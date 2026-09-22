-- ============================================================================
-- 0208 — PEDIDOS COMERCIAIS (o coração do sistema de gestão, ATT.txt Fase 2)
--
-- ─── Por que tabelas NOVAS, e não a `orders` existente
--
-- A mesma razão da 0204 (catálogo): `orders` é ESPELHO da Nuvemshop —
-- `external_id`, `external_provider`, `payload` e `updated_at_remote` significam
-- "o que o sistema remoto disse, e quando". Pedido digitado pelo vendedor, pela
-- IA ou pelo portal B2B teria de inventar os quatro, e um sync futuro da
-- Nuvemshop (upsert por external_id + delete do que sumiu) apagaria pedido
-- interno com um `where` esquecido. Ela fica onde está, como espelho. O que
-- faltava era a tabela dos pedidos que a LOJA possui.
--
-- ─── Desenho
--
-- `commercial_orders`: um pedido interno — número sequencial por tenant
-- (PED-0001), cliente (contato + snapshot para histórico), vendedor, status do
-- ciclo comercial, origem (o badge da tela: ia/vendedor/whatsapp/b2b), totais
-- em `_cents` + moeda (regra do CLAUDE.md), condição de pagamento, frete.
--
-- `commercial_order_items`: um item — produto (FK anulável + snapshot, porque
-- apagar produto do catálogo não pode apagar o que foi vendido), quantidade,
-- preço unitário, desconto %, subtotal.
--
-- `commercial_order_counters`: o próximo número por tenant. Existe porque
-- `MAX(numero)+1` na rota tem janela de corrida (dois vendedores finalizando
-- juntos geram o mesmo número, e um deles toma 409 fantasma). O avanço é
-- atômico: `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`.
--
-- ─── Status: vocabulário FECHADO (CHECK). Origem: ABERTO (sem CHECK)
--
-- Status é máquina de estados do produto (rascunho → ... → entregue, com
-- cancelado fora da linha) — um clone com status legado NÃO deve passar pelo
-- `update.sh` quebrando. Origem é rótulo de exibição (o badge): mesma doutrina
-- da 0204 (`origem` do produto), sem CHECK.
-- ============================================================================

-- ─── Contadores (primeiro: orders referencia ao avançar) ────────────────────

create table if not exists public.commercial_order_counters (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  ultimo_numero integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint commercial_order_counters_ultimo_nao_negativo check (ultimo_numero >= 0)
);

alter table public.commercial_order_counters enable row level security;

drop policy if exists commercial_order_counters_select on public.commercial_order_counters;
create policy commercial_order_counters_select on public.commercial_order_counters
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

-- Escrita da rota via service role (bypass RLS); a policy existe para o mesmo
-- motivo das demais tabelas: PostgREST nunca enxerga sem porta.
drop policy if exists commercial_order_counters_write on public.commercial_order_counters;
create policy commercial_order_counters_write on public.commercial_order_counters
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

revoke all on public.commercial_order_counters from anon;
grant select, insert, update, delete on public.commercial_order_counters to authenticated;
grant all on public.commercial_order_counters to service_role;

-- ─── Pedidos ────────────────────────────────────────────────────────────────

create table if not exists public.commercial_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- Numeração sequencial por tenant (PED-0001 na tela). É o `ultimo_numero`
  -- avançado atomicamente em `commercial_order_counters`, nunca MAX()+1.
  numero integer not null,

  -- Cliente: contato vivo + snapshot para o histórico (o contato pode mudar de
  -- nome/telefone; o pedido impresso não pode).
  contact_id uuid references public.contacts(id) on delete set null,
  cliente_nome text not null,
  cliente_documento text,

  -- Vendedor responsável (assignee humano). NULL = sem dono (fila, ou IA).
  vendedor_user_id uuid references auth.users(id) on delete set null,

  status text not null default 'rascunho',

  -- O badge da tela. Vocabulário ABERTO de propósito (sem CHECK): mesma
  -- doutrina da 0204.
  origem text not null default 'vendedor',

  moeda text not null default 'BRL',
  subtotal_cents bigint not null default 0,
  desconto_cents bigint not null default 0,
  frete_cents bigint not null default 0,
  total_cents bigint not null default 0,

  condicao_pagamento text,
  observacoes text,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint commercial_orders_numero_positivo check (numero > 0),
  constraint commercial_orders_status_valido check (
    status in ('rascunho', 'em_analise', 'aprovado', 'faturado', 'expedido', 'entregue', 'cancelado')
  ),
  constraint commercial_orders_moeda_iso check (moeda ~ '^[A-Z]{3}$'),
  constraint commercial_orders_subtotal_nao_negativo check (subtotal_cents >= 0),
  constraint commercial_orders_desconto_nao_negativo check (desconto_cents >= 0),
  constraint commercial_orders_frete_nao_negativo check (frete_cents >= 0),
  constraint commercial_orders_total_nao_negativo check (total_cents >= 0)
);

