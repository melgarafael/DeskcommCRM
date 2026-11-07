-- manifest: Proteger autoridade Amigo no banco, permitir desfechos externos sem certificação humana e manter o marcador de efeitos reparáveis.
create or replace function public.fn_provision_amigo() returns void
language plpgsql security definer set search_path = '' as $fn$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public.fn_provision_amigo', 0));
  create unique index if not exists amigo_contacts_org_id_uq on public.contacts(organization_id,id);
  create unique index if not exists amigo_leads_org_id_uq on public.crm_leads(organization_id,id);
  create unique index if not exists amigo_appointments_org_id_uq on public.calendar_appointments(organization_id,id);

  create table if not exists public.amigo_connections (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    active boolean not null default false,
    token_last4 text check (token_last4 is null or length(token_last4) between 1 and 4),
    validated_at timestamptz,
    default_place_id integer check (default_place_id > 0),
    -- Empty until explicitly confirmed. An inferred default must not activate a clinic.
    timezone text not null default '',
    allow_same_day boolean,
    months_ahead integer check (months_ahead in (3,6)),
    reminders_enabled boolean not null default false,
    last_sync_at timestamptz,
    last_error text,
    created_at timestamptz not null default clock_timestamp(),
    unique (organization_id,id),
    constraint amigo_connections_activation_check check (not active or (token_last4 is not null and validated_at is not null and default_place_id is not null and timezone <> ''))
  );
  create unique index if not exists amigo_connections_one_active_uq on public.amigo_connections(organization_id) where active;
  create index if not exists amigo_connections_latest_idx on public.amigo_connections(organization_id,created_at desc,id desc);
  create table if not exists public.amigo_credentials (
    connection_id uuid primary key,
    organization_id uuid not null references public.organizations(id) on delete cascade,
    ciphertext text not null check (length(ciphertext) > 0),
    foreign key (organization_id,connection_id) references public.amigo_connections(organization_id,id) on delete cascade
  );
  create table if not exists public.amigo_patient_links (
    organization_id uuid not null references public.organizations(id) on delete cascade,
    connection_id uuid not null,
    patient_id integer not null check (patient_id > 0),
    contact_id uuid not null,
    lead_id uuid,
    primary key (organization_id,connection_id,patient_id),
    foreign key (organization_id,connection_id) references public.amigo_connections(organization_id,id) on delete cascade,
    foreign key (organization_id,contact_id) references public.contacts(organization_id,id) on delete cascade,
    foreign key (organization_id,lead_id) references public.crm_leads(organization_id,id)
  );
  create table if not exists public.amigo_appointment_links (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    connection_id uuid not null,
    attendance_id integer not null check (attendance_id > 0),
    appointment_id uuid,
    patient_id integer check (patient_id > 0),
    remote_status text,
    remote_data jsonb not null default '{}'::jsonb,
    synced_at timestamptz not null default now(),
    unique (organization_id,connection_id,attendance_id),
    foreign key (organization_id,connection_id) references public.amigo_connections(organization_id,id) on delete cascade,
    foreign key (organization_id,appointment_id) references public.calendar_appointments(organization_id,id)
  );
  create table if not exists public.amigo_operations (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    connection_id uuid not null,
    key text not null check (length(key)>0),
    request_hash text not null,
    operation text not null,
    state text not null default 'prepared' check (state in ('prepared','sent','confirmed','rejected','uncertain')),
    result jsonb,
    request_context jsonb not null default '{}'::jsonb,
    target_id text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (organization_id,connection_id,key),
    foreign key (organization_id,connection_id) references public.amigo_connections(organization_id,id) on delete cascade
  );
  -- target_id: attendance identity, or the natural request hash for creation.
  -- NULL carries no lock; domain must assign a stable target before sending.
  create unique index if not exists amigo_operations_inflight_target_uq
    on public.amigo_operations(organization_id,connection_id,target_id)
    where state in ('prepared','sent','uncertain');
  create index if not exists amigo_patient_links_contact_idx on public.amigo_patient_links(organization_id,contact_id);
  create index if not exists amigo_patient_links_lead_idx on public.amigo_patient_links(organization_id,lead_id);
  create index if not exists amigo_appointment_links_appointment_idx on public.amigo_appointment_links(organization_id,appointment_id);

  alter table public.amigo_appointment_links add column if not exists effects_fingerprint text;
  alter table public.amigo_connections enable row level security;
  alter table public.amigo_credentials enable row level security;
  alter table public.amigo_patient_links enable row level security;
  alter table public.amigo_appointment_links enable row level security;
  alter table public.amigo_operations enable row level security;
  -- Remove Supabase default ACLs, including TRUNCATE. Only the guarded backend writes.
  revoke all on public.amigo_connections, public.amigo_credentials, public.amigo_patient_links, public.amigo_appointment_links, public.amigo_operations from public, anon, authenticated, service_role;
  grant select,insert,update,delete on public.amigo_connections, public.amigo_credentials, public.amigo_patient_links, public.amigo_appointment_links, public.amigo_operations to service_role;
  grant select on public.amigo_connections, public.amigo_patient_links, public.amigo_appointment_links, public.amigo_operations to authenticated;
  -- Conservative direct access: global patient payloads/operation results only
  -- for management of this org. Contextual agents go through the domain guard.
  drop policy if exists tenant_isolation_amigo_connections_select on public.amigo_connections;
  create policy tenant_isolation_amigo_connections_select on public.amigo_connections for select to authenticated
    using (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id,'manager'));
  drop policy if exists tenant_isolation_amigo_patient_links_select on public.amigo_patient_links;
  create policy tenant_isolation_amigo_patient_links_select on public.amigo_patient_links for select to authenticated
    using (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id,'manager'));
  drop policy if exists tenant_isolation_amigo_appointment_links_select on public.amigo_appointment_links;
  create policy tenant_isolation_amigo_appointment_links_select on public.amigo_appointment_links for select to authenticated
    using (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id,'manager'));
  drop policy if exists tenant_isolation_amigo_operations_select on public.amigo_operations;
  create policy tenant_isolation_amigo_operations_select on public.amigo_operations for select to authenticated
    using (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id,'manager'));

  drop trigger if exists amigo_connection_timezone on public.amigo_connections;
  create trigger amigo_connection_timezone before insert or update of timezone on public.amigo_connections
    for each row execute function public.fn_amigo_check_timezone();
  perform public.fn_proteger_modulo_provisionado();
  perform pg_catalog.pg_notify('pgrst','reload schema');
