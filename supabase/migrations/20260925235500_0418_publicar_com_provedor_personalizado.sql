-- ============================================================================
-- 2026-09-25 — 0418: PUBLICAR AGENTE COM O PROVEDOR PERSONALIZADO (#1642)
--
-- A 0413 trouxe o "Provedor personalizado (compatível com OpenAI)": cadastro,
-- teste, validação e turno do agente. Faltou a PUBLICAÇÃO. A
-- `fn_publish_ai_agent_version` só aceita o modelo que está no catálogo
-- `ai_models` com o mesmo `provider`, e ninguém escreve linha `custom` ali —
-- o catálogo é GLOBAL (sem `organization_id`) e o endpoint é de cada empresa,
-- então não há lista de modelos `custom` que valha para a instalação inteira.
-- Resultado medido numa VPS real: credencial `custom` validada, rascunho com
-- `qwen3:14b` (que o endpoint devolveu em `/models`) e todo "Publicar"
-- respondendo `model_not_found`. Nenhum agente com provedor personalizado
-- conseguia ser publicado.
--
-- O conserto: para `custom`, a fonte de verdade de "este modelo existe" é a
-- lista que o PRÓPRIO endpoint devolveu — `ai_provider_credentials.
-- models_available` da credencial da versão, que já passou pelas conferências
-- de organização, ativa e validada logo acima. Escrever os modelos em
-- `ai_models` foi recusado: o catálogo é da instalação, e o id que o endpoint
-- de uma empresa serve apareceria como opção para todas as outras.
--
-- `custom` sem credencial própria continua recusado (`model_not_found`): não
-- existe chave de plataforma para um endpoint de empresa. Os provedores
-- nativos seguem pela mesma consulta ao catálogo de sempre.
--
-- `create or replace` da versão de 5 argumentos, com a mesma assinatura e os
-- mesmos grants; as de 3 e 4 argumentos só delegam e não mudam. Idempotente.
-- ============================================================================

create or replace function public.fn_publish_ai_agent_version(
  p_org_id uuid,
  p_agent_id uuid,
  p_version_id uuid,
  p_platform_credential_verified boolean,
  p_expected_provenance text
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
  v_version record;
  v_credential record;
  v_session record;
  v_model_count integer;
  v_previous_version_id uuid;
  v_published_at timestamptz := now();
begin
  select a.id, a.organization_id, a.published_version_id, a.archived_at
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
  if v_agent.archived_at is not null then
    raise exception 'agent_archived' using errcode = 'P0001';
  end if;

  select v.id, v.organization_id, v.agent_id, v.status, v.provider, v.model,
         v.credential_id, v.channel_session_id, v.provisioning_origin
    into v_version
  from public.ai_agent_versions v
  where v.id = p_version_id
  for update;

  if not found then
    raise exception 'version_not_found' using errcode = 'P0001';
  end if;
  if v_version.agent_id <> p_agent_id or v_version.organization_id <> p_org_id then
    raise exception 'version_not_found' using errcode = 'P0001';
  end if;
  if p_expected_provenance is not null and (
    p_expected_provenance not in('onboarding','legacy_reconciliation') or
    v_version.provisioning_origin is distinct from p_expected_provenance or
    (select count(*) from public.ai_agent_versions own_version where own_version.organization_id=p_org_id and own_version.agent_id=p_agent_id)<>1
  ) then raise exception 'existing_version_requires_review' using errcode='P0001';end if;
  if v_version.status not in ('draft', 'superseded') then
    raise exception 'version_invalid_state' using errcode = 'P0001';
  end if;

  if v_version.credential_id is null and p_platform_credential_verified is not true then
    raise exception 'credential_missing' using errcode = 'P0001';
  end if;

  if v_version.credential_id is not null then
  select c.id, c.organization_id, c.provider, c.is_active, c.validated_at,
         c.models_available
    into v_credential
  from public.ai_provider_credentials c
  where c.id = v_version.credential_id;

  if not found or v_credential.organization_id <> p_org_id then
    raise exception 'credential_not_found' using errcode = 'P0001';
  end if;
  if not v_credential.is_active then
    raise exception 'credential_inactive' using errcode = 'P0001';
  end if;
  if v_credential.validated_at is null then
    raise exception 'credential_not_validated' using errcode = 'P0001';
  end if;
  if v_credential.provider <> v_version.provider then
    raise exception 'credential_provider_mismatch' using errcode = 'P0001';
  end if;

  end if;

  select s.id, s.organization_id, s.status
    into v_session
  from public.channel_sessions s
  where s.id = v_version.channel_session_id;

  if not found or v_session.organization_id <> p_org_id then
    raise exception 'channel_session_not_found' using errcode = 'P0001';
  end if;
  if v_session.status <> 'WORKING' then
    raise exception 'channel_session_offline' using errcode = 'P0001';
  end if;

  -- Provedor personalizado (0418): o endpoint é da empresa, e quem diz que o
  -- modelo existe é a lista que ELE devolveu, gravada na credencial já
  -- conferida acima. Sem credencial própria não há lista — recusado.
  if v_version.provider = 'custom' then
    if v_version.credential_id is null then
      raise exception 'model_not_found' using errcode = 'P0001';
    end if;
    if not (v_version.model = any(coalesce(v_credential.models_available, '{}'::text[]))) then
      raise exception 'model_not_found' using errcode = 'P0001';
    end if;
  else
    select count(*)
      into v_model_count
    from public.ai_models m
    where m.provider = v_version.provider
      and m.model_id = v_version.model
      and m.deprecated_at is null;

    if v_model_count = 0 then
      raise exception 'model_not_found' using errcode = 'P0001';
    end if;
  end if;

  v_previous_version_id := v_agent.published_version_id;

  if v_previous_version_id is not null and v_previous_version_id <> p_version_id then
    update public.ai_agent_versions
       set status = 'superseded', superseded_at = v_published_at
     where id = v_previous_version_id;
  end if;

  update public.ai_agent_versions
     set status = 'published',
         published_at = v_published_at,
         superseded_at = null
   where id = p_version_id;

  update public.ai_agents
     set published_version_id = p_version_id,
         updated_at = v_published_at
   where id = p_agent_id;

  return query
    select p_agent_id, p_version_id, v_previous_version_id, v_published_at;
end;
$$;

revoke all on function public.fn_publish_ai_agent_version(uuid,uuid,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.fn_publish_ai_agent_version(uuid,uuid,uuid,boolean,text) to service_role;
