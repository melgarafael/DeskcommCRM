import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { argumentos, bancoFalso, filtros, operacao, type BancoFalso, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

const h = vi.hoisted(() => ({
  ator: "aaaaaaaa-0000-4000-8000-000000000001",
  escrita: vi.fn(),
  audit: vi.fn(),
  ligada: true,
  banco: undefined as unknown as BancoFalso,
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: async () => false, loadAuthUser: async () => null }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/requirePlatformAdmin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/requirePlatformAdmin")>()),
  requirePlatformAdminEscrita: h.escrita,
}));
vi.mock("@/lib/instalacao/modulos", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/instalacao/modulos")>()),
  moduloLigado: async (_db: unknown, modulo: string) => modulo === "cobranca" && h.ligada,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.cliente }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));

import { EscritaDePlatformAdminNegada } from "@/lib/auth/requirePlatformAdmin";

import { POST } from "./route";

const TENANT = "bbbbbbbb-0000-4000-8000-000000000001";
const DIA = 86_400_000;
const em = (dias: number) => new Date(Date.now() + dias * DIA).toISOString();

let m: { org: Record<string, unknown> | null; linha: boolean; rpc: Resposta };
function responder(c: Cadeia): Resposta {
  if (c.tabela === "organizations") return { data: m.org };
  if (operacao(c) === "update") return { data: m.linha ? { organization_id: TENANT } : null };
  return {};
}
const ctx = (id = TENANT) => ({ params: Promise.resolve({ id }) });
const pedido = (body: unknown) =>
  new NextRequest(`http://localhost/api/v1/admin/tenants/${TENANT}/assinatura/prazo`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  });
const updates = () => h.banco.cadeias.filter((c) => operacao(c) === "update");

beforeEach(() => {
  vi.clearAllMocks();
  h.ligada = true;
  h.escrita.mockResolvedValue({ user: { id: h.ator }, platformAdmin: { user_id: h.ator, scope: "full", mfa_required: false } });
  m = { org: { id: TENANT, status: "active", suspended_kind: null }, linha: true, rpc: { data: { changed: true } } };
  h.banco = bancoFalso(responder, () => m.rpc);
});

describe("POST /admin/tenants/[id]/assinatura/prazo — Dar prazo (D-6)", () => {
  it("grava prazo_extra_ate na linha da org do PATH; org ativa não chama reativação; audita", async () => {
    const ate = em(10);
    const res = await POST(pedido({ ate }), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ prazo_extra_ate: ate, reativada: false });
    const [update] = updates();
    expect(update!.tabela).toBe("cobranca_assinaturas");
    expect(Object.keys(argumentos(update!, "update")?.[0] as object).sort()).toEqual(["prazo_extra_ate", "updated_at"]);
    expect(filtros(update!)).toEqual([["eq", "organization_id", TENANT]]);
    expect(h.banco.rpcs).toEqual([]);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "cobranca.prazo_concedido", organizationId: TENANT, metadata: { ate, reativada: false },
    }));
  });

  it("suspensa por cobrança: reativa na hora pela função", async () => {
    m.org = { id: TENANT, status: "suspended", suspended_kind: "cobranca" };
    expect((await (await POST(pedido({ ate: em(10) }), ctx())).json()).data.reativada).toBe(true);
    expect(h.banco.rpcs).toEqual([{ nome: "fn_reativar_organizacao", args: { p_org: TENANT, p_kind_exigido: "cobranca", p_ator: h.ator } }]);
  });

  it("suspensa administrativa: prazo gravado, suspensão fica", async () => {
    m.org = { id: TENANT, status: "suspended", suspended_kind: "administrativa" };
    expect((await (await POST(pedido({ ate: em(10) }), ctx())).json()).data.reativada).toBe(false);
    expect(h.banco.rpcs).toEqual([]);
  });

  it.each([["mais de 60 dias", em(61)], ["no passado", em(-1)]])("%s → 422, nada gravado", async (_caso, ate) => {
    const res = await POST(pedido({ ate }), ctx());
    expect(res.status).toBe(422);
    expect(updates()).toEqual([]);
  });

  it("data que não é ISO → 400", async () => {
    expect((await POST(pedido({ ate: "05/10/2026" }), ctx())).status).toBe(400);
  });

  it("empresa isenta (sem linha) → 404, sem audit", async () => {
    m.linha = false;
    expect((await POST(pedido({ ate: em(10) }), ctx())).status).toBe(404);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("reativação que falha → 500", async () => {
    m.org = { id: TENANT, status: "suspended", suspended_kind: "cobranca" };
    m.rpc = { data: null, error: { code: "XX000", message: "boom" } };
    expect((await POST(pedido({ ate: em(10) }), ctx())).status).toBe(500);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "cobranca.prazo_concedido",
      metadata: expect.objectContaining({ reativada: false }),
    }));
  });

  it("chave desligada → 404; support_readonly → 403; id inválido → 404", async () => {
    h.ligada = false;
    expect((await POST(pedido({ ate: em(10) }), ctx())).status).toBe(404);
    h.ligada = true;
    h.escrita.mockRejectedValueOnce(new EscritaDePlatformAdminNegada("forbidden_scope", "somente leitura"));
    expect((await POST(pedido({ ate: em(10) }), ctx())).status).toBe(403);
    expect((await POST(pedido({ ate: em(10) }), ctx("x"))).status).toBe(404);
    expect(h.banco.cadeias).toEqual([]);
  });
});
