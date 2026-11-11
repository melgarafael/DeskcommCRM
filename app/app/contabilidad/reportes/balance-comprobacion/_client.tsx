"use client";

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import Link from "next/link";

interface TrialBalanceRow {
  code: string;
  name: string;
  account_type: string;
  increases_on: string;
  total_debit: number;
  total_credit: number;
  balance: number;
}

interface TrialBalance {
  data: TrialBalanceRow[];
  totals: { totalDebit: number; totalCredit: number };
  is_balanced: boolean;
}

function formatBs(n: number) {
  return `Bs. ${n.toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function BalanceComprobacionClient() {
  const { data, isLoading } = useQuery({
    queryKey: ["trial-balance"],
    queryFn: () => apiClient.get<TrialBalance>("/api/v1/contabilidad/reportes/trial-balance"),
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">Balance de Comprobacion</h1>
        <Link href="/app/contabilidad/reportes" className="text-sm text-blue-600 hover:underline">← Reportes</Link>
      </div>

      {isLoading && <p className="text-sm text-text-muted">Cargando...</p>}

      {data && (
        <>
          {data.is_balanced ? (
            <p className="rounded-md bg-green-50 p-2 text-sm text-green-700 dark:bg-green-900/20 dark:text-green-400">Balance cuadrado</p>
          ) : (
            <p className="rounded-md bg-red-50 p-2 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400">Balance descuadrado — diferencia: {formatBs(Math.abs(data.totals.totalDebit - data.totals.totalCredit))}</p>
          )}

          <div className="overflow-x-auto rounded-lg border border-border-primary">
            <table className="w-full text-sm">
              <thead className="bg-surface-secondary text-left text-text-muted">
                <tr>
                  <th className="px-3 py-2">Codigo</th>
                  <th className="px-3 py-2">Cuenta</th>
                  <th className="px-3 py-2 text-right">Debe</th>
                  <th className="px-3 py-2 text-right">Haber</th>
                  <th className="px-3 py-2 text-right">Saldo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-primary">
                {data.data.map((row) => (
                  <tr key={row.code}>
                    <td className="px-3 py-2 font-mono text-text-muted">{row.code}</td>
                    <td className="px-3 py-2 text-text-primary">{row.name}</td>
                    <td className="px-3 py-2 text-right text-text-primary">{formatBs(row.total_debit)}</td>
                    <td className="px-3 py-2 text-right text-text-primary">{formatBs(row.total_credit)}</td>
                    <td className={`px-3 py-2 text-right font-medium ${row.balance < 0 ? "text-red-600" : "text-text-primary"}`}>{formatBs(row.balance)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-surface-secondary font-medium text-text-primary">
                <tr>
                  <td className="px-3 py-2" colSpan={2}>Totales</td>
                  <td className="px-3 py-2 text-right">{formatBs(data.totals.totalDebit)}</td>
                  <td className="px-3 py-2 text-right">{formatBs(data.totals.totalCredit)}</td>
                  <td className="px-3 py-2 text-right">{formatBs(data.totals.totalDebit - data.totals.totalCredit)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
