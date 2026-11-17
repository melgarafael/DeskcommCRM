/**
 * TAREFAS: ABRIR EM "MINHAS", LEMBRAR O FILTRO E O ESCOPO DO ATENDENTE (#4737).
 *
 * ─── O que a issue pede, e por que a API é o lugar da prova ─────────────────
 *
 * Duas partes, na mesma entrega:
 *
 *  1. **A tela.** Quem tem papel de atendente abre em "Minhas", e o último
 *     filtro escolhido volta no próximo carregamento — no MESMO mecanismo da
 *     camada de datas da Agenda (`raw_user_meta_data` da pessoa).
 *  2. **A opção da organização** "Atendente vê só as próprias tarefas (e as sem
 *     responsável)". Ligada, o atendente lista e abre apenas as dele e as sem
 *     dono.
 *
 * A parte 2 SÓ É RESTRIÇÃO SE VALER NA ROTA: esconder o seletor na tela não
 * impede ninguém de chamar `GET /api/v1/tasks` com o token da sessão. Por isso
 * os casos (a)–(d) batem na ROTA, e não no componente — é a sabotagem "esconder
 * só na tela" que este arquivo precisa derrubar.
 *
 * ─── O que cada caso prende ────────────────────────────────────────────────
 *
 *  (a) opção LIGADA + agent: a consulta só traz as dele e as sem responsável;
 *  (b) a tarefa de um COLEGA é recusa NOMEADA (403 `forbidden_scope`), não
 *      lista vazia nem 404 genérico;
 *  (c) opção DESLIGADA: comportamento idêntico ao de hoje, inclusive filtrar
 *      pelo id de um colega;
 *  (d) administrador não é afetado pela opção;
 *  (e) o filtro é lembrado no próximo carregamento, e o padrão do agent é
 *      "Minhas" — a régua pura e o fio da página até o componente.
 */
import { readFileSync } from "node:fs";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { portaDaAplicacao } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import { tarefaForaDoEscopo } from "@/lib/tarefas/escopo-do-atendente";
import {
  CHAVE_DO_FILTRO_DAS_TAREFAS,
  filtroInicialDaTela,
  lerFiltroDoResponsavel,
} from "@/lib/tarefas/preferencia-do-filtro";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => true,
}));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  portaDaAplicacao: vi.fn(),
}));
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: vi.fn(async () => null),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const ANA = "11111111-1111-4111-8111-111111111111";
const BETO = "66666666-6666-4666-8666-666666666666";
const TAREFA = "55555555-5555-4555-8555-555555555555";

function sessao(papel: Role = "agent", isPlatformAdmin = false) {
  const user: AuthUser = {
    id: ANA,
    email: "ana@example.com",
    full_name: "Ana",
    avatar_url: null,
    is_platform_admin: isPlatformAdmin,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role: papel }],
  };
  vi.mocked(requireRole).mockImplementation(async (min: Role) =>
    ROLE_RANK[papel] >= ROLE_RANK[min]
      ? { ok: true, user, org: { orgId: ORG, name: "Org", role: papel } }
      : { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) },
  );
}

/** Um elo de PostgREST que ANOTA o que a rota pediu — e devolve o que se mandar. */
function eloAnotador(anotacoes: Array<[string, string, unknown]>, resultado: unknown) {
  const elo: Record<string, unknown> = {};
  for (const metodo of ["select", "order", "limit", "in", "gte", "lte", "update", "delete"]) {
    elo[metodo] = () => elo;
  }
  elo.eq = (coluna: string, valor: unknown) => (anotacoes.push(["eq", coluna, valor]), elo);
  elo.is = (coluna: string, valor: unknown) => (anotacoes.push(["is", coluna, valor]), elo);
  elo.then = (res: (v: unknown) => unknown) => Promise.resolve(resultado).then(res);
  return elo;
}

/**
 * A organização como a rota a lê: uma linha só, com o jsonb `settings`.
 * `escopoLigado` é a opção que a tela de Configurações grava.
 */
