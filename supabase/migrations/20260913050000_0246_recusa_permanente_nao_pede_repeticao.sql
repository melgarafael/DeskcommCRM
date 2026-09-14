-- 0246 — recusa permanente para de se anunciar como "tente de novo"
--
-- ⛔ ISTO E O QUE DERRUBAVA O BANCO. Um clique em "Enviar link ao cliente" levava
-- o Postgres a 280% de CPU e o pedido nunca voltava. MEDIDO duas vezes na
-- instalacao real, em 2026-09-13.
--
-- O diagnostico anterior — meu, de 12/09 — dizia que a culpa era a trava de aviso
-- esperar sem teto. ESTAVA ERRADO. Medido durante a tempestade: nenhuma trava
-- segurada, `wait_event` vazio, `pg_blocking_pids` vazio, e a funcao respondendo
-- em 1,9 ms quando chamada direto. As migrations 0241 e 0245 consertaram um
-- mecanismo que nao era a causa.
--
-- ## A causa, PROVADA com o PostgREST v14.17 — a MESMA versao da VPS
--
-- Duas funcoes descartaveis, identicas, so mudando o SQLSTATE da recusa. Cada
-- uma chamada UMA vez por HTTP. O contador e uma sequence, porque `nextval` nao
-- volta atras no rollback e por isso conta execucao de verdade:
--
--   recusa com errcode 22023 → HTTP 400 em 12 ms ....... rodou     1 vez
--   recusa com errcode 40001 → nunca respondeu ......... rodou 51.556 vezes
--
-- `40001` e `serialization_failure`: ele DIZ a quem chama "foi um tropeco
-- passageiro, tente de novo". O PostgREST acredita e repete — sem teto, a toda
-- velocidade, ~1.700 vezes por segundo. Mas `meet_stale`,
-- `meet_conversation_stale` e `google_conflict_requires_choice` sao recusas
-- PERMANENTES: nenhuma delas passa a dar certo por insistencia. A promessa era
-- falsa, e quem pagou foi o banco.
--
-- ## Alcance: esta migration conserta TRES sitios, e existem 83
--
-- `grep -c "errcode='40001'" supabase/baseline.sql` devolve 83, em 22 recusas
-- diferentes (`service_stale`, `google_stale`, `appointment_stale`,
-- `followup_stale`...). TODAS com a mesma bomba armada, e nenhuma delas e da
-- agenda. Aqui ficam so as tres do caminho que estava quebrado; o resto esta
-- medido e escrito, e `tests/invariants/recusa-permanente-nao-pede-repeticao.test.ts`
-- impede que NASCAM novas — a lista de excecoes so encolhe.
--
-- `meet_ocupado` continua com `55P03` e nao entra aqui: ele e o unico do conjunto
-- que e mesmo passageiro, e mesmo assim nao usa 40001 — repetir a toda
-- velocidade seria ruim ate quando a promessa e verdadeira.

create or replace function public.fn_meet_action(p_org uuid,p_id uuid,p_revision text,p_request uuid,p_action text,p_conversation uuid default null)
returns boolean language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; contact uuid; b jsonb; destination_channel uuid;
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'agent') or not public.fn_support_write_allowed(p_org) then raise exception 'meet_forbidden' using errcode='42501';end if;
 if not public.fn_session_mfa_proven() then raise exception 'meet_mfa_required' using errcode='42501';end if;
 select contact_id into contact from public.calendar_appointments where organization_id=p_org and id=p_id;
 -- ESPERA LIMITADA PELA TRAVA DO ATENDIMENTO — e quem espera e o Postgres.
 --
 -- MEDIDO em producao em 2026-09-13, amostrando `pg_locks` durante o clique:
 -- varias conexoes disputando a MESMA trava por cliente. `fn_service_lock` usa
 -- `pg_advisory_xact_lock`, que espera SEM TETO, e o porteiro do Supabase
 -- desistia aos 10s com `upstream request timeout`.
 --
 -- ⚠️ ISTO CORRIGE O MEU PROPRIO CONSERTO (migration 0241), que resolveu a
 -- espera com um laco de `pg_try_advisory_xact_lock` + `pg_sleep(0.25)`. O laco
 -- funciona, mas o mecanismo e ruim: ele PESQUISA em vez de esperar. Mantem uma
 -- conexao do pool acordada, acorda 4x por segundo sem necessidade, e so
 -- percebe a trava livre ate 250ms depois que ela ficou livre.
 --
 -- MEDIDO que `lock_timeout` vale para trava de aviso: sessao segurando
 -- `pg_advisory_xact_lock(999111)`, segunda sessao com `lock_timeout='1s'`
 -- morreu em "canceling statement due to lock timeout". Entao o Postgres pode
 -- esperar por nos — dormindo de verdade, sem gastar CPU, e acordando no
 -- instante em que a trava sai.
 --
 -- 3 segundos, com folga sobre os 10s do porteiro: esperar MENOS que ele e o
 -- que troca um silencio de 30s por uma resposta honesta.
 if contact is not null then
  begin
   set local lock_timeout = '3s';
   perform public.fn_service_lock(p_org,contact);
   -- Volta ao padrao: daqui para baixo ha `for update`, e herdar o teto mudaria
   -- o comportamento deles sem que ninguem tenha decidido isso.
   set local lock_timeout = '0';
  exception when lock_not_available then
   raise exception 'meet_ocupado' using errcode='55P03';
  end;
 end if;
 select * into a from public.calendar_appointments where organization_id=p_org and id=p_id for update;
 if not found or a.owner_user_id is distinct from auth.uid() or not exists(select 1 from public.user_organizations where organization_id=p_org and user_id=auth.uid() and revoked_at is null) then raise exception 'meet_forbidden' using errcode='42501';end if;
 if a.revision::text is distinct from p_revision or a.meeting_request_id is distinct from p_request or a.status='cancelled'
  or exists(select 1 from public.contacts where id=a.contact_id and organization_id=p_org and is_anonymized) then raise exception 'meet_stale' using errcode='22023';end if;
 if p_action='retry' then
  if a.google_conflict is not null then raise exception 'google_conflict_requires_choice' using errcode='22023';end if;
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
  if not public.fn_meet_boundary_current(b) then raise exception 'meet_conversation_stale' using errcode='22023';end if;
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
