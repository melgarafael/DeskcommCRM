-- Social connections reuse channel sessions, the inbox and the outbound ledger.
-- Credentials are server-only; tenant admins use authenticated API routes.
create table if not exists public.channel_integrations (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  profile_id text not null,
  credential_encrypted bytea not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.channel_integrations enable row level security;
revoke all on public.channel_integrations from public, anon, authenticated;
grant all on public.channel_integrations to service_role;

alter table public.contacts add column if not exists social_identity text;
-- A ficha MESCLADA fica de fora do índice: depois de juntar dois contatos, o
-- perdedor continua na tabela com `is_merged_into` apontando para o vencedor, e
-- os dois carregam a mesma identidade social. Sem esta guarda, a junção passa a
-- falhar com violação de unicidade — e quem junta é o operador, na tela.
create unique index if not exists contacts_org_social_identity_unique
  on public.contacts (organization_id, social_identity)
  where social_identity is not null and is_merged_into is null;
comment on column public.contacts.social_identity is
  'Opaque network/account/participant key. Never interpreted as a telephone or WhatsApp identity.';

alter table public.channel_sessions drop constraint if exists channel_sessions_provider_check;
alter table public.channel_sessions add constraint channel_sessions_provider_check
  check (provider in ('waha', 'meta_cloud', 'zernio', 'zernio_social', 'wacalls'));
alter table public.channel_sessions drop constraint if exists channel_sessions_provider_ref_check;
alter table public.channel_sessions add constraint channel_sessions_provider_ref_check check (
  (provider = 'waha' and waha_session_name is not null) or
  (provider = 'meta_cloud' and meta_phone_number_id is not null) or
  (provider in ('zernio', 'zernio_social') and zernio_account_id is not null) or
  (provider = 'wacalls' and wacalls_session_id is not null)
);
alter table public.conversations drop constraint if exists conversations_channel_check;
alter table public.conversations add constraint conversations_channel_check
  check (channel in ('whatsapp', 'instagram', 'facebook'));
