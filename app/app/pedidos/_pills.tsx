import { ROTULO_DO_STATUS, type StatusDoPedido } from "@/lib/schemas/pedidos";

/**
 * Pills de status no molde do Mercos (Em orçamento amarelo, Concluído verde…).
 * Puro e partilhável entre lista e detalhe — sem "use client".
 */
const CLASSE_DA_PILL: Record<StatusDoPedido, string> = {
  rascunho: "bg-yellow-100 text-yellow-800",
  em_analise: "bg-amber-100 text-amber-800",
  aprovado: "bg-blue-100 text-blue-800",
  faturado: "bg-violet-100 text-violet-800",
  expedido: "bg-indigo-100 text-indigo-800",
  entregue: "bg-[#7cb342] text-white",
  cancelado: "bg-muted text-muted-foreground",
};

/** Rótulo da pill: rascunho aparece como "Em orçamento", como no Mercos. */
export function rotuloDaPill(status: StatusDoPedido): string {
  if (status === "rascunho") return "Em orçamento";
  if (status === "entregue") return "Concluído";
  return ROTULO_DO_STATUS[status] ?? status;
}

export function PillDoStatus({ status }: { status: StatusDoPedido }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${CLASSE_DA_PILL[status] ?? "bg-muted text-muted-foreground"}`}
    >
      {rotuloDaPill(status)}
    </span>
  );
}
