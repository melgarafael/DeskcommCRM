-- ============================================================================
-- 2026-09-26 — 0426: OS AVISOS DO JEV NA CENTRAL (onda 3 do Jev, bloco 3.2)
--
-- O Jev percebe, onde a regra de hoje não viu nada, dois pedidos do cliente:
-- falar com uma pessoa, e parar de receber mensagens. Quando a empresa escolhe
-- "Avisar a equipe" numa dessas tarefas, ele abre UM aviso na Central por
-- conversa e pedido — e só isso: nunca passa a conversa, nunca cala o agente,
-- nunca bloqueia o contato, nunca responde o cliente. Quem passa e quem bloqueia
-- continua sendo a regra de hoje, ou uma pessoa.
--
-- O QUE ESTA MIGRATION FAZ, em duas partes:
--
-- 1. Abre vocabulário: `jev_pedido_de_humano` e `jev_parar_de_receber` no CHECK
--    de `agent_inbox_items.kind`. Um kind por pedido, e não `other`: a Central
--    dá rótulo e destino por kind (lib/ai/inbox-destino.ts) e o `other` não leva
--    a uma conversa. A LISTA VEM INTEIRA, derivada do `supabase/baseline.sql`
--    no momento do commit: `add constraint` substitui, e uma lista parcial
--    apagaria o aviso de outra feature em silêncio
--    (tests/unit/kind-check-migration-x-baseline.test.ts compara as duas).
--
-- 2. O aviso fecha sozinho quando uma pessoa assume a conversa ou ela é
--    encerrada. O mecanismo já existia para o `routing_unassigned`: o gatilho
--    `trg_routing_assignment_changed` (0228), em `conversations`. A função dele
--    ganha um `update` a mais, na MESMA condição — o resto do corpo é o de
--    antes. Enquanto a pessoa não assume, o aviso fica aberto; o "Marcar
--    resolvido" da Central continua valendo.
--
-- O dedupe (um aberto por conversa e pedido) é do gravador
-- (lib/ai/decisao/pedidos.ts), por busca antes da escrita, como os outros
-- avisos por conversa: um índice único aqui quebraria o "Reabrir" de um aviso
-- resolvido quando outro já está aberto (lib/agent-engine/db/repository.ts,
-- `insertInboxItem`, declara a mesma escolha).
--
-- Aditiva: só alarga o conjunto (nada a corrigir antes) e troca o corpo de uma
-- função existente. Idempotente. A função continua revogada de public, anon e
-- authenticated — é de gatilho, ninguém a chama.
-- ============================================================================

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
    'jev_pedido_de_humano',
    'jev_parar_de_receber',
    'other'
));

create or replace function public.fn_routing_assignment_changed()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.assigned_to_user_id is not null or new.status not in('open','pending','claimed','ai_handling') then
  update public.agent_inbox_items set status='resolved' where organization_id=new.organization_id
   and kind='routing_unassigned' and ref_id=new.id and status<>'resolved';
  update public.agent_inbox_items set status='resolved',resolved_at=now() where organization_id=new.organization_id
   and kind in('jev_pedido_de_humano','jev_parar_de_receber') and ref_kind='conversation' and ref_id=new.id
   and status<>'resolved';
 elsif old.assigned_to_user_id is not null or old.status not in('open','pending','claimed','ai_handling') then
  perform public.fn_request_channel_routing(new.organization_id,new.id);
 end if;
 return new;
end;
$$;
revoke all on function public.fn_routing_assignment_changed() from public,anon,authenticated;

notify pgrst, 'reload schema';
