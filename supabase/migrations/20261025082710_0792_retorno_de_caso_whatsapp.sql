-- manifest: A resposta solicitada ao cliente gera aviso recuperável no mesmo Caso, com identidade por atualização e comando humano vinculado ao ciclo.
-- DIRC: somente o ponteiro do fato persistido; texto continua em agent_case_events.
-- Legado/abertura preservados como update_event_id NULL; não há replay/backfill.
alter table public.entregas_de_aviso_de_caso add column if not exists update_event_id uuid;
create unique index if not exists agent_case_events_notice_ref
  on public.agent_case_events(organization_id,case_id,id);
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.entregas_de_aviso_de_caso'::regclass and conname='entrega_atualizacao_do_mesmo_caso') then
  alter table public.entregas_de_aviso_de_caso add constraint entrega_atualizacao_do_mesmo_caso
   foreign key(organization_id,case_id,update_event_id)
   references public.agent_case_events(organization_id,case_id,id) on delete cascade;
 end if;
end $$;
-- Primeiro instala as novas chaves, depois remove a antiga; reaplicar é seguro.
create unique index if not exists entregas_de_aviso_abertura_unica
 on public.entregas_de_aviso_de_caso(organization_id,case_id,destino) where update_event_id is null;
create unique index if not exists entregas_de_aviso_atualizacao_unica
 on public.entregas_de_aviso_de_caso(organization_id,case_id,destino,update_event_id) where update_event_id is not null;
drop index if exists public.entregas_de_aviso_de_caso_unica;

-- Leitura server-only: nenhum conteúdo vem da carga do event_log ou do comando.
create or replace function public.fn_ler_retorno_de_caso(
 p_org uuid,p_case uuid,p_event uuid,p_config_revision text
) returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('info',e.body,'ask',pedido.body,'contactId',c.contact_id,'conversationId',c.id)
 from public.agent_case_events e
 join public.agent_cases ac on ac.organization_id=e.organization_id and ac.id=e.case_id
 join public.conversations c on c.organization_id=ac.organization_id and c.id=ac.conversation_id
 join public.config_aviso_de_caso cfg on cfg.organization_id=ac.organization_id
 join public.agent_case_events pedido on pedido.organization_id=e.organization_id
  and pedido.case_id=e.case_id and pedido.id::text=e.metadata->>'request_event_id'
 left join public.demandas d on d.organization_id=c.organization_id and d.contact_id=c.contact_id and d.id=c.current_demanda_id
 where e.organization_id=p_org and e.case_id=p_case and e.id=p_event
  and e.kind='lead_provided' and e.actor_kind='lead' and e.body is not null
  and ac.status='awaiting_human' and not c.is_group
  and cfg.ligado and cfg.channel_session_id is not null and cfg.updated_at::text=p_config_revision
  and pedido.kind='human_replied' and pedido.human_action='need_lead_info'
  and pedido.id=(select n.id from public.agent_case_events n where n.organization_id=p_org
   and n.case_id=p_case and n.kind='human_replied' order by n.created_at desc,n.id desc limit 1)
  and public.fn_meet_boundary_current((ac.context_snapshot->'service_boundary') ||
   case when ac.context_snapshot->'service_boundary'->>'demanda_id' is null
    then jsonb_build_object('demanda_id',c.current_demanda_id,'demanda_revision',d.revision)
    else '{}'::jsonb end)
