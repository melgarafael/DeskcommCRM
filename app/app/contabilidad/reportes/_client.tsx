"use client";

import Link from "next/link";

const REPORTS = [
  { href: "/app/contabilidad/balance", title: "Balance General", description: "Activos, pasivos y patrimonio" },
  { href: "/app/contabilidad/reportes/estado-resultados", title: "Estado de Resultados", description: "Ingresos vs gastos por periodo" },
  { href: "/app/contabilidad/reportes/balance-comprobacion", title: "Balance de Comprobacion", description: "Debe y haber por cuenta" },
  { href: "/app/contabilidad/reportes/libro-mayor", title: "Libro Mayor", description: "Movimientos detallados por cuenta" },
  { href: "/app/contabilidad/reportes/flujo-efectivo", title: "Flujo de Efectivo", description: "Entradas y salidas de caja" },
  { href: "/app/contabilidad/kpis", title: "KPIs Financieros", description: "Indicadores clave del negocio" },
  { href: "/app/contabilidad/presupuestos", title: "Presupuestos", description: "Control de gastos mensuales" },
];

export function ReportesHubClient() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-text-primary">Reportes Financieros</h1>
        <p className="text-sm text-text-muted">Reportes contables, indicadores y presupuestos.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {REPORTS.map((r) => (
          <Link
            key={r.href}
            href={r.href}
            className="rounded-lg border border-border-primary bg-surface-primary p-4 transition-colors hover:bg-surface-secondary"
          >
            <p className="font-medium text-text-primary">{r.title}</p>
            <p className="text-sm text-text-muted">{r.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
