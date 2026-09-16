-- 0268 · O rascunho de post do Instagram, esperando o lead confirmar.
--
-- `crm_instagram_preparar_post` grava aqui (status='pending') sem publicar
-- nada; só `crm_instagram_confirmar_post`, chamado num turno POSTERIOR depois
-- que o lead confirma na conversa, publica de fato. As duas tools são
-- deliberadamente separadas — nunca uma tool só que publica direto — porque
-- postar na conta de outra pessoa é a ação mais irreversível e pública que
-- este agente pode tomar.
--
-- ─── Por que RLS normal (com policy), e não o padrão "zero policies" de
--     `instagram_apps`/`instagram_connections` ───────────────────────────
-- Esta tabela não guarda segredo nenhum (nem token, nem app secret) — só
-- rascunho de legenda/hashtag/destino. Quem administra a organização pode e
-- deve conseguir ver o que o agente está prestes a publicar em nome de um
-- lead, então segue o padrão comum de tabela tenant-aware.

create table if not exists public.instagram_pending_posts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  source_message_id uuid not null references public.messages(id) on delete cascade,

  destino text not null check (destino in ('feed', 'reels')),
  caption text not null,
  hashtags text[] not null default '{}',

  status text not null default 'pending' check (status in ('pending', 'published', 'cancelled', 'expired', 'failed')),
  ig_media_id text,
  ig_permalink text,
  error_message text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz
);

create index if not exists instagram_pending_posts_org_contact_idx
  on public.instagram_pending_posts (organization_id, contact_id, status);

alter table public.instagram_pending_posts enable row level security;

drop policy if exists tenant_isolation_instagram_pending_posts_select on public.instagram_pending_posts;
create policy tenant_isolation_instagram_pending_posts_select on public.instagram_pending_posts
  for select
  using (organization_id in (select * from public.fn_user_org_ids()));

drop policy if exists tenant_isolation_instagram_pending_posts_modify on public.instagram_pending_posts;
create policy tenant_isolation_instagram_pending_posts_modify on public.instagram_pending_posts
  for all
  using (organization_id in (select * from public.fn_user_org_ids()))
  with check (organization_id in (select * from public.fn_user_org_ids()));

drop trigger if exists trg_instagram_pending_posts_updated_at on public.instagram_pending_posts;
create trigger trg_instagram_pending_posts_updated_at
  before update on public.instagram_pending_posts
  for each row execute function public.fn_set_updated_at();

comment on table public.instagram_pending_posts is
  'Rascunho de post do Instagram esperando confirmação do lead antes de publicar (crm_instagram_preparar_post / crm_instagram_confirmar_post).';
