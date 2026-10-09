import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { AVISO_DO_JEV } from "@/lib/ai/decisao/textos";

/**
 * OS AVISOS DA CENTRAL CUJA CHAVE É O TÍTULO NÃO ABREM EM DOBRO.
 *
 * Quatro escritores de `kind='other'` deduplicam por (organização, título) com
 * PERGUNTA e ESCRITA separadas — o aviso do Jev (`lib/ai/decisao/aviso.ts`), o
 * saldo (`espera-de-saldo.ts`), a recusa por endereço sem chave da empresa
 * (`run-model-call.ts`) e o laço do event-log (`aviso-do-laco.ts`). Eles rodam
 * concorrentes: o worker roda jobs em PARALELO, e o aviso do Jev é aberto por
 * dois drenos. A nota do próprio `aviso.ts` já pedia este índice ("Fecha de vez
 * só com índice único parcial (org, título) em `kind='other' and status='open'`)
 * — a migration 0539 o entrega.
 *
 * Este arquivo mede contra Postgres porque SQL não se prova com dublê. Cada
 * direção sozinha passaria por um motivo errado:
 *
 *   1. o aviso do Jev (sem ref própria) ⇒ uma linha aberta, e a segunda leva
 *      `23505` — o desfecho que o escritor trata como "já havia aviso";
 *   2. o de saldo, com a credencial de IA como ref: a chave é o TÍTULO, então
 *      DUAS credenciais diferentes não abrem dois avisos na mesma organização;
 *   3. controle do discriminador: avisos de grão PRÓPRIO (`lead`, `agent_case`)
 *      convivem abertos com o MESMO título — o índice não os recusa;
 *   4. a trava é POR ORGANIZAÇÃO; e
 *   5. resolvido o aviso, o próximo abre outro — dedupe não é "nunca mais".
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

const ORG_A = "ed0c0000-0000-4000-8000-00000000004a";
const ORG_B = "ed0c0000-0000-4000-8000-00000000004b";
const LEAD_1 = "ed0c0000-0000-4000-8000-0000000000d1";
const LEAD_2 = "ed0c0000-0000-4000-8000-0000000000d2";
const CASE_1 = "ed0c0000-0000-4000-8000-0000000000d3";
const CASE_2 = "ed0c0000-0000-4000-8000-0000000000d4";
const CRED_1 = "ed0c0000-0000-4000-8000-0000000000e1";
const CRED_2 = "ed0c0000-0000-4000-8000-0000000000e2";

/** O título REAL do aviso do Jev (a chave do dedupe dele). */
const JEV = AVISO_DO_JEV.titulo;
/** O título REAL do aviso de saldo (`espera-de-saldo.ts`). */
const SALDO = "A IA está sem saldo no provedor";
/** Título de grão próprio: o espelho de stage abre um por negócio. */
const TITULO_DO_LEAD = "Espelho de stage no CRM falhou — funil possivelmente inconsistente";

async function abrir(
  org: string,
  titulo: string,
  refKind: string | null = null,
  refId: string | null = null,
): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
     values ($1, 'other', 'warn', $2, 'Motivo: teste', $3, $4)
     returning id`,
    [org, titulo, refKind, refId],
  );
  return rows[0]?.id ?? null;
}

async function tentar(
  org: string,
  titulo: string,
  refKind: string | null = null,
  refId: string | null = null,
): Promise<{ id: string | null; code: string | null }> {
  try {
    return { id: await abrir(org, titulo, refKind, refId), code: null };
  } catch (err) {
    return { id: null, code: (err as { code?: string }).code ?? "sem-code" };
  }
}

const abertos = async (org: string, titulo: string): Promise<number> => {
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from agent_inbox_items
      where organization_id = $1 and kind = 'other' and title = $2 and status = 'open'`,
    [org, titulo],
  );
  return rows[0]!.n;
};

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2::text, $2::text, $2::text)`,
    [ORG_A, "other-titulo-a"],
  );
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2::text, $2::text, $2::text)`,
    [ORG_B, "other-titulo-b"],
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

