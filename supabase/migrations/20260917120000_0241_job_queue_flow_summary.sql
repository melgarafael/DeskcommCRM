-- 0241 · Job `flow_summary`: síntese do fluxo de atendimento por modelo.
--
-- ─── O que entra ────────────────────────────────────────────────────────────
-- A Fase 3 do fluxo robusto grava uma síntese DETERMINÍSTICA em
-- `followup_enrollments.completion_note` ao concluir. Este job enriquece essa
-- nota com um texto natural (o "passa-bastão" que o próximo passo da venda lê),
-- usando o modelo do ponto `flow_summary` (painel de provedores). O job é
-- enfileirado pela conclusão e escreve a nota SÓ em caso de sucesso — a nota
-- determinística fica como fallback.
--
-- `flow_summary` é um kind NOVO de `job_queue`, não um turno de agente: entra
-- nos DOIS CHECKs de vocabulário da tabela (`job_queue_kind_check` e
-- `job_queue_turn_needs_contact`, porque carrega `contact_id`).
--
-- Migration de vocabulário: NÃO recria constraints no baseline (o bloco único do
-- baseline já carrega a lista final — doutrina vigiada por
-- tests/unit/baseline-constraint-reconstruida.test.ts).

alter table job_queue drop constraint if exists job_queue_kind_check;
alter table job_queue add constraint job_queue_kind_check
  check (kind in ('inbound_turn','followup_turn','watchdog','flywheel','case_reply_turn','operator_turn','transactional_delivery','approved_reply','flow_summary'));

alter table job_queue drop constraint if exists job_queue_turn_needs_contact;
alter table job_queue add constraint job_queue_turn_needs_contact
  check ((kind in ('inbound_turn','followup_turn','case_reply_turn','operator_turn','transactional_delivery','approved_reply','flow_summary')) = (contact_id is not null));

notify pgrst, 'reload schema';
