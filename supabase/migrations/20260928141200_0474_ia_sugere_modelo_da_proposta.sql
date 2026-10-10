-- 20260928013000_0474_ia_sugere_modelo_da_proposta.sql
-- 0474 — a IA sugere um modelo de proposta, uma pessoa confirma (decisão do
-- dono, 25/09/2026). `template_slug_sugerido` é ESTADO PROVISÓRIO: nunca
-- entra na constraint `crm_proposals_template_slug_versao_juntos_check`,
-- porque essa constraint é sobre o modelo CONFIRMADO (`template_slug` +
-- `template_version`), e uma sugestão não confirmada não é um modelo em uso.
alter table public.crm_proposals add column if not exists template_slug_sugerido text;

comment on column public.crm_proposals.template_slug_sugerido is
  'Modelo que a IA sugeriu ao rascunhar (crm_draft_proposal). Some quando alguém confirma um modelo (vira template_slug) ou troca por outro — nunca é o modelo "de fato".';
