-- Cakto is opt-in; existing subscriptions and resource/AI limits are preserved.
alter table public.org_subscriptions drop constraint if exists org_subscriptions_provider_check;
alter table public.org_subscriptions add constraint org_subscriptions_provider_check check(provider in ('stripe','asaas','mercadopago','cakto'));
alter table public.org_subscriptions add column if not exists cakto_paid_order_id uuid;
alter table public.org_subscriptions add column if not exists cakto_paid_period integer;
-- A Cakto buyer can pay for multiple organizations. Subscription and checkout
-- correlation bind the tenant; buyer identity alone must never bind access.
alter table public.org_subscriptions drop constraint if exists org_subscriptions_provider_provider_customer_id_key;
create unique index if not exists org_subscriptions_non_cakto_customer on public.org_subscriptions(provider,provider_customer_id) where provider<>'cakto';
create unique index if not exists org_subscriptions_cakto_attempt on public.org_subscriptions(checkout_attempt_id) where provider='cakto';
-- Platform ingress queue before tenant resolution. No customer payload, secret,
-- address, email, or payment details are stored. Tenants have no access.
create table if not exists public.cakto_billing_inbox(
 id text primary key,
 order_id uuid not null,
 event_type text not null,
 received_at timestamptz not null default now(),
 retry_at timestamptz not null default now(),
 attempts integer not null default 0,
 last_error text,
 processed_at timestamptz
);
alter table public.cakto_billing_inbox enable row level security;
revoke all on public.cakto_billing_inbox from public,anon,authenticated;
grant all on public.cakto_billing_inbox to service_role;
create index if not exists cakto_billing_inbox_pending on public.cakto_billing_inbox(retry_at) where processed_at is null;
