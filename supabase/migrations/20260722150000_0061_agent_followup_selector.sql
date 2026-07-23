-- 0061 — Task 7.2 (sistema de follow-up): seletor de fluxo no editor do
-- agente. `ai_agent_versions` guarda config por COLUNA real (não um jsonb
-- único), o mesmo padrão de `trigger_config`/`handoff_keywords` já existentes
-- — então o campo novo é uma coluna jsonb própria, não um "widening" grátis
-- de um blob existente (achado ao ler o schema real antes de codar; a
-- suposição inicial do brief de "sem migration, é tudo jsonb" não bate com
-- este repo). `followup jsonb` = `{ enabled: boolean, flow_pointer_ids: uuid[] }`,
-- lido pelo dispatcher/reactivity da Onda 8 (gate: um gatilho AUTOMÁTICO de
-- follow-up só enrolla se algum agente PUBLICADO da org tiver o pointer
-- habilitado aqui — `lib/followup/agent-followup-gate.ts`).
--
-- `fn_ai_agent_version_content_immutable()` (migration 0051) precisa
-- conhecer a coluna nova — senão o campo followup de uma versão PUBLICADA
-- ficaria mutável por fora do contrato "conteúdo congelado fora de draft"
-- que o resto da tabela já respeita. Forward-fix via `create or replace`
-- (idempotente).
--
-- Idempotente; sem BEGIN/COMMIT; psql puro.

alter table ai_agent_versions
  add column if not exists followup jsonb not null default '{"enabled": false, "flow_pointer_ids": []}'::jsonb;

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
    or new.followup               is distinct from old.followup
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

-- Espelha o baseline: re-assenta o trigger idempotentemente (aponta pra mesma
-- função pós-create-or-replace; no-op num banco que já o tem do 0051).
drop trigger if exists trg_ai_agent_versions_content_immutable on public.ai_agent_versions;
create trigger trg_ai_agent_versions_content_immutable
  before update on public.ai_agent_versions
  for each row execute function fn_ai_agent_version_content_immutable();
