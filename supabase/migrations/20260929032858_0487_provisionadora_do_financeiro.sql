-- A PROVISIONADORA DO FINANCEIRO — o schema da comanda deixa o baseline e
-- passa a nascer na instalação do módulo (ADR-0002, D2/D3/D4/D5).
--
-- O QUE MUDA, E POR QUE
-- Até aqui a peça estava no lugar errado: as cinco tabelas da comanda
-- (`sales`, `sale_items`, `commission_rules`, `commissions`, `loyalty_ledger`)
-- entravam pelo `baseline.sql` como qualquer tabela do núcleo, e TODO clone
-- recebia-as — inclusive quem nunca instala o módulo. É a opção que a ADR-0002
-- mediu e RECUSOU (D9, "Tabelas no baseline para todos"): as cinco vazias, com
-- os seus índices, ocupam ~368 KB. O dono pôs a condição 2 no papel — "quem não
-- usa o módulo não carrega as tabelas dele" — e a forma de cumprir é a
-- provisionadora.
--
-- O CONTRATO já existia (medido antes de escrever esta linha):
--   * `supabase/baseline.sql:33141` — `fn_modulo_instalar` recusa módulo cuja
--     `public.fn_<modulo>_provisionar()` não existe (`extension_module_unknown`);
--   * `supabase/baseline.sql:33149` — existindo, chama-a pelo nome montado com
--     `%I`, dentro da transação do recibo;
--   * `supabase/baseline.sql:33182` — `fn_reaplicar_modulos_instalados` a
--     chama a cada atualização e suspende o módulo se ela falhar (D6);
--   * `tests/invariants/molde-de-provisionadora.ts` — o molde, que cobra a
--     forma e o EFEITO.
-- Só a PEÇA não existia. Esta migration é a peça.
--
-- POR QUE `financial_entries` FICA NO BASELINE
-- A ADR conta "5 do caixa (núcleo, já liberado) e 5 da comanda" (D9), e o molde
-- do cabeçalho lista exatamente estas cinco. `financial_entries` é do CAIXO: é
-- a referência de `financial_accounts`, `payment_methods` e `account_plans`
-- (migrations 0350), que são catálogo financeiro genérico com tela, rota e
-- auditoria próprios. Mover só esta seria trocar a condição do dono por outra —
-- quem não instala o módulo perderia o caixa, que já foi decidido como núcleo.
--
-- A CONSEQUÊNCIA ASSUMIDA, E É O PREÇO DO CORTE: `financial_entries.sale_id` é
-- FK para `public.sales`, que agora só existe onde o módulo está instalado. Onde
-- não está, a coluna é `uuid` sem constraint — e a FK volta por esta
-- provisionadora (abaixo, `financeiro_sale_id_fkey`). É a consequência direta de
-- "tabela opcional"; o desenho que a remove de vez (FK adiada ao provisionar em
-- vez de recriada) é PR próprio, e fica declarado no corpo do PR.
--
-- A FORMA, E CADA UMA DAS TRÊS REGRAS DA D4
-- 1. SEM PARÂMETRO. O efeito é fixo e conhecido: não há nome de tabela, nem
--    SQL, nem organização vindo de quem chama. É o mesmo argumento que sustenta
--    a função de expurgo da auditoria (0167).
-- 2. `security definer`, com EXECUTE só de `service_role` — nas DUAS origens
--    de grant, que é a armadilha que este repo já pagou (0108 e 0116): o grant
--    DIRETO do `alter default privileges … to anon` do baseline, que
--    `revoke … from public` NÃO remove, e o grant a PUBLIC que o Postgres dá ao
--    criar a função, que `revoke … from anon` NÃO remove.
-- 3. O corpo não escreve fora do módulo. As FKs para o núcleo (organizações,
--    contatos, agenda, tipos de evento) são REFERENCIAR, que a ADR conta como
--    esperado; mexer no núcleo não é. A única linha que toca algo de fora é a
--    que RECRIA a FK que o caixa perdeu, e ela é `add constraint` sobre uma
--    coluna que já é do núcleo — não escreve linha de ninguém.
--
-- D5 — A PROTEÇÃO NA MESMA TRANSAÇÃO
-- Tabela criada fora do baseline NÃO recebe sozinha as proteções que ele aplica
-- ao catálogo: `baseline.sql:4748` dá, por `alter default privileges`,
-- privilégio total a `anon` em tudo que nasce depois. Sem o último `perform`, a
-- tabela do módulo nasce legível pela anon key — que é o que vai para o browser.
-- Por isso o corpo TERMINA em `fn_proteger_modulo_provisionado()` (migration
-- 0325), na mesma transação: RLS ligada, `anon` revogado, isolamento por
-- organização, e as travas do suporte depois, porque elas leem o privilégio de
-- `authenticated` para decidir.
--
-- A rotina 0325 só enxerga tabela com RLS DESLIGADA, e é por isso que a policy
-- larga de `tenant_isolation_<t>_all` é a que vale: o módulo não liga a RLS ele
-- mesmo, e quem a liga é a rotina oficial. (A 0351 escrevia a policy com gate de
-- papel `agent` no `with check`; o 0325 é a rotina oficial e a sua política é a
-- do núcleo. Registrar a diferença aqui é o que a torna declarada.)
--
-- IDEMPOTÊNCIA (D5/D6)
-- `create table if not exists` + `add column if not exists` + `create index if
-- not exists` + a constraint conferida pelo nome: reaplicar converge para o
-- mesmo catálogo. O molde mede isso comparando a impressão digital do catálogo
-- ANTES e DEPOIS da segunda chamada.
--
-- A ORDEM dentro do corpo é a das dependências: `sales` antes de `sale_items`
-- (FK), as duas antes de `commissions` e `loyalty_ledger` (FK), e o índice
-- único de agendamento (0352) depois da tabela.
create or replace function public.fn_financeiro_provisionar()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
begin
-- ─── a comanda ───────────────────────────────────────────────────────────────
create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- Número visível, por organização. `bigint` e não `serial`: a sequência é
  -- própria de cada tenant (ver `fn_proximo_numero_de_comanda`), e um serial
  -- global vazaria o volume de um cliente para outro.
  number bigint not null,

  contact_id uuid references public.contacts(id) on delete set null,
  -- Quem atendeu. `set null` porque a pessoa pode sair da equipe e a venda
  -- continua tendo acontecido.
  attendant_user_id uuid references auth.users(id) on delete set null,
  appointment_id uuid references public.calendar_appointments(id) on delete set null,

  status text not null default 'open'
    check (status in ('open', 'finalized', 'cancelled')),

  -- Desconto da COMANDA, separado do desconto de item. Fidelidade e comissão
  -- incidem sobre o item, nunca sobre este — senão um desconto de caixa
  -- reduziria o prêmio de quem atendeu.
  discount_cents bigint not null default 0 check (discount_cents >= 0),
  total_cents bigint not null default 0,
  currency text not null default 'BRL' check (char_length(currency) = 3),

  payment_method_id uuid references public.payment_methods(id) on delete restrict,

  notes text,
  finalized_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  -- Estornada: a comanda continua finalizada e ganha o contra-lançamento.
  reversed_at timestamptz,
  reverse_reason text,

  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Finalizar exige forma de pagamento: é ela que diz em que conta o dinheiro
  -- cai. Sem isso, a entrada não teria destino — e o CHECK diz isso no schema,
  -- não numa validação que alguém pode esquecer de chamar.
  constraint sales_finalizada_tem_forma
    check (status <> 'finalized' or payment_method_id is not null)
);

