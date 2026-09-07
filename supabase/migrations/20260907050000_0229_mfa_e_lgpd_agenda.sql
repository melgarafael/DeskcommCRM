-- 0229 — MFA das ações humanas e ordem LGPD/agenda.
-- Forward independente de 0227/0228; helpers privados de 0222/0226 preservados.

create or replace function public.fn_appointment_change_core(p_org uuid,p_id uuid,p_revision bigint,p_patch jsonb,p_remote boolean,p_base jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; contact uuid; origin jsonb; event_id uuid;
begin
 if p_remote and (auth.uid() is not null or (p_patch-'starts_at'-'ends_at'-'time_zone'-'status'-'cancellation_reason')<>'{}'::jsonb or coalesce(p_patch->>'status','cancelled')<>'cancelled') then raise exception 'google_patch_forbidden' using errcode='42501';end if;
 if auth.uid() is not null and (not public.fn_role_at_least(p_org,'agent') or not public.fn_support_write_allowed(p_org)) then raise exception 'appointment_forbidden' using errcode='42501'; end if;
 if auth.uid() is not null and not public.fn_session_mfa_proven() then raise exception 'appointment_mfa_required' using errcode='42501';end if;
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

create or replace function public.fn_agenda_settings(p_org uuid,p_config jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'manager') or not public.fn_support_write_allowed(p_org) then raise exception 'agenda_settings_forbidden' using errcode='42501'; end if;
 if not public.fn_session_mfa_proven() then raise exception 'agenda_mfa_required' using errcode='42501';end if;
 if jsonb_typeof(p_config->'confirmation_delay_minutes') is distinct from 'number' or jsonb_typeof(p_config->'unknown_protection_minutes') is distinct from 'number'
  or (p_config-'confirmation_delay_minutes'-'unknown_protection_minutes')<>'{}'::jsonb
  or (p_config->>'confirmation_delay_minutes' ~ '^[0-9]{1,5}$') is not true or (p_config->>'unknown_protection_minutes' ~ '^[0-9]{1,5}$') is not true
  or (p_config->>'confirmation_delay_minutes')::int not between 1 and 10080
  or (p_config->>'unknown_protection_minutes')::int not between 1 and 10080
  or (p_config->>'unknown_protection_minutes')::int < (p_config->>'confirmation_delay_minutes')::int
 then raise exception 'agenda_settings_invalid' using errcode='22023'; end if;
 update public.organizations set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{agenda}',p_config,true) where id=p_org;
 if not found then raise exception 'organization_not_found' using errcode='P0002'; end if;
 return p_config;
end; $$;

create or replace function public.fn_google_selection(p_org uuid,p_revisions jsonb,p_sources uuid[],p_destination uuid)
returns void language plpgsql security definer set search_path=public as $$
declare actor uuid:=auth.uid(); expected jsonb; actual jsonb;
begin
 if actor is null or not public.fn_role_at_least(p_org,'agent') or not public.fn_support_write_allowed(p_org) then raise exception 'google_selection_forbidden' using errcode='42501';end if;
 if not public.fn_session_mfa_proven() then raise exception 'google_mfa_required' using errcode='42501';end if;
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

create or replace function public.fn_google_resolve(p_org uuid,p_id uuid,p_revision text,p_local_revision text,p_etag text,p_choice text)
returns void language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; contact uuid;
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'agent') or not public.fn_support_write_allowed(p_org) then raise exception 'google_resolution_forbidden' using errcode='42501';end if;
 if not public.fn_session_mfa_proven() then raise exception 'google_mfa_required' using errcode='42501';end if;
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

