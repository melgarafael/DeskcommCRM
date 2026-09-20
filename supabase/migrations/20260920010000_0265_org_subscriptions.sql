-- Subscription state is written only by trusted billing handlers, never by a tenant.
create table if not exists public.org_subscriptions (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  plan_id text check (plan_id in ('essencial','crescer','escala')),
  provider text not null default 'stripe' check (provider in ('stripe','asaas','mercadopago')),
  provider_customer_id text,
  provider_subscription_id text,
  status text not null default 'pending' check (status in ('pending','trialing','active','past_due','canceled','unpaid','incomplete','incomplete_expired','paused')),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  checkout_session_id text,
  checkout_url text,
  checkout_expires_at timestamptz,
  checkout_attempt_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_subscription_id),
  unique (provider, provider_customer_id)
);
alter table public.org_subscriptions enable row level security;
revoke all on public.org_subscriptions from anon, authenticated;
grant select on public.org_subscriptions to authenticated;
grant all on public.org_subscriptions to service_role;
drop policy if exists tenant_isolation_org_subscriptions_select on public.org_subscriptions;
create policy tenant_isolation_org_subscriptions_select on public.org_subscriptions
  for select to authenticated using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_user_role_in_org(organization_id) = 'admin'
  );

create table if not exists public.billing_webhook_events (
  provider text not null,
  event_id text not null,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_type text not null,
  processed_at timestamptz not null default now(),
  primary key (provider, event_id)
);
alter table public.billing_webhook_events enable row level security;
revoke all on public.billing_webhook_events from anon, authenticated;
grant all on public.billing_webhook_events to service_role;
