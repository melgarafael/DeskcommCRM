-- manifest: **Aviso de status do modelo no canal oficial direto (#3635, fatia 3).** `agent_inbox_items_kind_check` ganha `channel_template_review_direct` no bloco único do baseline: quando a Meta aprova, reprova, pausa ou desativa um modelo, o webhook do canal direto (`app/api/v1/webhooks/meta/[token]/route.ts`) atualizava o espelho em `meta_templates` e calava — exatamente o buraco que o canal de parceiro já tinha fechado com `channel_template_review`. O aviso nasce com `ref_kind='channel_session'` + `ref_id` da conexão (escopo por CONEXÃO, não por organização: dois números da mesma empresa podem ter modelos homônimos) e o kind é próprio porque o destino e o rótulo do de parceiro apontam para a aba do parceiro. Sem coluna nova, sem índice novo: a trava de "já avisado" é a consulta de item aberto por (org, kind, ref, título), do jeito que o canal de parceiro já faz. Gates: `tests/unit/kind-check-migration-x-baseline.test.ts`, `tests/unit/baseline-constraint-reconstruida.test.ts`, `tests/invariants/vocabulario-banco-x-typescript.test.ts`, `tests/unit/aviso-de-modelo-no-canal-direto.test.ts`.

-- O vocabulário do CHECK é o único objeto tocado: nenhuma coluna, nenhum
-- índice. `channel_template_review_direct` entra NESTA lista (a última
-- migration que reconstrói a constraint, igual ao bloco único do baseline)
-- pelas razões de sempre: kind que só existe no banco faz o INSERT do aviso
-- violar a constraint e o `catch` do webhook engolir em silêncio — o operador
-- simplesmente nunca vê o aviso.

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
    'other'
  ));
