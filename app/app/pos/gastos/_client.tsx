"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

const CATEGORIES = [
  { value: "alquiler", label: "Alquiler" },
  { value: "servicios_basicos", label: "Servicios básicos" },
  { value: "suministros", label: "Suministros" },
  { value: "marketing", label: "Marketing" },
  { value: "sueldos", label: "Sueldos" },
  { value: "impuestos", label: "Impuestos" },
  { value: "mantenimiento", label: "Mantenimiento" },
  { value: "equipamiento", label: "Equipamiento" },
  { value: "limpieza", label: "Limpieza" },
  { value: "seguros", label: "Seguros" },
  { value: "transporte", label: "Transporte" },
  { value: "bancarios", label: "Bancarios" },
  { value: "capacitacion", label: "Capacitación" },
  { value: "software", label: "Software" },
  { value: "otros", label: "Otros" },
] as const;

const PAYMENT_METHODS = [
  { value: "cash", label: "Efectivo" },
  { value: "debit_card", label: "Tarjeta débito" },
  { value: "credit_card", label: "Tarjeta crédito" },
  { value: "transfer", label: "Transferencia" },
  { value: "qr", label: "QR" },
  { value: "cheque", label: "Cheque" },
] as const;

const RECURRENCE = [
  { value: "weekly", label: "Semanal" },
  { value: "monthly", label: "Mensual" },
  { value: "quarterly", label: "Trimestral" },
  { value: "yearly", label: "Anual" },
] as const;

interface Expense {
  id: string;
  description: string;
  amount: number;
  category: string;
  expense_date: string;
  payment_method: string | null;
  supplier: string | null;
  reference_number: string | null;
  session_id: string | null;
  is_recurring: boolean;
  recurrence_period: string | null;
  notes: string | null;
  created_at: string;
}

interface POSSession {
  id: string;
  name: string;
  state: string;
}

function formatBs(n: number) {
  return `Bs. ${n.toFixed(2)}`;
}

function categoryLabel(val: string) {
  return CATEGORIES.find((c) => c.value === val)?.label ?? val;
}

function paymentLabel(val: string | null) {
  if (!val) return "—";
  return PAYMENT_METHODS.find((p) => p.value === val)?.label ?? val;
}

const EMPTY_FORM = {
  description: "",
  amount: "",
  category: "general",
  expense_date: new Date().toISOString().slice(0, 10),
  payment_method: "",
  supplier: "",
  reference_number: "",
  session_id: "",
  is_recurring: false,
  recurrence_period: "",
  notes: "",
};

