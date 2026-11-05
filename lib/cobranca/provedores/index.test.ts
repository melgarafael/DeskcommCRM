import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ base: null as string | null, chave: ["sk", "test", "51HregistroDeTeste00"].join("_") as string | null }));
vi.mock("@/lib/cobranca/configuracao", () => ({
  chaveDoProvedor: async () => h.chave,
  segredoDoWebhook: async () => "token-do-aviso-do-efi-000000000000000",
}));
vi.mock("@/lib/cobranca/provedores/base-de-teste", () => ({ baseDeTesteDaCobranca: () => h.base }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://crm.example.com" } }));

import { adaptador, modoDoProvedor } from "./index";
import { marcaDaInstalacao } from "./stripe";

const CLIENTE_ID = ["9f1c2a7e3b4d4e5f8a9b0c1d2e3f4a5b"].join("");
const SEGREDO_DO_CLIENTE = ["0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f"].join("");
const CHAVE_EFI = ["teste", CLIENTE_ID, SEGREDO_DO_CLIENTE].join(":");

const CHAVE_ASAAS = "$" + ["aact", "hmlg", "000MzkwODA2MWY2OGM3MWRlMDU2NWM3MzJlNzZmNGZhZGY6OjAwMDAw"].join("_");

function fetchQueGuarda() {
  const urls: string[] = [];
  const chaves: Array<string | null> = [];
  const f = (async (entrada: string | URL | Request, init?: RequestInit) => {
    urls.push(String(entrada));
    chaves.push(new Headers(init?.headers).get("access_token"));
    // Lista vazia nos dois dialetos: Stripe (`has_more`) e Asaas (`hasMore`, `totalCount`).
    return Response.json({ object: "list", data: [], has_more: false, hasMore: false, totalCount: 0, limit: 1, offset: 0 });
  }) as typeof fetch;
  return { f, urls, chaves };
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

  it("⭐ asaas sem base de teste fala com a API do Asaas (/v3), a chave no header access_token, sem tocar a rede ao montar", async () => {
    h.chave = CHAVE_ASAAS;
    const { f, urls, chaves } = fetchQueGuarda();
    const a = adaptador("asaas", { fetch: f });
    expect(a.id).toBe("asaas");
    expect(urls).toEqual([]);
    expect(await a.testarChave()).toEqual({ ok: true, modo: "teste" });
    expect(urls[0]).toMatch(/^https:\/\/api-sandbox\.asaas\.com\/v3\/customers\?/);
    expect(chaves[0]).toBe(CHAVE_ASAAS);
  });

  it("⭐ asaas com a base de teste ligada vai ao dublê em loopback, com o /v3 (a Stripe fica no /v1)", async () => {
    h.base = "http://127.0.0.1:3995";
    h.chave = CHAVE_ASAAS;
    const { f, urls } = fetchQueGuarda();
    await adaptador("asaas", { fetch: f }).testarChave();
    expect(urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:3995\/v3\/customers\?/);
  });

  it("a chave do Asaas também pode vir de quem chama (a Conexão testa a DIGITADA)", async () => {
    h.chave = null;
    const { f, chaves } = fetchQueGuarda();
    expect(await adaptador("asaas", { fetch: f, chave: async () => CHAVE_ASAAS }).testarChave()).toEqual({ ok: true, modo: "teste" });
    expect(chaves[0]).toBe(CHAVE_ASAAS);
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

  it("modoDoProvedor sai do prefixo da chave gravada, nos dois provedores", async () => {
    expect(await modoDoProvedor("stripe")).toBe("teste");
    h.chave = CHAVE_ASAAS;
    expect(await modoDoProvedor("asaas")).toBe("teste");
    h.chave = CHAVE_ASAAS.replace("_hmlg_", "_prod_");
    expect(await modoDoProvedor("asaas")).toBe("producao");
    h.chave = null;
    expect(await modoDoProvedor("stripe")).toBeNull();
    expect(await modoDoProvedor("asaas")).toBeNull();
  });

  it("⭐ efi: a credencial de homologação vai ao /v1/authorize do sandbox, no Basic, e nada toca a rede ao montar", async () => {
    h.chave = CHAVE_EFI;
    const urls: string[] = [];
    const autorizacoes: Array<string | null> = [];
    const f = (async (entrada: string | URL | Request, init?: RequestInit) => {
      urls.push(String(entrada));
      autorizacoes.push(new Headers(init?.headers).get("authorization"));
      return Response.json({ access_token: "token-do-efi", expires_in: 600 });
    }) as typeof fetch;
    const e = adaptador("efi", { fetch: f });
    expect(e.id).toBe("efi");
    expect(urls).toEqual([]);
    expect(await e.testarChave()).toEqual({ ok: true, modo: "teste" });
    expect(urls[0]).toBe("https://cobrancas-h.api.efipay.com.br/v1/authorize");
    expect(autorizacoes[0]).toMatch(/^Basic /);
    // A chave não aparece na URL — nem em teste.
    expect(urls[0]).not.toContain(SEGREDO_DO_CLIENTE);
  });

  it("⭐ efi com a base de teste ligada vai ao dublê em loopback, com o /v1 (como a Stripe)", async () => {
    h.base = "http://127.0.0.1:3995";
    h.chave = CHAVE_EFI;
    const urls: string[] = [];
    const f = (async (entrada: string | URL | Request) => {
      urls.push(String(entrada));
      return Response.json({ access_token: "token-do-efi", expires_in: 600 });
    }) as typeof fetch;
    expect(await adaptador("efi", { fetch: f }).testarChave()).toEqual({ ok: true, modo: "teste" });
    expect(urls[0]).toBe("http://127.0.0.1:3995/v1/authorize");
  });

  it("modoDoProvedor lê o prefixo da credencial do Efi", async () => {
    h.chave = CHAVE_EFI;
    expect(await modoDoProvedor("efi")).toBe("teste");
    h.chave = `producao:${CLIENTE_ID}:${SEGREDO_DO_CLIENTE}`;
    expect(await modoDoProvedor("efi")).toBe("producao");
    h.chave = "formato-errado";
    expect(await modoDoProvedor("efi")).toBeNull();
  });

  it("⭐ provedor fora da união é erro na construção, não adaptador mudo", () => {
    expect(() => adaptador("mercadopago" as never)).toThrow(/provedor de cobrança desconhecido/);
  });

  it("⭐ credencial inválida do Efi não derruba os outros provedores", async () => {
    const recusa = (async () => Response.json({ error: "invalid_client" }, { status: 401 })) as unknown as typeof fetch;
    const lista = fetchQueGuarda().f;
    const efi = adaptador("efi", { fetch: recusa, chave: async () => CHAVE_EFI });
    expect(await efi.testarChave()).toEqual({ ok: false, motivo: "chave_invalida" });
    // O mesmo processo, logo depois: Asaas e Stripe seguem respondendo.
    expect(await adaptador("asaas", { fetch: lista, chave: async () => CHAVE_ASAAS }).testarChave()).toEqual({ ok: true, modo: "teste" });
    expect(await adaptador("stripe", { fetch: lista, chave: async () => ["sk", "test", "51HdepoisDoEfi00"].join("_") }).testarChave()).toEqual({
      ok: true,
      modo: "teste",
    });
  });
});
