-- 0243 — o botao de enviar o link destrava: nasce a acao `resend`
--
-- Remarcar um compromisso ja enviado passou a corrigir o cliente sozinho
-- (migration 0242). Falta a outra metade, e o dono do produto pediu AS DUAS: o
-- automatico cobre quem remarcou e foi embora; o manual cobre o caso em que a
-- correcao automatica NAO saiu (o atendimento mudou, o canal caiu) e alguem
-- precisa agir.
--
-- MEDIDO no codigo em 2026-09-12: com estado `sent` e a mesma conversa, a tela
-- desabilitava o botao com "Link ja enviado" e nao havia caminho manual nenhum.
--
-- ⛔ POR QUE UMA ACAO NOVA, E NAO SO HABILITAR O BOTAO. O `return false` em
-- estado `sent` NAO e sobra: e a protecao contra CLIQUE DUPLO. Reescrever aquele
-- ramo ganharia o reenvio e perderia a protecao, e envio em dobro para cliente e
-- pior que nao-envio. Entao `deliver` fica intocado e `resend` e uma terceira
-- acao, irma de `retry`/`deliver`, que a tela so dispara depois de confirmacao.

create or replace function public.fn_meet_action(p_org uuid,p_id uuid,p_revision text,p_request uuid,p_action text,p_conversation uuid default null)
returns boolean language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; contact uuid; b jsonb; destination_channel uuid;
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'agent') or not public.fn_support_write_allowed(p_org) then raise exception 'meet_forbidden' using errcode='42501';end if;
 if not public.fn_session_mfa_proven() then raise exception 'meet_mfa_required' using errcode='42501';end if;
 select contact_id into contact from public.calendar_appointments where organization_id=p_org and id=p_id;
 -- ESPERA LIMITADA PELA TRAVA DO ATENDIMENTO.
 --
 -- MEDIDO em producao em 2026-09-13, amostrando `pg_locks` durante o clique:
 -- varias conexoes do PostgREST disputam a MESMA trava por cliente — umas
 -- segurando, outras esperando. `fn_service_lock` usa `pg_advisory_xact_lock`,
 -- que espera PARA SEMPRE. O pedido entrava na fila, o porteiro desistia aos
 -- 10s com `upstream request timeout`, e o cliente repetia — pondo mais um na
 -- fila. Tres tentativas, 30 segundos, e "Erro inesperado" no fim.
 --
 -- O corpo desta funcao, chamado SEM disputa, responde em 19 MILISSEGUNDOS.
 -- O problema nunca foi o trabalho: era a espera.
 --
 -- 3 segundos de teto, com folga sobre os 10s do porteiro: quem nao consegue
 -- ouve um motivo com NOME e a tela para de repetir sozinha. Esperar menos que
 -- o porteiro e o que troca um silencio de 30s por uma resposta honesta.
 --
 -- `fn_service_lock` continua como esta para os demais chamadores: a espera sem
 -- teto e o certo para um worker, que nao tem ninguem olhando a tela.
 if contact is not null then
  declare espera int := 0;
  begin
   while not pg_try_advisory_xact_lock(hashtextextended(p_org::text || ':' || contact::text, 222)) loop
    espera := espera + 1;
    if espera > 12 then raise exception 'meet_ocupado' using errcode='55P03';end if;
    perform pg_sleep(0.25);
   end loop;
  end;
 end if;
 select * into a from public.calendar_appointments where organization_id=p_org and id=p_id for update;
 if not found or a.owner_user_id is distinct from auth.uid() or not exists(select 1 from public.user_organizations where organization_id=p_org and user_id=auth.uid() and revoked_at is null) then raise exception 'meet_forbidden' using errcode='42501';end if;
 if a.revision::text is distinct from p_revision or a.meeting_request_id is distinct from p_request or a.status='cancelled' or a.location_kind<>'google_meet'
  or exists(select 1 from public.contacts where id=a.contact_id and organization_id=p_org and is_anonymized) then raise exception 'meet_stale' using errcode='40001';end if;
 if p_action='retry' then
  if a.google_conflict is not null then raise exception 'google_conflict_requires_choice' using errcode='40001';end if;
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
  if not public.fn_meet_boundary_current(b) then raise exception 'meet_conversation_stale' using errcode='40001';end if;
  if a.meeting_delivery->'service_boundary'=b and a.meeting_delivery->>'channel_session_id'=destination_channel::text then
   -- ⛔ ESTE `return false` E A PROTECAO CONTRA CLIQUE DUPLO, e por isso o
   -- reenvio explicito e uma acao NOVA em vez de um ramo reescrito.
   --
   -- E ele que impede a mesma mensagem de sair duas vezes por um clique
   -- nervoso. Se o botao "Enviar de novo" simplesmente reescrevesse este ramo,
   -- ganhariamos o reenvio e perderiamos a protecao — e envio em dobro para
   -- cliente e pior que nao-envio. `deliver` continua exatamente como era;
   -- `resend` passa reto, e quem o dispara ja confirmou na tela.
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
  update public.calendar_appointments set meeting_delivery=jsonb_build_object('state','waiting_for_link','generation',gen_random_uuid(),'service_boundary',b,'authorized_by',jsonb_build_object('kind','user','id',auth.uid()),'source_operation_id',gen_random_uuid(),'motivo',case when p_action='resend' then 'reenvio_manual' else 'primeiro_envio' end),meeting_delivery_job_id=null where organization_id=p_org and id=p_id;
 else raise exception 'meet_action_invalid' using errcode='22023';end if;
 return true;
end;$$;
revoke all on function public.fn_meet_action(uuid,uuid,text,uuid,text,uuid) from public,anon;
grant execute on function public.fn_meet_action(uuid,uuid,text,uuid,text,uuid) to authenticated;
