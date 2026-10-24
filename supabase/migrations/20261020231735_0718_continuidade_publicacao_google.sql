-- manifest: Publicação Google imediata com retomada nativa durável, revisão comprovada e espera sem Caso.
-- Additional persistence is the receipt ownership lost between booking and cron.
-- Contains only native identifiers/boundaries; no prompt, customer text or credentials.
-- No existing appointment/Case is enrolled. No HTTP runs in a transaction or trigger.
alter table public.job_queue drop constraint if exists job_queue_kind_check;
alter table public.job_queue add constraint job_queue_kind_check check (kind in ('inbound_turn','followup_turn','watchdog','flywheel','case_reply_turn','operator_turn','transactional_delivery','approved_reply','google_publication_turn'));
alter table public.job_queue drop constraint if exists job_queue_turn_needs_contact;
alter table public.job_queue add constraint job_queue_turn_needs_contact check ((kind in ('inbound_turn','followup_turn','case_reply_turn','operator_turn','transactional_delivery','approved_reply','google_publication_turn'))=(contact_id is not null));
alter table public.calendar_appointments add column if not exists google_sync_attempts integer not null default 0;
alter table public.calendar_appointments add column if not exists google_sync_failure_kind text;
-- NULL is a finite terminal recovery state. Explicit operator retry re-arms it.
alter table public.calendar_appointments alter column google_next_attempt_at drop not null;
create table if not exists public.google_publication_continuations (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 contact_id uuid not null references public.contacts(id) on delete cascade,
 conversation_id uuid not null references public.conversations(id) on delete cascade,
 source_job_id uuid not null references public.job_queue(id) on delete cascade,
 operation_key text not null,
 appointment_ids uuid[] not null,
 revisions jsonb not null,
 service_boundary jsonb not null,
 agent_operation jsonb,
 assignment_claim_ids uuid[] not null default '{}',
 inbound_message_ids uuid[] not null default '{}',
 request_message_id uuid references public.messages(id) on delete set null,
 state text not null default 'attempting' check(state in ('attempting','inline','waiting','queued','stale')),
 outcome text check(outcome in ('synced','human_required')),
 job_id uuid references public.job_queue(id) on delete set null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(organization_id,source_job_id,operation_key)
);
alter table public.google_publication_continuations add column if not exists inbound_message_ids uuid[] not null default '{}';
create index if not exists google_publication_continuations_waiting on public.google_publication_continuations(organization_id,contact_id)
 where state in ('waiting','attempting');
alter table public.google_publication_continuations enable row level security;
drop policy if exists tenant_isolation_google_publication_continuations_all on public.google_publication_continuations;
drop policy if exists tenant_isolation_google_publication_continuations_read on public.google_publication_continuations;
create policy tenant_isolation_google_publication_continuations_read on public.google_publication_continuations
 for select to authenticated using (organization_id in (select public.fn_user_org_ids()));
-- No public write policy or privilege. Native service_role owns state transitions.
revoke all on public.google_publication_continuations from public,anon,authenticated;
grant select,insert,update,delete on public.google_publication_continuations to service_role;

create or replace function public.fn_google_continuation_outcome(p_org uuid,p_id uuid)
returns text language plpgsql stable security definer set search_path=public as $$
declare r public.google_publication_continuations; a public.calendar_appointments; all_ready boolean:=true; failed boolean:=false; k uuid;
begin
 select * into r from public.google_publication_continuations where organization_id=p_org and id=p_id;
 if not found or not public.fn_meet_boundary_current(r.service_boundary)
   or public.fn_autonomous_turn_revoked(p_org,r.source_job_id)
   or exists(select 1 from public.conversation_assignment_events e where e.organization_id=p_org and e.conversation_id=r.conversation_id
     and e.reason in ('claim','transfer') and e.to_user_id is not null and not (e.id=any(r.assignment_claim_ids)))
   or exists(select 1 from public.conversations c join lateral (select e.reason,e.to_user_id from public.conversation_assignment_events e
     where e.organization_id=c.organization_id and e.conversation_id=c.id order by e.created_at desc,e.id desc limit 1) last_assignment on true
     where c.organization_id=p_org and c.id=r.conversation_id and last_assignment.reason in ('claim','transfer')
      and c.assigned_to_user_id=last_assignment.to_user_id)
   or exists(select 1 from (select m.id from public.messages m where m.organization_id=p_org and m.contact_id=r.contact_id
     and m.conversation_id=r.conversation_id and m.direction='inbound' order by m.created_at desc,m.id desc limit 32) recent
     where not (recent.id=any(r.inbound_message_ids)))
   or not exists(select 1 from public.contacts ct where ct.organization_id=p_org and ct.id=r.contact_id and not ct.is_anonymized and not ct.is_blocked and not ct.force_human)
   then return 'stale';end if;
 foreach k in array r.appointment_ids loop
  select * into a from public.calendar_appointments where organization_id=p_org and id=k and contact_id=r.contact_id and conversation_id=r.conversation_id;
  if not found or a.status not in ('pending','confirmed') or a.revision::text is distinct from r.revisions->k::text->>'revision'
    or a.google_local_revision::text is distinct from r.revisions->k::text->>'google_local_revision'
    then return 'stale';end if;
  -- Publication never grants genuine service approval or supplies a missing Meet link.
  if (a.service_occurrence_id is null and a.status='pending') or a.service_requires_confirmation and (a.status<>'confirmed' or a.service_confirmed_by_user_id is null or a.service_confirmed_at is null)
    then return 'stale';end if;
  if a.google_conflict is not null or a.google_sync_failure_kind='human_required' or a.meeting_state='failed' then failed:=true;end if;
  if a.google_event_id is null or a.google_synced_local_revision<>a.google_local_revision or a.needs_google_push
    or a.google_sync_error is not null or a.google_conflict is not null
    or (a.location_kind='google_meet' and (a.meeting_state<>'ready' or a.meeting_url is null)) then all_ready:=false;end if;
 end loop;
 if failed then return 'human_required';elsif all_ready then return 'synced';else return 'waiting';end if;
