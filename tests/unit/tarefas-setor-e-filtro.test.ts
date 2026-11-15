/**
 * FILTRO POR SETOR NA TELA DE TAREFAS (#4630).
 *
 * A tarefa não tem setor próprio: ela é do setor de quem a tem
 * (`crm_tasks.assigned_to` → `attendant_sector_members.user_id`). O filtro
 * precisa estar NA CONSULTA — a rota corta em 500, e filtrar na tela
 * esconderia as tarefas que ficaram depois do corte.
 *
 * Setores é módulo opcional, desligado por padrão (doc 213,
 * `lib/instalacao/modulos.ts`). Desligado, o filtro não existe: a rota
 * responde 404 como as rotas de setor, e a tela nem pergunta pelos setores.
 */
import { readFileSync } from "node:fs";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/instalacao/modulos", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  moduloLigado: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const ANA = "11111111-1111-4111-8111-111111111111";
const BETO = "33333333-3333-4333-8333-333333333333";
const SETOR = "77777777-7777-4777-8777-777777777777";

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

/** Dublê do PostgREST: uma cadeia por tabela, que ANOTA os filtros aplicados. */
function fazerSupabase(membros: { data: unknown; error: unknown }) {
  const filtros: Record<string, Array<[string, string, unknown]>> = {};
  function cadeia(tabela: string, resposta: { data: unknown; error: unknown }) {
    const anotados = (filtros[tabela] ??= []);
    const elo: Record<string, unknown> = {};
    for (const metodo of ["order", "limit", "gte", "lte", "select"]) elo[metodo] = () => elo;
    for (const metodo of ["eq", "in", "is"]) {
      elo[metodo] = (coluna: string, valor: unknown) => (anotados.push([metodo, coluna, valor]), elo);
    }
    elo.then = (res: (v: unknown) => unknown) => Promise.resolve(resposta).then(res);
    return elo;
  }
  vi.mocked(createClient).mockResolvedValue({
    from: (tabela: string) =>
      cadeia(tabela, tabela === "attendant_sector_members" ? membros : { data: [], error: null }),
  } as never);
  return filtros;
}

async function listar(qs: string) {
  const { GET } = await import("@/app/api/v1/tasks/route");
  return GET(new NextRequest(`http://localhost/api/v1/tasks${qs}`));
}

describe("GET /api/v1/tasks?sector_id=", () => {
  beforeEach(() => vi.mocked(moduloLigado).mockResolvedValue(true));

  it("⭐ filtra pelas tarefas de quem é do setor, lendo os membros só desta organização", async () => {
    sessao();
    const filtros = fazerSupabase({ data: [{ user_id: ANA }, { user_id: BETO }], error: null });
    const res = await listar(`?aberto=true&sector_id=${SETOR}`);
    expect(res.status).toBe(200);
    expect(filtros.attendant_sector_members).toContainEqual(["eq", "sector_id", SETOR]);
    expect(filtros.attendant_sector_members).toContainEqual(["eq", "organization_id", ORG]);
    expect(filtros.crm_tasks).toContainEqual(["in", "assigned_to", [ANA, BETO]]);
  });

  it("setor sem ninguém devolve lista vazia, e não a lista inteira", async () => {
    sessao();
    fazerSupabase({ data: [], error: null });
    const res = await listar(`?sector_id=${SETOR}`);
    expect(res.status).toBe(200);
    expect((await res.json()).data.tasks).toEqual([]);
  });

  it("falha ao ler os membros do setor é 500, não uma lista vazia em silêncio", async () => {
    sessao();
    fazerSupabase({ data: null, error: { message: "boom" } });
    const res = await listar(`?sector_id=${SETOR}`);
    expect(res.status).toBe(500);
  });

  it("com o módulo de setores desligado, o filtro não existe: 404", async () => {
    vi.mocked(moduloLigado).mockResolvedValue(false);
    sessao();
    const filtros = fazerSupabase({ data: [{ user_id: ANA }], error: null });
    const res = await listar(`?sector_id=${SETOR}`);
    expect(res.status).toBe(404);
    expect(filtros.attendant_sector_members ?? []).toEqual([]);
  });

  it("sem o parâmetro, a consulta é a de antes e o módulo nem é consultado", async () => {
    vi.mocked(moduloLigado).mockClear();
    sessao();
    const filtros = fazerSupabase({ data: [], error: null });
    const res = await listar("?aberto=true");
    expect(res.status).toBe(200);
    expect(filtros.attendant_sector_members).toBeUndefined();
    expect(moduloLigado).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/tasks?contact_id= — a busca do painel da conversa (#4630)", () => {
  it("é uma consulta só, filtrada pela organização da sessão e pelo contato", async () => {
    sessao();
    const filtros = fazerSupabase({ data: [], error: null });
    const CONTATO = "44444444-4444-4444-8444-444444444444";
    const res = await listar(`?contact_id=${CONTATO}&aberto=true`);
    expect(res.status).toBe(200);
    expect(Object.keys(filtros)).toEqual(["crm_tasks"]);
    expect(filtros.crm_tasks).toContainEqual(["eq", "organization_id", ORG]);
    expect(filtros.crm_tasks).toContainEqual(["eq", "contact_id", CONTATO]);
  });
});

describe("a tela de Tarefas respeita o módulo desligado", () => {
  it("só a tela de Tarefas pede setores, com o módulo ligado; o roster (agent+) só a quem edita", () => {
    const tela = readFileSync("app/app/tasks/_components/TarefasClient.tsx", "utf8");
    expect(tela).toMatch(/useSectors\(setoresLigados\)/);
    expect(tela).toMatch(/useAttendants\(setoresLigados && podeEditar\)/);
    expect(tela).toMatch(/setoresLigados = false/);
    const pagina = readFileSync("app/app/tasks/page.tsx", "utf8");
    expect(pagina).toMatch(/setoresLigados=\{await moduloLigado\(createAdminClient\(\), "setores"\)\}/);
    // A lista e o quadro também moram no painel do inbox e no dossiê: lá não
    // há setor a pedir. Eles recebem o mapa pronto, ou nenhum.
    for (const arquivo of [
      "app/app/tasks/_components/ListaDeTarefas.tsx",
      "app/app/tasks/_components/QuadroDeTarefas.tsx",
    ]) {
      const fonte = readFileSync(arquivo, "utf8");
      expect(fonte, arquivo).not.toMatch(/useSectors\(|useAttendants\(/);
      expect(fonte, arquivo).toMatch(/setorDoResponsavel = SEM_SETOR/);
    }
  });

  it("a tela manda o setor escolhido para a rota", () => {
    const tela = readFileSync("app/app/tasks/_components/TarefasClient.tsx", "utf8");
    expect(tela).toMatch(/sector_id: setor === "todos" \? undefined : setor/);
    const hook = readFileSync("hooks/tasks/useTasks.ts", "utf8");
    expect(hook).toMatch(/params\.set\("sector_id", filtros\.sector_id\)/);
  });
});
