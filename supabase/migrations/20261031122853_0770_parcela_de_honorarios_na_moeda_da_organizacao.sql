-- manifest: **A parcela de honorários vira linha de dinheiro completa: ganha `currency` própria (#3379).** `honorarios_parcelas` nasceu com `valor_cents` e sem unidade, e `app/app/honorarios/_parcelas.tsx` escrevia `formatCents(valor_cents, "BRL")` com a moeda fixa: numa organização em dólar, a parcela de `1,300` aparecia `R$ 1.300,00` — o número certo com o rótulo de outra moeda. A coluna entra no corpo de `fn_honorarios_provisionar()` (`text not null default 'BRL'` + CHECK de 3 caracteres; o default é o backfill de quem já tem o módulo instalado, e converter linha antiga está fora do escopo da issue) e um bloco `do` guardado por `to_regclass` aplica a MESMA coluna em instalação que já provisionou — sem ele, `update.sh` deixaria as parcelas existentes sem a coluna e a rota nova quebraria no insert. `fn_honorarios_parcela_pagar` passa a gravar `v_parcela.currency` no `financial_entries` que ela cria (a coluna tem `default 'BRL'`, então sem isso o pagamento de parcela em dólar entrava no caixa em real). A rota de criação resolve `organizations.currency` no SERVIDOR (`moedaDaOrganizacao`), nunca do corpo. Idempotente; apêndice espelhado no `baseline.sql` (corpos editados no lugar, cura no fim do arquivo); `MANIFEST.md` é histórico e não recebe linha.

-- 0770 — a parcela de honorários nasce na moeda da organização (#3379).
--
-- ─── O defeito ─────────────────────────────────────────────────────────────
--
-- `honorarios_parcelas` só tinha `valor_cents`. Toda parcela de toda
-- organização era exibida em BRL pela tela, qualquer que fosse a moeda do
-- negócio: numa organização em dólar, `1,300` digitado (que já virava 130000
-- centavos depois do #3378) aparecia como `R$ 1.300,00`. O valor certo com o
-- rótulo de outra unidade é pior do que um valor errado, porque parece certo.
--
-- ─── Por que COLUNA, e não herdar a moeda na leitura ───────────────────────
--
-- A issue deixa a decisão aberta ("coluna própria ou herdar a moeda do
-- contrato/organização, doutrina DIRC"). Herdar na leitura é mais barato e
-- mente: a moeda de uma linha de dinheiro é FATO dela, e é assim em
-- `financial_entries.currency`, `sales.currency`, `recurring_entries.currency`
-- e `financial_accounts.currency`. Quem lesse `organizations.currency` no
-- render veria as parcelas antigas mudarem de unidade no dia em que a
-- organização trocasse de moeda — o histórico se reescrevendo sozinho.
--
-- ─── O que entra ───────────────────────────────────────────────────────────
--
--   1. `honorarios_parcelas.currency text not null default 'BRL'`, com CHECK de
--      3 caracteres (a MESMA régua das outras colunas de moeda do caixa).
--      `default 'BRL'` é o backfill declarado: toda parcela que existe hoje
--      nasceu em BRL (é o que a tela mostrava e o que o `financial_entries` do
--      pagamento gravava). Converter linha antiga está fora do escopo da issue.
--   2. `fn_honorarios_provisionar()` recriada com a coluna no `create table`,
--      para instalação NOVA nascer com ela.
--   3. Um bloco `do` guardado por `to_regclass`: instalação que JÁ provisionou
--      o módulo recebe a coluna no `update.sh` (que re-aplica este arquivo). É
--      `add column if not exists` + `drop constraint if exists` + `add
--      constraint`, então roda quantas vezes for.
--   4. `fn_honorarios_parcela_pagar()` recriada: o `financial_entries` que ela
--      cria passa a levar `v_parcela.currency`. Sem isso, a parcela em dólar
--      entrava no caixa em real e caía no bloco BRL do relatório.
--
-- ─── O que NÃO muda ────────────────────────────────────────────────────────
--
-- RLS, grants e as assinaturas das funções ficam como estão: nada aqui abre
-- porta. `honorarios_contratos` segue sem coluna de moeda (o `valor_fixo_cents`
-- do contrato tem o mesmo defeito de rótulo e é assunto de outra issue).
--
-- ─── Reaplicação ───────────────────────────────────────────────────────────
--
-- `create or replace function` nas duas; o bloco `do` só age onde a tabela
-- existe (módulo instalado) e é feito de `if not exists` / `drop ... if exists`.

-- ---- 1 e 3: a coluna no provisionamento e a cura de quem já instalou --------

create or replace function public.fn_honorarios_provisionar()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
begin
  create table if not exists public.honorarios_contratos (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,

    -- Preservado mesmo se o lead for excluído (mesma decisão de
    -- `financial_entries.sale_id`): o contrato é registro financeiro e sobrevive
    -- à linha operacional que o originou.
    lead_id uuid references public.crm_leads(id) on delete set null,

    -- `text` + CHECK, não enum (doutrina: enum é difícil de estender).
    modelo text not null check (modelo in ('fixo', 'exito', 'misto')),

    valor_fixo_cents bigint check (valor_fixo_cents is null or valor_fixo_cents > 0),
    percentual_exito numeric(5,2) check (percentual_exito is null or (percentual_exito > 0 and percentual_exito <= 100)),
    repasse_advogado_pct numeric(5,2) check (repasse_advogado_pct is null or (repasse_advogado_pct >= 0 and repasse_advogado_pct <= 100)),

    -- Modelo declara o campo que faz sentido: fixo pede valor, êxito pede
    -- percentual, misto pede os dois. Não impede o resto de ficar em branco.
    constraint honorarios_contratos_modelo_tem_o_campo check (
      (modelo = 'fixo' and valor_fixo_cents is not null)
      or (modelo = 'exito' and percentual_exito is not null)
      or (modelo = 'misto' and valor_fixo_cents is not null and percentual_exito is not null)
    ),

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  create index if not exists honorarios_contratos_org_idx
    on public.honorarios_contratos (organization_id);
  create index if not exists honorarios_contratos_lead_idx
    on public.honorarios_contratos (organization_id, lead_id) where lead_id is not null;

  create table if not exists public.honorarios_parcelas (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    contrato_id uuid not null references public.honorarios_contratos(id) on delete cascade,

    numero integer not null check (numero > 0),
    vencimento date not null,
    valor_cents bigint not null check (valor_cents > 0),

    -- A MOEDA DA PARCELA (#3379). Linha de dinheiro carrega a sua unidade, como
    -- `financial_entries.currency` e `sales.currency`: herdar
    -- `organizations.currency` na hora de LER faria o histórico inteiro mudar de
    -- rótulo no dia em que a organização trocasse de moeda. O default é o
    -- backfill das parcelas que já existem (todas nasceram sem coluna, e o
    -- `financial_entries` delas nasceu em BRL).
    currency text not null default 'BRL' check (char_length(currency) = 3),

    -- Preservada mesmo se o lançamento do caixa for desfeito — a MESMA decisão
    -- de `financial_entries.sale_id`: o link é conveniência de navegação, nunca
    -- a fonte da verdade do valor ou da data.
    financial_entry_id uuid references public.financial_entries(id) on delete set null,

    status text not null default 'pendente' check (status in ('pendente', 'pago', 'atrasado')),

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint honorarios_parcelas_numero_unico unique (contrato_id, numero)
  );

  create index if not exists honorarios_parcelas_org_idx
    on public.honorarios_parcelas (organization_id);
  create index if not exists honorarios_parcelas_contrato_idx
    on public.honorarios_parcelas (organization_id, contrato_id);
  create index if not exists honorarios_parcelas_vencimento_idx
    on public.honorarios_parcelas (organization_id, vencimento) where status = 'pendente';

  -- ── RLS POR OPERAÇÃO (D5, ligada aqui e não pela rotina automática) ────────
  -- Molde da 0464 (propostas): uma policy por operação, espelhando as ROTAS,
  -- porque o PostgREST é porta tão aberta quanto elas (o JWT da sessão fala com
  -- ele direto; ver 0150) e o baseline dá GRANT ALL a `authenticated`.
  --   SELECT  qualquer papel da organização (GET /honorarios/... é `viewer`);
  --   INSERT  `manager` (POST de contrato e de parcela é `manager`);
  --   UPDATE  `manager` — nenhuma rota edita, e dinheiro não é coisa que
  --           `agent` configure (mesmo piso do caixa núcleo, migration 0350);
  --   DELETE  `manager`, e PARCELA PAGA NÃO SE APAGA: nem ela, nem o contrato
  --           que a tem (o `on delete cascade` levaria a parcela junto, e a
  --           cascata de FK não passa por RLS).
  -- A policy anterior era UMA só, `for all`, com USING = membro e WITH CHECK =
  -- manager+. DELETE só avalia o USING: `viewer` e `agent` apagavam contrato
  -- (com as parcelas) ou parcela paga (revisão do #1578).
  --
  -- Parcela paga é imutável pela sessão, e a sessão não marca parcela como
  -- paga: `pago` com `financial_entry_id` só nasce em fn_honorarios_parcela_pagar
  -- (definer, dona da tabela, não passa por aqui), que lança o caixa junto.
  -- Deixar a sessão escrever `status`/`financial_entry_id` à mão desfaria esse
  -- par: "pago" sem lançamento, ou "pendente" de novo para pagar duas vezes.
  -- A parcela só aponta para contrato da própria organização (a FK só confere
  -- que o contrato existe).
  alter table public.honorarios_contratos enable row level security;
  drop policy if exists tenant_isolation_honorarios_contratos_all on public.honorarios_contratos;

  drop policy if exists honorarios_contratos_select on public.honorarios_contratos;
  -- Cada `create policy` deste corpo ocupa DUAS linhas de propósito (#1906).
  -- O `update.sh` de v1.39.0 a v1.63.0 lê as regras do TEXTO deste arquivo
  -- (nome da regra e tabela na MESMA linha do create), até dentro de corpo de
  -- função, e cobrava estas 8 em instalação sem o módulo. Esse script antigo
  -- é o que roda na atualização (fica no disco), então o conserto dele não
  -- alcança quem atualiza: a forma do texto sim. Vigiado por
  -- tests/unit/adr-0002-funcao-provisionadora.test.ts.
  create policy honorarios_contratos_select
    on public.honorarios_contratos
    for select using (
      organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
    );

  drop policy if exists honorarios_contratos_insert on public.honorarios_contratos;
  create policy honorarios_contratos_insert
    on public.honorarios_contratos
    for insert
    with check (public.fn_is_platform_admin_full()
                or (organization_id in (select public.fn_user_org_ids())
                    and public.fn_role_at_least(organization_id, 'manager')));

  drop policy if exists honorarios_contratos_update on public.honorarios_contratos;
  create policy honorarios_contratos_update
    on public.honorarios_contratos
    for update
    using (public.fn_is_platform_admin_full()
           or (organization_id in (select public.fn_user_org_ids())
               and public.fn_role_at_least(organization_id, 'manager')))
    with check (public.fn_is_platform_admin_full()
                or (organization_id in (select public.fn_user_org_ids())
                    and public.fn_role_at_least(organization_id, 'manager')));

  drop policy if exists honorarios_contratos_delete on public.honorarios_contratos;
  create policy honorarios_contratos_delete
    on public.honorarios_contratos
    for delete
    using ((public.fn_is_platform_admin_full()
            or (organization_id in (select public.fn_user_org_ids())
                and public.fn_role_at_least(organization_id, 'manager')))
           and not exists (select 1 from public.honorarios_parcelas p
                            where p.contrato_id = honorarios_contratos.id and p.status = 'pago'));
  revoke all on public.honorarios_contratos from anon;

  alter table public.honorarios_parcelas enable row level security;
  drop policy if exists tenant_isolation_honorarios_parcelas_all on public.honorarios_parcelas;

  drop policy if exists honorarios_parcelas_select on public.honorarios_parcelas;
  create policy honorarios_parcelas_select
    on public.honorarios_parcelas
    for select using (
      organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
    );

  drop policy if exists honorarios_parcelas_insert on public.honorarios_parcelas;
  create policy honorarios_parcelas_insert
    on public.honorarios_parcelas
    for insert
    with check ((public.fn_is_platform_admin_full()
                 or (organization_id in (select public.fn_user_org_ids())
                     and public.fn_role_at_least(organization_id, 'manager')))
                and status <> 'pago' and financial_entry_id is null
                and exists (select 1 from public.honorarios_contratos c
                             where c.id = contrato_id
                               and c.organization_id = honorarios_parcelas.organization_id));

  drop policy if exists honorarios_parcelas_update on public.honorarios_parcelas;
  create policy honorarios_parcelas_update
    on public.honorarios_parcelas
    for update
    using ((public.fn_is_platform_admin_full()
            or (organization_id in (select public.fn_user_org_ids())
                and public.fn_role_at_least(organization_id, 'manager')))
           and status <> 'pago')
    with check ((public.fn_is_platform_admin_full()
                 or (organization_id in (select public.fn_user_org_ids())
                     and public.fn_role_at_least(organization_id, 'manager')))
                and status <> 'pago' and financial_entry_id is null
                and exists (select 1 from public.honorarios_contratos c
                             where c.id = contrato_id
                               and c.organization_id = honorarios_parcelas.organization_id));

  drop policy if exists honorarios_parcelas_delete on public.honorarios_parcelas;
  create policy honorarios_parcelas_delete
    on public.honorarios_parcelas
    for delete
    using ((public.fn_is_platform_admin_full()
            or (organization_id in (select public.fn_user_org_ids())
                and public.fn_role_at_least(organization_id, 'manager')))
           and status <> 'pago');
  revoke all on public.honorarios_parcelas from anon;

  comment on table public.honorarios_contratos is
    'Modelo de cobrança do caso (fixo/êxito/misto). Financeiro real (contas, lançamentos) é o caixa núcleo — este módulo só descreve o contrato.';
  comment on table public.honorarios_parcelas is
    'Calendário de parcelas do contrato. Pagar uma parcela cria um financial_entries e liga por financial_entry_id; não há tabela de "pagamento" própria.';

  -- RLS já ligada por nós, então esta rotina não mexe mais nelas (D5) — só
  -- aplica as travas de suporte, que dependem de RLS já estar de pé.
  perform public.fn_proteger_modulo_provisionado();
end;
$f$;

revoke execute on function public.fn_honorarios_provisionar() from public, anon, authenticated;
grant execute on function public.fn_honorarios_provisionar() to service_role;

-- ---- a MESMA coluna em instalação que já provisionou o módulo (#3379) -------
--
-- `fn_honorarios_provisionar()` só roda na INSTALAÇÃO do módulo: quem já o tem
-- jamais passaria por ela de novo. Sem este bloco, o `update.sh` deixaria as
-- parcelas existentes sem `currency` e a rota de criação (que passou a mandar a
-- coluna) quebraria com `42703`. Guardado por `to_regclass` porque a tabela pode
-- não existir — módulo opcional, ADR-0002 D7.

do $$
begin
  if to_regclass('public.honorarios_parcelas') is null then
    return;
  end if;

  alter table public.honorarios_parcelas
    add column if not exists currency text not null default 'BRL';

  -- A coluna pode ter chegado sem a guarda (linha antiga, correção manual):
  -- o `drop` antes do `add` deixa a constraint na definição desta migration.
  alter table public.honorarios_parcelas
    drop constraint if exists honorarios_parcelas_currency_check;
  alter table public.honorarios_parcelas
    add constraint honorarios_parcelas_currency_check check (char_length(currency) = 3);

  -- O comentário mora DENTRO da guarda: fora dela, `comment on column` numa base
  -- com o módulo NÃO instalado derruba o install inteiro (`ON_ERROR_STOP=1`) por
  -- uma tabela que, de propósito, não existe ali.
  execute $c$
    comment on column public.honorarios_parcelas.currency is
      'Moeda da parcela, resolvida de organizations.currency no servidor quando a parcela nasce (#3379). Linha de dinheiro carrega a própria unidade — é o que permite o histórico não mudar de rótulo quando a organização troca de moeda.'
  $c$;
end
$$;

create or replace function public.fn_honorarios_parcela_pagar(
  p_org uuid,
  p_parcela uuid,
  p_account_id uuid,
  p_account_plan_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_parcela record;
  v_entry uuid;
begin
  if auth.uid() is null or not public.fn_role_at_least(p_org, 'manager') then
    raise exception 'honorarios_forbidden' using errcode = '42501';
  end if;

  select * into v_parcela from public.honorarios_parcelas
   where id = p_parcela and organization_id = p_org
   for update;

  if not found then
    raise exception 'parcela_nao_encontrada' using errcode = 'P0002';
  end if;
  if v_parcela.status = 'pago' then
    raise exception 'parcela_ja_paga' using errcode = '22023';
  end if;

  -- A conta e o plano vêm do corpo da requisição, e a função é definer: sem esta
  -- conferência a FK aceitaria a conta de OUTRA organização e o dinheiro desta
  -- entraria no extrato de lá. fn_finalizar_comanda resolve a conta pela forma de
  -- pagamento filtrada por p_org; aqui a conta chega direto, então o filtro é este.
  if not exists (
    select 1 from public.financial_accounts
     where id = p_account_id and organization_id = p_org and is_active
  ) then
    raise exception 'conta_invalida' using errcode = '22023';
  end if;
  if p_account_plan_id is not null and not exists (
    select 1 from public.account_plans
     where id = p_account_plan_id and organization_id = p_org and is_active
  ) then
    raise exception 'conta_invalida' using errcode = '22023';
  end if;

  -- A entrada do caixa nasce na MOEDA DA PARCELA (#3379): `financial_entries`
  -- tem `default 'BRL'`, então sem esta coluna o dinheiro de uma parcela em
  -- dólar entrava no extrato em real — o valor certo no bloco errado do
  -- relatório.
  insert into public.financial_entries
    (organization_id, account_id, account_plan_id, direction, amount_cents, currency,
     description, status, paid_at, origin, created_by_user_id)
  values (
    p_org, p_account_id, p_account_plan_id, 'in', v_parcela.valor_cents, v_parcela.currency,
    format('Parcela %s de honorários', v_parcela.numero), 'paid', now(), 'manual', auth.uid()
  )
  returning id into v_entry;

  update public.honorarios_parcelas
     set status = 'pago', financial_entry_id = v_entry
   where id = p_parcela;

  return jsonb_build_object(
    'id', v_parcela.id,
    'contrato_id', v_parcela.contrato_id,
    'numero', v_parcela.numero,
    'valor_cents', v_parcela.valor_cents,
    'status', 'pago',
    'financial_entry_id', v_entry
  );
end;
$$;

revoke execute on function public.fn_honorarios_parcela_pagar(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.fn_honorarios_parcela_pagar(uuid, uuid, uuid, uuid) to authenticated;