-- 0240 — vínculo explícito entre Contato CRM e Pessoa Advomax.
create table if not exists public.advomax_contact_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  pessoa_codigo bigint not null,
  status text not null default 'pending' check (status in ('pending','linked','conflict','unlinked')),
  authority_source text not null default 'advomax',
  authority_epoch bigint not null default 1,
  last_synced_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, contact_id),
  unique (organization_id, pessoa_codigo)
);
create index if not exists idx_advomax_contact_links_org_status
  on public.advomax_contact_links (organization_id, status, updated_at desc);
alter table public.advomax_contact_links enable row level security;
drop policy if exists advomax_contact_links_select on public.advomax_contact_links;
create policy advomax_contact_links_select on public.advomax_contact_links
  for select using (organization_id in (select public.fn_user_org_ids()));
drop policy if exists advomax_contact_links_insert on public.advomax_contact_links;
create policy advomax_contact_links_insert on public.advomax_contact_links
  for insert with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  );
drop policy if exists advomax_contact_links_update on public.advomax_contact_links;
create policy advomax_contact_links_update on public.advomax_contact_links
  for update using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  ) with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  );
drop policy if exists advomax_contact_links_delete on public.advomax_contact_links;
create policy advomax_contact_links_delete on public.advomax_contact_links
  for delete using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  );
revoke all on public.advomax_contact_links from anon;
drop trigger if exists trg_advomax_contact_links_updated_at on public.advomax_contact_links;
create trigger trg_advomax_contact_links_updated_at
  before update on public.advomax_contact_links
  for each row execute function public.fn_set_updated_at();
