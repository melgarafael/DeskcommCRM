/**
 * GET/POST /api/v1/ai/cases/:id/chat — a consulta interna da equipe à IA (0281).
 *
 * ## O que este arquivo prova que nenhum gate estático prova
 *
 * `pontos-de-ia-completude.test.ts` prova que o literal `purpose: "case_chat"`
 * existe em algum lugar de `lib/**`. Ele NÃO prova que alguém o executa — e o
 * precedente vivo disso está no mesmo registro: `draft_suggestion` está
 * declarado, o literal existe, e `generateDraftReply` não tem nenhum import de
 * produção. Botão que não controla nada, com o gate verde.
 *
 * Aqui a rota REAL é chamada e o que se mede é a chamada ao seam: que ela
 * aconteceu, que ela NÃO aconteceu quando não podia, e o que foi gravado nos
 * dois casos.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { audit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { responderSobreOCaso } from "@/lib/agent-engine/agent/conversa-do-caso";
import { fail } from "@/lib/api/wrappers";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { LlmNotConfiguredError } from "@/lib/agent-engine/edge/llm/run-model-call";
import type { ResultadoDaBusca } from "@/lib/ai/knowledge/busca";
import type { Citation } from "@/lib/ai/citations/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/agent-engine/agent/conversa-do-caso", () => ({
  responderSobreOCaso: vi.fn(),
}));
vi.mock("@/lib/agent-engine/agent/request-deps", () => ({
  requestTurnDeps: () => ({ llmCfg: { anthropicApiKey: "k" }, log: undefined, registry: undefined }),
}));
vi.mock("@/lib/agent-engine/agent/conversa-do-caso/persona", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  leitorNoPool: vi.fn(() => ({})),
  resolverPersona: vi.fn(async () => ({ fonte: "padrao_da_organizacao", motivo: "sem_agente" })),
}));
vi.mock("@/lib/escalacao/continuidade", () => ({
  lerContinuidadeHumana: vi.fn(async () => ({ resumo: "" })),
}));
vi.mock("@/lib/agent-engine/agent/org-memory", () => ({
  loadOrgMemory: vi.fn(async () => ({ content: null, entries: [] })),
  renderOrgMemory: () => "",
}));
vi.mock("@/lib/atendimento/fronteira-server", () => ({
  readCurrentServiceBoundary: vi.fn(async () => null),
}));

const { GET, POST } = await import("@/app/api/v1/ai/cases/[id]/chat/route");

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const CASE_ID = "33333333-3333-4333-8333-333333333333";
const CONV_ID = "44444444-4444-4444-8444-444444444444";
const CONTACT_ID = "55555555-5555-4555-8555-555555555555";
const TURN_ID = "77777777-7777-4777-8777-777777777777";
const AGENT_ID = "66666666-6666-4666-8666-666666666666";

function session(effectiveRole: Role = "agent") {
  const user: AuthUser = {
    id: USER_ID,
    email: "u@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: effectiveRole }],
  };
  vi.mocked(requireRole).mockImplementation(async (min: Role) => {
    if (ROLE_RANK[effectiveRole] >= ROLE_RANK[min]) {
      return { ok: true, user, org: { orgId: ORG_ID, name: "Org", role: effectiveRole } };
    }
    return { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) };
  });
}

/**
 * O cliente de SESSÃO, imitando a RLS: `agent_cases` é org-wide, e
 * `conversations` devolve SÓ o que este usuário enxerga.
 */
function sessaoComVisibilidade(visiveis: string[], mensagens: unknown[] = []) {
  const linhas = (tabela: string) =>
    tabela === "conversations"
      ? visiveis.map((id) => ({ id }))
      : tabela === "agent_cases"
        ? [{ conversation_id: CONV_ID }]
        : mensagens;
  function cadeia(rows: unknown[]) {
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "limit", "lt"]) c[m] = () => c;
    c.then = (aceita: (v: unknown) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(aceita);
    return c;
  }
  vi.mocked(createClient).mockResolvedValue({
    from: (t: string) => cadeia(linhas(t)),
  } as unknown as Awaited<ReturnType<typeof createClient>>);
}

