-- Um aviso novo na Central: `case_stale` — o caso que ninguém abriu há um dia.
--
-- POR QUE: um caso em `awaiting_human` é a IA esperando uma pessoa destravar
-- alguma coisa, com um cliente do outro lado. Nada no sistema avisava que ele
-- estava parado. Medido num CRM em produção com o mesmo desenho de fila: 22
-- pedidos esquecidos, o mais antigo há 17,6 dias, onze deles gente pedindo para
-- falar com uma pessoa — numa fila que era usada (72 de 102 resolvidos).
--
-- ⚠️ O CHECK É RECRIADO INTEIRO, e não estendido: `add constraint` não é
-- idempotente (42710 na segunda aplicação) e não existe `alter constraint ...
-- add value` para CHECK. O `drop ... if exists` + `add` é o mesmo formato que a
-- 0233 usou para acrescentar `voice_call_missed`, e é o que faz o `update.sh` de
-- um clone reaplicar sem quebrar.
--
-- Nenhum dado muda: nenhuma linha existente usa o valor novo, então não há
-- backfill nem risco de a constraint reprovar o que já está gravado.

alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check
  check (kind in (
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
    -- O novo. `ref_kind='agent_case'`, `ref_id` = o id do caso.
    'case_stale',
    'other'
  ));

-- O índice que o watcher consulta a cada rodada: "existe aviso ABERTO para este
-- caso?". Parcial em `status='open'` porque é o único estado que ele pergunta —
-- e porque avisos resolvidos são a maioria das linhas com o tempo.
create index if not exists agent_inbox_items_case_stale_aberto_idx
  on public.agent_inbox_items (organization_id, ref_id)
  where kind = 'case_stale' and status = 'open';
