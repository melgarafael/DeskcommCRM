-- manifest: **A agenda aceita convidados da equipe e leva o contexto do negócio ao evento do Google (#4006).** `calendar_appointments.team_guest_user_ids` (uuid[], default vazio) guarda as pessoas da ORGANIZAÇÃO convidadas além do responsável e do `guest_email`; `fn_google_projection_stamp` passa a tratá-la como campo publicável, então incluir ou tirar convidado empurra o compromisso para o worker do Google sem um segundo mecanismo de gatilho. `calendar_event_types.levar_dados_do_negocio` (boolean, default FALSE — doc 272 = B) é o interruptor do bloco do negócio na descrição, ligado na tela do tipo. Aditiva e sem perda: compromisso antigo carrega com a lista vazia e todo tipo existente nasce com o interruptor desligado, então quem atualiza não passa a mandar dado do cliente ao Google sem decidir.
--
-- ─── POR QUE ARRAY NA PRÓPRIA LINHA, E NÃO TABELA DE CONVIDADOS ─────────────
--
-- A proposta da issue era uma tabela `calendar_appointment_team_guests`. O que
-- decidiu contra foi o mecanismo que leva a mudança ao Google: quem publica é
-- `fn_google_projection_stamp`, um gatilho BEFORE INSERT OR UPDATE **na linha do
-- compromisso**, que compara colunas dela para incrementar `google_local_revision`
-- e agendar a escrita. Com tabela separada, incluir um convidado não muda coluna
-- nenhuma do compromisso: o worker nunca saberia que há algo a publicar, e o
-- conserto seria um segundo gatilho, um `update` artificial na linha e mais uma
-- policy de RLS para o mesmo dado que já é 1:1 do compromisso.
--
-- O conjunto é pequeno (teto de 20 na rota), sempre lido e escrito JUNTO com o
-- compromisso, e é o Google que precisa da lista inteira de uma vez — não há
-- consulta por convidado. `to_jsonb(a)` já entrega a coluna ao snapshot do
-- worker, sem view nem RPC nova. A conferência de organização mora na rota, na
-- edição em `fn_appointment_change_core` e no resolvedor de e-mails
-- (`lib/agenda/google/convidados-da-equipe.ts`), porque array não aceita FK; é a
-- mesma régua nos três caminhos.

alter table public.calendar_appointments
  add column if not exists team_guest_user_ids uuid[] not null default '{}'::uuid[];

comment on column public.calendar_appointments.team_guest_user_ids is
  'Pessoas da ORGANIZAÇÃO convidadas para o compromisso, além do responsável (owner_user_id) e do e-mail digitado (guest_email). O convidado NÃO vira dono: carteira, distribuição e métricas continuam no owner_user_id. O worker resolve cada id no e-mail da conta Google conectada (a saudável primeiro) ou, sem conta, no e-mail de login, e entra em attendees com responseStatus=needsAction (migration 9209).';

alter table public.calendar_event_types
  add column if not exists levar_dados_do_negocio boolean not null default false;

comment on column public.calendar_event_types.levar_dados_do_negocio is
  'true = a descrição do evento no Google leva, DEPOIS do texto do compromisso, o bloco do negócio (negócio, etapa, produtos da proposta vigente, cliente, telefone e link do CRM). DESLIGADO de fábrica (doc 272 = B): com e-mail na ficha, o próprio cliente é convidado e lê a descrição, e atualizar o sistema não pode mandar esses dados para fora sem alguém decidir. Liga-se na tela do tipo. Só compromissos futuros recebem o bloco (migration 9209).';

-- A coluna nova é campo PUBLICÁVEL: sem ela nas duas comparações abaixo, mudar
-- quem participa não incrementaria `google_local_revision` e a alteração nunca
-- chegaria ao Google.
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
 decision:=public.fn_calendar_service_can_resolve(old.organization_id,old.id) and public.fn_role_at_least(new.organization_id,'agent') and public.fn_support_write_allowed(new.organization_id)
  and old.google_conflict is not null and new.google_conflict-'resolution'=old.google_conflict-'resolution'
  and new.google_conflict->'resolution'->>'actor_id'=auth.uid()::text
  and new.google_conflict->'resolution'->>'choice' in ('google','local','preserve_remote')
  and old.google_conflict->>'revision'=old.revision::text and old.google_conflict->>'local_revision'=old.google_local_revision::text
  and old.google_conflict->>'etag' is not distinct from old.google_etag;
 if auth.uid() is not null and (row(new.google_synced_at,new.google_sync_error) is distinct from row(old.google_synced_at,old.google_sync_error)
  or (new.google_next_attempt_at is distinct from old.google_next_attempt_at and not coalesce(public.fn_calendar_service_can_resolve(old.organization_id,old.id) and public.fn_role_at_least(new.organization_id,'agent') and public.fn_support_write_allowed(new.organization_id)
    and new.google_next_attempt_at<=clock_timestamp() and (old.google_conflict is null or decision),false))) then
  raise exception 'google_metadata_private' using errcode='42501';end if;
 if auth.uid() is not null and ((new.google_conflict is distinct from old.google_conflict and not coalesce(decision,false)) or row(new.google_base_projection,new.google_pending_write,new.google_claim_token,new.google_claim_epoch,new.google_claim_until,new.google_synced_local_revision,new.google_etag,new.google_connection_id,new.google_calendar_id,new.google_event_id)
  is distinct from row(old.google_base_projection,old.google_pending_write,old.google_claim_token,old.google_claim_epoch,old.google_claim_until,old.google_synced_local_revision,old.google_etag,old.google_connection_id,old.google_calendar_id,old.google_event_id)) then
  raise exception 'google_metadata_private' using errcode='42501';
 end if;
 changed:=row(new.starts_at,new.ends_at,new.time_zone,new.status='cancelled',new.title,new.description,new.location_kind,new.location_details,new.guest_email,new.team_guest_user_ids)
  is distinct from row(old.starts_at,old.ends_at,old.time_zone,old.status='cancelled',old.title,old.description,old.location_kind,old.location_details,old.guest_email,old.team_guest_user_ids);
 -- Única entrada que modifica base e domínio juntos é o núcleo service-only.
 -- Não há GUC ou flag no body público que suprima revisão.
 inbound:=row(new.title,new.description,new.location_kind,new.location_details,new.guest_email,new.team_guest_user_ids) is not distinct from row(old.title,old.description,old.location_kind,old.location_details,old.guest_email,old.team_guest_user_ids) and auth.uid() is null and new.google_base_projection is distinct from old.google_base_projection
  and (new.google_base_projection->'shared'->>'starts_at')::timestamptz=new.starts_at
  and (new.google_base_projection->'shared'->>'ends_at')::timestamptz=new.ends_at
  and new.google_base_projection->'shared'->>'time_zone'=new.time_zone
  and (new.google_base_projection->'shared'->>'cancelled')::boolean=(new.status='cancelled');
 new.google_local_revision:=old.google_local_revision+case when changed and not coalesce(inbound,false) then 1 else 0 end;
 if changed then new.google_next_attempt_at:=now(); end if;
 return new;
end;$$;
revoke all on function public.fn_google_projection_stamp() from public,anon,authenticated;

-- A RPC de transição aplica `p_patch` por LISTA FECHADA: sem esta cláusula, editar
-- a equipe devolvia 200 e a lista ficava como estava. Ausente não mexe; `[]` limpa.
-- `p_remote` continua recusando a chave: o Google nunca altera quem é convidado.
-- Corpo idêntico ao da 9055 (a última definição), mais a linha de
-- `team_guest_user_ids`, logo abaixo de `guest_email`, e a recusa nomeada da lista.
create or replace function public.fn_appointment_change_core(p_org uuid,p_id uuid,p_revision bigint,p_patch jsonb,p_remote boolean,p_base jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; contact uuid; origin jsonb; event_id uuid; service_fact jsonb; service_occurrence uuid; service_owner uuid;
 service_confirmation_required boolean;service_next_status text;
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

notify pgrst, 'reload schema';
