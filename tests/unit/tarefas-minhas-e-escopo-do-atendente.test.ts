/**
 * TAREFAS: ABRIR EM "MINHAS", LEMBRAR O FILTRO E MOSTRAR O RECORTE DO BANCO (#4737).
 *
 * ─── O que cada bloco prende ───────────────────────────────────────────────
 *
 *  (a) o filtro é lembrado, o do atendente abre em "Minhas" e, com o banco
 *      recortando, o id de um colega gravado antes não volta;
 *  (b) a régua da TELA (`escopoDaTelaDeTarefas`) espelha a policy
 *      `crm_tasks_select`: a matriz das duas opções que já existem × papel;
 *  (c) a ROTA não tem régua própria: sem filtro na requisição, a consulta sai
 *      só com a organização, para qualquer papel. É a metade "rota" do pedido
 *      de @webtecnica no #4800 (comparar a rota com a policy no caso
 *      criador→colega); a metade "policy" está em
 *      `tests/invariants/visibilidade-na-agenda-e-nas-tarefas.test.ts`.
 *  (d) o fio da página até o componente.
 */
import { readFileSync } from "node:fs";

import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import { resolveAuthDual } from "@/lib/api/auth-dual";
import { fail } from "@/lib/api/wrappers";
import { ROLE_RANK, type Role } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { escopoDaTelaDeTarefas } from "@/lib/tarefas/escopo-do-atendente";
import {
  CHAVE_DO_FILTRO_DAS_TAREFAS,
  filtroInicialDaTela,
  lerFiltroDoResponsavel,
} from "@/lib/tarefas/preferencia-do-filtro";

vi.mock("@/lib/api/auth-dual", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/auth-dual")>()),
  resolveAuthDual: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";
const ANA = "11111111-1111-4111-8111-111111111111";
const BETO = "66666666-6666-4666-8666-666666666666";

// ─── (a) a preferência ─────────────────────────────────────────────────────

describe("(a) o filtro escolhido é lembrado, e o do atendente abre em Minhas", () => {
  it("⭐ quem nunca escolheu abre no PADRÃO do papel: `eu` para agent, `todos` para o resto", () => {
    expect(lerFiltroDoResponsavel({}, { padrao: "eu" })).toBe("eu");
    expect(lerFiltroDoResponsavel({}, { padrao: "todos" })).toBe("todos");
    expect(lerFiltroDoResponsavel(null, { padrao: "eu" })).toBe("eu");
    expect(lerFiltroDoResponsavel(undefined, { padrao: "eu" })).toBe("eu");
  });

  it("⭐ a última escolha volta no próximo carregamento", () => {
    expect(lerFiltroDoResponsavel({ [CHAVE_DO_FILTRO_DAS_TAREFAS]: "ninguem" }, { padrao: "eu" })).toBe("ninguem");
    expect(lerFiltroDoResponsavel({ [CHAVE_DO_FILTRO_DAS_TAREFAS]: BETO }, { padrao: "eu" })).toBe(BETO);
    expect(lerFiltroDoResponsavel({ [CHAVE_DO_FILTRO_DAS_TAREFAS]: "todos" }, { padrao: "eu" })).toBe("todos");
  });

  it("`?assigned_to=me` do endereço ganha da preferência — é o que o lembrete abre", () => {
    const metadata = { [CHAVE_DO_FILTRO_DAS_TAREFAS]: "todos" };
    expect(filtroInicialDaTela(metadata, { padrao: "eu", pedidoNoEndereco: "me" })).toBe("eu");
    expect(filtroInicialDaTela(metadata, { padrao: "eu" })).toBe("todos");
  });

  it("escolha torta volta ao padrão, sem tela vazia", () => {
    for (const torto of ["mariana", "", "  ", 42, null, { x: 1 }, ["eu"]]) {
      expect(lerFiltroDoResponsavel({ [CHAVE_DO_FILTRO_DAS_TAREFAS]: torto }, { padrao: "eu" })).toBe("eu");
    }
  });

  it("⭐ com o banco recortando, o id de um colega gravado antes volta ao padrão — e o resto continua valendo", () => {
    const restrito = { padrao: "eu" as const, restritoAoProprio: true };
    expect(lerFiltroDoResponsavel({ [CHAVE_DO_FILTRO_DAS_TAREFAS]: BETO }, restrito)).toBe("eu");
    // "Todos" fica: é exatamente o que a policy entrega a esta pessoa.
    expect(lerFiltroDoResponsavel({ [CHAVE_DO_FILTRO_DAS_TAREFAS]: "todos" }, restrito)).toBe("todos");
    expect(lerFiltroDoResponsavel({ [CHAVE_DO_FILTRO_DAS_TAREFAS]: "ninguem" }, restrito)).toBe("ninguem");
  });
});

// ─── (b) a régua da tela espelha a policy ──────────────────────────────────

describe("(b) a tela lê as MESMAS opções que a policy `crm_tasks_select`", () => {
  const settings = (colegas: boolean | undefined, modo: string | undefined) => ({
    ...(colegas === undefined ? {} : { colegas_podem_mexer_na_agenda: colegas }),
    ...(modo === undefined ? {} : { visibility_mode: modo }),
  });

  it("⭐ a matriz: opção da agenda × O que cada atendente enxerga × papel", () => {
    const casos: Array<[boolean | undefined, string | undefined, Role, ReturnType<typeof escopoDaTelaDeTarefas>]> = [
      // Ligada (ou ausente, o padrão): a equipe inteira, qualquer modo.
      [undefined, undefined, "agent", null],
      [true, "own", "agent", null],
      [true, "own_and_unassigned", "agent", null],
      // Desligada: vale o modo — ausente é `own_and_unassigned`, como o `coalesce`.
      [false, "all", "agent", null],
      [false, "own_and_unassigned", "agent", "own_and_unassigned"],
      [false, undefined, "agent", "own_and_unassigned"],
      [false, "own", "agent", "own"],
      [false, "qualquer-coisa", "agent", "own"],
      // viewer, manager e admin veem tudo na policy, em qualquer combinação.
      [false, "own", "viewer", null],
      [false, "own", "manager", null],
      [false, "own", "admin", null],
      [false, "own_and_unassigned", "manager", null],
    ];
    for (const [colegas, modo, papel, esperado] of casos) {
      expect(
        escopoDaTelaDeTarefas({ papel, platformAdmin: false, settings: settings(colegas, modo) }),
        `${String(colegas)} × ${String(modo)} × ${papel}`,
      ).toBe(esperado);
    }
  });

  it("platform admin vê tudo — é o `fn_is_platform_admin()` da policy", () => {
    expect(escopoDaTelaDeTarefas({ papel: "agent", platformAdmin: true, settings: settings(false, "own") })).toBeNull();
  });

  it("settings torto não derruba a tela: cai na leitura que o banco faria (opção ligada)", () => {
    for (const torto of [null, undefined, "x", 3, ["a"]]) {
      expect(escopoDaTelaDeTarefas({ papel: "agent", platformAdmin: false, settings: torto })).toBeNull();
    }
  });
});

// ─── (c) a rota não tem régua própria ──────────────────────────────────────

function sessao(papel: Role) {
  vi.mocked(resolveAuthDual).mockImplementation(async (_req, { role: min }) => {
    if (ROLE_RANK[papel] < ROLE_RANK[min]) {
      return { ok: false as const, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) };
    }
    return {
      ok: true as const,
      organizationId: ORG,
      actor: { type: "user" as const, id: ANA },
      supabase: await createClient(),
      idioma: "pt-BR" as const,
      via: "session" as const,
    };
  });
}

