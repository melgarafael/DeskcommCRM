"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

interface CommissionEntry {
  member_id: string;
  member_name: string;
  commission_rate: number | null;
  total_sales: number;
  total_commission: number;
  sales_count: number;
}

function formatBs(n: number) {
  return `Bs. ${n.toFixed(2)}`;
}

function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function ComisionesPOSClient() {
  const qc = useQueryClient();
  const [period, setPeriod] = useState(currentPeriod);

  const { data: commissions, isLoading } = useQuery({
    queryKey: ["pos-commissions", period],
    queryFn: () => apiClient.get<CommissionEntry[]>(`/api/v1/pos/commissions?period=${period}`),
  });

  const closePeriod = useMutation({
    mutationFn: () => apiClient.post(`/api/v1/pos/commissions/close-period`, { period }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pos-commissions"] }),
  });

  const totalSales = commissions?.reduce((s, c) => s + c.total_sales, 0) ?? 0;
  const totalCommission = commissions?.reduce((s, c) => s + c.total_commission, 0) ?? 0;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-text-primary">Comisiones</h1>
        <div className="ml-auto flex items-center gap-2">
          <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary" />
          <button onClick={() => closePeriod.mutate()} disabled={closePeriod.isPending} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {closePeriod.isPending ? "Cerrando..." : "Cerrar período"}
          </button>
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-text-muted">Cargando...</p>
      ) : !commissions?.length ? (
        <p className="text-sm text-text-muted">Sin datos de comisiones para este período</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
              <p className="text-xs text-text-muted">Ventas totales</p>
              <p className="text-xl font-bold text-text-primary">{formatBs(totalSales)}</p>
            </div>
            <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
              <p className="text-xs text-text-muted">Comisiones totales</p>
              <p className="text-xl font-bold text-blue-600 dark:text-blue-400">{formatBs(totalCommission)}</p>
            </div>
            <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
              <p className="text-xs text-text-muted">Profesionales</p>
              <p className="text-xl font-bold text-text-primary">{commissions.length}</p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-primary text-left text-text-muted">
                  <th className="pb-2">Profesional</th>
                  <th className="pb-2 text-right">Ventas</th>
                  <th className="pb-2 text-right">Cantidad</th>
                  <th className="pb-2 text-right">Tasa</th>
                  <th className="pb-2 text-right">Comisión</th>
                </tr>
              </thead>
              <tbody>
                {commissions.map((c) => (
                  <tr key={c.member_id} className="border-b border-border-primary">
                    <td className="py-2 text-text-primary">{c.member_name}</td>
                    <td className="py-2 text-right text-text-muted">{formatBs(c.total_sales)}</td>
                    <td className="py-2 text-right text-text-muted">{c.sales_count}</td>
                    <td className="py-2 text-right text-text-muted">{c.commission_rate != null ? `${c.commission_rate}%` : "—"}</td>
                    <td className="py-2 text-right font-medium text-text-primary">{formatBs(c.total_commission)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
