import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin";
import { collectExportData } from "@/lib/lgpd/export-collector";
import { logger } from "@/lib/logger";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
});
afterAll(() => pool.end());

// Ponte de leitura somente para este coletor. Projeções, filtros, paginação e
// contagem viram SQL real: devolver SELECT * aqui esconderia vazamento de payload.
const queries: Array<{ table: string; columns: string }> = [];
const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw Error(`identificador inválido: ${s}`);
  return `"${s}"`;
};
const field = (s: string): string => {
  const json = /^([a-z_]+)->>([a-z_]+)$/.exec(s);
  return json ? `${ident(json[1]!)}->>'${json[2]}'` : ident(s);
};
class ReadQuery {
  columns = "";
  filters: string[] = [];
  values: unknown[] = [];
  ordering: string[] = [];
  size?: number;
  offset = 0;
  one = false;
  head = false;
  constructor(readonly table: string) {}
  parameter(value: unknown) {
    this.values.push(value);
    return `$${this.values.length}`;
  }
  select(columns: string, options?: { head?: boolean }) {
    this.columns = columns;
    this.head = !!options?.head;
    return this;
  }
  eq(key: string, value: unknown) {
    this.filters.push(`${field(key)}=${this.parameter(value)}`);
    return this;
  }
  in(key: string, values: unknown[]) {
    this.filters.push(`${field(key)}=any(${this.parameter(values)})`);
    return this;
  }
  or(expression: string) {
    this.filters.push(
      `(${expression
        .split(",")
        .map((term) => {
          const [key, op, value] = term.split(".");
          if (op !== "eq" || !key || !value) throw Error("filtro não suportado");
          return `${field(key)}=${this.parameter(value)}`;
        })
        .join(" or ")})`,
    );
    return this;
  }
  order(key: string, options?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.ordering.push(
      `${field(key)} ${options?.ascending === false ? "desc" : "asc"} ${options?.nullsFirst === false ? "nulls last" : ""}`,
    );
    return this;
  }
  limit(size: number) {
    this.size = size;
    return this;
  }
  range(from: number, to: number) {
    this.offset = from;
    this.size = to - from + 1;
    return this;
  }
  maybeSingle() {
    this.one = true;
    return this.execute();
  }
  then(yes: (value: unknown) => unknown, no?: (error: unknown) => unknown) {
    return this.execute().then(yes, no);
  }
  async execute() {
    queries.push({ table: this.table, columns: this.columns });
    const projection = this.columns
      .split(",")
      .map((part) => {
        const [alias, source] = part.trim().split(":");
        return source ? `${field(source)} as ${ident(alias!)}` : field(alias!);
      })
      .join(",");
    const where = this.filters.length ? ` where ${this.filters.join(" and ")}` : "";
    if (this.head) {
      const result = await pool.query(
        `select count(*)::int n from ${ident(this.table)}${where}`,
        this.values,
      );
      return { data: null, error: null, count: result.rows[0].n };
    }
    const order = this.ordering.length ? ` order by ${this.ordering.join(",")}` : "";
    const sql = `select ${projection} from ${ident(this.table)}${where}${order}${this.size === undefined ? "" : ` limit ${this.size}`} offset ${this.offset}`;
    const result = await pool.query(
      `with result as (${sql}) select to_jsonb(result) r from result`,
      this.values,
    );
    const data = result.rows.map((row) => row.r);
    return { data: this.one ? (data[0] ?? null) : data, error: null };
  }
}

const org = randomUUID(),
  otherOrg = randomUUID();
const target = randomUUID(),
  neighbor = randomUUID(),
  outsider = randomUUID();
const appointment = randomUUID(),
  neighborAppointment = randomUUID(),
  otherAppointment = randomUUID();
const job = randomUUID(),
  notice = randomUUID();
const secret = "PRIVATE-AUTHORIZATION-MATERIAL";
const request = {
  organizationId: org,
  requestId: randomUUID(),
  contactId: target,
  externalCustomerId: null,
};

