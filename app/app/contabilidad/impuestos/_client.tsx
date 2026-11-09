"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

interface TaxGroup {
  id: string;
  name: string;
}

interface TaxConfig {
  id: string;
  name: string;
  type_tax_use: string;
  amount_type: string;
  amount: number;
  tax_group_id?: string;
  tax_group_name?: string;
  is_active: boolean;
}

interface ComputeResult {
  base: number;
  tax_amount: number;
  total: number;
  taxes: { name: string; amount: number }[];
}

interface ReceivablePayable {
  total: number;
  count: number;
  items: { partner_name: string; amount: number }[];
}

export function ImpuestosClient() {
  const queryClient = useQueryClient();
  const [filterType, setFilterType] = useState("");
  const [filterActive, setFilterActive] = useState<string>("");
  const [groupName, setGroupName] = useState("");
  const [showConfigForm, setShowConfigForm] = useState(false);
  const [configForm, setConfigForm] = useState({
    name: "",
    type_tax_use: "sale",
    amount_type: "percent",
    amount: "",
    tax_group_id: "",
  });
  const [calcBase, setCalcBase] = useState("");
  const [calcTaxId, setCalcTaxId] = useState("");

  const { data: taxGroups, isLoading: loadingGroups } = useQuery({
    queryKey: ["tax-groups"],
    queryFn: () => apiClient.get<TaxGroup[]>("/api/v1/finance/tax-groups"),
  });

  const { data: taxConfigs, isLoading: loadingConfigs } = useQuery({
    queryKey: ["tax-configs"],
    queryFn: () => apiClient.get<TaxConfig[]>("/api/v1/finance/tax-configs"),
  });

  const { data: receivable } = useQuery({
    queryKey: ["receivable"],
    queryFn: () =>
      apiClient.get<ReceivablePayable>(
        "/api/v1/finance/reports/receivable-payable?type=receivable"
      ),
  });

  const { data: payable } = useQuery({
    queryKey: ["payable"],
    queryFn: () =>
      apiClient.get<ReceivablePayable>(
        "/api/v1/finance/reports/receivable-payable?type=payable"
      ),
  });

  const createGroup = useMutation({
    mutationFn: (name: string) =>
      apiClient.post("/api/v1/finance/tax-groups", { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tax-groups"] });
      setGroupName("");
    },
  });

  const createConfig = useMutation({
    mutationFn: (data: typeof configForm) =>
      apiClient.post("/api/v1/finance/tax-configs", {
        ...data,
        amount: parseFloat(data.amount),
        tax_group_id: data.tax_group_id || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tax-configs"] });
      setShowConfigForm(false);
      setConfigForm({
        name: "",
        type_tax_use: "sale",
        amount_type: "percent",
        amount: "",
        tax_group_id: "",
      });
    },
  });

  const seedFiscalTags = useMutation({
    mutationFn: () => apiClient.post("/api/v1/finance/fiscal/seed", {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tax-groups"] });
      queryClient.invalidateQueries({ queryKey: ["tax-configs"] });
    },
  });

  const computeTax = useMutation({
    mutationFn: ({ base, tax_id }: { base: number; tax_id: string }) =>
      apiClient.post<ComputeResult>("/api/v1/finance/tax-configs/compute", {
        base,
        tax_id,
      }),
  });

  const filteredConfigs = taxConfigs?.filter((c) => {
    if (filterType && c.amount_type !== filterType) return false;
    if (filterActive === "true" && !c.is_active) return false;
    if (filterActive === "false" && c.is_active) return false;
    return true;
  });

  const amountTypeLabel = (t: string) => {
    const map: Record<string, string> = {
      percent: "Porcentaje",
      division: "Division",
      group: "Grupo",
      fixed: "Fijo",
    };
    return map[t] || t;
  };

  if (loadingGroups || loadingConfigs)
    return <p className="p-6 text-text-muted">Cargando...</p>;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">Impuestos</h1>
        <button
          onClick={() => seedFiscalTags.mutate()}
          disabled={seedFiscalTags.isPending}
          className="rounded-lg bg-surface-secondary px-4 py-2 text-sm font-medium text-text-primary hover:opacity-80 disabled:opacity-50"
        >
          {seedFiscalTags.isPending ? "Sembrando..." : "Sembrar tags fiscales"}
        </button>
      </div>

      {/* Tax Groups */}
      <div className="rounded-lg border border-border-primary bg-surface-primary p-4 space-y-3">
        <h2 className="text-sm font-semibold text-text-primary">
          Grupos de Impuestos
        </h2>
        <div className="flex gap-2">
          <input
            placeholder="Nombre del grupo"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            className="rounded border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
          />
          <button
            onClick={() => groupName && createGroup.mutate(groupName)}
            disabled={createGroup.isPending || !groupName}
            className="rounded bg-surface-secondary px-3 py-2 text-sm text-text-primary hover:opacity-80 disabled:opacity-50"
          >
            Crear
          </button>
        </div>
        {createGroup.isError && (
          <p className="text-sm text-red-500">Error al crear grupo</p>
        )}
        {taxGroups && taxGroups.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {taxGroups.map((g) => (
              <span
                key={g.id}
                className="rounded-full border border-border-primary px-3 py-1 text-xs text-text-muted"
              >
                {g.name}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Tax Configs */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary">
            Configuraciones de Impuestos
          </h2>
          <button
            onClick={() => setShowConfigForm(!showConfigForm)}
            className="rounded-lg bg-surface-secondary px-4 py-2 text-sm font-medium text-text-primary hover:opacity-80"
          >
            {showConfigForm ? "Cancelar" : "Crear configuracion"}
          </button>
        </div>

        {/* Filters */}
        <div className="flex gap-3">
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="rounded border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
          >
            <option value="">Todos los tipos</option>
            <option value="percent">Porcentaje</option>
            <option value="division">Division</option>
            <option value="group">Grupo</option>
            <option value="fixed">Fijo</option>
          </select>
          <select
            value={filterActive}
            onChange={(e) => setFilterActive(e.target.value)}
            className="rounded border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
          >
            <option value="">Activa: Todos</option>
            <option value="true">Activa</option>
            <option value="false">Inactiva</option>
          </select>
        </div>

        {/* Create config form */}
        {showConfigForm && (
          <div className="rounded-lg border border-border-primary bg-surface-primary p-4 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <input
                placeholder="Nombre"
                value={configForm.name}
                onChange={(e) =>
                  setConfigForm({ ...configForm, name: e.target.value })
                }
                className="rounded border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
              />
              <select
                value={configForm.type_tax_use}
                onChange={(e) =>
                  setConfigForm({ ...configForm, type_tax_use: e.target.value })
                }
                className="rounded border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
              >
                <option value="sale">Venta</option>
                <option value="purchase">Compra</option>
                <option value="none">Ninguno</option>
              </select>
              <select
                value={configForm.amount_type}
                onChange={(e) =>
                  setConfigForm({ ...configForm, amount_type: e.target.value })
                }
                className="rounded border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
              >
                <option value="percent">Porcentaje</option>
                <option value="division">Division</option>
                <option value="group">Grupo</option>
                <option value="fixed">Fijo</option>
              </select>
              <input
                type="number"
                placeholder="Monto"
                value={configForm.amount}
                onChange={(e) =>
                  setConfigForm({ ...configForm, amount: e.target.value })
                }
                className="rounded border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
              />
              <select
                value={configForm.tax_group_id}
                onChange={(e) =>
                  setConfigForm({ ...configForm, tax_group_id: e.target.value })
                }
                className="rounded border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
              >
                <option value="">Sin grupo</option>
                {taxGroups?.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              onClick={() => createConfig.mutate(configForm)}
              disabled={createConfig.isPending}
              className="rounded-lg bg-surface-secondary px-4 py-2 text-sm font-medium text-text-primary hover:opacity-80 disabled:opacity-50"
            >
              {createConfig.isPending ? "Guardando..." : "Guardar"}
            </button>
            {createConfig.isError && (
              <p className="text-sm text-red-500">Error al crear configuracion</p>
            )}
          </div>
        )}

        {/* Configs table */}
        <div className="rounded-lg border border-border-primary bg-surface-primary">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-primary text-left text-text-muted">
                <th className="px-4 py-3">Nombre</th>
                <th className="px-4 py-3">Tipo</th>
                <th className="px-4 py-3 text-right">Monto</th>
                <th className="px-4 py-3">Grupo</th>
                <th className="px-4 py-3">Activa</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-primary">
              {filteredConfigs?.map((c) => (
                <tr key={c.id}>
                  <td className="px-4 py-3 text-text-primary">{c.name}</td>
                  <td className="px-4 py-3 text-text-muted">
                    {amountTypeLabel(c.amount_type)}
                  </td>
                  <td className="px-4 py-3 text-right text-text-primary">
                    {c.amount}
                    {c.amount_type === "percent" ? "%" : ""}
                  </td>
                  <td className="px-4 py-3 text-text-muted">
                    {c.tax_group_name || "-"}
                  </td>
                  <td className="px-4 py-3 text-text-muted">
                    {c.is_active ? "Si" : "No"}
                  </td>
                </tr>
              ))}
              {(!filteredConfigs || filteredConfigs.length === 0) && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-6 text-center text-text-muted"
                  >
                    Sin configuraciones de impuestos
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Tax Calculator */}
      <div className="rounded-lg border border-border-primary bg-surface-primary p-4 space-y-3">
        <h2 className="text-sm font-semibold text-text-primary">
          Calculadora de Impuestos
        </h2>
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="mb-1 block text-xs text-text-muted">
              Monto base
            </label>
            <input
              type="number"
              placeholder="0.00"
              value={calcBase}
              onChange={(e) => setCalcBase(e.target.value)}
              className="rounded border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-text-muted">
              Impuesto
            </label>
            <select
              value={calcTaxId}
              onChange={(e) => setCalcTaxId(e.target.value)}
              className="rounded border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
            >
              <option value="">Seleccionar</option>
              {taxConfigs
                ?.filter((c) => c.is_active)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </div>
          <button
            onClick={() =>
              calcBase &&
              calcTaxId &&
              computeTax.mutate({
                base: parseFloat(calcBase),
                tax_id: calcTaxId,
              })
            }
            disabled={computeTax.isPending || !calcBase || !calcTaxId}
            className="rounded-lg bg-surface-secondary px-4 py-2 text-sm font-medium text-text-primary hover:opacity-80 disabled:opacity-50"
          >
            Calcular
          </button>
        </div>
        {computeTax.data && (
          <div className="mt-2 space-y-1 text-sm">
            <p className="text-text-muted">
              Base: <span className="text-text-primary">{computeTax.data.base.toLocaleString()}</span>
            </p>
            {computeTax.data.taxes?.map((t, i) => (
              <p key={i} className="text-text-muted">
                {t.name}: <span className="text-text-primary">{t.amount.toLocaleString()}</span>
              </p>
            ))}
            <p className="font-medium text-text-primary">
              Total: {computeTax.data.total.toLocaleString()}
            </p>
          </div>
        )}
        {computeTax.isError && (
          <p className="text-sm text-red-500">Error al calcular</p>
        )}
      </div>

      {/* Receivable / Payable summary */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
          <h2 className="text-sm font-semibold text-text-primary">
            Cuentas por Cobrar
          </h2>
          {receivable ? (
            <>
              <p className="mt-1 text-lg font-semibold text-text-primary">
                {receivable.total.toLocaleString("es-BO", {
                  style: "currency",
                  currency: "BOB",
                })}
              </p>
              <p className="text-xs text-text-muted">
                {receivable.count} registros
              </p>
            </>
          ) : (
            <p className="mt-1 text-sm text-text-muted">Cargando...</p>
          )}
        </div>
        <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
          <h2 className="text-sm font-semibold text-text-primary">
            Cuentas por Pagar
          </h2>
          {payable ? (
            <>
              <p className="mt-1 text-lg font-semibold text-text-primary">
                {payable.total.toLocaleString("es-BO", {
                  style: "currency",
                  currency: "BOB",
                })}
              </p>
              <p className="text-xs text-text-muted">
                {payable.count} registros
              </p>
            </>
          ) : (
            <p className="mt-1 text-sm text-text-muted">Cargando...</p>
          )}
        </div>
      </div>
    </div>
  );
}
