/**
 * `autorizarModulo` — autoridade = declarado ∩ consentido ∩ porta (Spec 33, F3, tarefa 3).
 *
 * Banco falso por tabela, com o registro dos filtros: o que esta suíte prova é que (1) a
 * autoridade é a interseção, nunca um dos lados, (2) porta sem área e área não consentida
 * recusam, (3) escrita sem permissão de escrita recusa, (4) nada fica em cache entre
 * chamadas, (5) toda leitura filtra a organização, e (6) a dúvida recusa.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { autorizarModulo, modeloDoCaminho } from "./modulo-autorizado";

const ORG = "bbbbbbbb-2222-4222-8222-222222222222";
const TOKEN = "aaaaaaaa-1111-4111-8111-111111111111";
const INST = "cccccccc-3333-4333-8333-333333333333";
const ID = "dddddddd-4444-4444-8444-444444444444";

interface Banco {
  token: Record<string, unknown> | null;
  instalacao: Record<string, unknown> | null;
  vinculo: Record<string, unknown> | null;
  erro?: string;
}

function banco(): Banco {
  return {
    token: {
      extension_installation_id: INST,
      module_slug: "acme/comanda",
      revoked_at: null,
    },
    instalacao: {
      publisher: "acme",
      name: "comanda",
      disabled_at: null,
      removed_at: null,
      extension_artifacts: {
        manifest: {
          profile: "connected",
          permissions: ["area.contatos.leitura", "area.contatos.escrita", "area.negocios.leitura"],
        },
      },
    },
    vinculo: { enabled: true, consented_areas: ["area.contatos.leitura", "area.contatos.escrita"] },
  };
}

interface Falso {
  cliente: SupabaseClient;
  filtros: Record<string, Array<[string, unknown]>>;
}

function falso(b: Banco): Falso {
  const filtros: Record<string, Array<[string, unknown]>> = {};
  const linha: Record<string, Record<string, unknown> | null> = {
    api_tokens: b.token,
    extension_installations: b.instalacao,
    organization_extensions: b.vinculo,
  };
  const cliente = {
    from(tabela: string) {
      if (!(tabela in linha)) throw new Error(`tabela inesperada: ${tabela}`);
      filtros[tabela] = [];
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = (coluna: string, valor: unknown) => {
        filtros[tabela]!.push([coluna, valor]);
        return c;
      };
      c.maybeSingle = async () =>
        b.erro ? { data: null, error: { message: b.erro } } : { data: linha[tabela], error: null };
      return c;
    },
  };
  return { cliente: cliente as unknown as SupabaseClient, filtros };
}

async function decide(b: Banco, metodo: string, caminho: string, extra: object = {}) {
  return autorizarModulo({
    organizationId: ORG,
    tokenId: TOKEN,
    metodo,
    caminho,
    supabase: falso(b).cliente,
    ...extra,
  });
}

describe("autorizarModulo — declarado ∩ consentido", () => {
  it("área declarada e consentida, modo certo: passa", async () => {
    expect(await decide(banco(), "GET", "/api/v1/contacts")).toEqual({ ok: true });
    expect(await decide(banco(), "POST", "/api/v1/contacts")).toEqual({ ok: true });
    expect(await decide(banco(), "PATCH", `/api/v1/contacts/${ID}`)).toEqual({ ok: true });
  });

  it("consentiu só leitura: GET passa, POST e PATCH recusam (escrita sem permissão de escrita)", async () => {
    const b = banco();
    b.vinculo = { enabled: true, consented_areas: ["area.contatos.leitura"] };
    expect(await decide(b, "GET", "/api/v1/contacts")).toEqual({ ok: true });
    for (const metodo of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(await decide(b, metodo, `/api/v1/contacts/${ID}`)).toEqual({
        ok: false,
        codigo: "module_area_not_granted",
      });
    }
  });

  it("consentida mas NÃO declarada pelo pacote: recusa (o consentimento sozinho não basta)", async () => {
    const b = banco();
    b.vinculo = {
      enabled: true,
      consented_areas: ["area.contatos.leitura", "area.funis.leitura", "area.negocios.escrita"],
    };
    expect(await decide(b, "GET", "/api/v1/pipelines")).toEqual({
      ok: false,
      codigo: "module_area_not_granted",
    });
    expect(await decide(b, "POST", "/api/v1/leads")).toEqual({
      ok: false,
      codigo: "module_area_not_granted",
    });
  });

  it("declarada mas NÃO consentida: recusa (o manifesto sozinho não basta)", async () => {
    // negocios.leitura está declarada; a organização não consentiu.
    expect(await decide(banco(), "GET", "/api/v1/leads")).toEqual({
      ok: false,
      codigo: "module_area_not_granted",
    });
  });

  it("consentimento vazio: tudo recusa", async () => {
    const b = banco();
    b.vinculo = { enabled: true, consented_areas: [] };
    expect(await decide(b, "GET", "/api/v1/contacts")).toEqual({
      ok: false,
      codigo: "module_area_not_granted",
    });
  });

  it("pacote `declarative` (sem perfil connected) nunca tem área", async () => {
    const b = banco();
    (b.instalacao!.extension_artifacts as { manifest: { profile: string } }).manifest.profile =
      "declarative";
    expect(await decide(b, "GET", "/api/v1/contacts")).toEqual({
      ok: false,
      codigo: "module_area_not_granted",
    });
  });

  it("consented_areas que não é lista: recusa", async () => {
    const b = banco();
    b.vinculo = { enabled: true, consented_areas: null };
    expect(await decide(b, "GET", "/api/v1/contacts")).toEqual({
      ok: false,
      codigo: "module_area_not_granted",
    });
  });
});

describe("autorizarModulo — porta", () => {
  const TUDO = [
    "contatos",
    "negocios",
    "conversas",
    "agenda",
    "funis",
    "agentes_ia",
    "catalogo",
    "configuracao",
    "analise",
  ].flatMap((a) => [`area.${a}.leitura`, `area.${a}.escrita`]);

  function bancoComTudo(): Banco {
    const b = banco();
    (b.instalacao!.extension_artifacts as { manifest: { permissions: string[] } }).manifest.permissions =
      TUDO;
    b.vinculo = { enabled: true, consented_areas: TUDO };
    return b;
  }

  it.each([
    ["POST", "/api/v1/messages"], // envio ao cliente: quem envia é a pessoa
    ["GET", "/api/v1/settings/api-tokens"], // credencial
    ["DELETE", `/api/v1/contacts/${ID}`], // LGPD
    ["POST", "/api/v1/channels"],
    ["POST", "/api/v1/campaigns"],
    ["GET", "/api/v1/modulos"],
    ["GET", "/api/v1/algo-que-nao-existe"], // desconhecida
    ["POST", "/api/v1/financeiro/lancamentos"], // financeiro de escrita
  ])("porta sem área recusa mesmo com TODAS as áreas declaradas e consentidas: %s %s", async (metodo, caminho) => {
    expect(await decide(bancoComTudo(), metodo, caminho)).toEqual({
      ok: false,
      codigo: "module_area_not_granted",
    });
  });

  it("porta sem área recusa sem tocar o banco", async () => {
    const f = falso(bancoComTudo());
    const r = await autorizarModulo({
      organizationId: ORG,
      tokenId: TOKEN,
      metodo: "POST",
      caminho: "/api/v1/messages",
      supabase: f.cliente,
    });
    expect(r.ok).toBe(false);
    expect(f.filtros).toEqual({});
  });

  it("sem modelo nem caminho, ou caminho torto: recusa", async () => {
    const b = bancoComTudo();
    expect(await decide(b, "GET", "")).toMatchObject({ ok: false });
    for (const torto of [
      "/api/v1/contacts/../settings",
      "/api/v1/contacts//x",
      "/api/v1/contacts/%2e%2e",
      "/api/v2/contacts",
      "/contacts",
      "/api/v1/a/b/c/d/e/f/g/h/i",
    ]) {
      expect(await decide(b, "GET", torto)).toMatchObject({ ok: false });
    }
  });

  it("método fora do vocabulário recusa", async () => {
    expect(await decide(bancoComTudo(), "TRACE", "/api/v1/contacts")).toMatchObject({ ok: false });
  });

  it("modeloDaPorta informado pela rota tem precedência sobre o caminho", async () => {
    const b = banco();
    expect(
      await decide(b, "GET", "/api/v1/leads", { modeloDaPorta: "/api/v1/contacts" }),
    ).toEqual({ ok: true });
    expect(
      await decide(b, "GET", "/api/v1/contacts", { modeloDaPorta: "/api/v1/messages" }),
    ).toMatchObject({ ok: false });
  });

  it("caminho real vira o modelo certo", () => {
    expect(modeloDoCaminho(`/api/v1/pipelines/${ID}/stages`)).toBe("/api/v1/pipelines/[id]/[id]");
    expect(modeloDoCaminho(`/api/v1/pipelines/${ID}/leads`)).toBe("/api/v1/pipelines/[id]/leads");
    expect(modeloDoCaminho(`/api/v1/messages/${ID}/forward/`)).toBe("/api/v1/messages/[id]/forward");
    expect(modeloDoCaminho("/api/v1/team/assignable")).toBe("/api/v1/team/assignable");
    expect(modeloDoCaminho(`/api/v1/contacts/${ID}`)).toBe("/api/v1/contacts/[id]");
    // palavra que nenhuma lista conhece vira `[id]` (o prefixo `ai` ainda decide a área)
    expect(modeloDoCaminho("/api/v1/ai/skills/vendas")).toBe("/api/v1/ai/[id]/[id]");
    expect(modeloDoCaminho(`/api/v1/ai/followup-flows/${ID}/publish`)).toBe(
      "/api/v1/ai/followup-flows/[id]/publish",
    );
  });

  it("envio e LGPD pelo caminho real recusam com TODAS as áreas consentidas", async () => {
    const b = bancoComTudo();
    expect(await decide(b, "POST", `/api/v1/messages/${ID}/forward`)).toMatchObject({ ok: false });
    expect(await decide(b, "DELETE", `/api/v1/contacts/${ID}`)).toMatchObject({ ok: false });
    expect(await decide(b, "POST", `/api/v1/conversations/${ID}/claim`)).toMatchObject({ ok: false });
  });
});

describe("autorizarModulo — estado do módulo (sempre lido agora)", () => {
  it.each([
    ["vínculo desativado", (b: Banco) => (b.vinculo = { enabled: false, consented_areas: ["area.contatos.leitura"] })],
    ["instalação desligada", (b: Banco) => (b.instalacao!.disabled_at = "2026-11-05T00:00:00Z")],
    ["instalação removida", (b: Banco) => (b.instalacao!.removed_at = "2026-11-05T00:00:00Z")],
    ["token revogado", (b: Banco) => (b.token!.revoked_at = "2026-11-05T00:00:00Z")],
    ["token sem instalação", (b: Banco) => (b.token!.extension_installation_id = null)],
    ["token inexistente", (b: Banco) => (b.token = null)],
    ["instalação inexistente", (b: Banco) => (b.instalacao = null)],
    ["sem vínculo com a organização", (b: Banco) => (b.vinculo = null)],
    ["slug do token diferente da instalação", (b: Banco) => (b.token!.module_slug = "outro/modulo")],
  ])("%s ⇒ module_disabled", async (_nome, muda) => {
    const b = banco();
    muda(b);
    expect(await decide(b, "GET", "/api/v1/contacts")).toEqual({
      ok: false,
      codigo: "module_disabled",
    });
  });

  it("erro de leitura do banco recusa (lado seguro)", async () => {
    const b = banco();
    b.erro = "boom";
    expect(await decide(b, "GET", "/api/v1/contacts")).toEqual({
      ok: false,
      codigo: "module_authorization_unavailable",
    });
  });

  it("exceção do cliente recusa (lado seguro)", async () => {
    const r = await autorizarModulo({
      organizationId: ORG,
      tokenId: TOKEN,
      metodo: "GET",
      caminho: "/api/v1/contacts",
      supabase: {
        from() {
          throw new Error("rede caiu");
        },
      } as unknown as SupabaseClient,
    });
    expect(r).toEqual({ ok: false, codigo: "module_authorization_unavailable" });
  });

  it("consentimento retirado entre duas chamadas: a segunda recusa (sem cache)", async () => {
    const b = banco();
    expect(await decide(b, "GET", "/api/v1/contacts")).toEqual({ ok: true });
    b.vinculo = { enabled: true, consented_areas: [] };
    expect(await decide(b, "GET", "/api/v1/contacts")).toEqual({
      ok: false,
      codigo: "module_area_not_granted",
    });
  });

  it("toda leitura filtra a organização à mão e a instalação sai da LINHA do token", async () => {
    const f = falso(banco());
    const r = await autorizarModulo({
      organizationId: ORG,
      tokenId: TOKEN,
      metodo: "GET",
      caminho: "/api/v1/contacts",
      supabase: f.cliente,
    });
    expect(r).toEqual({ ok: true });
    expect(f.filtros.api_tokens).toEqual([
      ["organization_id", ORG],
      ["id", TOKEN],
    ]);
    expect(f.filtros.organization_extensions).toEqual([
      ["organization_id", ORG],
      ["installation_id", INST],
    ]);
    expect(f.filtros.extension_installations).toEqual([["id", INST]]);
  });
});
