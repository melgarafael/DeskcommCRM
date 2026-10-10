-- =============================================================================
-- 0010_ai_rag_handoff_columns_and_rpcs (applied via Supabase MCP)
-- EPIC-06 Wave 1 — supports ai-response-worker
-- =============================================================================
-- Adds:
--   * contacts.force_human                       boolean default false
--   * conversations.bot_silenced_until           timestamptz
--   * conversations.last_handoff_at              timestamptz
--   * partial index conversations_bot_silenced_idx
--   * RPC retrieve_top_k_chunks(...)             security definer, prog org filter
--   * RPC activate_kb_version(p_agent_id, p_version_id)
--   * Updates ai_pricing seeds (haiku 100/500, openai/text-embedding-3-small 20)
--
-- Rationale:
--   * Worker (workers/ai-response-worker.ts) needs to (a) inspect handoff state
--     (b) read top-K chunks via cosine similarity. RPC is security definer
--     because the worker runs under service-role, but body filters
--     organization_id explicitly so cross-tenant calls return zero rows even if
--     a future caller forgets the application-level guard.
--   * Source of truth is here + docs/specs/05-spec-ai-rag.md.
-- =============================================================================

alter table public.contacts
  add column if not exists force_human boolean not null default false;

alter table public.conversations
  add column if not exists bot_silenced_until timestamptz,
  add column if not exists last_handoff_at timestamptz;

create index if not exists conversations_bot_silenced_idx
  on public.conversations(bot_silenced_until)
  where bot_silenced_until is not null;

update public.ai_pricing
   set prompt_cents_per_million_tokens = 100,
       completion_cents_per_million_tokens = 500
 where model = 'anthropic/claude-haiku-4-5';

update public.ai_pricing
   set embedding_cents_per_million_tokens = 20
 where model = 'openai/text-embedding-3-small';

create or replace function public.retrieve_top_k_chunks(
  p_organization_id uuid,
  p_kb_version_id uuid,
  p_embedding vector(1536),
  p_k int default 5,
  p_threshold real default 0.72
) returns table (
  chunk_id uuid,
  knowledge_source_id uuid,
  content text,
  similarity real,
  metadata jsonb
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    c.id as chunk_id,
    c.knowledge_source_id,
    c.content,
    (1 - (c.embedding <=> p_embedding))::real as similarity,
    c.metadata
  from public.ai_chunks c
  where c.organization_id = p_organization_id
    and c.kb_version_id   = p_kb_version_id
    and (1 - (c.embedding <=> p_embedding)) >= p_threshold
  order by c.embedding <=> p_embedding asc
  limit greatest(p_k, 0);
$$;

revoke all on function public.retrieve_top_k_chunks(uuid, uuid, vector, int, real) from public;
revoke execute on function public.retrieve_top_k_chunks(uuid, uuid, vector, int, real) from anon;
grant execute on function public.retrieve_top_k_chunks(uuid, uuid, vector, int, real)
  to authenticated, service_role;

create or replace function public.activate_kb_version(
  p_agent_id uuid,
  p_version_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
  v_version_org uuid;
begin
  select organization_id into v_org from public.ai_agents where id = p_agent_id;
  if v_org is null then
    raise exception 'agent_not_found' using errcode = 'P0002';
  end if;

  select organization_id into v_version_org
    from public.ai_knowledge_versions
   where id = p_version_id and agent_id = p_agent_id;
  if v_version_org is null or v_version_org <> v_org then
    raise exception 'kb_version_not_found_or_cross_tenant' using errcode = '42501';
  end if;

  update public.ai_knowledge_versions
     set is_active = false
   where agent_id = p_agent_id and id <> p_version_id and is_active = true;

  update public.ai_knowledge_versions
     set is_active = true,
         activated_at = coalesce(activated_at, now())
   where id = p_version_id;

  update public.ai_agents
     set active_kb_version_id = p_version_id,
         updated_at = now()
   where id = p_agent_id;
end$$;

revoke all on function public.activate_kb_version(uuid, uuid) from public;
revoke execute on function public.activate_kb_version(uuid, uuid) from anon;
grant execute on function public.activate_kb_version(uuid, uuid)
  to authenticated, service_role;
