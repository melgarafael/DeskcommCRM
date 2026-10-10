-- 0023_ai_agents_module
-- EPIC-13 wave 1 (S-13.01): foundation schema for the configurable AI Agents module.
-- Source of truth: docs/specs/10-spec-ai-agents-runtime.md §3.1 a §3.5 + §2.2 (seed).
-- Idempotent — safe to re-apply.

-- =============================================================================
-- 3.0 — fn_audit_log_row (canonical, inlined for fresh-build idempotency)
-- =============================================================================
-- This helper was originally created on remote alongside the 0005 stub via
-- Supabase MCP but was never materialized in any local migration file. A fresh
-- `supabase db push` against an empty database fails because the audit triggers
-- below bind to an undefined function. Inlining with `create or replace` is
-- idempotent and matches the canonical body extracted from the linked project.

create or replace function public.fn_audit_log_row()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_action text;
  v_org    uuid;
begin
  if tg_op = 'INSERT' then
    v_action := tg_table_name || '.created';
    v_org    := new.organization_id;
  elsif tg_op = 'UPDATE' then
    v_action := tg_table_name || '.updated';
    v_org    := new.organization_id;
  elsif tg_op = 'DELETE' then
    v_action := tg_table_name || '.deleted';
    v_org    := old.organization_id;
  end if;

  insert into public.api_audit_log (organization_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_org,
    auth.uid(),
    v_action,
    tg_table_name,
    coalesce(new.id, old.id),
    case when tg_op = 'UPDATE'
      then jsonb_build_object('changed_fields', '[diff suppressed in v0.1]')
      else '{}'::jsonb
    end
  );

  return coalesce(new, old);
end$$;

-- =============================================================================
-- 3.1 — Estende public.ai_agents (existing, criada em 0005)
-- =============================================================================

alter table public.ai_agents
  add column if not exists published_version_id uuid,
  add column if not exists priority integer not null default 0,
  add column if not exists archived_at timestamptz,
  add column if not exists kind text not null default 'rag_bot';

-- check constraint em coluna pré-existente — adiciona apenas se faltar
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'ai_agents_kind_check'
      and conrelid = 'public.ai_agents'::regclass
  ) then
    alter table public.ai_agents
      add constraint ai_agents_kind_check
      check (kind in ('rag_bot', 'mcp_agent'));
  end if;
end$$;

-- Backfill: agentes existentes herdam kind='rag_bot' (default já cobre, mas garante NULLs legados).
update public.ai_agents
   set kind = 'rag_bot'
 where kind is null;

create index if not exists ai_agents_published_idx
  on public.ai_agents (organization_id, priority desc)
  where published_version_id is not null and archived_at is null;

-- =============================================================================
-- 3.3 — ai_provider_credentials (criada antes de ai_agent_versions por causa da FK)
-- =============================================================================

create table if not exists public.ai_provider_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  provider text not null check (provider in ('anthropic', 'openai', 'google')),
  label text not null,

  -- API key cifrada (AES-GCM, key em KMS/Vercel secret)
  api_key_encrypted bytea not null,
  api_key_iv bytea not null,
  api_key_tag bytea not null,
  api_key_last4 text not null,

  validated_at timestamptz,
  validation_error text,
  models_available text[],

  is_active boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ai_provider_credentials_unique unique (organization_id, provider, label)
);

create index if not exists ai_provider_credentials_org_provider_idx
  on public.ai_provider_credentials (organization_id, provider)
  where is_active;

alter table public.ai_provider_credentials enable row level security;

drop policy if exists tenant_isolation_ai_provider_credentials_select on public.ai_provider_credentials;
create policy tenant_isolation_ai_provider_credentials_select on public.ai_provider_credentials
  for select
  using (organization_id in (select * from public.fn_user_org_ids()));

drop policy if exists tenant_isolation_ai_provider_credentials_modify on public.ai_provider_credentials;
create policy tenant_isolation_ai_provider_credentials_modify on public.ai_provider_credentials
  for all
  using (organization_id in (select * from public.fn_user_org_ids()))
  with check (organization_id in (select * from public.fn_user_org_ids()));

revoke all on public.ai_provider_credentials from anon;

