import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as Canais from "@/lib/channels";

/**
 * A rota de modelos do canal intermediado pedia só login: qualquer membro,
 * inclusive `viewer`, criava modelo na conta da empresa, e o gate de MFA (que
 * mora em `requireRole`) não era consultado. Mesmo endurecimento da rota do
 * Datafy (#1492): ler pede `agent`, sincronizar/criar pede `admin`, corpo
 * validado, organização da sessão e audit com o autor.
 */
const h = vi.hoisted(() => ({
  role: vi.fn(),
  audit: vi.fn(),
  find: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  upserts: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/channels/connect", () => ({ findPartnerSession: h.find }));
vi.mock("@/lib/channels", async (original) => ({
  ...(await original<typeof Canais>()),
  getAdapter: () => ({ templates: { create: h.create, list: h.list } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        maybeSingle: async () => ({
          data: { id: "sess-1", provider: "zernio", zernio_account_id: "ACC" },
          error: null,
        }),
        upsert: async (linha: Record<string, unknown>) => {
          h.upserts.push(linha);
          return { error: null };
        },
        then: (ok: (r: unknown) => unknown) => ok({ data: [], error: null }),
      };
      return q;
    },
  }),
}));

import { GET, POST } from "@/app/api/v1/channels/partner/templates/route";

const URL_ = "https://crm.test/api/v1/channels/partner/templates";
const post = (body: unknown) =>
  POST(new NextRequest(URL_, { method: "POST", body: JSON.stringify(body) }));

const CORPO = [{ type: "BODY", text: "Olá {{1}}", example: { body_text: [["Ana"]] } }];
const PERMITIDO = { ok: true, org: { orgId: "org-da-sessao" }, user: { id: "u-1", idioma: "pt-BR" } };
const RECUSADO = () => ({ ok: false, response: new Response(null, { status: 403 }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.upserts = [];
  h.role.mockResolvedValue(PERMITIDO);
  h.find.mockResolvedValue({ id: "sess-1", archivedAt: null });
  h.list.mockResolvedValue([
    { name: "boas_vindas", language: "pt_BR", status: "APPROVED", category: "UTILITY", components: CORPO },
  ]);
  h.create.mockResolvedValue({});
});

describe("rota de modelos do canal intermediado", () => {
  it("ler pede agent; sincronizar e criar pedem admin", async () => {
    expect((await GET()).status).toBe(200);
    expect((await post({ acao: "sincronizar" })).status).toBe(200);
    expect(h.role.mock.calls.map((c) => c[0])).toEqual(["agent", "admin"]);
  });

  it("papel recusado (viewer no POST) devolve 403 antes de olhar conexão ou corpo", async () => {
    h.role.mockResolvedValue(RECUSADO());
    // Corpo inválido de propósito: o 403 vem antes do 422 e do 404.
    h.find.mockResolvedValue(null);
    expect((await post({ acao: "apagar" })).status).toBe(403);
    expect((await GET()).status).toBe(403);
    expect(h.find).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
  });

  it("corpo inválido é 422 e não toca a plataforma", async () => {
    for (const corpo of [
      null,
      {},
      { acao: "apagar" },
      { acao: "criar", name: "x", language: "pt_BR" },
      { acao: "criar", name: "x", language: "pt_BR", category: "OUTRA", components: CORPO },
    ]) {
      expect((await post(corpo)).status, JSON.stringify(corpo)).toBe(422);
    }
    expect(h.create).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
  });

  it("criar usa a organização da SESSÃO (não do corpo) e audita com o autor", async () => {
    const r = await post({
      acao: "criar",
      organization_id: "org-do-corpo",
      name: "boas_vindas",
      language: "pt_BR",
      components: CORPO,
    });
    expect(r.status).toBe(200);
    expect(h.create).toHaveBeenCalledWith({
      organizationId: "org-da-sessao",
      sessionRef: "ACC",
      draft: { name: "boas_vindas", language: "pt_BR", category: "UTILITY", components: CORPO },
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "template.created", actorUserId: "u-1", organizationId: "org-da-sessao" }),
    );
    expect(h.upserts[0]).toMatchObject({ organization_id: "org-da-sessao", channel_session_id: "sess-1" });
  });
});
