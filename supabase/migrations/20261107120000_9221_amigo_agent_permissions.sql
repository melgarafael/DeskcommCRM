-- manifest: Permissões de operações Amigo escolhidas pelo administrador para o agente.
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
  alter table public.amigo_connections add column if not exists agent_operations jsonb;
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


do $m$ begin if to_regclass('public.amigo_connections') is not null then alter table public.amigo_connections add column if not exists agent_operations jsonb;end if;end $m$;
create or replace function public.fn_amigo_save_config(p_org uuid, p_actor uuid, p_input jsonb, p_ciphertext text default null, p_connection uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  connection uuid;
  saved jsonb;
begin
  if not exists(select 1 from public.user_organizations where organization_id=p_org and user_id=p_actor and role='admin' and revoked_at is null and accepted_at is not null) then
    raise exception using errcode='42501', message='amigo_admin_required';
  end if;
  perform 1 from public.organizations where id=p_org for update;
  if not found then raise exception using errcode='23503', message='amigo_org_missing'; end if;
  if p_input - array['active','token_last4','default_place_id','timezone','allow_same_day','months_ahead','reminders_enabled','agent_operations']::text[] <> '{}'::jsonb then
    raise exception using errcode='22023', message='amigo_invalid_config';
  end if;
  if p_ciphertext is not null then
    if length(p_ciphertext)=0 or coalesce(p_input->>'token_last4','')='' then
      raise exception using errcode='22023', message='amigo_credential_missing';
    end if;
    update public.amigo_connections set active=false where organization_id=p_org and active;
    insert into public.amigo_connections(organization_id,active,token_last4,validated_at,default_place_id,timezone,allow_same_day,months_ahead,reminders_enabled,agent_operations)
      values(p_org,false,p_input->>'token_last4',now(),(p_input->>'default_place_id')::integer,coalesce(p_input->>'timezone',''),(p_input->>'allow_same_day')::boolean,(p_input->>'months_ahead')::integer,coalesce((p_input->>'reminders_enabled')::boolean,false),p_input->'agent_operations')
      returning id into connection;
    insert into public.amigo_credentials(organization_id,connection_id,ciphertext) values(p_org,connection,p_ciphertext);
  else
    select id into connection from public.amigo_connections where organization_id=p_org order by created_at desc,id desc limit 1 for update;
    if connection is null then raise exception using errcode='22023', message='amigo_not_configured'; end if;
    if connection is distinct from p_connection then
      raise exception using errcode='40001', message='amigo_connection_changed';
    end if;
    if coalesce((p_input->>'active')::boolean,false) and not exists(select 1 from public.amigo_credentials where organization_id=p_org and connection_id=connection) then
      raise exception using errcode='22023', message='amigo_credential_missing';
    end if;
    update public.amigo_connections set
      active=case when p_input ? 'active' then (p_input->>'active')::boolean else active end,
      default_place_id=case when p_input ? 'default_place_id' then (p_input->>'default_place_id')::integer else default_place_id end,
      timezone=case when p_input ? 'timezone' then p_input->>'timezone' else timezone end,
      allow_same_day=case when p_input ? 'allow_same_day' then (p_input->>'allow_same_day')::boolean else allow_same_day end,
      months_ahead=case when p_input ? 'months_ahead' then (p_input->>'months_ahead')::integer else months_ahead end,
      reminders_enabled=case when p_input ? 'reminders_enabled' then (p_input->>'reminders_enabled')::boolean else reminders_enabled end,
      agent_operations=case when p_input ? 'agent_operations' then p_input->'agent_operations' else agent_operations end
      where organization_id=p_org and id=connection;
  end if;
  select to_jsonb(c) into saved from public.amigo_connections c where c.organization_id=p_org and c.id=connection;
  return saved;
end;
$fn$;
revoke all on function public.fn_amigo_save_config(uuid,uuid,jsonb,text,uuid) from public, anon, authenticated;
grant execute on function public.fn_amigo_save_config(uuid,uuid,jsonb,text,uuid) to service_role;

notify pgrst,'reload schema';
