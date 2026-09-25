import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  avaliarDevolucao,
  lerPrazoDeDevolucaoMinutos,
  type ConversaEmHandoff,
} from "@/lib/escalacao/devolucao-automatica";

import { GOV_AGENT_A, GOV_ORG, GOV_SESSION, seedGov } from "./gov-helpers";

/**
 * "A conversa fica com quem atendeu" (0396) + "devolver ao agente sozinho"
 * (`handoff_return_after_minutes`) ligados JUNTOS.
 *
 * O prazo de devolução conta do último sinal humano, o maior entre
 * `last_handoff_at`, `assigned_at` e `last_outbound_at`. Se a reabertura
 * guardasse o `assigned_at` do episódio encerrado, os três seriam antigos e o
 * cron `handoff-devolucao` devolveria a conversa à IA no primeiro tick, antes
 * de o atendente ver a mensagem. Aqui a regra de produção (`avaliarDevolucao`)
 * julga o estado EXATO que `fn_service_inbound` grava.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});

const PRAZO_MINUTOS = 60;

beforeAll(async () => {
  seedGov();
  await pool.query(
    `update organizations
        set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{routing}',
          coalesce(settings->'routing', '{}'::jsonb)
            || jsonb_build_object('conversation_stays_with_attendant', true,
                                  'handoff_return_after_minutes', $2::int))
      where id = $1`,
    [GOV_ORG, PRAZO_MINUTOS],
  );
});
afterAll(async () => pool.end());

/** Um episódio que terminou há 3 dias, com todos os sinais humanos daquela época. */
async function episodioAntigoEncerrado() {
  const contact = randomUUID();
  const conversation = randomUUID();
  await pool.query(
    "insert into contacts(id,organization_id,display_name) values($1,$2,'Devolução')",
    [contact, GOV_ORG],
  );
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')",
    [conversation, GOV_ORG, contact, GOV_SESSION],
  );
  const claim = await pool.query(
    "select id from fn_conversation_assign($1,$2,$3,'claim',null,true)",
    [GOV_ORG, conversation, GOV_AGENT_A],
  );
  expect(claim.rows).toHaveLength(1);
  await pool.query(
    `update conversations
        set assigned_at = now() - interval '3 days',
            last_handoff_at = now() - interval '3 days',
            last_outbound_at = now() - interval '3 days'
      where id = $1 and organization_id = $2`,
    [conversation, GOV_ORG],
  );
  await pool.query("select * from fn_service_status($1,$2,'closed',null)", [GOV_ORG, conversation]);
  return { contact, conversation };
}

async function clienteEscreve(contact: string, conversation: string) {
  await pool.query(
    `insert into messages
      (id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,sent_via,body,sent_at)
     values($1,$2,$3,$4,$5,'text','inbound','received','ai','Voltei',clock_timestamp())`,
    [randomUUID(), GOV_ORG, conversation, GOV_SESSION, contact],
  );
}

/** A linha como o cron a lê, e o relógio do próprio banco como `agora`. */
async function estado(conversation: string) {
  const { rows } = await pool.query(
    `select c.id, c.organization_id, c.channel_session_id, c.status, c.assignee_kind,
            c.assigned_to_user_id, c.assigned_at, c.bot_silenced_until::text bot_silenced_until,
            c.last_handoff_at, c.last_outbound_at, c.status_changed_at,
            o.settings, clock_timestamp() agora
       from conversations c join organizations o on o.id = c.organization_id
      where c.id = $1 and c.organization_id = $2`,
    [conversation, GOV_ORG],
  );
  const r = rows[0];
  const iso = (v: Date | null) => (v ? new Date(v).toISOString() : null);
  const conversa: ConversaEmHandoff = {
    id: r.id,
    organization_id: r.organization_id,
    channel_session_id: r.channel_session_id,
    status: r.status,
    assignee_kind: r.assignee_kind,
    assigned_to_user_id: r.assigned_to_user_id,
    assigned_at: iso(r.assigned_at),
    bot_silenced_until: r.bot_silenced_until,
    last_handoff_at: iso(r.last_handoff_at),
    last_outbound_at: iso(r.last_outbound_at),
    status_changed_at: iso(r.status_changed_at),
  };
  const prazo = lerPrazoDeDevolucaoMinutos(r.settings);
  expect(prazo, "o prazo de devolução precisa estar ligado nesta organização").toBe(PRAZO_MINUTOS);
  const sel = (agoraMs: number) => ({
    prazoPorOrg: new Map([[GOV_ORG, prazo!]]),
    sessoesComAgente: new Map([[GOV_ORG, new Set([GOV_SESSION])]]),
    agoraMs,
  });
  return { conversa, agoraMs: new Date(r.agora).getTime(), sel };
}

describe("reabertura com o último atendente e devolução automática ligadas juntas", () => {
  it("a conversa reaberta não volta para a IA no primeiro tick do cron", async () => {
    const { contact, conversation } = await episodioAntigoEncerrado();
    await clienteEscreve(contact, conversation);
    const { conversa, agoraMs, sel } = await estado(conversation);

    expect(conversa).toMatchObject({
      status: "claimed",
      assigned_to_user_id: GOV_AGENT_A,
      bot_silenced_until: "infinity",
    });
    expect(avaliarDevolucao(conversa, sel(agoraMs))).toEqual({
      devolver: false,
      motivo: "dentro_do_prazo",
    });
  });

  it("controle: passado o prazo sem sinal humano, a mesma linha é devolvida", async () => {
    const { contact, conversation } = await episodioAntigoEncerrado();
    await clienteEscreve(contact, conversation);
    const { conversa, agoraMs, sel } = await estado(conversation);

    expect(avaliarDevolucao(conversa, sel(agoraMs + (PRAZO_MINUTOS + 1) * 60_000))).toEqual({
      devolver: true,
      minutos: PRAZO_MINUTOS,
    });
  });
});
