-- ============================================================================
-- 0221 — POLÍTICAS COMERCIAIS (workflow de aprovação e travas da venda)
--
-- Singleton por org: teto de desconto do vendedor, permissão de estoque
-- negativo e comissão padrão. Sem ela, defaults seguros valem (5%, sem
-- negativo): loja nova não nasce liberando tudo por ausência de config.
-- RLS: leitura org, escrita manager+ (política comercial é decisão de dono).
-- ============================================================================

create table if not exists public.commercial_policies (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  -- Desconto (item ou geral) até aqui: vendedor aprova sozinho. Acima: o
  -- pedido cai em `em_analise` sozinho (a rota força) e só gerente aprova.
  desconto_max_vendedor_pct numeric(5, 2) not null default 5,
  -- Estoque pode negativar? false = bloqueia (com override de gerente);
  -- true = vende mesmo sem saldo (vale para sob-encomenda global).
  permite_estoque_negativo boolean not null default false,
  -- Comissão padrão da operação (% sobre o total). NULL = sem comissão
  -- configurada (a tela não mostra estimativa em vez de chutar).
  comissao_padrao_pct numeric(5, 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commercial_policies_desconto_faixa check (
    desconto_max_vendedor_pct >= 0 and desconto_max_vendedor_pct <= 100
  ),
  constraint commercial_policies_comissao_faixa check (
    comissao_padrao_pct is null or (comissao_padrao_pct >= 0 and comissao_padrao_pct <= 100)
  )
);

alter table public.commercial_policies enable row level security;

drop policy if exists commercial_policies_select on public.commercial_policies;
create policy commercial_policies_select on public.commercial_policies
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists commercial_policies_write on public.commercial_policies;
create policy commercial_policies_write on public.commercial_policies
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

revoke all on public.commercial_policies from anon;
grant select, insert, update, delete on public.commercial_policies to authenticated;
grant all on public.commercial_policies to service_role;

drop trigger if exists trg_commercial_policies_updated_at on public.commercial_policies;
create trigger trg_commercial_policies_updated_at
  before update on public.commercial_policies
  for each row execute function public.fn_set_updated_at();

comment on table public.commercial_policies is
  'Trava comercial da org: teto de desconto sem aprovação, estoque negativo e comissão. Sem linha, valem os defaults seguros da DDL.';
