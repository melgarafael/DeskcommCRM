-- 0024_ai_agent_publish_fn
-- EPIC-13 wave 6 (S-13.06): atomic publish function for AI agent versions.
-- Source: docs/specs/10-spec-ai-agents-runtime.md §4.5.
--
-- Why a Postgres function (not Node-side sequential updates):
-- Spec mandates an atomic transaction over 3 statements (supersede previous,
-- publish new, point ai_agents.published_version_id). Supabase JS client has
-- no multi-statement transaction primitive — running statements sequentially
-- leaves DB inconsistent on partial failure. The function below runs in a
-- single implicit transaction and returns the published version row.
--
-- Validation contract:
-- - p_org_id must match agent.organization_id (caller resolves from session)
-- - version must belong to agent
-- - version.status must be in (draft, superseded)
-- - credential.is_active=true and validated_at IS NOT NULL
-- - credential.provider must equal version.provider
-- - channel_session.status='working'
-- - all *_id rows must exist in same organization (defense in depth)
--
-- Errors raised: validation_failed/<reason> with sqlstate P0001 — caller
-- maps to 422 with code = reason.
--
-- Idempotent: create or replace.

create or replace function public.fn_publish_ai_agent_version(
  p_org_id uuid,
  p_agent_id uuid,
  p_version_id uuid
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
  -- Load agent (locked) and assert ownership.
  select id, organization_id, published_version_id, archived_at
    into v_agent
  from public.ai_agents
  where id = p_agent_id
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

  -- Load target version (locked) and assert agent + status.
  select id, organization_id, agent_id, status, provider, model,
         credential_id, channel_session_id
    into v_version
  from public.ai_agent_versions
  where id = p_version_id
  for update;

  if not found then
    raise exception 'version_not_found' using errcode = 'P0001';
  end if;
  if v_version.agent_id <> p_agent_id or v_version.organization_id <> p_org_id then
    raise exception 'version_not_found' using errcode = 'P0001';
  end if;
  if v_version.status not in ('draft', 'superseded') then
    raise exception 'version_invalid_state' using errcode = 'P0001';
  end if;

  -- Validate credential (must be set; FK already nullable but publish requires).
  if v_version.credential_id is null then
    raise exception 'credential_missing' using errcode = 'P0001';
  end if;

  select id, organization_id, provider, is_active, validated_at
    into v_credential
  from public.ai_provider_credentials
  where id = v_version.credential_id;

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

  -- Validate channel_session.
  select id, organization_id, status
    into v_session
  from public.channel_sessions
  where id = v_version.channel_session_id;

  if not found or v_session.organization_id <> p_org_id then
    raise exception 'channel_session_not_found' using errcode = 'P0001';
  end if;
  if v_session.status <> 'working' then
    raise exception 'channel_session_offline' using errcode = 'P0001';
  end if;

  -- Validate model exists in catalog for the same provider, not deprecated.
  select count(*)
    into v_model_count
  from public.ai_models
  where provider = v_version.provider
    and model_id = v_version.model
    and deprecated_at is null;

  if v_model_count = 0 then
    raise exception 'model_not_found' using errcode = 'P0001';
  end if;

  v_previous_version_id := v_agent.published_version_id;

  -- Atomic flip:
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

comment on function public.fn_publish_ai_agent_version(uuid, uuid, uuid) is
  'EPIC-13 S-13.06: atomic Save/Publish flip with cross-reference validation. Errors raised as P0001 with reason code as message.';
