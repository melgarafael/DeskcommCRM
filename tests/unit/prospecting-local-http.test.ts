/**
 * #2942 — O PROVEDOR `local-http`: engine de scraping self-hosted.
 *
 * O que este arquivo mede, na ordem:
 *
 * 1. Organização com `settings.prospecting.provider = 'local-http'` tem a busca
 *    entregue ao ENGINE, na URL DA INSTALAÇÃO (`PROSPECTING_LOCAL_HTTP_URL`) —
 *    e ZERO chamadas a `api.apify.com`. Antes desta fatia a mesma organização
 *    caía fechado em `Provedor de busca desconhecido nesta organização`
 *    (422).
 * 2. **A URL vem da INSTALAÇÃO, nunca da organização.** O valor que a
 *    organização informaria (o canal de credencial) é IGNORADO: uma URL
 *    arbitrária dela não vale.
 * 3. **Destino de rede interna não autorizado é RECUSA FECHADA.** O endereço
 *    do engine passa pela régua de destinos internos
 *    (`motivoDaRecusaDeDestino(..., "instalacao")`), e um IP interno fora da
 *    lista que a instalação autoriza não é alcançado.
 * 4. Endereço interno COBERTO pela lista da instalação alcança o engine — o
 *    caso de uso que motivou a #2942.
 * 5. A régua de credencial do provedor é o HEALTH CHECK do engine da
 *    instalação, e NADA é gravado (não há segredo por organização).
 * 6. A fatia não mexe em quem não escolheu nada: sem escolha, continua a Apify.
 * 7. `local-http` é de PRODUÇÃO — ao contrário de `teste`, que só existe sob
 *    `NODE_ENV=test` (#2174).
 * 8. `synchronizeSearch` lê a busca e os resultados pelo mesmo engine; os itens
 *    que o normalizador da casa já entende viram candidatos — e um estado
 *    terminal COM FALHA (`failed`/`cancelled`) vira `search_status='failed'`.
 * 9. Falha do engine e URL inválida saem FECHADO, como `ProspectingError`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** A URL do engine é da INSTALAÇÃO — quem diz é `PROSPECTING_LOCAL_HTTP_URL`. */
// IP público LITERAL: a régua de destino julga o IP direto, sem tocar em DNS —
// nada de dublê de resolução, nada de rede. E `https` para valer em produção.
const ENGINE = "https://93.184.216.34:8080";

/**
 * O canal cifrado por organização segue existindo (a escolha da Apify o usa),
 * mas o `local-http` o IGNORA: `credencialDaOrg` é justamente a URL arbitrária
 * que a organização poderia informar e que NÃO pode valer.
 */
let credencialDaOrg: string | ((org: string) => string) = "https://url-da-organizacao.test:1234";

vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: vi.fn(async () => credencialDaOrg),
  encryptWebhookSecret: vi.fn(async () => "cifrado"),
}));

/**
 * O guard de destino (`lib/automation/outbound-ip.ts`) julga o IP LITERAL da URL
 * sem passar por DNS — por isso o engine de teste usa um IP público literal
 * (`ENGINE`) e não um nome. Nenhum dublê de resolução é preciso.
 */

/** Sem banco no teste: a lista de destinos internos cai no piso (vazio). */
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("sem banco no teste");
  },
}));

import {
  configureCredential,
  createSearch,
  synchronizeSearch,
} from "@/lib/prospecting/store";
import { ProspectingError } from "@/lib/prospecting/provider";
import { provedorDaOrganizacao } from "@/lib/prospecting/provedor";
import { provedorDeTeste } from "@/lib/prospecting/provedor-teste";
import { searchSchema } from "@/lib/prospecting/schema";
import { esquecerDestinosInternos } from "@/lib/automation/destinos-internos-autorizados";

const ORG_LOCAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_SEM_ESCOLHA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const BUSCA = searchSchema.parse({
  name: "clínicas de SP",
  niche: "clínicas odontológicas",
  location: "São Paulo",
  limit: 3,
  budget_usd: 1,
  enrich: false,
});

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

