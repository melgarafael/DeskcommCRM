/**
 * A busca da prospecção no idioma da ORGANIZAÇÃO (`lib/prospecting/idioma.ts`).
 *
 * Medido numa instalação real em espanhol em 02/11/2026: a busca ia com
 * `language: "pt-BR"` e `countryCode: "br"` fixos, e o rubro das empresas voltava
 * em português ("Concessionária", "Agente comercial de carros") — palavra que a
 * abordagem cita. O que estes casos fixam:
 *   1. organização em espanhol → a busca pede espanhol e NÃO prende o país no Brasil
 *      (quem diz onde buscar é a localização digitada);
 *   2. quem não tem idioma (ou tem um que o produto não serve) fica EXATAMENTE como antes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: vi.fn(async () => "chave-em-claro"),
  encryptWebhookSecret: vi.fn(async () => "cifrado"),
}));

import { idiomaDaOrganizacao } from "@/lib/prospecting/idioma";
import { startSearch } from "@/lib/prospecting/provider";
import { searchSchema } from "@/lib/prospecting/schema";
import { createSearch } from "@/lib/prospecting/store";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BUSCA = searchSchema.parse({
  name: "concesionarias",
  niche: "venta de vehiculos",
  location: "Montevideo, Uruguay",
  limit: 5,
  budget_usd: 1,
  enrich: true,
});

let fetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { id: "run", status: "RUNNING" } })));
  vi.stubGlobal("fetch", fetch);
});
const corpo = () => JSON.parse(String(fetch.mock.calls.at(-1)![1].body)) as Record<string, unknown>;

describe("idiomaDaOrganizacao", () => {
  const db = (locale: string | null | undefined) => ({
    query: vi.fn(async () => ({ rows: locale === undefined ? [] : [{ locale }] })),
  });
  it.each([
    ["es", "es"],
    ["es-MX", "es"],
    ["pt-BR", "pt-BR"],
    [null, "pt-BR"],
    [undefined, "pt-BR"],
    ["fr-FR", "pt-BR"],
  ])("locale %s → %s", async (locale, esperado) => {
    expect(await idiomaDaOrganizacao(db(locale as string | null | undefined) as never, ORG)).toBe(esperado);
  });
});

describe("startSearch", () => {
  it("sem idioma: português do Brasil e país Brasil, como sempre", async () => {
    await startSearch("k", BUSCA);
    expect(corpo()).toMatchObject({ language: "pt-BR", countryCode: "br" });
  });
  it("em espanhol: pede espanhol e não prende a busca no Brasil", async () => {
    await startSearch("k", BUSCA, { idioma: "es" });
    expect(corpo().language).toBe("es");
    expect(corpo()).not.toHaveProperty("countryCode");
    expect(corpo().locationQuery).toBe("Montevideo, Uruguay");
  });
});

describe("createSearch leva o idioma da organização até a busca", () => {
  function fakeDb(locale: string | null) {
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("pg_try_advisory_lock") || sql.includes("pg_advisory_unlock")) return { rows: [{ locked: true }] };
      if (sql.includes("select settings from organizations")) return { rows: [{}] };
      if (sql.startsWith("select locale from organizations")) return { rows: [{ locale }] };
      if (sql.includes("credential_encrypted from prospecting_settings"))
        return { rows: [{ credential_encrypted: Buffer.from("ab", "hex") }] };
      if (sql.startsWith("insert into prospecting_campaigns"))
        return { rows: [{ id: "11111111-1111-4111-8111-111111111111", organization_id: params[0] }] };
      return { rows: [] };
    });
    const client = { query, release: () => undefined };
    return { query, pool: { query, connect: async () => client } };
  }
  it.each([
    ["es", "es", false],
    [null, "pt-BR", true],
  ])("locale %s → language %s (país Brasil: %s)", async (locale, language, comPais) => {
    const db = fakeDb(locale);
    await createSearch(db.pool as never, {} as never, ORG, "77777777-7777-4777-8777-777777777777", BUSCA);
    expect(corpo().language).toBe(language);
    expect("countryCode" in corpo()).toBe(comPais);
  });
});
