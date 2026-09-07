-- 0224 — Presença é declaração humana; o relógio só pede confirmação.
-- DIRC: vínculos/estado/horário reutilizados; revisão mede intenção, não sync.
-- Recibo privado é decisão terminal, sem fila, e sobrevive ao expurgo do evento.
alter table public.calendar_appointments
 add column if not exists revision bigint not null default 1,
 add column if not exists revision_started_at timestamptz not null default now(),
 add column if not exists outcome_source_kind text,
 add column if not exists outcome_user_id uuid references auth.users(id) on delete set null,
 add column if not exists outcome_message_id uuid references public.messages(id) on delete set null,
 add column if not exists outcome_recorded_at timestamptz,
 add column if not exists confirmation_next_at timestamptz;
alter table public.followup_enrollments
 add column if not exists appointment_id uuid references public.calendar_appointments(id) on delete set null,
 add column if not exists appointment_revision bigint,
 add column if not exists revision bigint not null default 1;
create unique index if not exists followup_appointment_revision_unique
 on public.followup_enrollments(organization_id,pointer_id,appointment_id,appointment_revision) where appointment_id is not null;
create table if not exists public.appointment_recovery_receipts (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 appointment_id uuid not null references public.calendar_appointments(id) on delete cascade,
 appointment_revision bigint not null,
 source_event_id uuid references public.event_log(id) on delete set null,
 result text not null check(result in ('started','other_flow','ambiguous','not_configured','stale','no_contact')),
 pointer_id uuid references public.followup_flow_pointers(id) on delete set null,
 enrollment_id uuid references public.followup_enrollments(id) on delete set null,
 recorded_at timestamptz not null default now(),
 invalidated_at timestamptz,
 primary key(organization_id,appointment_id,appointment_revision)
);
alter table public.appointment_recovery_receipts enable row level security;
revoke all on public.appointment_recovery_receipts from public,anon,authenticated,service_role;
grant select on public.appointment_recovery_receipts to service_role;

-- Um aviso por revisão, inclusive depois de resolvido. Identidade não depende
-- de SELECT seguido de INSERT, nem da duração de um lease do cron.
alter table public.agent_inbox_items add column if not exists appointment_revision bigint;
create unique index if not exists inbox_appointment_revision_unique
 on public.agent_inbox_items(organization_id,ref_id,appointment_revision,kind)
 where ref_kind='appointment' and appointment_revision is not null;
alter table public.agent_inbox_items drop constraint if exists agent_inbox_items_kind_check;
alter table public.agent_inbox_items add constraint agent_inbox_items_kind_check check(kind in (
 'qr_rescan','job_dead','event_dead','budget_exceeded','handoff','promotion_review','judge_unaligned','followup_dead',
 'snooze_expired','next_action_ambiguous','risk_backlog_seeded','reactivation_expired','capabilities_missing',
 'message_send_stuck','channel_template_review','channel_number_alert','midia_nao_lida','promise_unfulfilled',
 'contact_proposal_expired','budget_warning','conhecimento_nao_indexado','other',
 'appointment_outcome_required','appointment_recovery_review'));

