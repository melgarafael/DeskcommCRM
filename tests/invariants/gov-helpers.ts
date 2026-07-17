import { execFileSync } from "node:child_process";

/**
 * G1-03 — shared harness for the governance invariants (gov-*.test.ts).
 *
 * Same docker-exec-psql pattern as rls-isolation.test.ts (G1-02): the suite
 * runs against the ephemeral Postgres started by scripts/test-db.sh
 * (baseline.sql applied), with JWT claims simulated via
 * set_config('request.jwt.claims', ...) — the exact auth.uid() path the
 * production RLS policies use. No real PII anywhere (LGPD): synthetic
 * @invariant.test emails only.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — run this suite via `pnpm test:invariants` (scripts/test-db.sh)",
  );
}
const containerName: string = container;

/** Runs a SQL script in ONE psql session inside the container; returns stdout (tuples-only). */
export function sql(script: string): string {
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

/** Last stdout line of a script (psql -tA prints one line per SELECT). */
export function lastLine(out: string): string {
  const lines = out.split("\n");
  const last = lines[lines.length - 1];
  if (last === undefined) throw new Error(`empty psql output`);
  return last;
}

/**
 * Runs a SELECT count as the `authenticated` role with the given user's JWT
 * claims — same shape PostgREST/Supabase uses (session role + request.jwt.claims).
 */
export function countAs(userId: string, countQuery: string): number {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${countQuery}
  `);
  const last = lastLine(out);
  if (!/^\d+$/.test(last)) throw new Error(`unexpected psql output: ${out}`);
  return Number(last);
}

/**
 * Runs a DML (no trailing `;`, no RETURNING — the helper appends `returning 1`)
 * as the `authenticated` role with the user's claims; returns affected rows.
 * An RLS denial (42501 / with-check violation) counts as 0 rows — the write
 * was blocked, which is exactly what the invariant measures. Any other error
 * rethrows.
 */
export function writeCountAs(userId: string, dml: string): number {
  try {
    const out = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
      with w as (${dml} returning 1) select count(*) from w;
    `);
    const last = lastLine(out);
    if (!/^\d+$/.test(last)) throw new Error(`unexpected psql output: ${out}`);
    return Number(last);
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    if (stderr.includes("row-level security")) return 0;
    throw err;
  }
}

export function tableExists(table: string): boolean {
  return (
    sql(
      `select exists(select 1 from information_schema.tables where table_schema = 'public' and table_name = '${table}');`,
    ) === "t"
  );
}

export function columnExists(table: string, column: string): boolean {
  return (
    sql(
      `select exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = '${table}' and column_name = '${column}');`,
    ) === "t"
  );
}

export function indexExists(index: string): boolean {
  return (
    sql(
      `select exists(select 1 from pg_indexes where schemaname = 'public' and indexname = '${index}');`,
    ) === "t"
  );
}

// Fixed UUIDs (cccccccc- namespace; rls-isolation uses aaaa/bbbb) make the
// seed idempotent AND race-safe across parallel test files (on conflict do nothing).
export const GOV_ORG = "cccccccc-0000-4000-8000-000000000001";
export const GOV_VIEWER = "cccccccc-1111-4000-8000-000000000001";
export const GOV_AGENT_A = "cccccccc-1111-4000-8000-000000000002";
export const GOV_AGENT_B = "cccccccc-1111-4000-8000-000000000003";
export const GOV_MANAGER = "cccccccc-1111-4000-8000-000000000004";
export const GOV_ADMIN = "cccccccc-1111-4000-8000-000000000005";
export const GOV_SESSION = "cccccccc-2222-4000-8000-000000000001";
// One contact per conversation: uniq_conversations_1to1_per_contact_session
// (migration 0027) allows only ONE 1:1 conversation per (org, contact, session).
export const GOV_CONTACT_1 = "cccccccc-3333-4000-8000-000000000001";
export const GOV_CONTACT_2 = "cccccccc-3333-4000-8000-000000000002";
export const GOV_CONTACT_3 = "cccccccc-3333-4000-8000-000000000003";
/** Contact WITHOUT any conversation — reserved for write-probe inserts. */
export const GOV_CONTACT_PROBE = "cccccccc-3333-4000-8000-000000000004";
/** Unassigned open conversation (read-scope probes). */
export const GOV_CONV_UNASSIGNED = "cccccccc-4444-4000-8000-000000000001";
/** Conversation assigned to GOV_AGENT_B (visibility-scope probes). */
export const GOV_CONV_AGENT_B = "cccccccc-4444-4000-8000-000000000002";
/** Unassigned conversation reserved for the atomic-claim invariant. */
export const GOV_CONV_CLAIM = "cccccccc-4444-4000-8000-000000000003";
export const GOV_PIPELINE = "cccccccc-5555-4000-8000-000000000001";
export const GOV_STAGE = "cccccccc-5555-4000-8000-000000000002";
export const GOV_LEAD = "cccccccc-6666-4000-8000-000000000001";

