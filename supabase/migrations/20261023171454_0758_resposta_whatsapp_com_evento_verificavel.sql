-- manifest: Integra a resposta WhatsApp interna ao evento e job canônicos com revalidação do opt-in e recibo, sem inventar usuário do CRM.
-- Revalida a delegação nativa sem inventar um usuário ou papel do CRM.
create or replace function public.fn_case_whatsapp_event_valid(
  p_org uuid,p_case uuid,p_event uuid,p_job text
) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce(exists(
  select 1 from public.agent_case_events e
  join public.agent_cases ac on ac.organization_id=e.organization_id and ac.id=e.case_id
  join public.conversations c on c.organization_id=ac.organization_id and c.id=ac.conversation_id
  left join public.demandas d on d.organization_id=c.organization_id and d.contact_id=c.contact_id and d.id=c.current_demanda_id
  join public.job_queue j on j.organization_id=e.organization_id and j.id::text=p_job
   and j.contact_id=c.contact_id and j.kind='case_reply_turn'
   and j.payload->>'case_id'=e.case_id::text and j.payload->>'human_event_id'=e.id::text
   and j.payload->>'action'=e.human_action
  join public.entregas_de_aviso_de_caso entrega on entrega.organization_id=e.organization_id
   and entrega.case_id=e.case_id and entrega.id::text=e.metadata->'review_context_v1'->>'delivery_id'
   and entrega.status='enviado'
  join public.config_aviso_de_caso cfg on cfg.organization_id=e.organization_id
   and cfg.ligado and cfg.resposta_whatsapp_habilitada
   and cfg.channel_session_id=entrega.channel_session_id and cfg.telefone_destino=entrega.destino
   and to_jsonb(extract(epoch from cfg.updated_at))=e.metadata->'review_context_v1'->'consent_revision'
  where e.organization_id=p_org and e.case_id=p_case and e.id=p_event
   and e.kind='human_replied' and e.actor_kind='human' and e.actor_user_id is null
   and e.metadata->>'source'='whatsapp' and e.metadata->>'whatsapp_message_key' is not null
   and e.metadata->'review_context_v1'->>'versao'='1'
   and e.metadata->'review_context_v1'->>'origem'='case_reply_internal_whatsapp'
   and e.metadata->'review_context_v1'->>'job_id'=j.id::text
   and e.metadata->'review_context_v1'->>'channel_session_id'=cfg.channel_session_id::text
   and e.metadata->'review_context_v1'->>'revoked_at' is null
   and j.payload->'service_boundary'=ac.context_snapshot->'service_boundary'
   -- Null→primeira demanda continua o mesmo atendimento, como no contrato comum.
   and public.fn_meet_boundary_current((ac.context_snapshot->'service_boundary') ||
    case when ac.context_snapshot->'service_boundary'->>'demanda_id' is null
     then jsonb_build_object('demanda_id',c.current_demanda_id,'demanda_revision',d.revision)
     else '{}'::jsonb end)
   and not exists(select 1 from public.agent_case_events n where n.organization_id=e.organization_id
    and n.case_id=e.case_id and n.kind in('human_replied','cancelled','escalated')
    and (n.created_at,n.id)>(e.created_at,e.id))
 ),false);
