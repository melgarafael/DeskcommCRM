/**
 * O QUADRO NÃO CARREGA A BASE INTEIRA, E A COLUNA QUE MUDA NÃO É ESCRITA MUDA.
 *
 * Duas coisas do #4028 que só a ROTA pode provar:
 *
 *  1. **O limite.** A visão em quadro pede `?limite=200`. Quem manda no teto é
 *     o servidor, não o navegador: um `limite` acima do máximo é RECUSADO com
 *     422 nomeado (e nada é consultado), em vez de virar uma consulta com o
 *     tamanho que o cliente quiser. É a diferença entre "a tela pede pouco" e
 *     "a rota não deixa pedir muito".
 *
 *  2. **Quem e quando.** Mover o cartão passa pelo MESMO `PATCH` da tela (não
 *     há caminho paralelo). Ele já gravava `crm_task.updated` com o ator; o que
 *     faltava era a TRANSIÇÃO no registro — `de` e `para`. Sem isso o audit
 *     dizia que alguém tocou na tarefa, não que a tarefa saiu de "Pendente"
 *     para "Concluída" — e um quadro cuja movimentação não se explica depois
 *     é um quadro que ninguém audita.
 *
 * O terceiro caso é o lado oposto que não pode regredir: `viewer` continua
 * recebendo `forbidden_role` nomeado, sem tocar `crm_tasks`, e toda escrita
 * continua presa à organização da sessão.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { portaDaAplicacao } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  portaDaAplicacao: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => true,
}));
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const ANA = "11111111-1111-4111-8111-111111111111";
const TAREFA = "55555555-5555-4555-8555-555555555555";

const LINHA = {
  id: TAREFA,
  organization_id: ORG,
  title: "Ligar de volta",
  description: null,
  due_date: null,
  priority: "medium",
  status: "in_progress",
  lead_id: null,
  contact_id: null,
  demanda_id: null,
  assigned_to: null,
  created_by: ANA,
  created_at: "2026-11-01T10:00:00.000Z",
  updated_at: "2026-11-05T12:00:00.000Z",
};

function sessao(papel: Role = "agent") {
  const user: AuthUser = {
    id: ANA,
    email: "ana@example.com",
    full_name: "Ana",
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role: papel }],
  };
  vi.mocked(requireRole).mockImplementation(async (min: Role) =>
    ROLE_RANK[papel] >= ROLE_RANK[min]
      ? { ok: true, user, org: { orgId: ORG, name: "Org", role: papel } }
      : { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) },
  );
}

interface Resposta {
  data?: unknown;
  error?: { message: string; code?: string } | null;
}

/** Dublê do PostgREST que anota tabelas, filtros `eq` e o `limit` pedido. */
function duble(respostas: Resposta[]) {
  const tabelas: string[] = [];
  const filtros: Array<[string, unknown]> = [];
  const limites: number[] = [];
  let i = 0;
  const from = (tabela: string) => {
    tabelas.push(tabela);
    const r = respostas[Math.min(i++, respostas.length - 1)] ?? {};
    const devolve = () => Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    const elo: Record<string, unknown> = {};
    for (const m of ["select", "insert", "update", "delete", "order", "in", "is", "neq"]) {
      elo[m] = () => elo;
    }
    elo.limit = (n: number) => {
      limites.push(n);
      return elo;
    };
    elo.eq = (coluna: string, valor: unknown) => (filtros.push([coluna, valor]), elo);
    elo.single = devolve;
    elo.maybeSingle = devolve;
    elo.then = (res: (v: unknown) => unknown) => devolve().then(res);
    return elo;
  };
  return { client: { from }, tabelas, filtros, limites };
}

const porta: ReturnType<typeof duble> = duble([]);

beforeEach(() => {
  vi.clearAllMocks();
  sessao();
  vi.mocked(portaDaAplicacao).mockReturnValue({
    async query() {
      return [];
    },
    async queryOne() {
      return null as never;
    },
  });
});

function montar(respostas: Resposta[]) {
  const d = duble(respostas);
  vi.mocked(createClient).mockResolvedValue(d.client as never);
  return d;
}

