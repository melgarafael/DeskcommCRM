-- 0232 — vínculo OAuth Codex por organização (D2). Um vínculo por org+provider.
-- Refresh token cifrado AES-256-GCM (colunas espelham ai_provider_credentials).
--
-- POSTURA deny-all (precedente ad_platform_connections, migration 0213): RLS
-- ligada, ZERO policies, grants revogados de anon/authenticated. O refresh
-- token tem a mesma sensibilidade do token de anúncios — só o servidor
-- alcança, com o admin client filtrando organization_id à mão (armazenamento
-- e rotas Codex usam createAdminClient em todos os caminhos). Servir esta
-- tabela pelo PostgREST, mesmo atrás de policy de tenant, trocaria ausência
-- de privilégio por regra que alguém pode errar depois.
create table if not exists public.ai_provider_oauth (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  provider text not null default 'openai-codex' check (provider = 'openai-codex'),
  label text not null default 'ChatGPT',
  refresh_encrypted bytea not null,
  refresh_iv bytea not null,
  refresh_tag bytea not null,
  access_expires_at timestamptz,
  -- Identidade da conta ChatGPT (vai no header `ChatGPT-Account-ID` de cada
  -- chamada de chat; sem ela o spike de execução não monta o envelope).
  -- Nullable de propósito: vínculo antigo continua válido, e o spike o
  -- preenche no primeiro refresh que devolver id_token.
  account_id text,
  status text not null default 'pending' check (status in ('pending','active','quarantined','revoked')),
  quarantined_reason text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider)
);
alter table public.ai_provider_oauth enable row level security;
-- O baseline traz ALTER DEFAULT PRIVILEGES concedendo tabelas novas a
-- anon/authenticated: tabela nova nasce concedida, então o revoke é
-- obrigatório, não enfeite (medido no eixo de anúncios, 0213).
revoke all on public.ai_provider_oauth from anon, authenticated;
grant select, insert, update, delete on public.ai_provider_oauth to service_role;
drop trigger if exists trg_ai_provider_oauth_updated_at on public.ai_provider_oauth;
create trigger trg_ai_provider_oauth_updated_at
  before update on public.ai_provider_oauth
  for each row execute function public.fn_set_updated_at();
