-- 0167 — Superfície do pointer de follow-up (IA vs automação CRM).
--
-- Um motor, duas listas. Sem esta coluna, /app/ai/followups e a seção CRM de
-- automação compartilhariam a mesma tabela sem recorte — um fluxo de mensagem
-- disparado por webhook apareceria na lista de follow-up da IA, e o contrário.
-- Default 'followup' deixa toda linha já existente na superfície de IA.
--
-- CHECK de CONJUNTO (não regex): entra em PARES de
-- tests/invariants/vocabulario-banco-x-typescript.test.ts.
--
-- Aditiva e idempotente: ADD COLUMN IF NOT EXISTS; constraint drop+add.

alter table public.followup_flow_pointers
  add column if not exists surface text not null default 'followup';

alter table public.followup_flow_pointers
  drop constraint if exists followup_flow_pointers_surface_check;

alter table public.followup_flow_pointers
  add constraint followup_flow_pointers_surface_check
  check (surface in ('followup', 'crm_automation'));

comment on column public.followup_flow_pointers.surface is
  'Onde o fluxo aparece: followup = /app/ai/followups; crm_automation = CRM Automação. '
  'Vocabulário cobrado por tests/invariants/vocabulario-banco-x-typescript.test.ts.';

notify pgrst, 'reload schema';
