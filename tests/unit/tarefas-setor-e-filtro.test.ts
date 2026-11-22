/**
 * O SETOR DA TAREFA VEM DA CONVERSA (OU DO NEGÓCIO), NÃO DO RESPONSÁVEL (#4883).
 *
 * ─── O defeito que este arquivo vigia ───────────────────────────────────────
 *
 * O selo mostrava o PRIMEIRO setor de quem tem a tarefa
 * (`atendentes[i].sector_ids[0]`), e o filtro "Setor" casava com
 * `crm_tasks.assigned_to` → `attendant_sector_members`. Quem atende mais de um
 * setor ficava com TODAS as tarefas com o mesmo selo, mesmo quando a conversa do
 * cliente estava em outro setor (setor que a IA grava, #3881).
 *
 * ─── A regra, e por que ela mora numa função pura ───────────────────────────
 *
 * `setorDaTarefa` (`lib/tarefas/setor-da-tarefa.ts`): conversa → negócio →
 * responsável. A rota ANEXA `setor` a cada tarefa com essa função e o filtro usa
 * `tarefaNoSetor`, que chama a mesma. Selo e filtro não podem discordar, porque
 * não há duas decisões para discordarem.
 *
 * Três casos, e cada um tem teste aqui: conversa em X com responsável em Y
 * mostra X; negócio em Z (sem conversa) mostra Z; sem os dois, mostra o setor do
 * responsável — MARCADO como fallback, para não passar por setor do atendimento.
 *
 * Setores é módulo opcional, desligado por padrão (doc 213,
 * `lib/instalacao/modulos.ts`). Desligado, o filtro não existe (404 como as
 * rotas de setor) e o selo não é derivado.
 */
import { readFileSync } from "node:fs";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveAuthDual } from "@/lib/api/auth-dual";
import { fail } from "@/lib/api/wrappers";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { ROLE_RANK, type Role } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { setorDaTarefa, tarefaNoSetor } from "@/lib/tarefas/setor-da-tarefa";

// A rota entra por `resolveAuthDual` (sessão OU token, Spec 33).
vi.mock("@/lib/api/auth-dual", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/auth-dual")>()),
  resolveAuthDual: vi.fn(),
}));
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
/** O setor da CONVERSA — o que a tela deve mostrar. */
const INTERNACIONAIS = "77777777-7777-4777-8777-777777777777";
/** O primeiro setor do RESPONSÁVEL — o que a tela mostrava por engano. */
const NACIONAIS = "88888888-8888-4888-8888-888888888888";
/** O setor do NEGÓCIO, quando a tarefa aponta um card sem conversa. */
const CORPORATIVO = "99999999-9999-4999-8999-999999999999";

const CONTATO = "44444444-4444-4444-8444-444444444444";
const NEGOCIO = "55555555-5555-4555-8555-555555555555";
const CONVERSA_DO_CONTATO = "66666666-6666-4666-8666-666666666666";
const CONVERSA_DO_CARD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function sessao(papel: Role = "agent") {
  vi.mocked(resolveAuthDual).mockImplementation(async (_req, { role: min }) => {
    if (ROLE_RANK[papel] < ROLE_RANK[min]) {
      return { ok: false as const, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) };
    }
    return {
      ok: true as const,
      organizationId: ORG,
      actor: { type: "user" as const, id: ANA, role: papel },
      supabase: await createClient(),
      idioma: "pt-BR" as const,
      via: "session" as const,
      role: papel,
      administraEmpresa: ROLE_RANK[papel] >= ROLE_RANK.admin,
    };
  });
}

type Resposta = { data: unknown; error: unknown };

/**
 * Dublê do PostgREST: uma cadeia por tabela, que ANOTA os filtros aplicados e
 * devolve as linhas daquela tabela. Sem isso o teste não consegue provar DE ONDE
 * o setor veio — que é exatamente o que a #4883 pede.
 */
