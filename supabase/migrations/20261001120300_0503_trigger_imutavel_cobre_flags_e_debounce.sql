-- ═══ A trava de imutabilidade da versão publicada passa a cobrir as duas
-- colunas que ficaram de fora (0503, issue #2003) ═══
--
-- `fn_ai_agent_version_content_immutable` impede um UPDATE de conteúdo numa
-- versão que já não é `draft` (a camada da app devolve 409; esta é a segunda
-- cerca, defense-in-depth, aberta para a service key). A lista de colunas é
-- escrita à mão e, desde o último `create or replace` (que cobria
-- `knowledge_source_ids`), ficaram DE FORA:
--
--   * `proposal_ai_draft_enabled` — flag por-agente que a tela edita
--     (`app/app/ai/agents/[id]/_components/AgentForm.tsx`), inimputável numa
--     versão publicada por um caminho que esqueça o 409;
--   * `inbound_debounce_ms` — coluna da migration 0498 (PR #1997, issue #1856):
--     a janela de rajada por agente. Ligar/desligar a coalescência de uma
--     versão JÁ publicada, sem virar versão draft nova, muda o comportamento
--     do atendimento em produção sem trilha.
--
-- A lista agora cobre TODAS as colunas de conteúdo da tabela. O invariante
-- `tests/unit/trigger-imutavel-cobre-todas-as-colunas-de-conteudo.test.ts`
-- compara a lista da trigger (a ÚLTIMA definição que vale, no baseline) contra
-- o conjunto de conteúdo, para a próxima coluna não repetir o esquecimento.
--
-- Idempotente por construção (`create or replace`, `drop ... if exists` antes
-- do `create` do trigger): quem já aplicou esta migration roda o apêndice do baseline
-- de novo e o trigger recria sem 'already exists'.

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
    or new.proposal_ai_draft_enabled is distinct from old.proposal_ai_draft_enabled
    or new.inbound_debounce_ms    is distinct from old.inbound_debounce_ms
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

drop trigger if exists trg_ai_agent_versions_content_immutable on public.ai_agent_versions;
create trigger trg_ai_agent_versions_content_immutable
  before update on public.ai_agent_versions
  for each row execute function fn_ai_agent_version_content_immutable();

notify pgrst, 'reload schema';