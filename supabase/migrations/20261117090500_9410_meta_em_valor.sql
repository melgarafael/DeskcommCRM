-- manifest: **Meta mensal em VALOR de venda (#4796, fatia 2 da #3025).** `crm_metas` ganha o indicador `valor_vendido` (alvo em CENTAVOS) e o dono opcional `vendedor_id`; a meta da empresa continua sendo `pipeline_id is null and vendedor_id is null`, e o índice único parcial é refeito para não confundir a meta da empresa com a do vendedor. Aditiva e retrocompatível: meta antiga, sem indicador, continua valendo por QUANTIDADE. Espelho no `baseline.sql`.
-- ============================================================================
-- 9410 — META MENSAL EM VALOR DE VENDA (#4796, fatia 2 da #3025)
--
-- ─── O que faltava ──────────────────────────────────────────────────────────
-- A meta da 0756 conta VENDAS GANHAS. Numa agência de viagens, uma venda de
-- R$ 3 mil e outra de R$ 80 mil contam igual nessa régua, e o gestor cobra o
-- time pelo FATURAMENTO do mês. Aqui nasce o segundo indicador:
-- `valor_vendido`, com o alvo em CENTAVOS — a mesma unidade de
-- `crm_leads.value_cents`, porque R$ 500.000,00 com centavo não cabe em reais
-- inteiros sem inventar arredondamento.
--
-- ─── Meta antiga NÃO muda de régua ──────────────────────────────────────────
-- A constraint `crm_metas_indicador_conhecido` passa a aceitar os dois valores.
-- Nenhuma linha é reescrita: quem foi gravado como `vendas_ganhas` (ou antes
-- disso, quando o default era o único indicador) continua contando quantidade.
-- O default da coluna segue `vendas_ganhas` — trocá-lo mudaria o significado
-- das metas já cadastradas.
--
-- ─── Os três níveis: empresa, funil e vendedor ──────────────────────────────
-- `vendedor_id` nulo + `pipeline_id` nulo = meta da EMPRESA;
-- `pipeline_id` preenchido = meta do FUNIL (já existia);
-- `vendedor_id` preenchido = meta do VENDEDOR (nasce agora).
-- As duas dimensões não se combinam: uma linha com dono E funil tornaria
-- "a meta do vendedor" ambígua, e o cadastro não oferece essa combinação.
--
-- ─── O índice da empresa precisou ser REFEITO, e é o ponto delicado ────────
-- `crm_metas_uma_por_empresa_periodo_idx` era
-- `(organization_id, periodo, indicador) where pipeline_id is null`. A meta do
-- vendedor TAMBÉM tem `pipeline_id` nulo — com o índice antigo, cadastrar a
-- meta de um vendedor colidiria com a meta da empresa e o INSERT estouraria na
-- cara de quem salvou. O predicado ganha `and vendedor_id is null`, e o índice
-- do vendedor é o seu par, também parcial.
--
-- ─── Leitura e escrita ─────────────────────────────────────────────────────
-- As policies não mudam: leitura org-scoped, escrita `manager+`. O vendedor é
-- um `auth.users` do próprio tenant; a FK impede um id inexistente, e a tela só
-- oferece membros da organização. Nada de `delete`: corrigir é gravar por cima.
-- ============================================================================

alter table public.crm_metas
  add column if not exists vendedor_id uuid references auth.users (id) on delete cascade;

comment on column public.crm_metas.vendedor_id is
  'Dono da meta individual (#4796). Nulo + pipeline_id nulo = meta da EMPRESA; preenchido = meta do VENDEDOR. As duas dimensões não se combinam.';

alter table public.crm_metas
  drop constraint if exists crm_metas_indicador_conhecido;

alter table public.crm_metas
  add constraint crm_metas_indicador_conhecido
  check (indicador in ('vendas_ganhas', 'valor_vendido'));

alter table public.crm_metas
  drop constraint if exists crm_metas_dono_ou_funil;

alter table public.crm_metas
  add constraint crm_metas_dono_ou_funil
  check (vendedor_id is null or pipeline_id is null);

-- O índice da EMPRESA passa a excluir a meta do vendedor (as duas tinham
-- `pipeline_id` nulo, e colidiriam).
drop index if exists public.crm_metas_uma_por_empresa_periodo_idx;

create unique index if not exists crm_metas_uma_por_empresa_periodo_idx
  on public.crm_metas (organization_id, periodo, indicador)
  where pipeline_id is null and vendedor_id is null;

create unique index if not exists crm_metas_uma_por_vendedor_periodo_idx
  on public.crm_metas (organization_id, periodo, indicador, vendedor_id)
  where vendedor_id is not null;

comment on column public.crm_metas.indicador is
  'O que a meta mede (#4796): `vendas_ganhas` = QUANTIDADE de negócios ganhos na janela; `valor_vendido` = soma de value_cents dos mesmos ganhos, com o alvo em CENTAVOS.';

comment on column public.crm_metas.alvo is
  'Quanto se quer atingir no indicador, naquele mês: QUANTIDADE de vendas ganhas em `vendas_ganhas`, VALOR em CENTAVOS da moeda da organização em `valor_vendido`. É o denominador que a tela de Desempenho não tinha.';

comment on table public.crm_metas is
  'Meta mensal da organização por indicador (#3025 fatia 1, valor na #4796). `pipeline_id` nulo + `vendedor_id` nulo = meta da EMPRESA; `pipeline_id` preenchido = meta do funil; `vendedor_id` preenchido = meta do vendedor. Leitura org-scoped; escrita manager+ (Server Action definirMetaMensal, com auditoria).';

notify pgrst, 'reload schema';