function organizacaoCom(escopoLigado: boolean) {
  const elo: Record<string, unknown> = {};
  for (const metodo of ["select", "eq", "limit"]) elo[metodo] = () => elo;
  elo.then = (res: (v: unknown) => unknown) =>
    Promise.resolve({
      data: [{ settings: { tarefas: { atendente_ve_so_as_proprias: escopoLigado } } }],
      error: null,
    }).then(res);
  return elo;
}

/** Dublê da LISTA: anota os filtros aplicados e as expressões `or`. */
function listagemCom(escopoLigado: boolean) {
  const filtros: Array<[string, string, unknown]> = [];
  const expressoesOr: string[] = [];
  const elo = eloAnotador(filtros, { data: [], error: null }) as Record<string, unknown>;
  elo.or = (expressao: string) => (expressoesOr.push(expressao), elo);
  vi.mocked(createClient).mockResolvedValue({
    from: (tabela: string) => (tabela === "organizations" ? organizacaoCom(escopoLigado) : elo),
  } as never);
  return { filtros, expressoesOr };
}

/** Dublê da tarefa única: a pré-leitura do PATCH/DELETE devolve esta linha. */
function tarefaCom(escopoLigado: boolean, assignedTo: string | null) {
  const filtros: Array<[string, string, unknown]> = [];
  const elo = eloAnotador(filtros, { data: null, error: null }) as Record<string, unknown>;
  elo.maybeSingle = async () => ({ data: { status: "pending", assigned_to: assignedTo }, error: null });
  // O UPDATE da tarefa (quando ele acontece) devolve uma linha qualquer: o que
  // os casos de (c)/(d) provam é que NÃO houve recusa de escopo, e não o corpo.
  elo.single = async () => ({ data: { id: TAREFA, status: "done", assigned_to: assignedTo }, error: null });
  vi.mocked(createClient).mockResolvedValue({
    from: (tabela: string) => (tabela === "organizations" ? organizacaoCom(escopoLigado) : elo),
  } as never);
  return filtros;
}

async function listar(qs: string) {
  const { GET } = await import("@/app/api/v1/tasks/route");
  return GET(new NextRequest(`http://localhost/api/v1/tasks${qs}`));
}

