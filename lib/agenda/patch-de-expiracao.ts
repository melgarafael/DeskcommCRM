/**
 * O que o cron `agenda-expira-pendentes` grava ao liberar um pedido que ninguém decidiu.
 *
 * `cancelled_at` é obrigatório: a constraint `calendar_appointments_cancelamento_coerente`
 * recusa `status = 'cancelled'` sem ele, e como o UPDATE da rota é um único `.in(ids)`,
 * uma linha recusada derruba a rodada inteira (500) e deixa todos os pendentes
 * segurando o horário.
 */
export function patchDeExpiracao(agora: Date) {
  return {
    status: "cancelled" as const,
    cancelled_at: agora.toISOString(),
    cancellation_reason: "Pedido expirado: ninguém confirmou dentro do prazo.",
  };
}
