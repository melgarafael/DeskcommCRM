import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * G4-04 — métricas por responsável (spec 13 §6). Dataset SEED CONHECIDO e
 * agregações assertadas com NÚMEROS EXATOS (não "> 0"), + prova de índice via
 * EXPLAIN sob role agent E manager (RLS ativa muda o plano — spec 13 §6.7).
 *
 * Namespace d4040404… (exclusivo deste arquivo). Sem PII (LGPD): títulos e
 * display_names sintéticos, e-mails @invariant.test. Timestamps LITERAIS fixos
 * (não now()) para agregações determinísticas.
 *
 * fn_attendant_metrics é SECURITY INVOKER ⇒ a RLS de crm_leads (0036) e
 * conversations (0035) escopa por atendente: manager vê org-wide; agent A vê só
 * as PRÓPRIAS (a lista "por atendente" colapsa a 1 linha, a dele).
 */

const ORG = "d4040404-0000-4000-8000-000000000001";
const AGENT_A = "d4040404-1111-4000-8000-000000000001";
const AGENT_B = "d4040404-1111-4000-8000-000000000002";
const MANAGER = "d4040404-1111-4000-8000-000000000003";
const SESSION = "d4040404-2222-4000-8000-000000000001";
const PIPELINE = "d4040404-5555-4000-8000-000000000001";
const STAGE_1 = "d4040404-5555-4000-8000-000000000002";
const STAGE_2 = "d4040404-5555-4000-8000-000000000003";
const C_A1 = "d4040404-3333-4000-8000-000000000001";
const C_A2 = "d4040404-3333-4000-8000-000000000002";
const C_B = "d4040404-3333-4000-8000-000000000003";
const C_A_OLD = "d4040404-3333-4000-8000-000000000004";
const CONV_A1 = "d4040404-4444-4000-8000-000000000001";
const CONV_A2 = "d4040404-4444-4000-8000-000000000002";
const CONV_B = "d4040404-4444-4000-8000-000000000003";
const CONV_A_OLD = "d4040404-4444-4000-8000-000000000004";

