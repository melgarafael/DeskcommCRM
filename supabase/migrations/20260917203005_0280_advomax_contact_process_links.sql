-- 0244 — referência durável Contato CRM ↔ Processo Advomax; o dossiê jurídico não é copiado para o CRM.
create unique index if not exists contacts_organization_id_id_key
  on public.contacts (organization_id, id);

create table if not exists public.advomax_contact_process_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  contact_id uuid not null,
  processo_codigo bigint not null check (processo_codigo > 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (organization_id, contact_id, processo_codigo),
  foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete cascade
);

create index if not exists idx_advomax_contact_process_links_org_contact
  on public.advomax_contact_process_links (organization_id, contact_id, created_at desc);

alter table public.advomax_contact_process_links enable row level security;
drop policy if exists advomax_contact_process_links_select on public.advomax_contact_process_links;
create policy advomax_contact_process_links_select on public.advomax_contact_process_links
  for select using (organization_id in (select public.fn_user_org_ids()));
drop policy if exists advomax_contact_process_links_insert on public.advomax_contact_process_links;
create policy advomax_contact_process_links_insert on public.advomax_contact_process_links
  for insert with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  );
drop policy if exists advomax_contact_process_links_update on public.advomax_contact_process_links;
create policy advomax_contact_process_links_update on public.advomax_contact_process_links
  for update using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  ) with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  );
drop policy if exists advomax_contact_process_links_delete on public.advomax_contact_process_links;
create policy advomax_contact_process_links_delete on public.advomax_contact_process_links
  for delete using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  );
revoke all on public.advomax_contact_process_links from anon;
