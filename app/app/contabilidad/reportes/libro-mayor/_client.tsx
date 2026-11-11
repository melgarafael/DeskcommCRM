"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import Link from "next/link";

interface LedgerEntry {
  account_id: string;
  code: string;
  account_name: string;
  entry_date: string;
  entry_number: string;
  line_description: string | null;
  debit: number;
  credit: number;
  running_balance: number;
}

interface Account {
  id: string;
  code: string;
  name: string;
}

interface LedgerResponse {
  entries: LedgerEntry[];
  accounts: Account[];
  filters: { account_id: string | null; startDate: string | null; endDate: string | null };
}

function formatBs(n: number) {
  return `Bs. ${n.toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function LibroMayorClient() {
  const [accountId, setAccountId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const params = new URLSearchParams();
  if (accountId) params.set("account_id", accountId);
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);

  const { data, isLoading } = useQuery({
    queryKey: ["general-ledger", accountId, startDate, endDate],
    queryFn: () => apiClient.get<LedgerResponse>(`/api/v1/contabilidad/reportes/general-ledger?${params.toString()}`),
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">Libro Mayor</h1>
        <Link href="/app/contabilidad/reportes" className="text-sm text-blue-600 hover:underline">← Reportes</Link>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs text-text-muted">Cuenta</label>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm">
            <option value="">Todas</option>
            {(data?.accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.code} - {a.name}</option>)}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-muted">Desde</label>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-muted">Hasta</label>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm" />
        </div>
      </div>

      {isLoading && <p className="text-sm text-text-muted">Cargando...</p>}

      {data && (
        <div className="overflow-x-auto rounded-lg border border-border-primary">
          <table className="w-full text-sm">
            <thead className="bg-surface-secondary text-left text-text-muted">
              <tr>
                <th className="px-3 py-2">Fecha</th>
                <th className="px-3 py-2">Asiento</th>
                <th className="px-3 py-2">Cuenta</th>
                <th className="px-3 py-2">Descripcion</th>
                <th className="px-3 py-2 text-right">Debe</th>
                <th className="px-3 py-2 text-right">Haber</th>
                <th className="px-3 py-2 text-right">Saldo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-primary">
              {data.entries.length === 0 ? (
                <tr><td colSpan={7} className="px-3 py-4 text-center text-text-muted">Sin movimientos</td></tr>
              ) : data.entries.map((e, i) => (
                <tr key={`${e.entry_number}-${i}`}>
                  <td className="px-3 py-2 text-text-muted">{e.entry_date}</td>
                  <td className="px-3 py-2 font-mono text-text-muted">{e.entry_number}</td>
                  <td className="px-3 py-2 text-text-primary">{e.code} - {e.account_name}</td>
                  <td className="px-3 py-2 text-text-muted">{e.line_description || "-"}</td>
                  <td className="px-3 py-2 text-right text-text-primary">{e.debit > 0 ? formatBs(e.debit) : "-"}</td>
                  <td className="px-3 py-2 text-right text-text-primary">{e.credit > 0 ? formatBs(e.credit) : "-"}</td>
                  <td className={`px-3 py-2 text-right font-medium ${e.running_balance < 0 ? "text-red-600" : "text-text-primary"}`}>{formatBs(e.running_balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
