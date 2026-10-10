-- =============================================================================
-- Migration 0022_ai_budget_trigger
-- EPIC-06 wave 11 (S-06.11): atomic budget consumption tracking via trigger.
-- =============================================================================
-- Source of truth: docs/stories/epics/EPIC-06-ai-rag.md (S-06.11)
--
-- Strategy: every INSERT into ai_invocations atomically increments
-- ai_budgets.current_month_consumed_cents for the same organization_id, using
-- INSERT ... ON CONFLICT (single statement, no race) and NEVER making HTTP
-- calls (CLAUDE.md anti-pattern #9 — triggers must not do HTTP).
--
-- The cron `ai-budget-checker` (TS worker) is responsible for reading the
-- accumulated counter and emitting alarms / flipping is_throttled / is_disabled
-- and dispatching emails.
-- =============================================================================

-- Defensive: ensure ai_budgets has PK on organization_id (Row metadata says it
-- is unique 1:1; this guard is idempotent and only fires on greenfield).
do $$
begin
  if not exists (
    select 1
    from   pg_constraint c
    join   pg_class t on t.oid = c.conrelid
    where  t.relname = 'ai_budgets'
    and    c.contype in ('p', 'u')
    and    pg_get_constraintdef(c.oid) ilike '%(organization_id)%'
  ) then
    alter table public.ai_budgets
      add constraint ai_budgets_organization_id_key unique (organization_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Trigger function: atomic upsert of current_month_consumed_cents.
-- ---------------------------------------------------------------------------
create or replace function public.fn_update_budget_consumption()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.ai_budgets (organization_id, current_month_consumed_cents)
  values (NEW.organization_id, coalesce(NEW.cost_cents, 0))
  on conflict (organization_id) do update
  set current_month_consumed_cents =
        public.ai_budgets.current_month_consumed_cents
        + coalesce(NEW.cost_cents, 0),
      updated_at = now();
  return NEW;
end;
$$;

revoke all on function public.fn_update_budget_consumption() from public, anon, authenticated;

drop trigger if exists trg_ai_invocations_budget on public.ai_invocations;
create trigger trg_ai_invocations_budget
  after insert on public.ai_invocations
  for each row
  execute function public.fn_update_budget_consumption();