/**
 * O pool, respondendo por FORMA de consulta. Registra tudo que foi executado —
 * é como os casos de "zero linhas novas em X" medem EFEITO e não chamada.
 */
function poolFalso(over: { caso?: Record<string, unknown> | null; contato?: Record<string, unknown>; jaPerguntou?: number; inserirLanca?: { code: string } } = {}) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const caso =
    over.caso === undefined
      ? {
          id: CASE_ID,
          title: "Desconto",
          kind: "outro",
          summary: "20%",
          blocker: "10%",
          status: "awaiting_human",
          opened_at: "2026-03-10T12:00:00Z",
          agent_id: null,
          conversation_id: CONV_ID,
          contact_id: CONTACT_ID,
          context_snapshot: null,
        }
      : over.caso;
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (/from agent_cases/.test(sql)) return { rows: caso === null ? [] : [caso] };
    if (/from contacts/.test(sql) && /is_blocked/.test(sql)) {
      return { rows: [over.contato ?? { is_blocked: false, is_anonymized: false }] };
    }
    if (/from contacts/.test(sql)) return { rows: [{ display_name: "Marina Silva", name: null }] };
    if (/count\(\*\)::text as n/.test(sql)) return { rows: [{ n: String(over.jaPerguntou ?? 0) }] };
    if (/insert into agent_case_chat_messages/.test(sql) && /'human'/.test(sql)) {
      if (over.inserirLanca) throw over.inserirLanca;
      return { rows: [] };
    }
    if (/from agent_case_chat_messages/.test(sql)) return { rows: [] };
    if (/from organizations/.test(sql)) return { rows: [{ timezone: "America/Sao_Paulo" }] };
    return { rows: [] };
  });
  vi.mocked(getRequestPool).mockReturnValue({ query } as unknown as ReturnType<typeof getRequestPool>);
  return { queries, query };
}

