-- 0398 — Honorários: primeiro módulo oficial a usar o mecanismo da ADR-0002.
--
-- Lei: docs/adr/0002-tabelas-de-modulo-num-banco-so.md. Onda 1 (D4/D5, migration 0325) e onda 2
-- (D3/D6, migration 0340) já entregaram o harness — registro `modulos_instalados`,
-- `fn_modulo_instalar`, reaplicação com suspensão explícita, `fn_proteger_modulo_provisionado()`.
-- Nenhum módulo concreto o usava ainda (a 0340 registra isso no próprio corpo: "o primeiro
-- (financeiro/comanda) escreve o próprio corpo" — a comanda seguiu pelo caminho antigo,
-- tabela no baseline para todos, exatamente o que a ADR-0002 critica). Honorários é o primeiro.
--
-- ── D2: a migration cria a FUNÇÃO, nunca a tabela ────────────────────────────────────────────
-- `public.fn_honorarios_provisionar()` — sem parâmetro, `security definer`, corpo com
-- `create table if not exists`. Criar a função aqui não cria tabela nenhuma; as tabelas só
-- nascem quando um administrador da instalação chama `fn_modulo_instalar('honorarios', ...)`.
--
-- ── Destino (DoD 18): extensão ────────────────────────────────────────────────────────────────
-- Parcelas, êxito e repasse de honorários são especialização de advocacia — sem elas, funis e
-- caixa do núcleo continuam inteiros. O caixa NÚCLEO (`financial_accounts`, `payment_methods`,
-- `account_plans`, `financial_entries`, migration 0350) já está liberado e faz o trabalho de
-- DINHEIRO; este módulo só descreve o CONTRATO e o CALENDÁRIO de parcelas — DIRC "integrar" em
-- vez de "duplicar". Pagar uma parcela cria um `financial_entries` (direction='in') e liga por
-- `financial_entry_id`; não há tabela de "pagamento" própria.
--
-- ── D4: por que a função não é porta de adulteração ──────────────────────────────────────────
-- Sem parâmetro (nenhum nome de tabela, org ou SQL vem de quem chama); idempotente
-- (`if not exists` em tudo); só `service_role` executa (revoke das duas origens — CLAUDE.md,
-- migrations item 9: o grant a PUBLIC que o Postgres dá ao criar a função, e o grant direto do
-- `alter default privileges ... to anon` do baseline).
--
-- ── D5: RLS por PAPEL, não a policy ampla automática ─────────────────────────────────────────
-- `fn_proteger_modulo_provisionado()` (chamada no fim) só liga RLS + a policy ampla
-- `tenant_isolation_<t>_all` em tabela que nasce com RLS DESLIGADA — e é exatamente o estado das
-- duas tabelas deste módulo ao saírem do `create table`. Como honorários quer escrita restrita a
-- `manager`+ (mesmo padrão do caixa núcleo: "dinheiro não é coisa que `agent` configure"), a
-- função liga a RLS ELA MESMA, com a policy por papel, ANTES de chamar a rotina automática — a
-- partir daí ela não enxerga mais estas tabelas (RLS já ligada), e a policy por papel é a que vale.
--
-- ── LGPD (D8) ─────────────────────────────────────────────────────────────────────────────────
-- Nenhuma coluna de `honorarios_contratos`/`honorarios_parcelas` é texto livre sobre a pessoa —
-- são parâmetros financeiros (modelo, percentual, valores) e agenda de pagamento. A cascata de
-- anonimização (`fn_lgpd_cascade_redact_contact`) não ganha passo novo porque não há o que
-- redigir; `lead_id`/`contrato_id` sobrevivem à anonimização do contato pela mesma razão que
-- `crm_leads.pipeline_id`/`stage_id`/`value_cents` sobrevivem (operação, não dado da pessoa).
--
-- ── Nenhum consumidor real ainda ──────────────────────────────────────────────────────────────
-- Instalar o módulo (`fn_modulo_instalar('honorarios', ...)`) é ação do administrador da
-- instalação (D3, não-negociável 4) — não roda sozinho nesta migration. Até alguém instalar, a
-- lista de módulos ativos continua vazia e nenhuma tabela existe (D3: "o corte é por instalação").

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

  -- ── RLS por PAPEL (D5, ligada aqui e não pela rotina automática) ───────────
  -- Leitura para quem é da organização; escrita para manager+ — mesmo padrão do
  -- caixa núcleo (financial_accounts/payment_methods/account_plans, migration
  -- 0350): dinheiro não é coisa que `agent` configure.
  execute format('alter table public.%I enable row level security', 'honorarios_contratos');
  execute format('drop policy if exists tenant_isolation_%I_all on public.%I', 'honorarios_contratos', 'honorarios_contratos');
  execute format($p$
    create policy tenant_isolation_%I_all on public.%I
      for all
      using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin())
      with check (
        public.fn_is_platform_admin()
        or (organization_id in (select public.fn_user_org_ids())
            and public.fn_role_at_least(organization_id, 'manager'))
      )
  $p$, 'honorarios_contratos', 'honorarios_contratos');
  execute format('revoke all on public.%I from anon', 'honorarios_contratos');

  execute format('alter table public.%I enable row level security', 'honorarios_parcelas');
  execute format('drop policy if exists tenant_isolation_%I_all on public.%I', 'honorarios_parcelas', 'honorarios_parcelas');
  execute format($p$
    create policy tenant_isolation_%I_all on public.%I
      for all
      using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin())
      with check (
        public.fn_is_platform_admin()
        or (organization_id in (select public.fn_user_org_ids())
            and public.fn_role_at_least(organization_id, 'manager'))
      )
  $p$, 'honorarios_parcelas', 'honorarios_parcelas');
  execute format('revoke all on public.%I from anon', 'honorarios_parcelas');

  comment on table public.honorarios_contratos is
    'Modelo de cobrança do caso (fixo/êxito/misto). Financeiro real (contas, lançamentos) é o caixa núcleo — este módulo só descreve o contrato.';
  comment on table public.honorarios_parcelas is
    'Calendário de parcelas do contrato. Pagar uma parcela cria um financial_entries e liga por financial_entry_id; não há tabela de "pagamento" própria.';

  -- RLS já ligada por nós, então esta rotina não mexe mais nelas (D5) — só
  -- aplica as travas de suporte, que dependem de RLS já estar de pé.
  perform public.fn_proteger_modulo_provisionado();
end;
$f$;

-- D4: as DUAS origens de EXECUTE (CLAUDE.md, migrations item 9) — o grant a PUBLIC que o
-- Postgres dá ao criar a função, e o `alter default privileges ... to anon` do baseline.
revoke execute on function public.fn_honorarios_provisionar() from public, anon, authenticated;
grant execute on function public.fn_honorarios_provisionar() to service_role;
