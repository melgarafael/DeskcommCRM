"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

const PAPER_SIZES = [
  { value: "58mm", label: "58 mm (térmico)" },
  { value: "80mm", label: "80 mm (térmico)" },
  { value: "a4", label: "A4" },
] as const;

interface TicketTemplate {
  id: string;
  name: string;
  business_name: string | null;
  tax_id: string | null;
  address: string | null;
  phone: string | null;
  logo_url: string | null;
  header_text: string | null;
  footer_text: string | null;
  show_tax_breakdown: boolean;
  show_payment_method: boolean;
  show_cashier: boolean;
  show_date_time: boolean;
  show_client: boolean;
  paper_size: string;
  is_default: boolean;
  created_at: string;
}

function emptyForm() {
  return {
    name: "",
    business_name: "",
    tax_id: "",
    address: "",
    phone: "",
    logo_url: "",
    header_text: "",
    footer_text: "Gracias por su compra",
    show_tax_breakdown: true,
    show_payment_method: true,
    show_cashier: true,
    show_date_time: true,
    show_client: true,
    paper_size: "80mm",
    is_default: false,
  };
}

function TicketPreview({ tpl }: { tpl: ReturnType<typeof emptyForm> }) {
  const w = tpl.paper_size === "58mm" ? "220px" : tpl.paper_size === "80mm" ? "302px" : "100%";
  return (
    <div
      className="mx-auto border border-dashed border-border-primary bg-white p-4 text-black"
      style={{ width: w, fontFamily: "monospace", fontSize: "12px" }}
    >
      {tpl.header_text && (
        <p className="mb-1 text-center text-xs">{tpl.header_text}</p>
      )}
      {tpl.business_name && (
        <p className="text-center text-sm font-bold">{tpl.business_name}</p>
      )}
      {tpl.tax_id && (
        <p className="text-center text-xs">NIT: {tpl.tax_id}</p>
      )}
      {tpl.address && (
        <p className="text-center text-xs">{tpl.address}</p>
      )}
      {tpl.phone && (
        <p className="text-center text-xs">Tel: {tpl.phone}</p>
      )}
      <div className="my-2 border-t border-dashed border-gray-400" />

      {tpl.show_date_time && (
        <p className="text-xs">Fecha: {new Date().toLocaleDateString("es-BO")} {new Date().toLocaleTimeString("es-BO", { hour: "2-digit", minute: "2-digit" })}</p>
      )}
      <p className="text-xs">Nro: VTA-0001</p>
      {tpl.show_cashier && <p className="text-xs">Cajero: Juan Pérez</p>}
      {tpl.show_client && <p className="text-xs">Cliente: María López</p>}

      <div className="my-2 border-t border-dashed border-gray-400" />

      <div className="flex justify-between text-xs font-bold">
        <span>Producto</span>
        <span>Total</span>
      </div>
      <div className="flex justify-between text-xs">
        <span>Corte de pelo x1</span>
        <span>80.00</span>
      </div>
      <div className="flex justify-between text-xs">
        <span>Shampoo x2</span>
        <span>50.00</span>
      </div>

      {tpl.show_tax_breakdown && (
        <>
          <div className="my-1 border-t border-dashed border-gray-400" />
          <div className="flex justify-between text-xs">
            <span>Subtotal</span>
            <span>113.27</span>
          </div>
          <div className="flex justify-between text-xs">
            <span>IVA (13%)</span>
            <span>16.73</span>
          </div>
        </>
      )}

      <div className="my-1 border-t border-dashed border-gray-400" />
      <div className="flex justify-between text-xs font-bold">
        <span>TOTAL</span>
        <span>Bs. 130.00</span>
      </div>

      {tpl.show_payment_method && (
        <p className="mt-1 text-xs">Pago: Efectivo</p>
      )}

      {tpl.footer_text && (
        <>
          <div className="my-2 border-t border-dashed border-gray-400" />
          <p className="text-center text-xs">{tpl.footer_text}</p>
        </>
      )}
    </div>
  );
}