beforeAll(async () => {
  vi.mocked(createAdminClient).mockReturnValue({
    from: (table: string) => new ReadQuery(table),
  } as never);
  for (const id of [org, otherOrg])
    await pool.query(
      "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Export','Export')",
      [id],
    );
  for (const [id, tenant] of [
    [target, org],
    [neighbor, org],
    [outsider, otherOrg],
  ])
    await pool.query("insert into contacts(id,organization_id,name) values($1,$2,'Pessoa')", [
      id,
      tenant,
    ]);
  for (const [id, tenant, contact] of [
    [appointment, org, target],
    [neighborAppointment, org, neighbor],
    [otherAppointment, otherOrg, outsider],
  ])
    await pool.query(
      "insert into calendar_appointments(id,organization_id,contact_id,title,starts_at,ends_at,status) values($1,$2,$3,'Consulta',now(),now()+interval '1 hour','completed')",
      [id, tenant, contact],
    );
  for (const [id, tenant, contact, ref] of [
    [job, org, target, appointment],
    [randomUUID(), org, neighbor, neighborAppointment],
    [randomUUID(), otherOrg, outsider, otherAppointment],
  ]) {
    await pool.query(
      "insert into job_queue(id,organization_id,contact_id,kind,payload,last_error,locked_by) values($1,$2,$3,'transactional_delivery',$4,$5,$5)",
      [
        id,
        tenant,
        contact,
        {
          appointment_id: ref,
          service_boundary: { authorization: secret },
          meeting_request_id: secret,
          delivery_generation: secret,
        },
        secret,
      ],
    );
    await pool.query(
      "insert into agent_inbox_items(id,organization_id,kind,ref_kind,ref_id,title,body,status) values($1,$2,'other','appointment',$3,'Entrega da reunião','Link aguardando liberação.','open')",
      [id === job ? notice : randomUUID(), tenant, ref],
    );
  }
  // Referência de outro tenant forjada no aviso e no payload do job não concede escopo.
  await pool.query(
    "insert into agent_inbox_items(organization_id,kind,ref_kind,ref_id,title) values($1,'other','appointment',$2,'AVISO-OUTRA-ORG'),($3,'other','appointment',$4,'AVISO-REF-OUTRA-ORG'),($3,'other','contact',$2,'AVISO-OUTRO-TIPO'),($3,'other',null,null,'AVISO-GLOBAL')",
    [otherOrg, appointment, org, otherAppointment],
  );
  await pool.query(
    "insert into job_queue(organization_id,contact_id,kind,payload) values($1,$2,'transactional_delivery',$3)",
    [org, target, { appointment_id: otherAppointment, authorization: secret }],
  );
});

it("exporta entrega/aviso do titular, exclui outro contato/tenant e material privado", async () => {
  const data = await collectExportData(request);
  expect(data.meeting_deliveries).toHaveLength(2);
  expect(data.meeting_deliveries.find((row) => row.id === job)).toMatchObject({
    appointment_id: appointment,
    status: "pending",
  });
  expect(data.meeting_deliveries.find((row) => row.id !== job)?.appointment_id).toBeNull();
  expect(data.appointment_notices).toEqual([
    expect.objectContaining({
      id: notice,
      ref_id: appointment,
      body: "Link aguardando liberação.",
    }),
  ]);
  const serialized = JSON.stringify(data);
  for (const excluded of [
    neighborAppointment,
    otherAppointment,
    "AVISO-",
    secret,
    "service_boundary",
    "meeting_request_id",
    "delivery_generation",
    "locked_by",
  ])
    expect(serialized).not.toContain(excluded);
  expect(
    queries
      .filter((q) => ["job_queue", "agent_inbox_items"].includes(q.table))
      .every((q) => !q.columns.includes("*") && !q.columns.split(",").includes("payload")),
  ).toBe(true);
  expect(logger.warn).not.toHaveBeenCalled();
});

it("contato da outra organização não dá footprint nem dados das novas tabelas", async () => {
  const data = await collectExportData({ ...request, contactId: outsider });
  expect(data.no_local_footprint).toBe(true);
  expect(data.meeting_deliveries).toEqual([]);
  expect(data.appointment_notices).toEqual([]);
});

it("sem identificador conserva contrato vazio e não visita tabelas pessoais", async () => {
  queries.length = 0;
  const data = await collectExportData({ ...request, contactId: null });
  expect(data.no_local_footprint).toBe(true);
  expect(data.meeting_deliveries).toEqual([]);
  expect(data.appointment_notices).toEqual([]);
  expect(queries.map((q) => q.table)).toEqual(["organizations"]);
});

