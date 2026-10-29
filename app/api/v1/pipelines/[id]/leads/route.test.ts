/**
 * A LISTA DO FUNIL PAGINADA NO BANCO (#3172, fatia 1).
 *
 * ─── O que este arquivo mede, e por quê ─────────────────────────────────────
 *
 * O defeito da issue não é visual: é a LEITURA. `GET …/board` lê o funil
 * inteiro, e num funil migrado com milhares de negócios isso levou 19 s (cada
 * linha passa por `fn_can_view_lead`), até estourar o `statement_timeout` do
 * papel `authenticated`. A rota nova lê UMA página com `range`.
 *
 * Por isso o caso que importa aqui é o da PÁGINA 2: ele é o único que distingue
 * "leu a página pedida" de "leu o funil inteiro e devolveu o pedaço que deu".
 * Uma rota sem `range` (a sabotagem que a issue pede) passa em todos os casos de
 * página 1 e cai exatamente neste.
 *
 * ─── As três coisas do arremate do CR, cada uma com o seu caso ───────────────
 *
 *   * a página é DETERMINÍSTICA: dois negócios com a MESMA `position_in_stage`
 *     saem sempre na mesma ordem, porque a consulta desempata por `id` —
 *     tirar o `.order("id")` deixa este caso vermelho;
 *   * o `has_more` vem de `per_page + 1` LINHAS, e não de uma contagem exata:
 *     o `meta` não tem `total`, e a linha extra não vai para a tela;
 *   * o ÍNDICE existe na migration e no apêndice do baseline, nas quatro
 *     colunas que a consulta filtra e ordena (o banco não é medido aqui — o que
 *     se mede é que o artefato que o self-host aplica carrega o índice).
 *
 * O dublê de banco (`tests/helpers/stages-db-double`) aplica `eq`/`neq`,
 * `order`, `range` e `count` de verdade: um stub de linha fixa mediria o stub,
 * não o handler.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { ORG_ID, PIPE, authOk, makeDb, type LeadRow } from "@/tests/helpers/stages-db-double";

const OUTRO_PIPE = "77777777-7777-4777-8777-777777777777";

const ctx = (id: string = PIPE) => ({ params: Promise.resolve({ id }) });

const requisicao = (qs = "", id: string = PIPE) =>
  new NextRequest(`http://localhost/api/v1/pipelines/${id}/leads${qs}`);

/**
 * Um negócio de `crm_leads` com os campos que a LISTA lê — `position_in_stage`
 * (a ordem do quadro) e `status` (o arquivado que fica fora).
 *
 * O `LeadRow` do dublê declara só o que as rotas de etapa e quadro leem; o
 * `as unknown as` é o cast declarado do resto das colunas, e não um alívio de
 * tipo: sem ele o teste não poderia montar o funil que a lista existe para ler.
 */
function daLista(id: string, over: Record<string, unknown> = {}): LeadRow {
  return {
    id,
    stage_id: "e1",
    pipeline_id: PIPE,
    organization_id: ORG_ID,
    contact_id: null,
    position_in_stage: 0,
    status: "open",
    title: id,
    ...over,
  } as unknown as LeadRow;
}

/**
 * Cinco negócios em posições distintas — a ordem do quadro. Posições distintas
 * de propósito: em empate, o dublê (e o Postgres sem desempate) não promete
 * ordem, e um teste sobre qual item cai em qual página mediria o acaso.
 */
const CINCO: LeadRow[] = [
  daLista("l1", { position_in_stage: 10, title: "Um" }),
  daLista("l2", { position_in_stage: 20, title: "Dois" }),
  daLista("l3", { position_in_stage: 30, title: "Três" }),
  daLista("l4", { position_in_stage: 40, title: "Quatro" }),
  daLista("l5", { position_in_stage: 50, title: "Cinco" }),
];

