/**
 * A LINHA DO TESTE FECHA COM O CUSTO DAS CHAMADAS DAQUELE RUN (#4664).
 *
 * ─── O defeito medido ──────────────────────────────────────────────────────
 *
 * `POST /api/v1/ai/agents/:id/versions/:vid/test` abre a linha do run
 * (`ai_agent_runs`, `is_dry_run = true`) e a fecha com status, data, latência e
 * texto — e com `tokens_in`, `tokens_out` e `cost_cents` no padrão 0. O dinheiro
 * gasto está em `llm_calls`, uma linha por chamada, com `preview_run_id`
 * apontando para o run que a causou (migration 9348). Nada somava as duas.
 *
 * ─── Por que os dois runs SIMULTÂNEOS são o teste ──────────────────────────
 *
 * O jeito preguiçoso de fechar essa linha é "somar o que o agente gastou desde
 * que o run começou". Com dois testes do mesmo agente disparados ao mesmo
 * tempo, essa soma dá o MESMO número nas duas linhas — e nenhuma tela consegue
 * dizer qual teste custou o quê. O dublê abaixo é um banco de verdade na única
 * dimensão que importa: ele aplica o filtro que o SQL pedir. Se alguém trocar a
 * chave por janela de tempo, os dois runs recebem o total e o segundo caso
 * reprova.
 *
 * `preview_run_id` é `uuid` no banco; aqui as chaves são strings estáveis para o
 * teste falar delas pelo nome.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  support: vi.fn(async () => null),
  preview: vi.fn(),
  audit: vi.fn(async () => undefined),
  admin: vi.fn(),
  pool: vi.fn(),
  /** `resolveAuthDual` monta um cliente de sessão — fora de request, `cookies()` estoura. */
  createClient: vi.fn(async () => ({})),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.support }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.requireRole }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));
vi.mock("@/lib/agent-engine/agent/sandbox", () => ({ testAgentVersion: mocks.preview }));
vi.mock("@/lib/agent-engine/agent/request-deps", () => ({ requestTurnDeps: () => ({}) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: mocks.pool }));

import { POST } from "@/app/api/v1/ai/agents/[id]/versions/[vid]/test/route";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const VERSION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";
const RUN_OUTRO = "33333333-3333-4333-8333-333333333333";

/** O mesmo instante para TODAS as chamadas: é o que derruba a soma por janela. */
const MESMO_INSTANTE = "2026-11-15T12:00:00.000Z";

const PERGUNTA_A = "Vocês entregam sábado?";
const PERGUNTA_B = "Qual o prazo de instalação?";

interface Chamada {
  organization_id: string;
  preview_run_id: string | null;
  purpose: string;
  input_tokens: number;
  output_tokens: number;
  /** `numeric` chega como string no driver do Postgres — a soma é a mesma. */
  cost_cents: string;
  created_at: string;
}

function chamada(extra: Partial<Chamada> & { preview_run_id: string | null }): Chamada {
  return {
    organization_id: ORG,
    purpose: "agent_preview",
    input_tokens: 0,
    output_tokens: 0,
    cost_cents: "0",
    created_at: MESMO_INSTANTE,
    ...extra,
  };
}

/**
 * O pool da rota (`getRequestPool`) — um banco de brinquedo que executa o filtro
 * que o SQL pediu, e não o que o teste gostaria.
 *
 * Duas formas são reconhecidas, e são as duas que a rota pode escrever:
 *
 *  1. `preview_run_id = $N` — o elo por run (#4664). É a certa.
 *  2. qualquer outra coisa (janela de tempo, por exemplo) — devolve TUDO. É o
 *     que o banco faria com uma consulta por horário, já que todas as chamadas
 *     deste teste nascem no mesmo instante; e é o vermelho que o caso dos dois
 *     runs simultâneos existe para produzir.
 *
 * Todas as linhas são da mesma organização, porque a rota filtra por ela.
 */
function poolDaSoma(linhas: Chamada[]) {
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    consultas.push({ sql, params });
    const porRun = /preview_run_id\s*=\s*\$(\d+)/.exec(sql);
    const filtradas = porRun
      ? linhas.filter((l) => l.preview_run_id === params[Number(porRun[1]) - 1])
      : linhas;
    return {
      rows: [
        {
          tokens_in: filtradas.reduce((t, l) => t + l.input_tokens, 0),
          tokens_out: filtradas.reduce((t, l) => t + l.output_tokens, 0),
          cost_cents: filtradas.reduce((t, l) => t + Number(l.cost_cents), 0).toFixed(4),
        },
      ],
    };
  });
  return { pool: { query }, consultas };
}

