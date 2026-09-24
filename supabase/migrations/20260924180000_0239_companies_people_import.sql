-- 0239_companies_people_import
--
-- Fase 1 do CRM B2B: companies → company_people → people → contacts.person_id.
-- Aditivo e idempotente. NÃO altera uniques de contacts/conversations/messages
-- nem o comportamento de fn_upsert_wa_contact (person_id permanece NULL no
-- upsert WAHA). organizations.cnpj continua sendo o CNPJ do TENANT, não de
-- clientes — empresas clientes vivem em public.companies.

-- ---------------------------------------------------------------------------
-- 1. companies
-- ---------------------------------------------------------------------------
create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  legal_name text,
  trade_name text,
  cnpj text,
  normalized_cnpj text,
  registration_status text,
  legal_nature text,
  company_size text,
  share_capital numeric,
  opened_at date,
  main_cnae_code text,
  main_cnae_description text,
  secondary_cnaes jsonb not null default '[]'::jsonb,
  street text,
  number text,
  complement text,
  district text,
  city text,
  state text,
  zip_code text,
  email text,
  phone text,
  enrichment_status text not null default 'pending'
    check (enrichment_status in ('pending', 'processing', 'completed', 'failed')),
  enriched_at timestamptz,
  enrichment_error text,
  brasilapi_raw jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint companies_normalized_cnpj_digits
    check (normalized_cnpj is null or normalized_cnpj ~ '^\d{14}$')
);

create index if not exists idx_companies_org_updated
  on public.companies (organization_id, updated_at desc);

create index if not exists idx_companies_org_trade
  on public.companies (organization_id, trade_name);

create unique index if not exists companies_org_normalized_cnpj_uidx
  on public.companies (organization_id, normalized_cnpj)
  where normalized_cnpj is not null;

alter table public.companies enable row level security;

drop policy if exists tenant_isolation_companies_all on public.companies;
create policy tenant_isolation_companies_all on public.companies
  for all
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

revoke all on table public.companies from anon;
grant select, insert, update, delete on table public.companies to authenticated;
grant all on table public.companies to service_role;

drop trigger if exists trg_companies_set_updated_at on public.companies;
create trigger trg_companies_set_updated_at
  before update on public.companies
  for each row execute function public.fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. people
-- ---------------------------------------------------------------------------
create table if not exists public.people (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  full_name text not null,
  normalized_name text,
  email text,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint people_full_name_nao_vazio check (length(btrim(full_name)) > 0)
);

create index if not exists idx_people_org_name
  on public.people (organization_id, normalized_name);

create index if not exists idx_people_org_updated
  on public.people (organization_id, updated_at desc);

alter table public.people enable row level security;

drop policy if exists tenant_isolation_people_all on public.people;
create policy tenant_isolation_people_all on public.people
  for all
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

revoke all on table public.people from anon;
grant select, insert, update, delete on table public.people to authenticated;
grant all on table public.people to service_role;

drop trigger if exists trg_people_set_updated_at on public.people;
create trigger trg_people_set_updated_at
  before update on public.people
  for each row execute function public.fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. company_people
-- ---------------------------------------------------------------------------
create table if not exists public.company_people (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  person_id uuid not null references public.people(id) on delete cascade,
  job_title text,
  department text,
  is_decision_maker boolean not null default false,
  is_primary boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint company_people_company_person_uidx unique (company_id, person_id)
);

create index if not exists idx_company_people_org
  on public.company_people (organization_id);

create index if not exists idx_company_people_person
  on public.company_people (organization_id, person_id);

create index if not exists idx_company_people_company
  on public.company_people (organization_id, company_id);

alter table public.company_people enable row level security;

drop policy if exists tenant_isolation_company_people_all on public.company_people;
create policy tenant_isolation_company_people_all on public.company_people
  for all
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

revoke all on table public.company_people from anon;
grant select, insert, update, delete on table public.company_people to authenticated;
grant all on table public.company_people to service_role;

drop trigger if exists trg_company_people_set_updated_at on public.company_people;
create trigger trg_company_people_set_updated_at
  before update on public.company_people
  for each row execute function public.fn_set_updated_at();

-- Mesma organization entre vínculo, company e person (anti cross-tenant por FK).
create or replace function public.fn_company_people_same_org()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_company_org uuid;
  v_person_org uuid;
