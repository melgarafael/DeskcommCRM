create or replace function public.fn_academia_catalog_write_allowed(p_org uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select auth.uid() is not null and public.fn_role_at_least(p_org,'manager')
 and public.fn_support_write_allowed(p_org) and public.fn_session_mfa_proven()
 and exists(select 1 from public.organizations where id=p_org and settings->'modules'->'academia'='true'::jsonb);
$$;
revoke all on function public.fn_academia_catalog_write_allowed(uuid) from public,anon,authenticated;
grant execute on function public.fn_academia_catalog_write_allowed(uuid) to authenticated;
-- 0234 — cadastros tenant-aware da academia, sem dados comerciais presumidos.
create or replace function public.fn_academia_catalog_revision() returns trigger
language plpgsql set search_path=public as $$
begin
 new.revision := old.revision + 1;
 new.updated_at := clock_timestamp();
 return new;
end; $$;
revoke all on function public.fn_academia_catalog_revision() from public,anon,authenticated;

create table if not exists public.academia_audiences (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 name text not null check(length(btrim(name)) between 1 and 120),
 notes text not null default '' check(length(notes)<=2000),
 active boolean not null default true,
 min_age integer check(min_age between 0 and 120),
 max_age integer check(max_age between 0 and 120),
 age_pending boolean not null default true,
 check(min_age is null or max_age is null or min_age<=max_age),
 revision integer not null default 1,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(organization_id,id)
);
create unique index if not exists academia_audiences_name_unique on public.academia_audiences(organization_id,lower(btrim(name)));
alter table public.academia_audiences enable row level security;
revoke all on public.academia_audiences from public,anon,authenticated;
grant select on public.academia_audiences to authenticated;
grant insert(id,organization_id,name,notes,active,min_age,max_age,age_pending) on public.academia_audiences to authenticated;
grant update(name,notes,active,min_age,max_age,age_pending) on public.academia_audiences to authenticated;
grant all on public.academia_audiences to service_role;
drop policy if exists tenant_isolation_academia_audiences_all on public.academia_audiences;
create policy tenant_isolation_academia_audiences_all on public.academia_audiences for select to authenticated
 using(organization_id in (select public.fn_user_org_ids()) and exists(
 select 1 from public.organizations o where o.id=organization_id and o.settings->'modules'->'academia'='true'::jsonb));
drop policy if exists academia_audiences_insert on public.academia_audiences;
create policy academia_audiences_insert on public.academia_audiences for insert to authenticated
 with check(public.fn_role_at_least(organization_id,'manager') and public.fn_support_write_allowed(organization_id)
 and public.fn_academia_catalog_write_allowed(organization_id) and organization_id in (select public.fn_user_org_ids())
 and exists(select 1 from public.organizations o where o.id=organization_id and o.settings->'modules'->'academia'='true'::jsonb));
drop policy if exists academia_audiences_update on public.academia_audiences;
create policy academia_audiences_update on public.academia_audiences for update to authenticated
 using(public.fn_role_at_least(organization_id,'manager') and public.fn_support_write_allowed(organization_id)
 and public.fn_academia_catalog_write_allowed(organization_id) and organization_id in (select public.fn_user_org_ids())
 and exists(select 1 from public.organizations o where o.id=organization_id and o.settings->'modules'->'academia'='true'::jsonb))
 with check(public.fn_role_at_least(organization_id,'manager') and public.fn_support_write_allowed(organization_id)
 and public.fn_academia_catalog_write_allowed(organization_id) and organization_id in (select public.fn_user_org_ids())
 and exists(select 1 from public.organizations o where o.id=organization_id and o.settings->'modules'->'academia'='true'::jsonb));
drop trigger if exists academia_revision on public.academia_audiences;
create trigger academia_revision before update on public.academia_audiences for each row execute function public.fn_academia_catalog_revision();

create table if not exists public.academia_modalities (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 name text not null check(length(btrim(name)) between 1 and 120),
 notes text not null default '' check(length(notes)<=2000),
 active boolean not null default true,
 aliases text[] not null default '{}' check(cardinality(aliases)<=20),
 revision integer not null default 1,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(organization_id,id)
);
create unique index if not exists academia_modalities_name_unique on public.academia_modalities(organization_id,lower(btrim(name)));
alter table public.academia_modalities enable row level security;
revoke all on public.academia_modalities from public,anon,authenticated;
grant select on public.academia_modalities to authenticated;
grant insert(id,organization_id,name,notes,active,aliases) on public.academia_modalities to authenticated;
grant update(name,notes,active,aliases) on public.academia_modalities to authenticated;
grant all on public.academia_modalities to service_role;
drop policy if exists tenant_isolation_academia_modalities_all on public.academia_modalities;
create policy tenant_isolation_academia_modalities_all on public.academia_modalities for select to authenticated
 using(organization_id in (select public.fn_user_org_ids()) and exists(
 select 1 from public.organizations o where o.id=organization_id and o.settings->'modules'->'academia'='true'::jsonb));
drop policy if exists academia_modalities_insert on public.academia_modalities;
create policy academia_modalities_insert on public.academia_modalities for insert to authenticated
 with check(public.fn_role_at_least(organization_id,'manager') and public.fn_support_write_allowed(organization_id)
 and public.fn_academia_catalog_write_allowed(organization_id) and organization_id in (select public.fn_user_org_ids())
 and exists(select 1 from public.organizations o where o.id=organization_id and o.settings->'modules'->'academia'='true'::jsonb));
drop policy if exists academia_modalities_update on public.academia_modalities;
create policy academia_modalities_update on public.academia_modalities for update to authenticated
 using(public.fn_role_at_least(organization_id,'manager') and public.fn_support_write_allowed(organization_id)
 and public.fn_academia_catalog_write_allowed(organization_id) and organization_id in (select public.fn_user_org_ids())
 and exists(select 1 from public.organizations o where o.id=organization_id and o.settings->'modules'->'academia'='true'::jsonb))
 with check(public.fn_role_at_least(organization_id,'manager') and public.fn_support_write_allowed(organization_id)
 and public.fn_academia_catalog_write_allowed(organization_id) and organization_id in (select public.fn_user_org_ids())
 and exists(select 1 from public.organizations o where o.id=organization_id and o.settings->'modules'->'academia'='true'::jsonb));
drop trigger if exists academia_revision on public.academia_modalities;
create trigger academia_revision before update on public.academia_modalities for each row execute function public.fn_academia_catalog_revision();

create table if not exists public.academia_teachers (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 name text not null check(length(btrim(name)) between 1 and 120),
 notes text not null default '' check(length(notes)<=2000),
 active boolean not null default true,

 revision integer not null default 1,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(organization_id,id)
);
create unique index if not exists academia_teachers_name_unique on public.academia_teachers(organization_id,lower(btrim(name)));
alter table public.academia_teachers enable row level security;
revoke all on public.academia_teachers from public,anon,authenticated;
grant select on public.academia_teachers to authenticated;
grant insert(id,organization_id,name,notes,active) on public.academia_teachers to authenticated;
grant update(name,notes,active) on public.academia_teachers to authenticated;
grant all on public.academia_teachers to service_role;
drop policy if exists tenant_isolation_academia_teachers_all on public.academia_teachers;
create policy tenant_isolation_academia_teachers_all on public.academia_teachers for select to authenticated
 using(organization_id in (select public.fn_user_org_ids()) and exists(
 select 1 from public.organizations o where o.id=organization_id and o.settings->'modules'->'academia'='true'::jsonb));
drop policy if exists academia_teachers_insert on public.academia_teachers;
create policy academia_teachers_insert on public.academia_teachers for insert to authenticated
 with check(public.fn_role_at_least(organization_id,'manager') and public.fn_support_write_allowed(organization_id)
 and public.fn_academia_catalog_write_allowed(organization_id) and organization_id in (select public.fn_user_org_ids())
 and exists(select 1 from public.organizations o where o.id=organization_id and o.settings->'modules'->'academia'='true'::jsonb));
drop policy if exists academia_teachers_update on public.academia_teachers;
create policy academia_teachers_update on public.academia_teachers for update to authenticated
 using(public.fn_role_at_least(organization_id,'manager') and public.fn_support_write_allowed(organization_id)
 and public.fn_academia_catalog_write_allowed(organization_id) and organization_id in (select public.fn_user_org_ids())
 and exists(select 1 from public.organizations o where o.id=organization_id and o.settings->'modules'->'academia'='true'::jsonb))
 with check(public.fn_role_at_least(organization_id,'manager') and public.fn_support_write_allowed(organization_id)
 and public.fn_academia_catalog_write_allowed(organization_id) and organization_id in (select public.fn_user_org_ids())
 and exists(select 1 from public.organizations o where o.id=organization_id and o.settings->'modules'->'academia'='true'::jsonb));
drop trigger if exists academia_revision on public.academia_teachers;
create trigger academia_revision before update on public.academia_teachers for each row execute function public.fn_academia_catalog_revision();

create table if not exists public.academia_spaces (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 name text not null check(length(btrim(name)) between 1 and 120),
 notes text not null default '' check(length(notes)<=2000),
 active boolean not null default true,

 revision integer not null default 1,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(organization_id,id)
);
create unique index if not exists academia_spaces_name_unique on public.academia_spaces(organization_id,lower(btrim(name)));
alter table public.academia_spaces enable row level security;
revoke all on public.academia_spaces from public,anon,authenticated;
grant select on public.academia_spaces to authenticated;
grant insert(id,organization_id,name,notes,active) on public.academia_spaces to authenticated;
grant update(name,notes,active) on public.academia_spaces to authenticated;
grant all on public.academia_spaces to service_role;
drop policy if exists tenant_isolation_academia_spaces_all on public.academia_spaces;
create policy tenant_isolation_academia_spaces_all on public.academia_spaces for select to authenticated
 using(organization_id in (select public.fn_user_org_ids()) and exists(
 select 1 from public.organizations o where o.id=organization_id and o.settings->'modules'->'academia'='true'::jsonb));
drop policy if exists academia_spaces_insert on public.academia_spaces;
create policy academia_spaces_insert on public.academia_spaces for insert to authenticated
 with check(public.fn_role_at_least(organization_id,'manager') and public.fn_support_write_allowed(organization_id)
 and public.fn_academia_catalog_write_allowed(organization_id) and organization_id in (select public.fn_user_org_ids())
 and exists(select 1 from public.organizations o where o.id=organization_id and o.settings->'modules'->'academia'='true'::jsonb));
drop policy if exists academia_spaces_update on public.academia_spaces;
create policy academia_spaces_update on public.academia_spaces for update to authenticated
 using(public.fn_role_at_least(organization_id,'manager') and public.fn_support_write_allowed(organization_id)
 and public.fn_academia_catalog_write_allowed(organization_id) and organization_id in (select public.fn_user_org_ids())
 and exists(select 1 from public.organizations o where o.id=organization_id and o.settings->'modules'->'academia'='true'::jsonb))
 with check(public.fn_role_at_least(organization_id,'manager') and public.fn_support_write_allowed(organization_id)
 and public.fn_academia_catalog_write_allowed(organization_id) and organization_id in (select public.fn_user_org_ids())
 and exists(select 1 from public.organizations o where o.id=organization_id and o.settings->'modules'->'academia'='true'::jsonb));
drop trigger if exists academia_revision on public.academia_spaces;
create trigger academia_revision before update on public.academia_spaces for each row execute function public.fn_academia_catalog_revision();
notify pgrst,'reload schema';
