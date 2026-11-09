"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

interface POSConfig {
  id: string;
  name: string;
  journal_id: string | null;
  is_active: boolean;
}

interface POSSession {
  id: string;
  config_id: string;
  config_name: string;
  user_name: string;
  state: string;
  opened_at: string;
  opening_balance: number;
}

interface SessionSummary {
  total_sales: number;
  total_amount: number;
  payments_by_method: { method: string; total: number }[];
}

interface DailyReport {
  total_sales: number;
  total_amount: number;
}

function formatBs(amount: number) {
  return `Bs. ${amount.toFixed(2)}`;
}

export function POSDashboardClient() {
  const queryClient = useQueryClient();
  const [selectedConfig, setSelectedConfig] = useState("");
  const [closingSessionId, setClosingSessionId] = useState<string | null>(null);
  const [closingBalance, setClosingBalance] = useState("");
  const [expandedSession, setExpandedSession] = useState<string | null>(null);

  const { data: sessions, isLoading: loadingSessions } = useQuery({
    queryKey: ["pos-sessions-open"],
    queryFn: () => apiClient.get<POSSession[]>("/api/v1/pos/sessions?state=opened"),
  });

  const { data: configs } = useQuery({
    queryKey: ["pos-configs"],
    queryFn: () => apiClient.get<POSConfig[]>("/api/v1/pos/configs"),
  });

  const { data: dailyReport } = useQuery({
    queryKey: ["pos-daily-report"],
    queryFn: () => apiClient.get<DailyReport>("/api/v1/pos/reports?type=daily"),
  });

  const { data: sessionSummary } = useQuery({
    queryKey: ["pos-session-summary", expandedSession],
    queryFn: () => apiClient.get<SessionSummary>(`/api/v1/pos/sessions/${expandedSession}/summary`),
    enabled: !!expandedSession,
  });

  const openSession = useMutation({
    mutationFn: (configId: string) =>
      apiClient.post("/api/v1/pos/sessions", { config_id: configId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-sessions-open"] });
      queryClient.invalidateQueries({ queryKey: ["pos-daily-report"] });
      setSelectedConfig("");
    },
  });

  const closeSession = useMutation({
    mutationFn: ({ id, closing_balance }: { id: string; closing_balance: number }) =>
      apiClient.post(`/api/v1/pos/sessions/${id}/close`, { closing_balance }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-sessions-open"] });
      queryClient.invalidateQueries({ queryKey: ["pos-daily-report"] });
      setClosingSessionId(null);
      setClosingBalance("");
    },
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold text-text-primary">Punto de Venta</h1>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
          <p className="text-sm text-text-muted">Sesiones abiertas</p>
          <p className="text-2xl font-semibold text-text-primary">{sessions?.length ?? 0}</p>
        </div>
        <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
          <p className="text-sm text-text-muted">Ventas hoy</p>
          <p className="text-2xl font-semibold text-text-primary">{dailyReport?.total_sales ?? 0}</p>
        </div>
        <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
          <p className="text-sm text-text-muted">Monto total hoy</p>
          <p className="text-2xl font-semibold text-text-primary">
            {formatBs(dailyReport?.total_amount ?? 0)}
          </p>
        </div>
      </div>

      {/* Open session */}
      <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
        <h2 className="mb-3 text-lg font-semibold text-text-primary">Abrir nueva sesion</h2>
        <div className="flex items-center gap-3">
          <select
            value={selectedConfig}
            onChange={(e) => setSelectedConfig(e.target.value)}
            className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
          >
            <option value="">Seleccionar configuracion...</option>
            {configs?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            onClick={() => selectedConfig && openSession.mutate(selectedConfig)}
            disabled={!selectedConfig || openSession.isPending}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {openSession.isPending ? "Abriendo..." : "Abrir sesion"}
          </button>
        </div>
        {openSession.isError && (
          <p className="mt-2 text-sm text-red-600">Error al abrir sesion</p>
        )}
      </div>

      {/* Active sessions */}
      <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
        <h2 className="mb-3 text-lg font-semibold text-text-primary">Sesiones activas</h2>
        {loadingSessions ? (
          <p className="text-sm text-text-muted">Cargando...</p>
        ) : !sessions?.length ? (
          <p className="text-sm text-text-muted">No hay sesiones abiertas</p>
        ) : (
          <div className="flex flex-col gap-3">
            {sessions.map((s) => (
              <div key={s.id} className="rounded-lg border border-border-primary bg-surface-secondary p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-text-primary">{s.config_name}</p>
                    <p className="text-sm text-text-muted">
                      {s.user_name} &middot; Abierta: {new Date(s.opened_at).toLocaleDateString("es-BO")}{" "}
                      {new Date(s.opened_at).toLocaleTimeString("es-BO")}
                    </p>
                    <p className="text-sm text-text-muted">
                      Saldo inicial: {formatBs(s.opening_balance)}
                    </p>
                    <span
                      className={`mt-1 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        s.state === "opened"
                          ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
                          : "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400"
                      }`}
                    >
                      {s.state === "opened" ? "Abierta" : "Control de apertura"}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setExpandedSession(expandedSession === s.id ? null : s.id)}
                      className="rounded-md border border-border-primary px-3 py-1.5 text-sm text-text-primary hover:bg-surface-secondary"
                    >
                      {expandedSession === s.id ? "Ocultar" : "Resumen"}
                    </button>
                    {closingSessionId === s.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          step="0.01"
                          placeholder="Saldo de cierre"
                          value={closingBalance}
                          onChange={(e) => setClosingBalance(e.target.value)}
                          className="w-36 rounded-md border border-border-primary bg-surface-primary px-2 py-1.5 text-sm text-text-primary"
                        />
                        <button
                          onClick={() =>
                            closeSession.mutate({
                              id: s.id,
                              closing_balance: parseFloat(closingBalance) || 0,
                            })
                          }
                          disabled={closeSession.isPending}
                          className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                        >
                          {closeSession.isPending ? "Cerrando..." : "Confirmar"}
                        </button>
                        <button
                          onClick={() => { setClosingSessionId(null); setClosingBalance(""); }}
                          className="rounded-md border border-border-primary px-3 py-1.5 text-sm text-text-muted hover:bg-surface-secondary"
                        >
                          Cancelar
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setClosingSessionId(s.id)}
                        className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20"
                      >
                        Cerrar sesion
                      </button>
                    )}
                  </div>
                </div>

                {expandedSession === s.id && sessionSummary && (
                  <div className="mt-3 border-t border-border-primary pt-3">
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <span className="text-text-muted">Total ventas:</span>{" "}
                        <span className="font-medium text-text-primary">{sessionSummary.total_sales}</span>
                      </div>
                      <div>
                        <span className="text-text-muted">Monto total:</span>{" "}
                        <span className="font-medium text-text-primary">{formatBs(sessionSummary.total_amount)}</span>
                      </div>
                    </div>
                    {sessionSummary.payments_by_method?.length > 0 && (
                      <div className="mt-2">
                        <p className="text-sm font-medium text-text-muted">Por metodo de pago:</p>
                        {sessionSummary.payments_by_method.map((pm) => (
                          <p key={pm.method} className="text-sm text-text-primary">
                            {pm.method}: {formatBs(pm.total)}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
