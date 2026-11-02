-- manifest: Credencial Hostinger por organização para o canal de e-mail da Zoe. A senha é cifrada em bytea, saída automática e sincronização começam desligadas, e o PostgREST não tem acesso direto à tabela.
--
-- Uma caixa por organização nesta primeira entrega. O adapter de protocolo é
-- `lib/email/hostinger.ts`; esta tabela não torna a caixa operacional por si só.
-- Worker, persistência das mensagens e política da campanha permanecem etapas
-- posteriores. A credencial só é lida/escrita no servidor após o gate de papel.
--
-- Idempotente: tabela, índice, RLS e grants podem ser reaplicados.

create table if not exists public.organization_email_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  provider text not null default 'hostinger',
  mailbox_email text not null,
  mailbox_password_encrypted bytea not null,
  status text not null default 'disconnected',
  outbound_automation_enabled boolean not null default false,
  inbox_sync_enabled boolean not null default false,
  inbox_uid_validity text,
  inbox_last_uid bigint not null default 0,
  last_sync_at timestamptz,
  last_error_code text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_email_connections_provider_check
    check (provider in ('hostinger')),
  constraint organization_email_connections_status_check
    check (status in ('disconnected', 'healthy', 'error')),
  constraint organization_email_connections_uid_check
    check (inbox_last_uid >= 0)
);

alter table public.organization_email_connections
  add column if not exists outbound_automation_enabled boolean not null default false;

comment on table public.organization_email_connections is
  'Conta de e-mail de entrada/saída da organização. A senha deve permanecer cifrada; nenhuma credencial é servida diretamente pelo PostgREST.';
comment on column public.organization_email_connections.mailbox_password_encrypted is
  'Cifrada por public.fn_encrypt_oauth (pgp_sym AES-256). Somente código servidor autorizado pode decifrar; nunca retornar à interface.';
comment on column public.organization_email_connections.inbox_sync_enabled is
  'A sincronização da caixa começa desligada e só pode ser habilitada quando o worker e as regras de entrada estiverem disponíveis.';
comment on column public.organization_email_connections.outbound_automation_enabled is
  'A caixa verificada só envia automações depois de um opt-in explícito do administrador da organização.';

create index if not exists organization_email_connections_sync_idx
  on public.organization_email_connections (last_sync_at)
  where inbox_sync_enabled and status = 'healthy';

alter table public.organization_email_connections enable row level security;
revoke all on public.organization_email_connections from public, anon, authenticated;
grant all on public.organization_email_connections to service_role;

notify pgrst, 'reload schema';
