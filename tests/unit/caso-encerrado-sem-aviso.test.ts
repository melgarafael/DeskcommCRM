/**
 * #3810 — ENCERRAR SEM AVISAR O CLIENTE (rota nova `POST .../close`).
 *
 * O defeito medido: um caso em `awaiting_human` que a vida já resolveu não tinha
 * saída pela mão da pessoa. A única porta era `POST .../reply`, e `resolved`,
 * `need_lead_info` e `escalate` TODOS mandam mensagem ao cliente — as duas
 * primeiras enfileiram `case_reply_turn` (a IA volta a falar) e a terceira chama
 * o handoff. Fechar um caso sem objeto custava mentir para o cliente.
 *
 * O que este arquivo mede, e por quê:
 *   - `status='cancelled'` no caso, escrito pelo MESMO serviço do agente
 *     (`encerrarChamadoPelaPessoa` → `encerrarChamadoComAutor`), com a nota
 *     OBRIGATÓRIA no evento e `actor_kind='human'`/`actor_user_id` da pessoa.
 *     A função é REAL aqui: mocká-la mediria o teste contra ele mesmo e deixaria
 *     o SQL (params, ator, nota) sem nenhum gate.
 *   - **ZERO job**: o ponto do issue. Nenhum statement toca `job_queue`, e
 *     `enqueueJob`/`performHumanHandoff`/`avisarLeadDoCrm` são espiados — se
 *     alguém "resolver" o caso enfileirando um turno, estes testes ficam
 *     vermelhos em vez de a IA mandar mensagem em produção.
 *   - os avisos do sino do caso (`agent_inbox_items.ref_id`) saem de `open` no
 *     mesmo commit.
 *   - sem nota → 400 e NADA muda (nem `begin`); caso fora de `awaiting_human` →
 *     409; caso de outra org → 404.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { enqueueJob } from "@/lib/agent-engine/queue/queue";
import { performHumanHandoff } from "@/lib/agent-engine/agent/human-handoff";
import { avisarLeadDoCrm } from "@/lib/ai/handoff/aviso-ao-lead";
import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
// A guarda de impersonação tem testemunho próprio (`lib/impersonate/*`). Aqui ela
// entra dublada porque `loadAuthUser()` depende de sessão Supabase, que este
// arquivo não monta — e o que se mede abaixo é a rota, não a guarda. O último
// teste prova que a recusa DELA chega ao cliente intacta.
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
// Espiões dos três efeitos que NÃO podem acontecer. A rota não os importa hoje;
// se alguém os trouxer para cá, esta é a linha que acusa.
vi.mock("@/lib/agent-engine/queue/queue", () => ({ enqueueJob: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-engine/agent/human-handoff", () => ({
  performHumanHandoff: vi.fn(async () => undefined),
}));
vi.mock("@/lib/ai/handoff/aviso-ao-lead", () => ({ avisarLeadDoCrm: vi.fn(async () => null) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const CASE_ID = "33333333-3333-4333-8333-333333333333";
const NOTA = "o cliente comprou em outra loja";

function session(effectiveRole: Role) {
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

type Chamada = { sql: string; params: unknown[] };

/**
 * O banco de mentira SÓ responde — não interpreta SQL. O que o teste lê é o que
 * foi enviado: é assim que "não enfileirou nada" vira uma asserção sobre o
 * statement e não sobre um mock de função que alguém pode remover.
 */
function makePoolStub(opts: { status?: string | null; encerrou?: boolean } = {}) {
  const chamadas: Chamada[] = [];
  const status = opts.status === undefined ? "awaiting_human" : opts.status;
  const encerrou = opts.encerrou ?? true;

  const responder = (sql: string) => {
    if (sql.includes("select status from agent_cases")) {
      return { rows: status === null ? [] : [{ status }], rowCount: status === null ? 0 : 1 };
    }
    // O statement do encerramento (update + insert do evento) só "fecha" quando
    // a transição casa — `encerrou: false` simula a corrida perdida.
    if (sql.includes("insert into agent_case_events")) {
      return { rows: [], rowCount: encerrou ? 1 : 0 };
    }
    if (sql.includes("update agent_inbox_items")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      chamadas.push({ sql, params });
      return responder(sql);
    }),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      chamadas.push({ sql, params });
      return responder(sql);
    }),
    connect: vi.fn(async () => client),
    __client: client,
    __chamadas: chamadas,
  };
  return pool;
}

