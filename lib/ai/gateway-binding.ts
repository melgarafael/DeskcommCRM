/**
 * O PAINEL DE PROVEDORES ALCANÇA TAMBÉM A PILHA ANTIGA.
 *
 * O sistema resolvia modelo por três caminhos que não se falam. O seam do
 * agente (`run-model-call.ts`) já obedece ao painel. Faltavam os pontos que
 * ainda passam por `lib/ai/gateway.ts` — `sentiment_classify`, `bot_respond` e
 * o ensaio de agente.
 *
 * Enquanto faltavam, a tela cometia o pior erro que uma tela de configuração
 * pode cometer: oferecia esses três pontos, aceitava a escolha, dizia "salvo" —
 * e nenhuma chamada a respeitava. Botão que não controla nada é pior que botão
 * ausente, porque gasta a confiança de quem clicou. É a mesma classe de defeito
 * que `tests/unit/pontos-de-ia-completude.test.ts` proíbe no registro; ela só
 * não era pega aqui porque o teste olha a LISTA, não a execução.
 *
 * ## Por que este módulo existe em vez de o worker chamar o seam
 *
 * O seam do agente fala `pg.Pool`; estes workers falam Supabase. Migrá-los para
 * o seam é a mudança certa e é grande — mexe em transação, em credencial e no
 * caminho que hoje responde o cliente. Este módulo é a ponte mínima que faz o
 * painel valer JÁ nos três pontos, sem reescrever o runtime que está no ar.
 * A unificação segue registrada como dívida no handoff.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

import { DEEPSEEK_ENDPOINT, REQUESTY_ENDPOINT } from "@/lib/agent-engine/edge/llm/providers";
import { fetchParaDestinoDaOrganizacao } from "@/lib/automation/destinos-internos-autorizados";
import { decryptKey, byteaToBuffer } from "@/lib/crypto/aes_gcm";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { escolherModeloNoCatalogo } from "./agents/escolher-modelo";
import { DEFAULT_CLASSIFIER_MODEL, OPENROUTER_BASE_URL, resolveLanguageModel, type ModelId } from "./gateway";
import { logarResolucaoDeModelo, provedorNaturalDoModelo, validarParProvedorModelo } from "./par-provedor-modelo";

export interface ModeloResolvido {
  model: LanguageModel;
  /** Para o log: qual modelo e de onde veio a decisão. */
  modelId: string;
  origem: "binding" | "credencial_da_organizacao" | "padrao";
}

/**
 * Resolve o modelo de um ponto, honrando o painel quando há binding.
 *
 * `organizationId` é obrigatório porque binding é por organização — e um
 * resolvedor que aceitasse organização opcional acabaria chamado sem ela no
 * caminho que mais importa, aplicando a configuração de ninguém.
 *
 * Sem binding, a ordem é a MESMA do resto do produto (`resolveOrgLlmConfig`):
 * a credencial ativa e validada do provider da organização e, só então, a chave
 * da instalação. Esta linha já disse "devolve exatamente o que
 * `resolveLanguageModel` devolvia"; era verdade até o degrau do meio entrar, e
 * deixá-la de pé faria a próxima pessoa concluir que a chave do `.env` ainda
 * vence a chave que a organização cadastrou na tela.
 */
export interface OpcoesDoResolvedor {
  /**
   * Quando nem a credencial da organização nem a chave da instalação executam
   * o modelo pedido, usar o padrão da organização (`settings.llm`: provedor e
   * modelo JUNTOS) em vez de devolver `null`.
   *
   * É para o ponto que mede, não para o que conversa: o clima pede um id da
   * Anthropic, e uma empresa que atende pela OpenAI (ou Google, ou DeepSeek)
   * sem modelo escolhido para ele ficava com o clima mudo — enquanto o painel
   * dizia "Usando o padrão da organização" para esse mesmo ponto. O modelo do
   * agente que responde o cliente é a personalidade dele e muda pela
   * publicação, nunca por esta queda; por isso é opção, e não regra.
   */
  naFaltaUsarOPadraoDaOrganizacao?: boolean;
}

