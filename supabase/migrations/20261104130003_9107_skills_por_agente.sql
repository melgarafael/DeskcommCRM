-- manifest: **Skills por agente:** `ai_agent_versions.skill_names text[]` NULL (NULL = todas as skills da organização e da plataforma, o comportamento anterior; vazio = nenhuma; nomes = só estas). Sem default e sem CHECK: toda versão existente fica NULL e segue igual. `fn_ai_agent_version_content_immutable` passa a cobrir a coluna — corpo copiado da última definição em vigor (9101) mais a linha; sem ela uma versão publicada ficaria editável nesse campo. Idempotente; espelho no apêndice do `supabase/baseline.sql`, antes da VARREDURA anon (0116).
-- ============================================================================
-- 9107 — SKILLS POR AGENTE: `skill_names` por versão publicada.
--
-- Até aqui o índice de skills da organização inteira entrava em todo agente, e
-- o matcher injetava o corpo de skill de outro nicho (medido: uma skill de
-- clínica entrou seis vezes no agente de imóveis). A escolha é por VERSÃO,
-- como `knowledge_source_ids` (0181) e a voz (9052): restringir é ato explícito
-- na tela do agente, com trilha no histórico de versões.
--
-- NULL e não `default '{}'`: vazio significaria NENHUMA skill, e toda versão
-- existente perderia as skills em silêncio. NULL é "não escolheu" = todas.
--
-- Nenhuma função nova em `public` (só o `create or replace` do trigger, que já
-- existia), então não há revoke a fazer. O corpo abaixo é DERIVADO da última
-- definição em vigor no baseline (9101) mais a linha de `skill_names`: partir
-- de uma cópia velha apagaria as colunas que as migrations seguintes cobriram.
-- ============================================================================

alter table public.ai_agent_versions
  add column if not exists skill_names text[];

comment on column public.ai_agent_versions.skill_names is
  'Migration 9107. NULL = todas as skills da organização e da plataforma '
  '(o comportamento anterior, e o default de toda versão); vazio = nenhuma; '
  'nomes = só estas. Resolvido em lib/agent-engine/agent/skills.ts:skillsDoAgente.';

create or replace function fn_ai_agent_version_content_immutable() returns trigger
-- search_path fixo na PRÓPRIA definição: um create or replace sem a cláusula
-- apaga o alter function ... set search_path da 0521 (invariante
-- tests/invariants/avisos-do-security-advisor.test.ts).
language plpgsql set search_path = '' as $fn$
begin
  if old.status <> 'draft' and (
       new.system_prompt          is distinct from old.system_prompt
    or new.provider               is distinct from old.provider
    or new.model                  is distinct from old.model
    or new.credential_id          is distinct from old.credential_id
    or new.tool_ids               is distinct from old.tool_ids
    or new.trigger_config         is distinct from old.trigger_config
    or new.channel_session_id     is distinct from old.channel_session_id
    or new.max_steps              is distinct from old.max_steps
    or new.token_budget           is distinct from old.token_budget
    or new.cost_budget_cents      is distinct from old.cost_budget_cents
    or new.history_message_window is distinct from old.history_message_window
    or new.history_token_window   is distinct from old.history_token_window
    or new.handoff_keywords       is distinct from old.handoff_keywords
    or new.handoff_tool_enabled   is distinct from old.handoff_tool_enabled
    or new.handoff_legal_enabled  is distinct from old.handoff_legal_enabled
    or new.followup               is distinct from old.followup
    or new.multimodal_input       is distinct from old.multimodal_input
    or new.video_frames_enabled   is distinct from old.video_frames_enabled
    or new.split_messages         is distinct from old.split_messages
    or new.split_max_chars        is distinct from old.split_max_chars
    or new.cases_enabled          is distinct from old.cases_enabled
    or new.operator_enabled       is distinct from old.operator_enabled
    or new.operator_model         is distinct from old.operator_model
    or new.operator_tool_ids      is distinct from old.operator_tool_ids
    or new.pipeline_ids           is distinct from old.pipeline_ids
    or new.knowledge_source_ids   is distinct from old.knowledge_source_ids
    or new.skill_names            is distinct from old.skill_names
    or new.proposal_ai_draft_enabled is distinct from old.proposal_ai_draft_enabled
    or new.inbound_debounce_ms    is distinct from old.inbound_debounce_ms
    or new.reply_min_interval_ms  is distinct from old.reply_min_interval_ms
    or new.voz_enabled            is distinct from old.voz_enabled
    or new.voz_quando             is distinct from old.voz_quando
    or new.version_number         is distinct from old.version_number
    or new.agent_id               is distinct from old.agent_id
    or new.organization_id        is distinct from old.organization_id
  ) then
    raise exception 'ai_agent_versions % é imutável (status=%): mudança de conteúdo = versão draft nova; rollback = revert (clona + publica)',
      old.id, old.status;
  end if;
  return new;
end;
$fn$;
