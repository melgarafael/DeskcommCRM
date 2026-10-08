import { describe, expect, it, vi } from "vitest";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { NuvemshopApiError } from "@/lib/nuvemshop/api-client";
import type { DepsDoSync } from "./deps";
import { processarPedidoDoWebhook } from "./pedido.handler";

const INTEG = { id: "integ-1", organizationId: "org-1", status: "healthy", storeId: "s1", accessToken: "t" };
const row = (payload: Record<string, unknown>): EventRow => ({
  id: "ev", organization_id: "org-1", event_type: "nuvemshop.order_paid", entity_kind: "nuvemshop_webhook",
  entity_id: null, payload, metadata: {}, consumed_by: [], attempts: 0,
});
function deps(getOrder: ReturnType<typeof vi.fn>, over: Partial<DepsDoSync> = {}): DepsDoSync {
  return {
    lerEstado: vi.fn(), carregarIntegracao: vi.fn().mockResolvedValue(INTEG),
    api: vi.fn(() => ({ listOrders: vi.fn(), getOrder })) as unknown as DepsDoSync["api"],
    gravarPedido: vi.fn().mockResolvedValue({ ok: true, orderId: "o" }),
    reservarRun: vi.fn(), registrarPagina: vi.fn(), fecharRun: vi.fn(), liberarRun: vi.fn(), emitirPasso: vi.fn(),
    desautorizar: vi.fn(), auditar: vi.fn(), novoRunId: () => "r", agora: () => new Date("2026-10-08T12:00:00Z"),
    ...over,
  };
}

describe("nuvemshop-pedido.v1", () => {
  it("busca o pedido e grava", async () => {
    const d = deps(vi.fn().mockResolvedValue({ id: 9 }));
    expect((await processarPedidoDoWebhook(row({ store_id: "s1", id: 9 }), d)).status).toBe("ok");
    expect(d.gravarPedido).toHaveBeenCalledWith("org-1", "s1", { id: 9 });
  });
  it("sem id → skipped", async () => {
    expect((await processarPedidoDoWebhook(row({ store_id: "s1" }), deps(vi.fn()))).status).toBe("skipped");
  });
  it("404 → skipped pedido_inexistente", async () => {
    const d = deps(vi.fn().mockRejectedValue(new NuvemshopApiError(404, "not_found", "")));
    expect(await processarPedidoDoWebhook(row({ id: 9 }), d)).toMatchObject({ status: "skipped", detail: "pedido_inexistente" });
  });
  it("integração inativa → skipped sem chamar a API", async () => {
    const getOrder = vi.fn();
    const d = deps(getOrder, { carregarIntegracao: vi.fn().mockResolvedValue({ ...INTEG, status: "disconnected" }) });
    expect((await processarPedidoDoWebhook(row({ id: 9 }), d)).status).toBe("skipped");
    expect(getOrder).not.toHaveBeenCalled();
  });
  it("pedido com dado ruim → skipped com o motivo (não é falha de infra)", async () => {
    const d = deps(vi.fn().mockResolvedValue({ id: 9 }), { gravarPedido: vi.fn().mockResolvedValue({ ok: false, motivo: "total_invalido:9" }) });
    expect(await processarPedidoDoWebhook(row({ id: 9 }), d)).toMatchObject({ status: "skipped", detail: "total_invalido:9" });
  });
});
