"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiClient } from "@/lib/api/client";

type FiscalRow = Record<string, string | number>;

const TABS = [
  { key: "ventas", label: "Libro Ventas IVA" },
  { key: "compras", label: "Libro Compras IVA" },
  { key: "iva", label: "Declaracion IVA" },
  { key: "it", label: "Declaracion IT" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const now = new Date();
const currentYear = now.getFullYear();
const currentMonth = now.getMonth() + 1;

export function LibrosFiscales() {
  const [activeTab, setActiveTab] = useState<TabKey>("ventas");
  const [year, setYear] = useState(currentYear);
  const [month, setMonth] = useState(currentMonth);

  const fiscalData = useQuery({
    queryKey: ["fiscal", activeTab, year, month],
    queryFn: () =>
      apiClient.get<FiscalRow[]>(
        `/api/v1/finance/fiscal/libros?type=${activeTab}&year=${year}&month=${month}`
      ),
  });

  // Derive column headers from data
  const columns = fiscalData.data && fiscalData.data.length > 0
    ? Object.keys(fiscalData.data[0] as Record<string, unknown>)
    : [];

  const years = Array.from({ length: 5 }, (_, i) => currentYear - i);
  const months = [
    "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-text-primary">Libros Fiscales</h1>
        <p className="text-sm text-text-muted">Libros de ventas, compras y declaraciones tributarias.</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border-primary">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === tab.key
                ? "border-b-2 border-blue-600 text-blue-600"
                : "text-text-muted hover:text-text-primary"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Period filters */}
      <div className="flex items-center gap-3">
        <select
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
          className="rounded border border-border-primary bg-surface-primary px-3 py-1.5 text-sm text-text-primary"
        >
          {years.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
        <select
          value={month}
          onChange={(e) => setMonth(Number(e.target.value))}
          className="rounded border border-border-primary bg-surface-primary px-3 py-1.5 text-sm text-text-primary"
        >
          {months.map((m, i) => (
            <option key={i + 1} value={i + 1}>{m}</option>
          ))}
        </select>
      </div>

      {/* Data table */}
      {fiscalData.isLoading && <p className="text-sm text-text-muted">Cargando...</p>}
      {fiscalData.isError && <p className="text-sm text-red-500">Error al cargar datos</p>}

      {fiscalData.data && fiscalData.data.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border-primary">
          <table className="w-full text-sm">
            <thead className="bg-surface-secondary text-left text-text-muted">
              <tr>
                {columns.map((col) => (
                  <th key={col} className="whitespace-nowrap px-3 py-2">{col}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-primary">
              {fiscalData.data.map((row, idx) => (
                <tr key={idx}>
                  {columns.map((col) => (
                    <td key={col} className="whitespace-nowrap px-3 py-2 text-text-primary">
                      {String(row[col] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!fiscalData.isLoading && fiscalData.data?.length === 0 && (
        <p className="text-sm text-text-muted">
          Sin datos para {months[month - 1]} {year}.
        </p>
      )}
    </div>
  );
}
