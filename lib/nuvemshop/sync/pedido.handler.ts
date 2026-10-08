/**
 * `nuvemshop-pedido.v1` — webhook `order/*` → `GET /orders/{id}` → `orders`.
 * O webhook só traz o id; o pedido inteiro vem da API, e o upsert "mais novo
 * vence" torna seguro rodar em paralelo com o backfill (spec §4.3). Não respeita
 * a trava do run de propósito.
 */
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { NuvemshopApiError } from "@/lib/nuvemshop/api-client";
import { depsReais, type DepsDoSync } from "./deps";
import { tratarErroDaApi } from "./erro-da-api";

const KEY = "nuvemshop-pedido.v1";
const r = (status: HandlerResult["status"], detail: string): HandlerResult => ({ consumer_key: KEY, status, detail });

export async function processarPedidoDoWebhook(row: EventRow, deps: DepsDoSync): Promise<HandlerResult> {
  const id = row.payload.id;
  if (id === undefined || id === null || String(id) === "") return r("skipped", "sem_id");

  const integ = await deps.carregarIntegracao(row.organization_id);
  if (!integ || integ.status !== "healthy") return r("skipped", "integracao_inativa");

  let bruto: unknown;
  try {
    bruto = await deps.api(integ).getOrder(String(id));
  } catch (err) {
    if (err instanceof NuvemshopApiError && err.status === 404) return r("skipped", "pedido_inexistente");
    return tratarErroDaApi(err, integ, deps, KEY);
  }

  const g = await deps.gravarPedido(row.organization_id, integ.storeId, bruto);
  return g.ok ? r("ok", g.ignorado ?? "gravado") : r("skipped", g.motivo);
}

export const nuvemshopPedidoHandler: EventHandler = {
  key: KEY,
  naOrgParada: "pula",
  events: ["nuvemshop.order_created", "nuvemshop.order_updated", "nuvemshop.order_paid", "nuvemshop.order_cancelled"],
  handle: (row) => processarPedidoDoWebhook(row, depsReais()),
};
