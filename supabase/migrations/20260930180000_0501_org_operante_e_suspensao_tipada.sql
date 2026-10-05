-- 0501 — A SUSPENSÃO QUE SUSPENDE: org operante, suspensão tipada e estado só pelo servidor
--        (spec docs/superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md §2.1, §2.5, §2.6, §3.1)
--
-- ── A causa ───────────────────────────────────────────────────────────────────
-- Suspender uma organização só tirava a pessoa da tela. A rota fazia leitura,
-- UPDATE e `event_log` sem await em três passos soltos; nada parava os jobs
-- `pending` nem as mensagens `queued`; e `status` era gravável pelo PostgREST
-- por qualquer platform admin — `orgs_write_platform_admin` aceita
-- `fn_is_platform_admin()`, que ignora o scope, então um `support_readonly`
-- reativava uma suspensa com um PATCH.
--
-- ── O que muda ────────────────────────────────────────────────────────────────
-- A. `organizations.suspended_kind` ('administrativa' | 'cobranca'), backfill
--    ANTES do CHECK. Sem CHECK de coerência com `status`: o lgpd-redact-worker
--    troca para `redacted` sem limpar o tipo; a regra de leitura mora em
--    lib/organizacao/operante.ts. `fn_org_operante(uuid)` é a régua SQL do
--    predicado (`status = 'active'`, falha fechada).
-- B. Gatilho `trg_organizacao_estado_so_pelo_servidor` (molde: `fn_meet_stamp`):
--    a sessão (`authenticated`/`anon`) não cria organização nem muda status,
--    tipo, campos de suspensão, `redacted_at` ou `created_by`.
-- C. `fn_suspender_organizacao`: uma transação, lock na linha, anti-backlog
--    (jobs `pending` → `failed`/`org_nao_operante`; mensagens `queued` →
--    `failed`/`org_suspensa`) e `tenant.suspended` no `event_log` na MESMA
--    transação. A administrativa prevalece sobre a de cobrança. O descarte da
--    fila (C0, `fn_org_parada_descarta_fila`) assenta junto o que dependia do
--    job: rascunho aprovado → `failed`, link do Meet → `failed` + aviso.
-- D. `agent_inbox_items.kind` ganha 'org_reativada' (lista completa do baseline).
-- E. `fn_reativar_organizacao`: exige o tipo, zera a suspensão, falha jobs
--    `pending` que sobraram e abre UM item 'org_reativada' com a contagem de
--    conversas (fora grupos) que receberam mensagem durante a suspensão. Nada é
--    reprocessado.
-- F. `fn_claim_due_followup_enrollments` não entrega inscrição de org parada: o
--    motor de follow-up não avança, não enfileira e não paga LLM por ela. Na
--    reativação a inscrição RETOMA: a de um nó `action` cujo turno a C0 descartou
--    (evento `turn_discarded`) ganha um turno novo, em vez de esgotar o dead-man.
--    O turno que JÁ RODAVA na suspensão grava o mesmo evento pelo worker, pela
--    mesma regra (`fn_followup_turno_descartado`, seção C0a).
-- G. `fn_followup_generation_write` recusa `turn_discarded` vindo da sessão
--    (`auth.uid()`): só o servidor grava o evento que faz o motor enfileirar.
--
-- Na PR 1 nenhuma das duas funções cita `cobranca_assinaturas` (nasce na PR 2;
-- plpgsql resolve a relação ao executar, e daria 42P01 em toda chamada).
-- Idempotente: `add column if not exists`, drop+add de constraint, `create or
-- replace`, `drop trigger if exists`. Toda função perde EXECUTE das duas
-- origens (public e anon) e de authenticated; só service_role executa — e a
-- C0, interna às duas funções de estado, nem ele.
-- Gate: tests/invariants/org-suspensa.test.ts.

-- ── A. suspended_kind + fn_org_operante ──────────────────────────────────────
alter table public.organizations add column if not exists suspended_kind text;

update public.organizations
   set suspended_kind = 'administrativa'
 where status = 'suspended'
   and suspended_kind is null;

alter table public.organizations
  drop constraint if exists organizations_suspended_kind_check;
