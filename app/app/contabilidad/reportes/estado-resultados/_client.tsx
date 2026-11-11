"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import Link from "next/link";

interface PeriodData {
  revenue: number;
  expenses: number;
  gross_profit: number;
  net_income: number;
}

interface IncomeStatement {
  period: { year: number; month: number };
  current: PeriodData;
  previous: PeriodData | null;
}

function formatBs(n: number) {
  return `Bs. ${n.toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const MONTHS = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

export function EstadoResultadosClient() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const { data, isLoading } = useQuery({
    queryKey: ["income-statement", year, month],
    queryFn: () => apiClient.get<IncomeStatement>(`/api/v1/contabilidad/reportes/income-statement?year=${year}&month=${month}`),
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">Estado de Resultados</h1>
        <Link href="/app/contabilidad/reportes" className="text-sm text-blue-600 hover:underline">← Reportes</Link>
      </div>

      <div className="flex items-center gap-3">
        <select value={month} onChange={(e) => setMonth(parseInt(e.target.value))} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm">
          {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
        </select>
        <input type="number" value={year} onChange={(e) => setYear(parseInt(e.target.value) || year)} className="w-24 rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm" />
      </div>

      {isLoading && <p className="text-sm text-text-muted">Cargando...</p>}

      {data && (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
            <h2 className="mb-3 font-semibold text-text-primary">{MONTHS[month - 1]} {year}</h2>
            <Row label="Ingresos" value={data.current.revenue} />
            <Row label="Gastos" value={data.current.expenses} negative />
            <div className="my-2 border-t border-border-primary" />
            <Row label="Utilidad bruta" value={data.current.gross_profit} bold />
            <Row label="Resultado neto" value={data.current.net_income} bold />
          </div>

          {data.previous && (
            <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
              <h2 className="mb-3 font-semibold text-text-muted">Periodo anterior</h2>
              <Row label="Ingresos" value={data.previous.revenue} />
              <Row label="Gastos" value={data.previous.expenses} negative />
              <div className="my-2 border-t border-border-primary" />
              <Row label="Utilidad bruta" value={data.previous.gross_profit} bold />
              <Row label="Resultado neto" value={data.previous.net_income} bold />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, bold, negative }: { label: string; value: number; bold?: boolean; negative?: boolean }) {
  const color = negative ? "text-red-600" : value < 0 ? "text-red-600" : "text-text-primary";
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className={bold ? "font-medium text-text-primary" : "text-text-muted"}>{label}</span>
      <span className={`${bold ? "font-semibold" : ""} ${color}`}>{formatBs(value)}</span>
    </div>
  );
}