$$;
revoke all on function public.fn_case_whatsapp_event_valid(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fn_case_whatsapp_event_valid(uuid,uuid,uuid,text) to service_role;

create or replace function public.fn_responder_caso_por_whatsapp(
  p_org uuid,
  p_case uuid,
  p_session uuid,
  p_phone_variants text[],
  p_action text,
  p_body text,
  p_message_key text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_contact_id uuid;
  v_delivery_id uuid;
  v_event_id uuid := gen_random_uuid();
  v_job_id uuid := gen_random_uuid();
  v_consent_revision numeric;
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role'
  );
begin
  if coalesce(v_role, '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('resolved', 'need_lead_info') then
    raise exception 'invalid_case_reply_action' using errcode = '22023';
  end if;
  if p_body is null or char_length(btrim(p_body)) not between 1 and 4000 then
    raise exception 'invalid_case_reply_body' using errcode = '22023';
  end if;
  if p_message_key is null or char_length(p_message_key) not between 1 and 300 then
    raise exception 'invalid_case_reply_message_key' using errcode = '22023';
  end if;

  -- Serializa a reentrega do mesmo webhook. Se o mesmo id chegar depois que o
  -- caso for reaberto para uma pergunta nova, continua sendo a mesma resposta.
  perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':' || p_message_key, 0));
  if exists (
    select 1 from public.agent_case_events e
     where e.organization_id = p_org
       and e.kind = 'human_replied'
       and e.metadata->>'whatsapp_message_key' = p_message_key
  ) then
    return 'duplicate';
  end if;

  -- O telefone e o canal precisam continuar sendo os configurados agora, e o
  -- caso precisa ter sido efetivamente avisado por essa mesma conexão e destino.
  -- A entrega enviada é a prova que a pessoa recebeu autorização para responder.
  if not exists (
    select 1
      from public.config_aviso_de_caso cfg
     where cfg.organization_id = p_org
       and cfg.ligado = true
       and cfg.resposta_whatsapp_habilitada = true
       and cfg.channel_session_id = p_session
       and cfg.telefone_destino = any(p_phone_variants)
     for update
  ) then
    return 'unauthorized';
  end if;

  select extract(epoch from updated_at) into v_consent_revision
    from public.config_aviso_de_caso where organization_id=p_org;

  select conv.contact_id, entrega.id
    into v_contact_id, v_delivery_id
    from public.agent_cases caso
    join public.conversations conv
      on conv.organization_id = caso.organization_id
     and conv.id = caso.conversation_id
    join public.entregas_de_aviso_de_caso entrega
      on entrega.organization_id = caso.organization_id
     and entrega.case_id = caso.id
   where caso.organization_id = p_org
     and caso.id = p_case
     and caso.status = 'awaiting_human'
     and entrega.status = 'enviado'
     and entrega.channel_session_id = p_session
     and entrega.destino = any(p_phone_variants)
   for update of caso;

  if v_delivery_id is null or v_contact_id is null then
    return 'case_unavailable';
  end if;

  if p_action = 'resolved' then
    update public.agent_cases
       set status = 'resolved', closed_at = now(), updated_at = now()
     where organization_id = p_org and id = p_case and status = 'awaiting_human';
    if not found then return 'case_unavailable'; end if;

    insert into public.agent_case_events
      (id, organization_id, case_id, kind, actor_kind, human_action, body, metadata)
    values
      (v_event_id, p_org, p_case, 'human_replied', 'human', 'resolved', p_body,
       jsonb_build_object('source', 'whatsapp', 'whatsapp_message_key', p_message_key,
                          'channel_session_id', p_session)),
      (gen_random_uuid(), p_org, p_case, 'resolved', 'human', null, null,
       jsonb_build_object('source', 'whatsapp', 'channel_session_id', p_session));
  else
    update public.agent_cases
       set status = 'awaiting_lead', updated_at = now()
     where organization_id = p_org and id = p_case and status = 'awaiting_human';
    if not found then return 'case_unavailable'; end if;

    insert into public.agent_case_events
      (id, organization_id, case_id, kind, actor_kind, human_action, body, metadata)
    values
      (v_event_id, p_org, p_case, 'human_replied', 'human', 'need_lead_info', p_body,
       jsonb_build_object('source', 'whatsapp', 'whatsapp_message_key', p_message_key,
                          'channel_session_id', p_session)),
      (gen_random_uuid(), p_org, p_case, 'lead_asked', 'human', null, null,
       jsonb_build_object('source', 'whatsapp', 'channel_session_id', p_session));
  end if;

  -- Uma resposta interna autenticada pelo canal não tem login do CRM.
  -- Guardamos a prova delegada, não atribuímos o ator da configuração à resposta.
  update public.agent_case_events set metadata=metadata || jsonb_build_object(
    'review_context_v1',jsonb_build_object('versao',1,'origem','case_reply_internal_whatsapp',
      'job_id',v_job_id,'delivery_id',v_delivery_id,'channel_session_id',p_session,
      'consent_revision',v_consent_revision))
   where organization_id=p_org and case_id=p_case and id=v_event_id;

  -- A transição, os eventos e a retomada entram no mesmo commit. Se a fila não
  -- aceitar o job, o webhook pode ser reentregue e nenhum caso fica sem retomada.
  insert into public.job_queue (id, organization_id, contact_id, kind, payload)
  values (
    v_job_id,
    p_org,
    v_contact_id,
    'case_reply_turn',
    jsonb_build_object('case_id', p_case, 'action', p_action, 'body', p_body,'human_event_id',v_event_id)
  );

  return 'accepted';
end;
$$;

revoke all on function public.fn_responder_caso_por_whatsapp(uuid, uuid, uuid, text[], text, text, text)
  from public, anon, authenticated;
grant execute on function public.fn_responder_caso_por_whatsapp(uuid, uuid, uuid, text[], text, text, text)
  to service_role;


notify pgrst,'reload schema';