create or replace function public.fn_appointment_stamp()
returns trigger language plpgsql security definer set search_path=public as $$
declare changed boolean; actor uuid;
begin
 if new.contact_id is not null and not exists(select 1 from public.contacts where id=new.contact_id and organization_id=new.organization_id) then
  raise exception 'appointment_contact_scope' using errcode='23503'; end if;
 if new.conversation_id is not null and not exists(select 1 from public.conversations where id=new.conversation_id and organization_id=new.organization_id and contact_id=new.contact_id and not is_group and (auth.uid() is null or public.fn_can_view_conversation(organization_id,assigned_to_user_id))) then
  raise exception 'appointment_conversation_scope' using errcode='23503'; end if;
 if tg_op='INSERT' then
  new.revision:=1;
  -- Legado importado sem autoria não vira fato certificado.
  new.outcome_source_kind:=null; new.outcome_user_id:=null; new.outcome_message_id:=null;
  new.outcome_recorded_at:=null;
  return new;
 end if;
 changed:=row(new.starts_at,new.ends_at,new.status,new.contact_id,new.conversation_id) is distinct from row(old.starts_at,old.ends_at,old.status,old.contact_id,old.conversation_id);
 new.revision:=old.revision+case when changed then 1 else 0 end;
 new.revision_started_at:=case when changed then clock_timestamp() else old.revision_started_at end;
 if changed then new.confirmation_next_at:=null; end if;
 if new.status is distinct from old.status and new.status in ('completed','no_show') then
  actor:=auth.uid();
  if actor is null or not public.fn_role_at_least(new.organization_id,'agent') or not public.fn_support_write_allowed(new.organization_id) then
   raise exception 'appointment_human_confirmation_required' using errcode='42501'; end if;
  if new.starts_at>now() then raise exception 'appointment_not_started' using errcode='22023'; end if;
  new.outcome_user_id:=actor; new.outcome_recorded_at:=clock_timestamp();
  new.outcome_source_kind:=case when new.outcome_message_id is null then 'user' else 'contact_message' end;
  if new.outcome_message_id is not null and not exists(
   select 1 from public.messages m join public.conversations c on c.id=m.conversation_id and c.organization_id=m.organization_id
   where m.id=new.outcome_message_id and m.organization_id=new.organization_id and m.contact_id=new.contact_id
    and (new.conversation_id is null or m.conversation_id=new.conversation_id)
    and m.direction='inbound' and m.service_revision is not null and m.service_revision=c.service_revision
    and m.demanda_id is not distinct from c.current_demanda_id and m.created_at>=old.revision_started_at
    and not c.is_group and public.fn_can_view_conversation(c.organization_id,c.assigned_to_user_id)
  ) then raise exception 'appointment_message_not_evidence' using errcode='42501'; end if;
 elsif changed then
  new.outcome_source_kind:=null; new.outcome_user_id:=null; new.outcome_message_id:=null;
  new.outcome_recorded_at:=null;
 else
  new.outcome_source_kind:=old.outcome_source_kind;
  -- SET NULL por retenção da FK é erosão de referência, não nova autoria.
  new.outcome_user_id:=case when new.outcome_user_id is null and not exists(select 1 from auth.users where id=old.outcome_user_id) then null else old.outcome_user_id end;
  new.outcome_message_id:=case when new.outcome_message_id is null and not exists(select 1 from public.messages where id=old.outcome_message_id and organization_id=old.organization_id) then null else old.outcome_message_id end;
  new.outcome_recorded_at:=old.outcome_recorded_at;
 end if;
 return new;
end; $$;
revoke all on function public.fn_appointment_stamp() from public,anon,authenticated;
drop trigger if exists trg_appointment_stamp on public.calendar_appointments;
create trigger trg_appointment_stamp before insert or update on public.calendar_appointments for each row execute function public.fn_appointment_stamp();