/**
 * O cliente admin: só `ai_agent_runs` é escrito. O id do run é decidido pela
 * PERGUNTA, e não pela ordem das chamadas — dois POSTs simultâneos intercalam à
 * vontade e o teste não pode depender de quem chegou primeiro.
 */
function bancoDoRun(idsPorPergunta: Record<string, string>) {
  const updates: Array<{ runId: string; dados: Record<string, unknown> }> = [];
  const admin = {
    from(tabela: string) {
      if (tabela === "ai_agent_versions") {
        const consulta = {
          select: () => consulta,
          eq: () => consulta,
          async maybeSingle() {
            return {
              data: {
                id: VERSION,
                agent_id: AGENT,
                organization_id: ORG,
                channel_session_id: null,
              },
              error: null,
            };
          },
        };
        return consulta;
      }
      if (tabela !== "ai_agent_runs") throw new Error(`Escrita inesperada: ${tabela}`);
      return {
        insert(dados: Record<string, unknown>) {
          const runId = idsPorPergunta[String(dados.input_text)];
          if (!runId) throw new Error(`pergunta sem run mapeado: ${String(dados.input_text)}`);
          return { select: () => ({ single: async () => ({ data: { id: runId }, error: null }) }) };
        },
        update(dados: Record<string, unknown>) {
          let runId = "";
          const consulta = {
            eq(coluna: string, valor: unknown) {
              if (coluna === "id") runId = String(valor);
              return consulta;
            },
            then(resolve: (v: { error: null }) => void) {
              updates.push({ runId, dados });
              resolve({ error: null });
            },
          };
          return consulta;
        },
      };
    },
  };
  return { admin, updates };
}

const ctx = { params: Promise.resolve({ id: AGENT, vid: VERSION }) };

function requisicao(pergunta: string) {
  return new NextRequest("http://localhost/api/v1/ai/agents/x/versions/y/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sample_message: pergunta }),
  });
}

/** O fechamento daquele run, ou `undefined` se a linha não foi fechada. */
function fechamentoDe(
  updates: Array<{ runId: string; dados: Record<string, unknown> }>,
  runId: string,
): Record<string, unknown> | undefined {
  return updates.find((u) => u.runId === runId)?.dados;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRole.mockResolvedValue({
    ok: true,
    user: { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", idioma: "pt-BR" },
    org: { orgId: ORG, role: "admin" },
  });
  mocks.preview.mockResolvedValue({
    candidates: [{ body: "Entregamos, sim." }],
    proposals: [],
    trace: [],
    midia: [],
    // #4129 — o material da empresa entra na mesma régua da mídia; a rota lê
    // `result.materiais.some(...)`, então o dublê precisa da lista (vazia).
    materiais: [],
  });
});

