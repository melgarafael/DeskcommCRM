-- Segmento e grupos (pai/filho) no catálogo — classificação própria da loja,
-- separada de `marca`/`categoria` (que seguem existindo, sem uso obrigatório).
-- Vocabulário ABERTO (sem CHECK): cada organização usa os próprios rótulos.

alter table public.catalog_products
  add column if not exists segmento text,
  add column if not exists grupo_pai text,
  add column if not exists grupo text;

create index if not exists catalog_products_org_segmento_idx
  on public.catalog_products (organization_id, segmento);

create index if not exists catalog_products_org_grupo_pai_idx
  on public.catalog_products (organization_id, grupo_pai);

create index if not exists catalog_products_org_grupo_idx
  on public.catalog_products (organization_id, grupo);
