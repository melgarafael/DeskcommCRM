/**
 * Quanto o modelo deve PENSAR antes de responder.
 *
 * Existe porque o custo do raciocínio não aparece no texto. Medido na
 * instalação do piloto: respostas de atendimento com 23 a 34 tokens de texto
 * consumiram de 450 a 2047 tokens de saída — o excedente é raciocínio, e é ele
 * que o cliente espera do outro lado do WhatsApp. O `agent_turn` levava 28s em
 * média, 50s no pior caso.
 *
 * A/B contra a API real, mesmo prompt, variando só este parâmetro: padrão
 * 8954ms, `low` 2252ms, `minimal` 1527ms — com resposta equivalente em `low`.
 * Um turno de qualificação ("qual período você prefere?") não precisa de
 * cadeia de raciocínio; um turno que decide preço ou compara planos, talvez —
 * e é por isso que isto é um knob, não uma constante.
 *
 * Decisão pura de propósito: quem chama é que fala com o provider.
 */

/** O que a OpenAI aceita em `reasoning_effort`, do mais barato ao mais caro. */
export const esforcos = ["minimal", "low", "medium", "high"] as const;
export type Esforco = (typeof esforcos)[number];

/** `provider` desliga a opinião do produto e deixa o default do provedor valer. */
export type PadraoDeEsforco = Esforco | "provider";

/**
 * Famílias que raciocinam.
 *
 * Casadas por nome INTEIRO ou por nome seguido de `-`, nunca por prefixo solto:
 * `o1` é modelo, `omni-moderation` não é, e `gpt-55` não é da família 5.
 */
const FAMILIAS = ["gpt-5", "o1", "o3", "o4"] as const;

/**
 * `gpt-5-chat` é a variante conversacional da família 5 e NÃO aceita
 * `reasoning_effort` — mandar assim mesmo é 400, e um 400 aqui derruba o turno
 * inteiro. Trocar lentidão por falha seria um péssimo negócio.
 */
const NAO_RACIOCINAM = [/^gpt-5-chat(-|$)/];

export function ehModeloDeRaciocinio(modelId: string): boolean {
  // Gateways roteiam como `openai/gpt-5-mini`: o discriminador é o NOME do
  // modelo, não o caminho até ele.
  const nome = modelId.trim().toLowerCase().split("/").pop() ?? "";
  if (NAO_RACIOCINAM.some((r) => r.test(nome))) return false;
  return FAMILIAS.some((f) => nome === f || nome.startsWith(`${f}-`));
}

export interface EntradaDeEsforco {
  /** Provider resolvido para esta chamada — `reasoning_effort` é vocabulário da OpenAI. */
  provider: string;
  modelId: string;
  /** O que a organização pediu em `settings.llm.params`. jsonb livre: pode vir lixo. */
  configurado?: unknown;
  /** O default do produto, do knob de ambiente. */
  padrao: PadraoDeEsforco;
}

/**
 * O esforço a enviar, ou `null` para não enviar nada.
 *
 * Ordem: o que a organização configurou vence o padrão do produto; ambos são
 * descartados quando o modelo ou o provider não entendem o parâmetro.
 */
export function esforcoDeRaciocinio({
  provider,
  modelId,
  configurado,
  padrao,
}: EntradaDeEsforco): Esforco | null {
  if (provider.trim().toLowerCase() !== "openai") return null;
  if (!ehModeloDeRaciocinio(modelId)) return null;

  const pedido = typeof configurado === "string" ? configurado.trim().toLowerCase() : "";
  if ((esforcos as readonly string[]).includes(pedido)) return pedido as Esforco;

  return padrao === "provider" ? null : padrao;
}
