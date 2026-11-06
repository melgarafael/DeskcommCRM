-- manifest: quando a Meta aprova, reprova, pausa ou desativa um modelo do canal oficial direto, o operador passa a saber pela Central — kind `channel_template_review_direct`, um aviso aberto por conexão+modelo+desfecho (índice único parcial, ref_kind `channel_session`), em vez do espelho atualizar em silêncio (#3635, fatia 3; o canal de parceiro já avisava).
--
-- ─── O que estava invisível ────────────────────────────────────────────────
--
-- A Meta revisa a definição DEPOIS da criação. O webhook atualizava só
-- `meta_templates.status`/`rejected_reason`; quem não abrisse a tela de modelos
-- descobria a reprovação no disparo que não saiu. O canal de parceiro
-- (`lib/channels/zernio/avisos.ts`) já abria aviso na Central; o canal oficial
-- direto não. Este é o kind próprio dele.
--
-- ─── Por que um kind NOVO, e não o `channel_template_review` ───────────────
--
-- A Central dá rótulo e destino por kind (`lib/ai/inbox-destino.ts`). O kind do
-- parceiro aponta para a aba do PARCEIRO; reusá-lo mandaria quem opera o canal
-- oficial para a tela errada. Kind próprio é o que permite o aviso nascer
-- sempre com `ref_kind = 'channel_session'` — duas conexões da mesma empresa
-- podem ter modelos de mesmo nome, e o aviso de uma não pode vazar para a outra.
--
-- ─── Idempotência é do BANCO ───────────────────────────────────────────────
--
-- A Meta re-entrega webhook. A chave é a mesma família dos outros avisos com
-- referência: organização + kind + ref + título, com `status = 'open'`; o título
-- carrega modelo, idioma e desfecho. O índice único PARCIAL fecha a corrida que
-- o SELECT-antes-do-INSERT não fecha (precedente: 0491, 0500 e 9033), e o
-- gravador trata `23505` como "já aberto". Sem `status` na chave para não
-- guardar uma linha resolvida para sempre.
--
-- Aditiva e idempotente: a lista de kinds só CRESCE, e o índice é
-- `if not exists`. Nada a corrigir antes.

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
    -- (#3635, fatia 3) O canal oficial direto também avisa quando a Meta
    -- revisa um modelo. Entra no FIM da lista pelas razões de sempre: bloco
    -- único por constraint (#159) e a janela de 2000 caracteres que
    -- `tests/unit/midia-nao-lida.test.ts` varre a partir do `add constraint`.
    'channel_template_review_direct',
    'other'
  ));

-- Um aviso ABERTO por (organização, conexão, modelo+idioma+desfecho). O título
-- é a parte que distingue dois modelos de mesmo nome na mesma conexão; o
-- `ref_id` é a conexão e é o que impede o vazamento entre conexões da empresa.
-- Parcial em `status = 'open'`: resolvido o aviso, um novo evento pode abrir um
-- novo — sem isso a linha resolvida silenciaria o modelo para sempre.
create unique index if not exists agent_inbox_modelo_direto_aberto_unico
  on public.agent_inbox_items (organization_id, kind, ref_id, title)
  where status = 'open' and kind = 'channel_template_review_direct';

notify pgrst, 'reload schema';