begin
  select organization_id into v_company_org
    from public.companies where id = new.company_id;
  select organization_id into v_person_org
    from public.people where id = new.person_id;

  if v_company_org is null then
    raise exception 'company_people: company_id inexistente';
  end if;
  if v_person_org is null then
    raise exception 'company_people: person_id inexistente';
  end if;
  if new.organization_id is distinct from v_company_org
     or new.organization_id is distinct from v_person_org then
    raise exception 'company_people: organization_id deve coincidir com company e person';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_company_people_same_org() from public, anon;
-- trigger functions are owned; no grant needed for callers

drop trigger if exists trg_company_people_same_org on public.company_people;
create trigger trg_company_people_same_org
  before insert or update on public.company_people
  for each row execute function public.fn_company_people_same_org();

-- ---------------------------------------------------------------------------
-- 4. contacts.person_id (aditivo, nullable)
-- ---------------------------------------------------------------------------
alter table public.contacts
  add column if not exists person_id uuid references public.people(id) on delete set null;

create index if not exists idx_contacts_org_person
  on public.contacts (organization_id, person_id)
  where person_id is not null;

create or replace function public.fn_contacts_person_same_org()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_person_org uuid;
begin
  if new.person_id is null then
    return new;
  end if;
  select organization_id into v_person_org
    from public.people where id = new.person_id;
  if v_person_org is null then
    raise exception 'contacts.person_id: pessoa inexistente';
  end if;
  if new.organization_id is distinct from v_person_org then
    raise exception 'contacts.person_id: organization_id deve coincidir com a pessoa';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_contacts_person_same_org() from public, anon;

drop trigger if exists trg_contacts_person_same_org on public.contacts;
create trigger trg_contacts_person_same_org
  before insert or update of person_id, organization_id on public.contacts
  for each row execute function public.fn_contacts_person_same_org();

-- ---------------------------------------------------------------------------
-- 5. import_batches / import_rows
-- ---------------------------------------------------------------------------
create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null default 'companies_people'
    check (kind in ('companies_people', 'contacts')),
  filename text not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed')),
  total_rows integer not null default 0,
  processed_rows integer not null default 0,
  successful_rows integer not null default 0,
  failed_rows integer not null default 0,
  conflict_rows integer not null default 0,
  column_mapping jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists idx_import_batches_org_created
  on public.import_batches (organization_id, created_at desc);

alter table public.import_batches enable row level security;

drop policy if exists tenant_isolation_import_batches_all on public.import_batches;
create policy tenant_isolation_import_batches_all on public.import_batches
  for all
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

revoke all on table public.import_batches from anon;
grant select, insert, update, delete on table public.import_batches to authenticated;
grant all on table public.import_batches to service_role;

drop trigger if exists trg_import_batches_set_updated_at on public.import_batches;
create trigger trg_import_batches_set_updated_at
  before update on public.import_batches
  for each row execute function public.fn_set_updated_at();

create table if not exists public.import_rows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  batch_id uuid not null references public.import_batches(id) on delete cascade,
  row_number integer not null,
  raw_data jsonb not null default '{}'::jsonb,
  normalized_data jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'success', 'conflict', 'failed')),
  error text,
  company_id uuid references public.companies(id) on delete set null,
  person_id uuid references public.people(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint import_rows_batch_row_uidx unique (batch_id, row_number)
);

create index if not exists idx_import_rows_batch_status
  on public.import_rows (batch_id, status);

create index if not exists idx_import_rows_org
  on public.import_rows (organization_id);

alter table public.import_rows enable row level security;

drop policy if exists tenant_isolation_import_rows_all on public.import_rows;
create policy tenant_isolation_import_rows_all on public.import_rows
  for all
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

revoke all on table public.import_rows from anon;
grant select, insert, update, delete on table public.import_rows to authenticated;
grant all on table public.import_rows to service_role;

create or replace function public.fn_import_rows_same_org()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_batch_org uuid;
begin
  select organization_id into v_batch_org
    from public.import_batches where id = new.batch_id;
  if v_batch_org is null then
    raise exception 'import_rows: batch_id inexistente';
  end if;
  if new.organization_id is distinct from v_batch_org then
    raise exception 'import_rows: organization_id deve coincidir com o batch';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_import_rows_same_org() from public, anon;

drop trigger if exists trg_import_rows_same_org on public.import_rows;
create trigger trg_import_rows_same_org
  before insert or update on public.import_rows
  for each row execute function public.fn_import_rows_same_org();
