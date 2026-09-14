import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { criarOrigemDeFollowup } from "./followup-service-origin";
import { seedGov, GOV_AGENT_A } from "./gov-helpers";

/**
 * Compromisso sem Google Meet nunca chegava ao cliente.
 *
 * A entrega transacional já resolvia fila, canal, fronteira de atendimento e
 * autorização. Ela só não valia para compromisso PRESENCIAL ou POR TELEFONE,
 * porque três exigências eram incondicionais — `meeting_state='ready'` e
 * `meeting_url is not null` na vigência, na ação, e no ENFILEIRADOR.
 *
 * A do enfileirador é a mais fácil de esquecer e a pior: num compromisso
 * presencial o estado é `not_requested` para sempre, então a entrega era
 * autorizada, o gatilho saía por ali, e nada acontecia — em silêncio.
 */

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});
beforeAll(() => seedGov());
afterAll(() => pool.end());

async function compromisso(local: string, meetingState: string) {
  const org = randomUUID();
  const id = randomUUID();
  const contact = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'SemMeet','SemMeet')",
    [org],
  );
  await pool.query(
    "insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'agent',now())",
    [org, GOV_AGENT_A],
  );
  await pool.query(
    "insert into contacts(id,organization_id,name,display_name) values($1,$2,'Cliente','Cliente')",
    [contact, org],
  );
  const boundary = await criarOrigemDeFollowup(pool, org, contact);
  await pool.query(
    `insert into calendar_appointments(id,organization_id,contact_id,conversation_id,owner_user_id,title,
       starts_at,ends_at,status,location_kind,meeting_state)
     values($1,$2,$3,$4,$5,'Visita',now()+interval '4 days',now()+interval '4 days 1 hour','confirmed',$6,$7)`,
    [id, org, contact, boundary.conversation_id, GOV_AGENT_A, local, meetingState],
  );
  return { org, id, contact, boundary };
}

/** Autoriza a entrega do jeito que `fn_meet_action` autoriza. */
async function autorizar(f: Awaited<ReturnType<typeof compromisso>>) {
  await pool.query(
    `update calendar_appointments set meeting_delivery = jsonb_build_object(
        'state','waiting_for_link','generation',gen_random_uuid()::text,
        'service_boundary',$2::jsonb,
        'authorized_by',jsonb_build_object('kind','user','id',$3::text))
      where id=$1`,
    [f.id, JSON.stringify(f.boundary), GOV_AGENT_A],
  );
  return (await pool.query("select meeting_delivery d from calendar_appointments where id=$1", [f.id]))
    .rows[0].d as Record<string, unknown>;
}

it("⛔ compromisso PRESENCIAL entra na fila — não espera link que não existe", async () => {
  const f = await compromisso("in_person", "not_requested");
  const d = await autorizar(f);
  expect(d.state).toBe("queued");
});

it("⛔ e um job de verdade nasce para ele", async () => {
  const f = await compromisso("in_person", "not_requested");
  await autorizar(f);
  const jobs = await pool.query(
    "select id from job_queue where organization_id=$1 and kind='transactional_delivery'",
    [f.org],
  );
  expect(jobs.rowCount).toBe(1);
});

it("⛔ CONTROLE: com Meet e link NÃO pronto, continua esperando", async () => {
  // O par que impede o afrouxamento de virar buraco: onde o Meet é o local,
  // mandar antes do link é mandar uma reunião sem como entrar nela.
  const f = await compromisso("google_meet", "pending");
  const d = await autorizar(f);
  expect(d.state).toBe("waiting_for_link");
  const jobs = await pool.query(
    "select id from job_queue where organization_id=$1 and kind='transactional_delivery'",
    [f.org],
  );
  expect(jobs.rowCount).toBe(0);
});

it("CONTROLE: compromisso CANCELADO não entra na fila, com ou sem Meet", async () => {
  const f = await compromisso("in_person", "not_requested");
  await pool.query(
    "update calendar_appointments set status='cancelled',cancelled_at=now() where id=$1",
    [f.id],
  );
  await autorizar(f);
  const jobs = await pool.query(
    "select id from job_queue where organization_id=$1 and kind='transactional_delivery' and status in ('pending','running')",
    [f.org],
  );
  expect(jobs.rowCount).toBe(0);
});
