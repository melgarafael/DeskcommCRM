-- manifest: O título do compromisso passa a ser editável — `title` entra na lista fechada da `fn_appointment_change_core`, com vazio recusado em vez de no-op (#3776).
--
-- 9055 — editar o título do compromisso (#3776, continuação do #3766).
--
-- ─── O defeito (medido na main 2b7c7269d) ───────────────────────────────────
--
-- O #3766 entregou o texto livre na CRIAÇÃO (PR #3775) e declarou a EDIÇÃO
-- fora de escopo. Ela continuava impossível em duas superfícies, e consertar
-- uma só dava no-op silencioso ou 400 confuso:
--
--   1. `app/api/v1/agenda/agendamentos/route.ts` — `alterarSchema` não tinha
--      `title`, e como o objeto não é `.strict()` o campo era DESCARTADO e o
--      `.refine` respondia "Informe pelo menos um campo para alterar" (400),
--      mentindo sobre a causa;
--   2. AQUI — `fn_appointment_change_core` aplica `p_patch` por lista FECHADA.
--      Sem `title` na lista, o `update` devolveria sucesso mudando nada.
--
-- ─── A regra ────────────────────────────────────────────────────────────────
--
-- `title=case when p_patch?'title' then btrim(p_patch->>'title') else title end`
-- no mesmo `update` que as outras colunas: mesma linha, mesma trava, mesmo CAS.
--
-- Três decisões escritas, porque cada uma tem uma alternativa plausível:
--
--   a. VAZIO É RECUSA (`appointment_title_empty`, 22023) — não "volte ao nome
--      do tipo". Na criação o vazio tem destino (o nome do tipo, `#3766`); na
--      edição, o compromisso já tem título próprio e o tipo pode ter mudado
--      desde a marcação. Voltar ao molde trocaria o texto por outro que ninguém
--      escolheu; recusar deixa a decisão com quem edita.
--   b. NULL/ausente NÃO MEXE (`p_patch?'title'` distingue os dois): `patch` sem
--      a chave preserva o título, e a chave com nulo cai na recusa do item (a) —
--      nunca numa violação de `not null` em inglês.
--   c. `revision` NÃO sobe, e o CAS não muda. `fn_appointment_stamp` incrementa
--      `revision` quando muda o COMBINADO (`starts_at`/`ends_at`/`status`/
--      `contact_id`/`conversation_id`); `title` é conteúdo, como `notes` e
--      `guest_email`, que também não mexem na revisão. Quem leva a mudança ao
--      Google é `google_local_revision`, e `fn_google_projection_stamp` já lê
--      `new.title` (baseline, `changed:=row(...,new.title,...)`): o hash do
--      grupo `title` sai do `summary` da projeção (`lib/agenda/google/sync-model.ts`),
--      então o evento remoto é reempurrado — nenhuma linha de código muda lá.
--
-- ─── Baseline ───────────────────────────────────────────────────────────────
--
-- O espelho entra no apêndice do `supabase/baseline.sql` ANTES da última
-- chamada de `fn_aplicar_travas_de_suporte()`: bloco depois dela não roda numa
-- instalação nova (#3465).

-- ---- editar o título do compromisso (migration 9055, #3776) ----
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
notify pgrst,'reload schema';
