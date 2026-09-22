-- ============================================================================
-- 0210 — CATEGORIAS E TABELAS DE PREÇO (ATT.txt Fase 1)
--
-- O `categoria text` livre de `catalog_products` (0204) não sustenta tabela de
-- preço por grupo nem árvore de categorias: texto livre duplica ("Bebidas" vs
-- "bebidas") e não tem pai. Entram duas tabelas próprias, e a coluna antiga
-- FICA — migração de dado em `update.sh` de cliente é o custo que a doutrina
-- manda não pagar sem necessidade; a tela passa a escrever `categoria_id`, e
-- `categoria` vira legado legível.
--
-- `product_categories`: árvore por `parent_id` auto-FK (NULL = raiz).
-- `price_tables`: uma tabela (atacado, varejo, cliente X) com desconto
--   padrão; `price_table_items` sobrescreve o preço por produto.
-- Regra de preço efetivo (aplicada na rota, não em trigger): item da tabela
--   > desconto da tabela sobre o base > preço base do produto.
-- ============================================================================

create table if not exists public.product_categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  parent_id uuid references public.product_categories(id) on delete cascade,
  nome text not null,
  posicao integer not null default 0,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_categories_nome_obrigatorio check (char_length(trim(nome)) > 0),
  -- Sem CHECK anti-ciclo no banco: ciclo A→B→A se detecta na escrita da rota
  -- (sobe a cadeia de pais com limite de profundidade); CHECK recursivo em
  -- trigger é o tipo de mágica que quebra `update.sh` sem mensagem útil.
  constraint product_categories_sem_auto_pai check (parent_id is null or parent_id <> id)
);

create unique index if not exists product_categories_org_nome_pai_key
  on public.product_categories (organization_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), nome);

create index if not exists product_categories_org_pai_idx
  on public.product_categories (organization_id, parent_id);

alter table public.product_categories enable row level security;

drop policy if exists product_categories_select on public.product_categories;
create policy product_categories_select on public.product_categories
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists product_categories_write on public.product_categories;
create policy product_categories_write on public.product_categories
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

revoke all on public.product_categories from anon;
grant select, insert, update, delete on public.product_categories to authenticated;
grant all on public.product_categories to service_role;

drop trigger if exists trg_product_categories_updated_at on public.product_categories;
create trigger trg_product_categories_updated_at
  before update on public.product_categories
  for each row execute function public.fn_set_updated_at();

-- ─── Tabelas de preço ───────────────────────────────────────────────────────

create table if not exists public.price_tables (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  nome text not null,
  -- Desconto padrão aplicado sobre o preço base quando não há item específico.
  desconto_pct numeric(5, 2) not null default 0,
  -- Só uma padrão por org: é ela que o pedido usa quando o cliente não tem
  -- tabela própria (decisão futura; hoje a rota usa a base + itens).
  padrao boolean not null default false,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint price_tables_nome_obrigatorio check (char_length(trim(nome)) > 0),
  constraint price_tables_desconto_faixa check (desconto_pct >= 0 and desconto_pct <= 100)
);

create unique index if not exists price_tables_org_nome_key
  on public.price_tables (organization_id, nome);

-- Uma padrão só: índice único parcial (NULLs não colidem, então o filtro).
create unique index if not exists price_tables_org_padrao_unica
  on public.price_tables (organization_id)
  where padrao is true;

alter table public.price_tables enable row level security;

drop policy if exists price_tables_select on public.price_tables;
create policy price_tables_select on public.price_tables
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists price_tables_write on public.price_tables;
create policy price_tables_write on public.price_tables
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

revoke all on public.price_tables from anon;
grant select, insert, update, delete on public.price_tables to authenticated;
grant all on public.price_tables to service_role;

drop trigger if exists trg_price_tables_updated_at on public.price_tables;
create trigger trg_price_tables_updated_at
  before update on public.price_tables
  for each row execute function public.fn_set_updated_at();

create table if not exists public.price_table_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  price_table_id uuid not null references public.price_tables(id) on delete cascade,
  product_id uuid not null references public.catalog_products(id) on delete cascade,
  -- Preço final nesta tabela. NULL = vale o desconto padrão da tabela.
  preco_cents bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint price_table_items_preco_nao_negativo check (preco_cents is null or preco_cents >= 0)
);

create unique index if not exists price_table_items_tabela_produto_key
  on public.price_table_items (price_table_id, product_id);

create index if not exists price_table_items_org_tabela_idx
  on public.price_table_items (organization_id, price_table_id);

alter table public.price_table_items enable row level security;

drop policy if exists price_table_items_select on public.price_table_items;
create policy price_table_items_select on public.price_table_items
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists price_table_items_write on public.price_table_items;
create policy price_table_items_write on public.price_table_items
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

revoke all on public.price_table_items from anon;
grant select, insert, update, delete on public.price_table_items to authenticated;
grant all on public.price_table_items to service_role;

drop trigger if exists trg_price_table_items_updated_at on public.price_table_items;
create trigger trg_price_table_items_updated_at
  before update on public.price_table_items
  for each row execute function public.fn_set_updated_at();

-- O produto ganha a FK para a categoria (a coluna texto `categoria` fica como
-- legado legível — ver cabeçalho).
alter table public.catalog_products
  add column if not exists categoria_id uuid references public.product_categories(id) on delete set null;

create index if not exists catalog_products_categoria_idx
  on public.catalog_products (organization_id, categoria_id);

comment on table public.product_categories is
  'Árvore de categorias do catálogo (parent_id NULL = raiz). Substitui o texto livre catalog_products.categoria, que fica como legado.';
comment on table public.price_tables is
  'Tabelas de preço (atacado, varejo, cliente X). Preço efetivo: item da tabela > desconto da tabela sobre a base > preço base.';
comment on table public.price_table_items is
  'Sobrescrita de preço por produto dentro de uma tabela. preco NULL = vale o desconto padrão da tabela.';
