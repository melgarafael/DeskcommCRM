-- manifest: **Avisos de tarefa na Central (#2529).** `agent_inbox_items_kind_check` ganha `task_due` e `task_overdue` no bloco único do baseline (lista completa; esta passa a ser a última migration que a reconstrói): o cron `task-reminder` avisa o RESPONSÁVEL quando a tarefa está perto do vencimento (janela que a pessoa escolhe — 15 min, 1 h ou 1 dia) e quando ela vence sem conclusão; os dois nascem com `ref_kind='task'`, levando à lista de tarefas. As duas categorias têm preferência por PESSOA em `raw_user_meta_data.lembretes_de_tarefa` — o mesmo sítio do perfil, sem migration própria: o cron não lê `localStorage` de ninguém, e a escolha que a tela grava hoje por NAVEGADOR não decidesse nada com o site fechado. Repetição em vencida e WhatsApp para o número do responsável são opt-in e nascem desligados; sem opt-in ou sem sessão de canal da organização o cron NÃO TENTA WhatsApp (a guarda mora em `lib/tarefas/preferencia-de-lembrete.ts`, antes de qualquer consulta). Gates desta 0655: `tests/unit/kind-check-migration-x-baseline.test.ts`, `tests/unit/baseline-constraint-reconstruida.test.ts`, `tests/invariants/vocabulario-banco-x-typescript.test.ts`, `lib/ai/inbox-destino.test.ts`, `lib/tarefas/preferencia-de-lembrete.test.ts`, `app/api/v1/cron/task-reminder/route.test.ts`.

-- Os avisos de tarefa são da MESMA família dos que já estão nesta lista
-- (`proposal_promised_not_created` sinaliza uma tarefa vencida de proposta
-- prometida): o vocabulário do CHECK é o que os separa, e por isso ele é o
-- único objeto tocado aqui. Nenhuma coluna nova, nenhum índice: a trava de
-- "já avisado" é o próprio item aberto da Central, do jeito que o cron de
-- proposta prometida já faz.

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
    -- (migration 0655, issue #2529) A tarefa vencida só aparecia em vermelho
    -- para quem ABRIA a lista de tarefas: quem não abria perdia o prazo em
    -- silêncio. O cron `task-reminder` varre `crm_tasks` com prazo na janela e
    -- nasce com estes DOIS kinds — um por momento, e não um genérico: a
    -- Central dá rótulo e destino por kind, e "tarefa perto do vencimento" e
    -- "tarefa venceu sem conclusão" pedem leituras diferentes de quem abre.
    -- Nascem com `ref_kind='task'`, levando à lista de tarefas. Entra NESTA
    -- lista pelas razões de sempre (#159, bloco único por constraint; e a
    -- janela do `midia-nao-lida.test.ts`, que os valores novos têm de manter
    -- dentro dos primeiros 2000 caracteres após o `add constraint`).
    'task_due',
    'task_overdue',
    'other'
  ));
