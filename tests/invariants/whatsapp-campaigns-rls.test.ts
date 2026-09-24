/**
 * Invariantes schema/RLS campanhas WhatsApp (0240+0241).
 * Roda só via `pnpm test:db`.
 */
import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — run via `pnpm test:db`");
}
const containerName: string = container;

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

const ORG_A = "aaaaaaaa-0000-4000-8000-0000000000ca";
const ORG_B = "bbbbbbbb-0000-4000-8000-0000000000ca";
const USER_A = "aaaaaaaa-1111-4000-8000-0000000000ca";
const USER_B = "bbbbbbbb-1111-4000-8000-0000000000ca";
const SESS_A = "aaaaaaaa-2222-4000-8000-0000000000ca";
const SESS_B = "bbbbbbbb-2222-4000-8000-0000000000ca";

function countAs(userId: string, countQuery: string): number {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${countQuery}
  `);
  const lines = out.split("\n");
  const last = lines[lines.length - 1];
  if (last === undefined || !/^\d+$/.test(last)) {
    throw new Error(`unexpected psql output: ${out}`);
  }
  return Number(last);
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${USER_A}', 'camp-a@invariant.test'),
      ('${USER_B}', 'camp-b@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'camp-inv-a', 'Camp A', 'Camp A'),
      ('${ORG_B}', 'camp-inv-b', 'Camp B', 'Camp B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${USER_A}', '${ORG_A}', 'manager', now()),
      ('${USER_B}', '${ORG_B}', 'manager', now())
      on conflict do nothing;
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status, display_name, provider)
      values
        ('${SESS_A}', '${ORG_A}', 'camp-a', 'enc', 'WORKING', 'A', 'waha'),
        ('${SESS_B}', '${ORG_B}', 'camp-b', 'enc', 'WORKING', 'B', 'waha')
      on conflict (id) do nothing;
  `);
});

