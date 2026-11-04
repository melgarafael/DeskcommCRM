-- manifest: Valida sessão ativa e recupera avisos por recibo autorizado, sem incluir payloads no CDC.
create schema if not exists crm_session_private;
revoke all on schema crm_session_private from public, anon, authenticated, service_role;

create or replace function crm_session_private.require_active_session()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $session$
declare
  claims jsonb;
  request_role text := current_setting('role', true);
  session_uuid uuid;
  user_uuid uuid;
  expires numeric;
begin
  begin
    claims := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
    -- Exemptions depend on the database role selected by PostgREST, not on a role string alone.
    if request_role = 'anon' and coalesce(claims ->> 'role', 'anon') = 'anon' then return; end if;
    if request_role = 'service_role' and claims ->> 'role' = 'service_role' then return; end if;
    if request_role is distinct from 'authenticated' or claims ->> 'role' is distinct from 'authenticated'
       or claims ->> 'session_id' is null or claims ->> 'sub' is null
       or jsonb_typeof(claims -> 'exp') is distinct from 'number' then
      raise sqlstate 'PT401' using message = 'active session required';
    end if;
    session_uuid := (claims ->> 'session_id')::uuid;
    user_uuid := (claims ->> 'sub')::uuid;
    expires := (claims ->> 'exp')::numeric;
    if expires <= extract(epoch from statement_timestamp()) then
      raise sqlstate 'PT401' using message = 'active session required';
    end if;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise sqlstate 'PT401' using message = 'active session required';
  end;
  if not exists (
    select 1 from auth.sessions s
    where s.id = session_uuid and s.user_id = user_uuid
      and (s.not_after is null or s.not_after > statement_timestamp())
  ) then
    raise sqlstate 'PT401' using message = 'session revoked';
  end if;
end;
$session$;
revoke all on function crm_session_private.require_active_session() from public, anon, authenticated, service_role;
grant usage on schema crm_session_private to anon, authenticated, service_role;
grant execute on function crm_session_private.require_active_session() to anon, authenticated, service_role;

create or replace function public.fn_pgrst_validar_sessao_e_replay()
returns void language plpgsql stable security invoker set search_path = ''
as $request$
begin
  perform public.fn_pgrst_recusar_replay_do_gateway();
  perform crm_session_private.require_active_session();
end;
$request$;
revoke all on function public.fn_pgrst_validar_sessao_e_replay() from public, anon, authenticated, service_role;
grant execute on function public.fn_pgrst_validar_sessao_e_replay() to anon, authenticated, service_role;
comment on function public.fn_pgrst_validar_sessao_e_replay() is
  'PostgREST pre-request: replay 409 preserved; authenticated requires active native auth.sessions row (session_id/sub/exp); anon/service_role unchanged.';

do $install$
declare
  configured_hook text;
begin
  if to_regrole('authenticator') is not null then
    select split_part(c.setting, '=', 2) into configured_hook
    from pg_db_role_setting d
    cross join lateral unnest(d.setconfig) as c(setting)
    where d.setrole = to_regrole('authenticator')::oid
      and d.setdatabase in (0, (select oid from pg_database where datname = current_database()))
      and c.setting like 'pgrst.db_pre_request=%'
    order by d.setdatabase desc limit 1;
    if coalesce(configured_hook, '') not in ('', 'public.fn_pgrst_recusar_replay_do_gateway', 'public.fn_pgrst_validar_sessao_e_replay') then
      raise exception 'Unknown PostgREST pre-request hook: explicit composition required' using errcode = '22023';
    end if;
    execute format('alter role authenticator in database %I set pgrst.db_pre_request = %L',
      current_database(), 'public.fn_pgrst_validar_sessao_e_replay');
  end if;
end;
$install$;
notify pgrst, 'reload config';
notify pgrst, 'reload schema';

create or replace function crm_session_private.session_allows_realtime_read()
returns boolean language plpgsql stable security definer set search_path='' as $$
begin
 perform crm_session_private.require_active_session();
 return true;
exception when sqlstate 'PT401' then return false;
end $$;
revoke all on function crm_session_private.session_allows_realtime_read() from public,anon,authenticated,service_role;
grant execute on function crm_session_private.session_allows_realtime_read() to authenticated;

