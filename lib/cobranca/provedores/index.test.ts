import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ base: null as string | null, chave: ["sk", "test", "51HregistroDeTeste00"].join("_") as string | null }));
vi.mock("@/lib/cobranca/configuracao", () => ({ chaveDoProvedor: async () => h.chave }));
vi.mock("@/lib/cobranca/provedores/base-de-teste", () => ({ baseDeTesteDaCobranca: () => h.base }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://crm.example.com" } }));

import { ErroDoProvedor } from "./contrato";
import { adaptador, modoDoProvedor } from "./index";
import { marcaDaInstalacao } from "./stripe";

function fetchQueGuarda() {
  const urls: string[] = [];
  const f = (async (entrada: string | URL | Request) => {
    urls.push(String(entrada));
    return Response.json({ object: "list", data: [], has_more: false });
  }) as typeof fetch;
  return { f, urls };
}

beforeEach(() => {
  h.base = null;
  h.chave = ["sk", "test", "51HregistroDeTeste00"].join("_");
});

describe("registro dos adaptadores de cobrança", () => {
  it("stripe sem base de teste fala com a API oficial, sem tocar a rede ao montar", async () => {
    const { f, urls } = fetchQueGuarda();
    const s = adaptador("stripe", { fetch: f });
    expect(s.id).toBe("stripe");
    expect(urls).toEqual([]);
    expect(await s.testarChave()).toEqual({ ok: true, modo: "teste" });
    expect(urls[0]).toMatch(/^https:\/\/api\.stripe\.com\/v1\/customers\?/);
  });

  it("⭐ com a base de teste ligada, a chamada vai ao dublê em loopback, com o /v1", async () => {
    h.base = "http://127.0.0.1:3995";
    const { f, urls } = fetchQueGuarda();
    await adaptador("stripe", { fetch: f }).testarChave();
    expect(urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:3995\/v1\/customers\?/);
  });

  it("a chave pode vir de quem chama (a Conexão testa a chave digitada antes de gravar)", async () => {
    h.chave = null;
    const { f } = fetchQueGuarda();
    const s = adaptador("stripe", { fetch: f, chave: async () => ["rk", "test", "51HdigitadaNaTela0"].join("_") });
    expect(await s.testarChave()).toEqual({ ok: true, modo: "teste" });
  });

  it("⭐ asaas ainda não: erro do provedor não transitório, nunca um adaptador pela metade", () => {
    let erro: unknown;
    try {
      adaptador("asaas");
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(ErroDoProvedor);
    expect((erro as ErroDoProvedor).codigo).toBe("provedor_nao_suportado");
    expect((erro as ErroDoProvedor).transitorio).toBe(false);
  });

  it("⭐ o endpoint nasce com a marca DESTA instalação (hash da origem do app)", async () => {
    const corpos: string[] = [];
    const f = (async (_e: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body === "string") corpos.push(init.body);
      return Response.json({ id: "we_1", secret: ["whsec", "x"].join("_"), object: "list", data: [] });
    }) as typeof fetch;
    await adaptador("stripe", { fetch: f }).prepararWebhook("https://crm.example.com/api/v1/webhooks/cobranca/stripe", "d@example.com");
    const marca = new URLSearchParams(corpos[0]).get("metadata[cobranca_do_revendedor]");
    expect(marca).toBe(marcaDaInstalacao("https://crm.example.com"));
  });

  it("modoDoProvedor sai do prefixo da chave gravada", async () => {
    expect(await modoDoProvedor("stripe")).toBe("teste");
    h.chave = null;
    expect(await modoDoProvedor("stripe")).toBeNull();
    expect(await modoDoProvedor("asaas")).toBeNull();
  });
});
