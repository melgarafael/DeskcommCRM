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

interface PaymentMethod {
  id: string;
  name: string;
  type: string;
  is_active: boolean;
}

export function ConfiguracionPOSClient() {
  const queryClient = useQueryClient();

  // --- POS Configs ---
  const [showConfigForm, setShowConfigForm] = useState(false);
  const [configName, setConfigName] = useState("");
  const [configJournal, setConfigJournal] = useState("");

  const { data: configs, isLoading: loadingConfigs } = useQuery({
    queryKey: ["pos-configs"],
    queryFn: () => apiClient.get<POSConfig[]>("/api/v1/pos/configs"),
  });

  const createConfig = useMutation({
    mutationFn: (body: { name: string; journal_id?: string }) =>
      apiClient.post("/api/v1/pos/configs", body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-configs"] });
      setShowConfigForm(false);
      setConfigName("");
      setConfigJournal("");
    },
  });

  // --- Payment Methods ---
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [pmName, setPmName] = useState("");
  const [pmType, setPmType] = useState("cash");

  const { data: paymentMethods, isLoading: loadingPM } = useQuery({
    queryKey: ["pos-payment-methods"],
    queryFn: () => apiClient.get<PaymentMethod[]>("/api/v1/pos/payment-methods"),
  });

  const createPaymentMethod = useMutation({
    mutationFn: (body: { name: string; type: string }) =>
      apiClient.post("/api/v1/pos/payment-methods", body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-payment-methods"] });
      setShowPaymentForm(false);
      setPmName("");
      setPmType("cash");
    },
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold text-text-primary">Configuracion POS</h1>

      {/* POS Configurations */}
      <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">Configuraciones POS</h2>
          <button
            onClick={() => setShowConfigForm(!showConfigForm)}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            {showConfigForm ? "Cancelar" : "Crear configuracion"}
          </button>
        </div>

        {showConfigForm && (
          <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-border-primary bg-surface-secondary p-4">
            <div>
              <label className="mb-1 block text-xs text-text-muted">Nombre</label>
              <input
                type="text"
                value={configName}
                onChange={(e) => setConfigName(e.target.value)}
                placeholder="Ej: Caja Principal"
                className="rounded-md border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-text-muted">ID Diario (opcional)</label>
              <input
                type="text"
                value={configJournal}
                onChange={(e) => setConfigJournal(e.target.value)}
                placeholder="UUID del diario"
                className="rounded-md border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary"
              />
            </div>
            <button
              onClick={() => {
                if (!configName.trim()) return;
                createConfig.mutate({
                  name: configName.trim(),
                  ...(configJournal.trim() ? { journal_id: configJournal.trim() } : {}),
                });
              }}
              disabled={createConfig.isPending || !configName.trim()}
              className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              {createConfig.isPending ? "Guardando..." : "Guardar"}
            </button>
            {createConfig.isError && (
              <p className="text-sm text-red-600">Error al crear configuracion</p>
            )}
          </div>
        )}

        {loadingConfigs ? (
          <p className="text-sm text-text-muted">Cargando...</p>
        ) : !configs?.length ? (
          <p className="text-sm text-text-muted">No hay configuraciones creadas</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-primary text-left text-text-muted">
                <th className="px-4 py-3 font-medium">Nombre</th>
                <th className="px-4 py-3 font-medium">Diario</th>
                <th className="px-4 py-3 font-medium">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-primary">
              {configs.map((c) => (
                <tr key={c.id}>
                  <td className="px-4 py-3 text-text-primary">{c.name}</td>
                  <td className="px-4 py-3 text-text-muted">{c.journal_id ?? "---"}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        c.is_active
                          ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
                          : "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
                      }`}
                    >
                      {c.is_active ? "Activa" : "Inactiva"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Payment Methods */}
      <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">Metodos de Pago</h2>
          <button
            onClick={() => setShowPaymentForm(!showPaymentForm)}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            {showPaymentForm ? "Cancelar" : "Crear metodo de pago"}
          </button>
        </div>

        {showPaymentForm && (
          <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-border-primary bg-surface-secondary p-4">
            <div>
              <label className="mb-1 block text-xs text-text-muted">Nombre</label>
              <input
                type="text"
                value={pmName}
                onChange={(e) => setPmName(e.target.value)}
                placeholder="Ej: Efectivo"
                className="rounded-md border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-text-muted">Tipo</label>
              <select
                value={pmType}
                onChange={(e) => setPmType(e.target.value)}
                className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
              >
                <option value="cash">Efectivo</option>
                <option value="card">Tarjeta</option>
                <option value="transfer">Transferencia</option>
                <option value="qr">QR</option>
              </select>
            </div>
            <button
              onClick={() => {
                if (!pmName.trim()) return;
                createPaymentMethod.mutate({ name: pmName.trim(), type: pmType });
              }}
              disabled={createPaymentMethod.isPending || !pmName.trim()}
              className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              {createPaymentMethod.isPending ? "Guardando..." : "Guardar"}
            </button>
            {createPaymentMethod.isError && (
              <p className="text-sm text-red-600">Error al crear metodo de pago</p>
            )}
          </div>
        )}

        {loadingPM ? (
          <p className="text-sm text-text-muted">Cargando...</p>
        ) : !paymentMethods?.length ? (
          <p className="text-sm text-text-muted">No hay metodos de pago creados</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-primary text-left text-text-muted">
                <th className="px-4 py-3 font-medium">Nombre</th>
                <th className="px-4 py-3 font-medium">Tipo</th>
                <th className="px-4 py-3 font-medium">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-primary">
              {paymentMethods.map((pm) => (
                <tr key={pm.id}>
                  <td className="px-4 py-3 text-text-primary">{pm.name}</td>
                  <td className="px-4 py-3 text-text-muted">
                    {pm.type === "cash" ? "Efectivo" : pm.type === "card" ? "Tarjeta" : pm.type === "transfer" ? "Transferencia" : pm.type === "qr" ? "QR" : pm.type}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        pm.is_active
                          ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
                          : "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
                      }`}
                    >
                      {pm.is_active ? "Activo" : "Inactivo"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