describe("o fechamento do teste soma o custo do PRÓPRIO run (#4664)", () => {
  it("soma só as chamadas que apontam para o run que fechou", async () => {
    const pool = poolDaSoma([
      chamada({
        preview_run_id: RUN_A,
        input_tokens: 120,
        output_tokens: 30,
        cost_cents: "3.5000",
      }),
      chamada({ preview_run_id: RUN_A, input_tokens: 30, output_tokens: 0, cost_cents: "0.5000" }),
      chamada({
        preview_run_id: RUN_OUTRO,
        input_tokens: 900,
        output_tokens: 90,
        cost_cents: "88.0000",
      }),
    ]);
    const db = bancoDoRun({ [PERGUNTA_A]: RUN_A });
    mocks.pool.mockReturnValue(pool.pool);
    mocks.admin.mockReturnValue(db.admin);

    const resposta = await POST(requisicao(PERGUNTA_A), ctx);
    expect(resposta.status).toBe(200);

    const fechamento = fechamentoDe(db.updates, RUN_A);
    expect(fechamento).toMatchObject({
      status: "completed",
      tokens_in: 150,
      tokens_out: 30,
      cost_cents: 4,
    });
    // A chave da consulta é o run — organização e id, os dois parâmetros.
    expect(pool.consultas).toHaveLength(1);
    expect(pool.consultas[0]?.params).toEqual([ORG, RUN_A]);
    // O outro lado do elo: a rota precisa ENTREGAR o id do run ao motor da
    // prévia — é ele que vira `llm_calls.preview_run_id` no INSERT da chamada.
    // Sem esta metade, a soma acima não tem o que somar: o run fecharia em zero
    // e o defeito do #4664 voltaria com outra roupa.
    expect(mocks.preview).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ runId: RUN_A }),
    );
  });

  it("dois testes simultâneos do mesmo agente não se misturam", async () => {
    const pool = poolDaSoma([
      chamada({
        preview_run_id: RUN_A,
        input_tokens: 120,
        output_tokens: 30,
        cost_cents: "3.5000",
      }),
      chamada({ preview_run_id: RUN_A, input_tokens: 30, output_tokens: 0, cost_cents: "0.5000" }),
      chamada({
        preview_run_id: RUN_B,
        input_tokens: 700,
        output_tokens: 90,
        cost_cents: "11.0000",
      }),
    ]);
    const db = bancoDoRun({ [PERGUNTA_A]: RUN_A, [PERGUNTA_B]: RUN_B });
    mocks.pool.mockReturnValue(pool.pool);
    mocks.admin.mockReturnValue(db.admin);

    // Os DOIS no ar ao mesmo tempo, com custos diferentes e o mesmo agente.
    const [respostaA, respostaB] = await Promise.all([
      POST(requisicao(PERGUNTA_A), ctx),
      POST(requisicao(PERGUNTA_B), ctx),
    ]);
    expect(respostaA.status).toBe(200);
    expect(respostaB.status).toBe(200);

    expect(fechamentoDe(db.updates, RUN_A)).toMatchObject({
      tokens_in: 150,
      tokens_out: 30,
      cost_cents: 4,
    });
    expect(fechamentoDe(db.updates, RUN_B)).toMatchObject({
      tokens_in: 700,
      tokens_out: 90,
      cost_cents: 11,
    });
    // O total das duas somas seria 850/120/15 — valor que NENHUMA linha pode
    // ter. Se a soma virar "o que o agente gastou nesse intervalo", as duas
    // linhas fecham com ele e este caso reprova.
    for (const fechamento of db.updates.map((u) => u.dados)) {
      expect(fechamento["tokens_in"]).not.toBe(850);
      expect(fechamento["cost_cents"]).not.toBe(15);
    }
    // E cada execução levou o SEU id para o motor: os dois ids aparecem, um por
    // chamada — nenhum POST roda com o run do outro.
    const idsEntregues = mocks.preview.mock.calls
      .map((c) => (c[2] as { runId?: string }).runId)
      .sort();
    expect(idsEntregues).toEqual([RUN_A, RUN_B].sort());
  });

  it("run sem chamada nenhuma fecha em ZERO, sem estourar", async () => {
    const pool = poolDaSoma([]);
    const db = bancoDoRun({ [PERGUNTA_A]: RUN_A });
    mocks.pool.mockReturnValue(pool.pool);
    mocks.admin.mockReturnValue(db.admin);

    const resposta = await POST(requisicao(PERGUNTA_A), ctx);
    expect(resposta.status).toBe(200);

    // Zero MEDIDO (há linha de fechamento, com as três colunas) — não ausência
    // de fechamento e não erro. Um run que não chamou modelo nenhum custou 0.
    expect(fechamentoDe(db.updates, RUN_A)).toMatchObject({
      status: "completed",
      tokens_in: 0,
      tokens_out: 0,
      cost_cents: 0,
    });
  });

  it("chamada de OUTRO run, no mesmo instante, não entra na soma", async () => {
    const pool = poolDaSoma([
      chamada({ preview_run_id: RUN_A, input_tokens: 10, output_tokens: 1, cost_cents: "0.2500" }),
      // Mesmo agente, mesma organização, MESMO segundo — e um run diferente.
      chamada({
        preview_run_id: RUN_OUTRO,
        input_tokens: 5000,
        output_tokens: 500,
        cost_cents: "42.0000",
      }),
    ]);
    const db = bancoDoRun({ [PERGUNTA_A]: RUN_A });
    mocks.pool.mockReturnValue(pool.pool);
    mocks.admin.mockReturnValue(db.admin);

    await POST(requisicao(PERGUNTA_A), ctx);

    expect(fechamentoDe(db.updates, RUN_A)).toMatchObject({
      tokens_in: 10,
      tokens_out: 1,
      cost_cents: 0.25,
    });
  });

  it("o teste que FALHA também fecha com o que gastou", async () => {
    // A recusa do provedor é cobrada: quando o turno morre, as chamadas que já
    // saíram continuam em `llm_calls` — e é essa linha que alguém abre depois
    // para entender o que aconteceu.
    const pool = poolDaSoma([
      chamada({ preview_run_id: RUN_A, input_tokens: 400, output_tokens: 0, cost_cents: "2.0000" }),
    ]);
    const db = bancoDoRun({ [PERGUNTA_A]: RUN_A });
    mocks.pool.mockReturnValue(pool.pool);
    mocks.admin.mockReturnValue(db.admin);
    mocks.preview.mockRejectedValue(new Error("SENTINELA: provedor recusou"));

    const resposta = await POST(requisicao(PERGUNTA_A), ctx);
    expect(resposta.status).toBe(422);

    expect(fechamentoDe(db.updates, RUN_A)).toMatchObject({
      status: "failed",
      tokens_in: 400,
      tokens_out: 0,
      cost_cents: 2,
    });
  });
});
