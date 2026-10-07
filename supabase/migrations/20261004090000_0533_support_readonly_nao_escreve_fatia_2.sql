-- manifest: **Platform admin `support_readonly` deixa de escrever nas 45 policies restantes da #2115 (36 das 47 listadas + 9 dinâmicas) — e a conta de escrita com a função pura fecha em 0.** Medição na `main@17c4b81b8`, depois do #2193: 36 policies de escrita com `fn_is_platform_admin()` puro, em 28 tabelas. **29 são troca direta** de policies de topo (cada tabela já tem `*_select` com a função pura, ou `fn_can_view_*`, que começa com `when fn_is_platform_admin() then true`); **6 são as policies internas de `fn_honorarios_provisionar`** (módulo honorários, ADR-0002) — a definição da função passa a criar as escritas com `_full` e mantém as duas SELECT com a pura; para quem já tem o módulo, quem reconstrói as policies é a reaplicação explícita (D6), que o fim do baseline roda em toda atualização; **1 é o único par**: `recurring_entries`, a única tabela das 47 sem `SELECT` própria — `_read` (pura) + `_write` (`_full`), preservando a assimetria do `_all` (using = membro ou plataforma; with check = plataforma ou membro+manager). Mesmo desenho da 0529: baseline editado no lugar (as 3 duplicatas de `attendant_availability` trocadas nas DUAS cópias) e invariante estendido — catálogo das 36, conta global de escrita em 0, comportamento do par e o módulo honorários instalado no próprio teste. **+9 dinâmicas** que a lista de 47 não via (a busca não enxerga `format()`) e a conta global achou: os dois blocos `do $$ foreach` de 0350 (`financial_accounts`, `payment_methods`, `account_plans`, with check manager) e 0351 (`sales`, `sale_items`, `commission_rules`, `commissions`, `financial_entries`, `loyalty_ledger`, with check agent) — `_all` vira o mesmo par `_read`/`_write` de `recurring_entries`.

-- 0533: fatia 2 da #2115 — a prioridade 5 do issue (o resto da lista).
--
-- A #2115 mediu 47 policies de escrita com fn_is_platform_admin() no trecho que
-- a 0508 não varreu (apêndices do baseline). A fatia 1 (0529, PR #2193) fechou
-- as 11 da prioridade 1 a 4; esta fecha as 36 restantes da lista e mais 9 que a
-- lista não via (dois blocos dinâmicos do baseline, `format()`): 45 ao todo.
--
-- Quatro formas, todas no mesmo desenho:
--   · 29 TROCAS DIRETAS em policies de topo — cada tabela já tem SELECT própria
--     com a função pura (ou fn_can_view_*, que começa com
--     `when fn_is_platform_admin() then true`);
--   · 6 POLICIES INTERNAS do módulo honorários (ADR-0002): o corpo de
--     fn_honorarios_provisionar é redefinido aqui e no baseline; as duas SELECT
--     seguem com a função pura e as seis de escrita passam a `_full`. Para quem
--     já tem o módulo, a policy nasce no provisionamento: quem a reconstrói é a
--     reaplicação explícita (D6), que o fim do baseline roda em toda atualização;
--   · 1 PAR — recurring_entries era a única das 47 sem SELECT própria;
--   · 9 PARES DINÂMICOS — os laços de 0350 e 0351 criavam `tenant_isolation_%I_all`
--     com a pura; viram o mesmo par `_read`/`_write` (fim deste arquivo).
--
-- Idempotente: drop policy if exists antes de cada create; create or replace
-- na função; a reaplicação é o mesmo comando do fim do baseline.
--
-- Medido em banco pelo invariante estendido
-- (tests/invariants/platform-admin-full-so-escreve.test.ts): catálogo das 45
-- expressões vivas, conta global de escrita com a função pura em 0, comportamento
-- do par de recurring_entries e o módulo honorários instalado dentro do teste.

drop policy if exists tenant_isolation_ai_agents_write on public.ai_agents;
create policy tenant_isolation_ai_agents_write on public.ai_agents
  for all using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin_full()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin_full()
  );