/** O corpo do envelope de sucesso, já lido. */
async function corpo(res: Response) {
  return (await res.json()) as {
    data: Array<{ id: string }>;
    meta?: { page: number; per_page: number; has_more: boolean };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/pipelines/[id]/leads", () => {
  it("exige viewer — ler a lista é a mesma permissão de abrir o quadro", async () => {
    authOk();
    makeDb({ leads: CINCO });
    const { GET } = await import("./route");
    await GET(requisicao(), ctx());
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("viewer");
  });

  it("sem auth → repassa a resposta do portão, sem ler o banco", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401, {}),
    });
    const db = makeDb({ leads: CINCO });
    const { GET } = await import("./route");
    const res = await GET(requisicao("?page=2&per_page=2"), ctx());
    expect(res.status).toBe(401);
    expect(db.escritas).toEqual([]);
  });

  it("⭐ a PÁGINA 2 devolve só os itens dela, e o `meta` diz que há mais", async () => {
    authOk();
    makeDb({ leads: CINCO });
    const { GET } = await import("./route");

    const { data, meta } = await corpo(await GET(requisicao("?page=2&per_page=2"), ctx()));

    // Sem `range` na consulta, é aqui que o teste cai: o funil inteiro volta.
    expect(data.map((l) => l.id)).toEqual(["l3", "l4"]);
    // Sem `total`: a rota não conta mais (o `has_more` sai da linha
    // `per_page + 1`), e um `meta` que prometesse total voltaria a pagar a
    // varredura do funil que o CR mandou tirar.
    expect(meta).toEqual({ page: 2, per_page: 2, has_more: true });
    expect(meta).not.toHaveProperty("total");
  });

  it("a ÚLTIMA página não promete próxima", async () => {
    authOk();
    makeDb({ leads: CINCO });
    const { GET } = await import("./route");

    const { data, meta } = await corpo(await GET(requisicao("?page=3&per_page=2"), ctx()));

    expect(data.map((l) => l.id)).toEqual(["l5"]);
    expect(meta?.has_more).toBe(false);
  });

  it("página cheia na última fatia NÃO tem próxima — a linha a mais é quem fala", async () => {
    authOk();
    makeDb({ leads: CINCO });
    const { GET } = await import("./route");

    const res = await GET(requisicao("?page=1&per_page=5"), ctx());
    const { data, meta } = await corpo(res);

    expect(data).toHaveLength(5);
    expect(meta).toEqual({ page: 1, per_page: 5, has_more: false });
  });

  it("a linha `per_page + 1` decide o `has_more` e NÃO vai para a tela", async () => {
    authOk();
    makeDb({ leads: CINCO });
    const { GET } = await import("./route");

    // `per_page=2` num funil de 5: o banco devolve 3 e a tela recebe 2.
    const { data, meta } = await corpo(await GET(requisicao("?page=1&per_page=2"), ctx()));

    expect(data.map((l) => l.id)).toEqual(["l1", "l2"]);
    expect(meta?.has_more).toBe(true);

    // A ÚLTIMA fatia: 5 negócios, `per_page=4` → o banco devolve 5 (≤ 4+1),
    // então não há próxima. É o caso que a contagem exata errava para MAIS
    // quando a página vinha cheia.
    const ultima = await corpo(await GET(requisicao("?page=2&per_page=4"), ctx()));
    expect(ultima.data.map((l) => l.id)).toEqual(["l5"]);
    expect(ultima.meta?.has_more).toBe(false);
  });

  it("⭐ a MESMA posição não embaralha a página: o desempate por `id` é determinístico", async () => {
    authOk();
    // Dois negócios com a MESMA `position_in_stage` (o lote que grava a mesma
    // posição em N linhas o faz), e fora de ordem no banco. Sem o
    // `.order("id")` da consulta, quem cai na página 1 e quem cai na 2 fica
    // por conta do plano: a página 2 pode repetir um item da 1 e pular outro.
    const empatados = [
      daLista("l2", { position_in_stage: 10, title: "Dois" }),
      daLista("l1", { position_in_stage: 10, title: "Um" }),
    ];
    makeDb({ leads: empatados });
    const { GET } = await import("./route");

    const p1 = await corpo(await GET(requisicao("?page=1&per_page=1"), ctx()));
    const p2 = await corpo(await GET(requisicao("?page=2&per_page=1"), ctx()));

    expect(p1.data.map((l) => l.id)).toEqual(["l1"]);
    expect(p2.data.map((l) => l.id)).toEqual(["l2"]);
    expect(p1.meta?.has_more).toBe(true);
    expect(p2.meta?.has_more).toBe(false);

    // A ordem da TABELA muda; a da página não. É isto que o desempate promete.
    makeDb({ leads: [...empatados].reverse() });
    const { GET: GET2 } = await import("./route");
    const outra = await corpo(await GET2(requisicao("?page=1&per_page=1"), ctx()));
    expect(outra.data.map((l) => l.id)).toEqual(["l1"]);
  });

  it("a ordem é a do quadro (`position_in_stage`)", async () => {
    authOk();
    // Fora de ordem no banco: com o `.order` apagado, a página sairia embaralhada.
    makeDb({ leads: [CINCO[2]!, CINCO[0]!, CINCO[4]!, CINCO[1]!, CINCO[3]!] });
    const { GET } = await import("./route");

    const { data } = await corpo(await GET(requisicao("?page=1&per_page=10"), ctx()));

    expect(data.map((l) => l.id)).toEqual(["l1", "l2", "l3", "l4", "l5"]);
  });

  it("negócio arquivado e negócio de OUTRO funil ficam fora — e do `has_more` também", async () => {
    authOk();
    makeDb({
      leads: [
        CINCO[0]!,
        daLista("arq", { position_in_stage: 60, status: "archived" }),
        daLista("outro", { position_in_stage: 70, pipeline_id: OUTRO_PIPE }),
      ],
    });
    const { GET } = await import("./route");

    const { data, meta } = await corpo(await GET(requisicao("?page=1&per_page=10"), ctx()));

    expect(data.map((l) => l.id)).toEqual(["l1"]);
    // Um negócio só, `per_page` 10: nada além dele, então não há próxima. Se o
    // arquivado entrasse na conta, a rota prometeria uma página que volta vazia.
    expect(meta).toEqual({ page: 1, per_page: 10, has_more: false });
  });

  it("`per_page` acima do teto é o TETO, não um 422: a lista inteira não se perde por isso", async () => {
    authOk();
    makeDb({ leads: CINCO });
    const { GET } = await import("./route");

    const { meta } = await corpo(await GET(requisicao("?per_page=5000"), ctx()));

    expect(meta?.per_page).toBe(200);
  });

  it("`page` inválida (`0`, `abc`) cai na 1 — a resposta não mente sobre a pergunta", async () => {
    authOk();
    makeDb({ leads: CINCO });
    const { GET } = await import("./route");

    for (const invalida of ["0", "abc", "-3"]) {
      const { meta } = await corpo(await GET(requisicao(`?page=${invalida}`), ctx()));
      expect(meta?.page).toBe(1);
    }
  });

  it("funil de outra organização (ou inexistente) → 404, e não lista vazia", async () => {
    authOk();
    // A linha existe, mas é de OUTRA organização: o `eq("organization_id")` é
    // quem separa — sem ele, um id alheio vazaria os negócios do outro tenant.
    makeDb({
      pipelines: [
        {
          id: OUTRO_PIPE,
          name: "Alheio",
          slug: "alheio",
          description: null,
          position: 1000,
          is_default: false,
          is_archived: false,
          organization_id: "99999999-9999-4999-8999-999999999999",
        },
      ],
      leads: CINCO,
    });
    const { GET } = await import("./route");

    const res = await GET(requisicao("", OUTRO_PIPE), ctx(OUTRO_PIPE));

    expect(res.status).toBe(404);
  });

  it("erro de leitura do banco → 500, nunca `data: []` (lista vazia seria mentira)", async () => {
    authOk();
    makeDb({
      leads: CINCO,
      readError: (table) =>
        table === "crm_leads" ? { code: "XX000", message: "banco caiu" } : null,
    });
    const { GET } = await import("./route");

    const res = await GET(requisicao("?page=1&per_page=2"), ctx());

    expect(res.status).toBe(500);
  });
});

