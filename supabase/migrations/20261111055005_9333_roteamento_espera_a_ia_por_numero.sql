-- 9333_roteamento_espera_a_ia_por_numero — #3966, sobre o #4238 de @webtecnica.
--
-- manifest: **A conversa pode esperar a IA qualificar antes de ir para a fila — como OPÇÃO DO NÚMERO, desligada de fábrica, com prazo máximo (#3966; mecanismo do #4238 de @webtecnica, adaptado pela decisão do dono no doc 311).** Com rodízio ou carga, a conversa é distribuída no NASCIMENTO e a atribuição cala o agente de IA (`conversa_de_humano`). Coluna nova `channel_routing_policies.ai_wait_minutes` (nula = desligada; 15 a 10080 = liga a espera e é o prazo máximo dela), gravada por `fn_set_channel_ai_wait` com as mesmas guardas de `fn_set_channel_routing` (gestor, suporte com escrita, MFA provada). Com a opção ligada, o `routing-worker` guarda o pedido até o prazo em vez de distribuir, e `fn_routing_assignment_changed` passa a pedir o roteamento quando `last_handoff_at` muda — a passagem para humano traz a conversa de volta UMA vez (`fn_request_channel_routing` deduplica). O ramo novo do gatilho só é verdadeiro no número que ligou a opção: desligada, o gatilho decide como antes. Passado o prazo sem a IA passar a conversa, ela entra na distribuição e a Central recebe o kind novo `routing_ia_wait_expired` (constraint `agent_inbox_items_kind_check` reconstruída com o vocabulário completo do baseline). Gate: `tests/invariants/roteamento-espera-a-qualificacao.test.ts`.
--
-- ─── O defeito, medido por @webtecnica no #4238 ─────────────────────────────
--
-- Com rodízio/carga ligados, `trg_conversation_routing_requested` (AFTER INSERT
-- em conversations) emite `conversation.routing_requested` e o `routing-worker`
-- entrega a conversa a uma pessoa em menos de 1 min — antes de a IA qualificar.
-- A atribuição grava `assignee_kind = 'user'` e o gate da IA cala o agente com o
-- motivo `conversa_de_humano` (`lib/ai/elegibilidade/gate.ts`): a própria fila
-- desligava a IA que deveria qualificar.
--
-- ─── O que mudou em relação ao #4238 (doc 311, alternativa A) ───────────────
--
-- O #4238 fazia a espera valer para TODO número com agente publicado, sem chave
-- e sem prazo: se a IA nunca passasse a conversa, ela ficava sem dono e fora da
-- fila, sem aviso. Aqui:
--
--   · é opção DO NÚMERO, desligada de fábrica — uma coluna só, porque não existe
--     "esperar sem prazo": `ai_wait_minutes` nulo desliga, preenchido liga e é o
--     prazo;
--   · o pedido do nascimento NÃO morre consumido: o worker o reagenda para o
--     prazo (um reagendamento, não um por minuto). `last_handoff_at` continua
--     sendo o marcador durável de "a qualificação terminou" — gravado pelos dois
--     caminhos de passagem e limpo pelo `reactivate-bot` — e a mudança dele
--     traz `next_attempt_at` para agora;
--   · o gatilho só reemite no número que ligou a opção. Desligada, o ramo novo
--     é falso e nenhum pedido a mais nasce.
--
-- Idempotente: `add column if not exists`, constraint em bloco DO com
-- `if not exists`, `create or replace` e gatilho recriado. Espelho no
-- `baseline.sql`, antes da VARREDURA anon.

alter table public.channel_routing_policies add column if not exists ai_wait_minutes integer;
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'channel_routing_policies_ai_wait_minutes_check'
       and conrelid = 'public.channel_routing_policies'::regclass
  ) then
    alter table public.channel_routing_policies
      add constraint channel_routing_policies_ai_wait_minutes_check
      check (ai_wait_minutes is null or ai_wait_minutes between 15 and 10080);
  end if;
end;
$$;

