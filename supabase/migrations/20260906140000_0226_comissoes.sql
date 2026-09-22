-- ============================================================================
-- 0226 — COMISSÕES (o que o vendedor leva por pedido)
--
-- Duas peças:
-- 1. `catalog_products.comissao_pct` (NULL = sem comissão): o % mora no
--    PRODUTO, como no Mercos (coluna "Comissão" da grade). NULL, não 0, para
--    distinguir "regra não definida" de "venda sem comissão".
-- 2. `commercial_commission_baixas`: uma linha por pedido quando a comissão é
--    paga ("Dar Baixa" do relatório). Sem ela, o pago/não-pago seria memória
--    de planilha — e planilha não tem RLS.
--
-- RLS molde 0204: leitura org, escrita manager+ (dinheiro é decisão gerencial).
-- ============================================================================

alter table public.catalog_products
  add column if not exists comissao_pct numeric(5, 2);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'catalog_products_comissao_faixa'
  ) then
    alter table public.catalog_products
      add constraint catalog_products_comissao_faixa
      check (comissao_pct is null or (comissao_pct >= 0 and comissao_pct <= 100));
  end if;
end $$;

comment on column public.catalog_products.comissao_pct is
  'Comissão do vendedor em % sobre o item. NULL = produto sem regra (não é 0).';

create table if not exists public.commercial_commission_baixas (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid not null references public.commercial_orders(id) on delete cascade,
  vendedor_user_id uuid,
  valor_cents bigint not null check (valor_cents >= 0),
  baixado_por uuid,
  baixado_em timestamptz not null default now(),
  observacao text,
  created_at timestamptz not null default now()
);

-- Um pedido, uma baixa: segunda baixa seria pagar duas vezes.
create unique index if not exists commercial_commission_baixas_order_key
  on public.commercial_commission_baixas (organization_id, order_id);

create index if not exists commercial_commission_baixas_vendedor_idx
  on public.commercial_commission_baixas (organization_id, vendedor_user_id);

alter table public.commercial_commission_baixas enable row level security;

drop policy if exists commercial_commission_baixas_select on public.commercial_commission_baixas;
create policy commercial_commission_baixas_select on public.commercial_commission_baixas
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists commercial_commission_baixas_write on public.commercial_commission_baixas;
create policy commercial_commission_baixas_write on public.commercial_commission_baixas
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

revoke all on public.commercial_commission_baixas from anon;
grant select, insert, update, delete on public.commercial_commission_baixas to authenticated;
grant all on public.commercial_commission_baixas to service_role;

comment on table public.commercial_commission_baixas is
  'Baixa de comissão paga por pedido (o "Dar Baixa" do relatório). Um pedido, uma baixa.';