-- View segura: SELECT sem campos cifrados. security_invoker garante que RLS da tabela base se aplica.
drop view if exists public.ai_provider_credentials_safe;
create view public.ai_provider_credentials_safe
  with (security_invoker = true)
  as
  select id, organization_id, provider, label, api_key_last4,
         validated_at, validation_error, models_available, is_active,
         created_by, created_at, updated_at
  from public.ai_provider_credentials;

revoke all on public.ai_provider_credentials_safe from anon;
grant select on public.ai_provider_credentials_safe to authenticated;

drop trigger if exists trg_ai_provider_credentials_audit on public.ai_provider_credentials;
create trigger trg_ai_provider_credentials_audit
  after insert or update or delete on public.ai_provider_credentials
  for each row execute function public.fn_audit_log_row();

-- =============================================================================
-- 3.2 — ai_agent_versions
-- =============================================================================

create table if not exists public.ai_agent_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_id uuid not null references public.ai_agents(id) on delete cascade,
  version_number integer not null,

  system_prompt text not null,
  provider text not null check (provider in ('anthropic', 'openai', 'google')),
  model text not null,
  credential_id uuid references public.ai_provider_credentials(id) on delete restrict,

  tool_ids text[] not null default '{}',

  trigger_config jsonb not null default jsonb_build_object(
    'events', jsonb_build_array('message'),
    'filters', jsonb_build_object(
      'ignore_groups', true,
      'ignore_self', true,
      'keyword_regex', null,
      'business_hours', null
    ),
    'concurrency', 'one_per_conversation'
  ),

  channel_session_id uuid not null references public.channel_sessions(id) on delete restrict,

  max_steps integer not null default 10 check (max_steps between 1 and 25),
  token_budget integer not null default 50000 check (token_budget between 1000 and 500000),
  cost_budget_cents integer not null default 50 check (cost_budget_cents between 1 and 10000),
  history_message_window integer not null default 20,
  history_token_window integer not null default 8000,

  handoff_keywords text[] not null default array['falar com humano', 'atendente', 'pessoa real'],
  handoff_tool_enabled boolean not null default true,

  status text not null default 'draft' check (status in ('draft', 'published', 'superseded', 'archived')),
  published_at timestamptz,
  superseded_at timestamptz,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),

  constraint ai_agent_versions_unique_number unique (agent_id, version_number)
);

create index if not exists ai_agent_versions_agent_idx
  on public.ai_agent_versions (agent_id, version_number desc);

alter table public.ai_agent_versions enable row level security;

drop policy if exists tenant_isolation_ai_agent_versions_all on public.ai_agent_versions;
create policy tenant_isolation_ai_agent_versions_all on public.ai_agent_versions
  for all
  using (organization_id in (select * from public.fn_user_org_ids()))
  with check (organization_id in (select * from public.fn_user_org_ids()));

revoke all on public.ai_agent_versions from anon;

drop trigger if exists trg_ai_agent_versions_audit on public.ai_agent_versions;
create trigger trg_ai_agent_versions_audit
  after insert or update or delete on public.ai_agent_versions
  for each row execute function public.fn_audit_log_row();

-- FK ai_agents.published_version_id → ai_agent_versions.id (criada agora que a tabela existe).
-- Set null on delete preserva o agent quando a versão for arquivada manualmente via DBA.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'ai_agents_published_version_id_fkey'
      and conrelid = 'public.ai_agents'::regclass
  ) then
    alter table public.ai_agents
      add constraint ai_agents_published_version_id_fkey
      foreign key (published_version_id)
      references public.ai_agent_versions(id)
      on delete set null;
  end if;
end$$;

-- =============================================================================
-- 3.4 — ai_agent_runs
-- =============================================================================

create table if not exists public.ai_agent_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_id uuid not null references public.ai_agents(id) on delete restrict,
  agent_version_id uuid not null references public.ai_agent_versions(id) on delete restrict,

  conversation_id uuid references public.conversations(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  channel_session_id uuid references public.channel_sessions(id) on delete set null,
  inbound_message_id uuid references public.messages(id) on delete set null,
  outbound_message_id uuid references public.messages(id) on delete set null,

  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed', 'aborted', 'handoff')),
  abort_reason text,
  error_code text,
  error_message text,

  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  cost_cents numeric(10, 4) not null default 0,
  latency_ms integer,
  steps_count integer not null default 0,

  tool_calls jsonb not null default '[]'::jsonb,

  is_dry_run boolean not null default false,

  started_at timestamptz not null default now(),
  completed_at timestamptz,

  created_at timestamptz not null default now()
);

