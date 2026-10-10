-- 0339 — o canal mudo tem aviso próprio na Central (doc 11, decisão B do dono)
--
-- O PROBLEMA. Um canal de WhatsApp nasce em modo de teste: a IA só responde
-- aos números que o operador autorizar. Isso é o certo — ninguém recebe
-- resposta automática por acidente durante a configuração. O defeito é o
-- ESQUECIMENTO, e o sintoma é o pior possível: as mensagens CHEGAM no Inbox,
-- tudo parece funcionar, e a IA nunca responde. Quem instalou conclui que o
-- produto está quebrado, não que falta um clique.
--
-- O QUE ESTA MIGRATION FAZ. Só abre vocabulário: acrescenta
-- `canal_mudo_sem_numero` ao CHECK de `agent_inbox_items.kind`. Quem emite é o
-- cron `app/api/v1/cron/canal-mudo-watcher` (diário), que também FECHA o aviso
-- quando ele deixa de valer — canal que ganhou número, saiu do modo de teste ou
-- foi arquivado.
--
-- A LISTA VEM INTEIRA, de propósito. `add constraint` não soma valor: ele
-- substitui a constraint. Reconstruir com uma lista parcial apagaria os outros
-- kinds EM SILÊNCIO — sem erro de SQL, sem conflito de git, e o aviso de outra
-- feature passaria a ser recusado pelo banco num caminho fire-and-forget. A
-- lista abaixo foi derivada do `supabase/baseline.sql` no momento do commit.
--
-- Quem vigia isso é `tests/invariants/vocabulario-banco-x-typescript.test.ts`:
-- ele exige que o CHECK e o union `InboxKind` (lib/agent-engine/db/repository.ts)
-- digam EXATAMENTE a mesma coisa. Uma reconstrução que perca valor fica
-- vermelha lá, no CI de quem a fez.
--
-- Aditiva: só alarga o conjunto, então não há dado a corrigir antes.

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
    'followup_sem_agente',
    'canal_mudo_sem_numero',
    'other',
    'aviso_de_caso_nao_entregue'
));

notify pgrst, 'reload schema';