describe("o isolamento por organização, medido nos filtros emitidos", () => {
  it("o `organization_id` vai na leitura do funil E na dos negócios", async () => {
    authOk();
    // `readError` devolvendo `null` não é erro: é a única janela para ver os
    // filtros que a rota emitiu. Sem `eq("organization_id")` na consulta de
    // `crm_leads`, um id de funil alheio listaria negócios de outro tenant.
    const vistos: Record<string, Array<Array<[string, unknown]>>> = {};
    makeDb({
      leads: CINCO,
      readError: (table, filtros) => {
        (vistos[table] ??= []).push(filtros);
        return null;
      },
    });
    const { GET } = await import("./route");

    await GET(requisicao("?page=1&per_page=2"), ctx());

    expect(vistos.crm_pipelines?.[0]).toContainEqual(["organization_id", ORG_ID]);
    expect(vistos.crm_leads?.[0]).toContainEqual(["organization_id", ORG_ID]);
    expect(vistos.crm_leads?.[0]).toContainEqual(["pipeline_id", PIPE]);
  });

  it("funil com o id certo mas de outra organização → 404", async () => {
    authOk();
    makeDb({
      pipelines: [
        {
          id: PIPE,
          name: "Do vizinho",
          slug: "vizinho",
          description: null,
          position: 1000,
          is_default: false,
          is_archived: false,
          organization_id: "99999999-9999-4999-8999-999999999999",
        },
      ],
      leads: CINCO,
    });
    const { GET } = await import("./route");

    const res = await GET(requisicao(), ctx(PIPE));

    expect(res.status).toBe(404);
  });
});