it("aviso ligado a compromisso fora do recorte de 500 também é exportado", async () => {
  await pool.query(
    "insert into calendar_appointments(organization_id,contact_id,title,starts_at,ends_at,status) select $1,$2,'Consulta anterior',now()-interval '10 days',now()-interval '9 days','completed' from generate_series(1,501)",
    [org, target],
  );
  const old = (
    await pool.query(
      "select id from calendar_appointments where organization_id=$1 and contact_id=$2 order by id desc limit 1",
      [org, target],
    )
  ).rows[0].id;
  await pool.query(
    "update calendar_appointments set starts_at=now()-interval '30 days',ends_at=now()-interval '29 days' where id=$1",
    [old],
  );
  const oldNotice = randomUUID();
  await pool.query(
    "insert into agent_inbox_items(id,organization_id,kind,ref_kind,ref_id,title) values($1,$2,'other','appointment',$3,'Aviso antigo')",
    [oldNotice, org, old],
  );
  const data = await collectExportData(request);
  expect(data.appointments).toHaveLength(500);
  expect(data.appointments.some((row) => row.id === old)).toBe(false);
  expect(data.appointment_notices.some((row) => row.id === oldNotice)).toBe(true);
});

it("baseline completo reaplicado preserva job transactional_delivery e ambas as constraints", async () => {
  const redacted = randomUUID(), oldAppointment = randomUUID();
  const originalDate = "2026-08-01T10:00:00.000Z";
  await pool.query("insert into contacts(id,organization_id,is_anonymized,anonymized_at) values($1,$2,true,$3)", [redacted, org, originalDate]);
  await pool.query("insert into calendar_appointments(id,organization_id,contact_id,title,starts_at,ends_at,status) values($1,$2,$3,'Legado',now(),now()+interval '1 hour','completed')", [oldAppointment, org, redacted]);
  const oldNotices: string[] = [];
  for (const kind of ["other", "appointment_outcome_required", "appointment_recovery_review"]) {
    const id = randomUUID(); oldNotices.push(id);
    await pool.query("insert into agent_inbox_items(id,organization_id,kind,ref_kind,ref_id,title,body) values($1,$2,$3,'appointment',$4,'Legado','RESIDUO-ANTERIOR-0229')", [id, org, kind, oldAppointment]);
  }
  const controls = (await pool.query("select to_jsonb(n) data from agent_inbox_items n where ref_id=any($1::uuid[]) order by id", [[neighborAppointment, otherAppointment]])).rows;
  const before = (await pool.query("select to_jsonb(j) r from job_queue j where id=$1", [job]))
    .rows[0].r;
  const container = process.env.TEST_DB_CONTAINER;
  if (!container) throw Error("rodar via pnpm test:db");
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      "-",
    ],
    {
      input: readFileSync("supabase/baseline.sql"),
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const evidencePath = process.env.MEET_EXPORT_BASELINE_LOG;
  if (evidencePath)
    writeFileSync(evidencePath, `${result.stdout}\n${result.stderr}\nexit=${result.status}`);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const cleaned = (await pool.query("select body,ref_id,status from agent_inbox_items where id=any($1::uuid[])", [oldNotices])).rows;
  expect(cleaned).toHaveLength(3);
  for (const row of cleaned) expect(row).toEqual({ body: "Contato anonimizado.", ref_id: null, status: "resolved" });
  expect((await pool.query("select anonymized_at from contacts where id=$1", [redacted])).rows[0].anonymized_at.toISOString()).toBe(originalDate);
  expect((await pool.query("select to_jsonb(n) data from agent_inbox_items n where ref_id=any($1::uuid[]) order by id", [[neighborAppointment, otherAppointment]])).rows).toEqual(controls);
  expect(
    (await pool.query("select to_jsonb(j) r from job_queue j where id=$1", [job])).rows[0].r,
  ).toEqual(before);
  const definitions = await pool.query(
    "select conname,pg_get_constraintdef(oid) definition from pg_constraint where conrelid='job_queue'::regclass and conname in ('job_queue_kind_check','job_queue_turn_needs_contact')",
  );
  expect(definitions.rows).toHaveLength(2);
  expect(definitions.rows.every((row) => row.definition.includes("transactional_delivery"))).toBe(
    true,
  );
  await expect(
    pool.query("insert into job_queue(organization_id,kind) values($1,'transactional_delivery')", [
      org,
    ]),
  ).rejects.toMatchObject({ code: "23514", constraint: "job_queue_turn_needs_contact" });
  await expect(
    pool.query("insert into job_queue(organization_id,kind) values($1,'made_up_kind')", [org]),
  ).rejects.toMatchObject({ code: "23514", constraint: "job_queue_kind_check" });
});

