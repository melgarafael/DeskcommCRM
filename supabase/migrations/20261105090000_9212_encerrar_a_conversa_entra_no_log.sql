-- manifest: **Encerrar a conversa passa a existir como fato no `event_log`.** `fn_service_status(…, 'closed')` mudava o status e gravava só a auditoria `conversation.closed`, que não é evento: nenhuma automação podia reagir ao fim do atendimento — e sem esse fato não existe pesquisa de satisfação nem qualquer fluxo pós-atendimento (#4023). Um gatilho `after update of status` em `conversations` emite `conversation.closed` (entidade `conversation`, organização de `new.organization_id`) quando a conversa ENTRA em `closed`, e só então: fechar de novo, conversa já encerrada ou status inalterado não geram linha, e o lote gera um fato por conversa. O emissor é gatilho porque o fechamento tem três escritores (rota de fechamento — reusada pelo lote —, `PATCH` de status e a marcação de contato pessoal) e o próximo caminho nasceria mudo. Falha ao emitir não derruba o fechamento: vira `WARNING` no log do banco. O tipo entra na lista de registro de `fn_event_log_e_registro` (ninguém o consome ainda, então a linha nasce `done` em vez de ficar `pending` para sempre) e na reserva de `emit_event` (sessão de usuário não forja encerramento). Sem tabela, coluna nem dado novo. Idempotente.

-- ---- o fechamento da conversa vira fato no `event_log` (migration 9212) ----
--
-- `fn_service_status(…, 'closed')` mudava o status e o encerramento NÃO virava
-- fato no barramento: a rota gravava só a auditoria `conversation.closed`, e
-- auditoria não é evento — nenhuma automação podia reagir ao fim do
-- atendimento, então não havia como mandar nada depois dele (#4023).
--
-- O EMISSOR É GATILHO, e não a rota, porque o fechamento tem três escritores
-- hoje: a rota `POST /conversations/[id]/close` (que o lote `…/bulk` reusa item
-- a item), o `PATCH` de status (`app/api/v1/conversations/_handler.ts`) e a
-- marcação de contato pessoal, que fecha TODAS as conversas abertas do contato.
-- Emissor em código deixaria o próximo caminho mudo sem ninguém notar — é o
-- mesmo motivo pelo qual `ai.case_closed` nasceu de gatilho (0148).
--
-- UMA VEZ POR TRANSIÇÃO: o `when` só deixa passar a conversa que ENTRA em
-- `closed`. Fechar de novo não muda status nenhum (`fn_service_status` devolve
-- antes do UPDATE, e o `when` cobre o UPDATE direto), então a segunda execução
-- não gera linha. Conversa que reabre e volta a fechar gera OUTRA linha, e isso
-- é o correto: são dois encerramentos.
--
-- FALHA AO EMITIR NÃO DERRUBA O FECHAMENTO: o `exception when others`
-- transforma o erro num `WARNING` do log do banco. Encerrar é o gesto pedido —
-- o mesmo critério que a rota já usa na devolução ao automático. O que se perde
-- é o fato, e ele fica registrado com o id da conversa em vez de sumir calado.
--
-- O TIPO AINDA NÃO TEM CONSUMIDOR: `conversation.closed` entra em
-- `fn_event_log_e_registro` para a linha nascer `done`, e não `pending` para
-- sempre (o defeito da issue #753). A pesquisa 1–5, que é a fatia seguinte da
-- #4023, é quem passa a consumi-lo.

create or replace function public.fn_emit_conversation_closed() returns trigger
  language plpgsql
  security definer
  set search_path = public
as $fn$
begin
  begin
    perform public.emit_event(
      'conversation.closed',
      'conversation',
      new.id,
      jsonb_build_object(
        'conversation_id', new.id,
        'contact_id', new.contact_id,
        'channel_session_id', new.channel_session_id,
        'assigned_to_user_id', new.assigned_to_user_id,
        'service_revision', new.service_revision,
        'closed_at', new.service_closed_at
      ),
      jsonb_build_object('actor_type', 'system', 'actor_id', 'trg_conversation_closed_no_log'),
      new.organization_id
    );
  exception when others then
    raise warning 'conversation.closed nao emitido para a conversa %: %', new.id, sqlerrm;
  end;
  return null;
end $fn$;

revoke all on function public.fn_emit_conversation_closed() from public;
revoke execute on function public.fn_emit_conversation_closed() from anon, authenticated;
grant execute on function public.fn_emit_conversation_closed() to service_role;

drop trigger if exists trg_conversation_closed_no_log on public.conversations;
create trigger trg_conversation_closed_no_log
  after update of status on public.conversations
  for each row
  when (new.status = 'closed' and old.status is distinct from new.status)
  execute function public.fn_emit_conversation_closed();

-- O tipo sem consumidor nasce `done` (registro), não `pending` (fila).
create or replace function public.fn_event_log_e_registro(p_event_type text)
returns boolean
language sql
immutable
set search_path to 'public', 'pg_temp'
as $$
  select p_event_type = any (array[
    -- IA e agente
    'ai.responded',
    'ai_agent.created',
    'ai_agent.published',
    'ai_agent.run_completed',
    'ai_agent.run_failed',
    'ai_agent.run_started',
    -- agente (harness) — o motor registra quando não há negócio para pendurar
    'agent.activity_unrouted',
    -- canal e conversa
    'channel_session.status_changed',
    'conversation.claimed',
    'conversation.closed',
    'conversation.transferred',
    'whatsapp.chat_id_not_recognized',
    'whatsapp.conversation_mark_failed',
    -- contato, lead, organização e plataforma ('lead.reopened' saiu na 0534: ele ganhou consumidor)
    'contact.anonymized',
    'contact.created',
    'contact.deleted',
    'contact.updated',
    'crm.activity_write_failed',
    'incident.resolved',
    'lead.bulk_assigned',
    'lead.bulk_deleted',
    'lead.bulk_tagged',
    'lead.risk_backlog_seeded',
    'lead.updated',
    'org.updated',
    'tenant.onboarded',
    'tenant.reactivated',
    'tenant.suspended',
    'user.profile_updated',
    -- mensagem ('message.failed' saiu aqui na 0417: ele ganhou consumidor)
    'message.outbound',
    'message.sending',
    'message.sent',
    -- LGPD
    'lgpd.export_delivered',
    'lgpd.export_generated',
    'lgpd.redact_applied',
    'lgpd.redact_failed'
  ]::text[]);
$$;

-- Mesma ACL de `fn_log_event` (migration 0034): função pura de leitura, útil no
-- SQL editor de uma instalação, e nunca alcançável pela anon key.
revoke all on function public.fn_event_log_e_registro(text) from public, anon;
grant execute on function public.fn_event_log_e_registro(text) to authenticated, service_role;

-- A reserva: encerramento de conversa não se forja pela sessão do usuário.
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
  -- `lead.stage_stale` entra pela 9206, pela mesma razão do gatilho de data do
  -- funil: quem o emite é só a varredura `lead-time-triggers` (sem sessão), e
  -- a partir dela ele alcança a origem e manda WhatsApp — forjado por login,
  -- seria envio em nome de uma etapa que ninguém parou.
  -- Revogação do turno é fato da tomada nativa, nunca um pedido do login.
  -- `conversation.closed` entra pela 9212: quem o emite é o gatilho do
  -- encerramento (o servidor), e a partir dele uma automação reage ao
  -- atendimento encerrado e manda mensagem ao cliente — forjado por login,
  -- seria mensagem em nome de um encerramento que ninguém fez.
  if auth.uid() is not null and p_event_type in (
    'message.received','appointment.outcome_confirmed',
    'ai.case_opened','ai.case_closed','contact.birthday','contact.phone_added',
    'lead.date_field_due','lead.stage_stale','conversation.autonomous_turn_revoked',
    'conversation.closed'
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

notify pgrst, 'reload schema';