export function TicketsPOSClient() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm());

  const { data: templates, isLoading } = useQuery({
    queryKey: ["pos-ticket-templates"],
    queryFn: () =>
      apiClient.get<TicketTemplate[]>("/api/v1/pos/ticket-templates"),
  });

  const saveMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      editId
        ? apiClient.patch("/api/v1/pos/ticket-templates", { id: editId, ...body })
        : apiClient.post("/api/v1/pos/ticket-templates", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pos-ticket-templates"] });
      setShowForm(false);
      setEditId(null);
      setForm(emptyForm());
    },
  });

  function startEdit(t: TicketTemplate) {
    setEditId(t.id);
    setForm({
      name: t.name,
      business_name: t.business_name ?? "",
      tax_id: t.tax_id ?? "",
      address: t.address ?? "",
      phone: t.phone ?? "",
      logo_url: t.logo_url ?? "",
      header_text: t.header_text ?? "",
      footer_text: t.footer_text ?? "",
      show_tax_breakdown: t.show_tax_breakdown,
      show_payment_method: t.show_payment_method,
      show_cashier: t.show_cashier,
      show_date_time: t.show_date_time,
      show_client: t.show_client,
      paper_size: t.paper_size,
      is_default: t.is_default,
    });
    setShowForm(true);
  }

  function setField(key: string, value: unknown) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">
            Tickets / Recibos
          </h1>
          <p className="text-sm text-text-muted">
            Configura la plantilla de tickets para impresión o envío
          </p>
        </div>
        <button
          onClick={() => {
            if (showForm) {
              setShowForm(false);
              setEditId(null);
              setForm(emptyForm());
            } else {
              setShowForm(true);
            }
          }}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          {showForm ? "Cancelar" : "Nueva plantilla"}
        </button>
      </div>

      {showForm && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Form */}
          <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
            <h2 className="mb-3 text-sm font-semibold text-text-primary">
              {editId ? "Editar plantilla" : "Nueva plantilla"}
            </h2>

            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs text-text-muted">Nombre *</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setField("name", e.target.value)}
                    placeholder="Ej: Ticket estándar"
                    className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-text-muted">Tamaño de papel</label>
                  <select
                    value={form.paper_size}
                    onChange={(e) => setField("paper_size", e.target.value)}
                    className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
                  >
                    {PAPER_SIZES.map((s) => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs text-text-muted">Nombre del negocio</label>
                  <input
                    type="text"
                    value={form.business_name}
                    onChange={(e) => setField("business_name", e.target.value)}
                    placeholder="Mi Negocio S.R.L."
                    className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-text-muted">NIT / RUC</label>
                  <input
                    type="text"
                    value={form.tax_id}
                    onChange={(e) => setField("tax_id", e.target.value)}
                    placeholder="123456789"
                    className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs text-text-muted">Dirección</label>
                  <input
                    type="text"
                    value={form.address}
                    onChange={(e) => setField("address", e.target.value)}
                    placeholder="Av. Principal #123"
                    className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-text-muted">Teléfono</label>
                  <input
                    type="text"
                    value={form.phone}
                    onChange={(e) => setField("phone", e.target.value)}
                    placeholder="+591 7XXXXXXX"
                    className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs text-text-muted">Texto de encabezado</label>
                <input
                  type="text"
                  value={form.header_text}
                  onChange={(e) => setField("header_text", e.target.value)}
                  placeholder="Ej: FACTURA DE VENTA"
                  className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs text-text-muted">Texto al pie (legal)</label>
                <input
                  type="text"
                  value={form.footer_text}
                  onChange={(e) => setField("footer_text", e.target.value)}
                  placeholder="Gracias por su compra"
                  className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs text-text-muted">URL del logo</label>
                <input
                  type="text"
                  value={form.logo_url}
                  onChange={(e) => setField("logo_url", e.target.value)}
                  placeholder="https://..."
                  className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
                />
              </div>

              {/* Toggles */}
              <div className="rounded-md border border-border-primary bg-surface-secondary p-3">
                <p className="mb-2 text-xs font-medium text-text-muted">Elementos visibles</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {[
                    { key: "show_tax_breakdown", label: "Desglose IVA" },
                    { key: "show_payment_method", label: "Método de pago" },
                    { key: "show_cashier", label: "Cajero" },
                    { key: "show_date_time", label: "Fecha y hora" },
                    { key: "show_client", label: "Cliente" },
                  ].map((opt) => (
                    <label key={opt.key} className="flex items-center gap-2 text-sm text-text-primary">
                      <input
                        type="checkbox"
                        checked={form[opt.key as keyof typeof form] as boolean}
                        onChange={(e) => setField(opt.key, e.target.checked)}
                        className="rounded"
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm text-text-primary">
                <input
                  type="checkbox"
                  checked={form.is_default}
                  onChange={(e) => setField("is_default", e.target.checked)}
                  className="rounded"
                />
                Plantilla por defecto
              </label>

              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    if (!form.name) return;
                    saveMutation.mutate(form);
                  }}
                  disabled={saveMutation.isPending || !form.name}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {saveMutation.isPending
                    ? "Guardando..."
                    : editId
                      ? "Actualizar"
                      : "Crear plantilla"}
                </button>
                {saveMutation.isError && (
                  <p className="text-sm text-red-600">Error al guardar</p>
                )}
              </div>
            </div>
          </div>

          {/* Preview */}
          <div className="rounded-lg border border-border-primary bg-surface-primary p-4">
            <h2 className="mb-3 text-sm font-semibold text-text-primary">
              Vista previa
            </h2>
            <div className="rounded-md bg-gray-100 p-4 dark:bg-gray-900">
              <TicketPreview tpl={form} />
            </div>
          </div>
        </div>
      )}

      {/* Templates list */}
      {isLoading ? (
        <p className="text-sm text-text-muted">Cargando...</p>
      ) : !templates?.length ? (
        <div className="rounded-lg border border-border-primary bg-surface-primary p-6 text-center">
          <p className="text-sm text-text-muted">
            No hay plantillas configuradas. Crea una para imprimir tickets de venta.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => (
            <div
              key={t.id}
              className="rounded-lg border border-border-primary bg-surface-primary p-4"
            >
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <p className="font-medium text-text-primary">{t.name}</p>
                  {t.is_default && (
                    <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">
                      Por defecto
                    </span>
                  )}
                </div>
                <button
                  onClick={() => startEdit(t)}
                  className="rounded-md border border-border-primary px-3 py-1.5 text-sm text-text-primary hover:bg-surface-secondary"
                >
                  Editar
                </button>
              </div>
              <div className="text-xs text-text-muted">
                {t.business_name && <p>{t.business_name}</p>}
                <p>Papel: {t.paper_size}</p>
                <p>
                  {[
                    t.show_tax_breakdown && "IVA",
                    t.show_payment_method && "Pago",
                    t.show_cashier && "Cajero",
                    t.show_client && "Cliente",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>

              <div className="mt-3 rounded-md bg-gray-100 p-2 dark:bg-gray-900">
                <TicketPreview
                  tpl={{
                    name: t.name,
                    business_name: t.business_name ?? "",
                    tax_id: t.tax_id ?? "",
                    address: t.address ?? "",
                    phone: t.phone ?? "",
                    logo_url: t.logo_url ?? "",
                    header_text: t.header_text ?? "",
                    footer_text: t.footer_text ?? "",
                    show_tax_breakdown: t.show_tax_breakdown,
                    show_payment_method: t.show_payment_method,
                    show_cashier: t.show_cashier,
                    show_date_time: t.show_date_time,
                    show_client: t.show_client,
                    paper_size: t.paper_size,
                    is_default: t.is_default,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
