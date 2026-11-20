/**
 * #1758 — O PROVEDOR `scavio`: lugares do Google Maps pela API da Scavio.
 *
 * O que este arquivo mede, na ordem:
 *
 * 1. Organização com `settings.prospecting.provider = 'scavio'` inicia a busca
 *    SEM rede (o id codifica a busca) e ZERO chamadas a `api.apify.com`.
 * 2. `synchronizeSearch` busca as páginas na Scavio com a chave DA
 *    ORGANIZAÇÃO, e os lugares (resposta real capturada em
 *    `tests/fixtures/scavio/`) viram candidatos pelo normalizador da casa.
 * 3. Paginação: as páginas que o `limit` pede, `start` de 20 em 20, parando
 *    na página curta; lugar repetido entre páginas entra uma vez só.
 * 4. Falha na primeira página é `ProspectingError` (o worker tenta de novo);
 *    falha numa página seguinte fica com o que já veio.
 * 5. A régua da credencial é `GET /api/v1/usage`; chave recusada não é gravada.
 * 6. Chave de OUTRO provedor (a da Apify, salva antes da troca) é recusada
 *    ANTES da rede, e um run que não é da Scavio falha fechado.
 * 7. Quem não escolheu nada continua na Apify, com `users/me`.
 * 8. Lugar fechado não vira candidato.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

let credencialDaOrg = "sk_chave-da-organizacao";

vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: vi.fn(async () => credencialDaOrg),
  encryptWebhookSecret: vi.fn(async () => "cifrado"),
}));

/** Sem banco no teste: o audit do fechamento da busca não alcança nada. */
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("sem banco no teste");
  },
}));

import { configureCredential, createSearch, synchronizeSearch } from "@/lib/prospecting/store";
import { ProspectingError } from "@/lib/prospecting/provider";
import { provedorDaOrganizacao } from "@/lib/prospecting/provedor";
import { itemDaScavio, provedorScavio } from "@/lib/prospecting/provedor-scavio";
import { normalizeProspect, searchSchema } from "@/lib/prospecting/schema";

const ORG_SCAVIO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_SEM_ESCOLHA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ESCOLHA = { prospecting: { provider: "scavio" } };
const BUSCA_URL = "https://api.scavio.dev/api/v2/google/maps/search";

/** Resposta REAL da busca de Mapas (Campinas, 3 lugares; só thumbnail/horários/extensões cortados). */
const PAGINA_REAL = JSON.parse(
  readFileSync(join(process.cwd(), "tests/fixtures/scavio/maps-search-pagina.json"), "utf8"),
) as { local_results: Record<string, unknown>[] };

const BUSCA = searchSchema.parse({
  name: "clínicas de Campinas",
  niche: "clínicas odontológicas",
  location: "Campinas, SP",
  limit: 3,
  budget_usd: 1,
  enrich: false,
});

/** Uma página de `quantos` lugares no formato real, com `place_id` próprio a partir de `desde`. */
function pagina(quantos: number, desde = 0) {
  const modelo = PAGINA_REAL.local_results[0]!;
  return {
    local_results: Array.from({ length: quantos }, (_, i) => ({
      ...modelo,
      position: i + 1,
      title: `${String(modelo.title)} ${desde + i}`,
      place_id: `ChIJ-lugar-${desde + i}`,
    })),
  };
}

function resposta(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status });
}

interface Campanha {
  id: string;
  organization_id: string;
  name: string;
  search: typeof BUSCA;
  config: unknown;
  status: string;
  search_status: string;
  run_id: string | null;
  dataset_id: string | null;
  next_send_at: Date;
  created_at: Date;
  error: string | null;
}

/** Banco falso: só o que `store.ts` toca, roteado pelo texto do SQL. */
function fakeDb(porOrg: Record<string, Record<string, unknown> | null>) {
  const log: { sql: string; params?: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    log.push({ sql, params });
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
    if (sql.includes("pg_advisory_unlock")) return { rows: [{ locked: true }] };
    if (sql.includes("select settings from organizations")) {
      const settings = porOrg[String(params[0])] ?? null;
      return { rows: settings ? [{ settings }] : [{}] };
    }
    if (sql.includes("credential_encrypted from prospecting_settings"))
      return { rows: [{ credential_encrypted: Buffer.from("ab", "hex") }] };
    if (sql.startsWith("insert into prospecting_campaigns")) {
      const campanha: Campanha = {
        id: "11111111-1111-4111-8111-111111111111",
        organization_id: String(params[0]),
        name: String(params[2]),
        search: params[3] as typeof BUSCA,
        config: null,
        status: "draft",
        search_status: "starting",
        run_id: null,
        dataset_id: null,
        next_send_at: new Date("2026-10-31T12:00:00Z"),
        created_at: new Date("2026-10-31T12:00:00Z"),
        error: null,
      };
      return { rows: [campanha] };
    }
    return { rows: [] };
  });
  const client = { query, release: () => undefined };
  return { query, log, client, pool: { query, connect: async () => client } };
}

