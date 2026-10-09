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

/** O `end_reason` da recusada de pessoal — motivo próprio, nunca `opt_out` nem o de bloqueio. */
export const END_REASON_CONTACT_PERSONAL = "contato_pessoal";

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

/**
 * Decide se a chamada de entrada deve ser recusada por contato pessoal
 * (spec 21, etapa 14 — critério 11): o mesmo tratamento do bloqueado.
 *
 * Função SEPARADA (e não um segundo parâmetro em `deveRecusarChamada`) porque
 * o `end_reason` gravado difere: bloqueado some como recusada, pessoal some
 * do histórico — e quem lê o motivo na linha precisa saber qual dos dois foi.
 * Fail-open igual: só `true` positivo recusa.
 *
 * SABOTAGEM (prova no CI):
 * - trocar por `return false` sempre = caso de pessoal vermelho (a IA atende);
 * - trocar por `return true` sempre = caso normal vermelho.
 */
export function deveRecusarChamadaPessoal(isPersonal: boolean | null | undefined): boolean {
  return isPersonal === true;
}
