import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { criarOrigemDeFollowup } from "./followup-service-origin";
import { seedGov, GOV_AGENT_A } from "./gov-helpers";

/**
 * Remarcar depois de enviar deixava o cliente com o horário errado.
 *
 * Medido no código em 2026-09-12, seguindo a cadeia peça por peça: o gatilho de
 * remarcação não tocava em `meeting_delivery`; o de enfileirar só age em
 * `waiting_for_link`; `fn_meet_action('deliver')` devolve `false` em estado
 * `sent`; e a tela desabilitava o botão com "Link já enviado".
 *
 * Nenhuma varredura cobria o buraco: `fn_appointment_confirmation_sweep` só age
 * DEPOIS que o compromisso termina, e o que ela cria é aviso interno na Central
 * — nunca mensagem ao cliente. A pessoa aparecia no dia errado.
 */

// A conexão é a do Postgres efêmero que `scripts/test-db.sh` sobe, e não a do
// `.env`: a primeira versão deste arquivo usou `SUPABASE_DB_URL` e os seis casos
// morreram em ECONNREFUSED — que lê como "o conserto não funciona" e é só o
// arreio errado. Mesma forma dos vizinhos em `tests/invariants/`.
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});
beforeAll(() => seedGov());
afterAll(() => pool.end());

/** Compromisso com o link JÁ ENVIADO — que é o estado em que o defeito mora. */
async function jaEnviado() {
  const org = randomUUID();
  const id = randomUUID();
  const contact = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Remarcar','Remarcar')",
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
       starts_at,ends_at,status,location_kind,meeting_state,meeting_url,meeting_request_id,meeting_delivery)
     values($1,$2,$3,$4,$5::uuid,'Reunião',now()+interval '4 days',now()+interval '4 days 1 hour','confirmed',
       'google_meet','ready','https://meet.google.com/abc-defg-hij',gen_random_uuid(),
       jsonb_build_object('state','sent','generation',gen_random_uuid()::text,'service_boundary',$6::jsonb,
                          'authorized_by',jsonb_build_object('kind','user','id',$5::uuid::text)))`,
    [id, org, contact, boundary.conversation_id, GOV_AGENT_A, JSON.stringify(boundary)],
  );
  return { org, id, contact };
}

const entrega = async (id: string) =>
  (await pool.query("select meeting_delivery d from calendar_appointments where id=$1", [id]))
    .rows[0].d as Record<string, unknown>;

// ⚠️ Remarcar arrasta o compromisso INTEIRO: quem move o começo move o fim
// junto. A primeira versão destes casos empurrava só `starts_at`, e os quatro
// morreram em `calendar_appointments_periodo_valido` — o banco recusou um
// compromisso que termina antes de comecar. Lia como "o gatilho nao dispara" e
// era o arreio: a linha nunca chegou a ser gravada. A constraint do produto
// estava certa; o teste é que descrevia uma remarcação impossível.

it("⛔ mudar o HORÁRIO de um compromisso já enviado reenfileira a correção", async () => {
  const f = await jaEnviado();
  await pool.query(
    "update calendar_appointments set starts_at=starts_at+interval '1 day',ends_at=ends_at+interval '1 day' where id=$1",
    [f.id],
  );
  const d = await entrega(f.id);
  expect(d.motivo).toBe("remarcado");
  expect(["waiting_for_link", "queued", "stale"]).toContain(d.state);
});

it("⛔ mudar o FUSO também — é o outro campo que entra no texto", async () => {
  const f = await jaEnviado();
  await pool.query("update calendar_appointments set time_zone='America/Manaus' where id=$1", [
    f.id,
  ]);
  expect((await entrega(f.id)).motivo).toBe("remarcado");
});

it("⛔ mudar só o TÍTULO não manda nada", async () => {
  // A guarda que impede o conserto de virar defeito novo: reagir a qualquer
  // `update` na linha faria uma edição de título mandar link ao cliente.
  const f = await jaEnviado();
  await pool.query("update calendar_appointments set title='Outro nome' where id=$1", [f.id]);
  const d = await entrega(f.id);
  expect(d.state).toBe("sent");
  expect(d.motivo).toBeUndefined();
});

it("⛔ compromisso CANCELADO não recebe correção", async () => {
  // Avisar cancelamento é outra funcionalidade. Mandar "o horário mudou" de um
  // compromisso que não existe mais é pior que calar.
  const f = await jaEnviado();
  await pool.query(
    "update calendar_appointments set status='cancelled',cancelled_at=now(),starts_at=starts_at+interval '1 day',ends_at=ends_at+interval '1 day' where id=$1",
    [f.id],
  );
  expect((await entrega(f.id)).motivo).toBeUndefined();
});

it("⛔ ANTIRREPETIÇÃO: duas remarcações seguidas deixam UM job vivo", async () => {
  // Arrastar o compromisso cinco vezes na grade não pode virar cinco mensagens.
  const f = await jaEnviado();
  await pool.query(
    "update calendar_appointments set starts_at=starts_at+interval '1 day',ends_at=ends_at+interval '1 day' where id=$1",
    [f.id],
  );
  await pool.query(
    "update calendar_appointments set starts_at=starts_at+interval '2 days',ends_at=ends_at+interval '2 days' where id=$1",
    [f.id],
  );
  const vivos = await pool.query(
    "select id from job_queue where organization_id=$1 and kind='transactional_delivery' and status in ('pending','running')",
    [f.org],
  );
  expect(vivos.rowCount).toBeLessThanOrEqual(1);
});

it("CONTROLE: compromisso que NUNCA foi enviado não ganha correção ao ser remarcado", async () => {
  // Sem este par, um gatilho que disparasse sempre passaria nos casos acima — e
  // mandaria "o horário mudou" para quem nunca recebeu horário nenhum.
  const f = await jaEnviado();
  await pool.query("update calendar_appointments set meeting_delivery='{}'::jsonb where id=$1", [
    f.id,
  ]);
  await pool.query(
    "update calendar_appointments set starts_at=starts_at+interval '1 day',ends_at=ends_at+interval '1 day' where id=$1",
    [f.id],
  );
  expect((await entrega(f.id)).motivo).toBeUndefined();
});
