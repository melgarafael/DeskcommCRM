-- O COMPROMISSO CHEGA AO CLIENTE MESMO SEM GOOGLE MEET.
--
-- Recorte do PR #803, de @paulolimajr77 (frente do Meet, fatia 3).
-- Empilha sobre a fatia 2 (0365): as definições abaixo são as dela, com a
-- exigência de link passando a ser CONDICIONAL e mais nada.
--
-- ## O que faltava
--
-- A entrega transacional já resolvia fila, canal, fronteira de atendimento e
-- autorização. Ela só não valia para compromisso PRESENCIAL ou POR TELEFONE,
-- porque duas exigências eram incondicionais: `meeting_state='ready'` e
-- `meeting_url is not null`. Marcar uma visita ou uma ligação e mandar os dados
-- ao cliente pelo CRM simplesmente não existia — a seção nem aparecia na tela.
--
-- Agora as duas valem SÓ onde o local é o Meet.
--
-- ## ⛔ O que NÃO muda, e é o que impede isto de virar buraco
--
--   • atendimento aberto na conversa continua obrigatório;
--   • contato anonimizado ou bloqueado continua fora;
--   • quem autoriza continua tendo de ser o responsável, com papel conferido no
--     ENVIO e não no clique;
--   • e onde o local É o Meet, o link continua tendo de estar pronto — mandar
--     uma reunião sem como entrar nela é pior que não mandar.
--
-- ## TRÊS funções, e a divisão de trabalho entre elas
--
-- `fn_meet_delivery_enqueue` é o GATILHO que cria o job — e é nele que estava a
-- exigência mais silenciosa: sem link pronto ele devolvia sem enfileirar, e a
-- entrega de um presencial ficava em `waiting_for_link` para sempre, sem job,
-- sem aviso e sem erro. `fn_meet_delivery_current` é o porteiro do envio: é ele que
-- decide se o job pode sair, e é lá que a exigência de link vira condicional.
-- `fn_meet_action` perde a guarda `location_kind<>'google_meet'` da recusa por
-- `meet_stale`: com ela, autorizar o envio de um compromisso presencial era
-- recusado como se a tela estivesse velha.
--
-- O autor deixou escrito por que a guarda de link NÃO vai em `fn_meet_action`:
-- ele tentou, e ela derrubou 10 casos legítimos do invariante do Meet — a tela
-- oferece "Enviar quando ficar pronto", e a entrega fica em `waiting_for_link`
-- até o link chegar. Quem garante que reunião sem porta não sai é o
-- enfileirador, e o lugar certo da guarda é lá.
--
-- ⚠️ ENTRA ANTES DO BLOCO DA VARREDURA anon no baseline: ela cura só o que veio
-- antes dela, e função criada depois nasce exposta a `anon` e fica.
--
-- Idempotente: `create or replace`.

create or replace function public.fn_meet_delivery_current(p_org uuid,p_job uuid,p_worker text,p_acquired_at timestamptz)
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.job_queue j join public.calendar_appointments a on a.organization_id=j.organization_id and a.id::text=j.payload->>'appointment_id'
  join public.contacts c on c.organization_id=a.organization_id and c.id=a.contact_id
  join public.conversations v on v.organization_id=a.organization_id and v.contact_id=a.contact_id and v.id::text=j.payload->'service_boundary'->>'conversation_id'
  join public.channel_sessions cs on cs.organization_id=v.organization_id and cs.id=v.channel_session_id
  join public.organizations o on o.id=a.organization_id and o.status='active'
  where cs.archived_at is null and a.meeting_delivery->>'channel_session_id'=cs.id::text and j.organization_id=p_org and j.id=p_job and j.kind='transactional_delivery' and j.status='running' and j.locked_by=p_worker and j.locked_at=p_acquired_at
   and a.contact_id=j.contact_id and not c.is_anonymized and not c.is_blocked and a.status<>'cancelled' and (a.location_kind<>'google_meet' or (a.meeting_state='ready' and a.meeting_url is not null))
   and a.meeting_request_id::text=j.payload->>'meeting_request_id' and a.meeting_delivery->>'generation'=j.payload->>'delivery_generation'
   and a.meeting_delivery_job_id=j.id and a.meeting_delivery->>'state'='queued'
   and exists(select 1 from public.user_organizations where organization_id=p_org and user_id=a.owner_user_id and revoked_at is null)
   and (a.meeting_delivery->'authorized_by'->>'kind'='ai_agent' or
    (a.meeting_delivery->'authorized_by'->>'kind'='user' and a.meeting_delivery->'authorized_by'->>'id'=a.owner_user_id::text and exists(
     select 1 from public.user_organizations u where u.organization_id=p_org and u.user_id=a.owner_user_id and u.revoked_at is null and u.role in ('agent','manager','admin')
      and (u.role in ('manager','admin') or v.assigned_to_user_id=u.user_id or o.settings->>'visibility_mode'='all'
       or (coalesce(o.settings->>'visibility_mode','own_and_unassigned')='own_and_unassigned' and v.assigned_to_user_id is null)))))
   and a.meeting_delivery->'service_boundary'=j.payload->'service_boundary' and public.fn_meet_boundary_current(j.payload->'service_boundary'));
