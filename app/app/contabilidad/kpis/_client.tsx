"use client";

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import Link from "next/link";

interface KpiData {
  cashBalance: number;
  revenue: number;
  expenses: number;
  netIncome: number;
  netIncomeTrend: number;
  revenueTrend: number;
  grossMargin: number;
  burnRate: number;
  runwayMonths: number;
  entriesByStatus: { draft: number; posted: number; cancelled: number };
  pnlHistory: { year: number; month: number; period_name: string; revenue: number; expenses: number; net_income: number }[];
  totalAccountsReceivable: number;
  dso: number | null;
  dsoRisk: string | null;
  budgetedExpenses: number | null;
  budgetVariance: number | null;
  budgetVariancePct: number | null;
  budgetRisk: string | null;
}

function formatBs(n: number) {
  return `Bs. ${n.toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function riskBadge(risk: string | null) {
  if (!risk) return null;
  const colors: Record<string, string> = {
    low: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
    medium: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
    high: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
    critical: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  };
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${colors[risk] || ""}`}>{risk}</span>;
}

function trendArrow(val: number) {
  if (val > 0) return <span className="text-green-600">+{val.toFixed(1)}%</span>;
  if (val < 0) return <span className="text-red-600">{val.toFixed(1)}%</span>;
  return <span className="text-text-muted">0%</span>;
}

export function KpisClient() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["contabilidad-kpis"],
    queryFn: () => apiClient.get<KpiData>("/api/v1/contabilidad/kpis"),
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">KPIs Financieros</h1>
          <p className="text-sm text-text-muted">Indicadores clave del negocio</p>
        </div>
        <Link href="/app/contabilidad/reportes" className="text-sm text-blue-600 hover:underline">← Reportes</Link>
      </div>

      {isLoading && <p className="text-sm text-text-muted">Cargando...</p>}
      {isError && <p className="text-sm text-red-500">Error al cargar KPIs</p>}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <KpiCard label="Saldo en caja" value={formatBs(data.cashBalance)} />
            <KpiCard label="Ingresos" value={formatBs(data.revenue)} trend={trendArrow(data.revenueTrend)} />
            <KpiCard label="Gastos" value={formatBs(data.expenses)} />
            <KpiCard label="Resultado neto" value={formatBs(data.netIncome)} trend={trendArrow(data.netIncomeTrend)} />
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <KpiCard label="Margen bruto" value={`${data.grossMargin.toFixed(1)}%`} />
            <KpiCard label="Burn rate" value={formatBs(data.burnRate)} sub="/mes" />
            <KpiCard label="Runway" value={data.runwayMonths >= 999 ? "∞" : `${data.runwayMonths.toFixed(1)} meses`} />
            <KpiCard label="Cuentas x cobrar" value={formatBs(data.totalAccountsReceivable)} />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
              <p className="text-sm text-text-muted">DSO (Dias para cobrar)</p>
              <p className="mt-1 text-2xl font-semibold text-text-primary">{data.dso !== null ? `${data.dso.toFixed(0)} dias` : "N/A"}</p>
              <div className="mt-1">{riskBadge(data.dsoRisk)}</div>
            </div>
            <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
              <p className="text-sm text-text-muted">Variacion presupuesto</p>
              <p className="mt-1 text-2xl font-semibold text-text-primary">
                {data.budgetVariancePct !== null ? `${data.budgetVariancePct.toFixed(1)}%` : "Sin presupuesto"}
              </p>
              <div className="mt-1">{riskBadge(data.budgetRisk)}</div>
            </div>
            <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
              <p className="text-sm text-text-muted">Asientos contables</p>
              <div className="mt-2 flex gap-3 text-sm">
                <span className="text-green-600">{data.entriesByStatus.posted} publicados</span>
                <span className="text-yellow-600">{data.entriesByStatus.draft} borrador</span>
                <span className="text-red-600">{data.entriesByStatus.cancelled} cancelados</span>
              </div>
            </div>
          </div>

          {data.pnlHistory.length > 0 && (
            <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
              <h2 className="mb-3 text-base font-medium text-text-primary">Historial P&L (ultimos 6 meses)</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-text-muted">
                    <tr>
                      <th className="px-3 py-2">Periodo</th>
                      <th className="px-3 py-2 text-right">Ingresos</th>
                      <th className="px-3 py-2 text-right">Gastos</th>
                      <th className="px-3 py-2 text-right">Resultado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-primary">
                    {data.pnlHistory.map((p) => (
                      <tr key={p.period_name}>
                        <td className="px-3 py-2 text-text-primary">{p.period_name}</td>
                        <td className="px-3 py-2 text-right text-text-primary">{formatBs(p.revenue)}</td>
                        <td className="px-3 py-2 text-right text-text-primary">{formatBs(p.expenses)}</td>
                        <td className={`px-3 py-2 text-right font-medium ${p.net_income >= 0 ? "text-green-600" : "text-red-600"}`}>
                          {formatBs(p.net_income)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function KpiCard({ label, value, trend, sub }: { label: string; value: string; trend?: React.ReactNode; sub?: string }) {
  return (
    <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
      <p className="text-sm text-text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-text-primary">
        {value}{sub && <span className="text-sm font-normal text-text-muted">{sub}</span>}
      </p>
      {trend && <div className="mt-1 text-sm">{trend}</div>}
    </div>
  );
}
