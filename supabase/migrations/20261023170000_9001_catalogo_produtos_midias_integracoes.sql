-- manifest: catalogo de produtos com video para whatsapp, bucket catalog-videos e campos de integracao bling e meta

alter table public.catalog_products
  add column if not exists video_file_path text,
  add column if not exists gtin text,
  add column if not exists ncm text,
  add column if not exists origem_fiscal text,
  add column if not exists peso_gramas integer,
  add column if not exists altura_cm integer,
  add column if not exists largura_cm integer,
  add column if not exists comprimento_cm integer,
  add column if not exists condicao text default 'new',
  add column if not exists link_loja text;

comment on column public.catalog_products.video_file_path is
  'Caminho em storage/catalog-videos, sempre <organization_id>/<id>/video.mp4. Usado para envio nativo de video via WhatsApp.';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('catalog-videos', 'catalog-videos', false, 314572800, array['video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
