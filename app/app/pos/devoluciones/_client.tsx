"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

const REFUND_METHODS = [
  { value: "cash", label: "Efectivo" },
  { value: "card", label: "Tarjeta" },
  { value: "transfer", label: "Transferencia" },
  { value: "credit_note", label: "Nota crédito" },
] as const;

const REASONS = [
  "Producto defectuoso",
  "Error en el pedido",
  "Cliente insatisfecho",
  "Cambio de opinión",
  "Producto incorrecto",
  "Duplicado",
  "Otro",
] as const;

interface Sale {
  id: string;
  number: string;
  total_amount: number;
  state: string;
  created_at: string;
}

interface PosReturn {
  id: string;
  return_number: string;
  sale_id: string;
  reason: string;
  refund_amount: number;
  refund_method: string;
  state: string;
  notes: string | null;
  created_at: string;
}

interface POSSession {
  id: string;
  name: string;
}

function formatBs(n: number) {
  return `Bs. ${n.toFixed(2)}`;
}

function methodLabel(val: string) {
  return REFUND_METHODS.find((m) => m.value === val)?.label ?? val;
}

function stateLabel(state: string) {
  switch (state) {
    case "confirmed":
      return "Confirmada";
    case "draft":
      return "Borrador";
    case "cancelled":
      return "Cancelada";
    default:
      return state;
  }
}

function stateColor(state: string) {
  switch (state) {
    case "confirmed":
      return "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400";
    case "draft":
      return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400";
    case "cancelled":
      return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400";
    default:
      return "bg-gray-100 text-gray-800";
  }
}

