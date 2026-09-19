-- ============================================================
-- 0347_modulo_voip — ai_agents.channel, phone_numbers, fn_resolve_inbound_number
--
-- RECOMPOSTA. Esta migration existiu no PR #677 como 0232_modulo_voip e foi
-- apagada por acidente no commit 97eed0955 (que unificou crm_calls em
-- voice_calls): o apêndice do baseline manteve o bloco, mas o arquivo sumiu,
-- e quem aplica as migrations em ordem nunca receberia phone_numbers.
-- O corpo abaixo é o bloco do apêndice, que já descartava crm_calls (ver
-- 0348_voice_calls_sip). Renumerada para acima do máximo da main.
-- ============================================================

--
-- SIP/Asterisk + IA de voz via OpenAI Realtime. Segue os mesmos padrões de
-- conversations/messages: RLS por tenant via fn_user_org_ids(), audit
-- append-only em mutações, text+CHECK (nunca enum nativo).
--
-- Sem event_log para call.*: nenhum handler em lib/event-log/register-handlers.ts
-- consumiria esses tipos ainda — evento sem handler nasce `pending` pra sempre
-- no drain (anti-pattern nº 3, ver migration 0155). Se um consumidor real
-- aparecer, adicionar handler + trigger juntos, não antes.

alter table public.ai_agents
  add column if not exists channel text not null default 'whatsapp';

alter table public.ai_agents
  drop constraint if exists ai_agents_channel_check;

alter table public.ai_agents
  add constraint ai_agents_channel_check
  check (channel = any (array['whatsapp', 'voice']));

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

-- Resolve org + config de roteamento a partir do número discado (DNIS).
-- Usado pelo worker (service-role, ignora RLS).
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

notify pgrst,'reload schema';
