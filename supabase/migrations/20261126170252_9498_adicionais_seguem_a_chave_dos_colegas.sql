-- manifest: **Os responsáveis adicionais seguem a chave "colegas podem mexer na agenda" (#5280): com ela desligada, quem está abaixo de gerente só inclui a si mesmo como adicional, na criação (`fn_appointment_insert_with_responsibles`), na edição da lista (`fn_appointment_change_core`, lista enviada inteira) e na reserva de serviço feita por pessoa (`fn_calendar_service_book`, equipe nova). Sem sessão de usuário, como o principal, segue como estava. Corpos copiados da 9494; muda só a conferência.**
-- Sem tabela temporária, sem BEGIN/COMMIT, sem id de tenant, psql puro, idempotente.

create or replace function public.fn_appointment_change_core(p_org uuid,p_id uuid,p_revision bigint,p_patch jsonb,p_remote boolean,p_base jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; contact uuid; origin jsonb; event_id uuid; service_fact jsonb; service_occurrence uuid; service_owner uuid;
 service_confirmation_required boolean;service_next_status text;resp record;
begin
 if p_remote and (auth.uid() is not null or (p_patch-'starts_at'-'ends_at'-'time_zone'-'status'-'cancellation_reason')<>'{}'::jsonb or coalesce(p_patch->>'status','cancelled')<>'cancelled') then raise exception 'google_patch_forbidden' using errcode='42501';end if;
 if auth.uid() is not null and (not public.fn_role_at_least(p_org,'agent') or not public.fn_support_write_allowed(p_org)) then raise exception 'appointment_forbidden' using errcode='42501'; end if;
 if auth.uid() is not null and not public.fn_session_mfa_proven() then raise exception 'appointment_mfa_required' using errcode='42501';end if;
 -- O TÍTULO VAZIO É RECUSA, e não no-op silencioso (#3776). `title` é `not null`
 -- no banco, e quem manda "  " está pedindo para limpar o campo — limpar não tem
 -- destino nesta régua (o nome do tipo pode ter mudado desde a marcação). A
 -- recusa vem NOMEADA, antes de qualquer trava, para o chamador receber um erro
 -- que aponta o campo em vez de uma violação de constraint em inglês.
 if p_patch?'title' and btrim(coalesce(p_patch->>'title',''))='' then raise exception 'appointment_title_empty' using errcode='22023'; end if;
 -- A LISTA DA EQUIPE TEM A MESMA RÉGUA DA ROTA: teto de 20 e só membro ativo da
 -- organização (array não aceita FK; o nulo cai no `not exists`). Recusa nomeada,
 -- antes de qualquer trava, como o título.
 if p_patch?'team_guest_user_ids' then
  if jsonb_typeof(p_patch->'team_guest_user_ids')<>'array' then raise exception 'appointment_team_guests_invalid' using errcode='22023'; end if;
  if jsonb_array_length(p_patch->'team_guest_user_ids')>20 or exists(
    select 1 from jsonb_array_elements_text(p_patch->'team_guest_user_ids') g
    where not exists(select 1 from public.user_organizations m where m.organization_id=p_org and m.user_id::text=lower(g) and m.revoked_at is null))
  then raise exception 'appointment_team_guests_invalid' using errcode='22023'; end if;
 end if;
 -- RESPONSÁVEIS ADICIONAIS (F2 #3067): forma, teto e membro ativo. Recusa nomeada antes de qualquer trava.
 if p_patch?'responsible_user_ids' then
  if jsonb_typeof(p_patch->'responsible_user_ids')<>'array' then raise exception 'appointment_responsibles_invalid' using errcode='22023'; end if;
  if jsonb_array_length(p_patch->'responsible_user_ids')>9 then raise exception 'appointment_responsibles_limit' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements_text(p_patch->'responsible_user_ids') g
       where g !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     or (select count(distinct lower(g)) from jsonb_array_elements_text(p_patch->'responsible_user_ids') g)<>jsonb_array_length(p_patch->'responsible_user_ids')
     or exists(select 1 from jsonb_array_elements_text(p_patch->'responsible_user_ids') g
       where not exists(select 1 from public.user_organizations m where m.organization_id=p_org and m.user_id::text=lower(g) and m.revoked_at is null))
  then raise exception 'appointment_responsibles_invalid' using errcode='22023'; end if;
 end if;
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
 -- OS ADICIONAIS SEGUEM A MESMA CHAVE DO PRINCIPAL: cada adicional que não é quem pede ocupa a agenda
 -- de um colega. A lista enviada conta INTEIRA (não só os novos), como o principal de colega, que
 -- também não se mantém numa edição sem a chave. Sem sessão (agente, servidor) segue como está.
 if auth.uid() is not null and p_patch?'responsible_user_ids' and not public.fn_role_at_least(p_org,'manager')
    and not public.fn_colegas_podem_mexer_na_agenda(p_org)
    and exists(select 1 from jsonb_array_elements_text(p_patch->'responsible_user_ids') g where lower(g)<>auth.uid()::text) then
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
  -- `btrim` porque o texto vem de fora e a coluna é `not null`: um título com
  -- espaços nas pontas é o mesmo título, e a grade o desenharia torto.
  title=case when p_patch?'title' then btrim(p_patch->>'title') else title end,
  notes=case when p_patch?'notes' then p_patch->>'notes' else notes end,
  guest_email=case when p_patch?'guest_email' then p_patch->>'guest_email' else guest_email end,
  team_guest_user_ids=case when p_patch?'team_guest_user_ids' then array(select jsonb_array_elements_text(p_patch->'team_guest_user_ids'))::uuid[] else team_guest_user_ids end,
  outcome_message_id=case when p_patch?'outcome_message_id' then (p_patch->>'outcome_message_id')::uuid else null end,
  confirmation_next_at=case when p_patch?'confirmation_next_at' then (p_patch->>'confirmation_next_at')::timestamptz else confirmation_next_at end
 where organization_id=p_org and id=p_id returning * into a;
 -- RESPONSÁVEIS: grava a lista nova (se veio) e revalida TODOS, no horário que a consulta tem agora.
 if p_patch?'responsible_user_ids' then
  delete from public.calendar_appointment_responsibles where organization_id=p_org and appointment_id=p_id;
  insert into public.calendar_appointment_responsibles(organization_id,appointment_id,user_id)
   select p_org,p_id,u.v::uuid from jsonb_array_elements_text(p_patch->'responsible_user_ids') u(v);
 end if;
 if exists(select 1 from public.calendar_appointment_responsibles r where r.organization_id=p_org and r.appointment_id=p_id and r.user_id=a.owner_user_id)
  then raise exception 'appointment_responsibles_invalid' using errcode='22023'; end if;
 if p_patch?'responsible_user_ids' or p_patch?'starts_at' or p_patch?'ends_at' then
  for resp in select r.user_id from public.calendar_appointment_responsibles r where r.organization_id=p_org and r.appointment_id=p_id loop
   if not public.fn_calendar_service_person_available(p_org,resp.user_id,a.starts_at,a.ends_at,a.id,a.event_type_id)
    then raise exception 'responsible_unavailable' using errcode='PT409',detail=resp.user_id::text; end if;
  end loop;
 end if;
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

create or replace function public.fn_calendar_service_book(p_org uuid,p_actor jsonb,p_input jsonb,p_execution jsonb default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare t public.calendar_event_types;a public.calendar_appointments;fact jsonb;occurrence uuid;contact uuid:=(p_input->>'contact_id')::uuid;
  type_id uuid:=(p_input->>'event_type_id')::uuid;start_at timestamptz:=(p_input->>'starts_at')::timestamptz;
  participant text;participant_name text:=nullif(trim(p_input->>'participant_name'),'');command_key text:=p_input->>'operation_key';
  req uuid[];team uuid[]:='{}';occ_team uuid[];open_row uuid;resp uuid;infl_start timestamptz;infl_end timestamptz;
begin
  perform public.fn_calendar_service_assert_actor(p_org,p_actor,'agent');
  -- RESPONSÁVEIS ADICIONAIS: forma e teto. Membro, principal e disponibilidade vêm mais abaixo, depois da ocupação.
  if p_input?'responsible_user_ids' and jsonb_typeof(p_input->'responsible_user_ids')<>'null' then
    if jsonb_typeof(p_input->'responsible_user_ids')<>'array' then raise exception 'appointment_responsibles_invalid' using errcode='22023';end if;
    if jsonb_array_length(p_input->'responsible_user_ids')>9 then raise exception 'appointment_responsibles_limit' using errcode='22023';end if;
    req:=(select coalesce(array_agg(distinct u.v::uuid order by u.v::uuid),'{}'::uuid[]) from jsonb_array_elements_text(p_input->'responsible_user_ids') u(v));
    if cardinality(req)<>jsonb_array_length(p_input->'responsible_user_ids') then raise exception 'appointment_responsibles_invalid' using errcode='22023';end if;
  end if;
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
      ||jsonb_strip_nulls(jsonb_build_object('space_id',(p_input->>'space_id')::uuid,'party_size',nullif(coalesce((p_input->>'party_size')::integer,1),1)))
      then raise exception 'service_idempotency_conflict' using errcode='PT409';end if;
    if req is not null and req<>public.fn_appointment_responsible_ids(p_org,a.id)
      then raise exception 'service_idempotency_conflict' using errcode='PT409';end if;
    return to_jsonb(a)||jsonb_build_object('deduplicated',true,'responsible_user_ids',to_jsonb(public.fn_appointment_responsible_ids(p_org,a.id)));
  end if;
  select * into t from public.calendar_event_types where organization_id=p_org and id=type_id;
  if not found then raise exception 'service_not_found' using errcode='P0002';end if;
  -- A pessoa já reservada é encontrada antes de consumir vaga ou exigir outro profissional.
  select * into a from public.calendar_appointments where organization_id=p_org and event_type_id=type_id and starts_at=start_at
    and participant_key=participant and status in ('pending','confirmed');
  if found then return to_jsonb(a)||jsonb_build_object('deduplicated',true,'responsible_user_ids',to_jsonb(public.fn_appointment_responsible_ids(p_org,a.id)));end if;
  if p_input?'expected_revision' and t.service_revision is distinct from (p_input->>'expected_revision')::bigint then raise exception 'service_stale' using errcode='PT409';end if;
  fact:=public.fn_calendar_service_check(p_org,type_id,start_at,(p_input->>'owner_user_id')::uuid,null,now(),
    (p_input->>'space_id')::uuid,(p_input->>'party_size')::integer);
  if not coalesce((fact->>'available')::boolean,false) then raise exception '%',fact->>'reason' using errcode='PT409';end if;
  if p_actor->>'type'='user' and fact->>'owner_user_id' is not null and fact->>'owner_user_id' is distinct from p_actor->>'id'
    and not exists(select 1 from public.user_organizations where organization_id=p_org and user_id=(p_actor->>'id')::uuid
      and revoked_at is null and role in ('manager','admin')) and not public.fn_colegas_podem_mexer_na_agenda(p_org)
    then raise exception 'appointment_do_colega' using errcode='42501';end if;
  occurrence:=public.fn_calendar_service_occurrence(p_org,type_id,fact);
  -- EQUIPE DA SESSÃO: quem abre a ocorrência define a equipe; quem entra depois herda e não pode trazer outra.
  infl_start:=start_at-make_interval(mins=>t.buffer_before_minutes);
  infl_end:=(fact->>'ends_at')::timestamptz+make_interval(mins=>t.buffer_after_minutes);
  select a2.id into open_row from public.calendar_appointments a2 where a2.organization_id=p_org and a2.service_occurrence_id=occurrence
    and a2.status in ('pending','confirmed') order by a2.created_at limit 1;
  if found then
    occ_team:=public.fn_appointment_responsible_ids(p_org,open_row);
    if req is not null and req<>occ_team then raise exception 'service_team_conflict' using errcode='PT409';end if;
    team:=occ_team;   -- herança: nenhuma checagem de disponibilidade, a equipe já está ocupando este horário
  else
    team:=coalesce(req,'{}'::uuid[]);
    -- Os adicionais seguem a mesma chave do principal, com a mesma régua de papel do ator.
    if p_actor->>'type'='user' and exists(select 1 from unnest(team) u where u is distinct from (p_actor->>'id')::uuid)
      and not exists(select 1 from public.user_organizations where organization_id=p_org and user_id=(p_actor->>'id')::uuid
        and revoked_at is null and role in ('manager','admin')) and not public.fn_colegas_podem_mexer_na_agenda(p_org)
      then raise exception 'appointment_do_colega' using errcode='42501';end if;
    foreach resp in array team loop
      if resp=(fact->>'owner_user_id')::uuid then raise exception 'appointment_responsibles_invalid' using errcode='22023';end if;
      if not exists(select 1 from public.user_organizations m where m.organization_id=p_org and m.user_id=resp and m.revoked_at is null)
        then raise exception 'appointment_responsibles_invalid' using errcode='22023';end if;
      if not public.fn_calendar_service_person_available(p_org,resp,infl_start,infl_end,null,type_id)
        then raise exception 'responsible_unavailable' using errcode='PT409',detail=resp::text;end if;
    end loop;
  end if;
  insert into public.calendar_appointments(organization_id,event_type_id,title,starts_at,ends_at,time_zone,status,owner_user_id,contact_id,conversation_id,
    description,notes,location_kind,location_details,guest_email,meeting_delivery,created_by_kind,created_by_user_id,source,service_occurrence_id,participant_key,participant_name,
    service_booking_mode,service_capacity_rule,service_capacity_limit,service_rule_revision,service_destination_calendar_id,service_publication_mode,service_requires_confirmation,service_operation_key,service_operation_request,
    service_space_id,service_party_size)
    values(p_org,type_id,coalesce(nullif(p_input->>'title',''),t.name||case when participant_name is null then '' else ' · '||participant_name end),start_at,(fact->>'ends_at')::timestamptz,t.service_timezone,
      case when t.requires_confirmation or (auth.uid() is null and p_input->>'segurar_pendente'='true') then 'pending' else 'confirmed' end,(fact->>'owner_user_id')::uuid,contact,(p_input->>'conversation_id')::uuid,
      nullif(trim(p_input->>'description'),''),nullif(p_input->>'notes',''),t.location_kind,
      case when p_input?'location_details' then nullif(trim(p_input->>'location_details'),'') else t.location_details end,
      nullif(trim(p_input->>'guest_email'),''),coalesce(p_input->'meeting_delivery',jsonb_build_object('state','none')),
      case when p_actor->>'type'='user' then 'user' when p_actor->>'type'='ai_agent' then 'ai' else 'system' end,
      case when p_actor->>'type'='user' then (p_actor->>'id')::uuid else null end,
      case when p_actor->>'type'='user' then 'ui' else 'mcp' end,occurrence,participant,participant_name,
      t.booking_mode,fact->>'capacity_rule',(fact->>'capacity_limit')::integer,t.service_revision,(fact->>'destination_calendar_id')::uuid,t.service_publication_mode,t.requires_confirmation,command_key,
      jsonb_build_object('event_type_id',type_id,'contact_id',contact,'starts_at',start_at,'participant_key',participant)
      ||jsonb_strip_nulls(jsonb_build_object('space_id',(p_input->>'space_id')::uuid,'party_size',nullif(coalesce((p_input->>'party_size')::integer,1),1))),
      (fact->>'space_id')::uuid,coalesce((fact->>'party_size')::integer,1))
    returning * into a;
  foreach resp in array team loop
    insert into public.calendar_appointment_responsibles(organization_id,appointment_id,user_id) values(p_org,a.id,resp);
  end loop;
  return to_jsonb(a)||jsonb_build_object('deduplicated',false,'service_facts',fact,'responsible_user_ids',to_jsonb(team));
end $$;
revoke all on function public.fn_calendar_service_book(uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.fn_calendar_service_book(uuid,jsonb,jsonb,jsonb) to service_role;

create or replace function public.fn_appointment_insert_with_responsibles(p_org uuid,p_f jsonb,p_responsibles uuid[])
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; resp uuid; t_id uuid:=(p_f->>'event_type_id')::uuid;
  owner uuid:=nullif(p_f->>'owner_user_id','')::uuid;
begin
  if auth.uid() is not null and (not public.fn_role_at_least(p_org,'agent') or not public.fn_support_write_allowed(p_org)) then raise exception 'appointment_forbidden' using errcode='42501';end if;
  if auth.uid() is not null and not public.fn_session_mfa_proven() then raise exception 'appointment_mfa_required' using errcode='42501';end if;
  if auth.uid() is not null and not public.fn_role_at_least(p_org,'manager') and not public.fn_colegas_podem_mexer_na_agenda(p_org) and owner is distinct from auth.uid() then raise exception 'appointment_do_colega' using errcode='42501';end if;
  -- Os adicionais seguem a mesma chave do principal: cada um que não é quem pede é agenda de colega.
  if auth.uid() is not null and not public.fn_role_at_least(p_org,'manager') and not public.fn_colegas_podem_mexer_na_agenda(p_org)
    and exists(select 1 from unnest(coalesce(p_responsibles,'{}'::uuid[])) u where u is distinct from auth.uid())
    then raise exception 'appointment_do_colega' using errcode='42501';end if;
  if owner is not null and not exists(select 1 from public.user_organizations m where m.organization_id=p_org and m.user_id=owner and m.revoked_at is null) then raise exception 'appointment_owner_invalid' using errcode='22023';end if;
  if not exists(select 1 from public.calendar_event_types e where e.organization_id=p_org and e.id=t_id) then raise exception 'appointment_event_type_invalid' using errcode='22023';end if;
  if nullif(p_f->>'contact_id','') is not null and not exists(select 1 from public.contacts c where c.organization_id=p_org and c.id=(p_f->>'contact_id')::uuid) then raise exception 'appointment_contact_invalid' using errcode='22023';end if;
  if nullif(p_f->>'conversation_id','') is not null and not exists(select 1 from public.conversations v where v.organization_id=p_org and v.id=(p_f->>'conversation_id')::uuid) then raise exception 'appointment_conversation_invalid' using errcode='22023';end if;
  if jsonb_typeof(coalesce(p_f->'team_guest_user_ids','[]'::jsonb))<>'array' or jsonb_array_length(coalesce(p_f->'team_guest_user_ids','[]'::jsonb))>20 or exists(
    select 1 from jsonb_array_elements_text(coalesce(p_f->'team_guest_user_ids','[]'::jsonb)) g
    where not exists(select 1 from public.user_organizations m where m.organization_id=p_org and m.user_id::text=lower(g) and m.revoked_at is null))
  then raise exception 'appointment_team_guests_invalid' using errcode='22023';end if;
  if auth.uid() is not null then
    p_f:=p_f||jsonb_build_object('created_by_kind','user','created_by_user_id',auth.uid()::text,'source','ui',
      'status',case when (select e.requires_confirmation from public.calendar_event_types e where e.organization_id=p_org and e.id=t_id) then 'pending' else 'confirmed' end);
  end if;
  perform public.fn_calendar_service_lock(p_org);
  if cardinality(coalesce(p_responsibles,'{}'::uuid[]))>9 then raise exception 'appointment_responsibles_limit' using errcode='22023';end if;
  foreach resp in array coalesce(p_responsibles,'{}'::uuid[]) loop
    if resp=owner or not exists(select 1 from public.user_organizations m where m.organization_id=p_org and m.user_id=resp and m.revoked_at is null)
      then raise exception 'appointment_responsibles_invalid' using errcode='22023';end if;
    if not public.fn_calendar_service_person_available(p_org,resp,(p_f->>'starts_at')::timestamptz,(p_f->>'ends_at')::timestamptz,null,t_id)
      then raise exception 'responsible_unavailable' using errcode='PT409',detail=resp::text;end if;
  end loop;
  insert into public.calendar_appointments(id,organization_id,event_type_id,title,starts_at,ends_at,time_zone,status,owner_user_id,contact_id,conversation_id,
    meeting_delivery,location_kind,location_details,description,notes,guest_email,team_guest_user_ids,created_by_kind,created_by_user_id,source)
  values((p_f->>'id')::uuid,p_org,t_id,p_f->>'title',(p_f->>'starts_at')::timestamptz,(p_f->>'ends_at')::timestamptz,p_f->>'time_zone',p_f->>'status',owner,
    nullif(p_f->>'contact_id','')::uuid,nullif(p_f->>'conversation_id','')::uuid,coalesce(p_f->'meeting_delivery','{"state":"none"}'::jsonb),
    p_f->>'location_kind',p_f->>'location_details',p_f->>'description',p_f->>'notes',p_f->>'guest_email',
    coalesce(array(select u::uuid from jsonb_array_elements_text(coalesce(p_f->'team_guest_user_ids','[]'::jsonb)) u),'{}'::uuid[]),
    p_f->>'created_by_kind',nullif(p_f->>'created_by_user_id','')::uuid,p_f->>'source')
  returning * into a;
  foreach resp in array coalesce(p_responsibles,'{}'::uuid[]) loop
    insert into public.calendar_appointment_responsibles(organization_id,appointment_id,user_id) values(p_org,a.id,resp);
  end loop;
  return to_jsonb(a);
end $$;
revoke all on function public.fn_appointment_insert_with_responsibles(uuid,jsonb,uuid[]) from public,anon;
grant execute on function public.fn_appointment_insert_with_responsibles(uuid,jsonb,uuid[]) to authenticated,service_role;

notify pgrst, 'reload schema';
