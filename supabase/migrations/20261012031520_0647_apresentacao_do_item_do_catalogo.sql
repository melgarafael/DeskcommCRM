-- manifest: Apresentação por texto ou áudio fica num agregado 1:1 do item, com RLS e mídia privada permanentes.
-- ============================================================================
-- 0647 — APRESENTAÇÃO DO ITEM DO CATÁLOGO PELA IA
--
-- A configuração é enriquecimento local do catálogo: não pertence ao
-- sincronizador que trouxe o produto e não polui a linha comercial com campos
-- opcionais da IA. Ausência da linha significa "desativada".
--
-- O FK composto prova no banco que apresentação e produto pertencem à mesma
-- organização. `catalog_product_id` também é único: uma apresentação por item.
--
-- O bucket é separado de `whatsapp-media`: o original pertence ao catálogo e
-- não pode sumir na limpeza LGPD de uma conversa. Também não entra em
-- `catalog-photos`, cujo contrato é exclusivamente JPEG/PNG. Sem policies em
-- storage.objects: as rotas autorizam e o service_role executa.
-- ============================================================================

create unique index if not exists catalog_products_org_id_key
  on public.catalog_products (organization_id, id);

create table if not exists public.catalog_product_presentations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  catalog_product_id uuid not null unique,

  enabled boolean not null default false,
  kind text not null default 'text',
  title text,
  text_content text,
  use_catalog_photos boolean not null default true,
  show_price boolean not null default false,

  audio_storage_path text,
  audio_mime text,
  audio_size_bytes bigint,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint catalog_product_presentations_product_org_fk
    foreign key (organization_id, catalog_product_id)
    references public.catalog_products (organization_id, id)
    on delete cascade,
  constraint catalog_product_presentations_kind_check
    check (kind in ('text', 'audio')),
  constraint catalog_product_presentations_title_length_check
    check (title is null or char_length(title) <= 200),
  constraint catalog_product_presentations_text_length_check
    check (text_content is null or char_length(text_content) <= 4096),
  constraint catalog_product_presentations_audio_coherent_check
    check (
      (audio_storage_path is null and audio_mime is null and audio_size_bytes is null)
      or
      (audio_storage_path is not null
       and audio_mime = 'audio/ogg;codecs=opus'
       and audio_size_bytes > 0
       and audio_size_bytes <= 16777216)
    ),
  constraint catalog_product_presentations_audio_owned_check
    check (
      audio_storage_path is null
      or audio_storage_path ~ (
        '^' || organization_id::text || '/' || catalog_product_id::text ||
        '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.ogg$'
      )
    ),
  constraint catalog_product_presentations_enabled_complete_check
    check (
      not enabled
      or (kind = 'text' and nullif(btrim(text_content), '') is not null)
      or (kind = 'audio' and audio_storage_path is not null)
    )
);

create index if not exists catalog_product_presentations_org_idx
  on public.catalog_product_presentations (organization_id, catalog_product_id);

alter table public.catalog_product_presentations enable row level security;

drop policy if exists catalog_product_presentations_select
  on public.catalog_product_presentations;
create policy catalog_product_presentations_select
  on public.catalog_product_presentations
  for select using (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

drop policy if exists catalog_product_presentations_write
  on public.catalog_product_presentations;
create policy catalog_product_presentations_write
  on public.catalog_product_presentations
  using (
    public.fn_is_platform_admin_full()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager')
    )
  )
  with check (
    public.fn_is_platform_admin_full()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager')
    )
  );

revoke all on public.catalog_product_presentations from public, anon;
grant select, insert, update, delete on public.catalog_product_presentations to authenticated;
grant all on public.catalog_product_presentations to service_role;

do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;

drop trigger if exists trg_catalog_product_presentations_updated_at
  on public.catalog_product_presentations;
create trigger trg_catalog_product_presentations_updated_at
  before update on public.catalog_product_presentations
  for each row execute function public.fn_set_updated_at();

comment on table public.catalog_product_presentations is
  'Configuração 1:1, local e opcional, da apresentação estruturada de um item do catálogo pela IA. Ausência da linha significa desativada.';
comment on column public.catalog_product_presentations.audio_storage_path is
  'Caminho privado em catalog-presentation-media, sempre <organization_id>/<catalog_product_id>/<uuid>.ogg. URLs assinadas nunca são persistidas.';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'catalog-presentation-media',
  'catalog-presentation-media',
  false,
  16777216,
  array['audio/ogg', 'audio/ogg;codecs=opus']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
