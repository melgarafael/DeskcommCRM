"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

interface Discount {
  id: string;
  name: string;
  discount_type: "percentage" | "fixed" | "bogo";
  value: number;
  applies_to: "sale" | "item" | "category";
  promo_code: string | null;
  is_active: boolean;
  valid_from: string | null;
  valid_until: string | null;
  max_uses: number | null;
  current_uses: number;
}

function formatValue(d: Discount) {
  if (d.discount_type === "percentage") return `${d.value}%`;
  if (d.discount_type === "fixed") return `Bs. ${d.value.toFixed(2)}`;
  return "2x1";
}

export function DescuentosPOSClient() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", discount_type: "percentage", value: "", applies_to: "sale", promo_code: "", valid_from: "", valid_until: "", max_uses: "" });

  const { data: discounts, isLoading } = useQuery({
    queryKey: ["pos-discounts"],
    queryFn: () => apiClient.get<Discount[]>("/api/v1/pos/discounts"),
  });

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiClient.post("/api/v1/pos/discounts", body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["pos-discounts"] }); setShowForm(false); },
  });

  const toggle = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) =>
      apiClient.put(`/api/v1/pos/discounts/${id}`, { is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pos-discounts"] }),
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">Descuentos</h1>
        <button onClick={() => setShowForm(!showForm)} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
          {showForm ? "Cancelar" : "Nuevo descuento"}
        </button>
      </div>

      {showForm && (
        <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input placeholder="Nombre *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary" />
            <select value={form.discount_type} onChange={(e) => setForm({ ...form, discount_type: e.target.value })} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary">
              <option value="percentage">Porcentaje</option>
              <option value="fixed">Monto fijo</option>
              <option value="bogo">2x1</option>
            </select>
            <input placeholder="Valor *" type="number" step="0.01" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary" />
            <select value={form.applies_to} onChange={(e) => setForm({ ...form, applies_to: e.target.value })} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary">
              <option value="sale">Toda la venta</option>
              <option value="item">Por item</option>
              <option value="category">Por categoría</option>
            </select>
            <input placeholder="Código promo (opcional)" value={form.promo_code} onChange={(e) => setForm({ ...form, promo_code: e.target.value })} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary" />
            <input placeholder="Usos máximos (opcional)" type="number" value={form.max_uses} onChange={(e) => setForm({ ...form, max_uses: e.target.value })} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary" />
            <input type="date" value={form.valid_from} onChange={(e) => setForm({ ...form, valid_from: e.target.value })} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary" />
            <input type="date" value={form.valid_until} onChange={(e) => setForm({ ...form, valid_until: e.target.value })} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary" />
          </div>
          <button
            onClick={() => {
              if (!form.name || !form.value) return;
              create.mutate({
                name: form.name,
                discount_type: form.discount_type,
                value: parseFloat(form.value),
                applies_to: form.applies_to,
                promo_code: form.promo_code || undefined,
                max_uses: form.max_uses ? parseInt(form.max_uses) : undefined,
                valid_from: form.valid_from || undefined,
                valid_until: form.valid_until || undefined,
              });
            }}
            disabled={create.isPending || !form.name || !form.value}
            className="mt-3 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {create.isPending ? "Guardando..." : "Guardar"}
          </button>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-text-muted">Cargando...</p>
      ) : !discounts?.length ? (
        <p className="text-sm text-text-muted">No hay descuentos configurados</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-primary text-left text-text-muted">
                <th className="pb-2">Nombre</th>
                <th className="pb-2">Tipo</th>
                <th className="pb-2">Valor</th>
                <th className="pb-2">Aplica a</th>
                <th className="pb-2">Código</th>
                <th className="pb-2">Usos</th>
                <th className="pb-2">Estado</th>
              </tr>
            </thead>
            <tbody>
              {discounts.map((d) => (
                <tr key={d.id} className="border-b border-border-primary">
                  <td className="py-2 text-text-primary">{d.name}</td>
                  <td className="py-2 text-text-muted">{d.discount_type}</td>
                  <td className="py-2 text-text-primary">{formatValue(d)}</td>
                  <td className="py-2 text-text-muted">{d.applies_to}</td>
                  <td className="py-2 text-text-muted">{d.promo_code ?? "—"}</td>
                  <td className="py-2 text-text-muted">{d.current_uses}{d.max_uses ? `/${d.max_uses}` : ""}</td>
                  <td className="py-2">
                    <button
                      onClick={() => toggle.mutate({ id: d.id, is_active: !d.is_active })}
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${d.is_active ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400" : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"}`}
                    >
                      {d.is_active ? "Activo" : "Inactivo"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
