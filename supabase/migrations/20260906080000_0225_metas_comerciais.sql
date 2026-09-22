-- ============================================================================
-- 0225 — METAS COMERCIAIS (o denominador do dashboard)
--
-- `commercial_goals`: uma linha por (org, mês, vendedor). `vendedor_user_id`
-- NULL = meta DA LOJA; preenchido = meta individual. Sem ela, "61,5% da meta"
-- seria parâmetro mágico — e parâmetro mágico é controle decorativo.
--
-- Sem ON CONFLICT na rota: a rota lê e escreve por (org, mês, vendedor) com
-- upsert explícito. NULL não colide em unique do Postgres, então são DOIS
-- índices parciais (loja e vendedor), um por regime — mesma técnica da 0205.
--
-- RLS molde 0204: leitura org, escrita manager+ (meta é decisão gerencial).
-- ============================================================================

create table if not exists public.commercial_goals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ano_mes text not null check (ano_mes ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  vendedor_user_id uuid,
  valor_cents integer not null check (valor_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists commercial_goals_loja_key
  on public.commercial_goals (organization_id, ano_mes)
  where vendedor_user_id is null;

create unique index if not exists commercial_goals_vendedor_key
  on public.commercial_goals (organization_id, ano_mes, vendedor_user_id)
  where vendedor_user_id is not null;

create index if not exists idx_commercial_goals_org_mes
  on public.commercial_goals (organization_id, ano_mes);

drop trigger if exists trg_commercial_goals_updated_at on public.commercial_goals;
create trigger trg_commercial_goals_updated_at
  before update on public.commercial_goals
  for each row execute function public.fn_set_updated_at();

alter table public.commercial_goals enable row level security;

drop policy if exists commercial_goals_select on public.commercial_goals;
create policy commercial_goals_select on public.commercial_goals
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists commercial_goals_write on public.commercial_goals;
create policy commercial_goals_write on public.commercial_goals
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

revoke all on public.commercial_goals from anon;
grant select, insert, update, delete on public.commercial_goals to authenticated;
grant all on public.commercial_goals to service_role;

comment on table public.commercial_goals is
  'Meta mensal em centavos por (org, mês). vendedor_user_id NULL = meta da loja; preenchido = meta individual do vendedor.';
comment on column public.commercial_goals.ano_mes is
  'Mês de vigência em YYYY-MM. Sem dia: meta é mensal por definição.';
