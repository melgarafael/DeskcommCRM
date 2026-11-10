"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

interface Statistics {
  period: { from: string; to: string };
  revenue: {
    total: number;
    by_method: Record<string, number>;
    by_service: { service_name: string; total: number }[];
    by_day: { date: string; total: number }[];
  };
  expenses: {
    total: number;
    by_category: Record<string, number>;
  };
  profit: number;
  sales_count: number;
  avg_ticket: number;
}

function formatBs(n: number) {
  return `Bs. ${n.toFixed(2)}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function thirtyDaysAgo() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

export function EstadisticasPOSClient() {
  const [from, setFrom] = useState(thirtyDaysAgo);
  const [to, setTo] = useState(today);

  const { data: stats, isLoading } = useQuery({
    queryKey: ["pos-statistics", from, to],
    queryFn: () => apiClient.get<Statistics>(`/api/v1/pos/statistics?from=${from}&to=${to}`),
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-text-primary">Estadísticas</h1>
        <div className="ml-auto flex items-center gap-2">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary" />
          <span className="text-text-muted">—</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary" />
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-text-muted">Cargando...</p>
      ) : !stats ? (
        <p className="text-sm text-text-muted">Sin datos para el período</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
              <p className="text-xs text-text-muted">Ingresos</p>
              <p className="text-xl font-bold text-green-600 dark:text-green-400">{formatBs(stats.revenue.total)}</p>
            </div>
            <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
              <p className="text-xs text-text-muted">Gastos</p>
              <p className="text-xl font-bold text-red-600 dark:text-red-400">{formatBs(stats.expenses.total)}</p>
            </div>
            <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
              <p className="text-xs text-text-muted">Ganancia</p>
              <p className={`text-xl font-bold ${stats.profit >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>{formatBs(stats.profit)}</p>
            </div>
            <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
              <p className="text-xs text-text-muted">Ventas</p>
              <p className="text-xl font-bold text-text-primary">{stats.sales_count}</p>
              <p className="text-xs text-text-muted">Ticket promedio: {formatBs(stats.avg_ticket)}</p>
            </div>
          </div>

          {Object.keys(stats.revenue.by_method).length > 0 && (
            <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
              <h2 className="mb-3 text-sm font-semibold text-text-primary">Ingresos por método de pago</h2>
              <div className="space-y-2">
                {Object.entries(stats.revenue.by_method).map(([method, total]) => (
                  <div key={method} className="flex items-center justify-between text-sm">
                    <span className="text-text-muted capitalize">{method}</span>
                    <span className="text-text-primary">{formatBs(total)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {stats.revenue.by_service.length > 0 && (
            <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
              <h2 className="mb-3 text-sm font-semibold text-text-primary">Ingresos por servicio</h2>
              <div className="space-y-2">
                {stats.revenue.by_service.map((s) => (
                  <div key={s.service_name} className="flex items-center justify-between text-sm">
                    <span className="text-text-muted">{s.service_name}</span>
                    <span className="text-text-primary">{formatBs(s.total)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {Object.keys(stats.expenses.by_category).length > 0 && (
            <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
              <h2 className="mb-3 text-sm font-semibold text-text-primary">Gastos por categoría</h2>
              <div className="space-y-2">
                {Object.entries(stats.expenses.by_category).map(([cat, total]) => (
                  <div key={cat} className="flex items-center justify-between text-sm">
                    <span className="text-text-muted capitalize">{cat}</span>
                    <span className="text-text-primary">{formatBs(total)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
