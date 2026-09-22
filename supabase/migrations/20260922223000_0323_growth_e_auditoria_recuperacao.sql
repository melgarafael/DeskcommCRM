-- Recovery of production native modules; 0265 already belongs to subscriptions.
-- Módulos Nativos: Instagram Growth Engine e Cliente Oculto (Mystery Shopper)

-- 1. Instagram Growth Triggers (Comentários -> DMs -> Leads)
create table if not exists public.growth_instagram_triggers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  post_id text, -- ID do post/reels na Meta ou null para todos os posts
  post_permalink text,
  post_thumbnail text,
  keywords text[] not null default '{}', -- Ex: ["EU QUERO", "PREÇO", "VALOR"]
  match_mode text not null default 'contains' check (match_mode in ('exact', 'contains', 'any')),
  dm_response_template text not null,
  auto_create_lead boolean not null default true,
  pipeline_id uuid references public.crm_pipelines(id) on delete set null,
  pipeline_stage_id uuid references public.crm_stages(id) on delete set null,
  lead_tags text[] not null default '{}',
  is_active boolean not null default true,
  executions_count integer not null default 0,
  leads_generated_count integer not null default 0,
  last_triggered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_growth_insta_org on public.growth_instagram_triggers(organization_id);
create index if not exists idx_growth_insta_post on public.growth_instagram_triggers(organization_id, post_id);

alter table public.growth_instagram_triggers enable row level security;
grant all on public.growth_instagram_triggers to service_role;
grant select, insert, update, delete on public.growth_instagram_triggers to authenticated;

-- 2. Cliente Oculto (Mystery Shopper Audits)
create table if not exists public.audit_mystery_scenarios (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  title text not null,
  persona_name text not null,
  persona_description text not null,
  objective text not null,
  target_channel_session_id uuid references public.channel_sessions(id) on delete set null,
  target_phone text,
  evaluation_criteria jsonb not null default '{"speed": true, "politeness": true, "objection_handling": true, "closing": true}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_mystery_executions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  scenario_id uuid references public.audit_mystery_scenarios(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  score numeric(4,2), -- 0 a 10.00
  first_response_time_seconds integer,
  messages_exchanged integer not null default 0,
  transcript jsonb not null default '[]',
  ai_feedback text,
  strengths text[],
  weaknesses text[],
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_mystery_scenarios_org on public.audit_mystery_scenarios(organization_id);
create index if not exists idx_mystery_exec_org on public.audit_mystery_executions(organization_id);

alter table public.audit_mystery_scenarios enable row level security;
grant all on public.audit_mystery_scenarios to service_role;
grant select, insert, update, delete on public.audit_mystery_scenarios to authenticated;

alter table public.audit_mystery_executions enable row level security;
grant all on public.audit_mystery_executions to service_role;
grant select, insert, update, delete on public.audit_mystery_executions to authenticated;

-- 3. Transcrição e Sentimento direto na tabela de mensagens (se não existirem)
alter table public.messages add column if not exists audio_transcription text;
alter table public.messages add column if not exists audio_transcription_status text default 'none' check (audio_transcription_status in ('none', 'processing', 'completed', 'failed'));
alter table public.messages add column if not exists audio_summary text;
alter table public.messages add column if not exists audio_intent text;


revoke all on public.growth_instagram_triggers from public, anon;
drop policy if exists tenant_isolation_growth_instagram_triggers_all on public.growth_instagram_triggers;
create policy tenant_isolation_growth_instagram_triggers_all on public.growth_instagram_triggers for all to authenticated
 using (organization_id in (select public.fn_user_org_ids()) and public.fn_user_role_in_org(organization_id)='admin')
 with check (organization_id in (select public.fn_user_org_ids()) and public.fn_user_role_in_org(organization_id)='admin');

revoke all on public.audit_mystery_scenarios from public, anon;
drop policy if exists tenant_isolation_audit_mystery_scenarios_all on public.audit_mystery_scenarios;
create policy tenant_isolation_audit_mystery_scenarios_all on public.audit_mystery_scenarios for all to authenticated
 using (organization_id in (select public.fn_user_org_ids()) and public.fn_user_role_in_org(organization_id)='admin')
 with check (organization_id in (select public.fn_user_org_ids()) and public.fn_user_role_in_org(organization_id)='admin');

revoke all on public.audit_mystery_executions from public, anon;
drop policy if exists tenant_isolation_audit_mystery_executions_all on public.audit_mystery_executions;
create policy tenant_isolation_audit_mystery_executions_all on public.audit_mystery_executions for all to authenticated
 using (organization_id in (select public.fn_user_org_ids()) and public.fn_user_role_in_org(organization_id)='admin')
 with check (organization_id in (select public.fn_user_org_ids()) and public.fn_user_role_in_org(organization_id)='admin');
