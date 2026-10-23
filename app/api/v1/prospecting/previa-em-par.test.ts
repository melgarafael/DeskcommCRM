/**
 * PROVA EM PAR (B2): a prévia que a PESSOA pede (clique → rota `prever_abordagem`)
 * e a que o SISTEMA gera sozinho (preparo automático, a cada minuto) chegam ao
 * modelo com os MESMOS argumentos, para o MESMO candidato. Se divergirem, a tela
 * mostra uma copy e o envio usa outra — e o operador revisou o que não sai.
 *
 * Lei: `docs/doctrine/prova-em-par.md`. Os dois lados chamam
 * `gerarPreviaDoCandidato` (`lib/prospecting/previa-gerar.ts`); este teste mede
 * o que realmente chegou em `gerarAbordagemDeFormulario`, não que a função existe.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({
  pool: vi.fn(),
  generate: vi.fn(),
  enriquecer: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: deps.pool }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/prospecting/store", () => ({
  activateCampaign: vi.fn(),
  configureCredential: vi.fn(),
  createSearch: vi.fn(),
  validateConfig: vi.fn(),
  withProspectingLock: vi.fn(),
}));
vi.mock("@/lib/prospecting/site-enrich", () => ({ enriquecerSitesPendentes: deps.enriquecer }));
vi.mock("@/lib/agent-engine/agent/abordagem-de-formulario", () => ({
  gerarAbordagemDeFormulario: deps.generate,
}));

import { POST } from "./route";
import { requireRole } from "@/lib/auth/require-role";
import { prepararCandidatos } from "@/lib/prospecting/preparo";

const ORG = "99999999-9999-4999-8999-999999999999";
const CAMPANHA = "22222222-2222-4222-8222-222222222222";
const CANDIDATO = "33333333-3333-4333-8333-333333333333";
const CONTATO = "44444444-4444-4444-8444-444444444444";
const AGENTE = "55555555-5555-4555-8555-555555555555";
const CONFIG = {
  agent_id: AGENTE,
  channel_session_id: "66666666-6666-4666-8666-666666666666",
  pipeline_id: "77777777-7777-4777-8777-777777777777",
  stage_id: "88888888-8888-4888-8888-888888888888",
  qualified_stage_id: "99999999-9999-4999-8999-999999999998",
  instruction: "Apresente a clínica com educação.",
  qualification: "Tem interesse em agendar avaliação.",
  daily_limit: 10,
  interval_minutes: 15,
  legal_basis_ref: "legítimo interesse, registro 1",
};
const SITE_OK = {
  ver: 1,
  classe: "site-ok",
  problemas: [],
  checklist: { tem: ["tel"], falta: [] },
  final_url: "https://vitta.test/",
  http_status: 200,
  tempo_ms: 300,
  conteudo_resumo: "Clínica de estética com agenda online.",
  pagespeed: null,
  verificado_em: "2026-10-10T12:00:00.000Z",
  provisorio: false,
  tentativas: 0,
};
const DADOS = {
  name: "Clínica Vitta",
  category: "Estética",
  address: "Rua X",
  website: "https://vitta.test/",
  rating: 4.8,
  reviews: 120,
  emails: [],
  socials: ["https://instagram.com/vitta"],
  site: SITE_OK,
};
const SEARCH = { niche: "clínica", avaliar_site: true, gerar_previa: true };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u-1", idioma: "pt" },
    org: { orgId: ORG },
  } as never);
  deps.generate.mockResolvedValue({ ok: true, texto: "Olá! Vi o site de vocês." });
  deps.enriquecer.mockResolvedValue({ enriquecidos: 0, classes: {} });
});

async function viaRota(dados: Record<string, unknown>, contactId: string | null) {
  deps.pool.mockReturnValue({
    query: async (sql: string) =>
      sql.includes("from prospecting_candidates")
        ? {
            rows: [
              {
                id: CANDIDATO,
                data: dados,
                status: "queued",
                contact_id: contactId,
                config: CONFIG,
                search: SEARCH,
              },
            ],
          }
        : { rows: [] },
  });
  const res = await POST(
    new NextRequest("http://localhost/api/v1/prospecting", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "prever_abordagem", id: CAMPANHA, candidate_id: CANDIDATO }),
    }),
  );
  expect(res.status).toBe(200);
  return deps.generate.mock.calls.at(-1)![2];
}

async function viaPreparo(dados: Record<string, unknown>, contactId: string | null) {
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (sql.includes("from prospecting_campaigns"))
        return { rows: [{ id: CAMPANHA, config: CONFIG, search: SEARCH }] };
      if (sql.startsWith("select") && sql.includes("from prospecting_candidates"))
        return {
          rows: [
            {
              id: CANDIDATO,
              data: dados,
              status: "queued",
              selected: true,
              contact_id: contactId,
            },
          ],
        };
      void params;
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  const pool = { connect: async () => client, query: vi.fn(async () => ({ rows: [] })) };
  const r = await prepararCandidatos(pool as never, {} as never, ORG, "req", Date.now() + 60_000);
  expect(r.previas).toBe(1);
  return deps.generate.mock.calls.at(-1)![2];
}

describe("prova em par: rota (clique) × preparo (tick)", () => {
  it.each([
    ["candidato sem contato", null],
    ["candidato com contato", CONTATO],
  ])("%s: o modelo recebe exatamente os mesmos argumentos", async (_nome, contactId) => {
    const rota = await viaRota(DADOS, contactId);
    deps.generate.mockClear();
    const preparo = await viaPreparo(DADOS, contactId);
    expect(preparo).toEqual(rota);
    // Garantia de que o `toEqual` não passou por vazio: os campos que importam existem.
    const args = preparo as { instrucao: string; dados: Record<string, string>; leadId: unknown };
    expect(args.instrucao).toContain("Estratégia de abordagem definida para este lead");
    expect(args.dados["Auditoria"]).toContain("verificado em 10/10/2026");
    expect(args.leadId).toBe(contactId);
  });

  it("sem site (derivado): mesmos argumentos nos dois lados", async () => {
    const semSite = { ...DADOS, website: null, site: null };
    const rota = await viaRota(semSite, null);
    deps.generate.mockClear();
    expect(await viaPreparo(semSite, null)).toEqual(rota);
  });

  it("nenhum dos dois lados manda 'Rascunho de abordagem' — a prévia gera do zero", async () => {
    const comPrevia = {
      ...DADOS,
      previa: {
        texto: "RASCUNHO-ANTIGO",
        baseada_em: `site-ok@${SITE_OK.verificado_em}`,
        gerada_em: "2026-10-10T00:00:00.000Z",
        agente_id: AGENTE,
      },
    };
    const rota = (await viaRota(comPrevia, null)) as { dados: Record<string, string> };
    expect(rota.dados["Rascunho de abordagem"]).toBeUndefined();
    // O preparo só olha candidato SEM prévia; para medir o lado dele com os mesmos
    // dados, tira-se a prévia (o argumento ao modelo não depende dela).
    deps.generate.mockClear();
    const preparo = (await viaPreparo(DADOS, null)) as { dados: Record<string, string> };
    expect(preparo.dados["Rascunho de abordagem"]).toBeUndefined();
    expect(JSON.stringify(preparo)).not.toContain("RASCUNHO-ANTIGO");
  });
});
