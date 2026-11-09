"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiClient } from "@/lib/api/client";

type Account = {
  id: string;
  code: string;
  name: string;
  account_type: string;
  reconcile: boolean;
  is_active: boolean;
};

const ACCOUNT_TYPES = [
  { value: "", label: "Todos" },
  { value: "asset", label: "Activo" },
  { value: "liability", label: "Pasivo" },
  { value: "equity", label: "Patrimonio" },
  { value: "income", label: "Ingreso" },
  { value: "expense", label: "Gasto" },
];

export function PlanCuentas() {
  const queryClient = useQueryClient();
  const [filterType, setFilterType] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ code: "", name: "", account_type: "asset", reconcile: false });

  const url = filterType
    ? `/api/v1/finance/chart-of-accounts?account_type=${filterType}`
    : "/api/v1/finance/chart-of-accounts";

  const accounts = useQuery({
    queryKey: ["chart-of-accounts", filterType],
    queryFn: () => apiClient.get<Account[]>(url),
  });

  const createAccount = useMutation({
    mutationFn: (data: typeof form) => apiClient.post("/api/v1/finance/chart-of-accounts", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["chart-of-accounts"] });
      setShowForm(false);
      setForm({ code: "", name: "", account_type: "asset", reconcile: false });
    },
  });

  const seedBolivia = useMutation({
    mutationFn: () => apiClient.post("/api/v1/finance/chart-of-accounts/seed", {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["chart-of-accounts"] });
    },
  });

  const sorted = accounts.data ? [...accounts.data].sort((a, b) => a.code.localeCompare(b.code)) : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-text-primary">Plan de Cuentas</h1>
        <p className="text-sm text-text-muted">Cuentas contables de la organizacion.</p>
      </div>

      {/* Actions row */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          className="rounded border border-border-primary bg-surface-primary px-3 py-1.5 text-sm text-text-primary"
        >
          {ACCOUNT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>

        <button
          onClick={() => setShowForm(!showForm)}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
        >
          {showForm ? "Cancelar" : "Crear cuenta"}
        </button>

        <button
          onClick={() => seedBolivia.mutate()}
          disabled={seedBolivia.isPending}
          className="rounded border border-border-primary bg-surface-primary px-3 py-1.5 text-sm text-text-primary hover:bg-surface-secondary disabled:opacity-50"
        >
          {seedBolivia.isPending ? "Sembrando..." : "Sembrar Plan Bolivia"}
        </button>
      </div>

      {/* Inline create form */}
      {showForm && (
        <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <input
              placeholder="Codigo"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              className="rounded border border-border-primary bg-surface-secondary px-3 py-1.5 text-sm text-text-primary"
            />
            <input
              placeholder="Nombre"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="rounded border border-border-primary bg-surface-secondary px-3 py-1.5 text-sm text-text-primary"
            />
            <select
              value={form.account_type}
              onChange={(e) => setForm({ ...form, account_type: e.target.value })}
              className="rounded border border-border-primary bg-surface-secondary px-3 py-1.5 text-sm text-text-primary"
            >
              {ACCOUNT_TYPES.filter((t) => t.value).map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-sm text-text-muted">
                <input
                  type="checkbox"
                  checked={form.reconcile}
                  onChange={(e) => setForm({ ...form, reconcile: e.target.checked })}
                />
                Reconciliar
              </label>
              <button
                onClick={() => createAccount.mutate(form)}
                disabled={createAccount.isPending || !form.code || !form.name}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {createAccount.isPending ? "Guardando..." : "Guardar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      {accounts.isLoading && <p className="text-sm text-text-muted">Cargando...</p>}
      {accounts.isError && <p className="text-sm text-red-500">Error al cargar datos</p>}

      {sorted.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border-primary">
          <table className="w-full text-sm">
            <thead className="bg-surface-secondary text-left text-text-muted">
              <tr>
                <th className="px-3 py-2">Codigo</th>
                <th className="px-3 py-2">Nombre</th>
                <th className="px-3 py-2">Tipo</th>
                <th className="px-3 py-2">Reconciliar</th>
                <th className="px-3 py-2">Activa</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-primary">
              {sorted.map((acc) => (
                <tr key={acc.id}>
                  <td className="px-3 py-2 font-mono text-text-primary">{acc.code}</td>
                  <td className="px-3 py-2 text-text-primary">{acc.name}</td>
                  <td className="px-3 py-2 text-text-muted">{acc.account_type}</td>
                  <td className="px-3 py-2 text-text-muted">{acc.reconcile ? "Si" : "No"}</td>
                  <td className="px-3 py-2">
                    <span className={acc.is_active ? "text-green-600" : "text-red-500"}>
                      {acc.is_active ? "Si" : "No"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!accounts.isLoading && sorted.length === 0 && (
        <p className="text-sm text-text-muted">No hay cuentas registradas. Use &quot;Sembrar Plan Bolivia&quot; para crear el plan base.</p>
      )}
    </div>
  );
}
