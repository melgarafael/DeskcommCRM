-- 0038: webhooks universais + mini motor de regras
-- Spec: docs/superpowers/specs/2026-07-17-webhooks-design.md
-- Idempotente e portável em psql puro (sem BEGIN/COMMIT — o runner envolve).

create table if not exists public.webhook_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  path_token text not null unique,
  secret text,
  kind text not null default 'lead_capture' check (kind in ('lead_capture')),
  default_pipeline_id uuid not null references public.crm_pipelines(id) on delete cascade,
  default_stage_id uuid not null references public.crm_stages(id) on delete cascade,
  field_map jsonb not null default '{}'::jsonb,
  redirect_to text,
  is_active boolean not null default true,
  last_received_at timestamptz,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.automation_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  trigger_event text not null
    check (trigger_event ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  conditions jsonb not null default '[]'::jsonb,
  actions jsonb not null default '[]'::jsonb,
  is_active boolean not null default false,
  last_run_at timestamptz,
  run_count integer not null default 0,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_automation_rules_org_trigger
  on public.automation_rules (organization_id, trigger_event)
  where is_active;

create table if not exists public.automation_rule_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  rule_id uuid not null references public.automation_rules(id) on delete cascade,
  event_id uuid references public.event_log(id) on delete set null,
  status text not null check (status in ('success', 'partial', 'failed')),
  actions_result jsonb not null default '[]'::jsonb,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists idx_automation_rule_runs_org_created
  on public.automation_rule_runs (organization_id, created_at desc);
create index if not exists idx_automation_rule_runs_rule
  on public.automation_rule_runs (rule_id, created_at desc);

alter table public.webhook_sources enable row level security;
alter table public.automation_rules enable row level security;
alter table public.automation_rule_runs enable row level security;

-- Padrão da migration 0030 (config tables): select p/ membro da org ou
-- platform admin; write manager+. Runs: só select (escrita é service_role,
-- que bypassa RLS; authenticated sem policy de write = negado por default).

drop policy if exists "webhook_sources_select" on public.webhook_sources;
drop policy if exists "webhook_sources_manager_write" on public.webhook_sources;

create policy "webhook_sources_select" on public.webhook_sources
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

create policy "webhook_sources_manager_write" on public.webhook_sources
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists "automation_rules_select" on public.automation_rules;
drop policy if exists "automation_rules_manager_write" on public.automation_rules;

create policy "automation_rules_select" on public.automation_rules
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

create policy "automation_rules_manager_write" on public.automation_rules
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists "automation_rule_runs_select" on public.automation_rule_runs;

create policy "automation_rule_runs_select" on public.automation_rule_runs
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );
