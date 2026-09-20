-- The commercial AI allowance follows the provider's billing cycle, not UTC month boundaries.
-- Existing rows stay unknown until reconciled with the provider; never infer a paid start date.
alter table public.org_subscriptions add column if not exists current_period_start timestamptz;
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname='org_subscriptions_period_order'
      and conrelid='public.org_subscriptions'::regclass
  ) then
    alter table public.org_subscriptions add constraint org_subscriptions_period_order check (
      current_period_start is null or (
        isfinite(current_period_start) and current_period_end is not null
        and isfinite(current_period_end) and current_period_start < current_period_end
      )
    );
  end if;
end $$;
