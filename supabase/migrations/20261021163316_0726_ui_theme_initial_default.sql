-- manifest: Define em Marca global o tema inicial de novas organizações, com autoridade de plataforma, revisão, recibo e cópia visual atômica sem sobrescrever escolhas existentes.
create table if not exists public.platform_ui_theme_defaults (
  id smallint primary key default 1 check (id=1),
  theme_id text not null default 'padrao' check (theme_id ~ '^[a-z][a-z0-9-]{1,63}$'),
  installation_id text not null default 'builtin-padrao-v1' check (installation_id ~ '^[a-zA-Z0-9_-]{4,100}$'),
  revision integer not null default 0 check (revision>=0),
  configurations jsonb not null default '{"padrao":{"version":1,"values":{}}}'::jsonb
    check (jsonb_typeof(configurations)='object' and pg_column_size(configurations)<=1048576
      and configurations ? theme_id and jsonb_typeof(configurations->theme_id) is not distinct from 'object'
      and jsonb_typeof(configurations->theme_id->'version') is not distinct from 'number'
      and jsonb_typeof(configurations->theme_id->'values') is not distinct from 'object'),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  last_request_id uuid,
  last_request_hash text
);
-- Configuration of the installation, not tenant data: server-side only like platform_branding.
alter table public.platform_ui_theme_defaults enable row level security;
revoke all on table public.platform_ui_theme_defaults from public,anon,authenticated,service_role;
grant select on table public.platform_ui_theme_defaults to service_role;

create or replace function public.fn_ui_theme_initial_default_apply(
  p_actor uuid,p_theme text,p_installation text,p_catalog_hash text,
  p_options_version integer,p_values jsonb,p_expected_revision integer,p_request uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_old public.platform_ui_theme_defaults%rowtype;
  v_revision integer;
  v_hash text;
  v_configs jsonb;
begin
  if p_actor is null or p_theme is null or p_installation is null or p_request is null
    or p_theme !~ '^[a-z][a-z0-9-]{1,63}$' or p_installation !~ '^[a-zA-Z0-9_-]{4,100}$'
    or p_catalog_hash is null or p_catalog_hash !~ '^[0-9a-f]{64}$'
    or p_options_version is null or p_options_version<1
    or p_expected_revision is null or p_expected_revision<0 or p_expected_revision>2147483646
    or jsonb_typeof(p_values) is distinct from 'object' or pg_column_size(p_values)>32768 then
    raise exception 'ui_theme_initial_invalid' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_each(p_values) o
      where o.key !~ '^(global|[a-z][a-z0-9-]{1,63})\.[a-z][a-z0-9-]{0,47}$'
        or jsonb_typeof(o.value) not in('string','number','boolean')) then
    raise exception 'ui_theme_initial_invalid' using errcode='22023';
  end if;
  -- Serializes the first write too; no placeholder row is seeded in public installations.
  perform pg_advisory_xact_lock(hashtextextended('public.platform_ui_theme_defaults',0));
  -- Authority is re-read after waiting, and held until the configuration/audit commit together.
  perform 1 from public.platform_admins where user_id=p_actor and revoked_at is null and scope='full' for share;
  if not found then raise exception 'ui_theme_initial_forbidden' using errcode='42501';end if;
  select * into v_old from public.platform_ui_theme_defaults where id=1 for update;
  v_revision:=coalesce(v_old.revision,0);
  v_hash:=encode(extensions.digest(jsonb_build_object('theme',p_theme,'installation',p_installation,
    'catalog',p_catalog_hash,'version',p_options_version,'values',p_values)::text,'sha256'),'hex');
  if v_old.last_request_id=p_request then
    if v_old.last_request_hash is distinct from v_hash then
      raise exception 'ui_theme_initial_request_conflict' using errcode='PT409';
    end if;
    return jsonb_build_object('revision',v_revision,'applied_now',false);
  end if;
  if v_revision<>p_expected_revision then
    raise exception 'ui_theme_initial_revision_conflict' using errcode='PT409';
  end if;
  v_configs:=jsonb_set(coalesce(v_old.configurations,'{}'::jsonb),array[p_theme],
    jsonb_build_object('version',p_options_version,'values',p_values),true);
  insert into public.platform_ui_theme_defaults(id,theme_id,installation_id,revision,configurations,updated_by,last_request_id,last_request_hash)
    values(1,p_theme,p_installation,v_revision+1,v_configs,p_actor,p_request,v_hash)
  on conflict(id) do update set theme_id=excluded.theme_id,installation_id=excluded.installation_id,
    revision=excluded.revision,configurations=excluded.configurations,updated_by=excluded.updated_by,
    updated_at=clock_timestamp(),last_request_id=excluded.last_request_id,last_request_hash=excluded.last_request_hash;
  -- No organization or UUID resource is invented for the singleton; never log option values.
  insert into public.api_audit_log(organization_id,actor_user_id,acting_as_platform_admin,action,resource_type,resource_id,request_id,bypassed_rls,metadata)
    values(null,p_actor,true,'ui_theme.initial_default_updated','platform_ui_theme_default',null,p_request::text,true,
      jsonb_build_object('theme_id',p_theme,'installation_id',p_installation,'revision',v_revision+1,'options_version',p_options_version));
  return jsonb_build_object('revision',v_revision+1,'applied_now',true);
end;
$$;
revoke all on function public.fn_ui_theme_initial_default_apply(uuid,text,text,text,integer,jsonb,integer,uuid) from public,anon,authenticated;
grant execute on function public.fn_ui_theme_initial_default_apply(uuid,text,text,text,integer,jsonb,integer,uuid) to service_role;

create or replace function public.fn_ui_theme_seed_new_organization()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_default public.platform_ui_theme_defaults%rowtype;
  v_revision integer;
begin
  -- Only organizations INSERTed after this configuration was saved inherit it.
  select * into v_default from public.platform_ui_theme_defaults where id=1 for share;
  if not found then return new;end if;
  -- Copy only the chosen visual configuration, not branding or dormant options of other themes.
  insert into public.organization_ui_themes(organization_id,theme_id,installation_id,revision,configurations)
    values(new.id,v_default.theme_id,v_default.installation_id,1,
      jsonb_build_object(v_default.theme_id,v_default.configurations->v_default.theme_id))
    on conflict(organization_id) do nothing returning revision into v_revision;
  if found then
    insert into public.api_audit_log(organization_id,actor_user_id,acting_as_platform_admin,action,resource_type,resource_id,request_id,bypassed_rls,metadata)
      values(new.id,null,false,'ui_theme.updated','organization_ui_theme',new.id,gen_random_uuid()::text,true,
        jsonb_build_object('theme_id',v_default.theme_id,'installation_id',v_default.installation_id,
          'revision',v_revision,'options_version',v_default.configurations->v_default.theme_id->'version',
          'source','installation_initial_default','initial_default_revision',v_default.revision));
  end if;
  return new;
end;
$$;
-- This is a trigger-only entry point, not an RPC, including for service_role.
revoke all on function public.fn_ui_theme_seed_new_organization() from public,anon,authenticated,service_role;
drop trigger if exists trg_ui_theme_seed_new_organization on public.organizations;
create trigger trg_ui_theme_seed_new_organization after insert on public.organizations
  for each row execute function public.fn_ui_theme_seed_new_organization();
notify pgrst,'reload schema';
