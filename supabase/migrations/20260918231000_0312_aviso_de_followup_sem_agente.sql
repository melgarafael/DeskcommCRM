-- Um aviso novo na Central: `followup_sem_agente` — o fluxo publicado que nunca
-- vai disparar.
--
-- POR QUE: um gatilho AUTOMÁTICO de follow-up (silêncio, etapa do funil, caso
-- aberto, falta a compromisso) só cria inscrição se algum agente PUBLICADO da
-- organização tem o ponteiro em `followup.flow_pointer_ids` — a regra está em
-- `lib/followup/agent-followup-gate.ts`, e a recuperação de falta repete a mesma
-- condição dentro de `fn_appointment_recover`. Faltando esse vínculo, os
-- produtores saem por `pointers_armados = 0` **em silêncio**: o fluxo aparece
-- `active` na tela, com versão publicada, e nenhum paciente é reengajado. Não há
-- erro, não há log que alguém leia, não há linha em tabela nenhuma.
--
-- É o invariante 6 do Sistema Vivo (`docs/doctrine/sistema-vivo.md`) — o `return`
-- mudo em cima de estado configurável — e ficou mais fácil de cair agora que a
-- galeria de modelos (`lib/followup/modelos/`) deixa qualquer pessoa instalar um
-- fluxo em dois cliques sem passar pelo agente.
--
-- ⚠️ O CHECK É RECRIADO INTEIRO, e não estendido: `add constraint` não é
-- idempotente (42710 na segunda aplicação) e não existe `alter constraint ...
-- add value` para CHECK. Mesmo formato da 0233 e da 0242, e é o que faz o
-- `update.sh` de um clone reaplicar sem quebrar.
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
    'case_stale',
    -- O novo. `ref_kind='followup_flow'`, `ref_id` = o id do ponteiro.
    'followup_sem_agente',
    'other'
  ));

-- O índice que o watcher consulta duas vezes por rodada: "existe aviso ABERTO
-- para este fluxo?" — para não abrir o segundo, e para FECHAR o aberto quando o
-- vínculo com o agente aparece. Parcial em `status='open'` porque é o único
-- estado que ele pergunta.
create index if not exists agent_inbox_items_followup_sem_agente_aberto_idx
  on public.agent_inbox_items (organization_id, ref_id)
  where kind = 'followup_sem_agente' and status = 'open';