/** Itens no formato que `normalizeProspect()` (`schema.ts`) entende — os nomes do Google Maps. */
function itensDoEngine(quantos: number): Record<string, unknown>[] {
  return Array.from({ length: quantos }, (_, i) => ({
    title: `Clínica ${i + 1}`,
    placeId: `place-${i + 1}`,
    phone: `(11) 9999${i}-${String(1000 + i).slice(-4)}`,
    categoryName: "Clínica odontológica",
    address: `São Paulo, ${i + 1}`,
    url: `https://exemplo.test/${i + 1}`,
    website: `https://exemplo.test/${i + 1}`,
    totalScore: 4.2,
    reviewsCount: i,
    permanentlyClosed: false,
  }));
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
    if (sql.includes("prospecting_settings(organization_id,credential_encrypted)"))
      return { rows: [] };
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
        next_send_at: new Date("2026-10-03T12:00:00Z"),
        created_at: new Date("2026-10-03T12:00:00Z"),
        error: null,
      };
      return { rows: [campanha] };
    }
    if (sql.startsWith("select * from prospecting_campaigns")) return { rows: [] };
    if (sql.includes("set run_id=$3")) return { rows: [] };
    if (sql.includes("search_status='unknown'")) return { rows: [] };
    if (sql.includes("search_status='failed'")) return { rows: [] };
    return { rows: [] };
  });
  const client = { query, release: () => undefined };
  return { query, log, client, pool: { query, connect: async () => client } };
}

/** Faz a leitura FINAL da campanha devolver o que o `update` gravou (mesmo truque do teste irmão). */
function observarRun(pool: ReturnType<typeof fakeDb>) {
  const original = pool.query.getMockImplementation()!;
  const gravado: Record<string, Record<string, unknown>> = {};
  pool.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const r = await original(sql, params);
    const org = String(params[0]);
    if (sql.includes("set run_id=$3"))
      gravado[org] = {
        ...(gravado[org] ?? {}),
        run_id: params[2],
        dataset_id: params[3],
        search_status: "running",
      };
    if (sql.includes("search_status='unknown'"))
      gravado[org] = { ...(gravado[org] ?? {}), search_status: "unknown", error: params[2] };
    if (sql.startsWith("select * from prospecting_campaigns") && !sql.includes("request_id")) {
      const g = gravado[org];
      if (g) return { rows: [{ id: params[1], ...(r.rows[0] ?? {}), ...g }] };
    }
    return r;
  });
  return gravado;
}

let fetch: ReturnType<typeof vi.fn>;

/** Responde o engine por ROTA, e registra tudo que passou por ele. */
function engine(opcoes: {
  health?: () => Response;
  scrape?: () => Response;
  job?: (id: string) => Response;
}): string[] {
  const urls: string[] = [];
  fetch.mockImplementation(async (url: string) => {
    urls.push(url);
    if (url.includes("/api/v1/health"))
      return opcoes.health?.() ?? new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    if (url.includes("/api/v1/scrape"))
      return (
        opcoes.scrape?.() ??
        new Response(JSON.stringify({ job_id: "job-1", status: "pending" }), { status: 202 })
      );
    if (url.includes("/api/v1/jobs/")) {
      const id = url.split("/api/v1/jobs/")[1]!.split("?")[0]!;
      return (
        opcoes.job?.(id) ??
        new Response(
          JSON.stringify({
            job_id: id,
            status: "completed",
            keyword: "clínicas odontológicas",
            results: itensDoEngine(BUSCA.limit),
            result_count: BUSCA.limit,
            error: "",
          }),
          { status: 200 },
        )
      );
    }
    throw new Error(`a URL não é do engine: ${url}`);
  });
  return urls;
}

/** A campanha que o engine já lançou, pronta para o tick do worker. */
function campanhaDoEngine(org: string, runId = "job-1"): Campanha {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    organization_id: org,
    name: BUSCA.name,
    search: BUSCA,
    config: null,
    status: "draft",
    search_status: "running",
    run_id: runId,
    dataset_id: runId,
    next_send_at: new Date("2026-10-03T12:00:00Z"),
    created_at: new Date("2026-10-03T12:00:00Z"),
    error: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  // A URL do engine é da INSTALAÇÃO (nunca da organização).
  vi.stubEnv("PROSPECTING_LOCAL_HTTP_URL", ENGINE);
  // A URL da organização é a isca: sempre uma que NÃO pode vencer a da instalação.
  credencialDaOrg = "https://url-da-organizacao.test:1234";
  // A lista de destinos internos é memoizada em `globalThis`: limpa entre testes.
  esquecerDestinosInternos();
  fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
});

