/**
 * QUEM GANHA QUANDO CINCO LUGARES OPINAM SOBRE O MESMO PONTO.
 *
 * A escolha de modelo de um ponto pode vir de cinco origens, e antes desta
 * frente elas conviviam sem ordem declarada — o que produzia o pior desfecho
 * possível: o operador mudava a configuração numa tela e o comportamento não
 * mudava, porque outra origem estava vencendo em silêncio.
 *
 * A ordem, do mais forte ao mais fraco:
 *
 *  1. **Agente publicado** — só para os pontos que SÃO o agente conversando
 *     (`agent_turn`, `operator_turn`). A escolha ali já tem tela própria, e
 *     duas telas mandando na mesma coisa é como se cria a configuração que
 *     mente. O painel mostra esses dois como leitura, com link para o agente.
 *  2. **Binding do ponto** — a escolha explícita feita no painel de provedores.
 *     É a superfície nova e é ela que o operador enxerga.
 *  3. **Variável de ambiente** — os sete knobs herdados (`COMPACTION_MODEL`,
 *     `STAGE_CLASSIFIER_MODEL`, …). Continuam valendo para quem já os usa, mas
 *     perdem para uma escolha feita na tela: quem clicou depois quis mais.
 *  4. **Herança de quem chamou** — o ponto AUXILIAR não tem modelo próprio, e
 *     quando o knob está vazio ele empresta o do agente publicado (ou o do
 *     roteador de intenção). Empresta os TRÊS campos juntos; emprestar só a
 *     string do modelo é o defeito do PR #151, e ele voltou por este degrau
 *     estar faltando.
 *  5. **Padrão da organização** — `organizations.settings.llm`, o que sempre
 *     valeu quando ninguém disse nada.
 *
 * A decisão devolve a ORIGEM junto com o valor. Isso não é enfeite: é o que
 * permite a tela responder "este ponto está usando X **porque**…" e o log
 * registrar a razão da escolha. Um resolvedor que devolvesse só o modelo
 * deixaria o operador na mesma dúvida de antes.
 *
 * Função pura, sem banco — mesmo motivo de `lib/routing/decide.ts` e
 * `lib/agent-engine/agent/aux-model-args.ts` existirem fora do worker: a regra
 * de precedência é a parte que erra, e ela precisa ser exercitável por teste
 * unitário. O I/O fica em quem chama.
 */
import { PONTO_POR_ID, type PontoDeIa } from "./registro";

/** De onde a escolha efetiva veio — vai para a tela e para o log. */
export type OrigemDaEscolha =
  | "fixo_do_produto"
  | "agente_publicado"
  | "binding"
  | "variavel_de_ambiente"
  | "herdado_de_quem_chamou"
  | "padrao_da_organizacao";

export const EXPLICACAO_DA_ORIGEM: Record<OrigemDaEscolha, string> = {
  agente_publicado: "Definido na versão publicada do agente.",
  binding: "Escolhido por você no painel de provedores.",
  variavel_de_ambiente: "Definido em variável de ambiente na instalação.",
  herdado_de_quem_chamou:
    "Herdado de quem disparou a chamada — o agente publicado, ou o roteador de intenção.",
  padrao_da_organizacao: "Usando o padrão da organização.",
  fixo_do_produto: "O produto resolve este ponto sozinho — não há modelo a escolher.",
};

/** Uma linha de `ai_purpose_bindings`, já filtrada por organização. */
export interface LinhaDeBinding {
  purpose: string;
  provider: string;
  credential_id: string | null;
  model_id: string;
  base_url: string | null;
  is_enabled: boolean;
}

/** O que o agente publicado impõe aos pontos que são o próprio agente. */
export interface AgentePublicado {
  provider: string;
  credentialId: string | null;
  model: string | undefined;
}

/** O padrão da organização (`organizations.settings.llm`). */
export interface PadraoDaOrganizacao {
  provider: string;
  defaultModel: string | null;
}

export interface EntradaDaDecisao {
  pontoId: string;
  binding: LinhaDeBinding | null;
  agentePublicado: AgentePublicado | null;
  /** O knob de ambiente daquele ponto, quando existe. */
  modeloDeAmbiente: string | undefined;
  padraoDaOrganizacao: PadraoDaOrganizacao;
}

