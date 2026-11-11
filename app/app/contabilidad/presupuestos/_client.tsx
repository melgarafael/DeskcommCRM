"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import Link from "next/link";

interface Budget {
  id: string;
  year: number;
  month: number;
  category: string;
  budgeted_amount: number;
  notes: string | null;
}

const MONTHS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

function formatBs(n: number) {
  return `Bs. ${n.toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function PresupuestosClient() {
  const queryClient = useQueryClient();
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [editingMonth, setEditingMonth] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");

  const { data: budgets, isLoading } = useQuery({
    queryKey: ["budgets", year],
    queryFn: () => apiClient.get<Budget[]>(`/api/v1/contabilidad/budgets?year=${year}`),
  });

  const saveBudget = useMutation({
    mutationFn: (body: { year: number; month: number; budgeted_amount: number; notes: string }) =>
      apiClient.post("/api/v1/contabilidad/budgets", body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["budgets", year] });
      setEditingMonth(null);
      setAmount("");
      setNotes("");
    },
  });

  const budgetMap = new Map((budgets ?? []).map((b) => [b.month, b]));

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Presupuestos Mensuales</h1>
          <p className="text-sm text-text-muted">Control de gastos planificados</p>
        </div>
        <Link href="/app/contabilidad/reportes" className="text-sm text-blue-600 hover:underline">← Reportes</Link>
      </div>

      <div className="flex items-center gap-3">
        <button onClick={() => setYear(year - 1)} className="rounded-md border border-border-primary px-3 py-1.5 text-sm hover:bg-surface-secondary">←</button>
        <span className="text-lg font-semibold text-text-primary">{year}</span>
        <button onClick={() => setYear(year + 1)} className="rounded-md border border-border-primary px-3 py-1.5 text-sm hover:bg-surface-secondary">→</button>
      </div>

      {isLoading ? (
        <p className="text-sm text-text-muted">Cargando...</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 12 }, (_, i) => i + 1).map((month) => {
            const budget = budgetMap.get(month);
            const isEditing = editingMonth === month;

            return (
              <div key={month} className="rounded-lg border border-border-primary bg-surface-primary p-4">
                <p className="text-sm font-medium text-text-primary">{MONTHS[month - 1]} {year}</p>

                {isEditing ? (
                  <div className="mt-2 flex flex-col gap-2">
                    <input
                      type="number"
                      step="0.01"
                      placeholder="Monto presupuestado"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      className="w-full rounded-md border border-border-primary bg-surface-secondary px-2 py-1.5 text-sm"
                    />
                    <input
                      type="text"
                      placeholder="Notas (opcional)"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      className="w-full rounded-md border border-border-primary bg-surface-secondary px-2 py-1.5 text-sm"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => saveBudget.mutate({ year, month, budgeted_amount: parseFloat(amount) || 0, notes })}
                        disabled={saveBudget.isPending}
                        className="rounded-md bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {saveBudget.isPending ? "..." : "Guardar"}
                      </button>
                      <button
                        onClick={() => { setEditingMonth(null); setAmount(""); setNotes(""); }}
                        className="rounded-md border border-border-primary px-3 py-1 text-sm hover:bg-surface-secondary"
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2">
                    {budget ? (
                      <>
                        <p className="text-lg font-semibold text-text-primary">{formatBs(budget.budgeted_amount)}</p>
                        {budget.notes && <p className="mt-1 text-xs text-text-muted">{budget.notes}</p>}
                      </>
                    ) : (
                      <p className="text-sm text-text-muted">Sin presupuesto</p>
                    )}
                    <button
                      onClick={() => {
                        setEditingMonth(month);
                        setAmount(budget ? String(budget.budgeted_amount) : "");
                        setNotes(budget?.notes || "");
                      }}
                      className="mt-2 text-xs text-blue-600 hover:underline"
                    >
                      {budget ? "Editar" : "Definir"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
        <p className="text-sm text-text-muted">Total anual presupuestado</p>
        <p className="text-2xl font-semibold text-text-primary">
          {formatBs((budgets ?? []).reduce((s, b) => s + b.budgeted_amount, 0))}
        </p>
      </div>
    </div>
  );
}