// Janela do teste e âncora temporal (tudo dentro dela salvo o marcado "OLD").
const FROM = "2026-07-01T00:00:00+00";
const TO = "2026-07-31T00:00:00+00";
const IN = "2026-07-10T12:00:00+00"; // 1º inbound / closed_at / assigned_at (in-window)
const OLD = "2026-05-01T12:00:00+00"; // fora da janela

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${AGENT_A}', 'm4-agent-a@invariant.test'),
      ('${AGENT_B}', 'm4-agent-b@invariant.test'),
      ('${MANAGER}', 'm4-manager@invariant.test')
    on conflict do nothing;

    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'gov-metrics', 'Gov Metrics Org', 'Gov Metrics')
      on conflict do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${AGENT_A}', '${ORG}', 'agent',   now()),
      ('${AGENT_B}', '${ORG}', 'agent',   now()),
      ('${MANAGER}', '${ORG}', 'manager', now())
    on conflict do nothing;

    do $m4$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSION}', '${ORG}', 'gov-metrics', '\\x00'::bytea);
    exception when unique_violation then null; end $m4$;

    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${PIPELINE}', '${ORG}', 'Gov Metrics', 'gov-metrics') on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${STAGE_1}', '${ORG}', '${PIPELINE}', 'Novo',    'novo',    1000),
      ('${STAGE_2}', '${ORG}', '${PIPELINE}', 'Fechado', 'fechado', 2000)
    on conflict do nothing;

    insert into public.contacts (id, organization_id, display_name) values
      ('${C_A1}',    '${ORG}', 'M4 Contato A1'),
      ('${C_A2}',    '${ORG}', 'M4 Contato A2'),
      ('${C_B}',     '${ORG}', 'M4 Contato B'),
      ('${C_A_OLD}', '${ORG}', 'M4 Contato A old')
    on conflict do nothing;

    -- LEADS won/lost (janela = closed_at). owner A: 3 won + 1 lost in-window,
    -- + 1 won OUT-of-window (não conta). owner B: 1 won + 2 lost in-window.
    -- + opens (funil, status='open', sem closed_at): A=2 (STAGE_1), B=1 (STAGE_2).
    insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, status, owner_user_id, closed_at, lost_reason)
      select '${ORG}', '${PIPELINE}', '${STAGE_1}', 'A won '||g, 'won', '${AGENT_A}', '${IN}', null from generate_series(1,3) g;
    insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, status, owner_user_id, closed_at, lost_reason)
      values ('${ORG}', '${PIPELINE}', '${STAGE_1}', 'A lost', 'lost', '${AGENT_A}', '${IN}', 'price');
    insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, status, owner_user_id, closed_at, lost_reason)
      values ('${ORG}', '${PIPELINE}', '${STAGE_1}', 'A won OLD', 'won', '${AGENT_A}', '${OLD}', null);
    insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, status, owner_user_id, closed_at, lost_reason)
      values ('${ORG}', '${PIPELINE}', '${STAGE_2}', 'B won', 'won', '${AGENT_B}', '${IN}', null);
    insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, status, owner_user_id, closed_at, lost_reason)
      select '${ORG}', '${PIPELINE}', '${STAGE_2}', 'B lost '||g, 'lost', '${AGENT_B}', '${IN}', 'no_response' from generate_series(1,2) g;
    insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, status, owner_user_id)
      select '${ORG}', '${PIPELINE}', '${STAGE_1}', 'A open '||g, 'open', '${AGENT_A}' from generate_series(1,2) g;
    insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, status, owner_user_id)
      values ('${ORG}', '${PIPELINE}', '${STAGE_2}', 'B open', 'open', '${AGENT_B}');

    -- CONVERSAS (janela = assigned_at). A: 2 in-window + 1 OLD (não conta). B: 1.
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assigned_at, assignee_kind) values
      ('${CONV_A1}',    '${ORG}', '${C_A1}',    '${SESSION}', 'claimed', '${AGENT_A}', '${IN}',  'user'),
      ('${CONV_A2}',    '${ORG}', '${C_A2}',    '${SESSION}', 'claimed', '${AGENT_A}', '${IN}',  'user'),
      ('${CONV_B}',     '${ORG}', '${C_B}',     '${SESSION}', 'claimed', '${AGENT_B}', '${IN}',  'user'),
      ('${CONV_A_OLD}', '${ORG}', '${C_A_OLD}', '${SESSION}', 'claimed', '${AGENT_A}', '${OLD}', 'user')
    on conflict do nothing;

    -- MENSAGENS (TTFR). Cada conv: inbound + resposta humana. CONV_A1 tem também
    -- uma resposta do BOT (sent_via='ai', sent_by_user_id NULL) ANTES da humana —
    -- NÃO deve contar. TTFR: A1=60s, A2=120s ⇒ média A=90s. B=30s.
    insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, sent_via, sent_by_user_id, sent_at) values
      -- CONV_A1
      ('${ORG}', '${CONV_A1}', '${SESSION}', '${C_A1}', 'text', 'inbound',  'crm', null,          '${IN}'),
      ('${ORG}', '${CONV_A1}', '${SESSION}', '${C_A1}', 'text', 'outbound', 'ai',  null,          '2026-07-10T12:00:10+00'),
      ('${ORG}', '${CONV_A1}', '${SESSION}', '${C_A1}', 'text', 'outbound', 'user','${AGENT_A}',  '2026-07-10T12:01:00+00'),
      -- CONV_A2
      ('${ORG}', '${CONV_A2}', '${SESSION}', '${C_A2}', 'text', 'inbound',  'crm', null,          '${IN}'),
      ('${ORG}', '${CONV_A2}', '${SESSION}', '${C_A2}', 'text', 'outbound', 'user','${AGENT_A}',  '2026-07-10T12:02:00+00'),
      -- CONV_B
      ('${ORG}', '${CONV_B}',  '${SESSION}', '${C_B}',  'text', 'inbound',  'crm', null,          '${IN}'),
      ('${ORG}', '${CONV_B}',  '${SESSION}', '${C_B}',  'text', 'outbound', 'user','${AGENT_B}',  '2026-07-10T12:00:30+00');
  `);
});

// Set the JWT claims SILENTLY (a `select set_config(...)` emits a line that
// pollutes an empty result set — a DO block produces no output).
function asRole(actorId: string): string {
  return `set role authenticated;
    do $c$ begin perform set_config('request.jwt.claims', '{"sub":"${actorId}"}', false); end $c$;`;
}

/** attendant row [won,lost,conv,avg] for a user under a role; [] if RLS hides it.
 *  Sentinel 'ROW:' + scalar subquery ⇒ SEMPRE 1 tupla (o `set role`/`do` emitem
 *  tags SET/DO no stdout; sem sentinela um resultado vazio se confundiria com elas). */
function metricRow(actorId: string, targetUserId: string, owner?: string): string[] {
  const p_owner = owner ? `'${owner}'::uuid` : "null";
  const out = sql(`
    ${asRole(actorId)}
    select 'ROW:' || coalesce((
      select concat_ws('|', a->>'won', a->>'lost', a->>'conversations_handled',
        coalesce(round((a->>'avg_first_response_seconds')::numeric)::text, ''))
      from jsonb_array_elements(
        public.fn_attendant_metrics('${ORG}', '${FROM}', '${TO}', ${p_owner}) -> 'attendants'
      ) a
      where a->>'user_id' = '${targetUserId}'
    ), '');
  `);
  const data = out.split("\n").pop()!.replace(/^ROW:/, "");
  return data === "" ? [] : data.split("|");
}

/** funnel count for a stage, under a given role. */
function funnelCount(actorId: string, stageId: string): number {
  const out = sql(`
    ${asRole(actorId)}
    select coalesce((f->>'count')::int, -1)
    from jsonb_array_elements(
      public.fn_attendant_metrics('${ORG}', '${FROM}', '${TO}', null) -> 'funnel'
    ) f
    where f->>'stage_id' = '${stageId}';
  `);
  return Number(out.split("\n").pop());
}

/** EXPLAIN plan text under a role, seqscan disabled to expose index applicability. */
function explainAs(actorId: string, query: string): string {
  return sql(`
    ${asRole(actorId)}
    set enable_seqscan = off;
    explain (analyze, format text) ${query}
  `);
}

const Q_WON_LOST = `
  select owner_user_id,
    count(*) filter (where status='won') w, count(*) filter (where status='lost') l
  from public.crm_leads
  where organization_id='${ORG}' and status in ('won','lost')
    and closed_at >= '${IN}' and closed_at < '${TO}' and owner_user_id is not null
  group by owner_user_id`;
const Q_CONV = `
  select assigned_to_user_id, count(*)
  from public.conversations
  where organization_id='${ORG}' and assigned_to_user_id is not null
    and assigned_at >= '${IN}' and assigned_at < '${TO}'
  group by assigned_to_user_id`;
const Q_TTFR = `
  select c.assigned_to_user_id,
    avg(extract(epoch from (fr.first_human_out - fr.first_in)))
  from public.conversations c
  cross join lateral (
    select min(m.sent_at) filter (where m.direction='inbound') as first_in,
           min(m.sent_at) filter (where m.direction='outbound' and m.sent_by_user_id is not null) as first_human_out
    from public.messages m where m.conversation_id = c.id
  ) fr
  where c.organization_id='${ORG}' and c.assigned_to_user_id is not null
    and fr.first_in is not null and fr.first_human_out is not null
    and fr.first_human_out > fr.first_in
  group by c.assigned_to_user_id`;

describe("G4-04 — métricas por responsável (números exatos)", () => {
  // ---- manager: org-wide, números exatos por atendente ----
  it("manager: agent A = 3 won, 1 lost, 2 conversas, TTFR médio 90s", () => {
    expect(metricRow(MANAGER, AGENT_A)).toEqual(["3", "1", "2", "90"]);
  });

  it("manager: agent B = 1 won, 2 lost, 1 conversa, TTFR médio 30s", () => {
    expect(metricRow(MANAGER, AGENT_B)).toEqual(["1", "2", "1", "30"]);
  });

  it("manager: won OLD (closed_at fora da janela) NÃO conta (A won = 3, não 4)", () => {
    expect(metricRow(MANAGER, AGENT_A)[0]).toBe("3");
  });

  it("manager: conversa OLD (assigned_at fora da janela) NÃO conta (A = 2, não 3)", () => {
    expect(metricRow(MANAGER, AGENT_A)[2]).toBe("2");
  });

  it("manager: filtro owner=A retorna só A (B ausente)", () => {
    expect(metricRow(MANAGER, AGENT_A, AGENT_A)).toEqual(["3", "1", "2", "90"]);
    expect(metricRow(MANAGER, AGENT_B, AGENT_A)).toEqual([]);
  });

  // ---- agent A: RLS own-scope — vê só a si mesmo ----
  it("agent A: vê os PRÓPRIOS números (own-scope RLS) = 3/1/2/90", () => {
    expect(metricRow(AGENT_A, AGENT_A)).toEqual(["3", "1", "2", "90"]);
  });

  it("agent A: NÃO vê o agent B (RLS colapsa a lista a 1 linha)", () => {
    expect(metricRow(AGENT_A, AGENT_B)).toEqual([]);
  });

  // ---- funil por stage ----
  it("manager: funil STAGE_1=2 opens (A), STAGE_2=1 open (B)", () => {
    expect(funnelCount(MANAGER, STAGE_1)).toBe(2);
    expect(funnelCount(MANAGER, STAGE_2)).toBe(1);
  });

  it("agent A: funil STAGE_1=2 (próprios), STAGE_2=0 (open de B invisível)", () => {
    expect(funnelCount(AGENT_A, STAGE_1)).toBe(2);
    expect(funnelCount(AGENT_A, STAGE_2)).toBe(0);
  });

  // ---- índice / EXPLAIN sob role (RLS ativa) — spec 13 §6.7, acceptance 3 ----
  const BIG = /Seq Scan on (public\.)?(crm_leads|conversations|messages)\b/;

  it("EXPLAIN won/lost usa índice sob agent E manager (sem seq scan em tabela grande)", () => {
    for (const actor of [AGENT_A, MANAGER]) {
      const plan = explainAs(actor, Q_WON_LOST);
      expect(plan).toMatch(/idx_crm_leads_org_status_closed_owner/);
      expect(plan).not.toMatch(BIG);
    }
  });

  it("EXPLAIN conversas atendidas usa índice sob agent E manager (sem seq scan)", () => {
    for (const actor of [AGENT_A, MANAGER]) {
      const plan = explainAs(actor, Q_CONV);
      expect(plan).toMatch(/idx_conversations_org_assignee_assigned/);
      expect(plan).not.toMatch(BIG);
    }
  });

  it("EXPLAIN TTFR usa índices de conversas+mensagens sob agent E manager (sem seq scan)", () => {
    for (const actor of [AGENT_A, MANAGER]) {
      const plan = explainAs(actor, Q_TTFR);
      expect(plan).toMatch(/idx_messages_conversation_sent/);
      expect(plan).not.toMatch(BIG);
    }
  });
});
