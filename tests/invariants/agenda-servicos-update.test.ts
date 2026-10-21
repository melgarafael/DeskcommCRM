import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, expect, it } from "vitest";

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
afterAll(() => pool.end());

it("reaplicar baseline com turma já reservada não desloca pessoas nem altera a identidade da ocorrência", async () => {
  const org = randomUUID(), owner = randomUUID(), type = randomUUID();
  await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Demonstração fictícia','Demonstração fictícia')", [org]);
  await pool.query("insert into auth.users(id,email) values($1,$2)", [owner, `${owner}@example.test`]);
  await pool.query("insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'manager',now())", [org, owner]);
  await pool.query("insert into calendar_event_types(id,organization_id,name,slug,duration_minutes,minimum_notice_minutes,service_enabled,booking_mode) values($1::uuid,$2,'Turma fictícia',$1::text,40,0,true,'collective_unlimited')", [type, org]);
  await pool.query("insert into calendar_service_schedule(organization_id,event_type_id,weekday,timing_kind,start_minute) values($1,$2,2,'fixed',840)", [org, type]);
  await pool.query("insert into calendar_service_professionals values($1,$2,$3)", [org, type, owner]);
  await pool.query("insert into attendant_availability(organization_id,user_id,is_available,schedule) values($1,$2,true,$3)", [org, owner, { timezone: "America/Sao_Paulo", windows: [{ dow: 2, start: "08:00", end: "18:00" }] }]);
  for (let i = 0; i < 2; i++) {
    const contact = randomUUID();
    await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,$3)", [contact, org, `Pessoa fictícia ${i}`]);
    await pool.query("select fn_calendar_service_book($1,$2,$3)", [org, { type: "user", id: owner }, { event_type_id: type, contact_id: contact, operation_key: randomUUID(), starts_at: em("17:00:00Z") }]);
  }
  const snapshot = async () => (await pool.query("select id,starts_at,ends_at,status,owner_user_id,service_occurrence_id,participant_key,service_operation_key from calendar_appointments where organization_id=$1 order by id", [org])).rows;
  const before = await snapshot();
  expect(before).toHaveLength(2); expect(before[0].service_occurrence_id).toBe(before[1].service_occurrence_id);
  await pool.query(readFileSync("supabase/baseline.sql", "utf8"));
  expect(await snapshot()).toEqual(before);
  await expect(pool.query("insert into calendar_appointments(organization_id,owner_user_id,title,starts_at,ends_at,status) values($1,$2,'Individual fictício',$3,$4,'confirmed')", [org, owner, em("17:00:00Z"), em("17:40:00Z")])).rejects.toMatchObject({ code: "PT409" });
}, 90000);
