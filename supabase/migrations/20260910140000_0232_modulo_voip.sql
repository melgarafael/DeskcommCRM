-- ============================================================
-- 0232_modulo_voip — crm_calls, phone_numbers, ai_agents.channel
--
-- Módulo VoIP (SIP/Asterisk + IA de voz via OpenAI Realtime). Segue os
-- mesmos padrões de conversations/messages: RLS por tenant via
-- fn_user_org_ids(), audit append-only em mutações, text+CHECK (nunca enum
-- nativo — nenhuma tabela do projeto usa `create type ... as enum`).
--
-- Sem event_log para call.*: nenhum handler em
-- lib/event-log/register-handlers.ts consumiria esses tipos ainda — evento
-- sem handler nasce `pending` pra sempre no drain (anti-pattern nº 3, ver
-- migration 0155). Se um consumidor real aparecer, adicionar handler +
-- trigger juntos, não antes.
-- ============================================================

-- ---------- ai_agents: canal (voz vs whatsapp) ----------
-- Aditivo, default preserva os agentes existentes como 'whatsapp'.
alter table public.ai_agents
  add column if not exists channel text not null default 'whatsapp';

alter table public.ai_agents
  drop constraint if exists ai_agents_channel_check;

alter table public.ai_agents
  add constraint ai_agents_channel_check
  check (channel = any (array['whatsapp', 'voice']));

-- ---------- TABELA: crm_calls ----------
create table if not exists public.crm_calls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  lead_id uuid references public.crm_leads(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,

  direction text not null check (direction = any (array['outbound', 'inbound'])),
  status text not null default 'ringing'
    check (status = any (array['ringing', 'in_progress', 'completed', 'no_answer', 'busy', 'failed', 'canceled'])),

  from_number text not null,
  to_number text not null,

  asterisk_channel_id text unique,
  ari_bridge_id text,

  assigned_to_user_id uuid references auth.users(id) on delete set null,

  ai_agent_id uuid references public.ai_agents(id) on delete set null,
  handled_by text not null default 'human'
    check (handled_by = any (array['human', 'ai', 'ai_then_human'])),

  started_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds int generated always as (
    case when answered_at is not null and ended_at is not null
      then extract(epoch from (ended_at - answered_at))::int
      else null
    end
  ) stored,

  recording_url text,
  transcript jsonb,
  sentiment text,
  ai_summary text,

  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_crm_calls_org on public.crm_calls(organization_id);
create index if not exists idx_crm_calls_lead on public.crm_calls(lead_id) where lead_id is not null;
create index if not exists idx_crm_calls_contact on public.crm_calls(contact_id) where contact_id is not null;
create index if not exists idx_crm_calls_status on public.crm_calls(organization_id, status);
create index if not exists idx_crm_calls_started on public.crm_calls(organization_id, started_at desc);

alter table public.crm_calls enable row level security;

drop policy if exists crm_calls_isolation on public.crm_calls;
create policy crm_calls_isolation on public.crm_calls
  using (organization_id in (select fn_user_org_ids()))
  with check (organization_id in (select fn_user_org_ids()));

drop trigger if exists trg_crm_calls_updated_at on public.crm_calls;
create trigger trg_crm_calls_updated_at
  before update on public.crm_calls
  for each row execute function public.fn_set_updated_at();

drop trigger if exists trg_crm_calls_audit on public.crm_calls;
create trigger trg_crm_calls_audit
  after insert or update or delete on public.crm_calls
  for each row execute function public.fn_audit_log_row();

-- ---------- TABELA: phone_numbers ----------
create table if not exists public.phone_numbers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  number text not null unique,
  label text,

  trunk_endpoint text not null,
  routing_mode text not null default 'ai'
    check (routing_mode = any (array['ai', 'human', 'ai_then_human'])),
  default_ai_agent_id uuid references public.ai_agents(id) on delete set null,
  fallback_user_id uuid references auth.users(id) on delete set null,

  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_phone_numbers_org on public.phone_numbers(organization_id);
create index if not exists idx_phone_numbers_active on public.phone_numbers(number) where is_active;

alter table public.phone_numbers enable row level security;

drop policy if exists phone_numbers_isolation on public.phone_numbers;
create policy phone_numbers_isolation on public.phone_numbers
  using (organization_id in (select fn_user_org_ids()))
  with check (organization_id in (select fn_user_org_ids()));

drop trigger if exists trg_phone_numbers_updated_at on public.phone_numbers;
create trigger trg_phone_numbers_updated_at
  before update on public.phone_numbers
  for each row execute function public.fn_set_updated_at();

drop trigger if exists trg_phone_numbers_audit on public.phone_numbers;
create trigger trg_phone_numbers_audit
  after insert or update or delete on public.phone_numbers
  for each row execute function public.fn_audit_log_row();

-- ---------- helper usado pelo worker (service-role, ignora RLS) ----------
-- Resolve org + config de roteamento a partir do número discado (DNIS).
create or replace function public.fn_resolve_inbound_number(p_number text)
returns table (
  organization_id uuid,
  routing_mode text,
  default_ai_agent_id uuid,
  fallback_user_id uuid
) as $$
  select organization_id, routing_mode, default_ai_agent_id, fallback_user_id
  from public.phone_numbers
  where number = p_number and is_active
  limit 1;
$$ language sql security definer stable;

-- Regra do item 9 do CLAUDE.md: função nova em public nasce exposta via as
-- DUAS origens (default privileges + grant implícito a PUBLIC). Revoga as
-- duas, concede só a service_role (é o worker quem chama, via admin client).
revoke execute on function public.fn_resolve_inbound_number(text) from public, anon;
grant execute on function public.fn_resolve_inbound_number(text) to service_role;
