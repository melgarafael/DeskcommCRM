-- manifest: **Meta mensal de um indicador, por organização (#3025, fatia 1: quantidade de vendas ganhas).** A tabela nova `crm_metas` guarda o ALVO da empresa — `organization_id`, `periodo` (sempre o 1º dia do mês na data de calendário), `indicador` (`vendas_ganhas` nesta fatia), `pipeline_id` opcional (nulo = a empresa inteira) e `alvo` (quantidade). A leitura é org-scoped sem gate de papel (a tela de Desempenho mostra a meta da empresa a qualquer membro); a ESCRITA é `manager+` com auditoria, pela Server Action `definirMetaMensal`. Aditiva e idempotente: o mesmo bloco entra no fim do `baseline.sql`, que é o arquivo que o kit self-host aplica.
-- ============================================================================
-- 0756 — META MENSAL POR INDICADOR (#3025, fatia 1)
--
-- ─── O que faltava ──────────────────────────────────────────────────────────
-- A tela Desempenho mostrava só o REALIZADO: contagens por atendente e as
-- barras do funil. Não havia onde dizer "este mês a empresa quer 40 vendas
-- ganhas", nem, por consequência, um DENOMINADOR — sem alvo não existe
-- percentual, e sem percentual o dono compara meses de cabeça. Toda meta
-- existia como número na cabeça de quem cobra.
--
-- ─── Por que uma tabela, e não uma coluna de `organizations.settings` ───────
-- Porque meta é LINHA, não configuração: ela tem período, tem indicador, tem
-- autor e vai ter histórico (o alvo de março precisa sobreviver à chegada de
-- abril, senão a comparação entre meses nasce mentirosa). Guardar em `settings`
-- daria uma meta só, a última, e apagaria a anterior no mesmo UPDATE.
--
-- ─── O período é DATE do 1º dia, e a constraint é o que o mantém assim ──────
-- `periodo = date_trunc('month', periodo)` recusa '2026-10-15'. Sem isso, duas
-- pessoas cadastrando "outubro" em dias diferentes criariam duas linhas que a
-- tela leria como metas distintas do mesmo mês.
--
-- ─── `pipeline_id` nulo é a META DA EMPRESA ────────────────────────────────
-- A fatia 1 cadastra e lê a meta da empresa inteira: `pipeline_id is null`. A
-- coluna e o índice por funil nascem agora para que a fatia seguinte (recorte
-- por funil) seja INSERT, e não migration de schema — o desenho já comporta o
-- que vem, sem prometer o que ainda não é lido.
--
-- ─── Leitura e escrita ─────────────────────────────────────────────────────
-- LEITURA: org-scoped pela policy `select` (`fn_user_org_ids`), sem gate de
-- papel — o atendente precisa ver o alvo que a empresa persegue, e é o número
-- que a própria tela dele mostra. ESCRITA: `manager+` (insert/update), NUNCA
-- `for all`: a lição da 0553 é que `for all` faz toda LEITURA avaliar
-- `fn_role_at_least` linha a linha e estoura o statement_timeout da tela.
-- Apagar meta fica FORA desta fatia (não há policy de `delete` e o comando não
-- é concedido a `authenticated`): corrigir é gravar de novo por cima.
-- ============================================================================

create table if not exists public.crm_metas (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- 1º dia do mês: a constraint abaixo é o que garante.
  periodo date not null,
  indicador text not null default 'vendas_ganhas',
  -- nulo = a meta da EMPRESA inteira (fatia 1); preenchido = a meta daquele funil.
  pipeline_id uuid references public.crm_pipelines (id) on delete cascade,
  alvo integer not null,
  -- Sem FK de cascata dura: quem cadastrou pode sair da instalação, e a meta
  -- continua sendo da empresa.
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_metas_periodo_e_o_primeiro_dia
    check (periodo = date_trunc('month', periodo)::date),
  constraint crm_metas_indicador_conhecido
    check (indicador in ('vendas_ganhas')),
  constraint crm_metas_alvo_positivo
    check (alvo > 0)
);

-- Uma meta da empresa por mês/indicador e uma meta por funil. Índices PARCIAIS
-- e não uma constraint única com `nulls not distinct`: `pipeline_id` nulo não
-- seria comparável em igualdade, e um alvo "igual a outro" com nulos passaria.
create unique index if not exists crm_metas_uma_por_empresa_periodo_idx
  on public.crm_metas (organization_id, periodo, indicador)
  where pipeline_id is null;

create unique index if not exists crm_metas_uma_por_funil_periodo_idx
  on public.crm_metas (organization_id, periodo, indicador, pipeline_id)
  where pipeline_id is not null;

-- A leitura da tela de Desempenho é por organização e por janela.
create index if not exists crm_metas_org_periodo_idx
  on public.crm_metas (organization_id, periodo desc);

alter table public.crm_metas enable row level security;

drop policy if exists crm_metas_select on public.crm_metas;
create policy crm_metas_select on public.crm_metas
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or (select public.fn_is_platform_admin())
  );

drop policy if exists crm_metas_insert on public.crm_metas;
create policy crm_metas_insert on public.crm_metas
  for insert with check (
    (select public.fn_is_platform_admin_full())
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists crm_metas_write on public.crm_metas;
create policy crm_metas_write on public.crm_metas
  for update using (
    (select public.fn_is_platform_admin_full())
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    (select public.fn_is_platform_admin_full())
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

-- `ALTER DEFAULT PRIVILEGES … GRANT ALL ON TABLES TO anon` do baseline alcança
-- toda tabela criada depois dele. Sem este revoke, o alvo da empresa fica
-- legível pela anon key, que vai para o browser.
revoke all on public.crm_metas from anon, authenticated;
grant select, insert, update on public.crm_metas to authenticated;
grant all on public.crm_metas to service_role;

comment on table public.crm_metas is
  'Meta mensal da organização por indicador (#3025, fatia 1). `pipeline_id` nulo = meta da EMPRESA; preenchido = meta do funil. Leitura org-scoped; escrita manager+ (Server Action definirMetaMensal, com auditoria).';

comment on column public.crm_metas.periodo is
  'O 1º dia do mês a que a meta se refere (constraint crm_metas_periodo_e_o_primeiro_dia). DATE na data de calendário: o mês da meta é o mês do operador, não um instante UTC.';

comment on column public.crm_metas.alvo is
  'Quanto se quer atingir no indicador, naquele mês: nesta fatia, a QUANTIDADE de vendas ganhas. É o denominador que a tela de Desempenho não tinha.';
