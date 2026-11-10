"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

interface Invoice {
  id: string;
  invoice_number: string;
  invoice_date: string;
  customer_name: string | null;
  customer_nit: string | null;
  subtotal: number | null;
  tax_total: number | null;
  total: number;
  status: "draft" | "issued" | "paid" | "void";
}

function formatBs(n: number) {
  return `Bs. ${n.toFixed(2)}`;
}

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  draft: { label: "Borrador", cls: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400" },
  issued: { label: "Emitida", cls: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400" },
  paid: { label: "Pagada", cls: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400" },
  void: { label: "Anulada", cls: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400" },
};

export function FacturasPOSClient() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("");

  const { data: invoices, isLoading } = useQuery({
    queryKey: ["pos-invoices", statusFilter],
    queryFn: () => apiClient.get<Invoice[]>(`/api/v1/pos/invoices${statusFilter ? `?status=${statusFilter}` : ""}`),
  });

  const voidInvoice = useMutation({
    mutationFn: (id: string) => apiClient.put(`/api/v1/pos/invoices/${id}`, { action: "void" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pos-invoices"] }),
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">Facturas</h1>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary">
          <option value="">Todas</option>
          <option value="draft">Borrador</option>
          <option value="issued">Emitidas</option>
          <option value="paid">Pagadas</option>
          <option value="void">Anuladas</option>
        </select>
      </div>

      {isLoading ? (
        <p className="text-sm text-text-muted">Cargando...</p>
      ) : !invoices?.length ? (
        <p className="text-sm text-text-muted">No hay facturas</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-primary text-left text-text-muted">
                <th className="pb-2">Número</th>
                <th className="pb-2">Fecha</th>
                <th className="pb-2">Cliente</th>
                <th className="pb-2">NIT</th>
                <th className="pb-2 text-right">Total</th>
                <th className="pb-2">Estado</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => {
                const st = STATUS_LABELS[inv.status] ?? STATUS_LABELS["draft"]!;
                return (
                  <tr key={inv.id} className="border-b border-border-primary">
                    <td className="py-2 font-mono text-text-primary">{inv.invoice_number}</td>
                    <td className="py-2 text-text-muted">{new Date(inv.invoice_date).toLocaleDateString("es-BO")}</td>
                    <td className="py-2 text-text-primary">{inv.customer_name ?? "—"}</td>
                    <td className="py-2 text-text-muted">{inv.customer_nit ?? "—"}</td>
                    <td className="py-2 text-right text-text-primary">{formatBs(inv.total)}</td>
                    <td className="py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${st.cls}`}>{st.label}</span></td>
                    <td className="py-2">
                      {inv.status !== "void" && (
                        <button onClick={() => voidInvoice.mutate(inv.id)} disabled={voidInvoice.isPending} className="text-xs text-red-600 hover:underline dark:text-red-400">
                          Anular
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
