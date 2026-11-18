/**
 * MODO DE CONHECIMENTO DO AGENTE — `busca` (hoje) ou `leitura_direta` (#4133).
 *
 * O modo mora em `ai_agents.config.knowledge_mode` e é resolvido uma vez por
 * turno, em `agent-config.ts`. A decisão de QUAIS ferramentas de conhecimento o
 * turno monta fica AQUI, num lugar só e testável: a régua é a mesma do gate
 * histórico de `search_knowledge` (ferramenta que só sabe dizer "não tenho base"
 * não é neutra — gasta contexto e degrada a escolha do modelo).
 *
 * ─── As duas réguas ─────────────────────────────────────────────────────────
 *
 *   - `busca` (default, comportamento de HOJE): monta `search_knowledge` e nada
 *     mais. A remoção quando não há material é a MESMA de antes — lista de
 *     materiais vazia E ponteiro legado nulo.
 *   - `leitura_direta`: monta `ler_documento` e injeta o índice; `search_knowledge`
 *     NÃO entra (ela chamaria embedding — o ponto do pedido é justamente não
 *     precisar de uma segunda chave).
 *
 * ─── Leitura direta sem lista de materiais cai em `busca` ───────────────────
 *
 * O índice e o `ler_documento` trabalham por ID de material, e os ids vêm de
 * `ai_agent_versions.knowledge_source_ids`. Um agente que só tem o ponteiro
 * LEGADO (`active_kb_version_id`) não tem ids para o modelo citar: em vez de
 * ficar sem nenhuma ferramenta, ele mantém a busca de hoje. A direção da falha
 * é a mesma do resto do arquivo: nunca emudecer o conhecimento por schema ou
 * configuração incompleta.
 */

/** Os modos aceitos pelo config do agente (o Zod valida na borda — ver guardrails-schema). */
export type ModoDeConhecimento = "busca" | "leitura_direta";

/** Default do produto: quem nunca escolheu continua no caminho de hoje. */
export const MODO_DE_CONHECIMENTO_PADRAO: ModoDeConhecimento = "busca";

/** O que o turno tem de conhecimento — vem do agente publicado. */
export interface ContextoDeConhecimentoDoTurno {
  modo: ModoDeConhecimento;
  knowledgeSourceIds: readonly string[];
  activeKbVersionId: string | null;
}

export interface PlanoDeConhecimentoDoTurno {
  /** O modo que o turno REALMENTE usa (já com o fallback do cabeçalho). */
  modo: ModoDeConhecimento;
  /** Injeta o índice de documentos no sufixo do prompt? */
  injetaIndice: boolean;
  /** Monta a ferramenta `ler_documento`? */
  montaLeitura: boolean;
  /** Monta a ferramenta `search_knowledge`? */
  montaBusca: boolean;
}

/**
 * Lê `ai_agents.config.knowledge_mode` com a direção segura: valor ausente ou
 * fora do vocabulário cai em `busca` (o comportamento de hoje), nunca no modo
 * novo por acidente.
 */
export function lerModoDeConhecimento(config: unknown): ModoDeConhecimento {
  if (config === null || typeof config !== "object") return MODO_DE_CONHECIMENTO_PADRAO;
  const bruto = (config as Record<string, unknown>).knowledge_mode;
  return bruto === "leitura_direta" ? "leitura_direta" : MODO_DE_CONHECIMENTO_PADRAO;
}

/** Modo efetivo: `leitura_direta` exige lista de materiais para ter ids. */
export function modoEfetivoDeConhecimento(ctx: ContextoDeConhecimentoDoTurno): ModoDeConhecimento {
  if (ctx.modo !== "leitura_direta") return MODO_DE_CONHECIMENTO_PADRAO;
  return ctx.knowledgeSourceIds.length > 0 ? "leitura_direta" : MODO_DE_CONHECIMENTO_PADRAO;
}

/** O plano do turno — uma decisão, três consumidores (índice, montagem, gate). */
export function planejarConhecimentoDoTurno(
  ctx: ContextoDeConhecimentoDoTurno,
): PlanoDeConhecimentoDoTurno {
  const modo = modoEfetivoDeConhecimento(ctx);
  const temBase = ctx.knowledgeSourceIds.length > 0 || ctx.activeKbVersionId != null;
  if (!temBase) {
    return { modo, injetaIndice: false, montaLeitura: false, montaBusca: false };
  }
  if (modo === "leitura_direta") {
    return { modo, injetaIndice: true, montaLeitura: true, montaBusca: false };
  }
  return { modo, injetaIndice: false, montaLeitura: false, montaBusca: true };
}

/**
 * Remove as ferramentas de conhecimento que ESTE turno não deve ter. O turno
 * monta as duas e este gate decide — mesmo padrão do gate histórico de
 * `search_knowledge` (montada sempre, removida quando não há base).
 */
export function aplicarGateDasFerramentasDeConhecimento(
  ferramentas: object,
  ctx: ContextoDeConhecimentoDoTurno,
): void {
  const alvo = ferramentas as Record<string, unknown>;
  const plano = planejarConhecimentoDoTurno(ctx);
  if (!plano.montaBusca) delete alvo.search_knowledge;
  if (!plano.montaLeitura) delete alvo.ler_documento;
}