describe("#2942 provedor local-http (engine de scraping self-hosted)", () => {
  it("organização com provider 'local-http' é atendida pelo engine, na URL da instalação, sem tocar na Apify", async () => {
    const db = fakeDb({ [ORG_LOCAL]: { prospecting: { provider: "local-http" } } });
    observarRun(db);
    const urls = engine({});

    const campanha = await createSearch(
      db.pool as never,
      {} as never,
      ORG_LOCAL,
      "77777777-7777-4777-8777-777777777777",
      BUSCA,
    );

    // O defeito de hoje: esta organização caía em "Provedor de busca desconhecido".
    expect(urls.every((u) => u.startsWith(ENGINE))).toBe(true);
    expect(urls.some((u) => u.includes("api.apify.com"))).toBe(false);
    expect(urls.filter((u) => u.endsWith("/api/v1/scrape"))).toHaveLength(1);

    const corpo = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(corpo.keyword).toContain(BUSCA.niche);
    expect(corpo.keyword).toContain(BUSCA.location);

    expect(campanha.run_id).toBe("job-1");
    expect(campanha.search_status).toBe("running");
  });

  it("a URL do engine vem da INSTALAÇÃO: a URL que a organização informa é ignorada", async () => {
    const db = fakeDb({ [ORG_LOCAL]: { prospecting: { provider: "local-http" } } });
    observarRun(db);
    const urls = engine({});

    // A organização "informa" uma URL arbitrária no canal de credencial.
    const urlArbitraria = "http://10.9.9.9:9999";
    credencialDaOrg = urlArbitraria;

    await createSearch(
      db.pool as never,
      {} as never,
      ORG_LOCAL,
      "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      BUSCA,
    );

    // O engine é o da instalação; a URL da organização NÃO é usada em lugar nenhum.
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith(ENGINE))).toBe(true);
    expect(urls.some((u) => u.includes("10.9.9.9"))).toBe(false);
    expect(urls.some((u) => u.includes("url-da-organizacao"))).toBe(false);
  });

  it("destino de rede interna NÃO autorizado é RECUSA FECHADA — o engine não é alcançado", async () => {
    // A instalação aponta o engine para um IP da rede de dentro; a lista de
    // destinos internos está VAZIA (piso do `.env`), então isto NÃO é autorizado.
    vi.stubEnv("PROSPECTING_LOCAL_HTTP_URL", "http://10.1.2.7:8080");
    const db = fakeDb({ [ORG_LOCAL]: { prospecting: { provider: "local-http" } } });
    observarRun(db);
    const urls = engine({});

    const provedor = await provedorDaOrganizacao(db.pool as never, ORG_LOCAL);
    const recusa = await provedor.startSearch("", BUSCA).catch((e: unknown) => e);

    expect(recusa).toBeInstanceOf(ProspectingError);
    expect((recusa as ProspectingError).status).toBe(422);
    expect((recusa as Error).message).toContain("private_host");
    // Nada saiu para a rede interna: o guard fecha ANTES do fetch.
    expect(urls).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("destino interno COBERTO pela lista da instalação alcança o engine (o caso de uso da #2942)", async () => {
    vi.stubEnv("PROSPECTING_LOCAL_HTTP_URL", "http://10.1.2.7:8080");
    // A instalação autorizou ESTE destino interno (última lista conhecida).
    globalThis.__ultimosDestinosInternosConhecidos = ["10.1.2.7"];
    const db = fakeDb({ [ORG_LOCAL]: { prospecting: { provider: "local-http" } } });
    observarRun(db);
    const urls = engine({});

    await createSearch(
      db.pool as never,
      {} as never,
      ORG_LOCAL,
      "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb",
      BUSCA,
    );

    expect(urls.every((u) => u.startsWith("http://10.1.2.7:8080"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/api/v1/scrape"))).toBe(true);
  });

  it("a régua da credencial é o health check do engine da instalação, e NADA é gravado", async () => {
    const db = fakeDb({ [ORG_LOCAL]: { prospecting: { provider: "local-http" } } });
    const urls = engine({});

    // A organização manda o valor que quiser: ele é IGNORADO (a URL da instalação vale).
    await configureCredential(db.pool as never, {} as never, ORG_LOCAL, "https://isca.test");

    expect(urls).toEqual([`${ENGINE}/api/v1/health`]);
    // Não há segredo por organização no local-http: o `configure` só valida.
    expect(
      db.log.some((q) =>
        q.sql.includes("prospecting_settings(organization_id,credential_encrypted)"),
      ),
    ).toBe(false);

    // Engine no ar mas sem confirmar: fecha fechado e NÃO grava a credencial.
    vi.clearAllMocks();
    const dbRuim = fakeDb({ [ORG_LOCAL]: { prospecting: { provider: "local-http" } } });
    engine({ health: () => new Response("indisponível", { status: 503 }) });

    const falha = await configureCredential(
      dbRuim.pool as never,
      {} as never,
      ORG_LOCAL,
      "https://isca.test",
    ).catch((e: unknown) => e);
    expect(falha).toBeInstanceOf(ProspectingError);
    expect(dbRuim.log.some((q) => q.sql.includes("prospecting_settings(organization_id"))).toBe(
      false,
    );
  });

  it("organização sem escolha nenhuma continua na Apify, com a mesma validação de users/me", async () => {
    const db = fakeDb({ [ORG_SEM_ESCOLHA]: null });
    observarRun(db);
    // A credencial guardada desta organização é a chave da Apify — não a URL do engine.
    credencialDaOrg = "chave-apify";
    fetch.mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "run-apify", status: "RUNNING" } })),
    );

    await configureCredential(db.pool as never, {} as never, ORG_SEM_ESCOLHA, "chave-apify");
    expect(fetch.mock.calls[0]![0]).toBe("https://api.apify.com/v2/users/me");
    // E a credencial da organização É gravada (a Apify tem segredo por organização).
    expect(
      db.log.some((q) => q.sql.includes("prospecting_settings(organization_id,credential_encrypted)")),
    ).toBe(true);

    await createSearch(
      db.pool as never,
      {} as never,
      ORG_SEM_ESCOLHA,
      "88888888-8888-4888-8888-888888888888",
      BUSCA,
    );
    const [url, init] = fetch.mock.calls.at(-1)!;
    expect(String(url)).toContain("https://api.apify.com/v2/acts/");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer chave-apify" });
  });

  it("sob NODE_ENV=production o local-http segue disponível, ao contrário do provedor 'teste'", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const db = fakeDb({
      [ORG_LOCAL]: { prospecting: { provider: "local-http" } },
      [ORG_SEM_ESCOLHA]: { prospecting: { provider: "teste" } },
    });
    observarRun(db);
    engine({});

    const campanha = await createSearch(
      db.pool as never,
      {} as never,
      ORG_LOCAL,
      "55555555-5555-4555-8555-555555555555",
      BUSCA,
    );
    expect(campanha.run_id).toBe("job-1");

    const falha = await createSearch(
      db.pool as never,
      {} as never,
      ORG_SEM_ESCOLHA,
      "66666666-6666-4666-8666-666666666666",
      BUSCA,
    ).catch((e: unknown) => e);
    expect(falha).toBeInstanceOf(ProspectingError);
    expect((falha as Error).message).toContain("desconhecido");
  });

  it("synchronizeSearch lê a busca e os resultados pelo engine, e os itens viram candidatos", async () => {
    const db = fakeDb({ [ORG_LOCAL]: { prospecting: { provider: "local-http" } } });
    const urls = engine({});

    await synchronizeSearch(db.client as never, {} as never, campanhaDoEngine(ORG_LOCAL) as never);

    expect(urls.some((u) => u.includes("api.apify.com"))).toBe(false);
    expect(urls).toContain(`${ENGINE}/api/v1/jobs/job-1`);
    const candidatos = db.log.filter((q) => q.sql.startsWith("insert into prospecting_candidates"));
    expect(candidatos).toHaveLength(BUSCA.limit);
    expect(db.log.some((q) => q.sql.includes("search_status='succeeded'"))).toBe(true);
  });

  it("estado terminal COM FALHA do engine vira search_status='failed'", async () => {
    const db = fakeDb({ [ORG_LOCAL]: { prospecting: { provider: "local-http" } } });
    engine({
      job: (id) =>
        new Response(JSON.stringify({ job_id: id, status: "failed", results: [] }), {
          status: 200,
        }),
    });

    await synchronizeSearch(db.client as never, {} as never, campanhaDoEngine(ORG_LOCAL) as never);

    const fechamento = db.log.find((q) => q.sql.includes("search_status='failed'"));
    expect(fechamento).toBeDefined();
    expect(String(fechamento!.params?.[2])).toContain("FAILED");
    // Estado terminal NÃO insere candidato nenhum nem marca sucesso.
    expect(db.log.some((q) => q.sql.startsWith("insert into prospecting_candidates"))).toBe(false);
    expect(db.log.some((q) => q.sql.includes("search_status='succeeded'"))).toBe(false);
  });

  it("estado 'cancelled' também é terminal COM FALHA", async () => {
    const db = fakeDb({ [ORG_LOCAL]: { prospecting: { provider: "local-http" } } });
    engine({
      job: (id) =>
        new Response(JSON.stringify({ job_id: id, status: "cancelled", results: [] }), {
          status: 200,
        }),
    });

    await synchronizeSearch(db.client as never, {} as never, campanhaDoEngine(ORG_LOCAL) as never);

    const fechamento = db.log.find((q) => q.sql.includes("search_status='failed'"));
    expect(fechamento).toBeDefined();
    expect(String(fechamento!.params?.[2])).toContain("FAILED");
  });

  it("engine fora do ar e URL inválida falham FECHADO como ProspectingError", async () => {
    const db = fakeDb({ [ORG_LOCAL]: { prospecting: { provider: "local-http" } } });
    observarRun(db);

    // Engine fora do ar: o provedor fecha com 502, não com o erro cru do fetch.
    fetch.mockRejectedValue(new Error("ECONNREFUSED"));
    const provedor = await provedorDaOrganizacao(db.pool as never, ORG_LOCAL);
    const foraDoAr = await provedor.startSearch("", BUSCA).catch((e: unknown) => e);
    expect(foraDoAr).toBeInstanceOf(ProspectingError);
    expect((foraDoAr as ProspectingError).status).toBe(502);
    expect((foraDoAr as ProspectingError).escopo).toBe("campanha");

    // E na busca a falha vira campanha em estado desconhecido, com o motivo gravado —
    // o comportamento de sempre do `store.ts`, que esta fatia não muda.
    const campanha = await createSearch(
      db.pool as never,
      {} as never,
      ORG_LOCAL,
      "99999999-9999-4999-8999-999999999999",
      BUSCA,
    );
    expect(campanha.search_status).toBe("unknown");
    expect(String(campanha.error)).toContain("não respondeu");
    expect(fetch.mock.calls.every((c) => !String(c[0]).includes("api.apify.com"))).toBe(true);

    // URL sem esquema (o erro de digitação mais provável de quem digita "localhost:8080").
    vi.clearAllMocks();
    const dbRuim = fakeDb({ [ORG_LOCAL]: { prospecting: { provider: "local-http" } } });
    vi.stubEnv("PROSPECTING_LOCAL_HTTP_URL", "localhost:8080");
    fetch.mockRejectedValue(new Error("a rede não deve ser usada"));

    const provedorRuim = await provedorDaOrganizacao(dbRuim.pool as never, ORG_LOCAL);
    const urlInvalida = await provedorRuim.startSearch("", BUSCA).catch((e: unknown) => e);
    expect(urlInvalida).toBeInstanceOf(ProspectingError);
    expect((urlInvalida as ProspectingError).status).toBe(422);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("o provedor de teste continua FORA de produção e o contrato de 3 métodos não muda", () => {
    expect(Object.keys(provedorDeTeste).sort()).toEqual([
      "readResults",
      "readSearch",
      "startSearch",
    ]);
  });
});
