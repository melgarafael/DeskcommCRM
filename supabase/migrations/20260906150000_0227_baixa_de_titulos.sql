-- ============================================================================
-- 0227 — BAIXA DE TÍTULOS (o "pago" das contas a receber)
--
-- `commercial_titulo_baixas`: uma linha por parcela paga (order_id +
-- parcela_n). O título em si continua DERIVADO do pedido (0226 não criou
-- tabela de títulos de propósito); a baixa é o único fato novo que precisa
-- persistir — sem ela, pago/não-pago seria memória de quem cobra.
--
-- RLS molde 0204: leitura org, escrita manager+ (dinheiro é decisão gerencial).
-- ============================================================================

create table if not exists public.commercial_titulo_baixas (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid not null references public.commercial_orders(id) on delete cascade,
  parcela_n integer not null check (parcela_n > 0),
  valor_cents bigint not null check (valor_cents >= 0),
  baixado_por uuid,
  baixado_em timestamptz not null default now(),
  observacao text,
  created_at timestamptz not null default now()
);

-- Uma parcela, uma baixa: pagar duas vezes a mesma parcela é erro de caixa.
create unique index if not exists commercial_titulo_baixas_parcela_key
  on public.commercial_titulo_baixas (organization_id, order_id, parcela_n);

create index if not exists commercial_titulo_baixas_order_idx
  on public.commercial_titulo_baixas (organization_id, order_id);

alter table public.commercial_titulo_baixas enable row level security;

drop policy if exists commercial_titulo_baixas_select on public.commercial_titulo_baixas;
create policy commercial_titulo_baixas_select on public.commercial_titulo_baixas
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists commercial_titulo_baixas_write on public.commercial_titulo_baixas;
create policy commercial_titulo_baixas_write on public.commercial_titulo_baixas
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

revoke all on public.commercial_titulo_baixas from anon;
grant select, insert, update, delete on public.commercial_titulo_baixas to authenticated;
grant all on public.commercial_titulo_baixas to service_role;

comment on table public.commercial_titulo_baixas is
  'Baixa de parcela recebida (o "pago" dos Títulos). Uma parcela, uma baixa.';
