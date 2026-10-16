/**
 * A marca "sempre atendimento humano" (`contacts.ai_opt_out`) vale no envio da
 * agenda pela IA mesmo com `force_human` DESLIGADO (migration 0676).
 *
 * Antes, `lib/agenda/meet-delivery.ts` passava `aiOptOut: false` fixo e confiava
 * que a marca sempre viria junto de `force_human`. Aqui a deriva é montada de
 * propósito — marca ligada, trava desligada — e a decisão tem de sair do banco:
 *
 *   1. `fn_meet_delivery_policy` devolve a marca;
 *   2. o porteiro do worker recusa pelo motivo `ai_opt_out`;
 *   3. `fn_meet_delivery_settle` aceita esse motivo (senão a recusa vira
 *      exceção e o job fica sem acerto).
 *
 * O controle é o MESMO compromisso sem a marca: o porteiro deixa passar.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { assertMeetingDeliveryPg } from "@/lib/agenda/meet-delivery";

import { criarOrigemDeFollowup } from "./followup-service-origin";
import { seedGov, GOV_AGENT_A } from "./gov-helpers";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});
beforeAll(() => seedGov());
afterAll(() => pool.end());

/** Compromisso presencial com a entrega autorizada pela IA e o job já pego pelo worker. */
async function entregaDaIaEmCurso(marca: boolean) {
  const org = randomUUID();
  const id = randomUUID();
  const contact = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'SempreHumano','SempreHumano')",
    [org],
  );
  await pool.query(
    "insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'agent',now())",
    [org, GOV_AGENT_A],
  );
  await pool.query(
    "insert into contacts(id,organization_id,name,display_name,ai_authorized_at) values($1,$2,'Cliente','Cliente',now())",
    [contact, org],
  );
  const boundary = await criarOrigemDeFollowup(pool, org, contact);
  await pool.query(
    "update conversations set assignee_kind='ai',bot_silenced_until=null,assigned_to_user_id=null where id=$1",
    [boundary.conversation_id],
  );
  await pool.query(
    `insert into calendar_appointments(id,organization_id,contact_id,conversation_id,owner_user_id,title,
       starts_at,ends_at,status,location_kind,meeting_state)
     values($1,$2,$3,$4,$5,'Visita',now()+interval '4 days',now()+interval '4 days 1 hour','confirmed','in_person','not_requested')`,
    [id, org, contact, boundary.conversation_id, GOV_AGENT_A],
  );
  await pool.query(
    `update calendar_appointments set meeting_delivery = jsonb_build_object(
        'state','waiting_for_link','generation',gen_random_uuid()::text,
        'service_boundary',$2::jsonb,
        'authorized_by',jsonb_build_object('kind','ai_agent','id','agent-engine'))
      where id=$1`,
    [id, JSON.stringify(boundary)],
  );
  // A deriva: marca ligada, trava de passagem DESLIGADA. Depois de enfileirar,
  // como aconteceria com a marca ligada a qualquer momento antes do envio.
  if (marca) {
    await pool.query("update contacts set ai_opt_out=true,force_human=false where id=$1", [contact]);
  }
  const job = (
    await pool.query("select meeting_delivery_job_id j from calendar_appointments where id=$1", [id])
  ).rows[0].j as string;
  expect(job, "o gatilho não enfileirou — o defeito é antes do porteiro").toBeTruthy();
  const worker = `w-${randomUUID().slice(0, 8)}`;
  // `locked_at::text`: o porteiro compara por igualdade exata, e o `Date` do
  // driver trunca os microssegundos.
  const { rows } = await pool.query(
    "update job_queue set status='running',locked_by=$3,locked_at=now() where organization_id=$1 and id=$2 returning locked_at::text",
    [org, job, worker],
  );
  return {
    org,
    id,
    contexto: { organizationId: org, jobId: job, jobClaim: { worker_id: worker, acquired_at: rows[0].locked_at as string } },
  };
}

it("⛔ a política devolve a marca do contato", async () => {
  const e = await entregaDaIaEmCurso(true);
  const { rows } = await pool.query("select fn_meet_delivery_policy($1,$2,$3,$4::timestamptz) p", [
    e.org,
    e.contexto.jobId,
    e.contexto.jobClaim.worker_id,
    e.contexto.jobClaim.acquired_at,
  ]);
  expect(rows[0].p).toMatchObject({ current: true, human_command: false, force_human: false, ai_opt_out: true });
});

it("⛔ marca ligada com force_human desligado: o porteiro recusa pela marca, e o acerto aceita o motivo", async () => {
  const e = await entregaDaIaEmCurso(true);
  await expect(assertMeetingDeliveryPg(pool, e.contexto)).rejects.toMatchObject({ reason: "ai_opt_out" });

  const { rows } = await pool.query("select fn_meet_delivery_settle($1,$2,$3,$4::timestamptz,'blocked:ai_opt_out') ok", [
    e.org,
    e.contexto.jobId,
    e.contexto.jobClaim.worker_id,
    e.contexto.jobClaim.acquired_at,
  ]);
  expect(rows[0].ok).toBe(true);
  const entrega = (await pool.query("select meeting_delivery d from calendar_appointments where id=$1", [e.id]))
    .rows[0].d;
  expect(entrega).toMatchObject({ state: "blocked", error: "ai_opt_out" });
});

it("CONTROLE: o mesmo compromisso sem a marca passa pelo porteiro", async () => {
  const e = await entregaDaIaEmCurso(false);
  await expect(assertMeetingDeliveryPg(pool, e.contexto)).resolves.toMatchObject({ humanCommand: false });
});