drop policy if exists tenant_isolation_ai_budgets_write on public.ai_budgets;
create policy tenant_isolation_ai_budgets_write on public.ai_budgets
  for all using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin_full()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin_full()
  );

drop policy if exists tenant_isolation_ai_chunks_write on public.ai_chunks;
create policy tenant_isolation_ai_chunks_write on public.ai_chunks
  for all using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin_full()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin_full()
  );

drop policy if exists tenant_isolation_ai_knowledge_sources_write on public.ai_knowledge_sources;
create policy tenant_isolation_ai_knowledge_sources_write on public.ai_knowledge_sources
  for all using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager'))
    or public.fn_is_platform_admin_full()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager'))
    or public.fn_is_platform_admin_full()
  );

drop policy if exists tenant_isolation_ai_kbv_write on public.ai_knowledge_versions;
create policy tenant_isolation_ai_kbv_write on public.ai_knowledge_versions
  for all using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin_full()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin_full()
  );

drop policy if exists attendant_availability_delete on public.attendant_availability;
create policy "attendant_availability_delete" on public.attendant_availability
  for delete using (
    public.fn_is_platform_admin_full()
    or (organization_id in (select public.fn_user_org_ids())
        and (user_id = auth.uid()
             or public.fn_role_at_least(organization_id, 'manager')))
  );

drop policy if exists attendant_availability_insert on public.attendant_availability;
create policy "attendant_availability_insert" on public.attendant_availability
  for insert with check (
    public.fn_is_platform_admin_full()
    or (organization_id in (select public.fn_user_org_ids())
        and (user_id = auth.uid()
             or public.fn_role_at_least(organization_id, 'manager')))
  );

drop policy if exists attendant_availability_update on public.attendant_availability;
create policy "attendant_availability_update" on public.attendant_availability
  for update using (
    public.fn_is_platform_admin_full()
    or (organization_id in (select public.fn_user_org_ids())
        and (user_id = auth.uid()
             or public.fn_role_at_least(organization_id, 'manager')))
  ) with check (
    public.fn_is_platform_admin_full()
    or (organization_id in (select public.fn_user_org_ids())
        and (user_id = auth.uid()
             or public.fn_role_at_least(organization_id, 'manager')))
  );

drop policy if exists automation_rules_manager_write on public.automation_rules;
create policy "automation_rules_manager_write" on public.automation_rules
  using (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists calendar_appointments_write on public.calendar_appointments;
create policy calendar_appointments_write on public.calendar_appointments
  using (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  )
  with check (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

drop policy if exists calendar_availability_exceptions_write on public.calendar_availability_exceptions;
create policy calendar_availability_exceptions_write on public.calendar_availability_exceptions
  using (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and (user_id = auth.uid() or public.fn_role_at_least(organization_id, 'manager')))
  )
  with check (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and (user_id = auth.uid() or public.fn_role_at_least(organization_id, 'manager')))
  );

