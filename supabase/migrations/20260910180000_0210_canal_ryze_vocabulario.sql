-- Migration: 20260910180000_0210_canal_ryze_vocabulario.sql
-- Descricao: Vocabulario e colunas de identificador para o provider Ryze API

alter table public.channel_sessions
  add column if not exists ryze_instance_name text,
  add column if not exists ryze_token_encrypted bytea;

-- Atualizar CHECK constraint do provider em channel_sessions
alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  check (provider in ('waha', 'meta_cloud', 'zernio', 'ryze'));

-- Atualizar CHECK constraint da coluna de referencia por provider
alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check
  check (
    (provider = 'waha' and waha_session_name is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    (provider = 'zernio' and zernio_account_id is not null) or
    (provider = 'ryze' and ryze_instance_name is not null)
  );

-- Indice unico parcial para ryze_instance_name entre sessoes ativas
create unique index if not exists idx_channel_sessions_ryze_instance_name_active
  on public.channel_sessions (ryze_instance_name)
  where archived_at is null and ryze_instance_name is not null;