export interface DecisaoDeBinding {
  provider: string;
  modelId: string | null;
  credentialId: string | null;
  baseUrl: string | null;
  origem: OrigemDaEscolha;
  /**
   * Incoerências que NÃO impedem a chamada, mas que alguém precisa ver. A
   * validação dura acontece na escrita (a API recusa binding incompatível); na
   * leitura, avisar é melhor que falhar — falhar fechado na ação, aberto na
   * informação. Sem isto, um ponto configurado errado antes de a validação
   * existir voltaria a ser uma falha muda.
   */
  avisos: string[];
}

/**
 * Os pontos cuja escolha pertence à versão publicada do agente, não ao painel.
 *
 * São os dois em que o modelo É a personalidade do agente: mudá-lo por fora
 * mudaria como o agente fala com o cliente sem passar pelo fluxo de publicação
 * (que é onde mora a revisão e o histórico de versão).
 */
export const PONTOS_DO_AGENTE_PUBLICADO: ReadonlySet<string> = new Set([
  "agent_turn",
  "operator_turn",
]);

/**
 * Modelo e credencial vêm sempre do MESMO lugar.
 *
 * Esta é a regra que o PR #151 pagou caro para aprender (ver
 * `lib/agent-engine/agent/aux-model-args.ts`): emprestar só a string do modelo
 * e deixar provider/credencial no padrão da org mandava `gpt-5-mini` para o
 * endpoint da Anthropic e matava o turno inteiro. Cada ramo abaixo devolve os
 * três campos juntos, ou nenhum.
 */
/**
 * Os pontos que HERDAM do agente publicado sem serem o agente.
 *
 * Eles não têm modelo próprio: quando o knob de ambiente está vazio,
 * `auxModelArgs` empresta o do agente — e, desde o PR #151, empresta provider e
 * credencial JUNTO. Em runtime quem sinaliza a herança é a presença do
 * override; a TELA não tem esse sinal e precisa desta lista, senão ela passaria
 * a anunciar herança em ponto que não herda — a mesma mentira de antes, virada
 * do avesso.
 *
 * Fonte: os quatro `argsAux(...)` de `inbound-turn.ts` mais o `checkpoint`, que
 * passa o mesmo par direto. Ponto que entrar ou sair daquele conjunto entra ou
 * sai daqui no mesmo commit.
 */
export const PONTOS_QUE_HERDAM_DO_AGENTE: ReadonlySet<string> = new Set([
  "stage_classifier",
  "jailbreak_detect",
  "promise_semantic",
  "compaction",
  "checkpoint",
  "draft_suggestion",
  "automation_ai_message",
]);