-- Concurrency guard: 1 run "running" por conversation (anti-double-reply).
-- Dry-runs bypassam o guard (múltiplos test runs OK).
create unique index if not exists ai_agent_runs_one_running_per_conv
  on public.ai_agent_runs (conversation_id)
  where status = 'running' and is_dry_run = false;

create index if not exists ai_agent_runs_org_started_idx
  on public.ai_agent_runs (organization_id, started_at desc);

create index if not exists ai_agent_runs_agent_idx
  on public.ai_agent_runs (agent_id, started_at desc);

create index if not exists ai_agent_runs_status_idx
  on public.ai_agent_runs (status, started_at)
  where status in ('pending', 'running');

alter table public.ai_agent_runs enable row level security;

drop policy if exists tenant_isolation_ai_agent_runs_all on public.ai_agent_runs;
create policy tenant_isolation_ai_agent_runs_all on public.ai_agent_runs
  for all
  using (organization_id in (select * from public.fn_user_org_ids()))
  with check (organization_id in (select * from public.fn_user_org_ids()));

revoke all on public.ai_agent_runs from anon;

drop trigger if exists trg_ai_agent_runs_audit on public.ai_agent_runs;
create trigger trg_ai_agent_runs_audit
  after insert or update or delete on public.ai_agent_runs
  for each row execute function public.fn_audit_log_row();

-- =============================================================================
-- 3.5 — ai_models (catálogo curado, GLOBAL — não tenant-aware)
-- =============================================================================

create table if not exists public.ai_models (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('anthropic', 'openai', 'google')),
  model_id text not null,
  display_name text not null,
  description text,
  context_window integer,
  input_price_per_million_cents integer,
  output_price_per_million_cents integer,
  supports_tools boolean not null default true,
  is_default_for_provider boolean not null default false,
  deprecated_at timestamptz,
  released_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,

  constraint ai_models_unique unique (provider, model_id)
);

alter table public.ai_models enable row level security;

drop policy if exists ai_models_read_all on public.ai_models;
create policy ai_models_read_all on public.ai_models for select using (true);
-- Sem policy de write — apenas service role/migration escreve.

create unique index if not exists ai_models_one_default_per_provider
  on public.ai_models (provider) where is_default_for_provider;

-- Seed Spec 10 §2.2 — 8 modelos curados.
-- claude-sonnet-4-6 default da Anthropic; gpt-5-mini default OpenAI; gemini-2.5-flash default Google
-- (escolha pragmática: atendimento prefere fast/cheap; flagship é opt-in pra raciocínio complexo).
insert into public.ai_models (provider, model_id, display_name, description, context_window, input_price_per_million_cents, output_price_per_million_cents, supports_tools, is_default_for_provider)
values
  ('anthropic', 'claude-opus-4-7',    'Claude Opus 4.7',    'Flagship Anthropic — raciocínio complexo',                  200000,  1500, 7500, true, false),
  ('anthropic', 'claude-sonnet-4-6',  'Claude Sonnet 4.6',  'Default recomendado — equilíbrio custo/qualidade',           200000,   300, 1500, true, true),
  ('anthropic', 'claude-haiku-4-5',   'Claude Haiku 4.5',   'Cheap/fast — atendimentos curtos e classificação',           200000,   100,  500, true, false),
  ('openai',    'gpt-5',              'GPT-5',              'Flagship OpenAI',                                           400000,   500, 4000, true, false),
  ('openai',    'gpt-5-mini',         'GPT-5 Mini',         'Cheap/fast OpenAI',                                         400000,   150,  600, true, true),
  ('openai',    'gpt-4o',             'GPT-4o (legacy)',    'Compat — uso legado',                                       128000,   250, 1000, true, false),
  ('google',    'gemini-2.5-pro',     'Gemini 2.5 Pro',     'Flagship Google',                                          1000000,   125,  500, true, false),
  ('google',    'gemini-2.5-flash',   'Gemini 2.5 Flash',   'Cheap/fast Google',                                        1000000,    30,  120, true, true)
on conflict (provider, model_id) do nothing;
