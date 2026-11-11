"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

interface POSConfig {
  id: string;
  name: string;
  code: string;
  cash_control: boolean;
  is_active: boolean;
}

interface POSSession {
  id: string;
  name: string;
  pos_config_id: string;
  user_id: string;
  state: "opening_control" | "opened" | "closing_control" | "closed";
  opened_at: string | null;
  closed_at: string | null;
  opening_balance: number;
  closing_balance_expected: number | null;
  closing_balance_real: number | null;
  closing_difference: number | null;
  opening_notes: string | null;
  closing_notes: string | null;
}

interface CashMovement {
  id: string;
  session_id: string;
  amount: number;
  reason: string;
  created_at: string;
}

interface SessionSummary {
  session_id: string;
  session_name: string;
  state: string;
  config_name: string;
  sales_count: number;
  total_sales: number;
  total_tax: number;
  total_payments_by_method: Record<string, number>;
  opening_balance: number;
  expected_balance: number;
  real_balance: number | null;
  difference: number | null;
}

function formatBs(n: number) {
  return `Bs. ${n.toFixed(2)}`;
}

const STATE_LABELS: Record<string, { label: string; cls: string }> = {
  opening_control: { label: "Abriendo", cls: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400" },
  opened: { label: "Abierta", cls: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400" },
  closing_control: { label: "Cerrando", cls: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400" },
  closed: { label: "Cerrada", cls: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400" },
};

export function CajasPOSClient() {
  const qc = useQueryClient();
  const [selectedConfig, setSelectedConfig] = useState<string | null>(null);
  const [openingBalance, setOpeningBalance] = useState("0");
  const [closingReal, setClosingReal] = useState("");
  const [closingNotes, setClosingNotes] = useState("");
  const [movAmount, setMovAmount] = useState("");
  const [movReason, setMovReason] = useState("");
  const [showOpenForm, setShowOpenForm] = useState<string | null>(null);
  const [showCloseForm, setShowCloseForm] = useState<string | null>(null);
  const [showMovForm, setShowMovForm] = useState<string | null>(null);

  const { data: configs } = useQuery({
    queryKey: ["pos-configs"],
    queryFn: () => apiClient.get<POSConfig[]>("/api/v1/pos/configs"),
  });

  const { data: sessions } = useQuery({
    queryKey: ["pos-sessions-all"],
    queryFn: () => apiClient.get<POSSession[]>("/api/v1/pos/sessions"),
  });

  const openSession = useMutation({
    mutationFn: (body: { config_id: string; opening_balance: number }) =>
      apiClient.post("/api/v1/pos/sessions", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pos-sessions-all"] });
      setShowOpenForm(null);
      setOpeningBalance("0");
    },
  });

  const closeSession = useMutation({
    mutationFn: (body: { sessionId: string; real_balance: number; notes?: string }) =>
      apiClient.post(`/api/v1/pos/sessions/${body.sessionId}/close`, {
        real_balance: body.real_balance,
        notes: body.notes,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pos-sessions-all"] });
      qc.invalidateQueries({ queryKey: ["pos-session-summary"] });
      setShowCloseForm(null);
      setClosingReal("");
      setClosingNotes("");
    },
  });

  const addMovement = useMutation({
    mutationFn: (body: { session_id: string; amount: number; reason: string }) =>
      apiClient.post("/api/v1/pos/cash-movements", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pos-cash-movements"] });
      qc.invalidateQueries({ queryKey: ["pos-sessions-all"] });
      setShowMovForm(null);
      setMovAmount("");
      setMovReason("");
    },
  });

  const activeConfigs = configs?.filter((c) => c.is_active) ?? [];

  const getActiveSession = (configId: string): POSSession | undefined =>
    sessions?.find(
      (s) => s.pos_config_id === configId && (s.state === "opened" || s.state === "opening_control"),
    );

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">Cajas</h1>
        <p className="text-sm text-text-muted">
          {activeConfigs.length} caja{activeConfigs.length !== 1 ? "s" : ""} configurada{activeConfigs.length !== 1 ? "s" : ""}
        </p>
      </div>

      {!activeConfigs.length ? (
        <p className="text-sm text-text-muted">
          No hay cajas configuradas. Ve a Configuracion para crear una.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {activeConfigs.map((cfg) => {
            const session = getActiveSession(cfg.id);
            const isOpen = !!session;

            return (
              <div
                key={cfg.id}
                className={`rounded-lg border p-4 ${
                  isOpen
                    ? "border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950/20"
                    : "border-border-primary bg-surface-primary"
                }`}
              >
                {/* Header */}
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-text-primary">{cfg.name}</h2>
                    <p className="text-xs text-text-muted">
                      Codigo: {cfg.code} · {cfg.cash_control ? "Control de efectivo" : "Sin control de efectivo"}
                    </p>
                  </div>
                  {isOpen ? (
                    <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/30 dark:text-green-400">
                      Abierta
                    </span>
                  ) : (
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                      Cerrada
                    </span>
                  )}
                </div>

                {/* Open session */}
                {!isOpen && (
                  <>
                    {showOpenForm === cfg.id ? (
                      <div className="flex flex-wrap items-end gap-2">
                        <div>
                          <label className="mb-1 block text-xs text-text-muted">Saldo inicial (Bs.)</label>
                          <input
                            type="number"
                            step="0.01"
                            value={openingBalance}
                            onChange={(e) => setOpeningBalance(e.target.value)}
                            className="w-32 rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
                          />
                        </div>
                        <button
                          onClick={() =>
                            openSession.mutate({
                              config_id: cfg.id,
                              opening_balance: parseFloat(openingBalance) || 0,
                            })
                          }
                          disabled={openSession.isPending}
                          className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
                        >
                          {openSession.isPending ? "Abriendo..." : "Abrir caja"}
                        </button>
                        <button
                          onClick={() => setShowOpenForm(null)}
                          className="rounded-md px-3 py-2 text-sm text-text-muted hover:text-text-primary"
                        >
                          Cancelar
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setShowOpenForm(cfg.id)}
                        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                      >
                        Abrir sesion
                      </button>
                    )}
                  </>
                )}

                {/* Active session details */}
                {isOpen && session && (
                  <SessionPanel
                    session={session}
                    config={cfg}
                    showCloseForm={showCloseForm === session.id}
                    showMovForm={showMovForm === session.id}
                    closingReal={closingReal}
                    closingNotes={closingNotes}
                    movAmount={movAmount}
                    movReason={movReason}
                    onSetClosingReal={setClosingReal}
                    onSetClosingNotes={setClosingNotes}
                    onSetMovAmount={setMovAmount}
                    onSetMovReason={setMovReason}
                    onToggleClose={() => setShowCloseForm(showCloseForm === session.id ? null : session.id)}
                    onToggleMov={() => setShowMovForm(showMovForm === session.id ? null : session.id)}
                    onClose={() =>
                      closeSession.mutate({
                        sessionId: session.id,
                        real_balance: parseFloat(closingReal) || 0,
                        notes: closingNotes.trim() || undefined,
                      })
                    }
                    onAddMov={() =>
                      addMovement.mutate({
                        session_id: session.id,
                        amount: parseFloat(movAmount) || 0,
                        reason: movReason.trim(),
                      })
                    }
                    closePending={closeSession.isPending}
                    movPending={addMovement.isPending}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Recent closed sessions */}
      <RecentSessions sessions={sessions?.filter((s) => s.state === "closed") ?? []} />
    </div>
  );
}

function SessionPanel({
  session,
  config,
  showCloseForm,
  showMovForm,
  closingReal,
  closingNotes,
  movAmount,
  movReason,
  onSetClosingReal,
  onSetClosingNotes,
  onSetMovAmount,
  onSetMovReason,
  onToggleClose,
  onToggleMov,
  onClose,
  onAddMov,
  closePending,
  movPending,
}: {
  session: POSSession;
  config: POSConfig;
  showCloseForm: boolean;
  showMovForm: boolean;
  closingReal: string;
  closingNotes: string;
  movAmount: string;
  movReason: string;
  onSetClosingReal: (v: string) => void;
  onSetClosingNotes: (v: string) => void;
  onSetMovAmount: (v: string) => void;
  onSetMovReason: (v: string) => void;
  onToggleClose: () => void;
  onToggleMov: () => void;
  onClose: () => void;
  onAddMov: () => void;
  closePending: boolean;
  movPending: boolean;
}) {
  const { data: summary } = useQuery({
    queryKey: ["pos-session-summary", session.id],
    queryFn: () => apiClient.get<SessionSummary>(`/api/v1/pos/sessions/${session.id}/summary`),
    refetchInterval: 15000,
  });

  const { data: movements } = useQuery({
    queryKey: ["pos-cash-movements", session.id],
    queryFn: () => apiClient.get<CashMovement[]>(`/api/v1/pos/sessions/${session.id}/cash-movements`),
  });

  return (
    <div className="flex flex-col gap-3">
      {/* Session info */}
      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div>
          <p className="text-xs text-text-muted">Sesion</p>
          <p className="font-mono text-text-primary">{session.name}</p>
        </div>
        <div>
          <p className="text-xs text-text-muted">Apertura</p>
          <p className="text-text-primary">{formatBs(session.opening_balance)}</p>
        </div>
        <div>
          <p className="text-xs text-text-muted">Ventas</p>
          <p className="text-text-primary">{summary ? summary.sales_count : "—"}</p>
        </div>
        <div>
          <p className="text-xs text-text-muted">Esperado</p>
          <p className="font-medium text-text-primary">
            {summary ? formatBs(summary.expected_balance) : "—"}
          </p>
        </div>
      </div>

      {/* Payments by method */}
      {summary && Object.keys(summary.total_payments_by_method).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(summary.total_payments_by_method).map(([method, amount]) => (
            <span key={method} className="rounded-md bg-blue-50 px-2 py-1 text-xs text-blue-800 dark:bg-blue-900/20 dark:text-blue-400">
              {method}: {formatBs(amount)}
            </span>
          ))}
        </div>
      )}

      {/* Cash movements */}
      {movements && movements.length > 0 && (
        <div className="rounded-md border border-border-primary bg-surface-secondary p-2">
          <p className="mb-1 text-xs font-medium text-text-muted">Movimientos de caja</p>
          <div className="max-h-32 space-y-1 overflow-y-auto">
            {movements.map((m) => (
              <div key={m.id} className="flex items-center justify-between text-xs">
                <span className="text-text-primary">{m.reason}</span>
                <span className={m.amount > 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>
                  {m.amount > 0 ? "+" : ""}{formatBs(m.amount)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={onToggleMov}
          className="rounded-md border border-border-primary bg-surface-secondary px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-surface-primary"
        >
          {showMovForm ? "Cancelar" : "Entrada/Salida de caja"}
        </button>
        <button
          onClick={onToggleClose}
          className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
        >
          {showCloseForm ? "Cancelar cierre" : "Cerrar caja"}
        </button>
      </div>

      {/* Cash movement form */}
      {showMovForm && (
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-border-primary bg-surface-secondary p-3">
          <div>
            <label className="mb-1 block text-xs text-text-muted">Monto (+ entrada, - salida)</label>
            <input
              type="number"
              step="0.01"
              value={movAmount}
              onChange={(e) => onSetMovAmount(e.target.value)}
              placeholder="ej: 100 o -50"
              className="w-32 rounded-md border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary"
            />
          </div>
          <div className="flex-1">
            <label className="mb-1 block text-xs text-text-muted">Razon</label>
            <input
              type="text"
              value={movReason}
              onChange={(e) => onSetMovReason(e.target.value)}
              placeholder="ej: Cambio para cliente"
              className="w-full rounded-md border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary"
            />
          </div>
          <button
            onClick={onAddMov}
            disabled={movPending || !movAmount || !movReason.trim()}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {movPending ? "Registrando..." : "Registrar"}
          </button>
        </div>
      )}

      {/* Close session form */}
      {showCloseForm && (
        <div className="flex flex-col gap-2 rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-950/20">
          <p className="text-xs font-medium text-red-800 dark:text-red-400">Cerrar sesion de caja</p>
          {config.cash_control && (
            <div>
              <label className="mb-1 block text-xs text-text-muted">Saldo real contado (Bs.)</label>
              <input
                type="number"
                step="0.01"
                value={closingReal}
                onChange={(e) => onSetClosingReal(e.target.value)}
                className="w-40 rounded-md border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary"
              />
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs text-text-muted">Notas de cierre (opcional)</label>
            <input
              type="text"
              value={closingNotes}
              onChange={(e) => onSetClosingNotes(e.target.value)}
              placeholder="Observaciones del cierre"
              className="w-full rounded-md border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary"
            />
          </div>
          <button
            onClick={onClose}
            disabled={closePending || (config.cash_control && !closingReal)}
            className="w-fit rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {closePending ? "Cerrando..." : "Confirmar cierre"}
          </button>
        </div>
      )}
    </div>
  );
}

function RecentSessions({ sessions }: { sessions: POSSession[] }) {
  const recent = sessions.slice(0, 10);
  if (!recent.length) return null;

  return (
    <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
      <h2 className="mb-3 text-lg font-semibold text-text-primary">Sesiones recientes cerradas</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border-primary text-left text-text-muted">
              <th className="pb-2">Sesion</th>
              <th className="pb-2">Abierta</th>
              <th className="pb-2">Cerrada</th>
              <th className="pb-2 text-right">Apertura</th>
              <th className="pb-2 text-right">Esperado</th>
              <th className="pb-2 text-right">Real</th>
              <th className="pb-2 text-right">Diferencia</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((s) => (
              <tr key={s.id} className="border-b border-border-primary">
                <td className="py-2 font-mono text-text-primary">{s.name}</td>
                <td className="py-2 text-text-muted">
                  {s.opened_at ? new Date(s.opened_at).toLocaleString("es-BO", { dateStyle: "short", timeStyle: "short" }) : "—"}
                </td>
                <td className="py-2 text-text-muted">
                  {s.closed_at ? new Date(s.closed_at).toLocaleString("es-BO", { dateStyle: "short", timeStyle: "short" }) : "—"}
                </td>
                <td className="py-2 text-right text-text-muted">{formatBs(s.opening_balance)}</td>
                <td className="py-2 text-right text-text-primary">
                  {s.closing_balance_expected != null ? formatBs(s.closing_balance_expected) : "—"}
                </td>
                <td className="py-2 text-right text-text-primary">
                  {s.closing_balance_real != null ? formatBs(s.closing_balance_real) : "—"}
                </td>
                <td className={`py-2 text-right font-medium ${
                  s.closing_difference != null && s.closing_difference > 0
                    ? "text-red-600 dark:text-red-400"
                    : s.closing_difference != null && s.closing_difference < 0
                      ? "text-green-600 dark:text-green-400"
                      : "text-text-muted"
                }`}>
                  {s.closing_difference != null ? formatBs(s.closing_difference) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