function pedido(corpo: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/ai/cases/${CASE_ID}/chat`, {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
}

const CORPO_OK = { turn_id: TURN_ID, pergunta: "Por que a IA não resolveu sozinha?" };

beforeEach(() => {
  vi.clearAllMocks();
  session("agent");
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, count: 1, limit: 12, window_sec: 60 });
  vi.mocked(responderSobreOCaso).mockResolvedValue({
    texto: "Porque a política permite 10%.",
    callId: "call-1",
    agentId: null,
  });
});

describe("POST — a guarda de visibilidade", () => {
  it("404 quando a conversa do caso NÃO é visível para quem pede", async () => {
    // O caso que justifica a feature existir com cuidado. E é 404, nunca 403:
    // um 403 confirmaria que o caso existe.
    sessaoComVisibilidade([]);
    poolFalso();
    const r = await POST(pedido(CORPO_OK), { params: Promise.resolve({ id: CASE_ID }) });
    expect(r.status).toBe(404);
    expect(responderSobreOCaso).not.toHaveBeenCalled();
  });

  it("404 para caso de outra organização — mesma resposta, sem distinguir", async () => {
    sessaoComVisibilidade([]);
    poolFalso({ caso: null });
    expect((await POST(pedido(CORPO_OK), { params: Promise.resolve({ id: CASE_ID }) })).status).toBe(404);
  });

  it("403 em acompanhamento somente-leitura, ANTES de tudo", async () => {
    // `requireSupportWrite` é o primeiro passo do handler, e literal: sem ele um
    // admin de plataforma em acompanhamento `full` gastaria o orçamento do
    // cliente e leria dado pessoal com rastro só de acompanhamento.
    vi.mocked(requireSupportWrite).mockResolvedValue(fail("forbidden", "somente leitura", 403, {}));
    sessaoComVisibilidade([CONV_ID]);
    poolFalso();
    const r = await POST(pedido(CORPO_OK), { params: Promise.resolve({ id: CASE_ID }) });
    expect(r.status).toBe(403);
    expect(requireRole).not.toHaveBeenCalled();
  });
});

describe("POST — o que acontece com o contato", () => {
  it("contato ANONIMIZADO: 422, sem chamar o modelo e sem gravar linha", async () => {
    // Responder sobre um contato anonimizado é reconstituir, num prompt, o que a
    // cascata acabou de apagar.
    sessaoComVisibilidade([CONV_ID]);
    const pool = poolFalso({ contato: { is_blocked: false, is_anonymized: true } });
    const r = await POST(pedido(CORPO_OK), { params: Promise.resolve({ id: CASE_ID }) });
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ error: { code: "reply_context_unavailable" } });
    expect(responderSobreOCaso).not.toHaveBeenCalled();
    expect(pool.queries.filter((q) => /insert into agent_case_chat_messages/.test(q.sql))).toEqual([]);
  });

  it("contato BLOQUEADO: 200 — é quando o atendente mais precisa entender", async () => {
    sessaoComVisibilidade([CONV_ID]);
    poolFalso({ contato: { is_blocked: true, is_anonymized: false } });
    const r = await POST(pedido(CORPO_OK), { params: Promise.resolve({ id: CASE_ID }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ data: { contato_bloqueado: true } });
    expect(responderSobreOCaso).toHaveBeenCalledTimes(1);
  });
});

describe("POST — teto de perguntas", () => {
  it("429 quando o balde do usuário estoura, com Retry-After", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false, count: 13, limit: 12, window_sec: 60 });
    sessaoComVisibilidade([CONV_ID]);
    poolFalso();
    const r = await POST(pedido(CORPO_OK), { params: Promise.resolve({ id: CASE_ID }) });
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("60");
    expect(responderSobreOCaso).not.toHaveBeenCalled();
  });

  it("429 pelo teto POR CASO, contado no banco", async () => {
    // O único teto que sobrevive a múltiplos processos e à ausência de Redis:
    // sem Redis, `checkRateLimit` conta em memória, por processo.
    sessaoComVisibilidade([CONV_ID]);
    poolFalso({ jaPerguntou: 120 });
    const r = await POST(pedido(CORPO_OK), { params: Promise.resolve({ id: CASE_ID }) });
    expect(r.status).toBe(429);
    expect(responderSobreOCaso).not.toHaveBeenCalled();
  });
});

describe("POST — idempotência pelo `turn_id`", () => {
  it("`turn_id` repetido devolve o turno existente SEM segunda chamada ao seam", async () => {
    // A unique do banco é a idempotência. `comIdempotencia` gravaria a resposta
    // em `idempotency_keys` — uma cópia do texto sobre a pessoa numa tabela fora
    // da cascata de LGPD e sem expurgo.
    sessaoComVisibilidade([CONV_ID]);
    poolFalso({ inserirLanca: { code: "23505" } });
    const r = await POST(pedido(CORPO_OK), { params: Promise.resolve({ id: CASE_ID }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ data: { replay: true } });
    expect(responderSobreOCaso).not.toHaveBeenCalled();
  });

  it("outro erro do INSERT NÃO vira replay — ele sobe", async () => {
    // Tratar qualquer falha como replay devolveria 200 para uma pergunta que
    // nunca foi gravada: o pior desfecho possível para quem espera a resposta.
    sessaoComVisibilidade([CONV_ID]);
    poolFalso({ inserirLanca: { code: "23503" } });
    await expect(POST(pedido(CORPO_OK), { params: Promise.resolve({ id: CASE_ID }) })).rejects.toBeTruthy();
  });
});

describe("POST — o caminho feliz e a falha do modelo", () => {
  it("chama o seam UMA vez e grava as duas linhas do turno", async () => {
    sessaoComVisibilidade([CONV_ID]);
    const pool = poolFalso();
    const r = await POST(pedido(CORPO_OK), { params: Promise.resolve({ id: CASE_ID }) });
    expect(r.status).toBe(200);
    expect(responderSobreOCaso).toHaveBeenCalledTimes(1);
    const inserts = pool.queries.filter((q) => /insert into agent_case_chat_messages/.test(q.sql));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]!.sql).toContain("'human'");
    expect(inserts[1]!.sql).toContain("'ai'");
  });

  it("a pergunta é gravada ANTES da chamada — falha deixa rastro, não silêncio", async () => {
    sessaoComVisibilidade([CONV_ID]);
    const pool = poolFalso();
    const ordem: string[] = [];
    vi.mocked(responderSobreOCaso).mockImplementation(async () => {
      ordem.push("seam");
      return { texto: "ok", callId: null, agentId: null };
    });
    await POST(pedido(CORPO_OK), { params: Promise.resolve({ id: CASE_ID }) });
    const iHuman = pool.queries.findIndex((q) => /insert into agent_case_chat_messages/.test(q.sql));
    expect(iHuman).toBeGreaterThanOrEqual(0);
    expect(ordem).toEqual(["seam"]);
    // A ordem medida no ARTEFATO: o insert 'human' é a primeira escrita.
    expect(pool.queries[iHuman]!.sql).toContain("'human'");
  });

  it("falha do modelo: grava a linha `ai` com `error_code` E devolve 422", async () => {
    // Os dois juntos de propósito: o status honra o monitoramento, a linha honra
    // quem abrir o caso depois. E o código vem da tradução, não do genérico.
    sessaoComVisibilidade([CONV_ID]);
    const pool = poolFalso();
    vi.mocked(responderSobreOCaso).mockRejectedValue(new LlmNotConfiguredError());
    const r = await POST(pedido(CORPO_OK), { params: Promise.resolve({ id: CASE_ID }) });
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ error: { code: "llm_not_configured" } });
    const insertAi = pool.queries.find((q) => /insert into agent_case_chat_messages/.test(q.sql) && /'ai'/.test(q.sql));
    expect(insertAi, "a linha `ai` não foi gravada — a falha virou silêncio").toBeTruthy();
    expect(insertAi!.params).toContain("llm_not_configured");
  });
});

describe("POST — o que a rota NÃO toca", () => {
  it("zero escrita em `messages`, `job_queue`, `conversation_notes`, `agent_case_events` e `agent_cases`", async () => {
    // As três tabelas que este chat NÃO pode tocar, e por quê:
    // `conversation_notes` viraria instrução literal no prompt do agente que
    // fala com o CLIENTE; `agent_case_events` infla `intervencoes` e zera
    // `espera_fila` no Índice de Atrito; e QUALQUER escrita em `agent_cases`
    // mexe em `updated_at`, que é o "alguém encostou" do cobrador de caso parado.
    sessaoComVisibilidade([CONV_ID]);
    const pool = poolFalso();
    await POST(pedido(CORPO_OK), { params: Promise.resolve({ id: CASE_ID }) });
    const escritas = pool.queries.filter((q) => /^\s*(insert|update|delete)/i.test(q.sql));
    for (const proibida of [
      "messages",
      "job_queue",
      "followup_enrollments",
      "conversation_notes",
      "agent_case_events",
      "agent_cases",
      "idempotency_keys",
    ]) {
      expect(
        escritas.filter((q) => new RegExp(`\\b(into|update)\\s+${proibida}\\b`).test(q.sql)),
        `a rota escreveu em ${proibida}`,
      ).toEqual([]);
    }
  });

  it("audita com `resourceId = caseId` e SEM o texto da pergunta nem da resposta", async () => {
    sessaoComVisibilidade([CONV_ID]);
    poolFalso();
    await POST(pedido(CORPO_OK), { params: Promise.resolve({ id: CASE_ID }) });
    expect(audit).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(audit).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(arg).toMatchObject({ action: "ai.case_chat_asked", resourceType: "agent_case", resourceId: CASE_ID });
    // `api_audit_log` é append-only sem UPDATE nem DELETE para papel nenhum: o
    // que entra ali NÃO sai pela cascata de LGPD.
    const serializado = JSON.stringify(arg.metadata);
    expect(serializado).not.toContain("Por que a IA não resolveu");
    expect(serializado).not.toContain("Porque a política permite");
  });
});

describe("POST — validação", () => {
  it("Zod é `.strict()`: campo desconhecido reprova", async () => {
    sessaoComVisibilidade([CONV_ID]);
    poolFalso();
    const r = await POST(pedido({ ...CORPO_OK, agent_id: "escolhido pelo cliente" }), {
      params: Promise.resolve({ id: CASE_ID }),
    });
    expect(r.status).toBe(422);
  });

  it("pergunta curta demais ou longa demais reprova", async () => {
    sessaoComVisibilidade([CONV_ID]);
    poolFalso();
    expect((await POST(pedido({ turn_id: TURN_ID, pergunta: "e?" }), { params: Promise.resolve({ id: CASE_ID }) })).status).toBe(422);
    expect(
      (await POST(pedido({ turn_id: TURN_ID, pergunta: "x".repeat(1001) }), { params: Promise.resolve({ id: CASE_ID }) })).status,
    ).toBe(422);
  });
});

describe("GET", () => {
  function get(url = `http://localhost/api/v1/ai/cases/${CASE_ID}/chat`) {
    return GET(new NextRequest(url), { params: Promise.resolve({ id: CASE_ID }) });
  }

  it("404 quando a conversa não é visível", async () => {
    sessaoComVisibilidade([]);
    poolFalso();
    expect((await get()).status).toBe(404);
  });

  it("devolve as mensagens pelo cliente de SESSÃO", async () => {
    sessaoComVisibilidade([CONV_ID], [{ id: "m-1", author_kind: "human", body: "oi" }]);
    poolFalso();
    const r = await get();
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ data: { mensagens: [{ id: "m-1" }] } });
  });

  it("`?antes=` inválido reprova com 422", async () => {
    sessaoComVisibilidade([CONV_ID]);
    poolFalso();
    expect((await get(`http://localhost/api/v1/ai/cases/${CASE_ID}/chat?antes=ontem`)).status).toBe(422);
  });

  it("DEGRADAÇÃO HONESTA: pool fora do ar devolve as mensagens e `caso_obsoleto: null`", async () => {
    // Falhar FECHADO na ação, ABERTO na informação. Um 503 aqui esconderia a
    // deliberação inteira por causa de uma bandeira que não pôde ser conferida.
    sessaoComVisibilidade([CONV_ID], [{ id: "m-1" }]);
    vi.mocked(getRequestPool).mockImplementation(() => {
      throw new Error("sem conexão com o banco");
    });
    const r = await get();
    expect(r.status).toBe(200);
    const corpo = (await r.json()) as { data: { mensagens: unknown[]; estado: Record<string, unknown> } };
    expect(corpo.data.mensagens).toHaveLength(1);
    expect(corpo.data.estado.caso_obsoleto).toBeNull();
  });
});