export async function resolverModeloDoPonto(
  purpose: string,
  organizationId: string,
  padrao: ModelId,
  opcoes: OpcoesDoResolvedor = {},
): Promise<ModeloResolvido | null> {
  const idPadrao = String(padrao);
  const binding = await lerBinding(purpose, organizationId);

  // O provedor do ENDEREÇO vem de quem vai receber a chamada: o binding, ou a
  // credencial da própria organização — cuja leitura já abre `settings.llm`,
  // então conferir o par não custa consulta nenhuma.
  const daOrg = binding === null ? await credencialDaOrganizacao(organizationId) : null;
  const providerEfetivo = binding !== null ? binding.provider : daOrg?.provider ?? null;

  const devolver = (
    resolvido: ModeloResolvido | null,
    provider: string,
    model: string,
    origem: string,
    motivo?: string,
  ): ModeloResolvido | null => {
    // O log da execução: provedor, modelo, propósito e origem da configuração,
    // em TODO ponto — é o que a tela e o operador usam para dizer qual modelo
    // efetivamente rodou em cada finalidade (issue #2377).
    logarResolucaoDeModelo(logger, {
      organization_id: organizationId,
      purpose,
      provider,
      model,
      origem,
      motivo,
    });
    return resolvido;
  };

  // ── O DEFAULT DO PRODUTO NÃO CRUZA PROVEDOR ─────────────────────────────
  //
  // `DEFAULT_CLASSIFIER_MODEL` nasceu Anthropic quando a Anthropic era a
  // única chave que o instalador pedia: é compatibilidade EXPLÍCITA (item (c)
  // da issue #2377), não fallback oculto. Enquanto o provedor efetivo for a
  // Anthropic ou um agregador, ele segue valendo. Quando o provedor efetivo é
  // OUTRO provedor direto, ele não é executado aqui — vale o par coerente da
  // organização. Sem esta linha, uma empresa em OpenAI classificava o clima
  // com um Claude que a tela nunca anunciava, pelo caminho que respondia
  // sozinho (item (a) da mesma issue).
  const defaultNaoExecutaAqui =
    ehODefaultAnthropicDoProduto(idPadrao) && provedorDiretoNaoAnthropic(providerEfetivo);

  /**
   * O fallback comum aos TRÊS pontos em que o resolvedor precisava escolher
   * algo para executar: o padrão do ponto, ou — quando aquele padrão é o
   * default da Anthropic e o provedor efetivo é outro provedor direto — o par
   * coerente da organização.
   *
   * Recusa não é logada aqui: `padraoDaInstalacao` e `padraoDaOrganizacao`
   * já registram o motivo, e dois logs para um mesmo motivo só poluem o
   * filtro de quem procura a causa.
   */
  const padraoExecutavel = async (
    motivoDeQueda?: string,
    // `true` quando o BINDING foi descartado (sem chave utilizavel ou par
    // invalido): o provedor daquela linha nao manda mais em nada, e o padrao do
    // ponto volta a valer com o PROPRIO provedor do id — que e sempre coerente.
    // Sem isto, um binding morto apontando para a OpenAI deixaria o ponto em
    // silencio (a recusa da issue #2377 e do PAR, nao do ponto inteiro).
    bindingDescartado = false,
  ): Promise<ModeloResolvido | null> => {
    const providerDoPadrao = bindingDescartado
      ? provedorNaturalDoModelo(idPadrao) ?? providerEfetivo
      : providerEfetivo;
    if (defaultNaoExecutaAqui && !bindingDescartado) {
      const motivo =
        `o padrão deste ponto é o default da Anthropic ("${idPadrao}") e o provedor efetivo ` +
        `é "${providerEfetivo}" — o default do produto não é executado sob outro provedor`;
      // Quem NÃO pediu a queda continua recebendo `null` (a mesma regra da
      // opção `naFaltaUsarOPadraoDaOrganizacao`): o agente que responde o
      // cliente não passa a ter um modelo que ninguém escolheu para ele. O
      // que muda é que agora ele não ganha um Claude silencioso — ganha um
      // `null` com o motivo no log.
      if (opcoes.naFaltaUsarOPadraoDaOrganizacao !== true) {
        logarResolucaoDeModelo(logger, {
          organization_id: organizationId,
          purpose,
          provider: providerEfetivo ?? "",
          model: idPadrao,
          origem: "padrao",
          motivo: `${motivo} — e este ponto não pede queda para o par da organização`,
        });
        return null;
      }
      const coerente = await padraoDaOrganizacao(organizationId, credencialUtilizavel(daOrg), purpose);
      if (coerente !== null) return devolver(coerente, providerEfetivo ?? "", coerente.modelId, coerente.origem, motivo);
      // PISO, não silêncio: sem par próprio executável, o default do produto
      // segue rodando pelo PRÓPRIO provedor dele, como antes da régua — uma
      // VPS que classificava com a chave Anthropic da instalação não para de
      // classificar ao atualizar. O aviso vai no log com o motivo.
      const piso = await padraoDaInstalacao(provedorNaturalDoModelo(idPadrao), padrao, { purpose, organizationId });
      return devolver(
        piso === null ? null : { model: piso, modelId: idPadrao, origem: "padrao" },
        provedorNaturalDoModelo(idPadrao) ?? "",
        idPadrao,
        "padrao",
        `${motivo} — e a organização não tem par próprio executável: o default do produto roda como piso`,
      );
    }
    const model = await padraoDaInstalacao(providerDoPadrao, padrao, { purpose, organizationId });
    if (model === null) return null;
    return devolver({ model, modelId: idPadrao, origem: "padrao" }, providerDoPadrao ?? "", idPadrao, "padrao", motivoDeQueda);
  };

  if (binding === null) {
    // Sem modelo nenhum para servir de padrão: nada é inventado. Um agente sem
    // `model` (ou um chamador que não sabe qual usar) cai no par da
    // organização em vez de ganhar um Claude silencioso.
    if (idPadrao.trim() === "") {
      const coerente = opcoes.naFaltaUsarOPadraoDaOrganizacao === true
        ? await padraoDaOrganizacao(organizationId, credencialUtilizavel(daOrg), purpose)
        : null;
      if (coerente !== null) return devolver(coerente, providerEfetivo ?? "", coerente.modelId, coerente.origem);
      return devolver(
        null,
        providerEfetivo ?? "",
        "",
        "padrao",
        "o resolvedor não recebeu modelo algum para este ponto e a organização não tem par próprio",
      );
    }

    if (defaultNaoExecutaAqui) return padraoExecutavel();

    // Antes da chave da instalação vem a credencial da PRÓPRIA organização —
    // o degrau do meio de `resolveOrgLlmConfig`, que esta pilha pulava.
    if (daOrg !== null && daOrg.apiKey !== null) {
      const idNoProvider = idParaOProvider(daOrg.provider ?? "", idPadrao);
      if (daOrg.provider !== null && idNoProvider !== null) {
        const par = validarParProvedorModelo(daOrg.provider, idNoProvider);
        const model =
          par.valido ? instanciar(daOrg.provider, daOrg.apiKey, idNoProvider, null) : null;
        if (model !== null) {
          return devolver(
            { model, modelId: idPadrao, origem: "credencial_da_organizacao" },
            daOrg.provider,
            idPadrao,
            "credencial_da_organizacao",
          );
        }
        if (!par.valido) {
          logarResolucaoDeModelo(logger, {
            organization_id: organizationId,
            purpose,
            provider: daOrg.provider,
            model: idPadrao,
            origem: "credencial_da_organizacao",
            motivo: par.motivo,
          });
        }
      }
    }
    // Sem credencial cadastrada sobra a chave da INSTALAÇÃO, e quem diz de QUEM
    // é essa chave é o provedor que a organização escolheu (issue #1181). A
    // leitura desse provedor é preguiçosa: id que já traz rota resolve sem ela,
    // e é esse o caminho de toda instalação padrão.
    const instalacao = await padraoExecutavel(
      "nenhuma chave desta instalação atende o par provedor+modelo do ponto",
    );
    if (instalacao !== null) return instalacao;
    if (opcoes.naFaltaUsarOPadraoDaOrganizacao === true) {
      const coerente = await padraoDaOrganizacao(organizationId, credencialUtilizavel(daOrg), purpose);
      return devolver(
        coerente,
        providerEfetivo ?? "",
        coerente?.modelId ?? "",
        coerente?.origem ?? "padrao_da_organizacao",
        coerente === null ? "o provedor efetivo não executa o padrão do ponto e a organização não tem par próprio" : undefined,
      );
    }
    return devolver(null, providerEfetivo ?? "", idPadrao, "padrao", "nenhuma chave desta instalação atende o par provedor+modelo do ponto");
  }

  const apiKey = await decifrarChave(binding.credential_id, organizationId);
  if (apiKey === null) {
    // Binding configurado mas sem chave utilizável: cai no padrão em vez de
    // deixar o ponto morto. O aviso é o que impede isso de virar mais uma
    // falha muda — foi justamente o que esta frente veio acabar.
    logger.warn("[gateway-binding] binding sem credencial utilizável — usando o padrão", {
      organization_id: organizationId,
      purpose,
    });
    return padraoExecutavel("o provedor do binding não executa o padrão do ponto", true);
  }

  // O PAR DO BINDING também é conferido antes de instanciar: a tela valida na
  // escrita, mas uma linha gravada antes da validação (ou um provedor que
  // mudou de catálogo) não pode virar chamada com id que o endpoint não conhece.
  const parDoBinding = validarParProvedorModelo(binding.provider, binding.model_id);
  const model =
    parDoBinding.valido ? instanciar(binding.provider, apiKey, binding.model_id, binding.base_url) : null;
  if (model !== null) {
    return devolver(
      { model, modelId: binding.model_id, origem: "binding" },
      binding.provider,
      binding.model_id,
      "binding",
    );
  }
  logger.warn("[gateway-binding] provider do binding é desconhecido — usando o padrão", {
    organization_id: organizationId,
    purpose,
    provider: binding.provider,
    ...(parDoBinding.valido ? {} : { motivo: parDoBinding.motivo }),
  });
  return padraoExecutavel(
    parDoBinding.valido
      ? "o provedor do binding não executa o padrão do ponto"
      : parDoBinding.motivo,
    true,
  );
}

