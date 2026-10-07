import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * A RESPOSTA A CASO OBSOLETO NÃO ABRE EM DOBRO — e é o BANCO que garante.
 *
 * A resposta de um humano a um caso que já mudou de atendimento abre um aviso
 * (`job_dead` com ref de conversa). `avisarRespostaDeCasoObsoleto`
 * (`lib/atendimento/aviso-caso-obsoleto.ts`) usa `insertInboxItem(..., 'kind_e_ref')`,
 * cuja guarda é `insert ... where not exists` — uma PERGUNTA e uma ESCRITA
 * separadas. E há dois escritores sem lock em comum: a rota síncrona
 * `POST /api/v1/ai/cases/[id]/reply` (transação explícita) e o worker
 * (`workers/agent-worker/main.ts`, pool). Os dois leem "não existe" antes de
 * qualquer escrita e os dois inserem — a corrida da issue #880 que a 0491
 * (`event_dead`) e a 0527 (`midia_nao_lida`) fecharam nos outros grãos.
 *
 * Este arquivo mede contra Postgres porque SQL não se prova com dublê. Cada
 * direção sozinha passaria por um motivo errado:
 *
 *   1. dois avisos iguais da MESMA conversa ⇒ uma linha aberta, e o segundo leva
 *      `23505` (é o que o caminho transacional passou a isolar em savepoint);
 *   2. a trava é POR CONVERSA — o aviso de outra conversa não é calado;
 *   3. a trava é POR ORGANIZAÇÃO — o aviso da vizinha não é calado;
 *   4. `job_dead` de JOB/CRON fica FORA (ref_kind diferente): mesmo `ref_id` com
 *      `ref_kind` de ocorrência não é barrado — é registro, não estado;
 *   5. resolvido o aviso, a próxima resposta abre outro — dedupe não é "nunca
 *      mais".
 *
 * O `23505` aqui é o MESMO caminho que o índice parcial da 0538 levanta em
 * produção: o teste não simula a corrida, ele mede o que a corrida produz.
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

const ORG_A = "ed0c0000-0000-4000-8000-00000000002a";
const ORG_B = "ed0c0000-0000-4000-8000-00000000002b";
const CONVERSA = "ed0c0000-0000-4000-8000-0000000000c1";
const OUTRA_CONVERSA = "ed0c0000-0000-4000-8000-0000000000c2";

/** O mesmo `insert` do gravador, com o mínimo que a tabela exige. */
async function abrirAviso(
  org: string,
  refId: string,
  refKind = "conversation",
): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
     values ($1, 'job_dead', 'warn', 'Resposta registrada; atendimento mudou', 'Motivo: teste', $2, $3)
     returning id`,
    [org, refKind, refId],
  );
  return rows[0]?.id ?? null;
}

/** `null` quando o insert passou; o `code` quando o banco recusou. */
async function tentarAbrir(
  org: string,
  refId: string,
  refKind = "conversation",
): Promise<{ id: string | null; code: string | null }> {
  try {
    return { id: await abrirAviso(org, refId, refKind), code: null };
  } catch (err) {
    return { id: null, code: (err as { code?: string }).code ?? "sem-code" };
  }
}

const abertos = async (org: string, refId?: string): Promise<number> => {
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from agent_inbox_items
      where organization_id = $1 and kind = 'job_dead' and ref_kind = 'conversation'
        and ($2::uuid is null or ref_id = $2::uuid) and status = 'open'`,
    [org, refId ?? null],
  );
  return rows[0]!.n;
};

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2::text, $2::text, $2::text)`,
    [ORG_A, "job-dead-a"],
  );
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2::text, $2::text, $2::text)`,
    [ORG_B, "job-dead-b"],
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

describe("a resposta a caso obsoleto não abre em dobro", () => {
  it("o segundo aviso da mesma conversa é recusado com 23505, e sobra UMA linha aberta", async () => {
    const primeiro = await tentarAbrir(ORG_A, CONVERSA);
    const segundo = await tentarAbrir(ORG_A, CONVERSA);

    expect(
      primeiro.code,
      "o primeiro aviso foi recusado — o índice está barrando o caso legítimo",
    ).toBeNull();
    expect(segundo.code, "o segundo aviso passou: a corrida do #880 continua aberta").toBe("23505");
    expect(await abertos(ORG_A, CONVERSA)).toBe(1);
  });

  it("a trava é por CONVERSA — o aviso de outra conversa da mesma organização abre", async () => {
    const outra = await tentarAbrir(ORG_A, OUTRA_CONVERSA);
    expect(outra.code, "o índice está por organização em vez de por conversa").toBeNull();
    expect(await abertos(ORG_A)).toBe(2);
  });

  it("a trava é por ORGANIZAÇÃO — o aviso de uma não cala a vizinha", async () => {
    const daVizinha = await tentarAbrir(ORG_B, CONVERSA);
    expect(daVizinha.code, "o índice está global em vez de por organização").toBeNull();
    expect(await abertos(ORG_B)).toBe(1);
  });

  it("`job_dead` de job/cron fica fora: mesmo ref_id com outro ref_kind não é barrado", async () => {
    const deJob = await tentarAbrir(ORG_A, CONVERSA, "job_queue");
    const deCron = await tentarAbrir(ORG_A, CONVERSA, "cron_jobs");
    expect(deJob.code, "o índice engoliu o registro de ocorrência da fila").toBeNull();
    expect(deCron.code, "o índice engoliu o registro de ocorrência do cron").toBeNull();
    expect(await abertos(ORG_A, CONVERSA)).toBe(1);
  });

  it("resolvido o aviso, a próxima resposta abre outro — dedupe não é 'nunca mais'", async () => {
    await pool.query(
      `update agent_inbox_items set status = 'resolved', resolved_at = now()
        where organization_id = $1 and kind = 'job_dead' and ref_kind = 'conversation'
          and ref_id = $2 and status = 'open'`,
      [ORG_A, CONVERSA],
    );
    const depois = await tentarAbrir(ORG_A, CONVERSA);
    expect(
      depois.code,
      "o aviso não reabre depois de resolvido — o dedupe virou mordaça",
    ).toBeNull();
    expect(await abertos(ORG_A, CONVERSA)).toBe(1);
  });

  it("o índice é o mesmo dos dois artefatos: o nome que a migration cria está no banco aplicado", async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'public' and tablename = 'agent_inbox_items'
          and indexname = 'agent_inbox_job_dead_conversa_aberto_unico'`,
    );
    expect(rows.length, "o índice não existe no banco aplicado").toBe(1);
    const def = rows[0]!.indexdef.replace(/\s+/g, " ");
    expect(def).toContain("UNIQUE INDEX");
    expect(def).toContain("(organization_id, kind, ref_id)");
    expect(def).toContain("status = 'open'::text");
    expect(def).toContain("kind = 'job_dead'::text");
    expect(def).toContain("ref_kind = 'conversation'::text");
  });
});
