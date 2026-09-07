-- 0225 — Google compartilha o compromisso; presença continua humana (0224).
-- DIRC: mesma tupla, crons, mutex e revisão de domínio. Checkpoints outbound
-- são hashes; pending_write é um slot de intenção histórica, nunca recibo remoto.
alter table public.calendar_appointments
 add column if not exists google_local_revision bigint not null default 1,
 add column if not exists google_synced_local_revision bigint not null default 0,
 add column if not exists google_etag text,
 add column if not exists google_base_projection jsonb,
 add column if not exists google_conflict jsonb,
 add column if not exists google_pending_write jsonb,
 add column if not exists google_claim_token uuid,
 add column if not exists google_claim_epoch bigint not null default 0,
 add column if not exists google_claim_until timestamptz,
 add column if not exists google_next_attempt_at timestamptz not null default now();
alter table public.calendar_connections add column if not exists calendar_selection_revision bigint not null default 0;
alter table public.calendar_connection_calendars
 add column if not exists access_role text,
 add column if not exists available boolean not null default true,
 add column if not exists catalog_checked_at timestamptz,
 add column if not exists sync_claim_token uuid,
 add column if not exists sync_claim_epoch bigint not null default 0,
 add column if not exists sync_claim_until timestamptz,
 add column if not exists sync_next_attempt_at timestamptz not null default now(),
 add column if not exists last_sync_at timestamptz,
 add column if not exists sync_error text,
 add column if not exists sync_cursor jsonb,
 add column if not exists sync_coverage jsonb;
alter table public.calendar_external_events
 add column if not exists seen_generation uuid,
 add column if not exists recurring_event_id text,
 add column if not exists original_start_time jsonb;
alter table public.calendar_external_events alter column starts_at drop not null;
alter table public.calendar_external_events alter column ends_at drop not null;
alter table public.calendar_external_events drop constraint if exists calendar_external_events_periodo_valido;
alter table public.calendar_external_events add constraint calendar_external_events_periodo_valido
 check(status='cancelled' or (starts_at is not null and ends_at is not null and ends_at>starts_at));
drop index if exists public.calendar_appointments_google_evento_key;
create unique index if not exists calendar_appointments_google_evento_key
 on public.calendar_appointments(organization_id,google_connection_id,google_calendar_id,google_event_id) where google_event_id is not null;
-- Nenhum legado é declarado sincronizado sem GET/base. Tupla ambígua fica
-- preservada e visível; não se adivinha calendário de outra conta/conexão.
drop index if exists public.calendar_appointments_pendente_no_google_idx;
drop view if exists public.calendar_google_reconcilable_appointments;
alter table public.calendar_appointments drop column if exists needs_google_push;
alter table public.calendar_appointments add column needs_google_push boolean generated always as
 (google_local_revision>google_synced_local_revision and google_conflict is null) stored;
