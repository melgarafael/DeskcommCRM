/**
 * O PAR (PROVEDOR, MODELO) É CONFERIDO ANTES DE QUALQUER BYTE SAIR — issue #2377.
 *
 * A instalação pode operar com OpenAI, Anthropic ou OpenRouter, e um
 * `organizations.settings.llm` legado nasceu como `{provider: 'openai',
 * default_model: 'claude-sonnet-5'}`: o gatilho semeava o par da Anthropic e o
 * instalador antigo trocava só o provedor. Um id desse mandava à OpenAI um
 * modelo que ela não conhece, e o defeito só aparecia no caminho que o usava —
 * mídia, classificação, leitura — enquanto a tela mostrava só o provedor geral.
 *
 * Este módulo é a régua única dos cinco pontos de execução:
 *
 *  - `lib/agent-engine/edge/llm/run-model-call.ts`  (seam do agente)
 *  - `lib/ai/gateway-binding.ts`                    (pilha antiga: sentimento, resposta, ensaio)
 *  - `workers/media-derive-worker.ts`               (mídia: transcrição, visão, pdf)
 *  - `lib/ai/runtime/agent.ts`                      (agentes internos)
 *  - `lib/ai/embed.ts`                              (leitura/indexação da base)
 *
 * Duas regras governam o que aqui se afirma:
 *
 *  1. Só se recusa o que se pode PROVAR. O provedor precisa ser um que o
 *     produto conhece (`anthropic`, `openai`, `google`, `deepseek`) ou um
 *     agregador (`openrouter`, `requesty`, `custom`), e o modelo precisa trazer
 *     um prefixo de fabricante conhecido ou pertencer a uma família que só
 *     um deles executa (`claude-*`, `gpt-*`, `gemini-*`, `deepseek-*`).
 *     Recusa errada é pior que a recusa faltando: a segunda deixa o provedor
 *     responder com o 400 dele, a primeira cala um ponto que funcionava.
 *  2. O QUE SE VALIDA é o par que vai SAIR, não a preferência do painel. Um id
 *     com rota própria (`openai/gpt-5-mini`) executa na OpenAI mesmo quando a
 *     organização está em Anthropic — a rota do id é coerência, não divergência.
 *     O par errado é `openai` + `claude-sonnet-5`: provedor de um, modelo de outro.
 */
import { logger } from "@/lib/logger";
import { IDS_DE_PROVEDOR, PROVEDOR_POR_ASSINATURA } from "./pontos/provedores";

/**
 * Endereço que executa o catálogo de OUTRO fabricante: a assinatura (#1672)
 * fala com os modelos da OpenAI (`gpt-5`), então o par se confere como `openai`.
 * Sem isto, todo turno de agente na assinatura era recusado antes de sair.
 */
const FABRICANTE_DO_ENDERECO: Readonly<Record<string, string>> = {
  [PROVEDOR_POR_ASSINATURA]: "openai",
};

export type ResultadoDoPar =
  | { valido: true }
  | { valido: false; motivo: string };

/** Provedores que servem QUALQUER id: o prefixo do fabricante é parte do endereço. */
const AGREGADORES: ReadonlySet<string> = new Set(["openrouter", "requesty", "custom"]);

/**
 * Os provedores diretos, DERIVADOS de `./pontos/provedores.ts` e nunca escritos
 * à mão aqui: o catálogo é a fonte única e `provedores-x-registry` reprovava
 * qualquer arquivo que listasse os três à mão (issue #2377).
 */
const PROVEDORES_DIRETOS: ReadonlySet<string> = new Set(
  IDS_DE_PROVEDOR.filter((id) => !AGREGADORES.has(id)),
);

/**
 * Famílias de modelo que só um fabricante executa — é o que permite recusar um
 * id BARE (`claude-sonnet-5`, sem prefixo) num provedor que não é o dele.
 * Prefixo vazio (`anthropic/claude-x`) já resolve antes, pelo próprio nome.
 */
const FAMILIAS: ReadonlyArray<{ re: RegExp; provedor: string }> = [
  { re: /^claude[-./]/i, provedor: "anthropic" },
  { re: /^gpt-/i, provedor: "openai" },
  { re: /^o[0-9]/i, provedor: "openai" },
  { re: /^gemini-/i, provedor: "google" },
  { re: /^deepseek-/i, provedor: "deepseek" },
];

/**
 * O provedor que um id pertence — `null` quando não dá para afirmar.
 *
 * Prefixo desconhecido (`fabricante-x/modelo-y`) devolve `null` de propósito:
 * agregadores usam exatamente esse formato, e pertencer a um deles não é erro.
 */
export function provedorNaturalDoModelo(modelId: string): string | null {
  const id = String(modelId ?? "").trim();
  if (id === "") return null;
  const nome = parteAposARota(id);
  if (nome !== null) {
    const rotulo = id.slice(0, id.indexOf("/")).toLowerCase();
    return PROVEDORES_DIRETOS.has(rotulo) ? rotulo : null;
  }
  return provedorDaFamilia(id);
}

/** O nome do modelo depois da rota, ou `null` quando o id não traz rota. */
function parteAposARota(id: string): string | null {
  const corte = id.indexOf("/");
  return corte > 0 ? id.slice(corte + 1) : null;
}

/** O fabricante de um NOME de modelo (`claude-sonnet-5` → anthropic), ou `null`. */
function provedorDaFamilia(nome: string): string | null {
  for (const familia of FAMILIAS) {
    if (familia.re.test(nome)) return familia.provedor;
  }
  return null;
}

