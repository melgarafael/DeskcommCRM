/**
 * /admin/tenants/new em dois modos (spec da cobrança §9, D-2).
 *
 * Chave desligada: nada muda. O rótulo `plan` vai para a função e vira
 * `settings.plan`, como sempre. Chave ligada: o dono escolhe um plano de
 * cobrança (a função cria o `trial` na mesma transação) ou nenhum (isenta), e o
 * rótulo antigo deixa de ser gravado, mesmo que o cliente o mande (o hook o
 * preenche com "standard" por default).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bancoFalso, type BancoFalso } from "@/tests/helpers/banco-falso-da-cobranca";

const h = vi.hoisted(() => ({
  ator: "a2180000-0000-4000-8000-000000000001",
  escrita: vi.fn(),
  audit: vi.fn(),
  invite: vi.fn(),
  ligada: false,
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
vi.mock("@/lib/auth/issue-invite", () => ({ issueInvite: h.invite }));

import { POST } from "@/app/api/v1/admin/tenants/route";

const ORG = "a2180000-0000-4000-8000-000000000002";
const PLANO = "a2180000-0000-4000-8000-000000000009";
const pedido = (extra: Record<string, unknown> = {}) =>
  new NextRequest("http://localhost/api/v1/admin/tenants", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "a2180000-0000-4000-8000-000000000003" },
    body: JSON.stringify({ display_name: "Minha organização", slug: "minha-org", owner_email: "owner@example.test", ...extra }),
  });
let planoLido: Record<string, unknown> | null;
const pRequest = () =>
  h.banco.rpcs.find((r) => r.nome === "fn_create_tenant_with_owner")?.args.p_request as Record<string, unknown> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  h.ligada = false;
  planoLido = { id: PLANO, intervalo: "mes", trial_dias: 14, max_assentos: null, max_canais: null, arquivado_em: null };
  h.escrita.mockResolvedValue({ user: { id: h.ator, email: "owner@example.test", user_metadata: {} }, platformAdmin: { scope: "full" } });
  h.banco = bancoFalso(
    (c) => (c.tabela === "cobranca_planos" ? { data: planoLido } : {}),
    () => ({ data: { id: ORG, display_name: "Minha organização", slug: "minha-org", created: true, invite_id: h.ator, issued_at: 1 } }),
  );
});

describe("POST /api/v1/admin/tenants — cobrança desligada", () => {
  it("grava o rótulo como sempre e não lê planos", async () => {
    expect((await POST(pedido({ plan: "pro" }))).status).toBe(201);
    expect(pRequest()?.plan).toBe("pro");
    expect(pRequest()?.plano_id).toBeUndefined();
    expect(h.banco.cadeias.some((c) => c.tabela === "cobranca_planos")).toBe(false);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ plan: "pro", plano_id: null }) }));
  });
  it("plano_id com a cobrança desligada → 422 plano_invalido, nada criado", async () => {
    const res = await POST(pedido({ plano_id: PLANO }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("plano_invalido");
    expect(h.banco.rpcs).toEqual([]);
  });
});

describe("POST /api/v1/admin/tenants — cobrança ligada", () => {
  beforeEach(() => {
    h.ligada = true;
  });
  it("com plano: plano_id vai para a função, o rótulo antigo não", async () => {
    expect((await POST(pedido({ plan: "standard", plano_id: PLANO }))).status).toBe(201);
    expect(pRequest()?.plano_id).toBe(PLANO);
    expect(pRequest()?.plan).toBeUndefined();
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ plan: null, plano_id: PLANO }) }));
  });
  it("sem plano: isenta — nem rótulo nem plano", async () => {
    expect((await POST(pedido({ plan: "standard" }))).status).toBe(201);
    expect(pRequest()?.plan).toBeUndefined();
    expect(pRequest()?.plano_id).toBeUndefined();
  });
  it("plano arquivado ou inexistente → 422 plano_invalido", async () => {
    planoLido = { ...planoLido, arquivado_em: "2026-09-01T00:00:00Z" };
    expect((await POST(pedido({ plano_id: PLANO }))).status).toBe(422);
    planoLido = null;
    expect((await POST(pedido({ plano_id: PLANO }))).status).toBe(422);
    expect(h.banco.rpcs).toEqual([]);
  });
  it("plano_id que não é uuid → 400", async () => {
    expect((await POST(pedido({ plano_id: "basico" }))).status).toBe(400);
    expect(h.banco.rpcs).toEqual([]);
  });
  it("⭐ corrida: a função recusa o plano (arquivado ou chave desligada depois da leitura) → 422 plano_invalido, não 'slug já existe'", async () => {
    h.banco = bancoFalso(
      (c) => (c.tabela === "cobranca_planos" ? { data: planoLido } : {}),
      () => ({ error: { code: "22023", message: "plano_invalido" } }),
    );
    const res = await POST(pedido({ plano_id: PLANO }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("plano_invalido");
  });
});