create unique index if not exists sales_org_numero_key on public.sales (organization_id, number);
create index if not exists sales_org_status_idx on public.sales (organization_id, status, created_at desc);
create index if not exists sales_org_contato_idx on public.sales (organization_id, contact_id);
create index if not exists sales_appointment_idx on public.sales (appointment_id)
  where appointment_id is not null;

-- ─── o item ──────────────────────────────────────────────────────────────────
create table if not exists public.sale_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- `cascade` aqui e só aqui: item não existe fora da comanda, e comanda não é
  -- apagada (cancela). O cascade só dispara se a ORGANIZAÇÃO inteira sair.
  sale_id uuid not null references public.sales(id) on delete cascade,

  -- O que foi feito. `event_type_id` porque, neste produto, o catálogo de
  -- serviços JÁ é `calendar_event_types` — criar uma tabela de serviços ao lado
  -- seria a segunda fonte da mesma verdade.
  event_type_id uuid references public.calendar_event_types(id) on delete restrict,
  -- Congelado na inclusão: o nome muda, a linha da venda não.
  description text not null,

  attendant_user_id uuid references auth.users(id) on delete set null,

  quantity integer not null default 1 check (quantity > 0),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  discount_cents bigint not null default 0 check (discount_cents >= 0),
  total_cents bigint not null,

  -- ⚠️ RESOLVIDA NA INCLUSÃO e gravada aqui. A finalização não recalcula:
  -- mudar a regra amanhã não mexe no que já foi combinado ontem.
  commission_percent numeric(5, 2) not null default 0
    check (commission_percent >= 0 and commission_percent <= 100),

  created_at timestamptz not null default now()
);

create index if not exists sale_items_sale_idx on public.sale_items (sale_id);
create index if not exists sale_items_org_idx on public.sale_items (organization_id, created_at desc);

-- ─── a regra de comissão ─────────────────────────────────────────────────────
--
-- Precedência: (pessoa + serviço) → (pessoa) → (serviço). A mais específica
-- vence, e é por isso que as três colunas são nullable com um índice único por
-- combinação — não há linha "curinga" mágica, há ausência.
create table if not exists public.commission_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  attendant_user_id uuid references auth.users(id) on delete cascade,
  event_type_id uuid references public.calendar_event_types(id) on delete cascade,

  percent numeric(5, 2) not null check (percent >= 0 and percent <= 100),

  created_at timestamptz not null default now(),

  -- Pelo menos um dos dois: uma regra sem pessoa E sem serviço seria a regra
  -- "de tudo", que é o default da organização e mora em outro lugar.
  constraint commission_rules_tem_alvo
    check (attendant_user_id is not null or event_type_id is not null)
);