do $policy$
declare t text; existing record; expected text := '( SELECT crm_session_private.session_allows_realtime_read() AS session_allows_realtime_read)';
begin
 foreach t in array ARRAY['conversations','ai_agent_runs','ai_agents','ai_knowledge_sources','calendar_appointments','conversation_notes','conversation_participants','crm_lead_activities','crm_lead_reactivations','crm_lead_risk_states','crm_leads','messages','realtime_invalidations','user_organizations','voice_calls'] loop
  if to_regclass(format('public.%I',t)) is null then raise exception 'required CDC table missing: %',t;end if;
  select polpermissive,polcmd,polroles,pg_get_expr(polqual,polrelid)as expression into existing
   from pg_policy where polrelid=to_regclass(format('public.%I',t)) and polname='crm_cdc_active_session';
  if found then
   if existing.polpermissive or existing.polcmd<>'r' or existing.polroles<>ARRAY['authenticated'::regrole::oid]
     or regexp_replace(lower(existing.expression),'\s','','g')<>regexp_replace(lower(expected),'\s','','g') then
    raise exception 'unexpected existing CDC session policy: %',t;
   end if;
  else
   execute format('create policy crm_cdc_active_session on public.%I as restrictive for select to authenticated using((select crm_session_private.session_allows_realtime_read()))',t);
  end if;
 end loop;
end $policy$;

create or replace function public.fn_notice_signal_from_change()returns trigger
language plpgsql security definer set search_path='' as $$
declare r jsonb; old_r jsonb; org uuid; kinds text[]; kind text;
begin
 r:=case when tg_op='DELETE' then to_jsonb(old)else to_jsonb(new)end;
 old_r:=case when tg_op='UPDATE' then to_jsonb(old)else null end;
 org:=case when tg_table_name='organizations' then (r->>'id')::uuid else (r->>'organization_id')::uuid end;
 if org is null or not exists(select 1 from public.organizations where id=org)then return null;end if;
 case tg_table_name
 when 'conversations' then
  kinds:=array[]::text[];
  if tg_op<>'UPDATE' or old_r->'status'is distinct from r->'status' or old_r->'last_inbound_at'is distinct from r->'last_inbound_at' then kinds:=array_append(kinds,'platform_alerts');end if;
  if tg_op='UPDATE' and old_r->'last_handoff_at'is distinct from r->'last_handoff_at' and r->>'last_handoff_at'is not null then kinds:=array_append(kinds,'handoff_pending');end if;
 when 'organizations' then kinds:=array['platform_alerts','tenant_health','tenant_agents'];
 when 'channel_sessions' then kinds:=array['platform_alerts','tenant_health'];
 when 'lgpd_requests' then kinds:=array['platform_alerts'];
 when 'ai_budgets' then kinds:=array['platform_alerts','tenant_health'];
 when 'ai_agents' then kinds:=array['tenant_agents','tenant_health'];
 when 'agent_inbox_items' then kinds:=array['agent_inbox'];
 else return null;
 end case;
 for kind in select unnest(kinds) order by 1 loop
  insert into public.realtime_invalidations(organization_id,table_name,change_token)
   values(org,kind,gen_random_uuid())on conflict(organization_id,table_name)
   do update set change_token=excluded.change_token;
 end loop;
 return null;
exception when others then
 -- Advisory invalidation is recoverable by the existing authorized REST polling.
 -- Roll back this trigger's signal writes, not the source business mutation.
 -- Never include SQLERRM, row content or tenant identifiers in the diagnostic.
 raise warning 'crm_notice_signal_failed sqlstate=%; polling_required',sqlstate;
 return null;
end$$;
revoke all on function public.fn_notice_signal_from_change()from public,anon,authenticated,service_role;
do $$declare t text; f oid:=to_regprocedure('public.fn_notice_signal_from_change()');existing oid;
begin
 if to_regprocedure('crm_session_private.session_allows_realtime_read()')is null then raise exception 'active session CDC gate required';end if;
 foreach t in array array['organizations','conversations','channel_sessions','lgpd_requests','ai_budgets','ai_agents','agent_inbox_items']loop
  if to_regclass(format('public.%I',t))is null then raise exception 'required notice source missing: %',t;end if;
  select tgfoid into existing from pg_trigger where tgrelid=to_regclass(format('public.%I',t))and tgname='crm_notice_signal';
  if found then if existing<>f then raise exception 'unexpected existing notice trigger: %',t;end if;
  else execute format('create trigger crm_notice_signal after insert or update or delete on public.%I for each row execute function public.fn_notice_signal_from_change()',t);end if;
 end loop;