function get(query = "") {
  return new NextRequest(`http://x/api/v1/tasks${query}`, { method: "GET" });
}

function patch(corpo: Record<string, unknown>) {
  return new NextRequest(`http://x/api/v1/tasks/${TAREFA}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

const ctx = { params: Promise.resolve({ id: TAREFA }) };

describe("GET /api/v1/tasks — a carga do quadro", () => {
  it("⭐ o limite pedido é o que a consulta usa", async () => {
    const d = montar([{ data: [LINHA] }]);
    const { GET } = await import("@/app/api/v1/tasks/route");

    const res = await GET(get("?limite=200"));

    expect(res.status).toBe(200);
    expect(d.limites).toEqual([200]);
  });

  it("sem `limite`, a lista continua com o teto de sempre", async () => {
    const d = montar([{ data: [LINHA] }]);
    const { GET } = await import("@/app/api/v1/tasks/route");

    const res = await GET(get());

    expect(res.status).toBe(200);
    expect(d.limites).toEqual([500]);
  });

  it("⭐ limite acima do teto é 422 nomeado, e NADA é consultado", async () => {
    const d = montar([{ data: [LINHA] }]);
    const { GET } = await import("@/app/api/v1/tasks/route");

    const res = await GET(get("?limite=100000"));

    expect(res.status).toBe(422);
    expect(d.tabelas).toEqual([]);
    const corpo = (await res.json()) as { error?: { details?: Record<string, unknown> } };
    expect(corpo.error?.details).toHaveProperty("limite");
  });

  it("limite zero também é recusado — coluna vazia não é quadro", async () => {
    const d = montar([{ data: [LINHA] }]);
    const { GET } = await import("@/app/api/v1/tasks/route");

    const res = await GET(get("?limite=0"));

    expect(res.status).toBe(422);
    expect(d.tabelas).toEqual([]);
  });
});

describe("PATCH /api/v1/tasks/[id] — mover o cartão", () => {
  it("⭐ a mudança de situação é registrada com QUEM moveu e DE/PARA onde", async () => {
    montar([{ data: { status: "pending" } }, { data: { ...LINHA, status: "done" } }]);
    const { PATCH } = await import("@/app/api/v1/tasks/[id]/route");

    const res = await PATCH(patch({ status: "done" }), ctx);

    expect(res.status).toBe(200);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        actorUserId: ANA,
        action: "crm_task.updated",
        resourceId: TAREFA,
        metadata: expect.objectContaining({ de: "pending", para: "done" }),
      }),
    );
  });

  it("editar outro campo NÃO inventa transição de situação", async () => {
    montar([{ data: { status: "pending" } }, { data: { ...LINHA, status: "pending" } }]);
    const { PATCH } = await import("@/app/api/v1/tasks/[id]/route");

    const res = await PATCH(patch({ title: "Ligar na sexta" }), ctx);

    expect(res.status).toBe(200);
    const registro = vi.mocked(audit).mock.calls.at(0)?.[0] as {
      metadata?: Record<string, unknown>;
    };
    expect(registro.metadata).not.toHaveProperty("de");
    expect(registro.metadata).not.toHaveProperty("para");
  });

  it("⭐ viewer recebe recusa NOMEADA e a tarefa não é tocada", async () => {
    sessao("viewer");
    const d = montar([{ data: { status: "pending" } }, { data: LINHA }]);
    const { PATCH } = await import("@/app/api/v1/tasks/[id]/route");

    const res = await PATCH(patch({ status: "done" }), ctx);

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe(
      "forbidden_role",
    );
    expect(d.tabelas).toEqual([]);
  });

  it("a escrita continua presa à organização da sessão — outra organização fica intacta", async () => {
    const d = montar([{ data: { status: "pending" } }, { data: { ...LINHA, status: "done" } }]);
    const { PATCH } = await import("@/app/api/v1/tasks/[id]/route");

    await PATCH(patch({ status: "done" }), ctx);

    expect(d.filtros).toEqual(
      expect.arrayContaining([
        ["id", TAREFA],
        ["organization_id", ORG],
      ]),
    );
  });
});
