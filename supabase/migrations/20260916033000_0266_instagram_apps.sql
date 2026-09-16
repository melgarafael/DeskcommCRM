-- 0266 · Meta App por organização, pra publicar no Instagram em nome do lead.
--
-- ─── Por que organização, não instalação ────────────────────────────────────
-- Mesmo raciocínio de `ad_platform_connections` (0213): o App pertence ao
-- negócio que vai publicar, não à instalação. Uma agência que hospeda dois
-- clientes na mesma VPS pode ter dois Apps Meta diferentes.
--
-- ─── Por que RLS ligada com ZERO policies ───────────────────────────────────
-- Mesmo desenho de `ad_platform_connections` (0213) e `platform_google_oauth`
-- (0201): a anon key vai para o browser, e uma policy de leitura por tenant
-- ainda exporia o App Secret cifrado (e o `app_id`) pelo PostgREST pra
-- qualquer membro autenticado da organização. Tabela com RLS ligada, sem
-- policy nenhuma e grants revogados de anon/authenticated não é servida pelo
-- PostgREST de jeito nenhum — só o `service_role`, que vive no servidor.
--
-- O App Secret assina toda chamada feita em nome de QUALQUER lead conectado
-- desta organização (é a chave-mestra, não o token de um lead só). Vazá-lo
-- deixa terceiro publicar na conta de qualquer lead que já conectou.
--
-- ─── A cifra é a que já existe ──────────────────────────────────────────────
-- `fn_encrypt_oauth`/`fn_decrypt_oauth` (0041), as mesmas de
-- `ad_platform_connections`, `calendar_connections` e `channel_sessions`.
-- Nenhuma função nova em `public` ⇒ nenhuma superfície `security definer`
-- nova ⇒ o item 9 da doutrina de migrations não é acionado por este arquivo.
--
-- A conexão de CADA LEAD com a conta Instagram dele (o token que efetivamente
-- publica) é outra tabela, que chega numa migration futura junto com o fluxo
-- OAuth — este arquivo só guarda o App que faz a ponte com a Meta.

create table if not exists public.instagram_apps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  app_id text not null,
  app_secret_encrypted bytea,

  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,

  constraint instagram_apps_unique_org unique (organization_id)
);

alter table public.instagram_apps enable row level security;
revoke all on public.instagram_apps from anon, authenticated;
grant select, insert, update, delete on public.instagram_apps to service_role;

drop trigger if exists trg_instagram_apps_updated_at on public.instagram_apps;
create trigger trg_instagram_apps_updated_at
  before update on public.instagram_apps
  for each row execute function public.fn_set_updated_at();

comment on table public.instagram_apps is
  'Meta App usado para publicar conteúdo no Instagram em nome dos leads. Server-side only: RLS ligada sem policies e grants revogados de anon/authenticated — o App Secret nunca volta ao browser.';
comment on column public.instagram_apps.app_secret_encrypted is
  'Cifrado por fn_encrypt_oauth (pgp_sym/aes256), a mesma cifra de ad_platform_connections e calendar_connections. Nunca gravar em claro: sem a chave mestra o save recusa.';