end$$;
do $$declare p record;expected text:= $expr$((table_name <> ALL (ARRAY['platform_alerts'::text, 'tenant_health'::text, 'tenant_agents'::text])) OR ( SELECT public.fn_is_platform_admin() AS fn_is_platform_admin))$expr$;
begin
 select polpermissive,polcmd,polroles,pg_get_expr(polqual,polrelid) as expression into p from pg_policy
 where polrelid='public.realtime_invalidations'::regclass and polname='crm_notice_admin_scope';
 if found then
  if p.polpermissive or p.polcmd<>'r' or p.polroles<>array['authenticated'::regrole::oid]
   or replace(regexp_replace(lower(p.expression),'\s','','g'),'public.fn_is_platform_admin','fn_is_platform_admin')<>replace(regexp_replace(lower(expected),'\s','','g'),'public.fn_is_platform_admin','fn_is_platform_admin')then raise exception 'unexpected notice scope policy';end if;
 else
  create policy crm_notice_admin_scope on public.realtime_invalidations as restrictive for select to authenticated
   using(table_name not in('platform_alerts','tenant_health','tenant_agents')or(select public.fn_is_platform_admin()));
 end if;
end$$;

create schema if not exists crm_notice_recovery;
revoke all on schema crm_notice_recovery from public,anon,authenticated,service_role;
grant usage on schema crm_notice_recovery to authenticated;
create or replace function crm_notice_recovery.revision(i public.agent_inbox_items)
returns text language sql immutable security invoker set search_path='' as $$
 select encode(sha256(convert_to(jsonb_build_array(i.id,i.kind,i.severity,i.title,i.body,i.ref_kind,i.ref_id,i.para_user_id)::text,'UTF8')),'hex');
$$;
revoke all on function crm_notice_recovery.revision(public.agent_inbox_items)from public,anon,authenticated,service_role;
grant execute on function crm_notice_recovery.revision(public.agent_inbox_items)to authenticated;
create or replace function crm_notice_recovery.writer_allowed(p_org uuid)returns boolean language plpgsql stable security definer set search_path='' as $$
declare support jsonb;
begin
 perform crm_session_private.require_active_session();
 if not coalesce(public.fn_role_at_least(p_org,'agent'),false)then raise sqlstate 'PT403'using message='notice access denied';end if;
 if not public.fn_session_mfa_proven()then raise sqlstate 'PT403'using message='mfa_required';end if;
 support:=public.fn_support_context();
 if support is not null and not coalesce(support->>'status'='active'and support->>'access_mode'='full',false)then raise sqlstate 'PT403'using message='support write denied';end if;
 return true;
