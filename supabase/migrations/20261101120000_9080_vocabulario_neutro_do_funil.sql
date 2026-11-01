
-- manifest: o vocabulário padrão de funil novo deixa de ser o de e-commerce (Cliente/Pedido/Pago/Cancelado) e passa a ser neutro (Contato/Negócio/Ganho/Perdido); só o DEFAULT da coluna muda, nenhuma linha existente é reescrita (doc 249, resposta B).
--
-- 9080 — o card do funil se chama "Negócio" em instalação nova.
--
-- ─── O problema ─────────────────────────────────────────────────────────────
--
-- O DEFAULT de `crm_pipelines.vocabulary` era o de uma loja. Todo funil que
-- nasce sem a coluna herda esse default: o semeado pelo gatilho
-- `trg_seed_default_pipeline_for_org`, o que o onboarding troca por outro ramo
-- (`fn_aplicar_quadro_do_onboarding` muda nome e etapas, não o vocabulário) e o
-- criado por `POST /api/v1/pipelines`. Medido numa instalação nova de clínica:
-- o quadro "Agendamentos" dizia "1 Pedido selecionado" e "Excluir 1 Pedido?".
--
-- ─── A decisão ──────────────────────────────────────────────────────────────
--
-- Doc 249, resposta B (31/10): o card do funil se chama "Negócio" em tudo. As
-- chaves são as MESMAS do default anterior; só os valores ficam neutros.
--
-- ─── O que NÃO faz ──────────────────────────────────────────────────────────
--
-- Não há UPDATE: quem já instalou continua com os nomes que tem — inclusive
-- quem os escolheu de propósito, que não se distingue de quem herdou o default.
-- Trocar é uma ação na tela (Configurações › Funis), não desta migration.
--
-- Idempotente: `set default` reaplicado grava o mesmo valor.

alter table public.crm_pipelines
  alter column vocabulary set default jsonb_build_object(
    'lead', 'Contato', 'lead_plural', 'Contatos',
    'deal', 'Negócio', 'deal_plural', 'Negócios',
    'won', 'Ganho', 'lost', 'Perdido',
    'stage', 'Etapa', 'stage_plural', 'Etapas'
  );
