-- 0226 — conferência e entrega são recibos distintos; mesma identidade Google/fila.
alter table public.calendar_connection_calendars add column if not exists allowed_conference_types text[];
alter table public.calendar_appointments
 add column if not exists meeting_state text not null default 'not_requested' check(meeting_state in ('not_requested','pending','ready','failed','cancelled')),
 add column if not exists meeting_request_id uuid,
 add column if not exists meeting_requested_at timestamptz,
 add column if not exists meeting_received_at timestamptz,
 add column if not exists meeting_ready_at timestamptz,
 add column if not exists meeting_attempts integer not null default 0,
 add column if not exists meeting_last_error text,
 add column if not exists meeting_next_attempt_at timestamptz,
 add column if not exists meeting_delivery jsonb not null default '{"state":"none"}',
 add column if not exists meeting_delivery_job_id uuid references public.job_queue(id) on delete set null;
create index if not exists calendar_meet_pending_idx on public.calendar_appointments(meeting_next_attempt_at)
 where meeting_state='pending';
alter table public.job_queue drop constraint if exists job_queue_kind_check;
alter table public.job_queue add constraint job_queue_kind_check check(kind in ('inbound_turn','followup_turn','watchdog','flywheel','case_reply_turn','operator_turn','transactional_delivery'));
alter table public.job_queue drop constraint if exists job_queue_turn_needs_contact;
alter table public.job_queue add constraint job_queue_turn_needs_contact check((kind in ('inbound_turn','followup_turn','case_reply_turn','operator_turn','transactional_delivery'))=(contact_id is not null));

create or replace function public.fn_meet_boundary_current(b jsonb)
returns boolean language sql stable security definer set search_path=public as $$
 select coalesce(exists(select 1 from public.conversations c left join public.demandas d on d.id=c.current_demanda_id and d.organization_id=c.organization_id and d.contact_id=c.contact_id
  where c.organization_id::text=b->>'organization_id' and c.contact_id::text=b->>'contact_id' and c.id::text=b->>'conversation_id'
   and c.service_revision::text=b->>'service_revision' and c.current_demanda_id::text is not distinct from b->>'demanda_id'
   and d.revision::text is not distinct from b->>'demanda_revision' and d.fechada_em is null and not c.is_group
   and c.status not in ('closed','resolved','archived')),false);
$$;
revoke all on function public.fn_meet_boundary_current(jsonb) from public,anon,authenticated;
grant execute on function public.fn_meet_boundary_current(jsonb) to service_role;

-- INVOKER: distingue escrita direta authenticated de chamadas pelas RPCs definer
-- que reconferem ator/claim. Não usa flag/GUC fornecida pelo cliente como bypass.
create or replace function public.fn_meet_stamp()
returns trigger language plpgsql set search_path=public as $$
declare redacted boolean; j public.job_queue; b jsonb;
begin
 if current_user in ('authenticated','anon') then
  if tg_op='INSERT' then
   if new.meeting_delivery<>'{"state":"none"}'::jsonb or new.meeting_request_id is not null or new.meeting_url is not null or new.meeting_state<>'not_requested' or new.meeting_requested_at is not null or new.meeting_received_at is not null or new.meeting_ready_at is not null or new.meeting_attempts<>0 or new.meeting_last_error is not null or new.meeting_next_attempt_at is not null or new.meeting_delivery_job_id is not null then raise exception 'meet_metadata_private' using errcode='42501';end if;
  elsif row(new.meeting_state,new.meeting_request_id,new.meeting_requested_at,new.meeting_received_at,new.meeting_ready_at,new.meeting_attempts,new.meeting_last_error,new.meeting_next_attempt_at,new.meeting_delivery,new.meeting_delivery_job_id,new.meeting_url)
   is distinct from row(old.meeting_state,old.meeting_request_id,old.meeting_requested_at,old.meeting_received_at,old.meeting_ready_at,old.meeting_attempts,old.meeting_last_error,old.meeting_next_attempt_at,old.meeting_delivery,old.meeting_delivery_job_id,old.meeting_url) then
   raise exception 'meet_metadata_private' using errcode='42501';
  end if;
 end if;
 select is_anonymized into redacted from public.contacts where id=new.contact_id and organization_id=new.organization_id;
 if (redacted or new.status='cancelled' or new.location_kind<>'google_meet') and (new.location_kind='google_meet' or new.meeting_state<>'not_requested') then
  if new.location_kind='google_meet' or new.meeting_state<>'not_requested' or new.meeting_requested_at is not null or new.meeting_received_at is not null or new.meeting_ready_at is not null or new.meeting_attempts<>0 or new.meeting_last_error is not null or new.meeting_next_attempt_at is not null or new.meeting_delivery_job_id is not null then new.meeting_state:='cancelled';end if;
  new.meeting_request_id:=null;new.meeting_url:=null;new.meeting_last_error:=null;new.meeting_next_attempt_at:=null;
  new.meeting_delivery:=jsonb_build_object('state',case when redacted then 'blocked' else 'stale' end);
 elsif new.location_kind='google_meet' and new.meeting_state='not_requested' then
  new.meeting_state:='pending';new.meeting_request_id:=gen_random_uuid();new.meeting_next_attempt_at:=now();
 end if;
 if tg_op='INSERT' and new.meeting_delivery ? 'booking_claim' then
  perform public.fn_service_lock(new.organization_id,new.contact_id);
  select * into j from public.job_queue where organization_id=new.organization_id and id=(new.meeting_delivery->>'source_operation_id')::uuid for update;
  b:=new.meeting_delivery->'service_boundary';
  if j.contact_id is distinct from new.contact_id or j.status is distinct from 'running' or j.kind not in ('inbound_turn','followup_turn','case_reply_turn','operator_turn')
   or j.locked_by is distinct from new.meeting_delivery->'booking_claim'->>'worker_id' or j.locked_at is distinct from (new.meeting_delivery->'booking_claim'->>'acquired_at')::timestamptz
   or j.payload->'service_boundary' is distinct from b or not public.fn_meet_boundary_current(b) or b->>'conversation_id' is distinct from new.conversation_id::text then
   raise exception 'meet_booking_stale' using errcode='40001';end if;
  if new.meeting_delivery->'authorized_by'->>'kind' is distinct from 'ai_agent' then raise exception 'meet_booking_origin_invalid' using errcode='42501';end if;
  new.meeting_delivery:=new.meeting_delivery-'booking_claim';
 end if;
 if new.meeting_delivery ? 'generation' and (tg_op='INSERT' or new.meeting_delivery->>'generation' is distinct from old.meeting_delivery->>'generation') then
  new.meeting_delivery:=new.meeting_delivery||jsonb_build_object('channel_session_id',(select channel_session_id from public.conversations where organization_id=new.organization_id and contact_id=new.contact_id and id::text=new.meeting_delivery->'service_boundary'->>'conversation_id'));
 end if;
 if new.meeting_state='pending' and new.meeting_next_attempt_at is not null then new.google_next_attempt_at:=least(new.google_next_attempt_at,new.meeting_next_attempt_at);end if;
 return new;