export function DevolucionesPOSClient() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [selectedSaleId, setSelectedSaleId] = useState("");
  const [reason, setReason] = useState("");
  const [customReason, setCustomReason] = useState("");
  const [refundAmount, setRefundAmount] = useState("");
  const [refundMethod, setRefundMethod] = useState("cash");
  const [sessionId, setSessionId] = useState("");
  const [notes, setNotes] = useState("");
  const [saleSearch, setSaleSearch] = useState("");

  const { data: returns, isLoading } = useQuery({
    queryKey: ["pos-returns"],
    queryFn: () => apiClient.get<PosReturn[]>("/api/v1/pos/returns"),
  });

  const { data: recentSales } = useQuery({
    queryKey: ["pos-sales-for-return"],
    queryFn: () =>
      apiClient.get<Sale[]>("/api/v1/pos/sales"),
    enabled: showForm,
  });

  const { data: openSessions } = useQuery({
    queryKey: ["pos-sessions-open"],
    queryFn: () =>
      apiClient.get<POSSession[]>("/api/v1/pos/sessions?state=opened"),
    enabled: showForm,
  });

  const createReturn = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiClient.post("/api/v1/pos/returns", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pos-returns"] });
      qc.invalidateQueries({ queryKey: ["pos-sales-for-return"] });
      setShowForm(false);
      resetForm();
    },
  });

  function resetForm() {
    setSelectedSaleId("");
    setReason("");
    setCustomReason("");
    setRefundAmount("");
    setRefundMethod("cash");
    setSessionId("");
    setNotes("");
    setSaleSearch("");
  }

  const selectedSale = recentSales?.find((s) => s.id === selectedSaleId);
  const filteredSales = recentSales?.filter(
    (s) =>
      s.state !== "cancelled" &&
      s.state !== "draft" &&
      (!saleSearch ||
        s.number?.toLowerCase().includes(saleSearch.toLowerCase())),
  );

  const totalRefunded =
    returns
      ?.filter((r) => r.state === "confirmed")
      .reduce((s, r) => s + r.refund_amount, 0) ?? 0;

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">
            Devoluciones
          </h1>
          {returns && returns.length > 0 && (
            <p className="text-sm text-text-muted">
              {returns.length} devoluciones · Total reembolsado:{" "}
              {formatBs(totalRefunded)}
            </p>
          )}
        </div>
        <button
          onClick={() => {
            setShowForm(!showForm);
            if (showForm) resetForm();
          }}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          {showForm ? "Cancelar" : "Nueva devolución"}
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
          <h2 className="mb-3 text-sm font-semibold text-text-primary">
            Registrar devolución
          </h2>

          {/* Sale selector */}
          <div className="mb-4">
            <label className="mb-1 block text-xs text-text-muted">
              Buscar venta *
            </label>
            <input
              type="text"
              value={saleSearch}
              onChange={(e) => setSaleSearch(e.target.value)}
              placeholder="Buscar por número de venta..."
              className="mb-2 w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
            />
            {filteredSales && filteredSales.length > 0 && !selectedSaleId && (
              <div className="max-h-40 overflow-y-auto rounded-md border border-border-primary">
                {filteredSales.slice(0, 10).map((s) => (
                  <button
                    key={s.id}
                    onClick={() => {
                      setSelectedSaleId(s.id);
                      setRefundAmount(s.total_amount.toString());
                    }}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-surface-secondary"
                  >
                    <span className="font-mono text-text-primary">
                      {s.number ?? s.id.slice(0, 8)}
                    </span>
                    <span className="text-text-muted">
                      {formatBs(s.total_amount)} ·{" "}
                      {new Date(s.created_at).toLocaleDateString("es-BO")}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {selectedSale && (
              <div className="mt-2 flex items-center gap-3 rounded-md border border-green-300 bg-green-50 px-3 py-2 dark:border-green-800 dark:bg-green-900/20">
                <span className="text-sm font-medium text-green-800 dark:text-green-400">
                  Venta: {selectedSale.number ?? selectedSale.id.slice(0, 8)}
                </span>
                <span className="text-sm text-green-700 dark:text-green-500">
                  {formatBs(selectedSale.total_amount)}
                </span>
                <button
                  onClick={() => {
                    setSelectedSaleId("");
                    setRefundAmount("");
                  }}
                  className="ml-auto text-xs text-green-600 underline hover:text-green-800"
                >
                  Cambiar
                </button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs text-text-muted">
                Motivo *
              </label>
              <select
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
              >
                <option value="">Seleccionar motivo...</option>
                {REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              {reason === "Otro" && (
                <input
                  type="text"
                  value={customReason}
                  onChange={(e) => setCustomReason(e.target.value)}
                  placeholder="Especificar motivo"
                  className="mt-2 w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
                />
              )}
            </div>
            <div>
              <label className="mb-1 block text-xs text-text-muted">
                Monto a devolver *
              </label>
              <input
                type="number"
                step="0.01"
                value={refundAmount}
                onChange={(e) => setRefundAmount(e.target.value)}
                placeholder="0.00"
                className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
              />
              {selectedSale && parseFloat(refundAmount) < selectedSale.total_amount && parseFloat(refundAmount) > 0 && (
                <p className="mt-1 text-xs text-yellow-600">
                  Devolución parcial ({((parseFloat(refundAmount) / selectedSale.total_amount) * 100).toFixed(0)}%)
                </p>
              )}
            </div>
            <div>
              <label className="mb-1 block text-xs text-text-muted">
                Método de reembolso *
              </label>
              <select
                value={refundMethod}
                onChange={(e) => setRefundMethod(e.target.value)}
                className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
              >
                {REFUND_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-text-muted">
                Sesión de caja
              </label>
              <select
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
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
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs text-text-muted">
                Notas
              </label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Notas adicionales"
                className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
              />
            </div>
          </div>

          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={() => {
                const finalReason =
                  reason === "Otro" ? customReason || "Otro" : reason;
                if (
                  !selectedSaleId ||
                  !finalReason ||
                  !refundAmount ||
                  !refundMethod
                )
                  return;
                createReturn.mutate({
                  sale_id: selectedSaleId,
                  reason: finalReason,
                  refund_amount: parseFloat(refundAmount),
                  refund_method: refundMethod,
                  session_id: sessionId || undefined,
                  notes: notes || undefined,
                });
              }}
              disabled={
                createReturn.isPending ||
                !selectedSaleId ||
                !reason ||
                !refundAmount
              }
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {createReturn.isPending
                ? "Procesando..."
                : "Confirmar devolución"}
            </button>
            {createReturn.isError && (
              <p className="text-sm text-red-600">
                Error al procesar devolución
              </p>
            )}
          </div>
        </div>
      )}

      {/* Returns table */}
      {isLoading ? (
        <p className="text-sm text-text-muted">Cargando...</p>
      ) : !returns?.length ? (
        <p className="text-sm text-text-muted">No hay devoluciones registradas</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border-primary">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-primary bg-surface-secondary text-left text-text-muted">
                <th className="px-4 py-3 font-medium">Nro.</th>
                <th className="px-4 py-3 font-medium">Fecha</th>
                <th className="px-4 py-3 font-medium">Motivo</th>
                <th className="px-4 py-3 font-medium">Método</th>
                <th className="px-4 py-3 font-medium">Estado</th>
                <th className="px-4 py-3 text-right font-medium">Monto</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-primary">
              {returns.map((r) => (
                <tr key={r.id} className="hover:bg-surface-secondary/50">
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-text-primary">
                    {r.return_number}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-text-muted">
                    {new Date(r.created_at).toLocaleDateString("es-BO")}
                  </td>
                  <td className="px-4 py-3 text-text-primary">
                    {r.reason}
                    {r.notes && (
                      <p className="mt-0.5 text-xs text-text-muted">
                        {r.notes}
                      </p>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-text-muted">
                    {methodLabel(r.refund_method)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${stateColor(r.state)}`}
                    >
                      {stateLabel(r.state)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-medium text-red-600 dark:text-red-400">
                    -{formatBs(r.refund_amount)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border-primary bg-surface-secondary">
                <td
                  colSpan={5}
                  className="px-4 py-3 text-right text-sm font-medium text-text-muted"
                >
                  Total reembolsado
                </td>
                <td className="px-4 py-3 text-right text-sm font-semibold text-red-600 dark:text-red-400">
                  -{formatBs(totalRefunded)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