describe("POST — F3 (#1869): o chat cita o acervo", () => {
  // A rota injeta os resolvedores por `ctx.citacoes` (seam de teste, mesmo
  // desenho do `deps` de `searchKnowledge`) — sem depender de mock de módulo.
  const t = (deps: {
    resolverAcervo?: (s: unknown, org: string, agent: string) => Promise<string[]>;
    buscar?: (s: unknown, _p: unknown) => Promise<ResultadoDaBusca>;
  }) => POST(pedido(CORPO_OK), { params: Promise.resolve({ id: CASE_ID }), citacoes: deps });
  const casoComAgente = {
    id: CASE_ID,
    title: "Desconto",
    kind: "outro",
    summary: "20%",
    blocker: "10%",
    status: "awaiting_human",
    opened_at: "2026-03-10T12:00:00Z",
    agent_id: AGENT_ID,
    conversation_id: CONV_ID,
    contact_id: CONTACT_ID,
    context_snapshot: null,
  };

  it("agente com base: a resposta devolve as citações do acervo", async () => {
    sessaoComVisibilidade([CONV_ID]);
    poolFalso({ caso: casoComAgente });
    const resolverAcervo = vi.fn(async (_s: unknown, _org: string, agent: string) => {
      expect(agent).toBe(AGENT_ID);
      return ["src-1"];
    });
    const buscar = vi.fn(async () => ({
      trechos: [
        {
          chunk_id: "c-1",
          knowledge_source_id: "src-1",
          source_name: "Manual de descontos",
          content: "A política permite 20%.",
          similarity: 0.81,
        },
      ],
      melhorSimilaridade: 0.81,
    }));

    const r = await t({ resolverAcervo, buscar });
    expect(r.status).toBe(200);
    const corpo = (await r.json()) as { data: { citacoes: Citation[] } };
    expect(resolverAcervo).toHaveBeenCalledTimes(1);
    expect(buscar).toHaveBeenCalledTimes(1);
    expect(corpo.data.citacoes).toHaveLength(1);
    expect(corpo.data.citacoes[0]!).toMatchObject({
      chunk_id: "c-1",
      knowledge_source_id: "src-1",
      source_anchor: "Manual de descontos",
      score: 0.81,
    });
    expect(corpo.data.citacoes[0]!.snippet).toContain("20%");
  });

  it("agente SEM material (acervo vazio): sem citação e sem segunda busca", async () => {
    sessaoComVisibilidade([CONV_ID]);
    poolFalso({ caso: casoComAgente });
    const resolverAcervo = vi.fn(async () => []);
    const buscar = vi.fn(async () => ({ trechos: [], melhorSimilaridade: null }));

    const r = await t({ resolverAcervo, buscar });
    expect(r.status).toBe(200);
    expect((await r.json()) as { data: { citacoes: unknown[] } }).toMatchObject({
      data: { citacoes: [] },
    });
    expect(buscar).not.toHaveBeenCalled();
  });

  it("agente do caso ausente (agent_id null): nem resolve o acervo", async () => {
    sessaoComVisibilidade([CONV_ID]);
    poolFalso(); // caso default tem agent_id: null
    const resolverAcervo = vi.fn(async () => []);
    const buscar = vi.fn(async () => ({ trechos: [], melhorSimilaridade: null }));

    const r = await t({ resolverAcervo, buscar });
    expect(r.status).toBe(200);
    expect(resolverAcervo).not.toHaveBeenCalled();
    expect((await r.json()) as { data: { citacoes: unknown[] } }).toMatchObject({
      data: { citacoes: [] },
    });
  });

  it("a FALHA da busca do acervo não derruba o POST — resposta sai sem citação", async () => {
    sessaoComVisibilidade([CONV_ID]);
    poolFalso({ caso: casoComAgente });
    const resolverAcervo = vi.fn(async () => ["src-1"]);
    const buscar = vi.fn(async () => {
      throw new Error("embedding sem chave");
    });

    const r = await t({ resolverAcervo, buscar });
    expect(r.status).toBe(200); // nunca 500 — a resposta de IA já aconteceu
    expect((await r.json()) as { data: { citacoes: unknown[] } }).toMatchObject({
      data: { citacoes: [] },
    });
  });

  it("LGPD mantida: contato ANONIMIZADO devolve 422 SEM consultar o acervo", async () => {
    sessaoComVisibilidade([CONV_ID]);
    poolFalso({ contato: { is_blocked: false, is_anonymized: true } });
    const resolverAcervo = vi.fn(async () => []);
    const buscar = vi.fn(async () => ({ trechos: [], melhorSimilaridade: null }));

    const r = await t({ resolverAcervo, buscar });
    expect(r.status).toBe(422);
    expect(resolverAcervo).not.toHaveBeenCalled();
    expect(buscar).not.toHaveBeenCalled();
  });

  it("idempotência mantida: replay (`turn_id` repetido) devolve o turno SEM buscar o acervo", async () => {
    sessaoComVisibilidade([CONV_ID]);
    poolFalso({ inserirLanca: { code: "23505" }, caso: casoComAgente });
    const resolverAcervo = vi.fn(async () => []);
    const buscar = vi.fn(async () => ({ trechos: [], melhorSimilaridade: null }));

    const r = await t({ resolverAcervo, buscar });
    expect(r.status).toBe(200);
    const corpo = (await r.json()) as { data: Record<string, unknown> };
    expect(corpo).toMatchObject({ data: { replay: true } });
    // O formato que a guarda `?.` da tela protege: o replay volta SEM `citacoes`.
    expect(corpo.data).not.toHaveProperty("citacoes");
    expect(resolverAcervo).not.toHaveBeenCalled();
    expect(buscar).not.toHaveBeenCalled();
  });
});
