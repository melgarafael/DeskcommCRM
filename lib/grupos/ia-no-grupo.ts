/**
 * A chave POR GRUPO: "Permitir que a IA responda neste grupo" (#2729).
 *
 * ─── O que a regra é ──────────────────────────────────────────────────────
 *
 * `channel_session_groups.ia_responde` (migration 0653). DESLIGADO por
 * padrão, e o padrão é a metade importante da regra: quem nunca mexeu em nada
 * continua com a IA calada em grupo, que é o comportamento de sempre (a 0482
 * fez o banco emitir `message.group_received` justamente para nenhum
 * consumidor de `message.received` — IA, follow-up, campanhas, automações —
 * enxergar mensagem de grupo).
 *
 * Ligado, o grupo deixa de ser descartado de cara: o ingest passa a pedir o
 * turno do agente e o drain do engine para de pular o evento. As PROTEÇÕES de
 * envio (janela de 24h, ritmo, teto diário, silêncio pós-handoff, gate de
 * elegibilidade) continuam valendo normalmente — elas moram DEPOIS desta
 * decisão, no turno, e nada aqui as contorna.
 *
 * ─── Por que isto mora numa função de uma linha ───────────────────────────
 *
 * Porque a mesma régua é aplicada em DOIS lugares que não podem divergir: o
 * ingest do grupo (`lib/grupos/ingest.ts`, que decide se pede o turno) e o
 * drain do engine (`lib/agent-engine/edge/crm/drain.ts`, que decide se o
 * evento vira job). Uma cópia inline em cada lugar é como a régua local do
 * worker passou a discordar da tela em produção (ver `pos-entrada.ts`).
 *
 * `=== true` e não truthy de propósito: é FALHA FECHADA. Coluna nula (linha
 * gravada por uma versão anterior, banco ainda sem a migration), `undefined`
 * (leitura que não trouxe a coluna) e qualquer outra coisa significam "não
 * sei se o operador liberou" — e não sei não responde.
 */
export function grupoLiberaIa(iaResponde: unknown): boolean {
  return iaResponde === true;
}
