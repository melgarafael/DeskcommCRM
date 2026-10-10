-- REENVIAR O LINK DO MEET, PEDIDO POR GENTE — uma ação nova, não um ramo reescrito.
--
-- Recorte do PR #803, de @paulolimajr77 (frente do Meet, fatia 2).
-- Empilha sobre a fatia 1 (migration 0363): o corpo abaixo é o dela, com o ramo
-- do envio ampliado e mais nada.
--
-- ## O que faltava
--
-- Quem já enviou o link e precisa enviar de novo — o cliente apagou a conversa,
-- trocou de número, ou a correção de uma remarcação não chegou — não tinha
-- caminho nenhum pelo produto. O botão dizia "Link já enviado" e ficava
-- desligado, e a única saída era mandar o link à mão por fora do CRM, o que
-- deixa a entrega sem registro, sem fronteira de atendimento e sem auditoria.
--
-- ## Por que uma AÇÃO NOVA, e não afrouxar o `deliver`
--
-- O `return false` do `deliver` em estado `waiting_for_link`/`sent` não é uma
-- limitação: é a PROTEÇÃO CONTRA CLIQUE DUPLO. Afrouxá-lo daria o reenvio e
-- tiraria a proteção no mesmo movimento, e envio em dobro para cliente é pior
-- que não-envio. Então `deliver` fica idêntico, e `resend` é um caminho próprio
-- que passa reto — disparado por uma rota própria, atrás de confirmação na tela.
--
-- `waiting_for_link` e `queued` continuam TRANCANDO os dois: ali a entrega já
-- está a caminho, e repetir empilharia pedido. O que destranca é só o `sent`.
--
-- ## O que NÃO entra aqui
--
-- O `motivo` da entrega (`reenvio_manual`) fica de fora de propósito: quem o
-- lê é `fn_meet_delivery_enqueue`, que só passa a copiá-lo na fatia da
-- remarcação. Gravar agora um campo que ninguém consome seria evento sem
-- consumidor.
--
-- Idempotente: `create or replace`.

create or replace function public.fn_meet_action(p_org uuid,p_id uuid,p_revision text,p_request uuid,p_action text,p_conversation uuid default null)
returns boolean language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; contact uuid; b jsonb; destination_channel uuid;
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'agent') or not public.fn_support_write_allowed(p_org) then raise exception 'meet_forbidden' using errcode='42501';end if;
 if not public.fn_session_mfa_proven() then raise exception 'meet_mfa_required' using errcode='42501';end if;
 select contact_id into contact from public.calendar_appointments where organization_id=p_org and id=p_id;
 if contact is not null then perform public.fn_service_lock(p_org,contact);end if;
 select * into a from public.calendar_appointments where organization_id=p_org and id=p_id for update;
 if not found or a.owner_user_id is distinct from auth.uid() or not exists(select 1 from public.user_organizations where organization_id=p_org and user_id=auth.uid() and revoked_at is null) then raise exception 'meet_forbidden' using errcode='42501';end if;
 if a.revision::text is distinct from p_revision or a.meeting_request_id is distinct from p_request or a.status='cancelled' or a.location_kind<>'google_meet'
  or exists(select 1 from public.contacts where id=a.contact_id and organization_id=p_org and is_anonymized) then raise exception 'meet_stale' using errcode='PT409';end if;
 if p_action='retry' then
  if a.google_conflict is not null then raise exception 'google_conflict_requires_choice' using errcode='PT409';end if;
  if a.meeting_state='ready' then return false;end if;
  if a.meeting_state<>'failed' then
   update public.calendar_appointments set meeting_next_attempt_at=now(),google_next_attempt_at=now() where organization_id=p_org and id=p_id;return true;
  end if;
  -- Tempo/timeout não provam rejeição. Somente failure recebido gira solicitação.
  update public.calendar_appointments set meeting_request_id=case when meeting_last_error='google_failure' and meeting_received_at is not null then gen_random_uuid() else meeting_request_id end,
   meeting_requested_at=case when meeting_last_error='google_failure' and meeting_received_at is not null then null else meeting_requested_at end,
   meeting_received_at=case when meeting_last_error='google_failure' then null else meeting_received_at end,
   meeting_state='pending',meeting_attempts=0,meeting_last_error=null,meeting_next_attempt_at=now(),google_next_attempt_at=now() where organization_id=p_org and id=p_id;
 elsif p_action in ('deliver','resend') then
  if a.contact_id is null then raise exception 'meet_conversation_unavailable' using errcode='42501';end if;
  select channel_session_id into destination_channel from public.conversations where organization_id=p_org and id=p_conversation and contact_id=a.contact_id and not is_group and public.fn_can_view_conversation(organization_id,assigned_to_user_id) for update;
  if not found then raise exception 'meet_conversation_unavailable' using errcode='42501';end if;
  b:=public.fn_service_boundary(p_org,p_conversation)-'status'-'demanda_fechada_em'-'service_started_at';
  if not public.fn_meet_boundary_current(b) then raise exception 'meet_conversation_stale' using errcode='PT409';end if;
  if a.meeting_delivery->'service_boundary'=b and a.meeting_delivery->>'channel_session_id'=destination_channel::text then
   -- ⛔ ESTE `return false` É A PROTEÇÃO CONTRA CLIQUE DUPLO, e é por isso que o
   -- reenvio é uma AÇÃO NOVA em vez de um ramo reescrito. Ele impede a mesma
   -- mensagem de sair duas vezes por um clique nervoso; se o botão "Enviar de
   -- novo" apenas reescrevesse este ramo, ganharíamos o reenvio e perderíamos a
   -- proteção — e envio em dobro para cliente é pior que não-envio.
   -- `deliver` continua exatamente como era; `resend` passa reto, e quem o
   -- dispara já confirmou na tela.
   if p_action='deliver' and a.meeting_delivery->>'state' in ('waiting_for_link','sent') then return false;end if;
   if a.meeting_delivery->>'state'='queued' and a.meeting_delivery_job_id is not null then
    -- Recuperação humana de job morto conserva ledger/identidade. Não duplicar
    -- uma mensagem aceita antes do crash nem reconstruir fronteira antiga.
    update public.job_queue set status='pending',locked_by=null,locked_at=null,attempts=0,run_after=now(),last_error=null
     where organization_id=p_org and id=a.meeting_delivery_job_id and kind='transactional_delivery' and status in ('dead','failed','done');
    return found;
   end if;
  end if;
  update public.job_queue set status='failed',locked_by=null,locked_at=null,last_error='meet_delivery_superseded' where organization_id=p_org and id=a.meeting_delivery_job_id and kind='transactional_delivery' and status in ('pending','running');
  update public.calendar_appointments set meeting_delivery=jsonb_build_object('state','waiting_for_link','generation',gen_random_uuid(),'service_boundary',b,'authorized_by',jsonb_build_object('kind','user','id',auth.uid()),'source_operation_id',gen_random_uuid()),meeting_delivery_job_id=null where organization_id=p_org and id=p_id;
 else raise exception 'meet_action_invalid' using errcode='22023';end if;
 return true;
end;$$;
