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
import { OPENROUTER_BASE_URL, resolveLanguageModel, type ModelId } from "./gateway";

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
  const binding = await lerBinding(purpose, organizationId);

  if (binding === null) {
    // Antes da chave da instalação vem a credencial da PRÓPRIA organização —
    // o degrau do meio de `resolveOrgLlmConfig`, que esta pilha pulava.
    const daOrg = await credencialDaOrganizacao(organizationId);
    const idNoProvider =
      daOrg === null ? null : idParaOProvider(daOrg.provider, String(padrao));
    if (daOrg !== null && idNoProvider !== null) {
      const model = instanciar(daOrg.provider, daOrg.apiKey, idNoProvider, null);
      if (model !== null) {
        // `modelId` continua sendo o id CANÔNICO, não o traduzido: é ele que
        // casa com o catálogo de preço no log de custo.
        return { model, modelId: String(padrao), origem: "credencial_da_organizacao" };
      }
    }
    // Sem credencial cadastrada sobra a chave da INSTALAÇÃO, e quem diz de QUEM
    // é essa chave é o provedor que a organização escolheu (issue #1181). A
    // leitura desse provedor é preguiçosa: id que já traz rota resolve sem ela,
    // e é esse o caminho de toda instalação padrão.
    const model = await padraoDaInstalacao(
      () => (daOrg !== null ? Promise.resolve(daOrg.provider) : providerDaOrganizacao(organizationId)),
      padrao,
    );
    if (model !== null) return { model, modelId: String(padrao), origem: "padrao" };
    return opcoes.naFaltaUsarOPadraoDaOrganizacao === true
      ? padraoDaOrganizacao(organizationId, daOrg)
      : null;
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
    const model = await padraoDaInstalacao(() => Promise.resolve(binding.provider), padrao);
    return model === null ? null : { model, modelId: String(padrao), origem: "padrao" };
  }

  const model = instanciar(binding.provider, apiKey, binding.model_id, binding.base_url);
  if (model === null) {
    logger.warn("[gateway-binding] provider do binding é desconhecido — usando o padrão", {
      organization_id: organizationId,
      purpose,
      provider: binding.provider,
    });
    const fallback = await padraoDaInstalacao(() => Promise.resolve(binding.provider), padrao);
    return fallback === null ? null : { model: fallback, modelId: String(padrao), origem: "padrao" };
  }

  return { model, modelId: binding.model_id, origem: "binding" };
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
 * O provedor chega como função e só é lido quando o id é BARE: no caminho sem
 * binding ele custa uma consulta a `organizations`, e o id prefixado — o de
 * toda instalação padrão — resolve sem ela.
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
  providerDaConfiguracao: () => Promise<string | null>,
  padrao: ModelId,
): Promise<LanguageModel | null> {
  const peloId = resolveLanguageModel(padrao);
  if (peloId !== null) return peloId;
  const id = String(padrao);
  if (id.includes("/")) return null;
  const provider = await providerDaConfiguracao();
  if (provider !== null && provider !== "openrouter") {
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
  if (provedorDoModelo === null || provedorDoModelo === provider) return null;
  return resolveLanguageModel(`${provedorDoModelo}/${id}`);
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
  daOrg: { provider: string; apiKey: string } | null,
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
  if (daOrg !== null && daOrg.provider === llm.provider) {
    const id = idParaOProvider(llm.provider, modelId);
    const model = id === null ? null : instanciar(llm.provider, daOrg.apiKey, id, null);
    if (model !== null) return { model, modelId, origem: "credencial_da_organizacao" };
  }
  const model = await padraoDaInstalacao(() => Promise.resolve(llm.provider), modelId as ModelId);
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
 * `credencialDaOrganizacao` já o leu quando havia credencial cadastrada; esta
 * leitura só acontece no caminho em que não havia — e é este provedor que diz
 * de QUEM é a chave da instalação que atende o ponto. Nunca lança: leitura que
 * falha devolve `null`, e a escada termina no mesmo desfecho de antes.
 */
async function providerDaOrganizacao(organizationId: string): Promise<string | null> {
  return (await llmDaOrganizacao(organizationId))?.provider ?? null;
}

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
): Promise<{ provider: string; apiKey: string } | null> {
  try {
    const admin = createAdminClient();
    const { data: org } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", organizationId)
      .maybeSingle();
    const provider = (org?.settings as { llm?: { provider?: string } } | null)?.llm?.provider;
    if (typeof provider !== "string" || provider === "") return null;

    // Admin client bypassa RLS: filtro por organização é PROGRAMÁTICO e
    // obrigatório (CLAUDE.md, anti-pattern 10).
    const { data } = await admin
      .from("ai_provider_credentials")
      .select("api_key_encrypted, api_key_iv, api_key_tag")
      .eq("organization_id", organizationId)
      .eq("provider", provider)
      .eq("is_active", true)
      .not("validated_at", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return null;

    return {
      provider,
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
    return null;
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