function fazerSupabase(tabelas: Record<string, Resposta>) {
  const filtros: Record<string, Array<[string, string, unknown]>> = {};
  function cadeia(tabela: string) {
    const resposta: Resposta = tabelas[tabela] ?? { data: [], error: null };
    const anotados = (filtros[tabela] ??= []);
    const elo: Record<string, unknown> = {};
    for (const metodo of ["order", "limit", "gte", "lte"]) elo[metodo] = () => elo;
    for (const metodo of ["select", "eq", "in", "is"]) {
      elo[metodo] = (coluna: string, valor: unknown) => (anotados.push([metodo, coluna, valor]), elo);
    }
    elo.then = (res: (v: unknown) => unknown) => Promise.resolve(resposta).then(res);
    return elo;
  }
  vi.mocked(createClient).mockResolvedValue({ from: (tabela: string) => cadeia(tabela) } as never);
  return filtros;
}

/** Uma linha de `crm_tasks` como a rota a lê (só o que o setor precisa). */
function tarefa(extra: Record<string, unknown> = {}) {
  return {
    id: "tarefa-1",
    title: "Ligar para o cliente",
    status: "pending",
    priority: "medium",
    due_date: null,
    contact_id: null,
    lead_id: null,
    assigned_to: ANA,
    lead: null,
    ...extra,
  };
}

async function listar(qs: string) {
  const { GET } = await import("@/app/api/v1/tasks/route");
  const res = await GET(new NextRequest(`http://localhost/api/v1/tasks${qs}`));
  const corpo = res.status === 200 ? await res.json() : null;
  return { res, corpo };
}

describe("setorDaTarefa — a regra pura que o selo e o filtro dividem", () => {
  it("⭐ conversa em X e responsável em Y mostra X, com a origem declarada", () => {
    expect(setorDaTarefa({ conversa: INTERNACIONAIS, responsavel: NACIONAIS })).toEqual({
      id: INTERNACIONAIS,
      origem: "conversa",
    });
  });

  it("sem conversa, o negócio responde — mesmo com responsável em outro setor", () => {
    expect(setorDaTarefa({ negocio: CORPORATIVO, responsavel: NACIONAIS })).toEqual({
      id: CORPORATIVO,
      origem: "negocio",
    });
  });

  it("sem conversa e sem negócio, mostra o setor do responsável — MARCADO como fallback", () => {
    expect(setorDaTarefa({ responsavel: NACIONAIS })).toEqual({
      id: NACIONAIS,
      origem: "responsavel",
    });
  });

  it("sem nenhuma das três fontes não há selo — e não um setor inventado", () => {
    expect(setorDaTarefa({ conversa: null, negocio: null, responsavel: null })).toBeNull();
    expect(setorDaTarefa({})).toBeNull();
  });

  it("a conversa vence o negócio: quem nasceu de uma conversa é dela", () => {
    expect(
      setorDaTarefa({ conversa: INTERNACIONAIS, negocio: CORPORATIVO, responsavel: NACIONAIS })?.id,
    ).toBe(INTERNACIONAIS);
  });
});

describe("tarefaNoSetor — o filtro pergunta a MESMA coisa que o selo", () => {
  it("⭐ filtrar por X devolve a tarefa que exibe X, ainda que o responsável seja de Y", () => {
    const fontes = { conversa: INTERNACIONAIS, responsavel: NACIONAIS };
    expect(tarefaNoSetor(fontes, INTERNACIONAIS)).toBe(true);
    expect(tarefaNoSetor(fontes, NACIONAIS)).toBe(false);
  });

  it("o fallback do responsável entra no filtro dele — e só nele", () => {
    const fontes = { responsavel: NACIONAIS };
    expect(tarefaNoSetor(fontes, NACIONAIS)).toBe(true);
    expect(tarefaNoSetor(fontes, INTERNACIONAIS)).toBe(false);
  });

  it('sem setor escolhido, toda tarefa passa (a tela abre em "Todos os setores")', () => {
    expect(tarefaNoSetor({}, undefined)).toBe(true);
    expect(tarefaNoSetor({ conversa: INTERNACIONAIS }, null)).toBe(true);
  });
});