/** Dublê da lista: anota TODO filtro, inclusive `or`, e as tabelas lidas. */
function listagem() {
  const filtros: Array<[string, string, unknown]> = [];
  const tabelas: string[] = [];
  const elo: Record<string, unknown> = {};
  for (const metodo of ["select", "order", "limit"]) elo[metodo] = () => elo;
  for (const metodo of ["eq", "is", "in", "gte", "lte"]) {
    elo[metodo] = (coluna: string, valor: unknown) => (filtros.push([metodo, coluna, valor]), elo);
  }
  elo.or = (expressao: string) => (filtros.push(["or", expressao, null]), elo);
  elo.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res);
  vi.mocked(createClient).mockResolvedValue({
    from: (tabela: string) => (tabelas.push(tabela), elo),
  } as never);
  return { filtros, tabelas };
}

describe("(c) a rota devolve o que a policy entrega — sem segunda régua", () => {
  it.each(["agent", "manager", "admin"] as const)(
    "⭐ %s sem filtro: a consulta sai só com a organização, em `crm_tasks` e em nada mais",
    async (papel) => {
      sessao(papel);
      const { filtros, tabelas } = listagem();
      const { GET } = await import("@/app/api/v1/tasks/route");

      const res = await GET(new NextRequest("http://localhost/api/v1/tasks"));

      expect(res.status).toBe(200);
      expect(tabelas).toEqual(["crm_tasks"]);
      expect(filtros).toEqual([["eq", "organization_id", ORG]]);
    },
  );
});

// ─── (d) o fio da página até o componente ──────────────────────────────────

describe("(d) o fio da página até o componente", () => {
  it("o papel decide o padrão, a página lê a régua da policy e a escolha é gravada", () => {
    const pagina = readFileSync("app/app/tasks/page.tsx", "utf8");
    expect(pagina).toMatch(/padrao: activeOrg\.role === "agent" \? "eu" : "todos"/);
    expect(pagina).toMatch(/filtroInicialDaTela\(await metadadosDaSessao\(\),/);
    expect(pagina).toMatch(/escopoDaTelaDeTarefas\(\{/);
    expect(pagina).toMatch(/escopoProprio=\{escopoProprio\}/);

    const tela = readFileSync("app/app/tasks/_components/TarefasClient.tsx", "utf8");
    expect(tela).toMatch(/await definirFiltroDasTarefas\(novo\)/);
    expect(tela).toMatch(/useState<FiltroDeResponsavel>\(filtroInicial\)/);
  });
});
