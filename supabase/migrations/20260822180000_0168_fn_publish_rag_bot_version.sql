-- 0168_fn_publish_rag_bot_version
--
-- O editor de agente `rag_bot` (`components/ai/AgentEditor.tsx`, "caminho legado
-- pré-EPIC-13" segundo `app/app/ai/agents/[id]/page.tsx:71`) só grava o rascunho
-- em `ai_agents` — nunca cria nem publica uma linha em `ai_agent_versions`. O
-- runtime (`lib/agent-engine/agent/agent-config.ts`) lê `system_prompt`/
-- `provider`/`model` da versão apontada por `ai_agents.published_version_id`,
-- não do rascunho. Resultado medido: editar o prompt/modelo de um `rag_bot` pela
-- tela não tem NENHUM efeito — o agente segue respondendo com o que foi
-- publicado no bootstrap inicial, em silêncio, sem erro em lugar nenhum.
--
-- `fn_publish_ai_agent_version` (0024/0025/0026) não serve para este caminho:
-- exige `credential_id` não-nulo na versão e `channel_sessions.status = 'WORKING'`
-- — nenhum dos dois é como `rag_bot` opera (ele resolve credencial por
-- organização+provider em tempo de chamada, sem vínculo de versão, e não trava
-- publish num canal offline). Esta função é o par mínimo, específico do
-- `rag_bot`: reusa (copia) os campos "de infraestrutura" da versão publicada
-- atual (canal, ferramentas, orçamento de tokens, etc. — nenhum deles é editável
-- pelo `AgentEditor.tsx`) e só troca `system_prompt`/`provider`/`model`, estes
-- sim vindos do rascunho em `ai_agents`.
--
-- `provider` NUNCA é hardcoded (essa era exatamente a causa de um segundo bug
-- medido nesta sessão de triagem): resolve de `organizations.settings.llm.provider`,
-- o mesmo campo que `scripts/bootstrap-owner.ts` grava a partir do `AI_PROVIDER`
-- escolhido no instalador — default `'anthropic'` só quando a organização nunca
-- escolheu nada.
--
-- Exige que já exista uma versão publicada (bootstrap sempre cria a v1) — sem
-- isso não há de onde copiar canal/ferramentas/orçamento, e inventar esses
-- valores aqui seria pior que recusar.

create or replace function public.fn_publish_rag_bot_version(
  p_org_id uuid,
  p_agent_id uuid,
  p_created_by uuid default null
)
returns table (
  agent_id uuid,
  version_id uuid,
  previous_version_id uuid,
  published_at timestamptz
)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_agent record;
  v_old_version record;
  v_provider text;
  v_model_count integer;
  v_new_version_id uuid;
  v_new_version_number integer;
  v_published_at timestamptz := now();
begin
  -- Trava o agente e confere posse + tipo. `for update` evita duas publicações
  -- concorrentes pisarem uma na outra (mesmo padrão da 0024/0025/0026).
  select a.id, a.organization_id, a.kind, a.archived_at, a.published_version_id,
         a.system_prompt, a.model
    into v_agent
  from public.ai_agents a
  where a.id = p_agent_id
  for update;

  if not found then
    raise exception 'agent_not_found' using errcode = 'P0001';
  end if;
  if v_agent.organization_id <> p_org_id then
    raise exception 'agent_not_found' using errcode = 'P0001';
  end if;
  if v_agent.kind is distinct from 'rag_bot' then
    raise exception 'agent_kind_invalid' using errcode = 'P0001';
  end if;
  if v_agent.archived_at is not null then
    raise exception 'agent_archived' using errcode = 'P0001';
  end if;
  if v_agent.published_version_id is null then
    raise exception 'no_existing_version' using errcode = 'P0001';
  end if;

  -- Versão publicada atual: fonte dos campos de infraestrutura que o
  -- `AgentEditor.tsx` não edita (canal, ferramentas, janelas de histórico,
  -- orçamento). Travada pelo mesmo motivo do agente.
  select v.id, v.organization_id, v.agent_id, v.version_number, v.credential_id,
         v.tool_ids, v.trigger_config, v.channel_session_id, v.max_steps,
         v.token_budget, v.cost_budget_cents, v.history_message_window,
         v.history_token_window, v.handoff_keywords, v.handoff_tool_enabled,
         v.followup, v.multimodal_input, v.video_frames_enabled, v.split_messages,
         v.split_max_chars, v.cases_enabled, v.operator_enabled, v.operator_model,
         v.operator_tool_ids, v.pipeline_ids
    into v_old_version
  from public.ai_agent_versions v
  where v.id = v_agent.published_version_id
  for update;

  if not found or v_old_version.agent_id <> p_agent_id or v_old_version.organization_id <> p_org_id then
    raise exception 'version_not_found' using errcode = 'P0001';
  end if;

  select coalesce(o.settings #>> '{llm,provider}', 'anthropic')
    into v_provider
  from public.organizations o
  where o.id = p_org_id;

  if v_provider is null then
    raise exception 'org_not_found' using errcode = 'P0001';
  end if;

  -- Mesmo piso de sanidade da 0024/0025/0026: não publica modelo que o
  -- catálogo desta instalação não conhece (ou já marcou deprecated).
  select count(*)
    into v_model_count
  from public.ai_models m
  where m.provider = v_provider
    and m.model_id = v_agent.model
    and m.deprecated_at is null;

  if v_model_count = 0 then
    raise exception 'model_not_found' using errcode = 'P0001';
  end if;

  v_new_version_number := v_old_version.version_number + 1;

  update public.ai_agent_versions
     set status = 'superseded', superseded_at = v_published_at
   where id = v_old_version.id;

  insert into public.ai_agent_versions (
    organization_id, agent_id, version_number, system_prompt, provider, model,
    credential_id, tool_ids, trigger_config, channel_session_id, max_steps,
    token_budget, cost_budget_cents, history_message_window, history_token_window,
    handoff_keywords, handoff_tool_enabled, status, published_at, created_by,
    followup, multimodal_input, video_frames_enabled, split_messages, split_max_chars,
    cases_enabled, operator_enabled, operator_model, operator_tool_ids, pipeline_ids
  ) values (
    p_org_id, p_agent_id, v_new_version_number, v_agent.system_prompt, v_provider, v_agent.model,
    v_old_version.credential_id, v_old_version.tool_ids, v_old_version.trigger_config,
    v_old_version.channel_session_id, v_old_version.max_steps,
    v_old_version.token_budget, v_old_version.cost_budget_cents,
    v_old_version.history_message_window, v_old_version.history_token_window,
    v_old_version.handoff_keywords, v_old_version.handoff_tool_enabled,
    'published', v_published_at, p_created_by,
    v_old_version.followup, v_old_version.multimodal_input, v_old_version.video_frames_enabled,
    v_old_version.split_messages, v_old_version.split_max_chars,
    v_old_version.cases_enabled, v_old_version.operator_enabled, v_old_version.operator_model,
    v_old_version.operator_tool_ids, v_old_version.pipeline_ids
  )
  returning id into v_new_version_id;

  update public.ai_agents
     set published_version_id = v_new_version_id,
         updated_at = v_published_at
   where id = p_agent_id;

  return query
    select p_agent_id, v_new_version_id, v_old_version.id, v_published_at;
end;
$$;

comment on function public.fn_publish_rag_bot_version(uuid, uuid, uuid) is
  'Publica o rascunho de um agente rag_bot (system_prompt/model) copiando os campos de infraestrutura da versão publicada atual. Ver comentário no topo da migration 0168 para o porquê de não reusar fn_publish_ai_agent_version.';

-- Função nova em public nasce exposta a `anon`/`authenticated` via
-- ALTER DEFAULT PRIVILEGES do baseline (origem A) e ao criar (origem B,
-- GRANT a PUBLIC implícito do Postgres) — as duas precisam ser fechadas
-- (doutrina de migrations, CLAUDE.md §"Função nova em public nasce EXPOSTA").
-- Só service_role chama esta função (sempre via createAdminClient() na action).
revoke execute on function public.fn_publish_rag_bot_version(uuid, uuid, uuid) from public, anon;
revoke execute on function public.fn_publish_rag_bot_version(uuid, uuid, uuid) from authenticated;
grant execute on function public.fn_publish_rag_bot_version(uuid, uuid, uuid) to service_role;