alter table public.organizations
  add constraint organizations_suspended_kind_check check (suspended_kind in ('administrativa', 'cobranca'));

comment on column public.organizations.suspended_kind is
  'Por que a organização está suspensa: administrativa (platform admin) ou cobranca (régua de cobrança). Só significa algo com status = suspended: o lgpd-redact-worker troca para redacted sem limpar. Escrito só por fn_suspender_organizacao e fn_reativar_organizacao (migration 0501).';

create or replace function public.fn_org_operante(p_org uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((select o.status = 'active' from public.organizations o where o.id = p_org), false);
$$;

revoke execute on function public.fn_org_operante(uuid) from public, anon, authenticated;
grant execute on function public.fn_org_operante(uuid) to service_role;

-- ── B. o estado da organização só muda pelo servidor ─────────────────────────
-- `orgs_write_platform_admin` aceita qualquer `fn_is_platform_admin()`, que
-- ignora o scope, e `authenticated` tem GRANT ALL: sem isto um support_readonly
-- reativaria uma suspensa, trocaria o tipo da suspensão, gravaria uma data de
-- anonimização (`redacted_at`, escrita só pelo lgpd-redact-worker) ou criaria
-- org isenta pelo PostgREST. Todo escritor legítimo é service_role ou função definer, onde
-- `current_user` é o dono da função. Molde: `fn_meet_stamp`.
create or replace function public.fn_organizacao_estado_so_pelo_servidor()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    raise exception 'organizacao_nasce_so_pelo_servidor'
      using errcode = '42501',
            detail = 'Organização nasce por rota de servidor (service_role ou função definer), nunca pela sessão.';
  end if;
  if new.status is distinct from old.status
     or new.suspended_kind is distinct from old.suspended_kind
     or new.suspended_at is distinct from old.suspended_at
     or new.suspended_reason is distinct from old.suspended_reason
     or new.suspended_by is distinct from old.suspended_by
     or new.redacted_at is distinct from old.redacted_at
     or new.created_by is distinct from old.created_by then
    raise exception 'estado_da_organizacao_so_pelo_servidor'
      using errcode = '42501',
            detail = 'Status, suspensão, anonimização e autoria mudam só por fn_suspender_organizacao, fn_reativar_organizacao ou rota de servidor.';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_organizacao_estado_so_pelo_servidor() from public, anon, authenticated;

drop trigger if exists trg_organizacao_estado_so_pelo_servidor on public.organizations;
create trigger trg_organizacao_estado_so_pelo_servidor
  before insert or update on public.organizations
  for each row execute function public.fn_organizacao_estado_so_pelo_servidor();

-- ── C0a. o turno de envio que sai sem rodar ─────────────────────────────────
-- O turno de envio de uma inscrição parada num nó `action` saiu sem ter rodado.
-- O evento diz isso ao motor, que enfileira um turno novo quando a organização
-- volta a operar (EVENTO_TURNO_DESCARTADO em lib/followup/node-handlers.ts).
-- Sem ele, os rechecks da reativação esgotavam o dead-man e matavam a inscrição
-- com `action_turn_never_completed` e um `followup_dead` de motivo falso. Duas
-- origens, uma regra: a C0 (turno `pending` falhado pela suspensão) e o worker
-- (turno que JÁ RODAVA na suspensão, com o envio barrado por
-- `OrgNaoOperanteError` — a C0 não toca `running`). A chave não termina em
-- `:<número>`: não conta como passo para fn_followup_job_current. Idempotente
-- pela chave; devolve se gravou. Sem guarda de status da org: a reativação
-- chama a C0 com a org já `active`.
create or replace function public.fn_followup_turno_descartado(p_org uuid, p_job uuid)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with gravado as (
    insert into public.followup_enrollment_events
      (organization_id, enrollment_id, node_id, event_type, payload, idempotency_key)
    select p_org, e.id, e.current_node_id, 'turn_discarded',
           jsonb_build_object('job_id', j.id, 'motivo', 'org_nao_operante'),
           coalesce(j.payload->>'source_step_key', j.id::text) || ':descartado'
      from public.job_queue j
      join public.followup_enrollments e
        on e.organization_id = p_org
       and e.id::text = j.payload->>'followup_enrollment_id'
       and e.current_node_id = j.payload->>'node_id'
       and e.status in ('active', 'waiting_reply', 'dormente')
     where j.id = p_job
       and j.organization_id = p_org
       and j.kind = 'followup_turn'
       and j.payload->>'purpose' = 'send_message'
    on conflict (enrollment_id, idempotency_key) where idempotency_key is not null do nothing
    returning 1
  )
  select exists (select 1 from gravado);
$$;

revoke execute on function public.fn_followup_turno_descartado(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_followup_turno_descartado(uuid, uuid) to service_role;

-- ── C0. a fila que a organização parada descarta ────────────────────────────
-- Falhar o job `pending` por fora não basta: o estado que dependia dele só é
-- assentado pelo acerto normal (fn_reply_settle, fn_meet_delivery_settle), que
-- nunca roda para um job que não saiu da fila. Sem isto, o rascunho aprovado
-- ficava 'aguardando envio' e o link do Meet nunca saía, sem aviso. Precedente:
-- fn_reply_redact, que falha job e rascunho juntos. Chamada pelas duas funções
-- de estado; nenhum papel a executa direto.
create or replace function public.fn_org_parada_descarta_fila(p_org uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_entregas    uuid[];
  v_turnos      uuid[];
  v_compromisso uuid;
begin
  with falhados as (
    update public.job_queue
       set status = 'failed', last_error = 'org_nao_operante'
     where organization_id = p_org and status = 'pending'
    returning id, kind, payload
  ),
  rascunhos as (
    update public.ai_reply_drafts d
       set status = 'failed', error_code = 'org_suspensa', updated_at = now()
      from falhados f
     where d.organization_id = p_org and d.send_job_id = f.id
       and f.kind = 'approved_reply' and d.status = 'approved'
    returning d.id
  )
  select coalesce(array_agg(f.id) filter (where f.kind = 'transactional_delivery'), '{}'),
         coalesce(array_agg(f.id) filter (where f.kind = 'followup_turn'), '{}')
    into v_entregas, v_turnos
    from falhados f;

  -- O turno de envio que saiu da fila sem rodar avisa o motor (C0a).
  perform public.fn_followup_turno_descartado(p_org, t.id) from unnest(v_turnos) as t(id);

  for v_compromisso in
    update public.calendar_appointments a
       set meeting_delivery = a.meeting_delivery
             || jsonb_build_object('state', 'failed', 'error', 'org_suspensa', 'settled_at', now())
     where a.organization_id = p_org
       and a.meeting_delivery_job_id = any(v_entregas)
    returning a.id
  loop
    perform public.fn_meet_notice(p_org, v_compromisso, 'failed');
  end loop;
end;
$$;

revoke execute on function public.fn_org_parada_descarta_fila(uuid) from public, anon, authenticated, service_role;

-- ── C. fn_suspender_organizacao: uma transação, fila parada ──────────────────
-- Conserta a rota que lia, gravava e emitia o evento sem await em três passos.
-- `failed` e não `dead` nos jobs: é o terminal de veto (queue.ts); `dead` abre
-- aviso `job_dead`. A mensagem `queued` vira `failed` para o redrive não a
-- mandar quando alguém olhar de novo. Suspensão com tipo NULO (imagem anterior
-- à 0501, depois de rollback) vale como administrativa.
create or replace function public.fn_suspender_organizacao(
  p_org uuid, p_kind text, p_motivo text, p_ator uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_kind   text;
begin
  if p_kind is null or p_kind not in ('administrativa', 'cobranca') then
    raise exception 'tipo_de_suspensao_invalido' using errcode = '22023';
  end if;

  select o.status, coalesce(o.suspended_kind, 'administrativa')
    into v_status, v_kind
    from public.organizations o
   where o.id = p_org
     for update;
  if not found then
    raise exception 'organization_not_found' using errcode = 'P0002';
  end if;

  if v_status = 'suspended' then
    if v_kind = p_kind then
      return jsonb_build_object('changed', false, 'motivo', 'ja_suspensa');
    end if;
    if p_kind = 'cobranca' then
      return jsonb_build_object('changed', false, 'motivo', 'administrativa_prevalece');
    end if;
    -- cobranca → administrativa: troca o tipo e mantém o início da suspensão.
    update public.organizations
       set suspended_kind = 'administrativa',
           suspended_reason = p_motivo,
           suspended_by = p_ator
     where id = p_org;
  elsif v_status = 'active' then
    update public.organizations
       set status = 'suspended',
           suspended_kind = p_kind,
           suspended_reason = p_motivo,
           suspended_at = now(),
           suspended_by = p_ator
     where id = p_org;
  else
    -- redacted / archived: inalterados, já não operam.
    return jsonb_build_object('changed', false, 'motivo', 'org_encerrada');
  end if;

  perform public.fn_org_parada_descarta_fila(p_org);

  update public.messages
     set status = 'failed', error_code = 'org_suspensa'
   where organization_id = p_org and status = 'queued';

  insert into public.event_log (organization_id, event_type, entity_kind, entity_id, payload)
  values (p_org, 'tenant.suspended', 'organization', p_org,
          jsonb_build_object('tenant_id', p_org, 'kind', p_kind,
                             'suspended_by', p_ator, 'reason', p_motivo));

  return jsonb_build_object('changed', true);
end;
$$;

revoke execute on function public.fn_suspender_organizacao(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_suspender_organizacao(uuid, text, text, uuid) to service_role;

-- ── D. agent_inbox_items.kind ganha 'org_reativada' ──────────────────────────
-- Lista COMPLETA do bloco único do baseline (kind-check-migration-x-baseline):
-- esta passa a ser a última migration que reconstrói a constraint.
alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;
alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'appointment_outcome_required','appointment_recovery_review','qr_rescan','routing_unassigned',
    'job_dead','event_dead','budget_exceeded','handoff','promotion_review','judge_unaligned',
    'followup_dead','snooze_expired','next_action_ambiguous','risk_backlog_seeded',
    'reactivation_expired','capabilities_missing','message_send_stuck','midia_nao_lida',
    'channel_template_review','channel_number_alert','promise_unfulfilled','contact_proposal_expired',
    'budget_warning','conhecimento_nao_indexado','voice_call_missed','case_stale',
    'aviso_de_caso_nao_entregue','followup_sem_agente','canal_mudo_sem_numero',
    'proposal_expired_notice','proposal_acceptance_rate_drop','proposal_promised_not_created',
    'proposta_travada',
    'proposta_pronta_para_revisao',
    -- (migration 0500) os dois avisos do Jev: entram aqui porque esta migration
    -- roda DEPOIS da 0500 e reconstrói a lista inteira — sem eles, a 0501 apagaria
    -- o vocabulário da 0500 (ou falharia com avisos do Jev já gravados).
    'jev_pedido_de_humano',
    'jev_parar_de_receber',
    -- a organização voltou de uma suspensão e há conversas para revisar.
    'org_reativada',
    'other'
  ));

-- ── E. fn_reativar_organizacao: volta sem rajada ─────────────────────────────
-- Exige o tipo: `/reactivate` desfaz só a administrativa; a de cobrança sai por
-- pagamento, prazo ou isenção (PR 2 em diante). Nada é reprocessado: jobs
-- `pending` que sobraram viram `failed`, e as conversas que receberam mensagem
-- durante a suspensão viram UM item na Central (sem referência) para uma
-- pessoa revisar.
create or replace function public.fn_reativar_organizacao(
  p_org uuid, p_kind_exigido text, p_ator uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status    text;
  v_kind      text;
  v_desde     timestamptz;
  v_conversas integer := 0;
begin
  if p_kind_exigido is null or p_kind_exigido not in ('administrativa', 'cobranca') then
    raise exception 'tipo_de_suspensao_invalido' using errcode = '22023';
  end if;

  select o.status, coalesce(o.suspended_kind, 'administrativa'), o.suspended_at
    into v_status, v_kind, v_desde
    from public.organizations o
   where o.id = p_org
     for update;
  if not found then
    raise exception 'organization_not_found' using errcode = 'P0002';
  end if;

  if v_status <> 'suspended' then
    return jsonb_build_object('changed', false, 'motivo', 'nao_suspensa');
  end if;
  if v_kind <> p_kind_exigido then
    return jsonb_build_object('changed', false, 'motivo',
      case v_kind when 'cobranca' then 'suspensao_de_cobranca' else 'suspensao_administrativa' end);
  end if;

  update public.organizations
     set status = 'active',
         suspended_kind = null,
         suspended_at = null,
         suspended_reason = null,
         suspended_by = null
   where id = p_org;

  perform public.fn_org_parada_descarta_fila(p_org);

  if v_desde is not null then
    select count(*) into v_conversas
      from public.conversations c
     where c.organization_id = p_org
       and not c.is_group
       and c.last_inbound_at >= v_desde;
  end if;

  if v_conversas > 0 then
    insert into public.agent_inbox_items (organization_id, kind, severity, title, body)
    values (p_org, 'org_reativada', 'warn',
            'A conta foi reativada — há conversas para revisar',
            -- Só o fato: o que fazer é a orientação do aviso na tela
            -- (lib/ai/inbox-destino.ts, org_reativada), que sabe das abas.
            case when v_conversas = 1
              then '1 conversa recebeu mensagem enquanto a conta estava suspensa.'
              else format('%s conversas receberam mensagem enquanto a conta estava suspensa.', v_conversas)
            end);
  end if;

  insert into public.event_log (organization_id, event_type, entity_kind, entity_id, payload)
  values (p_org, 'tenant.reactivated', 'organization', p_org,
          jsonb_build_object('tenant_id', p_org, 'kind', v_kind,
                             'reactivated_by', p_ator, 'conversas_com_mensagem', v_conversas));

  return jsonb_build_object('changed', true);
end;
$$;

revoke execute on function public.fn_reativar_organizacao(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_reativar_organizacao(uuid, text, uuid) to service_role;

-- ── F. o claim do follow-up não vê a organização parada ──────────────────────
-- Sem isto o motor seguia avançando fluxos da org suspensa, enfileirava turnos e
-- pagava o LLM de classificação. Definição VIGENTE da 0308 (espera longa dorme),
-- copiada do baseline, com UMA mudança: a CTE `orgs` só aceita organização
-- `active` (a régua de fn_org_operante, escrita como `exists` para o planner).
-- A inscrição da org parada não é tocada — nem o lease —, e volta ao rodízio na
-- reativação. Revoke e grant iguais aos da 0308.
create or replace function fn_claim_due_followup_enrollments(p_limit int, p_lease_seconds int)
returns setof followup_enrollments
language sql
security definer
set search_path = public
as $$
  with orgs as (
    -- Sem a condição de claim aqui de propósito: o lateral abaixo a aplica, e uma
    -- organização cujos vencidos estão todos com lease apenas devolve zero linhas.
    select distinct organization_id
      from followup_enrollments
     where status in ('active','waiting_reply','dormente')
       and next_eval_at <= now()
       -- Organização parada (suspensa, redigida, arquivada) não roda follow-up
       -- (migration 0501).
       and exists (select 1 from public.organizations o
                    where o.id = followup_enrollments.organization_id
                      and o.status = 'active')
  ),
  fila as (
    select f.id, f.next_eval_at, f.posicao_na_org
      from orgs
      cross join lateral (
        select d.id,
               d.next_eval_at,
               row_number() over (order by d.next_eval_at) as posicao_na_org
          from followup_enrollments d
         where d.organization_id = orgs.organization_id
           and d.status in ('active','waiting_reply','dormente')
           and d.next_eval_at <= now()
           and (d.claimed_until is null or d.claimed_until < now())
         order by d.next_eval_at
         limit p_limit
      ) f
  ),
  escolhidos as (
    -- O rodízio: posição 1 de todas as organizações, depois a 2 de todas, etc.
    -- Empate na mesma posição vai para quem esperou mais.
    select id from fila order by posicao_na_org, next_eval_at limit p_limit
  ),
  travados as (
    select e.id from followup_enrollments e
     where e.id in (select id from escolhidos)
     for update skip locked
  )
  update followup_enrollments e
     set claimed_until = now() + make_interval(secs => p_lease_seconds),
         updated_at = now()
   where e.id in (select id from travados)
     -- A condição de lease É REPETIDA AQUI, e não é redundante com a CTE `fila`.
     -- Sem ela, duas conexões simultâneas reclamam as MESMAS linhas: a segunda
     -- espera o lock da primeira, e quando ele sai o Postgres (READ COMMITTED)
     -- reavalia só o WHERE do UPDATE — que não olhava `claimed_until` — e grava
     -- por cima. O `skip locked` da CTE não salva: as duas materializam a mesma
     -- lista antes de qualquer lock existir. Medido: interseção de 5 em 5 no
     -- invariante de concorrência (followup-schema.test.ts).
     and (e.claimed_until is null or e.claimed_until < now())
  returning e.*;
$$;

revoke execute on function fn_claim_due_followup_enrollments(int, int) from public, anon, authenticated;
grant execute on function fn_claim_due_followup_enrollments(int, int) to service_role;

-- ── G. o evento turn_discarded é só do servidor ──────────────────────────────
-- A C0 grava `turn_discarded` para o motor enfileirar um turno novo na
-- reativação. A policy `followup_enrollment_events_insert` (0490) deixa
-- `manager` inserir pela sessão, e a chave `…:descartado` não termina em
-- `:<n>`: sem isto, um manager forjava o evento pelo PostgREST e o motor
-- enfileirava um 2º turno de envio. Definição VIGENTE da 0488 com UMA mudança:
-- o ramo da trilha também recusa `event_type = 'turn_discarded'` quando há
-- `auth.uid()`. O servidor (service_role, funções de estado) não tem
-- `auth.uid()` e segue gravando.
create or replace function public.fn_followup_generation_write()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 -- #1862 — DELETE que chega em CASCATA não é escrita de follow-up. Este gatilho
 -- é BEFORE ROW: o DELETE vindo de `on delete cascade` roda sob o gatilho da
 -- chave estrangeira, com `pg_trigger_depth() > 1`. Passa QUALQUER cascata, não
 -- só a da ficha: apagar o contato, a inscrição (followup_enrollments), o fluxo
 -- (followup_flow_pointers) ou a organização leva junto os registros internos.
 -- O turno que sobra sem inscrição/evento falha fechado em
 -- fn_followup_job_current. A profundidade não distingue cascata de DELETE
 -- feito por outro gatilho: hoje nenhum gatilho apaga nestas duas tabelas, e
 -- quem criar um herda esta passagem. O DELETE DIRETO (profundidade 1, com
 -- `auth.uid()`) continua caindo na recusa abaixo — a 42501 não afrouxa.
 if tg_op='DELETE' and pg_trigger_depth()>1 then return old; end if;
 if tg_table_name='job_queue' then
  if auth.uid() is not null and ((tg_op<>'DELETE' and new.kind='followup_turn') or (tg_op<>'INSERT' and old.kind='followup_turn')) then
   raise exception 'followup_job_internal' using errcode='42501';
  end if;
  if tg_op='UPDATE' and old.kind='followup_turn' then
   if new.organization_id<>old.organization_id or new.contact_id is distinct from old.contact_id or new.kind<>old.kind
    or new.payload->'followup_enrollment_id' is distinct from old.payload->'followup_enrollment_id'
    or new.payload->'node_id' is distinct from old.payload->'node_id'
    or new.payload->'source_step_key' is distinct from old.payload->'source_step_key'
   then raise exception 'followup_job_origin_immutable' using errcode='42501'; end if;
  end if;
 elsif auth.uid() is not null and (
   (tg_op<>'DELETE' and (new.idempotency_key ~ ':[0-9]+$' or new.event_type='turn_discarded'))
   or (tg_op<>'INSERT' and (old.idempotency_key ~ ':[0-9]+$' or old.event_type='turn_discarded'))) then
  raise exception 'followup_step_internal' using errcode='42501';
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end; $$;

revoke all on function public.fn_followup_generation_write() from public,anon,authenticated;