$$;
revoke all on function public.fn_ler_retorno_de_caso(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fn_ler_retorno_de_caso(uuid,uuid,uuid,text) to service_role;

create or replace function public.fn_responder_caso_por_whatsapp(
  p_org uuid,
  p_case uuid,
  p_session uuid,
  p_phone_variants text[],
  p_action text,
  p_body text,
  p_message_key text,
  p_update_event uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_contact_id uuid;
  v_delivery_id uuid;
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
     and entrega.update_event_id is not distinct from p_update_event
     and p_update_event is not distinct from (
       select e.id from public.agent_case_events e where e.organization_id=p_org
        and e.case_id=p_case and e.kind='lead_provided' order by e.created_at desc,e.id desc limit 1)
     and (p_update_event is null or public.fn_ler_retorno_de_caso(p_org,p_case,p_update_event,
       (select cfg.updated_at::text from public.config_aviso_de_caso cfg where cfg.organization_id=p_org)) is not null)
   order by entrega.enviado_em desc,entrega.id desc limit 1
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
      (organization_id, case_id, kind, actor_kind, human_action, body, metadata)
    values
      (p_org, p_case, 'human_replied', 'human', 'resolved', p_body,
       jsonb_build_object('source', 'whatsapp', 'whatsapp_message_key', p_message_key,
                          'channel_session_id', p_session, 'delivery_id', v_delivery_id, 'update_event_id', p_update_event)),
      (p_org, p_case, 'resolved', 'human', null, null,
       jsonb_build_object('source', 'whatsapp', 'channel_session_id', p_session));
  else
    update public.agent_cases
       set status = 'awaiting_lead', updated_at = now()
     where organization_id = p_org and id = p_case and status = 'awaiting_human';
    if not found then return 'case_unavailable'; end if;

    insert into public.agent_case_events
      (organization_id, case_id, kind, actor_kind, human_action, body, metadata)
    values
      (p_org, p_case, 'human_replied', 'human', 'need_lead_info', p_body,
       jsonb_build_object('source', 'whatsapp', 'whatsapp_message_key', p_message_key,
                          'channel_session_id', p_session, 'delivery_id', v_delivery_id, 'update_event_id', p_update_event)),
      (p_org, p_case, 'lead_asked', 'human', null, null,
       jsonb_build_object('source', 'whatsapp', 'channel_session_id', p_session));
  end if;

  -- A transição, os eventos e a retomada entram no mesmo commit. Se a fila não
  -- aceitar o job, o webhook pode ser reentregue e nenhum caso fica sem retomada.
  insert into public.job_queue (organization_id, contact_id, kind, payload)
  values (
    p_org,
    v_contact_id,
    'case_reply_turn',
    jsonb_build_object('case_id', p_case, 'action', p_action, 'body', p_body)
  );

  return 'accepted';
end;
$$;

revoke all on function public.fn_responder_caso_por_whatsapp(uuid, uuid, uuid, text[], text, text, text, uuid) from public,anon,authenticated;
grant execute on function public.fn_responder_caso_por_whatsapp(uuid, uuid, uuid, text[], text, text, text, uuid) to service_role;

create or replace function public.fn_responder_caso_por_whatsapp(
 p_org uuid,p_case uuid,p_session uuid,p_phone_variants text[],p_action text,p_body text,p_message_key text
) returns text language sql security invoker set search_path=public,pg_temp as $$
 select public.fn_responder_caso_por_whatsapp(p_org,p_case,p_session,p_phone_variants,p_action,p_body,p_message_key,null::uuid)
$$;
revoke all on function public.fn_responder_caso_por_whatsapp(uuid,uuid,uuid,text[],text,text,text) from public,anon,authenticated;
grant execute on function public.fn_responder_caso_por_whatsapp(uuid,uuid,uuid,text[],text,text,text) to service_role;

CREATE OR REPLACE FUNCTION public.emit_event(p_event_type text, p_entity_kind text, p_entity_id uuid, p_payload jsonb DEFAULT '{}'::jsonb, p_metadata jsonb DEFAULT '{}'::jsonb, p_organization_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org_id uuid;
  v_event_id uuid;
  v_contact uuid;
  v_origin jsonb;
begin
  -- message.received nasce somente do INSERT inbound interno. Um chamador
  -- público não pode reapresentar uma mensagem existente como evento novo.
  -- `ai.case_opened`/`ai.case_closed` entram pela mesma razão (0279): o caso é
  -- do motor, e um evento de caso forjado por login move o funil e acorda o
  -- agente em nome de uma decisão que ninguém tomou.
  -- `contact.birthday` entra pela 0551: só o cron (`contact-birthdays`, sem
  -- sessão) o emite, e a partir desta migration ele alcança a origem e manda
  -- WhatsApp de verdade — forjado por login, seria envio em nome de um
  -- aniversário que ninguém fez.
  -- `contact.phone_added` entra pela 0670, pela mesma razão do aniversário:
  -- quem o emite é o servidor (o PATCH de contatos, com a chave de serviço,
  -- depois de gravar o número), e ele alcança a origem e manda WhatsApp.
  -- `lead.date_field_due` entra pela 0743, como o aniversário: quem o emite é
  -- só o cron `lead-date-field-due` (sem sessão), e a partir dela ele alcança a
  -- origem e manda WhatsApp.
  -- Revogação do turno é fato da tomada nativa, nunca um pedido do login.
  if auth.uid() is not null and p_event_type in (
    'message.received','appointment.outcome_confirmed',
    'ai.case_opened','ai.case_closed','ai.case_updated','contact.birthday','contact.phone_added',
    'lead.date_field_due','conversation.autonomous_turn_revoked'
  ) then
    raise exception 'reserved_message_received' using errcode='42501';
  end if;
  -- Desfecho e responsável do negócio só nascem do gatilho de `crm_leads`
  -- (`fn_emit_event_on_lead_change`), quando a linha muda de fato. Nenhum
  -- emissor do app os pede por RPC; os consumidores produzem efeito real
  -- (push, webhook de saída, conversão de anúncio).
  if auth.uid() is not null
     and p_event_type in ('lead.won','lead.lost','lead.reopened','lead.assigned')
     and coalesce(current_setting('deskcomm.desfecho_pelo_negocio', true), '') <> 'on' then
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

  -- A ORIGEM E RESERVADA AO SERVIDOR — ENTAO O SERVIDOR TEM DE ESCREVE-LA.
  --
  -- O bloco acima recusa `service_origin` vindo de chamador autenticado (42501,
  -- e com razao: e o campo que AUTORIZA efeito operacional, nao payload
  -- publico). So que ninguem o escrevia no lugar dele. Efeito medido: quem move
  -- o negocio pela IA carimba a origem no servidor (`agent-stage-sync`,
  -- `appointment-stage-move`, `handoff-stage-move`) e o follow-up nasce; quem
  -- move PELO QUADRO — o operador, pela rota HTTP autenticada — emitia um
  -- evento SEM origem, `fn_service_event_origin` caia no `service_stale` final
  -- (40001), `serviceForEvent` engolia como `stale_origin` e o follow-up nunca
  -- nascia. Sem erro em lugar nenhum: o gatilho de etapa era inalcancavel pelo
  -- caminho que o produto oferece na tela.
  --
  -- O retrato e tirado AQUI, no instante da emissao, que e exatamente a
  -- semantica de procedencia que a 0223 quer: "quando este evento nasceu, o
  -- atendimento estava assim". A resolucao do contato vem da mesma tabela de
  -- `fn_service_event_contact` — se ela nao souber resolver o tipo, nao ha o que
  -- carimbar e o evento segue sem origem, como antes.
  if not (coalesce(p_payload,'{}'::jsonb) ? 'service_origin')
     and not (coalesce(p_metadata,'{}'::jsonb) ? 'service_origin') then
    select f.contact_id into v_contact
      from public.fn_service_event_contact(v_org_id, p_event_type, p_entity_kind, p_entity_id) f;
    if v_contact is not null
       and exists(select 1 from public.contacts
                   where organization_id=v_org_id and id=v_contact
                     and not is_anonymized and is_merged_into is null) then
      v_origin := jsonb_build_object('kind','command',
        'observed', public.fn_service_observe_command(v_org_id, v_contact));
    end if;
  end if;

  insert into public.event_log
    (organization_id, event_type, entity_kind, entity_id, payload, metadata)
  values
    (v_org_id, p_event_type, p_entity_kind, p_entity_id,
     coalesce(p_payload, '{}'::jsonb)
       || case when v_origin is null then '{}'::jsonb else jsonb_build_object('service_origin', v_origin) end,
     coalesce(p_metadata, '{}'::jsonb)
       || jsonb_build_object('emitted_at', extract(epoch from now())))
  returning id into v_event_id;

  return v_event_id;
end $function$;
notify pgrst,'reload schema';
