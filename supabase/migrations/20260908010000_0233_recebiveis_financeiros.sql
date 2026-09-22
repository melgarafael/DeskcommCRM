-- ============================================================================
-- 0233 — RECEBÍVEIS FINANCEIROS (contas a receber como entidade)
--
-- `financial_receivables`: uma linha por parcela a receber (order_id +
-- parcela_n). `financial_payments`: cada recebimento (parcial ou integral).
--
-- Por que DUAS tabelas novas se já existe `commercial_titulo_baixas` (0227)?
-- A baixa grava UM recebimento por parcela (UNIQUE por parcela) — recebimento
-- parcial, estorno parcial e "pago maior que saldo" não cabem nela. Em vez de
-- alargar a baixa e quebrar a tela de Títulos (que continua lendo pedidos +
-- baixas sem mudar nada), o recebível nasce ao lado, com o vínculo opcional
-- (`invoice_id` nulo = financeiro sem NF, regra do produto) e geração
-- idempotente (unique parcial). Pagamentos múltiplos por recebível, com o
-- teto (soma <= original) garantido no serviço + testes, porque CHECK não
-- atravessa linhas.
--
-- Desvios do molde 0204, declarados: `order_id`/`contact_id`/`invoice_id` são
-- NULLABLE com `on delete set null` (apagar pedido/contato não pode apagar o
-- financeiro — é a trilha de conciliação); status gravado é só
-- aberto/parcial/pago/cancelado, e VENCIDO é derivado (vencimento < hoje com
-- saldo > 0), para não precisar de cron varrendo a tabela todo dia.
--
-- RLS molde 0204: leitura org, escrita manager+ (dinheiro é decisão gerencial).
-- ============================================================================

create table if not exists public.financial_receivables (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid references public.commercial_orders(id) on delete set null,
  invoice_id uuid references public.invoices(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  parcela_n integer not null check (parcela_n > 0),
  total_parcelas integer not null check (total_parcelas > 0),
  valor_original_cents bigint not null check (valor_original_cents >= 0),
  vencimento date not null,
  status text not null default 'aberto'
    check (status in ('aberto', 'parcial', 'pago', 'cancelado')),
  forma_pagamento text,
  observacoes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotência da geração: o mesmo (pedido, parcela) nunca vira dois
-- recebíveis, nem com duplo clique nem com retry. Manual (order_id nulo) não
-- tem de onde colidir — fica sem a trava, com auditoria cobrindo.
create unique index if not exists financial_receivables_pedido_parcela_key
  on public.financial_receivables (organization_id, order_id, parcela_n)
  where order_id is not null;

create index if not exists financial_receivables_contato_idx
  on public.financial_receivables (organization_id, contact_id);
create index if not exists financial_receivables_vencimento_idx
  on public.financial_receivables (organization_id, vencimento);
create index if not exists financial_receivables_status_idx
  on public.financial_receivables (organization_id, status);
create index if not exists financial_receivables_pedido_idx
  on public.financial_receivables (organization_id, order_id);

create table if not exists public.financial_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  receivable_id uuid not null references public.financial_receivables(id) on delete cascade,
  valor_cents bigint not null check (valor_cents > 0),
  pago_em timestamptz not null default now(),
  forma_pagamento text,
  conta text,
  observacao text,
  -- Retry/duplo-clique: o cliente gera e reenvia a mesma chave; a segunda
  -- tentativa vira o pagamento original em vez de duplicar (409 não, 200 com
  -- o existente — retry cego não pode nem falhar nem duplicar).
  idempotency_key text,
  created_by uuid,
  created_at timestamptz not null default now()
);

create unique index if not exists financial_payments_idem_key
  on public.financial_payments (organization_id, receivable_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists financial_payments_recebivel_idx
  on public.financial_payments (organization_id, receivable_id);

alter table public.financial_receivables enable row level security;
alter table public.financial_payments enable row level security;

drop policy if exists financial_receivables_select on public.financial_receivables;
create policy financial_receivables_select on public.financial_receivables
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists financial_receivables_write on public.financial_receivables;
create policy financial_receivables_write on public.financial_receivables
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

drop policy if exists financial_payments_select on public.financial_payments;
create policy financial_payments_select on public.financial_payments
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists financial_payments_write on public.financial_payments;
create policy financial_payments_write on public.financial_payments
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

revoke all on public.financial_receivables from anon;
grant select, insert, update, delete on public.financial_receivables to authenticated;
grant all on public.financial_receivables to service_role;

revoke all on public.financial_payments from anon;
grant select, insert, update, delete on public.financial_payments to authenticated;
grant all on public.financial_payments to service_role;

comment on table public.financial_receivables is
  'Conta a receber por parcela (com ou sem NF — invoice_id nulo é estado válido). Status gravado sem "vencido", que é derivado.';
comment on table public.financial_payments is
  'Recebimento por evento (parcial ou integral). Teto soma <= original garantido no serviço.';