-- A mudança observada e o evento estão no mesmo commit. Sem janela em que
-- o desfecho ficou gravado e a recuperação nunca soube dele.
create or replace function public.fn_appointment_change(p_org uuid,p_id uuid,p_revision bigint,p_patch jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; contact uuid; origin jsonb; event_id uuid;
begin
 if auth.uid() is not null and (not public.fn_role_at_least(p_org,'agent') or not public.fn_support_write_allowed(p_org)) then raise exception 'appointment_forbidden' using errcode='42501'; end if;
 select contact_id into contact from public.calendar_appointments where organization_id=p_org and id=p_id;
 if not found then raise exception 'appointment_not_found' using errcode='P0002'; end if;
 if contact is not null then perform public.fn_service_lock(p_org,contact); end if;
 select * into a from public.calendar_appointments where organization_id=p_org and id=p_id for update;
 if a.contact_id is distinct from contact or a.revision is distinct from p_revision then raise exception 'appointment_stale' using errcode='40001'; end if;
 if a.status='cancelled' then raise exception 'appointment_cancelled' using errcode='22023'; end if;
 if contact is not null then origin:=jsonb_build_object('kind','command','observed',public.fn_service_observe_command(p_org,contact)); end if;
 update public.calendar_appointments set
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
revoke all on function public.fn_appointment_change(uuid,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.fn_appointment_change(uuid,uuid,bigint,jsonb) to authenticated,service_role;

-- Certificação ocorre sob o mutex ANTES dos locks de mensagens/FKs (Task4).
-- A ordem é a do lock, não created_at (now() mede início da transação).
-- Identidade é a nova mensagem persistida. Timestamp externo anterior ao
-- segundo do desfecho é histórico; igualdade de segundo conta. Sem timestamp,
-- o fallback de ingestão não permite distinguir histórico de entrada live.
create or replace function public.fn_appointment_inbound()
returns trigger language plpgsql security definer set search_path=public as $$
declare a record;
begin
 if auth.uid() is null and old.service_revision is null and new.service_revision is not null and new.direction='inbound' then
  perform public.fn_service_lock(new.organization_id,new.contact_id);
  for a in select * from public.calendar_appointments where organization_id=new.organization_id and contact_id=new.contact_id
   and status='no_show' and outcome_recorded_at is not null and new.sent_at>=date_trunc('second',outcome_recorded_at) for update
  loop
   insert into public.appointment_recovery_receipts(organization_id,appointment_id,appointment_revision,result,invalidated_at)
    values(a.organization_id,a.id,a.revision,'stale',clock_timestamp())
    on conflict(organization_id,appointment_id,appointment_revision) do update set invalidated_at=excluded.invalidated_at;
   update public.followup_enrollments set status='cancelled',cancel_reason='O cliente respondeu. Revise o próximo passo.',completed_at=now(),next_eval_at=null,claimed_until=null
    where organization_id=new.organization_id and contact_id=new.contact_id and appointment_id=a.id and appointment_revision=a.revision
     and status in ('active','waiting_reply','paused_handoff','paused_manual');
  end loop;
 end if;
 return new;
end; $$;
revoke all on function public.fn_appointment_inbound() from public,anon,authenticated;
drop trigger if exists trg_appointment_inbound on public.messages;
create trigger trg_appointment_inbound after update of service_revision on public.messages for each row execute function public.fn_appointment_inbound();

create or replace function public.fn_followup_revision()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 -- Origem da recuperação é imutável, inclusive para quem pode editar o fluxo.
 -- Só o desaparecimento real da FK permite apagar a referência, cancelando-o.
 if old.appointment_revision is not null then
  new.appointment_revision:=old.appointment_revision;
  if new.appointment_id is null and not exists(select 1 from public.calendar_appointments where organization_id=old.organization_id and id=old.appointment_id) then
   new.status:='cancelled';new.cancel_reason:='O compromisso foi removido.';new.next_eval_at:=null;new.claimed_until:=null;new.completed_at:=now();
  else new.appointment_id:=old.appointment_id; end if;
  if new.contact_id is distinct from old.contact_id then
   new.status:='cancelled';new.cancel_reason:='O contato do compromisso mudou.';new.next_eval_at:=null;new.claimed_until:=null;new.completed_at:=now();
  end if;
 end if;
 if new.appointment_revision is not null and new.status in ('active','waiting_reply','paused_handoff','paused_manual') then
  if old.status not in ('active','waiting_reply','paused_handoff','paused_manual') or not exists(
   select 1 from public.calendar_appointments a join public.appointment_recovery_receipts r
    on r.organization_id=a.organization_id and r.appointment_id=a.id and r.appointment_revision=a.revision
   where a.organization_id=new.organization_id and a.id=new.appointment_id and a.revision=new.appointment_revision
    and a.status='no_show' and a.contact_id=new.contact_id and r.result='started' and r.invalidated_at is null
  ) then raise exception 'followup_stale' using errcode='40001'; end if;
 end if;
 new.revision:=old.revision+1; return new;
end; $$;
revoke all on function public.fn_followup_revision() from public,anon,authenticated;
drop trigger if exists trg_followup_revision on public.followup_enrollments;
create trigger trg_followup_revision before update on public.followup_enrollments for each row execute function public.fn_followup_revision();

-- Defaults também são validados no schema TS. Valores corrompidos de clone
-- degradam para 10min/24h; não passam cast inseguro no sweep de toda instalação.
create or replace function public.fn_agenda_minutes(p_settings jsonb,p_key text,p_default int)
returns int language plpgsql immutable set search_path=public as $$
declare cfg jsonb:=p_settings->'agenda'; delay int; horizon int;
begin
 if jsonb_typeof(cfg) is distinct from 'object'
  or jsonb_typeof(cfg->'confirmation_delay_minutes') is distinct from 'number'
  or jsonb_typeof(cfg->'unknown_protection_minutes') is distinct from 'number'
  or (cfg->>'confirmation_delay_minutes' ~ '^[0-9]{1,5}$') is not true
  or (cfg->>'unknown_protection_minutes' ~ '^[0-9]{1,5}$') is not true then return p_default; end if;
 delay:=(cfg->>'confirmation_delay_minutes')::int; horizon:=(cfg->>'unknown_protection_minutes')::int;
 if delay not between 1 and 10080 or horizon not between delay and 10080
  or (cfg-'confirmation_delay_minutes'-'unknown_protection_minutes')<>'{}'::jsonb then return p_default; end if;
 return case p_key when 'confirmation_delay_minutes' then delay when 'unknown_protection_minutes' then horizon else p_default end;
end;
$$;
revoke all on function public.fn_agenda_minutes(jsonb,text,int) from public,anon,authenticated;
grant execute on function public.fn_agenda_minutes(jsonb,text,int) to service_role;

create or replace function public.fn_appointment_confirmation_sweep(p_limit int default 100,p_now timestamptz default now())
returns int language plpgsql security definer set search_path=public as $$
declare a record; n int:=0; expired boolean;
begin
 for a in select c.*,o.settings from public.calendar_appointments c join public.organizations o on o.id=c.organization_id
  where c.status in ('pending','confirmed')
   and c.ends_at+make_interval(mins=>public.fn_agenda_minutes(o.settings,'confirmation_delay_minutes',10))<=p_now
   and (c.confirmation_next_at is null or c.confirmation_next_at<=p_now)
  order by c.ends_at limit greatest(1,least(p_limit,500)) for update of c skip locked
 loop
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

-- Um único comando escolhe (ou recusa) o fluxo, guarda o recibo e inscreve.
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
 if result<>'started' then
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

create or replace function public.fn_agenda_settings(p_org uuid,p_config jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'manager') or not public.fn_support_write_allowed(p_org) then raise exception 'agenda_settings_forbidden' using errcode='42501'; end if;
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
revoke all on function public.fn_agenda_settings(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.fn_agenda_settings(uuid,jsonb) to authenticated;

create or replace function public.fn_appointment_enrollment_current(p_org uuid,p_id uuid,p_node text default null)
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.followup_enrollments e where e.organization_id=p_org and e.id=p_id
  and e.status in ('active','waiting_reply') and (p_node is null or e.current_node_id=p_node)
  and (e.appointment_revision is null or exists(select 1 from public.calendar_appointments a
   where a.organization_id=p_org and a.id=e.appointment_id and a.revision=e.appointment_revision and a.status='no_show'
    and a.outcome_recorded_at is not null and a.contact_id=e.contact_id
    and exists(select 1 from public.appointment_recovery_receipts r where r.organization_id=p_org and r.appointment_id=a.id and r.appointment_revision=a.revision and r.result='started' and r.invalidated_at is null))));
$$;
revoke all on function public.fn_appointment_enrollment_current(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fn_appointment_enrollment_current(uuid,uuid,text) to service_role;

-- DIRC: geração já existe na chave nó:steps do evento de enqueue. Rechecks
-- incrementam steps_taken, portanto igualdade com o contador atual seria falsa.
-- Só o produtor interno grava essa chave no job; retenção sem evento falha fechado.
create or replace function public.fn_followup_generation_write()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if tg_table_name='job_queue' then
  if auth.uid() is not null and ((tg_op<>'DELETE' and new.kind='followup_turn') or (tg_op<>'INSERT' and old.kind='followup_turn')) then
   raise exception 'followup_job_internal' using errcode='42501';
  end if;
  if tg_op='UPDATE' and old.kind='followup_turn' then
   if new.organization_id<>old.organization_id or new.contact_id is distinct from old.contact_id or new.kind<>old.kind
    or new.payload->'followup_enrollment_id' is distinct from old.payload->'followup_enrollment_id'
    or new.payload->'node_id' is distinct from old.payload->'node_id'
    or new.payload->'source_step_key' is distinct from old.payload->'source_step_key'
   then raise exception 'followup_job_origin_immutable' using errcode='42501'; end if;
  end if;
 elsif auth.uid() is not null and ((tg_op<>'DELETE' and new.idempotency_key ~ ':[0-9]+$') or (tg_op<>'INSERT' and old.idempotency_key ~ ':[0-9]+$')) then
  raise exception 'followup_step_internal' using errcode='42501';
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end; $$;
revoke all on function public.fn_followup_generation_write() from public,anon,authenticated;
drop trigger if exists trg_followup_generation_job on public.job_queue;
create trigger trg_followup_generation_job before insert or update or delete on public.job_queue for each row execute function public.fn_followup_generation_write();
drop trigger if exists trg_followup_generation_event on public.followup_enrollment_events;
create trigger trg_followup_generation_event before insert or update or delete on public.followup_enrollment_events for each row execute function public.fn_followup_generation_write();

create or replace function public.fn_followup_job_current(p_org uuid,p_job uuid,p_enrollment uuid,p_node text)
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.job_queue j
  join public.followup_enrollments e on e.id=p_enrollment and e.organization_id=j.organization_id and e.contact_id=j.contact_id
  join public.followup_enrollment_events origin on origin.organization_id=e.organization_id and origin.enrollment_id=e.id
   and origin.node_id=p_node and origin.idempotency_key=j.payload->>'source_step_key'
   and origin.event_type in ('turn_enqueued','classify_enqueued')
  where j.id=p_job and j.organization_id=p_org and j.kind='followup_turn' and j.status in ('pending','running')
   and j.payload->>'followup_enrollment_id'=p_enrollment::text and j.payload->>'node_id'=p_node
   and origin.idempotency_key = origin.node_id||':'||substring(origin.idempotency_key from ':([0-9]+)$')
   and public.fn_appointment_enrollment_current(p_org,p_enrollment,p_node)
   and not exists(select 1 from public.followup_enrollment_events later
    where later.organization_id=p_org and later.enrollment_id=e.id
     and later.idempotency_key=later.node_id||':'||substring(later.idempotency_key from ':([0-9]+)$')
     and substring(later.idempotency_key from ':([0-9]+)$')::numeric > substring(origin.idempotency_key from ':([0-9]+)$')::numeric
     and not (later.node_id=p_node and later.event_type='action_recheck')));
$$;
revoke all on function public.fn_followup_job_current(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fn_followup_job_current(uuid,uuid,uuid,text) to service_role;

-- Identidade ORIGINAL da aquisição. locked_at::text sai do claim PG sem perda
-- dos microssegundos; heartbeat não altera locked_at. Reclaim do mesmo worker
-- não reautoriza a execução anterior. Sem novo contador ou coluna de autoridade.
create or replace function public.fn_followup_claim_current(p_org uuid,p_job uuid,p_worker text,p_acquired_at timestamptz)
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.job_queue where organization_id=p_org and id=p_job
  and kind='followup_turn' and status='running' and locked_by=p_worker and locked_at=p_acquired_at);
$$;
revoke all on function public.fn_followup_claim_current(uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_followup_claim_current(uuid,uuid,text,timestamptz) to service_role;

-- CAS de todo update tardio: estado, nó e lease compartilham a revisão.
create or replace function public.fn_followup_patch(p_org uuid,p_id uuid,p_revision bigint,p_patch jsonb)
returns bigint language plpgsql security definer set search_path=public as $$
declare current public.followup_enrollments; patched public.followup_enrollments; contact uuid;
begin
 select contact_id into contact from public.followup_enrollments where id=p_id and organization_id=p_org;
 if not found then raise exception 'followup_stale' using errcode='40001'; end if;
 perform public.fn_service_lock(p_org,contact);
 select * into current from public.followup_enrollments where id=p_id and organization_id=p_org for update;
 if current.contact_id is distinct from contact or current.revision is distinct from p_revision then raise exception 'followup_stale' using errcode='40001'; end if;
 if p_patch->>'status' in ('active','waiting_reply') and current.appointment_revision is not null and not public.fn_appointment_enrollment_current(p_org,p_id,current.current_node_id) then raise exception 'followup_stale' using errcode='40001'; end if;
 select * into patched from jsonb_populate_record(current,p_patch);
 update public.followup_enrollments set status=patched.status,current_node_id=patched.current_node_id,next_eval_at=patched.next_eval_at,
  claimed_until=patched.claimed_until,attempts=patched.attempts,last_error=patched.last_error,steps_taken=patched.steps_taken,
  outcome=patched.outcome,cancel_reason=patched.cancel_reason,completed_at=patched.completed_at,timing_plan=patched.timing_plan
 where organization_id=p_org and id=p_id returning revision into p_revision;
 return p_revision;
end; $$;
revoke all on function public.fn_followup_patch(uuid,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.fn_followup_patch(uuid,uuid,bigint,jsonb) to service_role;

-- Estende o produtor permitido mantendo a origem imutável da 0223.
CREATE OR REPLACE FUNCTION public.emit_event(p_event_type text, p_entity_kind text, p_entity_id uuid, p_payload jsonb DEFAULT '{}'::jsonb, p_metadata jsonb DEFAULT '{}'::jsonb, p_organization_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org_id uuid;
  v_event_id uuid;
begin
  -- message.received nasce somente do INSERT inbound interno. Um chamador
  -- público não pode reapresentar uma mensagem existente como evento novo.
  if auth.uid() is not null and p_event_type in ('message.received','appointment.outcome_confirmed') then
    raise exception 'reserved_message_received' using errcode='42501';
  end if;
  -- Estes campos autorizam efeitos operacionais; não são payload público.
  if auth.uid() is not null and (
    coalesce(p_payload,'{}'::jsonb) ?| array['service_origin','service_boundary']
    or coalesce(p_metadata,'{}'::jsonb) ?| array['service_origin','service_boundary']
  ) then raise exception 'reserved_service_origin' using errcode='42501'; end if;
  v_org_id := coalesce(p_organization_id, (public.fn_support_context()->>'organization_id')::uuid);
  if v_org_id is null then
    select organization_id into v_org_id
      from public.user_organizations
      where user_id = auth.uid() and revoked_at is null
      limit 1;
  end if;
  if v_org_id is null then
    raise exception 'emit_event: organization_id obrigatorio';
  end if;

  if auth.uid() is not null
     and not public.fn_role_at_least(v_org_id, 'viewer') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'emit_event: caller must be an active member of the organization';
  end if;

  if not public.fn_support_write_allowed(v_org_id) then raise exception 'support_readonly' using errcode='42501'; end if;

  insert into public.event_log
    (organization_id, event_type, entity_kind, entity_id, payload, metadata)
  values
    (v_org_id, p_event_type, p_entity_kind, p_entity_id,
     coalesce(p_payload, '{}'::jsonb),
     coalesce(p_metadata, '{}'::jsonb)
       || jsonb_build_object('emitted_at', extract(epoch from now())))
  returning id into v_event_id;

  return v_event_id;
end $function$;


create or replace function public.fn_service_event_origin(p_org uuid,p_event uuid,p_contact uuid,p_session uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public.event_log; origin jsonb; boundary jsonb; current_boundary jsonb; entity_contact uuid; cid uuid; sid uuid; observed jsonb; root_event uuid:=p_event; visited uuid[]:=array[]::uuid[];
begin
 -- O drain faz claim otimista em outra transação; não conserva row lock.
 -- Não travar event_log: advisory contato antecede os locks de conversa/FKs.
 perform public.fn_service_lock(p_org,p_contact);
 loop
 if root_event = any(visited) or cardinality(visited)>=32 then raise exception 'service_origin_cycle' using errcode='40001'; end if;
 visited:=array_append(visited,root_event);
 boundary:=null;
 entity_contact:=null;
 select * into e from public.event_log where organization_id=p_org and id=root_event;
 if not found then raise exception 'service_event_not_found' using errcode='P0002'; end if;
 if e.event_type in ('lead.created','lead.stage_changed','lead.tag_added') and e.entity_kind='crm_lead' then
   select contact_id into entity_contact from public.crm_leads where organization_id=p_org and id=e.entity_id;
 elsif e.event_type='contact.tag_added' and e.entity_kind='contact' then
   select id into entity_contact from public.contacts where organization_id=p_org and id=e.entity_id;
 elsif e.event_type='appointment.outcome_confirmed' and e.entity_kind='appointment' then
   select contact_id into entity_contact from public.calendar_appointments where organization_id=p_org and id=e.entity_id and revision=(e.payload->>'appointment_revision')::bigint and status='no_show' and outcome_recorded_at is not null;
 elsif e.event_type='message.received' and e.entity_kind='message' then
   select contact_id,jsonb_build_object('organization_id',organization_id,'contact_id',contact_id,
     'conversation_id',conversation_id,'service_revision',service_revision,'demanda_id',demanda_id,'demanda_revision',demanda_revision)
     into entity_contact,boundary from public.messages where organization_id=p_org and id=e.entity_id and direction='inbound';
 else raise exception 'service_event_origin_unsupported' using errcode='40001'; end if;
 if entity_contact is distinct from p_contact or not exists(select 1 from public.contacts where organization_id=p_org and id=p_contact and not is_anonymized and is_merged_into is null) then
   raise exception 'service_scope_mismatch' using errcode='23503'; end if;
 origin:=e.payload->'service_origin';
 if origin->>'kind'='event' then
   if origin->>'organization_id' is distinct from p_org::text or origin->>'contact_id' is distinct from p_contact::text then raise exception 'service_scope_mismatch' using errcode='23503'; end if;
   root_event:=(origin->>'event_id')::uuid;
   if root_event is null then raise exception 'service_stale' using errcode='40001'; end if;
   continue;
 end if;
 exit;
 end loop;
 if boundary is not null or origin->>'kind'='continuation' then
   boundary:=coalesce(boundary,origin->'boundary');
   select channel_session_id into sid from public.conversations where organization_id=p_org and contact_id=p_contact and id=(boundary->>'conversation_id')::uuid;
   if p_session is not null and p_session is distinct from sid then raise exception 'service_channel_mismatch' using errcode='23503'; end if;
 elsif origin->>'kind'='command' then
   observed:=origin->'observed';
   if observed->>'organization_id' is distinct from p_org::text or observed->>'contact_id' is distinct from p_contact::text then raise exception 'service_scope_mismatch' using errcode='23503'; end if;
   if jsonb_typeof(observed->'destinations')='array' then
     sid:=coalesce(p_session,(observed->>'default_session_id')::uuid);
     select item->'observed' into observed from jsonb_array_elements(observed->'destinations') item where item->>'channel_session_id'=sid::text;
   else
     -- Compatibilidade com snapshot anterior: prova somente sua conversa, nunca ausência de outro canal.
     select channel_session_id into sid from public.conversations where organization_id=p_org and contact_id=p_contact and id=(observed->>'conversation_id')::uuid;
     if p_session is not null and p_session is distinct from sid then raise exception 'service_channel_mismatch' using errcode='23503'; end if;
   end if;
 else raise exception 'service_stale' using errcode='40001'; end if;
 if sid is null then raise exception 'service_stale' using errcode='40001'; end if;
 if not exists(select 1 from public.channel_sessions where id=sid and organization_id=p_org and archived_at is null) then raise exception 'service_channel_mismatch' using errcode='23503'; end if;
 if boundary is null and observed is null then raise exception 'service_stale' using errcode='40001'; end if;
 select service_boundary into current_boundary from public.event_service_origins where organization_id=p_org and event_id=root_event and channel_session_id=sid;
 if found then boundary:=current_boundary;
 elsif boundary is null then
   -- PARA UM EVENTO, `absent` E PROCEDENCIA — NAO REIVINDICACAO DE ESTADO.
   --
   -- O CAS de `fn_service_begin` existe para que dois ATORES com a mesma
   -- observacao "ausente" nao ajam os dois: o segundo tem de perder, e o
   -- invariante de `fn_service_begin` guarda isso. Um evento e outra coisa: o
   -- retrato `absent` diz "quando este evento foi EMITIDO nao havia
   -- atendimento", e a resolucao de cada evento ja e idempotente pelo memo
   -- `event_service_origins` logo acima — nao ha corrida a arbitrar aqui.
   --
   -- Sem esta distincao o caminho ORDINARIO morria: um lead criado e depois
   -- movido de etapa gera DOIS eventos, cada um com seu retrato `absent`;
   -- resolver o primeiro cria a conversa e o segundo levantava 40001 — que
   -- `serviceForEvent` engole como `stale_origin`, entao o follow-up de etapa
   -- simplesmente nao nascia, sem erro em lugar nenhum.
   --
   -- Zerar `observed` so quando a conversa JA existe mantem o CAS de pe para o
   -- retrato que descreve uma fronteira concreta (esse continua sendo conferido
   -- contra a vigente) e para todo chamador direto de `fn_service_begin`.
   if observed->>'absent' = 'true' and exists(
        select 1 from public.conversations
         where organization_id=p_org and contact_id=p_contact
           and channel_session_id=sid and not is_group) then
     observed:=null;
   end if;
   boundary:=public.fn_service_begin(p_org,p_contact,sid,observed) - 'status' - 'demanda_fechada_em' - 'service_started_at';
 end if;
 if boundary->>'organization_id' is distinct from p_org::text or boundary->>'contact_id' is distinct from p_contact::text then
   raise exception 'service_scope_mismatch' using errcode='23503'; end if;
 cid:=(boundary->>'conversation_id')::uuid;
 if p_session is not null and not exists(select 1 from public.conversations where organization_id=p_org and id=cid and contact_id=p_contact and channel_session_id=p_session) then
   raise exception 'service_channel_mismatch' using errcode='23503'; end if;
 current_boundary:=public.fn_service_boundary(p_org,cid);
 if current_boundary is null or current_boundary->>'status' in ('closed','resolved','archived')
   or current_boundary->>'demanda_fechada_em' is not null
   or (current_boundary - 'status' - 'demanda_fechada_em' - 'service_started_at') is distinct from boundary then
   raise exception 'service_stale' using errcode='40001'; end if;
 insert into public.event_service_origins(event_id,channel_session_id,organization_id,service_boundary) values(root_event,sid,p_org,boundary)
 on conflict(event_id,channel_session_id) do nothing;
 return boundary;
end; $$;
revoke all on function public.fn_service_event_origin(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_service_event_origin(uuid,uuid,uuid,uuid) to service_role;


drop function if exists public.fn_followup_inline_settle(uuid,uuid,text,boolean,text,timestamptz,boolean);
-- Atalho inline: estado do job e aviso no mesmo commit; lease antigo não conclui.
create or replace function public.fn_followup_inline_settle(p_org uuid,p_id uuid,p_worker text,p_done boolean,p_error text default null,p_retry_at timestamptz default null,p_hold boolean default false,p_acquired_at timestamptz default null)
returns boolean language plpgsql security definer set search_path=public as $$
declare j public.job_queue;
begin
 update public.job_queue set
  status=case when p_done then 'done' when p_hold then 'pending' when attempts>=max_attempts then 'dead' else 'pending' end,
  attempts=case when p_hold then greatest(0,attempts-1) else attempts end,
  run_after=coalesce(p_retry_at,now()+interval '1 minute'),locked_by=null,locked_at=null,last_error=left(p_error,400)
 where organization_id=p_org and id=p_id and kind='followup_turn' and status='running' and locked_by=p_worker and locked_at=p_acquired_at returning * into j;
 if not found then return false; end if;
 if j.status='dead' then
  insert into public.agent_inbox_items(organization_id,kind,severity,title,body,ref_kind,ref_id)
   values(p_org,'job_dead','critical','O acompanhamento não conseguiu enviar a mensagem',
    'Abra o acompanhamento e confira o canal. Motivo: '||coalesce(j.last_error,'envio indisponível'),'job_queue',j.id);
 end if;
 return true;
end; $$;
revoke all on function public.fn_followup_inline_settle(uuid,uuid,text,boolean,text,timestamptz,boolean,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_followup_inline_settle(uuid,uuid,text,boolean,text,timestamptz,boolean,timestamptz) to service_role;


-- Callback grava o passo e sua progressão juntos. Um CAS recusado não deixa
-- idempotency_key órfã que impediria a próxima tentativa legítima.
create or replace function public.fn_followup_apply_step(p_org uuid,p_id uuid,p_revision bigint,p_patch jsonb,p_event jsonb)
returns bigint language plpgsql security definer set search_path=public as $$
declare revision bigint; contact uuid;
begin
 if p_event ? 'job_id' then
  select contact_id into contact from public.followup_enrollments where organization_id=p_org and id=p_id;
  perform public.fn_service_lock(p_org,contact);
  perform 1 from public.job_queue where id=(p_event->>'job_id')::uuid and organization_id=p_org for update;
  if not public.fn_followup_claim_current(p_org,(p_event->>'job_id')::uuid,p_event->'job_claim'->>'worker_id',(p_event->'job_claim'->>'acquired_at')::timestamptz)
   or not public.fn_followup_job_current(p_org,(p_event->>'job_id')::uuid,p_id,p_event->>'node_id') then
   raise exception 'followup_job_stale' using errcode='40001';
  end if;
 end if;
 revision:=public.fn_followup_patch(p_org,p_id,p_revision,p_patch);
 insert into public.followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,idempotency_key)
  values(p_org,p_id,p_event->>'node_id',p_event->>'event_type',coalesce(p_event->'payload','{}'::jsonb),p_event->>'idempotency_key');
 return revision;
end; $$;
revoke all on function public.fn_followup_apply_step(uuid,uuid,bigint,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.fn_followup_apply_step(uuid,uuid,bigint,jsonb,jsonb) to service_role;

notify pgrst,'reload schema';
