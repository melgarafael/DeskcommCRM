/**
 * A LISTA DO FUNIL RESPEITA RESPONSÁVEL E STATUS DA BARRA (#3172, fatia 2).
 *
 * ─── O defeito que este arquivo mede ────────────────────────────────────────
 *
 * Com a aba Lista aberta, a barra de filtros aparecia e não fazia nada: a rota
 * `…/leads` não recebia filtro nenhum. "Responsável: Vânia" e "Responsável:
 * Josi" mostravam os mesmos negócios.
 *
 * O caso ⭐ é o que distingue "filtrou na CONSULTA" de "filtrou a página depois
 * de lida": os negócios da Ana estão nas posições 4 e 5. Com `per_page=2`, a
 * página 1 sem filtro é [l1, l2]; filtrar essa página em memória daria [] —
 * e a Ana tem dois negócios. Só o filtro antes do `range` devolve [l4, l5].
 *
 * O dublê (`tests/helpers/stages-db-double`) aplica `eq`, `is`, `neq`, `order` e
 * `range` de verdade, então o que se mede é o handler, não um stub.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { ORG_ID, PIPE, authOk, makeDb, type LeadRow } from "@/tests/helpers/stages-db-double";

const ANA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BIA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENTE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const ctx = () => ({ params: Promise.resolve({ id: PIPE }) });
const requisicao = (qs: string) =>
  new NextRequest(`http://localhost/api/v1/pipelines/${PIPE}/leads${qs}`);

/**
 * Um negócio com as colunas de DONO explícitas. `null` e não ausente: o dublê
 * compara como o banco, e `undefined` não é `NULL`.
 */
function negocio(id: string, pos: number, over: Record<string, unknown> = {}): LeadRow {
  return {
    id,
    stage_id: "e1",
    pipeline_id: PIPE,
    organization_id: ORG_ID,
    contact_id: null,
    position_in_stage: pos,
    status: "open",
    title: id,
    owner_user_id: null,
    owner_agent_id: null,
    ...over,
  } as unknown as LeadRow;
}

/** Bia nas três primeiras posições, Ana nas duas últimas, mais um do agente e um sem dono. */
const FUNIL: LeadRow[] = [
  negocio("l1", 10, { owner_user_id: BIA }),
  negocio("l2", 20, { owner_user_id: BIA, status: "won" }),
  negocio("l3", 30, { owner_user_id: BIA, status: "lost" }),
  negocio("l4", 40, { owner_user_id: ANA }),
  negocio("l5", 50, { owner_user_id: ANA, status: "won" }),
  negocio("l6", 60, { owner_agent_id: AGENTE }),
  negocio("l7", 70),
];

async function ids(res: Response) {
  const corpo = (await res.json()) as { data: Array<{ id: string }>; meta?: { has_more: boolean } };
  return { ids: corpo.data.map((l) => l.id), hasMore: corpo.meta?.has_more };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET …/leads com os filtros da barra", () => {
  it("⭐ Responsável filtra ANTES do range: a página 1 da Ana são os negócios DELA", async () => {
    authOk();
    makeDb({ leads: FUNIL });
    const { GET } = await import("./route");

    const r = await ids(await GET(requisicao(`?page=1&per_page=2&owner=${ANA}`), ctx()));

    // Filtrar a página [l1, l2] depois de lida daria [] — o defeito da tela.
    expect(r.ids).toEqual(["l4", "l5"]);
    expect(r.hasMore).toBe(false);
  });

  it("trocar de pessoa troca a resposta (era o sintoma: Vânia e Josi viam o mesmo)", async () => {
    authOk();
    makeDb({ leads: FUNIL });
    const { GET } = await import("./route");

    const daAna = await ids(await GET(requisicao(`?owner=${ANA}`), ctx()));
    const daBia = await ids(await GET(requisicao(`?owner=${BIA}`), ctx()));

    expect(daAna.ids).toEqual(["l4", "l5"]);
    expect(daBia.ids).toEqual(["l1", "l2", "l3"]);
  });

  it("`agent:<uuid>` casa o dono AGENTE, e não uma pessoa com o mesmo id", async () => {
    authOk();
    makeDb({ leads: FUNIL });
    const { GET } = await import("./route");

    const r = await ids(await GET(requisicao(`?owner=agent:${AGENTE}`), ctx()));

    expect(r.ids).toEqual(["l6"]);
  });

  it("`unassigned` é sem dono NENHUM — negócio com agente tem dono, como no quadro", async () => {
    authOk();
    makeDb({ leads: FUNIL });
    const { GET } = await import("./route");

    const r = await ids(await GET(requisicao("?owner=unassigned"), ctx()));

    expect(r.ids).toEqual(["l7"]);
  });

  it("Status filtra, e combina com Responsável (E, não OU)", async () => {
    authOk();
    makeDb({ leads: FUNIL });
    const { GET } = await import("./route");

    const ganhos = await ids(await GET(requisicao("?status=won"), ctx()));
    const ganhosDaBia = await ids(await GET(requisicao(`?status=won&owner=${BIA}`), ctx()));

    expect(ganhos.ids).toEqual(["l2", "l5"]);
    expect(ganhosDaBia.ids).toEqual(["l2"]);
  });

  it("`any` e `all` são o \"Todos\" que a barra escreve: o funil inteiro, como sem filtro", async () => {
    authOk();
    makeDb({ leads: FUNIL });
    const { GET } = await import("./route");

    const todos = await ids(await GET(requisicao("?owner=any&status=all"), ctx()));

    expect(todos.ids).toEqual(["l1", "l2", "l3", "l4", "l5", "l6", "l7"]);
  });

  it("filtro que não se entende é 422 — e o banco de negócios nem é lido", async () => {
    authOk();
    const lidas: string[] = [];
    makeDb({
      leads: FUNIL,
      readError: (tabela) => {
        lidas.push(tabela);
        return null;
      },
    });
    const { GET } = await import("./route");

    const donoRuim = await GET(requisicao("?owner=vania"), ctx());
    const statusRuim = await GET(requisicao("?status=ganho"), ctx());
    const agenteRuim = await GET(requisicao("?owner=agent:xyz"), ctx());

    expect(donoRuim.status).toBe(422);
    expect(statusRuim.status).toBe(422);
    expect(agenteRuim.status).toBe(422);
    // O funil inteiro com cara de filtrado é a resposta que não pode sair.
    expect(lidas).not.toContain("crm_leads");
  });

  it("o filtro não abre outra organização: `organization_id` continua na consulta", async () => {
    authOk();
    const vistos: Array<Array<[string, unknown]>> = [];
    makeDb({
      leads: FUNIL,
      readError: (tabela, filtros) => {
        if (tabela === "crm_leads") vistos.push(filtros);
        return null;
      },
    });
    const { GET } = await import("./route");

    await GET(requisicao(`?owner=${ANA}&status=open`), ctx());

    expect(vistos[0]).toContainEqual(["organization_id", ORG_ID]);
    expect(vistos[0]).toContainEqual(["owner_user_id", ANA]);
    expect(vistos[0]).toContainEqual(["status", "open"]);
  });
});
