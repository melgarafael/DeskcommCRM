import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * O AVISO DE MÍDIA NÃO LIDA É UM POR ORGANIZAÇÃO — e é o BANCO que garante.
 *
 * `avisarMidiaNaoLida` (`workers/media-derive-worker.ts`) pergunta se já existe
 * aviso aberto e só depois insere. A pergunta não tem trava, e o lote de
 * derivação roda em paralelo: dois workers derivando mídia no mesmo instante
 * leem "não existe" antes de qualquer escrita, e os dois inserem. Dois avisos
 * idênticos para a mesma organização — e Central repetida é Central que ninguém
 * abre, que é como o alerta morre pela segunda vez.
 *
 * Este arquivo mede contra Postgres porque SQL não se prova com dublê. Três
 * direções, porque cada uma sozinha passa por um motivo errado:
 *
 *   1. dois inserts iguais na MESMA organização ⇒ uma linha aberta, e o segundo
 *      leva `23505` (é o que o worker passou a ler como desfecho normal);
 *   2. a trava é POR ORGANIZAÇÃO — o aviso aberto de uma não cala a vizinha;
 *   3. resolvido o aviso, o próximo abre outro — dedupe não é "nunca mais".
 *
 * O `23505` aqui é o MESMO caminho que o índice parcial da 0527 levanta em
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

const ORG_A = "ed0c0000-0000-4000-8000-00000000000a";
const ORG_B = "ed0c0000-0000-4000-8000-00000000000b";

/** O mesmo `insert` do worker, com o mínimo que a tabela exige. */
async function abrirAviso(org: string, tipo: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into agent_inbox_items (organization_id, kind, severity, title, body)
     values ($1, 'midia_nao_lida', 'warn', $2, $3)
     returning id`,
    [org, `O agente não conseguiu ler ${tipo} que o cliente enviou`, "Motivo: teste"],
  );
  return rows[0]?.id ?? null;
}

/** `null` quando o insert passou; o `code` quando o banco recusou. */
async function tentarAbrir(
  org: string,
  tipo: string,
): Promise<{ id: string | null; code: string | null }> {
  try {
    return { id: await abrirAviso(org, tipo), code: null };
  } catch (err) {
    return { id: null, code: (err as { code?: string }).code ?? "sem-code" };
  }
}

const abertos = async (org: string): Promise<number> => {
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from agent_inbox_items
      where organization_id = $1 and kind = 'midia_nao_lida' and status = 'open'`,
    [org],
  );
  return rows[0]!.n;
};

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2::text, $2::text, $2::text)`,
    [ORG_A, "midia-a"],
  );
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2::text, $2::text, $2::text)`,
    [ORG_B, "midia-b"],
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

describe("o aviso de mídia não lida não abre em dobro", () => {
  it("o segundo insert da mesma organização é recusado com 23505, e sobra UMA linha aberta", async () => {
    // As duas inserções que a corrida produz: nenhuma das duas passa pelo
    // `select` da outra, porque as duas chegam antes de qualquer escrita.
    const primeiro = await tentarAbrir(ORG_A, "foto");
    const segundo = await tentarAbrir(ORG_A, "áudio");

    expect(
      primeiro.code,
      "o primeiro aviso foi recusado — o índice está barrando o caso legítimo",
    ).toBeNull();
    expect(segundo.code, "o segundo aviso passou: a corrida do #880 continua aberta").toBe("23505");
    expect(await abertos(ORG_A)).toBe(1);

    // E o que sobreviveu é o PRIMEIRO: o título fala de foto, não de áudio. É o
    // que mede que o TÍTULO não faz parte da chave nem é critério de desempate —
    // a mídia varia a cada tentativa e o aviso continua sendo um por organização.
    const { rows } = await pool.query<{ title: string }>(
      `select title from agent_inbox_items
        where organization_id = $1 and kind = 'midia_nao_lida' and status = 'open'`,
      [ORG_A],
    );
    expect(rows[0]!.title).toContain("foto");
  });

  it("a trava é por ORGANIZAÇÃO — o aviso de uma não cala a vizinha", async () => {
    const daVizinha = await tentarAbrir(ORG_B, "foto");
    expect(daVizinha.code, "o índice está global em vez de por organização").toBeNull();
    expect(await abertos(ORG_B)).toBe(1);
    expect(await abertos(ORG_A)).toBe(1);
  });

  it("resolvido o aviso, o próximo abre outro — dedupe não é 'nunca mais'", async () => {
    await pool.query(
      `update agent_inbox_items set status = 'resolved', resolved_at = now()
        where organization_id = $1 and kind = 'midia_nao_lida' and status = 'open'`,
      [ORG_A],
    );
    const depois = await tentarAbrir(ORG_A, "áudio");
    expect(
      depois.code,
      "o aviso não reabre depois de resolvido — o dedupe virou mordaça",
    ).toBeNull();
    expect(await abertos(ORG_A)).toBe(1);
  });

  it("o índice é o mesmo dos dois artefatos: o nome que a migration cria está no baseline", async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'public' and tablename = 'agent_inbox_items'
          and indexname = 'agent_inbox_midia_nao_lida_aberto_unico'`,
    );
    expect(rows.length, "o índice não existe no banco aplicado").toBe(1);
    const def = rows[0]!.indexdef.replace(/\s+/g, " ");
    expect(def).toContain("UNIQUE INDEX");
    expect(def).toContain("(organization_id, kind)");
    expect(def).toContain("status = 'open'::text");
    expect(def).toContain("kind = 'midia_nao_lida'::text");
  });
});