end;$$;
revoke all on function public.fn_meet_stamp() from public,anon,authenticated;
drop trigger if exists trg_zz_meet_stamp on public.calendar_appointments;
create trigger trg_zz_meet_stamp before insert or update on public.calendar_appointments for each row execute function public.fn_meet_stamp();

create or replace function public.fn_meet_observe(p_org uuid,p_id uuid,p_args jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; r jsonb:=p_args->'result';
begin
 select * into a from public.calendar_appointments where organization_id=p_org and id=p_id for update;
 if not found or a.status='cancelled' or a.location_kind<>'google_meet' or a.meeting_request_id is distinct from (p_args->>'meeting_request_id')::uuid
  or a.google_claim_token is distinct from (p_args->'claim'->>'token')::uuid or a.google_claim_epoch::text is distinct from p_args->'claim'->>'epoch'
  or a.google_claim_until<=clock_timestamp() or a.google_claim_until is null or a.revision::text is distinct from p_args->>'revision' or a.google_local_revision::text is distinct from p_args->>'local_revision' then raise exception 'meet_stale' using errcode='40001';end if;
 if r->>'state' is null or r->>'state' not in ('pending','ready','failed') or (r->>'error' is not null and r->>'error' not in ('google_failure','unsupported','unknown','invalid')) then raise exception 'meet_invalid' using errcode='22023';end if;
 if r->>'state'='ready' and (r->>'url' is null or r->>'url' !~ '^https://meet[.]google[.]com/[a-zA-Z0-9-]+/?$') then raise exception 'meet_invalid_url' using errcode='22023';end if;
 update public.calendar_appointments set
  meeting_state=case when r->>'state'='pending' and meeting_attempts>=19 then 'failed' else r->>'state' end,
  meeting_url=case when r->>'state'='ready' then r->>'url' else null end,
  meeting_last_error=case when r->>'state'='pending' and meeting_attempts>=19 then 'unknown' else r->>'error' end,
  meeting_received_at=case when coalesce((r->>'received')::boolean,false) then coalesce(meeting_received_at,now()) else meeting_received_at end,
  meeting_ready_at=case when r->>'state'='ready' then coalesce(meeting_ready_at,now()) else null end,
  meeting_attempts=meeting_attempts+1,
  meeting_next_attempt_at=now()+make_interval(secs=>least(900,15*power(2,least(meeting_attempts,6)))::double precision+floor(random()*5)),
  google_etag=coalesce(r->>'etag',google_etag)
 where organization_id=p_org and id=p_id;
end;$$;
revoke all on function public.fn_meet_observe(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.fn_meet_observe(uuid,uuid,jsonb) from service_role;

create or replace function public.fn_google_appointment(p_org uuid,p_id uuid,p_action text,p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; c public.calendar_connection_calendars; conn public.calendar_connections;
 contact uuid; claim jsonb:=p_args->'claim'; result jsonb; b jsonb; changed boolean; remote jsonb;
begin
 select contact_id into contact from public.calendar_appointments where organization_id=p_org and id=p_id;
 if not found then raise exception 'appointment_not_found' using errcode='P0002';end if;
 if contact is not null then perform public.fn_service_lock(p_org,contact);end if;
 -- Seleção/reserva compartilham membership antes dos locks de calendário/appointment.
 perform 1 from public.user_organizations m join public.calendar_appointments x on x.organization_id=m.organization_id and x.owner_user_id=m.user_id
  where x.organization_id=p_org and x.id=p_id for update of m;
 if p_args?'calendar_fence' then
  perform public.fn_google_calendar_fence(p_org,(p_args->'calendar_fence'->>'id')::uuid,p_args->'calendar_fence'->'claim',p_args->'calendar_fence'->'cursor');
 end if;
 select * into a from public.calendar_appointments where organization_id=p_org and id=p_id for update;
 if a.contact_id is distinct from contact then raise exception 'appointment_stale' using errcode='40001';end if;
 if contact is not null and exists(select 1 from public.contacts where organization_id=p_org and id=contact and is_anonymized) then
  if p_action='claim' then return jsonb_build_object('terminal','redacted');end if;
  raise exception 'google_contact_redacted' using errcode='42501';end if;
 if not exists(select 1 from public.user_organizations where organization_id=p_org and user_id=a.owner_user_id and revoked_at is null) then
  raise exception 'google_owner_unavailable' using errcode='42501';end if;
 if p_action='claim' then
  if a.google_claim_until>clock_timestamp() then return null;end if;
  if a.google_event_id is null and a.status<>'cancelled' then
   select k.* into c from public.calendar_connection_calendars k join public.calendar_connections x on x.id=k.connection_id and x.organization_id=k.organization_id
    where k.organization_id=p_org and x.user_id=a.owner_user_id and k.is_destination;
   if not found or (select count(*) from public.calendar_connection_calendars k join public.calendar_connections x on x.id=k.connection_id and x.organization_id=k.organization_id where k.organization_id=p_org and x.user_id=a.owner_user_id and k.is_destination)<>1 then
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
   or a.google_claim_until is null or a.google_claim_until<=clock_timestamp() then raise exception 'google_stale' using errcode='40001';end if;
  if p_action='renew' then
   if a.revision::text is distinct from p_args->>'revision' or a.google_local_revision::text is distinct from p_args->>'local_revision' then raise exception 'google_stale' using errcode='40001';end if;
   if not exists(select 1 from public.calendar_connections x join public.calendar_connection_calendars k on k.organization_id=x.organization_id and k.connection_id=x.id
    where x.organization_id=p_org and x.id=a.google_connection_id and x.user_id=a.owner_user_id and x.status='healthy' and k.external_calendar_id=a.google_calendar_id and k.available and k.access_role in ('writer','owner')) then raise exception 'google_connection_unavailable' using errcode='42501';end if;
   update public.calendar_appointments set google_claim_until=clock_timestamp()+interval '90 seconds' where organization_id=p_org and id=p_id returning * into a;
  elsif p_action='release' then
   update public.calendar_appointments set google_claim_token=null,google_claim_until=null where organization_id=p_org and id=p_id;return 'true';
  else
   if a.revision::text is distinct from p_args->>'revision' or a.google_local_revision::text is distinct from p_args->>'local_revision'
    or a.google_event_id is distinct from p_args->>'event_id' or a.google_connection_id::text is distinct from p_args->>'connection_id'
    or a.google_calendar_id is distinct from p_args->>'calendar_id' then raise exception 'google_stale' using errcode='40001';end if;
   if p_action='error' then
    update public.calendar_appointments set google_sync_error=left(p_args->>'message',200),google_next_attempt_at=now()+interval '15 minutes',
     meeting_state=case when meeting_state='pending' and meeting_attempts>=19 then 'failed' else meeting_state end,
     meeting_last_error=case when meeting_state='pending' then 'unknown' else meeting_last_error end,
     meeting_attempts=meeting_attempts+case when meeting_state='pending' then 1 else 0 end,
     meeting_next_attempt_at=case when meeting_state='pending' then now()+make_interval(secs=>least(900,15*power(2,least(meeting_attempts,6)))::double precision+floor(random()*5)) else meeting_next_attempt_at end
     where organization_id=p_org and id=p_id;return 'true';end if;
   if a.google_event_id is not null then
    select * into conn from public.calendar_connections where organization_id=p_org and id=a.google_connection_id and user_id=a.owner_user_id;
    select * into c from public.calendar_connection_calendars where organization_id=p_org and connection_id=a.google_connection_id and external_calendar_id=a.google_calendar_id;
    if conn.id is null or conn.status<>'healthy' or c.id is null or not c.available then raise exception 'google_connection_unavailable' using errcode='42501';end if;
   end if;
   if p_action='meet' then
    perform public.fn_meet_observe(p_org,p_id,p_args);
    select * into a from public.calendar_appointments where organization_id=p_org and id=p_id;
   elsif p_action='prepare' then
    if c.access_role not in ('owner','writer') or (a.google_pending_write is not null and a.google_pending_write<>'{"reservation":true}'::jsonb) or a.google_conflict is not null then raise exception 'google_write_unavailable' using errcode='40001';end if;
    if p_args->'operation'?'conference_request_id' and (a.meeting_request_id is distinct from (p_args->'operation'->>'conference_request_id')::uuid or a.meeting_state<>'pending' or a.meeting_received_at is not null or a.status='cancelled') then raise exception 'meet_stale' using errcode='40001';end if;
    update public.calendar_appointments set meeting_requested_at=case when p_args->'operation'?'conference_request_id' then coalesce(meeting_requested_at,now()) else meeting_requested_at end,google_pending_write=p_args->'operation' where organization_id=p_org and id=p_id;return 'true';
   elsif p_action='idle' then
    update public.calendar_appointments set google_next_attempt_at=now()+interval '15 minutes' where organization_id=p_org and id=p_id;return 'true';
   elsif p_action='commit' then
    result:=p_args->'result'; b:=result->'base';remote:=result->'remote';
    if result?'operation_id' and a.google_pending_write->>'operation_id' is distinct from result->>'operation_id' then raise exception 'google_stale' using errcode='40001';end if;
    if result?'apply_remote' then
     if a.status not in ('pending','confirmed') then raise exception 'google_outcome_protected' using errcode='40001';end if;
     if not coalesce((remote->>'cancelled')::boolean,false) and exists(select 1 from public.calendar_appointments other
      where other.organization_id=p_org and other.owner_user_id=a.owner_user_id and other.id<>a.id and other.status in ('pending','confirmed')
      and other.starts_at<(remote->>'ends_at')::timestamptz and other.ends_at>(remote->>'starts_at')::timestamptz) then
      return jsonb_build_object('overlap',true);end if;
     changed:=row(a.starts_at,a.ends_at,a.time_zone,a.status='cancelled') is distinct from row((remote->>'starts_at')::timestamptz,(remote->>'ends_at')::timestamptz,remote->>'time_zone',(remote->>'cancelled')::boolean);
     perform public.fn_appointment_change_core(p_org,p_id,a.revision,
      jsonb_build_object('starts_at',remote->>'starts_at','ends_at',remote->>'ends_at','time_zone',remote->>'time_zone')||
      case when (remote->>'cancelled')::boolean then '{"status":"cancelled","cancellation_reason":"Cancelado no Google"}'::jsonb else '{}'::jsonb end,true,b);
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
revoke all on function public.fn_google_appointment(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.fn_google_appointment(uuid,uuid,text,jsonb) to service_role;

create or replace function public.fn_google_catalog(p_org uuid,p_connection uuid,p_items jsonb,p_revision text)
returns void language plpgsql security definer set search_path=public as $$
declare conn public.calendar_connections; it jsonb; fresh boolean;
begin
 select * into conn from public.calendar_connections where organization_id=p_org and id=p_connection;
 if not found then raise exception 'google_connection_unavailable' using errcode='P0002';end if;
 perform 1 from public.user_organizations where organization_id=p_org and user_id=conn.user_id and revoked_at is null for update;
 if not found then raise exception 'google_owner_unavailable' using errcode='42501';end if;
 select * into conn from public.calendar_connections where organization_id=p_org and id=p_connection;
 if conn.status<>'healthy' then raise exception 'google_connection_unavailable' using errcode='42501';end if;
 if conn.calendar_selection_revision::text is distinct from p_revision then raise exception 'google_selection_stale' using errcode='40001';end if;
 fresh:=(select count(*) from public.calendar_connections where organization_id=p_org and user_id=conn.user_id and provider='google_calendar')=1 and conn.calendar_selection_revision=0 and not exists(select 1 from public.calendar_connection_calendars k join public.calendar_connections x on x.organization_id=k.organization_id and x.id=k.connection_id where k.organization_id=p_org and x.user_id=conn.user_id and k.is_destination);
 for it in select value from jsonb_array_elements(p_items) loop
  insert into public.calendar_connection_calendars(organization_id,connection_id,external_calendar_id,name,time_zone,is_primary,access_role,available,catalog_checked_at,counts_for_conflicts,is_destination,allowed_conference_types)
   values(p_org,p_connection,it->>'id',coalesce(it->>'summaryOverride',it->>'summary',it->>'id'),it->>'timeZone',coalesce((it->>'primary')::boolean,false),it->>'accessRole',not coalesce((it->>'deleted')::boolean,false),now(),
    fresh and coalesce((it->>'primary')::boolean,false),false,case when jsonb_typeof(it->'conferenceProperties'->'allowedConferenceSolutionTypes')='array' then array(select jsonb_array_elements_text(it->'conferenceProperties'->'allowedConferenceSolutionTypes')) else null end)
   on conflict(organization_id,connection_id,external_calendar_id) do update set name=excluded.name,time_zone=excluded.time_zone,is_primary=excluded.is_primary,
    allowed_conference_types=excluded.allowed_conference_types,access_role=excluded.access_role,available=excluded.available,catalog_checked_at=excluded.catalog_checked_at,sync_next_attempt_at=now();
 end loop;
 update public.calendar_connection_calendars set available=false,catalog_checked_at=now() where organization_id=p_org and connection_id=p_connection
  and not exists(select 1 from jsonb_array_elements(p_items) v where v->>'id'=external_calendar_id);
 if fresh then
  update public.calendar_connection_calendars set is_destination=true where organization_id=p_org and connection_id=p_connection and is_primary and available and access_role in ('owner','writer');
 end if;
 update public.calendar_connections set calendar_selection_revision=calendar_selection_revision+1 where organization_id=p_org and id=p_connection;
end;$$;
revoke all on function public.fn_google_catalog(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.fn_google_catalog(uuid,uuid,jsonb,text) to service_role;


create or replace function public.fn_meet_notice(p_org uuid,p_id uuid,p_reason text)
returns void language plpgsql security definer set search_path=public as $$
begin
 insert into public.agent_inbox_items(organization_id,kind,severity,title,body,ref_kind,ref_id,appointment_revision)
 select p_org,'other','warn','Link da reunião precisa de atenção',
  'Abra o compromisso na Agenda para verificar o link ou autorizar uma nova entrega.','appointment',id,revision
 from public.calendar_appointments where organization_id=p_org and id=p_id
 on conflict(organization_id,ref_id,appointment_revision,kind) where ref_kind='appointment' and appointment_revision is not null
 do update set status='open',resolved_at=null,body=excluded.body;
end;$$;
revoke all on function public.fn_meet_notice(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fn_meet_notice(uuid,uuid,text) to service_role;

create or replace function public.fn_meet_delivery_enqueue()
returns trigger language plpgsql security definer set search_path=public as $$
declare jid uuid; b jsonb;
begin
 if new.meeting_state='cancelled' or new.meeting_delivery->>'state' in ('blocked','stale') then
  update public.job_queue set status='failed',locked_at=null,locked_by=null,payload='{}',last_error='meet_delivery_stale'
   where organization_id=new.organization_id and id=new.meeting_delivery_job_id and kind='transactional_delivery' and status in ('pending','running');
  return new;
 end if;
 if new.meeting_state='failed' then perform public.fn_meet_notice(new.organization_id,new.id,'meeting_failed');end if;
 if new.meeting_state<>'ready' or new.meeting_delivery->>'state'<>'waiting_for_link' then return new;end if;
 b:=new.meeting_delivery->'service_boundary';
 if not public.fn_meet_boundary_current(b) then
  update public.calendar_appointments set meeting_delivery=meeting_delivery||'{"state":"stale","error":"service_boundary_stale"}' where organization_id=new.organization_id and id=new.id;
  perform public.fn_meet_notice(new.organization_id,new.id,'service_boundary_stale');return new;
 end if;
 jid:=gen_random_uuid();
 insert into public.job_queue(id,organization_id,contact_id,kind,payload,run_after)
 values(jid,new.organization_id,new.contact_id,'transactional_delivery',jsonb_build_object('appointment_id',new.id,'meeting_request_id',new.meeting_request_id,
  'delivery_generation',new.meeting_delivery->>'generation','service_boundary',b),now());
 update public.calendar_appointments set meeting_delivery_job_id=jid,meeting_delivery=meeting_delivery||'{"state":"queued"}'
  where organization_id=new.organization_id and id=new.id;
 return new;
end;$$;
revoke all on function public.fn_meet_delivery_enqueue() from public,anon,authenticated;
drop trigger if exists trg_meet_delivery_enqueue on public.calendar_appointments;
create trigger trg_meet_delivery_enqueue after insert or update on public.calendar_appointments for each row execute function public.fn_meet_delivery_enqueue();

create or replace function public.fn_meet_delivery_current(p_org uuid,p_job uuid,p_worker text,p_acquired_at timestamptz)
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.job_queue j join public.calendar_appointments a on a.organization_id=j.organization_id and a.id::text=j.payload->>'appointment_id'
  join public.contacts c on c.organization_id=a.organization_id and c.id=a.contact_id
  join public.conversations v on v.organization_id=a.organization_id and v.contact_id=a.contact_id and v.id::text=j.payload->'service_boundary'->>'conversation_id'
  join public.channel_sessions cs on cs.organization_id=v.organization_id and cs.id=v.channel_session_id
  join public.organizations o on o.id=a.organization_id and o.status='active'
  where cs.archived_at is null and a.meeting_delivery->>'channel_session_id'=cs.id::text and j.organization_id=p_org and j.id=p_job and j.kind='transactional_delivery' and j.status='running' and j.locked_by=p_worker and j.locked_at=p_acquired_at
   and a.contact_id=j.contact_id and not c.is_anonymized and not c.is_blocked and a.status<>'cancelled' and a.meeting_state='ready' and a.meeting_url is not null
   and a.meeting_request_id::text=j.payload->>'meeting_request_id' and a.meeting_delivery->>'generation'=j.payload->>'delivery_generation'
   and a.meeting_delivery_job_id=j.id and a.meeting_delivery->>'state'='queued'
   and exists(select 1 from public.user_organizations where organization_id=p_org and user_id=a.owner_user_id and revoked_at is null)
   and (a.meeting_delivery->'authorized_by'->>'kind'='ai_agent' or
    (a.meeting_delivery->'authorized_by'->>'kind'='user' and a.meeting_delivery->'authorized_by'->>'id'=a.owner_user_id::text and exists(
     select 1 from public.user_organizations u where u.organization_id=p_org and u.user_id=a.owner_user_id and u.revoked_at is null and u.role in ('agent','manager','admin')
      and (u.role in ('manager','admin') or v.assigned_to_user_id=u.user_id or o.settings->>'visibility_mode'='all'
       or (coalesce(o.settings->>'visibility_mode','own_and_unassigned')='own_and_unassigned' and v.assigned_to_user_id is null)))))
   and a.meeting_delivery->'service_boundary'=j.payload->'service_boundary' and public.fn_meet_boundary_current(j.payload->'service_boundary'));
$$;
revoke all on function public.fn_meet_delivery_current(uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_meet_delivery_current(uuid,uuid,text,timestamptz) to service_role;

-- Política privada: sempre relida por aquisição original, inclusive no sink.
-- A origem humana vem somente do recibo protegido, nunca de payload do caller.
create or replace function public.fn_meet_delivery_policy(p_org uuid,p_job uuid,p_worker text,p_acquired_at timestamptz)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare r record;
begin
 select a.meeting_delivery,a.contact_id,v.channel_session_id,c.is_blocked,c.is_anonymized,c.force_human,c.ai_authorized_at,v.assignee_kind,v.bot_silenced_until,cs.metadata,cs.archived_at,
  public.fn_meet_delivery_current(p_org,p_job,p_worker,p_acquired_at) as current
 into r from public.job_queue j join public.calendar_appointments a on a.organization_id=j.organization_id and a.id::text=j.payload->>'appointment_id'
 join public.contacts c on c.organization_id=a.organization_id and c.id=a.contact_id
 join public.conversations v on v.organization_id=a.organization_id and v.contact_id=a.contact_id and v.id::text=j.payload->'service_boundary'->>'conversation_id'
 join public.channel_sessions cs on cs.organization_id=v.organization_id and cs.id=v.channel_session_id
 where j.organization_id=p_org and j.id=p_job and j.kind='transactional_delivery' and j.status='running' and j.locked_by=p_worker and j.locked_at=p_acquired_at
  and a.meeting_delivery_job_id=j.id and a.meeting_delivery->>'generation'=j.payload->>'delivery_generation';
 if not found then return jsonb_build_object('current',false,'reason','stale');end if;
 if not r.current then return jsonb_build_object('current',false,'reason',case when r.is_anonymized then 'lgpd' when r.is_blocked then 'opt_out' when r.archived_at is not null then 'channel' else 'access_or_stale' end);end if;
 return jsonb_build_object('current',true,'contact_id',r.contact_id,'channel_session_id',r.channel_session_id,'human_command',r.meeting_delivery->'authorized_by'->>'kind'='user',
  'force_human',r.force_human,'ai_gate',r.metadata->>'ai_gate','ai_authorized_at',r.ai_authorized_at,'assignee_kind',r.assignee_kind,'bot_silenced_until',r.bot_silenced_until);
end;$$;
revoke all on function public.fn_meet_delivery_policy(uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_meet_delivery_policy(uuid,uuid,text,timestamptz) to service_role;

-- Fencing também no callback/settle. O sink tem sua própria revalidação; o
-- transporte já aceito não é desfeito, mas callback velho não reidrata estado.
create or replace function public.fn_meet_delivery_settle(p_org uuid,p_job uuid,p_worker text,p_acquired_at timestamptz,p_state text,p_retry_at timestamptz default null)
returns boolean language plpgsql security definer set search_path=public as $$
declare j public.job_queue; a public.calendar_appointments; contact uuid; current_intent boolean; reason text;
begin
 select contact_id into contact from public.job_queue where organization_id=p_org and id=p_job;
 if contact is null then return false;end if;
 perform public.fn_service_lock(p_org,contact);
 select * into j from public.job_queue where organization_id=p_org and id=p_job for update;
 if not found or j.kind<>'transactional_delivery' or j.status<>'running' or j.locked_by is distinct from p_worker or j.locked_at is distinct from p_acquired_at then return false;end if;
 select * into a from public.calendar_appointments where organization_id=p_org and id::text=j.payload->>'appointment_id' for update;
 current_intent:=a.meeting_delivery_job_id=j.id and a.meeting_delivery->>'generation'=j.payload->>'delivery_generation';
 if p_state like 'blocked:%' then
  reason:=substring(p_state from 9);
  if reason not in ('opt_out','lgpd','channel','access_or_stale','force_human','conversa_silenciada','conversa_de_humano','sem_autorizacao','autorizacao_expirada','limits','guardrail') then raise exception 'meet_reason_invalid' using errcode='22023';end if;
  p_state:='blocked';
 end if;
 if p_state not in ('sent','queued','retry','failed','blocked','stale') then raise exception 'meet_state_invalid' using errcode='22023';end if;
 if p_state in ('sent','queued','retry') and not public.fn_meet_delivery_current(p_org,p_job,p_worker,p_acquired_at) then p_state:='stale';end if;
 if p_state='sent' and not exists(select 1 from public.send_ledger where organization_id=p_org and job_id=p_job and seq=1 and status='accepted') then raise exception 'meet_delivery_not_accepted' using errcode='40001';end if;
 if p_state='retry' and j.attempts>=j.max_attempts then p_state:='failed';end if;
 if p_state in ('queued','retry') then
  update public.job_queue set status='pending',locked_by=null,locked_at=null,attempts=case when p_state='queued' then greatest(0,attempts-1) else attempts end,run_after=coalesce(p_retry_at,now()+interval '1 minute'),last_error='meet_delivery_waiting' where id=p_job and organization_id=p_org;
 else
  update public.job_queue set status=case when p_state='sent' then 'done' else 'failed' end,locked_by=null,locked_at=null,last_error=case when p_state='sent' then null else coalesce(reason,'meet_delivery_'||p_state) end where id=p_job and organization_id=p_org;
  if current_intent then
   update public.calendar_appointments set meeting_delivery=meeting_delivery||jsonb_build_object('state',p_state,'error',case when p_state='sent' then null else coalesce(reason,'meet_delivery_'||p_state) end,'settled_at',now()) where id=a.id and organization_id=p_org;
   if p_state<>'sent' then perform public.fn_meet_notice(p_org,a.id,p_state);
   else update public.agent_inbox_items set status='resolved',resolved_at=now() where organization_id=p_org and ref_kind='appointment' and ref_id=a.id and kind='other' and status='open';end if;
  end if;
 end if;
 return true;
end;$$;
revoke all on function public.fn_meet_delivery_settle(uuid,uuid,text,timestamptz,text,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_meet_delivery_settle(uuid,uuid,text,timestamptz,text,timestamptz) to service_role;

-- Prova de sessão, independente da política de CADASTRO obrigatório de MFA.
create or replace function public.fn_session_mfa_proven()
returns boolean language sql stable security definer set search_path=public as $$
 select auth.uid() is not null and (coalesce(auth.jwt()->>'aal','aal1')='aal2' or not exists(
  select 1 from auth.mfa_factors where user_id=auth.uid() and factor_type='totp' and status='verified'));
$$;
revoke all on function public.fn_session_mfa_proven() from public,anon,authenticated;

create or replace function public.fn_meet_action(p_org uuid,p_id uuid,p_revision text,p_request uuid,p_action text,p_conversation uuid default null)
returns boolean language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; contact uuid; b jsonb; destination_channel uuid;
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'agent') or not public.fn_support_write_allowed(p_org) then raise exception 'meet_forbidden' using errcode='42501';end if;
 if not public.fn_session_mfa_proven() then raise exception 'meet_mfa_required' using errcode='42501';end if;
 select contact_id into contact from public.calendar_appointments where organization_id=p_org and id=p_id;
 if contact is not null then perform public.fn_service_lock(p_org,contact);end if;
 select * into a from public.calendar_appointments where organization_id=p_org and id=p_id for update;
 if not found or a.owner_user_id is distinct from auth.uid() or not exists(select 1 from public.user_organizations where organization_id=p_org and user_id=auth.uid() and revoked_at is null) then raise exception 'meet_forbidden' using errcode='42501';end if;
 if a.revision::text is distinct from p_revision or a.meeting_request_id is distinct from p_request or a.status='cancelled' or a.location_kind<>'google_meet'
  or exists(select 1 from public.contacts where id=a.contact_id and organization_id=p_org and is_anonymized) then raise exception 'meet_stale' using errcode='40001';end if;
 if p_action='retry' then
  if a.google_conflict is not null then raise exception 'google_conflict_requires_choice' using errcode='40001';end if;
  if a.meeting_state='ready' then return false;end if;
  if a.meeting_state<>'failed' then
   update public.calendar_appointments set meeting_next_attempt_at=now(),google_next_attempt_at=now() where organization_id=p_org and id=p_id;return true;
  end if;
  -- Tempo/timeout não provam rejeição. Somente failure recebido gira solicitação.
  update public.calendar_appointments set meeting_request_id=case when meeting_last_error='google_failure' and meeting_received_at is not null then gen_random_uuid() else meeting_request_id end,
   meeting_requested_at=case when meeting_last_error='google_failure' and meeting_received_at is not null then null else meeting_requested_at end,
   meeting_received_at=case when meeting_last_error='google_failure' then null else meeting_received_at end,
   meeting_state='pending',meeting_attempts=0,meeting_last_error=null,meeting_next_attempt_at=now(),google_next_attempt_at=now() where organization_id=p_org and id=p_id;
 elsif p_action='deliver' then
  if a.contact_id is null then raise exception 'meet_conversation_unavailable' using errcode='42501';end if;
  select channel_session_id into destination_channel from public.conversations where organization_id=p_org and id=p_conversation and contact_id=a.contact_id and not is_group and public.fn_can_view_conversation(organization_id,assigned_to_user_id) for update;
  if not found then raise exception 'meet_conversation_unavailable' using errcode='42501';end if;
  b:=public.fn_service_boundary(p_org,p_conversation)-'status'-'demanda_fechada_em'-'service_started_at';
  if not public.fn_meet_boundary_current(b) then raise exception 'meet_conversation_stale' using errcode='40001';end if;
  if a.meeting_delivery->'service_boundary'=b and a.meeting_delivery->>'channel_session_id'=destination_channel::text then
   if a.meeting_delivery->>'state' in ('waiting_for_link','sent') then return false;end if;
   if a.meeting_delivery->>'state'='queued' and a.meeting_delivery_job_id is not null then
    -- Recuperação humana de job morto conserva ledger/identidade. Não duplicar
    -- uma mensagem aceita antes do crash nem reconstruir fronteira antiga.
    update public.job_queue set status='pending',locked_by=null,locked_at=null,attempts=0,run_after=now(),last_error=null
     where organization_id=p_org and id=a.meeting_delivery_job_id and kind='transactional_delivery' and status in ('dead','failed','done');
    return found;
   end if;
  end if;
  update public.job_queue set status='failed',locked_by=null,locked_at=null,last_error='meet_delivery_superseded' where organization_id=p_org and id=a.meeting_delivery_job_id and kind='transactional_delivery' and status in ('pending','running');
  update public.calendar_appointments set meeting_delivery=jsonb_build_object('state','waiting_for_link','generation',gen_random_uuid(),'service_boundary',b,'authorized_by',jsonb_build_object('kind','user','id',auth.uid()),'source_operation_id',gen_random_uuid()),meeting_delivery_job_id=null where organization_id=p_org and id=p_id;
 else raise exception 'meet_action_invalid' using errcode='22023';end if;
 return true;
end;$$;
revoke all on function public.fn_meet_action(uuid,uuid,text,uuid,text,uuid) from public,anon;
grant execute on function public.fn_meet_action(uuid,uuid,text,uuid,text,uuid) to authenticated;

-- Backfill operacional, sem assumir que URL legada é resposta validada Google.
update public.calendar_appointments set meeting_state='not_requested' where location_kind='google_meet' and meeting_state='not_requested' and status<>'cancelled';

-- Resultados/contextos derivados não são um segundo cofre de URL. A resposta
-- autorizada continua funcional em memória e a mensagem em messages.body.
create or replace function public.fn_meet_minimize_runtime()
returns trigger language plpgsql set search_path=public as $$
begin
 new:=jsonb_populate_record(new,regexp_replace(to_jsonb(new)::text,'https://meet[.]google[.]com/[a-zA-Z0-9-]+',case when tg_table_name='outbound_copies' then '[meet-link]' else '[link da reunião disponível na Agenda]' end,'g')::jsonb);
 return new;
end;$$;
revoke all on function public.fn_meet_minimize_runtime() from public,anon,authenticated;
do $$ declare tab text;begin
 foreach tab in array array['lead_checkpoints','lead_state','lead_state_transitions','agent_cases','outbound_copies','conversations'] loop
  execute format('drop trigger if exists trg_meet_minimize_runtime on public.%I',tab);
  execute format('create trigger trg_meet_minimize_runtime before insert or update on public.%I for each row execute function public.fn_meet_minimize_runtime()',tab);
 end loop;
end;$$;

create or replace function public.fn_meet_redact_contact()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 perform public.fn_service_lock(new.organization_id,new.id);
 update public.job_queue set payload='{}',status=case when status in ('pending','running') then 'failed' else status end,
  locked_by=null,locked_at=null,last_error='meet_contact_redacted'
  where organization_id=new.organization_id and contact_id=new.id and kind='transactional_delivery';
 update public.agent_inbox_items set status='resolved',resolved_at=now(),body='Contato anonimizado.',ref_id=null
  where organization_id=new.organization_id and ref_kind='appointment' and ref_id in(select id from public.calendar_appointments where organization_id=new.organization_id and contact_id=new.id) and kind='other';
 update public.calendar_appointments set meeting_url=null,meeting_request_id=null,meeting_requested_at=null,meeting_received_at=null,meeting_last_error=null,
  meeting_next_attempt_at=null,meeting_delivery='{"state":"blocked"}',meeting_delivery_job_id=null
  where organization_id=new.organization_id and contact_id=new.id;
 return new;
end;$$;
revoke all on function public.fn_meet_redact_contact() from public,anon,authenticated;
drop trigger if exists trg_meet_redact_contact on public.contacts;
create trigger trg_meet_redact_contact after update of is_anonymized on public.contacts for each row when(new.is_anonymized is true) execute function public.fn_meet_redact_contact();
notify pgrst,'reload schema';
