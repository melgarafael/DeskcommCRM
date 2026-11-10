"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

interface Product {
  id: string;
  name: string;
  sku: string | null;
  category: string | null;
  sale_price: number;
  cost_price: number | null;
  stock_quantity: number | null;
  min_stock: number | null;
  is_active: boolean;
}

function formatBs(n: number) {
  return `Bs. ${n.toFixed(2)}`;
}

export function ProductosPOSClient() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", sku: "", category: "", sale_price: "", cost_price: "", track_stock: false, stock_quantity: "", min_stock: "" });

  const { data: products, isLoading } = useQuery({
    queryKey: ["pos-products", search],
    queryFn: () => apiClient.get<Product[]>(`/api/v1/pos/products${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  });

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiClient.post("/api/v1/pos/products", body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["pos-products"] }); setShowForm(false); resetForm(); },
  });

  const toggleActive = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) =>
      apiClient.put(`/api/v1/pos/products/${id}`, { is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pos-products"] }),
  });

  function resetForm() {
    setForm({ name: "", sku: "", category: "", sale_price: "", cost_price: "", track_stock: false, stock_quantity: "", min_stock: "" });
  }

  function handleSubmit() {
    if (!form.name || !form.sale_price) return;
    create.mutate({
      name: form.name,
      sku: form.sku || undefined,
      category: form.category || undefined,
      sale_price: parseFloat(form.sale_price),
      cost_price: form.cost_price ? parseFloat(form.cost_price) : undefined,
      track_stock: form.track_stock,
      stock_quantity: form.stock_quantity ? parseInt(form.stock_quantity) : undefined,
      min_stock: form.min_stock ? parseInt(form.min_stock) : undefined,
    });
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">Productos</h1>
        <button onClick={() => setShowForm(!showForm)} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
          {showForm ? "Cancelar" : "Nuevo producto"}
        </button>
      </div>

      {showForm && (
        <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input placeholder="Nombre *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary" />
            <input placeholder="SKU" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary" />
            <input placeholder="Categoría" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary" />
            <input placeholder="Precio de venta *" type="number" step="0.01" value={form.sale_price} onChange={(e) => setForm({ ...form, sale_price: e.target.value })} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary" />
            <input placeholder="Precio de costo" type="number" step="0.01" value={form.cost_price} onChange={(e) => setForm({ ...form, cost_price: e.target.value })} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary" />
            <label className="flex items-center gap-2 text-sm text-text-primary">
              <input type="checkbox" checked={form.track_stock} onChange={(e) => setForm({ ...form, track_stock: e.target.checked })} />
              Controlar stock
            </label>
            {form.track_stock && (
              <>
                <input placeholder="Stock actual" type="number" value={form.stock_quantity} onChange={(e) => setForm({ ...form, stock_quantity: e.target.value })} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary" />
                <input placeholder="Stock mínimo" type="number" value={form.min_stock} onChange={(e) => setForm({ ...form, min_stock: e.target.value })} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary" />
              </>
            )}
          </div>
          <button onClick={handleSubmit} disabled={create.isPending || !form.name || !form.sale_price} className="mt-3 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {create.isPending ? "Guardando..." : "Guardar"}
          </button>
        </div>
      )}

      <input placeholder="Buscar productos..." value={search} onChange={(e) => setSearch(e.target.value)} className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary" />

      {isLoading ? (
        <p className="text-sm text-text-muted">Cargando...</p>
      ) : !products?.length ? (
        <p className="text-sm text-text-muted">No hay productos registrados</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-primary text-left text-text-muted">
                <th className="pb-2">Nombre</th>
                <th className="pb-2">SKU</th>
                <th className="pb-2">Categoría</th>
                <th className="pb-2 text-right">Precio</th>
                <th className="pb-2 text-right">Stock</th>
                <th className="pb-2">Estado</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id} className="border-b border-border-primary">
                  <td className="py-2 text-text-primary">{p.name}</td>
                  <td className="py-2 text-text-muted">{p.sku ?? "—"}</td>
                  <td className="py-2 text-text-muted">{p.category ?? "—"}</td>
                  <td className="py-2 text-right text-text-primary">{formatBs(p.sale_price)}</td>
                  <td className="py-2 text-right text-text-muted">{p.stock_quantity ?? "—"}</td>
                  <td className="py-2">
                    <button
                      onClick={() => toggleActive.mutate({ id: p.id, is_active: !p.is_active })}
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${p.is_active ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400" : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"}`}
                    >
                      {p.is_active ? "Activo" : "Inactivo"}
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