function closeReq(body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/v1/ai/cases/${CASE_ID}/close`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function importarRota() {
  return import("@/app/api/v1/ai/cases/[id]/close/route");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/ai/cases/:id/close — encerrar sem avisar o cliente", () => {
  it("cancela o caso, grava a nota no evento, resolve o sino e NÃO enfileira nada", async () => {
    session("agent");
    const pool = makePoolStub({ status: "awaiting_human" });
    vi.mocked(getRequestPool).mockReturnValue(pool as unknown as ReturnType<typeof getRequestPool>);

    const { POST } = await importarRota();
    const res = await POST(closeReq({ note: NOTA }), { params: Promise.resolve({ id: CASE_ID }) });

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { status: string } };
    expect(corpo.data.status).toBe("cancelled");

    // A transição: `cancelled` de verdade, e não `resolved` (que fingiria que
    // alguém concluiu algo).
    const encerramento = pool.__chamadas.find((c) => c.sql.includes("insert into agent_case_events"));
    expect(encerramento, "a rota não gravou evento nenhum").toBeDefined();
    expect(encerramento!.sql).toContain("update agent_cases");
    expect(encerramento!.params).toContain("cancelled");
    // A nota é OBRIGATÓRIA e vai no corpo do evento — é o que o próximo
    // atendente lê para entender por que o caso morreu.
    expect(encerramento!.params).toContain(NOTA);
    // E o ator é a PESSOA: `human` (o CHECK do banco não conhece 'user') com o
    // id de quem decidiu. Sem isto, a timeline diria que a IA agiu.
    expect(encerramento!.sql).toContain("actor_kind");
    expect(encerramento!.sql).toContain("'human'");
    expect(encerramento!.params).toContain(USER_ID);
    expect(encerramento!.params).toContain("cancelled");

    // O sino do caso fecha no MESMO commit.
    const sino = pool.__chamadas.find((c) => c.sql.includes("update agent_inbox_items"));
    expect(sino, "os avisos do sino do caso não foram resolvidos").toBeDefined();
    expect(sino!.sql).toContain("'resolved'");
    expect(sino!.params).toEqual([ORG_ID, CASE_ID]);

    // ZERO job — o ponto do issue. Nem por statement, nem por função.
    expect(
      pool.__chamadas.filter((c) => c.sql.includes("job_queue")),
      "a ação enfileirou um job: o cliente seria avisado",
    ).toEqual([]);
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(performHumanHandoff).not.toHaveBeenCalled();
    expect(avisarLeadDoCrm).not.toHaveBeenCalled();

    // Transição e sino no mesmo commit (um caso `cancelled` é terminal: meio
    // efeito não tem retentativa que se cure).
    const comandos = pool.__client.query.mock.calls.map(([sql]) => String(sql));
    expect(comandos[0]).toBe("begin");
    expect(comandos).toContain("commit");
    expect(comandos).not.toContain("rollback");

    expect(
      vi
        .mocked(audit)
        .mock.calls.some(([e]) => e.action === "ai.case_closed_without_reply"),
    ).toBe(true);
  });

  it("sem nota → 400 e NADA muda (nem transação aberta)", async () => {
    session("agent");
    const pool = makePoolStub();
    vi.mocked(getRequestPool).mockReturnValue(pool as unknown as ReturnType<typeof getRequestPool>);

    const { POST } = await importarRota();
    const res = await POST(closeReq({}), { params: Promise.resolve({ id: CASE_ID }) });

    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("nota em branco também é 400 (espaço não é nota)", async () => {
    session("agent");
    const pool = makePoolStub();
    vi.mocked(getRequestPool).mockReturnValue(pool as unknown as ReturnType<typeof getRequestPool>);

    const { POST } = await importarRota();
    const res = await POST(closeReq({ note: "   " }), { params: Promise.resolve({ id: CASE_ID }) });

    expect(res.status).toBe(400);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("caso que NÃO está em awaiting_human → 409, sem tocar no banco", async () => {
    session("agent");
    const pool = makePoolStub({ status: "resolved" });
    vi.mocked(getRequestPool).mockReturnValue(pool as unknown as ReturnType<typeof getRequestPool>);

    const { POST } = await importarRota();
    const res = await POST(closeReq({ note: NOTA }), { params: Promise.resolve({ id: CASE_ID }) });

    expect(res.status).toBe(409);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("caso de outra org (ou inexistente) → 404", async () => {
    session("agent");
    const pool = makePoolStub({ status: null });
    vi.mocked(getRequestPool).mockReturnValue(pool as unknown as ReturnType<typeof getRequestPool>);

    const { POST } = await importarRota();
    const res = await POST(closeReq({ note: NOTA }), { params: Promise.resolve({ id: CASE_ID }) });

    expect(res.status).toBe(404);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("corrida perdida (transição não casou) → 409 e rollback: nada fica pela metade", async () => {
    session("agent");
    const pool = makePoolStub({ status: "awaiting_human", encerrou: false });
    vi.mocked(getRequestPool).mockReturnValue(pool as unknown as ReturnType<typeof getRequestPool>);

    const { POST } = await importarRota();
    const res = await POST(closeReq({ note: NOTA }), { params: Promise.resolve({ id: CASE_ID }) });

    expect(res.status).toBe(409);
    const comandos = pool.__client.query.mock.calls.map(([sql]) => String(sql));
    expect(comandos).toContain("rollback");
    expect(comandos).not.toContain("commit");
    // O sino NÃO pode ter sido fechado por um encerramento que não aconteceu.
    expect(pool.__chamadas.some((c) => c.sql.includes("update agent_inbox_items"))).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });

  it("viewer é barrado (403) antes de qualquer leitura", async () => {
    session("viewer");
    const pool = makePoolStub();
    vi.mocked(getRequestPool).mockReturnValue(pool as unknown as ReturnType<typeof getRequestPool>);

    const { POST } = await importarRota();
    const res = await POST(closeReq({ note: NOTA }), { params: Promise.resolve({ id: CASE_ID }) });

    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("recusa da guarda de impersonação chega ao cliente intacta", async () => {
    session("agent");
    vi.mocked(requireSupportWrite).mockResolvedValueOnce(
      fail("forbidden", "Sessão de acompanhamento é somente leitura.", 403) as never,
    );
    const pool = makePoolStub();
    vi.mocked(getRequestPool).mockReturnValue(pool as unknown as ReturnType<typeof getRequestPool>);

    const { POST } = await importarRota();
    const res = await POST(closeReq({ note: NOTA }), { params: Promise.resolve({ id: CASE_ID }) });

    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
