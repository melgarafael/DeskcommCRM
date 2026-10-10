-- ============================================================================
-- 0390 — O PRODUTO GANHA FOTO (ideia de @vgamkt, a partir do #1130)
--
-- Cada produto do catálogo guarda até 5 fotos, e o agente de IA manda a foto
-- junto quando apresenta o produto no WhatsApp.
--
-- ─── Por que uma coluna `text[]`, e não uma tabela de fotos
--
-- O que a tela faz com as fotos é pôr, tirar e trocar a ordem. Num array isso é
-- UM update da linha do produto, e a ordem é a do próprio array (a primeira é
-- a capa) — sem coluna de posição para manter coerente. A tabela à parte
-- precisaria de RLS, grants e cascata próprios para repetir exatamente o que a
-- linha do produto já tem: leitura para a organização, escrita só de `manager`
-- para cima (policies da 0204), e as fotos somem junto com o produto.
--
-- O array guarda CAMINHOS de Storage, não URLs: a URL é assinada e curta, e
-- gravá-la seria gravar algo que expira.
--
-- ─── Por que um bucket próprio, privado
--
-- `catalog-photos` e não `whatsapp-media`: a limpeza de LGPD apaga a mídia das
-- conversas de um contato, e a foto do catálogo não é de contato nenhum. Quando
-- o agente manda a foto, o app COPIA o arquivo para a pasta da conversa em
-- `whatsapp-media` — é essa cópia que a conversa possui e que a LGPD apaga.
--
-- 5 MB e só JPEG/PNG: é o teto e são os formatos de imagem que o WhatsApp
-- oficial aceita. Aceitar mais aqui seria aceitar foto que um dos canais não
-- entrega. Nenhuma policy em `storage.objects`: só o `service_role` lê e grava,
-- depois de a rota conferir o papel (molde do `brand-logos`, 0158).
--
-- Quem LÊ um caminho deste array (a tela assina, o agente copia) confere que ele
-- começa com `<organização>/<produto>/` — um `manager` escreve a linha pelo
-- PostgREST e poderia gravar o caminho de outra organização; a leitura é por
-- service role, que não tem RLS para barrar.
--
-- Idempotente: `add column if not exists`, constraint recriada, bucket com
-- `on conflict do update`. Aditiva: o default satisfaz o CHECK em toda linha.
-- ============================================================================

alter table public.catalog_products
  add column if not exists fotos text[] not null default '{}';

alter table public.catalog_products
  drop constraint if exists catalog_products_fotos_no_maximo_5;
alter table public.catalog_products
  add constraint catalog_products_fotos_no_maximo_5 check (cardinality(fotos) <= 5);

comment on column public.catalog_products.fotos is
  'Caminhos em storage/catalog-photos, sempre <organization_id>/<id>/<uuid>.<jpg|png>. A ordem é a da tela e a primeira é a capa. Escrito só por app/api/v1/products/[id]/fotos.';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('catalog-photos', 'catalog-photos', false, 5242880, array['image/jpeg', 'image/png'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