async function editar(id: string, corpo: Record<string, unknown>) {
  const { PATCH } = await import("@/app/api/v1/tasks/[id]/route");
  return PATCH(
    new NextRequest(`http://localhost/api/v1/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(corpo),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ id }) } as never,
  );
}

beforeEach(() => {
  // O PATCH bem-sucedido registra a atividade na timeline do negócio; o pool é
  // dublê porque o que este arquivo prova é a REGRA de escopo, não a escrita.
  vi.mocked(portaDaAplicacao).mockReturnValue({
    async query() {
      return [];
    },
    async queryOne() {
      return null as never;
    },
  } as never);
});

const codigo = async (res: Response) => ((await res.json()) as { error?: { code?: string } }).error?.code;

// ─── (a) opção ligada: só as próprias e as sem responsável ──────────────────

describe("(a) agent com a opção ligada lista só as próprias e as sem responsável", () => {
  it("⭐ a consulta sai com `assigned_to = eu OR assigned_to is null`", async () => {
    sessao("agent");
    const { filtros, expressoesOr } = listagemCom(true);

    const res = await listar("?aberto=true");

    expect(res.status).toBe(200);
    expect(expressoesOr).toEqual([`assigned_to.eq.${ANA},assigned_to.is.null`]);
    // E não vira um `eq` de responsável: seria "só as minhas", deixando de fora
    // a fila sem dono — que é justamente a que o atendente pode assumir.
    expect(filtros.filter(([, coluna]) => coluna === "assigned_to")).toEqual([]);
    expect(filtros).toContainEqual(["eq", "organization_id", ORG]);
  });

  it("`assigned_to=ninguem` continua trazendo a fila sem dono para o restrito", async () => {
    sessao("agent");
    const { filtros } = listagemCom(true);

    const res = await listar("?assigned_to=ninguem");

    expect(res.status).toBe(200);
    expect(filtros).toContainEqual(["is", "assigned_to", null]);
  });

  it("`?assigned_to=me` (o link do lembrete) continua funcionando", async () => {
    sessao("agent");
    const { filtros } = listagemCom(true);

    const res = await listar("?assigned_to=me");

    expect(res.status).toBe(200);
    expect(filtros).toContainEqual(["eq", "assigned_to", ANA]);
  });
});

// ─── (b) a tarefa de um colega é recusa NOMEADA ─────────────────────────────

describe("(b) o agent restrito não abre a tarefa de um colega", () => {
  it("⭐ PATCH na tarefa de outra pessoa responde 403 `forbidden_scope`, não lista vazia", async () => {
    sessao("agent");
    tarefaCom(true, BETO);

    const res = await editar(TAREFA, { status: "done" });

    expect(res.status).toBe(403);
    expect(await codigo(res)).toBe("forbidden_scope");
  });

  it("a lista também recusa NOMEADAMENTE o filtro pelo id de um colega", async () => {
    sessao("agent");
    listagemCom(true);

    const res = await listar(`?assigned_to=${BETO}`);

    expect(res.status).toBe(403);
    expect(await codigo(res)).toBe("forbidden_scope");
  });

  it("a tarefa SEM responsável NÃO é tratada como de outro dono", async () => {
    // A régua pura, e é ela que a sabotagem "tratar sem responsável como de
    // outro" derruba: `null` é a fila que o atendente pode assumir.
    expect(tarefaForaDoEscopo({ restrito: true, usuarioId: ANA, assignedTo: null })).toBe(false);
    expect(tarefaForaDoEscopo({ restrito: true, usuarioId: ANA, assignedTo: ANA })).toBe(false);
    expect(tarefaForaDoEscopo({ restrito: true, usuarioId: ANA, assignedTo: BETO })).toBe(true);
    // E sem restrição, a regra não existe.
    expect(tarefaForaDoEscopo({ restrito: false, usuarioId: ANA, assignedTo: BETO })).toBe(false);
  });
});

// ─── (c) opção desligada: igual a hoje ─────────────────────────────────────

describe("(c) com a opção desligada, o comportamento é o de hoje", () => {
  it("⭐ sem filtro na requisição, a consulta não recorta por responsável", async () => {
    sessao("agent");
    const { filtros, expressoesOr } = listagemCom(false);

    const res = await listar("?aberto=true");

    expect(res.status).toBe(200);
    expect(expressoesOr).toEqual([]);
    expect(filtros.filter(([, coluna]) => coluna === "assigned_to")).toEqual([]);
  });

  it("filtrar pelo id de um colega continua funcionando", async () => {
    sessao("agent");
    const { filtros } = listagemCom(false);

    const res = await listar(`?assigned_to=${BETO}`);

    expect(res.status).toBe(200);
    expect(filtros).toContainEqual(["eq", "assigned_to", BETO]);
  });

  it("abrir a tarefa de um colega continua permitido", async () => {
    sessao("agent");
    tarefaCom(false, BETO);

    const res = await editar(TAREFA, { status: "done" });
    // 200: passou da régua de escopo e foi ao UPDATE. O que este caso prova é
    // que NÃO houve a recusa de 403 que existe com a opção ligada.
    expect(res.status).toBe(200);
  });
});

// ─── (d) administrador intocado ────────────────────────────────────────────

describe("(d) a opção não vale para administrador", () => {
  it("⭐ admin com a opção LIGADA continua recebendo a lista inteira", async () => {
    sessao("admin");
    const { filtros, expressoesOr } = listagemCom(true);

    const res = await listar("?aberto=true");

    expect(res.status).toBe(200);
    expect(expressoesOr).toEqual([]);
    expect(filtros.filter(([, coluna]) => coluna === "assigned_to")).toEqual([]);
  });

  it("manager também não é restringido — é quem distribui as tarefas", async () => {
    sessao("manager");
    const { expressoesOr } = listagemCom(true);

    const res = await listar("?aberto=true");

    expect(res.status).toBe(200);
    expect(expressoesOr).toEqual([]);
  });

  it("platform admin atendendo como suporte continua vendo tudo", async () => {
    sessao("agent", true);
    const { expressoesOr } = listagemCom(true);

    const res = await listar("?aberto=true");

    expect(res.status).toBe(200);
    expect(expressoesOr).toEqual([]);
  });
});

// ─── (e) o filtro é lembrado e o padrão do agent é "Minhas" ─────────────────

describe("(e) o filtro escolhido é lembrado, e o do agent abre em Minhas", () => {
  it("⭐ quem nunca escolheu abre no PADRÃO do papel: `eu` para agent, `todos` para o resto", () => {
    expect(lerFiltroDoResponsavel({}, { padrao: "eu" })).toBe("eu");
    expect(lerFiltroDoResponsavel({}, { padrao: "todos" })).toBe("todos");
    // Sem metadata nenhum (sessão nova, `user_metadata` nulo): o padrão, não erro.
    expect(lerFiltroDoResponsavel(null, { padrao: "eu" })).toBe("eu");
    expect(lerFiltroDoResponsavel(undefined, { padrao: "eu" })).toBe("eu");
  });

  it("⭐ a última escolha volta no próximo carregamento", () => {
    const metadata = { [CHAVE_DO_FILTRO_DAS_TAREFAS]: "ninguem" };

    expect(lerFiltroDoResponsavel(metadata, { padrao: "eu" })).toBe("ninguem");
    expect(
      lerFiltroDoResponsavel({ [CHAVE_DO_FILTRO_DAS_TAREFAS]: BETO }, { padrao: "eu" }),
    ).toBe(BETO);
    // A escolha gravada ganha do padrão do papel — é o ponto do item 1.
    expect(
      lerFiltroDoResponsavel({ [CHAVE_DO_FILTRO_DAS_TAREFAS]: "todos" }, { padrao: "eu" }),
    ).toBe("todos");
  });

  it("`?assigned_to=me` do endereço ganha da preferência — é o que o lembrete abre", () => {
    const metadata = { [CHAVE_DO_FILTRO_DAS_TAREFAS]: "todos" };

    expect(filtroInicialDaTela(metadata, { padrao: "eu", pedidoNoEndereco: "me" })).toBe("eu");
    expect(filtroInicialDaTela(metadata, { padrao: "eu" })).toBe("todos");
  });

  it("escolha torta ou de membro que saiu volta ao padrão, sem tela vazia", () => {
    for (const torto of ["mariana", "", "  ", 42, null, { x: 1 }, ["eu"]]) {
      expect(
        lerFiltroDoResponsavel({ [CHAVE_DO_FILTRO_DAS_TAREFAS]: torto }, { padrao: "eu" }),
      ).toBe("eu");
    }
  });

  it("com a opção ligada, `todos` gravado antes NÃO abre a tela num filtro proibido", () => {
    const metadata = { [CHAVE_DO_FILTRO_DAS_TAREFAS]: "todos" };

    expect(lerFiltroDoResponsavel(metadata, { padrao: "eu", restritoAoProprio: true })).toBe("eu");
    // E as escolhas que o restrito PODE fazer continuam valendo.
    expect(
      lerFiltroDoResponsavel(
        { [CHAVE_DO_FILTRO_DAS_TAREFAS]: "ninguem" },
        { padrao: "eu", restritoAoProprio: true },
      ),
    ).toBe("ninguem");
  });

  it("o fio da página até o componente: o papel decide o padrão e a escolha é gravada", () => {
    const pagina = readFileSync("app/app/tasks/page.tsx", "utf8");
    // O padrão do papel, no SERVIDOR — a tela não adivinha o papel.
    expect(pagina).toMatch(/padrao: activeOrg\.role === "agent" \? "eu" : "todos"/);
    expect(pagina).toMatch(/filtroInicialDaTela\(await metadadosDaSessao\(\),/);
    expect(pagina).toMatch(/escopoProprio=\{escopoProprio\}/);

    const tela = readFileSync("app/app/tasks/_components/TarefasClient.tsx", "utf8");
    // A escolha é GRAVADA — sem isto o filtro volta ao padrão na recarga, que
    // era exatamente o defeito relatado na issue.
    expect(tela).toMatch(/await definirFiltroDasTarefas\(novo\)/);
    expect(tela).toMatch(/useState<FiltroDeResponsavel>\(filtroInicial\)/);
  });
});
