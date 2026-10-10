-- 0054 — Sistema de follow-up: fluxos versionados + enrollments (spec 2026-07-21)

create table if not exists followup_flow_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  graph jsonb not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists followup_flow_pointers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  status text not null default 'draft' check (status in ('draft','active','disabled')),
  active_version_id uuid references followup_flow_versions(id),
  draft_graph jsonb,
  handoff_policy text not null default 'pause' check (handoff_policy in ('pause','cancel','allow')),
  trigger_config jsonb not null default '{"kind":"manual"}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

create table if not exists followup_enrollments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  pointer_id uuid not null references followup_flow_pointers(id) on delete cascade,
  version_id uuid not null references followup_flow_versions(id),
  contact_id uuid not null references contacts(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  current_node_id text not null,
  status text not null default 'active'
    check (status in ('active','waiting_reply','paused_handoff','completed','cancelled','dead')),
  next_eval_at timestamptz,
  claimed_until timestamptz,
  attempts smallint not null default 0,
  max_attempts smallint not null default 5,
  last_error text,
  steps_taken smallint not null default 0,
  outcome text check (outcome in ('converted','replied','exhausted','opted_out','handoff')),
  cancel_reason text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  -- estados com relógio TÊM next_eval_at; pausados/terminais NÃO — coerência no schema
  check (
    (status in ('active','waiting_reply') and next_eval_at is not null)
    or (status in ('paused_handoff','completed','cancelled','dead'))
  )
);

create index if not exists idx_followup_enrollments_due
  on followup_enrollments (next_eval_at)
  where status in ('active','waiting_reply');

create unique index if not exists idx_followup_enrollments_one_live
  on followup_enrollments (pointer_id, contact_id)
  where status in ('active','waiting_reply','paused_handoff');

create index if not exists idx_followup_enrollments_contact
  on followup_enrollments (organization_id, contact_id);

create table if not exists followup_enrollment_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  enrollment_id uuid not null references followup_enrollments(id) on delete cascade,
  node_id text,
  event_type text not null,
  payload jsonb not null default '{}',
  idempotency_key text,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_followup_events_idem
  on followup_enrollment_events (enrollment_id, idempotency_key)
  where idempotency_key is not null;

-- RLS (padrão fn_user_org_ids)
alter table followup_flow_versions enable row level security;
alter table followup_flow_pointers enable row level security;
alter table followup_enrollments enable row level security;
alter table followup_enrollment_events enable row level security;

do $$ begin
  create policy tenant_isolation_followup_flow_versions_all on followup_flow_versions
    for all using (organization_id in (select fn_user_org_ids()))
    with check (organization_id in (select fn_user_org_ids()));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy tenant_isolation_followup_flow_pointers_all on followup_flow_pointers
    for all using (organization_id in (select fn_user_org_ids()))
    with check (organization_id in (select fn_user_org_ids()));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy tenant_isolation_followup_enrollments_all on followup_enrollments
    for all using (organization_id in (select fn_user_org_ids()))
    with check (organization_id in (select fn_user_org_ids()));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy tenant_isolation_followup_enrollment_events_all on followup_enrollment_events
    for all using (organization_id in (select fn_user_org_ids()))
    with check (organization_id in (select fn_user_org_ids()));
exception when duplicate_object then null; end $$;

-- Claim atômico do worker (SKIP LOCKED) — service role only
create or replace function fn_claim_due_followup_enrollments(p_limit int, p_lease_seconds int)
returns setof followup_enrollments
language sql
security definer
set search_path = public
as $$
  update followup_enrollments e
  set claimed_until = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  where e.id in (
    select id from followup_enrollments
    where status in ('active','waiting_reply')
      and next_eval_at <= now()
      and (claimed_until is null or claimed_until < now())
    order by next_eval_at
    limit p_limit
    for update skip locked
  )
  returning e.*;
$$;
revoke all on function fn_claim_due_followup_enrollments(int, int) from public, anon, authenticated;