-- O número é a identidade dentro da organização.
create unique index if not exists commercial_orders_org_numero_key
  on public.commercial_orders (organization_id, numero);

-- A lista da tela: por status e recência.
create index if not exists commercial_orders_org_status_idx
  on public.commercial_orders (organization_id, status, created_at desc);

-- Pedidos do cliente (ficha 360°).
create index if not exists commercial_orders_org_contact_idx
  on public.commercial_orders (organization_id, contact_id);

-- Carteira do vendedor (dashboard por vendedor).
create index if not exists commercial_orders_org_vendedor_idx
  on public.commercial_orders (organization_id, vendedor_user_id);

alter table public.commercial_orders enable row level security;

drop policy if exists commercial_orders_select on public.commercial_orders;
create policy commercial_orders_select on public.commercial_orders
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

-- Escrita de `agent` para cima: vendedor e IA criam pedido; viewer não.
drop policy if exists commercial_orders_write on public.commercial_orders;
create policy commercial_orders_write on public.commercial_orders
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

revoke all on public.commercial_orders from anon;
grant select, insert, update, delete on public.commercial_orders to authenticated;
grant all on public.commercial_orders to service_role;

drop trigger if exists trg_commercial_orders_updated_at on public.commercial_orders;
create trigger trg_commercial_orders_updated_at
  before update on public.commercial_orders
  for each row execute function public.fn_set_updated_at();

-- ─── Itens ──────────────────────────────────────────────────────────────────

create table if not exists public.commercial_order_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid not null references public.commercial_orders(id) on delete cascade,

  -- Produto vivo (anulável: apagar do catálogo preserva o histórico via
  -- snapshot abaixo) + snapshot imutável do que foi vendido.
  product_id uuid references public.catalog_products(id) on delete set null,
  produto_codigo text not null,
  produto_nome text not null,

  quantidade integer not null,
  preco_unit_cents bigint not null,
  desconto_pct numeric(5, 2) not null default 0,
  subtotal_cents bigint not null,

  posicao integer not null default 0,

  created_at timestamptz not null default now(),

  constraint commercial_order_items_quantidade_positiva check (quantidade > 0),
  constraint commercial_order_items_preco_nao_negativo check (preco_unit_cents >= 0),
  constraint commercial_order_items_desconto_faixa check (desconto_pct >= 0 and desconto_pct <= 100),
  constraint commercial_order_items_subtotal_nao_negativo check (subtotal_cents >= 0)
);

create index if not exists commercial_order_items_order_idx
  on public.commercial_order_items (order_id, posicao);

alter table public.commercial_order_items enable row level security;

drop policy if exists commercial_order_items_select on public.commercial_order_items;
create policy commercial_order_items_select on public.commercial_order_items
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists commercial_order_items_write on public.commercial_order_items;
create policy commercial_order_items_write on public.commercial_order_items
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

revoke all on public.commercial_order_items from anon;
grant select, insert, update, delete on public.commercial_order_items to authenticated;
grant all on public.commercial_order_items to service_role;

comment on table public.commercial_orders is
  'Os pedidos que a LOJA possui — número sequencial por tenant, ciclo rascunho→entregue, origem (badge ia/vendedor/whatsapp/b2b). Distinto de orders, que é ESPELHO da Nuvemshop.';
comment on column public.commercial_orders.numero is
  'Sequencial por organização (PED-0001 na tela). Avançado atomicamente via commercial_order_counters, nunca MAX()+1.';
comment on column public.commercial_orders.origem is
  'O badge da tela: ia | vendedor | whatsapp | b2b. Vocabulário ABERTO (sem CHECK), mesma doutrina da origem do produto (0204).';
comment on table public.commercial_order_items is
  'Itens do pedido comercial, com snapshot de produto (código/nome/preço da venda) para o histórico sobreviver à edição do catálogo.';