const ROLE_USERS: ReadonlyArray<readonly [string, string, string]> = [
  [GOV_VIEWER, "viewer", "gov-viewer"],
  [GOV_AGENT_A, "agent", "gov-agent-a"],
  [GOV_AGENT_B, "agent", "gov-agent-b"],
  [GOV_MANAGER, "manager", "gov-manager"],
  [GOV_ADMIN, "admin", "gov-admin"],
];

/** Idempotent seed: 1 org, 5 members (1 per role + 2nd agent), 3 conversations, 1 lead. */
export function seedGov(): void {
  const users = ROLE_USERS.map(
    ([id, , tag]) =>
      `insert into auth.users (id, email) values ('${id}', '${tag}@invariant.test') on conflict do nothing;`,
  ).join("\n");
  const memberships = ROLE_USERS.map(
    ([id, role]) =>
      `insert into public.user_organizations (user_id, organization_id, role, accepted_at)
         values ('${id}', '${GOV_ORG}', '${role}', now()) on conflict do nothing;`,
  ).join("\n");

  sql(`
    ${users}
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${GOV_ORG}', 'gov-inv', 'Gov Invariant Org', 'Gov Inv')
      on conflict do nothing;
    ${memberships}
    -- DO + exception (não ON CONFLICT): channel_sessions tem unique DEFERRABLE
    -- (phone_per_org), que ON CONFLICT sem arbiter rejeita, e o arbiter (id)
    -- não cobre a corrida no unique de waha_session_name entre arquivos paralelos.
    do $gov$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${GOV_SESSION}', '${GOV_ORG}', 'gov-inv', '\\x00'::bytea);
    exception when unique_violation then null; end $gov$;
    insert into public.contacts (id, organization_id, display_name)
      values
        ('${GOV_CONTACT_1}', '${GOV_ORG}', 'Gov Invariant Contact 1'),
        ('${GOV_CONTACT_2}', '${GOV_ORG}', 'Gov Invariant Contact 2'),
        ('${GOV_CONTACT_3}', '${GOV_ORG}', 'Gov Invariant Contact 3'),
        ('${GOV_CONTACT_PROBE}', '${GOV_ORG}', 'Gov Invariant Contact Probe')
      on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${GOV_CONV_UNASSIGNED}', '${GOV_ORG}', '${GOV_CONTACT_1}', '${GOV_SESSION}', 'open')
      on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assigned_at)
      values ('${GOV_CONV_AGENT_B}', '${GOV_ORG}', '${GOV_CONTACT_2}', '${GOV_SESSION}', 'claimed', '${GOV_AGENT_B}', now())
      on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${GOV_CONV_CLAIM}', '${GOV_ORG}', '${GOV_CONTACT_3}', '${GOV_SESSION}', 'open')
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${GOV_PIPELINE}', '${GOV_ORG}', 'Gov Invariant', 'gov-inv')
      on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${GOV_STAGE}', '${GOV_ORG}', '${GOV_PIPELINE}', 'Novo', 'novo', 1000)
      on conflict do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title)
      values ('${GOV_LEAD}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Gov invariant lead')
      on conflict do nothing;
  `);
}
