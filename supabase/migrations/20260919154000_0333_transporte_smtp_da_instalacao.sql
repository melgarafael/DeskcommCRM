-- O TRANSPORTE SMTP DESTA INSTALAÇÃO — a segunda opção de e-mail, ao lado da
-- Resend, nunca no lugar dela.
--
-- ── O que esta tabela resolve ───────────────────────────────────────────────
--
-- Até aqui todo e-mail transacional do produto (convite de equipe, entrega de
-- export LGPD, alarme de SLA) saía por um único provedor externo: quem instalava
-- numa VPS era obrigado a abrir conta na Resend e verificar domínio lá antes de
-- conseguir mandar o PRIMEIRO convite. Agora quem já tem servidor de e-mail
-- aponta para ele. Os dois caminhos convivem — quem tem Resend não mexe em nada
-- (`lib/email/roteador.ts` escolhe SMTP quando há SMTP e Resend quando não há).
--
-- ── Mesmo desenho de `platform_meta_app` (0257) e `platform_google_oauth` (0201)
--
-- O objeto é a INSTALAÇÃO, não a organização: um servidor SMTP atende os e-mails
-- de todas as empresas desta VPS, e não há o que separar por tenant. Daí o
-- singleton (`id = 1`), a RLS ligada SEM policies, `anon`/`authenticated`
-- revogados e leitura/escrita só pelo `service_role`, atrás do gate
-- administrativo da tela /admin/email. O `revoke` é obrigatório porque o
-- `alter default privileges` do topo do `baseline.sql` concede tabela nova a
-- `anon` e `authenticated`.
--
-- ── A senha ─────────────────────────────────────────────────────────────────
--
-- Cifrada pela MESMA GUC das outras credenciais server-side (`fn_encrypt_oauth`,
-- via `lib/webhooks/secrets.ts`). Nunca volta ao browser: a tela recebe apenas
-- um booleano dizendo se existe uma senha gravada.
--
-- ── O `.env` não é apagado ──────────────────────────────────────────────────
--
-- As sete `SMTP_*` de `lib/env.ts` continuam sendo lidas e são o piso de
-- rollback (código novo sobre banco que ainda não aplicou esta migration) e o
-- caminho de provisionar a VPS sem abrir interface. O banco PREVALECE; as duas
-- fontes não se misturam (`lib/email/config.ts`).
--
-- Crédito do desenho e do SQL: @betoarts (PR #714).
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
  'O servidor SMTP DESTA INSTALAÇÃO (singleton). Server-side only: RLS ligada sem policies e grants revogados de anon/authenticated — o PostgREST não a serve. A senha é cifrada e nunca volta ao browser; a tela devolve apenas se existe.';
comment on column public.platform_smtp_settings.smtp_password_encrypted is
  'Cifrada por fn_encrypt_oauth (pgp_sym_encrypt/aes256). Nunca gravar em claro: sem a chave mestra o save recusa. Quem tem este valor manda e-mail como a instalação.';
comment on column public.platform_smtp_settings.smtp_security is
  'starttls (normalmente porta 587), tls (TLS implícito, normalmente 465) ou none. O CHECK existe porque o valor vira flag do transporte em lib/email/smtp.ts.';

alter table public.platform_smtp_settings enable row level security;
revoke all on public.platform_smtp_settings from anon, authenticated;
grant select, insert, update on public.platform_smtp_settings to service_role;

drop trigger if exists trg_platform_smtp_settings_updated_at on public.platform_smtp_settings;
create trigger trg_platform_smtp_settings_updated_at
  before update on public.platform_smtp_settings
  for each row execute function public.fn_set_updated_at();
