import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import { instanteDoBanco } from "@/lib/tempo/agora";
import { midiaDerivavelPendente } from "@/lib/agent-engine/edge/crm/midia-derivavel";

/**
 * A RÉGUA DE DATA CONTRA O DRIVER DE VERDADE (#3849).
 *
 * O #3846 consertou `midiaDerivavelPendente`, que exigia
 * `typeof quando === "string"` e por isso respondia "nada pendente" contra
 * Postgres real: o driver `pg` entrega `timestamptz` como `Date`. O dublê de pool
 * dos testes de unidade devolve string, então a guarda ficou inerte em produção
 * sem NENHUM teste vermelho.
 *
 * Aquele não era um caso isolado, era uma CLASSE: toda régua que lê coluna de
 * data e decide por tipo/parse de string tem a mesma fronteira escondida atrás do
 * dublê. Por isso este arquivo não mede um arquivo — ele:
 *
 *   0. MEDE o contrato do driver (o `pg_typeof` da coluna e a forma em que o
 *      valor chega), para que a razão da lista abaixo esteja no próprio teste e
 *      não num comentário;
 *   1. exercita a LISTA ÚNICA de réguas de data do repositório com o valor CRU
 *      que o banco entregou — régua nova entra aqui, e não nasce fora do teste;
 *   2. e a régua que não estiver na lista não é coberta por nada: é a lista que
 *      transforma "consertamos um caso" em "a classe tem guarda".
 *
 * O modo de falha que este arquivo pega é MUDO: nada lança. A régua responde
 * `null`, o turno segue sem esperar a mídia, o caso mostra a hora errada. Só a
 * medição com banco real vê.
 *
 * Roda com:
 *
 *     pnpm test:db tests/invariants/data-do-banco-nao-vem-como-texto.test.ts
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});

const ORG = "ee390000-0000-4000-8000-000000000001";
const CONTACT = "ee390000-0000-4000-8000-000000000002";
const SESSION = "ee390000-0000-4000-8000-000000000003";
const CONV = "ee390000-0000-4000-8000-000000000004";

/** O instante que a régua tem de enxergar, com milissegundo — é o que `Date.parse` perde. */
const CHEGADA = "2026-11-04T09:10:00.123Z";

/**
 * AS RÉGUAS DE DATA DO REPOSITÓRIO — lista única e explícita.
 *
 * Cada entrada recebe o valor CRU lido do banco (a forma que o driver entrega) e
 * responde se a régua VIU aquele instante. `exercitar` recebe o valor como
 * `unknown` de propósito: é assim que a régua o recebe em produção, vindo de uma
 * linha tipada por fé.
 *
 * Régua nova que decida data lida do banco entra AQUI no mesmo PR — a lista é o
 * contrato, e é por isso que ela é curta.
 */
const REGUAS: ReadonlyArray<{
  nome: string;
  exercitar: (valorCru: unknown) => Promise<boolean> | boolean;
}> = [
  {
    nome: "midiaDerivavelPendente",
    // A régua real: consulta a conversa no banco e devolve a mídia pendente com
    // o instante de chegada. Devolve `null` quando a hora é ilegível.
    exercitar: async () => {
      const pendente = await midiaDerivavelPendente(pool, {
        organizationId: ORG,
        conversationId: CONV,
      });
      return pendente !== null && pendente.quando === CHEGADA;
    },
  },
  {
    nome: "instanteDoBanco",
    // A normalização de borda: string (PostgREST/jsonb) e `Date` (pg) viram o
    // MESMO ISO. Preserva o milissegundo que `Date.parse` sobre `Date` perde.
    exercitar: (valorCru) => instanteDoBanco(valorCru) === CHEGADA,
  },
];

type LinhaDeData = { tipo: string; created_at: Date };

async function lerCarimboDeChegada(): Promise<LinhaDeData> {
  const { rows } = await pool.query<LinhaDeData>(
    `select pg_typeof(created_at)::text as tipo, created_at
       from messages
      where organization_id = $1 and conversation_id = $2
      order by created_at desc
      limit 1`,
    [ORG, CONV],
  );
  const linha = rows[0];
  if (linha === undefined) throw new Error("fixture ausente: nenhuma mensagem na conversa");
  return linha;
}

describe("a data que o banco entrega não é string", () => {
  beforeAll(async () => {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1,'data-do-banco','Data do Banco','Data do Banco') on conflict (id) do nothing`,
      [ORG],
    );
    await pool.query(
      `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
       values ($1,$2,'data-do-banco-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
      [SESSION, ORG],
    );
  });

  beforeEach(async () => {
    await pool.query("delete from messages where organization_id = $1", [ORG]);
    await pool.query("delete from conversations where organization_id = $1", [ORG]);
    await pool.query("delete from contacts where organization_id = $1", [ORG]);
    await pool.query(
      `insert into contacts (id, organization_id, name, phone_number)
       values ($1,$2,'Cliente de teste','+5511977776666')`,
      [CONTACT, ORG],
    );
    await pool.query(
      `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
       values ($1,$2,$3,$4,'ai_handling',false)`,
      [CONV, ORG, CONTACT, SESSION],
    );
    // Áudio de entrada, sem derivação e com `media_url`: pendente por definição.
    await pool.query(
      `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
         type, direction, status, body, media_url, media_mime, media_derived_status, sent_via, sent_at, created_at)
       values ($1,$2,$3,$4,$5,'audio','inbound','delivered',null,$6,'audio/ogg',null,'external_device',$7,$7)`,
      [crypto.randomUUID(), ORG, CONV, SESSION, CONTACT, "https://cdn.example/audio.ogg", CHEGADA],
    );
  });

  afterAll(async () => {
    await pool.query("delete from messages where organization_id = $1", [ORG]);
    await pool.query("delete from conversations where organization_id = $1", [ORG]);
    await pool.query("delete from contacts where organization_id = $1", [ORG]);
    await pool.end();
  });

  it("MEDIÇÃO 0: a coluna é `timestamptz` e o driver a entrega como `Date`", async () => {
    const linha = await lerCarimboDeChegada();
    expect(linha.tipo).toBe("timestamp with time zone");
    expect(linha.created_at).toBeInstanceOf(Date);
    expect(linha.created_at.toISOString()).toBe(CHEGADA);
  });

  it.each(REGUAS.map((r) => [r.nome, r] as const))(
    "a régua `%s` VÊ o instante que o driver entregou",
    async (_nome, regua) => {
      const { created_at } = await lerCarimboDeChegada();
      // O valor CRU, sem `toISOString()` e sem `new Date()`: é a forma que a
      // régua recebe em produção. Passar uma string aqui seria o dublê de novo.
      expect(await regua.exercitar(created_at)).toBe(true);
    },
  );
});
