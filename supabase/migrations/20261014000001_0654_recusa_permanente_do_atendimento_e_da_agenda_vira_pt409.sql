-- manifest: **A recusa permanente do atendimento e da agenda sai como PT409, não 40001 (#2805, diagnóstico de @paulolimajr77).** Numa VPS self-hosted, uma única chamada a `fn_service_event_origin` recusada com `service_stale` (errcode `40001`) fez o PostgREST 14 repetir a transação sem limite (~1.750 rollbacks/s, pool esgotado, CRM fora do ar); a guarda da 0250 depende do `sb-request-id`, que o self-host não carimba. Esta migration redefine 16 funções (`fn_service_begin`, `fn_service_event_origin`, `fn_demanda_encerrar`, `fn_reply_begin`, `fn_reply_action`, `fn_followup_apply_step`, `fn_appointment_recover`, `fn_appointment_change_core`, `fn_google_calendar_fence`, `fn_google_selection`, `fn_google_catalog`, `fn_google_resolve`, `fn_google_appointment`, `fn_meet_stamp`, `fn_meet_observe`, `fn_meet_delivery_settle`) com o corpo da última definição e o errcode trocado nos 34 sítios de recusa permanente; o handler de `fn_appointment_recover` que capturava `serialization_failure` em volta de `fn_service_event_origin` passa a capturar também `PT409` (sem isso, o recibo 'stale' e o aviso na Central sumiam); `service_contact_changed`, `appointment_notice_busy` e `contact_redaction_busy` continuam `40001` (repetir passa). Mesmo bloco no apêndice do `supabase/baseline.sql`, antes da VARREDURA anon. Chamadores (`lib/atendimento/fronteira.ts`, demandas, agendamentos, rotas do Google) aceitam `PT409` e `40001`. Gate: `tests/unit/recusa-permanente-nao-pede-repeticao.test.ts` reprova recusa permanente com `40001` na última definição do baseline e da cadeia.

-- ---- a recusa permanente do atendimento e da agenda não pede repetição (migration 0654, #2805) ----
-- Diagnóstico de @paulolimajr77 (#2805), numa VPS self-hosted em 2026-10-12:
-- UMA chamada a `fn_service_event_origin` que recusou um evento com
-- `service_stale` virou ~1.750 rollbacks/s, o pool da REST esgotou
-- (`PGRST003`), o banco foi a 243% de CPU e o CRM inteiro caiu em "Algo deu
-- errado".
--
-- O mecanismo, reproduzido na triagem com a mesma imagem do self-host
-- (`postgrest/postgrest:v14.17`) e uma função que conta as próprias execuções
-- antes de levantar o erro: com `errcode='40001'`, UM POST deixou o cliente sem
-- resposta em 5 s e a função rodou mais de 55 mil vezes em 3 s, seguindo depois
-- de o cliente desistir; com `PT409`, HTTP 409 e uma execução só. Quem repete é
-- o próprio PostgREST: a biblioteca de transação dele refaz a transação, sem
-- limite, quando o banco responde `40001` (serialization_failure). O Envoy do
-- self-host não tem política de retry, e a guarda da 0250
-- (`fn_pgrst_recusar_replay_do_gateway`) depende do `sb-request-id`, que o
-- Envoy do self-host não carimba — ela sai cedo e o laço não tem fim.
--
-- `40001` promete "conflito de serialização, tente de novo". Nas recusas
-- abaixo a promessa é falsa: a revisão, o claim ou o estado que o chamador
-- mandou nunca vai voltar a bater, então repetir a mesma transação recusa de
-- novo, para sempre. O conserto é o da 0363 (agenda) e da 0514
-- (`fn_service_status`), que o runbook `docs/runbooks/postgrest-replay-do-gateway.md`
-- nomeia: `PT409`. O PostgREST lê os três últimos dígitos de `PTxxx` como o
-- status HTTP, e 4xx não é repetido por ninguém.
--
-- Trocam para `PT409` (34 sítios, nas ÚLTIMAS definições destas 16 funções):
-- service_stale, service_origin_cycle, service_event_origin_unsupported,
-- demanda_stale, reply_agent_stale, reply_stale, followup_job_stale,
-- appointment_stale, appointment_flow_changed, google_outcome_protected,
-- google_stale, google_selection_stale, google_conflict_requires_choice,
-- google_write_unavailable, meet_stale, meet_booking_stale,
-- meet_delivery_not_accepted. `google_write_unavailable` entra na lista: ele
-- recusa porque a agenda não é gravável, porque já há escrita pendente ou
-- porque há conflito à espera de escolha — nada disso muda dentro da mesma
-- transação repetida.
--
-- CONTINUAM `40001`, de propósito (aqui repetir é a resposta certa):
-- `service_contact_changed` (o contato da conversa mudou entre a leitura e o
-- lock; a nova tentativa relê e passa), `appointment_notice_busy` e
-- `contact_redaction_busy` (trava ocupada por outra escrita). Nenhuma das
-- funções que só têm essas recusas é redefinida aqui.
--
-- Corpo de cada função igual ao da última definição anterior, com o
-- `errcode` trocado. E um ajuste a mais, que a troca obriga: o handler que
-- capturava o código antigo passa a capturar os dois. `fn_appointment_recover`
-- envolvia `fn_service_event_origin` num `exception when serialization_failure
-- then result:='stale'`; com a recusa saindo `PT409`, esse handler não a
-- pegava mais, e o recibo 'stale' e o aviso na Central sumiam (o evento ia
-- para dead depois de 5 tentativas). Agora é `when serialization_failure or
-- sqlstate 'PT409'` — o `40001` real (`service_contact_changed`) continua
-- capturado. Grants reafirmados como já estavam. Sem
-- tabela, coluna ou dado novo. Idempotente: `create or replace`. Os chamadores
-- do app leem `PT409` e continuam lendo `40001`, porque o banco e a imagem não
-- se atualizam no mesmo instante. Vigiado por
-- `tests/unit/recusa-permanente-nao-pede-repeticao.test.ts`.

create or replace function public.fn_service_begin(p_org uuid,p_contact uuid,p_session uuid default null,p_observed jsonb default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c public.conversations; sid uuid;
begin
 perform public.fn_service_lock(p_org,p_contact);
 if not exists(select 1 from public.contacts where id=p_contact and organization_id=p_org and not is_anonymized and is_merged_into is null) then
  raise exception 'service_contact_not_found' using errcode='P0002'; end if;
 select * into c from public.conversations where organization_id=p_org and contact_id=p_contact and not is_group
  and (p_session is null or channel_session_id=p_session) order by last_message_at desc nulls last,created_at desc limit 1 for no key update;
 if p_observed is not null then
   if p_observed->>'organization_id' is distinct from p_org::text or p_observed->>'contact_id' is distinct from p_contact::text then
     raise exception 'service_scope_mismatch' using errcode='23503'; end if;
   if c.id is null then
     if p_observed->>'absent' is distinct from 'true' then raise exception 'service_stale' using errcode='PT409'; end if;
   elsif public.fn_service_boundary(p_org,c.id) is distinct from p_observed then
     raise exception 'service_stale' using errcode='PT409';
   end if;
 end if;
 if c.id is not null then
   if c.status in ('closed','resolved','archived') then
     c:=public.fn_service_status(p_org,c.id,'open',c.service_revision);
   end if;
   if exists(select 1 from public.demandas where id=c.current_demanda_id and organization_id=p_org and fechada_em is not null) then
     update public.conversations set service_revision=service_revision+1,current_demanda_id=null,service_started_at=clock_timestamp()
      where id=c.id and organization_id=p_org returning * into c;
   end if;
   if c.service_started_at is null then
     update public.conversations set service_revision=service_revision+1,service_started_at=clock_timestamp()
      where id=c.id and organization_id=p_org returning * into c;
   end if;
   return public.fn_service_boundary(p_org,c.id);
 end if;
 select id into sid from public.channel_sessions where organization_id=p_org and archived_at is null
  and (p_session is null or id=p_session) order by (status='WORKING') desc,created_at limit 1;
 if sid is null then raise exception 'service_channel_not_found' using errcode='P0002'; end if;
 insert into public.conversations(organization_id,contact_id,channel_session_id,status,is_group,channel,service_started_at)
  values(p_org,p_contact,sid,'open',false,'whatsapp',clock_timestamp()) returning * into c;
 return public.fn_service_boundary(p_org,c.id);
end; $$;
revoke execute on function public.fn_service_begin(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.fn_service_begin(uuid,uuid,uuid,jsonb) to service_role;

create or replace function public.fn_service_event_origin(p_org uuid,p_event uuid,p_contact uuid,p_session uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public.event_log; origin jsonb; boundary jsonb; current_boundary jsonb; entity_contact uuid; v_suportado boolean; cid uuid; sid uuid; observed jsonb; root_event uuid:=p_event; visited uuid[]:=array[]::uuid[];
begin
 -- O drain faz claim otimista em outra transação; não conserva row lock.
 -- Não travar event_log: advisory contato antecede os locks de conversa/FKs.
 perform public.fn_service_lock(p_org,p_contact);
 loop
 if root_event = any(visited) or cardinality(visited)>=32 then raise exception 'service_origin_cycle' using errcode='PT409'; end if;
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
   if not v_suportado then raise exception 'service_event_origin_unsupported' using errcode='PT409'; end if;
 end if;
 if entity_contact is distinct from p_contact or not exists(select 1 from public.contacts where organization_id=p_org and id=p_contact and not is_anonymized and is_merged_into is null) then
   raise exception 'service_scope_mismatch' using errcode='23503'; end if;
 origin:=e.payload->'service_origin';
 if origin->>'kind'='event' then
   if origin->>'organization_id' is distinct from p_org::text or origin->>'contact_id' is distinct from p_contact::text then raise exception 'service_scope_mismatch' using errcode='23503'; end if;
   root_event:=(origin->>'event_id')::uuid;
   if root_event is null then raise exception 'service_stale' using errcode='PT409'; end if;
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
 else raise exception 'service_stale' using errcode='PT409'; end if;
 if sid is null then raise exception 'service_stale' using errcode='PT409'; end if;
 if not exists(select 1 from public.channel_sessions where id=sid and organization_id=p_org and archived_at is null) then raise exception 'service_channel_mismatch' using errcode='23503'; end if;
 if boundary is null and observed is null then raise exception 'service_stale' using errcode='PT409'; end if;
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
   raise exception 'service_stale' using errcode='PT409'; end if;
 insert into public.event_service_origins(event_id,channel_session_id,organization_id,service_boundary) values(root_event,sid,p_org,boundary)
 on conflict(event_id,channel_session_id) do nothing;
 return boundary;
end; $$;
revoke all on function public.fn_service_event_origin(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_service_event_origin(uuid,uuid,uuid,uuid) to service_role;

create or replace function public.fn_demanda_encerrar(p_org uuid,p_demanda uuid,p_expected bigint,p_desfecho text,p_actor uuid)
returns public.demandas language plpgsql security definer set search_path=public as $$
declare d public.demandas; pre_contact uuid;
begin
 if p_desfecho not in ('resolvida','convertida','nao_procede','encerrada_pelo_cliente','perdida','expirada_sem_resposta') then
  raise exception 'invalid_desfecho' using errcode='22023'; end if;
 select * into d from public.demandas where id=p_demanda and organization_id=p_org;
 if not found then raise exception 'demanda_not_found' using errcode='P0002'; end if;
 pre_contact:=d.contact_id;
 perform public.fn_service_lock(p_org,d.contact_id);
 select * into d from public.demandas where id=p_demanda and organization_id=p_org for no key update;
 if d.contact_id is distinct from pre_contact then raise exception 'service_contact_changed' using errcode='40001'; end if;
 if d.revision<>p_expected or d.fechada_em is not null then raise exception 'demanda_stale' using errcode='PT409'; end if;
 update public.demandas set revision=revision+1,desfecho=p_desfecho,fechada_em=clock_timestamp(),
  encerrada_por=p_actor,estado=case when p_desfecho in ('resolvida','convertida') then 'resolvida' else 'encerrada' end,
  proximo_passo=null,proximo_passo_em=null,updated_at=clock_timestamp()
  where id=p_demanda and organization_id=p_org returning * into d;
 insert into public.crm_lead_activities(organization_id,lead_id,contact_id,source_module,source_id,type,payload,performed_at,performed_by_user_id)
 select p_org,l.id,d.contact_id,'crm',d.id,'demand_closed',jsonb_build_object('demanda_id',d.id,'desfecho',p_desfecho),clock_timestamp(),p_actor
 from public.crm_leads l where l.organization_id=p_org and l.contact_id=d.contact_id;
 return d;
end; $$;
revoke execute on function public.fn_demanda_encerrar(uuid,uuid,bigint,text,uuid) from public,anon,authenticated;
grant execute on function public.fn_demanda_encerrar(uuid,uuid,bigint,text,uuid) to service_role;

create or replace function public.fn_reply_begin(p_org uuid,p_conversation uuid,p_agent uuid,p_version uuid,p_token uuid)
returns public.ai_reply_drafts language plpgsql security definer set search_path=public as $$
declare c public.conversations;a public.ai_agents;d public.ai_reply_drafts;contact uuid;b jsonb;
begin
 select contact_id into contact from public.conversations where organization_id=p_org and id=p_conversation;
 if contact is null then raise exception 'reply_context_unavailable' using errcode='42501';end if;
 perform public.fn_service_lock(p_org,contact);
 select * into a from public.ai_agents where organization_id=p_org and id=p_agent and archived_at is null for share;
 if not found or a.published_version_id is distinct from p_version then raise exception 'reply_agent_stale' using errcode='PT409';end if;
 select * into c from public.conversations where organization_id=p_org and id=p_conversation and contact_id=contact for no key update;
 if c.active_ai_agent_id is not null and c.active_ai_agent_id<>p_agent then raise exception 'reply_agent_stale' using errcode='PT409';end if;
 b:=public.fn_service_boundary(p_org,p_conversation)-'status'-'demanda_fechada_em'-'service_started_at';
 if not public.fn_meet_boundary_current(b) or exists(select 1 from public.contacts where organization_id=p_org and id=contact and (is_blocked or is_anonymized)) then raise exception 'reply_context_unavailable' using errcode='42501';end if;
 insert into public.ai_reply_drafts(organization_id,conversation_id,contact_id,agent_id,agent_version_id,channel_session_id,service_boundary,context_revision,operation_revision,generation_token)
 values(p_org,p_conversation,contact,p_agent,p_version,c.channel_session_id,b,c.reply_context_revision,a.operation_revision,p_token)
 on conflict(organization_id,conversation_id,agent_id,context_revision,operation_revision) do update set
 generation_token=case when (ai_reply_drafts.status='failed' or (ai_reply_drafts.status='generating' and ai_reply_drafts.updated_at<now()-interval '10 minutes')) then p_token else ai_reply_drafts.generation_token end,
 status=case when (ai_reply_drafts.status='failed' or (ai_reply_drafts.status='generating' and ai_reply_drafts.updated_at<now()-interval '10 minutes')) then 'generating' else ai_reply_drafts.status end,
 revision=ai_reply_drafts.revision+case when (ai_reply_drafts.status='failed' or (ai_reply_drafts.status='generating' and ai_reply_drafts.updated_at<now()-interval '10 minutes')) then 1 else 0 end,updated_at=now()
 returning * into d;return d;
end;$$;
revoke all on function public.fn_reply_begin(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_reply_begin(uuid,uuid,uuid,uuid,uuid) to service_role;

create or replace function public.fn_reply_action(p_org uuid,p_id uuid,p_revision text,p_action text,p_body text default null,p_feedback text default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare d public.ai_reply_drafts;contact uuid;jid uuid;a uuid;
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'agent') or not public.fn_support_write_allowed(p_org) or not public.fn_session_mfa_proven() then raise exception 'reply_forbidden' using errcode='42501';end if;
 select contact_id,agent_id into contact,a from public.ai_reply_drafts where organization_id=p_org and id=p_id;
 if contact is null then raise exception 'reply_forbidden' using errcode='42501';end if;
 perform public.fn_service_lock(p_org,contact);
 perform 1 from public.ai_agents where organization_id=p_org and id=a for share;
 perform 1 from public.conversations c join public.ai_reply_drafts r on r.organization_id=c.organization_id and r.conversation_id=c.id where r.organization_id=p_org and r.id=p_id and public.fn_can_view_conversation(c.organization_id,c.assigned_to_user_id) for share of c;
 if not found then raise exception 'reply_forbidden' using errcode='42501';end if;
 select * into d from public.ai_reply_drafts where organization_id=p_org and id=p_id for update;
 if d.status in('approved','sending','sent') and p_action='approve' and d.approved_by=auth.uid() and d.approved_body=p_body then return d.send_job_id;end if;
 if d.revision::text is distinct from p_revision or d.status<>'pending' or not public.fn_reply_context_current(p_org,p_id) then raise exception 'reply_stale' using errcode='PT409';end if;
 if p_action='reject' then
 update public.ai_reply_drafts set status='dismissed',feedback=jsonb_build_object('decision','rejected','reason',left(p_feedback,1000)),revision=revision+1,updated_at=now() where id=p_id and organization_id=p_org;return null;
 elsif p_action='approve' then
 if p_body is null or length(trim(p_body))=0 or length(p_body)>12000 then raise exception 'reply_body_invalid' using errcode='22023';end if;
 jid:=gen_random_uuid();
 insert into public.job_queue(id,organization_id,contact_id,kind,payload,run_after) values(jid,p_org,contact,'approved_reply',jsonb_build_object('draft_id',d.id,'service_boundary',d.service_boundary),now());
 update public.ai_reply_drafts set status='approved',edited_body=p_body,approved_body=p_body,approved_by=auth.uid(),approved_at=now(),approved_support_session_id=case when public.fn_support_context()->>'organization_id'=p_org::text then (public.fn_support_context()->>'id')::uuid else null end,send_job_id=jid,
 feedback=jsonb_build_object('decision',case when p_body is distinct from original_body then 'edited' else 'approved' end,'reason',left(p_feedback,1000),'correction',case when p_body is distinct from original_body then p_body else null end),revision=revision+1,updated_at=now()
 where id=p_id and organization_id=p_org;return jid;
 end if;
 raise exception 'reply_action_invalid' using errcode='22023';
end;$$;
revoke all on function public.fn_reply_action(uuid,uuid,text,text,text,text) from public,anon;
grant execute on function public.fn_reply_action(uuid,uuid,text,text,text,text) to authenticated;

create or replace function public.fn_followup_apply_step(p_org uuid,p_id uuid,p_revision bigint,p_patch jsonb,p_event jsonb)
returns bigint language plpgsql security definer set search_path=public as $$
declare revision bigint; contact uuid;
begin
 if p_event ? 'job_id' then
  select contact_id into contact from public.followup_enrollments where organization_id=p_org and id=p_id;
  perform public.fn_service_lock(p_org,contact);
  perform 1 from public.job_queue where id=(p_event->>'job_id')::uuid and organization_id=p_org for update;
  if not public.fn_followup_claim_current(p_org,(p_event->>'job_id')::uuid,p_event->'job_claim'->>'worker_id',(p_event->'job_claim'->>'acquired_at')::timestamptz)
   or not public.fn_followup_job_current(p_org,(p_event->>'job_id')::uuid,p_id,p_event->>'node_id') then
   raise exception 'followup_job_stale' using errcode='PT409';
  end if;
 end if;
 revision:=public.fn_followup_patch(p_org,p_id,p_revision,p_patch);
 insert into public.followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,idempotency_key)
  values(p_org,p_id,p_event->>'node_id',p_event->>'event_type',coalesce(p_event->'payload','{}'::jsonb),p_event->>'idempotency_key');
 return revision;
end; $$;
revoke all on function public.fn_followup_apply_step(uuid,uuid,bigint,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.fn_followup_apply_step(uuid,uuid,bigint,jsonb,jsonb) to service_role;

create or replace function public.fn_appointment_recover(p_org uuid,p_event uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public.event_log; a public.calendar_appointments; r public.appointment_recovery_receipts;
 contact uuid; rev bigint; result text; candidates uuid[]; pointer uuid; agent uuid; version uuid; node text; boundary jsonb; enrollment uuid;
begin
 select * into e from public.event_log where organization_id=p_org and id=p_event and event_type='appointment.outcome_confirmed' and entity_kind='appointment';
 if not found then raise exception 'appointment_source_event_missing' using errcode='P0002'; end if;
 rev:=(e.payload->>'appointment_revision')::bigint;
 select contact_id into contact from public.calendar_appointments where organization_id=p_org and id=e.entity_id;
 if not found then raise exception 'appointment_not_found' using errcode='P0002'; end if;
 if contact is not null then perform public.fn_service_lock(p_org,contact); end if;
 select * into a from public.calendar_appointments where organization_id=p_org and id=e.entity_id for update;
 if a.contact_id is distinct from contact then raise exception 'appointment_stale' using errcode='PT409'; end if;
 select * into r from public.appointment_recovery_receipts where organization_id=p_org and appointment_id=a.id and appointment_revision=rev;
 if found then return to_jsonb(r); end if;
 result:=case when contact is null then 'no_contact' when a.revision<>rev or a.status<>'no_show' or a.outcome_recorded_at is null

  or not exists(select 1 from public.contacts where organization_id=p_org and id=contact and not is_anonymized and is_merged_into is null and not is_blocked)
  then 'stale' else null end;
 if result is null then
  select array_agg(p.id) into candidates from public.followup_flow_pointers p
   where p.organization_id=p_org and p.status='active' and p.active_version_id is not null and p.trigger_config->>'kind'='appointment_no_show'
    and (coalesce(jsonb_array_length(p.trigger_config->'params'->'event_type_ids'),0)=0 or p.trigger_config->'params'->'event_type_ids' ? a.event_type_id::text)
    and exists(select 1 from public.ai_agent_versions v where v.organization_id=p_org and v.status='published'
     and v.followup->'enabled'='true'::jsonb and v.followup->'flow_pointer_ids' ? p.id::text);
  result:=case when coalesce(cardinality(candidates),0)=0 then 'not_configured' when cardinality(candidates)>1 then 'ambiguous' else null end;
 end if;
 if result is null and exists(select 1 from public.followup_enrollments where organization_id=p_org and contact_id=contact and status in ('active','waiting_reply','paused_handoff','paused_manual')) then result:='other_flow'; end if;
 if result is null then
  pointer:=candidates[1];
  select active_version_id into version from public.followup_flow_pointers where organization_id=p_org and id=pointer and status='active' for share;
  -- Precedência de AGENTES já canônica em resolveAgentForAutomaticTrigger.
  select agent_id into agent from public.ai_agent_versions where organization_id=p_org and status='published'
   and followup->'enabled'='true'::jsonb and followup->'flow_pointer_ids' ? pointer::text order by agent_id limit 1;
  select n->>'id' into node from public.followup_flow_versions v cross join lateral jsonb_array_elements(v.graph->'nodes') n
   where v.organization_id=p_org and v.id=version and n->>'type'='trigger';
  if version is null or agent is null or node is null then raise exception 'appointment_flow_changed' using errcode='PT409'; end if;
  begin
   boundary:=public.fn_service_event_origin(p_org,p_event,contact,
    (select channel_session_id from public.conversations where organization_id=p_org and id=a.conversation_id and contact_id=contact));
  exception when serialization_failure or sqlstate 'PT409' then result:='stale'; end;
  if result is null then
   begin
    insert into public.followup_enrollments(organization_id,pointer_id,version_id,contact_id,conversation_id,agent_id,current_node_id,service_boundary,
     appointment_id,appointment_revision)
    values(p_org,pointer,version,contact,(boundary->>'conversation_id')::uuid,agent,node,boundary,a.id,a.revision) returning id into enrollment;
    insert into public.followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,idempotency_key)
     values(p_org,enrollment,node,'enrolled',jsonb_build_object('trigger_kind','appointment_no_show','appointment_id',a.id,'appointment_revision',a.revision),'appointment:'||a.id||':'||a.revision);
    result:='started';
   exception when unique_violation then result:='other_flow'; end;
  end if;
 end if;
 insert into public.appointment_recovery_receipts(organization_id,appointment_id,appointment_revision,source_event_id,result,pointer_id,enrollment_id)
  values(p_org,a.id,rev,p_event,result,pointer,enrollment) returning * into r;
 if result<>'started' and not exists(select 1 from public.contacts where organization_id=p_org and id=contact and is_anonymized) then
  insert into public.agent_inbox_items(organization_id,kind,severity,title,body,ref_kind,ref_id,appointment_revision)
   values(p_org,'appointment_recovery_review','warn','A recuperação não foi iniciada',
    case result when 'other_flow' then 'Este contato já tem outro acompanhamento. Revise o próximo passo; nenhuma recuperação ficou aguardando vaga.'
     when 'ambiguous' then 'Mais de um fluxo atende a esta falta. Deixe apenas um configurado ou escolha manualmente o próximo passo.'
     when 'not_configured' then 'Configure um fluxo de recuperação e habilite-o em um assistente publicado. Esta falta não será iniciada retroativamente.'
     else 'O contexto mudou ou não há contato vinculado. Abra o compromisso e escolha o próximo passo.' end,'appointment',a.id,rev)
   on conflict(organization_id,ref_id,appointment_revision,kind) where ref_kind='appointment' and appointment_revision is not null do nothing;
 end if;
 return to_jsonb(r);
end; $$;
revoke all on function public.fn_appointment_recover(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_appointment_recover(uuid,uuid) to service_role;

create or replace function public.fn_appointment_change_core(p_org uuid,p_id uuid,p_revision bigint,p_patch jsonb,p_remote boolean,p_base jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; contact uuid; origin jsonb; event_id uuid;
begin
 if p_remote and (auth.uid() is not null or (p_patch-'starts_at'-'ends_at'-'time_zone'-'status'-'cancellation_reason')<>'{}'::jsonb or coalesce(p_patch->>'status','cancelled')<>'cancelled') then raise exception 'google_patch_forbidden' using errcode='42501';end if;
 if auth.uid() is not null and (not public.fn_role_at_least(p_org,'agent') or not public.fn_support_write_allowed(p_org)) then raise exception 'appointment_forbidden' using errcode='42501'; end if;
 if auth.uid() is not null and not public.fn_session_mfa_proven() then raise exception 'appointment_mfa_required' using errcode='42501';end if;
 select contact_id into contact from public.calendar_appointments where organization_id=p_org and id=p_id;
 if not found then raise exception 'appointment_not_found' using errcode='P0002'; end if;
 if contact is not null then perform public.fn_service_lock(p_org,contact); end if;
 select * into a from public.calendar_appointments where organization_id=p_org and id=p_id for update;
 if a.contact_id is distinct from contact or a.revision is distinct from p_revision then raise exception 'appointment_stale' using errcode='PT409'; end if;
 -- A AGENDA DO COLEGA É UMA OPÇÃO DA ORGANIZAÇÃO (migration 0343, issue #978).
 if auth.uid() is not null and not public.fn_role_at_least(p_org,'manager')
    and not public.fn_colegas_podem_mexer_na_agenda(p_org)
    and a.owner_user_id is distinct from auth.uid() then
  raise exception 'appointment_do_colega' using errcode='42501';
 end if;
 if p_remote and a.status not in ('pending','confirmed') then raise exception 'google_outcome_protected' using errcode='PT409';end if;
 if a.status='cancelled' then raise exception 'appointment_cancelled' using errcode='22023'; end if;
 if contact is not null then origin:=jsonb_build_object('kind','command','observed',public.fn_service_observe_command(p_org,contact)); end if;
 update public.calendar_appointments set
  google_base_projection=case when p_remote then p_base else google_base_projection end,
  starts_at=case when p_patch?'starts_at' then (p_patch->>'starts_at')::timestamptz else starts_at end,
  ends_at=case when p_patch?'ends_at' then (p_patch->>'ends_at')::timestamptz else ends_at end,
  time_zone=coalesce(p_patch->>'time_zone',time_zone),
  status=coalesce(p_patch->>'status',status),
  cancelled_at=case when p_patch->>'status'='cancelled' then now() else cancelled_at end,
  cancellation_reason=case when p_patch?'cancellation_reason' then p_patch->>'cancellation_reason' else cancellation_reason end,
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

create or replace function public.fn_google_calendar_fence(p_org uuid,p_id uuid,p_claim jsonb,p_cursor jsonb default null)
returns void language plpgsql security definer set search_path=public as $$
declare c public.calendar_connection_calendars;
begin
 select * into c from public.calendar_connection_calendars where organization_id=p_org and id=p_id for update;
 if not found or not c.available or c.access_role not in ('owner','writer','reader','writerWithoutPrivateAccess') or c.sync_claim_token is distinct from (p_claim->>'token')::uuid
  or c.sync_claim_epoch::text is distinct from p_claim->>'epoch' or c.sync_claim_until<=clock_timestamp() or c.sync_claim_until is null
  or (p_cursor is not null and c.sync_cursor is distinct from p_cursor) then raise exception 'google_stale' using errcode='PT409'; end if;
 if not exists(select 1 from public.calendar_connections x join public.user_organizations m on m.organization_id=x.organization_id and m.user_id=x.user_id
  where x.organization_id=p_org and x.id=c.connection_id and m.revoked_at is null and x.status='healthy') then raise exception 'google_connection_unavailable' using errcode='42501';end if;
end;$$;
revoke all on function public.fn_google_calendar_fence(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;

create or replace function public.fn_google_selection(p_org uuid,p_revisions jsonb,p_sources uuid[],p_destination uuid)
returns void language plpgsql security definer set search_path=public as $$
declare actor uuid:=auth.uid(); expected jsonb; actual jsonb;
begin
 if actor is null or not public.fn_role_at_least(p_org,'agent') or not public.fn_support_write_allowed(p_org) then raise exception 'google_selection_forbidden' using errcode='42501';end if;
 if not public.fn_session_mfa_proven() then raise exception 'google_mfa_required' using errcode='42501';end if;
 perform 1 from public.user_organizations where organization_id=p_org and user_id=actor and revoked_at is null for update;
 if not found then raise exception 'google_owner_unavailable' using errcode='42501';end if;
 select jsonb_agg(value order by value->>'connection_id') into expected from jsonb_array_elements(p_revisions);
 select jsonb_agg(jsonb_build_object('connection_id',id,'revision',calendar_selection_revision::text) order by id::text) into actual from public.calendar_connections where organization_id=p_org and user_id=actor and provider='google_calendar';
 if actual is distinct from expected then raise exception 'google_selection_stale' using errcode='PT409';end if;
 if not exists(select 1 from public.calendar_connection_calendars k join public.calendar_connections c on c.id=k.connection_id and c.organization_id=k.organization_id
  where k.organization_id=p_org and k.id=p_destination and c.user_id=actor and c.status='healthy' and k.available and k.access_role in ('owner','writer')) then raise exception 'google_destination_unavailable' using errcode='42501';end if;
 if exists(select 1 from unnest(p_sources) selected(id) where not exists(select 1 from public.calendar_connection_calendars k join public.calendar_connections c on c.id=k.connection_id and c.organization_id=k.organization_id
  where k.organization_id=p_org and k.id=selected.id and c.user_id=actor and c.status='healthy' and k.available and k.access_role in ('owner','writer','reader','writerWithoutPrivateAccess'))) then raise exception 'google_source_unavailable' using errcode='42501';end if;
 update public.calendar_connection_calendars k set is_destination=false from public.calendar_connections c where k.organization_id=p_org and c.organization_id=p_org and k.connection_id=c.id and c.user_id=actor;
 update public.calendar_connection_calendars k set is_destination=k.id=p_destination,counts_for_conflicts=k.id=any(p_sources),sync_next_attempt_at=now() from public.calendar_connections c where k.organization_id=p_org and c.organization_id=p_org and k.connection_id=c.id and c.user_id=actor;
 update public.calendar_connections set calendar_selection_revision=calendar_selection_revision+1 where organization_id=p_org and user_id=actor and provider='google_calendar';
end;$$;
revoke all on function public.fn_google_selection(uuid,jsonb,uuid[],uuid) from public,anon;
grant execute on function public.fn_google_selection(uuid,jsonb,uuid[],uuid) to authenticated;

create or replace function public.fn_google_catalog(p_org uuid,p_connection uuid,p_items jsonb,p_revision text)
returns void language plpgsql security definer set search_path=public as $$
declare conn public.calendar_connections; it jsonb; fresh boolean;
begin
 select * into conn from public.calendar_connections where organization_id=p_org and id=p_connection;
 if not found then raise exception 'google_connection_unavailable' using errcode='P0002';end if;
 perform 1 from public.user_organizations where organization_id=p_org and user_id=conn.user_id and revoked_at is null for update;
 if not found then raise exception 'google_owner_unavailable' using errcode='42501';end if;
 select * into conn from public.calendar_connections where organization_id=p_org and id=p_connection;
 if conn.status<>'healthy' then raise exception 'google_connection_unavailable' using errcode='42501';end if;
 if conn.calendar_selection_revision::text is distinct from p_revision then raise exception 'google_selection_stale' using errcode='PT409';end if;
 fresh:=(select count(*) from public.calendar_connections where organization_id=p_org and user_id=conn.user_id and provider='google_calendar')=1 and conn.calendar_selection_revision=0 and not exists(select 1 from public.calendar_connection_calendars k join public.calendar_connections x on x.organization_id=k.organization_id and x.id=k.connection_id where k.organization_id=p_org and x.user_id=conn.user_id and k.is_destination);
 for it in select value from jsonb_array_elements(p_items) loop
  insert into public.calendar_connection_calendars(organization_id,connection_id,external_calendar_id,name,time_zone,is_primary,access_role,available,catalog_checked_at,counts_for_conflicts,is_destination,allowed_conference_types)
   values(p_org,p_connection,it->>'id',coalesce(it->>'summaryOverride',it->>'summary',it->>'id'),it->>'timeZone',coalesce((it->>'primary')::boolean,false),it->>'accessRole',not coalesce((it->>'deleted')::boolean,false),now(),
    fresh and coalesce((it->>'primary')::boolean,false),false,case when jsonb_typeof(it->'conferenceProperties'->'allowedConferenceSolutionTypes')='array' then array(select jsonb_array_elements_text(it->'conferenceProperties'->'allowedConferenceSolutionTypes')) else null end)
   on conflict(organization_id,connection_id,external_calendar_id) do update set name=excluded.name,time_zone=excluded.time_zone,is_primary=excluded.is_primary,
    allowed_conference_types=excluded.allowed_conference_types,access_role=excluded.access_role,available=excluded.available,catalog_checked_at=excluded.catalog_checked_at,sync_next_attempt_at=now();
 end loop;
 update public.calendar_connection_calendars set available=false,catalog_checked_at=now() where organization_id=p_org and connection_id=p_connection
  and not exists(select 1 from jsonb_array_elements(p_items) v where v->>'id'=external_calendar_id);
 if fresh then
  update public.calendar_connection_calendars set is_destination=true where organization_id=p_org and connection_id=p_connection and is_primary and available and access_role in ('owner','writer');
 end if;
 update public.calendar_connections set calendar_selection_revision=calendar_selection_revision+1 where organization_id=p_org and id=p_connection;
end;$$;
revoke all on function public.fn_google_catalog(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.fn_google_catalog(uuid,uuid,jsonb,text) to service_role;

create or replace function public.fn_google_resolve(p_org uuid,p_id uuid,p_revision text,p_local_revision text,p_etag text,p_choice text)
returns void language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; contact uuid;
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'agent') or not public.fn_support_write_allowed(p_org) then raise exception 'google_resolution_forbidden' using errcode='42501';end if;
 if not public.fn_session_mfa_proven() then raise exception 'google_mfa_required' using errcode='42501';end if;
 select contact_id into contact from public.calendar_appointments where organization_id=p_org and id=p_id;
 if contact is not null then perform public.fn_service_lock(p_org,contact);end if;
 select * into a from public.calendar_appointments where organization_id=p_org and id=p_id for update;
 if not found or a.owner_user_id is distinct from auth.uid() then raise exception 'google_resolution_forbidden' using errcode='42501';end if;
 if a.revision::text is distinct from p_revision or a.google_local_revision::text is distinct from p_local_revision
  or a.google_etag is distinct from p_etag then raise exception 'google_stale' using errcode='PT409';end if;
 if p_choice='retry' then
  if a.google_conflict is not null then raise exception 'google_conflict_requires_choice' using errcode='PT409';end if;
  update public.calendar_appointments set google_next_attempt_at=now() where organization_id=p_org and id=p_id;
 else
  if p_choice not in ('google','local','preserve_remote') or a.google_conflict is null then raise exception 'google_choice_invalid' using errcode='22023';end if;
  -- O trigger reconhece somente esta forma autenticada: o corpo da comparação
  -- e as revisões não mudam, actor_id é auth.uid(), não input do browser.
  update public.calendar_appointments set google_conflict=google_conflict||jsonb_build_object('resolution',jsonb_build_object('choice',p_choice,'actor_id',auth.uid())),google_next_attempt_at=now()
   where organization_id=p_org and id=p_id;
 end if;
end;$$;
revoke all on function public.fn_google_resolve(uuid,uuid,text,text,text,text) from public,anon;
grant execute on function public.fn_google_resolve(uuid,uuid,text,text,text,text) to authenticated;

create or replace function public.fn_google_appointment(p_org uuid,p_id uuid,p_action text,p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; c public.calendar_connection_calendars; conn public.calendar_connections;
 contact uuid; claim jsonb:=p_args->'claim'; result jsonb; b jsonb; changed boolean; remote jsonb;
begin
 select contact_id into contact from public.calendar_appointments where organization_id=p_org and id=p_id;
 if not found then raise exception 'appointment_not_found' using errcode='P0002';end if;
 if contact is not null then perform public.fn_service_lock(p_org,contact);end if;
 -- Seleção/reserva compartilham membership antes dos locks de calendário/appointment.
 perform 1 from public.user_organizations m join public.calendar_appointments x on x.organization_id=m.organization_id and x.owner_user_id=m.user_id
  where x.organization_id=p_org and x.id=p_id for update of m;
 if p_args?'calendar_fence' then
  perform public.fn_google_calendar_fence(p_org,(p_args->'calendar_fence'->>'id')::uuid,p_args->'calendar_fence'->'claim',p_args->'calendar_fence'->'cursor');
 end if;
 select * into a from public.calendar_appointments where organization_id=p_org and id=p_id for update;
 if a.contact_id is distinct from contact then raise exception 'appointment_stale' using errcode='PT409';end if;
 if contact is not null and exists(select 1 from public.contacts where organization_id=p_org and id=contact and is_anonymized) then
  if p_action='claim' then return jsonb_build_object('terminal','redacted');end if;
  raise exception 'google_contact_redacted' using errcode='42501';end if;
 if not exists(select 1 from public.user_organizations where organization_id=p_org and user_id=a.owner_user_id and revoked_at is null) then
  raise exception 'google_owner_unavailable' using errcode='42501';end if;
 if p_action='claim' then
  if a.google_claim_until>clock_timestamp() then return null;end if;
  if a.google_event_id is null and a.status<>'cancelled' then
   select k.* into c from public.calendar_connection_calendars k join public.calendar_connections x on x.id=k.connection_id and x.organization_id=k.organization_id
    where k.organization_id=p_org and x.user_id=a.owner_user_id and k.is_destination;
   if not found or (select count(*) from public.calendar_connection_calendars k join public.calendar_connections x on x.id=k.connection_id and x.organization_id=k.organization_id where k.organization_id=p_org and x.user_id=a.owner_user_id and k.is_destination)<>1 then
    update public.calendar_appointments set google_sync_error='Escolha uma agenda de destino nas configurações.',google_next_attempt_at=now()+interval '15 minutes' where organization_id=p_org and id=p_id;return null;
   end if;
   if not c.available or c.access_role not in ('owner','writer') then
    update public.calendar_appointments set google_sync_error='A agenda de destino não permite publicação. Confira o acesso nas configurações.',google_next_attempt_at=now()+interval '15 minutes' where organization_id=p_org and id=p_id;return null;end if;
   update public.calendar_appointments set google_connection_id=c.connection_id,google_calendar_id=c.external_calendar_id,
    google_event_id='deskcommapp'||replace(id::text,'-',''),google_pending_write='{"reservation":true}'::jsonb where organization_id=p_org and id=p_id returning * into a;
  end if;
  update public.calendar_appointments set google_claim_token=gen_random_uuid(),google_claim_epoch=google_claim_epoch+1,
   google_claim_until=clock_timestamp()+interval '90 seconds' where organization_id=p_org and id=p_id returning * into a;
 else
  if a.google_claim_token is distinct from (claim->>'token')::uuid or a.google_claim_epoch::text is distinct from claim->>'epoch'
   or a.google_claim_until is null or a.google_claim_until<=clock_timestamp() then raise exception 'google_stale' using errcode='PT409';end if;
  if p_action='renew' then
   if a.revision::text is distinct from p_args->>'revision' or a.google_local_revision::text is distinct from p_args->>'local_revision' then raise exception 'google_stale' using errcode='PT409';end if;
   if not exists(select 1 from public.calendar_connections x join public.calendar_connection_calendars k on k.organization_id=x.organization_id and k.connection_id=x.id
    where x.organization_id=p_org and x.id=a.google_connection_id and x.user_id=a.owner_user_id and x.status='healthy' and k.external_calendar_id=a.google_calendar_id and k.available and k.access_role in ('writer','owner')) then raise exception 'google_connection_unavailable' using errcode='42501';end if;
   update public.calendar_appointments set google_claim_until=clock_timestamp()+interval '90 seconds' where organization_id=p_org and id=p_id returning * into a;
  elsif p_action='release' then
   update public.calendar_appointments set google_claim_token=null,google_claim_until=null where organization_id=p_org and id=p_id;return 'true';
  else
   if a.revision::text is distinct from p_args->>'revision' or a.google_local_revision::text is distinct from p_args->>'local_revision'
    or a.google_event_id is distinct from p_args->>'event_id' or a.google_connection_id::text is distinct from p_args->>'connection_id'
    or a.google_calendar_id is distinct from p_args->>'calendar_id' then raise exception 'google_stale' using errcode='PT409';end if;
   if p_action='error' then
    update public.calendar_appointments set google_sync_error=left(p_args->>'message',200),google_next_attempt_at=now()+interval '15 minutes',
     meeting_state=case when meeting_state='pending' and meeting_attempts>=19 then 'failed' else meeting_state end,
     meeting_last_error=case when meeting_state='pending' then 'unknown' else meeting_last_error end,
     meeting_attempts=meeting_attempts+case when meeting_state='pending' then 1 else 0 end,
     meeting_next_attempt_at=case when meeting_state='pending' then now()+make_interval(secs=>least(900,15*power(2,least(meeting_attempts,6)))::double precision+floor(random()*5)) else meeting_next_attempt_at end
     where organization_id=p_org and id=p_id;return 'true';end if;
   if a.google_event_id is not null then
    select * into conn from public.calendar_connections where organization_id=p_org and id=a.google_connection_id and user_id=a.owner_user_id;
    select * into c from public.calendar_connection_calendars where organization_id=p_org and connection_id=a.google_connection_id and external_calendar_id=a.google_calendar_id;
    if conn.id is null or conn.status<>'healthy' or c.id is null or not c.available then raise exception 'google_connection_unavailable' using errcode='42501';end if;
   end if;
   if p_action='meet' then
    perform public.fn_meet_observe(p_org,p_id,p_args);
    select * into a from public.calendar_appointments where organization_id=p_org and id=p_id;
   elsif p_action='prepare' then
    if c.access_role not in ('owner','writer') or (a.google_pending_write is not null and a.google_pending_write<>'{"reservation":true}'::jsonb) or a.google_conflict is not null then raise exception 'google_write_unavailable' using errcode='PT409';end if;
    if p_args->'operation'?'conference_request_id' and (a.meeting_request_id is distinct from (p_args->'operation'->>'conference_request_id')::uuid or a.meeting_state<>'pending' or a.meeting_received_at is not null or a.status='cancelled') then raise exception 'meet_stale' using errcode='PT409';end if;
    update public.calendar_appointments set meeting_requested_at=case when p_args->'operation'?'conference_request_id' then coalesce(meeting_requested_at,now()) else meeting_requested_at end,google_pending_write=p_args->'operation' where organization_id=p_org and id=p_id;return 'true';
   elsif p_action='idle' then
   -- idle = convergente sem nada a fazer e sem falha nesta rodada: erro
   -- guardado aqui e de rodada passada e nao pode sobreviver (#2467).
    update public.calendar_appointments set google_sync_error=null,google_next_attempt_at=now()+interval '15 minutes' where organization_id=p_org and id=p_id;return 'true';
   elsif p_action='commit' then
    result:=p_args->'result'; b:=result->'base';remote:=result->'remote';
    if result?'operation_id' and a.google_pending_write->>'operation_id' is distinct from result->>'operation_id' then raise exception 'google_stale' using errcode='PT409';end if;
    if result?'apply_remote' then
     if a.status not in ('pending','confirmed') then raise exception 'google_outcome_protected' using errcode='PT409';end if;
     if not coalesce((remote->>'cancelled')::boolean,false) and exists(select 1 from public.calendar_appointments other
      where other.organization_id=p_org and other.owner_user_id=a.owner_user_id and other.id<>a.id and other.status in ('pending','confirmed')
      and other.starts_at<(remote->>'ends_at')::timestamptz and other.ends_at>(remote->>'starts_at')::timestamptz) then
      return jsonb_build_object('overlap',true);end if;
     changed:=row(a.starts_at,a.ends_at,a.time_zone,a.status='cancelled') is distinct from row((remote->>'starts_at')::timestamptz,(remote->>'ends_at')::timestamptz,remote->>'time_zone',(remote->>'cancelled')::boolean);
     perform public.fn_appointment_change_core(p_org,p_id,a.revision,
      jsonb_build_object('starts_at',remote->>'starts_at','ends_at',remote->>'ends_at','time_zone',remote->>'time_zone')||
      case when (remote->>'cancelled')::boolean then '{"status":"cancelled","cancellation_reason":"Cancelado no Google"}'::jsonb else '{}'::jsonb end,true,b);
     if changed then
      insert into public.crm_lead_activities(organization_id,lead_id,contact_id,type,source_module,source_id,actor_kind,reason,payload)
       select p_org,l.lead_id,a.contact_id,case when (remote->>'cancelled')::boolean then 'appointment_cancelled' else 'appointment_rescheduled' end,
        'agenda',p_id,'system',case when (remote->>'cancelled')::boolean then 'Cancelado no Google' else 'Remarcado no Google' end,jsonb_build_object('origin','google','appointment_id',p_id,'resolution_actor_id',a.google_conflict->'resolution'->>'actor_id')
       from public.crm_lead_links l where l.organization_id=p_org and l.target_id=p_id and l.target_kind='appointment' group by l.lead_id;
     end if;
    end if;
    update public.calendar_appointments set
     google_base_projection=case when result?'base' then b else google_base_projection end,
     google_etag=case when result?'etag' then result->>'etag' else google_etag end,
     google_conflict=case when result?'conflict' then nullif(result->'conflict','null'::jsonb) else google_conflict end,
     google_pending_write=case when coalesce((result->>'retry_creation')::boolean,false) and a.google_base_projection is null and a.google_pending_write->>'method'='POST'
      then '{"reservation":true}'::jsonb when coalesce((result->>'clear_pending')::boolean,false) then null else google_pending_write end,
     google_synced_local_revision=case when coalesce((result->>'ack')::boolean,false) then a.google_local_revision else google_synced_local_revision end,
     google_synced_at=case when coalesce((result->>'ack')::boolean,false) then now() else google_synced_at end,
     google_sync_error=null,google_next_attempt_at=now()+interval '5 minutes'
     where organization_id=p_org and id=p_id returning * into a;
   else raise exception 'google_action_invalid' using errcode='22023';end if;
  end if;
 end if;
 return to_jsonb(a)||jsonb_build_object('revision',a.revision::text,'google_local_revision',a.google_local_revision::text,
  'google_synced_local_revision',a.google_synced_local_revision::text,'meeting_allowed_types',(select allowed_conference_types from public.calendar_connection_calendars where organization_id=p_org and connection_id=a.google_connection_id and external_calendar_id=a.google_calendar_id),'claim',jsonb_build_object('token',a.google_claim_token,'epoch',a.google_claim_epoch::text,'lease_until',a.google_claim_until));
end;$$;
revoke all on function public.fn_google_appointment(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.fn_google_appointment(uuid,uuid,text,jsonb) to service_role;

create or replace function public.fn_meet_stamp()
returns trigger language plpgsql set search_path=public as $$
declare redacted boolean; j public.job_queue; b jsonb;
begin
 if current_user in ('authenticated','anon') then
  if tg_op='INSERT' then
   if new.meeting_delivery<>'{"state":"none"}'::jsonb or new.meeting_request_id is not null or new.meeting_url is not null or new.meeting_state<>'not_requested' or new.meeting_requested_at is not null or new.meeting_received_at is not null or new.meeting_ready_at is not null or new.meeting_attempts<>0 or new.meeting_last_error is not null or new.meeting_next_attempt_at is not null or new.meeting_delivery_job_id is not null then raise exception 'meet_metadata_private' using errcode='42501';end if;
  elsif row(new.meeting_state,new.meeting_request_id,new.meeting_requested_at,new.meeting_received_at,new.meeting_ready_at,new.meeting_attempts,new.meeting_last_error,new.meeting_next_attempt_at,new.meeting_delivery,new.meeting_delivery_job_id,new.meeting_url)
   is distinct from row(old.meeting_state,old.meeting_request_id,old.meeting_requested_at,old.meeting_received_at,old.meeting_ready_at,old.meeting_attempts,old.meeting_last_error,old.meeting_next_attempt_at,old.meeting_delivery,old.meeting_delivery_job_id,old.meeting_url) then
   raise exception 'meet_metadata_private' using errcode='42501';
  end if;
 end if;
 select is_anonymized into redacted from public.contacts where id=new.contact_id and organization_id=new.organization_id;
 if (redacted or new.status='cancelled' or new.location_kind<>'google_meet') and (new.location_kind='google_meet' or new.meeting_state<>'not_requested') then
  if new.location_kind='google_meet' or new.meeting_state<>'not_requested' or new.meeting_requested_at is not null or new.meeting_received_at is not null or new.meeting_ready_at is not null or new.meeting_attempts<>0 or new.meeting_last_error is not null or new.meeting_next_attempt_at is not null or new.meeting_delivery_job_id is not null then new.meeting_state:='cancelled';end if;
  new.meeting_request_id:=null;new.meeting_url:=null;new.meeting_last_error:=null;new.meeting_next_attempt_at:=null;
  new.meeting_delivery:=jsonb_build_object('state',case when redacted then 'blocked' else 'stale' end);
 elsif new.location_kind='google_meet' and new.meeting_state='not_requested' then
  new.meeting_state:='pending';new.meeting_request_id:=gen_random_uuid();new.meeting_next_attempt_at:=now();
 end if;
 if tg_op='INSERT' and new.meeting_delivery ? 'booking_claim' then
  perform public.fn_service_lock(new.organization_id,new.contact_id);
  select * into j from public.job_queue where organization_id=new.organization_id and id=(new.meeting_delivery->>'source_operation_id')::uuid for update;
  b:=new.meeting_delivery->'service_boundary';
  if j.contact_id is distinct from new.contact_id or j.status is distinct from 'running' or j.kind not in ('inbound_turn','followup_turn','case_reply_turn','operator_turn')
   or j.locked_by is distinct from new.meeting_delivery->'booking_claim'->>'worker_id' or j.locked_at is distinct from (new.meeting_delivery->'booking_claim'->>'acquired_at')::timestamptz
   or j.payload->'service_boundary' is distinct from b or not public.fn_meet_boundary_current(b) or b->>'conversation_id' is distinct from new.conversation_id::text then
   raise exception 'meet_booking_stale' using errcode='PT409';end if;
  if new.meeting_delivery->'authorized_by'->>'kind' is distinct from 'ai_agent' then raise exception 'meet_booking_origin_invalid' using errcode='42501';end if;
  new.meeting_delivery:=new.meeting_delivery-'booking_claim';
 end if;
 if new.meeting_delivery ? 'generation' and (tg_op='INSERT' or new.meeting_delivery->>'generation' is distinct from old.meeting_delivery->>'generation') then
  new.meeting_delivery:=new.meeting_delivery||jsonb_build_object('channel_session_id',(select channel_session_id from public.conversations where organization_id=new.organization_id and contact_id=new.contact_id and id::text=new.meeting_delivery->'service_boundary'->>'conversation_id'));
 end if;
 if new.meeting_state='pending' and new.meeting_next_attempt_at is not null then new.google_next_attempt_at:=least(new.google_next_attempt_at,new.meeting_next_attempt_at);end if;
 return new;
end;$$;
revoke all on function public.fn_meet_stamp() from public,anon,authenticated;

create or replace function public.fn_meet_observe(p_org uuid,p_id uuid,p_args jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; r jsonb:=p_args->'result';
begin
 select * into a from public.calendar_appointments where organization_id=p_org and id=p_id for update;
 if not found or a.status='cancelled' or a.location_kind<>'google_meet' or a.meeting_request_id is distinct from (p_args->>'meeting_request_id')::uuid
  or a.google_claim_token is distinct from (p_args->'claim'->>'token')::uuid or a.google_claim_epoch::text is distinct from p_args->'claim'->>'epoch'
  or a.google_claim_until<=clock_timestamp() or a.google_claim_until is null or a.revision::text is distinct from p_args->>'revision' or a.google_local_revision::text is distinct from p_args->>'local_revision' then raise exception 'meet_stale' using errcode='PT409';end if;
 if r->>'state' is null or r->>'state' not in ('pending','ready','failed') or (r->>'error' is not null and r->>'error' not in ('google_failure','unsupported','unknown','invalid')) then raise exception 'meet_invalid' using errcode='22023';end if;
 if r->>'state'='ready' and (r->>'url' is null or r->>'url' !~ '^https://meet[.]google[.]com/[a-zA-Z0-9-]+/?$') then raise exception 'meet_invalid_url' using errcode='22023';end if;
 update public.calendar_appointments set
  meeting_state=case when r->>'state'='pending' and meeting_attempts>=19 then 'failed' else r->>'state' end,
  meeting_url=case when r->>'state'='ready' then r->>'url' else null end,
  meeting_last_error=case when r->>'state'='pending' and meeting_attempts>=19 then 'unknown' else r->>'error' end,
  meeting_received_at=case when coalesce((r->>'received')::boolean,false) then coalesce(meeting_received_at,now()) else meeting_received_at end,
  meeting_ready_at=case when r->>'state'='ready' then coalesce(meeting_ready_at,now()) else null end,
  meeting_attempts=meeting_attempts+1,
  meeting_next_attempt_at=now()+make_interval(secs=>least(900,15*power(2,least(meeting_attempts,6)))::double precision+floor(random()*5)),
  google_etag=coalesce(r->>'etag',google_etag)
 where organization_id=p_org and id=p_id;
end;$$;
revoke all on function public.fn_meet_observe(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.fn_meet_observe(uuid,uuid,jsonb) from service_role;

create or replace function public.fn_meet_delivery_settle(p_org uuid,p_job uuid,p_worker text,p_acquired_at timestamptz,p_state text,p_retry_at timestamptz default null)
returns boolean language plpgsql security definer set search_path=public as $$
declare j public.job_queue; a public.calendar_appointments; contact uuid; current_intent boolean; reason text;
begin
 select contact_id into contact from public.job_queue where organization_id=p_org and id=p_job;
 if contact is null then return false;end if;
 perform public.fn_service_lock(p_org,contact);
 select * into j from public.job_queue where organization_id=p_org and id=p_job for update;
 if not found or j.kind<>'transactional_delivery' or j.status<>'running' or j.locked_by is distinct from p_worker or j.locked_at is distinct from p_acquired_at then return false;end if;
 select * into a from public.calendar_appointments where organization_id=p_org and id::text=j.payload->>'appointment_id' for update;
 current_intent:=a.meeting_delivery_job_id=j.id and a.meeting_delivery->>'generation'=j.payload->>'delivery_generation';
 if p_state like 'blocked:%' then
  reason:=substring(p_state from 9);
  if reason not in ('opt_out','lgpd','channel','access_or_stale','force_human','conversa_silenciada','conversa_de_humano','sem_autorizacao','autorizacao_expirada','limits','guardrail') then raise exception 'meet_reason_invalid' using errcode='22023';end if;
  p_state:='blocked';
 end if;
 if p_state not in ('sent','queued','retry','failed','blocked','stale') then raise exception 'meet_state_invalid' using errcode='22023';end if;
 if p_state in ('sent','queued','retry') and not public.fn_meet_delivery_current(p_org,p_job,p_worker,p_acquired_at) then p_state:='stale';end if;
 if p_state='sent' and not exists(select 1 from public.send_ledger where organization_id=p_org and job_id=p_job and seq=1 and status='accepted') then raise exception 'meet_delivery_not_accepted' using errcode='PT409';end if;
 if p_state='retry' and j.attempts>=j.max_attempts then p_state:='failed';end if;
 if p_state in ('queued','retry') then
  update public.job_queue set status='pending',locked_by=null,locked_at=null,attempts=case when p_state='queued' then greatest(0,attempts-1) else attempts end,run_after=coalesce(p_retry_at,now()+interval '1 minute'),last_error='meet_delivery_waiting' where id=p_job and organization_id=p_org;
 else
  update public.job_queue set status=case when p_state='sent' then 'done' else 'failed' end,locked_by=null,locked_at=null,last_error=case when p_state='sent' then null else coalesce(reason,'meet_delivery_'||p_state) end where id=p_job and organization_id=p_org;
  if current_intent then
   update public.calendar_appointments set meeting_delivery=meeting_delivery||jsonb_build_object('state',p_state,'error',case when p_state='sent' then null else coalesce(reason,'meet_delivery_'||p_state) end,'settled_at',now()) where id=a.id and organization_id=p_org;
   if p_state<>'sent' then perform public.fn_meet_notice(p_org,a.id,p_state);
   else update public.agent_inbox_items set status='resolved',resolved_at=now() where organization_id=p_org and ref_kind='appointment' and ref_id=a.id and kind='other' and status='open';end if;
  end if;
 end if;
 return true;
end;$$;
revoke all on function public.fn_meet_delivery_settle(uuid,uuid,text,timestamptz,text,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_meet_delivery_settle(uuid,uuid,text,timestamptz,text,timestamptz) to service_role;
