import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as Canais from "@/lib/channels";

/**
 * A rota de modelos do canal Datafy (recorte do #1130, @vgamkt): desligada por
 * padrão, com papel, corpo validado, organização da sessão e contrato derivado.
 *
 * Inclui o editar/apagar que a #1734 religou: a rota recusava os dois com 422
 * porque o DELETE desta plataforma, por nome só, levava TODAS as variantes de
 * idioma enquanto a tela apagaria uma (#1728). O alvo agora resolve o id da
 * variante por nome+idioma, e a rota passa pela mesma `executarGestao` do outro
 * parceiro — inclusive pela pergunta "onde este modelo está em uso?".
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
  tabelas: {} as Record<string, unknown[]>,
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
        in: () => q,
        not: () => q,
        order: () => q,
        // O apagar tira a linha do espelho depois de falar com a plataforma
        // (lib/channels/gestao-de-modelos.ts) — sem `delete` o mock estourava.
        delete: () => q,
        maybeSingle: async () => ({
          data: { id: "sess-1", provider: "datafy", datafy_phone_number_id: "PN" },
          error: null,
        }),
        upsert: async (linha: Record<string, unknown>) => {
          h.upserts.push(linha);
          return { error: null };
        },
        then: (ok: (r: unknown) => unknown) =>
          ok({
            data: tabela === "meta_templates" ? h.espelho : (h.tabelas[tabela] ?? []),
            error: null,
          }),
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
  h.tabelas = {};
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

  it("⭐ editar e apagar miram a VARIANTE (nome + idioma) e passam pela gestão", async () => {
    // Era 422 e a plataforma não era tocada: o DELETE desta plataforma, por
    // nome só, apagava TODAS as variantes de idioma enquanto a tela apagaria
    // uma (#1728). Desde a #1734 o alvo resolve o id da variante por
    // nome+idioma antes de falar com a plataforma (#1734), e a rota usa a
    // mesma `executarGestao` da rota do outro parceiro.
    h.espelho = [{ id: "tpl-1", name: "boas_vindas", language: "pt_BR" }];
    const alvo = { name: "boas_vindas", language: "pt_BR" };

    const apagado = await post({ acao: "apagar", ...alvo, confirmado: true });
    expect(apagado.status).toBe(200);
    expect(h.remove).toHaveBeenCalledTimes(1);
    expect(h.remove).toHaveBeenCalledWith({
      organizationId: "org-da-sessao",
      sessionRef: "PN",
      name: "boas_vindas",
      language: "pt_BR",
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "template.deleted",
        actorUserId: "u-1",
        organizationId: "org-da-sessao",
        metadata: { name: "boas_vindas", language: "pt_BR" },
      }),
    );

    const editado = await post({ acao: "editar", ...alvo, components: CORPO });
    expect(editado.status).toBe(200);
    expect(h.update).toHaveBeenCalledWith({
      organizationId: "org-da-sessao",
      sessionRef: "PN",
      name: "boas_vindas",
      language: "pt_BR",
      patch: { components: CORPO },
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "template.updated", actorUserId: "u-1" }),
    );
    // A organização é a da SESSÃO: um corpo mandando outra não muda o dono.
    await post({ acao: "apagar", ...alvo, organization_id: "org-do-atacante", confirmado: true });
    expect(h.remove).toHaveBeenLastCalledWith(
      expect.objectContaining({ organizationId: "org-da-sessao" }),
    );
    expect(h.update.mock.calls[0]![0]).toMatchObject({ organizationId: "org-da-sessao" });
    // Sem idioma não há variante que mirar — a chamada é 422 e nada é tocado.
    h.remove.mockClear();
    expect((await post({ acao: "apagar", name: "boas_vindas" })).status).toBe(422);
    expect(h.remove).not.toHaveBeenCalled();
  });

  it("apagar modelo em uso responde 409 com onde ele está, e não apaga", async () => {
    h.espelho = [{ id: "tpl-1", name: "boas_vindas", language: "pt_BR" }];
    h.tabelas.followup_flow_pointers = [
      { name: "Remarketing", active_version_id: null, draft_graph: { t: "tpl-1" } },
    ];
    const r = await post({ acao: "apagar", name: "boas_vindas", language: "pt_BR" });
    expect(r.status).toBe(409);
    const j = (await r.json()) as { error: { code: string; details: { usos: string[] } } };
    expect(j.error.code).toBe("template_in_use");
    expect(j.error.details.usos).toEqual(["Follow-up «Remarketing»"]);
    expect(h.remove).not.toHaveBeenCalled();
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
