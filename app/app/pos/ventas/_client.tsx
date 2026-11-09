"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

interface SaleLine {
  id: string;
  product_name: string;
  qty: number;
  price_unit: number;
  price_subtotal: number;
  tax_amount: number;
}

interface SalePayment {
  id: string;
  payment_method_name: string;
  amount: number;
}

interface Sale {
  id: string;
  number: string;
  date: string;
  session_id: string;
  session_name: string;
  partner_name: string | null;
  total: number;
  state: string;
  lines?: SaleLine[];
  payments?: SalePayment[];
}

function formatBs(amount: number) {
  return `Bs. ${amount.toFixed(2)}`;
}

export function VentasPOSClient() {
  const queryClient = useQueryClient();
  const [stateFilter, setStateFilter] = useState("");
  const [sessionFilter, setSessionFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [expandedSale, setExpandedSale] = useState<string | null>(null);

  const params = new URLSearchParams();
  if (stateFilter) params.set("state", stateFilter);
  if (sessionFilter) params.set("session_id", sessionFilter);
  if (dateFrom) params.set("date_from", dateFrom);
  if (dateTo) params.set("date_to", dateTo);
  const qs = params.toString() ? `?${params.toString()}` : "";

  const { data: sales, isLoading } = useQuery({
    queryKey: ["pos-sales", stateFilter, sessionFilter, dateFrom, dateTo],
    queryFn: () => apiClient.get<Sale[]>(`/api/v1/pos/sales${qs}`),
  });

  const { data: saleDetail } = useQuery({
    queryKey: ["pos-sale-detail", expandedSale],
    queryFn: () => apiClient.get<Sale>(`/api/v1/pos/sales/${expandedSale}`),
    enabled: !!expandedSale,
  });

  const voidSale = useMutation({
    mutationFn: (id: string) => apiClient.post(`/api/v1/pos/sales/${id}/void`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-sales"] });
      setExpandedSale(null);
    },
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold text-text-primary">Ventas POS</h1>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border-primary bg-surface-primary p-4">
        <div>
          <label className="mb-1 block text-xs text-text-muted">Estado</label>
          <select
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value)}
            className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
          >
            <option value="">Todos</option>
            <option value="confirmed">Confirmada</option>
            <option value="voided">Anulada</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-muted">Sesion</label>
          <input
            type="text"
            placeholder="ID de sesion"
            value={sessionFilter}
            onChange={(e) => setSessionFilter(e.target.value)}
            className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-muted">Desde</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-muted">Hasta</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
          />
        </div>
      </div>

      {/* Sales table */}
      <div className="rounded-lg border border-border-primary bg-surface-primary">
        {isLoading ? (
          <p className="p-4 text-sm text-text-muted">Cargando...</p>
        ) : !sales?.length ? (
          <p className="p-4 text-sm text-text-muted">No se encontraron ventas</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-primary text-left text-text-muted">
                <th className="px-4 py-3 font-medium">Numero</th>
                <th className="px-4 py-3 font-medium">Fecha</th>
                <th className="px-4 py-3 font-medium">Sesion</th>
                <th className="px-4 py-3 font-medium">Cliente</th>
                <th className="px-4 py-3 font-medium text-right">Total</th>
                <th className="px-4 py-3 font-medium">Estado</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border-primary">
              {sales.map((sale) => (
                <>
                  <tr
                    key={sale.id}
                    className="cursor-pointer hover:bg-surface-secondary"
                    onClick={() => setExpandedSale(expandedSale === sale.id ? null : sale.id)}
                  >
                    <td className="px-4 py-3 text-text-primary">{sale.number}</td>
                    <td className="px-4 py-3 text-text-primary">
                      {new Date(sale.date).toLocaleDateString("es-BO")}
                    </td>
                    <td className="px-4 py-3 text-text-primary">{sale.session_name}</td>
                    <td className="px-4 py-3 text-text-primary">{sale.partner_name ?? "---"}</td>
                    <td className="px-4 py-3 text-right text-text-primary">{formatBs(sale.total)}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          sale.state === "confirmed"
                            ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
                            : "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
                        }`}
                      >
                        {sale.state === "confirmed" ? "Confirmada" : "Anulada"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {sale.state === "confirmed" && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm("Seguro que desea anular esta venta?")) {
                              voidSale.mutate(sale.id);
                            }
                          }}
                          disabled={voidSale.isPending}
                          className="rounded-md border border-red-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20"
                        >
                          Anular
                        </button>
                      )}
                    </td>
                  </tr>
                  {expandedSale === sale.id && saleDetail && (
                    <tr key={`${sale.id}-detail`}>
                      <td colSpan={7} className="bg-surface-secondary px-4 py-3">
                        {/* Lines */}
                        {saleDetail.lines && saleDetail.lines.length > 0 && (
                          <div className="mb-3">
                            <p className="mb-1 text-xs font-medium text-text-muted">Lineas</p>
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-left text-text-muted">
                                  <th className="pb-1">Producto</th>
                                  <th className="pb-1 text-right">Cant.</th>
                                  <th className="pb-1 text-right">P. Unit.</th>
                                  <th className="pb-1 text-right">Impuesto</th>
                                  <th className="pb-1 text-right">Subtotal</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-border-primary">
                                {saleDetail.lines.map((line) => (
                                  <tr key={line.id}>
                                    <td className="py-1 text-text-primary">{line.product_name}</td>
                                    <td className="py-1 text-right text-text-primary">{line.qty}</td>
                                    <td className="py-1 text-right text-text-primary">{formatBs(line.price_unit)}</td>
                                    <td className="py-1 text-right text-text-primary">{formatBs(line.tax_amount)}</td>
                                    <td className="py-1 text-right text-text-primary">{formatBs(line.price_subtotal)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                        {/* Payments */}
                        {saleDetail.payments && saleDetail.payments.length > 0 && (
                          <div>
                            <p className="mb-1 text-xs font-medium text-text-muted">Pagos</p>
                            {saleDetail.payments.map((p) => (
                              <p key={p.id} className="text-xs text-text-primary">
                                {p.payment_method_name}: {formatBs(p.amount)}
                              </p>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