/**
 * O ÍNDICE DA PÁGINA — no artefato que o self-host aplica.
 *
 * O `range` da rota corta o que VOLTA, não o que o banco AVALIA: sem um índice
 * na ordem pedida, o Postgres passa a regra de visibilidade em todo o funil
 * antes de ordenar (medido pelo mantenedor: 3.901 chamadas de
 * `fn_can_view_lead` e ~3,8 s na página 1 num funil de 3.901 negócios). O
 * conserto é DDL, e DDL mora em dois lugares: a migration versionada e o
 * apêndice do `baseline.sql` — o arquivo que o kit self-host realmente aplica.
 * Sem o apêndice, quem instalou numa VPS não recebe o índice; sem a migration,
 * quem replica a pasta `migrations/` em ordem também não.
 *
 * A ordem das colunas é o MIOLO da asserção, não um detalhe: um btree com o
 * prefixo de igualdade (`organization_id`, `pipeline_id`) seguido das colunas de
 * ordenação (`position_in_stage`, `id`) é o que permite ao plano parar depois de
 * `per_page + 1` linhas. Índice com as mesmas colunas em outra ordem não serve
 * para a página — e passaria num teste que só conferisse os NOMES das colunas.
 */
const RAIZ = process.cwd();

/** O texto da migration que cria o índice, achado pelo NOME do índice. */
function migrationDoIndice(): { arquivo: string; sql: string } {
  const dir = join(RAIZ, "supabase", "migrations");
  const arquivos = readdirSync(dir).filter((f) => f.endsWith(".sql"));
  const comIndice = arquivos.filter((f) =>
    readFileSync(join(dir, f), "utf8").includes("idx_crm_leads_org_pipeline_position_id"),
  );
  expect(
    comIndice,
    "nenhuma migration cria idx_crm_leads_org_pipeline_position_id — o índice que a página precisa não existe no DDL",
  ).toHaveLength(1);
  return { arquivo: comIndice[0]!, sql: readFileSync(join(dir, comIndice[0]!), "utf8") };
}

describe("o índice da página (migration + apêndice no baseline)", () => {
  it("a migration segue o padrão do repositório e se descreve no cabeçalho", () => {
    const { arquivo, sql } = migrationDoIndice();

    expect(arquivo).toMatch(/^\d{14}_\d{4}_[a-z0-9_]+\.sql$/);
    // O `-- manifest:` é o registro da migration desde 02/10/2026 (o
    // MANIFEST.md é histórico): migration sem ele é mudança de schema que
    // ninguém descreveu.
    expect(sql).toMatch(/^-- manifest:[ \t]*\S/m);
  });

  it("o índice é criado por idempotência, nas quatro colunas na ordem da consulta", () => {
    const { sql } = migrationDoIndice();

    // `if not exists`: a migration pode rodar num banco que já a aplicou (é o
    // que o `baseline` faz a cada instalação por cima).
    expect(sql).toMatch(/create index if not exists idx_crm_leads_org_pipeline_position_id/i);
    expect(sql).toMatch(
      /on\s+public\.crm_leads\s*\(\s*organization_id\s*,\s*pipeline_id\s*,\s*position_in_stage\s*,\s*id\s*\)/i,
    );
  });

  it("o apêndice do baseline tem o MESMO índice — é ele que o self-host aplica", () => {
    const { sql } = migrationDoIndice();
    const baseline = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");

    // O bloco inteiro da migration precisa estar no baseline: o `create index`
    // e o `comment on index` que o acompanha.
    for (const linha of sql
      .split("\n")
      .filter((l) => /^(create index|comment on index)/i.test(l))) {
      expect(baseline, `o baseline não tem: ${linha}`).toContain(linha);
    }
    expect(baseline).toMatch(/create index if not exists idx_crm_leads_org_pipeline_position_id/i);
  });
});