end$$;
revoke all on function crm_notice_recovery.writer_allowed(uuid)from public,anon,authenticated,service_role;
grant execute on function crm_notice_recovery.writer_allowed(uuid)to authenticated;
create table if not exists crm_notice_recovery.receipts(
 organization_id uuid not null references public.organizations(id)on delete cascade,
 user_id uuid not null references auth.users(id)on delete cascade,
 item_id uuid not null references public.agent_inbox_items(id)on delete cascade,
 revision text not null check(revision ~ '^[0-9a-f]{64}$'),
 acknowledged_at timestamptz not null default now(),
 primary key(organization_id,user_id,item_id,revision)
);
revoke all on table crm_notice_recovery.receipts from public,anon,authenticated,service_role;
grant select,insert on table crm_notice_recovery.receipts to authenticated;
alter table crm_notice_recovery.receipts enable row level security;
drop policy if exists tenant_isolation_receipts_select on crm_notice_recovery.receipts;
create policy tenant_isolation_receipts_select on crm_notice_recovery.receipts for select to authenticated using(
 user_id=(select auth.uid())and organization_id in(select public.fn_user_org_ids())
 and(select crm_session_private.session_allows_realtime_read())
 and exists(select 1 from public.agent_inbox_items i where i.id=item_id and i.organization_id=receipts.organization_id and(i.para_user_id is null or i.para_user_id=(select auth.uid())))
);
drop policy if exists tenant_isolation_receipts_insert on crm_notice_recovery.receipts;
create policy tenant_isolation_receipts_insert on crm_notice_recovery.receipts for insert to authenticated with check(
 crm_notice_recovery.writer_allowed(organization_id)and
 user_id=(select auth.uid())and organization_id in(select public.fn_user_org_ids())
 and(select crm_session_private.session_allows_realtime_read())
 and exists(select 1 from public.agent_inbox_items i where i.id=item_id and i.organization_id=receipts.organization_id and(i.para_user_id is null or i.para_user_id=(select auth.uid()))and crm_notice_recovery.revision(i)=receipts.revision)
);
create or replace function public.fn_notice_episode_page(p_organization_id uuid,p_limit int default 20)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
 perform crm_session_private.require_active_session();
 if not coalesce(public.fn_role_at_least(p_organization_id,'agent'),false)then raise sqlstate 'PT403' using message='notice access denied';end if;
 if p_limit is null or p_limit<1 or p_limit>100 then raise sqlstate '22023' using message='invalid page limit';end if;
 with eligible as materialized(
  select i.id,i.organization_id,i.kind,i.severity,i.title,i.body,i.ref_kind,i.ref_id,i.status,i.created_at,crm_notice_recovery.revision(i)revision
  from public.agent_inbox_items i
  where i.organization_id=p_organization_id and(i.para_user_id is null or i.para_user_id=(select auth.uid()))
   and not exists(select 1 from crm_notice_recovery.receipts r where r.organization_id=p_organization_id and r.user_id=(select auth.uid())and r.item_id=i.id and r.revision=crm_notice_recovery.revision(i))
  order by i.created_at,i.id limit p_limit+1
 ), page as(select *from eligible order by created_at,id limit p_limit)
 select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(p)order by p.created_at,p.id)from page p),'[]'::jsonb),'has_more',(select count(*)>p_limit from eligible),'coverage','retained_agent_inbox_items','history_complete',false)into result;
 return result;
end$$;
revoke all on function public.fn_notice_episode_page(uuid,int)from public,anon,authenticated,service_role;
grant execute on function public.fn_notice_episode_page(uuid,int)to authenticated;
create or replace function public.fn_notice_episode_ack(p_organization_id uuid,p_items jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare entry jsonb;row_id uuid;expected text;count_new int:=0;affected int;
begin
 perform crm_notice_recovery.writer_allowed(p_organization_id);
 if p_items is null or jsonb_typeof(p_items)<>'array'then raise sqlstate '22023' using message='invalid receipt batch';end if;
 if jsonb_array_length(p_items)<1 or jsonb_array_length(p_items)>100 then raise sqlstate '22023' using message='invalid receipt batch';end if;
 for entry in select value from jsonb_array_elements(p_items)loop
  if jsonb_typeof(entry)<>'object'or jsonb_typeof(entry->'id')is distinct from 'string'or jsonb_typeof(entry->'revision')is distinct from 'string'
    or(entry->>'id')!~'^[0-9a-fA-F-]{36}$'or(entry->>'revision')!~'^[0-9a-f]{64}$'
    or(select count(*)from jsonb_object_keys(entry))<>2 then raise sqlstate '22023' using message='invalid receipt';end if;
  row_id:=(entry->>'id')::uuid;
  select crm_notice_recovery.revision(i)into expected from public.agent_inbox_items i where i.organization_id=p_organization_id and i.id=row_id and(i.para_user_id is null or i.para_user_id=(select auth.uid()));
  if expected is null or expected<>entry->>'revision'then raise sqlstate 'PT409' using message='notice changed or no longer visible';end if;
  insert into crm_notice_recovery.receipts(organization_id,user_id,item_id,revision)values(p_organization_id,auth.uid(),row_id,expected)on conflict do nothing;
  get diagnostics affected=row_count;count_new:=count_new+affected;
 end loop;
 return jsonb_build_object('acknowledged',count_new);
end$$;
revoke all on function public.fn_notice_episode_ack(uuid,jsonb)from public,anon,authenticated,service_role;
grant execute on function public.fn_notice_episode_ack(uuid,jsonb)to authenticated;
notify pgrst,'reload schema';

create schema if not exists crm_notice_derived;
revoke all on schema crm_notice_derived from public,anon,authenticated,service_role;
grant usage on schema crm_notice_derived to authenticated;
create table if not exists crm_notice_derived.config(singleton boolean primary key default true check(singleton),activated_at timestamptz not null default clock_timestamp(),bootstrapped boolean not null default false);
insert into crm_notice_derived.config(singleton)values(true)on conflict do nothing;
create table if not exists crm_notice_derived.episodes(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id)on delete cascade,
 kind text not null check(kind in('channel_unavailable','lgpd_at_risk','ai_budget','tenant_pending_overflow')),
 source_key text not null,snapshot jsonb not null,created_at timestamptz not null default clock_timestamp());
