-- manifest: **O retorno combinado descartado passa a ter aviso na Central — kind `followup_descartado` (issue #4696).** `descartarFollowupObsoleto` (`lib/atendimento/descartar-followup-obsoleto.ts`) encerra o job `followup_turn` com `service_boundary_stale` quando o atendimento muda antes do disparo; o descarte está CERTO (mandar a mensagem escreveria ao cliente em nome de um atendimento que já não existe), mas era silencioso: 11 em 17 dias, um deles com o cliente esperando um contato que nunca sairia. O kind novo entra no bloco ÚNICO do `agent_inbox_items_kind_check` (antes de `other`) e o aviso nasce com `ref_kind='conversation'`, dedup por (kind, conversa) em `insertInboxItem` — sem índice parcial porque o único escritor é o worker e a fila serializa um job por contato (`uniq_job_queue_one_running_per_contact`), o mesmo motivo que deixa `promise_unfulfilled` e `handoff` sem índice. A linha do tempo do contato usa o vocabulário aberto de `crm_lead_activities` (`followup_discarded`), que não tem CHECK. Aditiva e idempotente; espelhada no bloco do `baseline.sql`. Gate: `tests/invariants/aviso-do-retorno-descartado.test.ts`.
-- 9397: o retorno combinado que não sai passa a contar (issue #4696).
--
-- A fronteira de serviço continua decidindo o mesmo: atendimento que mudou não
-- recebe mensagem. O que muda é o SILÊNCIO. Do lado de lá existe uma pessoa que
-- ouviu "te chamo às 15h"; do lado de cá o job aparecia como `failed` com
-- `service_boundary_stale` e nenhuma tela dizia nada.
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
    'followup_descartado',
    'other'
  ));
end;
$$;

notify pgrst, 'reload schema';
