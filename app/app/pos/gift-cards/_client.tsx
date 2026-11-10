"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

interface GiftCard {
  id: string;
  code: string;
  initial_amount: number;
  current_balance: number;
  status: "active" | "used" | "expired" | "cancelled";
  expires_at: string | null;
  created_at: string;
}

function formatBs(n: number) {
  return `Bs. ${n.toFixed(2)}`;
}

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  active: { label: "Activa", cls: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400" },
  used: { label: "Usada", cls: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400" },
  expired: { label: "Vencida", cls: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400" },
  cancelled: { label: "Cancelada", cls: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400" },
};

export function GiftCardsPOSClient() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [amount, setAmount] = useState("");
  const [expiresAt, setExpiresAt] = useState("");

  const { data: cards, isLoading } = useQuery({
    queryKey: ["pos-gift-cards"],
    queryFn: () => apiClient.get<GiftCard[]>("/api/v1/pos/gift-cards"),
  });

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiClient.post("/api/v1/pos/gift-cards", body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["pos-gift-cards"] }); setShowForm(false); setAmount(""); setExpiresAt(""); },
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">Gift Cards</h1>
        <button onClick={() => setShowForm(!showForm)} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
          {showForm ? "Cancelar" : "Nueva gift card"}
        </button>
      </div>

      {showForm && (
        <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input placeholder="Monto *" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary" />
            <input type="date" placeholder="Vence el" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary" />
          </div>
          <button
            onClick={() => { if (!amount) return; create.mutate({ initial_amount: parseFloat(amount), expires_at: expiresAt || undefined }); }}
            disabled={create.isPending || !amount}
            className="mt-3 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {create.isPending ? "Creando..." : "Crear gift card"}
          </button>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-text-muted">Cargando...</p>
      ) : !cards?.length ? (
        <p className="text-sm text-text-muted">No hay gift cards</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-primary text-left text-text-muted">
                <th className="pb-2">Código</th>
                <th className="pb-2 text-right">Monto inicial</th>
                <th className="pb-2 text-right">Saldo</th>
                <th className="pb-2">Estado</th>
                <th className="pb-2">Vence</th>
                <th className="pb-2">Creada</th>
              </tr>
            </thead>
            <tbody>
              {cards.map((c) => {
                const st = STATUS_LABELS[c.status] ?? STATUS_LABELS["active"]!;
                return (
                  <tr key={c.id} className="border-b border-border-primary">
                    <td className="py-2 font-mono text-text-primary">{c.code}</td>
                    <td className="py-2 text-right text-text-muted">{formatBs(c.initial_amount)}</td>
                    <td className="py-2 text-right text-text-primary">{formatBs(c.current_balance)}</td>
                    <td className="py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${st.cls}`}>{st.label}</span></td>
                    <td className="py-2 text-text-muted">{c.expires_at ? new Date(c.expires_at).toLocaleDateString("es-BO") : "—"}</td>
                    <td className="py-2 text-text-muted">{new Date(c.created_at).toLocaleDateString("es-BO")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