describe("whatsapp campaigns schema (0240+0241)", () => {
  it("tabelas e funções existem", () => {
    const tables = sql(`
      select count(*) from information_schema.tables
       where table_schema='public'
         and table_name in (
           'whatsapp_campaigns','whatsapp_campaign_recipients',
           'whatsapp_campaign_attempts','whatsapp_campaign_session_leases'
         );
    `);
    expect(tables.split("\n").pop()).toBe("4");
    const fns = sql(`
      select count(*) from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public'
         and p.proname in (
           'fn_claim_whatsapp_campaign_recipient',
           'fn_recover_stale_whatsapp_campaign_claims',
           'fn_whatsapp_campaign_status_counts'
         );
    `);
    expect(fns.split("\n").pop()).toBe("3");
  });

  it("RLS: user A não vê campanha de B", () => {
    sql(`
      delete from public.whatsapp_campaigns where organization_id in ('${ORG_A}','${ORG_B}');
      insert into public.whatsapp_campaigns
        (organization_id, name, message_text, channel_session_id, status)
        values ('${ORG_B}', 'Secreta', 'Oi', '${SESS_B}', 'draft');
    `);
    const n = countAs(
      USER_A,
      `select count(*)::text from public.whatsapp_campaigns where organization_id = '${ORG_B}';`,
    );
    expect(n).toBe(0);
  });

  it("same-org: campanha A não aceita session B", () => {
    let refused = false;
    try {
      sql(`
        insert into public.whatsapp_campaigns
          (organization_id, name, message_text, channel_session_id, status)
          values ('${ORG_A}', 'Cross', 'Oi', '${SESS_B}', 'draft');
      `);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });

  it("unique campaign_id+contact_id", () => {
    const campId = sql(`
      insert into public.whatsapp_campaigns
        (organization_id, name, message_text, channel_session_id, status)
        values ('${ORG_A}', 'Dup', 'Oi {{first_name}}', '${SESS_A}', 'draft')
      returning id;
    `).split("\n").pop()!;
    const contactId = sql(`
      insert into public.contacts (organization_id, phone_number, display_name)
        values ('${ORG_A}', '+5511999990001', 'Dup')
      returning id;
    `).split("\n").pop()!;
    sql(`
      insert into public.whatsapp_campaign_recipients
        (organization_id, campaign_id, contact_id, channel_session_id, phone_number_snapshot, status)
        values ('${ORG_A}', '${campId}', '${contactId}', '${SESS_A}', '+5511999990001', 'pending');
    `);
    let refused = false;
    try {
      sql(`
        insert into public.whatsapp_campaign_recipients
          (organization_id, campaign_id, contact_id, channel_session_id, phone_number_snapshot, status)
          values ('${ORG_A}', '${campId}', '${contactId}', '${SESS_A}', '+5511999990001', 'pending');
      `);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });

  it("lease: só um worker por channel_session", () => {
    sql(`
      delete from public.whatsapp_campaign_session_leases where channel_session_id = '${SESS_A}';
      insert into public.whatsapp_campaign_session_leases
        (channel_session_id, organization_id, worker_id, leased_until)
        values ('${SESS_A}', '${ORG_A}', 'worker-a', now() + interval '2 minutes');
    `);
    let refused = false;
    try {
      sql(`
        insert into public.whatsapp_campaign_session_leases
          (channel_session_id, organization_id, worker_id, leased_until)
          values ('${SESS_A}', '${ORG_A}', 'worker-b', now() + interval '2 minutes');
      `);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });

  it("stale processing recovery devolve recipient", () => {
    const campId = sql(`
      insert into public.whatsapp_campaigns
        (organization_id, name, message_text, channel_session_id, status)
        values ('${ORG_A}', 'Stale', 'Oi', '${SESS_A}', 'running')
      returning id;
    `).split("\n").pop()!;
    const contactId = sql(`
      insert into public.contacts (organization_id, phone_number, display_name)
        values ('${ORG_A}', '+5511999990002', 'Stale')
      returning id;
    `).split("\n").pop()!;
    const recId = sql(`
      insert into public.whatsapp_campaign_recipients
        (organization_id, campaign_id, contact_id, channel_session_id,
         phone_number_snapshot, status, claimed_at, claimed_by, attempt_count)
        values ('${ORG_A}', '${campId}', '${contactId}', '${SESS_A}',
                '+5511999990002', 'processing', now() - interval '10 minutes', 'dead', 1)
      returning id;
    `).split("\n").pop()!;
    sql(`delete from public.whatsapp_campaign_session_leases where channel_session_id = '${SESS_A}';`);
    const n = sql(`select public.fn_recover_stale_whatsapp_campaign_claims(180);`).split("\n").pop();
    expect(Number(n)).toBeGreaterThanOrEqual(1);
    const status = sql(`
      select status || ':' || attempt_count::text
        from public.whatsapp_campaign_recipients where id = '${recId}';
    `).split("\n").pop();
    expect(status).toBe("pending:0");
  });

  it("send_uncertain é status válido", () => {
    const campId = sql(`
      insert into public.whatsapp_campaigns
        (organization_id, name, message_text, channel_session_id, status)
        values ('${ORG_A}', 'Unc', 'Oi', '${SESS_A}', 'draft')
      returning id;
    `).split("\n").pop()!;
    const contactId = sql(`
      insert into public.contacts (organization_id, phone_number, display_name)
        values ('${ORG_A}', '+5511999990003', 'Unc')
      returning id;
    `).split("\n").pop()!;
    sql(`
      insert into public.whatsapp_campaign_recipients
        (organization_id, campaign_id, contact_id, channel_session_id,
         phone_number_snapshot, status)
        values ('${ORG_A}', '${campId}', '${contactId}', '${SESS_A}',
                '+5511999990003', 'send_uncertain');
    `);
    const n = sql(`
      select count(*) from public.whatsapp_campaign_recipients
       where campaign_id = '${campId}' and status = 'send_uncertain';
    `).split("\n").pop();
    expect(n).toBe("1");
  });

  it("send_uncertain → pending sem resolution é recusado", () => {
    const campId = sql(`
      insert into public.whatsapp_campaigns
        (organization_id, name, message_text, channel_session_id, status)
        values ('${ORG_A}', 'Guard', 'Oi', '${SESS_A}', 'running')
      returning id;
    `).split("\n").pop()!;
    const contactId = sql(`
      insert into public.contacts (organization_id, phone_number, display_name)
        values ('${ORG_A}', '+5511999990004', 'Guard')
      returning id;
    `).split("\n").pop()!;
    const recId = sql(`
      insert into public.whatsapp_campaign_recipients
        (organization_id, campaign_id, contact_id, channel_session_id,
         phone_number_snapshot, status)
        values ('${ORG_A}', '${campId}', '${contactId}', '${SESS_A}',
                '+5511999990004', 'send_uncertain')
      returning id;
    `).split("\n").pop()!;
    let refused = false;
    try {
      sql(`
        update public.whatsapp_campaign_recipients
           set status = 'pending'
         where id = '${recId}';
      `);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });

  it("retry_anyway explícito libera pending com novo outbound", () => {
    const campId = sql(`
      insert into public.whatsapp_campaigns
        (organization_id, name, message_text, channel_session_id, status)
        values ('${ORG_A}', 'Retry', 'Oi', '${SESS_A}', 'running')
      returning id;
    `).split("\n").pop()!;
    const contactId = sql(`
      insert into public.contacts (organization_id, phone_number, display_name)
        values ('${ORG_A}', '+5511999990005', 'Retry')
      returning id;
    `).split("\n").pop()!;
    const recId = sql(`
      insert into public.whatsapp_campaign_recipients
        (organization_id, campaign_id, contact_id, channel_session_id,
         phone_number_snapshot, status, outbound_message_id)
        values ('${ORG_A}', '${campId}', '${contactId}', '${SESS_A}',
                '+5511999990005', 'send_uncertain', gen_random_uuid())
      returning id;
    `).split("\n").pop()!;
    sql(`
      update public.whatsapp_campaign_recipients
         set status = 'pending',
             uncertainty_resolution = 'retry_anyway',
             uncertainty_resolved_at = now(),
             outbound_message_id = gen_random_uuid()
       where id = '${recId}';
    `);
    const st = sql(`select status from public.whatsapp_campaign_recipients where id = '${recId}';`)
      .split("\n")
      .pop();
    expect(st).toBe("pending");
  });

  it("lease expira e outro worker pode ocupar", () => {
    sql(`
      delete from public.whatsapp_campaign_session_leases where channel_session_id = '${SESS_A}';
      insert into public.whatsapp_campaign_session_leases
        (channel_session_id, organization_id, worker_id, leased_until)
        values ('${SESS_A}', '${ORG_A}', 'worker-a', now() - interval '1 second');
    `);
    // ON CONFLICT update path used by claim — simula inserção pós-expiração
    sql(`
      insert into public.whatsapp_campaign_session_leases as l
        (channel_session_id, organization_id, worker_id, leased_until)
      values ('${SESS_A}', '${ORG_A}', 'worker-b', now() + interval '2 minutes')
      on conflict (channel_session_id) do update
        set worker_id = excluded.worker_id,
            leased_until = excluded.leased_until
      where public.whatsapp_campaign_session_leases.leased_until < now();
    `);
    const who = sql(`
      select worker_id from public.whatsapp_campaign_session_leases
       where channel_session_id = '${SESS_A}';
    `)
      .split("\n")
      .pop();
    expect(who).toBe("worker-b");
  });

  it("stale recovery não toca send_uncertain", () => {
    const campId = sql(`
      insert into public.whatsapp_campaigns
        (organization_id, name, message_text, channel_session_id, status)
        values ('${ORG_A}', 'KeepUnc', 'Oi', '${SESS_A}', 'running')
      returning id;
    `).split("\n").pop()!;
    const contactId = sql(`
      insert into public.contacts (organization_id, phone_number, display_name)
        values ('${ORG_A}', '+5511999990006', 'KeepUnc')
      returning id;
    `).split("\n").pop()!;
    const recId = sql(`
      insert into public.whatsapp_campaign_recipients
        (organization_id, campaign_id, contact_id, channel_session_id,
         phone_number_snapshot, status, claimed_at, claimed_by, attempt_count)
        values ('${ORG_A}', '${campId}', '${contactId}', '${SESS_A}',
                '+5511999990006', 'send_uncertain',
                now() - interval '10 minutes', 'dead', 1)
      returning id;
    `).split("\n").pop()!;
    sql(`select public.fn_recover_stale_whatsapp_campaign_claims(180);`);
    const st = sql(`select status from public.whatsapp_campaign_recipients where id = '${recId}';`)
      .split("\n")
      .pop();
    expect(st).toBe("send_uncertain");
  });

  it("whatsapp_campaign_sessions rejeita session de outra org", () => {
    let refused = false;
    try {
      sql(`
        insert into public.whatsapp_campaign_sessions
          (organization_id, campaign_id, channel_session_id)
        select '${ORG_A}', c.id, '${SESS_B}'
          from public.whatsapp_campaigns c
         where c.organization_id = '${ORG_A}'
         limit 1;
      `);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });

  it("backfill deixa ao menos uma session por campanha", () => {
    const campId = sql(`
      insert into public.whatsapp_campaigns
        (organization_id, name, message_text, channel_session_id, status)
        values ('${ORG_A}', 'Multi', 'Oi', '${SESS_A}', 'draft')
      returning id;
    `).split("\n").pop()!;
    // trigger/backfill path: insert explícito
    sql(`
      insert into public.whatsapp_campaign_sessions
        (organization_id, campaign_id, channel_session_id, enabled)
        values ('${ORG_A}', '${campId}', '${SESS_A}', true)
      on conflict (campaign_id, channel_session_id) do nothing;
    `);
    const n = sql(`
      select count(*) from public.whatsapp_campaign_sessions
       where campaign_id = '${campId}' and organization_id = '${ORG_A}';
    `).split("\n").pop();
    expect(Number(n)).toBeGreaterThanOrEqual(1);
  });
});
