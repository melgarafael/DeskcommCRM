-- 0166 — Agenda nativa: coluna gerada `ends_at` em `appointments`.
--
-- Forward-fix da 0165 (NUNCA editamos migration já aplicada — doutrina em
-- CLAUDE.md, "Migrations & Banco"). O cron `appointment-outcome-nudge`
-- (Frente A) precisa filtrar por "scheduled_at + duration_minutes < corte",
-- não só por `scheduled_at` — um agendamento de 2h "termina" bem depois de
-- começar. `ends_at` é gerada (STORED) a partir de colunas já existentes, sem
-- backfill: o Postgres calcula automaticamente para as linhas que já existem.
alter table public.appointments
  add column if not exists ends_at timestamptz
  generated always as (scheduled_at + (duration_minutes || ' minutes')::interval) stored;

create index if not exists idx_appointments_ends_at
  on public.appointments (ends_at)
  where status = 'scheduled';