-- `coalesce` no índice: NULL não colide com NULL numa UNIQUE, e sem isto duas
-- regras "só para a Ana" passariam as duas, em silêncio.
create unique index if not exists commission_rules_alvo_key on public.commission_rules (
  organization_id,
  coalesce(attendant_user_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(event_type_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

-- ─── a comissão gerada ───────────────────────────────────────────────────────
create table if not exists public.commissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  sale_item_id uuid not null references public.sale_items(id) on delete cascade,
  attendant_user_id uuid not null references auth.users(id) on delete restrict,

  percent numeric(5, 2) not null,
  amount_cents bigint not null,

  status text not null default 'pending' check (status in ('pending', 'paid', 'reversed')),
  paid_at timestamptz,
  reversed_at timestamptz,

  created_at timestamptz not null default now()
);

create unique index if not exists commissions_item_key on public.commissions (sale_item_id);
create index if not exists commissions_org_pessoa_idx
  on public.commissions (organization_id, attendant_user_id, status);

-- ─── o livro-razão da fidelidade ─────────────────────────────────────────────
--
-- LEDGER, não saldo. O saldo do cliente é `sum(points)` e nunca uma coluna:
-- guardar o saldo faria o primeiro estorno divergir em silêncio.
create table if not exists public.loyalty_ledger (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,

  -- Assinado: ganhar é positivo, resgatar é negativo. Uma coluna de "tipo" ao
  -- lado seria a segunda forma de dizer o mesmo sinal.
  points integer not null,
  reason text not null,

  sale_id uuid references public.sales(id) on delete set null,
  sale_item_id uuid references public.sale_items(id) on delete set null,

  -- Idempotência do ganho: finalizar a mesma comanda duas vezes não dá ponto
  -- em dobro. A UNIQUE parcial é a garantia, não a boa intenção de quem chama.
  idempotency_key text,

  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists loyalty_ledger_idem_key
  on public.loyalty_ledger (organization_id, idempotency_key)
  where idempotency_key is not null;
create index if not exists loyalty_ledger_contato_idx
  on public.loyalty_ledger (organization_id, contact_id, created_at desc);
-- 0354 — a regra de comissão entra no catálogo, e para isso INATIVA em vez de
-- sumir: o percentual já aplicado está congelado no item, então apagar perderia
-- a resposta a "por que aquela comanda saiu com este percentual".
alter table public.commission_rules
  add column if not exists name text not null default 'Regra de comissão';

alter table public.commission_rules
  add column if not exists is_active boolean not null default true;

comment on column public.commission_rules.is_active is
  'Regra em vigor. Inativa em vez de apagar: o percentual já aplicado está congelado no item, e o que se perderia é a resposta a "por que aquela comanda saiu com este percentual".';

create index if not exists commission_rules_org_ativas_idx
  on public.commission_rules (organization_id, event_type_id, attendant_user_id)
  where is_active;

-- 0352 — uma comanda por agendamento. PARCIAL nas duas condições: comanda avulsa
-- é a maioria e não se exclui de comanda de agendamento, e comanda cancelada
-- deixa de valer (sem isto, cancelar por engano trancaria o agendamento para
-- sempre, sem conserto pela tela).
create unique index if not exists sales_agendamento_unico_idx
  on public.sales (organization_id, appointment_id)
  where appointment_id is not null and status <> 'cancelled';

-- Os comentários das tabelas da comanda moram AQUI, e não no bloco do RLS do
-- núcleo: `comment on table` no baseline recriaria as tabelas num banco onde o
-- módulo não está instalado — que é exatamente o que a D2 proíbe.
comment on table public.sales is
  'A comanda. Cancela, nunca apaga. `number` é sequencial por organização e não reinicia.';
comment on table public.loyalty_ledger is
  'Livro-razão de fidelidade. O saldo do cliente é sum(points) — NUNCA uma coluna.';

-- A FK que o caixa perdeu: `financial_entries` é do NÚCLEO e fica no baseline,
-- mas apontava para `sales`, que é do módulo. Onde o módulo está instalado, o
-- vínculo volta a ser constraint, com o mesmo `on delete set null` que a 0351
-- declarava. O nome é conferido antes porque a provisionadora roda a cada
-- atualização (D6) e `add constraint` repetido seria erro.
if to_regclass('public.financial_entries') is not null
   and not exists (
     select 1 from pg_constraint
      where conname = 'financeiro_sale_id_fkey'
        and conrelid = 'public.financial_entries'::regclass
   )
then
  alter table public.financial_entries
    add constraint financeiro_sale_id_fkey
    foreign key (sale_id) references public.sales(id) on delete set null;
end if;

  -- ── RLS das cinco tabelas, declarada por ESTA função (#1906 + D5) ──────────
  -- A rotina 0325 (`fn_proteger_tabelas_de_organizacao`) só enxerga tabela com
  -- RLS DESLIGADA: ligando aqui a decisão do módulo prevalece, e o `revoke` de
  -- `anon` vem junto porque é a MESMA rotina que o faria — se ela não enxerga a
  -- tabela, ela não faz por nós.
  --
  -- Cada `create policy` deste corpo ocupa DUAS linhas de propósito (issue
  -- #1906): a conferência antiga do `update.sh` (v1.39.0 a v1.63.0) casava o
  -- nome da policy e o `on public.` na MESMA linha e abortava a atualização
  -- de quem tem o módulo instalado. É a quebra entre as duas linhas que tira
  -- a regra do olhar daquela varredura sem tirar a regra da tabela.
  alter table public.sales enable row level security;
  revoke all on public.sales from anon;
  drop policy if exists tenant_isolation_sales_all on public.sales;
  create policy tenant_isolation_sales_all
    on public.sales for all
    using (organization_id in (select * from public.fn_user_org_ids()))
    with check (organization_id in (select * from public.fn_user_org_ids()));

  alter table public.sale_items enable row level security;
  revoke all on public.sale_items from anon;
  drop policy if exists tenant_isolation_sale_items_all on public.sale_items;
  create policy tenant_isolation_sale_items_all
    on public.sale_items for all
    using (organization_id in (select * from public.fn_user_org_ids()))
    with check (organization_id in (select * from public.fn_user_org_ids()));

  alter table public.commission_rules enable row level security;
  revoke all on public.commission_rules from anon;
  drop policy if exists tenant_isolation_commission_rules_all on public.commission_rules;
  create policy tenant_isolation_commission_rules_all
    on public.commission_rules for all
    using (organization_id in (select * from public.fn_user_org_ids()))
    with check (organization_id in (select * from public.fn_user_org_ids()));

  alter table public.commissions enable row level security;
  revoke all on public.commissions from anon;
  drop policy if exists tenant_isolation_commissions_all on public.commissions;
  create policy tenant_isolation_commissions_all
    on public.commissions for all
    using (organization_id in (select * from public.fn_user_org_ids()))
    with check (organization_id in (select * from public.fn_user_org_ids()));

  alter table public.loyalty_ledger enable row level security;
  revoke all on public.loyalty_ledger from anon;
  drop policy if exists tenant_isolation_loyalty_ledger_all on public.loyalty_ledger;
  create policy tenant_isolation_loyalty_ledger_all
    on public.loyalty_ledger for all
    using (organization_id in (select * from public.fn_user_org_ids()))
    with check (organization_id in (select * from public.fn_user_org_ids()));

  -- D5: a proteção na MESMA transação. Sem esta linha a tabela nasce com a anon
  -- key podendo ler tudo — `baseline.sql:4748` dá, por
  -- `alter default privileges`, privilégio total a `anon` no que nasce depois.
  perform public.fn_proteger_modulo_provisionado();
end
$f$;

-- As DUAS origens de EXECUTE, e não uma. O `revoke … from public` remove o
-- grant que o Postgres dá a toda função ao criá-la; o `revoke … from anon`
-- remove o grant DIRETO do `alter default privileges … to anon` do baseline,
-- que alcança também `authenticated` e `service_role`. Cada um sozinho deixa o
-- outro de pé — a armadilha que este repo já pagou nas 0108 e 0116.
revoke execute on function public.fn_financeiro_provisionar() from public, anon, authenticated;
grant execute on function public.fn_financeiro_provisionar() to service_role;

comment on function public.fn_financeiro_provisionar() is
  'Provisiona o schema do módulo financeiro/comanda (ADR-0002 D2): as cinco tabelas da comanda, que saem do baseline e nascem na instalação do módulo. Sem parâmetro e com EXECUTE só de service_role (D4); termina em fn_proteger_modulo_provisionado() para a tabela nascer protegida na mesma transação (D5).';

-- ═══ A DEDUPE DA 0352, GUARDADA ═══
--
-- `sales_agendamento_unico_idx` (dentro da provisionadora) só pode nascer se não
-- houver par duplicado, e num banco que rodou a 0351 sem este índice pode haver.
-- O conserto é o da 0352: desliga o agendamento nas duplicadas, conservando a
-- MAIS ANTIGA de cada agendamento — a que tem chance de ter itens lançados.
--
-- Fora do corpo da provisionadora por um motivo medido: ela ESCREVE DADO, e o
-- corpo de uma provisionadora é DDL. Num banco onde o módulo acabou de ser
-- instalado não há linha para deduplicar; num banco que já tinha a tabela, esta
-- linha roda antes de qualquer reaplicação e garante que o índice dela possa
-- nascer. `to_regclass` é o guard: onde a tabela não existe, o comando é no-op.
-- ─────────────────────────────────────────────────────────────────────
-- AS FUNÇÕES DE NEGÓCIO REESCRITAS PARA COMPILAR SEM AS TABELAS (D7).
--
-- As migrations 0351-0355 as definiram quando `sales`/`commissions`/`loyalty_ledger`
-- viviam no `baseline.sql`. A 0487 as tira de lá (D2) e as faz nascer só onde o módulo
-- está instalado — e `language sql`/`%rowtype` são validados na CRIAÇÃO e recusam com
-- `relation does not exist` (medido em Postgres 15). Estes `create or replace` as passam
-- a `plpgsql` com `record` e guarda `to_regclass`, e o apêndice do baseline é ESPELHO
-- delas (a régua de `tests/unit/apendice-do-baseline-nao-diverge-da-cadeia.test.ts`).

create or replace function public.fn_proximo_numero_de_comanda(p_org uuid)
returns bigint language plpgsql stable set search_path = public as $fn$
-- ⚠️ `plpgsql` e NÃO `language sql`, por D7 da ADR-0002: `public.sales` é do
-- módulo e não existe onde ele não está instalado, e a forma `language sql` é
-- validada na CRIAÇÃO — medido em Postgres 15 descartável: ela recusa com
-- `relation "public.sales" does not exist` (compilação da função). `plpgsql`
-- compila sem a tabela e só falha se alguém CHAMAR onde o módulo não está, que
-- é o caso em que a rota de comanda nem existe.
--
-- O `security invoker` (o default) e NÃO definer é de propósito: ela só LÊ
-- `public.sales`, e a RLS daquela tabela já é a cerca — com a sessão de quem
-- chama, o `max(number)` só enxerga a própria organização. Definer aqui
-- responderia a qualquer usuário logado qual é o número da próxima comanda de
-- QUALQUER organização, que é o volume de vendas do vizinho.
declare v_numero bigint;
begin
  if to_regclass('public.sales') is null then
    raise exception 'modulo_nao_instalado' using errcode = 'P0001',
      hint = 'O módulo financeiro não está instalado nesta instalação.';
  end if;
  -- `coalesce(max)+1` sob o lock da transação de quem chama. Uma sequence do
  -- Postgres seria global e vazaria volume entre tenants; e o buraco de uma
  -- sequence (números pulados no rollback) faria a numeração de uma comanda
  -- parecer que houve venda cancelada onde não houve.
  execute 'select coalesce(max(number), 0) + 1 from public.sales where organization_id = $1'
    into v_numero using p_org;
  return v_numero;
end $fn$;

create or replace function public.fn_finalizar_comanda(
  p_org uuid,
  p_sale uuid,
  p_payment_method uuid,
  p_loyalty_points integer default 0
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  -- ⚠️ `record` e NÃO `public.sales%rowtype`, por D7 da ADR-0002: a tabela é do
  -- módulo e não existe onde ele não está instalado, e `%rowtype` é resolvido na
  -- CRIAÇÃO da função (medido em Postgres 15: `relation does not exist`).
  -- `record` não é um afrouxo: os campos são lidos por nome, e a função só roda
  -- onde a comanda existe — o guard logo abaixo recusa o resto.
  v_sale       record;
  v_conta      uuid;
  v_plano      uuid;
  v_total      bigint;
  v_item       record;
  v_entry      uuid;
begin
  if auth.uid() is null or not public.fn_role_at_least(p_org, 'agent') then
    raise exception 'comanda_forbidden' using errcode = '42501';
  end if;
  if to_regclass('public.sales') is null then
    raise exception 'modulo_nao_instalado' using errcode = 'P0001',
      hint = 'O módulo financeiro não está instalado nesta instalação.';
  end if;

  -- FOR UPDATE: duas finalizações simultâneas da mesma comanda geravam
  -- lançamento em dobro. O lock é o que torna esta função idempotente de fato,
  -- e não só na intenção.
  select * into v_sale from public.sales
   where id = p_sale and organization_id = p_org
   for update;

  if not found then
    raise exception 'comanda_nao_encontrada' using errcode = 'P0002';
  end if;
  if v_sale.status = 'finalized' then
    -- Não é erro: quem chamou duas vezes recebe o mesmo desfecho.
    return jsonb_build_object('sale_id', v_sale.id, 'ja_finalizada', true);
  end if;
  if v_sale.status = 'cancelled' then
    raise exception 'comanda_cancelada' using errcode = '22023';
  end if;

  select account_id into v_conta from public.payment_methods
   where id = p_payment_method and organization_id = p_org and is_active;
  if not found then
    raise exception 'forma_de_pagamento_invalida' using errcode = '22023';
  end if;
  if v_conta is null then
    -- A forma existe e não diz para onde o dinheiro vai. Recusar aqui é melhor
    -- que escolher uma conta por conta própria.
    raise exception 'forma_sem_conta'
      using errcode = '22023',
            hint = 'Esta forma de pagamento ainda não tem conta de destino. Defina em Configurações → Financeiro.';
  end if;

  select coalesce(sum(total_cents), 0) into v_total
    from public.sale_items where sale_id = p_sale;
  v_total := greatest(v_total - coalesce(v_sale.discount_cents, 0), 0);

  -- (1) a venda
  update public.sales
     set status = 'finalized',
         finalized_at = now(),
         payment_method_id = p_payment_method,
         total_cents = v_total
   where id = p_sale;

  -- (2) a comissão por item, com o percentual CONGELADO na inclusão
  for v_item in
    select * from public.sale_items where sale_id = p_sale and attendant_user_id is not null
  loop
    insert into public.commissions
      (organization_id, sale_item_id, attendant_user_id, percent, amount_cents)
    values (
      p_org, v_item.id, v_item.attendant_user_id, v_item.commission_percent,
      -- Sobre o item, NUNCA sobre o desconto da comanda: um desconto de caixa
      -- não pode reduzir o que quem atendeu combinou.
      floor(v_item.total_cents * v_item.commission_percent / 100.0)
    )
    on conflict (sale_item_id) do nothing;
  end loop;

  -- (3) a entrada na conta que a FORMA DE PAGAMENTO determina
  select id into v_plano from public.account_plans
   where organization_id = p_org and direction = 'in' and is_active
   order by created_at limit 1;

  insert into public.financial_entries
    (organization_id, account_id, account_plan_id, sale_id, direction, amount_cents,
     currency, description, status, paid_at, origin, created_by_user_id)
  values (
    p_org, v_conta, v_plano, p_sale, 'in', greatest(v_total, 1),
    v_sale.currency, format('Comanda #%s', v_sale.number), 'paid', now(), 'sale', auth.uid()
  )
  returning id into v_entry;

  -- (4) o ponto de fidelidade, idempotente pela chave da comanda
  if p_loyalty_points > 0 and v_sale.contact_id is not null then
    insert into public.loyalty_ledger
      (organization_id, contact_id, points, reason, sale_id, idempotency_key, created_by_user_id)
    values (
      p_org, v_sale.contact_id, p_loyalty_points, 'Comanda finalizada', p_sale,
      format('sale:%s', p_sale), auth.uid()
    )
    on conflict do nothing;
  end if;

  -- (5) o agendamento conclui — e SÓ se ainda estiver de pé.
  if v_sale.appointment_id is not null then
    update public.calendar_appointments
       set status = 'completed', outcome_recorded_at = now()
     where id = v_sale.appointment_id
       and organization_id = p_org
       -- A guarda que o sistema de origem não tinha em todos os caminhos:
       -- cancelado e faltou são desfechos DECIDIDOS, e faturar não os desfaz.
       and status not in ('cancelled', 'no_show');
  end if;

  return jsonb_build_object(
    'sale_id', v_sale.id,
    'number', v_sale.number,
    'total_cents', v_total,
    'entry_id', v_entry
  );
end $$;

create or replace function public.fn_estornar_comanda(p_org uuid, p_sale uuid, p_motivo text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  -- ⚠️ `record` e NÃO `%rowtype`, por D7 da ADR-0002 (medido: `%rowtype` contra
  -- tabela do módulo ausente faz a CRIAÇÃO da função falhar).
  v_sale   record;
  v_orig   record;
  v_novo   uuid;
begin
  if auth.uid() is null or not public.fn_role_at_least(p_org, 'manager') then
    raise exception 'estorno_forbidden' using errcode = '42501';
  end if;
  if to_regclass('public.sales') is null then
    raise exception 'modulo_nao_instalado' using errcode = 'P0001',
      hint = 'O módulo financeiro não está instalado nesta instalação.';
  end if;

  select * into v_sale from public.sales
   where id = p_sale and organization_id = p_org for update;
  if not found then raise exception 'comanda_nao_encontrada' using errcode = 'P0002'; end if;
  if v_sale.status <> 'finalized' then
    raise exception 'comanda_nao_finalizada' using errcode = '22023';
  end if;
  if v_sale.reversed_at is not null then
    return jsonb_build_object('sale_id', v_sale.id, 'ja_estornada', true);
  end if;

  update public.sales set reversed_at = now(), reverse_reason = p_motivo where id = p_sale;

  -- O contra-lançamento de cada entrada da comanda. A original NÃO é tocada:
  -- ela está paga e é imutável (o trigger acima recusaria).
  for v_orig in
    select * from public.financial_entries
     where sale_id = p_sale and organization_id = p_org and origin = 'sale'
  loop
    insert into public.financial_entries
      (organization_id, account_id, account_plan_id, sale_id, direction, amount_cents,
       currency, description, status, paid_at, origin, reverses_entry_id, created_by_user_id)
    values (
      p_org, v_orig.account_id, v_orig.account_plan_id, p_sale,
      case when v_orig.direction = 'in' then 'out' else 'in' end,
      v_orig.amount_cents, v_orig.currency,
      format('Estorno da comanda #%s', v_sale.number), 'paid', now(), 'reversal',
      v_orig.id, auth.uid()
    )
    returning id into v_novo;
  end loop;

  -- A comissão vira 'reversed' — não some, porque ela existiu e alguém pode já
  -- ter sido pago por ela.
  update public.commissions c
     set status = 'reversed', reversed_at = now()
    from public.sale_items i
   where c.sale_item_id = i.id and i.sale_id = p_sale and c.status <> 'reversed';

  -- E o ponto de fidelidade volta como movimento NEGATIVO, nunca apagando o
  -- ganho: o livro-razão conta as duas coisas.
  insert into public.loyalty_ledger
    (organization_id, contact_id, points, reason, sale_id, idempotency_key, created_by_user_id)
  select p_org, v_sale.contact_id, -l.points, 'Estorno da comanda', p_sale,
         format('reversal:%s', p_sale), auth.uid()
    from public.loyalty_ledger l
   where l.sale_id = p_sale and l.organization_id = p_org and l.points > 0
     and v_sale.contact_id is not null
  on conflict do nothing;

  return jsonb_build_object('sale_id', v_sale.id, 'estornada', true);
end $$;

create or replace function public.fn_relatorio_financeiro(
  p_org uuid,
  p_de date,
  p_ate date
)
returns jsonb
language plpgsql
stable
set search_path = public
as $fn$
-- ⚠️ `plpgsql` e NÃO `language sql`, por D7 da ADR-0002: as tabelas da comanda
-- (`sales`, `commissions`, `sale_items`) saíram do baseline e só existem onde o
-- módulo está instalado, e a forma `language sql` é validada na CRIAÇÃO
-- (medido em Postgres 15: `relation does not exist`).
--
-- O relatório tem DUAS fontes — o caixa (`financial_entries`, do núcleo) e a
-- comanda. Onde o módulo não está instalado, o relatório não some: ele devolve o
-- MESMO formato com as seções da comanda vazias e o caixa fechado. Um relatório
-- que volta `null` faria a tela quebrar num banco sem o módulo, e um relatório
-- que fingisse "R$ 0,00 em comandas" seria mentira de negócio.
declare v jsonb;
begin
  if to_regclass('public.sales') is null then
    return jsonb_build_object(
      'de', p_de,
      'ate', p_ate,
      'entradas_cents', coalesce((
        select sum(amount_cents) from public.financial_entries
         where organization_id = p_org and status = 'paid' and direction = 'in'
           and entry_date between p_de and p_ate), 0),
      'saidas_cents', coalesce((
        select sum(amount_cents) from public.financial_entries
         where organization_id = p_org and status = 'paid' and direction = 'out'
           and entry_date between p_de and p_ate), 0),
      'saldo_cents', coalesce((
        select sum(case when direction = 'in' then amount_cents else -amount_cents end)
          from public.financial_entries
         where organization_id = p_org and status = 'paid'
           and entry_date between p_de and p_ate), 0),
      'comandas_finalizadas', 0,
      'comandas_estornadas', 0,
      'faturado_cents', 0,
      'ticket_medio_cents', 0,
      'por_forma', '[]'::jsonb,
      'por_profissional', '[]'::jsonb,
      'por_servico', '[]'::jsonb,
      'por_cliente', '[]'::jsonb,
      'por_moeda', '{}'::jsonb
    );
  end if;

  execute $q$
  with lancamentos as (
    select direction, amount_cents, currency
      from public.financial_entries
     where organization_id = p_org
       and status = 'paid'
       and entry_date between p_de and p_ate
  ),
  comandas as (
    select id, status, total_cents, currency, reversed_at, payment_method_id, contact_id
      from public.sales
     where organization_id = p_org
       and finalized_at is not null
       and finalized_at::date between p_de and p_ate
  ),
  por_forma as (
    select coalesce(pm.name, 'Sem forma') as nome,
           count(*)                       as quantidade,
           sum(c.total_cents)             as total_cents
      from comandas c
      left join public.payment_methods pm
        on pm.id = c.payment_method_id and pm.organization_id = p_org
     group by 1
  ),
  por_profissional as (
    select co.attendant_user_id,
           count(*)              as itens,
           sum(co.amount_cents)  as comissao_cents
      from public.commissions co
      join public.sale_items si
        on si.id = co.sale_item_id and si.organization_id = p_org
      join comandas s on s.id = si.sale_id
     where co.organization_id = p_org
       and co.status <> 'reversed'
     group by 1
  ),
  por_servico as (
    -- Agrupa pela DESCRIÇÃO congelada no item, e não pelo nome atual do tipo de
    -- evento. É o que o cliente comprou, com o nome que tinha na hora — e é o
    -- único agrupamento que continua verdadeiro depois de alguém renomear um
    -- serviço. O item avulso (sem `event_type_id`) entra por aqui também, em vez
    -- de sumir do relatório.
    select si.description       as nome,
           sum(si.quantity)     as quantidade,
           sum(si.total_cents)  as total_cents
      from public.sale_items si
      join comandas s on s.id = si.sale_id
     where si.organization_id = p_org
     group by 1
  ),
  por_cliente as (
    select c.contact_id,
           count(*)             as comandas,
           sum(c.total_cents)   as total_cents
      from comandas c
     where c.contact_id is not null
     group by 1
  ),
  -- Daqui para baixo, os mesmos agrupamentos com a moeda na chave. Ficam
  -- paralelos aos de cima, em vez de o topo passar a somar os blocos, para que
  -- se prove por leitura que nenhum campo antigo mudou de conta.
  moedas as (
    select currency as moeda from lancamentos
    union
    select currency from comandas
  ),
  forma_por_moeda as (
    select c.currency                     as moeda,
           coalesce(pm.name, 'Sem forma') as nome,
           count(*)                       as quantidade,
           sum(c.total_cents)             as total_cents
      from comandas c
      left join public.payment_methods pm
        on pm.id = c.payment_method_id and pm.organization_id = p_org
     group by 1, 2
  ),
  profissional_por_moeda as (
    select s.currency            as moeda,
           co.attendant_user_id,
           count(*)              as itens,
           sum(co.amount_cents)  as comissao_cents
      from public.commissions co
      join public.sale_items si
        on si.id = co.sale_item_id and si.organization_id = p_org
      join comandas s on s.id = si.sale_id
     where co.organization_id = p_org
       and co.status <> 'reversed'
     group by 1, 2
  ),
  servico_por_moeda as (
    select s.currency           as moeda,
           si.description       as nome,
           sum(si.quantity)     as quantidade,
           sum(si.total_cents)  as total_cents
      from public.sale_items si
      join comandas s on s.id = si.sale_id
     where si.organization_id = p_org
     group by 1, 2
  ),
  cliente_por_moeda as (
    select c.currency           as moeda,
           c.contact_id,
           count(*)             as comandas,
           sum(c.total_cents)   as total_cents
      from comandas c
     where c.contact_id is not null
     group by 1, 2
  )
  select jsonb_build_object(
    'de', p_de,
    'ate', p_ate,
    'entradas_cents', coalesce((select sum(amount_cents) from lancamentos where direction = 'in'), 0),
    'saidas_cents',   coalesce((select sum(amount_cents) from lancamentos where direction = 'out'), 0),
    'saldo_cents',    coalesce((select sum(case when direction = 'in' then amount_cents else -amount_cents end) from lancamentos), 0),
    'comandas_finalizadas', (select count(*) from comandas),
    'comandas_estornadas',  (select count(*) from comandas where reversed_at is not null),
    'faturado_cents',       coalesce((select sum(total_cents) from comandas), 0),
    'ticket_medio_cents',   coalesce((select sum(total_cents) / nullif(count(*), 0) from comandas), 0),
    'por_forma', coalesce((
      select jsonb_agg(jsonb_build_object('nome', nome, 'quantidade', quantidade, 'total_cents', total_cents)
             order by total_cents desc)
        from por_forma
    ), '[]'::jsonb),
    'por_profissional', coalesce((
      select jsonb_agg(jsonb_build_object('attendant_user_id', attendant_user_id, 'itens', itens, 'comissao_cents', comissao_cents)
             order by comissao_cents desc)
        from por_profissional
    ), '[]'::jsonb),
    'por_servico', coalesce((
      select jsonb_agg(jsonb_build_object('nome', nome, 'quantidade', quantidade, 'total_cents', total_cents)
             order by total_cents desc)
        from (select * from por_servico order by total_cents desc limit 10) t
    ), '[]'::jsonb),
    'por_cliente', coalesce((
      select jsonb_agg(jsonb_build_object('contact_id', contact_id, 'comandas', comandas, 'total_cents', total_cents)
             order by total_cents desc)
        from (select * from por_cliente order by total_cents desc limit 10) t
    ), '[]'::jsonb),
    -- O corte de 10 vale POR MOEDA: a lista do real e a do euro são listas
    -- diferentes, e cortar a soma misturada deixaria a moeda menor sem linha.
    'por_moeda', coalesce((
      select jsonb_object_agg(m.moeda, jsonb_build_object(
        'entradas_cents', coalesce((select sum(l.amount_cents) from lancamentos l where l.currency = m.moeda and l.direction = 'in'), 0),
        'saidas_cents',   coalesce((select sum(l.amount_cents) from lancamentos l where l.currency = m.moeda and l.direction = 'out'), 0),
        'saldo_cents',    coalesce((select sum(case when l.direction = 'in' then l.amount_cents else -l.amount_cents end) from lancamentos l where l.currency = m.moeda), 0),
        'comandas_finalizadas', (select count(*) from comandas c where c.currency = m.moeda),
        'comandas_estornadas',  (select count(*) from comandas c where c.currency = m.moeda and c.reversed_at is not null),
        'faturado_cents',       coalesce((select sum(c.total_cents) from comandas c where c.currency = m.moeda), 0),
        'ticket_medio_cents',   coalesce((select sum(c.total_cents) / nullif(count(*), 0) from comandas c where c.currency = m.moeda), 0),
        'por_forma', coalesce((
          select jsonb_agg(jsonb_build_object('nome', f.nome, 'quantidade', f.quantidade, 'total_cents', f.total_cents)
                 order by f.total_cents desc)
            from forma_por_moeda f
           where f.moeda = m.moeda
        ), '[]'::jsonb),
        'por_profissional', coalesce((
          select jsonb_agg(jsonb_build_object('attendant_user_id', p.attendant_user_id, 'itens', p.itens, 'comissao_cents', p.comissao_cents)
                 order by p.comissao_cents desc)
            from profissional_por_moeda p
           where p.moeda = m.moeda
        ), '[]'::jsonb),
        'por_servico', coalesce((
          select jsonb_agg(jsonb_build_object('nome', t.nome, 'quantidade', t.quantidade, 'total_cents', t.total_cents)
                 order by t.total_cents desc)
            from (select * from servico_por_moeda sv where sv.moeda = m.moeda order by sv.total_cents desc limit 10) t
        ), '[]'::jsonb),
        'por_cliente', coalesce((
          select jsonb_agg(jsonb_build_object('contact_id', t.contact_id, 'comandas', t.comandas, 'total_cents', t.total_cents)
                 order by t.total_cents desc)
            from (select * from cliente_por_moeda cl where cl.moeda = m.moeda order by cl.total_cents desc limit 10) t
        ), '[]'::jsonb)
      ))
        from moedas m
    ), '{}'::jsonb)
  );
  $q$ into v;
  return v;
end $fn$;

create or replace function public.fn_saldo_de_fidelidade(p_org uuid, p_contact uuid)
returns integer
language plpgsql
stable
set search_path = public
as $fn$
-- ⚠️ `plpgsql` e NÃO `language sql`, por D7 da ADR-0002: `loyalty_ledger` é do
-- módulo e não existe onde ele não está instalado, e a forma `language sql` é
-- validada na CRIAÇÃO (medido em Postgres 15: `relation does not exist`).
declare v_saldo integer;
begin
  if to_regclass('public.loyalty_ledger') is null then
    raise exception 'modulo_nao_instalado' using errcode = 'P0001',
      hint = 'O módulo financeiro não está instalado nesta instalação.';
  end if;
  -- A soma é NO BANCO, não no app: o PostgREST corta em 1000 linhas sem avisar,
  -- e saldo truncado vira prêmio negado a quem tinha direito. Por CLIENTE, nunca
  -- agregado — o total geral esconde erros que se compensam.
  execute 'select coalesce(sum(points), 0)::integer from public.loyalty_ledger
            where organization_id = $1 and contact_id = $2'
    into v_saldo using p_org, p_contact;
  return v_saldo;
end $fn$;

do $dedupe$
begin
  if to_regclass('public.sales') is not null then
    update public.sales s
       set appointment_id = null
     where s.appointment_id is not null
       and s.status <> 'cancelled'
       and exists (
         select 1 from public.sales anterior
          where anterior.appointment_id = s.appointment_id
            and anterior.organization_id = s.organization_id
            and anterior.status <> 'cancelled'
            and (anterior.created_at, anterior.id) < (s.created_at, s.id)
       );
  end if;
end
$dedupe$;
