import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { gravarPedido } from "./gravar-pedido";

/** Dublê do admin: só o que gravarPedido toca. */
function adminFalso(opts: { anonimizado?: boolean; rpcErro?: string } = {}) {
  const rpc = vi.fn().mockResolvedValue(
    opts.rpcErro ? { data: null, error: { message: opts.rpcErro } } : { data: "order-1", error: null },
  );
  const maybeSingle = vi.fn().mockResolvedValue({
    data: opts.anonimizado === undefined ? null : { is_anonymized: opts.anonimizado },
    error: null,
  });
  const cadeia = { select: () => cadeia, eq: () => cadeia, maybeSingle };
  const admin = { rpc, from: vi.fn(() => cadeia) } as unknown as SupabaseClient;
  return { admin, rpc };
}

const bruto = {
  id: 555, total: "10.00", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-02T00:00:00Z",
  contact_phone: "+5511999990000", customer: { id: 7 },
};
const ctx = { orgId: "org-1", storeId: "store-1" };

describe("gravarPedido", () => {
  it("grava com o contato resolvido e devolve o id", async () => {
    const { admin, rpc } = adminFalso();
    const resolver = vi.fn().mockResolvedValue("contato-1");
    await expect(gravarPedido(admin, ctx, bruto, resolver)).resolves.toEqual({ ok: true, orderId: "order-1" });
    expect(resolver).toHaveBeenCalledWith(admin, { orgId: "org-1", storeId: "store-1", customerId: "7" }, expect.objectContaining({ telefone: "+5511999990000" }));
    expect(rpc).toHaveBeenCalledWith("fn_gravar_pedido_externo", {
      p_organization_id: "org-1",
      p_pedido: expect.objectContaining({ external_id: "555", contact_id: "contato-1", total_cents: 1000 }),
    });
  });

  it("pedido já anonimizado: não resolve contato nem grava (LGPD)", async () => {
    const { admin, rpc } = adminFalso({ anonimizado: true });
    const resolver = vi.fn();
    await expect(gravarPedido(admin, ctx, bruto, resolver)).resolves.toEqual({ ok: true, orderId: null, ignorado: "anonimizado" });
    expect(resolver).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("formato inesperado → ok:false pedido_invalido", async () => {
    const { admin } = adminFalso();
    await expect(gravarPedido(admin, ctx, { id: 1 }, vi.fn())).resolves.toEqual({ ok: false, motivo: "pedido_invalido:1" });
  });

  it("tradução impossível → ok:false com o motivo", async () => {
    const { admin } = adminFalso();
    await expect(gravarPedido(admin, ctx, { ...bruto, total: "abc" }, vi.fn().mockResolvedValue(null)))
      .resolves.toEqual({ ok: false, motivo: "total_invalido:555" });
  });

  it("falha da RPC lança (infra, não dado)", async () => {
    const { admin } = adminFalso({ rpcErro: "boom" });
    await expect(gravarPedido(admin, ctx, bruto, vi.fn().mockResolvedValue(null))).rejects.toThrow(/fn_gravar_pedido_externo/);
  });
});
