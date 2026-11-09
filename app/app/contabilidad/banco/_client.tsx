"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

interface BankStatement {
  id: string;
  name: string;
  journal_id: string;
  journal_name?: string;
  date: string;
  balance_start: number;
  balance_end: number;
  state: string;
}

interface StatementLine {
  id: string;
  date: string;
  description: string;
  partner_name?: string;
  amount: number;
  state: string;
}

interface BankBalance {
  journal_id: string;
  journal_name: string;
  balance: number;
}

interface Journal {
  id: string;
  name: string;
}

export function BancoClient() {
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: "",
    journal_id: "",
    date: "",
    balance_start: "",
    balance_end: "",
  });

  const { data: statements, isLoading: loadingStatements } = useQuery({
    queryKey: ["bank-statements"],
    queryFn: () => apiClient.get<BankStatement[]>("/api/v1/finance/bank/statements"),
  });

  const { data: balances } = useQuery({
    queryKey: ["bank-balances"],
    queryFn: () => apiClient.get<BankBalance[]>("/api/v1/finance/bank/balances"),
  });

  const { data: journals } = useQuery({
    queryKey: ["bank-journals"],
    queryFn: () => apiClient.get<Journal[]>("/api/v1/finance/journals?type=bank"),
  });

  const { data: lines, isLoading: loadingLines } = useQuery({
    queryKey: ["statement-lines", expandedId],
    queryFn: () =>
      apiClient.get<StatementLine[]>(
        `/api/v1/finance/bank/statements/${expandedId}/lines`
      ),
    enabled: !!expandedId,
  });

  const autoReconcile = useMutation({
    mutationFn: (statementId: string) =>
      apiClient.post(`/api/v1/finance/bank/statements/${statementId}/auto-reconcile`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bank-statements"] });
      queryClient.invalidateQueries({ queryKey: ["statement-lines"] });
    },
  });

  const createStatement = useMutation({
    mutationFn: (data: typeof form) =>
      apiClient.post("/api/v1/finance/bank/statements", {
        name: data.name,
        journal_id: data.journal_id,
        date: data.date,
        balance_start: parseFloat(data.balance_start),
        balance_end: parseFloat(data.balance_end),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bank-statements"] });
      setShowForm(false);
      setForm({ name: "", journal_id: "", date: "", balance_start: "", balance_end: "" });
    },
  });

  const stateLabel = (s: string) => {
    const map: Record<string, string> = {
      draft: "Borrador",
      open: "Abierto",
      confirm: "Confirmado",
      pending: "Pendiente",
      matched: "Conciliado",
      reconciled: "Reconciliado",
    };
    return map[s] || s;
  };

  if (loadingStatements) return <p className="p-6 text-text-muted">Cargando...</p>;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">
          Conciliacion Bancaria
        </h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="rounded-lg bg-surface-secondary px-4 py-2 text-sm font-medium text-text-primary hover:opacity-80"
        >
          {showForm ? "Cancelar" : "Crear extracto"}
        </button>
      </div>

      {/* Balance summary */}
      {balances && balances.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {balances.map((b) => (
            <div
              key={b.journal_id}
              className="rounded-lg border border-border-primary bg-surface-primary p-4"
            >
              <p className="text-sm text-text-muted">{b.journal_name}</p>
              <p className="mt-1 text-lg font-semibold text-text-primary">
                {b.balance.toLocaleString("es-BO", {
                  style: "currency",
                  currency: "BOB",
                })}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Create statement form */}
      {showForm && (
        <div className="rounded-lg border border-border-primary bg-surface-primary p-4 space-y-3">
          <h2 className="text-sm font-semibold text-text-primary">Nuevo extracto</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <input
              placeholder="Nombre"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="rounded border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
            />
            <select
              value={form.journal_id}
              onChange={(e) => setForm({ ...form, journal_id: e.target.value })}
              className="rounded border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
            >
              <option value="">Seleccionar diario</option>
              {journals?.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
              className="rounded border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
            />
            <input
              type="number"
              placeholder="Saldo inicial"
              value={form.balance_start}
              onChange={(e) => setForm({ ...form, balance_start: e.target.value })}
              className="rounded border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
            />
            <input
              type="number"
              placeholder="Saldo final"
              value={form.balance_end}
              onChange={(e) => setForm({ ...form, balance_end: e.target.value })}
              className="rounded border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
            />
          </div>
          <button
            onClick={() => createStatement.mutate(form)}
            disabled={createStatement.isPending}
            className="rounded-lg bg-surface-secondary px-4 py-2 text-sm font-medium text-text-primary hover:opacity-80 disabled:opacity-50"
          >
            {createStatement.isPending ? "Guardando..." : "Guardar"}
          </button>
          {createStatement.isError && (
            <p className="text-sm text-red-500">Error al crear extracto</p>
          )}
        </div>
      )}

      {/* Statements table */}
      <div className="rounded-lg border border-border-primary bg-surface-primary">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border-primary text-left text-text-muted">
              <th className="px-4 py-3">Nombre</th>
              <th className="px-4 py-3">Diario</th>
              <th className="px-4 py-3">Fecha</th>
              <th className="px-4 py-3 text-right">Saldo Inicial</th>
              <th className="px-4 py-3 text-right">Saldo Final</th>
              <th className="px-4 py-3">Estado</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-primary">
            {statements?.map((s) => (
              <>
                <tr
                  key={s.id}
                  className="cursor-pointer hover:bg-surface-secondary"
                  onClick={() =>
                    setExpandedId(expandedId === s.id ? null : s.id)
                  }
                >
                  <td className="px-4 py-3 text-text-primary">{s.name}</td>
                  <td className="px-4 py-3 text-text-muted">
                    {s.journal_name || s.journal_id}
                  </td>
                  <td className="px-4 py-3 text-text-muted">{s.date}</td>
                  <td className="px-4 py-3 text-right text-text-muted">
                    {s.balance_start.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right text-text-primary font-medium">
                    {s.balance_end.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-text-muted">
                    {stateLabel(s.state)}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        autoReconcile.mutate(s.id);
                      }}
                      disabled={autoReconcile.isPending}
                      className="rounded bg-surface-secondary px-3 py-1 text-xs text-text-primary hover:opacity-80 disabled:opacity-50"
                    >
                      Auto-reconciliar
                    </button>
                  </td>
                </tr>
                {expandedId === s.id && (
                  <tr key={`${s.id}-lines`}>
                    <td colSpan={7} className="bg-surface-secondary px-4 py-3">
                      {loadingLines ? (
                        <p className="text-sm text-text-muted">Cargando lineas...</p>
                      ) : lines && lines.length > 0 ? (
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-left text-text-muted">
                              <th className="pb-2 pr-4">Fecha</th>
                              <th className="pb-2 pr-4">Descripcion</th>
                              <th className="pb-2 pr-4">Partner</th>
                              <th className="pb-2 pr-4 text-right">Monto</th>
                              <th className="pb-2">Estado</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border-primary">
                            {lines.map((l) => (
                              <tr key={l.id}>
                                <td className="py-2 pr-4 text-text-muted">
                                  {l.date}
                                </td>
                                <td className="py-2 pr-4 text-text-primary">
                                  {l.description}
                                </td>
                                <td className="py-2 pr-4 text-text-muted">
                                  {l.partner_name || "-"}
                                </td>
                                <td className="py-2 pr-4 text-right text-text-primary">
                                  {l.amount.toLocaleString()}
                                </td>
                                <td className="py-2 text-text-muted">
                                  {stateLabel(l.state)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <p className="text-sm text-text-muted">Sin lineas</p>
                      )}
                    </td>
                  </tr>
                )}
              </>
            ))}
            {(!statements || statements.length === 0) && (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-6 text-center text-text-muted"
                >
                  Sin extractos bancarios
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
