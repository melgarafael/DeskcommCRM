-- Native prospecting is an adapter to discovery, CRM creation and existing AI delivery.
-- Server-only tables: authenticated routes resolve the tenant and authorize every command.
create table if not exists public.prospecting_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  credential_encrypted bytea not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.prospecting_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  request_id uuid not null,
  name text not null,
  search jsonb not null,
  config jsonb,
  status text not null default 'draft' check (status in ('draft','running','paused','completed')),
  search_status text not null default 'starting' check (search_status in ('starting','running','succeeded','failed','unknown')),
  run_id text,
  dataset_id text,
  cost_usd numeric,
  result_count integer not null default 0,
  skipped_count integer not null default 0,
  error text,
  next_send_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, request_id)
);
create unique index if not exists prospecting_one_running_org on public.prospecting_campaigns(organization_id) where status='running';
create table if not exists public.prospecting_candidates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid not null,
  place_id text not null,
  phone text,
  data jsonb not null,
  status text not null default 'new' check (status in ('new','queued','sending','sent','skipped','failed')),
  contact_id uuid references public.contacts(id) on delete set null,
  lead_id uuid references public.crm_leads(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  service_boundary jsonb,
  message_id uuid not null default gen_random_uuid(),
  attempted_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, campaign_id) references public.prospecting_campaigns(organization_id,id) on delete cascade,
  unique (organization_id, place_id)
);
create unique index if not exists prospecting_phone_once_org on public.prospecting_candidates(organization_id,phone) where phone is not null;
create index if not exists prospecting_pending_campaign on public.prospecting_candidates(organization_id,campaign_id,status);
create index if not exists prospecting_conversation on public.prospecting_candidates(organization_id,conversation_id) where conversation_id is not null;
alter table public.prospecting_settings enable row level security;
alter table public.prospecting_campaigns enable row level security;
alter table public.prospecting_candidates enable row level security;
revoke all on public.prospecting_settings, public.prospecting_campaigns, public.prospecting_candidates from public, anon, authenticated;
grant all on public.prospecting_settings, public.prospecting_campaigns, public.prospecting_candidates to service_role;
notify pgrst, 'reload schema';