$$;
revoke all on function public.fn_meet_delivery_current(uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_meet_delivery_current(uuid,uuid,text,timestamptz) to service_role;

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
 if a.revision::text is distinct from p_revision or a.meeting_request_id is distinct from p_request or a.status='cancelled'
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

create or replace function public.fn_meet_delivery_enqueue()
returns trigger language plpgsql security definer set search_path=public as $$
declare jid uuid; b jsonb;
begin
 -- A MESMA ORDEM DE TRAVA das ~20 irmãs: contato PRIMEIRO, job_queue depois.
 -- Sem esta linha, este gatilho já segurava a linha do compromisso (é BEFORE/
 -- AFTER na própria calendar_appointments) e ia travar job_queue sem o mutex do
 -- contato, enquanto fn_meet_redact_contact (0229) pega o mutex do contato e só
 -- então mexe em job_queue. Duas ordens opostas sobre os mesmos dois recursos =
 -- deadlock (40P01) sob concorrência, e quem paga é o cliente com anonimização
 -- LGPD acontecendo enquanto um link de reunião é entregue.
 perform public.fn_service_lock(new.organization_id,new.contact_id);
 -- ⚠️ `status` ENTRA AQUI, e a falta dele era um buraco REAL que só apareceu
 -- ao abrir a entrega para compromisso sem Meet.
 --
 -- A guarda olhava só `meeting_state='cancelled'` — o estado do LINK, não do
 -- compromisso. Enquanto a entrega exigia link pronto isso bastava por
 -- acidente: cancelar o compromisso cancelava o link junto. Sem Meet não há
 -- link para cancelar, e um compromisso CANCELADO passava a enfileirar
 -- entrega. O porteiro do envio recusaria depois (`a.status<>'cancelled'`),
 -- então o cliente não receberia nada — mas o job nasceria para morrer
 -- bloqueado, e a tela mostraria uma entrega a caminho que nunca sai.
 --
 -- Achado do @paulolimajr77, e foi o teste DELE que o pegou aqui.
 if new.status='cancelled' or new.meeting_state='cancelled' or new.meeting_delivery->>'state' in ('blocked','stale') then
  update public.job_queue set status='failed',locked_at=null,locked_by=null,payload='{}',last_error='meet_delivery_stale'
   where organization_id=new.organization_id and id=new.meeting_delivery_job_id and kind='transactional_delivery' and status in ('pending','running');
  return new;
 end if;
 if new.meeting_state='failed' then perform public.fn_meet_notice(new.organization_id,new.id,'meeting_failed');end if;
 -- ⛔ ESPERAR O LINK VALE SÓ ONDE O LOCAL É O MEET.
 --
 -- Esta é a exigência mais fácil de esquecer e a pior de esquecer: num
 -- compromisso PRESENCIAL o `meeting_state` é `not_requested` para sempre,
 -- então a entrega era autorizada, o gatilho passava por aqui, devolvia sem
 -- enfileirar nada, e a entrega ficava em `waiting_for_link` PARA SEMPRE — em
 -- silêncio, sem job, sem aviso e sem erro. Foi o teste do autor que a achou.
 --
 -- Onde o local É o Meet, nada muda: sem link pronto não sai job, porque
 -- mandar uma reunião sem como entrar nela é pior que não mandar.
 if (new.location_kind='google_meet' and new.meeting_state<>'ready')
  or new.meeting_delivery->>'state'<>'waiting_for_link' then return new;end if;
 b:=new.meeting_delivery->'service_boundary';
 if not public.fn_meet_boundary_current(b) then
  update public.calendar_appointments set meeting_delivery=meeting_delivery||'{"state":"stale","error":"service_boundary_stale"}' where organization_id=new.organization_id and id=new.id;
  perform public.fn_meet_notice(new.organization_id,new.id,'service_boundary_stale');return new;
 end if;
 jid:=gen_random_uuid();
 insert into public.job_queue(id,organization_id,contact_id,kind,payload,run_after)
 values(jid,new.organization_id,new.contact_id,'transactional_delivery',jsonb_build_object('appointment_id',new.id,'meeting_request_id',new.meeting_request_id,
  'delivery_generation',new.meeting_delivery->>'generation','service_boundary',b),now());
 update public.calendar_appointments set meeting_delivery_job_id=jid,meeting_delivery=meeting_delivery||'{"state":"queued"}'
  where organization_id=new.organization_id and id=new.id;
 return new;
end;$$;
revoke all on function public.fn_meet_delivery_enqueue() from public,anon,authenticated;
