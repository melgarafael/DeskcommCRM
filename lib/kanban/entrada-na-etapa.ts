import type { Lead } from "@/lib/types/leads";
import { midpoint } from "./fractional-indexing";

/** O que a ordem precisa saber de um card: identidade e posição na etapa. */
type CardNaEtapa = Pick<Lead, "id" | "position_in_stage">;

/**
 * A posição de quem ENTRA numa etapa vindo de fora — e o defeito que ela
 * conserta (issue #3461, item 1).
 *
 * ─── O que se media antes ─────────────────────────────────────────────────
 *
 * `position_in_stage` é ordem crescente: MENOR primeiro. Quem criava card
 * gravava `MAX + 1000` (criação) e quem movia sem posição também (`move`,
 * `create_or_move_lead`, e a função `fn_mover_leads_em_lote` do lote) — ou
 * seja: todo recém-chegado nascia ABAIXO de todos os cards da coluna. A
 * conversa iniciada no Inbox e a transferida do Inbox para uma etapa
 * apareciam no FIM, que é exatamente o que a issue relata — e o operador tinha
 * de rolar a coluna inteira para achar o card que acabou de chegar.
 *
 * ─── O que passa a valer ──────────────────────────────────────────────────
 *
 * Um passo ACIMA da primeira: `MIN − 1000`, e `1000` na etapa vazia. É a mesma
 * régua que a resposta rápida já usa desde a migration 0729 ("a resposta NOVA
 * nasce no topo — um passo acima da primeira"): quem chega por último é quem
 * se olha primeiro, sem reescrever a posição de nenhum card existente.
 *
 * O passo é o mesmo de `midpoint` e a coluna é `numeric` no banco (não há
 * CHECK de piso), então descer não tem limite — e como cada entrada desce um
 * passo INTEIRO, dois cards que chegam em sequência nunca empatam: o segundo
 * fica acima do primeiro.
 */
export function posicaoDeEntradaNaEtapa(primeiraPosicaoDaEtapa: number | null): number {
  return midpoint(null, primeiraPosicaoDaEtapa);
}

/**
 * Comparador canônico de cards DENTRO de uma etapa: posição crescente e, no
 * EMPATE, `id`.
 *
 * O desempate não é enfeite (#3461): dois cards com a mesma
 * `position_in_stage` — herança do lote antigo que gravava a mesma posição em N
 * linhas — saíam na ordem em que o banco devolveu, que não é garantida e muda
 * de uma leitura para outra. Na tela, os dois TROCAVAM DE LUGAR a cada render,
 * sem ninguém arrastar nada. `id` é imutável: a mesma lista produz sempre a
 * mesma ordem.
 *
 * A ordem do SQL (`order("position_in_stage").order("id")`) usa a mesma régua —
 * este comparador existe para o caminho em MEMÓRIA (agrupar por etapa,
 * vizinho do arrasto) não divergir dela.
 */
export function compararNaEtapa(a: CardNaEtapa, b: CardNaEtapa): number {
  if (a.position_in_stage !== b.position_in_stage) {
    return a.position_in_stage - b.position_in_stage;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * A posição de quem CHEGA à etapa pelo menu ("Mover para…" do card, seletor de
 * etapa do dossiê) — o topo, pela mesma regra do `moveLeadHandler`. Lê a etapa
 * INTEIRA (cache do quadro, sem o filtro da página — #2545): o primeiro visível
 * não é o primeiro da etapa quando há filtro. O próprio card fica de fora.
 */
export function posicaoNoTopoDaEtapa(etapa: readonly CardNaEtapa[], leadId: string): number {
  const primeira = etapa.reduce<number | null>(
    (min, l) => (l.id === leadId || (min !== null && min <= l.position_in_stage) ? min : l.position_in_stage),
    null,
  );
  return posicaoDeEntradaNaEtapa(primeira);
}