/** Faz a leitura FINAL da campanha devolver o que o `update` gravou. */
function observarRun(db: ReturnType<typeof fakeDb>) {
  const original = db.query.getMockImplementation()!;
  const gravado: Record<string, unknown> = {};
  db.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const r = await original(sql, params);
    if (sql.includes("set run_id=$3"))
      Object.assign(gravado, {
        run_id: params[2],
        dataset_id: params[3],
        search_status: "running",
      });
    if (sql.includes("search_status='unknown'"))
      Object.assign(gravado, { search_status: "unknown", error: params[2] });
    if (sql.startsWith("select * from prospecting_campaigns") && !sql.includes("request_id"))
      return { rows: [{ id: params[1], ...gravado }] };
    return r;
  });
}

/** A campanha que `createSearch` deixou pronta para o tick do worker. */
async function campanhaIniciada(busca = BUSCA): Promise<Campanha> {
  const { id } = await provedorScavio.startSearch("", busca);
  return {
    id: "22222222-2222-4222-8222-222222222222",
    organization_id: ORG_SCAVIO,
    name: busca.name,
    search: busca,
    config: null,
    status: "draft",
    search_status: "running",
    run_id: id,
    dataset_id: id,
    next_send_at: new Date("2026-10-31T12:00:00Z"),
    created_at: new Date("2026-10-31T12:00:00Z"),
    error: null,
  };
}

let fetch: ReturnType<typeof vi.fn>;
const corpos = () =>
  fetch.mock.calls
    .filter((c) => String(c[0]) === BUSCA_URL)
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)));
const inseridos = (db: ReturnType<typeof fakeDb>) =>
  db.log.filter((q) => q.sql.startsWith("insert into prospecting_candidates"));

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  credencialDaOrg = "sk_chave-da-organizacao";
  fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
});