/**
 * O par é executável pelo provedor que vai atender a chamada?
 *
 * `provider` aqui é o provedor do ENDEREÇO — quem recebe a requisição — e não a
 * preferência gravada na organização. Inválido devolve o motivo em PT-BR, já
 * pronto para ir para o log e para a mensagem de erro do chamador.
 *
 * Três perguntas, nesta ordem:
 *  1. a rota do id (`openai/…`) bate com o endereço?
 *  2. o NOME do modelo é da família de quem a rota anuncia?
 *     (`openai/claude-sonnet-5` responde as duas com "não" na segunda — é o
 *     par legado que a issue #2377 descreve.)
 *  3. sem rota, o nome pertence a outro fabricante?
 */
export function validarParProvedorModelo(provider: unknown, modelId: unknown): ResultadoDoPar {
  const enderecoBruto = String(provider ?? "").trim().toLowerCase();
  const provedor = FABRICANTE_DO_ENDERECO[enderecoBruto] ?? enderecoBruto;
  const modelo = String(modelId ?? "").trim();

  if (provedor === "") {
    return { valido: false, motivo: "o provedor da chamada ficou vazio — não há endereço para onde ir" };
  }
  if (modelo === "") {
    return { valido: false, motivo: `o provedor "${provedor}" não recebeu modelo nenhum` };
  }
  // Agregador serve id de qualquer fabricante — o prefixo é endereço lá.
  if (AGREGADORES.has(provedor)) return { valido: true };
  // Provedor fora do catálogo do produto (proxy antigo, id legado): quem sabe
  // o que ele executa é quem o cadastrou, não esta régua.
  if (!PROVEDORES_DIRETOS.has(provedor)) return { valido: true };

  const nome = parteAposARota(modelo);
  if (nome === null) {
    // Id BARE: só o nome diz de quem é.
    const familia = provedorDaFamilia(modelo);
    if (familia === null || familia === provedor) return { valido: true };
    return { valido: false, motivo: parErrado(modelo, familia, provedor) };
  }

  const rotulo = modelo.slice(0, modelo.indexOf("/")).toLowerCase();
  if (!PROVEDORES_DIRETOS.has(rotulo)) {
    // Rota de agregador ou de fabricante que não conhecemos: conservador.
    return { valido: true };
  }
  if (rotulo !== provedor) {
    return { valido: false, motivo: parErrado(modelo, rotulo, provedor) };
  }
  const familia = provedorDaFamilia(nome);
  if (familia === null || familia === rotulo) return { valido: true };
  return { valido: false, motivo: `a rota "${rotulo}" anuncia o modelo "${nome}", mas o nome é da família "${familia}"` };
}

function parErrado(modelo: string, provedorDoModelo: string, provedorDaChamada: string): string {
  return (
    `o modelo "${modelo}" pertence ao provedor "${provedorDoModelo}", ` +
    `e o endereço da chamada é "${provedorDaChamada}" — enviá-lo assim seria entregar ` +
    `um id que aquele provedor não conhece`
  );
}

/** Lançado por TODOS os caminhos de execução, sempre ANTES da chamada externa. */
export class ParProvedorModeloInvalidoError extends Error {
  readonly code = "par_provedor_modelo_invalido";
  override readonly name = "ParProvedorModeloInvalidoError";
  constructor(
    readonly provider: string,
    readonly model: string,
    motivo: string,
    readonly purpose?: string,
  ) {
    super(
      `Par provedor/modelo inválido${purpose ? ` no ponto "${purpose}"` : ""}: ${motivo}. ` +
        `Corrija o modelo deste ponto em Agente de IA → Provedores ` +
        `(o par tem de ser do mesmo provedor). Nenhuma chamada foi feita.`,
    );
  }
}

interface Logador {
  info(msg: string, campos?: Record<string, unknown>): void;
  warn(msg: string, campos?: Record<string, unknown>): void;
}

export interface RegistroDaResolucao {
  organization_id?: string | undefined;
  /** O ponto de IA (`sentiment_classify`, `agent_turn`, …). */
  purpose: string;
  provider: string;
  model: string;
  /** De onde veio a escolha: `binding`, `credencial_da_organizacao`, `padrao`, … */
  origem: string;
  /** Só quando o par foi recusado: o porquê, em PT-BR. */
  motivo?: string | undefined;
}

/**
 * O log estruturado da execução: provedor, modelo, propósito e origem da
 * configuração em TODA resolução — é o que permite a tela e o operador dizerem
 * qual modelo efetivamente rodou em cada finalidade.
 *
 * Vaza só isto: nunca chave, prompt, telefone ou conteúdo de conversa.
 */
export function logarResolucaoDeModelo(log: Logador, registro: RegistroDaResolucao): void {
  const campos: Record<string, unknown> = {
    purpose: registro.purpose,
    provider: registro.provider,
    model: registro.model,
    origem_da_configuracao: registro.origem,
    ...(registro.organization_id ? { organization_id: registro.organization_id } : {}),
    ...(registro.motivo ? { motivo: registro.motivo } : {}),
  };
  if (registro.motivo) log.warn("ia: par provedor+modelo recusado antes da chamada", campos);
  else log.info("ia: par provedor+modelo validado", campos);
}

/** O logger da pilha antiga (`lib/logger`) e o do seam (`obs/logger`) servem aqui. */
export const logadorPadrao: Logador = logger;
