-- A conta autenticada não recebe organização automaticamente. Ela solicita a
-- criação de uma empresa ou a entrada em uma já existente, e a decisão ocorre
-- pelo administrador correto fora do cliente.
create table if not exists public.registration_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('create_organization', 'join_organization')),
  requested_organization_name text,
  requested_organization_id uuid references public.organizations(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint registration_requests_target_check check (
    (kind = 'create_organization' and requested_organization_name is not null and requested_organization_id is null)
    or
    (kind = 'join_organization' and requested_organization_name is null and requested_organization_id is not null)
  ),
  constraint registration_requests_decision_check check (
    (status = 'pending' and decided_at is null and decided_by is null)
    or
    (status in ('approved', 'rejected') and decided_at is not null and decided_by is not null)
  )
);

create unique index if not exists registration_requests_one_pending_create_per_user
  on public.registration_requests(user_id)
  where status = 'pending' and kind = 'create_organization';

create unique index if not exists registration_requests_one_pending_join_per_user_org
  on public.registration_requests(user_id, requested_organization_id)
  where status = 'pending' and kind = 'join_organization';

create index if not exists registration_requests_pending_target_idx
  on public.registration_requests(requested_organization_id, created_at)
  where status = 'pending' and kind = 'join_organization';

alter table public.registration_requests enable row level security;
revoke all on public.registration_requests from anon, authenticated;
grant select, insert, update on public.registration_requests to service_role;

drop trigger if exists trg_registration_requests_updated_at on public.registration_requests;
create trigger trg_registration_requests_updated_at
  before update on public.registration_requests
  for each row execute function public.fn_set_updated_at();
