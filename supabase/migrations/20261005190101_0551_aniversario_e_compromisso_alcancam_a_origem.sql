-- manifest: **O aniversário (`contact.birthday`) e os seis `appointment.*` passam a alcançar a origem do atendimento — nunca a alcançaram desde que existem (issue #2326).** O `fn_service_event_origin` só conhecia seis tipos de evento e o carimbo do `emit_event` só cobria quatro: todo gatilho fora da lista terminava a ação de WhatsApp em `service_boundary_stale`, sem erro em lugar nenhum. As duas pontas agora leem a MESMA tabela `(tipo, entidade) → contato` (`fn_service_event_contact`), que ganha `contact.birthday` e os seis `appointment.*`; `lead.created/stage_changed/tag_added` e `contact.tag_added` passam a ler dela sem mudança de comportamento. Como o aniversário agora envia de verdade e só o cron o emite, `contact.birthday` entra na lista de tipos que o `emit_event` recusa a quem chama com sessão (42501), igual ao `appointment.outcome_confirmed`. Idempotente: `create or replace`; apêndice igual no fim do `baseline.sql`.

-- ============================================================================
-- 0551 — O ANIVERSÁRIO E O COMPROMISSO ALCANÇAM A ORIGEM (#2326)
--
-- O defeito medido na #2326: uma regra de automação cujo gatilho é
-- `contact.birthday` ou um dos seis `appointment.*` e cuja ação é enviar
-- WhatsApp (ou `send_ai_message`, ou `start_message_flow`) NUNCA enviava. O
-- run terminava `failed` com `service_boundary_stale`, porque as duas pontas
-- da origem repetiam a MESMA regra à mão e as duas listas eram menores que os
-- gatilhos que o motor anuncia:
--
--   * `fn_service_event_origin` (0224) resolvia contato só para
--     `lead.created/stage_changed/tag_added`, `contact.tag_added`,
--     `appointment.outcome_confirmed` e `message.received` — qualquer outro
--     tipo caía em `service_event_origin_unsupported` (40001), que
--     `serviceForEvent` engole como origem obsoleta;
--   * o carimbo do `emit_event` (0279) só cobria `lead.created`,
--     `lead.stage_changed`, `lead.tag_added` e `contact.tag_added`.
--
-- Ou seja: mesmo que a resolução conhecesse o tipo, o evento de aniversário
-- nasceria sem `service_origin` e a resolução cairia no `service_stale` final
-- (40001) do mesmo jeito. As duas peças tinham de andar juntas — e andavam
-- separadas porque a mesma tabela de pares `(tipo, entidade) → contato` morava
-- duas vezes.
--
-- ─── O desenho ───────────────────────────────────────────────────────────────
--
-- `fn_service_event_contact` é agora a única tabela de `(tipo, entidade) →
-- contato`, com dois consumidores: o carimbo no instante da emissão
-- (`emit_event`) e a resolução na leitura da origem
-- (`fn_service_event_origin`). Acrescentar um gatilho de contato vira uma
-- linha nela — sem a segunda cadeia que precisa andar junto.
--
-- O retorno é `(contact_id, suportado)` e não só o uuid de propósito: os dois
-- consumidores precisam distinguir "par desconhecido" de "linha ausente" com o
-- MESMO comportamento de hoje — tipo desconhecido continua `unsupported`
-- (40001), e tipo conhecido com linha sumida continua `service_scope_mismatch`
-- (23503), que é o desfecho vigente do `lead` apagado no meio do caminho.
--
-- ─── O que entra, e o que NÃO entra ──────────────────────────────────────────
--
-- Entram: `contact.birthday` (cron `contact-birthdays`, entidade `contact`)
-- e os seis `appointment.created/confirmed/rescheduled/cancelled/completed/
-- no_show` (handler da Agenda, entidade `calendar_appointment`).
-- `appointment.outcome_confirmed` NÃO entra na tabela: ele tem resolução
-- própria em `fn_service_event_origin` (revision + `status='no_show'` +
-- `outcome_recorded_at`), e o ramo especial continua intocado.
--
-- Medido no mesmo caminho e FORA do recorte desta migration (fica para issue
-- própria): os quatro do encanamento do trigger de lead (`lead.won`,
-- `lead.lost`, `lead.reopened`, `lead.assigned`, com `entity_kind='lead'`
-- via `fn_log_event`) e os três gatilhos de relógio do funil
-- (`lead.date_field_due`, `lead.silent_for`, `lead.stage_stale`) também não
-- estão nas duas listas — mesma classe, mesma decisão pendente.
--
-- A prova de banco está em `tests/invariants/automation-send-whatsapp.test.ts`:
-- o aniversário dispara a ação inteira (sem `service_boundary_stale`) e os seis
-- `appointment.*` resolvem a fronteira. Sem o conserto, os dois casos reprovam.
-- ============================================================================

create or replace function public.fn_service_event_contact(p_org uuid,p_event_type text,p_entity_kind text,p_entity_id uuid)
returns table(contact_id uuid,suportado boolean) language plpgsql stable security definer set search_path=public as $$
begin
 if p_event_type in ('lead.created','lead.stage_changed','lead.tag_added') and p_entity_kind='crm_lead' then
   return query select (select l.contact_id from public.crm_leads l where l.organization_id=p_org and l.id=p_entity_id),true;
 elsif p_event_type in ('contact.tag_added','contact.birthday') and p_entity_kind='contact' then
   return query select (select c.id from public.contacts c where c.organization_id=p_org and c.id=p_entity_id),true;
 elsif p_event_type in ('appointment.created','appointment.confirmed','appointment.rescheduled','appointment.cancelled','appointment.completed','appointment.no_show') and p_entity_kind='calendar_appointment' then
   return query select (select a.contact_id from public.calendar_appointments a where a.organization_id=p_org and a.id=p_entity_id),true;
 else
   return query select null::uuid,false;
 end if;
end $$;
revoke all on function public.fn_service_event_contact(uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.fn_service_event_contact(uuid,text,text,uuid) to service_role;

create or replace function public.fn_service_event_origin(p_org uuid,p_event uuid,p_contact uuid,p_session uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public.event_log; origin jsonb; boundary jsonb; current_boundary jsonb; entity_contact uuid; v_suportado boolean; cid uuid; sid uuid; observed jsonb; root_event uuid:=p_event; visited uuid[]:=array[]::uuid[];
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
 if e.event_type='appointment.outcome_confirmed' and e.entity_kind='appointment' then
   select contact_id into entity_contact from public.calendar_appointments where organization_id=p_org and id=e.entity_id and revision=(e.payload->>'appointment_revision')::bigint and status='no_show' and outcome_recorded_at is not null;
 elsif e.event_type='message.received' and e.entity_kind='message' then
   select contact_id,jsonb_build_object('organization_id',organization_id,'contact_id',contact_id,
     'conversation_id',conversation_id,'service_revision',service_revision,'demanda_id',demanda_id,'demanda_revision',demanda_revision)
     into entity_contact,boundary from public.messages where organization_id=p_org and id=e.entity_id and direction='inbound';
 else
   -- O par (tipo, entidade) -> contato vem da MESMA tabela que o carimbo
   -- (`fn_service_event_contact`); se ela nao conhecer o par, segue sendo recusa.
   select f.contact_id, f.suportado into entity_contact, v_suportado
     from public.fn_service_event_contact(p_org,e.event_type,e.entity_kind,e.entity_id) f;
   if not v_suportado then raise exception 'service_event_origin_unsupported' using errcode='40001'; end if;
 end if;
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
  if auth.uid() is not null and p_event_type in (
    'message.received','appointment.outcome_confirmed',
    'ai.case_opened','ai.case_closed','contact.birthday'
  ) then
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
notify pgrst,'reload schema';