create index if not exists derived_episode_order on crm_notice_derived.episodes(created_at,id);
create table if not exists crm_notice_derived.state(
 organization_id uuid not null references public.organizations(id)on delete cascade,kind text not null,source_key text not null,
 active boolean not null,fingerprint text,observed_at timestamptz not null default clock_timestamp(),primary key(organization_id,kind,source_key));
create table if not exists crm_notice_derived.receipts(
 organization_id uuid not null references public.organizations(id)on delete cascade,user_id uuid not null references auth.users(id)on delete cascade,
 episode_id uuid not null references crm_notice_derived.episodes(id)on delete cascade,acknowledged_at timestamptz not null default now(),primary key(user_id,episode_id));
alter table crm_notice_derived.state add column if not exists observed_at timestamptz not null default clock_timestamp();
revoke all on all tables in schema crm_notice_derived from public,anon,authenticated,service_role;
create or replace function crm_notice_derived.require_reader()returns void language plpgsql stable security definer set search_path='' as $$
declare pa record;claims jsonb:=coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb);
begin
 perform crm_session_private.require_active_session();
 select mfa_required into pa from public.platform_admins where user_id=auth.uid()and revoked_at is null;
 if not found then raise sqlstate 'PT403'using message='platform admin required';end if;
 if(pa.mfa_required or exists(select 1 from auth.mfa_factors where user_id=auth.uid()and factor_type='totp'and status='verified'))and claims->>'aal'is distinct from 'aal2'then raise sqlstate 'PT403'using message='mfa_required';end if;
end$$;
revoke all on function crm_notice_derived.require_reader()from public,anon,authenticated,service_role;
grant execute on function crm_notice_derived.require_reader()to authenticated;
create or replace function crm_notice_derived.reader_allowed()returns boolean language plpgsql stable security invoker set search_path='' as $$begin perform crm_notice_derived.require_reader();return true;end$$;
revoke all on function crm_notice_derived.reader_allowed()from public,anon,authenticated,service_role;
grant execute on function crm_notice_derived.reader_allowed()to authenticated;
create or replace function crm_notice_derived.writer_allowed()returns boolean language plpgsql stable security definer set search_path='' as $$
begin
 perform crm_notice_derived.require_reader();
 if not public.fn_is_platform_admin_full()then raise sqlstate 'PT403'using message='full scope required for receipt';end if;
 return true;
