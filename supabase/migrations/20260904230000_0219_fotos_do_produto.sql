-- ============================================================================
-- 0219 — FOTOS DO PRODUTO (ATT.txt F1: upload múltiplo, máx 5)
--
-- `product_images`: uma linha por foto (produto + caminho + posição). A capa
-- é a de menor posição — sem coluna `is_cover` para não sincronizar (duas
-- fontes para "qual é a capa" divergem; ORDER BY não diverge).
--
-- Bucket `product-images` PÚBLICO, molde do `brand-logos` (0158): foto de
-- produto aparece em tela sem sessão (catálogo, portal futuro), e URL
-- assinada VENCE — a foto sumiria sozinha. Contenções iguais: ZERO policy em
-- storage.objects (público abre LEITURA, não escrita), caminho não-enumerável
-- `<org>/<uuid>.ext`, MIME como backstop (a rota fareja os bytes).
-- Teto 2 MB por foto: thumbnail de catálogo não precisa de mais, e a cota do
-- Supabase é do cliente.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.product_images (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null references public.catalog_products(id) on delete cascade,

  -- Caminho no bucket. Grava-se o CAMINHO, nunca a URL (DIRC-C).
  storage_path text not null,
  posicao integer not null default 0,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint product_images_path_obrigatorio check (char_length(trim(storage_path)) > 0),
  constraint product_images_posicao_nao_negativa check (posicao >= 0)
);

create index if not exists product_images_produto_idx
  on public.product_images (product_id, posicao);

alter table public.product_images enable row level security;

drop policy if exists product_images_select on public.product_images;
create policy product_images_select on public.product_images
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

-- Foto de produto é catálogo: escrita manager+, como preço.
drop policy if exists product_images_write on public.product_images;
create policy product_images_write on public.product_images
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

revoke all on public.product_images from anon;
grant select, insert, update, delete on public.product_images to authenticated;
grant all on public.product_images to service_role;

comment on table public.product_images is
  'Fotos do produto (máx 5, contado na rota): capa = menor posição. Bucket público product-images; caminho não-enumerável.';
