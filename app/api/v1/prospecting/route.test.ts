/**
 * Token `dsk_` na prospecção (#1875, #2028): só configurar, pesquisar e pausar
 * passam por token (lista de permissão); iniciar e retomar campanha seguem
 * exigindo a tela, porque enviam.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({
  validateBearerToken: vi.fn(),
  checkRateLimit: vi.fn(),
  pool: vi.fn(),
  activate: vi.fn(),
  generate: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: deps.warn, error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: deps.pool }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: deps.checkRateLimit }));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: deps.validateBearerToken };
});
vi.mock("@/lib/prospecting/store", () => ({
  activateCampaign: deps.activate,
  configureCredential: vi.fn(),
  createSearch: vi.fn(),
  validateConfig: vi.fn(),
  withProspectingLock: vi.fn(),
}));
vi.mock("@/lib/agent-engine/agent/abordagem-de-formulario", () => ({
  gerarAbordagemDeFormulario: deps.generate,
}));

import { POST } from "./route";
import { gerarAbordagemDeFormulario } from "@/lib/agent-engine/agent/abordagem-de-formulario";
import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";

const ID = "11111111-1111-4111-8111-111111111111";

function tokenPost(body: unknown) {
  return new NextRequest("http://localhost/api/v1/prospecting", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer dsk_abc" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.checkRateLimit.mockResolvedValue({ allowed: true });
  deps.pool.mockReturnValue({ query: vi.fn(async () => ({ rows: [{ id: ID }] })) });
  deps.validateBearerToken.mockResolvedValue({
    organizationId: "99999999-9999-4999-8999-999999999999",
    scopes: ["mcp:read", "mcp:write"],
    role: "admin",
    actor: { type: "api_token", id: "tok-1" },
    apiTokenId: "tok-1",
  });
});

describe("POST /api/v1/prospecting por token", () => {
  const CONFIG = {
    agent_id: ID,
    channel_session_id: ID,
    pipeline_id: ID,
    stage_id: ID,
    qualified_stage_id: ID,
    instruction: "Apresente a clínica com educação.",
    qualification: "Tem interesse em agendar avaliação.",
    legal_basis_ref: "legítimo interesse, registro 1",
  };

  it.each([
    ["start", { action: "start", id: ID, config: CONFIG }],
    ["resume", { action: "resume", id: ID }],
  ])("%s responde 403 sem tocar no banco", async (_nome, body) => {
    const res = await POST(tokenPost(body));
    expect(res.status).toBe(403);
    expect(deps.pool).not.toHaveBeenCalled();
    expect(deps.activate).not.toHaveBeenCalled();
  });

  it("pause segue aberto ao token", async () => {
    const res = await POST(tokenPost({ action: "pause", id: ID }));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/v1/prospecting prever_abordagem sem contato", () => {
  const ORG = "99999999-9999-4999-8999-999999999999";
  const CAMPANHA = "22222222-2222-4222-8222-222222222222";
  const CANDIDATO = "33333333-3333-4333-8333-333333333333";
  const CONTATO = "44444444-4444-4434-8434-444444444444";
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
    conteudo_resumo: null,
    pagespeed: null,
    verificado_em: "2026-10-10T12:00:00.000Z",
    provisorio: false,
    tentativas: 0,
  };

  function linhaDoCandidato(contact_id: string | null) {
    return {
      id: CANDIDATO,
      data: {
        name: "Clínica Vitta",
        category: "Estética",
        address: "Rua X",
        website: "https://vitta.test/",
        rating: 4.8,
        reviews: 120,
        emails: [],
        socials: [],
        site: SITE_OK,
      },
      status: "queued",
      contact_id,
      config: CONFIG,
      search: { niche: "clínica" },
    };
  }

  function previaSessao(candidate_id: string) {
    return new NextRequest("http://localhost/api/v1/prospecting", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "prever_abordagem", id: CAMPANHA, candidate_id }),
    });
  }

  beforeEach(() => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "u-1", idioma: "pt" },
      org: { orgId: ORG },
    } as never);
    deps.generate.mockResolvedValue({ ok: true, texto: "Olá! Vi o site de vocês." });
  });

  it("caso A: sem contato, leadId é null (nunca o id do candidato)", async () => {
    deps.pool.mockReturnValue({
      query: async (sql: string) =>
        sql.includes("from prospecting_candidates")
          ? { rows: [linhaDoCandidato(null)] }
          : { rows: [] },
    });
    const res = await POST(previaSessao(CANDIDATO));
    expect(res.status).toBe(200);
    expect(vi.mocked(gerarAbordagemDeFormulario)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ leadId: null }),
    );
    const chamada = vi.mocked(gerarAbordagemDeFormulario).mock.calls[0]![2] as { leadId: unknown };
    expect(chamada.leadId).not.toBe(CANDIDATO);
    expect(chamada.leadId).toBeNull();
    // A prévia deixou de ser somente leitura (B1): ela é guardada, e gravar
    // audita. O caso A continua sendo do leadId; a trilha é medida no caso C.
    const body = await res.json();
    expect(body.data.salva).toBe(true);
  });

  it("caso B: com contato, leadId é o contact_id", async () => {
    deps.pool.mockReturnValue({
      query: async (sql: string) =>
        sql.includes("from prospecting_candidates")
          ? { rows: [linhaDoCandidato(CONTATO)] }
          : { rows: [] },
    });
    const res = await POST(previaSessao(CANDIDATO));
    expect(res.status).toBe(200);
    expect(vi.mocked(gerarAbordagemDeFormulario)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ leadId: CONTATO }),
    );
  });

  it("caso C: sem site próprio (website vazio, sem veredito) deriva sem-site e responde 200", async () => {
    const base = linhaDoCandidato(null);
    deps.pool.mockReturnValue({
      query: async (sql: string) =>
        sql.includes("from prospecting_candidates")
          ? { rows: [{ ...base, data: { ...base.data, website: null, site: null } }] }
          : { rows: [] },
    });
    const res = await POST(previaSessao(CANDIDATO));
    expect(res.status).toBe(200);
    expect(vi.mocked(gerarAbordagemDeFormulario)).toHaveBeenCalled();
  });

  it("campanha SEM agente: a prévia usa o agente PADRÃO da organização (e grava o agente dele)", async () => {
    const gravados: unknown[][] = [];
    deps.pool.mockReturnValue({
      query: async (sql: string, p?: unknown[]) => {
        if (/update prospecting_candidates/.test(sql)) gravados.push(p ?? []);
        if (sql.includes("join ai_agents")) return { rows: [{ config: CONFIG }] };
        if (sql.includes("from prospecting_candidates"))
          return { rows: [{ ...linhaDoCandidato(null), config: { instruction: "busca nova" } }] };
        return { rows: [] };
      },
    });
    const res = await POST(previaSessao(CANDIDATO));
    expect(res.status).toBe(200);
    const chamada = vi.mocked(gerarAbordagemDeFormulario).mock.calls.at(-1)![2] as { agentId: string };
    expect(chamada.agentId).toBe(CONFIG.agent_id);
    expect((JSON.parse(String(gravados[0]![3])) as { agente_id: string }).agente_id).toBe(CONFIG.agent_id);
  });

  it("campanha SEM agente e SEM padrão na organização: 422 pedindo o agente", async () => {
    deps.pool.mockReturnValue({
      query: async (sql: string) =>
        sql.includes("from prospecting_candidates")
          ? { rows: [{ ...linhaDoCandidato(null), config: null }] }
          : { rows: [] },
    });
    const res = await POST(previaSessao(CANDIDATO));
    expect(res.status).toBe(422);
  });

  it("caso D: com site na web e sem veredito continua 409 (a prévia precisa da auditoria)", async () => {
    const base = linhaDoCandidato(null);
    deps.pool.mockReturnValue({
      query: async (sql: string) =>
        sql.includes("from prospecting_candidates")
          ? { rows: [{ ...base, data: { ...base.data, site: null } }] }
          : { rows: [] },
    });
    const res = await POST(previaSessao(CANDIDATO));
    expect(res.status).toBe(409);
    expect(vi.mocked(gerarAbordagemDeFormulario)).not.toHaveBeenCalled();
  });

  it("caso C: guarda a prévia no candidato e audita prospecting.preview_saved", async () => {
    const sqls: string[] = [];
    deps.pool.mockReturnValue({
      query: async (sql: string) => {
        sqls.push(sql);
        return sql.includes("from prospecting_candidates")
          ? { rows: [linhaDoCandidato(null)] }
          : { rows: [] };
      },
    });
    const res = await POST(previaSessao(CANDIDATO));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.salva).toBe(true);
    expect(body.data.mensagem).toBe("Olá! Vi o site de vocês.");
    const update = sqls.find((s) => /update prospecting_candidates/.test(s));
    expect(update, "a prévia precisa ser GRAVADA, não só devolvida").toBeTruthy();
    expect(update).toMatch(/organization_id\s*=\s*\$\d/);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "prospecting.preview_saved" }),
    );
    // A mesma estratégia que a tela mostra sobe para o agente (par com o envio).
    const chamada = vi.mocked(gerarAbordagemDeFormulario).mock.calls[0]![2] as {
      instrucao: string;
      dados: Record<string, string>;
    };
    expect(chamada.instrucao).toContain("Estratégia de abordagem definida para este lead");
    expect(chamada.instrucao).toContain("Cenário: Site ok");
  });

  it("a prévia gera DO ZERO: mesmo com prévia válida guardada, não manda o rascunho e grava o agente", async () => {
    const params: unknown[][] = [];
    deps.pool.mockReturnValue({
      query: async (sql: string, p?: unknown[]) => {
        if (/update prospecting_candidates/.test(sql)) params.push(p ?? []);
        if (!sql.includes("from prospecting_candidates")) return { rows: [] };
        const linha = linhaDoCandidato(null);
        return {
          rows: [
            {
              ...linha,
              data: {
                ...linha.data,
                previa: {
                  texto: "RASCUNHO-ANTIGO",
                  baseada_em: `${SITE_OK.classe}@${SITE_OK.verificado_em}`,
                  gerada_em: "2026-10-10T00:00:00.000Z",
                  agente_id: "11111111-1111-4111-8111-111111111111",
                },
              },
            },
          ],
        };
      },
    });
    const res = await POST(previaSessao(CANDIDATO));
    expect(res.status).toBe(200);
    const chamada = vi.mocked(gerarAbordagemDeFormulario).mock.calls.at(-1)![2] as {
      dados: Record<string, string>;
    };
    expect(chamada.dados["Rascunho de abordagem"]).toBeUndefined();
    const gravado = JSON.parse(String(params[0]![3])) as { agente_id: string };
    expect(gravado.agente_id).toBe(CONFIG.agent_id);
  });

  it("caso G: falha ao gravar é FAIL-OPEN — responde a prévia com salva:false e loga sem o texto", async () => {
    const sqls: string[] = [];
    deps.pool.mockReturnValue({
      query: async (sql: string) => {
        sqls.push(sql);
        if (sql.includes("from prospecting_candidates")) return { rows: [linhaDoCandidato(null)] };
        if (/update prospecting_candidates/.test(sql)) throw new Error("db down");
        return { rows: [] };
      },
    });
    const res = await POST(previaSessao(CANDIDATO));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.salva).toBe(false);
    expect(body.data.mensagem, "a prévia não some porque a gravação falhou").toBe(
      "Olá! Vi o site de vocês.",
    );
    // Sem mutação efetiva, sem trilha.
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
    // O log NÃO pode carregar o texto da mensagem (LGPD: conteúdo do cliente).
    expect(deps.warn).toHaveBeenCalled();
    expect(JSON.stringify(deps.warn.mock.calls)).not.toContain("Olá! Vi o site de vocês.");
  });
});
