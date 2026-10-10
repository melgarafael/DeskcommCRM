-- A RECUSA PERMANENTE DA AGENDA PARA DE PEDIR REPETIÇÃO — `PT409`, não `40001`.
--
-- Recorte do PR #803, de @paulolimajr77 (frente do Meet, fatia 1).
--
-- ## O defeito, medido em produção
--
-- `fn_meet_action` recusa por três motivos PERMANENTES — o compromisso mudou,
-- o atendimento da conversa mudou, o Google e o CRM discordam. Nenhum deles
-- melhora com nova tentativa: quem clicou precisa atualizar a tela e refazer a
-- escolha. Os três saíam com `errcode='40001'`, que significa o contrário:
-- "conflito de serialização, tente de novo".
--
-- E quem acredita nessa promessa não é o operador, é a infraestrutura. O
-- PostgREST mapeia a classe 40 para HTTP **500**, e o gateway do Supabase
-- reexecuta 5xx sem limite. Em 2026-09-11 oito requisições de dois dias antes,
-- reexecutadas ~280×/s cada, ocuparam o pool inteiro, o schema cache não
-- carregou e TODO o produto respondeu 503 `PGRST002`
-- (`docs/runbooks/postgrest-replay-do-gateway.md`).
--
-- O autor do #803 mediu o mesmo mecanismo pelo lado da agenda: uma chamada HTTP
-- virou dezenas de milhares de execuções e nunca respondeu.
--
-- ## Por que `PT409`, e não `22023` nem `P0001`
--
-- O runbook acima já nomeia a saída de classe: trocar `40001` por um `PTxxx`,
-- porque o PostgREST lê os três últimos dígitos como o status HTTP — `PT409`
-- chega como 409, e 4xx não é reexecutado. É o mesmo código que a guarda contra
-- o replay já usa (migration 0250).
--
-- `22023` (a escolha original do PR) já significa `meet_action_invalid` DENTRO
-- desta função: uma ação inválida passaria a sair como 409. E `P0001` sairia
-- como HTTP 400, que não é o que a tela precisa dizer.
--
-- ## O que NÃO muda
--
-- O corpo é o da `main` de hoje, com três `errcode` trocados e mais nada:
-- mesma ordem de guardas, mesmas travas, mesma fronteira de atendimento. O
-- `lock_timeout` continua no PAPEL (migration 0243), não aqui.
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
 elsif p_action='deliver' then
  if a.contact_id is null then raise exception 'meet_conversation_unavailable' using errcode='42501';end if;
  select channel_session_id into destination_channel from public.conversations where organization_id=p_org and id=p_conversation and contact_id=a.contact_id and not is_group and public.fn_can_view_conversation(organization_id,assigned_to_user_id) for update;
  if not found then raise exception 'meet_conversation_unavailable' using errcode='42501';end if;
  b:=public.fn_service_boundary(p_org,p_conversation)-'status'-'demanda_fechada_em'-'service_started_at';
  if not public.fn_meet_boundary_current(b) then raise exception 'meet_conversation_stale' using errcode='PT409';end if;
  if a.meeting_delivery->'service_boundary'=b and a.meeting_delivery->>'channel_session_id'=destination_channel::text then
   if a.meeting_delivery->>'state' in ('waiting_for_link','sent') then return false;end if;
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
