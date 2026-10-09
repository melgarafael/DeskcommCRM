import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * OS AVISOS DE ORÇAMENTO DE IA NÃO ABREM EM DOBRO.
 *
 * `budget_exceeded` e `budget_warning` deduplicam por (organização, kind) com
 * PERGUNTA e ESCRITA separadas — a CTE `avisa` de `SQL_ORCAMENTO` e o insert do
 * `budget_exceeded` (`lib/agent-engine/edge/llm/run-model-call.ts`), e o
 * `abrirItemDeOrcamento` (`workers/ai-response-worker.ts`, que declara a corrida
 * no próprio comentário: "dois drains simultâneos podem abrir dois itens iguais
 * lá e aqui"). O worker roda jobs em PARALELO, então dois turnos avaliam o
 * orçamento no mesmo instante; a migration 0540 entrega o índice que a issue
 * #880 propôs para este grão.
 *
 * Este arquivo mede contra Postgres porque SQL não se prova com dublê:
 *
 *   1. dois avisos do MESMO kind ⇒ uma linha aberta, e o segundo leva `23505`;
 *   2. a chave é o PAR (organização, kind): `budget_exceeded` e
 *      `budget_warning` convivem abertos — um relata que a IA parou, o outro
 *      que o gasto passou do aviso e ela segue;
 *   3. a trava é POR ORGANIZAÇÃO; e
 *   4. resolvido o aviso, o próximo abre outro — dedupe não é "nunca mais".
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG_A = "ed0c0000-0000-4000-8000-00000000005a";
const ORG_B = "ed0c0000-0000-4000-8000-00000000005b";

async function abrir(org: string, kind: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
     values ($1, $2, $3, $4, 'Motivo: teste', 'ai_budget', $1)
     returning id`,
    [
      org,
      kind,
      kind === "budget_exceeded" ? "critical" : "warn",
      kind === "budget_exceeded"
        ? "O orçamento de IA foi atingido"
        : "O gasto de IA passou do aviso",
    ],
  );
  return rows[0]?.id ?? null;
}

async function tentar(
  org: string,
  kind: string,
): Promise<{ id: string | null; code: string | null }> {
  try {
    return { id: await abrir(org, kind), code: null };
  } catch (err) {
    return { id: null, code: (err as { code?: string }).code ?? "sem-code" };
  }
}

const abertos = async (org: string, kind?: string): Promise<number> => {
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from agent_inbox_items
      where organization_id = $1
        and kind in ('budget_exceeded','budget_warning')
        and ($2::text is null or kind = $2)
        and status = 'open'`,
    [org, kind ?? null],
  );
  return rows[0]!.n;
};

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2::text, $2::text, $2::text)`,
    [ORG_A, "budget-a"],
  );
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2::text, $2::text, $2::text)`,
    [ORG_B, "budget-b"],
  );
});

afterAll(async () => {
  await pool.query(`delete from agent_inbox_items where organization_id in ($1, $2)`, [
    ORG_A,
    ORG_B,
  ]);
  await pool.query(`delete from organizations where id in ($1, $2)`, [ORG_A, ORG_B]);
  await pool.end();
});

describe("os avisos de orçamento não abrem em dobro", () => {
  it("o segundo aviso do MESMO kind é recusado com 23505, e sobra UMA linha aberta", async () => {
    const primeiro = await tentar(ORG_A, "budget_exceeded");
    const segundo = await tentar(ORG_A, "budget_exceeded");

    expect(
      primeiro.code,
      "o primeiro aviso foi recusado — o índice está barrando o caso legítimo",
    ).toBeNull();
    expect(segundo.code, "o segundo aviso passou: a corrida do orçamento continua aberta").toBe(
      "23505",
    );
    expect(await abertos(ORG_A, "budget_exceeded")).toBe(1);
  });

  it("a chave é o PAR (organização, kind): o aviso do limiar convive com o do bloqueio", async () => {
    const doLimiar = await tentar(ORG_A, "budget_warning");
    expect(
      doLimiar.code,
      "o aviso do limiar foi recusado — o índice colapsou os dois kinds num só",
    ).toBeNull();
    expect(await abertos(ORG_A, "budget_warning")).toBe(1);
    expect(await abertos(ORG_A)).toBe(2);
  });

  it("a trava é por ORGANIZAÇÃO — o aviso de uma não cala a vizinha", async () => {
    const daVizinha = await tentar(ORG_B, "budget_exceeded");
    expect(daVizinha.code, "o índice está global em vez de por organização").toBeNull();
    expect(await abertos(ORG_B, "budget_exceeded")).toBe(1);
    expect(await abertos(ORG_A, "budget_exceeded")).toBe(1);
  });

  it("resolvido o aviso, o próximo abre outro — dedupe não é 'nunca mais'", async () => {
    await pool.query(
      `update agent_inbox_items set status = 'resolved', resolved_at = now()
        where organization_id = $1 and kind = 'budget_exceeded' and status = 'open'`,
      [ORG_A],
    );
    const depois = await tentar(ORG_A, "budget_exceeded");
    expect(
      depois.code,
      "o aviso não reabre depois de resolvido — o dedupe virou mordaça",
    ).toBeNull();
    expect(await abertos(ORG_A, "budget_exceeded")).toBe(1);
  });

  it("o índice é o mesmo dos dois artefatos: o nome que a migration cria está no banco aplicado", async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'public' and tablename = 'agent_inbox_items'
          and indexname = 'agent_inbox_budget_aberto_unico'`,
    );
    expect(rows.length, "o índice não existe no banco aplicado").toBe(1);
    const def = rows[0]!.indexdef.replace(/\s+/g, " ").toLowerCase();
    expect(def).toContain("unique index");
    expect(def).toContain("(organization_id, kind)");
    expect(def).toContain("status = 'open'::text");
    expect(def).toContain("kind = any (array['budget_exceeded'::text, 'budget_warning'::text])");
  });
});
