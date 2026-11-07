import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { expect, it } from "vitest";
const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER required");
const org = "ab070000-0000-4000-8000-000000000001",
  user = "ab070000-0000-4000-8000-000000000002",
  conn = "ab070000-0000-4000-8000-000000000003",
  id = "ab070000-0000-4000-8000-000000000004";
function sql(body: string) {
  const migration = process.env.AMIGO_REVIEW_OLD
    ? ""
    : readFileSync("supabase/migrations/20261107093000_9218_amigo_projection_guards.sql", "utf8") +
      (existsSync("supabase/migrations/20261107094500_9220_amigo_optional_guard.sql")
        ? readFileSync("supabase/migrations/20261107094500_9220_amigo_optional_guard.sql", "utf8")
        : "");
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      container!,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-qtA",
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      "-",
    ],
    {
      encoding: "utf8",
      input: `begin;\n${migration}\nselect public.fn_provision_amigo();\ninsert into public.organizations(id,slug,legal_name,display_name) values('${org}','amigo-review-probe','Fictícia','Fictícia');\ninsert into auth.users(id,email)values('${user}','amigo-review@example.test');\ninsert into public.user_organizations(user_id,organization_id,role,accepted_at)values('${user}','${org}','manager',now());\ninsert into public.amigo_connections(id,organization_id,timezone)values('${conn}','${org}','America/Fortaleza');\ninsert into public.calendar_appointments(id,organization_id,title,starts_at,ends_at,status,authority,external_connection_id)values('${id}','${org}','Fictícia',now()-interval '2 hours',now()-interval '1 hour','confirmed','amigo','${conn}');\n${body}\nrollback;`,
      stdio: ["pipe", "pipe", "pipe"],
    },
  )
    .trim()
    .split("\n")
    .at(-1);
}
it.each(["completed", "no_show"])(
  "sync service role accepts remote %s without human certification",
  (status) => {
    expect(
      sql(
        `set local role service_role;update public.calendar_appointments set status='${status}' where organization_id='${org}' and id='${id}';select status||':'||coalesce(outcome_source_kind,'external') from public.calendar_appointments where id='${id}';`,
      ),
    ).toBe(status + ":external");
  },
);
it.each(["status='cancelled'", "authority='local'"])(
  "authenticated write cannot alter external projection: %s",
  (patch) => {
    expect(
      sql(
        `set local role authenticated;select set_config('request.jwt.claims','{"sub":"${user}","role":"authenticated"}',true);do $b$ begin begin update public.calendar_appointments set ${patch} where id='${id}';exception when insufficient_privilege then return;end;raise exception 'external_write_allowed';end $b$;select 'blocked';`,
      ),
    ).toBe("blocked");
  },
);

it("local booking still works before the optional Amigo tables exist", () => {
  expect(
    sql(
      `alter table public.amigo_connections rename to amigo_connections_probe_backup;set local role authenticated;select set_config('request.jwt.claims','{"sub":"${user}","role":"authenticated"}',true);insert into public.calendar_appointments(organization_id,owner_user_id,title,starts_at,ends_at,status)values('${org}','${user}','Local',now()+interval '1 day',now()+interval '1 day 30 minutes','confirmed');select 'local_ok';`,
    ),
  ).toBe("local_ok");
});
