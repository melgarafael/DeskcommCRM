-- O CATÁLOGO FINANCEIRO — a primeira camada do módulo de comanda/financeiro.
--
-- Três tabelas que não guardam dinheiro, só definem PARA ONDE ele vai:
--
--   financial_accounts  onde o dinheiro fica (Caixa, Banco)
--   payment_methods     como o cliente paga — e cada forma APONTA para a conta
--                       em que aquele dinheiro cai
--   account_plans       a classificação contábil do lançamento
--
-- A ordem importa: a forma de pagamento é quem decide em qual conta a entrada
-- é lançada quando uma comanda é finalizada. Sem esta camada, a comanda não tem
-- onde depositar, e é por isso que ela vem primeiro.
--
-- ⚠️ NADA AQUI TEM SALDO GRAVADO. `opening_balance_cents` é o saldo INICIAL —
-- o ponto de partida declarado por quem cadastrou a conta, que não muda com
-- lançamento nenhum. O saldo corrente é sempre DERIVADO por soma, e essa é uma
-- das invariantes do modelo: saldo gravado e lançamentos divergem no primeiro
-- estorno, e a divergência não dá sinal.
--
-- ⚠️ DINHEIRO EM `_cents` + `currency`, como manda o CLAUDE.md. Nunca `numeric`
-- solto: arredondamento de ponto flutuante em dinheiro é defeito que aparece
-- meses depois, num relatório que não fecha por centavos.

-- ─── onde o dinheiro fica ────────────────────────────────────────────────────
create table if not exists public.financial_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  name text not null,
  -- `text` + CHECK e não enum: enum é difícil de estender, e a lista de tipos de
  -- conta cresce com o negócio (carteira digital, aplicação, adquirente).
  kind text not null default 'cash' check (kind in ('cash', 'bank', 'other')),

  opening_balance_cents bigint not null default 0,
  currency text not null default 'BRL' check (char_length(currency) = 3),

  -- Inativa-se, não se apaga: conta com lançamento é história, e apagá-la
  -- deixaria o lançamento órfão ou o levaria junto.
  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists financial_accounts_org_nome_key
  on public.financial_accounts (organization_id, lower(name))
  where is_active;
create index if not exists financial_accounts_org_idx
  on public.financial_accounts (organization_id, is_active);

-- ─── como o cliente paga ─────────────────────────────────────────────────────
create table if not exists public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  name text not null,

  -- ⚠️ `on delete restrict`, e é a decisão desta migration: a forma de pagamento
  -- é quem diz em que conta o dinheiro cai. Apagar a conta em cascata deixaria
  -- formas apontando para o nada e lançamentos futuros sem destino — em
  -- silêncio. `restrict` obriga a inativar a conta, que é o caminho certo.
  account_id uuid references public.financial_accounts(id) on delete restrict,

  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists payment_methods_org_nome_key
  on public.payment_methods (organization_id, lower(name))
  where is_active;
create index if not exists payment_methods_org_idx
  on public.payment_methods (organization_id, is_active);

-- ─── a classificação do lançamento ───────────────────────────────────────────
create table if not exists public.account_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  name text not null,
  -- Entrada ou saída. O sistema de origem tinha TODAS as 17 linhas como
  -- 'debito', inclusive "Serviços" e "Comissão", que são coisas opostas — um
  -- campo que existe e não distingue nada. Aqui ele distingue, e o CHECK
  -- garante que continue distinguindo.
  direction text not null check (direction in ('in', 'out')),

  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists account_plans_org_nome_key
  on public.account_plans (organization_id, lower(name))
  where is_active;
create index if not exists account_plans_org_idx
  on public.account_plans (organization_id, is_active, direction);

-- ─── RLS: as três são tenant-aware e seguem o helper da casa ─────────────────
--
-- Leitura para quem é da organização; escrita para manager+. Dinheiro não é
-- coisa que `agent` configure — quem atende não define plano de contas.
do $$
declare t text;
begin
  foreach t in array array['financial_accounts', 'payment_methods', 'account_plans'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists tenant_isolation_%I_all on public.%I', t, t);
    execute format($f$
      create policy tenant_isolation_%I_all on public.%I
        for all
        using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin())
        with check (
          public.fn_is_platform_admin()
          or (organization_id in (select public.fn_user_org_ids())
              and public.fn_role_at_least(organization_id, 'manager'))
        )
    $f$, t, t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- `updated_at` pelo mesmo trigger que o resto da base usa, se ele existir nesta
-- instalação. `if exists` porque o baseline de um clone antigo pode não tê-lo, e
-- uma migration que falha por causa de carimbo de data é migration que trava
-- atualização por nada.
do $$
declare t text;
begin
  if exists (select 1 from pg_proc where proname = 'fn_touch_updated_at') then
    foreach t in array array['financial_accounts', 'payment_methods', 'account_plans'] loop
      execute format('drop trigger if exists trg_%I_touch on public.%I', t, t);
      execute format(
        'create trigger trg_%I_touch before update on public.%I for each row execute function public.fn_touch_updated_at()',
        t, t);
    end loop;
  end if;
end $$;

comment on table public.financial_accounts is
  'Onde o dinheiro fica. `opening_balance_cents` é o saldo INICIAL declarado; o saldo corrente é sempre derivado por soma dos lançamentos, nunca gravado.';
comment on table public.payment_methods is
  'Como o cliente paga. `account_id` decide em qual conta a entrada cai quando a comanda é finalizada.';
comment on table public.account_plans is
  'Classificação do lançamento, com direção (in/out) que o sistema de origem tinha e não usava.';