describe("os avisos `other` de grão título não abrem em dobro", () => {
  it("o aviso do Jev (sem ref própria): o segundo é recusado com 23505 e sobra UMA linha aberta", async () => {
    const primeiro = await tentar(ORG_A, JEV);
    const segundo = await tentar(ORG_A, JEV);

    expect(
      primeiro.code,
      "o primeiro aviso foi recusado — o índice está barrando o caso legítimo",
    ).toBeNull();
    expect(segundo.code, "o segundo aviso passou: a corrida do Jev continua aberta").toBe("23505");
    expect(await abertos(ORG_A, JEV)).toBe(1);
  });

  it("o aviso de saldo: a chave é o TÍTULO — duas credenciais diferentes não abrem dois", async () => {
    const primeiro = await tentar(ORG_A, SALDO, "ai_provider_credential", CRED_1);
    const segundo = await tentar(ORG_A, SALDO, "ai_provider_credential", CRED_2);

    expect(primeiro.code, "o primeiro aviso de saldo foi recusado").toBeNull();
    expect(
      segundo.code,
      "a segunda credencial abriu um segundo aviso: o índice está por ref em vez de por título",
    ).toBe("23505");
    expect(await abertos(ORG_A, SALDO)).toBe(1);
  });

  it("controle: os avisos de grão PRÓPRIO (ref `lead`) convivem com o MESMO título", async () => {
    const doPrimeiro = await tentar(ORG_A, TITULO_DO_LEAD, "lead", LEAD_1);
    const doSegundo = await tentar(ORG_A, TITULO_DO_LEAD, "lead", LEAD_2);

    expect(
      doPrimeiro.code,
      "o primeiro aviso de lead foi recusado — o índice invadiu o grão de ref própria",
    ).toBeNull();
    expect(
      doSegundo.code,
      "o aviso do segundo lead foi recusado: um índice por (organização, título) apagaria sinal legítimo",
    ).toBeNull();
    expect(await abertos(ORG_A, TITULO_DO_LEAD)).toBe(2);
  });

  it("controle: ref `agent_case` também fica fora do grão título", async () => {
    const primeiro = await tentar(ORG_A, "A IA pediu ajuda à equipe", "agent_case", CASE_1);
    const segundo = await tentar(ORG_A, "A IA pediu ajuda à equipe", "agent_case", CASE_2);
    // Um por caso, com o MESMO título: quem separa é o ref do escritor.
    expect(primeiro.code).toBeNull();
    expect(segundo.code).toBeNull();
    expect(await abertos(ORG_A, "A IA pediu ajuda à equipe")).toBe(2);
  });

  it("a trava é por ORGANIZAÇÃO — o aviso do Jev de uma não cala a vizinha", async () => {
    const daVizinha = await tentar(ORG_B, JEV);
    expect(daVizinha.code, "o índice está global em vez de por organização").toBeNull();
    expect(await abertos(ORG_B, JEV)).toBe(1);
  });

  it("resolvido o aviso, o próximo abre outro — dedupe não é 'nunca mais'", async () => {
    await pool.query(
      `update agent_inbox_items set status = 'resolved', resolved_at = now()
        where organization_id = $1 and kind = 'other' and title = $2 and status = 'open'`,
      [ORG_A, JEV],
    );
    const depois = await tentar(ORG_A, JEV);
    expect(
      depois.code,
      "o aviso do Jev não reabre depois de resolvido — o dedupe virou mordaça",
    ).toBeNull();
    expect(await abertos(ORG_A, JEV)).toBe(1);
  });

  it("o índice é o mesmo dos dois artefatos: o nome que a migration cria está no banco aplicado", async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'public' and tablename = 'agent_inbox_items'
          and indexname = 'agent_inbox_other_por_titulo_aberto_unico'`,
    );
    expect(rows.length, "o índice não existe no banco aplicado").toBe(1);
    const def = rows[0]!.indexdef.replace(/\s+/g, " ").toLowerCase();
    expect(def).toContain("unique index");
    expect(def).toContain("(organization_id, kind, title)");
    expect(def).toContain("status = 'open'::text");
    expect(def).toContain("kind = 'other'::text");
    expect(def).toContain("ref_kind is null");
    expect(def).toContain("ref_kind = 'ai_provider_credential'::text");
  });
});
