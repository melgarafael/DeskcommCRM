/**
 * Num canal em pré-go-live, o link de reunião que a IA envia só sai para quem
 * está na lista de teste do canal (migration 9399, #4701). A decisão sai do
 * banco, como nos outros caminhos da IA:
 *
 *   1. `fn_meet_delivery_policy` devolve o modo do canal, os números de teste
 *      e o telefone do contato;
 *   2. o porteiro do worker recusa o contato fora da lista pelo motivo
 *      `fora_da_lista_de_teste`;
 *   3. `fn_meet_delivery_settle` aceita esse motivo (senão a recusa vira
 *      exceção e o job fica sem acerto).
 *
 * O controle é o mesmo compromisso com o contato na lista: o porteiro deixa passar.
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

const NUMERO_DE_TESTE = "+5511999990000";
/** Testador de Instagram da lista social do canal (9394); o contato dele não tem telefone. */
const TESTADOR_SOCIAL = "instagram:6af9e0ef28984e27de07bef4:1011223655361506";

/** Compromisso presencial com a entrega autorizada pela IA, num canal pré-go-live, e o job já pego pelo worker. */
async function entregaDaIaEmCanalDeTeste(telefoneDoContato: string | null, identidadeSocial: string | null = null) {
  const org = randomUUID();
  const id = randomUUID();
  const contact = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'PreGoLive','PreGoLive')",
    [org],
  );
  await pool.query(
    "insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'agent',now())",
    [org, GOV_AGENT_A],
  );
  await pool.query(
    "insert into contacts(id,organization_id,name,display_name,phone_number,social_identity,ai_authorized_at) values($1,$2,'Cliente','Cliente',$3,$4,now())",
    [contact, org, telefoneDoContato, identidadeSocial],
  );
  const boundary = await criarOrigemDeFollowup(pool, org, contact);
  await pool.query(
    "update conversations set assignee_kind='ai',bot_silenced_until=null,assigned_to_user_id=null where id=$1",
    [boundary.conversation_id],
  );
  await pool.query(
    `update channel_sessions set metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
        'ai_gate','allowlist','ai_gate_mode','pre_go_live','ai_test_phone_numbers',jsonb_build_array($2::text),
        'ai_test_social_identities',jsonb_build_array($3::text))
      where id=(select channel_session_id from conversations where id=$1)`,
    [boundary.conversation_id, NUMERO_DE_TESTE, TESTADOR_SOCIAL],
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

it("⛔ a política devolve o modo do canal, a lista de teste e o telefone do contato", async () => {
  const e = await entregaDaIaEmCanalDeTeste("+5511988887777");
  const { rows } = await pool.query("select fn_meet_delivery_policy($1,$2,$3,$4::timestamptz) p", [
    e.org,
    e.contexto.jobId,
    e.contexto.jobClaim.worker_id,
    e.contexto.jobClaim.acquired_at,
  ]);
  expect(rows[0].p).toMatchObject({
    current: true,
    human_command: false,
    ai_gate: "allowlist",
    ai_gate_mode: "pre_go_live",
    ai_test_phone_numbers: [NUMERO_DE_TESTE],
    contact_phone_number: "+5511988887777",
  });
});

it("⛔ contato fora da lista de teste: o porteiro recusa pela lista, e o acerto aceita o motivo", async () => {
  const e = await entregaDaIaEmCanalDeTeste("+5511988887777");
  await expect(assertMeetingDeliveryPg(pool, e.contexto)).rejects.toMatchObject({ reason: "fora_da_lista_de_teste" });

  const { rows } = await pool.query(
    "select fn_meet_delivery_settle($1,$2,$3,$4::timestamptz,'blocked:fora_da_lista_de_teste') ok",
    [e.org, e.contexto.jobId, e.contexto.jobClaim.worker_id, e.contexto.jobClaim.acquired_at],
  );
  expect(rows[0].ok).toBe(true);
  const entrega = (await pool.query("select meeting_delivery d from calendar_appointments where id=$1", [e.id]))
    .rows[0].d;
  expect(entrega).toMatchObject({ state: "blocked", error: "fora_da_lista_de_teste" });
});

it("CONTROLE: o mesmo compromisso com o contato na lista passa pelo porteiro", async () => {
  const e = await entregaDaIaEmCanalDeTeste(NUMERO_DE_TESTE);
  await expect(assertMeetingDeliveryPg(pool, e.contexto)).resolves.toMatchObject({ humanCommand: false });
});

it("⛔ testador de Instagram/Facebook (9408): a política devolve a lista social e a identidade do contato, e o porteiro deixa passar", async () => {
  const e = await entregaDaIaEmCanalDeTeste(null, TESTADOR_SOCIAL);
  const { rows } = await pool.query("select fn_meet_delivery_policy($1,$2,$3,$4::timestamptz) p", [
    e.org,
    e.contexto.jobId,
    e.contexto.jobClaim.worker_id,
    e.contexto.jobClaim.acquired_at,
  ]);
  expect(rows[0].p).toMatchObject({
    current: true,
    ai_test_social_identities: [TESTADOR_SOCIAL],
    contact_social_identity: TESTADOR_SOCIAL,
    contact_phone_number: null,
  });
  await expect(assertMeetingDeliveryPg(pool, e.contexto)).resolves.toMatchObject({ humanCommand: false });
});
