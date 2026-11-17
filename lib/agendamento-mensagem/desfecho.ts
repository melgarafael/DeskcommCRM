/**
 * O que a linha do Relatório diz sobre um agendamento que já teve desfecho.
 *
 * `encaminhada` NÃO é "enviada": o cron entregou ao envio, e a mensagem pode
 * estar em `queued`/`sending` esperando o canal. Quando há mensagem, é o status
 * DELA que manda (doc 314, pendência 2).
 */
export type TomDoDesfecho = "success" | "warning" | "error" | "neutral";

export interface AgendamentoComMensagem {
  status: "agendada" | "encaminhada" | "falhou" | "cancelada";
  mensagem: { status: string } | null;
}

const SAIU = new Set(["sent", "delivered", "read"]);

/** A chave do desfecho; o texto na tela sai de um `t("…")` literal por chave, no componente. */
export type Desfecho = "enviada" | "na_fila" | "falhou" | "cancelada";

export function desfechoDoAgendamento(a: AgendamentoComMensagem): { desfecho: Desfecho; tom: TomDoDesfecho } {
  if (a.status === "cancelada") return { desfecho: "cancelada", tom: "neutral" };
  if (a.status === "falhou" || a.mensagem?.status === "failed") return { desfecho: "falhou", tom: "error" };
  if (a.status === "encaminhada" && a.mensagem && SAIU.has(a.mensagem.status)) return { desfecho: "enviada", tom: "success" };
  return { desfecho: "na_fila", tom: "warning" };
}