drop policy if exists calendar_event_types_write on public.calendar_event_types;
create policy calendar_event_types_write on public.calendar_event_types
  using (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists calendar_locations_insert on public.calendar_locations;
create policy calendar_locations_insert on public.calendar_locations
  for insert with check (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

drop policy if exists campaign_channel_sessions_write on public.campaign_channel_sessions;
create policy campaign_channel_sessions_write on public.campaign_channel_sessions
  using (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists campaign_recipients_write on public.campaign_recipients;
create policy campaign_recipients_write on public.campaign_recipients
  using (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists campaign_suppressions_write on public.campaign_suppressions;
create policy campaign_suppressions_write on public.campaign_suppressions
  using (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists campaign_templates_write on public.campaign_templates;
create policy campaign_templates_write on public.campaign_templates
  using (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists campaigns_write on public.campaigns;
create policy campaigns_write on public.campaigns
  using (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists catalog_products_write on public.catalog_products;
create policy catalog_products_write on public.catalog_products
  using (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists crm_lead_activities_insert on public.crm_lead_activities;
create policy "crm_lead_activities_insert" on public.crm_lead_activities
  for insert with check (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin_full()
  );

drop policy if exists crm_lead_links_delete on public.crm_lead_links;
create policy "crm_lead_links_delete" on public.crm_lead_links
  for delete using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin_full()
  );

drop policy if exists crm_lead_links_insert on public.crm_lead_links;
create policy "crm_lead_links_insert" on public.crm_lead_links
  for insert with check (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin_full()
  );

drop policy if exists crm_lead_links_update on public.crm_lead_links;
create policy "crm_lead_links_update" on public.crm_lead_links
  for update using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin_full()
  ) with check (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin_full()
  );

drop policy if exists crm_pipelines_manager_write on public.crm_pipelines;
create policy "crm_pipelines_manager_write" on public.crm_pipelines
  using (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists crm_stages_manager_write on public.crm_stages;
create policy "crm_stages_manager_write" on public.crm_stages
  using (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists crm_tasks_write on public.crm_tasks;
create policy crm_tasks_write on public.crm_tasks
  using (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  )
  with check (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

drop policy if exists org_guardrail_layers_admin_write on public.org_guardrail_layers;
create policy org_guardrail_layers_admin_write on public.org_guardrail_layers
  using (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'admin'))
  )
  with check (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'admin'))
  );

drop policy if exists org_voice_calls_admin_write on public.org_voice_calls;
create policy org_voice_calls_admin_write on public.org_voice_calls
  using (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'admin'))
  )
  with check (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'admin'))
  );

drop policy if exists webhook_sources_manager_write on public.webhook_sources;
create policy "webhook_sources_manager_write" on public.webhook_sources
  using (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists tenant_isolation_recurring_entries_all on public.recurring_entries;
drop policy if exists tenant_isolation_recurring_entries_read on public.recurring_entries;
create policy tenant_isolation_recurring_entries_read on public.recurring_entries
  for select
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());
drop policy if exists tenant_isolation_recurring_entries_write on public.recurring_entries;
create policy tenant_isolation_recurring_entries_write on public.recurring_entries
  for all
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin_full())
  with check (
    public.fn_is_platform_admin_full()
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'manager'))
  );

-- ---- fn_honorarios_provisionar: as 6 policies internas passam a exigir _full (ADR-0002) ----
-- O módulo honorários não põe tabela no baseline: elas nascem quando o módulo é
-- instalado, pelo corpo desta provisionadora. As duas SELECT continuam com a função
-- pura; as seis de escrita passam a exigir `scope='full'`.
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

-- Para quem já tem o módulo instalado, quem reconstrói as policies é a reaplicação
-- EXPLÍCITA (D6): o fim do baseline roda `fn_reaplicar_modulos_instalados()` em toda
-- atualização. Esta migration redefine a função; o caminho da cadeia não reaplica
-- módulo sozinho, de propósito.

-- ---- as 9 dos dois blocos dinâmicos (0350 e 0351): _all vira par ----
-- Ficaram fora da lista de 47 da #2115 porque a busca que a montou não enxerga
-- `format()`. A conta global do invariante as achou. Mesmo par de
-- recurring_entries: _read com a função pura, _write com `_full`.
do $$
declare t text; papel text;
begin
  foreach t in array array['financial_accounts', 'payment_methods', 'account_plans',
                           'sales', 'sale_items', 'commission_rules', 'commissions',
                           'financial_entries', 'loyalty_ledger'] loop
    -- Dinheiro de configuração (0350) é manager+; o que a comanda move (0351), agent+.
    papel := case when t in ('financial_accounts', 'payment_methods', 'account_plans')
                  then 'manager' else 'agent' end;
    execute format('drop policy if exists tenant_isolation_%I_all on public.%I', t, t);
    execute format('drop policy if exists tenant_isolation_%I_read on public.%I', t, t);
    execute format($f$
      create policy tenant_isolation_%I_read on public.%I
        for select
        using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin())
    $f$, t, t);
    execute format('drop policy if exists tenant_isolation_%I_write on public.%I', t, t);
    execute format($f$
      create policy tenant_isolation_%I_write on public.%I
        for all
        using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin_full())
        with check (
          public.fn_is_platform_admin_full()
          or (organization_id in (select public.fn_user_org_ids())
              and public.fn_role_at_least(organization_id, %L))
        )
    $f$, t, t, papel);
  end loop;
end $$;
