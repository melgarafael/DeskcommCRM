-- 0201 · Conectar o Google exigia SSH na VPS e um editor de texto.
--
-- ─── O que o usuário via ────────────────────────────────────────────────────
-- "Esta instalação não tem as credenciais do Google cadastradas — não é nada que
--  você tenha feito. Quem instalou o sistema precisa configurar
--  GOOGLE_CALENDAR_CLIENT_ID e GOOGLE_CALENDAR_CLIENT_SECRET."
--
-- O produto é self-host para quem NÃO programa. Nomear variáveis de ambiente
-- para essa pessoa é o mesmo que dizer que a funcionalidade não existe.
--
-- ─── Por que INSTALAÇÃO, e não organização ──────────────────────────────────
-- O `redirect_uri` sai de `NEXT_PUBLIC_APP_URL`, o `install.sh` grava o par no
-- `.env` da VPS, e o app OAuth é registrado no console do Google pelo dono da
-- instalação. É uma VPS por cliente: a credencial pareia 1:1 com a instalação.
-- Mesmo objeto de `platform_branding` (migration 0155), e este arquivo é um
-- clone declarado daquele molde.
--
-- A doutrina de marca própria do CLAUDE.md já diz a forma: o banco está ACIMA do
-- `.env`, e o `.env` é semente e piso de rollback. Vale igual aqui.
--
-- ─── Por que RLS LIGADA com ZERO policies ───────────────────────────────────
-- Não é descuido, é o desenho — o mesmo de `platform_branding`.
--
-- A anon key VAI PARA O BROWSER. Uma tabela servida pelo PostgREST e "protegida
-- por policy" depende de a policy estar certa; uma tabela com RLS ligada, sem
-- policy nenhuma e com os grants de `anon`/`authenticated` revogados não é
-- servida de jeito nenhum. Só o `service_role`, que vive no servidor, a alcança.
--
-- O que está em jogo justifica a diferença: o `client_secret` do app OAuth é o
-- que permite a QUALQUER UM trocar códigos e refresh tokens em nome desta
-- instalação — isto é, ler a agenda de todos os atendentes que conectaram.
--
-- ─── A cifra é a que já existe, e isso é decisão ────────────────────────────
-- `fn_encrypt_oauth`/`fn_decrypt_oauth` (migration 0041), que o próprio callback
-- do Google já usa para gravar os tokens em `calendar_connections`. Nenhuma
-- função nova em `public` ⇒ nenhuma superfície `security definer` nova ⇒ o item
-- 9 da doutrina de migrations não é acionado aqui.
--
-- Havia uma segunda cifra no repo (AES-GCM em Node, `ai_provider_credentials`),
-- e ela NÃO serve: é de escopo de ORGANIZAÇÃO e exposta por view. Usá-la seria
-- um terceiro caminho de cifra num módulo que já usa o primeiro.

create table if not exists public.platform_google_oauth (
  id smallint primary key default 1,
  client_id text,
  client_secret_encrypted bytea,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint platform_google_oauth_singleton check (id = 1)
);

comment on table public.platform_google_oauth is
  'O app OAuth do Google DESTA INSTALAÇÃO (singleton). Server-side only: RLS ligada sem policies e grants revogados de anon/authenticated — o PostgREST não a serve. O segredo nunca volta ao browser; a tela devolve apenas se existe.';
comment on column public.platform_google_oauth.client_secret_encrypted is
  'Cifrado por fn_encrypt_oauth (pgp_sym_encrypt/aes256), a mesma cifra dos tokens em calendar_connections. Nunca gravar em claro: sem a chave mestra o save recusa.';

alter table public.platform_google_oauth enable row level security;

revoke all on public.platform_google_oauth from anon, authenticated;
grant select, insert, update on public.platform_google_oauth to service_role;

drop trigger if exists trg_platform_google_oauth_updated_at on public.platform_google_oauth;
create trigger trg_platform_google_oauth_updated_at
  before update on public.platform_google_oauth
  for each row execute function public.fn_set_updated_at();
