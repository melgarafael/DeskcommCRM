/**
 * A EMPRESA NOVA NASCE NO IDIOMA DE QUEM SE CADASTROU.
 *
 * ─── O defeito ─────────────────────────────────────────────────────────────
 *
 * Quem se cadastrava numa tela em espanhol, confirmava o e-mail e caía num
 * onboarding inteiro em português: a organização nascia com os defaults da
 * coluna (`pt-BR`, `America/Sao_Paulo`, `BRL`), e a interface de quem não
 * escolheu idioma próprio segue o da organização.
 *
 * Este arquivo cobra as três metades:
 *   1. a REGRA (`perfilDaEmpresaNova`): idioma da tela, fuso do navegador,
 *      moeda do país — e o caminho `pt-BR` INTACTO;
 *   2. o PROVISIONAMENTO grava a regra no INSERT da organização;
 *   3. a entrada com Google leva as mesmas pistas pela URL de volta.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { perfilDaEmpresaNova, pistasParaGuardar } from "@/lib/auth/perfil-da-empresa-nova";
import { urlDeRetornoDoGoogle } from "@/lib/auth/entrada-com-google";
import { MOEDAS_SERVIDAS } from "@/lib/money";
import { FUSOS_OFERECIDOS } from "@/lib/tempo/fusos";

const FUSOS_DO_BRASIL = [
  "America/Sao_Paulo",
  "America/Manaus",
  "America/Belem",
  "America/Recife",
  "America/Fortaleza",
  "America/Cuiaba",
  "America/Rio_Branco",
];

describe("perfilDaEmpresaNova — a regra", () => {
  it("⭐ espanhol + fuso da Cidade do México: es, America/Mexico_City e peso mexicano", () => {
    expect(perfilDaEmpresaNova({ idioma: "es", fuso: "America/Mexico_City" })).toEqual({
      locale: "es",
      timezone: "America/Mexico_City",
      currency: "MXN",
    });
  });

  it("⭐ o país NÃO é gravado sem perfil legal revisado", () => {
    // Gravar `MX` sem perfil faria Configurações › Empresa recusar o salvar —
    // a empresa sem conseguir editar o próprio cadastro. Quando o perfil
    // existir (`paisesOferecidos`), esta linha muda sozinha.
    expect(perfilDaEmpresaNova({ idioma: "es", fuso: "America/Mexico_City" })).not.toHaveProperty("country");
  });

  it("com perfil revisado, o país entra (Lisboa → PT)", () => {
    expect(perfilDaEmpresaNova({ idioma: "es", fuso: "Europe/Lisbon" })).toEqual({
      locale: "es",
      timezone: "Europe/Lisbon",
      currency: "EUR",
      country: "PT",
    });
  });

  it("sem fuso do navegador, a região do Accept-Language decide (es-MX → México)", () => {
    expect(perfilDaEmpresaNova({ idioma: "es", acceptLanguage: "es-MX,es;q=0.9,en;q=0.8" })).toEqual({
      locale: "es",
      timezone: "America/Mexico_City",
      currency: "MXN",
    });
  });

  it("⭐ pt-BR nasce como sempre nasceu: só o idioma, os defaults da coluna para o resto", () => {
    // Mesmo com o navegador fora do Brasil: o cadastro em português não muda.
    expect(perfilDaEmpresaNova({ idioma: "pt-BR", fuso: "Europe/Madrid" })).toEqual({ locale: "pt-BR" });
    expect(perfilDaEmpresaNova({})).toEqual({ locale: "pt-BR" });
  });

  it("idioma da tela vence o cabeçalho; idioma desconhecido cai no cabeçalho", () => {
    expect(perfilDaEmpresaNova({ idioma: "pt-BR", acceptLanguage: "es-MX" }).locale).toBe("pt-BR");
    expect(perfilDaEmpresaNova({ idioma: "xx", acceptLanguage: "es-MX" }).locale).toBe("es");
  });

  it("fuso que o Intl recusa (escrito à mão) é ignorado, e a região do cabeçalho decide", () => {
    const perfil = perfilDaEmpresaNova({ idioma: "es", fuso: "America/Ciudad de México", acceptLanguage: "es-MX" });
    expect(perfil.timezone).toBe("America/Mexico_City");
  });

  it("fuso válido mas fora das opções de Configurações não é gravado (o <select> mostraria outro)", () => {
    const perfil = perfilDaEmpresaNova({ idioma: "es", fuso: "America/Caracas" });
    expect(perfil).toEqual({ locale: "es" });
  });

  it("país cuja moeda o produto não serve fica com a moeda padrão (não inventa)", () => {
    expect(perfilDaEmpresaNova({ idioma: "es", fuso: "America/Argentina/Buenos_Aires" })).toEqual({
      locale: "es",
      timezone: "America/Argentina/Buenos_Aires",
    });
    expect(perfilDaEmpresaNova({ idioma: "es", fuso: "Europe/Madrid" }).currency).toBe("EUR");
  });

  it("toda moeda da tabela é servida, e todo fuso da tabela é oferecido", () => {
    // Fuso de Configurações fora do Brasil e de UTC sem país ficaria sem moeda e
    // sem fuso de reserva; moeda não servida gravaria um código que a tela não mostra.
    for (const codigo of FUSOS_OFERECIDOS.map((f) => f.codigo)) {
      if (codigo === "UTC" || FUSOS_DO_BRASIL.includes(codigo)) continue;
      const perfil = perfilDaEmpresaNova({ idioma: "es", fuso: codigo });
      expect(perfil.timezone, codigo).toBe(codigo);
      if (perfil.currency) expect(MOEDAS_SERVIDAS as readonly string[], codigo).toContain(perfil.currency);
    }
  });

  it("pistasParaGuardar: só idioma servido e fuso que existe", () => {
    expect(pistasParaGuardar({ idioma: "es", fuso: "America/Mexico_City" })).toEqual({
      idioma: "es",
      fuso: "America/Mexico_City",
    });
    expect(pistasParaGuardar({ idioma: "xx-YY", fuso: "Lua/Base" })).toEqual({});
    expect(pistasParaGuardar({ idioma: 42, fuso: "x".repeat(200) })).toEqual({});
  });
});

describe("urlDeRetornoDoGoogle — as pistas atravessam o Google", () => {
  it("⭐ idioma e fuso vão na URL de volta, saneados", () => {
    const url = new URL(
      urlDeRetornoDoGoogle("https://crm.exemplo", { idioma: "es", fuso: "America/Mexico_City" }),
    );
    expect(url.searchParams.get("idioma")).toBe("es");
    expect(url.searchParams.get("fuso")).toBe("America/Mexico_City");
  });

  it("sem pistas (ou adulteradas), a URL é a de sempre", () => {
    expect(urlDeRetornoDoGoogle("https://crm.exemplo", {})).toBe(
      "https://crm.exemplo/auth/callback",
    );
    expect(urlDeRetornoDoGoogle("https://crm.exemplo", { idioma: "xx", fuso: "nada" })).toBe(
      "https://crm.exemplo/auth/callback",
    );
  });
});

// ── 2. o provisionamento ─────────────────────────────────────────────────────

interface Escrita {
  tabela: string;
  op: "insert" | "update" | "select";
  payload: Record<string, unknown> | null;
  filtros: Record<string, unknown>;
}
const escritas: Escrita[] = [];

function bancoFalso() {
  return {
    from: (tabela: string) => {
      const e: Escrita = { tabela, op: "select", payload: null, filtros: {} };
      const responder = () => {
        if (tabela === "user_organizations" && e.op === "select")
          return { data: null, error: null };
        if (tabela === "organizations" && e.op === "insert")
          return { data: { id: "org-nova", slug: "x" }, error: null };
        if (tabela === "crm_pipelines") return { data: { id: "funil-1" }, error: null };
        if (e.op === "update") return { data: [{ id: "linha" }], error: null };
        return { data: null, error: null };
      };
      const b = {
        select: () => b,
        insert: (p: Record<string, unknown>) => {
          e.op = "insert";
          e.payload = p;
          escritas.push(e);
          return b;
        },
        update: (p: Record<string, unknown>) => {
          e.op = "update";
          e.payload = p;
          escritas.push(e);
          return b;
        },
        eq: (c: string, v: unknown) => {
          e.filtros[c] = v;
          return b;
        },
        is: (c: string, v: unknown) => {
          e.filtros[c] = v;
          return b;
        },
        in: (c: string, v: unknown) => {
          e.filtros[`in:${c}`] = v;
          return b;
        },
        limit: () => b,
        single: async () => responder(),
        maybeSingle: async () => responder(),
        then: (ok: (r: unknown) => unknown) => Promise.resolve(responder()).then(ok),
      };
      return b;
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => bancoFalso() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

describe("ensureTenantForUser — a empresa nasce com o perfil", () => {
  beforeEach(() => {
    escritas.length = 0;
  });

  it("⭐ cadastro em espanhol: o INSERT da organização leva es, o fuso e a moeda do país", async () => {
    const { ensureTenantForUser } = await import("@/lib/auth/provision");
    await ensureTenantForUser({
      id: "u-1",
      email: "dueno@ferreteria.test",
      user_metadata: {
        org_name: "Ferretería",
        idioma_do_cadastro: "es",
        fuso_do_cadastro: "America/Mexico_City",
      },
    });

    const org = escritas.find((e) => e.tabela === "organizations" && e.op === "insert");
    expect(org?.payload).toMatchObject({
      locale: "es",
      timezone: "America/Mexico_City",
      currency: "MXN",
    });
    expect(org?.payload).not.toHaveProperty("country");
  });

  it("⭐ cadastro em português: o INSERT é o de sempre", async () => {
    const { ensureTenantForUser } = await import("@/lib/auth/provision");
    await ensureTenantForUser({
      id: "u-2",
      email: "dono@loja.com.br",
      user_metadata: {
        org_name: "Loja",
        idioma_do_cadastro: "pt-BR",
        fuso_do_cadastro: "Europe/Madrid",
      },
    });

    const org = escritas.find((e) => e.tabela === "organizations" && e.op === "insert");
    expect(org?.payload).toMatchObject({ locale: "pt-BR" });
    expect(org?.payload).not.toHaveProperty("timezone");
    expect(org?.payload).not.toHaveProperty("currency");
    expect(org?.payload).not.toHaveProperty("country");
  });

  it("conta antiga, sem pistas no metadado: o Accept-Language da confirmação decide", async () => {
    const { ensureTenantForUser } = await import("@/lib/auth/provision");
    await ensureTenantForUser(
      { id: "u-3", email: "x@y.test", user_metadata: { org_name: "X" } },
      { pistas: { acceptLanguage: "es-MX,es;q=0.9" } },
    );
    const org = escritas.find((e) => e.tabela === "organizations" && e.op === "insert");
    expect(org?.payload).toMatchObject({
      locale: "es",
      timezone: "America/Mexico_City",
      currency: "MXN",
    });
  });

  it("a URL de volta do Google vale como pista, e o metadado do cadastro vence ela", async () => {
    const { ensureTenantForUser } = await import("@/lib/auth/provision");
    await ensureTenantForUser(
      { id: "u-4", email: "g@y.test", user_metadata: { org_name: "G", idioma_do_cadastro: "es" } },
      { source: "signup", pistas: { idioma: "pt-BR", fuso: "Europe/Madrid" } },
    );
    const org = escritas.find((e) => e.tabela === "organizations" && e.op === "insert");
    // O idioma do metadado (gravado quando a pessoa leu a tela) vence o da URL;
    // o fuso, que o metadado não trouxe, vem da URL.
    expect(org?.payload).toMatchObject({ locale: "es", timezone: "Europe/Madrid", currency: "EUR" });
  });
});