export function decidirBinding(entrada: EntradaDaDecisao): DecisaoDeBinding {
  const ponto = PONTO_POR_ID.get(entrada.pontoId);
  const avisos: string[] = [];

  // 0 · Ponto FIXO responde por si, antes de qualquer cadeia.
  //
  // ⚠️ Sem este degrau, um ponto fixo percorria a resolução inteira e caía no
  // padrão da organização — e a tela anunciava `claude-sonnet-5` em "Ouvir o
  // áudio do cliente", ao lado do texto que diz "usa o padrão de transcrição
  // da OpenAI". A mesma tela afirmando duas coisas incompatíveis.
  //
  // Modelo de conversa não transcreve áudio: anunciar um ali manda quem opera
  // caçar um problema que não existe, ou trocar o modelo errado.
  if (ponto?.fixo?.usa) {
    return {
      provider: ponto.fixo.usa.provider,
      modelId: ponto.fixo.usa.modelId,
      credentialId: null,
      baseUrl: null,
      origem: "fixo_do_produto",
      avisos,
    };
  }

  // 1 · O agente publicado manda nos pontos que são o próprio agente.
  if (PONTOS_DO_AGENTE_PUBLICADO.has(entrada.pontoId) && entrada.agentePublicado !== null) {
    if (entrada.binding !== null && entrada.binding.is_enabled) {
      avisos.push(
        "Este ponto usa o modelo definido na versão publicada do agente; a escolha do painel não se aplica.",
      );
    }
    const agente = entrada.agentePublicado;
    // Versão publicada SEM modelo: o padrão da organização vale INTEIRO. O
    // `agente.model ?? padrao.defaultModel` que morava aqui juntava o provider
    // do agente ao modelo da org — o cruzamento do PR #151 escrito à mão, num
    // ramo que existe justamente para impedi-lo.
    if (agente.model === undefined) {
      return {
        provider: entrada.padraoDaOrganizacao.provider,
        modelId: entrada.padraoDaOrganizacao.defaultModel,
        credentialId: null,
        baseUrl: null,
        origem: "padrao_da_organizacao",
        avisos,
      };
    }
    return {
      provider: agente.provider,
      modelId: agente.model,
      credentialId: agente.credentialId,
      baseUrl: null,
      origem: "agente_publicado",
      avisos,
    };
  }

  // 2 · A escolha explícita do painel.
  if (entrada.binding !== null && entrada.binding.is_enabled) {
    if (entrada.modeloDeAmbiente !== undefined) {
      avisos.push(
        `A variável de ambiente deste ponto está definida como "${entrada.modeloDeAmbiente}", mas a escolha do painel tem prioridade.`,
      );
    }
    avisos.push(...avisosDeCapacidade(ponto, entrada.binding.model_id));
    return {
      provider: entrada.binding.provider,
      modelId: entrada.binding.model_id,
      credentialId: entrada.binding.credential_id,
      baseUrl: entrada.binding.base_url,
      origem: "binding",
      avisos,
    };
  }

  // 3 · O knob de ambiente. Herda provider/credencial do padrão da org, que é
  // exatamente o que esse knob sempre pressupôs — ele nasceu quando só havia
  // um provider por instalação.
  if (entrada.modeloDeAmbiente !== undefined) {
    return {
      provider: entrada.padraoDaOrganizacao.provider,
      modelId: entrada.modeloDeAmbiente,
      credentialId: null,
      baseUrl: null,
      origem: "variavel_de_ambiente",
      avisos,
    };
  }

  // 3.5 · A herança de quem disparou a chamada.
  //
  // ⚠️ É O RAMO QUE NÃO PODE FALTAR, e faltava. Sem ele o ponto auxiliar caía
  // no padrão da organização — mas `runModelCall` já havia resolvido a config
  // COM o override, então o `padraoDaOrganizacao` que chega aqui carrega o
  // provider de quem chamou e o modelo da org. Provider de um lugar, modelo de
  // outro: a forma exata do PR #151, medida de novo em produção em 2026-08-25
  // (`stage_classifier`, provider `openai`, model `claude-sonnet-4-5`, 400
  // `modelo_inexistente`, turno morto antes de o cliente receber resposta).
  //
  // Vem DEPOIS do knob de ambiente de propósito: `aux-model-args.ts` só
  // empresta o modelo do agente quando o knob está vazio, e as duas metades da
  // mesma regra não podem discordar sobre a ordem.
  const modeloDeQuemChamou = entrada.agentePublicado?.model;
  if (entrada.agentePublicado !== null && modeloDeQuemChamou !== undefined) {
    const quemChamou = entrada.agentePublicado;
    return {
      provider: quemChamou.provider,
      modelId: modeloDeQuemChamou,
      credentialId: quemChamou.credentialId,
      baseUrl: null,
      origem: "herdado_de_quem_chamou",
      avisos,
    };
  }

  // 4 · O padrão da organização.
  return {
    provider: entrada.padraoDaOrganizacao.provider,
    modelId: entrada.padraoDaOrganizacao.defaultModel,
    credentialId: null,
    baseUrl: null,
    origem: "padrao_da_organizacao",
    avisos,
  };
}

/**
 * Avisos sobre capacidade que a leitura consegue dar sem consultar o catálogo.
 *
 * A checagem completa (o modelo suporta ferramentas? enxerga imagem?) exige o
 * catálogo e acontece na ESCRITA, onde dá para recusar. Aqui cobrimos o caso
 * que não precisa de catálogo nenhum: ponto de embedding com modelo que não é
 * de embedding — um erro de digitação que, sem aviso, degrada a busca sem
 * derrubar nada.
 */
function avisosDeCapacidade(ponto: PontoDeIa | undefined, modelId: string): string[] {
  if (ponto === undefined) return [];
  if (ponto.exige.embeddingDims === undefined) return [];
  if (/embed/i.test(modelId)) return [];
  return [
    `Este ponto precisa de um modelo de embedding, e "${modelId}" não parece ser um. A busca no seu material pode parar de encontrar o conteúdo certo.`,
  ];
}
