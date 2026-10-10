-- 0475 — a Central avisa quando uma proposta rascunhada pela IA precisa de
-- revisão humana: falta confirmar o modelo sugerido (plano N1) ou falta
-- preço de catálogo (§4 da spec de modelos, item [4]-[5] — "abre o aviso
-- interno... acompanha a proposta até ter valor"). Nasce ao rascunhar
-- (lib/mcp/tools/propostas.ts) e se resolve sozinho quando as duas
-- pendências somem, ou quando a proposta é enviada ou descartada
-- (lib/propostas/aviso-de-revisao.ts).
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
    -- (migration 0466, D3) proposta presa em 'enviando' há mais de 5min — o
    -- mesmo padrão do 'message_send_stuck', cron próprio (proposta-travada).
    'proposta_travada',
    -- a IA rascunhou uma proposta e falta confirmar o modelo
    -- sugerido (plano N1) ou falta preço de catálogo — a Central acompanha
    -- até as duas pendências sumirem, ou até a proposta ser enviada/descartada.
    'proposta_pronta_para_revisao',
    'other'
  ));
