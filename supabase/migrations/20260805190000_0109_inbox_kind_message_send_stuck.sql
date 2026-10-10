-- 0109: agent_inbox_items.kind ganha 'message_send_stuck'
--
-- Issue #129. Uma mensagem outbound nasce com `status='sending'` e só sai desse
-- estado quando quem envia confirma. Quando o envio nunca acontece — worker
-- caído, evento sem consumidor, sessão do canal fora do ar — a linha fica
-- `sending` PARA SEMPRE, e o self-hoster vê no inbox uma mensagem eternamente
-- "enviando": um sinal de progresso para algo que não vai acontecer.
--
-- Num produto que a pessoa instala sozinha numa VPS não há ninguém olhando: ela
-- conclui que o produto é lento, não que está quebrado, e não abre issue. Por
-- isso o conserto não é só marcar `failed` — é fazer o defeito APARECER na
-- Central de avisos, que é onde o dono do negócio olha.
--
-- Idempotente: a lista de kinds só cresce, nenhuma linha existente viola a
-- constraint nova.

alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'qr_rescan',
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
    'other'
  ));

notify pgrst, 'reload schema';
