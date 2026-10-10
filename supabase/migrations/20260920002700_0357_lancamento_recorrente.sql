-- O lançamento que se repete todo mês.
--
-- Aluguel, internet, contador, salário. No sistema de origem eram três linhas e
-- uma rotina; aqui não havia o conceito, e a saída era a pessoa lançar à mão
-- todo mês — que é a que se esquece em fevereiro e faz o relatório do mês
-- parecer melhor do que foi.
--
-- ═══ A RECORRÊNCIA É UM MOLDE, NUNCA UM LANÇAMENTO ═══
--
-- `recurring_entries` não movimenta dinheiro. Ela descreve o que deve nascer, e
-- quem nasce é uma linha em `financial_entries` com `status = 'pending'`. A
-- separação importa: mudar o valor do aluguel em junho não pode reescrever o que
-- foi pago em maio, e não reescreve — os lançamentos passados já existem e são
-- independentes do molde.
--
-- Nasce PENDENTE, nunca paga. O sistema sabe que a conta vence; ele não sabe se
-- alguém pagou. Marcar como paga automaticamente encheria o caixa de dinheiro
-- que não saiu.
--
-- ═══ A IDEMPOTÊNCIA É DO BANCO ═══
--
-- `financial_entries.recurring_entry_id` + índice único por (molde, data) é o que
-- garante que o cron rodando duas vezes no mesmo dia — ou rodando de novo depois
-- de uma falha no meio — não gere a mesma despesa duas vezes. Uma flag de
-- "último gerado" na tabela do molde resolveria o caso comum e falharia
-- exatamente no que importa: duas execuções simultâneas.
--
-- ═══ DIA 31 ═══
--
-- `day_of_month` vai de 1 a 31, e onze meses do ano não têm todos eles. A regra
-- é: o que não existe cai no ÚLTIMO dia do mês. Pular seria deixar de cobrar o
-- aluguel em fevereiro; antecipar para o dia 1 do mês seguinte mudaria a
-- competência. Quem resolve isso é o cron, e o teste dele cobre fevereiro.

create table if not exists public.recurring_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  name text not null,
  account_id uuid not null references public.financial_accounts(id) on delete restrict,
  account_plan_id uuid references public.account_plans(id) on delete restrict,

  direction text not null check (direction in ('in', 'out')),
  amount_cents bigint not null check (amount_cents > 0),
  currency text not null default 'BRL' check (char_length(currency) = 3),

  -- 1 a 31. O que não existe no mês cai no último dia dele.
  day_of_month integer not null check (day_of_month between 1 and 31),

  -- Inativa-se, não se apaga: o molde explica os lançamentos que ele gerou.
  is_active boolean not null default true,

  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists recurring_entries_org_ativas_idx
  on public.recurring_entries (organization_id)
  where is_active;

alter table public.financial_entries
  add column if not exists recurring_entry_id uuid
  references public.recurring_entries(id) on delete set null;

-- A GARANTIA de que a mesma competência não nasce duas vezes. Parcial porque a
-- imensa maioria dos lançamentos não vem de molde nenhum.
create unique index if not exists financial_entries_recorrencia_competencia_idx
  on public.financial_entries (recurring_entry_id, entry_date)
  where recurring_entry_id is not null;

alter table public.recurring_entries enable row level security;
drop policy if exists tenant_isolation_recurring_entries_all on public.recurring_entries;
create policy tenant_isolation_recurring_entries_all on public.recurring_entries
  for all
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin())
  with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'manager'))
  );
revoke all on public.recurring_entries from anon;

comment on table public.recurring_entries is
  'O molde de um lançamento que se repete todo mês. Não movimenta dinheiro: quem nasce é uma linha pendente em financial_entries. Mudar o molde não reescreve o que já foi gerado.';
comment on column public.recurring_entries.day_of_month is
  'Dia do mês, 1 a 31. O que não existe no mês cai no último dia dele — pular deixaria de cobrar o aluguel em fevereiro.';
