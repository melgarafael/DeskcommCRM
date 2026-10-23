import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { carregarContextoDoAtendimento, projetarContextoDoAtendimento } from "@/lib/agent-engine/agent/contexto-do-atendimento";
import { pacoteFactualDaRevisao } from "@/lib/agent-engine/guardrails/promise/contrato-contexto";
import { reciboDoServico } from "@/lib/agenda/servicos/escrita";

// Nova cobertura T1–T8 do contrato de serviços; nenhuma lei congelada é alterada.
// Próxima terça-feira: a reserva usa o relógio real do banco, não uma data que vence no CI.
const diaDaAula = new Date();
diaDaAula.setUTCHours(0, 0, 0, 0);
diaDaAula.setUTCDate(diaDaAula.getUTCDate() + ((2 - diaDaAula.getUTCDay() + 7) % 7 || 7));
function em(hora: string, dias = 0): string {
  const dia = new Date(diaDaAula);
  dia.setUTCDate(dia.getUTCDate() + dias);
  return `${dia.toISOString().slice(0, 10)}T${hora}`;
}

const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL ?? `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres` });
const tenant = () => ({ org: randomUUID(), manager: randomUUID(), viewer: randomUUID() });
const tenants = [tenant(), tenant()] as const;
const at = em("17:00:00Z");
const now = new Date().toISOString();
beforeAll(async () => {
  for (const tenant of tenants) {
    await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Serviços fictícios','Serviços fictícios')", [tenant.org]);
    for (const role of ["manager", "viewer"] as const) {
      await pool.query("insert into auth.users(id,email) values($1,$2)", [tenant[role], `${tenant[role]}@example.test`]);
      await pool.query("insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,$3,now())", [tenant.org, tenant[role], role]);
    }
  }
});
afterAll(() => pool.end());

async function service(mode = "collective_unlimited", capacity: number | null = null) {
  const id = randomUUID();
  await pool.query("insert into calendar_event_types(id,organization_id,name,slug,duration_minutes,minimum_notice_minutes,service_enabled,booking_mode,service_capacity) values($1::uuid,$2,'Atividade fictícia',$1::text,40,0,true,$3,$4)", [id, tenants[0].org, mode, capacity]);
  await pool.query("insert into calendar_service_schedule(organization_id,event_type_id,weekday,timing_kind,start_minute) values($1,$2,2,'fixed',840)", [tenants[0].org, id]);
  return id;
}
async function check(id: string, start = at) {
  const { rows } = await pool.query("select fn_calendar_service_check($1,$2,$3,null,null,$4) result", [tenants[0].org, id, start, now]);
  return rows[0].result;
}
async function reserveFixture(id: string, start: string, end: string) {
  // Simular reservas anteriores à adoção do serviço, sem uma exceção de escrita no produto.
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("update calendar_event_types set service_enabled=false where id=$1", [id]);
    await db.query("insert into calendar_appointments(organization_id,event_type_id,title,starts_at,ends_at,status) values($1,$2,'Reserva preservada',$3,$4,'confirmed')", [tenants[0].org, id, start, end]);
    await db.query("update calendar_event_types set service_enabled=true where id=$1", [id]);
    await db.query("commit");
  } catch (e) { await db.query("rollback"); throw e; } finally { db.release(); }
}
async function contact() {
  const id = randomUUID();
  await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,'Participante fictício')", [id, tenants[0].org]);
  return id;
}
async function book(id: string, contactId: string, operationKey = randomUUID(), fields: Record<string, unknown> = {}) {
  const { rows } = await pool.query("select fn_calendar_service_book($1,$2,$3) r", [tenants[0].org, { type: "user", id: tenants[0].manager }, { event_type_id: id, starts_at: at, contact_id: contactId, operation_key: operationKey, ...fields }]);
  return rows[0].r;
}
async function withUser<T>(user: string, run: (db: pg.PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("begin"); await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: "authenticated", aal: "aal1" })]);
    return await run(client);
  } finally { await client.query("rollback"); client.release(); }
}

