-- 0267 · A conta do Instagram de CADA LEAD, conectada.
--
-- `instagram_apps` (0266) guarda o App que faz a ponte com a Meta — um por
-- organização. Esta tabela guarda o token que efetivamente publica em nome de
-- UM lead: um Instagram Professional (Business/Creator) por contato.
--
-- ─── Por que RLS ligada com ZERO policies ───────────────────────────────────
-- Mesmo motivo de `instagram_apps` (0266) e `ad_platform_connections` (0213):
-- este token publica conteúdo público na conta de outra pessoa — vazá-lo pelo
-- PostgREST pra qualquer membro autenticado da organização é pior que vazar um
-- token de leitura. Só `service_role` alcança.
--
-- ─── Por que um índice único por `ig_user_id`, além do de `contact_id` ──────
-- Sem ele, a MESMA conta Instagram poderia acabar conectada a dois contatos
-- diferentes (ex.: o lead conectou de novo depois de um contato duplicado) —
-- e a tool de publicar não teria como saber qual dos dois é "o dono" daquele
-- Instagram. `where revoked_at is null` deixa uma conta REVOGADA livre para
-- ser reconectada em outro contato, o mesmo desenho de
-- `channel_sessions_meta_phone_number_id_ativo_unique` (0165).
--
-- ─── A cifra é a que já existe ──────────────────────────────────────────────
-- `fn_encrypt_oauth`/`fn_decrypt_oauth` (0041), as mesmas de `instagram_apps`.

create table if not exists public.instagram_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,

  ig_user_id text not null,
  ig_username text,
  -- 'BUSINESS' | 'MEDIA_CREATOR' | 'PERSONAL' — a Graph API devolve isto no
  -- perfil. Guardado para a tela poder avisar "conta pessoal, não publica"
  -- sem precisar consultar a Meta de novo.
  ig_account_type text,

  access_token_encrypted bytea not null,
  token_expires_at timestamptz,

  connected_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint instagram_connections_unique_contact unique (organization_id, contact_id)
);

create unique index if not exists instagram_connections_ig_user_ativo_unique
  on public.instagram_connections (organization_id, ig_user_id)
  where revoked_at is null;

alter table public.instagram_connections enable row level security;
revoke all on public.instagram_connections from anon, authenticated;
grant select, insert, update, delete on public.instagram_connections to service_role;

drop trigger if exists trg_instagram_connections_updated_at on public.instagram_connections;
create trigger trg_instagram_connections_updated_at
  before update on public.instagram_connections
  for each row execute function public.fn_set_updated_at();

comment on table public.instagram_connections is
  'Conta Instagram Professional de um lead, conectada via OAuth para publicar em nome dele (feed/reels/stories). Server-side only: RLS ligada sem policies e grants revogados de anon/authenticated.';
comment on column public.instagram_connections.access_token_encrypted is
  'Cifrado por fn_encrypt_oauth (pgp_sym/aes256), a mesma cifra de instagram_apps e ad_platform_connections. Nunca gravar em claro: sem a chave mestra o save recusa.';