/**
 * O default de CLASSIFICAÇÃO do produto — o único que sobrou como constante.
 *
 * Compatibilidade explícita (issue #2377): nasceu Anthropic quando era a única
 * chave que o instalador pedia, e continua valendo como padrão do ponto. Quem
 * impede de virar fallback oculto é a conferência de par em
 * `resolverModeloDoPonto`: sob provedor direto diferente da Anthropic ele não
 * executa.
 */
function ehODefaultAnthropicDoProduto(id: string): boolean {
  return id === DEFAULT_CLASSIFIER_MODEL;
}

function provedorDiretoNaoAnthropic(provider: string | null): boolean {
  return provider !== null && ["openai", "google", "deepseek"].includes(provider);
}

function credencialUtilizavel(
  daOrg: { provider: string | null; apiKey: string | null } | null,
): { provider: string; apiKey: string } | null {
  if (daOrg === null || daOrg.provider === null || daOrg.apiKey === null) return null;
  return { provider: daOrg.provider, apiKey: daOrg.apiKey };
}

interface LinhaBinding {
  provider: string;
  credential_id: string | null;
  model_id: string;
  base_url: string | null;
}

async function lerBinding(
  purpose: string,
  organizationId: string,
): Promise<LinhaBinding | null> {
  try {
    const admin = createAdminClient();
    // Admin client bypassa RLS, então o filtro por organização é PROGRAMÁTICO e
    // obrigatório (CLAUDE.md, anti-pattern 10).
    const { data } = await admin
      .from("ai_purpose_bindings")
      .select("provider, credential_id, model_id, base_url")
      .eq("organization_id", organizationId)
      .eq("purpose", purpose)
      .eq("is_enabled", true)
      .maybeSingle();
    return (data as LinhaBinding | null) ?? null;
  } catch (err) {
    // Tabela ausente (clone sem o baseline aplicado) não pode derrubar o
    // atendimento — mas também não pode passar em silêncio.
    logger.warn("[gateway-binding] não consegui ler o binding — usando o padrão", {
      organization_id: organizationId,
      purpose,
      motivo: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * O id canônico traduzido para o que o provider da organização entende — ou
 * `null` quando ele não sabe executar aquele modelo.
 *
 * O prefixo de um id canônico (`anthropic/claude-haiku-4-5`) é ROTA, não nome
 * de modelo: quem já está dentro do provedor recebe só o nome, e é o que
 * `resolveLanguageModel` faz ao rotear pelo prefixo. A OpenRouter é a exceção
 * porque é agregadora — lá o prefixo é parte do endereço e vai inteiro.
 * A Requesty também é agregadora, e segue a mesma regra.
 *
 * O `null` é o freio do PR #151: id de outro provedor não vira chamada com a
 * chave da organização, vira queda para `resolveLanguageModel`, que sabe achar
 * a chave certa para aquele prefixo.
 */
function idParaOProvider(provider: string, id: string): string | null {
  // Os roteadores levam o prefixo inteiro — inclusive o provedor personalizado
  // (#1642), que serve id de QUALQUER fabricante atrás do próprio endpoint.
  if (provider === "openrouter" || provider === "requesty" || provider === "custom")
    return id;
  if (!id.includes("/")) return id;
  if (id.startsWith(`${provider}/`)) return id.slice(provider.length + 1);
  return null;
}

/**
 * O último degrau da escada: a chave da INSTALAÇÃO, no provedor que a
 * configuração manda usar.
 *
 * `resolveLanguageModel` roteia pelo PREFIXO do id canônico
 * (`openai/gpt-5.6-terra`) — e o catálogo serve id BARE: `gpt-5.6-terra` é o
 * `is_default_for_provider` da OpenAI (migration 0104, `ai_models`). Id sem
 * prefixo não acha provedor nenhum, o resolver devolvia `null` e o worker de
 * resposta automática PULAVA a mensagem do cliente com
 * `reason: "ai_gateway_key_missing"` mesmo com `OPENAI_API_KEY` no `.env` —
 * enquanto o ensaio do agente e o "Sugerir resposta", que montam o provedor
 * pelo par (provider, chave), respondiam pela mesma chave (issue #1181).
 *
 * O prefixo sintetizado aqui vem do provedor que a ORGANIZAÇÃO escolheu, e é só
 * isso que ele é: ROTA. O nome do modelo que chega ao SDK continua sendo o do
 * catálogo, como em `idParaOProvider`. Id que já traz rota não passa por aqui:
 * quem o roteia (ou recusa) é o próprio `resolveLanguageModel`, acima — e é o
 * mesmo freio do PR #151, que impede id de outro provedor de virar chamada com
 * a chave desta organização.
 *
 * O provedor chega PRONTO, como string, e não como função: ele sai da mesma
 * leitura de `settings.llm` que a procura de credencial já fazia — conferir o
 * par antes de executar não custa consulta nenhuma. Id que já traz rota não
 * passa pela síntese de prefixo: o prefixo É o endereço dele, e o par é
 * coerente por construção.
 *
 * O degrau de BAIXO é a conta SEM chave: quando a rota do provedor que a
 * organização escolheu não acha chave no ambiente (o `anthropic` que o gatilho
 * semeia numa instalação onde o instalador coletou `OPENAI_API_KEY`, por
 * exemplo), o id BARE é resolvido pelo provedor do MODELO no catálogo
 * `ai_models` — a mesma fonte que o resto do produto usa para o id BARE, e o
 * que a própria mensagem de `LlmNotConfiguredError` já declara ("fallback de
 * plataforma, conforme o provider do modelo"). Sem linha no catálogo, nada é
 * adivinhado: devolve `null` e o chamador PULA com motivo claro, em vez de
 * mandar um id para o endpoint de outro provedor.
 */
async function padraoDaInstalacao(
  providerEfetivo: string | null,
  padrao: ModelId,
  contexto: { purpose: string; organizationId: string },
): Promise<LanguageModel | null> {
  const id = String(padrao);
  const recusar = (provider: string, motivo: string): null => {
    // O buraco da issue #2377: o prefixo desta linha era sintetizado AQUI, a
    // partir do provedor da configuração, e um id BARE como `claude-sonnet-5`
    // saía para o endpoint da OpenAI. A recusa vem antes de qualquer byte e
    // leva o par inteiro no log.
    logarResolucaoDeModelo(logger, {
      organization_id: contexto.organizationId,
      purpose: contexto.purpose,
      provider,
      model: id,
      origem: "padrao",
      motivo,
    });
    return null;
  };

  const provider = providerEfetivo;
  const ehBare = !id.includes("/");
  const podeRotearPeloProvider = provider !== null && provider !== "openrouter";

  // ── O PAR É CONFERIDO ONDE O ENDEREÇO É ESCOLHIDO POR NÓS ───────────────
  //
  // Id BARE: quem decide o destino desta linha é ESTA função (degrau 1, o id
  // cru; degrau 2, `${providerEfetivo}/${id}` sintetizado aqui). É por isso
  // que `{openai, claude-sonnet-5}` mandava um id da Anthropic para o
  // endpoint da OpenAI — o prefixo nasce nesta função (issue #2377).
  //
  // A recusa não é imediata: o CATÁLOGO é quem diz de quem é o id de fato, e
  // o degrau 3 existe justamente para uma organização em Anthropic sem chave
  // da Anthropic resolver o `gpt-5.6-terra` pela `OPENAI_API_KEY` (issue
  // #1181). Então o par errado com a configuração vira MOTIVO PENDENTE, e só
  // é cobrado se nenhum degrau seguinte achar um provedor coerente.
  let recusaDoProvider: string | null = null;
  if (ehBare && podeRotearPeloProvider) {
    const par = validarParProvedorModelo(provider, id);
    if (!par.valido) recusaDoProvider = par.motivo;
  }
  const cobrarRecusa = (): null => {
    if (recusaDoProvider === null || provider === null) return null;
    return recusar(provider, recusaDoProvider);
  };

  // Degrau 1 — o id cru. Pulado quando a configuração já prova que este id não
  // é deste endereço: mandá-lo ao gateway ou ao OpenRouter assim seria trocar
  // um 400 do provedor por um 404 igualmente mudo.
  if (recusaDoProvider === null) {
    const peloId = resolveLanguageModel(id);
    if (peloId !== null) return peloId;
  }
  if (!ehBare) return cobrarRecusa();

  // Degrau 2 — a rota sintetizada com o provedor da configuração.
  if (recusaDoProvider === null && podeRotearPeloProvider) {
    const peloProvider = resolveLanguageModel(`${provider}/${id}`);
    if (peloProvider !== null) return peloProvider;
  }

  // A CONTA NÃO TEM CHAVE PARA ESTE ID — e a instalação tem. A rota de cima
  // sintetiza o prefixo a partir do provedor que a ORGANIZAÇÃO escolheu (ou do
  // `anthropic` que `fn_seed_org_llm_defaults` semeia), e quando esse provedor
  // não tem chave no `.env` o ponto pedia silêncio com
  // `reason: "ai_gateway_key_missing"` enquanto `OPENAI_API_KEY` estava lá — a
  // instalação que responde pelo teste do agente e pelo "Sugerir resposta" ficava
  // muda só no caminho que responde sozinho (issue #1181).
  //
  // Quem diz de QUEM é o id é o CATÁLOGO (`ai_models`), não a vontade de usar
  // qualquer chave que exista: é a mesma fonte que serve o id BARE e o mesmo
  // predicado que `resolveOrgLlmConfig` declara. Id que o catálogo não conhece,
  // ou cujo provedor é exatamente o que já tentamos, segue sem resposta.
  const provedorDoModelo = await provedorDoModeloNoCatalogo(id);
  if (provedorDoModelo !== null) {
    const parDoCatalogo = validarParProvedorModelo(provedorDoModelo, id);
    if (!parDoCatalogo.valido) return recusar(provedorDoModelo, parDoCatalogo.motivo);
    // O mesmo provedor da configuração já foi tentado no degrau 2 — repetir é
    // custo de leitura sem resposta nova.
    if (provedorDoModelo !== provider) {
      const peloCatalogo = resolveLanguageModel(`${provedorDoModelo}/${id}`);
      if (peloCatalogo !== null) return peloCatalogo;
    }
  }
  // Nenhum degrau achou endereço para este id: se o par com a configuração
  // estava errado, agora sim ele é cobrado — com provedor, modelo e motivo no
  // log, antes de qualquer byte.
  return cobrarRecusa();
}

/**
 * O provedor de um id BARE segundo o catálogo `ai_models` — `null` quando o
 * catálogo não o conhece (id legado, catálogo ainda não sincronizado).
 *
 * Leitura só no degrau de baixo, que hoje termina em skip: o custo é uma
 * consulta no caminho que, sem ela, responderia "nenhuma chave configurada".
 * Admin client sem coluna de organização — `ai_models` é catálogo da
 * instalação, e é assim que `definirPadraoDeIaDaOrganizacao` o lê.
 */
async function provedorDoModeloNoCatalogo(modelId: string): Promise<string | null> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("ai_models")
      .select("provider")
      .eq("model_id", modelId)
      .limit(1)
      .maybeSingle();
    const provider = (data as { provider?: unknown } | null)?.provider;
    return typeof provider === "string" && provider !== "" ? provider : null;
  } catch (erro) {
    // Mesma regra das outras leituras do módulo: fecha a ação (o desfecho é o
    // `null` de antes), abre a informação, e o log leva só a CLASSE do erro.
    logger.warn("[gateway-binding] não consegui ler o provedor do modelo no catálogo", {
      model_id: modelId,
      erro: erro instanceof Error ? erro.name : typeof erro,
    });
    return null;
  }
}

/**
 * O último recurso de `naFaltaUsarOPadraoDaOrganizacao`: o par (provedor,
 * modelo) que a organização escolheu, com a credencial dela quando existe e,
 * sem ela, com a chave da instalação daquele provedor.
 *
 * O par vai inteiro — a lição do PR #151. O `modelId` sai com o prefixo do
 * provedor, porque é ele que diz a `llm_calls` de quem é o gasto.
 */
async function padraoDaOrganizacao(
  organizationId: string,
  daOrg: { provider: string; apiKey: string | null } | null,
  purpose: string,
): Promise<ModeloResolvido | null> {
  const llm = await llmDaOrganizacao(organizationId);
  if (llm === null || llm.defaultModel === null) return null;
  const defaultModel = await modeloDoProvedor(organizationId, llm.provider, llm.defaultModel);
  const modelId =
    llm.provider === "openrouter" ||
    llm.provider === "requesty" ||
    llm.provider === "custom" ||
    defaultModel.startsWith(`${llm.provider}/`)
      ? defaultModel
      : `${llm.provider}/${defaultModel}`;
  // O ÚLTIMO freio do par (issue #2377): `modeloDoProvedor` conserta o par
  // lido no caminho normal, mas o degrau `oGravado` — catálogo ilegível,
  // banco indisponível — devolve o que está GRAVADO, e era por ali que
  // `{provider: 'openai', default_model: 'claude-sonnet-5'}` chegava inteiro
  // ao endpoint da OpenAI. Recusa aqui é `null` com o motivo no log, nunca
  // chamada com id que o provedor não conhece.
  const par = validarParProvedorModelo(llm.provider, modelId);
  if (!par.valido) {
    logarResolucaoDeModelo(logger, {
      organization_id: organizationId,
      purpose,
      provider: llm.provider,
      model: modelId,
      origem: "padrao_da_organizacao",
      motivo: par.motivo,
    });
    return null;
  }
  if (daOrg !== null && daOrg.provider === llm.provider && daOrg.apiKey !== null) {
    const id = idParaOProvider(llm.provider, modelId);
    const model = id === null ? null : instanciar(llm.provider, daOrg.apiKey, id, null);
    if (model !== null) return { model, modelId, origem: "credencial_da_organizacao" };
  }
  const model = await padraoDaInstalacao(llm.provider, modelId as ModelId, {
    purpose,
    organizationId,
  });
  return model === null ? null : { model, modelId, origem: "padrao" };
}

/**
 * O `default_model` da organização, se ele for DESTE provedor — senão, o do
 * catálogo do provedor pela régua do onboarding.
 *
 * Instalações feitas antes de `bootstrap-owner.ts` e `install.sh` gravarem o
 * par inteiro têm `{provider: 'openai', default_model: 'claude-sonnet-5'}`: o
 * gatilho semeou o par da Anthropic e o instalador trocou só o provedor. Montar
 * `openai/claude-sonnet-5` com isso mandava à OpenAI um id que ela não conhece,
 * em todo ponto que cai no padrão da empresa — e sem migration de dados, é aqui
 * que o par se conserta, na leitura.
 *
 * A pertença é conferida pelo id como o catálogo o guarda: sem o prefixo do
 * próprio provedor, exceto na OpenRouter, onde o `/` faz parte do id. Par
 * coerente passa intacto, inclusive quando não é o curado — é a escolha de
 * alguém. Catálogo vazio ou ilegível devolve o gravado: o desfecho de antes,
 * nunca um id inventado. Nunca lança.
 */
async function modeloDoProvedor(
  organizationId: string,
  provider: string,
  defaultModel: string,
): Promise<string> {
  const idNoCatalogo =
    provider !== "openrouter" && defaultModel.startsWith(`${provider}/`)
      ? defaultModel.slice(provider.length + 1)
      : defaultModel;
  const oGravado = (motivo: string): string => {
    logger.warn("[gateway-binding] não consegui conferir o modelo padrão no catálogo — usando o gravado", {
      organization_id: organizationId,
      provider,
      motivo,
    });
    return defaultModel;
  };
  try {
    // `ai_models` é o catálogo da instalação, sem `organization_id`: não há
    // tenant a filtrar aqui.
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("ai_models")
      .select("model_id")
      .eq("provider", provider)
      .eq("model_id", idNoCatalogo)
      .limit(1)
      .maybeSingle();
    if (error) return oGravado(error.message);
    if (data !== null) return defaultModel;

    const escolha = await escolherModeloNoCatalogo(admin, provider);
    if (escolha === null) return oGravado("catálogo ilegível");
    if (!escolha.escolhido) return defaultModel;
    logger.warn("[gateway-binding] o modelo padrão da organização não é do provedor dela — usando o do catálogo", {
      organization_id: organizationId,
      provider,
      gravado: defaultModel,
      usado: escolha.modelId,
    });
    return escolha.modelId;
  } catch (erro) {
    return oGravado(erro instanceof Error ? erro.name : typeof erro);
  }
}

/**
 * O provedor que a organização escolheu (Configurações › IA).
 *
 * `credencialDaOrganizacao` já o leu na MESMA ida a `organizations`, e é ele
 * que diz de QUEM é a chave da instalação que atende o ponto — e também o
 * endereço contra o qual o par provedor+modelo é conferido antes de executar
 * (issue #2377). Ter lido junto é o que faz a conferência não custar consulta.
 *
 * (Existia uma segunda leitura, `providerDaOrganizacao`, só para o id BARE.
 * Ela saiu junto com a mudança: o provedor já vem pronto.)
 */
async function llmDaOrganizacao(
  organizationId: string,
): Promise<{ provider: string; defaultModel: string | null } | null> {
  try {
    const admin = createAdminClient();
    // Admin client bypassa RLS: filtro por organização é PROGRAMÁTICO e
    // obrigatório (CLAUDE.md, anti-pattern 10).
    const { data } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", organizationId)
      .maybeSingle();
    const llm = (data?.settings as { llm?: { provider?: unknown; default_model?: unknown } } | null)
      ?.llm;
    if (typeof llm?.provider !== "string" || llm.provider === "") return null;
    const defaultModel =
      typeof llm.default_model === "string" && llm.default_model !== "" ? llm.default_model : null;
    return { provider: llm.provider, defaultModel };
  } catch (erro) {
    logger.warn("[gateway-binding] não consegui ler o provedor da organização", {
      organization_id: organizationId,
      erro: erro instanceof Error ? erro.name : typeof erro,
    });
    return null;
  }
}

/**
 * A credencial que a organização cadastrou para o SEU provider.
 *
 * É o degrau que faltava a esta pilha. `resolveOrgLlmConfig`
 * (lib/agent-engine/edge/llm/credentials.ts) já ordena assim há muito tempo:
 * credencial escolhida, senão a mais recente ativa/validada do provider da
 * organização, senão a chave da instalação. Aqui só havia o primeiro e o
 * terceiro — e uma organização com chave própria cadastrada e validada ficava
 * refém da chave do `.env`, que não é dela. Medido em produção: `.env` com
 * `OPENROUTER_API_KEY` revogada derrubou `sentiment_classify` com 401
 * `User not found.` enquanto os pontos do agent-engine, no mesmo minuto,
 * respondiam pela credencial da organização.
 *
 * O MODELO não vem daqui — vem de quem chamou. Trocá-lo pelo `default_model`
 * da organização mandaria o modelo de conversa fazer o trabalho do
 * classificador barato, e é a metade errada do par que o PR #151 ensinou a não
 * cruzar: aqui provider e credencial andam juntos, que é o par que importa.
 *
 * Nunca lança: leitura que falha devolve `null` e o chamador segue para a
 * chave da instalação. Um clone sem o baseline aplicado não pode ficar sem
 * atendimento por causa de uma consulta a mais.
 */
async function credencialDaOrganizacao(
  organizationId: string,
): Promise<{ provider: string | null; apiKey: string | null }> {
  // O PROVEDOR sai desta leitura mesmo sem credencial utilizável: ele é a
  // metade que diz qual endereço a organização escolheu, e é contra ele que o
  // par provedor+modelo é conferido antes de qualquer chamada (issue #2377).
  // Antes, o `null` de "sem credencial" jogava fora as duas metades, e a
  // conferência do padrão do produto só passou a existir porque elas ficam.
  try {
    const admin = createAdminClient();
    const { data: org } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", organizationId)
      .maybeSingle();
    const provider = (org?.settings as { llm?: { provider?: string } } | null)?.llm?.provider;
    const provedorEscolhido = typeof provider === "string" && provider !== "" ? provider : null;
    if (provedorEscolhido === null) return { provider: null, apiKey: null };

    // Admin client bypassa RLS: filtro por organização é PROGRAMÁTICO e
    // obrigatório (CLAUDE.md, anti-pattern 10).
    const { data } = await admin
      .from("ai_provider_credentials")
      .select("api_key_encrypted, api_key_iv, api_key_tag")
      .eq("organization_id", organizationId)
      .eq("provider", provedorEscolhido)
      .eq("is_active", true)
      .not("validated_at", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return { provider: provedorEscolhido, apiKey: null };

    return {
      provider: provedorEscolhido,
      apiKey: decryptKey({
        ciphertext: byteaToBuffer(data.api_key_encrypted),
        iv: byteaToBuffer(data.api_key_iv),
        tag: byteaToBuffer(data.api_key_tag),
      }),
    };
  } catch (erro) {
    // Falha FECHADA na ação (segue para a chave da instalação) e ABERTA na
    // informação. Sem rastro, uma leitura quebrada — baseline sem a tabela,
    // chave de decifragem trocada — é indistinguível de "esta organização não
    // cadastrou credencial", e o operador vê a conta do `.env` sendo debitada
    // sem nunca saber por quê. Vai só a CLASSE do erro: a mensagem pode
    // carregar material da credencial, o nome do erro não.
    logger.warn("credencial da organização não pôde ser lida; seguindo para a chave da instalação", {
      organizationId,
      erro: erro instanceof Error ? erro.name : typeof erro,
    });
    return { provider: null, apiKey: null };
  }
}

/** Decifra a chave da organização. Plaintext só existe no retorno. */
async function decifrarChave(
  credentialId: string | null,
  organizationId: string,
): Promise<string | null> {
  if (credentialId === null) return null;
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("ai_provider_credentials")
      .select("api_key_encrypted, api_key_iv, api_key_tag")
      .eq("id", credentialId)
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .not("validated_at", "is", null)
      .maybeSingle();
    if (!data) return null;
    return decryptKey({
      ciphertext: byteaToBuffer(data.api_key_encrypted),
      iv: byteaToBuffer(data.api_key_iv),
      tag: byteaToBuffer(data.api_key_tag),
    });
  } catch (erro) {
    // Mesma regra do catch acima: fecha a ação, abre a informação, e o log leva
    // só a classe do erro.
    logger.warn("credencial escolhida no painel não pôde ser decifrada; seguindo para o padrão", {
      credentialId,
      erro: erro instanceof Error ? erro.name : typeof erro,
    });
    return null;
  }
}

/**
 * Instancia o provider. Espelha `createDefaultRegistry` do agent-engine — e a
 * duplicação é consciente e temporária: unificar exige que estes workers falem
 * `pg.Pool`, que é a dívida registrada no handoff. Provider desconhecido
 * devolve `null` para o chamador cair no padrão com aviso, nunca um fallback
 * silencioso para outro provedor.
 */
function instanciar(
  provider: string,
  apiKey: string,
  modelId: string,
  baseUrl: string | null,
): LanguageModel | null {
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey })(modelId);
    case "openai":
      return createOpenAI({ apiKey })(modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(modelId);
    case "openrouter":
      return createOpenAI({ apiKey, baseURL: baseUrl ?? OPENROUTER_BASE_URL }).chat(modelId); // ver providers.ts
    // A DeepSeek fala a API da OpenAI. Sem este caso, uma organização em
    // DeepSeek cairia no `default` (null) e a pilha antiga seguiria para o
    // padrão com aviso — a tela ofereceria um provedor que estes workers ignoram.
    case "deepseek":
      return createOpenAI({ apiKey, baseURL: baseUrl ?? DEEPSEEK_ENDPOINT })(modelId);
    case "requesty":
      return createOpenAI({ apiKey, baseURL: baseUrl ?? REQUESTY_ENDPOINT }).chat(modelId); // ver providers.ts
    // Provedor personalizado (#1642): endpoint do operador. Sem `baseUrl` não
    // há onde ir — `null` deixa o chamador cair no padrão COM AVISO, que é o
    // contrato deste switch; inventar um endpoint seria mandar a chave do
    // gateway para outro lugar.
    case "custom":
      return baseUrl
        ? createOpenAI({ apiKey, baseURL: baseUrl, fetch: fetchParaDestinoDaOrganizacao() }).chat(modelId)
        : null;
    default:
      return null;
  }
}
