/**
 * EDITAR E APAGAR MODELO APROVADO PELA TELA.
 *
 * O adapter do canal intermediado sabia editar e apagar desde que entrou; a tela
 * só listava e criava, e quem opera ia à plataforma do provedor para trocar uma
 * vírgula ou tirar um modelo com o preço velho (pedido de uma instalação real,
 * 25/09/2026, depois de um reajuste de preço que exigiu modelos novos).
 *
 * O que este arquivo prende:
 * - ida e volta: o formulário preenchido a partir do modelo aprovado remonta os
 *   MESMOS componentes — editar não perde botão, link, telefone nem exemplo;
 * - apagar pergunta antes quando o modelo está em uso (follow-up ou prompt do
 *   agente), e só apaga com a confirmação;
 * - a rota: editar chama `update` e audita `template.updated`; apagar chama
 *   `remove`, tira do espelho e audita `template.deleted`; em uso responde 409
 *   com a lista.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as Canais from "@/lib/channels";
import { executarGestao, usosDoModelo } from "@/lib/channels/gestao-de-modelos";
import { lerConteudo, montarComponents, paraFormulario } from "@/lib/channels/template-conteudo";

// ── Banco de mentira: responde por tabela, registra deletes ────────────────────
function bancoFalso(tabelas: Record<string, unknown[]>) {
  const deletes: string[] = [];
  const cliente = {
    from(tabela: string) {
      let apagando = false;
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        in: () => q,
        not: () => q,
        neq: () => q,
        order: () => q,
        delete: () => {
          apagando = true;
          deletes.push(tabela);
          return q;
        },
        upsert: async () => ({ error: null }),
        maybeSingle: async () => ({ data: (tabelas[tabela] ?? [])[0] ?? null, error: null }),
        then: (ok: (r: unknown) => unknown) => ok({ data: apagando ? null : (tabelas[tabela] ?? []), error: null }),
      };
      return q;
    },
  };
  return { cliente: cliente as never, deletes };
}

describe("ida e volta do conteúdo", () => {
  it("⭐ o formulário preenchido a partir do modelo remonta os mesmos componentes", () => {
    const original = montarComponents({
      body: "Hola {{1}}, sale ₲150.000. ¿Te lo reservamos?",
      footer: "Loja Exemplo",
      exemplos: ["María"],
      cabecalho: { texto: "Oferta", midiaUrl: "" },
      botoes: [
        { tipo: "quick_reply", texto: "Sí, lo quiero" },
        { tipo: "url", texto: "Ver", url: "https://loja.example/produto" },
        { tipo: "phone_number", texto: "Llamar", telefone: "+5511900000000" },
      ],
    });
    const f = paraFormulario(lerConteudo(original));
    const remontado = montarComponents({
      body: f.corpo,
      footer: f.rodape,
      exemplos: f.exemplos,
      cabecalho: { texto: f.cabecalho, midiaUrl: f.midiaUrl },
      botoes: f.botoes,
    });
    expect(remontado).toEqual(original);
  });
});

describe("onde o modelo está em uso", () => {
  it("acha o follow-up que aponta o id e o agente que cita o nome no prompt", async () => {
    const { cliente } = bancoFalso({
      followup_flow_pointers: [
        { name: "Remarketing", active_version_id: "v1", draft_graph: null },
        { name: "Outro", active_version_id: "v2", draft_graph: null },
      ],
      followup_flow_versions: [
        { id: "v1", graph: { nodes: [{ config: { mode: "template", template_id: "tpl-1" } }] } },
        { id: "v2", graph: { nodes: [] } },
      ],
      ai_agents: [{ name: "Vendedor", published_version_id: "a1" }],
      ai_agent_versions: [{ id: "a1", system_prompt: "usá recordatorio_oferta si la ventana cerró" }],
    });
    const usos = await usosDoModelo(cliente, "org", { name: "recordatorio_oferta", ids: ["tpl-1"] });
    expect(usos).toEqual([
      { tipo: "fluxo", nome: "Remarketing" },
      { tipo: "agente", nome: "Vendedor" },
    ]);
  });
});

describe("executarGestao", () => {
  const escopo = { orgId: "org", sessionId: "sess", sessionRef: "ACC" };
  const ops = () => ({ list: vi.fn(), create: vi.fn(), update: vi.fn(async () => ({})), remove: vi.fn(async () => {}) });

  it("⭐ apagar modelo em uso NÃO apaga sem confirmação — devolve onde", async () => {
    const { cliente, deletes } = bancoFalso({
      meta_templates: [{ id: "tpl-1" }],
      followup_flow_pointers: [{ name: "Remarketing", active_version_id: null, draft_graph: { x: "tpl-1" } }],
      ai_agents: [],
    });
    const o = ops();
    const r = await executarGestao(o as never, cliente, escopo, { acao: "apagar", name: "x", language: "es", confirmado: false });
    expect(r).toEqual({ ok: false, codigo: "em_uso", usos: [{ tipo: "fluxo", nome: "Remarketing" }] });
    expect(o.remove).not.toHaveBeenCalled();
    expect(deletes).toEqual([]);
  });

  it("com a confirmação apaga na plataforma e tira do espelho", async () => {
    const { cliente, deletes } = bancoFalso({ meta_templates: [{ id: "tpl-1" }] });
    const o = ops();
    const r = await executarGestao(o as never, cliente, escopo, { acao: "apagar", name: "x", language: "es", confirmado: true });
    expect(r).toEqual({ ok: true, acao: "apagar" });
    expect(o.remove).toHaveBeenCalledWith({ organizationId: "org", sessionRef: "ACC", name: "x", language: "es" });
    expect(deletes).toEqual(["meta_templates"]);
  });

  it("editar manda só os componentes, com nome e idioma do modelo", async () => {
    const { cliente } = bancoFalso({});
    const o = ops();
    const components = [{ type: "BODY", text: "nuevo" }];
    await executarGestao(o as never, cliente, escopo, { acao: "editar", name: "x", language: "es", components });
    expect(o.update).toHaveBeenCalledWith({ organizationId: "org", sessionRef: "ACC", name: "x", language: "es", patch: { components } });
  });
});

// ── A rota ─────────────────────────────────────────────────────────────────────
const h = vi.hoisted(() => ({
  role: vi.fn(),
  audit: vi.fn(),
  find: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  tabelas: {} as Record<string, unknown[]>,
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/channels/connect", () => ({ findPartnerSession: h.find }));
vi.mock("@/lib/channels", async (original) => ({
  ...(await original<typeof Canais>()),
  getAdapter: () => ({ templates: { create: vi.fn(), list: h.list, update: h.update, remove: h.remove } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const base = bancoFalso(h.tabelas).cliente as unknown as { from: (t: string) => Record<string, unknown> };
    return {
      from: (t: string) => {
        const q = base.from(t);
        if (t === "channel_sessions") {
          q.maybeSingle = async () => ({ data: { id: "sess-1", provider: "zernio", zernio_account_id: "ACC" }, error: null });
        }
        return q;
      },
    };
  },
}));

import { POST } from "@/app/api/v1/channels/partner/templates/route";

const post = (body: unknown) =>
  POST(new NextRequest("https://crm.test/api/v1/channels/partner/templates", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  h.role.mockResolvedValue({ ok: true, org: { orgId: "org" }, user: { id: "u-1", idioma: "pt-BR" } });
  h.find.mockResolvedValue({ id: "sess-1", archivedAt: null });
  h.list.mockResolvedValue([]);
  h.update.mockResolvedValue({});
  h.remove.mockResolvedValue(undefined);
  h.tabelas = { meta_templates: [{ id: "tpl-1" }], ai_agents: [] };
});

describe("rota de modelos — editar e apagar", () => {
  it("editar e apagar pedem admin, como criar", async () => {
    await post({ acao: "editar", name: "x", language: "es", components: [{ type: "BODY", text: "a" }] });
    expect(h.role).toHaveBeenCalledWith("admin", expect.anything());
  });

  it("editar chama a plataforma e audita template.updated", async () => {
    const r = await post({ acao: "editar", name: "x", language: "es", components: [{ type: "BODY", text: "a" }] });
    expect(r.status).toBe(200);
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "template.updated", actorUserId: "u-1" }));
  });

  it("⭐ apagar modelo em uso responde 409 com os usos e não apaga", async () => {
    h.tabelas.followup_flow_pointers = [{ name: "Remarketing", active_version_id: null, draft_graph: { t: "tpl-1" } }];
    const r = await post({ acao: "apagar", name: "x", language: "es" });
    expect(r.status).toBe(409);
    const j = (await r.json()) as { error: { code: string; details: { usos: string[] } } };
    expect(j.error.code).toBe("template_in_use");
    expect(j.error.details.usos).toEqual(["Follow-up «Remarketing»"]);
    expect(h.remove).not.toHaveBeenCalled();
  });

  it("apagar confirmado chama a plataforma e audita template.deleted", async () => {
    const r = await post({ acao: "apagar", name: "x", language: "es", confirmado: true });
    expect(r.status).toBe(200);
    expect(h.remove).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "template.deleted" }));
  });
});
