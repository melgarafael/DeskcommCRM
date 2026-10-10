-- 0206_chamada_de_voz_wacalls
--
-- Schema pro canal de chamada de voz (WaCalls) — spec docs/specs/18-spec-voice-calls-wacalls.md.
-- `wacalls` entra como terceiro provider em channel_sessions (mesmo padrão de
-- 'zernio'/'meta_cloud': colunas nullable específicas de provider na mesma
-- tabela, não tabela por provider). `voice_calls` é nova, RLS desde já.

-- 1. channel_sessions ganha o provider 'wacalls' + suas colunas de identidade
alter table public.channel_sessions
  add column if not exists wacalls_session_id text,
  add column if not exists wacalls_jid text,
  add column if not exists wacalls_paired_at timestamptz;

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;
alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  check (provider = any (array['waha', 'meta_cloud', 'zernio', 'wacalls']));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;
alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check
  check (
    ((provider = 'waha') and (waha_session_name is not null))
    or ((provider = 'meta_cloud') and (meta_phone_number_id is not null))
    or ((provider = 'zernio') and (zernio_account_id is not null))
    or ((provider = 'wacalls') and (wacalls_session_id is not null))
  );

-- 2. voice_calls
create table if not exists public.voice_calls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid not null references public.channel_sessions(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  wacalls_call_id text not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  peer_phone text not null,
  -- Vocabulário do UPSTREAM (cmd/server/broker.go CallStatus), passthrough
  -- literal — não é invenção nossa. "Chamada perdida" NÃO é status próprio lá:
  -- é end_reason numa chamada que nunca teve answered_at. Ver end_reason abaixo.
  status text not null check (status in ('starting', 'ringing', 'connected', 'ended')),
  -- Vocabulário do UPSTREAM (internal/voip/core EndCallReason), só preenchido
  -- quando status='ended'. Sem CHECK de propósito: é vocabulário de terceiro,
  -- que pode ganhar valor novo numa versão futura do WaCalls sem quebrar a
  -- constraint (doutrina DIRC — mesma exceção de crm_lead_activities.type).
  -- Conhecidos hoje: user_ended, declined, timeout, busy, cancelled, failed,
  -- do_not_disturb, unknown.
  end_reason text,
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  duration_ms integer,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, wacalls_call_id)
);

-- Conserta quem já rodou um rascunho anterior desta migration com o
-- vocabulário errado de status (era invenção nossa, não o do upstream) — sem
-- linha em voice_calls ainda nesta versão nova da feature, então recriar a
-- constraint é seguro (nenhum dado a migrar).
alter table public.voice_calls add column if not exists end_reason text;
alter table public.voice_calls drop constraint if exists voice_calls_status_check;
alter table public.voice_calls
  add constraint voice_calls_status_check
  check (status in ('starting', 'ringing', 'connected', 'ended'));

create index if not exists idx_voice_calls_org on public.voice_calls(organization_id);
create index if not exists idx_voice_calls_contact on public.voice_calls(contact_id);
create index if not exists idx_voice_calls_channel_session on public.voice_calls(channel_session_id);

alter table public.voice_calls enable row level security;

drop policy if exists tenant_isolation_voice_calls_all on public.voice_calls;
create policy tenant_isolation_voice_calls_all on public.voice_calls
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

-- updated_at automático, mesmo padrão das outras tabelas tenant-aware
-- (fn_set_updated_at é o convencional aqui — 27 tabelas contra 5 de fn_touch_updated_at)
drop trigger if exists trg_voice_calls_set_updated_at on public.voice_calls;
create trigger trg_voice_calls_set_updated_at
  before update on public.voice_calls
  for each row execute function public.fn_set_updated_at();

-- 3. agent_inbox_items ganha o kind 'voice_call_missed' — chamada recebida
-- que nunca teve answered_at (call-ended sem ter passado por 'connected').
-- Mesmo padrão do CHECK de provider acima: vocabulário fechado, extensão via
-- drop+recreate.
alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;
alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check
  check (kind in (
    'appointment_outcome_required',
    'appointment_recovery_review',
    'qr_rescan',
    'routing_unassigned',
    'job_dead',
    'event_dead',
    'budget_exceeded',
    'handoff',
    'promotion_review',
    'judge_unaligned',
    'followup_dead',
    'snooze_expired',
    'next_action_ambiguous',
    'risk_backlog_seeded',
    'reactivation_expired',
    'capabilities_missing',
    'message_send_stuck',
    'midia_nao_lida',
    'channel_template_review',
    'channel_number_alert',
    'promise_unfulfilled',
    'contact_proposal_expired',
    'budget_warning',
    'conhecimento_nao_indexado',
    'voice_call_missed',
    'other'
  ));