export function GastosPOSClient() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [filterCategory, setFilterCategory] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");

  const queryParams = new URLSearchParams();
  if (filterCategory) queryParams.set("category", filterCategory);
  if (filterDateFrom) queryParams.set("date_from", filterDateFrom);
  if (filterDateTo) queryParams.set("date_to", filterDateTo);
  const qs = queryParams.toString();

  const { data: expenses, isLoading } = useQuery({
    queryKey: ["pos-expenses", qs],
    queryFn: () =>
      apiClient.get<Expense[]>(`/api/v1/pos/expenses${qs ? `?${qs}` : ""}`),
  });

  const { data: openSessions } = useQuery({
    queryKey: ["pos-sessions-open"],
    queryFn: () =>
      apiClient.get<POSSession[]>("/api/v1/pos/sessions?state=opened"),
  });

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiClient.post("/api/v1/pos/expenses", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pos-expenses"] });
      setShowForm(false);
      setForm({ ...EMPTY_FORM });
    },
  });

  const total = expenses?.reduce((s, e) => s + e.amount, 0) ?? 0;
  const byCategory = expenses?.reduce(
    (acc, e) => {
      acc[e.category] = (acc[e.category] ?? 0) + e.amount;
      return acc;
    },
    {} as Record<string, number>,
  );

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">
            Gastos Operativos
          </h1>
          {expenses && expenses.length > 0 && (
            <p className="text-sm text-text-muted">
              {expenses.length} gastos · Total: {formatBs(total)}
            </p>
          )}
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          {showForm ? "Cancelar" : "Nuevo gasto"}
        </button>
      </div>

      {/* KPI by category */}
      {byCategory && Object.keys(byCategory).length > 1 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(byCategory)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([cat, amt]) => (
              <div
                key={cat}
                className="rounded-md border border-border-primary bg-surface-primary px-3 py-2"
              >
                <p className="text-xs text-text-muted">{categoryLabel(cat)}</p>
                <p className="text-sm font-medium text-text-primary">
                  {formatBs(amt)}
                </p>
              </div>
            ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs text-text-muted">
            Categoría
          </label>
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
          >
            <option value="">Todas</option>
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-muted">Desde</label>
          <input
            type="date"
            value={filterDateFrom}
            onChange={(e) => setFilterDateFrom(e.target.value)}
            className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-muted">Hasta</label>
          <input
            type="date"
            value={filterDateTo}
            onChange={(e) => setFilterDateTo(e.target.value)}
            className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
          />
        </div>
        {(filterCategory || filterDateFrom || filterDateTo) && (
          <button
            onClick={() => {
              setFilterCategory("");
              setFilterDateFrom("");
              setFilterDateTo("");
            }}
            className="rounded-md border border-border-primary px-3 py-2 text-sm text-text-muted hover:bg-surface-secondary"
          >
            Limpiar
          </button>
        )}
      </div>

      {/* Create form */}
      {showForm && (
        <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
          <h2 className="mb-3 text-sm font-semibold text-text-primary">
            Registrar gasto
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs text-text-muted">
                Descripción *
              </label>
              <input
                type="text"
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
                placeholder="Ej: Pago alquiler noviembre"
                className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-text-muted">
                Monto *
              </label>
              <input
                type="number"
                step="0.01"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                placeholder="0.00"
                className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-text-muted">
                Categoría
              </label>
              <select
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
              >
                <option value="general">General</option>
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-text-muted">
                Fecha
              </label>
              <input
                type="date"
                value={form.expense_date}
                onChange={(e) =>
                  setForm({ ...form, expense_date: e.target.value })
                }
                className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-text-muted">
                Método de pago
              </label>
              <select
                value={form.payment_method}
                onChange={(e) =>
                  setForm({ ...form, payment_method: e.target.value })
                }
                className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
              >
                <option value="">Sin especificar</option>
                {PAYMENT_METHODS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-text-muted">
                Proveedor
              </label>
              <input
                type="text"
                value={form.supplier}
                onChange={(e) => setForm({ ...form, supplier: e.target.value })}
                placeholder="Nombre del proveedor"
                className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-text-muted">
                Nro. referencia
              </label>
              <input
                type="text"
                value={form.reference_number}
                onChange={(e) =>
                  setForm({ ...form, reference_number: e.target.value })
                }
                placeholder="Factura/recibo"
                className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-text-muted">
                Sesión de caja
              </label>
              <select
                value={form.session_id}
                onChange={(e) =>
                  setForm({ ...form, session_id: e.target.value })
                }
                className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
              >
                <option value="">No vinculado a caja</option>
                {openSessions?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-text-muted">
                Notas
              </label>
              <input
                type="text"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Notas adicionales"
                className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
              />
            </div>
            <div className="flex items-end gap-3">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="is-recurring"
                  checked={form.is_recurring}
                  onChange={(e) =>
                    setForm({ ...form, is_recurring: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-border-primary"
                />
                <label
                  htmlFor="is-recurring"
                  className="text-xs text-text-muted"
                >
                  Recurrente
                </label>
              </div>
              {form.is_recurring && (
                <select
                  value={form.recurrence_period}
                  onChange={(e) =>
                    setForm({ ...form, recurrence_period: e.target.value })
                  }
                  className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
                >
                  <option value="">Periodo...</option>
                  {RECURRENCE.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={() => {
                if (!form.description || !form.amount) return;
                create.mutate({
                  description: form.description,
                  amount: parseFloat(form.amount),
                  category: form.category || undefined,
                  expense_date: form.expense_date,
                  payment_method: form.payment_method || undefined,
                  supplier: form.supplier || undefined,
                  reference_number: form.reference_number || undefined,
                  session_id: form.session_id || undefined,
                  is_recurring: form.is_recurring,
                  recurrence_period: form.is_recurring
                    ? form.recurrence_period || undefined
                    : undefined,
                  notes: form.notes || undefined,
                });
              }}
              disabled={create.isPending || !form.description || !form.amount}
              className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              {create.isPending ? "Guardando..." : "Guardar gasto"}
            </button>
            {create.isError && (
              <p className="text-sm text-red-600">Error al registrar gasto</p>
            )}
          </div>
        </div>
      )}

      {/* Table */}
      {isLoading ? (
        <p className="text-sm text-text-muted">Cargando...</p>
      ) : !expenses?.length ? (
        <p className="text-sm text-text-muted">No hay gastos registrados</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border-primary">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-primary bg-surface-secondary text-left text-text-muted">
                <th className="px-4 py-3 font-medium">Fecha</th>
                <th className="px-4 py-3 font-medium">Descripción</th>
                <th className="px-4 py-3 font-medium">Categoría</th>
                <th className="px-4 py-3 font-medium">Proveedor</th>
                <th className="px-4 py-3 font-medium">Pago</th>
                <th className="px-4 py-3 font-medium">Ref.</th>
                <th className="px-4 py-3 text-right font-medium">Monto</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-primary">
              {expenses.map((e) => (
                <tr key={e.id} className="hover:bg-surface-secondary/50">
                  <td className="whitespace-nowrap px-4 py-3 text-text-muted">
                    {new Date(e.expense_date).toLocaleDateString("es-BO")}
                  </td>
                  <td className="px-4 py-3 text-text-primary">
                    <span>{e.description}</span>
                    {e.is_recurring && (
                      <span className="ml-2 inline-flex items-center rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-700 dark:bg-purple-900/30 dark:text-purple-400">
                        recurrente
                      </span>
                    )}
                    {e.notes && (
                      <p className="mt-0.5 text-xs text-text-muted">
                        {e.notes}
                      </p>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-text-muted">
                    {categoryLabel(e.category)}
                  </td>
                  <td className="px-4 py-3 text-text-muted">
                    {e.supplier ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-text-muted">
                    {paymentLabel(e.payment_method)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-text-muted">
                    {e.reference_number ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-medium text-text-primary">
                    {formatBs(e.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border-primary bg-surface-secondary">
                <td
                  colSpan={6}
                  className="px-4 py-3 text-right text-sm font-medium text-text-muted"
                >
                  Total
                </td>
                <td className="px-4 py-3 text-right text-sm font-semibold text-text-primary">
                  {formatBs(total)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