create or replace function public.fn_set_channel_ai_wait(p_org uuid,p_channel uuid,p_minutes integer)
returns integer language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'manager') or not public.fn_support_write_allowed(p_org)
 then raise exception 'routing_forbidden' using errcode='42501';end if;
 if not public.fn_session_mfa_proven() then raise exception 'routing_mfa_required' using errcode='42501';end if;
 if p_minutes is not null and (p_minutes<15 or p_minutes>10080) then
  raise exception 'routing_invalid_ai_wait' using errcode='22023';end if;
 update public.channel_routing_policies set ai_wait_minutes=p_minutes,updated_at=now()
  where organization_id=p_org and channel_session_id=p_channel;
 if not found then raise exception 'routing_channel_not_found' using errcode='P0002';end if;
 -- Quem estava esperando com a regra antiga é reavaliado agora, com a nova.
 perform public.fn_wake_channel_routing(p_org,p_channel);
 return p_minutes;
end;
$$;
revoke all on function public.fn_set_channel_ai_wait(uuid,uuid,integer) from public,anon;
grant execute on function public.fn_set_channel_ai_wait(uuid,uuid,integer) to authenticated;

create or replace function public.fn_routing_assignment_changed()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.assigned_to_user_id is not null or new.status not in('open','pending','claimed','ai_handling') then
  update public.agent_inbox_items set status='resolved' where organization_id=new.organization_id
   and kind='routing_unassigned' and ref_id=new.id and status<>'resolved';
 elsif old.assigned_to_user_id is not null or old.status not in('open','pending','claimed','ai_handling')
    -- #3966: a PASSAGEM PARA HUMANO traz o pedido de volta, mas só no número
    -- que LIGOU a espera pela IA. Com a opção desligada este ramo é falso e o
    -- gatilho decide exatamente como antes.
    or (new.last_handoff_at is not null and new.last_handoff_at is distinct from old.last_handoff_at
        and exists(select 1 from public.channel_routing_policies p
                    where p.organization_id=new.organization_id
                      and p.channel_session_id=new.channel_session_id
                      and p.ai_wait_minutes is not null)) then
  perform public.fn_request_channel_routing(new.organization_id,new.id);
 end if;
 return new;
end;
$$;
revoke all on function public.fn_routing_assignment_changed() from public,anon,authenticated;

drop trigger if exists trg_routing_assignment_changed on public.conversations;
create trigger trg_routing_assignment_changed after update of assigned_to_user_id,status,last_handoff_at on public.conversations
 for each row execute function public.fn_routing_assignment_changed();

-- ─── o aviso do prazo vencido ───────────────────────────────────────────────
--
-- Vocabulário COMPLETO (igual ao bloco único do baseline, cerca
-- `kind-check-migration-x-baseline`): o kind novo entra antes de 'other'. Em
-- bloco DO para o drop e o add andarem juntos — soltos, um `update.sh` sem
-- ON_ERROR_STOP que falhasse no add deixaria a tabela sem guarda.
do $$
begin
  alter table public.agent_inbox_items
    drop constraint if exists agent_inbox_items_kind_check;
  alter table public.agent_inbox_items
    add constraint agent_inbox_items_kind_check check (kind in (
    'appointment_outcome_required',
    'appointment_recovery_review',
    'qr_rescan',
    'routing_unassigned',
    'job_dead',
    'event_dead',
    'budget_exceeded',
    'handoff',
    'promotion_review',
    'judge_unaligned',
    'followup_dead',
    'snooze_expired',
    'next_action_ambiguous',
    'risk_backlog_seeded',
    'reactivation_expired',
    'capabilities_missing',
    'message_send_stuck',
    'midia_nao_lida',
    'channel_template_review',
    'channel_number_alert',
    'promise_unfulfilled',
    'contact_proposal_expired',
    'budget_warning',
    'conhecimento_nao_indexado',
    'voice_call_missed',
    'case_stale',
    'aviso_de_caso_nao_entregue',
    'followup_sem_agente',
    'canal_mudo_sem_numero',
    'proposal_expired_notice',
    'proposal_acceptance_rate_drop',
    'proposal_promised_not_created',
    'proposta_travada',
    'proposta_pronta_para_revisao',
    'org_reativada',
    'jev_pedido_de_humano',
    'jev_parar_de_receber',
    'canal_pausado',
    'cobranca',
    'email_de_login_trocado',
    'task_due',
    'task_overdue',
    'recuperacao_da_queda',
    'cliente_sem_resposta_na_queda',
    'assinatura_desconectada',
    'channel_template_review_direct',
    'routing_ia_wait_expired',
    'other'
  ));
end;
$$;

notify pgrst, 'reload schema';
