"use client";

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import Link from "next/link";

interface CashFlowSection {
  category: string;
  inflows: number;
  outflows: number;
  net: number;
}

interface CashFlow {
  sections: CashFlowSection[];
  net_change: number;
  closing_balance: number;
  cash_accounts: { code: string; name: string; balance: number }[];
}

function formatBs(n: number) {
  return `Bs. ${n.toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const CATEGORY_LABELS: Record<string, string> = {
  operating: "Actividades Operativas",
  investing: "Actividades de Inversion",
  financing: "Actividades de Financiamiento",
};

export function FlujoEfectivoClient() {
  const { data, isLoading } = useQuery({
    queryKey: ["cash-flow"],
    queryFn: () => apiClient.get<CashFlow>("/api/v1/contabilidad/reportes/cash-flow"),
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">Flujo de Efectivo</h1>
        <Link href="/app/contabilidad/reportes" className="text-sm text-blue-600 hover:underline">← Reportes</Link>
      </div>

      {isLoading && <p className="text-sm text-text-muted">Cargando...</p>}

      {data && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {data.sections.map((s) => (
              <div key={s.category} className="rounded-lg border border-border-primary bg-surface-primary p-4">
                <p className="text-sm font-medium text-text-primary">{CATEGORY_LABELS[s.category] || s.category}</p>
                <div className="mt-2 flex flex-col gap-1 text-sm">
                  <div className="flex justify-between"><span className="text-text-muted">Entradas</span><span className="text-green-600">{formatBs(s.inflows)}</span></div>
                  <div className="flex justify-between"><span className="text-text-muted">Salidas</span><span className="text-red-600">{formatBs(s.outflows)}</span></div>
                  <div className="flex justify-between border-t border-border-primary pt-1"><span className="font-medium text-text-primary">Neto</span><span className={`font-semibold ${s.net >= 0 ? "text-green-600" : "text-red-600"}`}>{formatBs(s.net)}</span></div>
                </div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
              <p className="text-sm text-text-muted">Cambio neto total</p>
              <p className={`text-2xl font-semibold ${data.net_change >= 0 ? "text-green-600" : "text-red-600"}`}>{formatBs(data.net_change)}</p>
            </div>
            <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
              <p className="text-sm text-text-muted">Saldo de cierre</p>
              <p className="text-2xl font-semibold text-text-primary">{formatBs(data.closing_balance)}</p>
            </div>
          </div>

          {data.cash_accounts.length > 0 && (
            <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
              <h2 className="mb-2 text-base font-medium text-text-primary">Cuentas de caja</h2>
              {data.cash_accounts.map((a) => (
                <div key={a.code} className="flex justify-between py-1 text-sm">
                  <span className="text-text-muted">{a.code} - {a.name}</span>
                  <span className="font-medium text-text-primary">{formatBs(a.balance)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