end$$;
revoke all on function crm_notice_derived.writer_allowed()from public,anon,authenticated,service_role;
grant execute on function crm_notice_derived.writer_allowed()to authenticated;
alter table crm_notice_derived.episodes enable row level security;
alter table crm_notice_derived.state enable row level security;
alter table crm_notice_derived.receipts enable row level security;
grant select on crm_notice_derived.episodes to authenticated;
grant select,insert on crm_notice_derived.receipts to authenticated;
drop policy if exists tenant_isolation_derived_read on crm_notice_derived.episodes;
create policy tenant_isolation_derived_read on crm_notice_derived.episodes for select to authenticated using((select crm_notice_derived.reader_allowed()));
drop policy if exists tenant_isolation_derived_receipts_read on crm_notice_derived.receipts;
create policy tenant_isolation_derived_receipts_read on crm_notice_derived.receipts for select to authenticated using(user_id=(select auth.uid())and(select crm_notice_derived.reader_allowed()));
drop policy if exists tenant_isolation_derived_receipts_insert on crm_notice_derived.receipts;
create policy tenant_isolation_derived_receipts_insert on crm_notice_derived.receipts for insert to authenticated with check(user_id=(select auth.uid())and(select crm_notice_derived.writer_allowed())and exists(select 1 from crm_notice_derived.episodes e where e.id=episode_id and e.organization_id=receipts.organization_id));
create or replace function crm_notice_derived.record(p_org uuid,p_kind text,p_key text,p_active boolean,p_data jsonb,p_seed boolean default false)returns boolean
language plpgsql security definer set search_path='' as $$
declare previous record;fresh boolean:=false;fp text:=encode(sha256(convert_to(p_data::text,'UTF8')),'hex');
begin
 if p_org is null or not exists(select 1 from public.organizations where id=p_org)then return true;end if;
 if not pg_try_advisory_xact_lock(hashtextextended('crm-derived:'||p_org||':'||p_kind||':'||p_key,0))then raise sqlstate '55P03'using message='capture contended';end if;
 select active,fingerprint into previous from crm_notice_derived.state where organization_id=p_org and kind=p_kind and source_key=p_key for update nowait;
 if p_active and not p_seed and(not found or not previous.active or previous.fingerprint is distinct from fp)then
  insert into crm_notice_derived.episodes(organization_id,kind,source_key,snapshot)values(p_org,p_kind,p_key,p_data);fresh:=true;
 end if;
 insert into crm_notice_derived.state(organization_id,kind,source_key,active,fingerprint)values(p_org,p_kind,p_key,p_active,fp)
 on conflict(organization_id,kind,source_key)do update set active=excluded.active,fingerprint=excluded.fingerprint,observed_at=clock_timestamp();
 if fresh then
  begin
   insert into public.realtime_invalidations(organization_id,table_name,change_token)values(p_org,'platform_alerts',gen_random_uuid())on conflict(organization_id,table_name)do update set change_token=excluded.change_token;
  exception when others then raise warning 'crm_notice_signal_failed sqlstate=%; polling_required',sqlstate;
  end;
 end if;
 return true;
exception when others then
 -- Subtransaction rolls back BOTH journal and dedupe state. Never log SQLERRM, IDs, body or row data.
 raise warning 'crm_notice_capture_failed kind=% sqlstate=%; business_continues',p_kind,sqlstate;return false;
end$$;
revoke all on function crm_notice_derived.record(uuid,text,text,boolean,jsonb,boolean)from public,anon,authenticated,service_role;
create or replace function crm_notice_derived.observe(p_table text,p_row jsonb,p_at timestamptz,p_seed boolean default false)returns boolean
language plpgsql security definer set search_path='' as $$
declare org uuid:=(p_row->>'organization_id')::uuid;key text;kind text;active boolean;data jsonb;mode text;ratio double precision;
begin
 case p_table
 when 'channel_sessions'then
  kind:='channel_unavailable';key:=p_row->>'id';active:=(p_row->>'status')in('ban_suspected','disconnected_unexpected')or((p_row->>'status')='disconnected'and(p_row->>'updated_at')::timestamptz>p_at-interval '24 hours');
  data:=jsonb_build_object('status',p_row->>'status','status_reason',p_row->>'status_reason');
 when 'lgpd_requests'then
  kind:='lgpd_at_risk';key:=p_row->>'id';
  -- Mirrors corteDaJanela(agora,5): (dias-1)*24h, NOT five additional days.
  active:=(p_row->>'status')not in('completed','failed')and(p_row->>'due_at')::timestamptz<=p_at+interval '96 hours';
  data:=jsonb_build_object('due_at',p_row->>'due_at','overdue',(p_at at time zone 'UTC')::date>((p_row->>'due_at')::timestamptz at time zone 'UTC')::date);
 when 'ai_budgets'then
  kind:='ai_budget';key:=org::text;mode:=case when p_row->>'enforcement_mode'in('avisar','bloquear')then p_row->>'enforcement_mode'else 'off'end;
  ratio:=case when(p_row->>'monthly_limit_cents')::double precision>0 then(p_row->>'current_month_consumed_cents')::double precision/(p_row->>'monthly_limit_cents')::double precision else 0 end;
  active:=mode<>'off'and ratio>=0.8;data:=jsonb_build_object('mode',mode,'percent',floor(ratio*100+0.5));
 else raise sqlstate '22023'using message='unknown source';end case;
 return crm_notice_derived.record(org,kind,key,coalesce(active,false),data,p_seed);
