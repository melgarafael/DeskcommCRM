import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER required; all probes use BEGIN/ROLLBACK, never reset.");
const migration = readFileSync("supabase/migrations/20261106190000_9216_agenda_authority.sql", "utf8");
const org = "af050000-0000-4000-8000-000000000001", other = "af050000-0000-4000-8000-000000000002";
const agent = "af050000-0000-4000-8000-000000000011", viewer = "af050000-0000-4000-8000-000000000012";
const conn = "af050000-0000-4000-8000-000000000021", appointment = "af050000-0000-4000-8000-000000000031", local = "af050000-0000-4000-8000-000000000032";
const fixtures = `
select public.fn_provision_amigo();
insert into public.organizations(id,slug,legal_name,display_name) values ('${org}','task5-probe-a','Task5 A','Task5 A'),('${other}','task5-probe-b','Task5 B','Task5 B');
insert into auth.users(id,email) values ('${agent}','task5-agent@invariant.test'),('${viewer}','task5-viewer@invariant.test');
insert into public.user_organizations(user_id,organization_id,role,accepted_at) values ('${agent}','${org}','agent',now()),('${viewer}','${org}','viewer',now());
insert into public.amigo_connections(id,organization_id,active,token_last4,validated_at,default_place_id,timezone) values ('${conn}','${org}',true,'fake',now(),3,'America/Fortaleza');
insert into public.calendar_appointments(id,organization_id,owner_user_id,title,starts_at,ends_at,status,authority,external_connection_id)
values ('${appointment}','${org}','${agent}','Fictício externo',now()+interval '2 days',now()+interval '2 days 30 minutes','pending','amigo','${conn}'),
('${local}','${org}','${agent}','Fictício local',now()+interval '3 days',now()+interval '3 days 30 minutes','confirmed','local',null);
insert into public.amigo_appointment_links(organization_id,connection_id,attendance_id,patient_id,appointment_id,remote_data) values ('${org}','${conn}',9,4,'${appointment}','{"private":"not exposed"}');
`;
function probe(body: string) {
  return execFileSync("docker", ["exec", "-i", container!, "psql", "-U", "postgres", "-d", "postgres", "-qtA", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    encoding: "utf8", input: `begin;\n${process.env.TASK5_TEST_MIGRATION === "1" ? migration : ""}\n${fixtures}\n${body}\nrollback;`, stdio: ["pipe", "pipe", "pipe"],
  }).trim().split("\n").at(-1);
}
function asUser(user: string, sql: string) { return `set local role authenticated; select set_config('request.jwt.claims','{"sub":"${user}"}',true); ${sql}`; }
function denied(sql: string) { return `do $probe$ begin begin ${sql}; exception when insufficient_privilege then return; end; raise exception 'expected 42501'; end $probe$; select 'ok';`; }

it("Google never reserves an external appointment even if owner and local publication fields are set", () => {
  expect(probe(`select public.fn_google_appointment('${org}','${appointment}','claim')->>'terminal';`)).toBe("external_authority");
});
it("Google candidates exclude Amigo while preserving local history", () => {
  expect(probe(`select count(*)=1 and bool_and(id='${local}') from public.calendar_service_google_candidates where organization_id='${org}';`)).toBe("t");
});
it("Google settlement refuses external authority without changing the appointment", () => {
  expect(probe(`${denied(`perform public.fn_google_appointment('${org}','${appointment}','release')`)} select status='pending' and google_event_id is null from public.calendar_appointments where id='${appointment}';`)).toBe("t");
});
it("an agent can discover active authority through safe metadata despite raw connection RLS", () => {
  expect(probe(asUser(agent, `select (select count(*)=0 from public.amigo_connections where organization_id='${org}') and public.fn_calendar_agenda_provider('${org}') = jsonb_build_object('id','${conn}'::uuid,'active',true,'timezone','America/Fortaleza','default_place_id',3);`))).toBe("t");
});
it("safe metadata is tenant scoped, including viewer reads, and denies anon", () => {
  expect(probe(asUser(viewer, `select public.fn_calendar_agenda_provider('${org}')->>'active';`))).toBe("true");
  expect(probe(asUser(agent, denied(`perform public.fn_calendar_agenda_provider('${other}')`)))).toBe("ok");
  expect(probe(`set local role anon; ${denied(`perform public.fn_calendar_agenda_provider('${org}')`)}`)).toBe("ok");
});
it("appointment target exposes only verified origin IDs to agents, never remote payloads", () => {
  expect(probe(asUser(agent, `select public.fn_calendar_amigo_target('${org}','${appointment}','${conn}')='{"attendance_id":9,"patient_id":4}'::jsonb;`))).toBe("t");
  expect(probe(asUser(agent, `select public.fn_calendar_amigo_target('${org}','${appointment}','${other}') is null;`))).toBe("t");
  expect(probe(asUser(agent, denied(`perform public.fn_calendar_amigo_target('${other}','${appointment}','${conn}')`)))).toBe("ok");
  expect(probe(asUser(viewer, denied(`perform public.fn_calendar_amigo_target('${org}','${appointment}','${conn}')`)))).toBe("ok");
});
it("migration reapplies idempotently and is shipped in the self-host baseline", () => {
  expect(readFileSync("supabase/baseline.sql", "utf8")).toContain(migration);
  expect(probe(`${migration}\n${migration}\nselect 'ok';`)).toBe("ok");
});
