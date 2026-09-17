import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { drainTick } from "@/lib/agent-engine/edge/crm/drain";
import { createLogger } from "@/lib/agent-engine/obs/logger";

/**
 * MIL DESPACHOS MORTOS ABREM UM AVISO, NÃO MIL.
 *
 * O dreno do agent-engine (`lib/agent-engine/edge/crm/drain.ts`) abre
 * `event_dead` na Central quando desiste de um `ai_agent.dispatch_requested`.
 * Numa pane — chave do provedor revogada, banco recusando o job — TODO despacho
 * morre, e um aviso por evento enterraria a Central no primeiro minuto. Central
 * inundada é Central que ninguém abre, que é como o alerta morre pela segunda vez.
 *
 * O dedupe é um `insert … where not exists` (`insertInboxItem`, modo `kind`).
 * SQL não se prova com dublê, e por isso este arquivo mede contra Postgres, pelo
 * ponto de uso (`drainTick`), com uma falha real: o `contact_id` do payload não
 * existe, e o `insert` em `job_queue` estoura na FK — o mesmo erro que um
 * contato apagado entre a mensagem e o turno produziria.
 *
 * Três direções, porque cada uma sozinha passa por um motivo errado:
 *   1. mil mortes → um aviso (e as mil mortes de fato aconteceram — sem esse
 *      controle, um dreno que nunca matasse nada também daria "um aviso ou menos");
 *   2. a trava é POR ORGANIZAÇÃO — o aviso aberto de uma não cala a vizinha;
 *   3. resolvido o aviso, a próxima morte abre outro — dedupe não é "nunca mais".
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:invariants` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});
const log = createLogger();

const ORG_A = "ed0a0000-0000-4000-8000-00000000000a";
const ORG_B = "ed0b0000-0000-4000-8000-00000000000b";
/** Não existe em `contacts`: é o que faz o enfileiramento do turno falhar na FK. */
const CONTATO_FANTASMA = "ed0f0000-0000-4000-8000-0000000000ff";

const MIL = 1000;

let seq = 0;
function proximoId(): string {
  seq += 1;
  return `ed000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

interface Cenario {
  org: string;
  session: string;
  conv: string;
}

/** Organização com canal, conversa e agente publicado — o turno PASSARIA do portão. */
async function montarOrganizacao(org: string, slug: string): Promise<Cenario> {
  const contato = proximoId();
  const session = proximoId();
  const conv = proximoId();
  const agent = proximoId();
  const version = proximoId();
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, $3, $4)`,
    [org, slug, slug, slug],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number) values ($1, $2, 'Cliente', $3)`,
    [contato, org, `+55119${String(seq).padStart(8, "0")}`],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, $3, 'WORKING', '\\x00'::bytea)`,
    [session, org, `morto-${slug}`],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1, $2, $3, $4, 'open', false)`,
    [conv, org, contato, session],
  );
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt, kind)
     values ($1, $2, 'Agente', 'você é um atendente', 'mcp_agent')`,
    [agent, org],
  );
  await pool.query(
    `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt,
                                    provider, model, channel_session_id, status, published_at)
     values ($1, $2, $3, 1, 'você é um atendente', 'anthropic', 'claude-sonnet-4-6', $4, 'published', now())`,
    [version, org, agent, session],
  );
  await pool.query(`update ai_agents set published_version_id = $1 where id = $2`, [version, agent]);
  return { org, session, conv };
}

/**
 * `quantos` despachos na ÚLTIMA tentativa: `attempts = 4`, e o claim soma a 5ª.
 * Todos apontam para o contato fantasma, então todos morrem neste tick.
 */
async function despachosMoribundos(c: Cenario, quantos: number): Promise<void> {
  await pool.query(
    `insert into event_log (organization_id, event_type, entity_kind, entity_id, payload, status, attempts)
     select $1::uuid, 'ai_agent.dispatch_requested', 'message', gen_random_uuid(),
            jsonb_build_object('conversation_id', $2::text, 'contact_id', $3::text,
                               'channel_session_id', $4::text, 'inbound_message_id', gen_random_uuid()::text),
            'pending', 4
       from generate_series(1, $5::int)`,
    [c.org, c.conv, CONTATO_FANTASMA, c.session, quantos],
  );
}

async function contar(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(sql, params);
  return rows[0]!.n;
}

const avisosAbertos = (org: string) =>
  contar(
    `select count(*)::int as n from agent_inbox_items
      where organization_id = $1 and kind = 'event_dead' and status = 'open'`,
    [org],
  );
const avisosTotais = (org: string) =>
  contar(
    `select count(*)::int as n from agent_inbox_items where organization_id = $1 and kind = 'event_dead'`,
    [org],
  );
const mortos = (org: string) =>
  contar(
    `select count(*)::int as n from event_log
      where organization_id = $1 and event_type = 'ai_agent.dispatch_requested' and status = 'dead'`,
    [org],
  );

const KNOBS = { batchSize: MIL, intervalMs: 0, idleIntervalMs: 0, debounceMs: 0, reapTimeoutMs: 300_000 };

let a: Cenario;
let b: Cenario;

beforeAll(async () => {
  a = await montarOrganizacao(ORG_A, "morto-a");
  b = await montarOrganizacao(ORG_B, "morto-b");
});

afterAll(async () => {
  await pool.end();
});

describe("despacho da IA que morre — a Central recebe UM aviso por organização", () => {
  it(`${MIL} despachos mortos no mesmo tick abrem UM aviso`, async () => {
    await despachosMoribundos(a, MIL);

    await drainTick(pool, KNOBS, log);

    expect(await mortos(ORG_A), "o controle: os mil despachos precisam ter morrido de fato").toBe(MIL);
    expect(await avisosAbertos(ORG_A), "a Central foi inundada — ou ficou muda").toBe(1);
  }, 300_000);

  it("o aviso aberto de uma organização não cala a VIZINHA", async () => {
    expect(await avisosAbertos(ORG_A)).toBe(1);
    await despachosMoribundos(b, 1);

    await drainTick(pool, KNOBS, log);

    expect(await mortos(ORG_B)).toBe(1);
    expect(await avisosAbertos(ORG_B), "o dedupe vazou entre organizações").toBe(1);
  }, 60_000);

  it("resolvido o aviso, a próxima morte abre OUTRO", async () => {
    await pool.query(
      `update agent_inbox_items set status = 'resolved' where organization_id = $1 and kind = 'event_dead'`,
      [ORG_A],
    );
    await despachosMoribundos(a, 1);

    await drainTick(pool, KNOBS, log);

    expect(await mortos(ORG_A)).toBe(MIL + 1);
    expect(await avisosTotais(ORG_A), "resolver o aviso deixou a organização cega para a próxima pane").toBe(2);
    expect(await avisosAbertos(ORG_A)).toBe(1);
  }, 60_000);
});
