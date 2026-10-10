-- 0066 human cases: loop assíncrono IA↔humano (spec 15)
create table if not exists agent_cases (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  lead_id uuid references crm_leads(id) on delete set null,
  agent_id uuid references ai_agents(id) on delete set null,
  status text not null default 'awaiting_human'
    check (status in ('awaiting_human','awaiting_lead','resolved','escalated','cancelled')),
  title text not null,
  summary text not null,
  blocker text not null,
  context_snapshot jsonb not null default '{}'::jsonb,
  source text not null default 'agent' check (source in ('agent','guardrail_autofallback')),
  followup_attempts smallint not null default 0,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists agent_cases_open_idx
  on agent_cases (organization_id, status) where status in ('awaiting_human','awaiting_lead');
create index if not exists agent_cases_lead_idx on agent_cases (organization_id, lead_id);
create index if not exists agent_cases_conv_idx on agent_cases (organization_id, conversation_id);

create table if not exists agent_case_events (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  case_id uuid not null references agent_cases(id) on delete cascade,
  kind text not null check (kind in
    ('opened','human_replied','lead_asked','lead_provided','lead_unresponsive','resolved','escalated','cancelled')),
  actor_kind text not null check (actor_kind in ('agent','human','system','lead')),
  actor_user_id uuid references auth.users(id) on delete set null,
  human_action text check (human_action in ('resolved','need_lead_info','escalate')),
  body text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists agent_case_events_case_idx on agent_case_events (case_id, created_at);

alter table ai_agent_versions add column if not exists cases_enabled boolean not null default false;

-- RLS
alter table agent_cases enable row level security;
alter table agent_case_events enable row level security;
drop policy if exists tenant_isolation_agent_cases_all on agent_cases;
create policy tenant_isolation_agent_cases_all on agent_cases
  for all using (organization_id in (select fn_user_org_ids())) with check (organization_id in (select fn_user_org_ids()));
drop policy if exists tenant_isolation_agent_case_events_select on agent_case_events;
create policy tenant_isolation_agent_case_events_select on agent_case_events
  for select using (organization_id in (select fn_user_org_ids()));
drop policy if exists tenant_isolation_agent_case_events_insert on agent_case_events;
create policy tenant_isolation_agent_case_events_insert on agent_case_events
  for insert with check (organization_id in (select fn_user_org_ids()));

-- estender CHECKs de job_queue (kind + coerência kind⇔contato) p/ case_reply_turn
-- nomes reais conferidos no banco linkado: job_queue_kind_check (named) e
-- job_queue_check (anônimo, gerado pelo Postgres) para o CHECK de coerência.
alter table job_queue drop constraint if exists job_queue_kind_check;
alter table job_queue add constraint job_queue_kind_check
  check (kind in ('inbound_turn','followup_turn','watchdog','flywheel','case_reply_turn'));
alter table job_queue drop constraint if exists job_queue_turn_needs_contact;
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'job_queue'::regclass and contype='c'
     and pg_get_constraintdef(oid) ilike '%contact_id is not null%';
  if c is not null then execute format('alter table job_queue drop constraint %I', c); end if;
end $$;
alter table job_queue add constraint job_queue_turn_needs_contact
  check ((kind in ('inbound_turn','followup_turn','case_reply_turn')) = (contact_id is not null));

alter table cron_jobs drop constraint if exists cron_jobs_job_kind_check;
alter table cron_jobs add constraint cron_jobs_job_kind_check
  check (job_kind in ('inbound_turn','followup_turn','watchdog','flywheel','case_reply_turn'));
