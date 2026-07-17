import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * G1-02 — RLS isolation invariant.
 *
 * Runs against the ephemeral Postgres container started by scripts/test-db.sh
 * (baseline.sql already applied). Seeds 2 orgs + 1 user each, then proves that
 * a user of org A sees ZERO rows of org B in conversations / messages /
 * contacts / crm_leads under RLS, with JWT claims simulated via
 * set_config('request.jwt.claims', ...) — the same auth.uid() /
 * fn_user_org_ids() path production policies use.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — run this suite via `pnpm test:db` (scripts/test-db.sh)",
  );
}
const containerName: string = container;

/** Runs a SQL script in ONE psql session inside the container; returns stdout (tuples-only). */
function sql(script: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      containerName,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-tA",
      "-f",
      "-",
    ],
    { input: script, encoding: "utf8" },
  ).trim();
}

// Fixed UUIDs make the seed idempotent (on conflict do nothing).
const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";
const USER_A = "aaaaaaaa-1111-4000-8000-000000000001";
const USER_B = "bbbbbbbb-1111-4000-8000-000000000002";
const SESS_A = "aaaaaaaa-2222-4000-8000-000000000001";
const SESS_B = "bbbbbbbb-2222-4000-8000-000000000002";

/**
 * Runs SELECTs as the `authenticated` role with the given user's JWT claims,
 * exactly how PostgREST/Supabase set them: session role + request.jwt.claims.
 */
function countAs(userId: string, countQuery: string): number {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${countQuery}
  `);
  // Output lines: set_config echo, then the count (last line).
  const lines = out.split("\n");
  const last = lines[lines.length - 1];
  if (last === undefined || !/^\d+$/.test(last)) {
    throw new Error(`unexpected psql output: ${out}`);
  }
  return Number(last);
}

function seedOrg(org: string, user: string, sess: string, tag: string): string {
  // No real PII: synthetic emails/names only (LGPD).
  return `
    insert into auth.users (id, email) values ('${user}', 'rls-${tag}@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${org}', 'rls-inv-${tag}', 'RLS Invariant ${tag}', 'RLS ${tag}')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${user}', '${org}', 'agent', now())
      on conflict do nothing;
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${sess}', '${org}', 'rls-inv-${tag}', '\\x00'::bytea)
      on conflict (id) do nothing;
  `;
}

beforeAll(() => {
  sql(seedOrg(ORG_A, USER_A, SESS_A, "a") + seedOrg(ORG_B, USER_B, SESS_B, "b"));
  // Contact → conversation → message + pipeline → stage → lead, per org.
  sql(`
    do $seed$
    declare
      v_org uuid;
      v_sess uuid;
      v_contact uuid;
      v_conv uuid;
      v_pipe uuid;
      v_stage uuid;
    begin
      foreach v_org in array array['${ORG_A}'::uuid, '${ORG_B}'::uuid] loop
        select id into v_sess from public.channel_sessions where organization_id = v_org limit 1;

        select id into v_contact from public.contacts
          where organization_id = v_org and display_name = 'RLS Invariant Contact';
        if v_contact is null then
          insert into public.contacts (organization_id, display_name)
            values (v_org, 'RLS Invariant Contact') returning id into v_contact;
        end if;

        select id into v_conv from public.conversations
          where organization_id = v_org and contact_id = v_contact;
        if v_conv is null then
          insert into public.conversations (organization_id, contact_id, channel_session_id)
            values (v_org, v_contact, v_sess) returning id into v_conv;
        end if;

        if not exists (select 1 from public.messages where organization_id = v_org) then
          insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, body)
            values (v_org, v_conv, v_sess, v_contact, 'text', 'inbound', 'rls invariant probe');
        end if;

        select id into v_pipe from public.crm_pipelines
          where organization_id = v_org and slug = 'rls-inv';
        if v_pipe is null then
          insert into public.crm_pipelines (organization_id, name, slug)
            values (v_org, 'RLS Invariant', 'rls-inv') returning id into v_pipe;
        end if;

        select id into v_stage from public.crm_stages
          where organization_id = v_org and pipeline_id = v_pipe and slug = 'novo';
        if v_stage is null then
          insert into public.crm_stages (organization_id, pipeline_id, name, slug, position)
            values (v_org, v_pipe, 'Novo', 'novo', 1000) returning id into v_stage;
        end if;

        if not exists (select 1 from public.crm_leads where organization_id = v_org) then
          insert into public.crm_leads (organization_id, pipeline_id, stage_id, title)
            values (v_org, v_pipe, v_stage, 'RLS invariant lead');
        end if;
      end loop;
    end
    $seed$;
  `);
});

const TABLES = ["conversations", "messages", "contacts", "crm_leads"] as const;

describe("RLS tenant isolation (fn_user_org_ids pattern)", () => {
  for (const table of TABLES) {
    it(`user of org A reads 0 rows of org B in ${table}`, () => {
      const crossTenant = countAs(
        USER_A,
        `select count(*) from public.${table} where organization_id = '${ORG_B}';`,
      );
      expect(crossTenant).toBe(0);
    });

    it(`user of org A still reads their own org rows in ${table} (positive control)`, () => {
      const ownRows = countAs(
        USER_A,
        `select count(*) from public.${table} where organization_id = '${ORG_A}';`,
      );
      expect(ownRows).toBeGreaterThanOrEqual(1);
    });
  }

  it("superuser sees both orgs (seed sanity: cross-tenant rows really exist)", () => {
    const total = Number(
      sql(
        `select count(distinct organization_id) from public.contacts where organization_id in ('${ORG_A}','${ORG_B}');`,
      ),
    );
    expect(total).toBe(2);
  });
});
