"use client";

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import Link from "next/link";

interface BalanceItem {
  code: string;
  name: string;
  account_type: string;
  balance: number;
}

interface BalanceSheet {
  sections: {
    assets: { items: BalanceItem[]; total: number };
    liabilities: { items: BalanceItem[]; total: number };
    equity: { items: BalanceItem[]; total: number };
  };
  is_balanced: boolean;
}

function formatBs(n: number) {
  return `Bs. ${n.toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function BalanceSheetClient() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["balance-sheet"],
    queryFn: () => apiClient.get<BalanceSheet>("/api/v1/contabilidad/reportes/balance-sheet"),
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Balance General</h1>
          <p className="text-sm text-text-muted">Situacion financiera actual</p>
        </div>
        <Link href="/app/contabilidad/reportes" className="text-sm text-blue-600 hover:underline">
          ← Reportes
        </Link>
      </div>

      {isLoading && <p className="text-sm text-text-muted">Cargando...</p>}
      {isError && <p className="text-sm text-red-500">Error al cargar balance</p>}

      {data && (
        <>
          {data.is_balanced ? (
            <p className="rounded-md bg-green-50 p-2 text-sm text-green-700 dark:bg-green-900/20 dark:text-green-400">Balance cuadrado</p>
          ) : (
            <p className="rounded-md bg-red-50 p-2 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400">Balance descuadrado</p>
          )}

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <Section title="Activos" items={data.sections.assets.items} total={data.sections.assets.total} />
            <Section title="Pasivos" items={data.sections.liabilities.items} total={data.sections.liabilities.total} />
            <Section title="Patrimonio" items={data.sections.equity.items} total={data.sections.equity.total} />
          </div>
        </>
      )}
    </div>
  );
}

function Section({ title, items, total }: { title: string; items: BalanceItem[]; total: number }) {
  return (
    <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
      <h2 className="mb-3 text-lg font-semibold text-text-primary">{title}</h2>
      {items.length === 0 ? (
        <p className="text-sm text-text-muted">Sin cuentas con movimiento</p>
      ) : (
        <div className="flex flex-col gap-1">
          {items.map((item) => (
            <div key={item.code} className="flex items-center justify-between text-sm">
              <span className="text-text-muted">{item.code} - {item.name}</span>
              <span className="font-medium text-text-primary">{formatBs(item.balance)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 flex items-center justify-between border-t border-border-primary pt-2">
        <span className="font-medium text-text-primary">Total {title}</span>
        <span className="text-lg font-semibold text-text-primary">{formatBs(total)}</span>
      </div>
    </div>
  );
}
