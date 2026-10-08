/**
 * Pedido da Nuvemshop → linha de `public.orders`. Puro.
 *
 * Valor desconhecido nunca chega ao CHECK de `orders`: cai no default da linha
 * (`pending` / `null`) e o bruto fica em `payload.origem` (spec §5.2).
 * O payload é PROJEÇÃO (spec §5.4): sem endereço, documento, e-mail ou nota.
 */
import { PROVEDOR } from "./constantes";
import type { PedidoNuvemshop } from "./pedido-nuvemshop";

export type StatusDoPedido = "pending" | "paid" | "cancelled" | "shipped" | "delivered" | "refunded";
export type StatusDeEnvio = "unpacked" | "packed" | "shipped" | "delivered";

export interface LinhaDePedido {
  external_provider: typeof PROVEDOR;
  external_id: string;
  customer_external_id: string | null;
  status: StatusDoPedido;
  fulfillment_status: StatusDeEnvio | null;
  total_cents: number;
  currency: string;
  payment_method: string | null;
  tracking_code: string | null;
  ordered_at: string;
  updated_at_remote: string;
  payload: Record<string, unknown>;
}

export class ErroDeTraducao extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = "ErroDeTraducao";
  }
}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** "150.90" → 15090. Por string, nunca `parseFloat * 100`. Meio centavo arredonda para cima. */
export function centavosDe(valor: string | number): number | null {
  const texto = typeof valor === "number" ? (Number.isFinite(valor) ? valor.toFixed(3) : "") : valor.trim();
  const m = DECIMAL.exec(texto);
  if (!m) return null;
  const inteiro = Number(m[1]);
  const fracao = (m[2] ?? "").padEnd(3, "0");
  const centavos = Number(fracao.slice(0, 2));
  const arredonda = Number(fracao[2]) >= 5 ? 1 : 0;
  const total = inteiro * 100 + centavos + arredonda;
  return Number.isSafeInteger(total) ? total : null;
}

function statusDe(p: PedidoNuvemshop): StatusDoPedido {
  if (p.status === "cancelled" || p.payment_status === "voided") return "cancelled";
  if (p.payment_status === "refunded") return "refunded";
  if (p.shipping_status === "delivered") return "delivered";
  if (p.shipping_status === "shipped") return "shipped";
  if (p.payment_status === "paid" || p.payment_status === "partially_refunded") return "paid";
  return "pending";
}

const ENVIO: ReadonlyMap<string, StatusDeEnvio> = new Map([
  ["unpacked", "unpacked"],
  ["partially_packed", "packed"],
  ["partially_fulfilled", "packed"],
  ["unshipped", "packed"],
  ["shipped", "shipped"],
  ["delivered", "delivered"],
]);

function envioDe(shipping: string | null | undefined): StatusDeEnvio | null {
  return (shipping && ENVIO.get(shipping)) || null;
}

function isoDe(texto: string, campo: string): string {
  const ms = Date.parse(texto);
  if (!Number.isFinite(ms)) throw new ErroDeTraducao(`data_invalida:${campo}`);
  return new Date(ms).toISOString();
}

function textoOuNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function projecao(p: PedidoNuvemshop): Record<string, unknown> {
  const base: Record<string, unknown> = {
    number: p.number ?? null,
    status: p.status ?? null,
    payment_status: p.payment_status ?? null,
    shipping_status: p.shipping_status ?? null,
    gateway: p.gateway ?? null,
    subtotal: p.subtotal ?? null,
    discount: p.discount ?? null,
    shipping_cost_customer: p.shipping_cost_customer ?? null,
    shipping_option: p.shipping_option ?? null,
    landing_url: p.landing_url ?? null,
    products: (p.products ?? []).map((i) => ({
      product_id: i.product_id ?? null,
      variant_id: i.variant_id ?? null,
      name: i.name ?? null,
      quantity: i.quantity ?? null,
      price: i.price ?? null,
    })),
    origem: {
      status: p.status ?? null,
      payment_status: p.payment_status ?? null,
      shipping_status: p.shipping_status ?? null,
    },
  };
  if (p.channels !== undefined) base.channels = p.channels;
  if (p.utm !== undefined) base.utm = p.utm;
  return base;
}

export function traduzirPedido(p: PedidoNuvemshop): LinhaDePedido {
  const total = centavosDe(p.total);
  if (total === null) throw new ErroDeTraducao("total_invalido");
  return {
    external_provider: PROVEDOR,
    external_id: String(p.id),
    customer_external_id: textoOuNull(p.customer?.id),
    status: statusDe(p),
    fulfillment_status: envioDe(p.shipping_status),
    total_cents: total,
    currency: (textoOuNull(p.currency) ?? "BRL").toUpperCase().slice(0, 3),
    payment_method: textoOuNull(p.gateway),
    tracking_code: textoOuNull(p.shipping_tracking_number),
    ordered_at: isoDe(p.created_at, "created_at"),
    updated_at_remote: isoDe(p.updated_at, "updated_at"),
    payload: projecao(p),
  };
}
