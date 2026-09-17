import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { drainTick } from "@/lib/agent-engine/edge/crm/drain";
import { createLogger } from "@/lib/agent-engine/obs/logger";
import { avisoDeEventoMorto, IA_QUE_NAO_RESPONDEU, TITULO_GENERICO } from "@/lib/event-log/aviso-de-evento-morto";

/**
 * O AVISO "A IA DEIXOU DE RESPONDER" NÃO SOME ATRÁS DE OUTRO `event_dead` ABERTO.
 *
 * Os dois drenos que desistem de evento abrem o mesmo `kind`. Com o dedupe do
 * dreno do agent-engine só por `kind`, um aviso de mídia aberto na organização
 * engolia a morte do despacho da IA — medido: com um `event_dead` de mídia
 * aberto, três despachos mortos não abriam nada. É o aviso que diz que um
 * cliente ficou sem resposta, e ele nunca chegava à Central.
 *
 * O conserto é o dedupe `kind_e_titulo` (`insertInboxItem`): a IA que deixou de
 * responder é uma família própria, com no máximo um aviso aberto. SQL não se
 * prova com dublê, então este arquivo mede contra Postgres, pelo ponto de uso
 * (`drainTick`), com uma falha real — o `contact_id` do payload não existe, e o
 * `insert` em `job_queue` estoura na FK.
 *
 * Duas direções, e o que cada sabotagem derruba (medido):
 *   1. o aviso de outra família aberto não cala o da IA — com o dedupe de volta
 *      a `kind`, abre ZERO avisos da IA;
 *   2. mil mortes da IA seguem sendo UM aviso da IA — com `kind_e_titulo` sem
 *      deduplicar, abrem 1003 (e o caso 1 também cai: 3 em vez de 1).
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

const ORG = "ed1a0000-0000-4000-8000-00000000000a";
/** Não existe em `contacts`: é o que faz o enfileiramento do turno falhar na FK. */
const CONTATO_FANTASMA = "ed1f0000-0000-4000-8000-0000000000ff";

const MIL = 1000;

let seq = 0;
function proximoId(): string {
  seq += 1;
  return `ed100000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

interface Cenario {
  session: string;
  conv: string;
}

/** Organização com canal, conversa e agente publicado — o turno PASSARIA do portão. */
async function montarOrganizacao(): Promise<Cenario> {
  const contato = proximoId();
  const session = proximoId();
  const conv = proximoId();
  const agent = proximoId();
  const version = proximoId();
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, 'ia-atras', 'IA atrás', 'IA atrás')`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number) values ($1, $2, 'Cliente', '+5511900001234')`,
    [contato, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, 'ia-atras', 'WORKING', '\\x00'::bytea)`,
    [session, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1, $2, $3, $4, 'open', false)`,
    [conv, ORG, contato, session],
  );
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt, kind)
     values ($1, $2, 'Agente', 'você é um atendente', 'mcp_agent')`,
    [agent, ORG],
  );
  await pool.query(
    `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt,
                                    provider, model, channel_session_id, status, published_at)
     values ($1, $2, $3, 1, 'você é um atendente', 'anthropic', 'claude-sonnet-4-6', $4, 'published', now())`,
    [version, ORG, agent, session],
  );
  await pool.query(`update ai_agents set published_version_id = $1 where id = $2`, [version, agent]);
  return { session, conv };
}

/**
 * O `event_dead` de mídia exatamente como `lib/event-log/drain.ts` o grava:
 * mesmo texto (`avisoDeEventoMorto` sem `efeito`), `critical`, sem referência.
 */
async function avisoDeMidiaAberto(): Promise<void> {
  const { title, body } = avisoDeEventoMorto({
    eventType: "media.derive_requested",
    tentativas: 5,
    motivo: "The model `claude-sonnet-5` does not exist or you do not have access to it",
  });
  await pool.query(
    `insert into agent_inbox_items (organization_id, kind, severity, title, body)
     values ($1, 'event_dead', 'critical', $2, $3)`,
    [ORG, title, body],
  );
}

/** `quantos` despachos na ÚLTIMA tentativa: `attempts = 4`, e o claim soma a 5ª. */
async function despachosMoribundos(c: Cenario, quantos: number): Promise<void> {
  await pool.query(
    `insert into event_log (organization_id, event_type, entity_kind, entity_id, payload, status, attempts)
     select $1::uuid, 'ai_agent.dispatch_requested', 'message', gen_random_uuid(),
            jsonb_build_object('conversation_id', $2::text, 'contact_id', $3::text,
                               'channel_session_id', $4::text, 'inbound_message_id', gen_random_uuid()::text),
            'pending', 4
       from generate_series(1, $5::int)`,
    [ORG, c.conv, CONTATO_FANTASMA, c.session, quantos],
  );
}

async function contar(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(sql, params);
  return rows[0]!.n;
}

const abertosComTitulo = (titulo: string) =>
  contar(
    `select count(*)::int as n from agent_inbox_items
      where organization_id = $1 and kind = 'event_dead' and status = 'open' and title = $2`,
    [ORG, titulo],
  );
const eventDeadTotais = () =>
  contar(`select count(*)::int as n from agent_inbox_items where organization_id = $1 and kind = 'event_dead'`, [
    ORG,
  ]);
const mortos = () =>
  contar(
    `select count(*)::int as n from event_log
      where organization_id = $1 and event_type = 'ai_agent.dispatch_requested' and status = 'dead'`,
    [ORG],
  );

const TITULO_MIDIA = TITULO_GENERICO;
const KNOBS = { batchSize: MIL, intervalMs: 0, idleIntervalMs: 0, debounceMs: 0, reapTimeoutMs: 300_000 };

let cenario: Cenario;

beforeAll(async () => {
  cenario = await montarOrganizacao();
});

afterAll(async () => {
  await pool.end();
});

describe("despacho da IA que morre com outro event_dead já aberto na organização", () => {
  it("com o aviso de mídia aberto, três despachos mortos abrem O aviso da IA", async () => {
    await avisoDeMidiaAberto();
    expect(await abertosComTitulo(TITULO_MIDIA), "o controle: o aviso de mídia precisa estar aberto").toBe(1);

    await despachosMoribundos(cenario, 3);
    await drainTick(pool, KNOBS, log);

    expect(await mortos(), "o controle: os três despachos precisam ter morrido de fato").toBe(3);
    expect(
      await abertosComTitulo(IA_QUE_NAO_RESPONDEU.titulo),
      "o aviso da IA sumiu atrás do de mídia (0) ou repetiu por despacho (3)",
    ).toBe(1);
    expect(await abertosComTitulo(TITULO_MIDIA), "o aviso de mídia não pode ser tocado").toBe(1);
  }, 60_000);

  it(`${MIL} despachos mortos a mais seguem sendo UM aviso da IA`, async () => {
    await despachosMoribundos(cenario, MIL);
    await drainTick(pool, KNOBS, log);

    expect(await mortos(), "o controle: os mil despachos precisam ter morrido de fato").toBe(MIL + 3);
    expect(await abertosComTitulo(IA_QUE_NAO_RESPONDEU.titulo), "a Central foi inundada").toBe(1);
    expect(await eventDeadTotais(), "nasceu aviso além do de mídia e do da IA").toBe(2);
  }, 300_000);
});
