-- 0053 — Épico Operação Visível (F3): rastro de aplicação de proposta do flywheel.
-- Uma flywheel_distiller_proposal aplicada vira uma ai_agent_version nova via o
-- fluxo publish-por-ponteiro existente (gate humano = o clique de aplicar). Estas
-- colunas registram O QUE foi aplicado, QUANDO, POR QUEM e em QUAL versão — sem
-- elas a UI não distingue proposta pendente de aplicada e o apply não é idempotente.
-- Idempotente: add column if not exists.

alter table flywheel_distiller_proposals
  add column if not exists applied_at timestamptz,
  add column if not exists applied_version_id uuid references ai_agent_versions(id) on delete set null,
  add column if not exists applied_by uuid;

comment on column flywheel_distiller_proposals.applied_at is
  'Operação Visível F3: quando a proposta foi aplicada como versão nova (null = pendente).';
comment on column flywheel_distiller_proposals.applied_version_id is
  'ai_agent_versions criada a partir desta proposta (publish por ponteiro).';
comment on column flywheel_distiller_proposals.applied_by is
  'auth user que clicou em aplicar (gate humano).';
