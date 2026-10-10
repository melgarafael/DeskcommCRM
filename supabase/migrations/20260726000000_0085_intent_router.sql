-- 0085: Intent Router (Fase 3 do épico harness — spec 2026-07-23).
-- Um router pluga num channel_session e roteia a conversa para o agente cuja
-- intenção declarada casa com a mensagem. Tabelas EDITÁVEIS (não versão+ponteiro):
-- mutação é auditada por trigger, como ai_agents.

create table if not exists ai_routers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null check (length(name) > 0),
  channel_session_id uuid not null references channel_sessions(id) on delete cascade,
  is_active boolean not null default true,
  config jsonb not null default jsonb_build_object(
    'classifier_model', 'claude-haiku-4-5',
    'sticky', true,
    'min_confidence', 0.6
  ),
  fallback_agent_id uuid references ai_agents(id) on delete set null,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Um router ativo por sessão de canal (dois routers disputando o mesmo número
-- seria ambiguidade de roteamento — o índice parcial impede).
create unique index if not exists uniq_ai_routers_active_session
  on ai_routers (channel_session_id) where is_active;

create table if not exists ai_router_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  router_id uuid not null references ai_routers(id) on delete cascade,
  agent_id uuid not null references ai_agents(id) on delete cascade,
  intent_name text not null check (length(intent_name) > 0),
  intent_description text not null check (length(intent_description) > 0),
  examples text[] not null default '{}',
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (router_id, intent_name)
);

create index if not exists idx_ai_router_members_router
  on ai_router_members (router_id, position);

-- Telemetria de decisão (append-only, SEM PII — o texto do lead nunca entra aqui).
create table if not exists ai_router_decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  router_id uuid references ai_routers(id) on delete set null,
  conversation_id uuid,
  intent_name text,
  confidence numeric(4,3),
  agent_id uuid references ai_agents(id) on delete set null,
  outcome text not null check (outcome in ('classified', 'sticky', 'reclassified', 'fallback', 'no_match', 'classifier_failed')),
  job_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_ai_router_decisions_org_created
  on ai_router_decisions (organization_id, created_at);
create index if not exists idx_ai_router_decisions_router
  on ai_router_decisions (router_id, created_at);

-- Stickiness por conversa: qual agente o router entregou e qual intenção.
alter table conversations add column if not exists active_ai_agent_id uuid references ai_agents(id) on delete set null;
alter table conversations add column if not exists active_intent text;
alter table conversations add column if not exists active_agent_set_at timestamptz;

-- Triggers: audit de mutação + updated_at (padrão de ai_agents).
drop trigger if exists trg_ai_routers_audit on ai_routers;
create trigger trg_ai_routers_audit
  after insert or update or delete on ai_routers
  for each row execute function fn_audit_log_row();
drop trigger if exists trg_ai_routers_updated_at on ai_routers;
create trigger trg_ai_routers_updated_at
  before update on ai_routers
  for each row execute function fn_set_updated_at();

drop trigger if exists trg_ai_router_members_audit on ai_router_members;
create trigger trg_ai_router_members_audit
  after insert or update or delete on ai_router_members
  for each row execute function fn_audit_log_row();
drop trigger if exists trg_ai_router_members_updated_at on ai_router_members;
create trigger trg_ai_router_members_updated_at
  before update on ai_router_members
  for each row execute function fn_set_updated_at();

-- RLS (mesmo shape do loop tenant_isolation_* do baseline).
do $$
declare t text;
begin
  foreach t in array array['ai_routers', 'ai_router_members', 'ai_router_decisions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists tenant_isolation_%s_all on public.%I', t, t);
    execute format(
      'create policy tenant_isolation_%s_all on public.%I for all
         using (organization_id in (select * from public.fn_user_org_ids()))
         with check (organization_id in (select * from public.fn_user_org_ids()))',
      t, t
    );
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;