describe("serviços opt-in e disponibilidade factual", () => {
  it("as oito tabelas novas isolam JWTs de duas organizações e recusam escrita direta", async () => {
    const org = tenants[0].org, id = await service(), resource = randomUUID(), conn = randomUUID(), cal = randomUUID();
    await pool.query("insert into calendar_resources(id,organization_id,name,capacity) values($1,$2,'Recurso fictício',1)", [resource, org]);
    await pool.query("insert into calendar_service_resources(organization_id,event_type_id,resource_id,units) values($1,$2,$3,1)", [org, id, resource]);
    await book(id, await contact());
    await pool.query("insert into calendar_service_professionals(organization_id,event_type_id,user_id) values($1,$2,$3)", [org, id, tenants[0].manager]);
    await pool.query("insert into calendar_connections(id,organization_id,user_id,account_email,status) values($1,$2,$3,$4,'healthy')", [conn, org, tenants[0].manager, `${conn}@example.test`]);
    await pool.query("insert into calendar_connection_calendars(id,organization_id,connection_id,external_calendar_id,name,access_role,available,counts_for_conflicts) values($1::uuid,$2,$3,$1::text,'Fonte fictícia','owner',true,false)", [cal, org, conn]);
    await pool.query("insert into calendar_service_calendar_sources(organization_id,event_type_id,calendar_id) values($1,$2,$3)", [org, id, cal]);
    await pool.query("insert into calendar_service_blocks(organization_id,event_type_id,scope_kind,starts_at,ends_at,reason,operation_key) values($1,$2,'service',$3,$4,'Bloqueio fictício',$5)", [org, id, at, em("17:40:00Z"), randomUUID()]);
    const tables = ["calendar_resources", "calendar_service_schedule", "calendar_service_professionals", "calendar_service_resources", "calendar_service_calendar_sources", "calendar_service_occurrences", "calendar_service_occurrence_resources", "calendar_service_blocks"] as const;
    for (const table of tables) {
      const own = await withUser(tenants[0].viewer, db => db.query(`select count(*)::int n from ${table} where organization_id=$1`, [org]));
      expect(own.rows[0].n, table).toBeGreaterThan(0);
      const foreign = await withUser(tenants[1].viewer, db => db.query(`select count(*)::int n from ${table} where organization_id=$1`, [org]));
      expect(foreign.rows[0].n, table).toBe(0);
      for (const sql of [`insert into ${table} select * from ${table} where false`, `update ${table} set organization_id=organization_id where false`, `delete from ${table} where false`])
        await expect(withUser(tenants[0].manager, db => db.query(sql))).rejects.toMatchObject({ code: "42501" });
    }
  });
  it("uma duração Google incompatível é recusada sem normalizar silenciosamente a reserva", async () => {
    const id = await service(); const a = await book(id, await contact());
    await expect(pool.query("select fn_appointment_change_core($1,$2,$3,$4,true,null)", [tenants[0].org, a.id, a.revision,
      { starts_at: at, ends_at: em("18:00:00Z"), time_zone: "America/Sao_Paulo" }])).rejects.toMatchObject({ code: "PT409" });
    const preserved = (await pool.query("select * from calendar_appointments where id=$1", [a.id])).rows[0];
    expect(String(preserved.revision)).toBe(String(a.revision));
    expect(new Date(preserved.ends_at).toISOString()).toBe(em("17:40:00.000Z"));
  });
  it("aprovação da equipe é autenticada; a IA não a fabrica nem a leva para outra data", async () => {
    const id = await service(); const org = tenants[0].org;
    await pool.query("update calendar_event_types set requires_confirmation=true where id=$1", [id]);
    await pool.query("insert into calendar_service_schedule(organization_id,event_type_id,weekday,timing_kind,start_minute) values($1,$2,3,'fixed',840)", [org, id]);
    const a = await book(id, await contact()); expect(a.status).toBe("pending");
    await expect(pool.query("select fn_appointment_change($1,$2,$3,$4)", [org, a.id, a.revision, { status: "confirmed" }])).rejects.toMatchObject({ code: "42501" });
    await expect(withUser(tenants[0].viewer, (db) => db.query("select fn_appointment_change($1,$2,$3,$4)", [org, a.id, a.revision, { status: "confirmed" }]))).rejects.toMatchObject({ code: "42501" });
    const signed = await withUser(tenants[0].manager, async (db) => {
      const confirmation = (await db.query("select fn_appointment_change($1,$2,$3,$4) r", [org, a.id, a.revision, { status: "confirmed" }])).rows[0].r;
      expect(confirmation.service_confirmed_by_user_id).toBe(tenants[0].manager);
      expect(reciboDoServico(confirmation)).toMatchObject({ human_confirmation: "confirmed", communication: "not_proven" });
      expect(reciboDoServico(confirmation)).not.toHaveProperty("service_confirmed_by_user_id");
      // Simular o caminho service-only depois da confirmação, na mesma fixture.
      await db.query("reset role"); await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "service_role" })]);
      return (await db.query("select fn_appointment_change($1,$2,$3,$4) r", [org, a.id, confirmation.revision, { starts_at: em("17:00:00Z", 1) }])).rows[0].r;
    });
    expect(signed).toMatchObject({ status: "pending", service_confirmed_by_user_id: null, service_confirmed_at: null });
    expect(reciboDoServico(signed)).toMatchObject({ human_confirmation: "pending" });
  });
  it("salva rascunho sem oferta e exige programação válida ao ativar", async () => {
    const id = await service(); const org = tenants[0].org; const actor = { type: "user", id: tenants[0].manager };
    const config = { event_type_id: id, expected_revision: 1, service_enabled: true, is_active: false,
      booking_mode: "individual", service_timezone: "America/Sao_Paulo", professionals: [], resources: [], calendar_sources: [], schedule: [] };
    expect((await pool.query("select fn_calendar_service_configure($1,$2,$3) r", [org, actor, config])).rows[0].r).toMatchObject({ is_active: false });
    expect(await check(id)).toMatchObject({ available: false, reason: "service_inactive" });
    await expect(pool.query("select fn_calendar_service_configure($1,$2,$3)", [org, actor, { ...config, expected_revision: 2, is_active: true }])).rejects.toMatchObject({ code: "22023" });
    await expect(pool.query("update calendar_event_types set is_active=true where id=$1", [id])).rejects.toMatchObject({ code: "22023" });
    expect((await pool.query("select fn_calendar_service_preview($1,$2,$3,null,$4) r", [org, id, JSON.stringify([at]), now])).rows[0].r).toEqual([{ starts_at: at, available: false, reason: "service_inactive" }]);
  });
  it("gestor recupera publicação compartilhada; viewer, outro tenant e escrita direta não ganham autoridade", async () => {
    const id = await service(); const org = tenants[0].org; const owner = randomUUID(); const conn = randomUUID(); const cal = randomUUID();
    await pool.query("insert into auth.users(id,email) values($1,$2)", [owner, `${owner}@example.test`]);
    await pool.query("insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'agent',now())", [org, owner]);
    await pool.query("insert into calendar_connections(id,organization_id,user_id,account_email,status) values($1,$2,$3,$4,'healthy')", [conn, org, owner, `${conn}@example.test`]);
    await pool.query("insert into calendar_connection_calendars(id,organization_id,connection_id,external_calendar_id,name,access_role,available) values($1::uuid,$2,$3,$1::text,'Compartilhada fictícia','owner',true)", [cal, org, conn]);
    await pool.query("update calendar_event_types set destination_calendar_id=$2,service_publication_mode='service' where id=$1", [id, cal]);
    const a = await book(id, await contact());
    for (const user of [owner, tenants[0].manager]) {
      const result = await withUser(user, (db) => db.query("select fn_calendar_service_can_resolve($1,$2) allowed, fn_google_resolve($1,$2,$3,$4,null,'retry')", [org, a.id, String(a.revision), String(a.google_local_revision)]));
      expect(result.rows[0].allowed).toBe(true);
    }
    for (const user of [tenants[0].viewer, tenants[1].manager])
      await expect(withUser(user, (db) => db.query("select fn_google_resolve($1,$2,$3,$4,null,'retry')", [org, a.id, String(a.revision), String(a.google_local_revision)]))).rejects.toMatchObject({ code: "42501" });
    const raw = await withUser(tenants[0].manager, (db) => db.query("update calendar_appointments set starts_at=starts_at+interval '1 day' where id=$1 returning id", [a.id]));
    expect(raw.rows).toEqual([]);
    await pool.query("update user_organizations set revoked_at=now() where organization_id=$1 and user_id=$2", [org, owner]);
    expect((await withUser(tenants[0].manager, (db) => db.query("select fn_calendar_service_can_resolve($1,$2) r", [org, a.id]))).rows[0].r).toBe(false);
  });
  it("releitura após ferramenta traz reserva atual ao pacote comum, sem comunicação ou participantes alheios", async () => {
    const id = await service(); const c = await contact(); const conv = randomUUID(); const session = randomUUID(); const org = tenants[0].org;
    await pool.query("insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted) values($1::uuid,$2,$1::text,'WORKING','\\x00')", [session, org]);
    await pool.query("insert into conversations(id,organization_id,contact_id,channel_session_id,status,is_group) values($1,$2,$3,$4,'ai_handling',false)", [conv, org, c, session]);
    const ids = { tenantId: org, leadId: c, conversationId: conv };
    const before = await carregarContextoDoAtendimento(pool, ids); expect(before.operacoes).toEqual([]);
    const a = await book(id, c, randomUUID(), { conversation_id: conv, participant_name: "Pessoa do pedido" });
    await book(id, await contact(), randomUUID(), { participant_name: "OUTRO_CLIENTE_PRIVADO" });
    const after = await carregarContextoDoAtendimento(pool, ids);
    const fact = after.operacoes.find((o) => o.origem === "agenda_persistida");
    expect(fact?.dados).toMatchObject({ participante: "Pessoa do pedido", modo: "collective_unlimited", publicacao_google: "not_configured", comunicacao: "nao_comprovada_pela_reserva" });
    const common = pacoteFactualDaRevisao({ candidate: "Reserva registrada no CRM.", serviceContext: after });
    expect(common.contexto_atendimento).toEqual(projetarContextoDoAtendimento(after));
    expect(JSON.stringify(common)).not.toContain("OUTRO_CLIENTE_PRIVADO"); expect(JSON.stringify(common)).not.toContain(c);
    const fingerprint = after.fingerprint;
    await pool.query("select fn_appointment_change($1,$2,$3,$4)", [org, a.id, a.revision, { status: "cancelled", cancellation_reason: "Pedido fictício encerrado." }]);
    const cancelled = await carregarContextoDoAtendimento(pool, ids);
    expect(cancelled.operacoes[0]?.dados.estado).toBe("cancelled"); expect(cancelled.fingerprint).not.toBe(fingerprint);
  });
  it("transição espera estoque antes de travar o contato, preservando a ordem da reserva", async () => {
    const id = await service(); const c = await contact(); const a = await book(id, c);
    const stock = await pool.connect(); const writer = await pool.connect(); const probe = await pool.connect();
    let pending: Promise<pg.QueryResult> | undefined;
    try {
      await stock.query("begin"); await stock.query("select fn_calendar_service_lock($1)", [tenants[0].org]);
      await writer.query("begin"); await writer.query("set local application_name='ag002-lock-order'");
      pending = writer.query("select fn_appointment_change($1,$2,$3,$4)", [tenants[0].org, a.id, a.revision, { status: "cancelled", cancellation_reason: "Teste de ordem de locks." }]);
      let waiting = false;
      for (let i = 0; i < 50 && !waiting; i++) {
        waiting = (await probe.query("select exists(select 1 from pg_stat_activity where application_name='ag002-lock-order' and wait_event='advisory') waiting")).rows[0].waiting;
        if (!waiting) await new Promise((r) => setTimeout(r, 20));
      }
      expect(waiting).toBe(true);
      await probe.query("begin"); await probe.query("set local lock_timeout='150ms'");
      await expect(probe.query("select fn_service_lock($1,$2)", [tenants[0].org, c])).resolves.toHaveProperty("rowCount", 1);
    } finally {
      await probe.query("rollback"); await stock.query("rollback"); if (pending) await pending; await writer.query("rollback");
      stock.release(); writer.release(); probe.release();
    }
  });
  it("a porta humana nativa cria pela sessão, deriva autoria e não expõe as RPCs internas", async () => {
    const id = await service(); const c = await contact();
    const input = { event_type_id: id, contact_id: c, starts_at: at, operation_key: randomUUID(), meeting_delivery: { state: "waiting_for_link", authorized_by: { kind: "user", id: tenants[1].manager } } };
    const positive = await withUser(tenants[0].manager, (db) => db.query("select fn_appointment_change($1,null,null,$2) r", [tenants[0].org, { create_service_booking: input }]));
    expect(positive.rows[0].r).toMatchObject({ contact_id: c, created_by_kind: "user", created_by_user_id: tenants[0].manager, owner_user_id: null, meeting_delivery: { state: "none" } });
    await expect(withUser(tenants[0].viewer, (db) => db.query("select fn_appointment_change($1,null,null,$2)", [tenants[0].org, { create_service_booking: input }]))).rejects.toMatchObject({ code: "42501" });
    await expect(withUser(tenants[1].manager, (db) => db.query("select fn_appointment_change($1,null,null,$2)", [tenants[0].org, { create_service_booking: input }]))).rejects.toMatchObject({ code: "42501" });
    await expect(withUser(tenants[0].manager, (db) => db.query("select fn_calendar_service_book($1,$2,$3)", [tenants[0].org, { type: "user", id: tenants[1].manager }, input]))).rejects.toMatchObject({ code: "42501" });
  });
  it("remarca e cancela a mesma reserva; retry recupera seu estado atual", async () => {
    const id = await service(); const c = await contact(); const key = randomUUID();
    await pool.query("insert into calendar_service_schedule(organization_id,event_type_id,weekday,timing_kind,start_minute,duration_minutes) values($1,$2,3,'fixed',840,45)", [tenants[0].org, id]);
    const first = await book(id, c, key);
    const moved = (await pool.query("select fn_appointment_change($1,$2,$3,$4) r", [tenants[0].org, first.id, first.revision, { starts_at: em("17:00:00Z", 1) }])).rows[0].r;
    expect(moved).toMatchObject({ id: first.id, ends_at: em("17:45:00+00:00", 1), service_capacity_rule: "inherit" });
    expect(moved.service_occurrence_id).not.toBe(first.service_occurrence_id);
    const retried = await book(id, c, key);
    expect(retried).toMatchObject({ id: first.id, deduplicated: true, starts_at: moved.starts_at });
    const cancelled = (await pool.query("select fn_appointment_change($1,$2,$3,$4) r", [tenants[0].org, moved.id, moved.revision, { status: "cancelled", cancellation_reason: "Teste fictício encerrado." }])).rows[0].r;
    expect(await book(id, c, key)).toMatchObject({ id: first.id, status: "cancelled", revision: cancelled.revision, deduplicated: true });
    expect((await pool.query("select count(*)::int n from calendar_appointments where event_type_id=$1", [id])).rows[0].n).toBe(1);
  });
  it("não move a reserva para fora da programação nem libera a origem após recusa", async () => {
    const id = await service(); const first = await book(id, await contact());
    await expect(pool.query("select fn_appointment_change($1,$2,$3,$4)", [tenants[0].org, first.id, first.revision, { starts_at: em("18:00:00Z") }])).rejects.toMatchObject({ code: "PT409" });
    expect((await pool.query("select service_occurrence_id,revision from calendar_appointments where id=$1", [first.id])).rows[0]).toEqual({ service_occurrence_id: first.service_occurrence_id, revision: String(first.revision) });
  });
  it("publica serviço compartilhado com titular real, sem inventar profissional", async () => {
    const id = await service(); const conn = randomUUID(); const calendar = randomUUID();
    await pool.query("insert into calendar_connections(id,organization_id,user_id,account_email,status) values($1,$2,$3,$4,'healthy')", [conn, tenants[0].org, tenants[0].manager, `${conn}@example.test`]);
    await pool.query("insert into calendar_connection_calendars(id,organization_id,connection_id,external_calendar_id,name,access_role,available,is_destination,counts_for_conflicts) values($1::uuid,$2,$3,$1::text,'Destino fictício','owner',true,false,false)", [calendar, tenants[0].org, conn]);
    await pool.query("update calendar_event_types set destination_calendar_id=$2,service_publication_mode='service' where id=$1", [id, calendar]);
    const a = await book(id, await contact());
    expect(a).toMatchObject({ owner_user_id: null, service_destination_calendar_id: calendar, service_publication_mode: "service" });
    expect((await pool.query("select owner_user_id from calendar_service_google_candidates where id=$1", [a.id])).rows[0]).toMatchObject({ owner_user_id: tenants[0].manager });
    const snapshot = (await pool.query("select fn_google_appointment($1,$2,'claim') r", [tenants[0].org, a.id])).rows[0].r;
    expect(snapshot).toMatchObject({ owner_user_id: null, google_connection_id: conn, google_calendar_id: calendar, google_event_id: `deskcommapp${a.id.replaceAll('-', '')}` });
    const unconfigured = await book(await service(), await contact());
    expect((await pool.query("select fn_google_appointment($1,$2,'claim') r", [tenants[0].org, unconfigured.id])).rows[0].r).toEqual({ terminal: "not_configured" });
    expect((await pool.query("select id from calendar_service_google_candidates where id=$1", [unconfigured.id])).rows).toEqual([]);
  });
  it("recurso e bloqueio exigem gerente atual, escopo e revisão; nenhuma reserva é apagada", async () => {
    const org = tenants[0].org; const actor = { type: "user", id: tenants[0].manager };
    await expect(pool.query("select fn_calendar_service_resource($1,$2,$3)", [org, { type: "user", id: tenants[0].viewer }, { name: "Recurso fictício", capacity: 1 }])).rejects.toMatchObject({ code: "42501" });
    const r = (await pool.query("select fn_calendar_service_resource($1,$2,$3) r", [org, actor, { name: "Recurso fictício", capacity: 1 }])).rows[0].r;
    await expect(pool.query("select fn_calendar_service_resource($1,$2,$3)", [tenants[1].org, { type: "user", id: tenants[1].manager }, { id: r.id, name: "Recurso fictício", capacity: 2, expected_revision: 1 }])).rejects.toMatchObject({ code: "P0002" });
    const id = await service(); const a = await book(id, await contact());
    const input = { operation_key: randomUUID(), scope_kind: "service", event_type_id: id, starts_at: at, ends_at: em("17:40:00Z"), reason: "Bloqueio fictício" };
    const preview = (await pool.query("select fn_calendar_service_block($1,$2,$3) r", [org, actor, { ...input, preview: true }])).rows[0].r;
    expect(preview).toMatchObject({ preview: true, existing_reservations_preserved: 1 });
    expect(await check(id)).toMatchObject({ available: true });
    expect((await pool.query("select count(*)::int n from calendar_service_blocks where event_type_id=$1", [id])).rows[0].n).toBe(0);
    const b = (await pool.query("select fn_calendar_service_block($1,$2,$3) r", [org, actor, input])).rows[0].r;
    expect(b).toMatchObject({ existing_reservations_preserved: 1, google_publication: "not_configured" });
    expect(await check(id)).toMatchObject({ available: false, reason: "blocked" });
    expect((await pool.query("select fn_calendar_service_block($1,$2,$3) r", [org, actor, input])).rows[0].r).toMatchObject({ id: b.id, deduplicated: true });
    await expect(pool.query("select fn_calendar_service_block($1,$2,$3)", [org, actor, { archive_id: b.id, expected_revision: 9 }])).rejects.toMatchObject({ code: "PT409" });
    await pool.query("select fn_calendar_service_block($1,$2,$3)", [org, actor, { archive_id: b.id, expected_revision: 1 }]);
    expect(await check(id)).toMatchObject({ available: true });
    expect((await pool.query("select status from calendar_appointments where id=$1", [a.id])).rows[0].status).toBe("confirmed");
  });
  it("uma turma ocupa o mesmo profissional uma vez, mas outra turma segue recusada", async () => {
    const owner = randomUUID(); const id = await service(); const another = await service();
    await pool.query("insert into auth.users(id,email) values($1,$2)", [owner, `${owner}@example.test`]);
    await pool.query("insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'agent',now())", [tenants[0].org, owner]);
    await pool.query("insert into calendar_service_professionals values($1,$2,$4),($1,$3,$4)", [tenants[0].org, id, another, owner]);
    await pool.query("insert into attendant_availability(organization_id,user_id,is_available,schedule) values($1,$2,true,$3)", [tenants[0].org, owner, { timezone: "America/Sao_Paulo", windows: [{ dow: 2, start: "08:00", end: "18:00" }] }]);
    const a = await book(id, await contact()); const b = await book(id, await contact());
    expect(a.owner_user_id).toBe(owner); expect(b.owner_user_id).toBe(owner); expect(b.service_occurrence_id).toBe(a.service_occurrence_id);
    expect(await check(another)).toMatchObject({ available: false, reason: "professional_unavailable" });
  });
  it("oferece uma turma sem limite e sem responsável fictício", async () => {
    const id = await service();
    await reserveFixture(id, at, em("17:40:00Z"));
    await reserveFixture(id, at, em("17:40:00Z"));
    expect(await check(id)).toMatchObject({ available: true, booking_mode: "collective_unlimited", capacity_limit: null, occupied: 2, owner_user_id: null, duration_minutes: 40 });
    expect(await check(id, em("18:00:00Z"))).toMatchObject({ available: false, reason: "outside_schedule" });
  });
  it("conta o pico durante toda a duração, sem somar ocupações disjuntas", async () => {
    const id = await service("collective_limited", 2);
    await reserveFixture(id, at, em("17:20:00Z"));
    await reserveFixture(id, em("17:20:00Z"), em("17:40:00Z"));
    expect(await check(id)).toMatchObject({ available: true, occupied: 1, remaining_capacity: 1 });
    await reserveFixture(id, at, em("17:40:00Z"));
    expect(await check(id)).toMatchObject({ available: false, reason: "capacity_reached", occupied: 2 });
  });
  it("a exceção por data substitui a capacidade semanal sem desligar um bloqueio", async () => {
    const id = await service("collective_limited", 1);
    await reserveFixture(id, at, em("17:40:00Z"));
    await pool.query("insert into calendar_service_schedule(organization_id,event_type_id,on_date,timing_kind,start_minute,capacity_rule) values($1,$2,$3::date,'fixed',840,'unlimited')", [tenants[0].org, id, diaDaAula.toISOString().slice(0, 10)]);
    expect(await check(id)).toMatchObject({ available: true, capacity_rule: "unlimited", capacity_limit: null });
    await pool.query("insert into calendar_service_blocks(organization_id,scope_kind,event_type_id,starts_at,ends_at,reason,operation_key) values($1,'service',$2,$3,$4,'Bloqueio fictício',$5)", [tenants[0].org, id, at, em("17:40:00Z"), randomUUID()]);
    expect(await check(id)).toMatchObject({ available: false, reason: "blocked" });
    const independent = await service();
    expect(await check(independent)).toMatchObject({ available: true });
  });
  it("a janela avisa que não foi verificada quando a fonte não tem cobertura", async () => {
    const id = await service(); const connection = randomUUID(); const calendar = randomUUID();
    await pool.query("insert into calendar_connections(id,organization_id,user_id,account_email,status) values($1,$2,$3,'calendar@example.test','healthy')", [connection, tenants[0].org, tenants[0].manager]);
    await pool.query("insert into calendar_connection_calendars(id,organization_id,connection_id,external_calendar_id,name,available,access_role) values($1::uuid,$2,$3,$1::text,'Calendário fictício',true,'owner')", [calendar, tenants[0].org, connection]);
    await pool.query("insert into calendar_service_calendar_sources values($1,$2,$3)", [tenants[0].org, id, calendar]);
    expect(await check(id)).toMatchObject({ available: false, reason: "availability_unverified" });
    await pool.query("update calendar_connection_calendars set last_sync_at=now(),sync_coverage=jsonb_build_object('window_start',now()-interval '1 day','window_end',now()+interval '30 days') where id=$1", [calendar]);
    expect(await check(id)).toMatchObject({ available: true });
    await pool.query("update user_organizations set revoked_at=now() where organization_id=$1 and user_id=$2", [tenants[0].org, tenants[0].manager]);
    expect(await check(id)).toMatchObject({ available: false, reason: "availability_unverified" });
    await pool.query("update user_organizations set revoked_at=null where organization_id=$1 and user_id=$2", [tenants[0].org, tenants[0].manager]);
  });
  it("a leitura autenticada e as FKs não atravessam organizações", async () => {
    const id = await service();
    expect((await withUser(tenants[0].viewer, (db) => db.query("select fn_calendar_service_read($1,$2) r", [tenants[0].org, id]))).rows[0].r).toMatchObject({ event_type_id: id });
    await expect(withUser(tenants[1].viewer, (db) => db.query("select fn_calendar_service_read($1,$2)", [tenants[0].org, id]))).rejects.toMatchObject({ code: "42501" });
    const foreign = await withUser(tenants[1].viewer, (db) => db.query("select * from calendar_service_schedule where event_type_id=$1", [id]));
    expect(foreign.rows).toEqual([]);
    await expect(pool.query("insert into calendar_service_schedule(organization_id,event_type_id,weekday,timing_kind,start_minute) values($1,$2,2,'fixed',900)", [tenants[1].org, id])).rejects.toMatchObject({ code: "23503" });
    await expect(withUser(tenants[0].viewer, (db) => db.query("update calendar_service_schedule set start_minute=900 where event_type_id=$1", [id]))).rejects.toMatchObject({ code: "42501" });
  });
  it("uma alteração de capacidade preserva reservas e exige ator/revisão atuais", async () => {
    const id = await service(); await reserveFixture(id, at, em("17:40:00Z"));
    const revision = Number((await pool.query("select service_revision from calendar_event_types where id=$1", [id])).rows[0].service_revision);
    const config = { event_type_id: id, expected_revision: revision, service_enabled: true, booking_mode: "collective_limited", service_capacity: 1, service_timezone: "America/Sao_Paulo", professionals: [], resources: [], calendar_sources: [], schedule: [{ weekday: 2, timing_kind: "fixed", start_minute: 840, capacity_rule: "inherit" }] };
    await expect(pool.query("select fn_calendar_service_configure($1,$2,$3)", [tenants[0].org, { type: "user", id: tenants[0].viewer }, config])).rejects.toMatchObject({ code: "42501" });
    const result = await pool.query("select fn_calendar_service_configure($1,$2,$3) r", [tenants[0].org, { type: "user", id: tenants[0].manager }, config]);
    expect(result.rows[0].r).toMatchObject({ service_revision: revision + 1, existing_reservations_preserved: true });
    expect((await pool.query("select count(*)::int n from calendar_appointments where event_type_id=$1", [id])).rows[0].n).toBe(1);
    expect(await check(id)).toMatchObject({ available: false, reason: "capacity_reached" });
    await expect(pool.query("select fn_calendar_service_configure($1,$2,$3)", [tenants[0].org, { type: "user", id: tenants[0].manager }, config])).rejects.toMatchObject({ code: "PT409" });
  });
  it("aceita três participantes na mesma ocorrência e deduplica comando e pessoa", async () => {
    const id = await service(); const contacts = await Promise.all([contact(), contact(), contact()]); const command = randomUUID();
    const first = await book(id, contacts[0], command);
    const others = await Promise.all(contacts.slice(1).map((c) => book(id, c)));
    expect(new Set([first, ...others].map((r) => r.id)).size).toBe(3);
    expect(new Set([first, ...others].map((r) => r.service_occurrence_id)).size).toBe(1);
    expect(await book(id, contacts[0], command)).toMatchObject({ id: first.id, deduplicated: true });
    expect(await book(id, contacts[0])).toMatchObject({ id: first.id, deduplicated: true });
    await expect(book(id, contacts[1], command)).rejects.toMatchObject({ code: "PT409" });
    expect((await pool.query("select count(*)::int n from calendar_appointments where event_type_id=$1", [id])).rows[0].n).toBe(3);
  });
  it("a corrida pela última vaga tem um único vencedor", async () => {
    const id = await service("collective_limited", 1); const contacts = await Promise.all([contact(), contact()]);
    const result = await Promise.allSettled(contacts.map((c) => book(id, c)));
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(result.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await pool.query("select count(*)::int n from calendar_appointments where event_type_id=$1", [id])).rows[0].n).toBe(1);
  });
  it("o grupo não deixa uma reserva parcial quando não cabe inteiro", async () => {
    const id = await service("collective_limited", 1); const c = await contact();
    await expect(pool.query("select fn_calendar_service_book_group($1,$2,$3)", [tenants[0].org, { type: "user", id: tenants[0].manager }, { event_type_id: id, starts_at: at, contact_id: c, operation_key: randomUUID(), participants: ["Pessoa fictícia A", "Pessoa fictícia B"] }])).rejects.toMatchObject({ code: "PT409" });
    expect((await pool.query("select count(*)::int n from calendar_appointments where event_type_id=$1", [id])).rows[0].n).toBe(0);
  });
  it("um recurso coletivo é ocupado uma vez e impede outra atividade", async () => {
    const a = await service(); const b = await service(); const resource = randomUUID();
    await pool.query("insert into calendar_resources(id,organization_id,name,capacity) values($1,$2,'Sala fictícia',1)", [resource, tenants[0].org]);
    await pool.query("insert into calendar_service_resources values($1,$2,$4,1),($1,$3,$4,1)", [tenants[0].org, a, b, resource]);
    await book(a, await contact()); await book(a, await contact());
    expect((await pool.query("select count(*)::int n from calendar_service_occurrence_resources where resource_id=$1", [resource])).rows[0].n).toBe(1);
    await expect(book(b, await contact())).rejects.toMatchObject({ code: "PT409" });
    expect(await check(b)).toMatchObject({ available: false, reason: "resource_unavailable" });
  });
  it("o profissional real continua protegido contra reserva individual legada", async () => {
    const id = await service("individual"); const owner = tenants[0].manager;
    await pool.query("insert into calendar_service_professionals values($1,$2,$3)", [tenants[0].org, id, owner]);
    await pool.query("insert into attendant_availability(organization_id,user_id,is_available,schedule) values($1,$2,true,$3) on conflict(organization_id,user_id) do update set is_available=true,schedule=excluded.schedule", [tenants[0].org, owner, { timezone: "America/Sao_Paulo", windows: [{ dow: 2, start: "08:00", end: "18:00" }] }]);
    const result = await book(id, await contact());
    expect(result.owner_user_id).toBe(owner);
    await expect(pool.query("insert into calendar_appointments(organization_id,owner_user_id,title,starts_at,ends_at,status) values($1,$2,'Legado fictício',$3,$4,'confirmed')", [tenants[0].org, owner, at, em("17:40:00Z")])).rejects.toMatchObject({ code: "PT409" });
    expect(await check(id)).toMatchObject({ available: false, reason: "professional_unavailable" });
  });
  it("o dono assume a empresa mesmo quando o provisório era profissional e dono de bloqueio", async () => {
    // fn_accept_team_invite apaga o vínculo provisório; com a FK composta em NO ACTION, o aceite do dono caía em 23503.
    const org = randomUUID(), provisorio = randomUUID(), dono = randomUUID(), id = randomUUID();
    await pool.query("insert into organizations(id,slug,legal_name,display_name,status) values($1::uuid,$1::text,'Passagem fictícia','Passagem fictícia','active')", [org]);
    for (const u of [provisorio, dono]) await pool.query("insert into auth.users(id,email) values($1,$2)", [u, `${u}@example.test`]);
    await pool.query("insert into user_organizations(organization_id,user_id,role,accepted_at,provisional_until_handover) values($1,$2,'admin',now(),true)", [org, provisorio]);
    await pool.query("insert into calendar_event_types(id,organization_id,name,slug,duration_minutes,minimum_notice_minutes,service_enabled,booking_mode) values($1::uuid,$2,'Atividade fictícia',$1::text,40,0,false,'individual')", [id, org]);
    await pool.query("insert into calendar_service_professionals(organization_id,event_type_id,user_id) values($1,$2,$3)", [org, id, provisorio]);
    await pool.query("insert into calendar_service_blocks(organization_id,scope_kind,owner_user_id,starts_at,ends_at,reason,operation_key) values($1,'professional',$2,$3,$4,'Bloqueio fictício',$5)", [org, provisorio, at, em("17:40:00Z"), randomUUID()]);
    await pool.query("select fn_accept_team_invite($1,$2,'admin',null,null,now())", [dono, org]);
    const sobra = await pool.query("select (select count(*) from user_organizations where organization_id=$1 and user_id=$2)::int vinculo, (select count(*) from calendar_service_professionals where organization_id=$1 and user_id=$2)::int profissional, (select count(*) from calendar_service_blocks where organization_id=$1 and owner_user_id=$2)::int bloqueio", [org, provisorio]);
    expect(sobra.rows[0]).toEqual({ vinculo: 0, profissional: 0, bloqueio: 0 });
  });
});
