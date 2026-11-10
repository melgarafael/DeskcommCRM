/**
 * FILTRO POR FUNIL NA TELA DE TAREFAS.
 *
 * ─── O pedido, de quem usa ──────────────────────────────────────────────────
 *
 * "Na tela de Tarefas tem filtro de situação e de responsável, mas faltava o de
 * funil." A tarefa não tem funil próprio: ela herda o do negócio a que está
 * presa (`crm_tasks.lead_id` → `crm_leads.pipeline_id`). O filtro precisa estar
 * NA CONSULTA — a rota corta em 500, e filtrar na tela esconderia as tarefas que
 * ficaram depois do corte — e precisa ser um join OBRIGATÓRIO no negócio: com o
 * join comum, o PostgREST devolve a tarefa de outro funil com `lead: null` em vez
 * de tirá-la da lista.
 */
import { readFileSync } from "node:fs";

import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const ANA = "11111111-1111-4111-8111-111111111111";
const FUNIL = "77777777-7777-4777-8777-777777777777";

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

/** Dublê do PostgREST que ANOTA o `select` pedido e os filtros aplicados. */
function fazerSupabase() {
  const filtros: Array<[string, string, unknown]> = [];
  const selects: string[] = [];
  const elo: Record<string, unknown> = {};
  for (const metodo of ["order", "limit", "in", "gte", "lte"]) elo[metodo] = () => elo;
  elo.select = (colunas: string) => (selects.push(colunas), elo);
  elo.eq = (coluna: string, valor: unknown) => (filtros.push(["eq", coluna, valor]), elo);
  elo.is = (coluna: string, valor: unknown) => (filtros.push(["is", coluna, valor]), elo);
  elo.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res);
  vi.mocked(createClient).mockResolvedValue({ from: () => elo } as never);
  return { filtros, selects };
}

async function listar(qs: string) {
  const { GET } = await import("@/app/api/v1/tasks/route");
  return GET(new NextRequest(`http://localhost/api/v1/tasks${qs}`));
}

describe("GET /api/v1/tasks?pipeline_id=", () => {
  it("⭐ filtra pelo funil do NEGÓCIO da tarefa, e o join no negócio vira obrigatório", async () => {
    sessao();
    const { filtros, selects } = fazerSupabase();
    const res = await listar(`?aberto=true&pipeline_id=${FUNIL}`);
    expect(res.status).toBe(200);
    expect(filtros).toContainEqual(["eq", "lead.pipeline_id", FUNIL]);
    expect(selects[0]).toContain("lead:crm_leads!inner(");
  });

  it("sem o parâmetro, a consulta é a de antes: join comum (tarefa solta continua na lista) e sem filtro de funil", async () => {
    sessao();
    const { filtros, selects } = fazerSupabase();
    await listar("?aberto=true");
    expect(selects[0]).toContain("lead:crm_leads(");
    expect(selects[0]).not.toContain("!inner");
    expect(filtros.filter(([, coluna]) => coluna === "lead.pipeline_id")).toEqual([]);
    // e a organização continua no filtro, como sempre
    expect(filtros).toContainEqual(["eq", "organization_id", ORG]);
  });

  it("combina com o responsável: os dois filtros entram na mesma consulta", async () => {
    sessao();
    const { filtros } = fazerSupabase();
    await listar(`?assigned_to=me&pipeline_id=${FUNIL}`);
    expect(filtros).toContainEqual(["eq", "assigned_to", ANA]);
    expect(filtros).toContainEqual(["eq", "lead.pipeline_id", FUNIL]);
  });

  it("valor que não é id é recusado (422), não vira 'todos os funis' em silêncio", async () => {
    sessao();
    fazerSupabase();
    const res = await listar("?pipeline_id=vendas");
    expect(res.status).toBe(422);
  });
});

describe("o filtro da tela → o parâmetro da rota", () => {
  it("a tela manda o funil escolhido para a rota (o fio que some sem barulho)", () => {
    const tela = readFileSync("app/app/tasks/_components/TarefasClient.tsx", "utf8");
    expect(tela).toMatch(/pipeline_id: funil === "todos" \? undefined : funil/);
    expect(tela).toMatch(/aria-label=\{t\("Funil"\)\}/);
    const hook = readFileSync("hooks/tasks/useTasks.ts", "utf8");
    expect(hook).toMatch(/params\.set\("pipeline_id", filtros\.pipeline_id\)/);
    const pagina = readFileSync("app/app/tasks/page.tsx", "utf8");
    expect(pagina).toMatch(/\.eq\("is_archived", false\)/);
    expect(pagina).toMatch(/\.eq\("organization_id", activeOrg\.orgId\)/);
  });
});
