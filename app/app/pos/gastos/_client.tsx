"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

interface Expense {
  id: string;
  description: string;
  amount: number;
  category: string | null;
  expense_date: string;
  created_at: string;
}

function formatBs(n: number) {
  return `Bs. ${n.toFixed(2)}`;
}

export function GastosPOSClient() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ description: "", amount: "", category: "", expense_date: new Date().toISOString().slice(0, 10) });

  const { data: expenses, isLoading } = useQuery({
    queryKey: ["pos-expenses"],
    queryFn: () => apiClient.get<Expense[]>("/api/v1/pos/expenses"),
  });

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiClient.post("/api/v1/pos/expenses", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pos-expenses"] });
      setShowForm(false);
      setForm({ description: "", amount: "", category: "", expense_date: new Date().toISOString().slice(0, 10) });
    },
  });

  const total = expenses?.reduce((s, e) => s + e.amount, 0) ?? 0;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Gastos</h1>
          {expenses && expenses.length > 0 && (
            <p className="text-sm text-text-muted">Total: {formatBs(total)}</p>
          )}
        </div>
        <button onClick={() => setShowForm(!showForm)} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
          {showForm ? "Cancelar" : "Nuevo gasto"}
        </button>
      </div>

      {showForm && (
        <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input placeholder="Descripción *" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary" />
            <input placeholder="Monto *" type="number" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary" />
            <input placeholder="Categoría" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary" />
            <input type="date" value={form.expense_date} onChange={(e) => setForm({ ...form, expense_date: e.target.value })} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary" />
          </div>
          <button
            onClick={() => {
              if (!form.description || !form.amount) return;
              create.mutate({
                description: form.description,
                amount: parseFloat(form.amount),
                category: form.category || undefined,
                expense_date: form.expense_date,
              });
            }}
            disabled={create.isPending || !form.description || !form.amount}
            className="mt-3 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {create.isPending ? "Guardando..." : "Guardar"}
          </button>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-text-muted">Cargando...</p>
      ) : !expenses?.length ? (
        <p className="text-sm text-text-muted">No hay gastos registrados</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-primary text-left text-text-muted">
                <th className="pb-2">Descripción</th>
                <th className="pb-2">Categoría</th>
                <th className="pb-2">Fecha</th>
                <th className="pb-2 text-right">Monto</th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((e) => (
                <tr key={e.id} className="border-b border-border-primary">
                  <td className="py-2 text-text-primary">{e.description}</td>
                  <td className="py-2 text-text-muted">{e.category ?? "—"}</td>
                  <td className="py-2 text-text-muted">{new Date(e.expense_date).toLocaleDateString("es-BO")}</td>
                  <td className="py-2 text-right font-medium text-text-primary">{formatBs(e.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
