-- manifest: Tomada humana invalida os turnos autônomos da conversa, sem vencer lembretes ou aprovações.
-- A identidade do atendimento não muda: só o lease do trabalho que perdeu comando.
-- Status terminal não volta a pending quando a conversa é devolvida ao automático.
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
    where j.organization_id = new.organization_id and j.kind = 'followup_turn' and j.status = 'running'
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
     and j.kind in ('inbound_turn', 'case_reply_turn')
     and j.status in ('pending', 'running');
  -- O worker encerra só o turno de follow-up revogado, não a inscrição nem sua política.
  -- transactional_delivery, approved_reply e operator_turn não têm este dono.
  return new;
end;
$$;
revoke execute on function public.fn_interromper_turnos_ao_assumir() from public, anon, authenticated, service_role;
-- Função de trigger: não há RPC/EXECUTE concedido ao caller.
drop trigger if exists trg_interromper_turnos_ao_assumir on public.conversation_assignment_events;
create trigger trg_interromper_turnos_ao_assumir
  after insert on public.conversation_assignment_events
  for each row execute function public.fn_interromper_turnos_ao_assumir();

-- A mesma revogação alcança o envio inline (sem agent-worker/AsyncLocalStorage).
create or replace function public.fn_followup_claim_current(p_org uuid,p_job uuid,p_worker text,p_acquired_at timestamptz)
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.job_queue j where j.organization_id=p_org and j.id=p_job
  and j.kind='followup_turn' and j.status='running' and j.locked_by=p_worker and j.locked_at=p_acquired_at
  and not exists(select 1 from public.event_log r where r.organization_id=p_org
    and r.event_type='conversation.autonomous_turn_revoked' and r.entity_kind='job' and r.entity_id=j.id
    and r.status='done' and r.payload->>'conversation_id'=j.payload->'service_boundary'->>'conversation_id'));
$$;
revoke all on function public.fn_followup_claim_current(uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_followup_claim_current(uuid,uuid,text,timestamptz) to service_role;

-- Pausa permite retomada: descarte é trilha do turno, não cancelamento da inscrição.
create or replace function public.fn_followup_turno_descartado(p_org uuid, p_job uuid)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with gravado as (
    insert into public.followup_enrollment_events
      (organization_id, enrollment_id, node_id, event_type, payload, idempotency_key)
    select p_org, e.id, e.current_node_id, 'turn_discarded',
           jsonb_build_object('job_id', j.id, 'motivo', case when exists (
             select 1 from public.event_log r where r.organization_id=p_org
               and r.event_type='conversation.autonomous_turn_revoked' and r.entity_kind='job'
               and r.entity_id=j.id and r.status='done'
           ) then 'conversation_command_taken' else 'org_nao_operante' end),
           coalesce(j.payload->>'source_step_key', j.id::text) || ':descartado'
      from public.job_queue j
      join public.followup_enrollments e
        on e.organization_id = p_org
       and e.id::text = j.payload->>'followup_enrollment_id'
       and e.current_node_id = j.payload->>'node_id'
       and e.status in ('active', 'waiting_reply', 'dormente', 'paused_handoff', 'paused_manual')
     where j.id = p_job
       and j.organization_id = p_org
       and j.kind = 'followup_turn'
       and j.payload->>'purpose' = 'send_message'
    on conflict (enrollment_id, idempotency_key) where idempotency_key is not null do nothing
    returning 1
  )
  select exists (select 1 from gravado);
$$;

revoke execute on function public.fn_followup_turno_descartado(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_followup_turno_descartado(uuid, uuid) to service_role;

-- Reserva a autoridade nova no emissor público; fn_log_event delega a ele.
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
  -- Revogação do turno é fato da tomada nativa, nunca um pedido do login.
  if auth.uid() is not null and p_event_type in (
    'message.received','appointment.outcome_confirmed',
    'ai.case_opened','ai.case_closed','contact.birthday',
    'conversation.autonomous_turn_revoked'
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
revoke execute on function public.emit_event(text, text, uuid, jsonb, jsonb, uuid) from public, anon;
grant  execute on function public.emit_event(text, text, uuid, jsonb, jsonb, uuid) to authenticated, service_role;
