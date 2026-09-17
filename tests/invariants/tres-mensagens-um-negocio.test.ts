import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { garantirLeadDaConversa } from "@/lib/leads/nascimento-do-lead";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * TRÊS MENSAGENS SEGUIDAS VIRAM UM NEGÓCIO — com a corrida reproduzida de fato.
 *
 * ## Por que este arquivo existe ao lado de `nascimento-do-lead.test.ts`
 *
 * O #851 trouxe lá o caso "três entradas SIMULTÂNEAS do mesmo contato criam UM
 * lead". Medido na triagem, com `lib/leads/nascimento-do-lead.ts` de volta ao
 * insert direto (o defeito): **o caso ficou verde 5 de 5 vezes**. O vermelho do
 * arquivo vinha só do caso seguinte, o de duas entradas.
 *
 * A causa é o pool, não o produto. Os casos anteriores daquele arquivo são
 * sequenciais e deixam UMA conexão aberta. No `Promise.all` de três, a primeira
 * chamada usa a conexão pronta e as outras duas esperam o pool ABRIR conexões
 * novas — e esse atraso é maior que o caminho inteiro da primeira até o INSERT.
 * Quando elas consultam "já existe aberto?", o card já existe. Sem corrida, o
 * caso não distingue o conserto do defeito. O de duas passa a distinguir porque
 * herda as conexões que o de três abriu.
 *
 * (Aquele arquivo é congelado pelo hook de `tests/invariants/**`; mexer nele é
 * decisão do dono. Por isso a correção do instrumento mora aqui.)
 *
 * ## O que muda aqui
 *
 *   1. **O pool é aquecido antes de cada rodada**: três `pg_sleep` simultâneos
 *      obrigam o pool a manter três conexões abertas, então as três entradas
 *      partem juntas.
 *   2. **Várias rodadas, um contato novo por rodada.** Uma corrida é
 *      probabilística; a asserção é sobre TODAS as rodadas, e a mensagem mostra
 *      quantos cards cada contato ganhou.
 *   3. **A prova é a contagem no banco**, não o retorno da função.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const CONEXOES = 3;
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: CONEXOES,
});
const db = pgComoSupabase(pool);

const ORG = "851a0000-0000-4000-8000-000000000851";
const CONVERSA = "851a0000-0000-4000-8000-00000000c851";
const RODADAS = 5;

/** Deixa `CONEXOES` conexões físicas abertas e ociosas no pool. */
async function aquecerOPool(): Promise<void> {
  await Promise.all(Array.from({ length: CONEXOES }, () => pool.query("select pg_sleep(0.05)")));
}

async function criarContato(nome: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, source) values ($1, $2, 'whatsapp') returning id`,
    [ORG, nome],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  // O funil de entrada nasce pelo trigger `fn_seed_default_pipeline_for_org`.
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-851-tres-mensagens', 'Tres Mensagens LTDA', 'Tres Mensagens')
     on conflict (id) do nothing`,
    [ORG],
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

describe("três mensagens seguidas do mesmo contato", () => {
  it(
    `criam UM negócio — ${RODADAS} rodadas de três entradas simultâneas, com o pool aquecido`,
    async () => {
      const cardsPorRodada: number[] = [];
      const criadosPorRodada: number[] = [];

      for (let rodada = 1; rodada <= RODADAS; rodada++) {
        const nome = `Simultâneo ${rodada}`;
        const contato = await criarContato(nome);
        await aquecerOPool();

        const resultados = await Promise.all(
          Array.from({ length: CONEXOES }, () =>
            garantirLeadDaConversa(db, {
              organizationId: ORG,
              contactId: contato,
              conversationId: CONVERSA,
              nomeDoContato: nome,
            }),
          ),
        );
        criadosPorRodada.push(resultados.filter((r) => r.criado).length);

        const { rows } = await pool.query<{ n: string }>(
          "select count(*) as n from crm_leads where organization_id = $1 and contact_id = $2",
          [ORG, contato],
        );
        cardsPorRodada.push(Number(rows[0]!.n));
      }

      expect(
        cardsPorRodada,
        `cards no banco por contato, rodada a rodada — mais de 1 é o cliente aparecendo repetido no funil`,
      ).toEqual(Array(RODADAS).fill(1));
      expect(criadosPorRodada, "a função disse ter criado mais de um card").toEqual(Array(RODADAS).fill(1));
    },
    120_000,
  );
});