create index if not exists calendar_appointments_pendente_no_google_idx
 on public.calendar_appointments(google_next_attempt_at) where needs_google_push and owner_user_id is not null;

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
 decision:=auth.uid()=old.owner_user_id and public.fn_role_at_least(new.organization_id,'agent') and public.fn_support_write_allowed(new.organization_id)
  and old.google_conflict is not null and new.google_conflict-'resolution'=old.google_conflict-'resolution'
  and new.google_conflict->'resolution'->>'actor_id'=auth.uid()::text
  and new.google_conflict->'resolution'->>'choice' in ('google','local','preserve_remote')
  and old.google_conflict->>'revision'=old.revision::text and old.google_conflict->>'local_revision'=old.google_local_revision::text
  and old.google_conflict->>'etag' is not distinct from old.google_etag;
 if auth.uid() is not null and (row(new.google_synced_at,new.google_sync_error) is distinct from row(old.google_synced_at,old.google_sync_error)
  or (new.google_next_attempt_at is distinct from old.google_next_attempt_at and not coalesce(auth.uid()=old.owner_user_id and public.fn_role_at_least(new.organization_id,'agent') and public.fn_support_write_allowed(new.organization_id)
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
revoke all on function public.fn_google_projection_stamp() from public,anon,authenticated;
drop trigger if exists trg_google_projection_stamp on public.calendar_appointments;
create trigger trg_google_projection_stamp before insert or update on public.calendar_appointments for each row execute function public.fn_google_projection_stamp();

create or replace function public.fn_appointment_change_core(p_org uuid,p_id uuid,p_revision bigint,p_patch jsonb,p_remote boolean,p_base jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; contact uuid; origin jsonb; event_id uuid;
begin
 if p_remote and (auth.uid() is not null or (p_patch-'starts_at'-'ends_at'-'time_zone'-'status'-'cancellation_reason')<>'{}'::jsonb or coalesce(p_patch->>'status','cancelled')<>'cancelled') then raise exception 'google_patch_forbidden' using errcode='42501';end if;
 if auth.uid() is not null and (not public.fn_role_at_least(p_org,'agent') or not public.fn_support_write_allowed(p_org)) then raise exception 'appointment_forbidden' using errcode='42501'; end if;
 select contact_id into contact from public.calendar_appointments where organization_id=p_org and id=p_id;
 if not found then raise exception 'appointment_not_found' using errcode='P0002'; end if;
 if contact is not null then perform public.fn_service_lock(p_org,contact); end if;
 select * into a from public.calendar_appointments where organization_id=p_org and id=p_id for update;
 if a.contact_id is distinct from contact or a.revision is distinct from p_revision then raise exception 'appointment_stale' using errcode='40001'; end if;
 if p_remote and a.status not in ('pending','confirmed') then raise exception 'google_outcome_protected' using errcode='40001';end if;
 if a.status='cancelled' then raise exception 'appointment_cancelled' using errcode='22023'; end if;
 if contact is not null then origin:=jsonb_build_object('kind','command','observed',public.fn_service_observe_command(p_org,contact)); end if;
 update public.calendar_appointments set
  google_base_projection=case when p_remote then p_base else google_base_projection end,
  starts_at=case when p_patch?'starts_at' then (p_patch->>'starts_at')::timestamptz else starts_at end,
  ends_at=case when p_patch?'ends_at' then (p_patch->>'ends_at')::timestamptz else ends_at end,
  time_zone=coalesce(p_patch->>'time_zone',time_zone),
  status=coalesce(p_patch->>'status',status),
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
create or replace function public.fn_appointment_change(p_org uuid,p_id uuid,p_revision bigint,p_patch jsonb)
returns jsonb language sql security definer set search_path=public as $$
 select public.fn_appointment_change_core(p_org,p_id,p_revision,p_patch,false,null);
$$;
revoke all on function public.fn_appointment_change(uuid,uuid,bigint,jsonb) from public,anon;
grant execute on function public.fn_appointment_change(uuid,uuid,bigint,jsonb) to authenticated,service_role;

-- Helpers de fencing só internos. Epoch identifica aquisição; geração pertence
-- ao ciclo de paginação e não muda durante heartbeat/reclaim.
create or replace function public.fn_google_calendar_fence(p_org uuid,p_id uuid,p_claim jsonb,p_cursor jsonb default null)
returns void language plpgsql security definer set search_path=public as $$
declare c public.calendar_connection_calendars;
begin
 select * into c from public.calendar_connection_calendars where organization_id=p_org and id=p_id for update;
 if not found or not c.available or c.access_role not in ('owner','writer','reader','writerWithoutPrivateAccess') or c.sync_claim_token is distinct from (p_claim->>'token')::uuid
  or c.sync_claim_epoch::text is distinct from p_claim->>'epoch' or c.sync_claim_until<=clock_timestamp() or c.sync_claim_until is null
  or (p_cursor is not null and c.sync_cursor is distinct from p_cursor) then raise exception 'google_stale' using errcode='40001'; end if;
 if not exists(select 1 from public.calendar_connections x join public.user_organizations m on m.organization_id=x.organization_id and m.user_id=x.user_id
  where x.organization_id=p_org and x.id=c.connection_id and m.revoked_at is null and x.status='healthy') then raise exception 'google_connection_unavailable' using errcode='42501';end if;
end;$$;
revoke all on function public.fn_google_calendar_fence(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;

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
    update public.calendar_appointments set google_sync_error=left(p_args->>'message',200),google_next_attempt_at=now()+interval '15 minutes'
     where organization_id=p_org and id=p_id;return 'true';end if;
   if a.google_event_id is not null then
    select * into conn from public.calendar_connections where organization_id=p_org and id=a.google_connection_id and user_id=a.owner_user_id;
    select * into c from public.calendar_connection_calendars where organization_id=p_org and connection_id=a.google_connection_id and external_calendar_id=a.google_calendar_id;
    if conn.id is null or conn.status<>'healthy' or c.id is null or not c.available then raise exception 'google_connection_unavailable' using errcode='42501';end if;
   end if;
   if p_action='prepare' then
    if c.access_role not in ('owner','writer') or (a.google_pending_write is not null and a.google_pending_write<>'{"reservation":true}'::jsonb) or a.google_conflict is not null then raise exception 'google_write_unavailable' using errcode='40001';end if;
    update public.calendar_appointments set google_pending_write=p_args->'operation' where organization_id=p_org and id=p_id;return 'true';
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
  'google_synced_local_revision',a.google_synced_local_revision::text,'claim',jsonb_build_object('token',a.google_claim_token,'epoch',a.google_claim_epoch::text,'lease_until',a.google_claim_until));
end;$$;
revoke all on function public.fn_google_appointment(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.fn_google_appointment(uuid,uuid,text,jsonb) to service_role;

create or replace function public.fn_google_calendar(p_org uuid,p_id uuid,p_action text,p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=public as $$
declare c public.calendar_connection_calendars; cur jsonb; it jsonb; gen uuid; rebuild_full boolean; token text;
begin
 select * into c from public.calendar_connection_calendars where organization_id=p_org and id=p_id for update;
 if not found then raise exception 'google_calendar_not_found' using errcode='P0002';end if;
 if not exists(select 1 from public.calendar_connections x join public.user_organizations m on m.organization_id=x.organization_id and m.user_id=x.user_id
  where x.organization_id=p_org and x.id=c.connection_id and m.revoked_at is null and x.status='healthy') then raise exception 'google_connection_unavailable' using errcode='42501';end if;
 if p_action='claim' then
  if c.sync_claim_until>clock_timestamp() or not c.available then return null;end if;
  cur:=c.sync_cursor;
  if cur is null then
   rebuild_full:=c.sync_token is null or c.sync_coverage is null or (c.sync_coverage->>'completed_at')::timestamptz<now()-interval '24 hours';
   cur:=jsonb_build_object('generation',gen_random_uuid(),'mode',case when rebuild_full then 'full' else 'incremental' end,
    'base_sync_token',case when rebuild_full then null else c.sync_token end,'page_token',null,
    'window_start',case when rebuild_full then now()-interval '1 day' else (c.sync_coverage->>'window_start')::timestamptz end,
    'window_end',case when rebuild_full then now()+interval '90 days' else (c.sync_coverage->>'window_end')::timestamptz end);
  end if;
  update public.calendar_connection_calendars set sync_claim_token=gen_random_uuid(),sync_claim_epoch=sync_claim_epoch+1,
   sync_claim_until=clock_timestamp()+interval '90 seconds',sync_cursor=cur where organization_id=p_org and id=p_id returning * into c;
 else
  perform public.fn_google_calendar_fence(p_org,p_id,p_args->'claim',p_args->'cursor');
  if p_action='renew' then
   update public.calendar_connection_calendars set sync_claim_until=clock_timestamp()+interval '90 seconds' where organization_id=p_org and id=p_id returning * into c;
  elsif p_action='release' then
   update public.calendar_connection_calendars set sync_claim_token=null,sync_claim_until=null where organization_id=p_org and id=p_id;return 'true';
  elsif p_action='error' then
   update public.calendar_connection_calendars set sync_error=left(p_args->>'message',200),sync_next_attempt_at=now()+interval '15 minutes' where organization_id=p_org and id=p_id;return 'true';
  elsif p_action='reset' then
   update public.calendar_connection_calendars set sync_token=null,sync_cursor=null,sync_error='A ocupação está desatualizada. Reconstruindo a leitura.',sync_next_attempt_at=now()
    where organization_id=p_org and id=p_id;return 'true';
  elsif p_action='item' then
   it:=p_args->'item';gen:=(c.sync_cursor->>'generation')::uuid;
   -- O vínculo é resolvido antes do cache/anti-eco, também quando só chega id.
   if exists(select 1 from public.calendar_appointments where organization_id=p_org and google_connection_id=c.connection_id and google_calendar_id=c.external_calendar_id and google_event_id=it->>'external_event_id') then
    delete from public.calendar_external_events where organization_id=p_org and connection_id=c.connection_id and external_calendar_id=c.external_calendar_id and external_event_id=it->>'external_event_id';
    return 'true';
   end if;
   insert into public.calendar_external_events(organization_id,connection_id,external_calendar_id,external_event_id,title,starts_at,ends_at,status,transparency,is_all_day,seen_generation,recurring_event_id,original_start_time)
    values(p_org,c.connection_id,c.external_calendar_id,it->>'external_event_id',null,(it->>'starts_at')::timestamptz,(it->>'ends_at')::timestamptz,
     it->>'status',coalesce(it->>'transparency','opaque'),coalesce((it->>'is_all_day')::boolean,false),gen,it->>'recurring_event_id',it->'original_start_time')
    on conflict(organization_id,connection_id,external_calendar_id,external_event_id) do update set title=null,starts_at=excluded.starts_at,ends_at=excluded.ends_at,
     status=excluded.status,transparency=excluded.transparency,is_all_day=excluded.is_all_day,seen_generation=excluded.seen_generation,
     recurring_event_id=coalesce(excluded.recurring_event_id,calendar_external_events.recurring_event_id),original_start_time=coalesce(excluded.original_start_time,calendar_external_events.original_start_time);
   return 'true';
  elsif p_action='page' then
   token:=p_args->>'next_page_token';
   if token is not null and token=c.sync_cursor->>'page_token' then raise exception 'google_cursor_no_progress' using errcode='22023';end if;
   if token is null then
    if coalesce(p_args->>'next_sync_token','')='' then raise exception 'google_checkpoint_missing' using errcode='22023';end if;
    if c.sync_cursor->>'mode'='full' then
     delete from public.calendar_external_events where organization_id=p_org and connection_id=c.connection_id and external_calendar_id=c.external_calendar_id
      and starts_at<(c.sync_cursor->>'window_end')::timestamptz and ends_at>(c.sync_cursor->>'window_start')::timestamptz
      and seen_generation is distinct from (c.sync_cursor->>'generation')::uuid and status<>'cancelled';
    end if;
    update public.calendar_connection_calendars set sync_token=p_args->>'next_sync_token',sync_cursor=null,last_sync_at=now(),sync_error=null,
     sync_coverage=case when c.sync_cursor->>'mode'='full' then c.sync_cursor-'page_token'-'base_sync_token'-'mode'||jsonb_build_object('completed_at',now()) else c.sync_coverage end,
     sync_next_attempt_at=now()+interval '15 minutes' where organization_id=p_org and id=p_id returning * into c;
   else
    update public.calendar_connection_calendars set sync_cursor=jsonb_set(sync_cursor,'{page_token}',to_jsonb(token)),sync_next_attempt_at=now() where organization_id=p_org and id=p_id returning * into c;
   end if;
  else raise exception 'google_action_invalid' using errcode='22023';end if;
 end if;
 return to_jsonb(c)||jsonb_build_object('claim',jsonb_build_object('token',c.sync_claim_token,'epoch',c.sync_claim_epoch::text,'lease_until',c.sync_claim_until));
end;$$;
revoke all on function public.fn_google_calendar(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.fn_google_calendar(uuid,uuid,text,jsonb) to service_role;

-- Catálogo completo: ausências somente depois de todas as páginas recebidas.
-- Uma mesma membership cerca seleção, catálogo e primeira reserva.
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
  insert into public.calendar_connection_calendars(organization_id,connection_id,external_calendar_id,name,time_zone,is_primary,access_role,available,catalog_checked_at,counts_for_conflicts,is_destination)
   values(p_org,p_connection,it->>'id',coalesce(it->>'summaryOverride',it->>'summary',it->>'id'),it->>'timeZone',coalesce((it->>'primary')::boolean,false),it->>'accessRole',not coalesce((it->>'deleted')::boolean,false),now(),
    fresh and coalesce((it->>'primary')::boolean,false),false)
   on conflict(organization_id,connection_id,external_calendar_id) do update set name=excluded.name,time_zone=excluded.time_zone,is_primary=excluded.is_primary,
    access_role=excluded.access_role,available=excluded.available,catalog_checked_at=excluded.catalog_checked_at,sync_next_attempt_at=now();
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

create or replace function public.fn_google_selection(p_org uuid,p_revisions jsonb,p_sources uuid[],p_destination uuid)
returns void language plpgsql security definer set search_path=public as $$
declare actor uuid:=auth.uid(); expected jsonb; actual jsonb;
begin
 if actor is null or not public.fn_role_at_least(p_org,'agent') or not public.fn_support_write_allowed(p_org) then raise exception 'google_selection_forbidden' using errcode='42501';end if;
 perform 1 from public.user_organizations where organization_id=p_org and user_id=actor and revoked_at is null for update;
 if not found then raise exception 'google_owner_unavailable' using errcode='42501';end if;
 select jsonb_agg(value order by value->>'connection_id') into expected from jsonb_array_elements(p_revisions);
 select jsonb_agg(jsonb_build_object('connection_id',id,'revision',calendar_selection_revision::text) order by id::text) into actual from public.calendar_connections where organization_id=p_org and user_id=actor and provider='google_calendar';
 if actual is distinct from expected then raise exception 'google_selection_stale' using errcode='40001';end if;
 if not exists(select 1 from public.calendar_connection_calendars k join public.calendar_connections c on c.id=k.connection_id and c.organization_id=k.organization_id
  where k.organization_id=p_org and k.id=p_destination and c.user_id=actor and c.status='healthy' and k.available and k.access_role in ('owner','writer')) then raise exception 'google_destination_unavailable' using errcode='42501';end if;
 if exists(select 1 from unnest(p_sources) selected(id) where not exists(select 1 from public.calendar_connection_calendars k join public.calendar_connections c on c.id=k.connection_id and c.organization_id=k.organization_id
  where k.organization_id=p_org and k.id=selected.id and c.user_id=actor and c.status='healthy' and k.available and k.access_role in ('owner','writer','reader','writerWithoutPrivateAccess'))) then raise exception 'google_source_unavailable' using errcode='42501';end if;
 update public.calendar_connection_calendars k set is_destination=false from public.calendar_connections c where k.organization_id=p_org and c.organization_id=p_org and k.connection_id=c.id and c.user_id=actor;
 update public.calendar_connection_calendars k set is_destination=k.id=p_destination,counts_for_conflicts=k.id=any(p_sources),sync_next_attempt_at=now() from public.calendar_connections c where k.organization_id=p_org and c.organization_id=p_org and k.connection_id=c.id and c.user_id=actor;
 update public.calendar_connections set calendar_selection_revision=calendar_selection_revision+1 where organization_id=p_org and user_id=actor and provider='google_calendar';
end;$$;
revoke all on function public.fn_google_selection(uuid,jsonb,uuid[],uuid) from public,anon;
grant execute on function public.fn_google_selection(uuid,jsonb,uuid[],uuid) to authenticated;

-- Leitura derivada: seleção vale nos três leitores, mesmo com cache antigo.
create or replace function public.fn_google_counts_for_conflicts(p_org uuid,p_connection uuid,p_calendar text)
returns boolean language sql stable security definer set search_path=public as $$
 -- ⚠️ FALHA ABERTO na AUSÊNCIA de catálogo, e a direção é deliberada.
 -- A forma `exists(... and counts_for_conflicts)` exigia linha em
 -- calendar_connection_calendars para o evento contar. Antes desta migration os
 -- três leitores (grade, semente da página e o motor de horários livres) liam
 -- `calendar_external_events` DIRETO: toda ocupação contava. Numa conexão cujo
 -- catálogo ainda não foi montado — ou cujo calendário saiu do catálogo com os
 -- eventos ainda gravados — a ocupação sumia da grade E deixava de bloquear o
 -- horário. O erro barato é mostrar "Ocupado" a mais; o caro é marcar por cima
 -- de uma consulta que existe. A negativa só vale quando alguém a declarou.
 select (auth.uid() is null or p_org in (select public.fn_user_org_ids())) and not exists(
  select 1 from public.calendar_connection_calendars where organization_id=p_org and connection_id=p_connection and external_calendar_id=p_calendar and not counts_for_conflicts);
$$;
revoke all on function public.fn_google_counts_for_conflicts(uuid,uuid,text) from public,anon;
grant execute on function public.fn_google_counts_for_conflicts(uuid,uuid,text) to authenticated,service_role;
create or replace view public.calendar_selected_external_events with (security_invoker=true) as
 select e.* from public.calendar_external_events e where e.status<>'cancelled'
 and public.fn_google_counts_for_conflicts(e.organization_id,e.connection_id,e.external_calendar_id);
revoke all on public.calendar_selected_external_events from public,anon;
grant select on public.calendar_selected_external_events to authenticated,service_role;

-- Anonimização e commit disputam a MESMA linha de appointment. Quem chegar
-- depois vê redação ou tem o resultado apagado; não reidrata snapshot tardio.
create or replace function public.fn_google_redact_contact()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.is_anonymized then
  update public.calendar_appointments set google_base_projection=null,google_conflict=null,google_pending_write=null,
   google_claim_epoch=google_claim_epoch+1,google_claim_token=null,google_claim_until=null,google_etag=null,
   google_sync_error='Contato anonimizado. Sincronização interrompida.',guest_email=null
   where organization_id=new.organization_id and contact_id=new.id;
 end if;return new;
end;$$;
revoke all on function public.fn_google_redact_contact() from public,anon,authenticated;
drop trigger if exists trg_google_redact_contact on public.contacts;
create trigger trg_google_redact_contact after update of is_anonymized on public.contacts for each row when(new.is_anonymized is true) execute function public.fn_google_redact_contact();
-- Backlog sem consumer não era entrega. A revisão durável é a única pendência.
update public.event_log set status='done',updated_at=now(),last_error='superseded: Google acompanha a revisão atual do compromisso'
 where event_type='agenda.appointment.push_to_google' and status in ('pending','processing');
notify pgrst,'reload schema';

create or replace function public.fn_google_resolve(p_org uuid,p_id uuid,p_revision text,p_local_revision text,p_etag text,p_choice text)
returns void language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; contact uuid;
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'agent') or not public.fn_support_write_allowed(p_org) then raise exception 'google_resolution_forbidden' using errcode='42501';end if;
 select contact_id into contact from public.calendar_appointments where organization_id=p_org and id=p_id;
 if contact is not null then perform public.fn_service_lock(p_org,contact);end if;
 select * into a from public.calendar_appointments where organization_id=p_org and id=p_id for update;
 if not found or a.owner_user_id is distinct from auth.uid() then raise exception 'google_resolution_forbidden' using errcode='42501';end if;
 if a.revision::text is distinct from p_revision or a.google_local_revision::text is distinct from p_local_revision
  or a.google_etag is distinct from p_etag then raise exception 'google_stale' using errcode='40001';end if;
 if p_choice='retry' then
  if a.google_conflict is not null then raise exception 'google_conflict_requires_choice' using errcode='40001';end if;
  update public.calendar_appointments set google_next_attempt_at=now() where organization_id=p_org and id=p_id;
 else
  if p_choice not in ('google','local','preserve_remote') or a.google_conflict is null then raise exception 'google_choice_invalid' using errcode='22023';end if;
  -- O trigger reconhece somente esta forma autenticada: o corpo da comparação
  -- e as revisões não mudam, actor_id é auth.uid(), não input do browser.
  update public.calendar_appointments set google_conflict=google_conflict||jsonb_build_object('resolution',jsonb_build_object('choice',p_choice,'actor_id',auth.uid())),google_next_attempt_at=now()
   where organization_id=p_org and id=p_id;
 end if;
end;$$;
revoke all on function public.fn_google_resolve(uuid,uuid,text,text,text,text) from public,anon;
grant execute on function public.fn_google_resolve(uuid,uuid,text,text,text,text) to authenticated;

notify pgrst,'reload schema';

create or replace function public.fn_google_coverage(p_org uuid,p_owner uuid,p_start timestamptz,p_end timestamptz)
returns boolean language sql stable security definer set search_path=public as $$
 select case when auth.uid() is not null and p_org not in(select public.fn_user_org_ids()) then true else exists(
  select 1 from public.calendar_connection_calendars k join public.calendar_connections c on c.organization_id=k.organization_id and c.id=k.connection_id
  where k.organization_id=p_org and c.user_id=p_owner and k.counts_for_conflicts and (
   not k.available or c.status<>'healthy' or k.access_role not in ('owner','writer','reader','writerWithoutPrivateAccess') or k.sync_coverage is null or k.sync_error is not null or k.last_sync_at is null or k.last_sync_at<now()-interval '30 minutes'
   or (k.sync_coverage->>'window_start')::timestamptz>p_start or (k.sync_coverage->>'window_end')::timestamptz<p_end)) end;
$$;
revoke all on function public.fn_google_coverage(uuid,uuid,timestamptz,timestamptz) from public,anon;
grant execute on function public.fn_google_coverage(uuid,uuid,timestamptz,timestamptz) to authenticated,service_role;
notify pgrst,'reload schema';

-- Elegibilidade derivada do titular canônico, ANTES do limite do cron.
-- Preservar a tupla redigida impede eco; não significa autorizar novo GET.
create or replace view public.calendar_google_reconcilable_appointments with (security_invoker=true) as
 select a.* from public.calendar_appointments a where not exists(
  select 1 from public.contacts c where c.organization_id=a.organization_id and c.id=a.contact_id and c.is_anonymized);
revoke all on public.calendar_google_reconcilable_appointments from public,anon,authenticated;
grant select on public.calendar_google_reconcilable_appointments to service_role;
notify pgrst,'reload schema';
