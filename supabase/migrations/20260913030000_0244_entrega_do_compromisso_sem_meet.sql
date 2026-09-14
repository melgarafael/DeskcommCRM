-- 0244 — o compromisso chega ao cliente mesmo sem Google Meet
--
-- A entrega transacional ja resolvia fila, canal, fronteira de atendimento e
-- autorizacao. Ela so nao valia para compromisso PRESENCIAL ou POR TELEFONE,
-- porque duas exigencias eram incondicionais: `meeting_state='ready'` e
-- `meeting_url is not null`. Passam a valer SO onde o local e o Meet.
--
-- ⛔ O QUE NAO MUDA, e e o que impede isto de virar buraco:
--   • atendimento aberto na conversa continua obrigatorio;
--   • contato anonimizado ou bloqueado continua fora;
--   • quem autoriza continua tendo de ser o responsavel, com papel conferido no
--     ENVIO e nao no clique;
--   • e onde o local E o Meet, o link continua tendo de estar pronto — mandar
--     uma reuniao sem como entrar nela e pior que nao mandar.

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
 if a.revision::text is distinct from p_revision or a.meeting_request_id is distinct from p_request or a.status='cancelled'
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
  -- ⚠️ AQUI NAO SE EXIGE LINK PRONTO, e isto e deliberado.
  --
  -- Autorizar o envio ANTES de o link existir e o proprio desenho: a tela
  -- oferece "Enviar quando ficar pronto", a entrega fica em `waiting_for_link`,
  -- e o gatilho a enfileira quando o link chega. Eu cheguei a pôr uma guarda de
  -- `meeting_state='ready'` aqui ao afrouxar a exigencia para compromisso sem
  -- Meet — e ela derrubou 10 casos do invariante do Meet, todos legitimos.
  --
  -- Quem garante que reuniao sem porta nao sai e o ENFILEIRADOR, que espera o
  -- link ficar pronto onde o local e o Meet. O lugar certo da guarda e la.
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
 -- ⚠️ `status` ENTRA AQUI, e a falta dele era um buraco real.
 --
 -- A guarda olhava so `meeting_state='cancelled'` — o estado do LINK. Num
 -- compromisso presencial esse estado e `not_requested` para sempre, entao
 -- um compromisso CANCELADO continuava sendo enfileirado e o cliente
 -- receberia os dados de um compromisso que nao existe mais.
 --
 -- Enquanto so o Meet era entregavel, `meeting_state` bastava por acidente:
 -- cancelar o compromisso cancelava o link junto. Ao abrir a entrega para
 -- os demais locais, o acidente deixou de cobrir. Quem pegou foi o caso de
 -- CONTROLE do invariante, nao o caso principal.
 if new.status='cancelled' or new.meeting_state='cancelled' or new.meeting_delivery->>'state' in ('blocked','stale') then
  update public.job_queue set status='failed',locked_at=null,locked_by=null,payload='{}',last_error='meet_delivery_stale'
   where organization_id=new.organization_id and id=new.meeting_delivery_job_id and kind='transactional_delivery' and status in ('pending','running');
  return new;
 end if;
 if new.meeting_state='failed' then perform public.fn_meet_notice(new.organization_id,new.id,'meeting_failed');end if;
 -- A TERCEIRA exigencia incondicional, e a mais facil de esquecer: o
 -- enfileirador tambem esperava `meeting_state='ready'`. Num compromisso
 -- presencial esse estado e `not_requested` PARA SEMPRE — entao a entrega era
 -- autorizada, o gatilho saia por aqui, e nada acontecia. Em silencio.
 if (new.location_kind='google_meet' and new.meeting_state<>'ready')
    or new.meeting_delivery->>'state'<>'waiting_for_link' then return new;end if;
 b:=new.meeting_delivery->'service_boundary';
 if not public.fn_meet_boundary_current(b) then
  update public.calendar_appointments set meeting_delivery=meeting_delivery||'{"state":"stale","error":"service_boundary_stale"}' where organization_id=new.organization_id and id=new.id;
  perform public.fn_meet_notice(new.organization_id,new.id,'service_boundary_stale');return new;
 end if;
 -- Um job pendente da geracao anterior morre AQUI, e nao e deixado para a
 -- vigencia descobrir. Assim a antirrepeticao vale mesmo com o trabalhador
 -- parado: cinco arrastos seguidos deixam UM job vivo, nao cinco.
 update public.job_queue set status='failed',locked_by=null,locked_at=null,last_error='meet_delivery_superseded'
  where organization_id=new.organization_id and id=new.meeting_delivery_job_id and kind='transactional_delivery' and status in ('pending','running');
 jid:=gen_random_uuid();
 insert into public.job_queue(id,organization_id,contact_id,kind,payload,run_after)
 values(jid,new.organization_id,new.contact_id,'transactional_delivery',jsonb_build_object('appointment_id',new.id,'meeting_request_id',new.meeting_request_id,
  'delivery_generation',new.meeting_delivery->>'generation','service_boundary',b,
  -- O motivo decide a FRASE que o cliente le. Sem ele, `primeiro_envio` —
  -- que e o comportamento de antes, e o certo para toda entrega ja na fila.
  'motivo',coalesce(new.meeting_delivery->>'motivo','primeiro_envio')),
  -- ANTIRREPETICAO: a correcao espera antes de sair, e uma remarcacao nova
  -- dentro da janela substitui esta. Sem espera, arrastar o compromisso na
  -- grade viraria uma mensagem por arrasto.
  coalesce((new.meeting_delivery->>'nao_antes_de')::timestamptz, now()));
 update public.calendar_appointments set meeting_delivery_job_id=jid,meeting_delivery=meeting_delivery||'{"state":"queued"}'
  where organization_id=new.organization_id and id=new.id;
 return new;
end;$$;
revoke all on function public.fn_meet_delivery_enqueue() from public,anon,authenticated;
