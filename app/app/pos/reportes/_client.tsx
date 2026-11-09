"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

type TabKey = "daily" | "by_payment_method" | "tax_summary";

interface DailyRow {
  date: string;
  total_sales: number;
  total_amount: number;
}

interface PaymentMethodRow {
  payment_method: string;
  total_transactions: number;
  total_amount: number;
}

interface TaxRow {
  tax_name: string;
  tax_rate: number;
  base_amount: number;
  tax_amount: number;
}

const TABS: { key: TabKey; label: string }[] = [
  { key: "daily", label: "Ventas Diarias" },
  { key: "by_payment_method", label: "Por Metodo de Pago" },
  { key: "tax_summary", label: "Resumen Fiscal" },
];

function formatBs(amount: number) {
  return `Bs. ${amount.toFixed(2)}`;
}

export function ReportesPOSClient() {
  const [tab, setTab] = useState<TabKey>("daily");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["pos-reports", tab],
    queryFn: () => apiClient.get<unknown[]>(`/api/v1/pos/reports?type=${tab}`),
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold text-text-primary">Reportes POS</h1>

      {/* Tab selector */}
      <div className="flex gap-1 rounded-lg border border-border-primary bg-surface-secondary p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.key
                ? "bg-surface-primary text-text-primary shadow-sm"
                : "text-text-muted hover:text-text-primary"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Table content */}
      <div className="rounded-lg border border-border-primary bg-surface-primary">
        {isLoading ? (
          <p className="p-4 text-sm text-text-muted">Cargando...</p>
        ) : isError ? (
          <p className="p-4 text-sm text-red-600">Error al cargar datos</p>
        ) : !data?.length ? (
          <p className="p-4 text-sm text-text-muted">Sin datos para mostrar</p>
        ) : tab === "daily" ? (
          <DailyTable rows={data as DailyRow[]} />
        ) : tab === "by_payment_method" ? (
          <PaymentMethodTable rows={data as PaymentMethodRow[]} />
        ) : (
          <TaxTable rows={data as TaxRow[]} />
        )}
      </div>
    </div>
  );
}

function DailyTable({ rows }: { rows: DailyRow[] }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border-primary text-left text-text-muted">
          <th className="px-4 py-3 font-medium">Fecha</th>
          <th className="px-4 py-3 font-medium text-right">Ventas</th>
          <th className="px-4 py-3 font-medium text-right">Monto Total</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border-primary">
        {rows.map((r, i) => (
          <tr key={i}>
            <td className="px-4 py-3 text-text-primary">
              {new Date(r.date).toLocaleDateString("es-BO")}
            </td>
            <td className="px-4 py-3 text-right text-text-primary">{r.total_sales}</td>
            <td className="px-4 py-3 text-right text-text-primary">{formatBs(r.total_amount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PaymentMethodTable({ rows }: { rows: PaymentMethodRow[] }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border-primary text-left text-text-muted">
          <th className="px-4 py-3 font-medium">Metodo de Pago</th>
          <th className="px-4 py-3 font-medium text-right">Transacciones</th>
          <th className="px-4 py-3 font-medium text-right">Monto Total</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border-primary">
        {rows.map((r, i) => (
          <tr key={i}>
            <td className="px-4 py-3 text-text-primary">{r.payment_method}</td>
            <td className="px-4 py-3 text-right text-text-primary">{r.total_transactions}</td>
            <td className="px-4 py-3 text-right text-text-primary">{formatBs(r.total_amount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TaxTable({ rows }: { rows: TaxRow[] }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border-primary text-left text-text-muted">
          <th className="px-4 py-3 font-medium">Impuesto</th>
          <th className="px-4 py-3 font-medium text-right">Tasa (%)</th>
          <th className="px-4 py-3 font-medium text-right">Base Imponible</th>
          <th className="px-4 py-3 font-medium text-right">Impuesto</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border-primary">
        {rows.map((r, i) => (
          <tr key={i}>
            <td className="px-4 py-3 text-text-primary">{r.tax_name}</td>
            <td className="px-4 py-3 text-right text-text-primary">{r.tax_rate}%</td>
            <td className="px-4 py-3 text-right text-text-primary">{formatBs(r.base_amount)}</td>
            <td className="px-4 py-3 text-right text-text-primary">{formatBs(r.tax_amount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
