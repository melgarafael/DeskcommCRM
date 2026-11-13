/**
 * A LINHA DO TESTE NA ABA "EXECUÇÕES" LEVA A PERGUNTA E A RESPOSTA (#4426).
 *
 * ─── O defeito medido ──────────────────────────────────────────────────────
 *
 * Quem testa uma versão do agente vê nascer uma linha em "Execuções", com
 * tokens, custo e latência — e, ao abrir, o drawer diz "Sem trace disponível."
 * A mensagem que a pessoa digitou e o que a IA respondeu só existem no
 * `TestPanel` enquanto ele está aberto: o POST `/test` montava `finalText` e o
 * devolvia no corpo, mas gravava em `ai_agent_runs` só status, data e
 * `tool_calls`. O texto morria com a próxima execução (`setResult(null)`).
 *
 * ─── Por que o teste é sobre as DUAS pontas ────────────────────────────────
 *
 * Gravar sem devolver deixa o histórico igual (o dado existe e a tela não o
 * mostra); devolver sem gravar é pior — o drawer afirmaria um texto que não foi
 * guardado. Este arquivo prende as duas:
 *  - POST `/test` — a escrita: `input_text` no INSERT e `output_text` no
 *    fechamento da linha;
 *  - GET `/runs` — a leitura: a linha do teste (dry-run) chega à tela com o
 *    texto, e a execução REAL continua sem texto (nada é emprestado entre
 *    linhas).
 *
 * A ligação entre as duas pontas é `llm_calls.preview_run_id` → `ai_agent_runs.id`:
 * a rota da aba lê `llm_calls` (é o motor que responde de verdade) e é por esse
 * id que ela busca o run de prévia que guarda o texto. Sem ele, "procurar o run
 * do teste" seria adivinhar por horário — e dois testes simultâneos do mesmo
 * agente trocariam de texto entre si.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  support: vi.fn(async () => null),
  preview: vi.fn(),
  audit: vi.fn(async () => undefined),
  admin: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.support }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.requireRole }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/agent-engine/agent/sandbox", () => ({ testAgentVersion: mocks.preview }));
vi.mock("@/lib/agent-engine/agent/request-deps", () => ({ requestTurnDeps: () => ({}) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));

import { POST } from "@/app/api/v1/ai/agents/[id]/versions/[vid]/test/route";
import { GET } from "@/app/api/v1/ai/agents/[id]/runs/route";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const VERSION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RUN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CALL_DO_TESTE = "11111111-1111-4111-8111-111111111111";
const CALL_REAL = "22222222-2222-4222-8222-222222222222";

const PERGUNTA = "Vocês entregam em Campinas no sábado?";

/** O dublê do POST: só `ai_agent_runs` é escrito, e cada escrita é registrada. */
function bancoDoTeste() {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const admin = {
    from(table: string) {
      if (table === "ai_agent_versions") {
        const filtros: Record<string, unknown> = {};
        const consulta = {
          select: () => consulta,
          eq(coluna: string, valor: unknown) {
            filtros[coluna] = valor;
            return consulta;
          },
          async maybeSingle() {
            return {
              data: { id: VERSION, agent_id: AGENT, organization_id: ORG, channel_session_id: null },
              error: null,
            };
          },
        };
        return consulta;
      }
      if (table !== "ai_agent_runs") throw new Error(`Escrita inesperada: ${table}`);
      return {
        insert(dados: Record<string, unknown>) {
          inserts.push(dados);
          return { select: () => ({ single: async () => ({ data: { id: RUN }, error: null }) }) };
        },
        update(dados: Record<string, unknown>) {
          const consulta = {
            eq() {
              return consulta;
            },
            then(resolve: (v: { error: null }) => void) {
              updates.push(dados);
              resolve({ error: null });
            },
          };
          return consulta;
        },
      };
    },
  };
  return { admin, inserts, updates };
}

/**
 * O dublê do GET: responde as duas tabelas que a rota lê.
 *
 * `ai_agent_runs` é consultada por `.in("id", [...])` — o texto do teste é
 * buscado pelos ids que as linhas de `llm_calls` apontam, e não pela organização
 * inteira.
 */
function bancoDaAba(textos: Record<string, { input_text: string | null; output_text: string | null }>) {
  const chamadas = [
    {
      id: CALL_DO_TESTE,
      organization_id: ORG,
      agent_id: AGENT,
      contact_id: null,
      purpose: "agent_preview",
      status: "ok",
      error_code: null,
      error_message: null,
      input_tokens: 100,
      output_tokens: 20,
      cost_cents: 1,
      latency_ms: 1200,
      created_at: "2026-11-12T10:00:00.000Z",
      preview_run_id: RUN,
    },
    {
      id: CALL_REAL,
      organization_id: ORG,
      agent_id: AGENT,
      contact_id: "33333333-3333-4333-8333-333333333333",
      purpose: "agent_turn",
      status: "ok",
      error_code: null,
      error_message: null,
      input_tokens: 300,
      output_tokens: 40,
      cost_cents: 2,
      latency_ms: 2000,
      created_at: "2026-11-12T09:00:00.000Z",
      preview_run_id: null,
    },
  ];
  const pedidos: Array<{ tabela: string; coluna?: string; valores?: unknown }> = [];

  const cliente = {
    from(tabela: string) {
      if (tabela === "ai_agent_runs") {
        const consulta = {
          select() {
            return consulta;
          },
          in(coluna: string, valores: unknown) {
            pedidos.push({ tabela, coluna, valores });
            return Promise.resolve({
              data: (valores as string[])
                .filter((id) => textos[id])
                .map((id) => ({ id, ...textos[id] })),
              error: null,
            });
          },
        };
        return consulta;
      }
      if (tabela !== "llm_calls") throw new Error(`Leitura inesperada: ${tabela}`);
      const consulta = {
        select() {
          return consulta;
        },
        eq() {
          return consulta;
        },
        order() {
          return consulta;
        },
        limit() {
          return consulta;
        },
        or() {
          return consulta;
        },
        then(resolve: (v: { data: unknown[]; error: null }) => void) {
          resolve({ data: chamadas, error: null });
        },
      };
      return consulta;
    },
  };
  return { cliente, pedidos };
}