describe("GET /api/v1/tasks — o selo vem da conversa (#4883)", () => {
  beforeEach(() => vi.mocked(moduloLigado).mockResolvedValue(true));

  it("⭐ tarefa de conversa em X, responsável cujo setor é Y: o selo é X", async () => {
    sessao();
    const filtros = fazerSupabase({
      crm_tasks: { data: [tarefa({ contact_id: CONTATO })], error: null },
      conversations: {
        data: [
          {
            id: CONVERSA_DO_CONTATO,
            contact_id: CONTATO,
            sector_id: INTERNACIONAIS,
            last_message_at: "2026-11-17T10:00:00Z",
          },
        ],
        error: null,
      },
      attendant_sector_members: { data: [{ user_id: ANA, sector_id: NACIONAIS }], error: null },
    });

    const { res, corpo } = await listar("?aberto=true&com_setor=true");

    expect(res.status).toBe(200);
    expect(corpo.data.tasks[0].setor).toEqual({ id: INTERNACIONAIS, origem: "conversa" });
    // A conversa é lida DENTRO da organização da sessão — regra do CLAUDE.md.
    expect(filtros.conversations).toContainEqual(["eq", "organization_id", ORG]);
    expect(filtros.conversations).toContainEqual(["in", "contact_id", [CONTATO]]);
  });

  it("tarefa sem conversa e sem negócio mostra o setor do responsável, e a origem o declara", async () => {
    sessao();
    fazerSupabase({
      crm_tasks: { data: [tarefa()], error: null },
      attendant_sector_members: { data: [{ user_id: ANA, sector_id: NACIONAIS }], error: null },
    });

    const { corpo } = await listar("?com_setor=true");
    expect(corpo.data.tasks[0].setor).toEqual({ id: NACIONAIS, origem: "responsavel" });
  });

  it("responsável em dois setores: o fallback é o de MENOR id — sempre o mesmo", async () => {
    sessao();
    fazerSupabase({
      crm_tasks: { data: [tarefa()], error: null },
      attendant_sector_members: {
        data: [
          { user_id: ANA, sector_id: NACIONAIS },
          { user_id: ANA, sector_id: INTERNACIONAIS },
        ],
        error: null,
      },
    });

    const { corpo } = await listar("?com_setor=true");
    // "7777…" < "8888…": o fallback não pode depender da ordem em que o banco
    // devolveu as linhas — o mesmo usuário tem de ver o mesmo selo sempre.
    expect(corpo.data.tasks[0].setor).toEqual({ id: INTERNACIONAIS, origem: "responsavel" });
  });

  it("tarefa que aponta um card sem conversa mostra o setor do NEGÓCIO", async () => {
    sessao();
    fazerSupabase({
      crm_tasks: {
        data: [tarefa({ lead_id: NEGOCIO, lead: { id: NEGOCIO, title: "Peru" } })],
        error: null,
      },
      crm_lead_links: { data: [{ lead_id: NEGOCIO, target_id: CONVERSA_DO_CARD }], error: null },
      conversations: {
        data: [
          {
            id: CONVERSA_DO_CARD,
            contact_id: CONTATO,
            sector_id: CORPORATIVO,
            last_message_at: "2026-11-16T09:00:00Z",
          },
        ],
        error: null,
      },
    });

    const { corpo } = await listar("?com_setor=true");
    expect(corpo.data.tasks[0].setor).toEqual({ id: CORPORATIVO, origem: "negocio" });
  });

  it("o selo não mente: tarefa de outro setor não herda o setor de quem a tem", async () => {
    sessao();
    fazerSupabase({
      crm_tasks: { data: [tarefa({ contact_id: CONTATO })], error: null },
      conversations: {
        data: [
          {
            id: CONVERSA_DO_CONTATO,
            contact_id: CONTATO,
            sector_id: INTERNACIONAIS,
            last_message_at: "2026-11-17T10:00:00Z",
          },
        ],
        error: null,
      },
      attendant_sector_members: { data: [{ user_id: ANA, sector_id: NACIONAIS }], error: null },
    });

    const { corpo } = await listar("?com_setor=true");
    expect(corpo.data.tasks[0].setor.id).not.toBe(NACIONAIS);
  });
});

