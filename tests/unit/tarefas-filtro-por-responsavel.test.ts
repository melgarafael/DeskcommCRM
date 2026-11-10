/**
 * FILTRO POR RESPONSÁVEL NA TELA DE TAREFAS.
 *
 * ─── O pedido, de quem usa ──────────────────────────────────────────────────
 *
 * "Quando a gente clica em Tarefas aparecem todas as tarefas por ordem
 * cronológica, mas não dá para separar só as do Aires e só as da Mariana. Fica
 * tudo misturado." A rota não aceitava filtro de responsável e a tela não tinha
 * o seletor — e filtrar só na tela não serviria: a rota corta em 500, então "as
 * minhas" que ficassem depois do corte sumiriam sem aviso.
 */
import { readFileSync } from "node:fs";

import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { responsavelDoFiltro } from "@/lib/tarefas/filtro-de-responsavel";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const ANA = "11111111-1111-4111-8111-111111111111";
const BETO = "66666666-6666-4666-8666-666666666666";

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

/** Dublê do PostgREST que ANOTA os filtros aplicados (eq e is). */
function fazerSupabase() {
  const filtros: Array<[string, string, unknown]> = [];
  const elo: Record<string, unknown> = {};
  for (const metodo of ["select", "order", "limit", "in", "gte", "lte"]) elo[metodo] = () => elo;
  elo.eq = (coluna: string, valor: unknown) => (filtros.push(["eq", coluna, valor]), elo);
  elo.is = (coluna: string, valor: unknown) => (filtros.push(["is", coluna, valor]), elo);
  elo.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res);
  vi.mocked(createClient).mockResolvedValue({ from: () => elo } as never);
  return filtros;
}

async function listar(qs: string) {
  const { GET } = await import("@/app/api/v1/tasks/route");
  return GET(new NextRequest(`http://localhost/api/v1/tasks${qs}`));
}

describe("GET /api/v1/tasks?assigned_to=", () => {
  it("com o id de um membro, filtra pelas tarefas DELE", async () => {
    sessao();
    const filtros = fazerSupabase();
    const res = await listar(`?aberto=true&assigned_to=${BETO}`);
    expect(res.status).toBe(200);
    expect(filtros).toContainEqual(["eq", "assigned_to", BETO]);
  });

  it("`ninguem` traz as SEM responsável (is null), não as de todo mundo", async () => {
    sessao();
    const filtros = fazerSupabase();
    const res = await listar("?assigned_to=ninguem");
    expect(res.status).toBe(200);
    expect(filtros).toContainEqual(["is", "assigned_to", null]);
    expect(filtros.filter(([op, coluna]) => op === "eq" && coluna === "assigned_to")).toEqual([]);
  });

  it("sem o parâmetro, não filtra por responsável — o comportamento de antes", async () => {
    sessao();
    const filtros = fazerSupabase();
    await listar("?aberto=true");
    expect(filtros.filter(([, coluna]) => coluna === "assigned_to")).toEqual([]);
    // e a organização continua no filtro, como sempre
    expect(filtros).toContainEqual(["eq", "organization_id", ORG]);
  });

  it("`me` é resolvido pelo usuário da SESSÃO, não por um id do navegador", async () => {
    sessao();
    const filtros = fazerSupabase();
    const res = await listar("?assigned_to=me");
    expect(res.status).toBe(200);
    expect(filtros).toContainEqual(["eq", "assigned_to", ANA]);
  });

  it("valor que não é id nem `ninguem` é recusado (422), não vira 'todos' em silêncio", async () => {
    sessao();
    fazerSupabase();
    const res = await listar("?assigned_to=mariana");
    expect(res.status).toBe(422);
  });
});

describe("o filtro da tela → o parâmetro da rota", () => {
  it("todos = sem parâmetro; minhas = `me` (a rota resolve pela sessão); ninguem e id passam como estão", () => {
    expect(responsavelDoFiltro("todos")).toBeUndefined();
    expect(responsavelDoFiltro("eu")).toBe("me");
    expect(responsavelDoFiltro("ninguem")).toBe("ninguem");
    expect(responsavelDoFiltro(BETO)).toBe(BETO);
  });

  it("a tela usa o filtro e manda para a rota (o fio que some sem barulho)", () => {
    const tela = readFileSync("app/app/tasks/_components/TarefasClient.tsx", "utf8");
    expect(tela).toMatch(/assigned_to: responsavelDoFiltro\(responsavel\)/);
    expect(tela).toMatch(/aria-label=\{t\("Responsável"\)\}/);
    const hook = readFileSync("hooks/tasks/useTasks.ts", "utf8");
    expect(hook).toMatch(/params\.set\("assigned_to", filtros\.assigned_to\)/);
  });
});
