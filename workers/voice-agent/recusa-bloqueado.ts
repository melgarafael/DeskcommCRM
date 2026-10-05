/**
 * workers/voice-agent/recusa-bloqueado.ts
 *
 * A DECISÃO "bloqueado na ligação é recusado", pura e exportada de
 * propósito: o teste ao lado mede cada caso, e o teste do fio
 * (`fio-recusa-bloqueado.test.ts`) prova que `handleStasisStart` USA esta
 * função — função pura órfã não conta como implementação.
 *
 * Fail-open: só `is_blocked === true` positivo recusa.
 * `null`/erro (`false`, `null`, `undefined`) segue como hoje — recusar no
 * escuro derrubaria ligação legítima por instabilidade transitória.
 */

/** O `end_reason` gravado na linha recusada — campo sem CHECK de propósito, sem migration. */
export const END_REASON_CONTACT_BLOCKED = "contact_blocked";

/**
 * Decide se a chamada de entrada deve ser recusada pelo bloqueio do contato.
 *
 * SABOTAGEM (prova no CI):
 * - apagar o `=== true` (recusar por qualquer valor) = caso 2 vermelho;
 * - trocar por `return true` sempre = caso 2 vermelho;
 * - trocar por `return false` sempre = caso 1 vermelho.
 */
export function deveRecusarChamada(isBlocked: boolean | null | undefined): boolean {
  return isBlocked === true;
}
