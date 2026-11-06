-- manifest: **O gatilho "lead parado N dias na mesma etapa" (`lead.stage_stale`, entidade `crm_lead`) passa a alcançar a origem do atendimento — a mesma classe que a 0743 consertou para `lead.date_field_due` (issue #4018).** A varredura `app/api/v1/cron/lead-time-triggers` emite o evento com `p_entity_kind='crm_lead'` e SEM `service_origin` no payload, e `fn_service_event_contact` — a tabela única `(tipo, entidade) → contato` que o carimbo do `emit_event` e a resolução de `fn_service_event_origin` leem — não conhecia o par: nenhum ramo da função o alcançava, a resolução recusava com `service_event_origin_unsupported` (`PT409`), `serviceForEvent` devolvia `null` e `serviceForAutomation` lançava `StaleServiceBoundaryError` — a ação de WhatsApp terminava `failed`/`service_boundary_stale` sem erro em lugar nenhum. O par novo entra na lista `crm_lead` que a função já mantinha, ao lado de `lead.created/stage_changed/tag_added/date_field_due`: as DUAS pontas passam a reconhecê-lo pela mesma linha. Não se toca no emissor (a origem é DERIVADA pelo par, não inventada no cron) e nenhum par existente é afrouxado: `lead.silent_for` e os quatro `lead.*` de `entity_kind='lead'` continuam fora, como a 0743 deixou. O `emit_event` passa a reservar `lead.stage_stale` ao servidor, como `lead.date_field_due` (0743): só a varredura, sem sessão, o emite. Idempotente: `create or replace`; apêndice igual no fim do `baseline.sql`, antes da VARREDURA anon (0116).

-- ============================================================================
-- 9206 — O GATILHO DE ETAPA PARADA ALCANÇA A ORIGEM (#4018)
--
-- O defeito medido na #4018, numa instalação real (v1.100.0, imagens do GHCR):
-- TODA regra cujo gatilho é "Quando um lead ficar N dias na mesma etapa"
-- (`lead.stage_stale`) e cuja ação é enviar WhatsApp terminava `partial`, com a
-- ação de envio em `failed`/`service_boundary_stale`. É a MESMA classe do
-- #3286, que a 0743 consertou para `lead.date_field_due` — e a própria 0743
-- nomeia `lead.stage_stale` como pendente ("mesma classe, issues próprias").
-- Esta é a issue própria.
--
-- ─── A causa ────────────────────────────────────────────────────────────────
--
-- O gatilho é emitido por `app/api/v1/cron/lead-time-triggers/route.ts` com
-- `p_event_type = regra.trigger_event` (`'lead.stage_stale'`) e
-- `p_entity_kind='crm_lead'`, e sem `service_origin` no payload — pela razão
-- certa: origem é campo reservado ao SERVIDOR, e é ele que tem de escrevê-la.
--
-- As duas pontas que escrevem e leem essa origem consultam a MESMA tabela de
-- pares `(tipo, entidade) → contato`, `fn_service_event_contact`:
--
--   * o carimbo do `emit_event` (a resolução que vira `service_origin` no
--     instante da emissão) — sem o par, o evento nasce SEM origem;
--   * a resolução de `fn_service_event_origin` — sem o par, levanta
--     `service_event_origin_unsupported` (`PT409`).
--
-- Como o `lead.stage_stale` não estava em nenhuma das listas, o evento nascia
-- sem origem E a resolução o recusava — não havia caminho. `PT409` é engolido
-- por `serviceForEvent` como origem obsoleta, `serviceForAutomation` lançava
-- `StaleServiceBoundaryError`, e a ação terminava `failed` com a mensagem do
-- invariante de fronteira, sem nada no log dizendo qual era o defeito.
--
-- ─── O desenho ──────────────────────────────────────────────────────────────
--
-- A definição abaixo parte da ÚLTIMA de `fn_service_event_contact`, a da 0743,
-- que já mantém `contact.phone_added` (0670) e `lead.date_field_due` (0743).
-- Partir da 0551 desfaria os dois consertos.
--
-- O conserto é UMA linha: `lead.stage_stale` entra na lista de tipos que a
-- função já resolvia para `entity_kind='crm_lead'`, ao lado de
-- `lead.created`/`lead.stage_changed`/`lead.tag_added`/`lead.date_field_due`. A
-- entidade `crm_lead` continua resolvendo o contato por `crm_leads.contact_id`
-- — nenhuma coluna, nenhuma tabela, nenhum ramo novo, nenhum par afrouxado:
-- tipo fora da lista continua `unsupported`, `entity_kind` incompatível
-- continua `unsupported`, e a resolução continua filtrada por organização (o
-- par não resolve contato de negócio de outra organização, e o evento não
-- carimba).
--
-- NÃO se inventa `service_origin` no cron: a origem é DERIVADA pelo par, no
-- instante da emissão, pelo `emit_event` — exatamente como a 0551 fez para o
-- aniversário, que também é emitido por cron sem sessão.
--
-- O `emit_event` entra inteiro (não só a lista de reservados) porque o corpo é
-- o da 0743 e não pode ser remontado por patch: qualquer linha perdida aqui
-- afrouxaria o carimbo de TODO evento. A única diferença em relação à 0743 é
-- `lead.stage_stale` na lista de reservados, ao lado de `lead.date_field_due`.
--
-- ─── O que fica de fora, de propósito ───────────────────────────────────────
--
-- O AGRAVANTE que a issue aponta — as ações seguintes da regra continuarem
-- rodando depois de o envio falhar, e o `add_tag` marcar o contato como se a
-- mensagem tivesse saído — NÃO se conserta aqui. É decisão de desenho do laço
-- de ações do motor (`lib/automation/engine.ts`), vale para TODA ação que
-- falha, e não só para este gatilho; misturá-la nesta migration esconderia a
-- decisão dentro de um conserto de fronteira.
--
-- `lead.silent_for` ("N dias sem mensagem") sai da MESMA varredura e é a mesma
-- classe, mas continua fora das duas listas: é issue própria, como a 0743
-- registrou. Os quatro `lead.won/lost/reopened/assigned` (entity_kind='lead',
-- via `fn_log_event`) também seguem fora.
--
-- ─── A prova ────────────────────────────────────────────────────────────────
--
-- `tests/invariants/gatilho-de-etapa-parada-alcanca-a-origem.test.ts` mede o
-- par, o carimbo GRAVADO (kind/contact_id/destinations) e a resolução, com os
-- quatro lados opostos: `lead.date_field_due` continua funcionando,
-- `lead.silent_for` continua recusado com `PT409`, evento sem contato segue sem
-- carimbo e evento de outra organização não é aceito.
-- `tests/invariants/automation-send-whatsapp.test.ts`, caso 13, roda a AÇÃO
-- inteira: sem esta migration o run termina `failed` com
-- `service_boundary_stale`; com ela a mensagem nasce.
-- ============================================================================

create or replace function public.fn_service_event_contact(p_org uuid,p_event_type text,p_entity_kind text,p_entity_id uuid)
returns table(contact_id uuid,suportado boolean) language plpgsql stable security definer set search_path=public as $$
begin
 if p_event_type in ('lead.created','lead.stage_changed','lead.tag_added','lead.date_field_due','lead.stage_stale') and p_entity_kind='crm_lead' then
   return query select (select l.contact_id from public.crm_leads l where l.organization_id=p_org and l.id=p_entity_id),true;
 elsif p_event_type in ('contact.tag_added','contact.birthday','contact.phone_added') and p_entity_kind='contact' then
   return query select (select c.id from public.contacts c where c.organization_id=p_org and c.id=p_entity_id),true;
 elsif p_event_type in ('appointment.created','appointment.confirmed','appointment.rescheduled','appointment.cancelled','appointment.completed','appointment.no_show') and p_entity_kind='calendar_appointment' then
   return query select (select a.contact_id from public.calendar_appointments a where a.organization_id=p_org and a.id=p_entity_id),true;
 else
   return query select null::uuid,false;
 end if;
end $$;
revoke all on function public.fn_service_event_contact(uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.fn_service_event_contact(uuid,text,text,uuid) to service_role;

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
  if auth.uid() is not null and p_event_type in (
    'message.received','appointment.outcome_confirmed',
    'ai.case_opened','ai.case_closed','contact.birthday','contact.phone_added',
    'lead.date_field_due','lead.stage_stale','conversation.autonomous_turn_revoked'
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
