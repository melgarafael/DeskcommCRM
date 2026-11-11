"use client";

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import Link from "next/link";

type Account = { id: string; code: string; name: string; account_type: string; is_active: boolean };
type JournalEntry = { id: string; number: string; date: string; journal_name: string; entry_type: string; state: string; total_debit: number };
type Payment = { id: string; amount: number; state: string };

export function ContabilidadHub() {
  const accounts = useQuery({
    queryKey: ["chart-of-accounts-active"],
    queryFn: () => apiClient.get<Account[]>("/api/v1/finance/chart-of-accounts?is_active=true"),
  });

  const journalEntries = useQuery({
    queryKey: ["journal-entries-posted"],
    queryFn: () => apiClient.get<JournalEntry[]>("/api/v1/finance/journal-entries?state=posted"),
  });

  const draftEntries = useQuery({
    queryKey: ["journal-entries-draft"],
    queryFn: () => apiClient.get<JournalEntry[]>("/api/v1/finance/journal-entries?state=draft"),
  });

  const payments = useQuery({
    queryKey: ["payments-paid"],
    queryFn: () => apiClient.get<Payment[]>("/api/v1/finance/payments?state=paid"),
  });

  const isLoading = accounts.isLoading || journalEntries.isLoading || draftEntries.isLoading || payments.isLoading;
  const isError = accounts.isError || journalEntries.isError || draftEntries.isError || payments.isError;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-text-primary">Contabilidad</h1>
        <p className="text-sm text-text-muted">
          Plan de cuentas, asientos contables y libros fiscales.
        </p>
      </div>

      {isLoading && <p className="text-sm text-text-muted">Cargando...</p>}
      {isError && <p className="text-sm text-red-500">Error al cargar datos</p>}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <KpiCard label="Cuentas activas" value={accounts.data?.length ?? 0} />
        <KpiCard label="Asientos publicados" value={journalEntries.data?.length ?? 0} />
        <KpiCard label="Asientos borrador" value={draftEntries.data?.length ?? 0} />
        <KpiCard label="Pagos realizados" value={payments.data?.length ?? 0} />
      </div>

      {/* Quick Links */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <QuickLink href="/app/contabilidad/plan-cuentas" title="Plan de Cuentas" description="Gestionar cuentas contables" />
        <QuickLink href="/app/contabilidad/diario" title="Diario" description="Asientos contables" />
        <QuickLink href="/app/contabilidad/fiscal" title="Libros Fiscales" description="IVA, IT y declaraciones" />
        <QuickLink href="/app/contabilidad/reportes" title="Reportes" description="Balance, resultados, libro mayor" />
        <QuickLink href="/app/contabilidad/kpis" title="KPIs" description="Indicadores financieros" />
        <QuickLink href="/app/contabilidad/presupuestos" title="Presupuestos" description="Control presupuestario mensual" />
        <QuickLink href="/app/contabilidad/banco" title="Banco" description="Conciliacion bancaria" />
        <QuickLink href="/app/contabilidad/impuestos" title="Impuestos" description="Configuracion tributaria" />
      </div>

      {/* Recent posted entries */}
      {journalEntries.data && journalEntries.data.length > 0 && (
        <div>
          <h2 className="mb-2 text-base font-medium text-text-primary">Asientos recientes</h2>
          <div className="overflow-x-auto rounded-lg border border-border-primary">
            <table className="w-full text-sm">
              <thead className="bg-surface-secondary text-left text-text-muted">
                <tr>
                  <th className="px-3 py-2">Numero</th>
                  <th className="px-3 py-2">Fecha</th>
                  <th className="px-3 py-2">Diario</th>
                  <th className="px-3 py-2">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-primary">
                {journalEntries.data.slice(0, 5).map((entry) => (
                  <tr key={entry.id}>
                    <td className="px-3 py-2 text-text-primary">{entry.number}</td>
                    <td className="px-3 py-2 text-text-muted">{entry.date}</td>
                    <td className="px-3 py-2 text-text-muted">{entry.journal_name}</td>
                    <td className="px-3 py-2">
                      <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-700">
                        {entry.state}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function KpiCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
      <p className="text-sm text-text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-text-primary">{value}</p>
    </div>
  );
}

function QuickLink({ href, title, description }: { href: string; title: string; description: string }) {
  return (
    <Link
      href={href}
      className="rounded-lg border border-border-primary bg-surface-primary p-4 transition-colors hover:bg-surface-secondary"
    >
      <p className="font-medium text-text-primary">{title}</p>
      <p className="text-sm text-text-muted">{description}</p>
    </Link>
  );
}
