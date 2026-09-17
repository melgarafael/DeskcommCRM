import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import {
  buildCompromissosBlock,
  compromissosDoContato,
} from "@/lib/agent-engine/agent/compromissos-do-contato";

/**
 * O MOTOR DA ORGANIZAÇÃO A NÃO LÊ OS COMPROMISSOS DA B (issue #545, item 1).
 *
 * ═══ Por que esta leitura precisa de invariante próprio ═══
 *
 * `inbound-turn.ts` monta o bloco de compromissos com o `pool` do motor, que
 * IGNORA RLS. O `organization_id = $1` da consulta é o filtro de organização
 * desse caminho. O que caía nele vai para o prompt do agente, e dali para o
 * cliente de outra empresa.
 *
 * A guarda que existia (`tests/unit/o-agente-enxerga-os-compromissos-do-contato`)
 * conferia o TEXTO do SQL contra um dublê. Trocar o filtro por
 * `(organization_id = $1 or true)` mantinha a substring e deixava aquela suíte
 * inteira verde, lendo compromissos de todas as organizações. Aqui a consulta
 * roda num Postgres real e o que se confere são as linhas que ela devolve.
 *
 * ═══ A outra camada, e por que ela não dispensa esta ═══
 *
 * Desde a migration 0224, o gatilho `fn_appointment_stamp` recusa gravar
 * compromisso cujo contato seja de outra organização. Isso impede a LINHA
 * cruzada. Não impede um CHAMADOR que passe a organização A com o contato da B,
 * nem alcança linha gravada antes da 0224. É esse chamador que o caso cruzado
 * abaixo simula.
 *
 * O `agora` é fixo e o compromisso fica num futuro fixo: a consulta compara
 * `ends_at >= $3`, e usar o relógio do processo faria o caso depender da data
 * em que a suíte roda.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  host: "127.0.0.1",
  port: PORT,
  user: "postgres",
  password: "postgres",
  database: "postgres",
});

const ORG_A = "c0a1a545-0000-4000-8000-00000000000a";
const ORG_B = "c0a1a545-0000-4000-8000-00000000000b";

const AGORA = new Date("2026-01-01T12:00:00.000Z");
const TITULO_DA_B = "Retorno da cliente da B";
const TITULO_DA_A = "Avaliação do cliente da A";

let contatoDaB = "";
let contatoDaA = "";

beforeAll(async () => {
  for (const [id, slug] of [
    [ORG_A, "compromisso-cross-a"],
    [ORG_B, "compromisso-cross-b"],
  ] as const) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1, $2, 'Compromisso Cross LTDA', 'Compromisso Cross') on conflict (id) do nothing`,
      [id, slug],
    );
  }

  const b = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, name) values ($1, 'Cliente da B') returning id`,
    [ORG_B],
  );
  contatoDaB = b.rows[0]!.id;

  const a = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, name) values ($1, 'Cliente da A') returning id`,
    [ORG_A],
  );
  contatoDaA = a.rows[0]!.id;

  for (const [org, contato, titulo] of [
    [ORG_B, contatoDaB, TITULO_DA_B],
    [ORG_A, contatoDaA, TITULO_DA_A],
  ] as const) {
    await pool.query(
      `insert into calendar_appointments (organization_id, contact_id, title, starts_at, ends_at, status)
       values ($1, $2, $3, '2030-03-10 14:00:00+00', '2030-03-10 15:00:00+00', 'confirmed')`,
      [org, contato, titulo],
    );
  }
});

afterAll(async () => {
  await pool.end();
});

describe("compromissos do contato, com duas organizações no banco", () => {
  it("o cenário está montado: cada organização tem um contato com um compromisso futuro", async () => {
    // Sem isto, o caso cruzado passa verde medindo um banco vazio.
    expect(contatoDaA).not.toBe("");
    expect(contatoDaB).not.toBe("");
    const { rows } = await pool.query<{ organization_id: string; n: string }>(
      `select organization_id, count(*)::text as n from calendar_appointments
        where organization_id in ($1, $2) group by organization_id order by organization_id`,
      [ORG_A, ORG_B],
    );
    expect(rows.map((r) => [r.organization_id, r.n])).toEqual([
      [ORG_A, "1"],
      [ORG_B, "1"],
    ]);
  });

  it("controle positivo: a organização dona lê o compromisso do próprio contato", async () => {
    // Sem este caso, uma consulta que não devolvesse NADA deixaria o caso cruzado
    // verde pelo motivo errado.
    const daB = await compromissosDoContato(pool, ORG_B, contatoDaB, AGORA);
    expect(daB.map((c) => c.title)).toEqual([TITULO_DA_B]);

    const blocoDaA = await buildCompromissosBlock(pool, ORG_A, contatoDaA, AGORA);
    expect(blocoDaA).toContain(TITULO_DA_A);
  });

  it("a organização A, chamada com o contato da B, não lê o compromisso da B", async () => {
    const vazou = await compromissosDoContato(pool, ORG_A, contatoDaB, AGORA);
    expect(
      vazou.map((c) => c.title),
      "o motor da organização A leu compromisso da organização B",
    ).toEqual([]);
  });

  it("e o bloco que vai para o prompt do agente da A fica vazio", async () => {
    // É a função que `inbound-turn.ts` chama com o pool do motor, que ignora RLS.
    const bloco = await buildCompromissosBlock(pool, ORG_A, contatoDaB, AGORA);
    expect(bloco, "o prompt do agente da organização A recebeu compromisso da B").toBe("");
  });
});
