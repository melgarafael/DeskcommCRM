-- 0427 — probabilidade de ganho POR ETAPA (issue #1535).
--
-- O funil já guarda os ingredientes da previsão (valor, moeda, data prevista
-- de fechamento) e não a conta: não há probabilidade por etapa nem previsão
-- ponderada. `crm_lead_scores.ai_probability` é OUTRA medida — embute o risco
-- de esfriar, é recalculada por eventos e serve de sinal, não de meta que o
-- gestor calibra.
--
-- Aditiva e idempotente: a coluna nasce `null` em toda linha existente, e
-- `null` significa "esta etapa não tem probabilidade calibrada" — que a regra
-- de previsão reporta À PARTE (balde "sem probabilidade"), nunca some como
-- zero em silêncio. Nada muda até alguém configurar.
--
-- Etapas `is_won` e `is_lost` valem implicitamente 100 e 0 NA REGRA
-- (`lib/leads/previsao.ts`), não gravado: o CHECK de ganho/perda já é o que
-- garante que as duas não acontecem juntas, e gravar a probabilidade ali seria
-- um segundo lugar para a mesma verdade divergir.
alter table public.crm_stages
  add column if not exists win_probability smallint;

alter table public.crm_stages
  drop constraint if exists crm_stages_win_probability_range;

alter table public.crm_stages
  add constraint crm_stages_win_probability_range
  check (win_probability is null or win_probability between 0 and 100);
