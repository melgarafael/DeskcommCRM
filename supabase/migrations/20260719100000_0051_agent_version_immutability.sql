-- 0051_agent_version_immutability — Fase 2B da fusão Vendaval.
--
-- ai_agent_versions passa a ser a fonte de config que o agent-engine LÊ POR
-- PONTEIRO no início de cada turno (published_version_id). Uma versão publicada
-- precisa ser imutável NO BANCO (não só por convenção de app): editar = criar
-- versão draft nova; rollback = revert (clona + publica). Mesmo princípio do
-- fn_agent_versions_immutable do harness (0050), adaptado ao lifecycle desta
-- tabela — o UPDATE de CONTEÚDO é vetado fora de status='draft'; as transições
-- de lifecycle (draft→published→superseded→archived + timestamps) continuam
-- livres (é o que o RPC fn_publish_ai_agent_version faz).
-- Idempotente; sem BEGIN/COMMIT; psql puro.

create or replace function fn_ai_agent_version_content_immutable() returns trigger
language plpgsql as $fn$
begin
  -- Conteúdo congelado fora de draft. Campos de lifecycle ficam de fora do
  -- veto de propósito: status/published_at/superseded_at mudam no publish.
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