const ctxDoTeste = { params: Promise.resolve({ id: AGENT, vid: VERSION }) };
const ctxDaAba = { params: Promise.resolve({ id: AGENT }) };

function requisicaoDoTeste() {
  return new NextRequest("http://localhost/api/v1/ai/agents/x/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sample_message: PERGUNTA }),
  });
}

describe("POST /test — a pergunta e a resposta ficam gravadas (#4426)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue({
      ok: true,
      user: { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", idioma: "pt-BR" },
      org: { orgId: ORG, role: "admin" },
    });
    mocks.preview.mockResolvedValue({
      candidates: [{ body: "Entregamos, sim: até as 18h." }],
      proposals: [],
      trace: [],
      midia: [],
    });
  });

  it("grava a mensagem de teste no INSERT do run", async () => {
    const db = bancoDoTeste();
    mocks.admin.mockReturnValue(db.admin);

    const resposta = await POST(requisicaoDoTeste(), ctxDoTeste);
    expect(resposta.status).toBe(200);

    // A pergunta é o que a pessoa digitou, aparada — o MESMO schema (4000) que
    // a tela usa. Sem ela, a linha do histórico não diz o que foi testado.
    expect(db.inserts).toEqual([
      expect.objectContaining({ is_dry_run: true, contact_id: null, input_text: PERGUNTA }),
    ]);
  });

  it("grava a resposta final no fechamento do run", async () => {
    const db = bancoDoTeste();
    mocks.admin.mockReturnValue(db.admin);

    await POST(requisicaoDoTeste(), ctxDoTeste);

    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]).toEqual(
      expect.objectContaining({ status: "completed", output_text: "Entregamos, sim: até as 18h." }),
    );
  });

  it("a resposta gravada é a MESMA que a tela recebeu", async () => {
    const db = bancoDoTeste();
    mocks.admin.mockReturnValue(db.admin);

    const resposta = await POST(requisicaoDoTeste(), ctxDoTeste);
    const corpo = (await resposta.json()) as { data: { final_text: string } };

    expect(db.updates[0]?.["output_text"]).toBe(corpo.data.final_text);
  });
});

describe("GET /runs — a linha do teste leva o texto; a execução real não (#4426)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue({
      ok: true,
      user: { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", idioma: "pt-BR" },
      org: { orgId: ORG, role: "admin" },
    });
  });

  it("devolve pergunta e resposta na linha dry-run, pelo id da prévia", async () => {
    const db = bancoDaAba({
      [RUN]: { input_text: PERGUNTA, output_text: "Entregamos, sim: até as 18h." },
    });
    mocks.createClient.mockResolvedValue(db.cliente);

    const resposta = await GET(
      new NextRequest(`http://localhost/api/v1/ai/agents/${AGENT}/runs`),
      ctxDaAba,
    );
    expect(resposta.status).toBe(200);
    const corpo = (await resposta.json()) as {
      data: Array<Record<string, unknown>>;
    };
    const doTeste = corpo.data.find((linha) => linha["id"] === CALL_DO_TESTE);

    expect(doTeste).toBeDefined();
    expect(doTeste?.["is_dry_run"]).toBe(true);
    expect(doTeste?.["input_text"]).toBe(PERGUNTA);
    expect(doTeste?.["output_text"]).toBe("Entregamos, sim: até as 18h.");
    // O texto é buscado pelo id do run de prévia, não pela organização: um
    // `select` sem filtro traria o texto de TODOS os testes do agente para todas
    // as linhas — o mesmo defeito de escopo que esta onda conserta em outro lugar.
    expect(db.pedidos).toEqual([{ tabela: "ai_agent_runs", coluna: "id", valores: [RUN] }]);
  });

  it("a execução real continua sem texto — nada é emprestado entre linhas", async () => {
    const db = bancoDaAba({
      [RUN]: { input_text: PERGUNTA, output_text: "Entregamos, sim: até as 18h." },
    });
    mocks.createClient.mockResolvedValue(db.cliente);

    const resposta = await GET(
      new NextRequest(`http://localhost/api/v1/ai/agents/${AGENT}/runs`),
      ctxDaAba,
    );
    const corpo = (await resposta.json()) as { data: Array<Record<string, unknown>> };
    const real = corpo.data.find((linha) => linha["id"] === CALL_REAL);

    expect(real).toBeDefined();
    expect(real?.["is_dry_run"]).toBe(false);
    expect(real?.["input_text"]).toBeNull();
    expect(real?.["output_text"]).toBeNull();
  });
});
