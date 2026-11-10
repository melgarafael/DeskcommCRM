"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

interface AccountReceivable {
  id: string;
  contact_id: string | null;
  description: string | null;
  original_amount: number;
  paid_amount: number;
  balance: number;
  due_date: string;
  status: "pending" | "partial" | "paid" | "overdue" | "written_off";
  created_at: string;
}

interface AgingBucket {
  bucket: string;
  count: number;
  total: number;
}

function formatBs(n: number) {
  return `Bs. ${n.toFixed(2)}`;
}

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  pending: { label: "Pendiente", cls: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400" },
  partial: { label: "Parcial", cls: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400" },
  paid: { label: "Pagado", cls: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400" },
  overdue: { label: "Vencido", cls: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400" },
  written_off: { label: "Incobrable", cls: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400" },
};

export function CuentasPorCobrarPOSClient() {
  const [statusFilter, setStatusFilter] = useState("");

  const { data: accounts, isLoading } = useQuery({
    queryKey: ["pos-accounts-receivable", statusFilter],
    queryFn: () => apiClient.get<AccountReceivable[]>(`/api/v1/pos/accounts-receivable${statusFilter ? `?status=${statusFilter}` : ""}`),
  });

  const { data: aging } = useQuery({
    queryKey: ["pos-aging"],
    queryFn: () => apiClient.get<AgingBucket[]>("/api/v1/pos/accounts-receivable/aging"),
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold text-text-primary">Cuentas por Cobrar</h1>

      {aging && aging.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {aging.map((b) => (
            <div key={b.bucket} className="rounded-lg border border-border-primary bg-surface-primary p-3">
              <p className="text-xs text-text-muted">{b.bucket}</p>
              <p className="text-lg font-semibold text-text-primary">{formatBs(b.total)}</p>
              <p className="text-xs text-text-muted">{b.count} cuenta{b.count !== 1 ? "s" : ""}</p>
            </div>
          ))}
        </div>
      )}

      <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="w-fit rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary">
        <option value="">Todos los estados</option>
        <option value="pending">Pendiente</option>
        <option value="partial">Parcial</option>
        <option value="paid">Pagado</option>
        <option value="overdue">Vencido</option>
        <option value="written_off">Incobrable</option>
      </select>

      {isLoading ? (
        <p className="text-sm text-text-muted">Cargando...</p>
      ) : !accounts?.length ? (
        <p className="text-sm text-text-muted">No hay cuentas por cobrar</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-primary text-left text-text-muted">
                <th className="pb-2">Descripción</th>
                <th className="pb-2 text-right">Monto</th>
                <th className="pb-2 text-right">Pagado</th>
                <th className="pb-2 text-right">Saldo</th>
                <th className="pb-2">Vence</th>
                <th className="pb-2">Estado</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const st = STATUS_LABELS[a.status] ?? STATUS_LABELS["pending"]!;
                return (
                  <tr key={a.id} className="border-b border-border-primary">
                    <td className="py-2 text-text-primary">{a.description ?? "—"}</td>
                    <td className="py-2 text-right text-text-muted">{formatBs(a.original_amount)}</td>
                    <td className="py-2 text-right text-text-muted">{formatBs(a.paid_amount)}</td>
                    <td className="py-2 text-right font-medium text-text-primary">{formatBs(a.balance)}</td>
                    <td className="py-2 text-text-muted">{new Date(a.due_date).toLocaleDateString("es-BO")}</td>
                    <td className="py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${st.cls}`}>{st.label}</span></td>
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