describe("#1758 provedor scavio (Google Maps pela API da Scavio)", () => {
  it("organização com provider 'scavio' inicia a busca sem rede e sem tocar na Apify", async () => {
    const db = fakeDb({ [ORG_SCAVIO]: ESCOLHA });
    observarRun(db);

    const campanha = await createSearch(
      db.pool as never,
      {} as never,
      ORG_SCAVIO,
      "77777777-7777-4777-8777-777777777777",
      BUSCA,
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(String(campanha.run_id)).toMatch(/^scavio:/);
    expect(campanha.dataset_id).toBe(campanha.run_id);
    expect(campanha.search_status).toBe("running");
  });

  it("synchronizeSearch busca na Scavio com a chave da organização, e os lugares reais viram candidatos", async () => {
    const db = fakeDb({ [ORG_SCAVIO]: ESCOLHA });
    fetch.mockResolvedValue(resposta(PAGINA_REAL));

    await synchronizeSearch(db.client as never, {} as never, (await campanhaIniciada()) as never);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(BUSCA_URL);
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer sk_chave-da-organizacao",
    });
    // Sem `gl`: com ele e sem centro de mapa, a busca puxaria para a capital do país.
    expect(corpos()).toEqual([
      { query: "clínicas odontológicas em Campinas, SP", hl: "pt-BR", start: 0 },
    ]);

    const candidatos = inseridos(db);
    expect(candidatos).toHaveLength(3);
    const primeiro = candidatos[0]!.params![4] as Record<string, unknown>;
    expect(primeiro).toMatchObject({
      key: "ChIJ_fJkU-bJyJQRkyriqOD0XIA",
      name: "Clínica Odontológica | Rede Odonto Campinas",
      phone: "+551932031404",
      website: "https://www.redeodonto.com.br/rede-odonto-campinas",
      category: "Clínica odontológica",
      rating: 4.8,
      reviews: 882,
      maps_url: "https://maps.google.com/?cid=9249536980455402131",
    });
    const fechamento = db.log.find((q) => q.sql.includes("search_status='succeeded'"));
    expect(fechamento).toBeDefined();
    // A Scavio cobra em créditos: o custo em dólar fica nulo, não inventado.
    expect(fechamento!.params![3]).toBeNull();
  });

  it("pagina de 20 em 20 até o limite e para na página curta", async () => {
    const db = fakeDb({ [ORG_SCAVIO]: ESCOLHA });
    const busca = { ...BUSCA, limit: 100 };
    fetch
      .mockResolvedValueOnce(resposta(pagina(20, 0)))
      .mockResolvedValueOnce(resposta(pagina(20, 20)))
      .mockResolvedValueOnce(resposta(pagina(7, 40)));

    await synchronizeSearch(
      db.client as never,
      {} as never,
      (await campanhaIniciada(busca)) as never,
    );

    expect(corpos().map((c) => c.start)).toEqual([0, 20, 40]);
    expect(inseridos(db)).toHaveLength(47);
  });

  it("não pede página além do limite, e lugar repetido entre páginas entra uma vez só", async () => {
    const provedor = provedorScavio;
    const { id } = await provedor.startSearch("", { ...BUSCA, limit: 25 });
    // A segunda página repete os 5 últimos lugares da primeira.
    fetch
      .mockResolvedValueOnce(resposta(pagina(20, 0)))
      .mockResolvedValueOnce(resposta(pagina(20, 15)));

    const itens = await provedor.readResults("sk_x", id, 25);

    expect(corpos().map((c) => c.start)).toEqual([0, 20]);
    const ids = itens.map((i) => i.placeId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(itens).toHaveLength(25);
    expect(ids.at(-1)).toBe("ChIJ-lugar-24");
  });

  it("organização em espanhol busca em espanhol; id de antes do idioma segue em português", async () => {
    const { id } = await provedorScavio.startSearch(
      "",
      { ...BUSCA, niche: "clínicas dentales", location: "Montevideo, Uruguay", limit: 5 },
      { idioma: "es" },
    );
    fetch.mockResolvedValueOnce(resposta(pagina(5, 0)));
    await provedorScavio.readResults("sk_x", id, 5);
    expect(corpos()).toEqual([
      { query: "clínicas dentales en Montevideo, Uruguay", hl: "es", start: 0 },
    ]);

    fetch.mockClear();
    fetch.mockResolvedValueOnce(resposta(pagina(5, 0)));
    const antigo =
      "scavio:" +
      Buffer.from(
        JSON.stringify({ niche: BUSCA.niche, location: BUSCA.location, limit: 5 }),
        "utf8",
      ).toString("base64url");
    await provedorScavio.readResults("sk_x", antigo, 5);
    expect(corpos()).toEqual([
      { query: "clínicas odontológicas em Campinas, SP", hl: "pt-BR", start: 0 },
    ]);
  });

  it("falha na PRIMEIRA página é ProspectingError; numa página seguinte fica com o que já veio", async () => {
    const { id } = await provedorScavio.startSearch("", { ...BUSCA, limit: 60 });

    fetch.mockResolvedValueOnce(resposta({ error: "Insufficient credits" }, 402));
    const falha = await provedorScavio.readResults("sk_x", id, 60).catch((e: unknown) => e);
    expect(falha).toBeInstanceOf(ProspectingError);
    expect((falha as ProspectingError).status).toBe(502);
    expect((falha as ProspectingError).escopo).toBe("campanha");
    expect((falha as Error).message).toContain("Saldo");

    fetch.mockReset();
    fetch
      .mockResolvedValueOnce(resposta(pagina(20, 0)))
      .mockRejectedValueOnce(new Error("ECONNRESET"));
    const parcial = await provedorScavio.readResults("sk_x", id, 60);
    expect(parcial).toHaveLength(20);
  });

  it("a régua da credencial é GET /api/v1/usage, e chave recusada não é gravada", async () => {
    const db = fakeDb({ [ORG_SCAVIO]: ESCOLHA });
    fetch.mockResolvedValue(resposta({ plan: "free", credit_balance: 50 }));

    await configureCredential(db.pool as never, {} as never, ORG_SCAVIO, "sk_chave-nova-valida");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe("https://api.scavio.dev/api/v1/usage");
    expect((fetch.mock.calls[0]![1] as RequestInit).method).toBe("GET");
    expect(
      db.log.some((q) =>
        q.sql.includes("prospecting_settings(organization_id,credential_encrypted)"),
      ),
    ).toBe(true);

    vi.clearAllMocks();
    const dbRuim = fakeDb({ [ORG_SCAVIO]: ESCOLHA });
    fetch.mockResolvedValue(resposta({ error: "Unauthorized" }, 401));
    const falha = await configureCredential(
      dbRuim.pool as never,
      {} as never,
      ORG_SCAVIO,
      "sk_chave-revogada",
    ).catch((e: unknown) => e);
    expect(falha).toBeInstanceOf(ProspectingError);
    expect((falha as Error).message).toBe("Chave de busca inválida.");
    expect(dbRuim.log.some((q) => q.sql.includes("prospecting_settings(organization_id"))).toBe(
      false,
    );
  });

  it("a chave de OUTRO provedor é recusada antes da rede, no configure e na busca", async () => {
    const db = fakeDb({ [ORG_SCAVIO]: ESCOLHA });
    const noConfigure = await configureCredential(
      db.pool as never,
      {} as never,
      ORG_SCAVIO,
      "apify_api_chave-antiga",
    ).catch((e: unknown) => e);
    expect(noConfigure).toBeInstanceOf(ProspectingError);
    expect((noConfigure as Error).message).toContain("não é uma chave da Scavio");

    // A chave da Apify ficou salva de antes da troca de escolha (#2174).
    credencialDaOrg = "apify_api_chave-antiga";
    const naBusca = await synchronizeSearch(
      db.client as never,
      {} as never,
      (await campanhaIniciada()) as never,
    ).catch((e: unknown) => e);
    expect(naBusca).toBeInstanceOf(ProspectingError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("um run que não é da Scavio (trocou de provedor no meio da busca) falha fechado, sem rede", async () => {
    const db = fakeDb({ [ORG_SCAVIO]: ESCOLHA });
    const campanha = { ...(await campanhaIniciada()), run_id: "run-apify", dataset_id: "ds-apify" };

    const falha = await synchronizeSearch(db.client as never, {} as never, campanha as never).catch(
      (e: unknown) => e,
    );

    expect(falha).toBeInstanceOf(ProspectingError);
    expect((falha as Error).message).toContain("não foi iniciada pela Scavio");
    expect(fetch).not.toHaveBeenCalled();
    expect(inseridos(db)).toHaveLength(0);
  });

  it("organização sem escolha continua na Apify, com users/me, mesmo com outra na Scavio", async () => {
    const db = fakeDb({ [ORG_SCAVIO]: ESCOLHA, [ORG_SEM_ESCOLHA]: null });
    observarRun(db);
    credencialDaOrg = "chave-apify";
    fetch.mockResolvedValue(
      resposta({ data: { id: "run-apify", status: "RUNNING", defaultDatasetId: "ds" } }),
    );

    await configureCredential(db.pool as never, {} as never, ORG_SEM_ESCOLHA, "chave-apify");
    expect(fetch.mock.calls[0]![0]).toBe("https://api.apify.com/v2/users/me");

    await createSearch(
      db.pool as never,
      {} as never,
      ORG_SEM_ESCOLHA,
      "88888888-8888-4888-8888-888888888888",
      BUSCA,
    );
    expect(String(fetch.mock.calls.at(-1)![0])).toContain("https://api.apify.com/v2/acts/");
    expect(fetch.mock.calls.every((c) => !String(c[0]).includes("scavio"))).toBe(true);
  });

  it("está disponível em produção (não é provedor de ambiente, como o 'teste')", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const db = fakeDb({ [ORG_SCAVIO]: ESCOLHA });
    const provedor = await provedorDaOrganizacao(db.pool as never, ORG_SCAVIO);
    expect(provedor).toBe(provedorScavio);
  });

  it("lugar fechado não vira candidato; lugar aberto sem site vira", () => {
    const real = PAGINA_REAL.local_results[0]!;
    expect(
      normalizeProspect(itemDaScavio({ ...real, open_state: "Fechado permanentemente" })),
    ).toBeNull();
    expect(
      normalizeProspect(itemDaScavio({ ...real, open_state: "Temporarily closed" })),
    ).toBeNull();

    const semSite = { ...real };
    delete semSite.website;
    const candidato = normalizeProspect(itemDaScavio(semSite));
    expect(candidato?.website).toBeNull();
    expect(candidato?.phone).toBe("+551932031404");
  });
});
