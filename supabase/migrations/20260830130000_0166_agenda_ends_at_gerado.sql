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

-- ---------------------------------------------------------------------------

-- `agent_inbox_items.kind` ganha 'appointment_outcome_pending' — o cron
-- `appointment-outcome-nudge` (app/api/v1/cron/appointment-outcome-nudge/route.ts)
-- insere avisos com este kind, e sem ele TODO insert do cron falha com 23514
-- em qualquer Postgres real (o mock do teste unitário não aplica CHECK, então
-- isto não aparecia lá).
--
-- ESTE É O BLOCO ÚNICO desta constraint (mesma regra da 0139, e vigiado por
-- tests/unit/baseline-constraint-reconstruida.test.ts): quem acrescenta um
-- `kind` edita o bloco existente no fim do `baseline.sql`, não cria um novo.
-- Aqui na cadeia de migrations, a lista abaixo é a lista completa (a mesma da
-- 0159, que era a última a reconstruir a constraint) mais o valor novo, para
-- que `tests/unit/kind-check-migration-x-baseline.test.ts` (a ÚLTIMA migration
-- que reconstrói a constraint tem de bater com o baseline) continue verde.
alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'qr_rescan',
    'job_dead',
    'event_dead',
    'budget_exceeded',
    'handoff',
    'promotion_review',
    'judge_unaligned',
    'followup_dead',
    'snooze_expired',
    'next_action_ambiguous',
    'risk_backlog_seeded',
    'reactivation_expired',
    'capabilities_missing',
    'message_send_stuck',
    'midia_nao_lida',
    'channel_template_review',
    'channel_number_alert',
    'promise_unfulfilled',
    'contact_proposal_expired',
    'budget_warning',
    -- (migration 0166) Cron appointment-outcome-nudge — agendamento passado
    -- que ainda está `scheduled` e precisa de confirmação humana. Entra no
    -- fim da lista, antes de 'other', mesma convenção das entradas acima.
    'appointment_outcome_pending',
    'other'
  ));
