-- Transporte SMTP da instalação. Segredos ficam cifrados pela mesma GUC usada
-- pelas demais credenciais server-side; nenhum papel exposto lê esta tabela.
create table if not exists public.platform_smtp_settings (
  id smallint primary key default 1,
  smtp_host text,
  smtp_port integer not null default 587 check (smtp_port between 1 and 65535),
  smtp_security text not null default 'starttls' check (smtp_security in ('starttls', 'tls', 'none')),
  smtp_username text,
  smtp_password_encrypted bytea,
  from_email text,
  from_name text,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint platform_smtp_settings_singleton check (id = 1),
  constraint platform_smtp_settings_host check (smtp_host is null or smtp_host ~ '^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$'),
  constraint platform_smtp_settings_from_email check (
    from_email is null or from_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  )
);

comment on table public.platform_smtp_settings is
  'Transporte SMTP desta instalação. Senha cifrada; leitura e escrita só pelo service_role.';

alter table public.platform_smtp_settings enable row level security;
revoke all on public.platform_smtp_settings from anon, authenticated;
grant select, insert, update on public.platform_smtp_settings to service_role;

drop trigger if exists trg_platform_smtp_settings_updated_at on public.platform_smtp_settings;
create trigger trg_platform_smtp_settings_updated_at
  before update on public.platform_smtp_settings
  for each row execute function public.fn_set_updated_at();
