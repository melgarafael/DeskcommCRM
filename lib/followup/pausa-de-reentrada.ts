/**
 * A PAUSA ANTES DE O FLUXO DE SILÊNCIO RECOMEÇAR PARA QUEM JÁ PASSOU POR ELE.
 *
 * ─── O defeito ─────────────────────────────────────────────────────────────
 *
 * Medido numa instalação real (25–26/09/2026), num fluxo de silêncio de 1 hora
 * com `cancel_on_reply`:
 *
 *   - a cliente respondeu "gracias" a uma mensagem do fluxo; a resposta cancelou
 *     a inscrição, o agente respondeu, e UMA HORA depois a varredura a inscreveu
 *     de novo, do primeiro passo — outra oferta, e assim a cada "gracias";
 *   - dois contatos entraram em laço: o passo de IA terminava sem enviar (numa
 *     das conversas, porque uma pessoa da equipe já a tinha assumido), a
 *     inscrição era cancelada, e a varredura seguinte a recriava — ~95 vezes,
 *     sem nunca chegar ao segundo passo.
 *
 * O cooldown da varredura (`silence-sweep.ts`) não segura nenhum dos dois: ele
 * espera `threshold_minutes` desde o FIM da tentativa anterior, e com
 * `cancel_on_reply` a resposta do cliente encerra a inscrição no mesmo instante
 * em que o silêncio começa — cooldown e limiar vencem juntos. No laço, ele
 * espaça as reinscrições (uma por limiar), mas não as encerra.
 *
 * ─── A regra ───────────────────────────────────────────────────────────────
 *
 * `trigger_config.params.reentry_pause_minutes` (opcional; ausente ou 0 = sem
 * pausa, o comportamento de antes). Com pausa, um contato que JÁ TEVE uma
 * inscrição ENCERRADA neste fluxo só volta a entrar quando passar a pausa
 * inteira desde o MAIS RECENTE entre:
 *
 *   - o fim dessa inscrição (cobre o laço e o fluxo que termina sem guarda);
 *   - a última mensagem do contato (cobre quem respondeu e segue conversando:
 *     cada mensagem nova recomeça a contagem).
 *
 * Quem nunca passou pelo fluxo não é afetado: entra no limiar de sempre. A
 * cadência dentro do fluxo (as esperas entre os passos) também não muda — a
 * pausa só decide QUANDO o fluxo pode recomeçar do início.
 *
 * Por fluxo, e não por organização: é a política de reentrada DESTE fluxo. O
 * índice `idx_followup_enrollments_one_live` já impede dois fluxos vivos ao
 * mesmo tempo para o mesmo contato.
 */

/** Teto da pausa: 90 dias, o mesmo do gatilho "cliente voltou". */
export const MAX_PAUSA_DE_REENTRADA_MINUTES = 90 * 24 * 60;

/**
 * De onde a pausa conta.
 *
 * - `ultima_mensagem` (padrão): do MAIS RECENTE entre o fim da inscrição e a
 *   última mensagem do cliente — cada mensagem nova recomeça a contagem. É o que
 *   o remarketing quer: quem respondeu e segue conversando não recebe a cadeia de
 *   venda de novo.
 * - `ultimo_envio`: só do fim da inscrição anterior. É o que um toque curto quer
 *   (pedido de uma loja, 27/09/2026: "10 minutos depois de o cliente parar de
 *   responder, uma vez por dia"): com o teto de silêncio de 60 min, a base
 *   `ultima_mensagem` com pausa de 24 h NUNCA se cumpre — a pausa conta da
 *   mensagem que acabou de chegar, e a janela fecha em 60 min —, e o toque saía
 *   uma vez por contato para sempre.
 */
export const BASES_DA_PAUSA = ["ultima_mensagem", "ultimo_envio"] as const;
export type BaseDaPausa = (typeof BASES_DA_PAUSA)[number];

export interface FatosDaReentrada {
  /** Quando terminou a inscrição encerrada mais recente deste fluxo para o contato (ms). */
  encerradaEm: number;
  /** Quando o contato escreveu por último (ms); `null` se não se sabe. */
  ultimaMensagemEm: number | null;
}

/**
 * Até quando (ms) o contato espera antes de o fluxo recomeçar. `null` = não há
 * pausa a respeitar (sem pausa configurada, ou o contato nunca encerrou uma
 * inscrição deste fluxo).
 */
export function pausaDeReentradaAte(
  fatos: FatosDaReentrada | undefined,
  pausaMinutos: number,
  base: BaseDaPausa = "ultima_mensagem",
): number | null {
  if (!fatos || !(pausaMinutos > 0)) return null;
  const referencia =
    base === "ultimo_envio"
      ? fatos.encerradaEm
      : Math.max(fatos.encerradaEm, fatos.ultimaMensagemEm ?? fatos.encerradaEm);
  return referencia + pausaMinutos * 60_000;
}

/** O contato ainda está na pausa? Inclusivo no fim: exatamente na hora, já pode entrar. */
export function emPausaDeReentrada(
  fatos: FatosDaReentrada | undefined,
  pausaMinutos: number,
  agora: Date,
  base: BaseDaPausa = "ultima_mensagem",
): boolean {
  const ate = pausaDeReentradaAte(fatos, pausaMinutos, base);
  return ate !== null && agora.getTime() < ate;
}
