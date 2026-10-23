-- manifest: Agendas opt-in por serviço, programação e capacidade, preservando reservas individuais e vínculos Google existentes.
-- Operações de rede permanecem no executor Google; RPCs não fazem HTTP.

alter table public.calendar_event_types
  add column if not exists service_enabled boolean not null default false,
  add column if not exists booking_mode text not null default 'individual',
  add column if not exists service_capacity integer,
  add column if not exists service_timezone text not null default 'America/Sao_Paulo',
  add column if not exists destination_calendar_id uuid,
  add column if not exists service_publication_mode text not null default 'none',
  add column if not exists service_revision bigint not null default 1;

create unique index if not exists calendar_event_types_org_id_key on public.calendar_event_types(organization_id,id);
create unique index if not exists calendar_calendars_org_id_key on public.calendar_connection_calendars(organization_id,id);

do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.calendar_event_types'::regclass and conname='calendar_service_mode_valid') then
    alter table public.calendar_event_types add constraint calendar_service_mode_valid check(booking_mode in ('individual','collective_limited','collective_unlimited'));
    alter table public.calendar_event_types add constraint calendar_service_capacity_valid check(service_capacity is null or service_capacity between 1 and 100000);
    alter table public.calendar_event_types add constraint calendar_service_publication_valid check(service_publication_mode in ('none','service','professional'));
    alter table public.calendar_event_types add constraint calendar_service_destination_fk foreign key(organization_id,destination_calendar_id)
      references public.calendar_connection_calendars(organization_id,id) on delete set null(destination_calendar_id);
  end if;
end $$;

create table if not exists public.calendar_service_schedule (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_type_id uuid not null,
  weekday integer,
  on_date date,
  timing_kind text not null check(timing_kind in ('fixed','window')),
  start_minute integer not null check(start_minute between 0 and 1439),
  end_minute integer check(end_minute between 1 and 1440 and end_minute>start_minute),
  duration_minutes integer check(duration_minutes between 5 and 1440),
  capacity_rule text not null default 'inherit' check(capacity_rule in ('inherit','limited','unlimited')),
  capacity_limit integer check(capacity_limit between 1 and 100000),
  created_at timestamptz not null default now(),
  constraint calendar_service_schedule_type_fk foreign key(organization_id,event_type_id) references public.calendar_event_types(organization_id,id) on delete cascade,
  constraint calendar_service_schedule_scope_valid check((weekday is null)<>(on_date is null) and (weekday is null or weekday between 0 and 6)),
  constraint calendar_service_schedule_window_valid check(timing_kind<>'window' or end_minute is not null),
  constraint calendar_service_schedule_capacity_valid check(capacity_rule<>'limited' or capacity_limit is not null)
);
create index if not exists calendar_service_schedule_type_idx on public.calendar_service_schedule(organization_id,event_type_id,on_date,weekday);

create table if not exists public.calendar_service_professionals (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_type_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key(organization_id,event_type_id,user_id),
  foreign key(organization_id,event_type_id) references public.calendar_event_types(organization_id,id) on delete cascade
);

create table if not exists public.calendar_resources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check(length(trim(name)) between 1 and 80),
  capacity integer not null default 1 check(capacity between 1 and 100000),
  is_active boolean not null default true,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  unique(organization_id,id)
);
create table if not exists public.calendar_service_resources (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_type_id uuid not null,
  resource_id uuid not null,
  units integer not null default 1 check(units between 1 and 100000),
  primary key(organization_id,event_type_id,resource_id),
  foreign key(organization_id,event_type_id) references public.calendar_event_types(organization_id,id) on delete cascade,
  foreign key(organization_id,resource_id) references public.calendar_resources(organization_id,id) on delete restrict
);
create table if not exists public.calendar_service_calendar_sources (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_type_id uuid not null,
  calendar_id uuid not null,
  primary key(organization_id,event_type_id,calendar_id),
  foreign key(organization_id,event_type_id) references public.calendar_event_types(organization_id,id) on delete cascade,
  foreign key(organization_id,calendar_id) references public.calendar_connection_calendars(organization_id,id) on delete cascade
);

create table if not exists public.calendar_service_occurrences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_type_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null check(ends_at>starts_at),
  booking_mode text not null check(booking_mode in ('individual','collective_limited','collective_unlimited')),
  -- Coletiva divide uma ocorrência; individual usa o profissional real na chave.
  allocation_key uuid not null default '00000000-0000-0000-0000-000000000000',
  created_at timestamptz not null default now(),
  unique(organization_id,id),
  unique(organization_id,event_type_id,starts_at,ends_at,allocation_key),
  foreign key(organization_id,event_type_id) references public.calendar_event_types(organization_id,id) on delete restrict
);
create table if not exists public.calendar_service_occurrence_resources (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  occurrence_id uuid not null,
  resource_id uuid not null,
  units integer not null check(units between 1 and 100000),
  primary key(organization_id,occurrence_id,resource_id),
  foreign key(organization_id,occurrence_id) references public.calendar_service_occurrences(organization_id,id) on delete cascade,
  foreign key(organization_id,resource_id) references public.calendar_resources(organization_id,id) on delete restrict
);

alter table public.calendar_appointments
  add column if not exists service_occurrence_id uuid,
  add column if not exists participant_key text,
  add column if not exists participant_name text,
  add column if not exists service_booking_mode text,
  add column if not exists service_capacity_rule text,
  add column if not exists service_capacity_limit integer,
  add column if not exists service_rule_revision bigint,
  add column if not exists service_destination_calendar_id uuid,
  add column if not exists service_publication_mode text,
  add column if not exists service_requires_confirmation boolean,
  add column if not exists service_confirmed_by_user_id uuid references auth.users(id) on delete set null,
  add column if not exists service_confirmed_at timestamptz,
  add column if not exists service_operation_key text,
  add column if not exists service_operation_request jsonb,
  add column if not exists service_block boolean not null default false;
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.calendar_appointments'::regclass and conname='calendar_service_occurrence_fk') then
    alter table public.calendar_appointments add constraint calendar_service_occurrence_fk foreign key(organization_id,service_occurrence_id)
      references public.calendar_service_occurrences(organization_id,id) on delete restrict;
    alter table public.calendar_appointments add constraint calendar_service_appointment_destination_fk foreign key(organization_id,service_destination_calendar_id)
      references public.calendar_connection_calendars(organization_id,id) on delete set null(service_destination_calendar_id);
    alter table public.calendar_appointments add constraint calendar_service_participant_name_valid check(participant_name is null or length(participant_name) between 1 and 120);
  end if;
end $$;
create unique index if not exists calendar_service_participant_once on public.calendar_appointments(organization_id,service_occurrence_id,participant_key)
  where service_occurrence_id is not null and status in ('pending','confirmed');
create unique index if not exists calendar_service_operation_once on public.calendar_appointments(organization_id,service_operation_key)
  where service_operation_key is not null;
create index if not exists calendar_service_appointments_type_time on public.calendar_appointments(organization_id,event_type_id,starts_at,ends_at)
  where status in ('pending','confirmed');
create index if not exists calendar_service_confirmer_idx on public.calendar_appointments(service_confirmed_by_user_id);

create table if not exists public.calendar_service_blocks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  scope_kind text not null check(scope_kind in ('service','professional','resource')),
  event_type_id uuid,
  owner_user_id uuid references auth.users(id) on delete restrict,
  resource_id uuid,
  starts_at timestamptz not null,
  ends_at timestamptz not null check(ends_at>starts_at),
  reason text not null check(length(trim(reason)) between 1 and 300),
  operation_key uuid not null,
  publication_appointment_id uuid references public.calendar_appointments(id) on delete restrict,
  archived_at timestamptz,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  unique(organization_id,operation_key),
  foreign key(organization_id,event_type_id) references public.calendar_event_types(organization_id,id) on delete restrict,
  foreign key(organization_id,resource_id) references public.calendar_resources(organization_id,id) on delete restrict,
  constraint calendar_service_block_scope_valid check(
    (scope_kind='service' and event_type_id is not null and owner_user_id is null and resource_id is null) or
    (scope_kind='professional' and event_type_id is null and owner_user_id is not null and resource_id is null) or
    (scope_kind='resource' and event_type_id is null and owner_user_id is null and resource_id is not null))
);
create index if not exists calendar_service_blocks_time_idx on public.calendar_service_blocks(organization_id,starts_at,ends_at) where archived_at is null;
-- Reverse lookup for FKs and the corresponding source/resource/block queries.
create index if not exists calendar_service_appointment_destination_idx on public.calendar_appointments(organization_id,service_destination_calendar_id);
create index if not exists calendar_service_destination_idx on public.calendar_event_types(organization_id,destination_calendar_id);
create index if not exists calendar_service_block_type_idx on public.calendar_service_blocks(organization_id,event_type_id);
create index if not exists calendar_service_block_resource_idx on public.calendar_service_blocks(organization_id,resource_id);
create index if not exists calendar_service_block_owner_idx on public.calendar_service_blocks(owner_user_id,organization_id);
drop index if exists public.calendar_service_block_publication_idx;
create index calendar_service_block_publication_idx on public.calendar_service_blocks(organization_id,publication_appointment_id);
create index if not exists calendar_service_sources_calendar_idx on public.calendar_service_calendar_sources(organization_id,calendar_id);
create index if not exists calendar_service_occurrence_resource_idx on public.calendar_service_occurrence_resources(organization_id,resource_id);
create index if not exists calendar_service_professional_user_idx on public.calendar_service_professionals(user_id,organization_id);
create index if not exists calendar_service_resource_reverse_idx on public.calendar_service_resources(organization_id,resource_id);
-- Links de pessoa/publicação também precisam pertencer à organização do serviço.
create unique index if not exists calendar_service_appointment_org_id_idx on public.calendar_appointments(organization_id,id);
alter table public.calendar_service_professionals drop constraint if exists calendar_service_professionals_user_id_fkey;
alter table public.calendar_service_blocks drop constraint if exists calendar_service_blocks_owner_user_id_fkey;
alter table public.calendar_service_blocks drop constraint if exists calendar_service_blocks_publication_appointment_id_fkey;
do $$ begin
 if not exists(select 1 from pg_constraint where conname='calendar_service_professional_member_fk' and conrelid='public.calendar_service_professionals'::regclass) then
  alter table public.calendar_service_professionals add constraint calendar_service_professional_member_fk foreign key(organization_id,user_id) references public.user_organizations(organization_id,user_id) on delete cascade;end if;
 if not exists(select 1 from pg_constraint where conname='calendar_service_block_owner_member_fk' and conrelid='public.calendar_service_blocks'::regclass) then
  alter table public.calendar_service_blocks add constraint calendar_service_block_owner_member_fk foreign key(organization_id,owner_user_id) references public.user_organizations(organization_id,user_id) on delete cascade;end if;
 if not exists(select 1 from pg_constraint where conname='calendar_service_block_publication_org_fk' and conrelid='public.calendar_service_blocks'::regclass) then
  alter table public.calendar_service_blocks add constraint calendar_service_block_publication_org_fk foreign key(organization_id,publication_appointment_id) references public.calendar_appointments(organization_id,id);end if;
end $$;

-- Mutação somente pelas RPCs/handlers com ator e revisão; SELECT sob RLS para a UI.
-- As reservas novas são escritas pelas portas nativas security definer. Uma
-- escrita direta pela sessão não pode travar a linha antes da trava de estoque.
drop policy if exists service_appointments_native_insert on public.calendar_appointments;
create policy service_appointments_native_insert on public.calendar_appointments as restrictive for insert to authenticated
 with check (service_occurrence_id is null and not service_block);
drop policy if exists service_appointments_native_update on public.calendar_appointments;
create policy service_appointments_native_update on public.calendar_appointments as restrictive for update to authenticated
 using (service_occurrence_id is null and not service_block) with check (service_occurrence_id is null and not service_block);
drop policy if exists service_appointments_native_delete on public.calendar_appointments;
create policy service_appointments_native_delete on public.calendar_appointments as restrictive for delete to authenticated
 using (service_occurrence_id is null and not service_block);
do $$ declare tab text; begin
  foreach tab in array array['calendar_service_schedule','calendar_service_professionals','calendar_resources','calendar_service_resources',
    'calendar_service_calendar_sources','calendar_service_occurrences','calendar_service_occurrence_resources','calendar_service_blocks'] loop
    execute format('alter table public.%I enable row level security',tab);
    execute format('drop policy if exists %I on public.%I','tenant_isolation_'||tab||'_all',tab);
    execute format('create policy %I on public.%I for select to authenticated using (organization_id in (select public.fn_user_org_ids()))','tenant_isolation_'||tab||'_all',tab);
    execute format('revoke all on public.%I from public,anon,authenticated',tab);
    execute format('grant select on public.%I to authenticated',tab);
    execute format('grant select,insert,update,delete on public.%I to service_role',tab);
  end loop;
end $$;

create or replace function public.fn_calendar_service_lock(p_org uuid)
returns void language sql volatile security definer set search_path=public as $$
  select pg_advisory_xact_lock(hashtextextended(p_org::text||':calendar_inventory',0));
$$;
revoke all on function public.fn_calendar_service_lock(uuid) from public,anon,authenticated;
grant execute on function public.fn_calendar_service_lock(uuid) to service_role;