it("avisos de presença/recuperação e Meet são exportados e redigidos sem recriação tardia", async () => {
  const subject = randomUUID(), sibling = randomUUID(), foreign = randomUUID();
  const rows: Array<{ contact: string; org: string; appointment: string; sentinel: string }> = [];
  for (const [contact, tenant] of [[subject, org], [sibling, org], [foreign, otherOrg]]) {
    const id = randomUUID(), sentinel = `TITULO-PESSOAL-${id}`;
    await pool.query("insert into contacts(id,organization_id,name) values($1,$2,'Titular')", [contact, tenant]);
    await pool.query("insert into calendar_appointments(id,organization_id,contact_id,title,starts_at,ends_at,status) values($1,$2,$3,$4,now()-interval '3 hours',now()-interval '2 hours','confirmed')", [id, tenant, contact, sentinel]);
    for (const kind of ["other", "appointment_recovery_review"])
      await pool.query("insert into agent_inbox_items(organization_id,kind,ref_kind,ref_id,title,body) values($1,$2,'appointment',$3,'Aviso de compromisso',$4)", [tenant, kind, id, sentinel]);
    rows.push({ contact: contact!, org: tenant!, appointment: id, sentinel });
  }
  await pool.query("select fn_appointment_confirmation_sweep(500,now())");
  const subjectRow = rows[0]!;
  const notices = async (row: typeof subjectRow) => (await pool.query("select to_jsonb(n) data from agent_inbox_items n where organization_id=$1 and ref_kind='appointment' and ref_id=$2 order by id", [row.org, row.appointment])).rows.map(r => r.data);
  const before = await notices(subjectRow);
  expect(before.map(n => n.kind).sort()).toEqual(["appointment_outcome_required", "appointment_recovery_review", "other"]);
  expect(before.every(n => n.body.includes(subjectRow.sentinel))).toBe(true);
  const exported = await collectExportData({ ...request, contactId: subject });
  expect(exported.appointment_notices.map(n => n.id).sort()).toEqual(before.map(n => n.id).sort());
  expect(exported.appointment_notices.every(n => n.body?.includes(subjectRow.sentinel))).toBe(true);
  for (const control of rows.slice(1)) expect(JSON.stringify(exported)).not.toContain(control.sentinel);
  const controls = await Promise.all(rows.slice(1).map(notices));
  await pool.query("update contacts set is_anonymized=true,anonymized_at=now() where organization_id=$1 and id=$2", [org, subject]);
  const after = (await pool.query("select to_jsonb(n) data from agent_inbox_items n where id=any($1::uuid[]) order by id", [before.map(n => n.id)])).rows.map(r => r.data);
  expect(after).toHaveLength(3);
  for (const notice of after) expect(notice).toMatchObject({ status: "resolved", ref_id: null, body: "Contato anonimizado." });
  expect(JSON.stringify(after)).not.toContain(subjectRow.sentinel);
  expect(await Promise.all(rows.slice(1).map(notices))).toEqual(controls);
  await pool.query("update calendar_appointments set confirmation_next_at=null where id=$1", [subjectRow.appointment]);
  await pool.query("select fn_appointment_confirmation_sweep(500,now()+interval '3 days')");
  expect(await notices(subjectRow)).toEqual([]);
  const event = randomUUID();
  await pool.query("insert into event_log(id,organization_id,event_type,entity_kind,entity_id,payload) values($1,$2,'appointment.outcome_confirmed','appointment',$3,'{\"appointment_revision\":1}')", [event, org, subjectRow.appointment]);
  const receipt = (await pool.query("select fn_appointment_recover($1,$2) result", [org, event])).rows[0].result;
  expect(receipt).toMatchObject({ appointment_id: subjectRow.appointment, result: "stale" });
  expect(await notices(subjectRow)).toEqual([]);
  expect((await collectExportData({ ...request, contactId: subject })).appointment_notices).toEqual([]);
});
