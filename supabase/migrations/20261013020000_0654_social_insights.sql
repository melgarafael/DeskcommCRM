-- manifest: tabelas de social_insights_connections e social_insights_daily (Instagram e Facebook)

create table if not exists public.social_insights_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  facebook_page_id text,
  facebook_page_name text,
  instagram_business_id text,
  instagram_username text,
  access_token_encrypted text,
  status text not null default 'connected',
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_social_insights_connections_org unique (organization_id)
);

create table if not exists public.social_insights_daily (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  platform text not null check (platform in ('facebook', 'instagram')),
  date date not null,
  impressions integer not null default 0,
  reach integer not null default 0,
  followers_count integer not null default 0,
  new_followers integer not null default 0,
  profile_views integer not null default 0,
  interactions integer not null default 0,
  raw_data jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_social_insights_daily_org_plat_date unique (organization_id, platform, date)
);

create index if not exists idx_social_insights_daily_org_date 
  on public.social_insights_daily (organization_id, date desc);

create index if not exists idx_social_insights_daily_org_plat_date 
  on public.social_insights_daily (organization_id, platform, date desc);

alter table public.social_insights_connections enable row level security;
alter table public.social_insights_daily enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies 
    where tablename = 'social_insights_connections' and policyname = 'social_insights_connections_org_select'
  ) then
    create policy social_insights_connections_org_select
      on public.social_insights_connections
      for select
      to authenticated
      using (organization_id in (select public.fn_user_org_ids()));
  end if;

  if not exists (
    select 1 from pg_policies 
    where tablename = 'social_insights_daily' and policyname = 'social_insights_daily_org_select'
  ) then
    create policy social_insights_daily_org_select
      on public.social_insights_daily
      for select
      to authenticated
      using (organization_id in (select public.fn_user_org_ids()));
  end if;
end $$;
