-- 0169 — agent_inbox_items.kind ganha 'billing_subscription_pending' (ADR-0002)
--
-- A criação da assinatura Asaas no signup self-service pode falhar (rede,
-- chave errada) DEPOIS que a organização já foi criada — e a organização não
-- pode ficar travada esperando a Asaas responder no exato instante do
-- cadastro. Ela nasce `active` mesmo assim; este kind é o que torna a
-- assinatura pendente VISÍVEL na Central de avisos, em vez de um estado mudo
-- que só um dump de `organization_subscriptions` revelaria (invariante 4 do
-- Sistema Vivo: nenhuma demanda sem próximo passo).
--
-- RECONSTRÓI A CONSTRAINT INTEIRA, não acrescenta um bloco novo (doutrina da
-- issue #159, vigiada por tests/unit/baseline-constraint-reconstruida.test.ts
-- e tests/unit/kind-check-migration-x-baseline.test.ts): esta migration passa
-- a ser "a última que reconstrói agent_inbox_items_kind_check", e sua lista
-- precisa bater EXATAMENTE com a do apêndice do baseline.sql — nem um valor a
-- menos (silencia aviso de clone que aplica migrations em ordem) nem a mais.
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
    'midia_nao_lida',
    'channel_template_review',
    'channel_number_alert',
    'promise_unfulfilled',
    'contact_proposal_expired',
    'budget_warning',
    'billing_subscription_pending',
    'other'
  ));

notify pgrst, 'reload schema';