exception when others then raise warning 'crm_notice_capture_failed source=% sqlstate=%; business_continues',p_table,sqlstate;return false;
end$$;
revoke all on function crm_notice_derived.observe(text,jsonb,timestamptz,boolean)from public,anon,authenticated,service_role;
create or replace function crm_notice_derived.capture_row()returns trigger language plpgsql security definer set search_path='' as $$
begin
 -- Observe OLD at closure too: a temporal window can start without an UPDATE.
 if tg_op<>'INSERT'then perform crm_notice_derived.observe(tg_table_name,to_jsonb(old),clock_timestamp());end if;
 if tg_op<>'DELETE'then perform crm_notice_derived.observe(tg_table_name,to_jsonb(new),clock_timestamp());
 else perform crm_notice_derived.record(old.organization_id,case tg_table_name when 'channel_sessions'then 'channel_unavailable'when 'lgpd_requests'then 'lgpd_at_risk'else 'ai_budget'end,case when tg_table_name='ai_budgets'then old.organization_id::text else(to_jsonb(old)->>'id')end,false,'{}');end if;
 return null;
exception when others then raise warning 'crm_notice_capture_failed source=% sqlstate=%; business_continues',tg_table_name,sqlstate;return null;
end$$;
revoke all on function crm_notice_derived.capture_row()from public,anon,authenticated,service_role;
create or replace function crm_notice_derived.observe_overflow(p_org uuid,p_seed boolean default false)returns boolean language plpgsql security definer set search_path='' as $$
declare n bigint;
begin
 if not pg_try_advisory_xact_lock(hashtextextended('crm-derived-overflow:'||p_org,0))then raise sqlstate '55P03'using message='capture contended';end if;
 select count(*)into n from public.conversations where organization_id=p_org and status='pending';
 return crm_notice_derived.record(p_org,'tenant_pending_overflow',p_org::text,n>50,jsonb_build_object('count',n),p_seed);
exception when others then raise warning 'crm_notice_capture_failed kind=tenant_pending_overflow sqlstate=%; business_continues',sqlstate;return false;
end$$;
revoke all on function crm_notice_derived.observe_overflow(uuid,boolean)from public,anon,authenticated,service_role;
create or replace function crm_notice_derived.capture_conversations()returns trigger language plpgsql security definer set search_path='' as $$
declare org uuid;
begin
 if tg_op='INSERT'then for org in select distinct organization_id from new_notice_rows loop perform crm_notice_derived.observe_overflow(org);end loop;
 elsif tg_op='DELETE'then for org in select distinct organization_id from old_notice_rows loop perform crm_notice_derived.observe_overflow(org);end loop;
 else for org in select organization_id from new_notice_rows union select organization_id from old_notice_rows loop perform crm_notice_derived.observe_overflow(org);end loop;end if;
 return null;
exception when others then raise warning 'crm_notice_capture_failed kind=tenant_pending_overflow sqlstate=%; business_continues',sqlstate;return null;
end$$;
revoke all on function crm_notice_derived.capture_conversations()from public,anon,authenticated,service_role;
do $$declare t text;begin
 foreach t in array array['channel_sessions','lgpd_requests','ai_budgets']loop
  execute format('drop trigger if exists crm_capture_derived on public.%I',t);
  execute format('create trigger crm_capture_derived after insert or update or delete on public.%I for each row execute function crm_notice_derived.capture_row()',t);
 end loop;
 drop trigger if exists crm_capture_overflow_insert on public.conversations;
 create trigger crm_capture_overflow_insert after insert on public.conversations referencing new table as new_notice_rows for each statement execute function crm_notice_derived.capture_conversations();
 drop trigger if exists crm_capture_overflow_update on public.conversations;
 create trigger crm_capture_overflow_update after update on public.conversations referencing old table as old_notice_rows new table as new_notice_rows for each statement execute function crm_notice_derived.capture_conversations();
 drop trigger if exists crm_capture_overflow_delete on public.conversations;
 create trigger crm_capture_overflow_delete after delete on public.conversations referencing old table as old_notice_rows for each statement execute function crm_notice_derived.capture_conversations();
end$$;
create or replace function crm_notice_derived.observe_clock(p_at timestamptz,p_seed boolean default false)returns jsonb language plpgsql security definer set search_path='' as $$
declare r record;good int:=0;bad int:=0;
begin
 -- Bounded rotating scan. Closing/updating a request also observes OLD directly.
 for r in select to_jsonb(q)row from public.lgpd_requests q left join crm_notice_derived.state s on s.organization_id=q.organization_id and s.kind='lgpd_at_risk'and s.source_key=q.id::text
  where q.status not in('completed','failed')order by s.observed_at nulls first,q.due_at,q.id limit 500 loop
  if crm_notice_derived.observe('lgpd_requests',r.row,p_at,p_seed)then good:=good+1;else bad:=bad+1;end if;
 end loop;
 return jsonb_build_object('observed',good,'failed',bad,'bounded_scan',true);