-- Assinaturas e concessões das portas existentes não mudam.
revoke all on function public.fn_appointment_change_core(uuid,uuid,bigint,jsonb,boolean,jsonb) from public,anon,authenticated;
revoke all on function public.fn_agenda_settings(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.fn_agenda_settings(uuid,jsonb) to authenticated;
revoke all on function public.fn_google_selection(uuid,jsonb,uuid[],uuid) from public,anon;
grant execute on function public.fn_google_selection(uuid,jsonb,uuid[],uuid) to authenticated;
revoke all on function public.fn_google_resolve(uuid,uuid,text,text,text,text) from public,anon;
grant execute on function public.fn_google_resolve(uuid,uuid,text,text,text,text) to authenticated;

create or replace function public.fn_meet_redact_contact()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 perform public.fn_service_lock(new.organization_id,new.id);
 update public.job_queue set payload='{}',status=case when status in ('pending','running') then 'failed' else status end,
  locked_by=null,locked_at=null,last_error='meet_contact_redacted'
  where organization_id=new.organization_id and contact_id=new.id and kind='transactional_delivery';
 update public.agent_inbox_items set status='resolved',resolved_at=now(),body='Contato anonimizado.',ref_id=null
  where organization_id=new.organization_id and ref_kind='appointment' and ref_id in(select id from public.calendar_appointments where organization_id=new.organization_id and contact_id=new.id) and kind in ('other','appointment_outcome_required','appointment_recovery_review');
 update public.calendar_appointments set meeting_url=null,meeting_request_id=null,meeting_requested_at=null,meeting_received_at=null,meeting_last_error=null,
  meeting_next_attempt_at=null,meeting_delivery='{"state":"blocked"}',meeting_delivery_job_id=null
  where organization_id=new.organization_id and contact_id=new.id;
 return new;
end;$$;

revoke all on function public.fn_meet_redact_contact() from public,anon,authenticated;

create or replace function public.fn_appointment_recover(p_org uuid,p_event uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public.event_log; a public.calendar_appointments; r public.appointment_recovery_receipts;
 contact uuid; rev bigint; result text; candidates uuid[]; pointer uuid; agent uuid; version uuid; node text; boundary jsonb; enrollment uuid;
begin
 select * into e from public.event_log where organization_id=p_org and id=p_event and event_type='appointment.outcome_confirmed' and entity_kind='appointment';
 if not found then raise exception 'appointment_source_event_missing' using errcode='P0002'; end if;
 rev:=(e.payload->>'appointment_revision')::bigint;
 select contact_id into contact from public.calendar_appointments where organization_id=p_org and id=e.entity_id;
 if not found then raise exception 'appointment_not_found' using errcode='P0002'; end if;
 if contact is not null then perform public.fn_service_lock(p_org,contact); end if;
 select * into a from public.calendar_appointments where organization_id=p_org and id=e.entity_id for update;
 if a.contact_id is distinct from contact then raise exception 'appointment_stale' using errcode='40001'; end if;
 select * into r from public.appointment_recovery_receipts where organization_id=p_org and appointment_id=a.id and appointment_revision=rev;
 if found then return to_jsonb(r); end if;
 result:=case when contact is null then 'no_contact' when a.revision<>rev or a.status<>'no_show' or a.outcome_recorded_at is null

  or not exists(select 1 from public.contacts where organization_id=p_org and id=contact and not is_anonymized and is_merged_into is null and not is_blocked)
  then 'stale' else null end;
 if result is null then
  select array_agg(p.id) into candidates from public.followup_flow_pointers p
   where p.organization_id=p_org and p.status='active' and p.active_version_id is not null and p.trigger_config->>'kind'='appointment_no_show'
    and (coalesce(jsonb_array_length(p.trigger_config->'params'->'event_type_ids'),0)=0 or p.trigger_config->'params'->'event_type_ids' ? a.event_type_id::text)
    and exists(select 1 from public.ai_agent_versions v where v.organization_id=p_org and v.status='published'
     and v.followup->'enabled'='true'::jsonb and v.followup->'flow_pointer_ids' ? p.id::text);
  result:=case when coalesce(cardinality(candidates),0)=0 then 'not_configured' when cardinality(candidates)>1 then 'ambiguous' else null end;
 end if;
 if result is null and exists(select 1 from public.followup_enrollments where organization_id=p_org and contact_id=contact and status in ('active','waiting_reply','paused_handoff','paused_manual')) then result:='other_flow'; end if;
 if result is null then
  pointer:=candidates[1];
  select active_version_id into version from public.followup_flow_pointers where organization_id=p_org and id=pointer and status='active' for share;
  -- Precedência de AGENTES já canônica em resolveAgentForAutomaticTrigger.
  select agent_id into agent from public.ai_agent_versions where organization_id=p_org and status='published'
   and followup->'enabled'='true'::jsonb and followup->'flow_pointer_ids' ? pointer::text order by agent_id limit 1;
  select n->>'id' into node from public.followup_flow_versions v cross join lateral jsonb_array_elements(v.graph->'nodes') n
   where v.organization_id=p_org and v.id=version and n->>'type'='trigger';
  if version is null or agent is null or node is null then raise exception 'appointment_flow_changed' using errcode='40001'; end if;
  begin
   boundary:=public.fn_service_event_origin(p_org,p_event,contact,
    (select channel_session_id from public.conversations where organization_id=p_org and id=a.conversation_id and contact_id=contact));
  exception when serialization_failure then result:='stale'; end;
  if result is null then
   begin
    insert into public.followup_enrollments(organization_id,pointer_id,version_id,contact_id,conversation_id,agent_id,current_node_id,service_boundary,
     appointment_id,appointment_revision)
    values(p_org,pointer,version,contact,(boundary->>'conversation_id')::uuid,agent,node,boundary,a.id,a.revision) returning id into enrollment;
    insert into public.followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,idempotency_key)
     values(p_org,enrollment,node,'enrolled',jsonb_build_object('trigger_kind','appointment_no_show','appointment_id',a.id,'appointment_revision',a.revision),'appointment:'||a.id||':'||a.revision);
    result:='started';
   exception when unique_violation then result:='other_flow'; end;
  end if;
 end if;
 insert into public.appointment_recovery_receipts(organization_id,appointment_id,appointment_revision,source_event_id,result,pointer_id,enrollment_id)
  values(p_org,a.id,rev,p_event,result,pointer,enrollment) returning * into r;
 if result<>'started' and not exists(select 1 from public.contacts where organization_id=p_org and id=contact and is_anonymized) then
  insert into public.agent_inbox_items(organization_id,kind,severity,title,body,ref_kind,ref_id,appointment_revision)
   values(p_org,'appointment_recovery_review','warn','A recuperação não foi iniciada',
    case result when 'other_flow' then 'Este contato já tem outro acompanhamento. Revise o próximo passo; nenhuma recuperação ficou aguardando vaga.'
     when 'ambiguous' then 'Mais de um fluxo atende a esta falta. Deixe apenas um configurado ou escolha manualmente o próximo passo.'
     when 'not_configured' then 'Configure um fluxo de recuperação e habilite-o em um assistente publicado. Esta falta não será iniciada retroativamente.'
     else 'O contexto mudou ou não há contato vinculado. Abra o compromisso e escolha o próximo passo.' end,'appointment',a.id,rev)
   on conflict(organization_id,ref_id,appointment_revision,kind) where ref_kind='appointment' and appointment_revision is not null do nothing;
 end if;
 return to_jsonb(r);
end; $$;

revoke all on function public.fn_appointment_recover(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_appointment_recover(uuid,uuid) to service_role;

create or replace function public.fn_meet_notice(p_org uuid,p_id uuid,p_reason text)
returns void language plpgsql security definer set search_path=public as $$
declare contact uuid;
begin
 select contact_id into contact from public.calendar_appointments where organization_id=p_org and id=p_id;
 -- Pode vir de trigger com row lock: nunca esperar por advisory tardio.
 if contact is not null and not pg_try_advisory_xact_lock(hashtextextended(p_org::text||':'||contact::text,222)) then
  raise exception 'appointment_notice_busy' using errcode='40001';
 end if;
 insert into public.agent_inbox_items(organization_id,kind,severity,title,body,ref_kind,ref_id,appointment_revision)
 select p_org,'other','warn','Link da reunião precisa de atenção',
  'Abra o compromisso na Agenda para verificar o link ou autorizar uma nova entrega.','appointment',id,revision
 from public.calendar_appointments where organization_id=p_org and id=p_id
  and contact_id is not distinct from contact
  and not exists(select 1 from public.contacts c where c.organization_id=p_org and c.id=contact and c.is_anonymized)
 on conflict(organization_id,ref_id,appointment_revision,kind) where ref_kind='appointment' and appointment_revision is not null
 do update set status='open',resolved_at=null,body=excluded.body;
end;$$;

revoke all on function public.fn_meet_notice(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fn_meet_notice(uuid,uuid,text) to service_role;

create or replace function public.fn_appointment_confirmation_sweep(p_limit int default 100,p_now timestamptz default now())
returns int language plpgsql security definer set search_path=public as $$
declare a record; candidate record; n int:=0; expired boolean;
begin
 -- Escolhe o mesmo lote vencido e obtém mutexes em ordem, sem row lock prévio.
 for candidate in select * from (
  select c.id,c.organization_id,c.contact_id,c.ends_at
  from public.calendar_appointments c join public.organizations o on o.id=c.organization_id
  where c.status in ('pending','confirmed')
   and c.ends_at+make_interval(mins=>public.fn_agenda_minutes(o.settings,'confirmation_delay_minutes',10))<=p_now
   and (c.confirmation_next_at is null or c.confirmation_next_at<=p_now)
   and not exists(select 1 from public.contacts ct where ct.organization_id=c.organization_id and ct.id=c.contact_id and ct.is_anonymized)
  order by c.ends_at,c.id limit greatest(1,least(p_limit,500))
 ) due order by organization_id,contact_id,id
 loop
  if candidate.contact_id is not null and not pg_try_advisory_xact_lock(hashtextextended(candidate.organization_id::text||':'||candidate.contact_id::text,222)) then continue;end if;
  select c.*,o.settings into a from public.calendar_appointments c join public.organizations o on o.id=c.organization_id
   where c.id=candidate.id and c.organization_id=candidate.organization_id and c.contact_id is not distinct from candidate.contact_id
    and c.status in ('pending','confirmed')
    and c.ends_at+make_interval(mins=>public.fn_agenda_minutes(o.settings,'confirmation_delay_minutes',10))<=p_now
    and (c.confirmation_next_at is null or c.confirmation_next_at<=p_now)
    and not exists(select 1 from public.contacts ct where ct.organization_id=c.organization_id and ct.id=c.contact_id and ct.is_anonymized)
   for update of c skip locked;
  if not found then continue;end if;
  expired:=a.ends_at+make_interval(mins=>public.fn_agenda_minutes(a.settings,'unknown_protection_minutes',1440))<=p_now;
  insert into public.agent_inbox_items(organization_id,kind,severity,title,body,ref_kind,ref_id,appointment_revision)
   values(a.organization_id,'appointment_outcome_required',case when expired then 'critical' else 'warn' end,
    case when expired then 'Presença sem confirmação há mais tempo' else 'Confirme a presença no compromisso' end,
    'Compromisso: '||a.title||'. Abra e registre se a pessoa compareceu, faltou ou cancelou. O horário sozinho não confirma falta.',
    'appointment',a.id,a.revision)
   on conflict(organization_id,ref_id,appointment_revision,kind) where ref_kind='appointment' and appointment_revision is not null
   do update set status='open',resolved_at=null,severity=excluded.severity,title=excluded.title;
  update public.calendar_appointments set confirmation_next_at=case when expired then p_now+interval '24 hours' else least(p_now+interval '24 hours',a.ends_at+make_interval(mins=>public.fn_agenda_minutes(a.settings,'unknown_protection_minutes',1440))) end where id=a.id and organization_id=a.organization_id;
  n:=n+1;
 end loop;
 return n;
end; $$;

revoke all on function public.fn_appointment_confirmation_sweep(int,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_appointment_confirmation_sweep(int,timestamptz) to service_role;

CREATE OR REPLACE FUNCTION "public"."fn_lgpd_cascade_redact_contact"("p_organization_id" "uuid", "p_contact_id" "uuid", "p_request_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_already bool;
  v_counts jsonb := '{}'::jsonb;
  v_media_paths text[] := '{}';
  v_anon_label text;
  v_count int;
begin
  perform public.fn_service_lock(p_organization_id,p_contact_id);
  select is_anonymized into v_already
    from contacts
    where id = p_contact_id and organization_id = p_organization_id;

  if not found then
    raise exception 'contact not found' using errcode = 'P0002';
  end if;

  if v_already then
    return jsonb_build_object('already_anonymized', true, 'counts', v_counts, 'media_paths', v_media_paths);
  end if;

  v_anon_label := 'Cliente Anonimizado #' || substring(p_contact_id::text from 1 for 8);

  -- Collect media storage paths (we only delete what we own — media_storage_path)
  select coalesce(array_agg(distinct media_storage_path) filter (where media_storage_path is not null), '{}')
    into v_media_paths
    from messages
    where organization_id = p_organization_id
      and conversation_id in (
        select id from conversations
          where contact_id = p_contact_id and organization_id = p_organization_id
      );

  -- 1. contacts (irreversible)
  update contacts set
    name = v_anon_label,
    display_name = v_anon_label,
    email = null,
    -- email_normalized NÃO entra: é GENERATED ALWAYS AS (lower(trim(email)))
    -- e o Postgres recusa escrita nela — a linha acima já a zera por derivação.
    -- Com a atribuição, o cascade INTEIRO abortava e nada era anonimizado.
    phone_number = null,
    cpf_encrypted = null,
    cpf_hash = null,
    birthdate = null,
    is_anonymized = true,
    anonymized_at = now(),
    consent = '{}'::jsonb,
    source_metadata = '{}'::jsonb,
    tags = '{}'::text[],
    updated_at = now()
  where id = p_contact_id and organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('contacts', v_count);

  -- 2. conversations metadata + preview strip
  update conversations set
    metadata = '{}'::jsonb,
    last_message_preview = null,
    updated_at = now()
  where contact_id = p_contact_id and organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('conversations', v_count);

  -- 3. messages: redact body + null media + strip metadata (preserve status/timestamps/conversation_id)
  update messages set
    body = '[mensagem anonimizada]',
    media_url = null,
    media_mime = null,
    media_size_bytes = null,
    media_storage_path = null,
    metadata = '{}'::jsonb,
    updated_at = now()
  where organization_id = p_organization_id
    and conversation_id in (
      select id from conversations
        where contact_id = p_contact_id and organization_id = p_organization_id
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('messages', v_count);

  -- 4. crm_lead_activities — strip payload, metadata E reason (migration 0071).
  --    `reason` é texto livre escrito por LLM sobre a conversa do lead: supor que
  --    nunca conterá um nome é a suposição que falha. `evidence` NÃO é limpa —
  --    guarda só ids, e as linhas apontadas são redigidas por conta própria.
  update crm_lead_activities set
    payload = '{}'::jsonb,
    metadata = '{}'::jsonb,
    reason = null
  where organization_id = p_organization_id
    and (
      contact_id = p_contact_id
      or lead_id in (
        select lead_id from crm_lead_links
          where target_kind = 'contact'
            and target_id = p_contact_id
            and organization_id = p_organization_id
      )
      or lead_id in (
        select id from crm_leads
          where contact_id = p_contact_id and organization_id = p_organization_id
      )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('activities', v_count);

  -- 5. crm_leads — strip title/description/custom_fields/source_metadata/tags but PRESERVE pipeline/stage/value
  update crm_leads set
    title = v_anon_label,
    description = null,
    custom_fields = '{}'::jsonb,
    source_metadata = '{}'::jsonb,
    tags = '{}'::text[],
    updated_at = now()
  where organization_id = p_organization_id
    and (
      contact_id = p_contact_id
      or id in (
        select lead_id from crm_lead_links
          where target_kind = 'contact'
            and target_id = p_contact_id
            and organization_id = p_organization_id
      )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('leads', v_count);

  -- 6. orders — PRESERVE values + status + timestamps. Strip personal fields from payload jsonb
  --    and replace customer_external_id with null (FK-safe; soft de-link). Keep contact_id null.
  update orders set
    payload = (coalesce(payload, '{}'::jsonb))
      - 'customer'
      - 'customer_name'
      - 'customer_email'
      - 'customer_phone'
      - 'shipping_address'
      - 'billing_address'
      - 'contact_identification',
    customer_external_id = null,
    contact_id = null,
    is_anonymized = true,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('orders', v_count);

  -- 7. enqueue media for async deletion (idempotent via unique (bucket, object_path))
  if array_length(v_media_paths, 1) > 0 then
    insert into storage_redaction_queue (organization_id, request_id, bucket, object_path)
    select p_organization_id, p_request_id, 'whatsapp-media', path
      from unnest(v_media_paths) as path
      where path is not null and length(path) > 0
    on conflict (bucket, object_path) do nothing;
  end if;

  -- 8. dense audit row
  insert into api_audit_log (organization_id, action, actor_user_id, resource_type, resource_id, metadata, bypassed_rls)
  values (
    p_organization_id,
    'lgpd.redact_executed',
    null,
    'contact',
    p_contact_id,
    jsonb_build_object(
      'cascaded_to', v_counts,
      'media_queued', coalesce(array_length(v_media_paths, 1), 0),
      'request_id', p_request_id
    ),
    true
  );

  return jsonb_build_object(
    'already_anonymized', false,
    'counts', v_counts,
    'media_paths', v_media_paths
  );
end;
$$;

revoke all on function public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid) to service_role;

-- UPDATE cru já detém a linha ao entrar em BEFORE ROW. Compatibilidade sem
-- espera invertida: ocupado implica retry da transação inteira, inclusive true→true.
create or replace function public.fn_contact_redaction_lock()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if not pg_try_advisory_xact_lock(hashtextextended(new.organization_id::text||':'||new.id::text,222)) then
  raise exception 'contact_redaction_busy' using errcode='40001';
 end if;
 return new;
end;$$;
revoke all on function public.fn_contact_redaction_lock() from public,anon,authenticated;
drop trigger if exists trg_contact_redaction_lock on public.contacts;
create trigger trg_contact_redaction_lock before update on public.contacts
 for each row when(new.is_anonymized is true) execute function public.fn_contact_redaction_lock();

-- Passo 1 legado: mesma autoridade humana, apenas a escrita do contato.
-- A retomada de leads/atividades segue na rota e usa o timestamp retornado aqui.
create or replace function public.fn_lgpd_anonymize_contact(p_organization_id uuid,p_contact_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c public.contacts; support jsonb;
begin
 support:=public.fn_support_context();
 if auth.uid() is null or not public.fn_support_write_allowed(p_organization_id)
  or not (public.fn_role_at_least(p_organization_id,'admin') or (public.fn_is_platform_admin() and support is null)) then
  raise exception 'contact_anonymize_forbidden' using errcode='42501';
 end if;
 if not public.fn_session_mfa_proven() then raise exception 'contact_anonymize_mfa_required' using errcode='42501';end if;
 perform public.fn_service_lock(p_organization_id,p_contact_id);
 select * into c from public.contacts where organization_id=p_organization_id and id=p_contact_id for update;
 if not found then raise exception 'contact_not_found' using errcode='P0002';end if;
 if c.is_anonymized then return jsonb_build_object('already_anonymized',true,'anonymized_at',c.anonymized_at);end if;
 update public.contacts set name=null,display_name='Contato Anonimizado #'||substring(p_contact_id::text from 1 for 8),
  email=null,phone_number=null,cpf_encrypted=null,cpf_hash=null,birthdate=null,
  is_anonymized=true,anonymized_at=now(),updated_at=now()
  where organization_id=p_organization_id and id=p_contact_id returning * into c;
 return jsonb_build_object('already_anonymized',false,'anonymized_at',c.anonymized_at);
end;$$;
revoke all on function public.fn_lgpd_anonymize_contact(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.fn_lgpd_anonymize_contact(uuid,uuid) to authenticated;

-- Cura apenas resíduos deste footprint em clones que já anonimizaram o contato.
-- Mesma ordem de mutexes; não reescreve o contato nem a data original do direito.
do $$
declare c record;
begin
 for c in select distinct ct.organization_id,ct.id from public.contacts ct
  join public.calendar_appointments a on a.organization_id=ct.organization_id and a.contact_id=ct.id
  join public.agent_inbox_items n on n.organization_id=ct.organization_id and n.ref_kind='appointment' and n.ref_id=a.id
  where ct.is_anonymized and n.kind in ('other','appointment_outcome_required','appointment_recovery_review')
  order by ct.organization_id,ct.id
 loop
  perform public.fn_service_lock(c.organization_id,c.id);
  update public.agent_inbox_items set status='resolved',resolved_at=now(),body='Contato anonimizado.',ref_id=null
   where organization_id=c.organization_id and ref_kind='appointment'
    and kind in ('other','appointment_outcome_required','appointment_recovery_review')
    and ref_id in(select id from public.calendar_appointments where organization_id=c.organization_id and contact_id=c.id);
 end loop;
end;$$;

notify pgrst,'reload schema';