end $$;

create or replace function public.fn_google_continuation_register(p_org uuid,p_ids uuid[],p_operation text,p_execution jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.google_publication_continuations;j public.job_queue;contact uuid;conv uuid;revs jsonb;request uuid;
begin
 select * into j from public.job_queue where organization_id=p_org and id=(p_execution->'job'->>'id')::uuid;
 if not found or j.kind not in ('inbound_turn','followup_turn','case_reply_turn') or j.contact_id is null
  or not public.fn_calendar_service_execution_current(p_org,j.contact_id,p_execution)
  then raise exception 'google_continuation_execution_stale' using errcode='42501';end if;
 contact:=j.contact_id;conv:=(p_execution->'boundary'->>'conversation_id')::uuid;
 perform public.fn_service_lock(p_org,contact);
 if not public.fn_calendar_service_execution_current(p_org,contact,p_execution) then raise exception 'google_continuation_execution_stale' using errcode='42501';end if;
 if coalesce(array_length(p_ids,1),0)=0 or array_length(p_ids,1)>20 or p_operation is null or length(p_operation)>500
  or (select count(*) from public.calendar_appointments a where a.organization_id=p_org and a.id=any(p_ids) and a.contact_id=contact and a.conversation_id=conv)<>array_length(p_ids,1)
  then raise exception 'google_continuation_scope_invalid' using errcode='42501';end if;
 -- Human approval and explicitly unconfigured Google retain their existing owner.
 if exists(select 1 from public.calendar_appointments a where a.organization_id=p_org and a.id=any(p_ids)
  and (a.status not in ('pending','confirmed') or (a.service_occurrence_id is null and a.status='pending') or (a.service_occurrence_id is not null and a.service_publication_mode='none')
   or (a.service_requires_confirmation and (a.status<>'confirmed' or a.service_confirmed_by_user_id is null or a.service_confirmed_at is null)))) then return null;end if;
 select * into r from public.google_publication_continuations where organization_id=p_org and source_job_id=j.id and operation_key=p_operation;
 if found then
  if r.appointment_ids<>p_ids then raise exception 'google_continuation_idempotency_conflict' using errcode='PT409';end if;
  return jsonb_build_object('id',r.id,'state',r.state);
 end if;
 select jsonb_object_agg(a.id::text,jsonb_build_object('revision',a.revision::text,'google_local_revision',a.google_local_revision::text)) into revs
  from public.calendar_appointments a where a.organization_id=p_org and a.id=any(p_ids);
 if j.kind='inbound_turn' then request:=(j.payload->>'inbound_message_id')::uuid;
 elsif j.kind='case_reply_turn' then select (c.context_snapshot->>'request_message_id')::uuid into request from public.agent_cases c
   where c.organization_id=p_org and c.id::text=j.payload->>'case_id' and c.conversation_id=conv;end if;
 -- Only identifiers of a genuine inbound from this exact request are retained.
 if request is not null and not exists(select 1 from public.messages m where m.organization_id=p_org and m.id=request and m.contact_id=contact and m.conversation_id=conv and m.direction='inbound') then request:=null;end if;
 insert into public.google_publication_continuations(organization_id,contact_id,conversation_id,source_job_id,operation_key,appointment_ids,revisions,service_boundary,agent_operation,request_message_id,assignment_claim_ids,inbound_message_ids)
 values(p_org,contact,conv,j.id,p_operation,p_ids,revs,p_execution->'boundary',p_execution->'agent_operation',request,
  coalesce((select array_agg(e.id) from public.conversation_assignment_events e where e.organization_id=p_org and e.conversation_id=conv
    and e.reason in ('claim','transfer') and e.to_user_id is not null),'{}'::uuid[]),
  coalesce((select array_agg(recent.id) from (select m.id from public.messages m where m.organization_id=p_org and m.contact_id=contact
    and m.conversation_id=conv and m.direction='inbound' order by m.created_at desc,m.id desc limit 32) recent),'{}'::uuid[])) returning * into r;
 return jsonb_build_object('id',r.id,'state',r.state);
end $$;

create or replace function public.fn_google_continuation_enqueue(p_org uuid,p_id uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare r public.google_publication_continuations; result text;event_id uuid;jid uuid;
begin
 select * into r from public.google_publication_continuations where organization_id=p_org and id=p_id;
 if not found then return false;end if;
 perform public.fn_service_lock(p_org,r.contact_id);
 select * into r from public.google_publication_continuations where organization_id=p_org and id=p_id for update;
 if r.state<>'waiting' then return false;end if;
 result:=public.fn_google_continuation_outcome(p_org,p_id);
 if result='stale' then update public.google_publication_continuations set state='stale',updated_at=now() where organization_id=p_org and id=p_id;return true;end if;
 if result='waiting' then return false;end if;
 event_id:=gen_random_uuid();jid:=gen_random_uuid();
 insert into public.event_log(id,organization_id,event_type,entity_kind,entity_id,payload,status)
 values(event_id,p_org,'appointment.google_publication_ready','appointment',r.appointment_ids[1],jsonb_build_object('continuation_id',r.id,'outcome',result),'done');
 insert into public.job_queue(id,organization_id,contact_id,kind,source_event_id,payload,run_after)
 values(jid,p_org,r.contact_id,'google_publication_turn',event_id,jsonb_build_object('continuation_id',r.id,'service_boundary',r.service_boundary),now());
 update public.google_publication_continuations set state='queued',outcome=result,job_id=jid,updated_at=now() where organization_id=p_org and id=p_id;
 insert into public.crm_lead_activities(organization_id,lead_id,contact_id,type,source_module,source_id,actor_kind,reason,payload)
 select p_org,l.lead_id,r.contact_id,'note_added','agenda',r.appointment_ids[1],'system',
  case when result='synced' then 'Reserva publicada no Google; confirmação automática pendente.' else 'Publicação Google precisa de intervenção; atendimento retomado com a causa.' end,
  jsonb_build_object('origin','google_publication','continuation_id',r.id,'job_id',jid,'outcome',result)
 from public.crm_lead_links l where l.organization_id=p_org and l.target_kind='appointment' and l.target_id=r.appointment_ids[1] group by l.lead_id;
 return true;
end $$;

create or replace function public.fn_google_continuation_finish(p_org uuid,p_id uuid,p_source_job uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.google_publication_continuations; result text;
begin
 select * into r from public.google_publication_continuations where organization_id=p_org and id=p_id and source_job_id=p_source_job;
 if not found then raise exception 'google_continuation_not_found' using errcode='42501';end if;
 perform public.fn_service_lock(p_org,r.contact_id);
 select * into r from public.google_publication_continuations where organization_id=p_org and id=p_id for update;
 if r.state in ('inline','waiting','queued') and public.fn_google_continuation_outcome(p_org,p_id)='stale' then
  update public.google_publication_continuations set state='stale',updated_at=now() where organization_id=p_org and id=p_id returning * into r;
 end if;
 if r.state='attempting' then
  result:=public.fn_google_continuation_outcome(p_org,p_id);
  update public.google_publication_continuations set state=case when result in ('synced','human_required') then 'inline' when result='stale' then 'stale' else 'waiting' end,
   outcome=case when result in ('synced','human_required') then result else null end,updated_at=now() where organization_id=p_org and id=p_id returning * into r;
 end if;
 if r.state='waiting' then
  perform public.fn_google_continuation_enqueue(p_org,p_id);
  select * into r from public.google_publication_continuations where organization_id=p_org and id=p_id;
 end if;
 return jsonb_build_object('deferred',r.state in ('waiting','queued','stale'),'state',r.state);
end $$;

create or replace function public.fn_google_continuation_current(p_org uuid,p_job uuid,p_worker text,p_acquired_at timestamptz)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare r public.google_publication_continuations;result text; channel uuid;
begin
 select r0.* into r from public.google_publication_continuations r0 join public.job_queue j on j.organization_id=r0.organization_id and j.id=r0.job_id
 where r0.organization_id=p_org and r0.job_id=p_job and r0.state='queued' and j.kind='google_publication_turn' and j.contact_id=r0.contact_id
  and j.status='running' and j.locked_by=p_worker and j.locked_at=p_acquired_at and not public.fn_autonomous_turn_revoked(p_org,j.id);
 if not found then return null;end if;
 result:=public.fn_google_continuation_outcome(p_org,r.id);
 if result is distinct from r.outcome then return null;end if;
 if r.agent_operation is not null and not exists(select 1 from public.ai_agents a where a.organization_id=p_org and a.id=(r.agent_operation->>'agentId')::uuid
  and a.published_version_id=(r.agent_operation->>'versionId')::uuid and a.operation_revision::text=r.agent_operation->>'revision'
  and a.operation_mode='automatic' and a.paused_at is null and a.archived_at is null) then return null;end if;
 select c.channel_session_id into channel from public.conversations c join public.channel_sessions ch on ch.organization_id=c.organization_id and ch.id=c.channel_session_id
  where c.organization_id=p_org and c.id=r.conversation_id and c.contact_id=r.contact_id and ch.status not in ('STOPPED','FAILED');
 if channel is null then return null;end if;
 return jsonb_build_object('conversation_id',r.conversation_id,'channel_session_id',channel,'outcome',result);
end $$;

create or replace function public.fn_google_continuation_on_publication()
returns trigger language plpgsql security definer set search_path=public as $$
declare r record;
begin
 -- Same contact mutex as booking/Google/claiming. No job lock before the mutex.
 if new.contact_id is null then return new;end if;
 perform public.fn_service_lock(new.organization_id,new.contact_id);
 for r in select id from public.google_publication_continuations where organization_id=new.organization_id and contact_id=new.contact_id
  and new.id=any(appointment_ids) and state='waiting' loop
  perform public.fn_google_continuation_enqueue(new.organization_id,r.id);
 end loop;
 return new;
end $$;
drop trigger if exists trg_google_continuation_on_publication on public.calendar_appointments;
create trigger trg_google_continuation_on_publication after update on public.calendar_appointments
 for each row execute function public.fn_google_continuation_on_publication();

create or replace function public.fn_google_continuation_recover()
returns integer language plpgsql security definer set search_path=public as $$
declare r record;n integer:=0;
begin
 -- Recover crash between registration and handoff, only after the original job exhausted/done.
 -- A running/pending original job retains its inline ownership; no LLM polling job is created.
 for r in select c.id,c.organization_id,c.contact_id from public.google_publication_continuations c
  join public.job_queue j on j.organization_id=c.organization_id and j.id=c.source_job_id
  where c.state='waiting' or (c.state='attempting' and j.status in ('done','dead','failed')) order by c.created_at limit 50 loop
  perform public.fn_service_lock(r.organization_id,r.contact_id);
  update public.google_publication_continuations set state='waiting',updated_at=now() where organization_id=r.organization_id and id=r.id and state='attempting';
  if public.fn_google_continuation_enqueue(r.organization_id,r.id) then n:=n+1;end if;
 end loop;
 return n;
end $$;

revoke all on function public.fn_google_continuation_outcome(uuid,uuid),public.fn_google_continuation_register(uuid,uuid[],text,jsonb),
 public.fn_google_continuation_enqueue(uuid,uuid),public.fn_google_continuation_finish(uuid,uuid,uuid),
 public.fn_google_continuation_current(uuid,uuid,text,timestamptz),public.fn_google_continuation_recover() from public,anon,authenticated;
grant execute on function public.fn_google_continuation_outcome(uuid,uuid),public.fn_google_continuation_register(uuid,uuid[],text,jsonb),
 public.fn_google_continuation_enqueue(uuid,uuid),public.fn_google_continuation_finish(uuid,uuid,uuid),
 public.fn_google_continuation_current(uuid,uuid,text,timestamptz),public.fn_google_continuation_recover() to service_role;
revoke all on function public.fn_google_continuation_on_publication() from public,anon,authenticated,service_role;

-- Existing Google executor and assignment guards, with bounded recovery.
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
  if a.google_sync_failure_kind='human_required' and a.google_next_attempt_at is null then return jsonb_build_object('terminal','human_required');end if;
  if a.google_claim_until>clock_timestamp() then return null;end if;
  if a.google_event_id is null and a.status<>'cancelled' then
   select k.* into c from public.calendar_connection_calendars k join public.calendar_connections x on x.id=k.connection_id and x.organization_id=k.organization_id
    where k.organization_id=p_org and x.user_id=publication_owner
      and case when (a.service_occurrence_id is not null or a.service_block) then k.id=a.service_destination_calendar_id else k.is_destination end;
   if not found or (select count(*) from public.calendar_connection_calendars k join public.calendar_connections x on x.id=k.connection_id and x.organization_id=k.organization_id where k.organization_id=p_org and x.user_id=publication_owner and case when (a.service_occurrence_id is not null or a.service_block) then k.id=a.service_destination_calendar_id else k.is_destination end)<>1 then
    update public.calendar_appointments set google_sync_error='Escolha uma agenda de destino nas configurações.',google_sync_failure_kind='human_required',google_next_attempt_at=null where organization_id=p_org and id=p_id;return null;
   end if;
   if not c.available or c.access_role not in ('owner','writer') then
    update public.calendar_appointments set google_sync_error='A agenda de destino não permite publicação. Confira o acesso nas configurações.',google_sync_failure_kind='human_required',google_next_attempt_at=null where organization_id=p_org and id=p_id;return null;end if;
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
    update public.calendar_appointments set google_sync_error=left(p_args->>'message',200),google_sync_attempts=google_sync_attempts+1,
     google_sync_failure_kind=case when p_args->>'failure_kind'='human_required' or google_sync_attempts>=19 then 'human_required' else 'transient' end,
     google_next_attempt_at=case when p_args->>'failure_kind'='human_required' or google_sync_attempts>=19 then null else now()+interval '15 minutes' end,
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
    update public.calendar_appointments set google_sync_error=null,google_sync_failure_kind=null,google_sync_attempts=0,google_next_attempt_at=now()+interval '15 minutes' where organization_id=p_org and id=p_id;return 'true';
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
     google_sync_error=null,google_sync_failure_kind=null,google_sync_attempts=case when coalesce((result->>'ack')::boolean,false) then 0 else google_sync_attempts end,google_next_attempt_at=now()+interval '5 minutes'
     where organization_id=p_org and id=p_id returning * into a;
   else raise exception 'google_action_invalid' using errcode='22023';end if;
  end if;
 end if;
 return to_jsonb(a)||jsonb_build_object('revision',a.revision::text,'google_local_revision',a.google_local_revision::text,
  'google_synced_local_revision',a.google_synced_local_revision::text,'meeting_allowed_types',(select allowed_conference_types from public.calendar_connection_calendars where organization_id=p_org and connection_id=a.google_connection_id and external_calendar_id=a.google_calendar_id),'claim',jsonb_build_object('token',a.google_claim_token,'epoch',a.google_claim_epoch::text,'lease_until',a.google_claim_until));
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
  new.google_sync_attempts:=0;new.google_sync_failure_kind:=null;
  return new;
 end if;
 decision:=public.fn_calendar_service_can_resolve(old.organization_id,old.id) and public.fn_role_at_least(new.organization_id,'agent') and public.fn_support_write_allowed(new.organization_id)
  and old.google_conflict is not null and new.google_conflict-'resolution'=old.google_conflict-'resolution'
  and new.google_conflict->'resolution'->>'actor_id'=auth.uid()::text
  and new.google_conflict->'resolution'->>'choice' in ('google','local','preserve_remote')
  and old.google_conflict->>'revision'=old.revision::text and old.google_conflict->>'local_revision'=old.google_local_revision::text
  and old.google_conflict->>'etag' is not distinct from old.google_etag;
 if auth.uid() is not null and (row(new.google_synced_at,new.google_sync_error,new.google_sync_attempts,new.google_sync_failure_kind) is distinct from row(old.google_synced_at,old.google_sync_error,old.google_sync_attempts,old.google_sync_failure_kind)
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
 if changed or (auth.uid() is not null and new.google_next_attempt_at is distinct from old.google_next_attempt_at) then new.google_next_attempt_at:=now();new.google_sync_attempts:=0;new.google_sync_failure_kind:=null;new.google_sync_error:=null; end if;
 return new;
end;$$;
create or replace function public.fn_interromper_turnos_ao_assumir()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Distribuir ao responsável não é assumir; handoff é decisão do próprio turno.
  if new.reason not in ('claim', 'transfer') or new.to_user_id is null then return new; end if;
  -- O fato de atribuição deve corresponder ao dono real, na MESMA organização.
  if not exists (select 1 from public.conversations c
    where c.organization_id = new.organization_id and c.id = new.conversation_id
      and c.assigned_to_user_id = new.to_user_id) then return new; end if;
  -- O fluxo tem escrita interna própria: a sessão humana não pode cancelar seu
  -- job. Guarda um fato terminal para o worker descartar sob a sua autoridade.
  -- Não usa created_at >= locked_at: now() é o início da transação da tomada,
  -- que pode ter começado ANTES da aquisição do lease que está sendo revogado.
  insert into public.event_log (organization_id, event_type, entity_kind, entity_id, payload, status)
    select new.organization_id, 'conversation.autonomous_turn_revoked', 'job', j.id,
      jsonb_build_object('conversation_id', new.conversation_id, 'assignment_event_id', new.id), 'done'
    from public.job_queue j
    where j.organization_id = new.organization_id and j.kind in ('followup_turn','google_publication_turn') and j.status = 'running'
      and j.payload->'service_boundary'->>'conversation_id' = new.conversation_id::text
      and j.payload->'service_boundary'->>'organization_id' = new.organization_id::text
      and j.contact_id = (select c.contact_id from public.conversations c
        where c.organization_id = new.organization_id and c.id = new.conversation_id);
  update public.job_queue j
     set status = 'failed', locked_by = null, locked_at = null,
         last_error = 'conversation_command_taken'
   where j.organization_id = new.organization_id
     and j.payload->'service_boundary'->>'conversation_id' = new.conversation_id::text
     and j.payload->'service_boundary'->>'organization_id' = new.organization_id::text
     and j.contact_id = (select c.contact_id from public.conversations c
       where c.organization_id = new.organization_id and c.id = new.conversation_id)
     and j.kind in ('inbound_turn', 'case_reply_turn','google_publication_turn')
     and j.status in ('pending', 'running');
  -- O worker encerra só o turno de follow-up revogado, não a inscrição nem sua política.
  -- transactional_delivery, approved_reply e operator_turn não têm este dono.
  return new;
end;
$$;

-- Read-only projection: a member can resolve only the request already visible
-- in its own conversation. Internal boundary/lease metadata remains private.
create or replace function public.fn_google_continuation_request_message(p_org uuid,p_contact uuid,p_conversation uuid,p_job uuid)
returns uuid language plpgsql stable security definer set search_path=public as $$
begin
 if auth.uid() is not null or current_setting('role',true)='authenticated' then
  if auth.uid() is null or not (p_org in (select public.fn_user_org_ids())) then return null;end if;
 end if;
 return (select c.request_message_id from public.google_publication_continuations c
  join public.job_queue j on j.organization_id=c.organization_id and j.id=c.job_id and j.kind='google_publication_turn' and j.contact_id=c.contact_id
  join public.messages m on m.organization_id=c.organization_id and m.id=c.request_message_id and m.contact_id=c.contact_id and m.conversation_id=c.conversation_id and m.direction='inbound'
  where c.organization_id=p_org and c.contact_id=p_contact and c.conversation_id=p_conversation and c.job_id=p_job);
end $$;
revoke all on function public.fn_google_continuation_request_message(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_google_continuation_request_message(uuid,uuid,uuid,uuid) to authenticated,service_role;
-- Same anonymization transition used by both native LGPD entry points.
-- Technical continuation metadata contains no body; revoke and redact the new job.
create or replace function public.fn_google_publication_redact_contact()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.is_anonymized and not old.is_anonymized then
  update public.job_queue set payload='{}'::jsonb,status='failed',locked_by=null,locked_at=null,
   last_error='contact_anonymized'
   where organization_id=new.organization_id and contact_id=new.id and kind='google_publication_turn';
 end if;
 return new;
end $$;
revoke all on function public.fn_google_publication_redact_contact() from public,anon,authenticated;
grant execute on function public.fn_google_publication_redact_contact() to service_role;
drop trigger if exists trg_google_publication_redact_contact on public.contacts;
create trigger trg_google_publication_redact_contact after update of is_anonymized on public.contacts
 for each row execute function public.fn_google_publication_redact_contact();

notify pgrst,'reload schema';


-- Recuperação idempotente: reconhecimento Google, contenção e pedido atual.
-- manifest: Reconhecer publicação sem esperar nota auxiliar e retomar a mesma reserva com o pedido atual.
-- Consolida a recuperação já validada na 0718 pública ainda em revisão.
-- Sem dados empresariais ou inscrição retroativa de compromissos.

create or replace function public.fn_google_continuation_enqueue(p_org uuid,p_id uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare r public.google_publication_continuations;result text;event_id uuid;jid uuid;
begin
 select * into r from public.google_publication_continuations where organization_id=p_org and id=p_id;
 if not found then return false;end if;
 -- A producer may hold calendar inventory. Never wait on the contact mutex
 -- here: the durable waiting row is retried by the existing recovery cron.
 if not pg_try_advisory_xact_lock(hashtextextended(p_org::text||':'||r.contact_id::text,222)) then return false;end if;
 select * into r from public.google_publication_continuations where organization_id=p_org and id=p_id for update;
 if r.state<>'waiting' then return false;end if;
 result:=public.fn_google_continuation_outcome(p_org,p_id);
 if result='stale' then update public.google_publication_continuations set state='stale',updated_at=now() where organization_id=p_org and id=p_id;return true;end if;
 if result='waiting' then return false;end if;
 -- Both the job and timeline have contact FKs. Do not wait with the calendar
 -- inventory mutex held. Keep the durable waiting receipt for native recovery.
 begin
  perform 1 from public.contacts where organization_id=p_org and id=r.contact_id for key share nowait;
 exception when lock_not_available then return false;
 end;
 event_id:=gen_random_uuid();jid:=gen_random_uuid();
 insert into public.event_log(id,organization_id,event_type,entity_kind,entity_id,payload,status)
 values(event_id,p_org,'appointment.google_publication_ready','appointment',r.appointment_ids[1],jsonb_build_object('continuation_id',r.id,'outcome',result),'done');
 insert into public.job_queue(id,organization_id,contact_id,kind,source_event_id,payload,run_after)
 values(jid,p_org,r.contact_id,'google_publication_turn',event_id,jsonb_build_object('continuation_id',r.id,'service_boundary',r.service_boundary),now());
 update public.google_publication_continuations set state='queued',outcome=result,job_id=jid,updated_at=now() where organization_id=p_org and id=p_id;
 -- The event/job is the atomic durable audit. A contact/lead FK for an auxiliary
 -- timeline note must not undo an already acknowledged remote write or hold
 -- the calendar inventory mutex. The leased native job writes the note later.
 return true;
end $$;

create or replace function public.fn_google_continuation_activity(p_org uuid,p_job uuid,p_worker text,p_acquired_at timestamptz)
returns boolean language plpgsql security definer set search_path=public as $$
declare r public.google_publication_continuations;
begin
 if public.fn_google_continuation_current(p_org,p_job,p_worker,p_acquired_at) is null then return false;end if;
 select * into r from public.google_publication_continuations where organization_id=p_org and job_id=p_job and state='queued';
 if not found then return false;end if;
 if not pg_try_advisory_xact_lock(hashtextextended(p_org::text||':'||r.contact_id::text,222)) then
  raise exception 'google_continuation_activity_busy' using errcode='55P03';end if;
 -- No waiting behind an operator while holding the publication transaction.
 -- A busy note is retried by the native job; publication is already committed.
 perform 1 from public.contacts where organization_id=p_org and id=r.contact_id for key share nowait;
 perform 1 from public.crm_leads l where l.organization_id=p_org and l.id in
  (select k.lead_id from public.crm_lead_links k where k.organization_id=p_org and k.target_kind='appointment' and k.target_id=r.appointment_ids[1])
  order by l.id for key share nowait;
 if public.fn_google_continuation_current(p_org,p_job,p_worker,p_acquired_at) is null then return false;end if;
 insert into public.crm_lead_activities(organization_id,lead_id,contact_id,type,source_module,source_id,actor_kind,reason,payload)
 select p_org,k.lead_id,r.contact_id,'note_added','agenda',r.appointment_ids[1],'system',
  case when r.outcome='synced' then 'Reserva publicada no Google; confirmação automática pendente.' else 'Publicação Google precisa de intervenção; atendimento retomado com a causa.' end,
  jsonb_build_object('origin','google_publication','continuation_id',r.id,'job_id',p_job,'outcome',r.outcome)
 from public.crm_lead_links k where k.organization_id=p_org and k.target_kind='appointment' and k.target_id=r.appointment_ids[1]
  and not exists(select 1 from public.crm_lead_activities a where a.organization_id=p_org and a.lead_id=k.lead_id
   and a.source_module='agenda' and a.source_id=r.appointment_ids[1] and a.payload->>'continuation_id'=r.id::text)
 group by k.lead_id;
 return true;
end $$;

create or replace function public.fn_google_continuation_resume(p_org uuid,p_ids uuid[],p_execution jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare j public.job_queue;r public.google_publication_continuations;registered jsonb;result jsonb;k uuid;
begin
 select * into j from public.job_queue where organization_id=p_org and id=(p_execution->'job'->>'id')::uuid;
 if not found or j.kind<>'inbound_turn' or not public.fn_calendar_service_execution_current(p_org,j.contact_id,p_execution)
  then raise exception 'google_continuation_execution_stale' using errcode='42501';end if;
 perform public.fn_service_lock(p_org,j.contact_id);
 if not public.fn_calendar_service_execution_current(p_org,j.contact_id,p_execution)
  then raise exception 'google_continuation_execution_stale' using errcode='42501';end if;
 if coalesce(cardinality(p_ids),0)=0 or cardinality(p_ids)>20 or
  cardinality(p_ids)<>(select count(distinct x) from unnest(p_ids) x) then
  raise exception 'google_continuation_scope_invalid' using errcode='42501';end if;
 -- Only a prior, unchanged reservation from this conversation/demand. A model
 -- cannot enroll an unrelated appointment or revive a revoked human handoff.
 select c.* into r from public.google_publication_continuations c
 where c.organization_id=p_org and c.contact_id=j.contact_id and c.conversation_id=(p_execution->'boundary'->>'conversation_id')::uuid
  and c.appointment_ids=p_ids and c.state in ('attempting','waiting','stale')
  and public.fn_meet_boundary_current(c.service_boundary)
  and not public.fn_autonomous_turn_revoked(p_org,c.source_job_id)
  and not exists(select 1 from public.conversation_assignment_events e where e.organization_id=p_org and e.conversation_id=c.conversation_id
   and e.reason in ('claim','transfer') and e.to_user_id is not null and not(e.id=any(c.assignment_claim_ids)))
 order by c.created_at desc,c.id desc limit 1;
 if not found then return jsonb_build_object('resumed',false,'reason','no_current_publication_recovery');end if;
 foreach k in array p_ids loop
  if not exists(select 1 from public.calendar_appointments a where a.organization_id=p_org and a.id=k and a.contact_id=j.contact_id
   and a.conversation_id=r.conversation_id and a.status='confirmed'
   and a.revision::text=r.revisions->k::text->>'revision' and a.google_local_revision::text=r.revisions->k::text->>'google_local_revision'
   and (not coalesce(a.service_requires_confirmation,false) or (a.service_confirmed_by_user_id is not null and a.service_confirmed_at is not null)))
   then return jsonb_build_object('resumed',false,'reason','reservation_changed_or_human_required');end if;
 end loop;
 -- Keep the old request stale; register captures the current message, lease,
 -- boundary, assignments and agent operation. No old authority is reused.
 update public.google_publication_continuations c set state='stale',updated_at=now()
 where c.organization_id=p_org and c.contact_id=j.contact_id and c.appointment_ids=p_ids and c.source_job_id<>j.id
  and c.state in ('attempting','waiting','queued') and public.fn_google_continuation_outcome(p_org,c.id)='stale';
 registered:=public.fn_google_continuation_register(p_org,p_ids,'resume:'||array_to_string(p_ids,','),p_execution);
 if registered is null then return jsonb_build_object('resumed',false,'reason','reservation_changed_or_human_required');end if;
 result:=public.fn_google_continuation_finish(p_org,(registered->>'id')::uuid,j.id);
 return result||jsonb_build_object('resumed',true);
end $$;

revoke all on function public.fn_google_continuation_enqueue(uuid,uuid),public.fn_google_continuation_activity(uuid,uuid,text,timestamptz),
 public.fn_google_continuation_resume(uuid,uuid[],jsonb) from public,anon,authenticated;
grant execute on function public.fn_google_continuation_enqueue(uuid,uuid),public.fn_google_continuation_activity(uuid,uuid,text,timestamptz),
 public.fn_google_continuation_resume(uuid,uuid[],jsonb) to service_role;

-- Read-only coordination of a sentiment alert with the current inbound turn.
-- A pending publication alone cannot suppress a legitimate handoff. Only the
-- explicit native resume action owns this exception; otherwise defer briefly
-- for the current turn and fall back to the unchanged sentiment policy.
create or replace function public.fn_google_publication_sentiment_context(p_org uuid,p_conversation uuid,p_message uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare m public.messages;v public.conversations;r public.google_publication_continuations;j public.job_queue;
begin
 select * into v from public.conversations where organization_id=p_org and id=p_conversation;
 if not found or v.status in ('closed','claimed') or v.assigned_to_user_id is not null
  or v.bot_silenced_until>now() then return null;end if;
 select * into m from public.messages where organization_id=p_org and conversation_id=v.id and id=p_message
  and contact_id=v.contact_id and direction='inbound' and service_revision=v.service_revision
  and (demanda_id is not distinct from v.current_demanda_id or demanda_id is null);
 if not found or exists(select 1 from public.messages newer where newer.organization_id=p_org and newer.conversation_id=v.id
  and newer.contact_id=v.contact_id and newer.direction='inbound' and (newer.created_at,newer.id)>(m.created_at,m.id))
  or not exists(select 1 from public.contacts c where c.organization_id=p_org and c.id=v.contact_id
  and not c.is_anonymized and not c.is_blocked and not c.force_human) then return null;end if;
 select * into j from public.job_queue where organization_id=p_org and contact_id=v.contact_id and kind='inbound_turn'
  and payload->>'inbound_message_id'=m.id::text and payload->>'conversation_id'=v.id::text
  order by created_at desc,id desc limit 1;
 if not found or public.fn_autonomous_turn_revoked(p_org,j.id) then return null;end if;
 select c.* into r from public.google_publication_continuations c
 where c.organization_id=p_org and c.contact_id=v.contact_id and c.conversation_id=v.id
  and public.fn_meet_boundary_current(c.service_boundary)
  and not public.fn_autonomous_turn_revoked(p_org,c.source_job_id)
  and not exists(select 1 from public.conversation_assignment_events e where e.organization_id=p_org and e.conversation_id=v.id
   and e.reason in ('claim','transfer') and e.to_user_id is not null and not(e.id=any(c.assignment_claim_ids)))
  and not exists(select 1 from unnest(c.appointment_ids) k where not exists(
   select 1 from public.calendar_appointments a where a.organization_id=p_org and a.id=k and a.contact_id=v.contact_id
    and a.conversation_id=v.id and a.status='confirmed'
    and a.revision::text=c.revisions->k::text->>'revision' and a.google_local_revision::text=c.revisions->k::text->>'google_local_revision'
    and a.google_conflict is null and a.google_sync_failure_kind is distinct from 'human_required' and a.meeting_state<>'failed'
    and (not coalesce(a.service_requires_confirmation,false) or (a.service_confirmed_by_user_id is not null and a.service_confirmed_at is not null))))
  and ((c.source_job_id=j.id and c.request_message_id=m.id and c.operation_key like 'resume:%' and c.state in ('attempting','inline','waiting','queued'))
    or (c.source_job_id<>j.id and c.created_at<=m.created_at and c.state in ('attempting','waiting','stale')))
 order by (c.source_job_id=j.id) desc,c.created_at desc,c.id desc limit 1;
 if not found then return null;end if;
 if r.source_job_id=j.id then return jsonb_build_object('owned',true);end if;
 -- Finite, database-clock deadline. No new job or LLM poll is introduced.
 if j.status in ('pending','running') and j.created_at+interval '2 minutes'>now() then
  return jsonb_build_object('owned',false,'wait_until',j.created_at+interval '2 minutes');end if;
 return null;
end $$;
revoke all on function public.fn_google_publication_sentiment_context(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_google_publication_sentiment_context(uuid,uuid,uuid) to service_role;

create or replace function public.fn_google_continuation_on_publication()
returns trigger language plpgsql security definer set search_path=public as $$
declare r record;
begin
 -- Acknowledgement may hold calendar inventory; leave waiting recovery on contention.
 if new.contact_id is null then return new;end if;
 if not pg_try_advisory_xact_lock(hashtextextended(new.organization_id::text||':'||new.contact_id::text,222)) then return new;end if;
 for r in select id from public.google_publication_continuations where organization_id=new.organization_id and contact_id=new.contact_id
  and new.id=any(appointment_ids) and state='waiting' loop
  perform public.fn_google_continuation_enqueue(new.organization_id,r.id);
 end loop;
 return new;
end $$;
revoke all on function public.fn_google_continuation_on_publication() from public,anon,authenticated;
grant execute on function public.fn_google_continuation_on_publication() to service_role;

create or replace function public.fn_meet_delivery_enqueue()
returns trigger language plpgsql security definer set search_path=public as $$
declare jid uuid; b jsonb;
begin
 -- No delivery action was enrolled: the existing path returns without effects.
 -- Evaluate that same idle guard BEFORE locking contact while Google ack may
 -- hold calendar inventory. Enrolled Meet/non-Meet deliveries, failures and
 -- cancellation keep their original mutex, guards and queue behavior.
 if new.status<>'cancelled' and new.meeting_state not in ('cancelled','failed')
  and coalesce(new.meeting_delivery->>'state','') not in ('blocked','stale')
  and ((new.location_kind='google_meet' and new.meeting_state<>'ready')
    or new.meeting_delivery->>'state'<>'waiting_for_link') then return new;end if;
 -- A MESMA ORDEM DE TRAVA das ~20 irmãs: contato PRIMEIRO, job_queue depois.
 -- Sem esta linha, este gatilho já segurava a linha do compromisso (é BEFORE/
 -- AFTER na própria calendar_appointments) e ia travar job_queue sem o mutex do
 -- contato, enquanto fn_meet_redact_contact (0229) pega o mutex do contato e só
 -- então mexe em job_queue. Duas ordens opostas sobre os mesmos dois recursos =
 -- deadlock (40P01) sob concorrência, e quem paga é o cliente com anonimização
 -- LGPD acontecendo enquanto um link de reunião é entregue.
 perform public.fn_service_lock(new.organization_id,new.contact_id);
 -- ⚠️ `status` ENTRA AQUI, e a falta dele era um buraco REAL que só apareceu
 -- ao abrir a entrega para compromisso sem Meet.
 --
 -- A guarda olhava só `meeting_state='cancelled'` — o estado do LINK, não do
 -- compromisso. Enquanto a entrega exigia link pronto isso bastava por
 -- acidente: cancelar o compromisso cancelava o link junto. Sem Meet não há
 -- link para cancelar, e um compromisso CANCELADO passava a enfileirar
 -- entrega. O porteiro do envio recusaria depois (`a.status<>'cancelled'`),
 -- então o cliente não receberia nada — mas o job nasceria para morrer
 -- bloqueado, e a tela mostraria uma entrega a caminho que nunca sai.
 --
 -- Achado do @paulolimajr77, e foi o teste DELE que o pegou aqui.
 if new.status='cancelled' or new.meeting_state='cancelled' or new.meeting_delivery->>'state' in ('blocked','stale') then
  update public.job_queue set status='failed',locked_at=null,locked_by=null,payload='{}',last_error='meet_delivery_stale'
   where organization_id=new.organization_id and id=new.meeting_delivery_job_id and kind='transactional_delivery' and status in ('pending','running');
  return new;
 end if;
 if new.meeting_state='failed' then perform public.fn_meet_notice(new.organization_id,new.id,'meeting_failed');end if;
 -- ⛔ ESPERAR O LINK VALE SÓ ONDE O LOCAL É O MEET.
 --
 -- Esta é a exigência mais fácil de esquecer e a pior de esquecer: num
 -- compromisso PRESENCIAL o `meeting_state` é `not_requested` para sempre,
 -- então a entrega era autorizada, o gatilho passava por aqui, devolvia sem
 -- enfileirar nada, e a entrega ficava em `waiting_for_link` PARA SEMPRE — em
 -- silêncio, sem job, sem aviso e sem erro. Foi o teste do autor que a achou.
 --
 -- Onde o local É o Meet, nada muda: sem link pronto não sai job, porque
 -- mandar uma reunião sem como entrar nela é pior que não mandar.
 if (new.location_kind='google_meet' and new.meeting_state<>'ready')
  or new.meeting_delivery->>'state'<>'waiting_for_link' then return new;end if;
 b:=new.meeting_delivery->'service_boundary';
 if not public.fn_meet_boundary_current(b) then
  update public.calendar_appointments set meeting_delivery=meeting_delivery||'{"state":"stale","error":"service_boundary_stale"}' where organization_id=new.organization_id and id=new.id;
  perform public.fn_meet_notice(new.organization_id,new.id,'service_boundary_stale');return new;
 end if;
 jid:=gen_random_uuid();
 insert into public.job_queue(id,organization_id,contact_id,kind,payload,run_after)
 values(jid,new.organization_id,new.contact_id,'transactional_delivery',jsonb_build_object('appointment_id',new.id,'meeting_request_id',new.meeting_request_id,
  'delivery_generation',new.meeting_delivery->>'generation','service_boundary',b,
  -- O MOTIVO decide a FRASE que o cliente lê. Ausente = `primeiro_envio`,
  -- que é o comportamento de antes desta migration e o certo para toda
  -- entrega que já estava na fila quando ela foi aplicada.
  'motivo',coalesce(new.meeting_delivery->>'motivo','primeiro_envio')),
  -- ANTIRREPETIÇÃO: a correção ESPERA antes de sair, e uma remarcação nova
  -- dentro da janela substitui esta. Sem a espera, arrastar o compromisso na
  -- grade viraria uma mensagem por arrasto.
  coalesce((new.meeting_delivery->>'nao_antes_de')::timestamptz, now()));
 update public.calendar_appointments set meeting_delivery_job_id=jid,meeting_delivery=meeting_delivery||'{"state":"queued"}'
  where organization_id=new.organization_id and id=new.id;
 return new;
end;$$;
revoke all on function public.fn_meet_delivery_enqueue() from public,anon,authenticated;
grant execute on function public.fn_meet_delivery_enqueue() to service_role;
