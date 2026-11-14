-- manifest: **O molde da recorrência do negócio para no último mês do contrato (#3602, doc 312 = A).** `recurring_entries.ends_on date` nullable: a última competência que o molde ainda gera; nulo = sem prazo, o desenho de todo molde digitado à mão. O ganho do negócio grava a data a partir de `crm_leads.recurring_months`, e o cron `app/api/v1/cron/recurring-entries` pula a competência posterior a ela. Sem a coluna, um contrato de 12 meses virava conta a receber para sempre. ADITIVA: nenhuma linha é reescrita. Espelho no apêndice do `supabase/baseline.sql`, logo depois do bloco 9316. Prova em `tests/invariants/recorrencia-do-negocio.test.ts`.
--
-- Por que uma DATA e não o número de meses: o cron compara competência com
-- competência, e a data já carrega o dia do mês resolvido (o dia 31 que cai em
-- 30 de abril). O número de meses exigiria saber de que mês o molde partiu, e
-- o re-ganho de um negócio parte de outro mês.
--
-- Idempotente: `add column if not exists`.

alter table public.recurring_entries
  add column if not exists ends_on date;

comment on column public.recurring_entries.ends_on is
  'A última competência que o molde gera; nulo = sem prazo. Gravada pelo ganho do negócio a partir de crm_leads.recurring_months (#3602). Migration 9371.';