create or replace function public.fn_calendar_service_read(p_org uuid,p_type uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare t public.calendar_event_types; result jsonb;
begin
  if auth.uid() is not null and not public.fn_role_at_least(p_org,'viewer') then raise exception 'service_forbidden' using errcode='42501';end if;
  if auth.uid() is null and current_setting('role',true)='authenticated' then raise exception 'service_forbidden' using errcode='42501';end if;
  select * into t from public.calendar_event_types where organization_id=p_org and id=p_type;
  if not found then return null;end if;
  result:=jsonb_build_object('event_type_id',t.id,'name',t.name,'slug',t.slug,'is_active',t.is_active,
    'service_enabled',t.service_enabled,'booking_mode',t.booking_mode,'service_capacity',t.service_capacity,'service_timezone',t.service_timezone,
    'duration_minutes',t.duration_minutes,'slot_interval_minutes',t.slot_interval_minutes,'minimum_notice_minutes',t.minimum_notice_minutes,
    'booking_window_days',t.booking_window_days,'buffer_before_minutes',t.buffer_before_minutes,'buffer_after_minutes',t.buffer_after_minutes,
    'requires_confirmation',t.requires_confirmation,'destination_calendar_id',t.destination_calendar_id,'service_revision',t.service_revision,'service_publication_mode',t.service_publication_mode,
    'schedule',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'weekday',s.weekday,'on_date',s.on_date,'timing_kind',s.timing_kind,
      'start_minute',s.start_minute,'end_minute',s.end_minute,'duration_minutes',s.duration_minutes,'capacity_rule',s.capacity_rule,'capacity_limit',s.capacity_limit)
      order by s.on_date,s.weekday,s.start_minute) from public.calendar_service_schedule s where s.organization_id=p_org and s.event_type_id=p_type),'[]'::jsonb),
    'professionals',coalesce((select jsonb_agg(s.user_id order by s.user_id) from public.calendar_service_professionals s where s.organization_id=p_org and s.event_type_id=p_type),'[]'::jsonb),
    'resources',coalesce((select jsonb_agg(jsonb_build_object('resource_id',s.resource_id,'units',s.units)) from public.calendar_service_resources s where s.organization_id=p_org and s.event_type_id=p_type),'[]'::jsonb),
    'calendar_sources',coalesce((select jsonb_agg(s.calendar_id order by s.calendar_id) from public.calendar_service_calendar_sources s where s.organization_id=p_org and s.event_type_id=p_type),'[]'::jsonb));
  return result;
end $$;
revoke all on function public.fn_calendar_service_read(uuid,uuid) from public,anon;
grant execute on function public.fn_calendar_service_read(uuid,uuid) to authenticated,service_role;

-- Reativação legada não pode oferecer um serviço que ainda está em rascunho.
-- Mudanças nos campos do tipo também invalidam a revisão da consulta anterior.
create or replace function public.fn_calendar_service_type_guard()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if tg_op='UPDATE' and (new.service_enabled or old.service_enabled) then
  if row(new.is_active,new.service_enabled,new.booking_mode,new.service_capacity,new.duration_minutes,new.buffer_before_minutes,new.buffer_after_minutes,
    new.minimum_notice_minutes,new.booking_window_days,new.slot_interval_minutes,new.service_timezone,new.requires_confirmation,new.service_publication_mode,new.destination_calendar_id)
    is distinct from row(old.is_active,old.service_enabled,old.booking_mode,old.service_capacity,old.duration_minutes,old.buffer_before_minutes,old.buffer_after_minutes,
    old.minimum_notice_minutes,old.booking_window_days,old.slot_interval_minutes,old.service_timezone,old.requires_confirmation,old.service_publication_mode,old.destination_calendar_id)
   then new.service_revision:=greatest(new.service_revision,old.service_revision+1);end if;
  if new.service_enabled and new.is_active and (not exists(select 1 from public.calendar_service_schedule where organization_id=new.organization_id and event_type_id=new.id)
    or (new.booking_mode='individual' and not exists(select 1 from public.calendar_service_professionals p join public.user_organizations m
      on m.organization_id=p.organization_id and m.user_id=p.user_id and m.revoked_at is null where p.organization_id=new.organization_id and p.event_type_id=new.id)))
    then raise exception 'service_configuration_invalid' using errcode='22023';end if;
 end if;
 if tg_op='INSERT' and auth.uid() is not null and new.service_enabled and new.is_active then
  raise exception 'service_configuration_invalid' using errcode='22023';end if;
 return new;
end $$;
revoke all on function public.fn_calendar_service_type_guard() from public,anon,authenticated;
grant execute on function public.fn_calendar_service_type_guard() to service_role;
drop trigger if exists trg_calendar_service_type_guard on public.calendar_event_types;
create trigger trg_calendar_service_type_guard before insert or update on public.calendar_event_types for each row execute function public.fn_calendar_service_type_guard();

create or replace function public.fn_calendar_service_assert_actor(p_org uuid,p_actor jsonb,p_role text)
returns void language plpgsql stable security definer set search_path=public as $$
declare actor_id uuid; actor_kind text:=p_actor->>'type';required integer;token_id uuid;
begin
  if actor_kind='user' then
    actor_id:=(p_actor->>'id')::uuid;
    required:=case p_role when 'manager' then 4 when 'viewer' then 1 else 2 end;
    if not exists(select 1 from public.user_organizations where organization_id=p_org and user_id=actor_id and revoked_at is null
      and case role when 'admin' then 5 when 'manager' then 4 when 'ai_operator' then 3 when 'agent' then 2 else 1 end>=required)
      then raise exception 'service_actor_forbidden' using errcode='42501';end if;
    if auth.uid() is not null and (auth.uid()<>actor_id or not public.fn_support_write_allowed(p_org) or not public.fn_session_mfa_proven())
      then raise exception 'service_actor_forbidden' using errcode='42501';end if;
  elsif actor_kind is null or actor_kind not in ('api_token','ai_agent') or (actor_kind='ai_agent' and p_role='manager') then
    raise exception 'service_actor_forbidden' using errcode='42501';
  end if;
  token_id:=case when actor_kind='api_token' then (p_actor->>'id')::uuid when actor_kind='ai_agent' then (p_actor->>'api_token_id')::uuid else null end;
  if token_id is not null and not exists(select 1 from public.api_tokens k where k.organization_id=p_org and k.id=token_id
    and k.revoked_at is null and (k.expires_at is null or k.expires_at>now()) and k.scopes ? 'mcp:write'
    and coalesce((select max(case value when 'role:admin' then 5 when 'role:manager' then 4 when 'role:ai_operator' then 3 when 'role:agent' then 2 when 'role:viewer' then 1 end)
      from jsonb_array_elements_text(case when jsonb_typeof(k.scopes)='array' then k.scopes else '[]'::jsonb end)),2)>=case when p_role='manager' then 4 else 2 end)
    then raise exception 'service_actor_forbidden' using errcode='42501';end if;
