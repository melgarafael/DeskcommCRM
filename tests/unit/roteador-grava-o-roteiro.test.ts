/**
 * B2 da revisão do #1573: a tela mandava `flow_pointer_id` no PUT dos membros
 * do roteador, o Zod o descartava, e o INSERT nem tinha a coluna — o vínculo
 * intenção → roteiro nunca era gravado. Aqui a ROTA roda de verdade (schema +
 * gravador), nos dois caminhos (Postgres e HTTP), com o banco de mentira só
 * respondendo às consultas.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  support: vi.fn(),
  admin: vi.fn(),
  pool: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.guard }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.support }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: mocks.pool }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));

import { PUT } from "@/app/api/v1/ai/routers/[id]/members/route";

const ORG = "10000000-0000-4000-8000-000000000001";
const ROUTER = "10000000-0000-4000-8000-000000000002";
const AGENTE = "10000000-0000-4000-8000-000000000003";
const ROTEIRO = "10000000-0000-4000-8000-000000000004";

function pedido(flow: string | null) {
  return new NextRequest(`http://localhost/api/v1/ai/routers/${ROUTER}/members`, {
    method: "PUT",
    body: JSON.stringify({
      members: [
        { agent_id: AGENTE, intent_name: "financiar", intent_description: "quer financiar", examples: [], flow_pointer_id: flow },
      ],
    }),
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  mocks.support.mockResolvedValue(null);
  mocks.guard.mockResolvedValue({ ok: true, user: { id: AGENTE, idioma: "pt-BR" }, org: { orgId: ORG } });
});

/** Postgres de mentira: `roteiroValido` diz se a consulta de roteiros o acha (mesma empresa + atendimento). */
function postgres(roteiroValido: boolean) {
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    release: vi.fn(),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      consultas.push({ sql, params });
      if (sql.includes("from ai_routers")) return { rows: [{ id: ROUTER }] };
      if (sql.includes("from ai_agents")) return { rows: [{ id: AGENTE }] };
      if (sql.includes("from followup_flow_pointers")) return { rows: roteiroValido ? [{ id: ROTEIRO }] : [] };
      return { rows: [] };
    }),
  };
  mocks.pool.mockReturnValue({ connect: async () => db });
  vi.stubEnv("SUPABASE_DB_URL", "postgresql://local-test");
  return consultas;
}

describe("caminho Postgres", () => {
  it("⭐ grava flow_pointer_id na linha da intenção", async () => {
    const consultas = postgres(true);
    const r = await PUT(pedido(ROTEIRO), { params: Promise.resolve({ id: ROUTER }) });
    expect(r.status).toBe(200);
    const insert = consultas.find((c) => c.sql.includes("insert into ai_router_members"));
    expect(insert?.sql).toContain("flow_pointer_id");
    expect(insert?.params).toContain(ROTEIRO);
    // A consulta que valida o roteiro filtra empresa E superfície.
    const conferencia = consultas.find((c) => c.sql.includes("from followup_flow_pointers"));
    expect(conferencia?.sql).toContain("surface='atendimento'");
    expect(conferencia?.params[0]).toBe(ORG);
  });

  it("⭐ roteiro de outra empresa ou follow-up comum (a consulta não acha): 422, nada gravado", async () => {
    const consultas = postgres(false);
    const r = await PUT(pedido(ROTEIRO), { params: Promise.resolve({ id: ROUTER }) });
    expect(r.status).toBe(422);
    expect(consultas.some((c) => c.sql.startsWith("delete") || c.sql.includes("insert into"))).toBe(false);
    expect(consultas.some((c) => c.sql === "rollback")).toBe(true);
  });

  it("sem roteiro: grava null e nem consulta fluxos", async () => {
    const consultas = postgres(true);
    const r = await PUT(pedido(null), { params: Promise.resolve({ id: ROUTER }) });
    expect(r.status).toBe(200);
    expect(consultas.some((c) => c.sql.includes("from followup_flow_pointers"))).toBe(false);
    const insert = consultas.find((c) => c.sql.includes("insert into ai_router_members"));
    expect(insert?.params[6]).toBeNull();
  });
});

/** Supabase de mentira para o caminho HTTP: registra filtros e o que foi inserido. */
function http(roteiroValido: boolean) {
  const inseridos: unknown[] = [];
  const filtrosDoRoteiro: Array<[string, unknown]> = [];
  const from = vi.fn((tabela: string) => {
    const chain = {
      select: () => chain,
      eq: (c: string, v: unknown) => {
        if (tabela === "followup_flow_pointers") filtrosDoRoteiro.push([c, v]);
        return chain;
      },
      is: () => chain,
      in: () => chain,
      delete: () => chain,
      upsert: () => chain,
      maybeSingle: async () => ({ data: { id: ROUTER }, error: null }),
      insert: (linhas: unknown[]) => {
        inseridos.push(...linhas);
        return chain;
      },
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data:
            tabela === "ai_agents"
              ? [{ id: AGENTE }]
              : tabela === "followup_flow_pointers"
                ? roteiroValido
                  ? [{ id: ROTEIRO }]
                  : []
                : [],
          error: null,
        }).then(resolve),
    };
    return chain;
  });
  mocks.admin.mockReturnValue({ from });
  return { inseridos, filtrosDoRoteiro };
}

describe("caminho HTTP (instalação sem SUPABASE_DB_URL)", () => {
  it("⭐ grava flow_pointer_id, conferindo empresa e superfície", async () => {
    const { inseridos, filtrosDoRoteiro } = http(true);
    const r = await PUT(pedido(ROTEIRO), { params: Promise.resolve({ id: ROUTER }) });
    expect(r.status).toBe(200);
    expect(inseridos).toEqual([expect.objectContaining({ flow_pointer_id: ROTEIRO, organization_id: ORG })]);
    expect(filtrosDoRoteiro).toEqual(
      expect.arrayContaining([
        ["organization_id", ORG],
        ["surface", "atendimento"],
      ]),
    );
  });

  it("⭐ roteiro que a consulta não acha: 422, nada inserido", async () => {
    const { inseridos } = http(false);
    const r = await PUT(pedido(ROTEIRO), { params: Promise.resolve({ id: ROUTER }) });
    expect(r.status).toBe(422);
    expect(inseridos).toEqual([]);
  });
});
