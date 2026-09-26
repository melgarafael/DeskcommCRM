import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as Canais from "@/lib/channels";

/**
 * A rota de modelos do canal Datafy (recorte do #1130, @vgamkt): desligada por
 * padrão, com papel, corpo validado, organização da sessão e contrato derivado.
 */
const h = vi.hoisted(() => ({
  role: vi.fn(),
  audit: vi.fn(),
  find: vi.fn(),
  ligado: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  upserts: [] as Record<string, unknown>[],
  espelho: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/channels/graph-parceiro/credentials", () => ({ canalGraphParceiroLigado: h.ligado }));
vi.mock("@/lib/channels/graph-parceiro/session", () => ({ findGraphPartnerSession: h.find }));
vi.mock("@/lib/channels", async (original) => ({
  ...(await original<typeof Canais>()),
  getAdapter: () => ({ templates: { create: h.create, list: h.list, update: h.update, remove: h.remove } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        maybeSingle: async () => ({
          data: { id: "sess-1", provider: "datafy", datafy_phone_number_id: "PN" },
          error: null,
        }),
        upsert: async (linha: Record<string, unknown>) => {
          h.upserts.push(linha);
          return { error: null };
        },
        then: (ok: (r: unknown) => unknown) =>
          ok({ data: tabela === "meta_templates" ? h.espelho : null, error: null }),
      };
      return q;
    },
  }),
}));

import { GET, POST } from "@/app/api/v1/channels/graph-partner/templates/route";

const URL_ = "https://crm.test/api/v1/channels/graph-partner/templates";
const post = (body: unknown) =>
  POST(new NextRequest(URL_, { method: "POST", body: JSON.stringify(body) }));

const CORPO = [{ type: "BODY", text: "Olá {{1}}", example: { body_text: [["Ana"]] } }];

beforeEach(() => {
  vi.clearAllMocks();
  h.upserts = [];
  h.espelho = [];
  h.ligado.mockReturnValue(true);
  h.role.mockResolvedValue({ ok: true, org: { orgId: "org-da-sessao" }, user: { id: "u-1", idioma: "pt-BR" } });
  h.find.mockResolvedValue({ id: "sess-1", archivedAt: null });
  h.list.mockResolvedValue([
    { name: "boas_vindas", language: "pt_BR", status: "APPROVED", category: "UTILITY", components: CORPO },
  ]);
  h.create.mockResolvedValue({});
});

describe("rota de modelos do canal parceiro Graph", () => {
  it("desligado na instalação: 404 e nem pergunta o papel", async () => {
    h.ligado.mockReturnValue(false);
    expect((await GET()).status).toBe(404);
    expect((await post({ acao: "sincronizar" })).status).toBe(404);
    expect(h.role).not.toHaveBeenCalled();
    expect(h.find).not.toHaveBeenCalled();
  });

  it("ler pede agent; sincronizar e criar pedem admin", async () => {
    await GET();
    await post({ acao: "sincronizar" });
    expect(h.role.mock.calls.map((c) => c[0])).toEqual(["agent", "admin"]);
  });

  it("papel recusado devolve a resposta do guarda e não toca a plataforma", async () => {
    h.role.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await post({ acao: "sincronizar" })).status).toBe(403);
    expect(h.list).not.toHaveBeenCalled();
  });

  it("corpo inválido é 422 e não cria nada", async () => {
    for (const corpo of [null, {}, { acao: "apagar" }, { acao: "criar", name: "x", language: "pt_BR" }, { acao: "criar", name: "x", language: "pt_BR", category: "OUTRA", components: CORPO }]) {
      expect((await post(corpo)).status, JSON.stringify(corpo)).toBe(422);
    }
    expect(h.create).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
  });

  it("⭐ editar e apagar não existem nesta rota: 422 e a plataforma não é tocada", async () => {
    // O DELETE desta plataforma é por nome e leva TODAS as variantes de idioma,
    // enquanto a tela apagaria uma só (#1728). Até existir o apagar por variante,
    // a rota recusa — e o adapter tem update/remove para a recusa ser da ROTA.
    const alvo = { name: "boas_vindas", language: "pt_BR" };
    expect((await post({ acao: "apagar", ...alvo, confirmado: true })).status).toBe(422);
    expect((await post({ acao: "editar", ...alvo, components: CORPO })).status).toBe(422);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("criar usa a organização da SESSÃO (não do corpo), audita com o autor e sincroniza com hash real", async () => {
    const r = await post({
      acao: "criar",
      organization_id: "org-do-atacante",
      name: "boas_vindas",
      language: "pt_BR",
      components: CORPO,
    });
    expect(r.status).toBe(200);
    expect(h.create).toHaveBeenCalledWith({
      organizationId: "org-da-sessao",
      sessionRef: "PN",
      draft: { name: "boas_vindas", language: "pt_BR", category: "UTILITY", components: CORPO },
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "template.created", actorUserId: "u-1", organizationId: "org-da-sessao" }),
    );
    expect(h.upserts).toHaveLength(1);
    expect(h.upserts[0]).toMatchObject({ organization_id: "org-da-sessao", channel_session_id: "sess-1", waba_id: "PN" });
    expect(h.upserts[0]!.contract_hash).toMatch(/^[0-9a-f]{16,}$/);
  });

  it("o GET devolve os slots do contrato, com a chave que o envio confere", async () => {
    h.espelho = [
      { name: "boas_vindas", language: "pt_BR", status: "APPROVED", category: "UTILITY", components: CORPO, parameter_format: "POSITIONAL", synced_at: "2026-09-23T00:00:00Z" },
    ];
    const r = await GET();
    const json = (await r.json()) as { data: { templates: { slots: { key: string; valueKey: string }[] }[] } };
    expect(json.data.templates[0]!.slots).toEqual([expect.objectContaining({ key: "1", valueKey: "1" })]);
  });
});