describe("GET /api/v1/tasks?sector_id= — o filtro casa com o selo (#4883)", () => {
  beforeEach(() => vi.mocked(moduloLigado).mockResolvedValue(true));

  /**
   * DUAS tarefas, as duas de ANA (cujo setor é NACIONAIS):
   *  · `tarefa-1` nasceu da conversa em INTERNACIONAIS;
   *  · `tarefa-2` é avulsa, sem conversa nem negócio → setor do responsável.
   */
  function duasTarefas() {
    return fazerSupabase({
      crm_tasks: {
        data: [tarefa({ id: "tarefa-1", contact_id: CONTATO }), tarefa({ id: "tarefa-2" })],
        error: null,
      },
      conversations: {
        data: [
          {
            id: CONVERSA_DO_CONTATO,
            contact_id: CONTATO,
            sector_id: INTERNACIONAIS,
            last_message_at: "2026-11-17T10:00:00Z",
          },
        ],
        error: null,
      },
      attendant_sector_members: { data: [{ user_id: ANA, sector_id: NACIONAIS }], error: null },
    });
  }

  it("⭐ filtrar por X devolve as tarefas que EXIBEM X", async () => {
    sessao();
    duasTarefas();
    const { corpo } = await listar(`?aberto=true&sector_id=${INTERNACIONAIS}`);
    expect(corpo.data.tasks.map((t: { id: string }) => t.id)).toEqual(["tarefa-1"]);
  });

  it("⭐ a tarefa de um membro do setor cuja conversa está em outro setor NÃO entra no filtro dele", async () => {
    sessao();
    duasTarefas();
    const { corpo } = await listar(`?aberto=true&sector_id=${NACIONAIS}`);
    expect(corpo.data.tasks.map((t: { id: string }) => t.id)).toEqual(["tarefa-2"]);
  });

  it("filtrar por um setor sem ninguém pode devolver tarefa — a conversa é de lá", async () => {
    sessao();
    fazerSupabase({
      crm_tasks: { data: [tarefa({ contact_id: CONTATO })], error: null },
      conversations: {
        data: [
          {
            id: CONVERSA_DO_CONTATO,
            contact_id: CONTATO,
            sector_id: CORPORATIVO,
            last_message_at: "2026-11-17T10:00:00Z",
          },
        ],
        error: null,
      },
      attendant_sector_members: { data: [], error: null },
    });
    const { corpo } = await listar(`?sector_id=${CORPORATIVO}`);
    expect(corpo.data.tasks.map((t: { id: string }) => t.id)).toEqual(["tarefa-1"]);
  });

  it("falha ao ler a conversa é 500, não uma lista sem setor em silêncio", async () => {
    sessao();
    fazerSupabase({
      crm_tasks: { data: [tarefa({ contact_id: CONTATO })], error: null },
      conversations: { data: null, error: { message: "boom" } },
    });
    const { res } = await listar(`?sector_id=${INTERNACIONAIS}`);
    expect(res.status).toBe(500);
  });

  it("com o módulo de setores desligado, o filtro não existe: 404", async () => {
    vi.mocked(moduloLigado).mockResolvedValue(false);
    sessao();
    const filtros = fazerSupabase({ crm_tasks: { data: [tarefa()], error: null } });
    const { res } = await listar(`?sector_id=${INTERNACIONAIS}`);
    expect(res.status).toBe(404);
    expect(filtros.conversations ?? []).toEqual([]);
  });

  it("módulo desligado e só o selo pedido: a lista volta, sem setor derivado", async () => {
    vi.mocked(moduloLigado).mockResolvedValue(false);
    sessao();
    const filtros = fazerSupabase({ crm_tasks: { data: [tarefa()], error: null } });
    const { res, corpo } = await listar("?com_setor=true");
    expect(res.status).toBe(200);
    expect(corpo.data.tasks[0].setor).toBeUndefined();
    expect(filtros.conversations ?? []).toEqual([]);
  });

  it("sem o parâmetro, a consulta é a de antes e o módulo nem é consultado", async () => {
    vi.mocked(moduloLigado).mockClear();
    sessao();
    const filtros = fazerSupabase({ crm_tasks: { data: [tarefa()], error: null } });
    const { res } = await listar("?aberto=true");
    expect(res.status).toBe(200);
    expect(filtros.conversations).toBeUndefined();
    expect(filtros.attendant_sector_members).toBeUndefined();
    expect(moduloLigado).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/tasks — o selo aguenta a lista cheia e o token (#4883)", () => {
  beforeEach(() => vi.mocked(moduloLigado).mockResolvedValue(true));

  /** Um uuid v4 de mentira, distinto por índice e por prefixo. */
  const uuid = (prefixo: string, i: number) =>
    `${prefixo}${String(i).padStart(7, "0")}-0000-4000-8000-000000000000`;

  it("250 tarefas de contatos distintos: nenhum .in() leva mais de 100 ids, e nenhum id fica de fora", async () => {
    sessao();
    const N = 250;
    const contatos = Array.from({ length: N }, (_, i) => uuid("c", i));
    const negocios = Array.from({ length: N }, (_, i) => uuid("d", i));
    const pessoas = Array.from({ length: N }, (_, i) => uuid("e", i));
    const conversasDosCards = Array.from({ length: N }, (_, i) => uuid("f", i));
    const filtros = fazerSupabase({
      crm_tasks: {
        data: contatos.map((c, i) =>
          tarefa({
            id: `tarefa-${i}`,
            contact_id: c,
            lead_id: negocios[i],
            assigned_to: pessoas[i],
          }),
        ),
        error: null,
      },
      crm_lead_links: {
        data: negocios.map((n, i) => ({ lead_id: n, target_id: conversasDosCards[i] })),
        error: null,
      },
      conversations: {
        data: [
          {
            id: CONVERSA_DO_CONTATO,
            contact_id: contatos[N - 1],
            sector_id: INTERNACIONAIS,
            last_message_at: "2026-11-17T10:00:00Z",
          },
        ],
        error: null,
      },
      attendant_sector_members: { data: [], error: null },
    });

    const { res, corpo } = await listar("?com_setor=true");
    expect(res.status).toBe(200);
    // A ÚLTIMA tarefa, que num .in() único cairia no mesmo lote das outras,
    // continua achando o setor da sua conversa.
    expect(corpo.data.tasks[N - 1].setor).toEqual({ id: INTERNACIONAIS, origem: "conversa" });

    const lotes = (tabela: string, coluna: string) =>
      (filtros[tabela] ?? [])
        .filter(([metodo, col]) => metodo === "in" && col === coluna)
        .map(([, , valor]) => valor as string[]);
    const casos: Array<[string, string, string[]]> = [
      ["conversations", "contact_id", contatos],
      ["crm_lead_links", "lead_id", negocios],
      ["conversations", "id", conversasDosCards],
      ["attendant_sector_members", "user_id", pessoas],
    ];
    for (const [tabela, coluna, esperados] of casos) {
      const deste = lotes(tabela, coluna);
      expect(deste.length, `${tabela}.${coluna}`).toBeGreaterThan(1);
      for (const lote of deste) expect(lote.length, `${tabela}.${coluna}`).toBeLessThanOrEqual(100);
      expect(new Set(deste.flat()), `${tabela}.${coluna}`).toEqual(new Set(esperados));
    }
  });

  it("pelo token, o negócio juntado traz o contato — e o selo acha o setor do NEGÓCIO como na sessão", async () => {
    vi.mocked(resolveAuthDual).mockImplementation(
      async () =>
        ({
          ok: true as const,
          organizationId: ORG,
          actor: { type: "user" as const, id: ANA },
          supabase: await createClient(),
          via: "token" as const,
          scopes: ["mcp:read"],
          apiTokenId: "tok-1",
        }) as never,
    );
    const filtros = fazerSupabase({
      crm_tasks: { data: [tarefa({ lead_id: NEGOCIO, assigned_to: null })], error: null },
      crm_leads: { data: [{ id: NEGOCIO, title: "Peru", contact_id: CONTATO }], error: null },
      conversations: {
        data: [
          {
            id: CONVERSA_DO_CONTATO,
            contact_id: CONTATO,
            sector_id: CORPORATIVO,
            last_message_at: "2026-11-16T09:00:00Z",
          },
        ],
        error: null,
      },
    });

    const { res, corpo } = await listar("?com_setor=true");
    expect(res.status).toBe(200);
    expect(filtros.crm_leads).toContainEqual(["select", "id, title, contact_id", undefined]);
    expect(filtros.crm_leads).toContainEqual(["eq", "organization_id", ORG]);
    expect(corpo.data.tasks[0].setor).toEqual({ id: CORPORATIVO, origem: "negocio" });
  });
});


describe("GET /api/v1/tasks?contact_id= — a busca do painel da conversa (#4630)", () => {
  it("é uma consulta só, filtrada pela organização da sessão e pelo contato", async () => {
    sessao();
    const filtros = fazerSupabase({ crm_tasks: { data: [], error: null } });
    const { res } = await listar(`?contact_id=${CONTATO}&aberto=true`);
    expect(res.status).toBe(200);
    expect(Object.keys(filtros)).toEqual(["crm_tasks"]);
    expect(filtros.crm_tasks).toContainEqual(["eq", "organization_id", ORG]);
    expect(filtros.crm_tasks).toContainEqual(["eq", "contact_id", CONTATO]);
  });
});

describe("a tela de Tarefas: um selo só, e o servidor decide", () => {
  it("só a tela de Tarefas pede setores, com o módulo ligado", () => {
    const tela = readFileSync("app/app/tasks/_components/TarefasClient.tsx", "utf8");
    expect(tela).toMatch(/useSectors\(setoresLigados\)/);
    expect(tela).toMatch(/setoresLigados = false/);
    // O roster (`/api/v1/attendants`, agent+) era pedido só para montar o mapa
    // "responsável → setor" do chip. O chip agora vem do servidor (#4883), e o
    // pedido saiu junto — a lista de responsáveis continua vindo de
    // `useAssignableMembers`, que é quem dá o NOME de quem tem a tarefa.
    expect(tela).not.toMatch(/useAttendants/);
    const pagina = readFileSync("app/app/tasks/page.tsx", "utf8");
    expect(pagina).toMatch(/setoresLigados=\{await moduloLigado\(createAdminClient\(\), "setores"\)\}/);
    // A lista e o quadro também moram no painel do inbox e no dossiê: lá não há
    // setor a pedir. Eles recebem os setores por id, ou nenhum.
    for (const arquivo of [
      "app/app/tasks/_components/ListaDeTarefas.tsx",
      "app/app/tasks/_components/QuadroDeTarefas.tsx",
    ]) {
      const fonte = readFileSync(arquivo, "utf8");
      expect(fonte, arquivo).not.toMatch(/useSectors\(|useAttendants\(/);
      expect(fonte, arquivo).toMatch(/setores = SEM_SETOR/);
      // O chip não decide mais nada: desenha `tarefa.setor`, que veio do servidor.
      expect(fonte, arquivo).toMatch(/<SeloDeSetor setor=\{tarefa\.setor\} setores=\{setores\} \/>/);
      expect(fonte, arquivo).not.toMatch(/setorDoResponsavel/);
    }
  });

  it("o selo mostra o que o servidor decidiu e MARCA o fallback do responsável", () => {
    const selo = readFileSync("app/app/tasks/_components/SeloDeSetor.tsx", "utf8");
    expect(selo).toMatch(/setor\.origem === "responsavel"/);
    expect(selo).toMatch(/Setor do responsável — a tarefa não tem conversa nem negócio com setor/);
    expect(selo).toMatch(/data-origem-do-setor=\{setor\.origem\}/);
  });

  it("a tela manda o setor escolhido e pede o campo derivado", () => {
    const tela = readFileSync("app/app/tasks/_components/TarefasClient.tsx", "utf8");
    expect(tela).toMatch(/sector_id: setor === "todos" \? undefined : setor/);
    expect(tela).toMatch(/com_setor: setoresLigados/);
    const hook = readFileSync("hooks/tasks/useTasks.ts", "utf8");
    expect(hook).toMatch(/params\.set\("sector_id", filtros\.sector_id\)/);
    expect(hook).toMatch(/params\.set\("com_setor", "true"\)/);
  });
});