end $$;
revoke all on function public.fn_calendar_service_assert_actor(uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.fn_calendar_service_assert_actor(uuid,jsonb,text) to service_role;

create or replace function public.fn_calendar_service_configure(p_org uuid,p_actor jsonb,p_config jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare t public.calendar_event_types; item jsonb;type_id uuid:=(p_config->>'event_type_id')::uuid; cal uuid;
begin
  perform public.fn_calendar_service_assert_actor(p_org,p_actor,'manager');
  perform public.fn_calendar_service_lock(p_org);
  select * into t from public.calendar_event_types where organization_id=p_org and id=type_id for update;
  if not found then raise exception 'service_not_found' using errcode='P0002';end if;
  if t.service_revision is distinct from (p_config->>'expected_revision')::bigint then raise exception 'service_stale' using errcode='PT409';end if;
  if not exists(select 1 from pg_timezone_names where name=p_config->>'service_timezone') then raise exception 'service_timezone_invalid' using errcode='22023';end if;
  if jsonb_array_length(p_config->'schedule')>256 or jsonb_array_length(p_config->'professionals')>100
    or jsonb_array_length(p_config->'resources')>50 or jsonb_array_length(p_config->'calendar_sources')>100 then raise exception 'service_configuration_too_large' using errcode='22023';end if;
  if p_config->>'booking_mode' not in ('individual','collective_limited','collective_unlimited')
    or (p_config->>'booking_mode'='collective_limited' and not coalesce((p_config->>'service_capacity')::integer between 1 and 100000,false))
    or (coalesce((p_config->>'service_enabled')::boolean,false) and coalesce((p_config->>'is_active')::boolean,t.is_active) and (jsonb_array_length(p_config->'schedule')=0
      or (p_config->>'booking_mode'='individual' and jsonb_array_length(p_config->'professionals')=0)))
    then raise exception 'service_configuration_invalid' using errcode='22023';end if;
  if coalesce(p_config->>'service_publication_mode','none') not in ('none','service','professional')
    or (p_config->>'service_publication_mode'='service' and p_config->>'destination_calendar_id' is null)
    or (p_config->>'service_publication_mode'='professional' and jsonb_array_length(p_config->'professionals')=0)
    then raise exception 'service_publication_invalid' using errcode='22023';end if;
  for item in select value from jsonb_array_elements(p_config->'professionals') loop
    if not exists(select 1 from public.user_organizations where organization_id=p_org and user_id=(item#>>'{}')::uuid and revoked_at is null)
      then raise exception 'service_professional_unavailable' using errcode='42501';end if;
  end loop;
  for item in select value from jsonb_array_elements(p_config->'resources') loop
    if not exists(select 1 from public.calendar_resources where organization_id=p_org and id=(item->>'resource_id')::uuid and is_active
      and (item->>'units')::integer between 1 and capacity) then raise exception 'service_resource_unavailable' using errcode='22023';end if;
  end loop;
  for cal in select (value#>>'{}')::uuid from jsonb_array_elements(p_config->'calendar_sources')
    union select (p_config->>'destination_calendar_id')::uuid where p_config->>'destination_calendar_id' is not null loop
    if not exists(select 1 from public.calendar_connection_calendars k join public.calendar_connections c on c.organization_id=k.organization_id and c.id=k.connection_id
      join public.user_organizations m on m.organization_id=c.organization_id and m.user_id=c.user_id and m.revoked_at is null
      where k.organization_id=p_org and k.id=cal and k.available and c.status='healthy' and k.access_role in ('owner','writer','reader','writerWithoutPrivateAccess')
        and (cal is distinct from (p_config->>'destination_calendar_id')::uuid or k.access_role in ('owner','writer')))
      then raise exception 'service_calendar_unavailable' using errcode='42501';end if;
  end loop;
  delete from public.calendar_service_schedule where organization_id=p_org and event_type_id=type_id;
  delete from public.calendar_service_professionals where organization_id=p_org and event_type_id=type_id;
  delete from public.calendar_service_resources where organization_id=p_org and event_type_id=type_id;
  delete from public.calendar_service_calendar_sources where organization_id=p_org and event_type_id=type_id;
  for item in select value from jsonb_array_elements(p_config->'schedule') loop
    if p_config->>'booking_mode'='individual' and coalesce(item->>'capacity_rule','inherit')<>'inherit' then raise exception 'service_individual_capacity_invalid' using errcode='22023';end if;
    insert into public.calendar_service_schedule(organization_id,event_type_id,weekday,on_date,timing_kind,start_minute,end_minute,duration_minutes,capacity_rule,capacity_limit)
      values(p_org,type_id,(item->>'weekday')::integer,(item->>'on_date')::date,item->>'timing_kind',(item->>'start_minute')::integer,
        (item->>'end_minute')::integer,(item->>'duration_minutes')::integer,coalesce(item->>'capacity_rule','inherit'),(item->>'capacity_limit')::integer);
  end loop;
  insert into public.calendar_service_professionals select p_org,type_id,(value#>>'{}')::uuid from jsonb_array_elements(p_config->'professionals');
  if exists(select 1 from public.calendar_service_schedule a join public.calendar_service_schedule b on b.organization_id=a.organization_id and b.event_type_id=a.event_type_id and a.id<b.id
    where a.organization_id=p_org and a.event_type_id=type_id and ((a.on_date is not null and a.on_date=b.on_date) or (a.on_date is null and b.on_date is null and a.weekday=b.weekday))
      and ((a.timing_kind='fixed' and b.timing_kind='fixed' and a.start_minute=b.start_minute)
        or (a.timing_kind='window' and b.timing_kind='window' and a.start_minute<b.end_minute and b.start_minute<a.end_minute)))
    then raise exception 'schedule_ambiguous' using errcode='22023';end if;
  insert into public.calendar_service_resources select p_org,type_id,(value->>'resource_id')::uuid,(value->>'units')::integer from jsonb_array_elements(p_config->'resources');
  insert into public.calendar_service_calendar_sources select p_org,type_id,(value#>>'{}')::uuid from jsonb_array_elements(p_config->'calendar_sources');
  update public.calendar_event_types set service_enabled=(p_config->>'service_enabled')::boolean,
    is_active=case when (p_config->>'service_enabled')::boolean then coalesce((p_config->>'is_active')::boolean,is_active) else is_active end,booking_mode=p_config->>'booking_mode',
    requires_confirmation=coalesce((p_config->>'requires_confirmation')::boolean,requires_confirmation),
    service_capacity=(p_config->>'service_capacity')::integer,service_timezone=p_config->>'service_timezone',
    destination_calendar_id=case when p_config->>'service_publication_mode'='service' then (p_config->>'destination_calendar_id')::uuid else null end,
    service_publication_mode=coalesce(p_config->>'service_publication_mode','none'),service_revision=service_revision+1,updated_at=now()
    where organization_id=p_org and id=type_id;
  return public.fn_calendar_service_read(p_org,type_id)||jsonb_build_object('existing_reservations_preserved',true,
    'future_reservations',(select count(*) from public.calendar_appointments where organization_id=p_org and event_type_id=type_id and starts_at>now() and status in ('pending','confirmed')));
end $$;
revoke all on function public.fn_calendar_service_configure(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.fn_calendar_service_configure(uuid,jsonb,jsonb) to service_role;

-- Só devolve ocupação/cobertura, nunca títulos, convidados ou tokens das fontes.
create or replace function public.fn_calendar_service_google_state(p_org uuid,p_type uuid,p_owner uuid,p_start timestamptz,p_end timestamptz)
returns jsonb language sql stable security definer set search_path=public as $$
  with sources as (
    select k.connection_id,k.external_calendar_id,k.available,k.access_role,k.sync_coverage,k.sync_error,k.last_sync_at,
      c.status connection_status,m.revoked_at,c.user_id connection_owner,m.user_id active_member
      from public.calendar_connection_calendars k
      join public.calendar_connections c on c.organization_id=k.organization_id and c.id=k.connection_id
      left join public.user_organizations m on m.organization_id=c.organization_id and m.user_id=c.user_id
      where k.organization_id=p_org and (
        exists(select 1 from public.calendar_service_calendar_sources s where s.organization_id=p_org and s.event_type_id=p_type and s.calendar_id=k.id)
        or (p_owner is not null and c.user_id=p_owner and k.counts_for_conflicts))
  ) select jsonb_build_object('coverage_verified',not exists(select 1 from sources s where s.active_member is null or s.revoked_at is not null
      or not s.available or s.connection_status<>'healthy' or s.access_role not in ('owner','writer','reader','writerWithoutPrivateAccess')
      or s.sync_coverage is null or s.sync_error is not null or s.last_sync_at is null or s.last_sync_at<now()-interval '30 minutes'
      or (s.sync_coverage->>'window_start')::timestamptz>p_start or (s.sync_coverage->>'window_end')::timestamptz<p_end),
    'busy',exists(select 1 from sources s join public.calendar_external_events e on e.organization_id=p_org and e.connection_id=s.connection_id and e.external_calendar_id=s.external_calendar_id
      where e.starts_at<p_end and e.ends_at>p_start and e.status<>'cancelled' and e.transparency='opaque'
        and not exists(select 1 from public.calendar_appointments a where a.organization_id=p_org and a.google_connection_id=e.connection_id
          and a.google_calendar_id=e.external_calendar_id and a.google_event_id=e.external_event_id)),
    'source_count',(select count(*) from sources));
$$;
revoke all on function public.fn_calendar_service_google_state(uuid,uuid,uuid,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_calendar_service_google_state(uuid,uuid,uuid,timestamptz,timestamptz) to service_role;

create or replace function public.fn_calendar_service_person_available(p_org uuid,p_owner uuid,p_start timestamptz,p_end timestamptz,p_ignore uuid default null,p_type uuid default null)
returns boolean language plpgsql stable security definer set search_path=public as $$
declare schedule jsonb;zone text; local_start timestamp;local_end timestamp;day_date date;start_min integer;end_min integer;windows int4multirange;
begin
  if not exists(select 1 from public.user_organizations where organization_id=p_org and user_id=p_owner and revoked_at is null) then return false;end if;
  select a.schedule into schedule from public.attendant_availability a where a.organization_id=p_org and a.user_id=p_owner and a.is_available;
  if not found or jsonb_typeof(schedule->'windows')<>'array' then return false;end if;
  zone:=coalesce(nullif(schedule->>'timezone',''),'America/Sao_Paulo');
  if not exists(select 1 from pg_timezone_names where name=zone) then return false;end if;
  local_start:=p_start at time zone zone;local_end:=p_end at time zone zone;day_date:=local_start::date;
  if local_end::date<>day_date and local_end::time<>'00:00:00' then return false;end if;
  start_min:=extract(hour from local_start)::int*60+extract(minute from local_start)::int;
  end_min:=case when local_end::date<>day_date then 1440 else extract(hour from local_end)::int*60+extract(minute from local_end)::int end;
  if end_min<=start_min then return false;end if;
  select range_agg(r) into windows from (
    select int4range(split_part(w->>'start',':',1)::int*60+split_part(w->>'start',':',2)::int,
      split_part(w->>'end',':',1)::int*60+split_part(w->>'end',':',2)::int,'[)') r
      from jsonb_array_elements(schedule->'windows') w where (w->>'dow')::int=extract(dow from local_start)::int
    union all select int4range(start_minute,end_minute,'[)') from public.calendar_availability_exceptions
      where organization_id=p_org and user_id=p_owner and exception_date=day_date and not is_unavailable
  ) x;
  if not coalesce(windows @> int4range(start_min,end_min,'[)'),false) then return false;end if;
  if exists(select 1 from public.calendar_availability_exceptions where organization_id=p_org and user_id=p_owner and exception_date=day_date and is_unavailable
    and start_minute<end_min and end_minute>start_min) then return false;end if;
  if exists(select 1 from public.calendar_appointments where organization_id=p_org and owner_user_id=p_owner and id is distinct from p_ignore
    and status in ('pending','confirmed') and starts_at<p_end and ends_at>p_start
    and not (p_type is not null and event_type_id=p_type
      and starts_at-make_interval(mins=>(select buffer_before_minutes from public.calendar_event_types where organization_id=p_org and id=p_type))=p_start
      and ends_at+make_interval(mins=>(select buffer_after_minutes from public.calendar_event_types where organization_id=p_org and id=p_type))=p_end
      and service_occurrence_id is not null and service_booking_mode in ('collective_limited','collective_unlimited'))) then return false;end if;
  if exists(select 1 from public.calendar_service_blocks where organization_id=p_org and scope_kind='professional' and owner_user_id=p_owner and archived_at is null
    and starts_at<p_end and ends_at>p_start) then return false;end if;
  return true;
exception when invalid_text_representation or data_exception then return false;
end $$;
revoke all on function public.fn_calendar_service_person_available(uuid,uuid,timestamptz,timestamptz,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_calendar_service_person_available(uuid,uuid,timestamptz,timestamptz,uuid,uuid) to service_role;

create or replace function public.fn_calendar_service_check(p_org uuid,p_type uuid,p_start timestamptz,p_owner uuid default null,p_ignore uuid default null,p_now timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare t public.calendar_event_types;s public.calendar_service_schedule;local_start timestamp;minute integer;priority_date boolean;priority_fixed boolean;
  rule_count integer;duration integer;end_at timestamptz;start_inflated timestamptz;end_inflated timestamptz;limit_value integer;occupied integer;
  person record;resource record;google jsonb;selected_owner uuid;available_owners uuid[]:='{}';own_occ uuid;held integer;consumed integer;coverage_failed boolean:=false;destination uuid;
begin
  select * into t from public.calendar_event_types where organization_id=p_org and id=p_type;
  if not found then return jsonb_build_object('available',false,'reason','service_not_found');end if;
  if not t.is_active or not t.service_enabled then return jsonb_build_object('available',false,'reason','service_inactive');end if;
  if t.destination_calendar_id is not null and not exists(select 1 from public.calendar_connection_calendars k
    join public.calendar_connections c on c.organization_id=k.organization_id and c.id=k.connection_id
    join public.user_organizations m on m.organization_id=c.organization_id and m.user_id=c.user_id and m.revoked_at is null
    where k.organization_id=p_org and k.id=t.destination_calendar_id and k.available and c.status='healthy' and k.access_role in ('owner','writer'))
    then return jsonb_build_object('available',false,'reason','publication_unavailable');end if;
  local_start:=p_start at time zone t.service_timezone;minute:=extract(hour from local_start)::int*60+extract(minute from local_start)::int;
  if extract(second from local_start)<>0 then return jsonb_build_object('available',false,'reason','outside_schedule');end if;
  select exists(select 1 from public.calendar_service_schedule where organization_id=p_org and event_type_id=p_type and on_date=local_start::date
    and ((timing_kind='fixed' and start_minute=minute) or (timing_kind='window' and start_minute<=minute and end_minute>minute))) into priority_date;
  select exists(select 1 from public.calendar_service_schedule where organization_id=p_org and event_type_id=p_type
    and case when priority_date then on_date=local_start::date else on_date is null and weekday=extract(dow from local_start)::int end
    and timing_kind='fixed' and start_minute=minute) into priority_fixed;
  select count(*) into rule_count from public.calendar_service_schedule where organization_id=p_org and event_type_id=p_type
    and case when priority_date then on_date=local_start::date else on_date is null and weekday=extract(dow from local_start)::int end
    and case when priority_fixed then timing_kind='fixed' and start_minute=minute else timing_kind='window' and start_minute<=minute and end_minute>minute end;
  if rule_count<>1 then return jsonb_build_object('available',false,'reason',case when rule_count=0 then 'outside_schedule' else 'schedule_ambiguous' end);end if;
  select * into s from public.calendar_service_schedule where organization_id=p_org and event_type_id=p_type
    and case when priority_date then on_date=local_start::date else on_date is null and weekday=extract(dow from local_start)::int end
    and case when priority_fixed then timing_kind='fixed' and start_minute=minute else timing_kind='window' and start_minute<=minute and end_minute>minute end;
  duration:=coalesce(s.duration_minutes,t.duration_minutes);end_at:=p_start+make_interval(mins=>duration);
  if s.timing_kind='window' and (minute+duration>s.end_minute or (minute-s.start_minute)%coalesce(t.slot_interval_minutes,duration)<>0)
    then return jsonb_build_object('available',false,'reason','outside_schedule');end if;
  if p_start<p_now+make_interval(mins=>t.minimum_notice_minutes) or p_start>p_now+make_interval(days=>t.booking_window_days)
    then return jsonb_build_object('available',false,'reason','outside_booking_window');end if;
  start_inflated:=p_start-make_interval(mins=>t.buffer_before_minutes);end_inflated:=end_at+make_interval(mins=>t.buffer_after_minutes);
  google:=public.fn_calendar_service_google_state(p_org,p_type,null,start_inflated,end_inflated);
  if not (google->>'coverage_verified')::boolean then return jsonb_build_object('available',false,'reason','availability_unverified');end if;
  if (google->>'busy')::boolean or exists(select 1 from public.calendar_service_blocks where organization_id=p_org and scope_kind='service'
    and event_type_id=p_type and archived_at is null and starts_at<end_inflated and ends_at>start_inflated)
    then return jsonb_build_object('available',false,'reason','blocked');end if;
  if p_owner is not null and not exists(select 1 from public.calendar_service_professionals where organization_id=p_org and event_type_id=p_type and user_id=p_owner)
    then return jsonb_build_object('available',false,'reason','professional_not_eligible');end if;
  for person in select user_id from public.calendar_service_professionals where organization_id=p_org and event_type_id=p_type
    and (p_owner is null or user_id=p_owner) order by user_id loop
    google:=public.fn_calendar_service_google_state(p_org,p_type,person.user_id,start_inflated,end_inflated);
    if not (google->>'coverage_verified')::boolean then coverage_failed:=true;continue;end if;
    if not (google->>'busy')::boolean and public.fn_calendar_service_person_available(p_org,person.user_id,start_inflated,end_inflated,p_ignore,case when t.booking_mode<>'individual' then p_type else null end)
      then available_owners:=array_append(available_owners,person.user_id);end if;
  end loop;
  if (t.booking_mode='individual' or exists(select 1 from public.calendar_service_professionals where organization_id=p_org and event_type_id=p_type))
    and cardinality(available_owners)=0 then return jsonb_build_object('available',false,'reason',case when coverage_failed then 'availability_unverified' else 'professional_unavailable' end);end if;
  selected_owner:=available_owners[1];
  destination:=case when t.service_publication_mode='service' then t.destination_calendar_id else null end;
  if t.service_publication_mode='professional' then
    select k.id into destination from public.calendar_connection_calendars k join public.calendar_connections c on c.organization_id=k.organization_id and c.id=k.connection_id
      where k.organization_id=p_org and c.user_id=selected_owner and k.is_destination and k.available and c.status='healthy' and k.access_role in ('owner','writer');
    if destination is null then return jsonb_build_object('available',false,'reason','publication_unavailable');end if;
  end if;
  -- O máximo simultâneo mede toda a duração; consultas disjuntas não se somam como se fossem simultâneas.
  with intervals as (
    select greatest(starts_at,p_start) s,least(ends_at,end_at) e from public.calendar_appointments
      where organization_id=p_org and event_type_id=p_type and id is distinct from p_ignore and not service_block and status in ('pending','confirmed') and starts_at<end_at and ends_at>p_start
  ),changes as (select i.s at,1 delta from intervals i union all select i.e,-1 from intervals i),totals as (select at,sum(delta) delta from changes group by at),running as (
    select sum(delta) over(order by at rows unbounded preceding) count from totals)
  select coalesce(max(count),0)::integer into occupied from running;
  limit_value:=case when t.booking_mode='individual' then null when s.capacity_rule='unlimited' then null when s.capacity_rule='limited' then s.capacity_limit
    when t.booking_mode='collective_limited' then t.service_capacity else null end;
  if limit_value is not null and occupied>=limit_value then return jsonb_build_object('available',false,'reason','capacity_reached','occupied',occupied,'capacity_limit',limit_value);end if;
  select id into own_occ from public.calendar_service_occurrences where organization_id=p_org and event_type_id=p_type and starts_at=p_start and ends_at=end_at
    and allocation_key=case when t.booking_mode='individual' then selected_owner else '00000000-0000-0000-0000-000000000000'::uuid end;
  for resource in select r.id,r.capacity,r.is_active,sr.units from public.calendar_service_resources sr join public.calendar_resources r on r.organization_id=sr.organization_id and r.id=sr.resource_id
    where sr.organization_id=p_org and sr.event_type_id=p_type order by r.id loop
    if not resource.is_active or exists(select 1 from public.calendar_service_blocks where organization_id=p_org and scope_kind='resource' and resource_id=resource.id
      and archived_at is null and starts_at<end_inflated and ends_at>start_inflated) then return jsonb_build_object('available',false,'reason','resource_unavailable');end if;
    select coalesce(max(units),0) into held from public.calendar_service_occurrence_resources where organization_id=p_org and occurrence_id=own_occ and resource_id=resource.id;
    with intervals as (
      select greatest(o.starts_at,start_inflated) s,least(o.ends_at,end_inflated) e,rr.units from public.calendar_service_occurrence_resources rr
        join public.calendar_service_occurrences o on o.organization_id=rr.organization_id and o.id=rr.occurrence_id
        where rr.organization_id=p_org and rr.resource_id=resource.id and rr.occurrence_id is distinct from own_occ
          and o.starts_at<end_inflated and o.ends_at>start_inflated
          and exists(select 1 from public.calendar_appointments a where a.organization_id=p_org and a.service_occurrence_id=o.id and a.id is distinct from p_ignore and a.status in ('pending','confirmed'))
    ),changes as(select i.s at,i.units delta from intervals i union all select i.e,-i.units from intervals i),totals as(select at,sum(delta) delta from changes group by at),running as(
      select sum(delta) over(order by at rows unbounded preceding) count from totals)
    select coalesce(max(count),0)::integer into consumed from running;
    if consumed+greatest(held,resource.units)>resource.capacity then return jsonb_build_object('available',false,'reason','resource_unavailable');end if;
  end loop;
  return jsonb_build_object('available',true,'reason',null,'starts_at',p_start,'ends_at',end_at,'duration_minutes',duration,'time_zone',t.service_timezone,
    'owner_user_id',selected_owner,'available_professionals',cardinality(available_owners),'booking_mode',t.booking_mode,'capacity_rule',s.capacity_rule,
    'capacity_limit',limit_value,'occupied',occupied,'remaining_capacity',case when cardinality(available_owners)>0 then
      case when limit_value is null then cardinality(available_owners) else least(limit_value-occupied,cardinality(available_owners)) end
      when limit_value is null then null else limit_value-occupied end,
    'service_revision',t.service_revision,'coverage_verified',true,'destination_calendar_id',destination,'service_publication_mode',t.service_publication_mode,'requires_confirmation',t.requires_confirmation);
end $$;
revoke all on function public.fn_calendar_service_check(uuid,uuid,timestamptz,uuid,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_calendar_service_check(uuid,uuid,timestamptz,uuid,uuid,timestamptz) to service_role;

create or replace function public.fn_calendar_service_preview(p_org uuid,p_type uuid,p_starts jsonb,p_owner uuid default null,p_now timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare item jsonb;result jsonb:='[]';
begin
  if auth.uid() is not null and not public.fn_role_at_least(p_org,'viewer') then raise exception 'service_forbidden' using errcode='42501';end if;
  if auth.uid() is null and current_setting('role',true)='authenticated' then raise exception 'service_forbidden' using errcode='42501';end if;
  if jsonb_typeof(p_starts)<>'array' or jsonb_array_length(p_starts)>500 then raise exception 'service_preview_invalid' using errcode='22023';end if;
  for item in select value from jsonb_array_elements(p_starts) loop
    result:=result||jsonb_build_array(public.fn_calendar_service_check(p_org,p_type,(item#>>'{}')::timestamptz,p_owner,null,p_now)||jsonb_build_object('starts_at',item#>>'{}'));
  end loop;
  return result;
end $$;
revoke all on function public.fn_calendar_service_preview(uuid,uuid,jsonb,uuid,timestamptz) from public,anon;
grant execute on function public.fn_calendar_service_preview(uuid,uuid,jsonb,uuid,timestamptz) to authenticated,service_role;

create or replace function public.fn_calendar_service_sources_to_refresh(p_org uuid,p_type uuid,p_owner uuid default null)
returns jsonb language sql stable security definer set search_path=public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',id) order by id),'[]'::jsonb) from (
    select distinct k.id from public.calendar_connection_calendars k
      join public.calendar_connections c on c.organization_id=k.organization_id and c.id=k.connection_id
      join public.user_organizations m on m.organization_id=c.organization_id and m.user_id=c.user_id and m.revoked_at is null
      join public.calendar_event_types t on t.organization_id=k.organization_id and t.id=p_type
      where k.organization_id=p_org and (
        k.id=t.destination_calendar_id or
        exists(select 1 from public.calendar_service_calendar_sources s where s.organization_id=p_org and s.event_type_id=p_type and s.calendar_id=k.id) or
        (k.counts_for_conflicts and exists(select 1 from public.calendar_service_professionals s where s.organization_id=p_org and s.event_type_id=p_type
          and s.user_id=c.user_id and (p_owner is null or s.user_id=p_owner))))
  ) x;
$$;
revoke all on function public.fn_calendar_service_sources_to_refresh(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_calendar_service_sources_to_refresh(uuid,uuid,uuid) to service_role;

-- Capturado exclusivamente pelo runtime, fora do schema público de ferramentas/rotas.
create or replace function public.fn_calendar_service_execution_current(p_org uuid,p_contact uuid,p_execution jsonb)
returns boolean language plpgsql stable security definer set search_path=public as $$
declare b jsonb:=p_execution->'boundary';j jsonb:=p_execution->'job';operation jsonb:=p_execution->'agent_operation';current_b jsonb;
begin
  if p_execution is null or p_execution='null'::jsonb then return false;end if;
  if b is not null and b<>'null'::jsonb then
    if b->>'organization_id'<>p_org::text or b->>'contact_id'<>p_contact::text then return false;end if;
    current_b:=public.fn_service_boundary(p_org,(b->>'conversation_id')::uuid);
    if current_b is null or current_b->>'status' in ('closed','resolved','archived')
      or current_b->>'demanda_fechada_em' is not null or current_b->>'contact_id' is distinct from b->>'contact_id'
      or current_b->>'service_revision' is distinct from b->>'service_revision'
      or current_b->>'demanda_id' is distinct from b->>'demanda_id'
      or current_b->>'demanda_revision' is distinct from b->>'demanda_revision' then return false;end if;
  else return false;end if;
  if j is not null and j<>'null'::jsonb and not exists(select 1 from public.job_queue q where q.organization_id=p_org and q.id=(j->>'id')::uuid
    and q.contact_id=p_contact and q.status='running' and q.locked_by=j->>'worker_id' and q.locked_at=(j->>'acquired_at')::timestamptz
    and not public.fn_autonomous_turn_revoked(p_org,q.id)) then return false;end if;
  if operation is not null and operation<>'null'::jsonb and not exists(select 1 from public.ai_agents a where a.organization_id=p_org
    and a.id=(operation->>'agentId')::uuid and a.published_version_id=(operation->>'versionId')::uuid
    and a.operation_revision::text=operation->>'revision' and a.operation_mode='automatic' and a.paused_at is null and a.archived_at is null)
    then return false;end if;
  return j is not null and j<>'null'::jsonb;
end $$;
revoke all on function public.fn_calendar_service_execution_current(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.fn_calendar_service_execution_current(uuid,uuid,jsonb) to service_role;

create or replace function public.fn_calendar_service_occurrence(p_org uuid,p_type uuid,p_check jsonb)
returns uuid language plpgsql security definer set search_path=public as $$
declare result uuid;assignment uuid;item record;
begin
  assignment:=case when p_check->>'booking_mode'='individual' then (p_check->>'owner_user_id')::uuid else '00000000-0000-0000-0000-000000000000'::uuid end;
  insert into public.calendar_service_occurrences(organization_id,event_type_id,starts_at,ends_at,booking_mode,allocation_key)
    values(p_org,p_type,(p_check->>'starts_at')::timestamptz,(p_check->>'ends_at')::timestamptz,p_check->>'booking_mode',assignment)
    on conflict(organization_id,event_type_id,starts_at,ends_at,allocation_key) do update set allocation_key=excluded.allocation_key returning id into result;
  for item in select resource_id,units from public.calendar_service_resources where organization_id=p_org and event_type_id=p_type order by resource_id loop
    insert into public.calendar_service_occurrence_resources(organization_id,occurrence_id,resource_id,units) values(p_org,result,item.resource_id,item.units)
      on conflict(organization_id,occurrence_id,resource_id) do update set units=greatest(calendar_service_occurrence_resources.units,excluded.units);
  end loop;
  return result;
end $$;
revoke all on function public.fn_calendar_service_occurrence(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.fn_calendar_service_occurrence(uuid,uuid,jsonb) to service_role;

create or replace function public.fn_calendar_service_book(p_org uuid,p_actor jsonb,p_input jsonb,p_execution jsonb default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare t public.calendar_event_types;a public.calendar_appointments;fact jsonb;occurrence uuid;contact uuid:=(p_input->>'contact_id')::uuid;
  type_id uuid:=(p_input->>'event_type_id')::uuid;start_at timestamptz:=(p_input->>'starts_at')::timestamptz;
  participant text;participant_name text:=nullif(trim(p_input->>'participant_name'),'');command_key text:=p_input->>'operation_key';
begin
  perform public.fn_calendar_service_assert_actor(p_org,p_actor,'agent');
  if contact is null or command_key is null or length(command_key)>500 or not exists(select 1 from public.contacts where organization_id=p_org and id=contact and not is_anonymized)
    then raise exception 'service_contact_not_found' using errcode='P0002';end if;
  perform public.fn_service_lock(p_org,contact);
  perform public.fn_calendar_service_lock(p_org);
  -- Anonimização pode ter aguardado a mesma trava enquanto o pedido esperava.
  if not exists(select 1 from public.contacts where organization_id=p_org and id=contact and not is_anonymized)
    then raise exception 'service_contact_not_found' using errcode='P0002';end if;
  if p_input->>'conversation_id' is not null and not exists(select 1 from public.conversations where organization_id=p_org
    and id=(p_input->>'conversation_id')::uuid and contact_id=contact and not is_group)
    then raise exception 'service_conversation_not_found' using errcode='P0002';end if;
  if p_actor->>'type'='ai_agent' and (p_actor->>'api_token_id' is null or p_actor->>'native_job' is not null or p_execution is not null)
    and (not public.fn_calendar_service_execution_current(p_org,contact,p_execution)
      or (p_actor->>'native_job' is not null and p_execution->'job'->>'id' is distinct from p_actor->>'native_job'))
    then raise exception 'service_execution_stale' using errcode='42501';end if;
  participant:=contact::text||':'||coalesce(lower(regexp_replace(participant_name,'\s+',' ','g')),'primary');
  -- Retry de comando também confere o conteúdo; não devolve uma operação alheia.
  select * into a from public.calendar_appointments where organization_id=p_org and service_operation_key=command_key;
  if found then
    if a.service_operation_request is distinct from jsonb_build_object('event_type_id',type_id,'contact_id',contact,'starts_at',start_at,'participant_key',participant)
      then raise exception 'service_idempotency_conflict' using errcode='PT409';end if;
    return to_jsonb(a)||jsonb_build_object('deduplicated',true);
  end if;
  select * into t from public.calendar_event_types where organization_id=p_org and id=type_id;
  if not found then raise exception 'service_not_found' using errcode='P0002';end if;
  -- A pessoa já reservada é encontrada antes de consumir vaga ou exigir outro profissional.
  select * into a from public.calendar_appointments where organization_id=p_org and event_type_id=type_id and starts_at=start_at
    and participant_key=participant and status in ('pending','confirmed');
  if found then return to_jsonb(a)||jsonb_build_object('deduplicated',true);end if;
  if p_input?'expected_revision' and t.service_revision is distinct from (p_input->>'expected_revision')::bigint then raise exception 'service_stale' using errcode='PT409';end if;
  fact:=public.fn_calendar_service_check(p_org,type_id,start_at,(p_input->>'owner_user_id')::uuid);
  if not coalesce((fact->>'available')::boolean,false) then raise exception '%',fact->>'reason' using errcode='PT409';end if;
  if p_actor->>'type'='user' and fact->>'owner_user_id' is not null and fact->>'owner_user_id' is distinct from p_actor->>'id'
    and not exists(select 1 from public.user_organizations where organization_id=p_org and user_id=(p_actor->>'id')::uuid
      and revoked_at is null and role in ('manager','admin')) and not public.fn_colegas_podem_mexer_na_agenda(p_org)
    then raise exception 'appointment_do_colega' using errcode='42501';end if;
  occurrence:=public.fn_calendar_service_occurrence(p_org,type_id,fact);
  insert into public.calendar_appointments(organization_id,event_type_id,title,starts_at,ends_at,time_zone,status,owner_user_id,contact_id,conversation_id,
    description,notes,location_kind,location_details,guest_email,meeting_delivery,created_by_kind,created_by_user_id,source,service_occurrence_id,participant_key,participant_name,
    service_booking_mode,service_capacity_rule,service_capacity_limit,service_rule_revision,service_destination_calendar_id,service_publication_mode,service_requires_confirmation,service_operation_key,service_operation_request)
    values(p_org,type_id,coalesce(nullif(p_input->>'title',''),t.name||case when participant_name is null then '' else ' · '||participant_name end),start_at,(fact->>'ends_at')::timestamptz,t.service_timezone,
      case when t.requires_confirmation then 'pending' else 'confirmed' end,(fact->>'owner_user_id')::uuid,contact,(p_input->>'conversation_id')::uuid,
      nullif(trim(p_input->>'description'),''),nullif(p_input->>'notes',''),t.location_kind,
      case when p_input?'location_details' then nullif(trim(p_input->>'location_details'),'') else t.location_details end,
      nullif(trim(p_input->>'guest_email'),''),coalesce(p_input->'meeting_delivery',jsonb_build_object('state','none')),
      case when p_actor->>'type'='user' then 'user' when p_actor->>'type'='ai_agent' then 'ai' else 'system' end,
      case when p_actor->>'type'='user' then (p_actor->>'id')::uuid else null end,
      case when p_actor->>'type'='user' then 'ui' else 'mcp' end,occurrence,participant,participant_name,
      t.booking_mode,fact->>'capacity_rule',(fact->>'capacity_limit')::integer,t.service_revision,(fact->>'destination_calendar_id')::uuid,t.service_publication_mode,t.requires_confirmation,command_key,
      jsonb_build_object('event_type_id',type_id,'contact_id',contact,'starts_at',start_at,'participant_key',participant))
    returning * into a;
  return to_jsonb(a)||jsonb_build_object('deduplicated',false,'service_facts',fact);
end $$;
revoke all on function public.fn_calendar_service_book(uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.fn_calendar_service_book(uuid,jsonb,jsonb,jsonb) to service_role;

create or replace function public.fn_calendar_service_book_group(p_org uuid,p_actor jsonb,p_input jsonb,p_execution jsonb default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare item jsonb;result jsonb:='[]';names text[]:='{}';canonical text;one jsonb;
begin
  if jsonb_typeof(p_input->'participants')<>'array' or jsonb_array_length(p_input->'participants') not between 1 and 20
    then raise exception 'service_participants_invalid' using errcode='22023';end if;
  for item in select value from jsonb_array_elements(p_input->'participants') loop
    canonical:=lower(regexp_replace(trim(item#>>'{}'),'\s+',' ','g'));
    if coalesce(length(canonical),0) not between 1 and 120 or canonical=any(names) then raise exception 'service_participants_invalid' using errcode='22023';end if;
    names:=array_append(names,canonical);
    one:=public.fn_calendar_service_book(p_org,p_actor,(p_input-'participants')||jsonb_build_object('participant_name',item#>>'{}',
      'operation_key',(p_input->>'operation_key')||':'||md5(canonical)),p_execution);
    result:=result||jsonb_build_array(one);
  end loop;
  return result;
end $$;
revoke all on function public.fn_calendar_service_book_group(uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.fn_calendar_service_book_group(uuid,jsonb,jsonb,jsonb) to service_role;

-- A trava alcança também o escritor individual legado quando disputa um profissional
-- com uma reserva nova. Sobreposições antigas entre duas linhas legadas não são reclassificadas.
create or replace function public.fn_calendar_service_appointment_guard()
returns trigger language plpgsql security definer set search_path=public as $$
declare fact jsonb;checked boolean;type_row public.calendar_event_types;
begin
  if tg_op='DELETE' then return old;end if;
  if tg_op='INSERT' and new.service_occurrence_id is null and not new.service_block
    and exists(select 1 from public.calendar_event_types where organization_id=new.organization_id and id=new.event_type_id and service_enabled)
    then raise exception 'service_writer_required' using errcode='42501';end if;
  if tg_op='INSERT' and auth.uid() is not null and (new.service_block or (new.service_occurrence_id is null and (new.service_destination_calendar_id is not null or new.service_publication_mode is not null)))
    then raise exception 'service_writer_required' using errcode='42501';end if;
  if tg_op='UPDATE' and auth.uid() is not null and row(new.participant_key,new.participant_name,new.service_destination_calendar_id,new.service_publication_mode,new.service_requires_confirmation,new.service_operation_key,new.service_operation_request,new.service_block)
    is distinct from row(old.participant_key,old.participant_name,old.service_destination_calendar_id,old.service_publication_mode,old.service_requires_confirmation,old.service_operation_key,old.service_operation_request,old.service_block)
    then raise exception 'service_writer_required' using errcode='42501';end if;
  if tg_op='UPDATE' and auth.uid() is not null and ((old.service_occurrence_id is null and new.service_occurrence_id is not null)
    or (old.service_occurrence_id is not null and row(new.contact_id,new.event_type_id) is distinct from row(old.contact_id,old.event_type_id))
    or (row(new.starts_at,new.ends_at,new.owner_user_id,new.service_occurrence_id) is not distinct from row(old.starts_at,old.ends_at,old.owner_user_id,old.service_occurrence_id)
      and row(new.service_booking_mode,new.service_capacity_rule,new.service_capacity_limit,new.service_rule_revision) is distinct from row(old.service_booking_mode,old.service_capacity_rule,old.service_capacity_limit,old.service_rule_revision)))
    then raise exception 'service_writer_required' using errcode='42501';end if;
  if tg_op='UPDATE' and row(new.starts_at,new.ends_at,new.owner_user_id,new.status,new.service_occurrence_id,new.contact_id,new.event_type_id,new.service_destination_calendar_id)
    is not distinct from row(old.starts_at,old.ends_at,old.owner_user_id,old.status,old.service_occurrence_id,old.contact_id,old.event_type_id,old.service_destination_calendar_id) then return new;end if;
  if tg_op='INSERT' and new.service_occurrence_id is not null and new.contact_id is not null then perform public.fn_service_lock(new.organization_id,new.contact_id);end if;
  perform public.fn_calendar_service_lock(new.organization_id);
  if tg_op='INSERT' and new.service_occurrence_id is not null then
    if new.contact_id is null or new.service_operation_key is null or not exists(select 1 from public.contacts where organization_id=new.organization_id and id=new.contact_id and not is_anonymized)
      or new.status not in ('pending','confirmed') then raise exception 'service_creation_invalid' using errcode='22023';end if;
    if auth.uid() is not null then
      perform public.fn_calendar_service_assert_actor(new.organization_id,jsonb_build_object('type','user','id',auth.uid()),'agent');
      new.created_by_kind:='user';new.created_by_user_id:=auth.uid();new.source:='ui';
      new.meeting_delivery:=jsonb_build_object('state','none');
    end if;
    if new.conversation_id is not null and not exists(select 1 from public.conversations where organization_id=new.organization_id and id=new.conversation_id and contact_id=new.contact_id and not is_group)
      then raise exception 'service_conversation_not_found' using errcode='P0002';end if;
    new.participant_key:=new.contact_id::text||':'||coalesce(lower(regexp_replace(nullif(trim(new.participant_name),''),'\s+',' ','g')),'primary');
    new.service_operation_request:=jsonb_build_object('event_type_id',new.event_type_id,'contact_id',new.contact_id,'starts_at',new.starts_at,'participant_key',new.participant_key);
  end if;
  if new.status not in ('pending','confirmed') or new.service_block then return new;end if;
  checked:=new.service_occurrence_id is not null;
  if checked then
    if not exists(select 1 from public.calendar_service_occurrences o where o.organization_id=new.organization_id and o.id=new.service_occurrence_id
      and o.event_type_id=new.event_type_id and o.starts_at=new.starts_at and o.ends_at=new.ends_at)
      then raise exception 'service_occurrence_mismatch' using errcode='23503';end if;
    -- Confirmação não reabre uma reserva já ocupante; mudança de horário/reativação revalida.
    if tg_op='INSERT' or row(new.starts_at,new.ends_at,new.owner_user_id,new.service_occurrence_id) is distinct from row(old.starts_at,old.ends_at,old.owner_user_id,old.service_occurrence_id)
      or old.status not in ('pending','confirmed') then
      fact:=public.fn_calendar_service_check(new.organization_id,new.event_type_id,new.starts_at,new.owner_user_id,new.id);
      if not coalesce((fact->>'available')::boolean,false) then raise exception '%',fact->>'reason' using errcode='PT409';end if;
      if (fact->>'ends_at')::timestamptz is distinct from new.ends_at then raise exception 'service_duration_mismatch' using errcode='PT409';end if;
      new.service_booking_mode:=fact->>'booking_mode';new.service_capacity_rule:=fact->>'capacity_rule';
      new.service_capacity_limit:=(fact->>'capacity_limit')::integer;new.service_rule_revision:=(fact->>'service_revision')::bigint;
      new.service_occurrence_id:=public.fn_calendar_service_occurrence(new.organization_id,new.event_type_id,fact);
      if tg_op='INSERT' then
        select * into type_row from public.calendar_event_types where organization_id=new.organization_id and id=new.event_type_id;
        new.service_destination_calendar_id:=(fact->>'destination_calendar_id')::uuid;
        new.service_publication_mode:=type_row.service_publication_mode;new.service_requires_confirmation:=type_row.requires_confirmation;
        new.status:=case when type_row.requires_confirmation then 'pending' else 'confirmed' end;
      end if;
    end if;
  end if;
  if new.owner_user_id is not null and exists(select 1 from public.calendar_appointments a where a.organization_id=new.organization_id and a.id<>new.id
    and a.owner_user_id=new.owner_user_id and a.status in ('pending','confirmed') and a.starts_at<new.ends_at and a.ends_at>new.starts_at
    and not (new.service_occurrence_id is not null and a.service_occurrence_id=new.service_occurrence_id
      and new.service_booking_mode in ('collective_limited','collective_unlimited'))
    and (checked or a.service_occurrence_id is not null)) then raise exception 'professional_unavailable' using errcode='PT409';end if;
  return new;
end $$;
revoke all on function public.fn_calendar_service_appointment_guard() from public,anon,authenticated;
drop trigger if exists trg_calendar_service_appointment_guard on public.calendar_appointments;
create trigger trg_calendar_service_appointment_guard before insert or update on public.calendar_appointments for each row execute function public.fn_calendar_service_appointment_guard();

-- A turma compartilha seu profissional; a exclusividade individual permanece na mesma chave histórica.
-- A trava/guard acima ainda rejeita disputa de profissional entre ocorrências diferentes.
drop index if exists public.calendar_appointments_sem_duplicata_idx;
create unique index calendar_appointments_sem_duplicata_idx on public.calendar_appointments(organization_id,owner_user_id,starts_at)
  where status in ('pending','confirmed') and owner_user_id is not null and not service_block
    and coalesce(service_booking_mode,'individual')='individual';
comment on index public.calendar_appointments_sem_duplicata_idx is 'Exclusividade individual preservada. Uma ocorrência coletiva compartilha profissional sob trava e guard; nunca compartilha com outra ocorrência.';

notify pgrst,'reload schema';

-- ---- Transições nativas com agenda de serviço (0650) ----
create or replace function public.fn_appointment_change_core(p_org uuid,p_id uuid,p_revision bigint,p_patch jsonb,p_remote boolean,p_base jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; contact uuid; origin jsonb; event_id uuid; service_fact jsonb; service_occurrence uuid; service_owner uuid;
 service_confirmation_required boolean;service_next_status text;
begin
 if p_remote and (auth.uid() is not null or (p_patch-'starts_at'-'ends_at'-'time_zone'-'status'-'cancellation_reason')<>'{}'::jsonb or coalesce(p_patch->>'status','cancelled')<>'cancelled') then raise exception 'google_patch_forbidden' using errcode='42501';end if;
 if auth.uid() is not null and (not public.fn_role_at_least(p_org,'agent') or not public.fn_support_write_allowed(p_org)) then raise exception 'appointment_forbidden' using errcode='42501'; end if;
 if auth.uid() is not null and not public.fn_session_mfa_proven() then raise exception 'appointment_mfa_required' using errcode='42501';end if;
 perform public.fn_calendar_service_lock(p_org);
 select contact_id into contact from public.calendar_appointments where organization_id=p_org and id=p_id;
 if not found then raise exception 'appointment_not_found' using errcode='P0002'; end if;
 if contact is not null then perform public.fn_service_lock(p_org,contact); end if;
 select * into a from public.calendar_appointments where organization_id=p_org and id=p_id for update;
 if a.contact_id is distinct from contact or a.revision is distinct from p_revision then raise exception 'appointment_stale' using errcode='PT409'; end if;
 -- A AGENDA DO COLEGA É UMA OPÇÃO DA ORGANIZAÇÃO (migration 0343, issue #978).
 if auth.uid() is not null and not public.fn_role_at_least(p_org,'manager')
    and not public.fn_colegas_podem_mexer_na_agenda(p_org)
    and a.owner_user_id is distinct from auth.uid()
    and not (a.service_occurrence_id is not null and a.owner_user_id is null) then
  raise exception 'appointment_do_colega' using errcode='42501';
 end if;
 if p_remote and a.status not in ('pending','confirmed') then raise exception 'google_outcome_protected' using errcode='PT409';end if;
 if a.status='cancelled' then raise exception 'appointment_cancelled' using errcode='22023'; end if;
 if contact is not null then origin:=jsonb_build_object('kind','command','observed',public.fn_service_observe_command(p_org,contact)); end if;
 -- A reserva de serviço usa a mesma transição nativa, com destino revalidado antes de soltar a origem.
 if a.service_occurrence_id is not null then
  perform public.fn_calendar_service_lock(p_org);
  if auth.uid() is null and p_patch?'_service_execution' and not p_remote
    and not public.fn_calendar_service_execution_current(p_org,contact,p_patch->'_service_execution')
    then raise exception 'service_execution_stale' using errcode='42501';end if;
  if p_patch?'starts_at' then
   service_owner:=case when p_patch?'owner_user_id' then (p_patch->>'owner_user_id')::uuid else a.owner_user_id end;
   service_fact:=public.fn_calendar_service_check(p_org,a.event_type_id,(p_patch->>'starts_at')::timestamptz,service_owner,a.id);
   if not coalesce((service_fact->>'available')::boolean,false) then raise exception '%',service_fact->>'reason' using errcode='PT409';end if;
   -- O Google não pode trocar a duração da programação e receber um ACK
   -- para uma linha que o CRM normalizou silenciosamente para outra duração.
   if p_remote and p_patch?'ends_at' and (p_patch->>'ends_at')::timestamptz is distinct from (service_fact->>'ends_at')::timestamptz then
    raise exception 'service_remote_duration_conflict' using errcode='PT409';end if;
   service_occurrence:=public.fn_calendar_service_occurrence(p_org,a.event_type_id,service_fact);
  end if;
  service_confirmation_required:=coalesce((service_fact->>'requires_confirmation')::boolean,a.service_requires_confirmation,false);
  service_next_status:=coalesce(p_patch->>'status',a.status);
  if service_confirmation_required and a.status='pending' and p_patch->>'status'='confirmed' and auth.uid() is null then
   raise exception 'service_human_confirmation_required' using errcode='42501';end if;
  -- A aprovação da equipe vale para o horário aprovado. Outra data pela IA
  -- volta a pending; remarcação autenticada da equipe pode renovar a aprovação.
  if service_confirmation_required and service_occurrence is not null and service_next_status='confirmed' and auth.uid() is null then
   service_next_status:='pending';end if;
 end if;
 update public.calendar_appointments set
  google_base_projection=case when p_remote then p_base else google_base_projection end,
  starts_at=case when p_patch?'starts_at' then (p_patch->>'starts_at')::timestamptz else starts_at end,
  ends_at=case when service_occurrence is not null then (service_fact->>'ends_at')::timestamptz when p_patch?'ends_at' then (p_patch->>'ends_at')::timestamptz else ends_at end,
  time_zone=case when service_occurrence is not null then service_fact->>'time_zone' else coalesce(p_patch->>'time_zone',time_zone) end,
  owner_user_id=case when service_occurrence is not null then (service_fact->>'owner_user_id')::uuid else owner_user_id end,
  service_occurrence_id=coalesce(service_occurrence,service_occurrence_id),
  service_capacity_rule=case when service_occurrence is not null then service_fact->>'capacity_rule' else service_capacity_rule end,
  service_capacity_limit=case when service_occurrence is not null then (service_fact->>'capacity_limit')::integer else service_capacity_limit end,
  service_rule_revision=case when service_occurrence is not null then (service_fact->>'service_revision')::bigint else service_rule_revision end,
  service_requires_confirmation=case when service_occurrence is not null then service_confirmation_required else service_requires_confirmation end,
  service_confirmed_by_user_id=case
   when service_confirmation_required and service_next_status='confirmed' and auth.uid() is not null and (p_patch?'status' or service_occurrence is not null) then auth.uid()
   when service_occurrence is not null then null else service_confirmed_by_user_id end,
  service_confirmed_at=case
   when service_confirmation_required and service_next_status='confirmed' and auth.uid() is not null and (p_patch?'status' or service_occurrence is not null) then clock_timestamp()
   when service_occurrence is not null then null else service_confirmed_at end,
  status=coalesce(service_next_status,p_patch->>'status',status),
  cancelled_at=case when p_patch->>'status'='cancelled' then now() else cancelled_at end,
  cancellation_reason=case when p_patch?'cancellation_reason' then p_patch->>'cancellation_reason' else cancellation_reason end,
  notes=case when p_patch?'notes' then p_patch->>'notes' else notes end,
  guest_email=case when p_patch?'guest_email' then p_patch->>'guest_email' else guest_email end,
  outcome_message_id=case when p_patch?'outcome_message_id' then (p_patch->>'outcome_message_id')::uuid else null end,
  confirmation_next_at=case when p_patch?'confirmation_next_at' then (p_patch->>'confirmation_next_at')::timestamptz else confirmation_next_at end
 where organization_id=p_org and id=p_id returning * into a;
 if p_patch?'confirmation_next_at' and (a.confirmation_next_at<=now() or a.confirmation_next_at>now()+interval '24 hours') then raise exception 'appointment_invalid_snooze' using errcode='22023'; end if;
 update public.followup_enrollments set status='cancelled',cancel_reason='O compromisso mudou. Revise o próximo passo.',completed_at=now(),next_eval_at=null,claimed_until=null
  where organization_id=p_org and appointment_id=p_id and appointment_revision<>a.revision and status in ('active','waiting_reply','paused_handoff','paused_manual');
 update public.agent_inbox_items set status='resolved',resolved_at=now()
  where organization_id=p_org and ref_kind='appointment' and ref_id=p_id and status='open'
   and (appointment_revision<>a.revision or a.status in ('completed','no_show','cancelled') or p_patch?'confirmation_next_at');
 if contact is not null and a.status='no_show' and a.outcome_recorded_at is not null and a.revision<>p_revision then
  insert into public.event_log(organization_id,event_type,entity_kind,entity_id,payload)
   values(p_org,'appointment.outcome_confirmed','appointment',p_id,
    jsonb_build_object('appointment_revision',a.revision,'service_origin',origin)) returning id into event_id;
 end if;
 return to_jsonb(a);
end; $$;

revoke all on function public.fn_appointment_change_core(uuid,uuid,bigint,jsonb,boolean,jsonb) from public,anon,authenticated;
notify pgrst,'reload schema';

-- ---- Publicação Google por destino explícito de serviço (0650) ----
create or replace function public.fn_google_appointment(p_org uuid,p_id uuid,p_action text,p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; c public.calendar_connection_calendars; conn public.calendar_connections;
 contact uuid; publication_owner uuid; claim jsonb:=p_args->'claim'; result jsonb; b jsonb; changed boolean; remote jsonb;
begin
 perform public.fn_calendar_service_lock(p_org);
 select contact_id into contact from public.calendar_appointments where organization_id=p_org and id=p_id;
 if not found then raise exception 'appointment_not_found' using errcode='P0002';end if;
 if contact is not null then perform public.fn_service_lock(p_org,contact);end if;
 -- Seleção/reserva compartilham membership antes dos locks de calendário/appointment.
 select case when x.service_occurrence_id is null and not x.service_block then x.owner_user_id else coalesce(link.user_id,dest.user_id) end into publication_owner
  from public.calendar_appointments x
  left join public.calendar_connections link on link.organization_id=x.organization_id and link.id=x.google_connection_id
  left join public.calendar_connection_calendars k on k.organization_id=x.organization_id and k.id=x.service_destination_calendar_id
  left join public.calendar_connections dest on dest.organization_id=k.organization_id and dest.id=k.connection_id
  where x.organization_id=p_org and x.id=p_id;
 perform 1 from public.user_organizations m where m.organization_id=p_org and m.user_id=publication_owner for update of m;
 if p_args?'calendar_fence' then
  perform public.fn_google_calendar_fence(p_org,(p_args->'calendar_fence'->>'id')::uuid,p_args->'calendar_fence'->'claim',p_args->'calendar_fence'->'cursor');
 end if;
 select * into a from public.calendar_appointments where organization_id=p_org and id=p_id for update;
 if a.contact_id is distinct from contact then raise exception 'appointment_stale' using errcode='PT409';end if;
 if contact is not null and exists(select 1 from public.contacts where organization_id=p_org and id=contact and is_anonymized) then
  if p_action='claim' then return jsonb_build_object('terminal','redacted');end if;
  raise exception 'google_contact_redacted' using errcode='42501';end if;
 if (a.service_occurrence_id is not null or a.service_block) and a.service_publication_mode='none' and p_action='claim' then return jsonb_build_object('terminal','not_configured');end if;
 if not exists(select 1 from public.user_organizations where organization_id=p_org and user_id=publication_owner and revoked_at is null) then
  raise exception 'google_owner_unavailable' using errcode='42501';end if;
 if p_action='claim' then
  if a.google_claim_until>clock_timestamp() then return null;end if;
  if a.google_event_id is null and a.status<>'cancelled' then
   select k.* into c from public.calendar_connection_calendars k join public.calendar_connections x on x.id=k.connection_id and x.organization_id=k.organization_id
    where k.organization_id=p_org and x.user_id=publication_owner
      and case when (a.service_occurrence_id is not null or a.service_block) then k.id=a.service_destination_calendar_id else k.is_destination end;
   if not found or (select count(*) from public.calendar_connection_calendars k join public.calendar_connections x on x.id=k.connection_id and x.organization_id=k.organization_id where k.organization_id=p_org and x.user_id=publication_owner and case when (a.service_occurrence_id is not null or a.service_block) then k.id=a.service_destination_calendar_id else k.is_destination end)<>1 then
    update public.calendar_appointments set google_sync_error='Escolha uma agenda de destino nas configurações.',google_next_attempt_at=now()+interval '15 minutes' where organization_id=p_org and id=p_id;return null;
   end if;
   if not c.available or c.access_role not in ('owner','writer') then
    update public.calendar_appointments set google_sync_error='A agenda de destino não permite publicação. Confira o acesso nas configurações.',google_next_attempt_at=now()+interval '15 minutes' where organization_id=p_org and id=p_id;return null;end if;
   update public.calendar_appointments set google_connection_id=c.connection_id,google_calendar_id=c.external_calendar_id,
    google_event_id='deskcommapp'||replace(id::text,'-',''),google_pending_write='{"reservation":true}'::jsonb where organization_id=p_org and id=p_id returning * into a;
  end if;
  update public.calendar_appointments set google_claim_token=gen_random_uuid(),google_claim_epoch=google_claim_epoch+1,
   google_claim_until=clock_timestamp()+interval '90 seconds' where organization_id=p_org and id=p_id returning * into a;
 else
  if a.google_claim_token is distinct from (claim->>'token')::uuid or a.google_claim_epoch::text is distinct from claim->>'epoch'
   or a.google_claim_until is null or a.google_claim_until<=clock_timestamp() then raise exception 'google_stale' using errcode='PT409';end if;
  if p_action='renew' then
   if a.revision::text is distinct from p_args->>'revision' or a.google_local_revision::text is distinct from p_args->>'local_revision' then raise exception 'google_stale' using errcode='PT409';end if;
   if not exists(select 1 from public.calendar_connections x join public.calendar_connection_calendars k on k.organization_id=x.organization_id and k.connection_id=x.id
    where x.organization_id=p_org and x.id=a.google_connection_id and x.user_id=publication_owner and x.status='healthy' and k.external_calendar_id=a.google_calendar_id and k.available and k.access_role in ('writer','owner')) then raise exception 'google_connection_unavailable' using errcode='42501';end if;
   update public.calendar_appointments set google_claim_until=clock_timestamp()+interval '90 seconds' where organization_id=p_org and id=p_id returning * into a;
  elsif p_action='release' then
   update public.calendar_appointments set google_claim_token=null,google_claim_until=null where organization_id=p_org and id=p_id;return 'true';
  else
   if a.revision::text is distinct from p_args->>'revision' or a.google_local_revision::text is distinct from p_args->>'local_revision'
    or a.google_event_id is distinct from p_args->>'event_id' or a.google_connection_id::text is distinct from p_args->>'connection_id'
    or a.google_calendar_id is distinct from p_args->>'calendar_id' then raise exception 'google_stale' using errcode='PT409';end if;
   if p_action='error' then
    update public.calendar_appointments set google_sync_error=left(p_args->>'message',200),google_next_attempt_at=now()+interval '15 minutes',
     meeting_state=case when meeting_state='pending' and meeting_attempts>=19 then 'failed' else meeting_state end,
     meeting_last_error=case when meeting_state='pending' then 'unknown' else meeting_last_error end,
     meeting_attempts=meeting_attempts+case when meeting_state='pending' then 1 else 0 end,
     meeting_next_attempt_at=case when meeting_state='pending' then now()+make_interval(secs=>least(900,15*power(2,least(meeting_attempts,6)))::double precision+floor(random()*5)) else meeting_next_attempt_at end
     where organization_id=p_org and id=p_id;return 'true';end if;
   if a.google_event_id is not null then
    select * into conn from public.calendar_connections where organization_id=p_org and id=a.google_connection_id and user_id=publication_owner;
    select * into c from public.calendar_connection_calendars where organization_id=p_org and connection_id=a.google_connection_id and external_calendar_id=a.google_calendar_id;
    if conn.id is null or conn.status<>'healthy' or c.id is null or not c.available then raise exception 'google_connection_unavailable' using errcode='42501';end if;
   end if;
   if p_action='meet' then
    perform public.fn_meet_observe(p_org,p_id,p_args);
    select * into a from public.calendar_appointments where organization_id=p_org and id=p_id;
   elsif p_action='prepare' then
    if c.access_role not in ('owner','writer') or (a.google_pending_write is not null and a.google_pending_write<>'{"reservation":true}'::jsonb) or a.google_conflict is not null then raise exception 'google_write_unavailable' using errcode='PT409';end if;
    if p_args->'operation'?'conference_request_id' and (a.meeting_request_id is distinct from (p_args->'operation'->>'conference_request_id')::uuid or a.meeting_state<>'pending' or a.meeting_received_at is not null or a.status='cancelled') then raise exception 'meet_stale' using errcode='PT409';end if;
    update public.calendar_appointments set meeting_requested_at=case when p_args->'operation'?'conference_request_id' then coalesce(meeting_requested_at,now()) else meeting_requested_at end,google_pending_write=p_args->'operation' where organization_id=p_org and id=p_id;return 'true';
   elsif p_action='idle' then
   -- idle = convergente sem nada a fazer e sem falha nesta rodada: erro
   -- guardado aqui e de rodada passada e nao pode sobreviver (#2467).
    update public.calendar_appointments set google_sync_error=null,google_next_attempt_at=now()+interval '15 minutes' where organization_id=p_org and id=p_id;return 'true';
   elsif p_action='commit' then
    result:=p_args->'result'; b:=result->'base';remote:=result->'remote';
    if result?'operation_id' and a.google_pending_write->>'operation_id' is distinct from result->>'operation_id' then raise exception 'google_stale' using errcode='PT409';end if;
    if result?'apply_remote' then
     if a.status not in ('pending','confirmed') then raise exception 'google_outcome_protected' using errcode='PT409';end if;
     if a.service_occurrence_id is null and not a.service_block and not coalesce((remote->>'cancelled')::boolean,false) and exists(select 1 from public.calendar_appointments other
      where other.organization_id=p_org and other.owner_user_id=a.owner_user_id and other.id<>a.id and other.status in ('pending','confirmed')
      and other.starts_at<(remote->>'ends_at')::timestamptz and other.ends_at>(remote->>'starts_at')::timestamptz) then
      return jsonb_build_object('overlap',true);end if;
     changed:=row(a.starts_at,a.ends_at,a.time_zone,a.status='cancelled') is distinct from row((remote->>'starts_at')::timestamptz,(remote->>'ends_at')::timestamptz,remote->>'time_zone',(remote->>'cancelled')::boolean);
     -- Um evento de bloqueio é projeção do bloqueio local: uma edição remota
     -- não o retira nem muda seu alcance sem a ação explícita do operador.
     if a.service_block and changed then return jsonb_build_object('overlap',true);end if;
     begin
      perform public.fn_appointment_change_core(p_org,p_id,a.revision,
       case when (remote->>'cancelled')::boolean then '{"status":"cancelled","cancellation_reason":"Cancelado no Google"}'::jsonb
       else jsonb_build_object('starts_at',remote->>'starts_at','ends_at',remote->>'ends_at','time_zone',remote->>'time_zone') end,true,b);
     exception when sqlstate 'PT409' then
      -- A subtransação desfaz atribuições novas. A reserva original continua
      -- íntegra e o executor persiste o conflito; autoridade/lease não são ocultados.
      return jsonb_build_object('overlap',true);
     end;
     if changed then
      insert into public.crm_lead_activities(organization_id,lead_id,contact_id,type,source_module,source_id,actor_kind,reason,payload)
       select p_org,l.lead_id,a.contact_id,case when (remote->>'cancelled')::boolean then 'appointment_cancelled' else 'appointment_rescheduled' end,
        'agenda',p_id,'system',case when (remote->>'cancelled')::boolean then 'Cancelado no Google' else 'Remarcado no Google' end,jsonb_build_object('origin','google','appointment_id',p_id,'resolution_actor_id',a.google_conflict->'resolution'->>'actor_id')
       from public.crm_lead_links l where l.organization_id=p_org and l.target_id=p_id and l.target_kind='appointment' group by l.lead_id;
     end if;
    end if;
    update public.calendar_appointments set
     google_base_projection=case when result?'base' then b else google_base_projection end,
     google_etag=case when result?'etag' then result->>'etag' else google_etag end,
     google_conflict=case when result?'conflict' then nullif(result->'conflict','null'::jsonb) else google_conflict end,
     google_pending_write=case when coalesce((result->>'retry_creation')::boolean,false) and a.google_base_projection is null and a.google_pending_write->>'method'='POST'
      then '{"reservation":true}'::jsonb when coalesce((result->>'clear_pending')::boolean,false) then null else google_pending_write end,
     google_synced_local_revision=case when coalesce((result->>'ack')::boolean,false) then a.google_local_revision else google_synced_local_revision end,
     google_synced_at=case when coalesce((result->>'ack')::boolean,false) then now() else google_synced_at end,
     google_sync_error=null,google_next_attempt_at=now()+interval '5 minutes'
     where organization_id=p_org and id=p_id returning * into a;
   else raise exception 'google_action_invalid' using errcode='22023';end if;
  end if;
 end if;
 return to_jsonb(a)||jsonb_build_object('revision',a.revision::text,'google_local_revision',a.google_local_revision::text,
  'google_synced_local_revision',a.google_synced_local_revision::text,'meeting_allowed_types',(select allowed_conference_types from public.calendar_connection_calendars where organization_id=p_org and connection_id=a.google_connection_id and external_calendar_id=a.google_calendar_id),'claim',jsonb_build_object('token',a.google_claim_token,'epoch',a.google_claim_epoch::text,'lease_until',a.google_claim_until));
end;$$;

-- View nova: não acrescentar coluna à view histórica, pois seu a.* é reaplicado antes deste apêndice.
create or replace view public.calendar_service_google_candidates with (security_invoker=true) as
 select a.id,a.organization_id,
  case when a.service_occurrence_id is null and not a.service_block then a.owner_user_id else coalesce(link.user_id,dest.user_id) end owner_user_id,
  a.needs_google_push,a.google_event_id,a.google_conflict,a.google_next_attempt_at
 from public.calendar_appointments a
 left join public.calendar_connections link on link.organization_id=a.organization_id and link.id=a.google_connection_id
 left join public.calendar_connection_calendars k on k.organization_id=a.organization_id and k.id=a.service_destination_calendar_id
 left join public.calendar_connections dest on dest.organization_id=k.organization_id and dest.id=k.connection_id
 where ((a.service_occurrence_id is null and not a.service_block) or a.service_publication_mode<>'none')
  and not exists(select 1 from public.contacts c where c.organization_id=a.organization_id and c.id=a.contact_id and c.is_anonymized);
revoke all on public.calendar_service_google_candidates from public,anon,authenticated;
grant select on public.calendar_service_google_candidates to service_role;
revoke all on function public.fn_google_appointment(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.fn_google_appointment(uuid,uuid,text,jsonb) to service_role;
notify pgrst,'reload schema';

-- ---- Configuração de recursos e bloqueios (0650) ----
-- A porta humana existente permanece autenticada; não abrir EXECUTE das RPCs internas.
create or replace function public.fn_calendar_service_create_authenticated(p_org uuid,p_revision bigint,p_patch jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare actor jsonb;
begin
  if auth.uid() is null or not public.fn_role_at_least(p_org,'agent') or not public.fn_support_write_allowed(p_org)
    then raise exception 'appointment_forbidden' using errcode='42501';end if;
  if not public.fn_session_mfa_proven() then raise exception 'appointment_mfa_required' using errcode='42501';end if;
  if p_revision is not null or (p_patch-'create_service_booking')<>'{}'::jsonb then raise exception 'service_creation_invalid' using errcode='22023';end if;
  actor:=jsonb_build_object('type','user','id',auth.uid());
  if p_patch->'create_service_booking'?'participants' then
    return public.fn_calendar_service_book_group(p_org,actor,(p_patch->'create_service_booking')-'meeting_delivery',null);
  end if;
  return public.fn_calendar_service_book(p_org,actor,(p_patch->'create_service_booking')-'meeting_delivery',null);
end $$;
revoke all on function public.fn_calendar_service_create_authenticated(uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.fn_calendar_service_create_authenticated(uuid,bigint,jsonb) to service_role;

create or replace function public.fn_appointment_change(p_org uuid,p_id uuid,p_revision bigint,p_patch jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
 if p_id is null and p_patch?'create_service_booking' then
  return public.fn_calendar_service_create_authenticated(p_org,p_revision,p_patch);
 end if;
 return public.fn_appointment_change_core(p_org,p_id,p_revision,p_patch,false,null);
end $$;
revoke all on function public.fn_appointment_change(uuid,uuid,bigint,jsonb) from public,anon;
grant execute on function public.fn_appointment_change(uuid,uuid,bigint,jsonb) to authenticated,service_role;

create or replace function public.fn_calendar_service_catalog(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
begin
 if auth.uid() is not null and not public.fn_role_at_least(p_org,'manager') then return '[]'::jsonb;end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id',k.id,'name',k.name,'account_email',c.account_email,'user_id',c.user_id,
   'can_read',k.access_role in ('owner','writer','reader','writerWithoutPrivateAccess'),'can_write',k.access_role in ('owner','writer'),
   'available',k.available and c.status='healthy','last_sync_at',k.last_sync_at,'sync_error',k.sync_error,
   'is_destination',k.is_destination,'coverage',k.sync_coverage) order by c.account_email,k.name),'[]'::jsonb)
  from public.calendar_connection_calendars k join public.calendar_connections c on c.organization_id=k.organization_id and c.id=k.connection_id
  join public.user_organizations m on m.organization_id=c.organization_id and m.user_id=c.user_id and m.revoked_at is null
  where k.organization_id=p_org);
end $$;
revoke all on function public.fn_calendar_service_catalog(uuid) from public,anon;
grant execute on function public.fn_calendar_service_catalog(uuid) to authenticated,service_role;

create or replace function public.fn_calendar_service_resource(p_org uuid,p_actor jsonb,p_config jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.calendar_resources;resource uuid:=coalesce((p_config->>'id')::uuid,gen_random_uuid());
begin
 perform public.fn_calendar_service_assert_actor(p_org,p_actor,'manager');
 perform public.fn_calendar_service_lock(p_org);
 if coalesce(length(trim(p_config->>'name')),0) not between 2 and 100 or coalesce((p_config->>'capacity')::integer,0) not between 1 and 100000
  then raise exception 'service_resource_invalid' using errcode='22023';end if;
 select * into r from public.calendar_resources where organization_id=p_org and id=resource for update;
 if found then
  if r.revision is distinct from (p_config->>'expected_revision')::bigint then raise exception 'service_stale' using errcode='PT409';end if;
  update public.calendar_resources set name=trim(p_config->>'name'),capacity=(p_config->>'capacity')::integer,
    is_active=coalesce((p_config->>'is_active')::boolean,true),revision=revision+1 where organization_id=p_org and id=resource returning * into r;
 else
  if p_config?'id' then raise exception 'service_resource_not_found' using errcode='P0002';end if;
  insert into public.calendar_resources(id,organization_id,name,capacity) values(resource,p_org,trim(p_config->>'name'),(p_config->>'capacity')::integer) returning * into r;
 end if;
 return to_jsonb(r);
end $$;
revoke all on function public.fn_calendar_service_resource(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.fn_calendar_service_resource(uuid,jsonb,jsonb) to service_role;

create or replace function public.fn_calendar_service_block(p_org uuid,p_actor jsonb,p_input jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare b public.calendar_service_blocks;t public.calendar_event_types;appointment uuid;affected integer;destination uuid;
 start_at timestamptz:=(p_input->>'starts_at')::timestamptz;end_at timestamptz:=(p_input->>'ends_at')::timestamptz;
begin
 perform public.fn_calendar_service_assert_actor(p_org,p_actor,'manager');
 perform public.fn_calendar_service_lock(p_org);
 if p_input?'archive_id' then
  select * into b from public.calendar_service_blocks where organization_id=p_org and id=(p_input->>'archive_id')::uuid for update;
  if not found then raise exception 'service_block_not_found' using errcode='P0002';end if;
  if b.archived_at is not null then return to_jsonb(b);end if;
  if b.revision is distinct from (p_input->>'expected_revision')::bigint then raise exception 'service_stale' using errcode='PT409';end if;
  if b.publication_appointment_id is not null then
    perform public.fn_appointment_change(p_org,b.publication_appointment_id,
      (select revision from public.calendar_appointments where organization_id=p_org and id=b.publication_appointment_id),
      jsonb_build_object('status','cancelled','cancellation_reason','Bloqueio retirado pela equipe.'));
  end if;
  update public.calendar_service_blocks set archived_at=now(),revision=revision+1 where organization_id=p_org and id=b.id returning * into b;
  return to_jsonb(b);
 end if;
 if end_at<=start_at or coalesce(length(trim(p_input->>'reason')),0) not between 1 and 300 or p_input->>'scope_kind' not in ('service','professional','resource')
  then raise exception 'service_block_invalid' using errcode='22023';end if;
 if p_input->>'scope_kind'='service' then
  select * into t from public.calendar_event_types where organization_id=p_org and id=(p_input->>'event_type_id')::uuid;
  if not found then raise exception 'service_not_found' using errcode='P0002';end if;
 elsif p_input->>'scope_kind'='professional' and not exists(select 1 from public.user_organizations where organization_id=p_org and user_id=(p_input->>'owner_user_id')::uuid and revoked_at is null)
  then raise exception 'service_professional_not_found' using errcode='P0002';
 elsif p_input->>'scope_kind'='resource' and not exists(select 1 from public.calendar_resources where organization_id=p_org and id=(p_input->>'resource_id')::uuid)
  then raise exception 'service_resource_not_found' using errcode='P0002';end if;
  select count(*) into affected from public.calendar_appointments a where a.organization_id=p_org and not a.service_block
   and a.status in ('pending','confirmed') and a.starts_at<end_at and a.ends_at>start_at and case p_input->>'scope_kind'
    when 'service' then a.event_type_id=(p_input->>'event_type_id')::uuid when 'professional' then a.owner_user_id=(p_input->>'owner_user_id')::uuid
    else exists(select 1 from public.calendar_service_occurrence_resources r where r.organization_id=p_org and r.occurrence_id=a.service_occurrence_id and r.resource_id=(p_input->>'resource_id')::uuid) end;
 if coalesce((p_input->>'preview')::boolean,false) then
  return jsonb_build_object('preview',true,'existing_reservations_preserved',affected,'scope_kind',p_input->>'scope_kind');
 end if;
 select * into b from public.calendar_service_blocks where organization_id=p_org and operation_key=(p_input->>'operation_key')::uuid;
 if found then
  if row(b.scope_kind,b.starts_at,b.ends_at,b.reason,b.event_type_id,b.owner_user_id,b.resource_id) is distinct from
    row(p_input->>'scope_kind',start_at,end_at,trim(p_input->>'reason'),(p_input->>'event_type_id')::uuid,(p_input->>'owner_user_id')::uuid,(p_input->>'resource_id')::uuid)
    then raise exception 'service_idempotency_conflict' using errcode='PT409';end if;
  return to_jsonb(b)||jsonb_build_object('deduplicated',true,'active',b.archived_at is null,'existing_reservations_preserved',affected,
   'google_publication',case when b.publication_appointment_id is null then 'not_configured' else
    (select case when a.google_conflict is not null then 'conflict' when a.google_sync_error is not null then 'failed'
      when a.google_event_id is not null and a.google_synced_local_revision=a.google_local_revision then case when a.status='cancelled' then 'removed' else 'synced' end else 'pending' end
     from public.calendar_appointments a where a.organization_id=p_org and a.id=b.publication_appointment_id) end);
 end if;
 if coalesce((p_input->>'publish_google')::boolean,false) then
  if p_input->>'scope_kind'<>'service' or t.service_publication_mode<>'service' or t.destination_calendar_id is null
    then raise exception 'service_publication_invalid' using errcode='22023';end if;
  if not exists(select 1 from public.calendar_connection_calendars k join public.calendar_connections c on c.organization_id=k.organization_id and c.id=k.connection_id
    join public.user_organizations m on m.organization_id=c.organization_id and m.user_id=c.user_id and m.revoked_at is null
    where k.organization_id=p_org and k.id=t.destination_calendar_id and k.available and k.access_role in ('owner','writer') and c.status='healthy')
    then raise exception 'publication_unavailable' using errcode='PT409';end if;
  insert into public.calendar_appointments(organization_id,event_type_id,title,starts_at,ends_at,time_zone,status,source,created_by_kind,created_by_user_id,
      service_block,service_destination_calendar_id,service_publication_mode)
    values(p_org,t.id,'Bloqueio: '||t.name,start_at,end_at,t.service_timezone,'confirmed',case when p_actor->>'type'='user' then 'ui' else 'mcp' end,
      case when p_actor->>'type'='user' then 'user' else 'system' end,case when p_actor->>'type'='user' then (p_actor->>'id')::uuid else null end,
      true,t.destination_calendar_id,'service') returning id into appointment;
 end if;
 insert into public.calendar_service_blocks(organization_id,scope_kind,event_type_id,owner_user_id,resource_id,starts_at,ends_at,reason,operation_key,publication_appointment_id)
  values(p_org,p_input->>'scope_kind',(p_input->>'event_type_id')::uuid,(p_input->>'owner_user_id')::uuid,(p_input->>'resource_id')::uuid,start_at,end_at,
    trim(p_input->>'reason'),(p_input->>'operation_key')::uuid,appointment) returning * into b;
 select count(*) into affected from public.calendar_appointments a where a.organization_id=p_org and not a.service_block
  and a.status in ('pending','confirmed') and a.starts_at<end_at and a.ends_at>start_at and case b.scope_kind
    when 'service' then a.event_type_id=b.event_type_id when 'professional' then a.owner_user_id=b.owner_user_id
    else exists(select 1 from public.calendar_service_occurrence_resources r where r.organization_id=p_org and r.occurrence_id=a.service_occurrence_id and r.resource_id=b.resource_id) end;
 return to_jsonb(b)||jsonb_build_object('existing_reservations_preserved',affected,'google_publication',case when appointment is null then 'not_configured' else 'pending' end);
end $$;
revoke all on function public.fn_calendar_service_block(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.fn_calendar_service_block(uuid,jsonb,jsonb) to service_role;
notify pgrst,'reload schema';

-- ---- Autoridade Google em serviços compartilhados (0650) ----

-- A conta de publicação pode ser compartilhada; ela nunca se torna o profissional.
-- A mesma autoridade limita a decisão, a retentativa e o trigger de metadados.
create or replace function public.fn_calendar_service_can_resolve(p_org uuid,p_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
 select auth.uid() is not null and public.fn_role_at_least(p_org,'agent') and public.fn_support_write_allowed(p_org)
  and public.fn_session_mfa_proven() and exists(
   select 1 from public.calendar_appointments a
   left join public.calendar_connections link on link.organization_id=a.organization_id and link.id=a.google_connection_id
   left join public.calendar_connection_calendars k on k.organization_id=a.organization_id and k.id=a.service_destination_calendar_id
   left join public.calendar_connections dest on dest.organization_id=k.organization_id and dest.id=k.connection_id
   where a.organization_id=p_org and a.id=p_id and case
    when a.service_occurrence_id is null and not a.service_block then a.owner_user_id=auth.uid()
    else a.service_publication_mode<>'none'
     and exists(select 1 from public.user_organizations m where m.organization_id=p_org and m.user_id=coalesce(link.user_id,dest.user_id) and m.revoked_at is null)
     and (public.fn_role_at_least(p_org,'manager') or auth.uid()=coalesce(link.user_id,dest.user_id)) end);
$$;
revoke all on function public.fn_calendar_service_can_resolve(uuid,uuid) from public,anon;
grant execute on function public.fn_calendar_service_can_resolve(uuid,uuid) to authenticated,service_role;

create or replace function public.fn_google_resolve(p_org uuid,p_id uuid,p_revision text,p_local_revision text,p_etag text,p_choice text)
returns void language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; contact uuid;
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'agent') or not public.fn_support_write_allowed(p_org) then raise exception 'google_resolution_forbidden' using errcode='42501';end if;
 if not public.fn_session_mfa_proven() then raise exception 'google_mfa_required' using errcode='42501';end if;
 perform public.fn_calendar_service_lock(p_org);
 select contact_id into contact from public.calendar_appointments where organization_id=p_org and id=p_id;
 if contact is not null then perform public.fn_service_lock(p_org,contact);end if;
 select * into a from public.calendar_appointments where organization_id=p_org and id=p_id for update;
 if not found or not public.fn_calendar_service_can_resolve(p_org,p_id) then raise exception 'google_resolution_forbidden' using errcode='42501';end if;
 if a.revision::text is distinct from p_revision or a.google_local_revision::text is distinct from p_local_revision
  or a.google_etag is distinct from p_etag then raise exception 'google_stale' using errcode='PT409';end if;
 if p_choice='retry' then
  if a.google_conflict is not null then raise exception 'google_conflict_requires_choice' using errcode='PT409';end if;
  update public.calendar_appointments set google_next_attempt_at=now() where organization_id=p_org and id=p_id;
 else
  if p_choice not in ('google','local','preserve_remote') or a.google_conflict is null then raise exception 'google_choice_invalid' using errcode='22023';end if;
  -- O trigger reconhece somente esta forma autenticada: o corpo da comparação
  -- e as revisões não mudam, actor_id é auth.uid(), não input do browser.
  update public.calendar_appointments set google_conflict=google_conflict||jsonb_build_object('resolution',jsonb_build_object('choice',p_choice,'actor_id',auth.uid())),google_next_attempt_at=now()
   where organization_id=p_org and id=p_id;
 end if;
end;$$;
create or replace function public.fn_google_projection_stamp()
returns trigger language plpgsql security definer set search_path=public as $$
declare changed boolean; inbound boolean; decision boolean; redacted boolean;
begin
 redacted:=new.contact_id is not null and exists(select 1 from public.contacts where organization_id=new.organization_id and id=new.contact_id and is_anonymized);
 if redacted then
  new.google_base_projection:=null;new.google_conflict:=null;new.google_pending_write:=null;new.google_claim_token:=null;new.google_claim_until:=null;new.google_etag:=null;new.guest_email:=null;
  if tg_op='UPDATE' then new.google_claim_epoch:=old.google_claim_epoch+1;new.google_local_revision:=old.google_local_revision;new.google_synced_local_revision:=old.google_local_revision;end if;
  return new;
 end if;
 if tg_op='INSERT' then
  new.google_local_revision:=1;new.google_synced_local_revision:=0;
  if auth.uid() is not null then
   new.google_base_projection:=null;new.google_etag:=null;new.google_pending_write:=null;new.google_conflict:=null;
   new.google_claim_token:=null;new.google_claim_epoch:=0;new.google_claim_until:=null;
   new.google_connection_id:=null;new.google_calendar_id:=null;new.google_event_id:=null;
  end if;
  return new;
 end if;
 decision:=public.fn_calendar_service_can_resolve(old.organization_id,old.id) and public.fn_role_at_least(new.organization_id,'agent') and public.fn_support_write_allowed(new.organization_id)
  and old.google_conflict is not null and new.google_conflict-'resolution'=old.google_conflict-'resolution'
  and new.google_conflict->'resolution'->>'actor_id'=auth.uid()::text
  and new.google_conflict->'resolution'->>'choice' in ('google','local','preserve_remote')
  and old.google_conflict->>'revision'=old.revision::text and old.google_conflict->>'local_revision'=old.google_local_revision::text
  and old.google_conflict->>'etag' is not distinct from old.google_etag;
 if auth.uid() is not null and (row(new.google_synced_at,new.google_sync_error) is distinct from row(old.google_synced_at,old.google_sync_error)
  or (new.google_next_attempt_at is distinct from old.google_next_attempt_at and not coalesce(public.fn_calendar_service_can_resolve(old.organization_id,old.id) and public.fn_role_at_least(new.organization_id,'agent') and public.fn_support_write_allowed(new.organization_id)
    and new.google_next_attempt_at<=clock_timestamp() and (old.google_conflict is null or decision),false))) then
  raise exception 'google_metadata_private' using errcode='42501';end if;
 if auth.uid() is not null and ((new.google_conflict is distinct from old.google_conflict and not coalesce(decision,false)) or row(new.google_base_projection,new.google_pending_write,new.google_claim_token,new.google_claim_epoch,new.google_claim_until,new.google_synced_local_revision,new.google_etag,new.google_connection_id,new.google_calendar_id,new.google_event_id)
  is distinct from row(old.google_base_projection,old.google_pending_write,old.google_claim_token,old.google_claim_epoch,old.google_claim_until,old.google_synced_local_revision,old.google_etag,old.google_connection_id,old.google_calendar_id,old.google_event_id)) then
  raise exception 'google_metadata_private' using errcode='42501';
 end if;
 changed:=row(new.starts_at,new.ends_at,new.time_zone,new.status='cancelled',new.title,new.description,new.location_kind,new.location_details,new.guest_email)
  is distinct from row(old.starts_at,old.ends_at,old.time_zone,old.status='cancelled',old.title,old.description,old.location_kind,old.location_details,old.guest_email);
 -- Única entrada que modifica base e domínio juntos é o núcleo service-only.
 -- Não há GUC ou flag no body público que suprima revisão.
 inbound:=row(new.title,new.description,new.location_kind,new.location_details,new.guest_email) is not distinct from row(old.title,old.description,old.location_kind,old.location_details,old.guest_email) and auth.uid() is null and new.google_base_projection is distinct from old.google_base_projection
  and (new.google_base_projection->'shared'->>'starts_at')::timestamptz=new.starts_at
  and (new.google_base_projection->'shared'->>'ends_at')::timestamptz=new.ends_at
  and new.google_base_projection->'shared'->>'time_zone'=new.time_zone
  and (new.google_base_projection->'shared'->>'cancelled')::boolean=(new.status='cancelled');
 new.google_local_revision:=old.google_local_revision+case when changed and not coalesce(inbound,false) then 1 else 0 end;
 if changed then new.google_next_attempt_at:=now(); end if;
 return new;
end;$$;
notify pgrst,'reload schema';