end$$;
revoke all on function crm_notice_derived.observe_clock(timestamptz,boolean)from public,anon,authenticated,service_role;
create or replace function public.fn_notice_observe_clock()returns jsonb language sql volatile security definer set search_path='' as $$select crm_notice_derived.observe_clock(clock_timestamp());$$;
revoke all on function public.fn_notice_observe_clock()from public,anon,authenticated,service_role;
grant execute on function public.fn_notice_observe_clock()to service_role;
do $$declare r record;t text;begin
 if not(select bootstrapped from crm_notice_derived.config where singleton)then
  foreach t in array array['channel_sessions','lgpd_requests','ai_budgets']loop
   for r in execute format('select to_jsonb(q)row from public.%I q',t)loop
    if not crm_notice_derived.observe(t,r.row,clock_timestamp(),true)then raise exception 'derived_notice_bootstrap_failed';end if;
   end loop;
  end loop;
  for r in select distinct organization_id from public.conversations loop if not crm_notice_derived.observe_overflow(r.organization_id,true)then raise exception 'derived_notice_bootstrap_failed';end if;end loop;
  update crm_notice_derived.config set bootstrapped=true where singleton;
 end if;
end$$;
create or replace function public.fn_derived_notice_page(p_limit int default 20)returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
 perform crm_notice_derived.require_reader();
 if p_limit is null or p_limit<1 or p_limit>100 then raise sqlstate '22023'using message='invalid limit';end if;
 with pending as materialized(select e.* from crm_notice_derived.episodes e where not exists(select 1 from crm_notice_derived.receipts r where r.user_id=auth.uid()and r.episode_id=e.id)order by e.created_at,e.id limit p_limit+1),page as(select *from pending order by created_at,id limit p_limit)
 select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(p)||jsonb_build_object('revision',encode(sha256(convert_to(p.id::text,'UTF8')),'hex'))order by created_at,id)from page p),'[]'::jsonb),'has_more',(select count(*)>p_limit from pending),'coverage','persisted_derived_episodes','history_complete',false)into result;
 return result;
end$$;
revoke all on function public.fn_derived_notice_page(int)from public,anon,authenticated,service_role;
grant execute on function public.fn_derived_notice_page(int)to authenticated;
create or replace function public.fn_derived_notice_ack(p_items jsonb)returns jsonb language plpgsql security invoker set search_path='' as $$
declare x jsonb;e record;n int:=0;added int;
begin
 perform crm_notice_derived.writer_allowed();
 if p_items is null or jsonb_typeof(p_items)<>'array'then raise sqlstate '22023'using message='invalid receipt';end if;
 if jsonb_array_length(p_items)<1 or jsonb_array_length(p_items)>100 then raise sqlstate '22023'using message='invalid receipt';end if;
 for x in select value from jsonb_array_elements(p_items)loop
  if jsonb_typeof(x)<>'object'or(select count(*)from jsonb_object_keys(x))<>2 or jsonb_typeof(x->'id')is distinct from 'string'or jsonb_typeof(x->'revision')is distinct from 'string'then raise sqlstate '22023'using message='invalid receipt';end if;
  select id,organization_id into e from crm_notice_derived.episodes where id=(x->>'id')::uuid and encode(sha256(convert_to(id::text,'UTF8')),'hex')=x->>'revision';
  if not found then raise sqlstate 'PT409'using message='notice no longer visible';end if;
  insert into crm_notice_derived.receipts(organization_id,user_id,episode_id)values(e.organization_id,auth.uid(),e.id)on conflict do nothing;
  get diagnostics added=row_count;n:=n+added;
 end loop;
 return jsonb_build_object('acknowledged',n);
end$$;
revoke all on function public.fn_derived_notice_ack(jsonb)from public,anon,authenticated,service_role;
grant execute on function public.fn_derived_notice_ack(jsonb)to authenticated;
notify pgrst,'reload schema';
