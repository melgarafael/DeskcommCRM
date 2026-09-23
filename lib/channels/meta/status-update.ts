/**
 * `statuses[]` da Cloud API → colunas da linha de `messages`.
 *
 * Existe porque a rota do webhook gravava só `status: failed | sent` e jogava
 * fora o resto do evento. O estrago aparece quando o template é ACEITO pela
 * Meta (a chamada volta 200 com `wamid`, a linha nasce `sent`) e a entrega
 * falha depois: o motivo vem em `statuses[0].errors[0]` — 131026 número não
 * registrado, 131047 fora da janela sem template, 131049 limite de marketing,
 * 132015 template pausado — e nenhum deles chegava ao operador. A tela dizia
 * "enviado" para uma mensagem que nunca tocou o aparelho, e não havia onde
 * olhar.
 *
 * `delivered` e `read` também se perdiam: viravam `sent`, e `delivered_at` /
 * `read_at` ficavam nulos para sempre neste canal. O canal não-oficial já
 * grava os dois (`lib/waha/ingest.ts`, `handleAck`); a assimetria era o defeito,
 * não o desenho.
 *
 * `status` continua colapsado em `sent | failed` de propósito: é o domínio que
 * o resto do produto lê. A informação fina vai para as colunas que já existem.
 */
import type { MessageStatusEvent } from "./webhook";

export function statusUpdate(e: MessageStatusEvent, now: string): Record<string, unknown> {
  const update: Record<string, unknown> = {
    status: e.status === "failed" ? "failed" : "sent",
    updated_at: now,
  };

  // `read` implica entregue — a Meta não manda `delivered` garantido antes.
  if (e.status === "delivered" || e.status === "read") update.delivered_at = now;
  if (e.status === "read") update.read_at = now;

  if (e.status === "failed") {
    // `error_code` é texto no banco (o canal não-oficial grava rótulos ali).
    update.error_code = e.errorCode === null ? null : String(e.errorCode);
    update.error_message = e.errorTitle;
  }

  return update;
}
