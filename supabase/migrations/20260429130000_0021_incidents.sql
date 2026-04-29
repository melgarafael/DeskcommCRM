-- EPIC-11 wave 11 (S-11.11): incidents table
-- Platform-admins only (cross-tenant). Users do not see.

create table if not exists public.incidents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  type text not null,
  severity text not null check (severity in ('info','warning','critical')),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open','acknowledged','resolved')),
  acknowledged_at timestamptz,
  acknowledged_by uuid references auth.users(id),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id),
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists incidents_status_idx on public.incidents(status, created_at desc) where status != 'resolved';
create index if not exists incidents_org_idx on public.incidents(organization_id, created_at desc);
create index if not exists incidents_severity_idx on public.incidents(severity, status);

alter table public.incidents enable row level security;

create policy platform_admin_only_incidents on public.incidents for all
  using (public.fn_is_platform_admin()) with check (public.fn_is_platform_admin());

create trigger incidents_updated_at before update on public.incidents
  for each row execute function public.fn_set_updated_at();