end;
$fn$;
revoke all on function public.fn_provision_amigo() from public, anon, authenticated;
grant execute on function public.fn_provision_amigo() to service_role;


do $ddl$ begin
 if to_regclass('public.amigo_appointment_links') is not null then
  alter table public.amigo_appointment_links add column if not exists effects_fingerprint text;
 end if;
end $ddl$;

create or replace function public.fn_amigo_protect_projection() returns trigger
language plpgsql security definer set search_path='' as $body$
declare privileged boolean := coalesce(current_setting('role',true),'none') in ('service_role','none','postgres');
begin
 if not privileged then
  if tg_op='INSERT' then
   if new.authority <> 'local' then raise exception 'amigo_remote_authority_required' using errcode='42501'; end if;
   if to_regclass('public.amigo_connections') is not null and exists(select 1 from public.amigo_connections where organization_id=new.organization_id and active) then
    raise exception 'amigo_main_agenda_required' using errcode='42501';
   end if;
  elsif tg_op='DELETE' then
   if old.authority='amigo' then raise exception 'amigo_remote_authority_required' using errcode='42501';end if;
  elsif old.authority='amigo' or new.authority is distinct from old.authority or new.external_connection_id is distinct from old.external_connection_id or new.external_status is distinct from old.external_status then
   raise exception 'amigo_remote_authority_required' using errcode='42501';
  end if;
 end if;
 if tg_op='DELETE' then return old;end if;
 return new;
end $body$;
revoke all on function public.fn_amigo_protect_projection() from public,anon,authenticated;
grant execute on function public.fn_amigo_protect_projection() to service_role;
drop trigger if exists trg_amigo_protect_projection on public.calendar_appointments;
create trigger trg_amigo_protect_projection before insert or update or delete on public.calendar_appointments for each row execute function public.fn_amigo_protect_projection();

create or replace function public.fn_amigo_protect_event_identity() returns trigger
language plpgsql security definer set search_path='' as $body$
begin
 if coalesce(current_setting('role',true),'none') not in ('service_role','none','postgres') then
  if tg_op='DELETE' then
   if old.external_provider='amigo' then raise exception 'amigo_external_type_identity' using errcode='42501';end if;
  elsif tg_op='INSERT' then
   if new.external_provider is not null then raise exception 'amigo_external_type_identity' using errcode='42501';end if;
  elsif row(new.external_provider,new.external_id,new.external_connection_id) is distinct from row(old.external_provider,old.external_id,old.external_connection_id) then
   raise exception 'amigo_external_type_identity' using errcode='42501';
  end if;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end $body$;
revoke all on function public.fn_amigo_protect_event_identity() from public,anon,authenticated;
grant execute on function public.fn_amigo_protect_event_identity() to service_role;
drop trigger if exists trg_amigo_protect_event_identity on public.calendar_event_types;
create trigger trg_amigo_protect_event_identity before insert or update or delete on public.calendar_event_types for each row execute function public.fn_amigo_protect_event_identity();

-- Adapt the effective revision/evidence trigger, preserving its current local rules.
do $ddl$
declare definition text; needle text := 'actor:=auth.uid();';
begin
 definition:=pg_get_functiondef('public.fn_appointment_stamp()'::regprocedure);
 if position('amigo_external_outcome' in definition)=0 then
  if position(needle in definition)=0 then raise exception 'appointment_stamp_contract_changed';end if;
  definition:=replace(definition,needle,$patch$
  -- amigo_external_outcome: authoritative import is not certified human attendance.
  if new.authority='amigo' and coalesce(current_setting('role',true),'none')='service_role' then
   new.outcome_source_kind:=null;new.outcome_user_id:=null;new.outcome_message_id:=null;new.outcome_recorded_at:=null;
   return new;
  end if;
  actor:=auth.uid();$patch$);
  execute definition;
 end if;
end $ddl$;
notify pgrst,'reload schema';
