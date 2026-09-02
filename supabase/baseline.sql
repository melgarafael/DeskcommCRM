


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'DeskcommCRM v0.1 - Migration 0001 platform_base applied 2026-04-28';



CREATE OR REPLACE FUNCTION "public"."activate_kb_version"("p_agent_id" "uuid", "p_version_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."activate_kb_version"("p_agent_id" "uuid", "p_version_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."activate_kb_version"("p_agent_id" "uuid", "p_version_id" "uuid") IS 'Atomically activate a knowledge_version for an agent. Validates tenant scope.';



CREATE OR REPLACE FUNCTION "public"."emit_event"("p_event_type" "text", "p_entity_kind" "text", "p_entity_id" "uuid", "p_payload" "jsonb" DEFAULT '{}'::"jsonb", "p_metadata" "jsonb" DEFAULT '{}'::"jsonb", "p_organization_id" "uuid" DEFAULT NULL::"uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_org_id uuid;
  v_event_id uuid;
begin
  v_org_id := p_organization_id;
  if v_org_id is null then
    -- Try to resolve from caller's first org (best-effort; trigger callers MUST pass it)
    select organization_id into v_org_id
      from public.user_organizations
      where user_id = auth.uid() and revoked_at is null
      limit 1;
  end if;
  if v_org_id is null then
    raise exception 'emit_event: organization_id obrigatorio';
  end if;

  insert into public.event_log
    (organization_id, event_type, entity_kind, entity_id, payload, metadata)
  values
    (v_org_id, p_event_type, p_entity_kind, p_entity_id,
     coalesce(p_payload, '{}'::jsonb),
     coalesce(p_metadata, '{}'::jsonb)
       || jsonb_build_object('emitted_at', extract(epoch from now())))
  returning id into v_event_id;

  return v_event_id;
end $$;


ALTER FUNCTION "public"."emit_event"("p_event_type" "text", "p_entity_kind" "text", "p_entity_id" "uuid", "p_payload" "jsonb", "p_metadata" "jsonb", "p_organization_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_audit_log_row"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_action text;
  v_org    uuid;
begin
  if tg_op = 'INSERT' then
    v_action := tg_table_name || '.created';
    v_org    := new.organization_id;
  elsif tg_op = 'UPDATE' then
    v_action := tg_table_name || '.updated';
    v_org    := new.organization_id;
  elsif tg_op = 'DELETE' then
    v_action := tg_table_name || '.deleted';
    v_org    := old.organization_id;
  end if;

  insert into public.api_audit_log (organization_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_org,
    auth.uid(),
    v_action,
    tg_table_name,
    coalesce(new.id, old.id),
    case when tg_op = 'UPDATE'
      then jsonb_build_object('changed_fields', '[diff suppressed in v0.1]')
      else '{}'::jsonb
    end
  );

  return coalesce(new, old);
end$$;


ALTER FUNCTION "public"."fn_audit_log_row"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_crm_lead_close_on_stage"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_is_won  boolean;
  v_is_lost boolean;
begin
  if tg_op = 'UPDATE'
     and new.stage_id is not distinct from old.stage_id
     and new.status   is not distinct from old.status then
    return new;
  end if;

  select is_won, is_lost into v_is_won, v_is_lost
    from public.crm_stages where id = new.stage_id;

  if v_is_won then
    new.status := 'won';
    new.closed_at := coalesce(new.closed_at, now());
  elsif v_is_lost then
    new.status := 'lost';
    new.closed_at := coalesce(new.closed_at, now());
  else
    if tg_op = 'UPDATE' and old.status in ('won','lost') then
      new.status := 'open';
      new.closed_at := null;
    end if;
  end if;
  return new;
end$$;


ALTER FUNCTION "public"."fn_crm_lead_close_on_stage"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_decrypt_oauth"("ciphertext" "bytea") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  k text := current_setting('app.nuvemshop_oauth_key', true);
begin
  return pgp_sym_decrypt(ciphertext, k);
end$$;


ALTER FUNCTION "public"."fn_decrypt_oauth"("ciphertext" "bytea") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_emit_channel_session_status_changed"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  perform public.fn_log_event(
    new.organization_id, 'channel_session.status_changed',
    jsonb_build_object(
      'channel_session_id', new.id, 'from_status', old.status, 'to_status', new.status,
      'status_reason', new.status_reason, 'phone_number', new.phone_number
    )
  );
  return new;
end$$;


ALTER FUNCTION "public"."fn_emit_channel_session_status_changed"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_emit_event_on_lead_change"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if tg_op = 'INSERT' then
    perform public.fn_log_event(
      new.organization_id, 'lead.created',
      jsonb_build_object('lead_id', new.id, 'pipeline_id', new.pipeline_id,
                         'stage_id', new.stage_id, 'contact_id', new.contact_id,
                         'source', new.source)
    );
    return new;
  end if;

  if new.stage_id is distinct from old.stage_id then
    perform public.fn_log_event(
      new.organization_id, 'lead.stage_changed',
      jsonb_build_object('lead_id', new.id, 'from_stage_id', old.stage_id, 'to_stage_id', new.stage_id)
    );
  end if;

  if new.status is distinct from old.status then
    if new.status = 'won' then
      perform public.fn_log_event(new.organization_id, 'lead.won',
        jsonb_build_object('lead_id', new.id, 'value_cents', new.value_cents));
    elsif new.status = 'lost' then
      perform public.fn_log_event(new.organization_id, 'lead.lost',
        jsonb_build_object('lead_id', new.id, 'lost_reason', new.lost_reason));
    elsif new.status = 'open' then
      perform public.fn_log_event(new.organization_id, 'lead.reopened',
        jsonb_build_object('lead_id', new.id));
    end if;
  end if;

  if new.owner_user_id is distinct from old.owner_user_id then
    perform public.fn_log_event(new.organization_id, 'lead.assigned',
      jsonb_build_object('lead_id', new.id, 'from_user_id', old.owner_user_id, 'to_user_id', new.owner_user_id));
  end if;

  return new;
end$$;


ALTER FUNCTION "public"."fn_emit_event_on_lead_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_emit_message_event"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_event text;
begin
  if new.direction = 'inbound' then
    v_event := 'message.received';
  else
    v_event := case new.status
                 when 'sending' then 'message.sending'
                 when 'sent' then 'message.sent'
                 when 'failed' then 'message.failed'
                 else 'message.outbound'
               end;
  end if;

  perform public.fn_log_event(
    new.organization_id, v_event,
    jsonb_build_object(
      'message_id', new.id, 'conversation_id', new.conversation_id,
      'contact_id', new.contact_id, 'direction', new.direction,
      'type', new.type, 'status', new.status, 'external_id', new.external_id,
      'channel_session_id', new.channel_session_id,
      'body_preview', "left"(new.body, 280)
    )
  );
  return new;
end$$;


ALTER FUNCTION "public"."fn_emit_message_event"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_encrypt_oauth"("plaintext" "text") RETURNS "bytea"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  k text := current_setting('app.nuvemshop_oauth_key', true);
begin
  if k is null or length(k) < 32 then
    raise exception 'NUVEMSHOP_OAUTH_ENCRYPTION_KEY ausente';
  end if;
  return pgp_sym_encrypt(plaintext, k, 'cipher-algo=aes256');
end$$;


ALTER FUNCTION "public"."fn_encrypt_oauth"("plaintext" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_is_platform_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from public.platform_admins
    where user_id = auth.uid() and revoked_at is null
  );
$$;


ALTER FUNCTION "public"."fn_is_platform_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_lgpd_cascade_redact_contact"("p_organization_id" "uuid", "p_contact_id" "uuid", "p_request_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_already bool;
  v_counts jsonb := '{}'::jsonb;
  v_media_paths text[] := '{}';
  v_anon_label text;
  v_count int;
begin
  select is_anonymized into v_already
    from contacts
    where id = p_contact_id and organization_id = p_organization_id;

  if not found then
    raise exception 'contact not found' using errcode = 'P0002';
  end if;

  if v_already then
    return jsonb_build_object('already_anonymized', true, 'counts', v_counts, 'media_paths', v_media_paths);
  end if;

  v_anon_label := 'Cliente Anonimizado #' || substring(p_contact_id::text from 1 for 8);

  -- Collect media storage paths (we only delete what we own — media_storage_path)
  select coalesce(array_agg(distinct media_storage_path) filter (where media_storage_path is not null), '{}')
    into v_media_paths
    from messages
    where organization_id = p_organization_id
      and conversation_id in (
        select id from conversations
          where contact_id = p_contact_id and organization_id = p_organization_id
      );

  -- 1. contacts (irreversible)
  update contacts set
    name = v_anon_label,
    display_name = v_anon_label,
    email = null,
    -- email_normalized NÃO entra: é GENERATED ALWAYS AS (lower(trim(email)))
    -- e o Postgres recusa escrita nela — a linha acima já a zera por derivação.
    -- Com a atribuição, o cascade INTEIRO abortava e nada era anonimizado.
    phone_number = null,
    cpf_encrypted = null,
    cpf_hash = null,
    birthdate = null,
    is_anonymized = true,
    anonymized_at = now(),
    consent = '{}'::jsonb,
    source_metadata = '{}'::jsonb,
    tags = '{}'::text[],
    updated_at = now()
  where id = p_contact_id and organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('contacts', v_count);

  -- 2. conversations metadata + preview strip
  update conversations set
    metadata = '{}'::jsonb,
    last_message_preview = null,
    updated_at = now()
  where contact_id = p_contact_id and organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('conversations', v_count);

  -- 3. messages: redact body + null media + strip metadata (preserve status/timestamps/conversation_id)
  update messages set
    body = '[mensagem anonimizada]',
    media_url = null,
    media_mime = null,
    media_size_bytes = null,
    media_storage_path = null,
    metadata = '{}'::jsonb,
    updated_at = now()
  where organization_id = p_organization_id
    and conversation_id in (
      select id from conversations
        where contact_id = p_contact_id and organization_id = p_organization_id
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('messages', v_count);

  -- 4. crm_lead_activities — strip payload, metadata E reason (migration 0071).
  --    `reason` é texto livre escrito por LLM sobre a conversa do lead: supor que
  --    nunca conterá um nome é a suposição que falha. `evidence` NÃO é limpa —
  --    guarda só ids, e as linhas apontadas são redigidas por conta própria.
  update crm_lead_activities set
    payload = '{}'::jsonb,
    metadata = '{}'::jsonb,
    reason = null
  where organization_id = p_organization_id
    and (
      contact_id = p_contact_id
      or lead_id in (
        select lead_id from crm_lead_links
          where target_kind = 'contact'
            and target_id = p_contact_id
            and organization_id = p_organization_id
      )
      or lead_id in (
        select id from crm_leads
          where contact_id = p_contact_id and organization_id = p_organization_id
      )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('activities', v_count);

  -- 5. crm_leads — strip title/description/custom_fields/source_metadata/tags but PRESERVE pipeline/stage/value
  update crm_leads set
    title = v_anon_label,
    description = null,
    custom_fields = '{}'::jsonb,
    source_metadata = '{}'::jsonb,
    tags = '{}'::text[],
    updated_at = now()
  where organization_id = p_organization_id
    and (
      contact_id = p_contact_id
      or id in (
        select lead_id from crm_lead_links
          where target_kind = 'contact'
            and target_id = p_contact_id
            and organization_id = p_organization_id
      )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('leads', v_count);

  -- 6. orders — PRESERVE values + status + timestamps. Strip personal fields from payload jsonb
  --    and replace customer_external_id with null (FK-safe; soft de-link). Keep contact_id null.
  update orders set
    payload = (coalesce(payload, '{}'::jsonb))
      - 'customer'
      - 'customer_name'
      - 'customer_email'
      - 'customer_phone'
      - 'shipping_address'
      - 'billing_address'
      - 'contact_identification',
    customer_external_id = null,
    contact_id = null,
    is_anonymized = true,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('orders', v_count);

  -- 7. enqueue media for async deletion (idempotent via unique (bucket, object_path))
  if array_length(v_media_paths, 1) > 0 then
    insert into storage_redaction_queue (organization_id, request_id, bucket, object_path)
    select p_organization_id, p_request_id, 'whatsapp-media', path
      from unnest(v_media_paths) as path
      where path is not null and length(path) > 0
    on conflict (bucket, object_path) do nothing;
  end if;

  -- 8. dense audit row
  insert into api_audit_log (organization_id, action, actor_user_id, resource_type, resource_id, metadata, bypassed_rls)
  values (
    p_organization_id,
    'lgpd.redact_executed',
    null,
    'contact',
    p_contact_id,
    jsonb_build_object(
      'cascaded_to', v_counts,
      'media_queued', coalesce(array_length(v_media_paths, 1), 0),
      'request_id', p_request_id
    ),
    true
  );

  return jsonb_build_object(
    'already_anonymized', false,
    'counts', v_counts,
    'media_paths', v_media_paths
  );
end;
$$;


ALTER FUNCTION "public"."fn_lgpd_cascade_redact_contact"("p_organization_id" "uuid", "p_contact_id" "uuid", "p_request_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_log_event"("p_organization_id" "uuid", "p_event_type" "text", "p_payload" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_entity_kind text;
  v_entity_id   uuid;
begin
  -- Derive entity_kind from event_type (e.g. 'lead.created' -> 'lead')
  v_entity_kind := split_part(p_event_type, '.', 1);
  v_entity_id   := (p_payload ->> 'lead_id')::uuid;
  if v_entity_id is null then
    v_entity_id := (p_payload ->> (v_entity_kind || '_id'))::uuid;
  end if;

  return public.emit_event(
    p_event_type,
    v_entity_kind,
    v_entity_id,
    p_payload,
    '{}'::jsonb,
    p_organization_id
  );
end $$;


ALTER FUNCTION "public"."fn_log_event"("p_organization_id" "uuid", "p_event_type" "text", "p_payload" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_publish_ai_agent_version"("p_org_id" "uuid", "p_agent_id" "uuid", "p_version_id" "uuid") RETURNS TABLE("agent_id" "uuid", "version_id" "uuid", "previous_version_id" "uuid", "published_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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
         v.credential_id, v.channel_session_id
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
  if v_version.status not in ('draft', 'superseded') then
    raise exception 'version_invalid_state' using errcode = 'P0001';
  end if;

  if v_version.credential_id is null then
    raise exception 'credential_missing' using errcode = 'P0001';
  end if;

  select c.id, c.organization_id, c.provider, c.is_active, c.validated_at
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

  select count(*)
    into v_model_count
  from public.ai_models m
  where m.provider = v_version.provider
    and m.model_id = v_version.model
    and m.deprecated_at is null;

  if v_model_count = 0 then
    raise exception 'model_not_found' using errcode = 'P0001';
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


ALTER FUNCTION "public"."fn_publish_ai_agent_version"("p_org_id" "uuid", "p_agent_id" "uuid", "p_version_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."fn_publish_ai_agent_version"("p_org_id" "uuid", "p_agent_id" "uuid", "p_version_id" "uuid") IS 'EPIC-13 S-13.06 (fixed in 0025): atomic Save/Publish flip. Column refs qualified to avoid ambiguity with RETURNS TABLE OUT params.';



CREATE OR REPLACE FUNCTION "public"."fn_role_at_least"("p_org" "uuid", "p_min" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  with levels(role, lvl) as (
    values ('viewer',1),('agent',2),('manager',3),('admin',4)
  )
  select coalesce(
    (select user_lvl.lvl >= min_lvl.lvl
     from levels user_lvl
     join levels min_lvl on min_lvl.role = p_min
     where user_lvl.role = public.fn_user_role_in_org(p_org)),
    false
  );
$$;


ALTER FUNCTION "public"."fn_role_at_least"("p_org" "uuid", "p_min" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_seed_default_pipeline_for_org"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_pipeline_id uuid;
  v_position numeric := 1000;
  r record;
begin
  insert into public.crm_pipelines (organization_id, name, slug, is_default, position)
  values (new.id, 'Pedidos', 'pedidos', true, 1000)
  returning id into v_pipeline_id;

  for r in
    select * from (values
      ('Carrinho abandonado',  'carrinho_abandonado',  false, false),
      ('Aguardando pagamento', 'aguardando_pagamento', false, false),
      ('Pago',                 'pago',                 true,  false),
      ('Em separação',        'em_separacao',         false, false),
      ('Enviado',              'enviado',              false, false),
      ('Entregue',             'entregue',             false, false),
      ('Pós-venda',           'pos_venda',            false, false),
      ('Cancelado',            'cancelado',            false, true)
    ) as t(stage_name, stage_slug, won, lost)
  loop
    insert into public.crm_stages (organization_id, pipeline_id, name, slug, position, is_won, is_lost)
    values (new.id, v_pipeline_id, r.stage_name, r.stage_slug, v_position, r.won, r.lost);
    v_position := v_position + 1000;
  end loop;

  return new;
end$$;


ALTER FUNCTION "public"."fn_seed_default_pipeline_for_org"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  new.updated_at := now();
  return new;
end $$;


ALTER FUNCTION "public"."fn_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_touch_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  new.updated_at := now();
  return new;
end $$;


ALTER FUNCTION "public"."fn_touch_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_update_budget_consumption"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  insert into public.ai_budgets (organization_id, current_month_consumed_cents)
  values (NEW.organization_id, coalesce(NEW.cost_cents, 0))
  on conflict (organization_id) do update
  set current_month_consumed_cents =
        public.ai_budgets.current_month_consumed_cents
        + coalesce(NEW.cost_cents, 0),
      updated_at = now();
  return NEW;
end;
$$;


ALTER FUNCTION "public"."fn_update_budget_consumption"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_update_last_activity_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  update public.crm_leads
     set last_activity_at = greatest(coalesce(last_activity_at, '-infinity'::timestamptz), new.performed_at)
   where id = new.lead_id;

  if new.contact_id is not null then
    update public.contacts
       set last_activity_at = greatest(coalesce(last_activity_at, '-infinity'::timestamptz), new.performed_at)
     where id = new.contact_id;
  end if;
  return new;
end$$;


ALTER FUNCTION "public"."fn_update_last_activity_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_user_org_ids"() RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select organization_id from public.user_organizations
  where user_id = auth.uid() and revoked_at is null;
$$;


ALTER FUNCTION "public"."fn_user_org_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_user_role_in"("p_org" "uuid") RETURNS integer
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select case public.fn_user_role_in_org(p_org)
    when 'viewer'  then 1
    when 'agent'   then 2
    when 'manager' then 3
    when 'admin'   then 4
    else 0
  end;
$$;


ALTER FUNCTION "public"."fn_user_role_in"("p_org" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_user_role_in_org"("p_org" "uuid") RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select role from public.user_organizations
  where user_id = auth.uid() and organization_id = p_org and revoked_at is null
  limit 1;
$$;


ALTER FUNCTION "public"."fn_user_role_in_org"("p_org" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_validate_activity_lead_org"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.crm_leads where id = new.lead_id;
  if v_org is null then
    raise exception 'lead_not_found' using errcode = '23503';
  end if;
  if v_org <> new.organization_id then
    raise exception 'lead_org_mismatch' using errcode = '23514';
  end if;
  return new;
end$$;


ALTER FUNCTION "public"."fn_validate_activity_lead_org"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_validate_lost_reason_required"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_canonical text[] := array['requested_by_customer','price','no_response','product_unavailable',
                              'cancelled_by_store','cancelled_by_customer','payment_failed','other'];
  v_pipeline_extra text[];
begin
  if new.status = 'lost' then
    if new.lost_reason is null or length(new.lost_reason) = 0 then
      raise exception 'lost_reason_required' using errcode = '22023';
    end if;

    select coalesce(
      array(select jsonb_array_elements_text(settings->'lost_reasons')), '{}'::text[]
    ) into v_pipeline_extra
    from public.crm_pipelines where id = new.pipeline_id;

    if not (new.lost_reason = any (v_canonical) or new.lost_reason = any (v_pipeline_extra)) then
      raise exception 'lost_reason_invalid: %', new.lost_reason using errcode = '22023';
    end if;
  end if;
  return new;
end$$;


ALTER FUNCTION "public"."fn_validate_lost_reason_required"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."midpoint"("p_prev" numeric, "p_next" numeric) RETURNS numeric
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select case
    when p_prev is null and p_next is null then 1000::numeric
    when p_prev is null then p_next - 1
    when p_next is null then p_prev + 1
    else (p_prev + p_next) / 2
  end
$$;


ALTER FUNCTION "public"."midpoint"("p_prev" numeric, "p_next" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."retrieve_top_k_chunks"("p_organization_id" "uuid", "p_kb_version_id" "uuid", "p_embedding" "public"."vector", "p_k" integer DEFAULT 5, "p_threshold" real DEFAULT 0.72) RETURNS TABLE("chunk_id" "uuid", "knowledge_source_id" "uuid", "content" "text", "similarity" real, "metadata" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."retrieve_top_k_chunks"("p_organization_id" "uuid", "p_kb_version_id" "uuid", "p_embedding" "public"."vector", "p_k" integer, "p_threshold" real) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."retrieve_top_k_chunks"("p_organization_id" "uuid", "p_kb_version_id" "uuid", "p_embedding" "public"."vector", "p_k" integer, "p_threshold" real) IS 'Top-K cosine similarity over ai_chunks. SECURITY DEFINER + programmatic org_id filter. Caller must validate p_organization_id matches authenticated tenant.';

-- `rls_auto_enable()` (event trigger candidato para ligar RLS automaticamente em
-- toda CREATE TABLE) foi removida em 2026-08-27: nunca existiu um `CREATE EVENT
-- TRIGGER ... EXECUTE FUNCTION rls_auto_enable()` em lugar nenhum do baseline ou
-- das migrations, então a função nunca foi de fato invocada pelo Postgres — e,
-- sendo do tipo `event_trigger`, também não pode ser chamada manualmente via
-- SQL. Era uma promessa de proteção automática que o código nunca cumpriu; quem
-- lesse o baseline podia concluir, errado, que tabela nova nascia com RLS
-- ligada sozinha. A garantia real de isolamento por tabela é comportamental
-- (tests/invariants/rls-isolation.test.ts + rls-completude-varredura.test.ts),
-- não um event trigger. Ligar o event trigger de verdade é mudança de
-- comportamento de runtime do banco e mereceria revisão própria — não esta.

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."ai_agent_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "agent_id" "uuid" NOT NULL,
    "agent_version_id" "uuid" NOT NULL,
    "conversation_id" "uuid",
    "contact_id" "uuid",
    "channel_session_id" "uuid",
    "inbound_message_id" "uuid",
    "outbound_message_id" "uuid",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "abort_reason" "text",
    "error_code" "text",
    "error_message" "text",
    "tokens_in" integer DEFAULT 0 NOT NULL,
    "tokens_out" integer DEFAULT 0 NOT NULL,
    "cost_cents" numeric(10,4) DEFAULT 0 NOT NULL,
    "latency_ms" integer,
    "steps_count" integer DEFAULT 0 NOT NULL,
    "tool_calls" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "is_dry_run" boolean DEFAULT false NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_agent_runs_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'running'::"text", 'completed'::"text", 'failed'::"text", 'aborted'::"text", 'handoff'::"text"])))
);


ALTER TABLE "public"."ai_agent_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_agent_versions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "agent_id" "uuid" NOT NULL,
    "version_number" integer NOT NULL,
    "system_prompt" "text" NOT NULL,
    "provider" "text" NOT NULL,
    "model" "text" NOT NULL,
    "credential_id" "uuid",
    "tool_ids" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "trigger_config" "jsonb" DEFAULT "jsonb_build_object"('events', "jsonb_build_array"('message'), 'filters', "jsonb_build_object"('ignore_groups', true, 'ignore_self', true, 'keyword_regex', NULL::"unknown", 'business_hours', NULL::"unknown"), 'concurrency', 'one_per_conversation') NOT NULL,
    "channel_session_id" "uuid" NOT NULL,
    "max_steps" integer DEFAULT 10 NOT NULL,
    "token_budget" integer DEFAULT 50000 NOT NULL,
    "cost_budget_cents" integer DEFAULT 50 NOT NULL,
    "history_message_window" integer DEFAULT 20 NOT NULL,
    "history_token_window" integer DEFAULT 8000 NOT NULL,
    "handoff_keywords" "text"[] DEFAULT ARRAY['falar com humano'::"text", 'atendente'::"text", 'pessoa real'::"text"] NOT NULL,
    "handoff_tool_enabled" boolean DEFAULT true NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "published_at" timestamp with time zone,
    "superseded_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    CONSTRAINT "ai_agent_versions_cost_budget_cents_check" CHECK ((("cost_budget_cents" >= 1) AND ("cost_budget_cents" <= 10000))),
    CONSTRAINT "ai_agent_versions_max_steps_check" CHECK ((("max_steps" >= 1) AND ("max_steps" <= 25))),
    CONSTRAINT "ai_agent_versions_provider_check" CHECK (("provider" = ANY (ARRAY['anthropic'::"text", 'openai'::"text", 'google'::"text"]))),
    CONSTRAINT "ai_agent_versions_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'published'::"text", 'superseded'::"text", 'archived'::"text"]))),
    CONSTRAINT "ai_agent_versions_token_budget_check" CHECK ((("token_budget" >= 1000) AND ("token_budget" <= 500000)))
);


ALTER TABLE "public"."ai_agent_versions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_agents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "is_default" boolean DEFAULT false NOT NULL,
    "model" "text" DEFAULT 'anthropic/claude-sonnet-4-6'::"text" NOT NULL,
    "system_prompt" "text" NOT NULL,
    "config" "jsonb" DEFAULT "jsonb_build_object"('temperature', 0.3, 'max_tokens', 1024, 'rag_top_k', 5, 'rag_similarity_threshold', 0.72, 'context_message_window', 20, 'confidence_threshold', 0.55, 'sentiment_threshold', 0.3, 'zero_data_retention', false) NOT NULL,
    "guardrails" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "active_kb_version_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "published_version_id" "uuid",
    "priority" integer DEFAULT 0 NOT NULL,
    "archived_at" timestamp with time zone,
    "kind" "text" DEFAULT 'rag_bot'::"text" NOT NULL,
    CONSTRAINT "ai_agents_kind_check" CHECK (("kind" = ANY (ARRAY['rag_bot'::"text", 'mcp_agent'::"text"])))
);


ALTER TABLE "public"."ai_agents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_budgets" (
    "organization_id" "uuid" NOT NULL,
    "monthly_limit_cents" integer DEFAULT 5000 NOT NULL,
    "action_at_100pct" "text" DEFAULT 'throttle'::"text" NOT NULL,
    "alarm_threshold_pct" integer DEFAULT 80 NOT NULL,
    "current_month_consumed_cents" numeric(12,4) DEFAULT 0 NOT NULL,
    "current_period_start" "date" DEFAULT ("date_trunc"('month'::"text", "now"()))::"date" NOT NULL,
    "last_alarm_sent_at" timestamp with time zone,
    "is_throttled" boolean DEFAULT false NOT NULL,
    "is_disabled" boolean DEFAULT false NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_budgets_action_at_100pct_check" CHECK (("action_at_100pct" = ANY (ARRAY['throttle'::"text", 'disable'::"text"]))),
    CONSTRAINT "ai_budgets_alarm_threshold_pct_check" CHECK ((("alarm_threshold_pct" >= 50) AND ("alarm_threshold_pct" <= 99)))
);


ALTER TABLE "public"."ai_budgets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_chunks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "knowledge_source_id" "uuid" NOT NULL,
    "kb_version_id" "uuid" NOT NULL,
    "position" integer NOT NULL,
    "content" "text" NOT NULL,
    "content_hash" "text" NOT NULL,
    "token_count" integer NOT NULL,
    "embedding" "public"."vector"(1536) NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ai_chunks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_faq_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "knowledge_source_id" "uuid" NOT NULL,
    "question" "text" NOT NULL,
    "answer" "text" NOT NULL,
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "locale" "text" DEFAULT 'pt-BR'::"text" NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ai_faq_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_invocations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "agent_id" "uuid" NOT NULL,
    "conversation_id" "uuid",
    "message_id" "uuid",
    "invocation_kind" "text" NOT NULL,
    "model" "text" NOT NULL,
    "prompt_tokens" integer DEFAULT 0 NOT NULL,
    "completion_tokens" integer DEFAULT 0 NOT NULL,
    "total_tokens" integer GENERATED ALWAYS AS (("prompt_tokens" + "completion_tokens")) STORED,
    "latency_ms" integer NOT NULL,
    "cost_cents" numeric(10,4) DEFAULT 0 NOT NULL,
    "finish_reason" "text",
    "citations" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "prompt_blob_path" "text",
    "response_blob_path" "text",
    "error_payload" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_invocations_invocation_kind_check" CHECK (("invocation_kind" = ANY (ARRAY['bot_respond'::"text", 'sentiment_classify'::"text", 'triage_classify'::"text", 'embedding_generate'::"text"])))
);


ALTER TABLE "public"."ai_invocations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_knowledge_sources" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "agent_id" "uuid" NOT NULL,
    "source_type" "text" NOT NULL,
    "source_metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "last_indexed_at" timestamp with time zone,
    "last_index_status" "text",
    "last_index_error" "text",
    "chunks_count" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "name" "text" DEFAULT ''::"text" NOT NULL,
    "status" "text" DEFAULT 'ready'::"text" NOT NULL,
    "ingested_at" timestamp with time zone,
    CONSTRAINT "ai_knowledge_sources_last_index_status_check" CHECK (("last_index_status" = ANY (ARRAY['success'::"text", 'partial'::"text", 'failed'::"text"]))),
    CONSTRAINT "ai_knowledge_sources_source_type_check" CHECK (("source_type" = ANY (ARRAY['faq'::"text", 'policy'::"text", 'catalog'::"text", 'conversations'::"text", 'conversation'::"text", 'nuvemshop_catalog'::"text"]))),
    CONSTRAINT "ai_knowledge_sources_status_check" CHECK (("status" = ANY (ARRAY['ready'::"text", 'archived'::"text", 'building'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."ai_knowledge_sources" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_knowledge_versions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "agent_id" "uuid" NOT NULL,
    "version_number" integer NOT NULL,
    "description" "text",
    "is_active" boolean DEFAULT false NOT NULL,
    "sources_snapshot" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "total_chunks" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "activated_at" timestamp with time zone,
    "activated_by" "uuid",
    "status" "text" DEFAULT 'building'::"text",
    "error_message" "text",
    "indexed_at" timestamp with time zone,
    CONSTRAINT "ai_knowledge_versions_status_check" CHECK (("status" = ANY (ARRAY['building'::"text", 'ready'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."ai_knowledge_versions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_models" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider" "text" NOT NULL,
    "model_id" "text" NOT NULL,
    "display_name" "text" NOT NULL,
    "description" "text",
    "context_window" integer,
    "input_price_per_million_cents" integer,
    "output_price_per_million_cents" integer,
    "supports_tools" boolean DEFAULT true NOT NULL,
    "is_default_for_provider" boolean DEFAULT false NOT NULL,
    "deprecated_at" timestamp with time zone,
    "released_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "ai_models_provider_check" CHECK (("provider" = ANY (ARRAY['anthropic'::"text", 'openai'::"text", 'google'::"text"])))
);


ALTER TABLE "public"."ai_models" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_pricing" (
    "model" "text" NOT NULL,
    "prompt_cents_per_million_tokens" numeric(10,4),
    "completion_cents_per_million_tokens" numeric(10,4),
    "embedding_cents_per_million_tokens" numeric(10,4),
    "effective_from" timestamp with time zone DEFAULT "now"() NOT NULL,
    "superseded_at" timestamp with time zone,
    "notes" "text"
);


ALTER TABLE "public"."ai_pricing" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_provider_credentials" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "label" "text" NOT NULL,
    "api_key_encrypted" "bytea" NOT NULL,
    "api_key_iv" "bytea" NOT NULL,
    "api_key_tag" "bytea" NOT NULL,
    "api_key_last4" "text" NOT NULL,
    "validated_at" timestamp with time zone,
    "validation_error" "text",
    "models_available" "text"[],
    "is_active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_provider_credentials_provider_check" CHECK (("provider" = ANY (ARRAY['anthropic'::"text", 'openai'::"text", 'google'::"text"])))
);


ALTER TABLE "public"."ai_provider_credentials" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."ai_provider_credentials_safe" WITH ("security_invoker"='true') AS
 SELECT "id",
    "organization_id",
    "provider",
    "label",
    "api_key_last4",
    "validated_at",
    "validation_error",
    "models_available",
    "is_active",
    "created_by",
    "created_at",
    "updated_at"
   FROM "public"."ai_provider_credentials";


ALTER VIEW "public"."ai_provider_credentials_safe" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."api_audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid",
    "actor_user_id" "uuid",
    "actor_api_token_id" "uuid",
    "acting_as_platform_admin" boolean DEFAULT false NOT NULL,
    "actor_ip" "inet",
    "actor_user_agent" "text",
    "action" "text" NOT NULL,
    "resource_type" "text",
    "resource_id" "uuid",
    "request_id" "text",
    "bypassed_rls" boolean DEFAULT false NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."api_audit_log" OWNER TO "postgres";


COMMENT ON TABLE "public"."api_audit_log" IS 'L-10: Append-only. Retencao 5 anos.';



CREATE TABLE IF NOT EXISTS "public"."api_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "prefix" "text" NOT NULL,
    "token_hash" "bytea" NOT NULL,
    "scopes" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "last_used_at" timestamp with time zone,
    "last_used_ip" "inet",
    "expires_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "revoked_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."api_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."channel_session_warmup" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "channel_session_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "day" "date" NOT NULL,
    "messages_sent" integer DEFAULT 0 NOT NULL,
    "messages_received" integer DEFAULT 0 NOT NULL,
    "unique_contacts" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."channel_session_warmup" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."channel_sessions" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "waha_session_name" "text" NOT NULL,
    "engine" "text" DEFAULT 'NOWEB'::"text" NOT NULL,
    "webhook_path_token" "text" DEFAULT "replace"(("extensions"."uuid_generate_v4"())::"text", '-'::"text", ''::"text") NOT NULL,
    "webhook_secret_encrypted" "bytea" NOT NULL,
    "status" "text" DEFAULT 'STARTING'::"text" NOT NULL,
    "status_reason" "text",
    "phone_number" "text",
    "display_name" "text",
    "last_health_check_at" timestamp with time zone,
    "last_status_change_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "consecutive_health_fails" integer DEFAULT 0 NOT NULL,
    "daily_message_limit" integer DEFAULT 300 NOT NULL,
    "warmup_started_at" timestamp with time zone,
    "warmup_completed_at" timestamp with time zone,
    "is_warmup_complete" boolean GENERATED ALWAYS AS (("warmup_completed_at" IS NOT NULL)) STORED,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    CONSTRAINT "channel_sessions_engine_check" CHECK (("engine" = ANY (ARRAY['NOWEB'::"text", 'WEBJS'::"text"]))),
    CONSTRAINT "channel_sessions_status_check" CHECK (("status" = ANY (ARRAY['STARTING'::"text", 'SCAN_QR_CODE'::"text", 'WORKING'::"text", 'STOPPED'::"text", 'FAILED'::"text"])))
);


ALTER TABLE "public"."channel_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contacts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "name" "text",
    "display_name" "text",
    "email" "text",
    "email_normalized" "text" GENERATED ALWAYS AS ("lower"(TRIM(BOTH FROM "email"))) STORED,
    "phone_number" "text",
    "cpf_encrypted" "bytea",
    "cpf_hash" "text",
    "birthdate" "date",
    "is_blocked" boolean DEFAULT false NOT NULL,
    "blocked_reason" "text",
    "blocked_at" timestamp with time zone,
    "is_anonymized" boolean DEFAULT false NOT NULL,
    "anonymized_at" timestamp with time zone,
    "is_merged_into" "uuid",
    "merged_at" timestamp with time zone,
    "consent" "jsonb" DEFAULT "jsonb_build_object"('marketing', "jsonb_build_object"('granted_at', NULL::"unknown", 'source', NULL::"unknown", 'version', NULL::"unknown"), 'transactional', "jsonb_build_object"('granted_at', NULL::"unknown", 'source', NULL::"unknown", 'version', NULL::"unknown"), 'profiling', "jsonb_build_object"('granted_at', NULL::"unknown", 'source', NULL::"unknown", 'version', NULL::"unknown")) NOT NULL,
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "source_metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "last_activity_at" timestamp with time zone,
    "force_human" boolean DEFAULT false NOT NULL,
    CONSTRAINT "contacts_anonymized_locked" CHECK ((("is_anonymized" = false) OR (("is_anonymized" = true) AND ("anonymized_at" IS NOT NULL)))),
    CONSTRAINT "contacts_cpf_consistency" CHECK ((("cpf_encrypted" IS NULL) = ("cpf_hash" IS NULL))),
    CONSTRAINT "contacts_email_format" CHECK ((("email" IS NULL) OR ("email" ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'::"text"))),
    CONSTRAINT "contacts_phone_e164_format" CHECK ((("phone_number" IS NULL) OR ("phone_number" ~ '^\+\d{8,15}$'::"text")))
);


ALTER TABLE "public"."contacts" OWNER TO "postgres";


COMMENT ON TABLE "public"."contacts" IS 'Pessoa fisica no escopo de um tenant. CPF criptografado at-rest. is_anonymized irreversivel (L-04).';



CREATE TABLE IF NOT EXISTS "public"."conversations" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "contact_id" "uuid" NOT NULL,
    "channel_session_id" "uuid" NOT NULL,
    "channel" "text" DEFAULT 'whatsapp'::"text" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "status_changed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "assigned_to_user_id" "uuid",
    "assigned_at" timestamp with time zone,
    "last_inbound_at" timestamp with time zone,
    "last_outbound_at" timestamp with time zone,
    "last_message_at" timestamp with time zone,
    "last_message_preview" "text",
    "unread_count_for_assignee" integer DEFAULT 0 NOT NULL,
    "is_group" boolean DEFAULT false NOT NULL,
    "group_chat_id" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "bot_silenced_until" timestamp with time zone,
    "last_handoff_at" timestamp with time zone,
    "last_handoff_reason" "text",
    "usable_for_rag" boolean DEFAULT false NOT NULL,
    "usable_for_rag_marked_at" timestamp with time zone,
    "usable_for_rag_marked_by" "uuid",
    "rag_review_status" "text",
    CONSTRAINT "conversations_channel_check" CHECK (("channel" = 'whatsapp'::"text")),
    CONSTRAINT "conversations_rag_review_status_check" CHECK ((("rag_review_status" IS NULL) OR ("rag_review_status" = ANY (ARRAY['pending_review'::"text", 'ingested'::"text", 'skipped'::"text"])))),
    CONSTRAINT "conversations_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'pending'::"text", 'resolved'::"text", 'claimed'::"text", 'ai_handling'::"text", 'closed'::"text", 'archived'::"text"])))
);


ALTER TABLE "public"."conversations" OWNER TO "postgres";


COMMENT ON CONSTRAINT "conversations_status_check" ON "public"."conversations" IS 'Accepts both legacy (open/pending/resolved) + EPIC-03 spec (claimed/ai_handling/closed/archived). UI/API normalizes; future migration may consolidate.';



CREATE TABLE IF NOT EXISTS "public"."crm_lead_activities" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "contact_id" "uuid",
    "source_module" "text" NOT NULL,
    "source_id" "uuid",
    "type" "text" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "performed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "performed_by_user_id" "uuid"
);


ALTER TABLE "public"."crm_lead_activities" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."crm_lead_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "target_kind" "text" NOT NULL,
    "target_id" "uuid" NOT NULL,
    "link_kind" "text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    CONSTRAINT "crm_lead_links_target_kind_enum" CHECK (("target_kind" = ANY (ARRAY['order'::"text", 'conversation'::"text", 'message'::"text", 'appointment'::"text", 'contact'::"text", 'lead'::"text", 'external'::"text"])))
);


ALTER TABLE "public"."crm_lead_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."crm_leads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "pipeline_id" "uuid" NOT NULL,
    "stage_id" "uuid" NOT NULL,
    "contact_id" "uuid",
    "title" "text" NOT NULL,
    "description" "text",
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "lost_reason" "text",
    "position_in_stage" numeric DEFAULT 1000 NOT NULL,
    "value_cents" bigint,
    "currency" "text" DEFAULT 'BRL'::"text",
    "owner_user_id" "uuid",
    "assigned_at" timestamp with time zone,
    "last_activity_at" timestamp with time zone,
    "expected_close_date" "date",
    "closed_at" timestamp with time zone,
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "source_metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "external_id" "text",
    "custom_fields" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    CONSTRAINT "crm_leads_closed_at_consistency" CHECK (((("status" = 'open'::"text") AND ("closed_at" IS NULL)) OR (("status" = ANY (ARRAY['won'::"text", 'lost'::"text"])) AND ("closed_at" IS NOT NULL)))),
    CONSTRAINT "crm_leads_currency_iso" CHECK ((("currency" IS NULL) OR ("currency" ~ '^[A-Z]{3}$'::"text"))),
    CONSTRAINT "crm_leads_lost_reason_required" CHECK ((("status" <> 'lost'::"text") OR (("lost_reason" IS NOT NULL) AND ("length"("lost_reason") > 0)))),
    CONSTRAINT "crm_leads_status_enum" CHECK (("status" = ANY (ARRAY['open'::"text", 'won'::"text", 'lost'::"text"])))
);


ALTER TABLE "public"."crm_leads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."crm_pipelines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "description" "text",
    "is_default" boolean DEFAULT false NOT NULL,
    "is_archived" boolean DEFAULT false NOT NULL,
    "position" numeric DEFAULT 1000 NOT NULL,
    "vocabulary" "jsonb" DEFAULT "jsonb_build_object"('lead', 'Cliente', 'lead_plural', 'Clientes', 'deal', 'Pedido', 'deal_plural', 'Pedidos', 'won', 'Pago', 'lost', 'Cancelado', 'stage', 'Etapa', 'stage_plural', 'Etapas') NOT NULL,
    "settings" "jsonb" DEFAULT "jsonb_build_object"('fields', '[]'::"jsonb", 'canonical_tags', '[]'::"jsonb", 'lost_reasons', '[]'::"jsonb", 'identity_resolution', "jsonb_build_object"('fields_in_priority_order', "jsonb_build_array"('cpf', 'phone_e164', 'email'))) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "crm_pipelines_slug_format" CHECK (("slug" ~ '^[a-z0-9_-]{2,40}$'::"text"))
);


ALTER TABLE "public"."crm_pipelines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."crm_stages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "pipeline_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "description" "text",
    "position" numeric NOT NULL,
    "color" "text",
    "is_won" boolean DEFAULT false NOT NULL,
    "is_lost" boolean DEFAULT false NOT NULL,
    "is_archived" boolean DEFAULT false NOT NULL,
    "expected_duration_hours" numeric,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "requires_human" boolean DEFAULT false NOT NULL,
    CONSTRAINT "crm_stages_color_format" CHECK ((("color" IS NULL) OR ("color" ~ '^#[0-9a-fA-F]{6}$'::"text"))),
    CONSTRAINT "crm_stages_slug_format" CHECK (("slug" ~ '^[a-z0-9_-]{2,40}$'::"text")),
    CONSTRAINT "crm_stages_won_lost_mutex" CHECK ((NOT ("is_won" AND "is_lost")))
);


ALTER TABLE "public"."crm_stages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "entity_kind" "text" NOT NULL,
    "entity_id" "uuid",
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "consumed_by" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "attempts" smallint DEFAULT 0 NOT NULL,
    "last_error" "text",
    "next_attempt_at" timestamp with time zone,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "event_log_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'done'::"text", 'dead'::"text"]))),
    CONSTRAINT "event_type_format" CHECK (("event_type" ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'::"text"))
);


ALTER TABLE "public"."event_log" OWNER TO "postgres";


COMMENT ON TABLE "public"."event_log" IS 'Bus interno do CRM. Triggers e ServerActions inserem aqui via emit_event(). Workers consomem.';



CREATE TABLE IF NOT EXISTS "public"."idempotency_keys" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "key" "text" NOT NULL,
    "endpoint" "text" NOT NULL,
    "request_hash" "bytea" NOT NULL,
    "status_code" integer NOT NULL,
    "response_body" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '24:00:00'::interval) NOT NULL
);


ALTER TABLE "public"."idempotency_keys" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."incidents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid",
    "type" "text" NOT NULL,
    "severity" "text" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "acknowledged_at" timestamp with time zone,
    "acknowledged_by" "uuid",
    "resolved_at" timestamp with time zone,
    "resolved_by" "uuid",
    "resolution_note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "incidents_severity_check" CHECK (("severity" = ANY (ARRAY['info'::"text", 'warning'::"text", 'critical'::"text"]))),
    CONSTRAINT "incidents_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'acknowledged'::"text", 'resolved'::"text"])))
);


ALTER TABLE "public"."incidents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lgpd_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "request_type" "text" NOT NULL,
    "source" "text" NOT NULL,
    "contact_id" "uuid",
    "external_customer_id" "text",
    "status" "text" DEFAULT 'received'::"text" NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "due_at" timestamp with time zone NOT NULL,
    "completed_at" timestamp with time zone,
    "request_payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "result" "jsonb",
    "error_message" "text",
    "cascaded_to" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "emergency" boolean DEFAULT false NOT NULL,
    "scope" "text" DEFAULT 'contact'::"text" NOT NULL,
    CONSTRAINT "lgpd_requests_request_type_check" CHECK (("request_type" = ANY (ARRAY['data_request'::"text", 'redact'::"text", 'store_redact'::"text"]))),
    CONSTRAINT "lgpd_requests_scope_check" CHECK (("scope" = ANY (ARRAY['contact'::"text", 'tenant'::"text"]))),
    CONSTRAINT "lgpd_requests_source_check" CHECK (("source" = ANY (ARRAY['nuvemshop'::"text", 'manual'::"text", 'api'::"text", 'support'::"text"]))),
    CONSTRAINT "lgpd_requests_status_check" CHECK (("status" = ANY (ARRAY['received'::"text", 'processing'::"text", 'completed'::"text", 'failed'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."lgpd_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."merge_queue" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "candidates" "uuid"[] NOT NULL,
    "reason" "text" NOT NULL,
    "trigger_payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "resolution" "jsonb",
    "resolved_by_user_id" "uuid",
    "resolved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "merge_queue_candidates_min2" CHECK (("array_length"("candidates", 1) >= 2)),
    CONSTRAINT "merge_queue_status_enum" CHECK (("status" = ANY (ARRAY['pending'::"text", 'resolved'::"text", 'discarded'::"text"])))
);


ALTER TABLE "public"."merge_queue" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."messages" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "channel_session_id" "uuid" NOT NULL,
    "contact_id" "uuid" NOT NULL,
    "external_id" "text",
    "type" "text" NOT NULL,
    "direction" "text" NOT NULL,
    "status" "text" DEFAULT 'received'::"text" NOT NULL,
    "ack" integer,
    "error_code" "text",
    "error_message" "text",
    "body" "text",
    "media_url" "text",
    "media_mime" "text",
    "media_size_bytes" bigint,
    "media_storage_path" "text",
    "sent_via" "text" DEFAULT 'crm'::"text" NOT NULL,
    "sent_by_user_id" "uuid",
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "delivered_at" timestamp with time zone,
    "read_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "activity_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "messages_direction_check" CHECK (("direction" = ANY (ARRAY['inbound'::"text", 'outbound'::"text"]))),
    CONSTRAINT "messages_sent_via_check" CHECK (("sent_via" = ANY (ARRAY['crm'::"text", 'external_device'::"text", 'automation'::"text", 'ai'::"text", 'user'::"text", 'system'::"text"]))),
    CONSTRAINT "messages_status_check" CHECK (("status" = ANY (ARRAY['queued'::"text", 'received'::"text", 'sending'::"text", 'sent'::"text", 'delivered'::"text", 'read'::"text", 'failed'::"text"]))),
    CONSTRAINT "messages_type_check" CHECK (("type" = ANY (ARRAY['text'::"text", 'image'::"text", 'video'::"text", 'audio'::"text", 'document'::"text", 'sticker'::"text", 'location'::"text", 'contact'::"text", 'reaction'::"text", 'system'::"text"])))
);


ALTER TABLE "public"."messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."nuvemshop_products" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "external_id" "text" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "price_cents" bigint NOT NULL,
    "available_qty" integer DEFAULT 0 NOT NULL,
    "url" "text",
    "image_url" "text",
    "rag_indexed_at" timestamp with time zone,
    "rag_chunk_count" integer DEFAULT 0 NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "last_updated_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "nuvemshop_products_price_cents_check" CHECK (("price_cents" >= 0))
);


ALTER TABLE "public"."nuvemshop_products" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "external_id" "text" NOT NULL,
    "external_provider" "text" NOT NULL,
    "customer_external_id" "text",
    "contact_id" "uuid",
    "status" "text" NOT NULL,
    "total_cents" bigint NOT NULL,
    "currency" character(3) DEFAULT 'BRL'::"bpchar" NOT NULL,
    "payment_method" "text",
    "fulfillment_status" "text",
    "tracking_code" "text",
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "ordered_at" timestamp with time zone NOT NULL,
    "updated_at_remote" timestamp with time zone,
    "is_anonymized" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "orders_external_provider_check" CHECK (("external_provider" = ANY (ARRAY['nuvemshop'::"text", 'vtex'::"text", 'shopify'::"text"]))),
    CONSTRAINT "orders_fulfillment_status_check" CHECK (("fulfillment_status" = ANY (ARRAY['unpacked'::"text", 'packed'::"text", 'shipped'::"text", 'delivered'::"text"]))),
    CONSTRAINT "orders_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'paid'::"text", 'cancelled'::"text", 'fulfilled'::"text", 'shipped'::"text", 'delivered'::"text", 'refunded'::"text"]))),
    CONSTRAINT "orders_total_cents_check" CHECK (("total_cents" >= 0))
);


ALTER TABLE "public"."orders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organizations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slug" "public"."citext" NOT NULL,
    "legal_name" "text" NOT NULL,
    "display_name" "text" NOT NULL,
    "cnpj" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "timezone" "text" DEFAULT 'America/Sao_Paulo'::"text" NOT NULL,
    "locale" "text" DEFAULT 'pt-BR'::"text" NOT NULL,
    "rate_limit_rps" integer DEFAULT 100 NOT NULL,
    "ai_budget_cents" bigint,
    "media_retention_days" integer DEFAULT 365 NOT NULL,
    "settings" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "dpo_email" "public"."citext",
    "privacy_policy_url" "text",
    "onboarded_at" timestamp with time zone,
    "suspended_at" timestamp with time zone,
    "redacted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "onboarding_state" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "suspended_reason" "text",
    "suspended_by" "uuid",
    CONSTRAINT "organizations_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'suspended'::"text", 'redacted'::"text", 'archived'::"text"])))
);


ALTER TABLE "public"."organizations" OWNER TO "postgres";


COMMENT ON TABLE "public"."organizations" IS 'Tenants do DeskcommCRM. Cada linha = 1 e-commerce cliente.';



COMMENT ON COLUMN "public"."organizations"."onboarded_at" IS 'Null = ainda em onboarding; populado quando step 5 completa';



COMMENT ON COLUMN "public"."organizations"."onboarding_state" IS 'Wizard state: { welcome?: {accepted_at, timezone, display_name}, whatsapp?: {session_id, status}, nuvemshop?: {connected_at, store_id}, ai?: {agent_id}, team?: {invites_sent} }';



CREATE TABLE IF NOT EXISTS "public"."platform_admins" (
    "user_id" "uuid" NOT NULL,
    "granted_by" "uuid" NOT NULL,
    "granted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "scope" "text" DEFAULT 'full'::"text" NOT NULL,
    "mfa_required" boolean DEFAULT true NOT NULL,
    "reason" "text" NOT NULL,
    "revoked_at" timestamp with time zone,
    "revoked_by" "uuid",
    "revoke_reason" "text",
    CONSTRAINT "platform_admins_scope_check" CHECK (("scope" = ANY (ARRAY['full'::"text", 'support_readonly'::"text"])))
);


ALTER TABLE "public"."platform_admins" OWNER TO "postgres";


COMMENT ON TABLE "public"."platform_admins" IS 'Super-admins que cruzam tenants. Modificacao SOMENTE via DBA + double-confirmation. T-04.';



CREATE TABLE IF NOT EXISTS "public"."storage_redaction_queue" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "request_id" "uuid",
    "bucket" "text" NOT NULL,
    "object_path" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "error_message" "text",
    "enqueued_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "processed_at" timestamp with time zone,
    CONSTRAINT "storage_redaction_queue_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'deleted'::"text", 'failed'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."storage_redaction_queue" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tenant_integrations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "oauth_access_token_encrypted" "bytea" NOT NULL,
    "oauth_refresh_token_encrypted" "bytea",
    "scopes" "text"[] DEFAULT ARRAY[]::"text"[] NOT NULL,
    "expires_at" timestamp with time zone,
    "status" "text" DEFAULT 'connecting'::"text" NOT NULL,
    "status_reason" "text",
    "store_metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "webhook_path_token" "text" DEFAULT "encode"("extensions"."gen_random_bytes"(24), 'hex'::"text") NOT NULL,
    "webhook_secret_encrypted" "bytea" NOT NULL,
    "webhook_subscriptions" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "last_sync_at" timestamp with time zone,
    "last_health_check_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tenant_integrations_provider_check" CHECK (("provider" = ANY (ARRAY['nuvemshop'::"text", 'vtex'::"text", 'shopify'::"text"]))),
    CONSTRAINT "tenant_integrations_status_check" CHECK (("status" = ANY (ARRAY['connecting'::"text", 'healthy'::"text", 'token_expired'::"text", 'scope_missing'::"text", 'disconnected'::"text", 'rate_limited'::"text", 'error'::"text"])))
);


ALTER TABLE "public"."tenant_integrations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_organizations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "invited_by" "uuid",
    "invited_at" timestamp with time zone,
    "accepted_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "user_organizations_role_check" CHECK (("role" = ANY (ARRAY['viewer'::"text", 'agent'::"text", 'manager'::"text", 'admin'::"text"])))
);


ALTER TABLE "public"."user_organizations" OWNER TO "postgres";


COMMENT ON COLUMN "public"."user_organizations"."role" IS '4 roles canônicos: viewer (1) < agent (2) < manager (3) < admin (4). Hierarquia.';



CREATE TABLE IF NOT EXISTS "public"."user_recovery_codes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "code_hash" "bytea" NOT NULL,
    "used_at" timestamp with time zone,
    "used_ip" "inet",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_recovery_codes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."webhook_events_log" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid",
    "channel_session_id" "uuid",
    "provider" "text" DEFAULT 'waha'::"text" NOT NULL,
    "webhook_path_token" "text",
    "http_method" "text" DEFAULT 'POST'::"text" NOT NULL,
    "headers" "jsonb",
    "raw_body" "text" NOT NULL,
    "payload_parsed" "jsonb",
    "signature_header" "text",
    "valid_signature" boolean,
    "event_type" "text",
    "external_id" "text",
    "status" "text" DEFAULT 'received'::"text" NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "error_message" "text",
    "processed_at" timestamp with time zone,
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    CONSTRAINT "webhook_events_log_provider_check" CHECK (("provider" = ANY (ARRAY['waha'::"text", 'nuvemshop'::"text", 'generic'::"text"]))),
    CONSTRAINT "webhook_events_log_status_check" CHECK (("status" = ANY (ARRAY['received'::"text", 'processed'::"text", 'error'::"text", 'dead'::"text"])))
);


ALTER TABLE "public"."webhook_events_log" OWNER TO "postgres";


DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_agent_runs_pkey' AND conrelid = '"public"."ai_agent_runs"'::regclass)
   AND to_regclass('"public"."ai_agent_runs_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_agent_runs"
    ADD CONSTRAINT "ai_agent_runs_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_agent_versions_pkey' AND conrelid = '"public"."ai_agent_versions"'::regclass)
   AND to_regclass('"public"."ai_agent_versions_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_agent_versions"
    ADD CONSTRAINT "ai_agent_versions_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_agent_versions_unique_number' AND conrelid = '"public"."ai_agent_versions"'::regclass)
   AND to_regclass('"public"."ai_agent_versions_unique_number"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_agent_versions"
    ADD CONSTRAINT "ai_agent_versions_unique_number" UNIQUE ("agent_id", "version_number");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_agents_name_unique' AND conrelid = '"public"."ai_agents"'::regclass)
   AND to_regclass('"public"."ai_agents_name_unique"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_agents"
    ADD CONSTRAINT "ai_agents_name_unique" UNIQUE ("organization_id", "name");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_agents_pkey' AND conrelid = '"public"."ai_agents"'::regclass)
   AND to_regclass('"public"."ai_agents_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_agents"
    ADD CONSTRAINT "ai_agents_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_budgets_pkey' AND conrelid = '"public"."ai_budgets"'::regclass)
   AND to_regclass('"public"."ai_budgets_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_budgets"
    ADD CONSTRAINT "ai_budgets_pkey" PRIMARY KEY ("organization_id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_chunks_pkey' AND conrelid = '"public"."ai_chunks"'::regclass)
   AND to_regclass('"public"."ai_chunks_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_chunks"
    ADD CONSTRAINT "ai_chunks_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_chunks_position_unique' AND conrelid = '"public"."ai_chunks"'::regclass)
   AND to_regclass('"public"."ai_chunks_position_unique"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_chunks"
    ADD CONSTRAINT "ai_chunks_position_unique" UNIQUE ("knowledge_source_id", "kb_version_id", "position");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_faq_items_pkey' AND conrelid = '"public"."ai_faq_items"'::regclass)
   AND to_regclass('"public"."ai_faq_items_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_faq_items"
    ADD CONSTRAINT "ai_faq_items_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_invocations_pkey' AND conrelid = '"public"."ai_invocations"'::regclass)
   AND to_regclass('"public"."ai_invocations_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_invocations"
    ADD CONSTRAINT "ai_invocations_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_kbv_version_unique' AND conrelid = '"public"."ai_knowledge_versions"'::regclass)
   AND to_regclass('"public"."ai_kbv_version_unique"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_knowledge_versions"
    ADD CONSTRAINT "ai_kbv_version_unique" UNIQUE ("agent_id", "version_number");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_knowledge_sources_pkey' AND conrelid = '"public"."ai_knowledge_sources"'::regclass)
   AND to_regclass('"public"."ai_knowledge_sources_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_knowledge_sources"
    ADD CONSTRAINT "ai_knowledge_sources_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_knowledge_versions_pkey' AND conrelid = '"public"."ai_knowledge_versions"'::regclass)
   AND to_regclass('"public"."ai_knowledge_versions_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_knowledge_versions"
    ADD CONSTRAINT "ai_knowledge_versions_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_models_pkey' AND conrelid = '"public"."ai_models"'::regclass)
   AND to_regclass('"public"."ai_models_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_models"
    ADD CONSTRAINT "ai_models_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_models_unique' AND conrelid = '"public"."ai_models"'::regclass)
   AND to_regclass('"public"."ai_models_unique"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_models"
    ADD CONSTRAINT "ai_models_unique" UNIQUE ("provider", "model_id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_pricing_pkey' AND conrelid = '"public"."ai_pricing"'::regclass)
   AND to_regclass('"public"."ai_pricing_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_pricing"
    ADD CONSTRAINT "ai_pricing_pkey" PRIMARY KEY ("model");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_provider_credentials_pkey' AND conrelid = '"public"."ai_provider_credentials"'::regclass)
   AND to_regclass('"public"."ai_provider_credentials_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_provider_credentials"
    ADD CONSTRAINT "ai_provider_credentials_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_provider_credentials_unique' AND conrelid = '"public"."ai_provider_credentials"'::regclass)
   AND to_regclass('"public"."ai_provider_credentials_unique"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_provider_credentials"
    ADD CONSTRAINT "ai_provider_credentials_unique" UNIQUE ("organization_id", "provider", "label");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'api_audit_log_pkey' AND conrelid = '"public"."api_audit_log"'::regclass)
   AND to_regclass('"public"."api_audit_log_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."api_audit_log"
    ADD CONSTRAINT "api_audit_log_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'api_tokens_organization_id_prefix_key' AND conrelid = '"public"."api_tokens"'::regclass)
   AND to_regclass('"public"."api_tokens_organization_id_prefix_key"') IS NULL THEN
ALTER TABLE ONLY "public"."api_tokens"
    ADD CONSTRAINT "api_tokens_organization_id_prefix_key" UNIQUE ("organization_id", "prefix");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'api_tokens_pkey' AND conrelid = '"public"."api_tokens"'::regclass)
   AND to_regclass('"public"."api_tokens_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."api_tokens"
    ADD CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'channel_session_warmup_pkey' AND conrelid = '"public"."channel_session_warmup"'::regclass)
   AND to_regclass('"public"."channel_session_warmup_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."channel_session_warmup"
    ADD CONSTRAINT "channel_session_warmup_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'channel_sessions_phone_per_org_unique' AND conrelid = '"public"."channel_sessions"'::regclass)
   AND to_regclass('"public"."channel_sessions_phone_per_org_unique"') IS NULL THEN
ALTER TABLE ONLY "public"."channel_sessions"
    ADD CONSTRAINT "channel_sessions_phone_per_org_unique" UNIQUE ("organization_id", "phone_number") DEFERRABLE INITIALLY DEFERRED;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'channel_sessions_pkey' AND conrelid = '"public"."channel_sessions"'::regclass)
   AND to_regclass('"public"."channel_sessions_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."channel_sessions"
    ADD CONSTRAINT "channel_sessions_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'channel_sessions_waha_session_name_unique' AND conrelid = '"public"."channel_sessions"'::regclass)
   AND to_regclass('"public"."channel_sessions_waha_session_name_unique"') IS NULL THEN
ALTER TABLE ONLY "public"."channel_sessions"
    ADD CONSTRAINT "channel_sessions_waha_session_name_unique" UNIQUE ("waha_session_name");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'channel_sessions_webhook_path_token_unique' AND conrelid = '"public"."channel_sessions"'::regclass)
   AND to_regclass('"public"."channel_sessions_webhook_path_token_unique"') IS NULL THEN
ALTER TABLE ONLY "public"."channel_sessions"
    ADD CONSTRAINT "channel_sessions_webhook_path_token_unique" UNIQUE ("webhook_path_token");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'contacts_pkey' AND conrelid = '"public"."contacts"'::regclass)
   AND to_regclass('"public"."contacts_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'conversations_pkey' AND conrelid = '"public"."conversations"'::regclass)
   AND to_regclass('"public"."conversations_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'conversations_unique_per_contact_session' AND conrelid = '"public"."conversations"'::regclass)
   AND to_regclass('"public"."conversations_unique_per_contact_session"') IS NULL THEN
ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_unique_per_contact_session" UNIQUE ("organization_id", "contact_id", "channel_session_id", "group_chat_id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'crm_lead_activities_pkey' AND conrelid = '"public"."crm_lead_activities"'::regclass)
   AND to_regclass('"public"."crm_lead_activities_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."crm_lead_activities"
    ADD CONSTRAINT "crm_lead_activities_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'crm_lead_links_pkey' AND conrelid = '"public"."crm_lead_links"'::regclass)
   AND to_regclass('"public"."crm_lead_links_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."crm_lead_links"
    ADD CONSTRAINT "crm_lead_links_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'crm_leads_pkey' AND conrelid = '"public"."crm_leads"'::regclass)
   AND to_regclass('"public"."crm_leads_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."crm_leads"
    ADD CONSTRAINT "crm_leads_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'crm_pipelines_pkey' AND conrelid = '"public"."crm_pipelines"'::regclass)
   AND to_regclass('"public"."crm_pipelines_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."crm_pipelines"
    ADD CONSTRAINT "crm_pipelines_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'crm_stages_pkey' AND conrelid = '"public"."crm_stages"'::regclass)
   AND to_regclass('"public"."crm_stages_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."crm_stages"
    ADD CONSTRAINT "crm_stages_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'event_log_pkey' AND conrelid = '"public"."event_log"'::regclass)
   AND to_regclass('"public"."event_log_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."event_log"
    ADD CONSTRAINT "event_log_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'idempotency_keys_organization_id_key_endpoint_key' AND conrelid = '"public"."idempotency_keys"'::regclass)
   AND to_regclass('"public"."idempotency_keys_organization_id_key_endpoint_key"') IS NULL THEN
ALTER TABLE ONLY "public"."idempotency_keys"
    ADD CONSTRAINT "idempotency_keys_organization_id_key_endpoint_key" UNIQUE ("organization_id", "key", "endpoint");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'idempotency_keys_pkey' AND conrelid = '"public"."idempotency_keys"'::regclass)
   AND to_regclass('"public"."idempotency_keys_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."idempotency_keys"
    ADD CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'incidents_pkey' AND conrelid = '"public"."incidents"'::regclass)
   AND to_regclass('"public"."incidents_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."incidents"
    ADD CONSTRAINT "incidents_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'lgpd_requests_pkey' AND conrelid = '"public"."lgpd_requests"'::regclass)
   AND to_regclass('"public"."lgpd_requests_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."lgpd_requests"
    ADD CONSTRAINT "lgpd_requests_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'merge_queue_pkey' AND conrelid = '"public"."merge_queue"'::regclass)
   AND to_regclass('"public"."merge_queue_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."merge_queue"
    ADD CONSTRAINT "merge_queue_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'messages_org_external_id_unique' AND conrelid = '"public"."messages"'::regclass)
   AND to_regclass('"public"."messages_org_external_id_unique"') IS NULL THEN
ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_org_external_id_unique" UNIQUE ("organization_id", "external_id") DEFERRABLE INITIALLY DEFERRED;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'messages_pkey' AND conrelid = '"public"."messages"'::regclass)
   AND to_regclass('"public"."messages_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'nuvemshop_products_organization_id_external_id_key' AND conrelid = '"public"."nuvemshop_products"'::regclass)
   AND to_regclass('"public"."nuvemshop_products_organization_id_external_id_key"') IS NULL THEN
ALTER TABLE ONLY "public"."nuvemshop_products"
    ADD CONSTRAINT "nuvemshop_products_organization_id_external_id_key" UNIQUE ("organization_id", "external_id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'nuvemshop_products_pkey' AND conrelid = '"public"."nuvemshop_products"'::regclass)
   AND to_regclass('"public"."nuvemshop_products_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."nuvemshop_products"
    ADD CONSTRAINT "nuvemshop_products_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'orders_organization_id_external_provider_external_id_key' AND conrelid = '"public"."orders"'::regclass)
   AND to_regclass('"public"."orders_organization_id_external_provider_external_id_key"') IS NULL THEN
ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_organization_id_external_provider_external_id_key" UNIQUE ("organization_id", "external_provider", "external_id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'orders_pkey' AND conrelid = '"public"."orders"'::regclass)
   AND to_regclass('"public"."orders_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'organizations_cnpj_key' AND conrelid = '"public"."organizations"'::regclass)
   AND to_regclass('"public"."organizations_cnpj_key"') IS NULL THEN
ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_cnpj_key" UNIQUE ("cnpj");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'organizations_pkey' AND conrelid = '"public"."organizations"'::regclass)
   AND to_regclass('"public"."organizations_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'organizations_slug_key' AND conrelid = '"public"."organizations"'::regclass)
   AND to_regclass('"public"."organizations_slug_key"') IS NULL THEN
ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_slug_key" UNIQUE ("slug");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'platform_admins_pkey' AND conrelid = '"public"."platform_admins"'::regclass)
   AND to_regclass('"public"."platform_admins_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."platform_admins"
    ADD CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("user_id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'storage_redaction_queue_bucket_object_path_key' AND conrelid = '"public"."storage_redaction_queue"'::regclass)
   AND to_regclass('"public"."storage_redaction_queue_bucket_object_path_key"') IS NULL THEN
ALTER TABLE ONLY "public"."storage_redaction_queue"
    ADD CONSTRAINT "storage_redaction_queue_bucket_object_path_key" UNIQUE ("bucket", "object_path");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'storage_redaction_queue_pkey' AND conrelid = '"public"."storage_redaction_queue"'::regclass)
   AND to_regclass('"public"."storage_redaction_queue_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."storage_redaction_queue"
    ADD CONSTRAINT "storage_redaction_queue_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'tenant_integrations_organization_id_provider_key' AND conrelid = '"public"."tenant_integrations"'::regclass)
   AND to_regclass('"public"."tenant_integrations_organization_id_provider_key"') IS NULL THEN
ALTER TABLE ONLY "public"."tenant_integrations"
    ADD CONSTRAINT "tenant_integrations_organization_id_provider_key" UNIQUE ("organization_id", "provider");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'tenant_integrations_pkey' AND conrelid = '"public"."tenant_integrations"'::regclass)
   AND to_regclass('"public"."tenant_integrations_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."tenant_integrations"
    ADD CONSTRAINT "tenant_integrations_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'user_organizations_pkey' AND conrelid = '"public"."user_organizations"'::regclass)
   AND to_regclass('"public"."user_organizations_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."user_organizations"
    ADD CONSTRAINT "user_organizations_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'user_organizations_user_id_organization_id_key' AND conrelid = '"public"."user_organizations"'::regclass)
   AND to_regclass('"public"."user_organizations_user_id_organization_id_key"') IS NULL THEN
ALTER TABLE ONLY "public"."user_organizations"
    ADD CONSTRAINT "user_organizations_user_id_organization_id_key" UNIQUE ("user_id", "organization_id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'user_recovery_codes_pkey' AND conrelid = '"public"."user_recovery_codes"'::regclass)
   AND to_regclass('"public"."user_recovery_codes_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."user_recovery_codes"
    ADD CONSTRAINT "user_recovery_codes_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'warmup_session_day_unique' AND conrelid = '"public"."channel_session_warmup"'::regclass)
   AND to_regclass('"public"."warmup_session_day_unique"') IS NULL THEN
ALTER TABLE ONLY "public"."channel_session_warmup"
    ADD CONSTRAINT "warmup_session_day_unique" UNIQUE ("channel_session_id", "day");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'webhook_events_log_pkey' AND conrelid = '"public"."webhook_events_log"'::regclass)
   AND to_regclass('"public"."webhook_events_log_pkey"') IS NULL THEN
ALTER TABLE ONLY "public"."webhook_events_log"
    ADD CONSTRAINT "webhook_events_log_pkey" PRIMARY KEY ("id");
END IF; END $baseline_guard$;



CREATE INDEX IF NOT EXISTS "ai_agent_runs_agent_idx" ON "public"."ai_agent_runs" USING "btree" ("agent_id", "started_at" DESC);



CREATE UNIQUE INDEX IF NOT EXISTS "ai_agent_runs_one_running_per_conv" ON "public"."ai_agent_runs" USING "btree" ("conversation_id") WHERE (("status" = 'running'::"text") AND ("is_dry_run" = false));



CREATE INDEX IF NOT EXISTS "ai_agent_runs_org_started_idx" ON "public"."ai_agent_runs" USING "btree" ("organization_id", "started_at" DESC);



CREATE INDEX IF NOT EXISTS "ai_agent_runs_status_idx" ON "public"."ai_agent_runs" USING "btree" ("status", "started_at") WHERE ("status" = ANY (ARRAY['pending'::"text", 'running'::"text"]));



CREATE INDEX IF NOT EXISTS "ai_agent_versions_agent_idx" ON "public"."ai_agent_versions" USING "btree" ("agent_id", "version_number" DESC);



CREATE UNIQUE INDEX IF NOT EXISTS "ai_agents_one_default_per_org" ON "public"."ai_agents" USING "btree" ("organization_id") WHERE "is_default";



CREATE INDEX IF NOT EXISTS "ai_agents_org_active_idx" ON "public"."ai_agents" USING "btree" ("organization_id") WHERE "is_active";



CREATE INDEX IF NOT EXISTS "ai_agents_published_idx" ON "public"."ai_agents" USING "btree" ("organization_id", "priority" DESC) WHERE (("published_version_id" IS NOT NULL) AND ("archived_at" IS NULL));



CREATE INDEX IF NOT EXISTS "ai_chunks_embedding_ivfflat_idx" ON "public"."ai_chunks" USING "ivfflat" ("embedding" "public"."vector_cosine_ops") WITH ("lists"='100');



CREATE INDEX IF NOT EXISTS "ai_chunks_metadata_gin_idx" ON "public"."ai_chunks" USING "gin" ("metadata");



CREATE INDEX IF NOT EXISTS "ai_chunks_org_kbv_idx" ON "public"."ai_chunks" USING "btree" ("organization_id", "kb_version_id");



CREATE INDEX IF NOT EXISTS "ai_chunks_source_idx" ON "public"."ai_chunks" USING "btree" ("knowledge_source_id");



CREATE INDEX IF NOT EXISTS "ai_faq_items_org_idx" ON "public"."ai_faq_items" USING "btree" ("organization_id");



CREATE INDEX IF NOT EXISTS "ai_faq_items_source_idx" ON "public"."ai_faq_items" USING "btree" ("knowledge_source_id", "position");



CREATE INDEX IF NOT EXISTS "ai_invocations_agent_kind_idx" ON "public"."ai_invocations" USING "btree" ("agent_id", "invocation_kind");



CREATE INDEX IF NOT EXISTS "ai_invocations_conversation_idx" ON "public"."ai_invocations" USING "btree" ("conversation_id") WHERE ("conversation_id" IS NOT NULL);



CREATE INDEX IF NOT EXISTS "ai_invocations_org_created_idx" ON "public"."ai_invocations" USING "btree" ("organization_id", "created_at" DESC);



CREATE UNIQUE INDEX IF NOT EXISTS "ai_kbv_one_active_per_agent" ON "public"."ai_knowledge_versions" USING "btree" ("agent_id") WHERE "is_active";



CREATE INDEX IF NOT EXISTS "ai_knowledge_sources_agent_idx" ON "public"."ai_knowledge_sources" USING "btree" ("agent_id", "is_active");



CREATE UNIQUE INDEX IF NOT EXISTS "ai_knowledge_sources_unique_per_agent" ON "public"."ai_knowledge_sources" USING "btree" ("agent_id", "source_type") WHERE "is_active";



CREATE UNIQUE INDEX IF NOT EXISTS "ai_models_one_default_per_provider" ON "public"."ai_models" USING "btree" ("provider") WHERE "is_default_for_provider";



CREATE INDEX IF NOT EXISTS "ai_provider_credentials_org_provider_idx" ON "public"."ai_provider_credentials" USING "btree" ("organization_id", "provider") WHERE "is_active";



CREATE INDEX IF NOT EXISTS "conversations_bot_silenced_idx" ON "public"."conversations" USING "btree" ("bot_silenced_until") WHERE ("bot_silenced_until" IS NOT NULL);



CREATE INDEX IF NOT EXISTS "conversations_usable_rag_idx" ON "public"."conversations" USING "btree" ("organization_id", "usable_for_rag", "usable_for_rag_marked_at") WHERE ("usable_for_rag" = true);



CREATE INDEX IF NOT EXISTS "event_log_consumed_by_gin" ON "public"."event_log" USING "gin" ("consumed_by");



CREATE INDEX IF NOT EXISTS "event_log_dead_idx" ON "public"."event_log" USING "btree" ("organization_id", "created_at" DESC) WHERE ("status" = 'dead'::"text");



CREATE INDEX IF NOT EXISTS "event_log_entity_idx" ON "public"."event_log" USING "btree" ("entity_kind", "entity_id", "created_at" DESC);



CREATE INDEX IF NOT EXISTS "event_log_org_type_idx" ON "public"."event_log" USING "btree" ("organization_id", "event_type", "created_at" DESC);



CREATE INDEX IF NOT EXISTS "event_log_pending_idx" ON "public"."event_log" USING "btree" ("organization_id", "created_at") WHERE ("status" = 'pending'::"text");



CREATE INDEX IF NOT EXISTS "idx_api_tokens_hash" ON "public"."api_tokens" USING "btree" ("token_hash") WHERE ("revoked_at" IS NULL);



CREATE INDEX IF NOT EXISTS "idx_api_tokens_org" ON "public"."api_tokens" USING "btree" ("organization_id") WHERE ("revoked_at" IS NULL);



CREATE INDEX IF NOT EXISTS "idx_audit_action_time" ON "public"."api_audit_log" USING "btree" ("action", "created_at" DESC);



CREATE INDEX IF NOT EXISTS "idx_audit_actor_time" ON "public"."api_audit_log" USING "btree" ("actor_user_id", "created_at" DESC);



CREATE INDEX IF NOT EXISTS "idx_audit_org_time" ON "public"."api_audit_log" USING "btree" ("organization_id", "created_at" DESC);



CREATE INDEX IF NOT EXISTS "idx_audit_request" ON "public"."api_audit_log" USING "btree" ("request_id");



CREATE INDEX IF NOT EXISTS "idx_audit_resource" ON "public"."api_audit_log" USING "btree" ("resource_type", "resource_id");



CREATE INDEX IF NOT EXISTS "idx_channel_sessions_health" ON "public"."channel_sessions" USING "btree" ("last_health_check_at") WHERE ("status" = 'WORKING'::"text");



CREATE INDEX IF NOT EXISTS "idx_channel_sessions_org_status" ON "public"."channel_sessions" USING "btree" ("organization_id", "status");



CREATE INDEX IF NOT EXISTS "idx_contacts_consent_gin" ON "public"."contacts" USING "gin" ("consent" "jsonb_path_ops");



CREATE INDEX IF NOT EXISTS "idx_contacts_org_blocked" ON "public"."contacts" USING "btree" ("organization_id") WHERE ("is_blocked" = true);



CREATE INDEX IF NOT EXISTS "idx_contacts_org_last_activity" ON "public"."contacts" USING "btree" ("organization_id", "last_activity_at" DESC NULLS LAST);



CREATE INDEX IF NOT EXISTS "idx_contacts_org_name_trgm" ON "public"."contacts" USING "gin" ("name" "public"."gin_trgm_ops");



CREATE INDEX IF NOT EXISTS "idx_contacts_tags_gin" ON "public"."contacts" USING "gin" ("tags");



CREATE INDEX IF NOT EXISTS "idx_conversations_assigned" ON "public"."conversations" USING "btree" ("assigned_to_user_id", "status") WHERE ("assigned_to_user_id" IS NOT NULL);



CREATE INDEX IF NOT EXISTS "idx_conversations_open_unassigned" ON "public"."conversations" USING "btree" ("organization_id", "last_inbound_at" DESC) WHERE (("status" = 'open'::"text") AND ("assigned_to_user_id" IS NULL));



CREATE INDEX IF NOT EXISTS "idx_conversations_org_last_msg" ON "public"."conversations" USING "btree" ("organization_id", "last_message_at" DESC NULLS LAST);



CREATE INDEX IF NOT EXISTS "idx_crm_lead_links_lead" ON "public"."crm_lead_links" USING "btree" ("lead_id");



CREATE INDEX IF NOT EXISTS "idx_crm_lead_links_org_target" ON "public"."crm_lead_links" USING "btree" ("organization_id", "target_kind", "target_id");



CREATE INDEX IF NOT EXISTS "idx_crm_leads_custom_fields_gin" ON "public"."crm_leads" USING "gin" ("custom_fields" "jsonb_path_ops");



CREATE INDEX IF NOT EXISTS "idx_crm_leads_org_contact" ON "public"."crm_leads" USING "btree" ("organization_id", "contact_id");



CREATE INDEX IF NOT EXISTS "idx_crm_leads_org_expected_close_overdue" ON "public"."crm_leads" USING "btree" ("organization_id", "expected_close_date") WHERE (("status" = 'open'::"text") AND ("expected_close_date" IS NOT NULL));



CREATE INDEX IF NOT EXISTS "idx_crm_leads_org_last_activity" ON "public"."crm_leads" USING "btree" ("organization_id", "last_activity_at" DESC NULLS LAST);



CREATE INDEX IF NOT EXISTS "idx_crm_leads_org_owner_status" ON "public"."crm_leads" USING "btree" ("organization_id", "owner_user_id", "status") WHERE ("status" = 'open'::"text");



CREATE INDEX IF NOT EXISTS "idx_crm_leads_org_pipeline_status" ON "public"."crm_leads" USING "btree" ("organization_id", "pipeline_id", "status");



CREATE INDEX IF NOT EXISTS "idx_crm_leads_org_stage_position" ON "public"."crm_leads" USING "btree" ("organization_id", "stage_id", "position_in_stage");



CREATE INDEX IF NOT EXISTS "idx_crm_leads_tags_gin" ON "public"."crm_leads" USING "gin" ("tags");



CREATE INDEX IF NOT EXISTS "idx_crm_pipelines_org_position" ON "public"."crm_pipelines" USING "btree" ("organization_id", "position") WHERE ("is_archived" = false);



CREATE INDEX IF NOT EXISTS "idx_crm_stages_pipeline_position" ON "public"."crm_stages" USING "btree" ("pipeline_id", "position") WHERE ("is_archived" = false);



CREATE INDEX IF NOT EXISTS "idx_idem_expiry" ON "public"."idempotency_keys" USING "btree" ("expires_at");



CREATE INDEX IF NOT EXISTS "idx_idem_lookup" ON "public"."idempotency_keys" USING "btree" ("organization_id", "key", "endpoint");



CREATE INDEX IF NOT EXISTS "idx_lead_activities_org_contact" ON "public"."crm_lead_activities" USING "btree" ("organization_id", "contact_id", "performed_at" DESC);



CREATE INDEX IF NOT EXISTS "idx_lead_activities_org_lead_perf" ON "public"."crm_lead_activities" USING "btree" ("organization_id", "lead_id", "performed_at" DESC);



CREATE INDEX IF NOT EXISTS "idx_lead_activities_org_type_perf" ON "public"."crm_lead_activities" USING "btree" ("organization_id", "type", "performed_at" DESC);



CREATE INDEX IF NOT EXISTS "idx_lead_activities_payload_gin" ON "public"."crm_lead_activities" USING "gin" ("payload" "jsonb_path_ops");



CREATE INDEX IF NOT EXISTS "idx_merge_queue_org_status" ON "public"."merge_queue" USING "btree" ("organization_id", "status", "created_at");



CREATE INDEX IF NOT EXISTS "idx_messages_conversation_sent" ON "public"."messages" USING "btree" ("conversation_id", "sent_at" DESC);



CREATE INDEX IF NOT EXISTS "idx_messages_external_lookup" ON "public"."messages" USING "btree" ("organization_id", "external_id") WHERE ("external_id" IS NOT NULL);



CREATE INDEX IF NOT EXISTS "idx_messages_org_status_created" ON "public"."messages" USING "btree" ("organization_id", "status", "created_at") WHERE ("status" = ANY (ARRAY['sending'::"text", 'failed'::"text"]));



CREATE INDEX IF NOT EXISTS "idx_organizations_pending_onboarding" ON "public"."organizations" USING "btree" ("id") WHERE ("onboarded_at" IS NULL);



CREATE INDEX IF NOT EXISTS "idx_orgs_slug" ON "public"."organizations" USING "btree" ("slug");



CREATE INDEX IF NOT EXISTS "idx_orgs_status" ON "public"."organizations" USING "btree" ("status") WHERE ("status" = 'active'::"text");



CREATE UNIQUE INDEX IF NOT EXISTS "idx_recovery_unique" ON "public"."user_recovery_codes" USING "btree" ("user_id", "code_hash");



CREATE INDEX IF NOT EXISTS "idx_recovery_user" ON "public"."user_recovery_codes" USING "btree" ("user_id") WHERE ("used_at" IS NULL);



CREATE INDEX IF NOT EXISTS "idx_user_orgs_org_role" ON "public"."user_organizations" USING "btree" ("organization_id", "role") WHERE ("revoked_at" IS NULL);



CREATE INDEX IF NOT EXISTS "idx_user_orgs_user" ON "public"."user_organizations" USING "btree" ("user_id") WHERE ("revoked_at" IS NULL);



CREATE INDEX IF NOT EXISTS "idx_warmup_org_day" ON "public"."channel_session_warmup" USING "btree" ("organization_id", "day" DESC);



CREATE INDEX IF NOT EXISTS "idx_webhook_events_external_id" ON "public"."webhook_events_log" USING "btree" ("organization_id", "provider", "external_id") WHERE ("external_id" IS NOT NULL);



CREATE INDEX IF NOT EXISTS "idx_webhook_events_org_received" ON "public"."webhook_events_log" USING "btree" ("organization_id", "received_at" DESC);



CREATE INDEX IF NOT EXISTS "idx_webhook_events_status_received" ON "public"."webhook_events_log" USING "btree" ("status", "received_at") WHERE ("status" = ANY (ARRAY['received'::"text", 'error'::"text"]));



CREATE INDEX IF NOT EXISTS "incidents_org_idx" ON "public"."incidents" USING "btree" ("organization_id", "created_at" DESC);



CREATE INDEX IF NOT EXISTS "incidents_severity_idx" ON "public"."incidents" USING "btree" ("severity", "status");



CREATE INDEX IF NOT EXISTS "incidents_status_idx" ON "public"."incidents" USING "btree" ("status", "created_at" DESC) WHERE ("status" <> 'resolved'::"text");



CREATE INDEX IF NOT EXISTS "lgpd_requests_contact_idx" ON "public"."lgpd_requests" USING "btree" ("contact_id") WHERE ("contact_id" IS NOT NULL);



CREATE INDEX IF NOT EXISTS "lgpd_requests_emergency_idx" ON "public"."lgpd_requests" USING "btree" ("organization_id", "emergency", "due_at") WHERE ("emergency" = true);



CREATE INDEX IF NOT EXISTS "lgpd_requests_org_due_idx" ON "public"."lgpd_requests" USING "btree" ("organization_id", "due_at") WHERE ("status" = ANY (ARRAY['received'::"text", 'processing'::"text"]));



CREATE INDEX IF NOT EXISTS "lgpd_requests_org_status_idx" ON "public"."lgpd_requests" USING "btree" ("organization_id", "status");



CREATE INDEX IF NOT EXISTS "nuvemshop_products_org_idx" ON "public"."nuvemshop_products" USING "btree" ("organization_id");



CREATE INDEX IF NOT EXISTS "nuvemshop_products_rag_pending_idx" ON "public"."nuvemshop_products" USING "btree" ("organization_id") WHERE ("rag_indexed_at" IS NULL);



CREATE INDEX IF NOT EXISTS "nuvemshop_products_title_trgm" ON "public"."nuvemshop_products" USING "gin" ("title" "public"."gin_trgm_ops");



CREATE INDEX IF NOT EXISTS "orders_contact_idx" ON "public"."orders" USING "btree" ("contact_id") WHERE ("contact_id" IS NOT NULL);



CREATE INDEX IF NOT EXISTS "orders_customer_external_idx" ON "public"."orders" USING "btree" ("organization_id", "external_provider", "customer_external_id");



CREATE INDEX IF NOT EXISTS "orders_org_ordered_idx" ON "public"."orders" USING "btree" ("organization_id", "ordered_at" DESC);



CREATE INDEX IF NOT EXISTS "orders_payload_gin" ON "public"."orders" USING "gin" ("payload" "jsonb_path_ops");



CREATE INDEX IF NOT EXISTS "orders_status_idx" ON "public"."orders" USING "btree" ("organization_id", "status");



CREATE INDEX IF NOT EXISTS "storage_redaction_queue_org_idx" ON "public"."storage_redaction_queue" USING "btree" ("organization_id");



CREATE INDEX IF NOT EXISTS "storage_redaction_queue_status_idx" ON "public"."storage_redaction_queue" USING "btree" ("status", "enqueued_at") WHERE ("status" = 'pending'::"text");



CREATE INDEX IF NOT EXISTS "tenant_integrations_expires_idx" ON "public"."tenant_integrations" USING "btree" ("expires_at") WHERE ("expires_at" IS NOT NULL);



CREATE INDEX IF NOT EXISTS "tenant_integrations_org_idx" ON "public"."tenant_integrations" USING "btree" ("organization_id");



CREATE UNIQUE INDEX IF NOT EXISTS "tenant_integrations_path_token_idx" ON "public"."tenant_integrations" USING "btree" ("webhook_path_token");



CREATE INDEX IF NOT EXISTS "tenant_integrations_status_idx" ON "public"."tenant_integrations" USING "btree" ("status") WHERE ("status" = ANY (ARRAY['token_expired'::"text", 'error'::"text"]));



CREATE UNIQUE INDEX IF NOT EXISTS "uniq_contacts_org_cpf" ON "public"."contacts" USING "btree" ("organization_id", "cpf_hash") WHERE (("cpf_hash" IS NOT NULL) AND ("is_merged_into" IS NULL));



CREATE UNIQUE INDEX IF NOT EXISTS "uniq_contacts_org_email" ON "public"."contacts" USING "btree" ("organization_id", "email_normalized") WHERE (("email_normalized" IS NOT NULL) AND ("is_merged_into" IS NULL));



CREATE UNIQUE INDEX IF NOT EXISTS "uniq_contacts_org_phone" ON "public"."contacts" USING "btree" ("organization_id", "phone_number") WHERE (("phone_number" IS NOT NULL) AND ("is_merged_into" IS NULL));



CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_lead_links_lead_target_link" ON "public"."crm_lead_links" USING "btree" ("lead_id", "target_kind", "target_id", "link_kind");



CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_leads_org_source_external" ON "public"."crm_leads" USING "btree" ("organization_id", "source", "external_id") WHERE ("external_id" IS NOT NULL);



CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_pipelines_org_default" ON "public"."crm_pipelines" USING "btree" ("organization_id") WHERE ("is_default" = true);



CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_pipelines_org_slug" ON "public"."crm_pipelines" USING "btree" ("organization_id", "slug");



CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_stages_pipeline_lost" ON "public"."crm_stages" USING "btree" ("pipeline_id") WHERE (("is_lost" = true) AND ("is_archived" = false));



CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_stages_pipeline_slug" ON "public"."crm_stages" USING "btree" ("pipeline_id", "slug");



CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_stages_pipeline_won" ON "public"."crm_stages" USING "btree" ("pipeline_id") WHERE (("is_won" = true) AND ("is_archived" = false));



CREATE INDEX IF NOT EXISTS "webhook_events_log_dlq_idx" ON "public"."webhook_events_log" USING "btree" ("organization_id", "provider") WHERE ("status" = 'dead'::"text");



CREATE INDEX IF NOT EXISTS "webhook_events_log_lgpd_idx" ON "public"."webhook_events_log" USING "btree" ("organization_id", "provider", "event_type", "received_at" DESC) WHERE ("event_type" = ANY (ARRAY['customer/redact'::"text", 'customer/data_request'::"text", 'store/redact'::"text"]));



CREATE OR REPLACE TRIGGER "ai_faq_items_updated_at" BEFORE UPDATE ON "public"."ai_faq_items" FOR EACH ROW EXECUTE FUNCTION "public"."fn_set_updated_at"();



CREATE OR REPLACE TRIGGER "incidents_updated_at" BEFORE UPDATE ON "public"."incidents" FOR EACH ROW EXECUTE FUNCTION "public"."fn_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_ai_agent_runs_audit" AFTER INSERT OR DELETE OR UPDATE ON "public"."ai_agent_runs" FOR EACH ROW EXECUTE FUNCTION "public"."fn_audit_log_row"();



CREATE OR REPLACE TRIGGER "trg_ai_agent_versions_audit" AFTER INSERT OR DELETE OR UPDATE ON "public"."ai_agent_versions" FOR EACH ROW EXECUTE FUNCTION "public"."fn_audit_log_row"();



CREATE OR REPLACE TRIGGER "trg_ai_agents_audit" AFTER INSERT OR DELETE OR UPDATE ON "public"."ai_agents" FOR EACH ROW EXECUTE FUNCTION "public"."fn_audit_log_row"();



CREATE OR REPLACE TRIGGER "trg_ai_agents_updated_at" BEFORE UPDATE ON "public"."ai_agents" FOR EACH ROW EXECUTE FUNCTION "public"."fn_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_ai_budgets_updated_at" BEFORE UPDATE ON "public"."ai_budgets" FOR EACH ROW EXECUTE FUNCTION "public"."fn_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_ai_invocations_budget" AFTER INSERT ON "public"."ai_invocations" FOR EACH ROW EXECUTE FUNCTION "public"."fn_update_budget_consumption"();



CREATE OR REPLACE TRIGGER "trg_ai_knowledge_sources_updated_at" BEFORE UPDATE ON "public"."ai_knowledge_sources" FOR EACH ROW EXECUTE FUNCTION "public"."fn_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_ai_provider_credentials_audit" AFTER INSERT OR DELETE OR UPDATE ON "public"."ai_provider_credentials" FOR EACH ROW EXECUTE FUNCTION "public"."fn_audit_log_row"();



CREATE OR REPLACE TRIGGER "trg_api_tokens_touch" BEFORE UPDATE ON "public"."api_tokens" FOR EACH ROW EXECUTE FUNCTION "public"."fn_touch_updated_at"();



CREATE OR REPLACE TRIGGER "trg_channel_sessions_status_audit" AFTER UPDATE OF "status" ON "public"."channel_sessions" FOR EACH ROW WHEN (("old"."status" IS DISTINCT FROM "new"."status")) EXECUTE FUNCTION "public"."fn_emit_channel_session_status_changed"();



CREATE OR REPLACE TRIGGER "trg_channel_sessions_updated_at" BEFORE UPDATE ON "public"."channel_sessions" FOR EACH ROW EXECUTE FUNCTION "public"."fn_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_contacts_updated_at" BEFORE UPDATE ON "public"."contacts" FOR EACH ROW EXECUTE FUNCTION "public"."fn_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_conversations_updated_at" BEFORE UPDATE ON "public"."conversations" FOR EACH ROW EXECUTE FUNCTION "public"."fn_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_crm_lead_close_on_stage" BEFORE INSERT OR UPDATE OF "stage_id" ON "public"."crm_leads" FOR EACH ROW EXECUTE FUNCTION "public"."fn_crm_lead_close_on_stage"();



CREATE OR REPLACE TRIGGER "trg_crm_leads_updated_at" BEFORE UPDATE ON "public"."crm_leads" FOR EACH ROW EXECUTE FUNCTION "public"."fn_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_crm_pipelines_updated_at" BEFORE UPDATE ON "public"."crm_pipelines" FOR EACH ROW EXECUTE FUNCTION "public"."fn_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_crm_stages_updated_at" BEFORE UPDATE ON "public"."crm_stages" FOR EACH ROW EXECUTE FUNCTION "public"."fn_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_emit_event_on_lead_change" AFTER INSERT OR UPDATE ON "public"."crm_leads" FOR EACH ROW EXECUTE FUNCTION "public"."fn_emit_event_on_lead_change"();



CREATE OR REPLACE TRIGGER "trg_event_log_touch" BEFORE UPDATE ON "public"."event_log" FOR EACH ROW EXECUTE FUNCTION "public"."fn_touch_updated_at"();



CREATE OR REPLACE TRIGGER "trg_lgpd_requests_updated_at" BEFORE UPDATE ON "public"."lgpd_requests" FOR EACH ROW EXECUTE FUNCTION "public"."fn_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_messages_emit_event" AFTER INSERT ON "public"."messages" FOR EACH ROW EXECUTE FUNCTION "public"."fn_emit_message_event"();



CREATE OR REPLACE TRIGGER "trg_messages_updated_at" BEFORE UPDATE ON "public"."messages" FOR EACH ROW EXECUTE FUNCTION "public"."fn_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_nuvemshop_products_updated_at" BEFORE UPDATE ON "public"."nuvemshop_products" FOR EACH ROW EXECUTE FUNCTION "public"."fn_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_orders_updated_at" BEFORE UPDATE ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."fn_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_organizations_touch" BEFORE UPDATE ON "public"."organizations" FOR EACH ROW EXECUTE FUNCTION "public"."fn_touch_updated_at"();



CREATE OR REPLACE TRIGGER "trg_seed_default_pipeline_for_org" AFTER INSERT ON "public"."organizations" FOR EACH ROW EXECUTE FUNCTION "public"."fn_seed_default_pipeline_for_org"();



CREATE OR REPLACE TRIGGER "trg_tenant_integrations_updated_at" BEFORE UPDATE ON "public"."tenant_integrations" FOR EACH ROW EXECUTE FUNCTION "public"."fn_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_update_last_activity_at" AFTER INSERT ON "public"."crm_lead_activities" FOR EACH ROW EXECUTE FUNCTION "public"."fn_update_last_activity_at"();



CREATE OR REPLACE TRIGGER "trg_user_orgs_touch" BEFORE UPDATE ON "public"."user_organizations" FOR EACH ROW EXECUTE FUNCTION "public"."fn_touch_updated_at"();



CREATE OR REPLACE TRIGGER "trg_validate_activity_lead_org" BEFORE INSERT ON "public"."crm_lead_activities" FOR EACH ROW EXECUTE FUNCTION "public"."fn_validate_activity_lead_org"();



CREATE OR REPLACE TRIGGER "trg_validate_lost_reason_required" BEFORE INSERT OR UPDATE OF "status", "lost_reason" ON "public"."crm_leads" FOR EACH ROW EXECUTE FUNCTION "public"."fn_validate_lost_reason_required"();



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_agent_runs_agent_id_fkey' AND conrelid = '"public"."ai_agent_runs"'::regclass)
   AND to_regclass('"public"."ai_agent_runs_agent_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_agent_runs"
    ADD CONSTRAINT "ai_agent_runs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agents"("id") ON DELETE RESTRICT;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_agent_runs_agent_version_id_fkey' AND conrelid = '"public"."ai_agent_runs"'::regclass)
   AND to_regclass('"public"."ai_agent_runs_agent_version_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_agent_runs"
    ADD CONSTRAINT "ai_agent_runs_agent_version_id_fkey" FOREIGN KEY ("agent_version_id") REFERENCES "public"."ai_agent_versions"("id") ON DELETE RESTRICT;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_agent_runs_channel_session_id_fkey' AND conrelid = '"public"."ai_agent_runs"'::regclass)
   AND to_regclass('"public"."ai_agent_runs_channel_session_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_agent_runs"
    ADD CONSTRAINT "ai_agent_runs_channel_session_id_fkey" FOREIGN KEY ("channel_session_id") REFERENCES "public"."channel_sessions"("id") ON DELETE SET NULL;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_agent_runs_contact_id_fkey' AND conrelid = '"public"."ai_agent_runs"'::regclass)
   AND to_regclass('"public"."ai_agent_runs_contact_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_agent_runs"
    ADD CONSTRAINT "ai_agent_runs_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_agent_runs_conversation_id_fkey' AND conrelid = '"public"."ai_agent_runs"'::regclass)
   AND to_regclass('"public"."ai_agent_runs_conversation_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_agent_runs"
    ADD CONSTRAINT "ai_agent_runs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE SET NULL;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_agent_runs_inbound_message_id_fkey' AND conrelid = '"public"."ai_agent_runs"'::regclass)
   AND to_regclass('"public"."ai_agent_runs_inbound_message_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_agent_runs"
    ADD CONSTRAINT "ai_agent_runs_inbound_message_id_fkey" FOREIGN KEY ("inbound_message_id") REFERENCES "public"."messages"("id") ON DELETE SET NULL;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_agent_runs_organization_id_fkey' AND conrelid = '"public"."ai_agent_runs"'::regclass)
   AND to_regclass('"public"."ai_agent_runs_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_agent_runs"
    ADD CONSTRAINT "ai_agent_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_agent_runs_outbound_message_id_fkey' AND conrelid = '"public"."ai_agent_runs"'::regclass)
   AND to_regclass('"public"."ai_agent_runs_outbound_message_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_agent_runs"
    ADD CONSTRAINT "ai_agent_runs_outbound_message_id_fkey" FOREIGN KEY ("outbound_message_id") REFERENCES "public"."messages"("id") ON DELETE SET NULL;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_agent_versions_agent_id_fkey' AND conrelid = '"public"."ai_agent_versions"'::regclass)
   AND to_regclass('"public"."ai_agent_versions_agent_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_agent_versions"
    ADD CONSTRAINT "ai_agent_versions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agents"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_agent_versions_channel_session_id_fkey' AND conrelid = '"public"."ai_agent_versions"'::regclass)
   AND to_regclass('"public"."ai_agent_versions_channel_session_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_agent_versions"
    ADD CONSTRAINT "ai_agent_versions_channel_session_id_fkey" FOREIGN KEY ("channel_session_id") REFERENCES "public"."channel_sessions"("id") ON DELETE RESTRICT;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_agent_versions_created_by_fkey' AND conrelid = '"public"."ai_agent_versions"'::regclass)
   AND to_regclass('"public"."ai_agent_versions_created_by_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_agent_versions"
    ADD CONSTRAINT "ai_agent_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_agent_versions_credential_id_fkey' AND conrelid = '"public"."ai_agent_versions"'::regclass)
   AND to_regclass('"public"."ai_agent_versions_credential_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_agent_versions"
    ADD CONSTRAINT "ai_agent_versions_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "public"."ai_provider_credentials"("id") ON DELETE RESTRICT;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_agent_versions_organization_id_fkey' AND conrelid = '"public"."ai_agent_versions"'::regclass)
   AND to_regclass('"public"."ai_agent_versions_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_agent_versions"
    ADD CONSTRAINT "ai_agent_versions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_agents_created_by_fkey' AND conrelid = '"public"."ai_agents"'::regclass)
   AND to_regclass('"public"."ai_agents_created_by_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_agents"
    ADD CONSTRAINT "ai_agents_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_agents_organization_id_fkey' AND conrelid = '"public"."ai_agents"'::regclass)
   AND to_regclass('"public"."ai_agents_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_agents"
    ADD CONSTRAINT "ai_agents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_agents_published_version_id_fkey' AND conrelid = '"public"."ai_agents"'::regclass)
   AND to_regclass('"public"."ai_agents_published_version_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_agents"
    ADD CONSTRAINT "ai_agents_published_version_id_fkey" FOREIGN KEY ("published_version_id") REFERENCES "public"."ai_agent_versions"("id") ON DELETE SET NULL;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_budgets_organization_id_fkey' AND conrelid = '"public"."ai_budgets"'::regclass)
   AND to_regclass('"public"."ai_budgets_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_budgets"
    ADD CONSTRAINT "ai_budgets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_chunks_knowledge_source_id_fkey' AND conrelid = '"public"."ai_chunks"'::regclass)
   AND to_regclass('"public"."ai_chunks_knowledge_source_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_chunks"
    ADD CONSTRAINT "ai_chunks_knowledge_source_id_fkey" FOREIGN KEY ("knowledge_source_id") REFERENCES "public"."ai_knowledge_sources"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_chunks_organization_id_fkey' AND conrelid = '"public"."ai_chunks"'::regclass)
   AND to_regclass('"public"."ai_chunks_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_chunks"
    ADD CONSTRAINT "ai_chunks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_faq_items_knowledge_source_id_fkey' AND conrelid = '"public"."ai_faq_items"'::regclass)
   AND to_regclass('"public"."ai_faq_items_knowledge_source_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_faq_items"
    ADD CONSTRAINT "ai_faq_items_knowledge_source_id_fkey" FOREIGN KEY ("knowledge_source_id") REFERENCES "public"."ai_knowledge_sources"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_faq_items_organization_id_fkey' AND conrelid = '"public"."ai_faq_items"'::regclass)
   AND to_regclass('"public"."ai_faq_items_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_faq_items"
    ADD CONSTRAINT "ai_faq_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_invocations_agent_id_fkey' AND conrelid = '"public"."ai_invocations"'::regclass)
   AND to_regclass('"public"."ai_invocations_agent_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_invocations"
    ADD CONSTRAINT "ai_invocations_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agents"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_invocations_conversation_id_fkey' AND conrelid = '"public"."ai_invocations"'::regclass)
   AND to_regclass('"public"."ai_invocations_conversation_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_invocations"
    ADD CONSTRAINT "ai_invocations_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE SET NULL;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_invocations_message_id_fkey' AND conrelid = '"public"."ai_invocations"'::regclass)
   AND to_regclass('"public"."ai_invocations_message_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_invocations"
    ADD CONSTRAINT "ai_invocations_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE SET NULL;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_invocations_organization_id_fkey' AND conrelid = '"public"."ai_invocations"'::regclass)
   AND to_regclass('"public"."ai_invocations_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_invocations"
    ADD CONSTRAINT "ai_invocations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_knowledge_sources_agent_id_fkey' AND conrelid = '"public"."ai_knowledge_sources"'::regclass)
   AND to_regclass('"public"."ai_knowledge_sources_agent_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_knowledge_sources"
    ADD CONSTRAINT "ai_knowledge_sources_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agents"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_knowledge_sources_organization_id_fkey' AND conrelid = '"public"."ai_knowledge_sources"'::regclass)
   AND to_regclass('"public"."ai_knowledge_sources_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_knowledge_sources"
    ADD CONSTRAINT "ai_knowledge_sources_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_knowledge_versions_activated_by_fkey' AND conrelid = '"public"."ai_knowledge_versions"'::regclass)
   AND to_regclass('"public"."ai_knowledge_versions_activated_by_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_knowledge_versions"
    ADD CONSTRAINT "ai_knowledge_versions_activated_by_fkey" FOREIGN KEY ("activated_by") REFERENCES "auth"."users"("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_knowledge_versions_agent_id_fkey' AND conrelid = '"public"."ai_knowledge_versions"'::regclass)
   AND to_regclass('"public"."ai_knowledge_versions_agent_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_knowledge_versions"
    ADD CONSTRAINT "ai_knowledge_versions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agents"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_knowledge_versions_organization_id_fkey' AND conrelid = '"public"."ai_knowledge_versions"'::regclass)
   AND to_regclass('"public"."ai_knowledge_versions_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_knowledge_versions"
    ADD CONSTRAINT "ai_knowledge_versions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_provider_credentials_created_by_fkey' AND conrelid = '"public"."ai_provider_credentials"'::regclass)
   AND to_regclass('"public"."ai_provider_credentials_created_by_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_provider_credentials"
    ADD CONSTRAINT "ai_provider_credentials_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_provider_credentials_organization_id_fkey' AND conrelid = '"public"."ai_provider_credentials"'::regclass)
   AND to_regclass('"public"."ai_provider_credentials_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."ai_provider_credentials"
    ADD CONSTRAINT "ai_provider_credentials_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'api_audit_log_actor_api_token_id_fkey' AND conrelid = '"public"."api_audit_log"'::regclass)
   AND to_regclass('"public"."api_audit_log_actor_api_token_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."api_audit_log"
    ADD CONSTRAINT "api_audit_log_actor_api_token_id_fkey" FOREIGN KEY ("actor_api_token_id") REFERENCES "public"."api_tokens"("id") ON DELETE SET NULL;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'api_audit_log_actor_user_id_fkey' AND conrelid = '"public"."api_audit_log"'::regclass)
   AND to_regclass('"public"."api_audit_log_actor_user_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."api_audit_log"
    ADD CONSTRAINT "api_audit_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'api_audit_log_organization_id_fkey' AND conrelid = '"public"."api_audit_log"'::regclass)
   AND to_regclass('"public"."api_audit_log_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."api_audit_log"
    ADD CONSTRAINT "api_audit_log_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE SET NULL;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'api_tokens_created_by_fkey' AND conrelid = '"public"."api_tokens"'::regclass)
   AND to_regclass('"public"."api_tokens_created_by_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."api_tokens"
    ADD CONSTRAINT "api_tokens_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'api_tokens_organization_id_fkey' AND conrelid = '"public"."api_tokens"'::regclass)
   AND to_regclass('"public"."api_tokens_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."api_tokens"
    ADD CONSTRAINT "api_tokens_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'api_tokens_revoked_by_fkey' AND conrelid = '"public"."api_tokens"'::regclass)
   AND to_regclass('"public"."api_tokens_revoked_by_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."api_tokens"
    ADD CONSTRAINT "api_tokens_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'channel_session_warmup_channel_session_id_fkey' AND conrelid = '"public"."channel_session_warmup"'::regclass)
   AND to_regclass('"public"."channel_session_warmup_channel_session_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."channel_session_warmup"
    ADD CONSTRAINT "channel_session_warmup_channel_session_id_fkey" FOREIGN KEY ("channel_session_id") REFERENCES "public"."channel_sessions"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'channel_session_warmup_organization_id_fkey' AND conrelid = '"public"."channel_session_warmup"'::regclass)
   AND to_regclass('"public"."channel_session_warmup_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."channel_session_warmup"
    ADD CONSTRAINT "channel_session_warmup_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'channel_sessions_created_by_fkey' AND conrelid = '"public"."channel_sessions"'::regclass)
   AND to_regclass('"public"."channel_sessions_created_by_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."channel_sessions"
    ADD CONSTRAINT "channel_sessions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'channel_sessions_organization_id_fkey' AND conrelid = '"public"."channel_sessions"'::regclass)
   AND to_regclass('"public"."channel_sessions_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."channel_sessions"
    ADD CONSTRAINT "channel_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'contacts_is_merged_into_fkey' AND conrelid = '"public"."contacts"'::regclass)
   AND to_regclass('"public"."contacts_is_merged_into_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_is_merged_into_fkey" FOREIGN KEY ("is_merged_into") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'contacts_organization_id_fkey' AND conrelid = '"public"."contacts"'::regclass)
   AND to_regclass('"public"."contacts_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'conversations_assigned_to_user_id_fkey' AND conrelid = '"public"."conversations"'::regclass)
   AND to_regclass('"public"."conversations_assigned_to_user_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_assigned_to_user_id_fkey" FOREIGN KEY ("assigned_to_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'conversations_channel_session_id_fkey' AND conrelid = '"public"."conversations"'::regclass)
   AND to_regclass('"public"."conversations_channel_session_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_channel_session_id_fkey" FOREIGN KEY ("channel_session_id") REFERENCES "public"."channel_sessions"("id") ON DELETE RESTRICT;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'conversations_contact_id_fkey' AND conrelid = '"public"."conversations"'::regclass)
   AND to_regclass('"public"."conversations_contact_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE RESTRICT;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'conversations_organization_id_fkey' AND conrelid = '"public"."conversations"'::regclass)
   AND to_regclass('"public"."conversations_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'conversations_usable_for_rag_marked_by_fkey' AND conrelid = '"public"."conversations"'::regclass)
   AND to_regclass('"public"."conversations_usable_for_rag_marked_by_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_usable_for_rag_marked_by_fkey" FOREIGN KEY ("usable_for_rag_marked_by") REFERENCES "auth"."users"("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'crm_lead_activities_contact_id_fkey' AND conrelid = '"public"."crm_lead_activities"'::regclass)
   AND to_regclass('"public"."crm_lead_activities_contact_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."crm_lead_activities"
    ADD CONSTRAINT "crm_lead_activities_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'crm_lead_activities_lead_id_fkey' AND conrelid = '"public"."crm_lead_activities"'::regclass)
   AND to_regclass('"public"."crm_lead_activities_lead_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."crm_lead_activities"
    ADD CONSTRAINT "crm_lead_activities_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."crm_leads"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'crm_lead_activities_organization_id_fkey' AND conrelid = '"public"."crm_lead_activities"'::regclass)
   AND to_regclass('"public"."crm_lead_activities_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."crm_lead_activities"
    ADD CONSTRAINT "crm_lead_activities_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'crm_lead_links_lead_id_fkey' AND conrelid = '"public"."crm_lead_links"'::regclass)
   AND to_regclass('"public"."crm_lead_links_lead_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."crm_lead_links"
    ADD CONSTRAINT "crm_lead_links_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."crm_leads"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'crm_lead_links_organization_id_fkey' AND conrelid = '"public"."crm_lead_links"'::regclass)
   AND to_regclass('"public"."crm_lead_links_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."crm_lead_links"
    ADD CONSTRAINT "crm_lead_links_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'crm_leads_contact_id_fkey' AND conrelid = '"public"."crm_leads"'::regclass)
   AND to_regclass('"public"."crm_leads_contact_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."crm_leads"
    ADD CONSTRAINT "crm_leads_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'crm_leads_organization_id_fkey' AND conrelid = '"public"."crm_leads"'::regclass)
   AND to_regclass('"public"."crm_leads_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."crm_leads"
    ADD CONSTRAINT "crm_leads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'crm_leads_pipeline_id_fkey' AND conrelid = '"public"."crm_leads"'::regclass)
   AND to_regclass('"public"."crm_leads_pipeline_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."crm_leads"
    ADD CONSTRAINT "crm_leads_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "public"."crm_pipelines"("id") ON DELETE RESTRICT;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'crm_leads_stage_id_fkey' AND conrelid = '"public"."crm_leads"'::regclass)
   AND to_regclass('"public"."crm_leads_stage_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."crm_leads"
    ADD CONSTRAINT "crm_leads_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "public"."crm_stages"("id") ON DELETE RESTRICT;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'crm_pipelines_organization_id_fkey' AND conrelid = '"public"."crm_pipelines"'::regclass)
   AND to_regclass('"public"."crm_pipelines_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."crm_pipelines"
    ADD CONSTRAINT "crm_pipelines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'crm_stages_organization_id_fkey' AND conrelid = '"public"."crm_stages"'::regclass)
   AND to_regclass('"public"."crm_stages_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."crm_stages"
    ADD CONSTRAINT "crm_stages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'crm_stages_pipeline_id_fkey' AND conrelid = '"public"."crm_stages"'::regclass)
   AND to_regclass('"public"."crm_stages_pipeline_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."crm_stages"
    ADD CONSTRAINT "crm_stages_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "public"."crm_pipelines"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'event_log_organization_id_fkey' AND conrelid = '"public"."event_log"'::regclass)
   AND to_regclass('"public"."event_log_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."event_log"
    ADD CONSTRAINT "event_log_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'idempotency_keys_organization_id_fkey' AND conrelid = '"public"."idempotency_keys"'::regclass)
   AND to_regclass('"public"."idempotency_keys_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."idempotency_keys"
    ADD CONSTRAINT "idempotency_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'incidents_acknowledged_by_fkey' AND conrelid = '"public"."incidents"'::regclass)
   AND to_regclass('"public"."incidents_acknowledged_by_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."incidents"
    ADD CONSTRAINT "incidents_acknowledged_by_fkey" FOREIGN KEY ("acknowledged_by") REFERENCES "auth"."users"("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'incidents_organization_id_fkey' AND conrelid = '"public"."incidents"'::regclass)
   AND to_regclass('"public"."incidents_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."incidents"
    ADD CONSTRAINT "incidents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'incidents_resolved_by_fkey' AND conrelid = '"public"."incidents"'::regclass)
   AND to_regclass('"public"."incidents_resolved_by_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."incidents"
    ADD CONSTRAINT "incidents_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "auth"."users"("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'lgpd_requests_contact_id_fkey' AND conrelid = '"public"."lgpd_requests"'::regclass)
   AND to_regclass('"public"."lgpd_requests_contact_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."lgpd_requests"
    ADD CONSTRAINT "lgpd_requests_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'lgpd_requests_organization_id_fkey' AND conrelid = '"public"."lgpd_requests"'::regclass)
   AND to_regclass('"public"."lgpd_requests_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."lgpd_requests"
    ADD CONSTRAINT "lgpd_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'merge_queue_organization_id_fkey' AND conrelid = '"public"."merge_queue"'::regclass)
   AND to_regclass('"public"."merge_queue_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."merge_queue"
    ADD CONSTRAINT "merge_queue_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'messages_activity_id_fkey' AND conrelid = '"public"."messages"'::regclass)
   AND to_regclass('"public"."messages_activity_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "public"."crm_lead_activities"("id") ON DELETE SET NULL;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'messages_channel_session_id_fkey' AND conrelid = '"public"."messages"'::regclass)
   AND to_regclass('"public"."messages_channel_session_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_channel_session_id_fkey" FOREIGN KEY ("channel_session_id") REFERENCES "public"."channel_sessions"("id") ON DELETE RESTRICT;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'messages_contact_id_fkey' AND conrelid = '"public"."messages"'::regclass)
   AND to_regclass('"public"."messages_contact_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE RESTRICT;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'messages_conversation_id_fkey' AND conrelid = '"public"."messages"'::regclass)
   AND to_regclass('"public"."messages_conversation_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'messages_organization_id_fkey' AND conrelid = '"public"."messages"'::regclass)
   AND to_regclass('"public"."messages_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'messages_sent_by_user_id_fkey' AND conrelid = '"public"."messages"'::regclass)
   AND to_regclass('"public"."messages_sent_by_user_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_sent_by_user_id_fkey" FOREIGN KEY ("sent_by_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'nuvemshop_products_organization_id_fkey' AND conrelid = '"public"."nuvemshop_products"'::regclass)
   AND to_regclass('"public"."nuvemshop_products_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."nuvemshop_products"
    ADD CONSTRAINT "nuvemshop_products_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'orders_contact_id_fkey' AND conrelid = '"public"."orders"'::regclass)
   AND to_regclass('"public"."orders_contact_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'orders_organization_id_fkey' AND conrelid = '"public"."orders"'::regclass)
   AND to_regclass('"public"."orders_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'organizations_created_by_fkey' AND conrelid = '"public"."organizations"'::regclass)
   AND to_regclass('"public"."organizations_created_by_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'organizations_suspended_by_fkey' AND conrelid = '"public"."organizations"'::regclass)
   AND to_regclass('"public"."organizations_suspended_by_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_suspended_by_fkey" FOREIGN KEY ("suspended_by") REFERENCES "auth"."users"("id");
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'platform_admins_granted_by_fkey' AND conrelid = '"public"."platform_admins"'::regclass)
   AND to_regclass('"public"."platform_admins_granted_by_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."platform_admins"
    ADD CONSTRAINT "platform_admins_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'platform_admins_revoked_by_fkey' AND conrelid = '"public"."platform_admins"'::regclass)
   AND to_regclass('"public"."platform_admins_revoked_by_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."platform_admins"
    ADD CONSTRAINT "platform_admins_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'platform_admins_user_id_fkey' AND conrelid = '"public"."platform_admins"'::regclass)
   AND to_regclass('"public"."platform_admins_user_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."platform_admins"
    ADD CONSTRAINT "platform_admins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'storage_redaction_queue_organization_id_fkey' AND conrelid = '"public"."storage_redaction_queue"'::regclass)
   AND to_regclass('"public"."storage_redaction_queue_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."storage_redaction_queue"
    ADD CONSTRAINT "storage_redaction_queue_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'storage_redaction_queue_request_id_fkey' AND conrelid = '"public"."storage_redaction_queue"'::regclass)
   AND to_regclass('"public"."storage_redaction_queue_request_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."storage_redaction_queue"
    ADD CONSTRAINT "storage_redaction_queue_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."lgpd_requests"("id") ON DELETE SET NULL;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'tenant_integrations_organization_id_fkey' AND conrelid = '"public"."tenant_integrations"'::regclass)
   AND to_regclass('"public"."tenant_integrations_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."tenant_integrations"
    ADD CONSTRAINT "tenant_integrations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'user_organizations_invited_by_fkey' AND conrelid = '"public"."user_organizations"'::regclass)
   AND to_regclass('"public"."user_organizations_invited_by_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."user_organizations"
    ADD CONSTRAINT "user_organizations_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'user_organizations_organization_id_fkey' AND conrelid = '"public"."user_organizations"'::regclass)
   AND to_regclass('"public"."user_organizations_organization_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."user_organizations"
    ADD CONSTRAINT "user_organizations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'user_organizations_user_id_fkey' AND conrelid = '"public"."user_organizations"'::regclass)
   AND to_regclass('"public"."user_organizations_user_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."user_organizations"
    ADD CONSTRAINT "user_organizations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'user_recovery_codes_user_id_fkey' AND conrelid = '"public"."user_recovery_codes"'::regclass)
   AND to_regclass('"public"."user_recovery_codes_user_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."user_recovery_codes"
    ADD CONSTRAINT "user_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'webhook_events_log_channel_session_id_fkey' AND conrelid = '"public"."webhook_events_log"'::regclass)
   AND to_regclass('"public"."webhook_events_log_channel_session_id_fkey"') IS NULL THEN
ALTER TABLE ONLY "public"."webhook_events_log"
    ADD CONSTRAINT "webhook_events_log_channel_session_id_fkey" FOREIGN KEY ("channel_session_id") REFERENCES "public"."channel_sessions"("id") ON DELETE SET NULL;
END IF; END $baseline_guard$;



ALTER TABLE "public"."ai_agent_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_agent_versions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_agents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_budgets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_chunks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_faq_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_invocations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_knowledge_sources" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_knowledge_versions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_models" ENABLE ROW LEVEL SECURITY;


DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'ai_models_read_all' AND polrelid = '"public"."ai_models"'::regclass) THEN
CREATE POLICY "ai_models_read_all" ON "public"."ai_models" FOR SELECT USING (true);
END IF; END $baseline_guard$;



ALTER TABLE "public"."ai_pricing" ENABLE ROW LEVEL SECURITY;


DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'ai_pricing_public_read' AND polrelid = '"public"."ai_pricing"'::regclass) THEN
CREATE POLICY "ai_pricing_public_read" ON "public"."ai_pricing" FOR SELECT USING (true);
END IF; END $baseline_guard$;



ALTER TABLE "public"."ai_provider_credentials" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."api_audit_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."api_tokens" ENABLE ROW LEVEL SECURITY;


DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'api_tokens_admin_only' AND polrelid = '"public"."api_tokens"'::regclass) THEN
CREATE POLICY "api_tokens_admin_only" ON "public"."api_tokens" USING (("public"."fn_role_at_least"("organization_id", 'admin'::"text") OR "public"."fn_is_platform_admin"())) WITH CHECK (("public"."fn_role_at_least"("organization_id", 'admin'::"text") OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'audit_log_insert_tenant_member' AND polrelid = '"public"."api_audit_log"'::regclass) THEN
CREATE POLICY "audit_log_insert_tenant_member" ON "public"."api_audit_log" FOR INSERT TO "authenticated" WITH CHECK ((("organization_id" IS NULL) OR ("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'audit_log_select' AND polrelid = '"public"."api_audit_log"'::regclass) THEN
CREATE POLICY "audit_log_select" ON "public"."api_audit_log" FOR SELECT USING (("public"."fn_is_platform_admin"() OR (("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'admin'::"text"))));
END IF; END $baseline_guard$;



ALTER TABLE "public"."channel_session_warmup" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."channel_sessions" ENABLE ROW LEVEL SECURITY;


DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'channel_sessions_tenant_isolation_all' AND polrelid = '"public"."channel_sessions"'::regclass) THEN
CREATE POLICY "channel_sessions_tenant_isolation_all" ON "public"."channel_sessions" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



ALTER TABLE "public"."contacts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."conversations" ENABLE ROW LEVEL SECURITY;


DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'conversations_tenant_isolation_all' AND polrelid = '"public"."conversations"'::regclass) THEN
CREATE POLICY "conversations_tenant_isolation_all" ON "public"."conversations" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



ALTER TABLE "public"."crm_lead_activities" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."crm_lead_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."crm_leads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."crm_pipelines" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."crm_stages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."event_log" ENABLE ROW LEVEL SECURITY;


DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'event_log_select' AND polrelid = '"public"."event_log"'::regclass) THEN
CREATE POLICY "event_log_select" ON "public"."event_log" FOR SELECT USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



ALTER TABLE "public"."idempotency_keys" ENABLE ROW LEVEL SECURITY;


DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'idempotency_tenant' AND polrelid = '"public"."idempotency_keys"'::regclass) THEN
CREATE POLICY "idempotency_tenant" ON "public"."idempotency_keys" USING (("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids"))) WITH CHECK (("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")));
END IF; END $baseline_guard$;



ALTER TABLE "public"."incidents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lgpd_requests" ENABLE ROW LEVEL SECURITY;


DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'lgpd_requests_admin_select' AND polrelid = '"public"."lgpd_requests"'::regclass) THEN
CREATE POLICY "lgpd_requests_admin_select" ON "public"."lgpd_requests" FOR SELECT USING (("public"."fn_is_platform_admin"() OR (("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'admin'::"text"))));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'lgpd_requests_admin_write' AND polrelid = '"public"."lgpd_requests"'::regclass) THEN
CREATE POLICY "lgpd_requests_admin_write" ON "public"."lgpd_requests" USING (("public"."fn_is_platform_admin"() OR (("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'admin'::"text")))) WITH CHECK (("public"."fn_is_platform_admin"() OR (("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'admin'::"text"))));
END IF; END $baseline_guard$;



ALTER TABLE "public"."merge_queue" ENABLE ROW LEVEL SECURITY;


DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'merge_queue_manager_select' AND polrelid = '"public"."merge_queue"'::regclass) THEN
CREATE POLICY "merge_queue_manager_select" ON "public"."merge_queue" FOR SELECT USING (("public"."fn_is_platform_admin"() OR (("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'manager'::"text"))));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'merge_queue_manager_write' AND polrelid = '"public"."merge_queue"'::regclass) THEN
CREATE POLICY "merge_queue_manager_write" ON "public"."merge_queue" USING (("public"."fn_is_platform_admin"() OR (("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'manager'::"text")))) WITH CHECK (("public"."fn_is_platform_admin"() OR (("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'manager'::"text"))));
END IF; END $baseline_guard$;



ALTER TABLE "public"."messages" ENABLE ROW LEVEL SECURITY;


DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'messages_tenant_isolation_all' AND polrelid = '"public"."messages"'::regclass) THEN
CREATE POLICY "messages_tenant_isolation_all" ON "public"."messages" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



ALTER TABLE "public"."nuvemshop_products" ENABLE ROW LEVEL SECURITY;


DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'nuvemshop_products_tenant' AND polrelid = '"public"."nuvemshop_products"'::regclass) THEN
CREATE POLICY "nuvemshop_products_tenant" ON "public"."nuvemshop_products" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;


DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'orders_tenant_select' AND polrelid = '"public"."orders"'::regclass) THEN
CREATE POLICY "orders_tenant_select" ON "public"."orders" FOR SELECT USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'orders_tenant_write' AND polrelid = '"public"."orders"'::regclass) THEN
CREATE POLICY "orders_tenant_write" ON "public"."orders" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



ALTER TABLE "public"."organizations" ENABLE ROW LEVEL SECURITY;


DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'orgs_select' AND polrelid = '"public"."organizations"'::regclass) THEN
CREATE POLICY "orgs_select" ON "public"."organizations" FOR SELECT USING ((("id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'orgs_write_platform_admin' AND polrelid = '"public"."organizations"'::regclass) THEN
CREATE POLICY "orgs_write_platform_admin" ON "public"."organizations" USING ("public"."fn_is_platform_admin"()) WITH CHECK ("public"."fn_is_platform_admin"());
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'platform_admin_only_incidents' AND polrelid = '"public"."incidents"'::regclass) THEN
CREATE POLICY "platform_admin_only_incidents" ON "public"."incidents" USING ("public"."fn_is_platform_admin"()) WITH CHECK ("public"."fn_is_platform_admin"());
END IF; END $baseline_guard$;



ALTER TABLE "public"."platform_admins" ENABLE ROW LEVEL SECURITY;


DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'platform_admins_self' AND polrelid = '"public"."platform_admins"'::regclass) THEN
CREATE POLICY "platform_admins_self" ON "public"."platform_admins" FOR SELECT USING ("public"."fn_is_platform_admin"());
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'recovery_codes_self' AND polrelid = '"public"."user_recovery_codes"'::regclass) THEN
CREATE POLICY "recovery_codes_self" ON "public"."user_recovery_codes" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));
END IF; END $baseline_guard$;



ALTER TABLE "public"."storage_redaction_queue" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tenant_integrations" ENABLE ROW LEVEL SECURITY;


DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'tenant_integrations_admin_write' AND polrelid = '"public"."tenant_integrations"'::regclass) THEN
CREATE POLICY "tenant_integrations_admin_write" ON "public"."tenant_integrations" USING (("public"."fn_is_platform_admin"() OR (("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'manager'::"text")))) WITH CHECK (("public"."fn_is_platform_admin"() OR (("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'manager'::"text"))));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'tenant_integrations_select' AND polrelid = '"public"."tenant_integrations"'::regclass) THEN
CREATE POLICY "tenant_integrations_select" ON "public"."tenant_integrations" FOR SELECT USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'tenant_isolation_ai_agent_runs_all' AND polrelid = '"public"."ai_agent_runs"'::regclass) THEN
CREATE POLICY "tenant_isolation_ai_agent_runs_all" ON "public"."ai_agent_runs" USING (("organization_id" IN ( SELECT "fn_user_org_ids"."fn_user_org_ids"
   FROM "public"."fn_user_org_ids"() "fn_user_org_ids"("fn_user_org_ids")))) WITH CHECK (("organization_id" IN ( SELECT "fn_user_org_ids"."fn_user_org_ids"
   FROM "public"."fn_user_org_ids"() "fn_user_org_ids"("fn_user_org_ids"))));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'tenant_isolation_ai_agent_versions_all' AND polrelid = '"public"."ai_agent_versions"'::regclass) THEN
CREATE POLICY "tenant_isolation_ai_agent_versions_all" ON "public"."ai_agent_versions" USING (("organization_id" IN ( SELECT "fn_user_org_ids"."fn_user_org_ids"
   FROM "public"."fn_user_org_ids"() "fn_user_org_ids"("fn_user_org_ids")))) WITH CHECK (("organization_id" IN ( SELECT "fn_user_org_ids"."fn_user_org_ids"
   FROM "public"."fn_user_org_ids"() "fn_user_org_ids"("fn_user_org_ids"))));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'tenant_isolation_ai_agents_all' AND polrelid = '"public"."ai_agents"'::regclass) THEN
CREATE POLICY "tenant_isolation_ai_agents_all" ON "public"."ai_agents" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'tenant_isolation_ai_budgets_all' AND polrelid = '"public"."ai_budgets"'::regclass) THEN
CREATE POLICY "tenant_isolation_ai_budgets_all" ON "public"."ai_budgets" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'tenant_isolation_ai_chunks_all' AND polrelid = '"public"."ai_chunks"'::regclass) THEN
CREATE POLICY "tenant_isolation_ai_chunks_all" ON "public"."ai_chunks" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'tenant_isolation_ai_faq_items_all' AND polrelid = '"public"."ai_faq_items"'::regclass) THEN
CREATE POLICY "tenant_isolation_ai_faq_items_all" ON "public"."ai_faq_items" USING (("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids"))) WITH CHECK (("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'tenant_isolation_ai_invocations_all' AND polrelid = '"public"."ai_invocations"'::regclass) THEN
CREATE POLICY "tenant_isolation_ai_invocations_all" ON "public"."ai_invocations" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'tenant_isolation_ai_kbv_all' AND polrelid = '"public"."ai_knowledge_versions"'::regclass) THEN
CREATE POLICY "tenant_isolation_ai_kbv_all" ON "public"."ai_knowledge_versions" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'tenant_isolation_ai_knowledge_sources_all' AND polrelid = '"public"."ai_knowledge_sources"'::regclass) THEN
CREATE POLICY "tenant_isolation_ai_knowledge_sources_all" ON "public"."ai_knowledge_sources" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'tenant_isolation_ai_provider_credentials_modify' AND polrelid = '"public"."ai_provider_credentials"'::regclass) THEN
CREATE POLICY "tenant_isolation_ai_provider_credentials_modify" ON "public"."ai_provider_credentials" USING (("organization_id" IN ( SELECT "fn_user_org_ids"."fn_user_org_ids"
   FROM "public"."fn_user_org_ids"() "fn_user_org_ids"("fn_user_org_ids")))) WITH CHECK (("organization_id" IN ( SELECT "fn_user_org_ids"."fn_user_org_ids"
   FROM "public"."fn_user_org_ids"() "fn_user_org_ids"("fn_user_org_ids"))));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'tenant_isolation_ai_provider_credentials_select' AND polrelid = '"public"."ai_provider_credentials"'::regclass) THEN
CREATE POLICY "tenant_isolation_ai_provider_credentials_select" ON "public"."ai_provider_credentials" FOR SELECT USING (("organization_id" IN ( SELECT "fn_user_org_ids"."fn_user_org_ids"
   FROM "public"."fn_user_org_ids"() "fn_user_org_ids"("fn_user_org_ids"))));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'tenant_isolation_contacts_all' AND polrelid = '"public"."contacts"'::regclass) THEN
CREATE POLICY "tenant_isolation_contacts_all" ON "public"."contacts" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'tenant_isolation_crm_lead_activities_insert' AND polrelid = '"public"."crm_lead_activities"'::regclass) THEN
CREATE POLICY "tenant_isolation_crm_lead_activities_insert" ON "public"."crm_lead_activities" FOR INSERT WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'tenant_isolation_crm_lead_activities_select' AND polrelid = '"public"."crm_lead_activities"'::regclass) THEN
CREATE POLICY "tenant_isolation_crm_lead_activities_select" ON "public"."crm_lead_activities" FOR SELECT USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'tenant_isolation_crm_lead_links_all' AND polrelid = '"public"."crm_lead_links"'::regclass) THEN
CREATE POLICY "tenant_isolation_crm_lead_links_all" ON "public"."crm_lead_links" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'tenant_isolation_crm_leads_all' AND polrelid = '"public"."crm_leads"'::regclass) THEN
CREATE POLICY "tenant_isolation_crm_leads_all" ON "public"."crm_leads" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'tenant_isolation_crm_pipelines_all' AND polrelid = '"public"."crm_pipelines"'::regclass) THEN
CREATE POLICY "tenant_isolation_crm_pipelines_all" ON "public"."crm_pipelines" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'tenant_isolation_crm_stages_all' AND polrelid = '"public"."crm_stages"'::regclass) THEN
CREATE POLICY "tenant_isolation_crm_stages_all" ON "public"."crm_stages" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'tenant_isolation_storage_redaction_queue_all' AND polrelid = '"public"."storage_redaction_queue"'::regclass) THEN
CREATE POLICY "tenant_isolation_storage_redaction_queue_all" ON "public"."storage_redaction_queue" USING (("organization_id" IN ( SELECT "fn_user_org_ids"."fn_user_org_ids"
   FROM "public"."fn_user_org_ids"() "fn_user_org_ids"("fn_user_org_ids")))) WITH CHECK (("organization_id" IN ( SELECT "fn_user_org_ids"."fn_user_org_ids"
   FROM "public"."fn_user_org_ids"() "fn_user_org_ids"("fn_user_org_ids"))));
END IF; END $baseline_guard$;



ALTER TABLE "public"."user_organizations" ENABLE ROW LEVEL SECURITY;


DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'user_orgs_delete' AND polrelid = '"public"."user_organizations"'::regclass) THEN
CREATE POLICY "user_orgs_delete" ON "public"."user_organizations" FOR DELETE USING (("public"."fn_role_at_least"("organization_id", 'admin'::"text") OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'user_orgs_insert' AND polrelid = '"public"."user_organizations"'::regclass) THEN
CREATE POLICY "user_orgs_insert" ON "public"."user_organizations" FOR INSERT WITH CHECK (("public"."fn_role_at_least"("organization_id", 'admin'::"text") OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'user_orgs_select' AND polrelid = '"public"."user_organizations"'::regclass) THEN
CREATE POLICY "user_orgs_select" ON "public"."user_organizations" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR "public"."fn_role_at_least"("organization_id", 'admin'::"text") OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'user_orgs_update' AND polrelid = '"public"."user_organizations"'::regclass) THEN
CREATE POLICY "user_orgs_update" ON "public"."user_organizations" FOR UPDATE USING (("public"."fn_role_at_least"("organization_id", 'admin'::"text") OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



ALTER TABLE "public"."user_recovery_codes" ENABLE ROW LEVEL SECURITY;


DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'warmup_tenant_isolation_all' AND polrelid = '"public"."channel_session_warmup"'::regclass) THEN
CREATE POLICY "warmup_tenant_isolation_all" ON "public"."channel_session_warmup" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));
END IF; END $baseline_guard$;



ALTER TABLE "public"."webhook_events_log" ENABLE ROW LEVEL SECURITY;


DO $baseline_guard$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_policy
                WHERE polname = 'webhook_events_log_tenant_read' AND polrelid = '"public"."webhook_events_log"'::regclass) THEN
CREATE POLICY "webhook_events_log_tenant_read" ON "public"."webhook_events_log" FOR SELECT USING (("public"."fn_is_platform_admin"() OR (("organization_id" IS NOT NULL) AND ("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")))));
END IF; END $baseline_guard$;



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "public"."activate_kb_version"("p_agent_id" "uuid", "p_version_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."activate_kb_version"("p_agent_id" "uuid", "p_version_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."activate_kb_version"("p_agent_id" "uuid", "p_version_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."emit_event"("p_event_type" "text", "p_entity_kind" "text", "p_entity_id" "uuid", "p_payload" "jsonb", "p_metadata" "jsonb", "p_organization_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."emit_event"("p_event_type" "text", "p_entity_kind" "text", "p_entity_id" "uuid", "p_payload" "jsonb", "p_metadata" "jsonb", "p_organization_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_audit_log_row"() TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_crm_lead_close_on_stage"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_crm_lead_close_on_stage"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_crm_lead_close_on_stage"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."fn_decrypt_oauth"("ciphertext" "bytea") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fn_decrypt_oauth"("ciphertext" "bytea") TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_emit_channel_session_status_changed"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_emit_channel_session_status_changed"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_emit_channel_session_status_changed"() TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_emit_event_on_lead_change"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_emit_event_on_lead_change"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_emit_event_on_lead_change"() TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_emit_message_event"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_emit_message_event"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_emit_message_event"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."fn_encrypt_oauth"("plaintext" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fn_encrypt_oauth"("plaintext" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_is_platform_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_is_platform_admin"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."fn_lgpd_cascade_redact_contact"("p_organization_id" "uuid", "p_contact_id" "uuid", "p_request_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fn_lgpd_cascade_redact_contact"("p_organization_id" "uuid", "p_contact_id" "uuid", "p_request_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_log_event"("p_organization_id" "uuid", "p_event_type" "text", "p_payload" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_log_event"("p_organization_id" "uuid", "p_event_type" "text", "p_payload" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_publish_ai_agent_version"("p_org_id" "uuid", "p_agent_id" "uuid", "p_version_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."fn_publish_ai_agent_version"("p_org_id" "uuid", "p_agent_id" "uuid", "p_version_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_publish_ai_agent_version"("p_org_id" "uuid", "p_agent_id" "uuid", "p_version_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_role_at_least"("p_org" "uuid", "p_min" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_role_at_least"("p_org" "uuid", "p_min" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_seed_default_pipeline_for_org"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_seed_default_pipeline_for_org"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_seed_default_pipeline_for_org"() TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_touch_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_touch_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_touch_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."fn_update_budget_consumption"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fn_update_budget_consumption"() TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_update_last_activity_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_update_last_activity_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_update_last_activity_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_user_org_ids"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_user_org_ids"() TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_user_role_in"("p_org" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_user_role_in"("p_org" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_user_role_in_org"("p_org" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_user_role_in_org"("p_org" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_validate_activity_lead_org"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_validate_activity_lead_org"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_validate_activity_lead_org"() TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_validate_lost_reason_required"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_validate_lost_reason_required"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_validate_lost_reason_required"() TO "service_role";



GRANT ALL ON FUNCTION "public"."midpoint"("p_prev" numeric, "p_next" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."midpoint"("p_prev" numeric, "p_next" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."midpoint"("p_prev" numeric, "p_next" numeric) TO "service_role";



REVOKE ALL ON FUNCTION "public"."retrieve_top_k_chunks"("p_organization_id" "uuid", "p_kb_version_id" "uuid", "p_embedding" "public"."vector", "p_k" integer, "p_threshold" real) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."retrieve_top_k_chunks"("p_organization_id" "uuid", "p_kb_version_id" "uuid", "p_embedding" "public"."vector", "p_k" integer, "p_threshold" real) TO "authenticated";
GRANT ALL ON FUNCTION "public"."retrieve_top_k_chunks"("p_organization_id" "uuid", "p_kb_version_id" "uuid", "p_embedding" "public"."vector", "p_k" integer, "p_threshold" real) TO "service_role";



GRANT ALL ON TABLE "public"."ai_agent_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_agent_runs" TO "service_role";



GRANT ALL ON TABLE "public"."ai_agent_versions" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_agent_versions" TO "service_role";



GRANT ALL ON TABLE "public"."ai_agents" TO "anon";
GRANT ALL ON TABLE "public"."ai_agents" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_agents" TO "service_role";



GRANT ALL ON TABLE "public"."ai_budgets" TO "anon";
GRANT ALL ON TABLE "public"."ai_budgets" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_budgets" TO "service_role";



GRANT ALL ON TABLE "public"."ai_chunks" TO "anon";
GRANT ALL ON TABLE "public"."ai_chunks" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_chunks" TO "service_role";



GRANT ALL ON TABLE "public"."ai_faq_items" TO "anon";
GRANT ALL ON TABLE "public"."ai_faq_items" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_faq_items" TO "service_role";



GRANT ALL ON TABLE "public"."ai_invocations" TO "anon";
GRANT ALL ON TABLE "public"."ai_invocations" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_invocations" TO "service_role";



GRANT ALL ON TABLE "public"."ai_knowledge_sources" TO "anon";
GRANT ALL ON TABLE "public"."ai_knowledge_sources" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_knowledge_sources" TO "service_role";



GRANT ALL ON TABLE "public"."ai_knowledge_versions" TO "anon";
GRANT ALL ON TABLE "public"."ai_knowledge_versions" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_knowledge_versions" TO "service_role";



GRANT ALL ON TABLE "public"."ai_models" TO "anon";
GRANT ALL ON TABLE "public"."ai_models" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_models" TO "service_role";



GRANT ALL ON TABLE "public"."ai_pricing" TO "anon";
GRANT ALL ON TABLE "public"."ai_pricing" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_pricing" TO "service_role";



GRANT ALL ON TABLE "public"."ai_provider_credentials" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_provider_credentials" TO "service_role";



GRANT ALL ON TABLE "public"."ai_provider_credentials_safe" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_provider_credentials_safe" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."api_audit_log" TO "anon";
GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."api_audit_log" TO "authenticated";
GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."api_audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."api_tokens" TO "anon";
GRANT ALL ON TABLE "public"."api_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."api_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."channel_session_warmup" TO "anon";
GRANT ALL ON TABLE "public"."channel_session_warmup" TO "authenticated";
GRANT ALL ON TABLE "public"."channel_session_warmup" TO "service_role";



GRANT ALL ON TABLE "public"."channel_sessions" TO "anon";
GRANT ALL ON TABLE "public"."channel_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."channel_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."contacts" TO "anon";
GRANT ALL ON TABLE "public"."contacts" TO "authenticated";
GRANT ALL ON TABLE "public"."contacts" TO "service_role";



GRANT ALL ON TABLE "public"."conversations" TO "anon";
GRANT ALL ON TABLE "public"."conversations" TO "authenticated";
GRANT ALL ON TABLE "public"."conversations" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."crm_lead_activities" TO "anon";
GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."crm_lead_activities" TO "authenticated";
GRANT ALL ON TABLE "public"."crm_lead_activities" TO "service_role";



GRANT ALL ON TABLE "public"."crm_lead_links" TO "anon";
GRANT ALL ON TABLE "public"."crm_lead_links" TO "authenticated";
GRANT ALL ON TABLE "public"."crm_lead_links" TO "service_role";



GRANT ALL ON TABLE "public"."crm_leads" TO "anon";
GRANT ALL ON TABLE "public"."crm_leads" TO "authenticated";
GRANT ALL ON TABLE "public"."crm_leads" TO "service_role";



GRANT ALL ON TABLE "public"."crm_pipelines" TO "anon";
GRANT ALL ON TABLE "public"."crm_pipelines" TO "authenticated";
GRANT ALL ON TABLE "public"."crm_pipelines" TO "service_role";



GRANT ALL ON TABLE "public"."crm_stages" TO "anon";
GRANT ALL ON TABLE "public"."crm_stages" TO "authenticated";
GRANT ALL ON TABLE "public"."crm_stages" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."event_log" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."event_log" TO "authenticated";
GRANT ALL ON TABLE "public"."event_log" TO "service_role";



GRANT ALL ON TABLE "public"."idempotency_keys" TO "anon";
GRANT ALL ON TABLE "public"."idempotency_keys" TO "authenticated";
GRANT ALL ON TABLE "public"."idempotency_keys" TO "service_role";



GRANT ALL ON TABLE "public"."incidents" TO "anon";
GRANT ALL ON TABLE "public"."incidents" TO "authenticated";
GRANT ALL ON TABLE "public"."incidents" TO "service_role";



GRANT ALL ON TABLE "public"."lgpd_requests" TO "anon";
GRANT ALL ON TABLE "public"."lgpd_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."lgpd_requests" TO "service_role";



GRANT ALL ON TABLE "public"."merge_queue" TO "anon";
GRANT ALL ON TABLE "public"."merge_queue" TO "authenticated";
GRANT ALL ON TABLE "public"."merge_queue" TO "service_role";



GRANT ALL ON TABLE "public"."messages" TO "anon";
GRANT ALL ON TABLE "public"."messages" TO "authenticated";
GRANT ALL ON TABLE "public"."messages" TO "service_role";



GRANT ALL ON TABLE "public"."nuvemshop_products" TO "anon";
GRANT ALL ON TABLE "public"."nuvemshop_products" TO "authenticated";
GRANT ALL ON TABLE "public"."nuvemshop_products" TO "service_role";



GRANT ALL ON TABLE "public"."orders" TO "anon";
GRANT ALL ON TABLE "public"."orders" TO "authenticated";
GRANT ALL ON TABLE "public"."orders" TO "service_role";



GRANT ALL ON TABLE "public"."organizations" TO "anon";
GRANT ALL ON TABLE "public"."organizations" TO "authenticated";
GRANT ALL ON TABLE "public"."organizations" TO "service_role";



GRANT ALL ON TABLE "public"."platform_admins" TO "anon";
GRANT ALL ON TABLE "public"."platform_admins" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_admins" TO "service_role";



GRANT ALL ON TABLE "public"."storage_redaction_queue" TO "authenticated";
GRANT ALL ON TABLE "public"."storage_redaction_queue" TO "service_role";



GRANT ALL ON TABLE "public"."tenant_integrations" TO "anon";
GRANT ALL ON TABLE "public"."tenant_integrations" TO "authenticated";
GRANT ALL ON TABLE "public"."tenant_integrations" TO "service_role";



GRANT ALL ON TABLE "public"."user_organizations" TO "anon";
GRANT ALL ON TABLE "public"."user_organizations" TO "authenticated";
GRANT ALL ON TABLE "public"."user_organizations" TO "service_role";



GRANT ALL ON TABLE "public"."user_recovery_codes" TO "anon";
GRANT ALL ON TABLE "public"."user_recovery_codes" TO "authenticated";
GRANT ALL ON TABLE "public"."user_recovery_codes" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."webhook_events_log" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."webhook_events_log" TO "authenticated";
GRANT ALL ON TABLE "public"."webhook_events_log" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";








-- ============================================================================
-- COMPLEMENTO DO BASELINE (não capturado pelo dump --schema public):
--   storage buckets + policies (migrations 0014/0017) e realtime publication.
--   Aplicar DEPOIS do schema public (dependem de public.user_organizations).
-- ============================================================================

-- ---- storage: bucket ai-policy + policies (migration 0014) ----

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ai-policy',
  'ai-policy',
  false,
  20971520,
  array['application/pdf', 'text/markdown', 'text/x-markdown', 'text/plain']
)
on conflict (id) do nothing;

drop policy if exists "tenant_read_ai_policy" on storage.objects;
create policy "tenant_read_ai_policy" on storage.objects for select
  using (
    bucket_id = 'ai-policy'
    and exists (
      select 1 from public.user_organizations uo
      where uo.user_id = auth.uid()
        and uo.revoked_at is null
        and uo.organization_id = (split_part(name, '/', 1))::uuid
    )
  );

drop policy if exists "tenant_write_ai_policy" on storage.objects;
create policy "tenant_write_ai_policy" on storage.objects for insert
  with check (
    bucket_id = 'ai-policy'
    and exists (
      select 1 from public.user_organizations uo
      where uo.user_id = auth.uid()
        and uo.revoked_at is null
        and uo.organization_id = (split_part(name, '/', 1))::uuid
    )
  );

drop policy if exists "tenant_delete_ai_policy" on storage.objects;
create policy "tenant_delete_ai_policy" on storage.objects for delete
  using (
    bucket_id = 'ai-policy'
    and exists (
      select 1 from public.user_organizations uo
      where uo.user_id = auth.uid()
        and uo.revoked_at is null
        and uo.organization_id = (split_part(name, '/', 1))::uuid
    )
  );

-- ---- storage: bucket lgpd-exports + policy (migration 0017) ----

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'lgpd-exports',
  'lgpd-exports',
  false,
  52428800,
  array['application/pdf', 'application/json']
)
on conflict (id) do nothing;

drop policy if exists "tenant_read_lgpd_exports" on storage.objects;
create policy "tenant_read_lgpd_exports" on storage.objects for select
  using (
    bucket_id = 'lgpd-exports'
    and exists (
      select 1 from public.user_organizations uo
      where uo.user_id = auth.uid()
        and uo.revoked_at is null
        and uo.organization_id = (split_part(name, '/', 1))::uuid
    )
  );

-- ---- bucket de assets de skills (migration 0068) ----
insert into storage.buckets (id, name, public, file_size_limit)
values ('skill-assets', 'skill-assets', false, 5242880)
on conflict (id) do nothing;

-- Leitura por org (path {org_id}/...) OU plataforma (path platform/...) por qualquer
-- usuário autenticado (assets de plataforma são públicos p/ tenants; conteúdo é curado).
drop policy if exists "skill_assets_read" on storage.objects;
create policy "skill_assets_read" on storage.objects for select to authenticated
  using (
    bucket_id = 'skill-assets'
    and (
      split_part(name, '/', 1) = 'platform'
      or exists (
        select 1 from public.user_organizations uo
        where uo.user_id = auth.uid() and uo.revoked_at is null
          and uo.organization_id = (split_part(name, '/', 1))::uuid
      )
    )
  );
-- Escrita/DELETE de assets é sempre via service role (rota de import) — sem policy de write.

-- ---- realtime: inbox (messages/conversations), kanban (crm_leads) e IA ----
do $$ begin
  if not exists (select 1 from pg_publication where pubname='supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
do $$
declare t text;
begin
  -- crm_lead_activities (migration 0071): o dossiê assina a timeline filtrada
  -- por lead_id (§3.5). O board não assina esta tabela — ele escuta crm_leads
  -- por pipeline_id, e toda atividade toca o lead via fn_update_last_activity_at.
  foreach t in array array['messages','conversations','crm_leads','ai_agents','ai_agent_runs','ai_knowledge_sources','crm_lead_activities']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename=t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---- ai_models: catálogo curado global (migration 0023, §Seed Spec 10 §2.2) ----
-- Também não capturado pelo dump --schema-only. Sem isto, /api/v1/ai/providers/:p/models
-- devolve lista vazia pra todo provedor e o seletor de modelo do agente fica sem opções.
insert into public.ai_models (provider, model_id, display_name, description, context_window, input_price_per_million_cents, output_price_per_million_cents, supports_tools, is_default_for_provider)
values
  ('anthropic', 'claude-opus-4-7',    'Claude Opus 4.7',    'Flagship Anthropic — raciocínio complexo',                  200000,  1500, 7500, true, false),
  ('anthropic', 'claude-sonnet-4-6',  'Claude Sonnet 4.6',  'Default recomendado — equilíbrio custo/qualidade',           200000,   300, 1500, true, true),
  ('anthropic', 'claude-haiku-4-5',   'Claude Haiku 4.5',   'Cheap/fast — atendimentos curtos e classificação',           200000,   100,  500, true, false),
  ('openai',    'gpt-5',              'GPT-5',              'Flagship OpenAI',                                           400000,   500, 4000, true, false),
  ('openai',    'gpt-5-mini',         'GPT-5 Mini',         'Cheap/fast OpenAI',                                         400000,   150,  600, true, true),
  ('openai',    'gpt-4o',             'GPT-4o (legacy)',    'Compat — uso legado',                                       128000,   250, 1000, true, false),
  ('google',    'gemini-2.5-pro',     'Gemini 2.5 Pro',     'Flagship Google',                                          1000000,   125,  500, true, false),
  ('google',    'gemini-2.5-flash',   'Gemini 2.5 Flash',   'Cheap/fast Google',                                        1000000,    30,  120, true, true)
on conflict (provider, model_id) do nothing;

-- ---- WhatsApp: unificação de conversas por contato (migration 0027) ----
-- O dump --schema-only não traz mudanças pós-snapshot. Sem este bloco, clones
-- (install.sh) e clones atualizando (update.sh, que re-aplica baseline.sql)
-- ficam com o bug: 1 pessoa vira N contatos/conversas (WAHA emite
-- message+message.any por mensagem; contatos @lid sem unique + check-then-act).
-- Idempotente e AUTO-CURATIVO: em banco novo o dedup é no-op; em clone já bugado
-- ele deduplica o histórico ANTES de criar as constraints. Ver a migration
-- 20260706210000_0027_whatsapp_conversation_unification.sql para o detalhe.

-- A. Identidade canônica (generated)
alter table public.contacts
  add column if not exists wa_identity text
  generated always as (
    case
      when phone_number is not null then 'phone:' || phone_number
      when source_metadata->>'waha_lid' is not null
        then 'lid:' || regexp_replace(source_metadata->>'waha_lid', '@.*$', '')
      else null
    end
  ) stored;

-- B1. Merge de contatos duplicados (usa is_merged_into como mapa; sem temp tables)
with ranked as (
  select id, first_value(id) over (partition by organization_id, wa_identity order by created_at asc, id asc) as canonical_id
  from public.contacts where wa_identity is not null and is_merged_into is null
)
update public.contacts c set is_merged_into = r.canonical_id, merged_at = now()
from ranked r where c.id = r.id and r.id <> r.canonical_id;

update public.conversations       t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.messages            t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.ai_agent_runs       t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.crm_lead_activities t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.crm_leads           t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.lgpd_requests       t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.orders              t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;

update public.contacts can set display_name = better.name
from (
  select coalesce(c.is_merged_into, c.id) as canonical_id,
    (array_agg(c.display_name order by (c.display_name ~ '^Contato ') asc, c.created_at asc)
       filter (where c.display_name is not null and c.display_name <> ''))[1] as name
  from public.contacts c
  where coalesce(c.is_merged_into, c.id) in (select is_merged_into from public.contacts where is_merged_into is not null)
  group by 1
) better
where can.id = better.canonical_id and better.name is not null
  and (can.display_name is null or can.display_name = '' or can.display_name ~ '^Contato ');

-- B2. Merge de conversas 1:1 duplicadas
update public.messages t set conversation_id = canon.canonical_id
from (select id, first_value(id) over (partition by organization_id, contact_id, channel_session_id order by created_at asc, id asc) as canonical_id from public.conversations where is_group = false) canon
where t.conversation_id = canon.id and canon.id <> canon.canonical_id;
update public.ai_agent_runs t set conversation_id = canon.canonical_id
from (select id, first_value(id) over (partition by organization_id, contact_id, channel_session_id order by created_at asc, id asc) as canonical_id from public.conversations where is_group = false) canon
where t.conversation_id = canon.id and canon.id <> canon.canonical_id;
update public.ai_invocations t set conversation_id = canon.canonical_id
from (select id, first_value(id) over (partition by organization_id, contact_id, channel_session_id order by created_at asc, id asc) as canonical_id from public.conversations where is_group = false) canon
where t.conversation_id = canon.id and canon.id <> canon.canonical_id;
delete from public.conversations d
using (select id, first_value(id) over (partition by organization_id, contact_id, channel_session_id order by created_at asc, id asc) as canonical_id from public.conversations where is_group = false) canon
where d.id = canon.id and canon.id <> canon.canonical_id;

-- C. Constraints anti-reduplicação
create unique index if not exists uniq_contacts_org_wa_identity
  on public.contacts (organization_id, wa_identity)
  where wa_identity is not null and is_merged_into is null;
create unique index if not exists uniq_conversations_1to1_per_contact_session
  on public.conversations (organization_id, contact_id, channel_session_id)
  where is_group = false;

-- D. Upsert atômico (a aplicação usa via lib/waha/ingest.ts)
create or replace function public.fn_upsert_wa_contact(
  p_org uuid, p_kind text, p_phone text, p_lid text, p_chat_id text, p_notify text
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.contacts (organization_id, phone_number, source, consent, tags, source_metadata, display_name)
  values (p_org, case when p_kind = 'phone' then p_phone end, 'whatsapp', '{}'::jsonb, '{}'::text[],
    case when p_kind = 'lid' then jsonb_build_object('waha_lid', p_lid, 'notify_name', nullif(p_notify, ''))
      else jsonb_build_object('waha_chat_id', p_chat_id, 'notify_name', nullif(p_notify, '')) end,
    nullif(p_notify, ''))
  on conflict (organization_id, wa_identity) where wa_identity is not null and is_merged_into is null
  do update set display_name = coalesce(contacts.display_name, excluded.display_name), updated_at = now()
  returning id into v_id;
  return v_id;
end; $$;

create or replace function public.fn_upsert_wa_conversation(
  p_org uuid, p_contact uuid, p_session uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.conversations (organization_id, contact_id, channel_session_id, channel, status, is_group, unread_count_for_assignee, metadata)
  values (p_org, p_contact, p_session, 'whatsapp', 'open', false, 0, '{}'::jsonb)
  on conflict (organization_id, contact_id, channel_session_id) where is_group = false
  do update set updated_at = now()
  returning id into v_id;
  return v_id;
end; $$;

create or replace function public.fn_mark_conversation_message(
  p_conv uuid, p_direction text, p_preview text, p_at timestamptz
) returns void language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set
    last_message_at = p_at, last_message_preview = p_preview,
    last_inbound_at  = case when p_direction = 'inbound'  then p_at else last_inbound_at  end,
    last_outbound_at = case when p_direction = 'outbound' then p_at else last_outbound_at end,
    unread_count_for_assignee = case
      when p_direction = 'inbound'  then unread_count_for_assignee + 1
      when p_direction = 'outbound' then 0
      else unread_count_for_assignee
    end,
    updated_at = now()
  where id = p_conv;
end; $$;

revoke all on function public.fn_upsert_wa_contact(uuid, text, text, text, text, text) from public;
revoke all on function public.fn_upsert_wa_conversation(uuid, uuid, uuid) from public;
revoke all on function public.fn_mark_conversation_message(uuid, text, text, timestamptz) from public;
grant execute on function public.fn_upsert_wa_contact(uuid, text, text, text, text, text) to service_role;
grant execute on function public.fn_upsert_wa_conversation(uuid, uuid, uuid) to service_role;
grant execute on function public.fn_mark_conversation_message(uuid, text, text, timestamptz) to service_role;

-- ---- RLS por role em tabelas de config + viewer read-only (migration 0030) ----
-- G2-03: spec 13 §4 — pipelines/stages (config) write manager+; conversations
-- write agent+ (viewer read-only). SELECT permanece org-flat (escopo own é G4).
-- Idempotente: drop if exists + create (auto-curativo no update.sh de clones).

drop policy if exists "tenant_isolation_crm_pipelines_all" on public.crm_pipelines;
drop policy if exists "crm_pipelines_select" on public.crm_pipelines;
drop policy if exists "crm_pipelines_manager_write" on public.crm_pipelines;

create policy "crm_pipelines_select" on public.crm_pipelines
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

create policy "crm_pipelines_manager_write" on public.crm_pipelines
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists "tenant_isolation_crm_stages_all" on public.crm_stages;
drop policy if exists "crm_stages_select" on public.crm_stages;
drop policy if exists "crm_stages_manager_write" on public.crm_stages;

create policy "crm_stages_select" on public.crm_stages
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

create policy "crm_stages_manager_write" on public.crm_stages
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists "conversations_tenant_isolation_all" on public.conversations;
drop policy if exists "conversations_select" on public.conversations;
drop policy if exists "conversations_agent_write" on public.conversations;

create policy "conversations_select" on public.conversations
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

create policy "conversations_agent_write" on public.conversations
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

-- ---- Auditoria de atribuição de conversas + fn_conversation_assign (migration 0031) ----
-- G3-01 (gov-loop): toda mudança de dono de conversa vira evento estruturado
-- (spec 13 §3.1) e as rotas de claim/transfer/release passam a mudar o dono via
-- fn_conversation_assign — UPDATE condicional + INSERT do evento na MESMA
-- transação (spec 04 §9; 0 rows = optimistic lock perdeu → 409). Idempotente:
-- em clone atualizado é no-op; sem dados a corrigir.

create table if not exists public.conversation_assignment_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  from_user_id    uuid references auth.users(id) on delete set null,
  to_user_id      uuid references auth.users(id) on delete set null,
  changed_by      uuid references auth.users(id) on delete set null,
  reason          text not null
                  check (reason in ('claim','transfer','release','routing','handoff')),
  created_at      timestamptz not null default now()
);

create index if not exists idx_cae_conversation
  on public.conversation_assignment_events (conversation_id, created_at desc);

alter table public.conversation_assignment_events enable row level security;

drop policy if exists cae_select on public.conversation_assignment_events;
create policy cae_select on public.conversation_assignment_events
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

drop policy if exists cae_insert on public.conversation_assignment_events;
create policy cae_insert on public.conversation_assignment_events
  for insert with check (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

revoke all on public.conversation_assignment_events from anon;

create or replace function public.fn_conversation_assign(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_to_user_id uuid,
  p_reason text,
  p_expected_assignee uuid default null,
  p_enforce_expected boolean default false
) returns setof public.conversations
language plpgsql
set search_path = public
as $$
declare
  v_from uuid;
  v_conv public.conversations%rowtype;
begin
  select assigned_to_user_id into v_from
    from public.conversations
   where id = p_conversation_id
     and organization_id = p_organization_id
   for update;

  if not found then
    return;
  end if;

  if p_enforce_expected and v_from is distinct from p_expected_assignee then
    return;
  end if;

  update public.conversations
     set assigned_to_user_id = p_to_user_id,
         assigned_at = case when p_to_user_id is null then null else now() end,
         status = case when p_to_user_id is null then 'open' else 'claimed' end,
         status_changed_at = now(),
         unread_count_for_assignee = 0,
         updated_at = now()
   where id = p_conversation_id
   returning * into v_conv;

  insert into public.conversation_assignment_events
    (organization_id, conversation_id, from_user_id, to_user_id, changed_by, reason)
  values
    (p_organization_id, p_conversation_id, v_from, p_to_user_id, auth.uid(), p_reason);

  return next v_conv;
end;
$$;

revoke all on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean) from public;
grant execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean)
  to authenticated, service_role;

-- ---- assignee_kind + guard de membership na fn_conversation_assign (migration 0032) ----
-- G3-02 (gov-loop): IA como assignee de 1ª classe (spec 13 §3.2). Coluna
-- conversations.assignee_kind ('user'|'ai') + CHECK de coerência em forma de
-- implicação (kind='user' ⇒ dono humano; kind='ai' ⇒ sem dono; kind null livre
-- pra escritas legadas). Backfill ANTES da constraint (auto-curativo em clones).
-- Forward-fix INB-06a: fn_conversation_assign valida DENTRO da função que o
-- destino é membro ativo agent+ da org (via fn_member_role_in_org, SECURITY
-- DEFINER) e mantém assignee_kind coerente em claim/transfer/release/handoff.
-- fn_member_role_in_org é executável APENAS por authenticated (responde só a
-- membro ativo da org) e service_role (auth.uid() null); anon tem EXECUTE
-- revogado EXPLICITAMENTE — o default privilege do Supabase concede EXECUTE a
-- anon em toda função nova e o JWT anon também tem uid null.

alter table public.conversations
  add column if not exists assignee_kind text
  check (assignee_kind in ('user','ai'));

update public.conversations
   set assignee_kind = 'user'
 where assigned_to_user_id is not null
   and assignee_kind is distinct from 'user';

update public.conversations
   set assignee_kind = null
 where assigned_to_user_id is null
   and assignee_kind = 'user';

update public.conversations
   set assignee_kind = 'ai'
 where status = 'ai_handling'
   and assigned_to_user_id is null
   and assignee_kind is distinct from 'ai';

alter table public.conversations
  drop constraint if exists conversations_assignee_kind_coherence;
alter table public.conversations
  add constraint conversations_assignee_kind_coherence check (
    (assignee_kind = 'user' and assigned_to_user_id is not null) or
    (assignee_kind = 'ai'   and assigned_to_user_id is null)     or
    (assignee_kind is null)
  );

create or replace function public.fn_member_role_in_org(p_user uuid, p_org uuid)
returns text
language sql stable security definer
set search_path = public
as $$
  select uo.role
    from public.user_organizations uo
   where uo.user_id = p_user
     and uo.organization_id = p_org
     and uo.revoked_at is null
     and (
       auth.uid() is null
       or exists (
         select 1 from public.user_organizations me
          where me.user_id = auth.uid()
            and me.organization_id = p_org
            and me.revoked_at is null
       )
     )
   limit 1;
$$;

revoke all on function public.fn_member_role_in_org(uuid, uuid) from public;
-- O revoke from public NÃO cobre o grant DIRETO que anon carrega via
-- ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon (padrão
-- Supabase). Sem esta linha, o PostgREST expõe a função como RPC pública
-- (anon key vai pro browser) e o ramo auth.uid() null responde a request
-- anônimo — enumeração de membership/role de qualquer tenant.
revoke execute on function public.fn_member_role_in_org(uuid, uuid) from anon;
grant execute on function public.fn_member_role_in_org(uuid, uuid)
  to authenticated, service_role;

create or replace function public.fn_conversation_assign(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_to_user_id uuid,
  p_reason text,
  p_expected_assignee uuid default null,
  p_enforce_expected boolean default false
) returns setof public.conversations
language plpgsql
set search_path = public
as $$
declare
  v_from uuid;
  v_conv public.conversations%rowtype;
begin
  if p_to_user_id is not null then
    if coalesce(public.fn_member_role_in_org(p_to_user_id, p_organization_id), 'none')
         not in ('agent','manager','admin') then
      raise exception 'assignee_not_eligible_member'
        using hint = 'target must be an active agent+ member of the organization';
    end if;
  end if;

  select assigned_to_user_id into v_from
    from public.conversations
   where id = p_conversation_id
     and organization_id = p_organization_id
   for update;

  if not found then
    return;
  end if;

  if p_enforce_expected and v_from is distinct from p_expected_assignee then
    return;
  end if;

  update public.conversations
     set assigned_to_user_id = p_to_user_id,
         assigned_at = case when p_to_user_id is null then null else now() end,
         assignee_kind = case when p_to_user_id is null then null else 'user' end,
         status = case when p_to_user_id is null then 'open' else 'claimed' end,
         status_changed_at = now(),
         unread_count_for_assignee = 0,
         updated_at = now()
   where id = p_conversation_id
   returning * into v_conv;

  insert into public.conversation_assignment_events
    (organization_id, conversation_id, from_user_id, to_user_id, changed_by, reason)
  values
    (p_organization_id, p_conversation_id, v_from, p_to_user_id, auth.uid(), p_reason);

  return next v_conv;
end;
$$;

revoke all on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean) from public;
grant execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean)
  to authenticated, service_role;


-- ---- conversation tags (migration 0033) ----
-- G3-05 (gov-loop): eixo 7 — tags de conversa (spec 13 §3.3). Mesmo shape de
-- contacts.tags/crm_leads.tags (text[] + GIN). Vocabulário canônico em
-- organizations.settings.canonical_conversation_tags (org-scoped), semeado só
-- onde ausente. Idempotente/auto-curativo.
alter table public.conversations
  add column if not exists tags text[] not null default '{}';

create index if not exists idx_conversations_tags_gin
  on public.conversations using gin (tags);

update public.organizations
   set settings = coalesce(settings, '{}'::jsonb)
       || jsonb_build_object(
            'canonical_conversation_tags',
            jsonb_build_array(
              'dúvida', 'reclamação', 'troca', 'devolução',
              'elogio', 'orçamento', 'pós-venda', 'urgente'
            )
          )
 where not (coalesce(settings, '{}'::jsonb) ? 'canonical_conversation_tags');


-- ---- revoke anon EXECUTE em SECURITY DEFINER de escrita (migration 0034) ----
-- G4-00 (gov-loop): defesa em profundidade (INB-07). Duas origens de EXECUTE a
-- anon: (A) grant DIRETO do ALTER DEFAULT PRIVILEGES ... TO anon acima (funções
-- criadas depois dele, já sem grant a PUBLIC) → revoke anon; (B) grant via
-- PUBLIC (funções criadas ANTES do ALTER e nunca revogadas de public) → revoke
-- public + re-afirma authenticated/service_role (call sites legítimos). Nenhum
-- fluxo anônimo depende delas. Idempotente/auto-curativo.
revoke execute on function public.fn_upsert_wa_contact(uuid, text, text, text, text, text) from anon;
revoke execute on function public.fn_upsert_wa_conversation(uuid, uuid, uuid) from anon;
revoke execute on function public.fn_mark_conversation_message(uuid, text, text, timestamptz) from anon;

revoke execute on function public.emit_event(text, text, uuid, jsonb, jsonb, uuid) from public;
revoke execute on function public.emit_event(text, text, uuid, jsonb, jsonb, uuid) from anon;
grant execute on function public.emit_event(text, text, uuid, jsonb, jsonb, uuid) to authenticated, service_role;

revoke execute on function public.fn_log_event(uuid, text, jsonb) from public;
revoke execute on function public.fn_log_event(uuid, text, jsonb) from anon;
grant execute on function public.fn_log_event(uuid, text, jsonb) to authenticated, service_role;

revoke execute on function public.fn_audit_log_row() from public;
revoke execute on function public.fn_audit_log_row() from anon;
grant execute on function public.fn_audit_log_row() to service_role;


-- ---- visibility_mode: RLS de conversas/mensagens por atendente (migration 0035) ----
-- G4-01 (gov-loop): eixo 5 (spec 13 §3.5 + §4). organizations.settings.visibility_mode
-- ('all'|'own_and_unassigned'|'own', default 'own_and_unassigned' — G1-06a) restringe o
-- SELECT de conversations/messages APENAS para o role agent; viewer/manager/admin seguem
-- org-wide read. fn_can_view_conversation recebe os campos da ROW (evita lookup/recursão
-- por-row); DEFINER + search_path blindado + revoke anon/public (lição G4-00). A escrita
-- 0030 era FOR ALL, cujo USING também governa SELECT (policies OR-adas) — por isso é
-- re-expressa por-comando (mesmo agent+/org; quem escreve não muda), removendo só o grant
-- implícito de SELECT. messages SELECT herda o escopo da conversa via exists(). Idempotente,
-- auto-curativo. Escrita não restringida; ingestão/outbound via service_role bypassa RLS.

create or replace function public.fn_can_view_conversation(
  p_org uuid,
  p_assigned_to_user_id uuid
) returns boolean
language sql stable security definer
set search_path = public
as $$
  select case
    when public.fn_is_platform_admin() then true
    when public.fn_user_role_in_org(p_org) is null then false
    when public.fn_user_role_in_org(p_org) in ('viewer','manager','admin') then true
    when p_assigned_to_user_id = auth.uid() then true
    else case coalesce(
           (select settings->>'visibility_mode' from public.organizations where id = p_org),
           'own_and_unassigned')
         when 'all' then true
         when 'own_and_unassigned' then p_assigned_to_user_id is null
         else false
       end
  end;
$$;

revoke all on function public.fn_can_view_conversation(uuid, uuid) from public;
revoke execute on function public.fn_can_view_conversation(uuid, uuid) from anon;
grant execute on function public.fn_can_view_conversation(uuid, uuid)
  to authenticated, service_role;

drop policy if exists "conversations_select" on public.conversations;
create policy "conversations_select" on public.conversations
  for select using (
    public.fn_can_view_conversation(organization_id, assigned_to_user_id)
  );

drop policy if exists "conversations_agent_write" on public.conversations;
drop policy if exists "conversations_agent_insert" on public.conversations;
drop policy if exists "conversations_agent_update" on public.conversations;
drop policy if exists "conversations_agent_delete" on public.conversations;

create policy "conversations_agent_insert" on public.conversations
  for insert with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );
create policy "conversations_agent_update" on public.conversations
  for update using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  ) with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );
create policy "conversations_agent_delete" on public.conversations
  for delete using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

drop policy if exists "messages_tenant_isolation_all" on public.messages;
drop policy if exists "messages_select" on public.messages;
drop policy if exists "messages_insert" on public.messages;
drop policy if exists "messages_update" on public.messages;
drop policy if exists "messages_delete" on public.messages;

create policy "messages_select" on public.messages
  for select using (
    public.fn_is_platform_admin()
    or exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id
    )
  );

create policy "messages_insert" on public.messages
  for insert with check (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );
create policy "messages_update" on public.messages
  for update using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  ) with check (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );
create policy "messages_delete" on public.messages
  for delete using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

-- Forward-fix do G4-01: fn_conversation_assign (0031/0032) passa a SECURITY
-- DEFINER. Com o SELECT de conversations visibility-aware, o `update ... returning
-- *` re-aplica a policy de SELECT à NOVA linha — numa transferência o dono passa a
-- ser outro atendente, invisível ao autor, e o RETURNING falharia. DEFINER bypassa
-- a RLS na escrita interna; a autorização do caller (antes garantida pela RLS
-- INVOKER) é re-afirmada dentro da função: agent+ ativo da MESMA org (service_role
-- com auth.uid() null é dispensado). Corpo idêntico ao 0032 fora o guard.
create or replace function public.fn_conversation_assign(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_to_user_id uuid,
  p_reason text,
  p_expected_assignee uuid default null,
  p_enforce_expected boolean default false
) returns setof public.conversations
language plpgsql security definer
set search_path = public
as $$
declare
  v_from uuid;
  v_conv public.conversations%rowtype;
begin
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'agent') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'caller must be an active agent+ member of the organization';
  end if;

  if p_to_user_id is not null then
    if coalesce(public.fn_member_role_in_org(p_to_user_id, p_organization_id), 'none')
         not in ('agent','manager','admin') then
      raise exception 'assignee_not_eligible_member'
        using hint = 'target must be an active agent+ member of the organization';
    end if;
  end if;

  select assigned_to_user_id into v_from
    from public.conversations
   where id = p_conversation_id
     and organization_id = p_organization_id
   for update;

  if not found then
    return;
  end if;

  if p_enforce_expected and v_from is distinct from p_expected_assignee then
    return;
  end if;

  update public.conversations
     set assigned_to_user_id = p_to_user_id,
         assigned_at = case when p_to_user_id is null then null else now() end,
         assignee_kind = case when p_to_user_id is null then null else 'user' end,
         status = case when p_to_user_id is null then 'open' else 'claimed' end,
         status_changed_at = now(),
         unread_count_for_assignee = 0,
         updated_at = now()
   where id = p_conversation_id
   returning * into v_conv;

  insert into public.conversation_assignment_events
    (organization_id, conversation_id, from_user_id, to_user_id, changed_by, reason)
  values
    (p_organization_id, p_conversation_id, v_from, p_to_user_id, auth.uid(), p_reason);

  return next v_conv;
end;
$$;

revoke all on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean) from public;
revoke execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean) from anon;
grant execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean)
  to authenticated, service_role;

-- ---- visibility_mode: RLS de crm_leads (kanban) por atendente (migration 0036) ----
-- G4-03 (gov-loop): eixo 5 (spec 13 §4 linha 220). Espelha a G4-01 (conversations,
-- 0035) para crm_leads — "dono" do lead = owner_user_id (não assigned_to). REUSE do
-- mesmo organizations.settings.visibility_mode ('all'|'own_and_unassigned'|'own',
-- default 'own_and_unassigned' — G1-06a; a matriz diz "mesmo escopo"). Só o role
-- agent é restrito; viewer/manager/admin org-wide read; platform_admin tudo.
-- fn_can_view_lead recebe os campos da ROW (sem lookup/recursão); DEFINER +
-- search_path blindado + revoke anon/public (lição G4-00). A FOR ALL org-flat
-- `tenant_isolation_crm_leads_all` governava SELECT junto (USING OR-ado) — dropada e
-- re-expressa por-comando: SELECT visibility-aware + escrita por-role (agent=own-scope
-- via a mesma fn, manager+=org-wide, viewer=none via piso 'agent'). Drag-and-drop de
-- lead próprio (UPDATE de stage/position sem mudar owner) passa; lead de outro agent
-- bloqueado; bulk assign (G3-04, ≥manager) intacto. Idempotente, auto-curativo.

create or replace function public.fn_can_view_lead(
  p_org uuid,
  p_owner_user_id uuid
) returns boolean
language sql stable security definer
set search_path = public
as $$
  select case
    when public.fn_is_platform_admin() then true
    when public.fn_user_role_in_org(p_org) is null then false
    when public.fn_user_role_in_org(p_org) in ('viewer','manager','admin') then true
    when p_owner_user_id = auth.uid() then true
    else case coalesce(
           (select settings->>'visibility_mode' from public.organizations where id = p_org),
           'own_and_unassigned')
         when 'all' then true
         when 'own_and_unassigned' then p_owner_user_id is null
         else false
       end
  end;
$$;

revoke all on function public.fn_can_view_lead(uuid, uuid) from public;
revoke execute on function public.fn_can_view_lead(uuid, uuid) from anon;
grant execute on function public.fn_can_view_lead(uuid, uuid)
  to authenticated, service_role;

drop policy if exists "tenant_isolation_crm_leads_all" on public.crm_leads;
drop policy if exists "crm_leads_select" on public.crm_leads;
drop policy if exists "crm_leads_insert" on public.crm_leads;
drop policy if exists "crm_leads_update" on public.crm_leads;
drop policy if exists "crm_leads_delete" on public.crm_leads;

create policy "crm_leads_select" on public.crm_leads
  for select using (
    public.fn_can_view_lead(organization_id, owner_user_id)
  );

create policy "crm_leads_insert" on public.crm_leads
  for insert with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent')
        and (public.fn_role_at_least(organization_id, 'manager')
             or public.fn_can_view_lead(organization_id, owner_user_id)))
  );
create policy "crm_leads_update" on public.crm_leads
  for update using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent')
        and (public.fn_role_at_least(organization_id, 'manager')
             or public.fn_can_view_lead(organization_id, owner_user_id)))
  ) with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent')
        and (public.fn_role_at_least(organization_id, 'manager')
             or public.fn_can_view_lead(organization_id, owner_user_id)))
  );
create policy "crm_leads_delete" on public.crm_leads
  for delete using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent')
        and (public.fn_role_at_least(organization_id, 'manager')
             or public.fn_can_view_lead(organization_id, owner_user_id)))
  );


-- ---- métricas por responsável: índices + fn_attendant_metrics (migration 0037) ----
-- spec 13 §6. Índices dedicados (won/lost por owner na janela de closed_at;
-- conversas por assignee org-leading) + agregação SECURITY INVOKER (a RLS de
-- crm_leads/conversations define o escopo por atendente). Idempotente.

create index if not exists idx_crm_leads_org_status_closed_owner
  on public.crm_leads (organization_id, status, closed_at, owner_user_id)
  where closed_at is not null;

create index if not exists idx_conversations_org_assignee_assigned
  on public.conversations (organization_id, assigned_to_user_id, assigned_at)
  where assigned_to_user_id is not null;

create or replace function public.fn_attendant_metrics(
  p_org uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_owner uuid default null
) returns jsonb
language sql stable
set search_path = public
as $$
  with
  lead_agg as (
    select
      owner_user_id as user_id,
      count(*) filter (where status = 'won')  as won,
      count(*) filter (where status = 'lost') as lost
    from public.crm_leads
    where organization_id = p_org
      and status in ('won', 'lost')
      and closed_at >= p_from and closed_at < p_to
      and owner_user_id is not null
      and (p_owner is null or owner_user_id = p_owner)
    group by owner_user_id
  ),
  conv_agg as (
    select
      assigned_to_user_id as user_id,
      count(*) as conversations_handled
    from public.conversations
    where organization_id = p_org
      and assigned_to_user_id is not null
      and assigned_at >= p_from and assigned_at < p_to
      and (p_owner is null or assigned_to_user_id = p_owner)
    group by assigned_to_user_id
  ),
  ttfr as (
    select
      c.assigned_to_user_id as user_id,
      avg(extract(epoch from (fr.first_human_out - fr.first_in))) as avg_first_response_seconds
    from public.conversations c
    cross join lateral (
      select
        min(m.sent_at) filter (where m.direction = 'inbound') as first_in,
        min(m.sent_at) filter (
          where m.direction = 'outbound' and m.sent_by_user_id is not null
        ) as first_human_out
      from public.messages m
      where m.conversation_id = c.id
    ) fr
    where c.organization_id = p_org
      and c.assigned_to_user_id is not null
      and (p_owner is null or c.assigned_to_user_id = p_owner)
      and fr.first_in is not null
      and fr.first_human_out is not null
      and fr.first_human_out > fr.first_in
      and fr.first_human_out >= p_from and fr.first_human_out < p_to
    group by c.assigned_to_user_id
  ),
  attendant_ids as (
    select user_id from lead_agg
    union select user_id from conv_agg
    union select user_id from ttfr
  )
  select jsonb_build_object(
    'funnel', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'stage_id', s.id,
          'stage_name', s.name,
          'position', s.position,
          'count', coalesce(l.cnt, 0)
        ) order by s.position, s.name
      )
      from public.crm_stages s
      left join (
        select stage_id, count(*) as cnt
        from public.crm_leads
        where organization_id = p_org
          and status = 'open'
          and (p_owner is null or owner_user_id = p_owner)
        group by stage_id
      ) l on l.stage_id = s.id
      where s.organization_id = p_org
        and s.is_archived = false
    ), '[]'::jsonb),
    'attendants', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'user_id', a.user_id,
          'won', coalesce(la.won, 0),
          'lost', coalesce(la.lost, 0),
          'conversations_handled', coalesce(ca.conversations_handled, 0),
          'avg_first_response_seconds', tf.avg_first_response_seconds
        ) order by coalesce(la.won, 0) desc, a.user_id
      )
      from attendant_ids a
      left join lead_agg la on la.user_id = a.user_id
      left join conv_agg ca on ca.user_id = a.user_id
      left join ttfr tf on tf.user_id = a.user_id
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.fn_attendant_metrics(uuid, timestamptz, timestamptz, uuid) from public;
revoke execute on function public.fn_attendant_metrics(uuid, timestamptz, timestamptz, uuid) from anon;
grant execute on function public.fn_attendant_metrics(uuid, timestamptz, timestamptz, uuid)
  to authenticated, service_role;


-- ---- webhooks universais + motor de regras (migration 0038) ----
-- Spec: docs/superpowers/specs/2026-07-17-webhooks-design.md. Idempotente
-- (create if not exists / drop policy if exists) — auto-curativo no update.sh.

create table if not exists public.webhook_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  path_token text not null unique,
  secret text,
  kind text not null default 'lead_capture' check (kind in ('lead_capture')),
  default_pipeline_id uuid not null references public.crm_pipelines(id) on delete cascade,
  default_stage_id uuid not null references public.crm_stages(id) on delete cascade,
  field_map jsonb not null default '{}'::jsonb,
  redirect_to text,
  is_active boolean not null default true,
  last_received_at timestamptz,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.automation_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  trigger_event text not null
    check (trigger_event ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  conditions jsonb not null default '[]'::jsonb,
  actions jsonb not null default '[]'::jsonb,
  is_active boolean not null default false,
  last_run_at timestamptz,
  run_count integer not null default 0,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_automation_rules_org_trigger
  on public.automation_rules (organization_id, trigger_event)
  where is_active;

create table if not exists public.automation_rule_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  rule_id uuid not null references public.automation_rules(id) on delete cascade,
  event_id uuid references public.event_log(id) on delete set null,
  status text not null check (status in ('success', 'partial', 'failed')),
  actions_result jsonb not null default '[]'::jsonb,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists idx_automation_rule_runs_org_created
  on public.automation_rule_runs (organization_id, created_at desc);
create index if not exists idx_automation_rule_runs_rule
  on public.automation_rule_runs (rule_id, created_at desc);

alter table public.webhook_sources enable row level security;
alter table public.automation_rules enable row level security;
alter table public.automation_rule_runs enable row level security;

drop policy if exists "webhook_sources_select" on public.webhook_sources;
drop policy if exists "webhook_sources_manager_write" on public.webhook_sources;

create policy "webhook_sources_select" on public.webhook_sources
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

create policy "webhook_sources_manager_write" on public.webhook_sources
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists "automation_rules_select" on public.automation_rules;
drop policy if exists "automation_rules_manager_write" on public.automation_rules;

create policy "automation_rules_select" on public.automation_rules
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

create policy "automation_rules_manager_write" on public.automation_rules
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists "automation_rule_runs_select" on public.automation_rule_runs;

create policy "automation_rule_runs_select" on public.automation_rule_runs
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

-- ---- disponibilidade/horário por atendente: attendant_availability (migration 0039) ----
-- spec 13 §3.4/§5. Persiste o <AttendantStatusToggle> (spec 04 §8): is_available,
-- capacity (>0), schedule jsonb tz-aware, last_heartbeat_at (AT-08 auto-offline
-- 15min via worker TS). RLS por-comando (nunca FOR ALL): SELECT org-wide;
-- INSERT/UPDATE/DELETE = própria linha OU manager+. Idempotente.

create table if not exists public.attendant_availability (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  is_available      boolean not null default false,
  capacity          integer not null default 5 check (capacity > 0),
  schedule          jsonb not null default '{}',
  last_heartbeat_at timestamptz,
  updated_at        timestamptz not null default now(),
  unique (organization_id, user_id)
);

create index if not exists idx_attendant_availability_available
  on public.attendant_availability (organization_id)
  where is_available;

alter table public.attendant_availability enable row level security;

drop policy if exists "attendant_availability_select" on public.attendant_availability;
create policy "attendant_availability_select" on public.attendant_availability
  for select using (
    public.fn_is_platform_admin()
    or organization_id in (select public.fn_user_org_ids())
  );

drop policy if exists "attendant_availability_insert" on public.attendant_availability;
create policy "attendant_availability_insert" on public.attendant_availability
  for insert with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and (user_id = auth.uid()
             or public.fn_role_at_least(organization_id, 'manager')))
  );

drop policy if exists "attendant_availability_update" on public.attendant_availability;
create policy "attendant_availability_update" on public.attendant_availability
  for update using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and (user_id = auth.uid()
             or public.fn_role_at_least(organization_id, 'manager')))
  ) with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and (user_id = auth.uid()
             or public.fn_role_at_least(organization_id, 'manager')))
  );

drop policy if exists "attendant_availability_delete" on public.attendant_availability;
create policy "attendant_availability_delete" on public.attendant_availability
  for delete using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and (user_id = auth.uid()
             or public.fn_role_at_least(organization_id, 'manager')))
  );

-- ---- roteamento: disponibilidade/horário por atendente (migration 0039) ----
-- spec 13 §3.4/§5. attendant_availability (1 linha por org×user): toggle
-- online/offline + capacity ajustável + schedule tz-aware + last_heartbeat_at
-- (AT-08). RLS por-comando (nunca FOR ALL): SELECT org-wide; WRITE própria linha
-- OU manager+. settings.routing (§3.5) fica no jsonb organizations.settings,
-- validado por Zod (lib/schemas/routing.ts) — sem coluna nova. Idempotente.

create table if not exists public.attendant_availability (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  is_available      boolean not null default false,
  capacity          integer not null default 5 check (capacity > 0),
  schedule          jsonb not null default '{}',
  last_heartbeat_at timestamptz,
  updated_at        timestamptz not null default now(),
  unique (organization_id, user_id)
);

create index if not exists idx_attendant_availability_available
  on public.attendant_availability (organization_id)
  where is_available;

alter table public.attendant_availability enable row level security;

drop policy if exists "attendant_availability_select" on public.attendant_availability;
create policy "attendant_availability_select" on public.attendant_availability
  for select using (
    public.fn_is_platform_admin()
    or organization_id in (select public.fn_user_org_ids())
  );

drop policy if exists "attendant_availability_insert" on public.attendant_availability;
create policy "attendant_availability_insert" on public.attendant_availability
  for insert with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and (user_id = auth.uid()
             or public.fn_role_at_least(organization_id, 'manager')))
  );

drop policy if exists "attendant_availability_update" on public.attendant_availability;
create policy "attendant_availability_update" on public.attendant_availability
  for update using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and (user_id = auth.uid()
             or public.fn_role_at_least(organization_id, 'manager')))
  ) with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and (user_id = auth.uid()
             or public.fn_role_at_least(organization_id, 'manager')))
  );

drop policy if exists "attendant_availability_delete" on public.attendant_availability;
create policy "attendant_availability_delete" on public.attendant_availability
  for delete using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and (user_id = auth.uid()
             or public.fn_role_at_least(organization_id, 'manager')))
  );


-- ---- roteamento: emissão de conversation.routing_requested (migration 0040) ----
-- AT-03: a ENTRADA de uma conversa na fila emite o evento; o worker (cron TS
-- lib/routing/worker.ts) consome e distribui. Trigger NUNCA faz HTTP — só
-- emit_event. ANTI-ECO: AFTER INSERT APENAS + WHEN sem-dono numa fila aberta;
-- não há trigger de UPDATE, então o UPDATE de atribuição do worker NUNCA re-emite
-- (sem isso ⇒ loop infinito). Idempotente (create or replace + drop if exists).
create or replace function public.fn_emit_conversation_routing() returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  perform public.emit_event(
    'conversation.routing_requested',
    'conversation',
    new.id,
    jsonb_build_object('conversation_id', new.id, 'organization_id', new.organization_id),
    '{}'::jsonb,
    new.organization_id
  );
  return null;
end;
$$;

alter function public.fn_emit_conversation_routing() owner to postgres;

drop trigger if exists trg_conversation_routing_requested on public.conversations;
create trigger trg_conversation_routing_requested
  after insert on public.conversations
  for each row
  when (new.assigned_to_user_id is null and new.status in ('open', 'pending'))
  execute function public.fn_emit_conversation_routing();


-- ---- cifragem at-rest dos secrets de webhooks (migration 0041) ----
-- Idempotente e auto-curativo (ver migrations/20260718150000_0041). Chave em
-- private.app_secrets (GUC como override); sem chave, plaintext é descartado com WARNING.
-- Forward-fix de raiz: fn_encrypt_oauth/fn_decrypt_oauth fixavam
-- search_path='public', mas pgcrypto vive no schema `extensions` no Supabase
-- (e faltava no baseline) — pgp_sym_* NUNCA resolvia. Garante a extensão e
-- recria as funções com o search_path correto.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- Fonte da chave: Supabase cloud NÃO permite ALTER DATABASE/ROLE SET de GUC
-- custom (42501) — GUC-only nunca funcionaria lá. A chave vive em
-- private.app_secrets (schema sem grants; só as SECURITY DEFINER leem);
-- a GUC, quando setada (VPS/psql/testes), tem precedência como override.
create schema if not exists private;
create table if not exists private.app_secrets (
  name text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
revoke all on schema private from public;
revoke all on all tables in schema private from public;

create or replace function private.fn_oauth_key() returns text
    language sql security definer
    set search_path to 'private', 'pg_temp'
    as $$
  select coalesce(
    nullif(current_setting('app.nuvemshop_oauth_key', true), ''),
    (select value from private.app_secrets where name = 'nuvemshop_oauth_key')
  );
$$;
revoke all on function private.fn_oauth_key() from public;

create or replace function public.fn_encrypt_oauth(plaintext text) returns bytea
    language plpgsql security definer
    set search_path to 'public', 'private', 'extensions', 'pg_temp'
    as $$
declare
  k text := private.fn_oauth_key();
begin
  if k is null or length(k) < 32 then
    raise exception 'NUVEMSHOP_OAUTH_ENCRYPTION_KEY ausente';
  end if;
  return pgp_sym_encrypt(plaintext, k, 'cipher-algo=aes256');
end$$;

create or replace function public.fn_decrypt_oauth(ciphertext bytea) returns text
    language plpgsql security definer
    set search_path to 'public', 'private', 'extensions', 'pg_temp'
    as $$
declare
  k text := private.fn_oauth_key();
begin
  return pgp_sym_decrypt(ciphertext, k);
end$$;

revoke all on function public.fn_encrypt_oauth(text) from public;
revoke all on function public.fn_decrypt_oauth(bytea) from public;
grant execute on function public.fn_encrypt_oauth(text) to service_role;
grant execute on function public.fn_decrypt_oauth(bytea) to service_role;

alter table public.webhook_sources
  add column if not exists secret_encrypted bytea;

do $$
declare
  k text := current_setting('app.nuvemshop_oauth_key', true);
  has_plain boolean;
  n_dropped int;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'webhook_sources' and column_name = 'secret'
  ) into has_plain;
  if not has_plain then
    return; -- já migrado
  end if;

  if k is not null and length(k) >= 32 then
    update public.webhook_sources
      set secret_encrypted = public.fn_encrypt_oauth(secret)
      where secret is not null and secret_encrypted is null;
  else
    select count(*) into n_dropped from public.webhook_sources where secret is not null;
    if n_dropped > 0 then
      raise warning 'webhook_sources: % secret(s) plaintext descartado(s) — GUC app.nuvemshop_oauth_key ausente; re-configure os secrets pela UI', n_dropped;
    end if;
  end if;

  alter table public.webhook_sources drop column secret;
end$$;

-- automation_rules: reescreve configs de call_webhook trocando secret -> secret_enc
do $$
declare
  k text := current_setting('app.nuvemshop_oauth_key', true);
  r record;
  new_actions jsonb;
  a jsonb;
  n_dropped int := 0;
begin
  for r in
    select id, actions from public.automation_rules
    where actions::text like '%"secret"%'
  loop
    new_actions := '[]'::jsonb;
    for a in select * from jsonb_array_elements(r.actions) loop
      if a->>'type' = 'call_webhook' and (a->'config') ? 'secret' then
        if k is not null and length(k) >= 32 then
          a := jsonb_set(
            a #- '{config,secret}',
            '{config,secret_enc}',
            to_jsonb(encode(public.fn_encrypt_oauth(a#>>'{config,secret}'), 'hex'))
          );
        else
          a := a #- '{config,secret}';
          n_dropped := n_dropped + 1;
        end if;
      end if;
      new_actions := new_actions || jsonb_build_array(a);
    end loop;
    update public.automation_rules set actions = new_actions, updated_at = now()
      where id = r.id;
  end loop;
  if n_dropped > 0 then
    raise warning 'automation_rules: % secret(s) de call_webhook descartado(s) — GUC app.nuvemshop_oauth_key ausente; re-configure pela UI', n_dropped;
  end if;
end$$;


-- ---- trigger de leads sem duplicatas de evento (migration 0043) ----
-- Idempotente (create or replace + drop/create trigger). Ver migrations/20260718160001_0043.
create or replace function public.fn_emit_event_on_lead_change() returns trigger
    language plpgsql
    set search_path to 'public', 'pg_temp'
    as $$
begin
  if tg_op = 'INSERT' then
    -- lead.created é emitido pelo createLeadHandler (entity_kind='crm_lead').
    return new;
  end if;

  -- lead.stage_changed é emitido pelo moveLeadHandler (entity_kind='crm_lead').

  if new.status is distinct from old.status then
    if new.status = 'won' then
      perform public.fn_log_event(new.organization_id, 'lead.won',
        jsonb_build_object('lead_id', new.id, 'value_cents', new.value_cents));
    elsif new.status = 'lost' then
      perform public.fn_log_event(new.organization_id, 'lead.lost',
        jsonb_build_object('lead_id', new.id, 'lost_reason', new.lost_reason));
    elsif new.status = 'open' then
      perform public.fn_log_event(new.organization_id, 'lead.reopened',
        jsonb_build_object('lead_id', new.id));
    end if;
  end if;

  if new.owner_user_id is distinct from old.owner_user_id then
    perform public.fn_log_event(new.organization_id, 'lead.assigned',
      jsonb_build_object('lead_id', new.id, 'from_user_id', old.owner_user_id, 'to_user_id', new.owner_user_id));
  end if;

  return new;
end$$;

-- INSERT não emite mais nada — dispara só em UPDATE.
drop trigger if exists trg_emit_event_on_lead_change on public.crm_leads;
create trigger trg_emit_event_on_lead_change
  after update on public.crm_leads
  for each row execute function public.fn_emit_event_on_lead_change();

-- Backlog morto: duplicatas antigas do trigger nunca terão consumer.
update public.event_log
  set status = 'done', updated_at = now()
  where status = 'pending'
    and entity_kind = 'lead'
    and event_type in ('lead.created', 'lead.stage_changed');

-- ---- RLS por role em crm_lead_activities/crm_lead_links (migration 0042) ----
-- G6-00 (INB-10): timeline/vínculos de lead seguiam org-flat no SELECT — agent em
-- modo 'own' não via o lead (0036) mas lia as activities/links dele por query direta.
-- FIX: SELECT das tabelas-filhas HERDA a visibilidade do lead-pai via a MESMA
-- fn_can_view_lead (0036), por EXISTS no lead_id (NÃO scalar de owner — lição G4-01:
-- scalar devolveria NULL pro lead oculto e own_and_unassigned trataria como fila ⇒
-- vazamento; o EXISTS fecha). WRITE fica org-scope IDÊNTICO ao de hoje (defesa em
-- profundidade, não o vetor: todo escritor real usa service role e bypassa RLS;
-- activities é append-only). crm_lead_links era FOR ALL (USING governa SELECT via OR,
-- a armadilha G4-01) — dropada e re-expressa POR-COMANDO. Idempotente, auto-curativo.

drop policy if exists "tenant_isolation_crm_lead_activities_select" on public.crm_lead_activities;
drop policy if exists "tenant_isolation_crm_lead_activities_insert" on public.crm_lead_activities;
drop policy if exists "crm_lead_activities_select" on public.crm_lead_activities;
drop policy if exists "crm_lead_activities_insert" on public.crm_lead_activities;

create policy "crm_lead_activities_select" on public.crm_lead_activities
  for select using (
    exists (
      select 1 from public.crm_leads l
      where l.id = crm_lead_activities.lead_id
        and public.fn_can_view_lead(l.organization_id, l.owner_user_id)
    )
  );

create policy "crm_lead_activities_insert" on public.crm_lead_activities
  for insert with check (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

drop policy if exists "tenant_isolation_crm_lead_links_all" on public.crm_lead_links;
drop policy if exists "crm_lead_links_select" on public.crm_lead_links;
drop policy if exists "crm_lead_links_insert" on public.crm_lead_links;
drop policy if exists "crm_lead_links_update" on public.crm_lead_links;
drop policy if exists "crm_lead_links_delete" on public.crm_lead_links;

create policy "crm_lead_links_select" on public.crm_lead_links
  for select using (
    exists (
      select 1 from public.crm_leads l
      where l.id = crm_lead_links.lead_id
        and public.fn_can_view_lead(l.organization_id, l.owner_user_id)
    )
  );

create policy "crm_lead_links_insert" on public.crm_lead_links
  for insert with check (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );
create policy "crm_lead_links_update" on public.crm_lead_links
  for update using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  ) with check (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );
create policy "crm_lead_links_delete" on public.crm_lead_links
  for delete using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );


-- ---- user_organizations SELECT org-wide para manager+ (migration 0044) ----
-- G6-06 (INB-14): manager passa a ler todo o roster da org (matriz spec 13 §4:
-- team=org:read a manager). Antes: só admin org-wide, manager caía no self-read
-- e GET /api/v1/team devolvia 1 linha. Self-read preservado p/ todos; WRITE
-- inalterado (insert/update/delete = admin). Idempotente e auto-curativo.
drop policy if exists "user_orgs_select" on public.user_organizations;
create policy "user_orgs_select" on public.user_organizations
  for select using (
    (user_id = auth.uid())
    or public.fn_role_at_least(organization_id, 'manager')
    or public.fn_is_platform_admin()
  );

-- ============================================================================
-- Dumps do Supabase zeram o search_path (set_config('search_path','',false));
-- os apêndices da fusão criam objetos NÃO-qualificados — restaura o público.
select pg_catalog.set_config('search_path', 'public, extensions', false);

-- APÊNDICE 0050_agent_harness (fusão Vendaval) — idempotente, espelho exato da
-- migration 20260719000000 (kit self-host aplica via install.sh/update.sh).
-- ============================================================================

-- 0050_agent_harness — schema do motor SDR (harness) portado do Vendaval para o
-- banco do CRM (fusão). Mapeamento canônico (lib/agent-engine/PORT-NOTES.md):
--   tenants → organizations · tenant_id → organization_id · leads → contacts ·
--   lead_id → contact_id · channel_session_id → FK real p/ channel_sessions(id).
-- Mortos no porte: tenants/leads (espelhos — o CRM é o mesmo banco agora),
-- event_inbox (o drain lê event_log direto), org_llm_credentials (BYOK do CRM =
-- ai_provider_credentials), colunas LGPD/handoff de leads (contacts.consent /
-- is_anonymized / conversations.bot_silenced_until já existem).
-- Idempotente (if not exists / or replace / do $$); SEM begin/commit; psql puro.

-- ============================================================================
-- Escalação humana do RUNTIME (ex-inbox_items do Vendaval; a UI lê daqui).
-- organization_id NULL = plataforma (ex.: infra) — visível só ao service role.
-- Kind já inclui 'judge_unaligned' (extensão da 0025 do Vendaval, embutida).
-- ============================================================================
create table if not exists agent_inbox_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  kind text not null check (kind in
    ('qr_rescan','job_dead','event_dead','budget_exceeded','handoff',
     'promotion_review','judge_unaligned','other')),
  severity text not null default 'warn' check (severity in ('info','warn','critical')),
  title text not null,
  body text,
  ref_kind text,
  ref_id uuid,
  status text not null default 'open' check (status in ('open','ack','resolved')),
  created_at timestamptz not null default now()
);
create index if not exists idx_agent_inbox_items_open on agent_inbox_items (organization_id, created_at desc)
  where status = 'open';

-- ============================================================================
-- 0002 — fila durável FOR UPDATE SKIP LOCKED com lane por contact_id.
-- ============================================================================
create table if not exists job_queue (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid references contacts(id) on delete cascade, -- NULL para watchdog/flywheel (jobs sem contato)
  kind text not null check (kind in ('inbound_turn','followup_turn','watchdog','flywheel')),
  source_event_id uuid,                -- event_log.id (CRM, mesmo banco) que originou o job — dedup evento→job
  payload jsonb not null default '{}',
  status text not null default 'pending'
    check (status in ('pending','running','done','failed','dead')),
  priority smallint not null default 100,
  run_after timestamptz not null default now(),
  attempts smallint not null default 0,
  max_attempts smallint not null default 5,
  last_error text,                     -- normalizado/truncado no código — nunca conteúdo de mensagem (PII)
  locked_by text,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  -- jobs de turno TÊM contato; watchdog/flywheel NÃO — o schema força a coerência
  check ((kind in ('inbound_turn','followup_turn')) = (contact_id is not null))
);

create index if not exists idx_job_queue_claim on job_queue (status, run_after) where status = 'pending';

-- INVARIANTE (lane): 1 job 'running' por contato por vez; paralelismo entre contatos.
-- É o CINTO — o claim em duas etapas evita chegar aqui; na corrida residual o 23505
-- é capturado e o claim perde só a rodada.
create unique index if not exists uniq_job_queue_one_running_per_contact on job_queue (contact_id)
  where status = 'running' and contact_id is not null;

-- DEDUP evento→job: o handoff é at-least-once; evento re-entregue não vira 2º turno.
create unique index if not exists uniq_job_queue_source_event on job_queue (organization_id, source_event_id)
  where source_event_id is not null;

-- ============================================================================
-- 0003 — ledger de envio idempotente. Uma linha por mensagem `seq` do turno; `id`
-- É a idempotency_key da tentativa LÓGICA (re-attempt após 'failed' rotaciona o id).
-- ============================================================================
create table if not exists send_ledger (
  id uuid primary key default gen_random_uuid(), -- a idempotency_key da tentativa lógica corrente
  organization_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid references contacts(id) on delete cascade,
  job_id uuid not null references job_queue(id) on delete cascade,
  seq smallint not null,
  -- sha256 hex do corpo — PII (o corpo em si) NUNCA entra no ledger nem em log.
  body_hash text not null,
  -- requested: inserido imediatamente antes do envio (crash aqui → retry re-envia a MESMA key)
  -- accepted:  envio confirmado ('sent') — retry pula
  -- queued:    aceito e retido (sessão ≠ WORKING / waha_not_configured)
  -- vetoed:    is_blocked — veto permanente de negócio (irrevogável)
  -- failed:    'failed' (sem telefone / erro WAHA) — retry = tentativa lógica nova
  status text not null default 'requested'
    check (status in ('requested','accepted','queued','vetoed','failed')),
  crm_message_id uuid,                 -- messages.id (mesmo banco; vem na resposta do handler de envio)
  last_error text,                     -- normalizado/truncado no código — nunca corpo de mensagem (PII)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 1 linha por mensagem do turno — a base do "intenção exactly-once".
  unique (job_id, seq)
);

-- O throttle/spinning da cadeia before_send consulta envios recentes por org.
create index if not exists idx_send_ledger_recent on send_ledger (organization_id, created_at desc);

-- ============================================================================
-- Imutabilidade compartilhada das tabelas *_versions: conteúdo publicado é
-- imutável — mudança = versão nova; rollback = mover o ponteiro. DELETE fica de
-- fora de propósito (o cascade de organizations precisa passar; versão apontada
-- é protegida pelo FK do ponteiro correspondente).
-- ============================================================================
create or replace function fn_agent_versions_immutable() returns trigger
language plpgsql as $fn$
begin
  raise exception '% é imutável: mudança = versão nova; rollback = mover o ponteiro (%)',
    tg_table_name, replace(tg_table_name, '_versions', '_pointers');
end;
$fn$;

-- ============================================================================
-- 0004 — playbook em camadas versionado + carga por ponteiro. 1 linha por CAMADA
-- (platform|tenant|campaign); o runtime carrega por ponteiro no início de cada
-- run: trocar versão/rollback = mover ponteiro, sem restart. Camada platform é
-- global (organization_id NULL); tenant/campaign pertencem a uma org.
-- ============================================================================
create table if not exists playbook_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade, -- NULL = plataforma (global)
  layer text not null check (layer in ('platform', 'tenant', 'campaign')),
  -- Markdown com seções nomeadas (## ...), máx. 200 linhas por camada — validado no insert.
  content text not null,
  created_at timestamptz not null default now(),
  -- platform é global; tenant/campaign SEMPRE têm dono — o schema força a coerência
  check ((layer = 'platform') = (organization_id is null))
);

drop trigger if exists trg_playbook_versions_immutable on playbook_versions;
create trigger trg_playbook_versions_immutable
  before update on playbook_versions
  for each row execute function fn_agent_versions_immutable();

-- Ponteiro → versão ativa por escopo. SEM cascade no version_id: versão apontada
-- não pode sumir debaixo do ponteiro.
create table if not exists playbook_pointers (
  organization_id uuid references organizations(id) on delete cascade, -- NULL = plataforma (global)
  layer text not null check (layer in ('platform', 'tenant', 'campaign')),
  version_id uuid not null references playbook_versions(id),
  updated_at timestamptz not null default now(),
  check ((layer = 'platform') = (organization_id is null))
);

-- Unicidade do escopo (PK não serve: organization_id é NULL na plataforma).
create unique index if not exists uniq_playbook_pointers_org
  on playbook_pointers (organization_id, layer) where organization_id is not null;
create unique index if not exists uniq_playbook_pointers_platform
  on playbook_pointers (layer) where organization_id is null;

-- ============================================================================
-- 0005 + 0012 — espelho de saúde da sessão WAHA + circuito de saúde do número.
-- status_changed_at só avança quando o status MUDA (métrica "tempo no estado").
-- Os holds de status e de saúde coexistem — job retido sob QUALQUER hold.
-- ============================================================================
create table if not exists channel_session_health (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  channel_session_id uuid not null references channel_sessions(id) on delete cascade,
  status text not null,
  status_changed_at timestamptz not null default now(),
  -- Status já escalado (agent_inbox_items kind='qr_rescan') no EPISÓDIO corrente —
  -- dedup do "exatamente 1×". Volta a null quando a sessão volta a WORKING.
  escalated_status text,
  -- Circuito de saúde (0012): default false — linhas criadas pelo watchdog NÃO
  -- nascem health-held; o "nasce em hold" (fail-safe de go-live) é decidido pelo
  -- tick de saúde quando health_released_at is null, nunca pelo default.
  health_hold_active boolean not null default false,
  health_hold_reason text,          -- 'go_live' | 'block_rate' | 'response_rate'
  health_held_at timestamptz,       -- início do episódio de hold (base do cool-down)
  -- Liberação explícita inicial (go-live). NULL = número novo, nunca liberado →
  -- nasce em hold (fail-safe). Uma vez setado, permanece.
  health_released_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (organization_id, channel_session_id)
);

-- Cursor durável de consumo do event_log do CRM por consumidor do harness (o
-- watchdog é o 1º). Tabela de PLATAFORMA (sem org): RLS habilitada sem policy —
-- só o service role (worker) lê/escreve.
create table if not exists watchdog_cursors (
  consumer text primary key,
  last_created_at timestamptz not null default 'epoch',
  last_event_id uuid not null default '00000000-0000-0000-0000-000000000000',
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- 0006 — toda chamada de modelo (custo, cache, atribuição); agregado mensal =
-- enforcement do budget. Credenciais BYOK são do CRM (ai_provider_credentials) —
-- org_llm_credentials do Vendaval NÃO foi portada.
-- ============================================================================
create table if not exists llm_calls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  job_id uuid references job_queue(id) on delete set null,
  variant_id uuid,                       -- experiment_variants (flywheel); nasce p/ atribuição
  purpose text not null default 'agent_turn',  -- 'agent_turn' | 'classifier' | 'compaction' | 'connection_test'
  provider text not null,
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_read_tokens int not null default 0,   -- métrica de 1ª classe
  cache_write_tokens int not null default 0,
  cost_cents numeric,                    -- null = preço desconhecido — nunca inventar 0
  latency_ms int,
  created_at timestamptz not null default now()
);
create index if not exists idx_llm_calls_org_time on llm_calls (organization_id, created_at);

-- ============================================================================
-- 0007 — artefato durável do loop do agente: cada run fecha escrevendo um
-- checkpoint; o run seguinte do MESMO contato abre lendo o mais recente —
-- sessões descartáveis, artefatos duráveis. Conteúdo validado por Zod no handler.
-- ============================================================================
create table if not exists lead_checkpoints (
  id uuid primary key default gen_random_uuid(),
  -- ordem de escrita estrita (created_at pode empatar) — abertura lê por seq.
  seq bigint generated always as identity,
  organization_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  job_id uuid references job_queue(id) on delete set null, -- o run É o job
  commitments jsonb not null default '[]',      -- string[] — compromissos assumidos no turno
  objections jsonb not null default '[]',       -- string[] — objeções levantadas
  next_action text,
  rolling_summary text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_lead_checkpoints_latest
  on lead_checkpoints (organization_id, contact_id, seq desc);

-- ============================================================================
-- 0008 — estado do funil por contato. O modelo MARCA avanços via tool; quem
-- valida a transição é a máquina de estados NO CÓDIGO — o CHECK é backstop.
-- ============================================================================
create table if not exists lead_state (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  stage text not null default 'new' check (stage in
    ('new','contacted','qualifying','qualified','negotiating','won','lost')),
  -- qualificação whitelisted (BANT) — Zod .strict() rejeita outras chaves antes daqui.
  qualification jsonb not null default '{}',
  next_action text,
  updated_at timestamptz not null default now(),
  unique (organization_id, contact_id)
);

-- Histórico append-only de transições — auditoria/diffabilidade do funil.
create table if not exists lead_state_transitions (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  organization_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  job_id uuid references job_queue(id) on delete set null,
  from_stage text not null,
  to_stage text not null,
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists idx_lead_state_transitions_contact
  on lead_state_transitions (organization_id, contact_id, seq desc);

-- ============================================================================
-- 0009 — métricas de 1ª classe persistidas. Labels SÓ com ids/contagens — PII
-- jamais entra. organization_id NULL = plataforma.
-- ============================================================================
create table if not exists metrics (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade, -- null = plataforma
  name text not null,
  labels jsonb not null default '{}',
  value double precision not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_metrics_name_time on metrics (name, created_at desc);
create index if not exists idx_metrics_org_name_time on metrics (organization_id, name, created_at desc);

-- ============================================================================
-- 0010 + 0011 + 0012 — knobs anti-ban por número/sessão + ledger de pacing.
-- Coluna NULL = default conservador no código (knobs, nunca constantes). O cap
-- diário ABSOLUTO não mora aqui: fonte única é channel_sessions.daily_message_limit.
-- ============================================================================
create table if not exists channel_knobs (
  organization_id uuid not null references organizations(id) on delete cascade,
  channel_session_id uuid not null references channel_sessions(id) on delete cascade,
  throttle_ms integer,                -- intervalo mínimo entre envios do número
  jitter_max_ms integer,              -- teto do jitter randômico somado ao throttle
  window_start_hour smallint,         -- janela [start, end) na hora local da org
  window_end_hour smallint,
  allow_sunday boolean,               -- NULL = default do código (hoje: enviar)
  timezone text,                      -- IANA tz da org (a janela é avaliada nela)
  -- degraus [{"minAgeDays":N,"cap":M|null}, ...]; CHECK (array NÃO-VAZIO) +
  -- validação de shape no load — NULL cai no default; `[]` é rejeitado.
  warmup_daily_caps jsonb
    constraint channel_knobs_warmup_caps_is_array
    check (
      warmup_daily_caps is null
      or (jsonb_typeof(warmup_daily_caps) = 'array' and jsonb_array_length(warmup_daily_caps) > 0)
    ),
  -- knobs de spinning / saúde (0011/0012): CHECK só garante "é objeto"; campo a
  -- campo é validado no load. NULL ou shape inválido → defaults conservadores.
  spinning_knobs jsonb
    constraint channel_knobs_spinning_is_object
    check (spinning_knobs is null or jsonb_typeof(spinning_knobs) = 'object'),
  health_knobs jsonb
    constraint channel_knobs_health_is_object
    check (health_knobs is null or jsonb_typeof(health_knobs) = 'object'),
  number_activated_at timestamptz not null default now(), -- idade do número p/ warm-up
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, channel_session_id)
);

-- Ledger de envios efetivados por número — estado durável do throttle e dos caps
-- diários (na tz da org).
create table if not exists pacing_ledger (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  channel_session_id uuid not null references channel_sessions(id) on delete cascade,
  sent_at timestamptz not null default now()
);
create index if not exists idx_pacing_ledger_session
  on pacing_ledger (organization_id, channel_session_id, sent_at desc);

-- 0011 — janela deslizante de copies enviadas (gate anti-template-idêntico):
-- copy NORMALIZADA das últimas outbound por NÚMERO (across contatos).
create table if not exists outbound_copies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  channel_session_id uuid not null references channel_sessions(id) on delete cascade,
  normalized_text text not null,      -- copy normalizada (lower/trim/whitespace) p/ similaridade
  normalized_hash text not null,      -- sha256 do normalizado p/ igualdade exata
  sent_at timestamptz not null default now()
);
create index if not exists idx_outbound_copies_session
  on outbound_copies (organization_id, channel_session_id, sent_at desc);

-- ============================================================================
-- 0013 — cron persistente POR CONTATO. Irmão da fila: a fila processa AGORA, o
-- cron AGENDA e, no disparo, ENFILEIRA um job em job_queue. Sobrevive a restart
-- porque TODO o estado mora aqui.
-- ============================================================================
create table if not exists cron_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  kind text not null check (kind in ('at','every','cron')),
  --   'at'   → one-shot: next_run_at guarda o instante; dispara e desabilita.
  --   'every'→ recorrência fixa: interval_ms é o período (ms).
  --   'cron' → expressão 5-campos avaliada em tz (IANA).
  interval_ms bigint check (interval_ms is null or interval_ms > 0),
  cron_expr text,
  tz text not null default 'UTC',
  -- o que enfileirar quando disparar; coerência kind⇔contato é do CHECK de
  -- job_queue no enqueue — cron mal-configurado falha PERMANENTE (23514), nunca
  -- silenciosamente.
  job_kind text not null default 'followup_turn'
    check (job_kind in ('inbound_turn','followup_turn','watchdog','flywheel')),
  payload jsonb not null default '{}',
  -- próximo disparo — JÁ com o offset de stagger determinístico (anti-rajada).
  next_run_at timestamptz not null,
  enabled boolean not null default true,
  -- retry do disparo CORRENTE: transiente incrementa + adia (backoff); esgotar
  -- max_attempts desabilita + agent_inbox_items.
  attempts smallint not null default 0,
  max_attempts smallint not null default 5,
  last_error text,                        -- normalizado/truncado — nunca PII
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'every' or interval_ms is not null),
  check (kind <> 'cron' or cron_expr is not null)
);
create index if not exists idx_cron_jobs_due on cron_jobs (next_run_at)
  where enabled = true;

-- ============================================================================
-- 0014 — templates de re-entrada versionados + ponteiro. Uma versão guarda N
-- VARIANTES pt-br de spinning; a re-entrada determinística envia a variante
-- DIRETO pela cadeia de guardrails, sem LLM — custo $0.
-- ============================================================================
create table if not exists reentry_template_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  variants text[] not null check (array_length(variants, 1) >= 1),
  created_at timestamptz not null default now()
);

drop trigger if exists trg_reentry_template_versions_immutable on reentry_template_versions;
create trigger trg_reentry_template_versions_immutable
  before update on reentry_template_versions
  for each row execute function fn_agent_versions_immutable();

create table if not exists reentry_template_pointers (
  organization_id uuid primary key references organizations(id) on delete cascade,
  version_id uuid not null references reentry_template_versions(id),
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- 0015 + 0016 — memória durável por contato. O ÍNDICE (headlines) é injetado no
-- sufixo do prompt com orçamento fixo; o CORPO vem sob demanda. Hard cap imposto
-- na ESCRITA (recusa nota que estouraria) — sem truncamento silencioso.
-- Nota de um contato NUNCA aparece em run de outro (query sempre filtra
-- organization_id + contact_id de fonte confiável).
-- ============================================================================
create table if not exists lead_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  headline text not null check (length(headline) > 0), -- a LINHA do índice
  body text not null check (length(body) > 0),         -- corpo sob demanda
  -- 0016: vetor derivado p/ recall híbrido. jsonb (array de floats), não pgvector:
  -- a DIMENSÃO é do provedor (BYOK agnóstico) e o conjunto por contato é pequeno
  -- (hard cap) ⇒ cosseno exato em app, sem índice ANN. Populado preguiçosamente;
  -- notas são write-once ⇒ o embedding cacheado nunca fica stale.
  embedding jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_lead_notes_contact
  on lead_notes (organization_id, contact_id, created_at);

-- ============================================================================
-- 0017 — playbooks SITUACIONAIS como skills versionadas com disclosure
-- progressivo: só name+description (o ÍNDICE) reside no prompt; o body carrega
-- SÓ quando o matcher if-then DETERMINÍSTICO dispara. platform = global
-- (organization_id NULL, ex.: "STOP ambíguo"/compliance).
-- ============================================================================
create table if not exists skill_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade, -- NULL = plataforma (global)
  name text not null check (length(name) > 0),
  description text not null check (length(description) > 0),
  body text not null check (length(body) > 0), -- markdown ≤200 linhas; carrega SÓ no match
  -- { "any_keywords": string[], "probe_keywords"?: string[] } — shape validado no código.
  matcher jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

drop trigger if exists trg_skill_versions_immutable on skill_versions;
create trigger trg_skill_versions_immutable
  before update on skill_versions
  for each row execute function fn_agent_versions_immutable();

create table if not exists skill_pointers (
  organization_id uuid references organizations(id) on delete cascade, -- NULL = plataforma (global)
  name text not null check (length(name) > 0),
  version_id uuid not null references skill_versions(id),
  updated_at timestamptz not null default now()
);
create unique index if not exists uniq_skill_pointers_org
  on skill_pointers (organization_id, name) where organization_id is not null;
create unique index if not exists uniq_skill_pointers_platform
  on skill_pointers (name) where organization_id is null;

-- ============================================================================
-- 0018 — tabela de preços/promessas versionada por ponteiro (anti-"vendo por
-- R$1"): o gate before_send carrega por ponteiro sob o lock de cada tentativa.
-- ============================================================================
create table if not exists promise_table_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  -- { minPriceCents?, maxDiscountPercent?, maxInstallments? } — shape validado no
  -- insert. Campo ausente = dimensão não fiscalizada.
  values jsonb not null,
  created_at timestamptz not null default now()
);

drop trigger if exists trg_promise_table_versions_immutable on promise_table_versions;
create trigger trg_promise_table_versions_immutable
  before update on promise_table_versions
  for each row execute function fn_agent_versions_immutable();

create table if not exists promise_table_pointers (
  organization_id uuid not null references organizations(id) on delete cascade,
  version_id uuid not null references promise_table_versions(id),
  updated_at timestamptz not null default now()
);
create unique index if not exists uniq_promise_table_pointers_org
  on promise_table_pointers (organization_id);

-- ============================================================================
-- 0019 — template de disclosure "assistente virtual" versionado por ponteiro
-- (disclosure by design — CDC hoje / PL 2338 amanhã). Injetado na 1ª mensagem
-- (modo inject) ou exigido do modelo (modo veto).
-- ============================================================================
create table if not exists disclosure_template_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  body text not null, -- texto pt-br do disclosure
  created_at timestamptz not null default now()
);

drop trigger if exists trg_disclosure_template_versions_immutable on disclosure_template_versions;
create trigger trg_disclosure_template_versions_immutable
  before update on disclosure_template_versions
  for each row execute function fn_agent_versions_immutable();

create table if not exists disclosure_template_pointers (
  organization_id uuid not null references organizations(id) on delete cascade,
  version_id uuid not null references disclosure_template_versions(id),
  updated_at timestamptz not null default now()
);
create unique index if not exists uniq_disclosure_template_pointers_org
  on disclosure_template_pointers (organization_id);

-- ============================================================================
-- 0021 — trace de auditoria da cadeia before_send por tentativa: array de gates
-- avaliados + gate/código do veto (null = passou). Escrita autônoma (fora da tx
-- serializada) — a auditoria do veto SOBREVIVE ao rollback. PII fora: só
-- gate/verdict/code/detail — o CORPO da mensagem NUNCA entra aqui.
-- ============================================================================
create table if not exists before_send_traces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  job_id uuid not null references job_queue(id) on delete cascade, -- RUN = job_queue.id
  contact_id uuid references contacts(id) on delete cascade,
  channel_session_id uuid not null references channel_sessions(id) on delete cascade,
  -- GateTraceEntry[]: [{ gate, verdict, code?, detail? }, ...] — sem PII.
  trace jsonb not null,
  vetoed_gate text,
  vetoed_code text,
  created_at timestamptz not null default now()
);
create index if not exists idx_before_send_traces_run
  on before_send_traces (organization_id, job_id, created_at);

-- ============================================================================
-- 0023 — vereditos dos judges em produção, batch offline (NUNCA inline por
-- mensagem). Idempotente/resumível: unique (dataset, trace_id, dimension) +
-- on conflict do nothing. PII fora do DB: só metadata/proveniência anonimizada.
-- ============================================================================
create table if not exists flywheel_judge_verdicts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  dataset text not null,               -- namespace da proveniência (replay)
  trace_id text not null,
  dimension text not null,
  verdict text not null check (verdict in ('yes', 'no', 'unknown')),
  option_order text not null,          -- auditoria da mitigação de position bias
  judge_family text not null,
  model text not null,
  -- ORIGEM do trace: proveniência do dataset (replay) ou playbook_version (live).
  provenance jsonb not null default '{}',
  run_id uuid not null,                -- agrupa uma RODADA de batch
  judged_at timestamptz not null default now()
);
create unique index if not exists uq_flywheel_judge_verdicts_key
  on flywheel_judge_verdicts (dataset, trace_id, dimension);
create index if not exists idx_flywheel_judge_verdicts_run
  on flywheel_judge_verdicts (organization_id, run_id);
create index if not exists idx_flywheel_judge_verdicts_dataset
  on flywheel_judge_verdicts (dataset, dimension);

-- ============================================================================
-- 0024 — CANDIDATOS de melhoria propostos pelo distiller isolado. NUNCA aplica:
-- aplicar é o merge sob gate humano. Este é o ÚNICO store de escrita do distiller
-- (anti "curator-takeover"). Cada proposta REFERENCIA a evidência que a motivou.
-- ============================================================================
create table if not exists flywheel_distiller_proposals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  run_id uuid not null,
  dataset text not null,
  type text not null check (type in ('playbook_bullet', 'golden_case', 'reentry_trigger')),
  target text not null,                -- camada de playbook / arquivo golden / família de gatilho
  content text not null check (length(content) > 0), -- texto proposto, pt-br, sem PII
  evidence jsonb not null,             -- trace_ids + run_ids + taxa/amostra
  proposed_at timestamptz not null default now()
);
create index if not exists idx_flywheel_distiller_proposals_run
  on flywheel_distiller_proposals (organization_id, run_id);
create index if not exists idx_flywheel_distiller_proposals_dataset
  on flywheel_distiller_proposals (dataset, type);

-- ============================================================================
-- 0025 — MANUTENÇÃO do judge: rotaciona casos frescos julgados em produção para
-- um POOL de alinhamento (candidatos a novo lote de labels humanos no drift).
-- A unique é o DEDUP da rotação. (A extensão de kind 'judge_unaligned' já está
-- embutida no CHECK de agent_inbox_items acima.)
-- ============================================================================
create table if not exists judge_alignment_pool (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  dataset text not null,
  trace_id text not null,
  dimension text not null,
  added_at timestamptz not null default now()
);
create unique index if not exists uq_judge_alignment_pool_key
  on judge_alignment_pool (dataset, trace_id, dimension);
create index if not exists idx_judge_alignment_pool_dim
  on judge_alignment_pool (organization_id, dimension);

-- ============================================================================
-- 0026 — knobs de re-entrada (timing de follow-up + segmentação) versionados +
-- ponteiro. O 1º alvo concreto do flywheel: timing não é constante nem env —
-- é config versionada por org, otimizável e rollbackável pelo ponteiro.
-- ============================================================================
create table if not exists reentry_knob_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  -- { follow_up_window_hours: number>0, enabled_segments: string[] } — shape
  -- revalidado no insert.
  knobs jsonb not null,
  created_at timestamptz not null default now()
);

drop trigger if exists trg_reentry_knob_versions_immutable on reentry_knob_versions;
create trigger trg_reentry_knob_versions_immutable
  before update on reentry_knob_versions
  for each row execute function fn_agent_versions_immutable();

create table if not exists reentry_knob_pointers (
  organization_id uuid primary key references organizations(id) on delete cascade,
  version_id uuid not null references reentry_knob_versions(id),
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- RLS — padrão do repo: tenant_isolation_<tabela>_all via fn_user_org_ids() +
-- revoke de anon. Nas tabelas com organization_id nullable (agent_inbox_items,
-- playbook_versions/pointers, skill_versions/pointers, metrics) a MESMA policy
-- serve: `null in (...)` nunca é true ⇒ linhas de plataforma são visíveis só ao
-- service role (que bypassa RLS).
-- ============================================================================
do $$
declare
  t text;
begin
  foreach t in array array[
    'agent_inbox_items', 'job_queue', 'send_ledger',
    'playbook_versions', 'playbook_pointers',
    'channel_session_health', 'llm_calls',
    'lead_checkpoints', 'lead_state', 'lead_state_transitions',
    'metrics', 'channel_knobs', 'pacing_ledger', 'outbound_copies',
    'cron_jobs',
    'reentry_template_versions', 'reentry_template_pointers',
    'lead_notes', 'skill_versions', 'skill_pointers',
    'promise_table_versions', 'promise_table_pointers',
    'disclosure_template_versions', 'disclosure_template_pointers',
    'before_send_traces',
    'flywheel_judge_verdicts', 'flywheel_distiller_proposals',
    'judge_alignment_pool',
    'reentry_knob_versions', 'reentry_knob_pointers'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists tenant_isolation_%s_all on public.%I', t, t);
    execute format(
      'create policy tenant_isolation_%s_all on public.%I for all
         using (organization_id in (select * from public.fn_user_org_ids()))
         with check (organization_id in (select * from public.fn_user_org_ids()))',
      t, t
    );
    execute format('revoke all on public.%I from anon', t);
  end loop;
end
$$;

-- watchdog_cursors não tem organization_id (infra de plataforma): RLS habilitada
-- SEM policy ⇒ só o service role acessa.
alter table watchdog_cursors enable row level security;
revoke all on watchdog_cursors from anon;


-- APÊNDICE 0051_agent_version_immutability (fusão Fase 2B) — espelho exato da migration.

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


-- APÊNDICE 0052_republish_fn_uppercase_fix — re-assenta a fn de publish correta (anti-drift).

-- 0052_republish_fn_uppercase_fix — forward-fix de DRIFT de função.
--
-- Sintoma (Fase 2B da fusão): publish na tela falhava com channel_session_offline
-- mesmo com a sessão WORKING. Diagnóstico no banco hospedado: a função
-- fn_publish_ai_agent_version deployada continha `v_session.status <> 'working'`
-- (minúsculo) — a versão PRÉ-0026 — apesar de 20260706200000_0026 constar como
-- aplicada em schema_migrations. Ou seja: algo re-aplicou a definição antiga por
-- FORA do fluxo de migrations depois da 0026 (drift).
-- Conserto: re-assentar a definição correta da 0026 como migration NOVA (forward-
-- fix; migração aplicada nunca é editada). Idempotente por natureza (or replace).

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
         v.credential_id, v.channel_session_id
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
  if v_version.status not in ('draft', 'superseded') then
    raise exception 'version_invalid_state' using errcode = 'P0001';
  end if;

  if v_version.credential_id is null then
    raise exception 'credential_missing' using errcode = 'P0001';
  end if;

  select c.id, c.organization_id, c.provider, c.is_active, c.validated_at
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

  select count(*)
    into v_model_count
  from public.ai_models m
  where m.provider = v_version.provider
    and m.model_id = v_version.model
    and m.deprecated_at is null;

  if v_model_count = 0 then
    raise exception 'model_not_found' using errcode = 'P0001';
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

comment on function public.fn_publish_ai_agent_version(uuid, uuid, uuid) is
  'EPIC-13 S-13.06 (fixed in 0026): compares channel_sessions.status against WORKING (uppercase), matching channel_sessions_status_check. 0024/0025 compared against lowercase working and always raised channel_session_offline.';

-- ============================================================================
-- 0053 — Operação Visível F3: rastro de aplicação de proposta do flywheel
-- (applied_at/applied_version_id/applied_by; null = pendente). Idempotente.
-- ============================================================================
alter table flywheel_distiller_proposals
  add column if not exists applied_at timestamptz,
  add column if not exists applied_version_id uuid references ai_agent_versions(id) on delete set null,
  add column if not exists applied_by uuid;

-- ---- followup flows (migration 0054) ----

create table if not exists followup_flow_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  graph jsonb not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists followup_flow_pointers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  status text not null default 'draft' check (status in ('draft','active','disabled')),
  active_version_id uuid references followup_flow_versions(id),
  draft_graph jsonb,
  handoff_policy text not null default 'pause' check (handoff_policy in ('pause','cancel','allow')),
  trigger_config jsonb not null default '{"kind":"manual"}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

create table if not exists followup_enrollments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  pointer_id uuid not null references followup_flow_pointers(id) on delete cascade,
  version_id uuid not null references followup_flow_versions(id),
  contact_id uuid not null references contacts(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  current_node_id text not null,
  status text not null default 'active'
    check (status in ('active','waiting_reply','paused_handoff','completed','cancelled','dead')),
  next_eval_at timestamptz,
  claimed_until timestamptz,
  attempts smallint not null default 0,
  max_attempts smallint not null default 5,
  last_error text,
  steps_taken smallint not null default 0,
  outcome text check (outcome in ('converted','replied','exhausted','opted_out','handoff')),
  cancel_reason text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  -- estados com relógio TÊM next_eval_at; pausados/terminais NÃO — coerência no schema
  check (
    (status in ('active','waiting_reply') and next_eval_at is not null)
    or (status in ('paused_handoff','completed','cancelled','dead'))
  )
);

create index if not exists idx_followup_enrollments_due
  on followup_enrollments (next_eval_at)
  where status in ('active','waiting_reply');

create unique index if not exists idx_followup_enrollments_one_live
  on followup_enrollments (pointer_id, contact_id)
  where status in ('active','waiting_reply','paused_handoff');

create index if not exists idx_followup_enrollments_contact
  on followup_enrollments (organization_id, contact_id);

create table if not exists followup_enrollment_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  enrollment_id uuid not null references followup_enrollments(id) on delete cascade,
  node_id text,
  event_type text not null,
  payload jsonb not null default '{}',
  idempotency_key text,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_followup_events_idem
  on followup_enrollment_events (enrollment_id, idempotency_key)
  where idempotency_key is not null;

-- RLS (padrão fn_user_org_ids)
alter table followup_flow_versions enable row level security;
alter table followup_flow_pointers enable row level security;
alter table followup_enrollments enable row level security;
alter table followup_enrollment_events enable row level security;

do $$ begin
  create policy tenant_isolation_followup_flow_versions_all on followup_flow_versions
    for all using (organization_id in (select fn_user_org_ids()))
    with check (organization_id in (select fn_user_org_ids()));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy tenant_isolation_followup_flow_pointers_all on followup_flow_pointers
    for all using (organization_id in (select fn_user_org_ids()))
    with check (organization_id in (select fn_user_org_ids()));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy tenant_isolation_followup_enrollments_all on followup_enrollments
    for all using (organization_id in (select fn_user_org_ids()))
    with check (organization_id in (select fn_user_org_ids()));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy tenant_isolation_followup_enrollment_events_all on followup_enrollment_events
    for all using (organization_id in (select fn_user_org_ids()))
    with check (organization_id in (select fn_user_org_ids()));
exception when duplicate_object then null; end $$;

-- Claim atômico do worker (SKIP LOCKED) — service role only
create or replace function fn_claim_due_followup_enrollments(p_limit int, p_lease_seconds int)
returns setof followup_enrollments
language sql
security definer
set search_path = public
as $$
  update followup_enrollments e
  set claimed_until = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  where e.id in (
    select id from followup_enrollments
    where status in ('active','waiting_reply')
      and next_eval_at <= now()
      and (claimed_until is null or claimed_until < now())
    order by next_eval_at
    limit p_limit
    for update skip locked
  )
  returning e.*;
$$;
revoke all on function fn_claim_due_followup_enrollments(int, int) from public, anon, authenticated;

-- ---- followup version lineage + atomic publish (migration 0056) ----

alter table followup_flow_versions
  add column if not exists pointer_id uuid references followup_flow_pointers(id) on delete cascade;

update followup_flow_versions v
set pointer_id = p.id
from followup_flow_pointers p
where p.active_version_id = v.id
  and v.pointer_id is null;

create index if not exists idx_followup_versions_pointer
  on followup_flow_versions (pointer_id);

create or replace function fn_publish_followup_flow_version(
  p_org uuid,
  p_pointer uuid,
  p_graph jsonb,
  p_created_by uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pointer record;
  v_version_id uuid;
begin
  select p.id, p.organization_id
    into v_pointer
  from followup_flow_pointers p
  where p.id = p_pointer
  for update;

  if not found or v_pointer.organization_id <> p_org then
    raise exception 'pointer_not_found' using errcode = 'P0001';
  end if;

  insert into followup_flow_versions (organization_id, pointer_id, graph, created_by)
  values (p_org, p_pointer, p_graph, p_created_by)
  returning id into v_version_id;

  update followup_flow_pointers
     set active_version_id = v_version_id,
         status = 'active',
         updated_at = now()
   where id = p_pointer;

  return v_version_id;
end;
$$;
revoke all on function fn_publish_followup_flow_version(uuid, uuid, jsonb, uuid) from public, anon, authenticated;

-- ---- agent_inbox_items: kind 'followup_dead' (migration 0057) ----

-- A constraint NÃO é reconstruída aqui: o vocabulário desta migration já está
-- contido no bloco único do fim deste apêndice. Reconstruí-la com a lista da
-- época quebrava o update.sh de quem já tem linha com kind mais novo (era o
-- caso deste bloco: 'snooze_expired' e os 4 seguintes ainda não existiam).

-- ---- agent editor: seletor de fluxo de follow-up (migration 0061) ----

alter table ai_agent_versions
  add column if not exists followup jsonb not null default '{"enabled": false, "flow_pointer_ids": []}'::jsonb;

create or replace function fn_ai_agent_version_content_immutable() returns trigger
language plpgsql as $fn$
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

-- ---- followup enrollment: 1 vivo por lead ORG-WIDE + agent_id (migration 0064) ----
-- Dedup ANTES de trocar o índice (self-host-safe: o update.sh re-aplica sem
-- ON_ERROR_STOP, então o dado sujo tem que ser curado antes da constraint).
with ranked as (
  select id,
         row_number() over (
           partition by organization_id, contact_id
           order by started_at desc, id desc
         ) as rn
  from followup_enrollments
  where status in ('active', 'waiting_reply', 'paused_handoff')
)
update followup_enrollments e
set status = 'cancelled',
    cancel_reason = 'exclusivity_backfill',
    next_eval_at = null,
    updated_at = now()
from ranked
where e.id = ranked.id
  and ranked.rn > 1;

drop index if exists idx_followup_enrollments_one_live;
create unique index if not exists idx_followup_enrollments_one_live
  on followup_enrollments (organization_id, contact_id)
  where status in ('active', 'waiting_reply', 'paused_handoff');

alter table followup_enrollments
  add column if not exists agent_id uuid references ai_agents(id) on delete set null;
create index if not exists idx_followup_enrollments_agent
  on followup_enrollments (agent_id);
-- ---- bucket whatsapp-media (migration 0055) ----
insert into storage.buckets (id, name, public, file_size_limit)
values ('whatsapp-media', 'whatsapp-media', false, 52428800)
on conflict (id) do update set file_size_limit = excluded.file_size_limit;

-- ---- media multimodal: derivado + flags (migration 0058) ----
alter table messages
  add column if not exists media_derived_text text,
  add column if not exists media_derived_status text;
alter table ai_agent_versions
  add column if not exists multimodal_input boolean not null default true,
  add column if not exists video_frames_enabled boolean not null default false;

-- ---- split de mensagens por-agente (migration 0059) ----
alter table ai_agent_versions
  add column if not exists split_messages boolean not null default false,
  add column if not exists split_max_chars integer not null default 600;

-- ---- templates de script do vendedor (migration 0060) ----
create table if not exists message_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  owner_user_id uuid references auth.users(id) on delete cascade,
  title text not null,
  body text not null,
  shortcut text,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_message_templates_org on message_templates (organization_id);

alter table message_templates enable row level security;

drop policy if exists "message_templates_select" on message_templates;
create policy "message_templates_select" on message_templates
  for select using (
    (
      organization_id in (select fn_user_org_ids())
      and (owner_user_id is null or owner_user_id = auth.uid())
    )
    or fn_is_platform_admin()
  );

drop policy if exists "message_templates_write" on message_templates;
create policy "message_templates_write" on message_templates
  for all using (
    organization_id in (select fn_user_org_ids())
    and (
      (owner_user_id = auth.uid() and fn_role_at_least(organization_id, 'agent'))
      or (owner_user_id is null and fn_role_at_least(organization_id, 'manager'))
    )
  )
  with check (
    organization_id in (select fn_user_org_ids())
    and (
      (owner_user_id = auth.uid() and fn_role_at_least(organization_id, 'agent'))
      or (owner_user_id is null and fn_role_at_least(organization_id, 'manager'))
    )
  );

-- ---- snooze por conversa (migration 0062) ----
alter table conversations
  add column if not exists snooze_until timestamptz,
  add column if not exists snoozed_by_user_id uuid references auth.users(id) on delete set null,
  add column if not exists snoozed_at timestamptz;

create index if not exists idx_conversations_snooze_until
  on conversations (snooze_until) where snooze_until is not null;

-- (constraint agent_inbox_items_kind_check: definida uma vez só, no fim deste
--  apêndice — ver "vocabulário completo". 'snooze_expired' está lá.)

-- ---- notas internas de conversa (migration 0063) ----
create table if not exists conversation_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  body text not null,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists idx_conversation_notes_conversation
  on conversation_notes (conversation_id, created_at);

alter table conversation_notes enable row level security;

drop policy if exists "conversation_notes_select" on conversation_notes;
create policy "conversation_notes_select" on conversation_notes
  for select using (
    organization_id in (select fn_user_org_ids()) or fn_is_platform_admin()
  );

drop policy if exists "conversation_notes_write" on conversation_notes;
create policy "conversation_notes_write" on conversation_notes
  for all using (
    organization_id in (select fn_user_org_ids()) and fn_role_at_least(organization_id, 'agent')
  )
  with check (
    organization_id in (select fn_user_org_ids()) and fn_role_at_least(organization_id, 'agent')
  );

-- ---- human cases (migration 0066) ----
create table if not exists agent_cases (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  lead_id uuid references crm_leads(id) on delete set null,
  agent_id uuid references ai_agents(id) on delete set null,
  status text not null default 'awaiting_human'
    check (status in ('awaiting_human','awaiting_lead','resolved','escalated','cancelled')),
  title text not null,
  summary text not null,
  blocker text not null,
  context_snapshot jsonb not null default '{}'::jsonb,
  source text not null default 'agent' check (source in ('agent','guardrail_autofallback')),
  followup_attempts smallint not null default 0,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists agent_cases_open_idx
  on agent_cases (organization_id, status) where status in ('awaiting_human','awaiting_lead');
create index if not exists agent_cases_lead_idx on agent_cases (organization_id, lead_id);
create index if not exists agent_cases_conv_idx on agent_cases (organization_id, conversation_id);

create table if not exists agent_case_events (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  case_id uuid not null references agent_cases(id) on delete cascade,
  kind text not null check (kind in
    ('opened','human_replied','lead_asked','lead_provided','lead_unresponsive','resolved','escalated','cancelled')),
  actor_kind text not null check (actor_kind in ('agent','human','system','lead')),
  actor_user_id uuid references auth.users(id) on delete set null,
  human_action text check (human_action in ('resolved','need_lead_info','escalate')),
  body text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists agent_case_events_case_idx on agent_case_events (case_id, created_at);

alter table ai_agent_versions add column if not exists cases_enabled boolean not null default false;

alter table agent_cases enable row level security;
alter table agent_case_events enable row level security;
drop policy if exists tenant_isolation_agent_cases_all on agent_cases;
create policy tenant_isolation_agent_cases_all on agent_cases
  for all using (organization_id in (select fn_user_org_ids())) with check (organization_id in (select fn_user_org_ids()));
drop policy if exists tenant_isolation_agent_case_events_select on agent_case_events;
create policy tenant_isolation_agent_case_events_select on agent_case_events
  for select using (organization_id in (select fn_user_org_ids()));
drop policy if exists tenant_isolation_agent_case_events_insert on agent_case_events;
create policy tenant_isolation_agent_case_events_insert on agent_case_events
  for insert with check (organization_id in (select fn_user_org_ids()));

-- estender CHECKs de job_queue (kind + coerência kind⇔contato) p/ case_reply_turn
-- nomes reais conferidos no banco linkado: job_queue_kind_check (named) e
-- job_queue_check (anônimo, gerado pelo Postgres) para o CHECK de coerência.
alter table job_queue drop constraint if exists job_queue_kind_check;
alter table job_queue add constraint job_queue_kind_check
  -- 'operator_turn' (migration 0111, spec 16 §3.2) entra NESTE bloco, não num
  -- novo no fim: reconstruir a mesma constraint em N blocos quebra o update.sh
  -- de todo clone que já tenha uma linha de vocabulário posterior — os blocos
  -- antigos rodam antes e falham em cadeia. Vigiado por
  -- tests/unit/baseline-constraint-reconstruida.test.ts.
  check (kind in ('inbound_turn','followup_turn','watchdog','flywheel','case_reply_turn','operator_turn'));
alter table job_queue drop constraint if exists job_queue_turn_needs_contact;
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'job_queue'::regclass and contype='c'
     and pg_get_constraintdef(oid) ilike '%contact_id is not null%';
  if c is not null then execute format('alter table job_queue drop constraint %I', c); end if;
end $$;
alter table job_queue add constraint job_queue_turn_needs_contact
  check ((kind in ('inbound_turn','followup_turn','case_reply_turn','operator_turn')) = (contact_id is not null));

alter table cron_jobs drop constraint if exists cron_jobs_job_kind_check;
alter table cron_jobs add constraint cron_jobs_job_kind_check
  check (job_kind in ('inbound_turn','followup_turn','watchdog','flywheel','case_reply_turn'));

-- ---- agent_inbox_items: reconcilia kind check followup_dead+snooze_expired (migration 0065) ----

-- (constraint agent_inbox_items_kind_check: definida uma vez só, no fim deste
--  apêndice — ver "vocabulário completo". Os dois valores desta migration
--  estão lá.)
-- ---- memória geral da org: org_memory_versions/pointers/entries (migration 0067) ----
-- 0067: Memória Geral da Org (Fase 1 do épico harness — spec 2026-07-23).
-- Doc-mãe versionado (padrão versões-imutáveis+ponteiro do playbook 0004/0050)
-- + entradas de aprendizado individuais (manual | flywheel com aprovação humana).

create table if not exists org_memory_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  version_number int not null,
  content text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, version_number)
);

drop trigger if exists trg_org_memory_versions_immutable on org_memory_versions;
create trigger trg_org_memory_versions_immutable
  before update on org_memory_versions
  for each row execute function fn_agent_versions_immutable();

create table if not exists org_memory_pointers (
  organization_id uuid not null unique references organizations(id) on delete cascade,
  version_id uuid not null references org_memory_versions(id),
  updated_at timestamptz not null default now()
);

create table if not exists org_memory_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  title text not null check (length(title) > 0),
  body text not null check (length(body) > 0),
  source text not null check (source in ('manual', 'flywheel')),
  status text not null default 'active' check (status in ('proposed', 'active', 'archived')),
  proposal_id uuid references flywheel_distiller_proposals(id) on delete set null,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_org_memory_entries_org_status
  on org_memory_entries (organization_id, status, created_at);

-- Flywheel: novo destino de proposta (entry de memória da org).
alter table flywheel_distiller_proposals drop constraint if exists flywheel_distiller_proposals_type_check;
alter table flywheel_distiller_proposals add constraint flywheel_distiller_proposals_type_check
  check (type in ('playbook_bullet', 'golden_case', 'reentry_trigger', 'org_memory_entry'));

-- RLS (mesmo shape do loop tenant_isolation_* do baseline).
do $$
declare t text;
begin
  foreach t in array array['org_memory_versions', 'org_memory_pointers', 'org_memory_entries'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists tenant_isolation_%s_all on public.%I', t, t);
    execute format(
      'create policy tenant_isolation_%s_all on public.%I for all
         using (organization_id in (select * from public.fn_user_org_ids()))
         with check (organization_id in (select * from public.fn_user_org_ids()))',
      t, t
    );
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- ---- skills instaláveis: manifest + skill_activations + catálogo (migration 0068) ----
-- 0068: Skills instaláveis + marketplace (Fase 2 do épico harness — spec 2026-07-23).
-- Manifest de arquivos na versão de skill + telemetria de ativação + bucket de
-- assets + leitura do catálogo de plataforma por clientes user-scoped.

alter table skill_versions add column if not exists manifest jsonb not null default '[]'::jsonb;
alter table skill_versions add column if not exists forked_from_version_id uuid references skill_versions(id) on delete set null;

create table if not exists skill_activations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  skill_name text not null,
  skill_version_id uuid references skill_versions(id) on delete set null,
  trigger text not null check (trigger in ('hard', 'probe')),
  job_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists idx_skill_activations_org_created
  on skill_activations (organization_id, created_at);
create index if not exists idx_skill_activations_skill
  on skill_activations (organization_id, skill_name, created_at);

-- RLS das tabelas org-scoped novas (skill_activations). skill_versions/pointers já
-- estão no loop tenant_isolation do baseline; a leitura de catálogo é policy extra abaixo.
do $$
declare t text;
begin
  foreach t in array array['skill_activations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists tenant_isolation_%s_all on public.%I', t, t);
    execute format(
      'create policy tenant_isolation_%s_all on public.%I for all
         using (organization_id in (select * from public.fn_user_org_ids()))
         with check (organization_id in (select * from public.fn_user_org_ids()))',
      t, t
    );
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- Catálogo do marketplace: qualquer usuário autenticado LÊ as skills de plataforma
-- (organization_id null). Só SELECT; escrita de plataforma continua service-role.
drop policy if exists catalog_read_skill_versions on skill_versions;
create policy catalog_read_skill_versions on skill_versions for select
  to authenticated using (organization_id is null);
drop policy if exists catalog_read_skill_pointers on skill_pointers;
create policy catalog_read_skill_pointers on skill_pointers for select
  to authenticated using (organization_id is null);

-- ---- seed de skills de plataforma: catálogo inicial do marketplace (migration 0069) ----
-- 0069: seed de skills de plataforma (organization_id null) — catálogo inicial do
-- marketplace de skills (Fase 2 do épico harness). Duas skills de fábrica, qualidade
-- sobre quantidade: `objecao-preco` (vendas/genérico) e `agendamento` (clínicas/
-- serviços). Visíveis em toda org via a policy catalog_read_* acima.
--
-- Idempotente: cada bloco só insere versão+ponteiro se o ponteiro de plataforma
-- ainda não existir pra aquele nome — evita versão órfã (skill_versions é imutável,
-- sem UPDATE possível) e respeita o unique index uniq_skill_pointers_platform em
-- re-run.

do $seed$
declare
  v_id uuid;
begin
  if not exists (
    select 1 from skill_pointers where organization_id is null and name = 'objecao-preco'
  ) then
    insert into skill_versions (organization_id, name, description, body, matcher)
    values (
      null,
      'objecao-preco',
      'Playbook pra contornar objeção de preço no WhatsApp — diagnostica o motivo real por trás do "caro" antes de reagir, sem ceder desconto não autorizado.',
      $body$# Playbook: contornar objeção de preço

## Quando usar
O lead reagiu ao preço/valor com resistência — direta ("tá caro") ou indireta (pediu
desconto, comparou com concorrente, sumiu depois de saber o valor). Objetivo: entender
a objeção real por trás do "caro" antes de reagir, e nunca ceder desconto que a
organização não autorizou.

## Diagnóstico primeiro — "caro" quase nunca é sobre o número
Antes de responder, identifique QUAL objeção está por trás:

1. **Orçamento real insuficiente** — "não tenho esse valor agora", "tá fora do meu orçamento"
2. **Não enxergou o valor ainda** — "por que custa isso?", silêncio após o preço, comparação vaga
3. **Comparação com concorrente/opção mais barata** — "vi mais barato em [X]", "achei um mais em conta"
4. **Tática de negociação** — pede desconto de cara, sem ter perguntado nada sobre o produto antes
5. **Timing** — "vou pensar", "deixa eu ver com [sócio/cônjuge]" disfarçado de objeção de preço

Se não der pra diagnosticar pela mensagem, PERGUNTE antes de argumentar: "Só pra eu
te ajudar melhor — é o valor em si, ou você tava esperando algo diferente do que
ofereci?"

## If-then por diagnóstico

**SE orçamento real insuficiente:**
- Não insista no preço cheio. Ofereça: parcelamento, plano de entrada, versão
  reduzida — SÓ o que já estiver documentado como opção legítima na base de
  conhecimento do tenant.
- NUNCA invente parcelamento ou desconto que não está documentado — se não souber a
  política, faça handoff.
- Não deprecie o lead por não ter orçamento. Trate como informação, não como recusa.

**SE não enxergou valor ainda:**
- Não repita o preço. Reforce o resultado concreto que o cliente ganha (não a lista
  de features).
- Use um número ou prova social real se a base de conhecimento tiver ("cliente X
  reduziu Y em Z semanas").
- Pergunta de reengajamento: "Faz sentido pra você o que isso resolve, ou ficou
  alguma dúvida sobre o que está incluso?"

**SE comparação com concorrente:**
- Não ataque o concorrente. Pergunte o que ele viu de diferente ("o que tinha nessa
  outra opção?") — geralmente revela se é preço mesmo ou outro critério (prazo,
  suporte, garantia).
- Destaque o diferencial real do tenant (o que a base de conhecimento tiver de
  posicionamento), não genérico.

**SE tática de negociação (pediu desconto sem contexto):**
- Não ceda automaticamente. Pergunte o que faria sentido fechar hoje — muitas vezes
  revela o número real que o lead tem em mente.
- Desconto SÓ se a organização tiver uma política documentada na base de
  conhecimento (RAG) pra esse cenário. Sem isso, handoff — decisão de preço fora do
  script é gate humano.

**SE for timing disfarçado ("vou pensar"):**
- Não pressione. Pergunte objetivamente o que falta pra decidir ("o que te ajudaria
  a decidir com mais segurança agora?").
- Agende um follow-up explícito (data/hora), não deixe em aberto — lead que "vai
  pensar" sem follow-up marcado esfria.

## Regras duras
- Nunca prometa desconto, brinde ou condição especial que não esteja na base de
  conhecimento do tenant (RAG) ou explicitamente configurada no agente.
- Nunca minta sobre "promoção que acaba hoje" ou crie urgência falsa.
- Se o lead ficar hostil, ameaçar cancelar ou pedir falar com humano — handoff
  imediato, sem insistir mais uma vez.
- Se depois de 2 trocas de mensagem a objeção não resolver, ofereça handoff
  explicitamente: "Quer que eu chame alguém do time pra fechar os detalhes com
  você?"

## Exemplos de resposta (tom, não copiar literal)
- "Entendo — antes de eu te passar mais opção, me conta: é o valor em si ou esperava
  algo diferente do que te mostrei?"
- "Faz sentido. Sobre o valor, hoje temos [opção documentada]. Isso ajudaria a caber
  no seu momento?"
- "Show, deixa eu confirmar contigo: o que faria sentido fechar hoje pra você?"

## O que NÃO fazer
- Não despeje a lista de preços de novo sem contexto.
- Não ignore a objeção e mude de assunto.
- Não use frases de pressão tipo "só até hoje" sem essa condição existir de verdade.
$body$,
      '{"any_keywords": ["caro", "tá caro", "está caro", "muito caro", "desconto", "abaixar o preço", "mais barato", "achei mais barato", "fora do meu orçamento", "não cabe no orçamento", "valor alto", "preço alto"], "probe_keywords": ["quanto custa", "qual o valor", "quanto é", "parcelamento", "condições de pagamento", "forma de pagamento"]}'::jsonb
    )
    returning id into v_id;

    insert into skill_pointers (organization_id, name, version_id)
    values (null, 'objecao-preco', v_id);
  end if;
end
$seed$;

do $seed$
declare
  v_id uuid;
begin
  if not exists (
    select 1 from skill_pointers where organization_id is null and name = 'agendamento'
  ) then
    insert into skill_versions (organization_id, name, description, body, matcher)
    values (
      null,
      'agendamento',
      'Playbook pra marcar/remarcar horário (consulta, visita, sessão) — oferece opções concretas de agenda real, nunca inventa disponibilidade, confirma por escrito antes de fechar.',
      $body$# Playbook: marcar horário/agendamento

## Quando usar
O lead pede pra marcar um horário, consulta, visita, demonstração ou sessão —
qualquer compromisso com data/hora. Comum em clínicas, imobiliárias (visitas),
serviços e consultorias.

## Regra de ouro: nunca invente disponibilidade
Se o agente não tiver acesso confirmado à agenda real do tenant (integração/consulta
de disponibilidade), NÃO ofereça horário específico. Diga que vai confirmar e faça
handoff, ou pergunte a preferência do lead e sinalize que a confirmação virá em
seguida. Prometer um horário que depois não existe quebra confiança e gera
reagendamento forçado.

## Fluxo padrão (if-then)

**1. Identifique o serviço/motivo antes de oferecer horário**
- SE o lead só disse "quero agendar" sem contexto → pergunte o motivo/serviço
  primeiro. Agendar sem saber o quê gera erro de encaixe (ex.: consulta de 20min
  marcada num slot de 1h de procedimento).

**2. Ofereça opções fechadas, não uma pergunta aberta**
- SE tiver acesso à agenda real → ofereça 2-3 horários concretos ("tenho terça 14h
  ou quarta 10h, qual funciona?"). Pergunta aberta tipo "qual horário você prefere?"
  gera ida e volta desnecessária e trava a conversa.
- SE não tiver acesso à agenda → não invente. Diga algo como "vou confirmar a
  disponibilidade e te retorno em instantes" e sinalize handoff/task pra quem tem
  acesso.

**3. Colete os dados obrigatórios antes de confirmar**
- Nome completo do lead (ou confirme o que já está no CRM).
- Serviço/motivo específico.
- Unidade/local, se o tenant tiver mais de uma (clínica com filiais, imobiliária com
  múltiplos imóveis).
- Se for reagendamento, o horário anterior a ser substituído.

**4. Confirme por escrito antes de encerrar**
- SE o lead aceitar um horário → repita de volta por escrito: "Confirmado:
  [serviço] dia [data] às [hora], em [local]. Confirma pra mim?"
- Só considere o agendamento fechado depois do "sim"/confirmação explícita do lead —
  silêncio ou "ok" vago não é confirmação suficiente pra compromissos com custo de
  no-show alto (ex. consulta médica, visita a imóvel).

**5. Reagendamento e cancelamento**
- SE o lead pedir pra remarcar → trate como novo agendamento: pergunte novo horário
  disponível, e cancele/substitua o anterior explicitamente (não deixe os dois
  marcados).
- SE o lead pedir pra cancelar → confirme o cancelamento e pergunte se quer remarcar
  pra outra data, sem pressionar.

**6. Risco de no-show**
- Se o negócio tiver política de confirmação D-1 documentada na base de
  conhecimento, siga-a (ex.: mensagem de lembrete automática). Se não houver, não
  invente política — apenas confirme o agendamento normalmente.

## Regras duras
- Nunca confirme horário sem ter checado disponibilidade real (ou sem sinalizar que
  ainda vai confirmar).
- Nunca marque dois compromissos conflitantes pro mesmo lead sem avisar.
- Se o lead pedir um horário fora do funcionamento do negócio (ex. domingo,
  madrugada) e isso não estiver nas regras do tenant, não confirme — explique a
  janela real de atendimento.
- Dado sensível (endereço completo, documento) só é coletado se o fluxo do tenant
  realmente exigir — não peça informação a mais que o agendamento precisa.

## Exemplos de resposta (tom, não copiar literal)
- "Pra eu te encaixar certo: é pra qual serviço/motivo?"
- "Tenho quinta às 15h ou sexta às 9h — qual fica melhor pra você?"
- "Confirmado: consulta dia 28/07 às 15h, na unidade Centro. Pode confirmar pra
  mim?"

## O que NÃO fazer
- Não pergunte "qual horário você prefere?" sem oferecer opções concretas quando
  você tem a agenda.
- Não confirme agendamento sem resposta explícita do lead.
- Não invente disponibilidade que você não checou.
$body$,
      '{"any_keywords": ["agendar", "marcar horário", "marcar consulta", "marcar uma visita", "agenda", "que horas vocês", "horário disponível", "remarcar", "reagendar", "cancelar o horário", "desmarcar"], "probe_keywords": ["que horas", "qual dia", "tem vaga", "disponibilidade"]}'::jsonb
    )
    returning id into v_id;

    insert into skill_pointers (organization_id, name, version_id)
    values (null, 'agendamento', v_id);
  end if;
end
$seed$;


-- ---- ai_pricing backfill (migration 0113, renumerada de 0068) ----
-- O NNNN original colidia com `0068_skills_marketplace`. O arquivo foi renomeado
-- (o timestamp `20260725150000` NAO mudou, entao a version do Supabase e a mesma e
-- ninguem re-aplica). As strings `notes` abaixo continuam dizendo "backfill 0068"
-- DE PROPOSITO: sao dado ja gravado nos bancos existentes, e reescrever dado para
-- acompanhar renumeracao de arquivo criaria divergencia entre clone antigo e novo
-- sem ganho nenhum. O guard `not exists` casa por `model`, nunca por `notes`.
-- BUG: ai_pricing nascia VAZIA em toda instalação nova. Os seeds existem só na
-- migration 0010, mas a cadeia fresh não sobe (as 10 primeiras são stubs
-- `SELECT 1;`) e quem instala aplica este baseline, que semeia ai_models mas
-- não ai_pricing. Com a tabela vazia, computeCost() devolve 0 sem log e o teto
-- de ai_budgets nunca dispara. Derivado de ai_models: idempotente e
-- auto-curativo, cobre qualquer modelo futuro do catálogo.
insert into public.ai_pricing (model, prompt_cents_per_million_tokens, completion_cents_per_million_tokens, notes)
select
  m.model_id,
  m.input_price_per_million_cents,
  m.output_price_per_million_cents,
  'backfill 0068 a partir de ai_models'
from public.ai_models m
where m.deprecated_at is null
  and m.input_price_per_million_cents is not null
  and m.output_price_per_million_cents is not null
  and not exists (
    select 1 from public.ai_pricing p
    where p.model = m.model_id and p.superseded_at is null
  );

-- Embedding do RAG — não vive em ai_models.
insert into public.ai_pricing (model, embedding_cents_per_million_tokens, notes)
select 'openai/text-embedding-3-small', 20, 'backfill 0068 (seed original da 0010)'
where not exists (
  select 1 from public.ai_pricing p
  where p.model = 'openai/text-embedding-3-small' and p.superseded_at is null
);
-- ---- crm_leads owner_kind/owner_agent_id (migration 0070) ----
-- CRM Vivo · Wave 1 (CORE 1): a IA é dona do NEGÓCIO, não só da conversa.
-- Mesmo padrão da 0032 (conversations.assignee_kind): backfill ANTES da
-- constraint, CHECK de coerência em forma de implicação, drop+add re-aplicável.
-- owner_agent_id aponta para ai_agents (identidade), NUNCA ai_agent_versions —
-- o tooltip "Nome · vN" resolve a versão publicada por join na hora de exibir.
alter table public.crm_leads
  add column if not exists owner_kind text
  check (owner_kind in ('user','ai'));

alter table public.crm_leads
  add column if not exists owner_agent_id uuid
  references public.ai_agents(id) on delete set null;

update public.crm_leads
   set owner_kind = 'user'
 where owner_user_id is not null
   and owner_kind is distinct from 'user';

update public.crm_leads
   set owner_kind = null
 where owner_user_id is null
   and owner_agent_id is null
   and owner_kind = 'user';

update public.crm_leads
   set owner_kind = 'ai'
 where owner_agent_id is not null
   and owner_kind is distinct from 'ai';

alter table public.crm_leads
  drop constraint if exists crm_leads_owner_kind_coherence;
alter table public.crm_leads
  add constraint crm_leads_owner_kind_coherence check (
    (owner_kind = 'user' and owner_user_id is not null and owner_agent_id is null) or
    (owner_kind = 'ai'   and owner_agent_id is not null and owner_user_id is null) or
    (owner_kind is null)
  );

create index if not exists idx_crm_leads_owner_agent
  on public.crm_leads (organization_id, owner_agent_id)
  where owner_agent_id is not null;

-- lead.assigned passa a cobrir o dono agente (corpo da 0043 + ramo do agente).
create or replace function public.fn_emit_event_on_lead_change() returns trigger
    language plpgsql
    set search_path to 'public', 'pg_temp'
    as $$
begin
  if tg_op = 'INSERT' then
    return new;
  end if;

  if new.status is distinct from old.status then
    if new.status = 'won' then
      perform public.fn_log_event(new.organization_id, 'lead.won',
        jsonb_build_object('lead_id', new.id, 'value_cents', new.value_cents));
    elsif new.status = 'lost' then
      perform public.fn_log_event(new.organization_id, 'lead.lost',
        jsonb_build_object('lead_id', new.id, 'lost_reason', new.lost_reason));
    elsif new.status = 'open' then
      perform public.fn_log_event(new.organization_id, 'lead.reopened',
        jsonb_build_object('lead_id', new.id));
    end if;
  end if;

  if new.owner_user_id is distinct from old.owner_user_id
     or new.owner_agent_id is distinct from old.owner_agent_id then
    perform public.fn_log_event(new.organization_id, 'lead.assigned',
      jsonb_build_object(
        'lead_id', new.id,
        'from_user_id', old.owner_user_id, 'to_user_id', new.owner_user_id,
        'from_agent_id', old.owner_agent_id, 'to_agent_id', new.owner_agent_id,
        'owner_kind', new.owner_kind));
  end if;

  return new;
end$$;


-- ---- crm_lead_activities: barramento único da vida do lead (migration 0071) ----
-- Wave 3, bloco 1 do CRM Vivo. actor_kind/actor_agent_id/reason/evidence +
-- stage_changed_at em crm_leads. Realtime desta tabela entra pelo array do loop
-- de publicação, acima.
--
-- FRONTEIRA DIRC: source_module/source_id = O QUE ORIGINOU (um ponteiro);
-- evidence = O QUE SUSTENTA (N referências). evidence nunca repete o source_id.
--
-- Idempotente e AUTO-CURATIVO: o backfill lê actor_kind/reason de metadata (onde
-- o orquestrador de handoff já os grava hoje) ANTES de a constraint existir, e
-- degrada para 'system' a linha marcada como 'ai' sem lastro nenhum — senão o
-- update.sh de um clone quebraria ao criar a constraint.

-- ---------------------------------------------------------------------------
-- A. Colunas do barramento
-- ---------------------------------------------------------------------------

-- 'contact' é a PESSOA do outro lado — não 'lead': deste lado da casa lead é o
-- NEGÓCIO (crm_leads), então 'lead' diria "o negócio falou". Também não
-- adotamos 'agent'/'human' de agent_case_events: aqui 'agent' já é papel humano
-- de RBAC (viewer < agent < manager < admin) e colidiria.
alter table public.crm_lead_activities
  add column if not exists actor_kind text
  check (actor_kind in ('user','ai','system','rule','contact'));

alter table public.crm_lead_activities
  add column if not exists actor_agent_id uuid
  references public.ai_agents(id) on delete set null;

-- O PORQUÊ em texto legível por humano — é o que a timeline mostra embaixo da
-- linha, e o que torna a decisão da IA discutível em vez de mágica.
alter table public.crm_lead_activities
  add column if not exists reason text;

-- O LASTRO: {"run_ids": [...], "trace_ids": [...]} — mesmo formato de
-- flywheel_distiller_proposals.evidence.
alter table public.crm_lead_activities
  add column if not exists evidence jsonb;

comment on column public.crm_lead_activities.actor_kind is
  'Quem agiu: user (humano do time) | ai (agente) | system (o produto) | rule (automação) | contact (a pessoa atendida). NUNCA "lead": lead aqui é o negócio.';
comment on column public.crm_lead_activities.evidence is
  'O que SUSTENTA a atividade: {"run_ids":[],"trace_ids":[]} (N referências). Não confundir com source_module/source_id, que é O QUE ORIGINOU (um ponteiro). evidence nunca repete o source_id — origem não é prova.';
comment on column public.crm_lead_activities.reason is
  'Por que esta atividade existe, em texto legível. Sem PII: é exibido na timeline e exportado no LGPD.';

-- ---------------------------------------------------------------------------
-- B. Backfill A PARTIR DO JSONB — antes de qualquer default e antes da
--    constraint (doutrina de migrations §8).
--
--    actor_kind e reason JÁ são gravados hoje dentro de metadata
--    (lib/ai/handoff/orchestrator.ts). Backfillar tudo como 'system' apagaria
--    informação que já existe — seria perda de dado disfarçada de migration.
-- ---------------------------------------------------------------------------

-- ORDEM IMPORTA: o lastro sobe ANTES do ator. Promover para 'ai' e degradar
-- depois funciona na primeira aplicação (a constraint ainda não existe) e
-- QUEBRA no update.sh de um clone, onde ela já existe e recusa a linha no ato.
-- Aqui nenhum estado intermediário inválido chega a existir.

-- 1. Lastro que já existe em metadata sobe para a coluna (nunca inventado).
update public.crm_lead_activities
   set evidence = jsonb_strip_nulls(
         jsonb_build_object(
           'run_ids',   metadata->'run_ids',
           'trace_ids', metadata->'trace_ids'
         ))
 where evidence is null
   and (jsonb_typeof(metadata->'run_ids') = 'array'
     or jsonb_typeof(metadata->'trace_ids') = 'array');

-- 2. Atores que não são a IA: promoção direta.
update public.crm_lead_activities
   set actor_kind = metadata->>'actor_kind'
 where actor_kind is null
   and metadata->>'actor_kind' in ('user','system','rule','contact');

-- 3. 'ai' só quando há execução que sustente a afirmação.
update public.crm_lead_activities
   set actor_kind = 'ai'
 where actor_kind is null
   and metadata->>'actor_kind' = 'ai'
   and (coalesce(jsonb_array_length(evidence->'run_ids'), 0) > 0
     or coalesce(jsonb_array_length(evidence->'trace_ids'), 0) > 0);

-- 4. 'ai' sem lastro nenhum vira 'system': o registro continua inteiro (o
--    reason é preservado); o que se recusa a afirmar é a AUTORIA da IA, porque
--    não há execução que a sustente.
update public.crm_lead_activities
   set actor_kind = 'system'
 where actor_kind is null
   and metadata->>'actor_kind' = 'ai';

update public.crm_lead_activities
   set reason = metadata->>'reason'
 where reason is null
   and nullif(metadata->>'reason', '') is not null;

-- 5. Quem tem autor humano registrado é 'user' — o dado está na coluna, só não
--    estava nomeado.
update public.crm_lead_activities
   set actor_kind = 'user'
 where actor_kind is null
   and performed_by_user_id is not null;

-- 6. Cura de banco onde a constraint ainda não existia e uma linha 'ai' entrou
--    sem lastro (não alcançável depois que a constraint existe — por isso vem
--    por último e é no-op no caminho feliz).
update public.crm_lead_activities
   set actor_kind = 'system'
 where actor_kind = 'ai'
   and coalesce(jsonb_array_length(evidence->'run_ids'), 0) = 0
   and coalesce(jsonb_array_length(evidence->'trace_ids'), 0) = 0;

-- ---------------------------------------------------------------------------
-- C. Constraint de lastro (drop+add — re-aplicável)
--
--    A doutrina do CORE 3 ("número sem porquê não é gravado") aplicada uma wave
--    antes: se a IA afirma algo na timeline, existe run_id ou trace_id que
--    sustente. `jsonb_array_length(...) > 0`, NÃO `evidence ? 'run_ids'` — a
--    segunda passa com array VAZIO, e lastro vazio não sustenta nada.
-- ---------------------------------------------------------------------------

alter table public.crm_lead_activities
  drop constraint if exists crm_lead_activities_ai_needs_evidence;
-- A constraint NÃO é recriada aqui, e sim uma vez só mais abaixo, na versão que
-- também aceita `llm_call_ids`. Recriá-la com a lista da época derrubava o
-- update.sh de quem já tem atividade de IA cuja evidência é só `llm_call_ids`.

-- Timeline por ator (o dossiê filtra "só o que a IA fez"), parcial porque a
-- maioria das linhas não é de agente.
create index if not exists idx_lead_activities_org_actor_agent
  on public.crm_lead_activities (organization_id, actor_agent_id, performed_at desc)
  where actor_agent_id is not null;

-- ---------------------------------------------------------------------------
-- D. stage_changed_at — de carona, porque esta wave passa a emitir atividade na
--    mudança de estágio. Sem a coluna, "3d em Negociação" no card continua
--    medindo tempo SEM RESPOSTA (last_activity_at) e mente sobre o estágio.
--    Trigger puro: carimba a coluna, sem HTTP (doutrina — trigger nunca faz rede).
-- ---------------------------------------------------------------------------

alter table public.crm_leads
  add column if not exists stage_changed_at timestamptz;

-- Bancos existentes: o melhor palito honesto é a criação do lead — nunca
-- inventar uma data de entrada no estágio que ninguém registrou.
update public.crm_leads
   set stage_changed_at = created_at
 where stage_changed_at is null;

alter table public.crm_leads
  alter column stage_changed_at set default now();

create or replace function public.fn_stamp_stage_changed_at() returns trigger
    language plpgsql
    set search_path to 'public', 'pg_temp'
    as $$
begin
  if tg_op = 'INSERT' then
    new.stage_changed_at := coalesce(new.stage_changed_at, now());
  elsif new.stage_id is distinct from old.stage_id then
    new.stage_changed_at := now();
  end if;
  return new;
end$$;

drop trigger if exists trg_stamp_stage_changed_at on public.crm_leads;
create trigger trg_stamp_stage_changed_at
  before insert or update on public.crm_leads
  for each row execute function public.fn_stamp_stage_changed_at();

comment on column public.crm_leads.stage_changed_at is
  'Quando o lead entrou no estágio atual. Carimbado por trigger. É o relógio de "tempo no estágio" do card — distinto de last_activity_at, que é "tempo sem resposta".';

-- ---- evidence: lastro pode apontar para llm_calls (migration 0072) ----
-- Só AFROUXA a constraint (acrescenta uma terceira forma de lastro), então
-- nenhuma linha existente passa a violá-la e o update.sh de clone não quebra.
-- Idempotente por drop+add.
alter table public.crm_lead_activities
  drop constraint if exists crm_lead_activities_ai_needs_evidence;

alter table public.crm_lead_activities
  add constraint crm_lead_activities_ai_needs_evidence check (
    actor_kind <> 'ai'
    or coalesce(jsonb_array_length(evidence->'run_ids'), 0) > 0
    or coalesce(jsonb_array_length(evidence->'trace_ids'), 0) > 0
    or coalesce(jsonb_array_length(evidence->'llm_call_ids'), 0) > 0
  );

comment on column public.crm_lead_activities.evidence is
  'O que SUSTENTA a atividade (N referências), cada chave apontando para UMA tabela: run_ids→ai_agent_runs, trace_ids→o trace do turno, llm_call_ids→llm_calls. Não confundir com source_module/source_id, que é O QUE ORIGINOU (um ponteiro). evidence nunca repete o source_id — origem não é prova.';

-- ---- identidade da próxima ação + caixa para o caso ambíguo (migration 0073) ----
-- Duas mudanças independentes, ambas idempotentes e auto-curativas.
--
-- `next_action_seq` distingue "a mesma proposta" de "a mesma frase": o agente
-- pode reescrever o mesmo texto significando outra coisa, e a autorização
-- humana precisa saber QUAL proposta foi lida. Default 0 para as linhas que já
-- existem — o primeiro reescrever leva a 1, que é o correto: a proposta que
-- estava lá antes desta coluna nunca foi autorizada por ninguém.
alter table public.lead_state
  add column if not exists next_action_seq bigint not null default 0;

comment on column public.lead_state.next_action_seq is
  'Identidade da proposta corrente. Incrementa a CADA escrita de next_action, inclusive quando o texto novo é idêntico ao anterior — é o que distingue "a mesma proposta" de "a mesma frase". A autorização humana carrega este número; a execução o compara. Nunca usar updated_at no lugar: ele se move por outras escritas do estado.';

-- Só ACRESCENTA um kind, então nenhuma linha existente passa a violar a
-- constraint e o update.sh de um clone não quebra. Idempotente por drop+add.
-- `followup_dead` está aqui porque a lista é a do BASELINE, não a do banco de
-- dev: os dois divergiram, e o dev está com uma versão ANTERIOR da constraint
-- (sem esse valor) enquanto lib/followup/engine.ts insere exatamente esse kind.
-- Reconstruir a partir do banco apagaria o valor e mataria, em silêncio, o
-- aviso de enrollment morto. A fonte de verdade é o arquivo versionado.
-- (constraint agent_inbox_items_kind_check: definida uma vez só, no fim deste
--  apêndice — ver "vocabulário completo". 'next_action_ambiguous' está lá.)

-- ---- score de probabilidade com evidência, em tabela própria (migrations 0074+0075) ----
-- O baseline salta o passo intermediário de propósito: quem instala do zero não
-- deve ganhar as colunas em `crm_leads` para perdê-las na linha seguinte. Para
-- quem ATUALIZA (update.sh) o bloco continua correto — o `drop column if exists`
-- e a migração de dados abaixo cuidam de um clone que já aplicou a 0074.
create table if not exists public.crm_lead_scores (
  lead_id uuid primary key references public.crm_leads(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ai_probability numeric(5, 2),
  ai_probability_reason text,
  ai_probability_evidence jsonb not null default '{}'::jsonb,
  ai_probability_at timestamptz,
  ai_probability_band text,
  ai_probability_band_since timestamptz,
  updated_at timestamptz not null default now()
);

-- `primary key (lead_id)` já garante o 1:1 — um lead tem no máximo uma linha de
-- score. FK com `on delete cascade`: score é sobre o negócio, e sem o negócio
-- não significa nada (não é histórico, é estado corrente).

comment on table public.crm_lead_scores is
  'Score de probabilidade por lead, FORA de crm_leads de propósito. Ver o cabeçalho da migration 0075: trazer estes campos de volta reintroduz o pulso que mente (board assina crm_leads) e o 409 fantasma (trava otimista do move + trigger de updated_at). Fica FORA da publicação supabase_realtime — recálculo é telemetria e não deve pintar card; quem pinta é a atividade emitida na travessia de faixa.';

-- ---- migra o que existir (clones que já aplicaram a 0074) ----
-- SQL DINÂMICO de propósito: numa instalação NOVA as colunas nunca existiram em
-- `crm_leads`, e o Postgres faz o parse do comando ANTES de avaliar qualquer
-- guarda — `where exists (select from information_schema...)` não salva, porque
-- o erro é de parse, não de execução. Só `execute` adia a resolução do nome.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'crm_leads'
       and column_name = 'ai_probability'
  ) then
    execute $mig$
      insert into public.crm_lead_scores (
        lead_id, organization_id, ai_probability, ai_probability_reason,
        ai_probability_evidence, ai_probability_at, ai_probability_band,
        ai_probability_band_since
      )
      select l.id, l.organization_id, l.ai_probability, l.ai_probability_reason,
             coalesce(l.ai_probability_evidence, '{}'::jsonb), l.ai_probability_at,
             l.ai_probability_band, l.ai_probability_band_since
        from public.crm_leads l
       where l.ai_probability is not null
      on conflict (lead_id) do nothing
    $mig$;
  end if;
end $$;

alter table public.crm_leads
  drop constraint if exists crm_leads_score_needs_reason,
  drop constraint if exists crm_leads_score_range,
  drop constraint if exists crm_leads_score_band_check,
  drop constraint if exists crm_leads_score_band_coherence;

alter table public.crm_leads
  drop column if exists ai_probability,
  drop column if exists ai_probability_reason,
  drop column if exists ai_probability_evidence,
  drop column if exists ai_probability_at,
  drop column if exists ai_probability_band,
  drop column if exists ai_probability_band_since;

-- ---- as mesmas garantias, agora na tabela certa ----
alter table public.crm_lead_scores
  drop constraint if exists crm_lead_scores_needs_reason;

-- ---- evidência do score: FONTE ÚNICA (migrations 0076+0077) ----
-- ---- limpeza ANTES da constraint ----
-- Hoje são 0 linhas de 2, mas o CHECK nunca exigiu âncora DENTRO do fator: um
-- clone pode ter `factors` sem âncora nenhuma, e essa linha passa hoje e
-- reprovaria depois. Apaga o SCORE — não inventa âncora, porque âncora
-- fabricada aponta para um registro que não sustenta nada e é indistinguível
-- da verdadeira.
update public.crm_lead_scores
   set ai_probability = null,
       ai_probability_reason = null,
       ai_probability_at = null,
       ai_probability_band = null,
       ai_probability_band_since = null,
       updated_at = now()
 where ai_probability is not null
   and (
     coalesce(jsonb_array_length(ai_probability_evidence -> 'factors'), 0) = 0
     or not (ai_probability_evidence @? '$.factors[*].ancora')
   );

alter table public.crm_lead_scores
  drop constraint if exists crm_lead_scores_needs_reason;

alter table public.crm_lead_scores
  add constraint crm_lead_scores_needs_reason check (
    ai_probability is null
    or (
      ai_probability_reason is not null
      and btrim(ai_probability_reason) <> ''
      -- LEGÍVEL: o que o hover revela.
      and coalesce(jsonb_array_length(ai_probability_evidence -> 'factors'), 0) > 0
      -- RASTREÁVEL: para onde o clique leva. `@?` com jsonpath em vez de
      -- subconsulta, que CHECK não aceita — e é o que permite exigir a âncora
      -- DENTRO do fator, mantendo a fonte única.
      and ai_probability_evidence @? '$.factors[*].ancora'
    )
  );

comment on column public.crm_lead_scores.ai_probability_evidence is
  'O QUE SUSTENTA o score, em FONTE ÚNICA: `factors` — cada parcela com `pontos` (com sinal), `frase` legível e, quando há ponto no tempo, `ancora` {kind,id}. A constraint exige factors não-vazio E pelo menos um fator com âncora: legível sem rastreável é adjetivo, rastreável sem legível é um id que ninguém entende. NÃO unificar com o formato de crm_lead_activities.evidence (arrays de ids por tabela): a diferença é deliberada e está explicada na migration 0077 — atividade cita FATOS de N tabelas, score cita PARCELAS de um cálculo. Unificar reintroduz as duas listas que já divergiram uma vez (0076), com o banco cobrando uma chave e a tela lendo outra.';

alter table public.crm_lead_scores
  drop constraint if exists crm_lead_scores_range;

alter table public.crm_lead_scores
  add constraint crm_lead_scores_range check (
    ai_probability is null or (ai_probability >= 0 and ai_probability <= 100)
  );

alter table public.crm_lead_scores
  drop constraint if exists crm_lead_scores_band_check;

alter table public.crm_lead_scores
  add constraint crm_lead_scores_band_check check (
    ai_probability_band is null
    or ai_probability_band = any (array['frio', 'morno', 'quente']::text[])
  );

alter table public.crm_lead_scores
  drop constraint if exists crm_lead_scores_band_coherence;

alter table public.crm_lead_scores
  add constraint crm_lead_scores_band_coherence check (
    ai_probability_band is null
    or ai_probability is null
    or (ai_probability_band = 'quente' and ai_probability >= 65)
    or (ai_probability_band = 'morno' and ai_probability >= 35 and ai_probability <= 75)
    or (ai_probability_band = 'frio' and ai_probability <= 45)
  );

comment on column public.crm_lead_scores.ai_probability is
  'Probabilidade 0-100 por FÓRMULA determinística sobre sinais que já existem — nunca chamada de modelo. Com fórmula, o reason é DERIVADO do cálculo e "número sem porquê" é impossível por construção; com modelo, a frase é gerada ao lado do número e a lei só pareceria cumprida. null = sinal insuficiente, e é estado legítimo: nunca zero.';

comment on column public.crm_lead_scores.ai_probability_reason is
  'O PORQUÊ em português, obrigatório por constraint quando há score. Existe para o humano poder DISCORDAR: sem razão citável o número é opinião sem apelação.';

comment on column public.crm_lead_scores.ai_probability_evidence is
  'O QUE SUSTENTA (N referências): activity_ids→crm_lead_activities, message_ids→messages, checkpoint_ids→lead_checkpoints. A constraint exige pelo menos uma — razão sem referência é adjetivo.';

comment on column public.crm_lead_scores.ai_probability_band is
  'Faixa exibida. Persistida porque histerese precisa da faixa anterior; o CHECK de coerência torna divergir do score IMPOSSÍVEL de gravar, não só improvável. Cortes em FAIXA_LIMITES (lib/kanban/score-band.ts), fonte única do CHECK, do emissor e da UI.';

-- ---- tenancy ----
alter table public.crm_lead_scores enable row level security;

drop policy if exists tenant_isolation_crm_lead_scores_all on public.crm_lead_scores;
create policy tenant_isolation_crm_lead_scores_all on public.crm_lead_scores
  for all
  using (organization_id in (select fn_user_org_ids()))
  with check (organization_id in (select fn_user_org_ids()));

create index if not exists idx_crm_lead_scores_org_band
  on public.crm_lead_scores (organization_id, ai_probability_band);

-- FORA da publicação de realtime — é o ponto inteiro desta migration. Remover
-- é defensivo: se um clone tiver a tabela publicada por engano, isto corrige.
do $$
begin
  if exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'crm_lead_scores'
  ) then
    execute 'alter publication supabase_realtime drop table public.crm_lead_scores';
  end if;
end $$;

-- ---- estado de risco do negócio (migration 0078) ----
-- 0078 — "esfriando" deixa de ser adjetivo calculado e vira ESTADO do negócio
--
-- O QUE ESTAVA ERRADO: `classifyRisk` é função pura recalculada a cada leitura,
-- e os únicos chamadores são rotas de LEITURA. Nenhum worker, nenhum emissor.
-- Consequência medida: "esfriando" não existia até alguém abrir a tela, não
-- tinha tipo de atividade (o vocabulário não sabia dizer "esfriou" nem
-- "voltou"), e — o pior — não era RETIDO: não havia como responder "há quanto
-- tempo está esfriando" nem "quantas vezes já esfriou e voltou".
--
-- A ironia que motivou a wave: o cabeçalho de `lib/leads/risk-radar.ts` declara
-- ser o desilhamento C1 da doutrina do sistema vivo — "uma demanda que esfriou
-- e não tem próximo passo garantido está morrendo sem ninguém ver; o radar a
-- torna visível". Mas tornar visível numa tela que ninguém é obrigado a abrir
-- não é mecanismo anti-morte: é a mesma morte, com testemunha opcional.
--
-- ⚠️ POR QUE FORA DE `crm_leads` — os dois motivos são os MESMOS da 0075 e
-- valem palavra por palavra aqui; leia aquele cabeçalho antes de "simplificar"
-- isto para dentro do lead:
--   1. o PULSO QUE MENTE — o board assina `crm_leads`; uma varredura de risco
--      em lote faria dezenas de cards piscarem sem novidade nenhuma;
--   2. o 409 FANTASMA — `trg_crm_leads_updated_at` invalida a trava otimista do
--      arrasto em voo, e o usuário recebe "alguém editou este lead" quando
--      ninguém editou.
--
-- ⚠️ MAS ESTA TABELA FICA **DENTRO** DA PUBLICAÇÃO DE REALTIME, ao contrário da
-- `crm_lead_scores`. Isso NÃO contradiz a 0075 — é a mesma regra aplicada:
-- "silêncio para telemetria, pulso para mudança de estado". Score é telemetria
-- (número que se move sozinho o tempo todo); risco é transição discreta e rara
-- que EXIGE ação humana. É por aqui que a borda de aviso aparece sem reload,
-- sem tocar o lead — e é justamente não tocar o lead que preserva 1 e 2.
--
-- A CONTRAPARTIDA, que vive no escritor e não dá para o banco garantir: só
-- escreva quando o BUCKET MUDAR. Um `update` que só refresca `detected_at`
-- publicaria evento de realtime sem mudança de estado, e o board voltaria a
-- piscar à toa — o defeito que esta separação toda existe para impedir.

create table if not exists public.crm_lead_risk_states (
  lead_id uuid primary key references public.crm_leads(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bucket text not null,
  -- QUANDO O NEGÓCIO ENTROU NESTE ESTADO, que não é quando o sistema percebeu.
  -- A distinção é o que torna o acervo honesto: os 48 negócios já frios no dia
  -- da estreia entram com `since` no passado (o instante em que de fato
  -- esfriaram) e `detected_at` em now. Sem os dois campos, o histórico diria
  -- que todos esfriaram no mesmo minuto — e diria isso para sempre.
  since timestamptz not null,
  detected_at timestamptz not null default now(),
  -- A janela do estágio usada na decisão, gravada JUNTO. Sem ela, mudar
  -- `expected_duration_hours` reescreve retroativamente o significado de todo
  -- estado já gravado, e ninguém consegue explicar por que aquele negócio
  -- esfriou "às 24h" se hoje o estágio diz 72h.
  cold_hours numeric not null,
  updated_at timestamptz not null default now()
);

comment on table public.crm_lead_risk_states is
  'Estado de risco por negócio (wave 7 — o ciclo). FORA de crm_leads pelos motivos da 0075 (pulso que mente, 409 fantasma), mas DENTRO da publicação supabase_realtime, ao contrário de crm_lead_scores: risco é mudança de estado, não telemetria. O escritor só grava quando o bucket muda.';

alter table public.crm_lead_risk_states
  drop constraint if exists crm_lead_risk_states_bucket_check;
alter table public.crm_lead_risk_states
  add constraint crm_lead_risk_states_bucket_check check (
    bucket = any (array['em_dia', 'em_voo', 'em_risco', 'critico']::text[])
  );

-- Estado não começa no futuro. Trava o erro de gravar `since = now + janela`
-- (o instante em que VAI esfriar) em vez de `last_activity_at + janela`.
alter table public.crm_lead_risk_states
  drop constraint if exists crm_lead_risk_states_since_no_passado;
alter table public.crm_lead_risk_states
  add constraint crm_lead_risk_states_since_no_passado check (since <= detected_at);

alter table public.crm_lead_risk_states
  drop constraint if exists crm_lead_risk_states_cold_hours_positivo;
alter table public.crm_lead_risk_states
  add constraint crm_lead_risk_states_cold_hours_positivo check (cold_hours > 0);

alter table public.crm_lead_risk_states enable row level security;

drop policy if exists tenant_isolation_crm_lead_risk_states_all on public.crm_lead_risk_states;
create policy tenant_isolation_crm_lead_risk_states_all on public.crm_lead_risk_states
  for all
  using (organization_id in (select fn_user_org_ids()))
  with check (organization_id in (select fn_user_org_ids()));

-- O radar lê "quem está em risco nesta org", nesta ordem.
create index if not exists idx_crm_lead_risk_states_org_bucket
  on public.crm_lead_risk_states (organization_id, bucket, since);

-- DENTRO da publicação — ver o cabeçalho. Idempotente: só adiciona se faltar.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'crm_lead_risk_states'
  ) then
    execute 'alter publication supabase_realtime add table public.crm_lead_risk_states';
  end if;
end $$;

-- ---- relógio do silêncio só conta interação (migration 0079) ----
-- 0079 — o relógio do silêncio para de ser zerado pela constatação do silêncio
--
-- O DEFEITO, medido antes de escrever: `fn_update_last_activity_at` carimba
-- `crm_leads.last_activity_at` para QUALQUER atividade, sem filtro de tipo. E
-- `last_activity_at` é exatamente o relógio que decide o esfriamento. Então o
-- produtor do estado apagaria o próprio estado ao registrá-lo: o negócio esfria,
-- o sistema registra "esfriou", o trigger zera o relógio, e o negócio volta a
-- "em dia" no mesmo instante. Vinte e quatro horas depois, de novo — uma linha
-- de timeline por janela, para sempre, sem ninguém ter feito nada.
--
-- Provado em transação revertida (lead 08b70b48, o mais frio com relógio
-- não-nulo): 484h de silêncio, bucket CRÍTICO → insere uma atividade → 0h,
-- bucket "em dia".
--
-- A regra geral: CONSTATAR O SILÊNCIO NÃO É QUEBRAR O SILÊNCIO. Toda métrica do
-- tipo "tempo desde o último X" é aniquilada por registrar observação sobre ela,
-- se o registro contar como X.
--
-- ⚠️ POR QUE LISTA POSITIVA E NÃO LISTA DE EXCEÇÕES — a assimetria é o ponto
-- inteiro, e inverter parece inofensivo:
--
--   com lista de exceções ("ignore lead_cooled"), um tipo NOVO de observação de
--   sistema, daqui a seis meses, volta a carimbar o relógio. O negócio parece
--   vivo estando morto: morte silenciosa, que é a doença que esta wave existe
--   para curar;
--
--   com lista positiva, um tipo novo de interação REAL fica de fora e o negócio
--   parece frio estando quente: alarme falso, visível, alguém reclama e conserta.
--
-- O default para o que ainda não existe tem de ser o erro BARULHENTO.
--
-- AS ESCOLHAS DE FORA, cada uma com sua razão — revisáveis, mas não por
-- distração:
--   send_vetoed        o envio não chegou ao cliente. Se contasse, um negócio em
--                      que a IA tenta e é barrada em looping pareceria vivo
--                      estando travado;
--   handoff_triggered  passar para humano é PROMESSA de atendimento, não
--                      atendimento. Se contasse, o negócio transferido e nunca
--                      atendido ficaria mascarado justamente na janela em que
--                      alguém deveria notar;
--   next_action_dismissed  o humano decidiu NÃO agir. O negócio fica sem próximo
--                      passo, que é a definição de risco na doutrina — deveria
--                      esfriar mais rápido, não menos.

create or replace function public.fn_update_last_activity_at()
  returns trigger
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $function$
begin
  -- LISTA POSITIVA: só isto conta como "alguém tocou este negócio". Tipo que
  -- não está aqui NÃO quebra o silêncio — inclusive tipo que ainda não existe.
  -- Ver o cabeçalho da 0079 antes de acrescentar linha nesta lista.
  if new.type not in (
    'ai_turn',              -- a IA falou com o cliente
    'note',                 -- alguém registrou trabalho no negócio
    'lead_edited',          -- humano mexeu nos dados
    'stage_changed',        -- humano moveu o negócio
    'next_action_approved'  -- humano decidiu agir
  ) then
    return new;
  end if;

  update public.crm_leads
     set last_activity_at = greatest(coalesce(last_activity_at, '-infinity'::timestamptz), new.performed_at)
   where id = new.lead_id;

  if new.contact_id is not null then
    update public.contacts
       set last_activity_at = greatest(coalesce(last_activity_at, '-infinity'::timestamptz), new.performed_at)
     where id = new.contact_id;
  end if;
  return new;
end$function$;

comment on function public.fn_update_last_activity_at() is
  'Carimba last_activity_at SÓ para tipos que contam como interação (lista positiva — ver migration 0079). Constatar o silêncio não é quebrar o silêncio: sem este filtro, a atividade que registra "este negócio esfriou" zera o próprio relógio que produziu o estado.';

-- ---- kind de caixa para o acervo de risco (migration 0080) ----
-- 0080 — o acervo de negócios já frios ganha UM item de caixa, com ação nomeada
--
-- POR QUE ISTO EXISTE: quando o estado de risco (0078) começa a ser gravado, os
-- negócios que JÁ estavam frios entram todos de uma vez. Medido no banco de
-- desenvolvimento: 48 críticos e 2 em risco, de 66 abertos.
--
-- Eles NÃO podem emitir atividade de timeline ("esfriou agora" seria falso: eles
-- esfriaram há dias) e não podem entrar em silêncio, porque aí ficariam
-- absolvidos por decreto de migração — cinquenta demandas abertas que ninguém
-- decidiu abandonar e ninguém vai revisar. O `event_log` sozinho não resolve:
-- é rastro de máquina, e não coloca ninguém para agir.
--
-- Daí UM item agregado (não cinquenta) com dono e AÇÃO NOMEADA. Item de caixa
-- sem ação nomeada é o ruído que a própria doutrina proíbe: "revise os 48 e
-- decida quais encerrar" é trabalho; "48 negócios em risco" é um número.
--
-- ⚠️ O `InboxKind` em `lib/agent-engine/db/repository.ts` é a outra ponta deste
-- CHECK e JÁ FICOU TRÊS VALORES ATRÁS DO BANCO sem nada falhar. Kind novo aqui
-- = kind novo lá, na mesma mudança. Está sendo feito neste commit.

-- (constraint agent_inbox_items_kind_check: definida uma vez só, no fim deste
--  apêndice — ver "vocabulário completo". 'risk_backlog_seeded' está lá.)

-- ---- detected_at é carimbo do banco (migration 0081) ----
-- 0081 — `detected_at` deixa de ser dado do cliente e vira CARIMBO do banco
--
-- O DEFEITO, encontrado rodando o observador de travessia (peça 5) e não por
-- inspeção: `since` deriva de `last_activity_at`, que o trigger carimba com o
-- `now()` do BANCO. `detected_at` vinha do processo Node. Medido nesta máquina:
-- **o banco está 2 segundos à frente**. Um negócio tocado no instante anterior à
-- passada do worker produzia `since > detected_at`, violava
-- `crm_lead_risk_states_since_no_passado`, e o worker INTEIRO abortava.
--
-- Omitir a coluna no `upsert` NÃO resolve, e é o detalhe que engana: o default
-- só se aplica no INSERT. No UPDATE — que é o caminho de toda travessia depois
-- da primeira — a coluna mantém o valor ANTIGO, e aí o `since` novo fica maior
-- que um `detected_at` de dias atrás. Pior que o caso do relógio: acontece
-- SEMPRE, não só na janela de dois segundos.
--
-- A constraint estava certa e pegou o que eu não teria visto. O conserto não é
-- afrouxá-la: é tirar do cliente a chance de errar. `detected_at` passa a ser
-- carimbado pelo banco em TODA escrita, como `updated_at` — quem escreve não
-- decide quando percebeu, o banco decide.
--
-- ⚠️ A LIÇÃO É MAIOR QUE A COLUNA: `since` e `detected_at` são comparados por um
-- CHECK, então TÊM de vir do mesmo relógio. O relógio do processo continua
-- classificando (`classifyRisk` compara janelas de HORAS, onde segundos não
-- mudam bucket); o CHECK compara INSTANTES, onde mudam. Grandezas diferentes
-- toleram precisões diferentes, e confundir as duas foi exatamente o defeito.

create or replace function public.fn_carimba_detected_at()
  returns trigger
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $function$
begin
  new.detected_at := now();
  new.updated_at := now();
  return new;
end$function$;

comment on function public.fn_carimba_detected_at() is
  'detected_at é quando o BANCO percebeu, nunca quando o processo achou que percebeu. Ver migration 0081: com o valor vindo do cliente, a deriva de relógio violava o CHECK since <= detected_at e derrubava o worker inteiro.';

drop trigger if exists trg_crm_lead_risk_states_detected_at on public.crm_lead_risk_states;
create trigger trg_crm_lead_risk_states_detected_at
  before insert or update on public.crm_lead_risk_states
  for each row
  execute function public.fn_carimba_detected_at();

-- ---- proposta de reativação com prazo (migration 0082) ----
-- 0082 — a proposta de reativação, com PRAZO e destino
--
-- O cenário 23 fecha o ciclo da wave 7: o negócio esfria (0078-0081), alguém
-- decide reativá-lo, o agente envia, a atividade fica registrada e o estado
-- volta ao normal.
--
-- ⚠️ O BLOCO OBRIGATÓRIO, e ele é RECURSIVO: a wave existe para "esfriando"
-- virar DEMANDA, e a demanda que ela cria TAMBÉM PODE MORRER. Proposta de
-- reativação que ninguém decide fica pendente para sempre, e o negócio volta a
-- ser card parado AGORA COM UM BOTÃO EM CIMA — que é pior que antes: card
-- parado sem nada se lê como abandono; com proposta pendente SIMULA ATENÇÃO, e
-- simulação de atendimento ADIA a intervenção humana em vez de provocá-la.
--
-- Daí `expires_at` ser NOT NULL: não existe proposta sem prazo nesta tabela, e
-- é o banco que garante. No vencimento ela sai do card e vira item de caixa —
-- demanda sem dono não mora no Kanban.
--
-- ⚠️ POR QUE NÃO REUSAR `lead_state.next_action`: ela é por CONTATO (unique
-- organization_id, contact_id) e o risco é por NEGÓCIO — um contato com dois
-- negócios, um esfriando e outro quente, teria uma proposta só para os dois. E
-- é texto livre, sem estado nem prazo. Caberia à força, distorcendo as duas
-- coisas; a decisão é registrada aqui para ninguém "simplificar" depois.
--
-- ⚠️ O ENVIO NÃO NASCE AQUI. Aceitar a proposta dispara o caminho que já existe
-- (`cron_jobs` + o motor de follow-up). Esta tabela guarda a DECISÃO, não a
-- mensagem — criar um segundo caminho de envio seria o mesmo erro de ter duas
-- definições de "esfriando".

create table if not exists public.crm_lead_reactivations (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.crm_leads(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  status text not null default 'pending',
  -- Carimbados pelo BANCO, nunca pelo processo: a 0081 custou um worker
  -- abortando inteiro porque `since` vinha do banco e `detected_at` do Node,
  -- com 2 segundos de deriva entre eles. Instantes comparados entre si vêm do
  -- mesmo relógio.
  proposed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- O texto que o agente enviaria. É proposta do AGENTE — texto de máquina —,
  -- não campo do negócio: vale a mesma regra do `reason` da timeline, e nenhum
  -- dado do lead entra aqui por cópia.
  draft text,
  decided_at timestamptz,
  decided_by_user_id uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

comment on table public.crm_lead_reactivations is
  'Proposta de reativação de negócio esfriado (wave 7, cenário 23). SEMPRE com prazo: proposta que ninguém decide vira card parado com botão em cima, que simula atenção e adia a intervenção humana. No vencimento sai do card e vira item de caixa.';

alter table public.crm_lead_reactivations
  drop constraint if exists crm_lead_reactivations_status_check;
alter table public.crm_lead_reactivations
  add constraint crm_lead_reactivations_status_check check (
    status = any (array['pending', 'accepted', 'dismissed', 'expired']::text[])
  );

-- Prazo no futuro em relação à proposta. Trava o erro de nascer vencida — que
-- criaria um item de caixa no primeiro tick e ninguém entenderia de onde veio.
alter table public.crm_lead_reactivations
  drop constraint if exists crm_lead_reactivations_prazo_no_futuro;
alter table public.crm_lead_reactivations
  add constraint crm_lead_reactivations_prazo_no_futuro check (expires_at > proposed_at);

-- Decisão e decisor andam juntos: status decidido SEM `decided_at` é registro
-- que não sabe dizer quando aconteceu, e a timeline depende dessa resposta.
alter table public.crm_lead_reactivations
  drop constraint if exists crm_lead_reactivations_decisao_datada;
alter table public.crm_lead_reactivations
  add constraint crm_lead_reactivations_decisao_datada check (
    (status = 'pending' and decided_at is null)
    or (status <> 'pending' and decided_at is not null)
  );

-- UMA proposta viva por negócio. Índice parcial: propostas já decididas ficam
-- como histórico e não bloqueiam a próxima — o negócio pode esfriar de novo, e
-- impedir isso deixaria o segundo esfriamento sem proposta nenhuma.
create unique index if not exists uq_crm_lead_reactivations_uma_viva
  on public.crm_lead_reactivations (lead_id)
  where status = 'pending';

-- O worker de vencimento varre por aqui.
create index if not exists idx_crm_lead_reactivations_vencendo
  on public.crm_lead_reactivations (organization_id, expires_at)
  where status = 'pending';

alter table public.crm_lead_reactivations enable row level security;

drop policy if exists tenant_isolation_crm_lead_reactivations_all on public.crm_lead_reactivations;
create policy tenant_isolation_crm_lead_reactivations_all on public.crm_lead_reactivations
  for all
  using (organization_id in (select fn_user_org_ids()))
  with check (organization_id in (select fn_user_org_ids()));

-- `proposed_at` e `updated_at` são do banco, como na 0081.
create or replace function public.fn_carimba_reativacao()
  returns trigger
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $function$
begin
  if tg_op = 'INSERT' then
    new.proposed_at := now();
  end if;
  new.updated_at := now();
  return new;
end$function$;

drop trigger if exists trg_crm_lead_reactivations_carimbo on public.crm_lead_reactivations;
create trigger trg_crm_lead_reactivations_carimbo
  before insert or update on public.crm_lead_reactivations
  for each row
  execute function public.fn_carimba_reativacao();

-- DENTRO da publicação de realtime, pela mesma regra da 0078: proposta nascendo
-- ou vencendo é MUDANÇA DE ESTADO que o card precisa mostrar sem reload —
-- não é telemetria.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'crm_lead_reactivations'
  ) then
    execute 'alter publication supabase_realtime add table public.crm_lead_reactivations';
  end if;
end $$;

-- ---- kind de caixa para reativação vencida (migration 0083) ----
-- 0083 — a proposta de reativação vencida tem PARA ONDE IR
--
-- Sem este kind, o vencimento seria uma linha de banco e nada mais: a proposta
-- sai do card e desaparece. "Some do card" resolve a simulação de atenção e
-- cria o problema anterior de volta — o negócio parado sem ninguém sabendo.
--
-- A demanda que a wave criou não pode morrer por silêncio, e é EXATAMENTE a
-- mesma forma da promessa cujo prazo depende de terceiro: sem fallback
-- declarado, ela não é quebrada por decisão — ELA EXPIRA SOZINHA E NINGUÉM
-- PERCEBE QUE DECIDIU. O item de caixa é o fallback, e ele tem dono e ação
-- nomeada porque item sem ação é o ruído que a doutrina proíbe.
--
-- ⚠️ O `InboxKind` em `lib/agent-engine/db/repository.ts` e o
-- `Record<InboxKind, string>` em `lib/ai/agent-inbox-copy.ts` são as outras
-- pontas deste CHECK. Kind novo aqui = kind novo nos dois, no mesmo commit —
-- e agora o invariante `vocabulario-banco-x-typescript` LÊ o arquivo de
-- verdade, então esquecer não passa mais em silêncio.

-- (constraint agent_inbox_items_kind_check: definida uma vez só, no fim deste
--  apêndice — ver "vocabulário completo". 'reactivation_expired' está lá.)

-- ---- agent_stage_hint (migration 0084) ----
-- 0084 — o funil do AGENTE aprende a falar o vocabulário do TENANT
--
-- Dois vocabulários que hoje não se conhecem:
--
--   AGENTE    `lead_state.stage` — SETE valores fixos: new, contacted,
--             qualifying, qualified, negotiating, won, lost;
--   PIPELINE  `crm_stages` — arbitrários por tenant. Medidos neste banco:
--             clínica  → Primeiro contato, Avaliação, Proposta enviada,
--                        Negociação, Tratamento fechado, Perdido
--             e-commerce → Carrinho abandonado, Aguardando pagamento, Pago,
--                        Em separação, Enviado, Entregue, Pós-venda, Cancelado
--
-- Sem ponte, o agente que avança o próprio funil não move o card — e o board
-- mostra um negócio parado num estágio que já não é verdade.
--
-- ⚠️ E A PONTE JÁ EXISTE PELA METADE: `crm_stages` tem `is_won` e `is_lost`.
-- Dois dos sete já estão mapeados, por colunas booleanas. Esta migration NÃO
-- cria um mecanismo novo — GENERALIZA um que existe incompleto. A consequência
-- é o CHECK de coerência abaixo: sem ele, `is_won` e `agent_stage_hint`
-- passariam a ser DUAS FONTES capazes de dizer coisas diferentes sobre o mesmo
-- estágio, que é a família de defeito que esta entrega inteira encontrou seis
-- vezes ("um lado mudou e o outro não acompanhou").
--
-- `null` é estado LEGÍTIMO e comum: "Em separação", "Pós-venda" e "Carrinho
-- abandonado" não têm equivalente no funil do agente, e forçar um mapeamento
-- seria inventar semântica que o tenant não declarou.

alter table public.crm_stages
  add column if not exists agent_stage_hint text;

comment on column public.crm_stages.agent_stage_hint is
  'A que passo do funil do AGENTE este estágio corresponde (lead_state.stage). NULL = não corresponde a nenhum, que é legítimo. Coerente com is_won/is_lost por CHECK — ver migration 0084.';

alter table public.crm_stages
  drop constraint if exists crm_stages_agent_stage_hint_check;
alter table public.crm_stages
  add constraint crm_stages_agent_stage_hint_check check (
    agent_stage_hint is null
    or agent_stage_hint = any (array[
      'new', 'contacted', 'qualifying', 'qualified', 'negotiating', 'won', 'lost'
    ]::text[])
  );

-- ⚠️ A COERÊNCIA COM O QUE JÁ EXISTIA. Um estágio marcado `is_won` que se
-- anuncia como 'qualifying' faria o agente e o board discordarem sobre o mesmo
-- lugar — e cada um estaria "certo" pela sua própria fonte. O CHECK torna a
-- divergência IMPOSSÍVEL em vez de improvável.
--
-- Nos dois sentidos, de propósito: `is_won` sem hint é o estado de hoje (válido,
-- e é como todos os clones começam), mas hint='won' num estágio que não é de
-- ganho seria mentira na direção oposta.
alter table public.crm_stages
  drop constraint if exists crm_stages_hint_coerente_com_won_lost;
alter table public.crm_stages
  add constraint crm_stages_hint_coerente_com_won_lost check (
    (agent_stage_hint <> 'won' or is_won)
    and (agent_stage_hint <> 'lost' or is_lost)
    and (not is_won or agent_stage_hint is null or agent_stage_hint = 'won')
    and (not is_lost or agent_stage_hint is null or agent_stage_hint = 'lost')
  );

-- ⚠️ UM ESTÁGIO POR HINT, POR PIPELINE — e este índice é UNIQUE de propósito.
--
-- Eu ia tratar a ambiguidade no resolvedor ("dois estágios com o mesmo hint →
-- recuse mover"). O schema já respondeu melhor: `uniq_crm_stages_pipeline_won` e
-- `uniq_crm_stages_pipeline_lost` JÁ EXISTEM, com o mesmo desenho — parcial, e
-- excluindo arquivados. O produto já decidiu que "dois lugares de ganho no mesmo
-- funil" é impossível, não improvável; não havia razão para os outros cinco
-- passos serem tratados com menos rigor que os dois.
--
-- E a diferença é grande: com o UNIQUE, o tenant DESCOBRE o erro ao configurar
-- — o banco recusa na hora, com o estágio na frente dele. Com tratamento no
-- resolvedor, ele descobriria meses depois, quando um negócio não se movesse e
-- ninguém soubesse dizer por quê.
--
-- `is_archived = false` acompanha o precedente: estágio arquivado é histórico e
-- não disputa o mapeamento com o que está em uso.
create unique index if not exists uniq_crm_stages_pipeline_hint
  on public.crm_stages (pipeline_id, agent_stage_hint)
  where agent_stage_hint is not null and is_archived = false;

-- ---- backfill do que JÁ ESTÁ DECIDIDO, e só dele ----
-- `is_won`/`is_lost` são declaração explícita do tenant sobre aquele estágio;
-- copiá-los para o hint não inventa nada. NENHUM outro estágio é adivinhado:
-- inferir 'qualifying' de um nome como "Avaliação" seria o sistema decidindo
-- semântica por semelhança de palavra, e erraria em português de outro nicho.
update public.crm_stages
   set agent_stage_hint = 'won'
 where is_won and agent_stage_hint is null;

update public.crm_stages
   set agent_stage_hint = 'lost'
 where is_lost and agent_stage_hint is null;

-- ANALYZE: `ALTER TABLE` deixa o planner sem estatística e ele passa a errar a
-- escolha de índice em consultas de crm_leads (medido no G4-04). Custa
-- milissegundos numa tabela vazia.
analyze public.crm_leads;
-- ---- intent router: ai_routers/members/decisions + stickiness (migration 0085) ----

-- 0085: Intent Router (Fase 3 do épico harness — spec 2026-07-23).
-- Um router pluga num channel_session e roteia a conversa para o agente cuja
-- intenção declarada casa com a mensagem. Tabelas EDITÁVEIS (não versão+ponteiro):
-- mutação é auditada por trigger, como ai_agents.

create table if not exists ai_routers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null check (length(name) > 0),
  channel_session_id uuid not null references channel_sessions(id) on delete cascade,
  is_active boolean not null default true,
  config jsonb not null default jsonb_build_object(
    'classifier_model', 'claude-haiku-4-5',
    'sticky', true,
    'min_confidence', 0.6
  ),
  fallback_agent_id uuid references ai_agents(id) on delete set null,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Um router ativo por sessão de canal (dois routers disputando o mesmo número
-- seria ambiguidade de roteamento — o índice parcial impede).
create unique index if not exists uniq_ai_routers_active_session
  on ai_routers (channel_session_id) where is_active;

create table if not exists ai_router_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  router_id uuid not null references ai_routers(id) on delete cascade,
  agent_id uuid not null references ai_agents(id) on delete cascade,
  intent_name text not null check (length(intent_name) > 0),
  intent_description text not null check (length(intent_description) > 0),
  examples text[] not null default '{}',
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (router_id, intent_name)
);

create index if not exists idx_ai_router_members_router
  on ai_router_members (router_id, position);

-- Telemetria de decisão (append-only, SEM PII — o texto do lead nunca entra aqui).
create table if not exists ai_router_decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  router_id uuid references ai_routers(id) on delete set null,
  conversation_id uuid,
  intent_name text,
  confidence numeric(4,3),
  agent_id uuid references ai_agents(id) on delete set null,
  outcome text not null check (outcome in ('classified', 'sticky', 'reclassified', 'fallback', 'no_match', 'classifier_failed')),
  job_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_ai_router_decisions_org_created
  on ai_router_decisions (organization_id, created_at);
create index if not exists idx_ai_router_decisions_router
  on ai_router_decisions (router_id, created_at);

-- Stickiness por conversa: qual agente o router entregou e qual intenção.
alter table conversations add column if not exists active_ai_agent_id uuid references ai_agents(id) on delete set null;
alter table conversations add column if not exists active_intent text;
alter table conversations add column if not exists active_agent_set_at timestamptz;

-- Triggers: audit de mutação + updated_at (padrão de ai_agents).
drop trigger if exists trg_ai_routers_audit on ai_routers;
create trigger trg_ai_routers_audit
  after insert or update or delete on ai_routers
  for each row execute function fn_audit_log_row();
drop trigger if exists trg_ai_routers_updated_at on ai_routers;
create trigger trg_ai_routers_updated_at
  before update on ai_routers
  for each row execute function fn_set_updated_at();

drop trigger if exists trg_ai_router_members_audit on ai_router_members;
create trigger trg_ai_router_members_audit
  after insert or update or delete on ai_router_members
  for each row execute function fn_audit_log_row();
drop trigger if exists trg_ai_router_members_updated_at on ai_router_members;
create trigger trg_ai_router_members_updated_at
  before update on ai_router_members
  for each row execute function fn_set_updated_at();

-- RLS (mesmo shape do loop tenant_isolation_* do baseline).
do $$
declare t text;
begin
  foreach t in array array['ai_routers', 'ai_router_members', 'ai_router_decisions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists tenant_isolation_%s_all on public.%I', t, t);
    execute format(
      'create policy tenant_isolation_%s_all on public.%I for all
         using (organization_id in (select * from public.fn_user_org_ids()))
         with check (organization_id in (select * from public.fn_user_org_ids()))',
      t, t
    );
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- ---- knowledge_searches: telemetria de busca de conhecimento (migration 0086) ----

-- 0086 — telemetria de busca de conhecimento (Fase 4 do épico do Harness)
--
-- POR QUE UMA TABELA E NÃO `metrics`: a pergunta que o painel precisa responder
-- é "quantas buscas QUASE acertaram", e ela exige o `top_score` da busca ao lado
-- do `threshold` que estava valendo naquele momento. Métrica agregada perde
-- exatamente essa distância, que é o número que vira ação.
--
-- SEM PII, pelo mesmo contrato de `ai_router_decisions` (0085): não gravamos o
-- texto da pergunta. `hits`/`top_score` respondem à pergunta do painel sem
-- carregar conteúdo de conversa para uma tabela de telemetria de retenção longa.

create table if not exists knowledge_searches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  job_id uuid,
  kb_version_id uuid,
  -- Quantos chunks passaram do limiar. 0 = o agente perguntou e a base não tinha.
  hits int not null default 0,
  -- Similaridade do MELHOR candidato, mesmo que abaixo do limiar. É o que
  -- distingue "a base não tem isso" (top_score baixo) de "a base tem e o limiar
  -- cortou" (top_score logo abaixo do threshold).
  top_score numeric,
  -- O limiar vigente na busca. Guardado junto porque ele é configurável por
  -- agente: comparar `top_score` com o limiar de HOJE mentiria sobre buscas de
  -- ontem.
  threshold numeric not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_knowledge_searches_org_created
  on knowledge_searches (organization_id, created_at desc);

alter table knowledge_searches enable row level security;

drop policy if exists tenant_isolation_knowledge_searches_all on knowledge_searches;
create policy tenant_isolation_knowledge_searches_all on knowledge_searches
  for all
  using (organization_id in (select fn_user_org_ids()))
  with check (organization_id in (select fn_user_org_ids()));

-- Defesa em profundidade, mesmo contrato da 0085: a policy já devolve zero linha
-- para JWT anônimo (auth.uid() null => fn_user_org_ids() vazio), mas o grant que
-- o Supabase concede por default privilege não tem razão de existir aqui — esta
-- tabela nunca é lida sem sessão. Idempotente: revogar o que não está lá é no-op.
revoke all on public.knowledge_searches from anon;

-- ---- atualização self-service pela UI (migration 0089) ----
--
-- Duas tabelas de INSTÂNCIA (sem organization_id): descrevem o servidor, não o
-- inquilino. Sem policy de RLS de propósito — com RLS habilitada e zero policy,
-- `anon` e `authenticated` não leem nada pelo PostgREST; o acesso passa só pelas
-- rotas /api/v1/system/*, que usam service role e checam is_platform_admin.
create table if not exists public.system_version (
  id                  smallint primary key default 1 check (id = 1),
  current_version     text not null default '',
  current_sha         text not null default '',
  off_release         boolean not null default false,
  latest_version      text not null default '',
  changelog_raw       text not null default '',
  agent_last_seen_at  timestamptz,
  update_requested_at timestamptz,
  update_requested_by uuid references auth.users(id) on delete set null,
  updated_at          timestamptz not null default now()
);
comment on table public.system_version is
  'Singleton: versão instalada e disponível desta instância. Escrito pelo agente do host.';
insert into public.system_version (id) values (1) on conflict (id) do nothing;
create table if not exists public.system_update_runs (
  id            uuid primary key default gen_random_uuid(),
  from_version  text not null default '',
  to_version    text not null default '',
  status        text not null default 'dispatched'
                check (status in ('dispatched','success','failed','failed_rolled_back')),
  last_step     text check (last_step in ('backup','codigo','banco')),
  requested_by  uuid references auth.users(id) on delete set null,
  dispatched_at timestamptz not null default now(),
  finished_at   timestamptz,
  log_tail      text not null default ''
);
comment on table public.system_update_runs is
  'Histórico append de atualizações disparadas pela UI. status/last_step espelham RunStatus/RunStep em lib/system/update-run.ts.';
create index if not exists idx_system_update_runs_dispatched
  on public.system_update_runs (dispatched_at desc);
alter table public.system_version    enable row level security;
alter table public.system_update_runs enable row level security;

-- ---- índice único parcial: no máximo 1 run "dispatched" por vez (migration 0090) ----
--
-- Dedup defensivo ANTES da constraint (clone com dado inconsistente não pode
-- quebrar o update.sh): mantém só a linha "dispatched" mais recente, marca
-- as demais como failed.
with ranked as (
  select id, row_number() over (order by dispatched_at desc) as rn
  from public.system_update_runs
  where status = 'dispatched'
)
update public.system_update_runs
set status = 'failed', finished_at = coalesce(finished_at, now())
where id in (select id from ranked where rn > 1);

create unique index if not exists uniq_system_update_runs_dispatched
  on public.system_update_runs (status)
  where status = 'dispatched';

-- ---- acentos nas etapas padrão do funil (migration 0092) ----
-- O seed do funil "Pedidos" criava "Em separacao" e "Pos-venda" sem acento —
-- nomes visíveis no quadro principal, a tela mais usada do CRM. O seed acima já
-- nasce corrigido; este bloco cura quem instalou antes. Idempotente e seguro:
-- só casa com o nome padrão intacto, então tenant que renomeou a etapa não é
-- tocado.
update public.crm_stages set name = 'Em separação' where name = 'Em separacao';
update public.crm_stages set name = 'Pós-venda'    where name = 'Pos-venda';

-- ---- channel provider (migration 0087) ----
-- O canal deixa de ser suposto. Até aqui o sistema INTEIRO supunha WAHA (o
-- handler de envio chamava `getAdapter("waha")` com literal; o ctx de produção
-- do `before_send` fixava `provider: 'waha'`), e supor o canal é o que impede o
-- seam de existir.
--
-- Tagged union, não flag: `provider` sozinho aceitaria uma sessão `meta_cloud`
-- sem `meta_phone_number_id` e uma `waha` sem `waha_session_name` — as duas
-- irresolvíveis na hora do envio, descobertas em runtime com a mensagem do
-- cliente já aceita. O CHECK move a descoberta para o INSERT.
--
-- `waha_session_name` perde o NOT NULL porque ele É o identificador de um dos
-- ramos da união; obrigatório, `meta_cloud` seria inexprimível. A UNIQUE dele
-- continua valendo (NULLs são distintos no Postgres).
--
-- NÃO cria índice único de (organization_id, phone_number): a trava já existe
-- desde o snapshot — `channel_sessions_phone_per_org_unique ... DEFERRABLE
-- INITIALLY DEFERRED` — e já responde a "um número vive em UM provider", porque
-- não olha o provider. Duplicá-la custaria checagem em toda escrita e colocaria
-- uma trava NÃO-deferível ao lado de uma deferível, quebrando no meio qualquer
-- transação que hoje troca números entre sessões.
--
-- Auto-curativo para o `update.sh` de clone: o default preenche as linhas
-- existentes no mesmo ALTER e `waha_session_name` era NOT NULL antes desta
-- mudança — então TODA linha pré-existente já satisfaz o ramo 'waha' quando o
-- CHECK nasce. Não há dado a deduplicar antes da constraint.
alter table public.channel_sessions
  add column if not exists provider text not null default 'waha',
  add column if not exists meta_phone_number_id text,
  add column if not exists meta_waba_id text,
  add column if not exists meta_token_encrypted bytea;

alter table public.channel_sessions alter column waha_session_name drop not null;

-- (constraints channel_sessions_provider_check e channel_sessions_provider_ref_check:
--  definidas uma vez só, no fim deste arquivo, com o vocabulário FINAL — regra de
--  `tests/unit/baseline-constraint-reconstruida.test.ts`. Reconstruí-las aqui com a
--  lista de dois providers faria o `update.sh` de um clone que já tem o terceiro
--  falhar ao re-aplicar, e deixaria a tabela sem constraint entre o drop e o add
--  que funciona.)

-- ---- vocabulário do terceiro canal (migration 0131) ----
-- Espelho idempotente da 0116. Racional completo no arquivo da migration; o que
-- importa aqui é POR QUE os dois CHECKs são recriados em vez de criados com
-- `exception when duplicate_object`: os blocos acima já os criaram na versão de
-- DOIS providers, e num clone que roda `update.sh` eles JÁ EXISTEM. O
-- `duplicate_object` engoliria a versão nova em silêncio e o banco ficaria
-- recusando a sessão do canal novo com o script tendo passado verde — a
-- falha-em-verde que a doutrina do self-host proíbe.
--
-- Ordem importa: a coluna nasce ANTES do CHECK que a referencia, e nullable,
-- então nenhuma linha existente a viola. Toda linha pré-existente tem provider
-- 'waha' ou 'meta_cloud' e já satisfaz o ramo correspondente — nada a
-- deduplicar antes das constraints.
alter table public.channel_sessions
  add column if not exists zernio_account_id text;

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  check (provider = any (array['waha'::text, 'meta_cloud'::text, 'zernio'::text]));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha'       and waha_session_name    is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    (provider = 'zernio'     and zernio_account_id    is not null)
  );

comment on column public.channel_sessions.zernio_account_id is
  'Identificador da conta conectada NO INTERMEDIÁRIO (accountId), não o phone_number_id da Meta. É o que endereça envio e webhook. Espelhado em lib/channels/session-ref.ts.';

-- ---- o que falta para o terceiro canal ENVIAR (migration 0132) ----
-- Espelho idempotente da 0117. Racional completo no arquivo da migration.
--
-- `provider_conversation_id`: os dois canais existentes DERIVAM o destinatário
-- do contato (chatId ou E.164). Este não — quem endereça é um id de 24 hex que
-- o intermediário inventa e devolve pelo webhook. Sem guardá-lo não há como
-- responder dentro da janela de 24h, porque o endpoint que aceita telefone
-- exige template. Nome genérico: é o mesmo conceito para qualquer provider que
-- enderece por thread própria, e carimbar nome de provider numa tabela que hoje
-- não tem nenhum seria dívida gratuita.
--
-- As duas colunas nascem NULLABLE e sem constraint nova: nenhuma linha
-- existente as viola, então não há dado a corrigir antes — o `update.sh` de um
-- clone com dados aplica isto sem tocar em nada.
alter table public.conversations
  add column if not exists provider_conversation_id text;

comment on column public.conversations.provider_conversation_id is
  'Id que o PROVIDER dá a esta thread, quando ele endereça por thread própria em vez de por telefone. Chega pelo webhook de mensagem recebida. NULL = provider endereça por telefone (WAHA, oficial) ou ainda não houve primeiro contato.';

create index if not exists idx_conversations_provider_conversation_id
  on public.conversations (organization_id, provider_conversation_id)
  where provider_conversation_id is not null;

alter table public.channel_sessions
  add column if not exists zernio_token_encrypted bytea;

comment on column public.channel_sessions.zernio_token_encrypted is
  'API key do intermediário, cifrada por fn_encrypt_oauth. Por SESSÃO (não por instalação) — mesma decisão da 0087 para o canal oficial.';

-- ---- carimbo do lookup de telefone (migration 0119) ----
-- Espelho idempotente da 0119. Racional completo no arquivo da migration.
--
-- O canal identifica quem escreve por id opaco, e a tradução para telefone é
-- povoada por ATIVIDADE — hoje não sabe, semana que vem talvez. Sem carimbar a
-- tentativa, a varredura reprocessaria sempre os mesmos primeiros N e os do fim
-- da fila nunca seriam perguntados.
--
-- NULLABLE de propósito: NULL = nunca perguntado; com valor e telefone ainda
-- nulo = o canal não sabia na ocasião. Um `not null default now()` colapsaria
-- os dois e faria contato novo nascer como "já tentado".
alter table public.contacts
  add column if not exists phone_lookup_at timestamptz;

comment on column public.contacts.phone_lookup_at is
  'Última vez que se PERGUNTOU ao canal o telefone por trás da identidade opaca. NULL = nunca perguntado. Com valor e phone_number ainda null = o canal não sabia na ocasião.';

create index if not exists idx_contacts_phone_lookup_pendente
  on public.contacts (organization_id, phone_lookup_at nulls first)
  where phone_number is null;

comment on column public.channel_sessions.provider is
  'Canal desta sessão. Vocabulário espelhado em lib/channels/types.ts → ChannelProvider (cobrado por tests/invariants/vocabulario-banco-x-typescript.test.ts).';

-- ---- meta templates (migration 0088) ----
-- Espelho idempotente da migration 0088. Racional completo no arquivo da
-- migration; aqui fica o que o install.sh/update.sh precisa executar.

create table if not exists public.meta_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  waba_id text not null,
  name text not null,
  language text not null,
  status text not null,                 -- APPROVED | PENDING | REJECTED | PAUSED | DISABLED
  category text,
  rejected_reason text,
  quality_score text,
  -- Payload de `components` como a Meta o devolveu. É a ENTRADA de
  -- deriveTemplateContract; guardar o derivado seria a segunda fonte da verdade
  -- que esta fase inteira existe para eliminar.
  components jsonb not null,
  -- sha256 do contrato DERIVADO (não do jsonb cru): muda quando parâmetro muda,
  -- não muda quando alguém corrige uma vírgula no texto.
  contract_hash text not null,
  parameter_format text not null default 'POSITIONAL',
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$ begin
  alter table public.meta_templates
    add constraint meta_templates_parameter_format_check
    check (parameter_format in ('POSITIONAL', 'NAMED'));
exception when duplicate_object then null; end $$;

-- COMMENTs ficam no banco: aparecem em `\d+` e no Supabase Studio, onde quem
-- inspeciona a tabela não tem este arquivo à mão.
comment on table public.meta_templates is
  'Espelho local dos templates hospedados na Meta (migration 0088). Derivado, nunca autoritativo: o schema vive na Meta. contract_hash sai de lib/channels/meta/contract-hash.ts e é a âncora da trava por obsolescência.';
comment on column public.meta_templates.status is
  'Vocabulário ABERTO da Meta — deliberadamente SEM CHECK (ela cria estado novo sem avisar; CHECK quebraria o update.sh do clone). Espelhado em lib/channels/meta/template-sync.ts.';
comment on column public.meta_templates.contract_hash is
  'SHA-256 do contrato DERIVADO (slots + parameter_format), não do JSON cru. Config de disparo guarda este hash; divergência = config obsoleta.';
comment on column public.meta_templates.parameter_format is
  'Valor NORMALIZADO por deriveTemplateContract, não o cru da Meta — por isso TEM CHECK, ao contrário de status.';

create unique index if not exists meta_templates_org_waba_name_lang_uniq
  on public.meta_templates (organization_id, waba_id, name, language);

-- `name` no fim serve a listagem ordenada da tela sem sort extra (índice dele,
-- superset do meu — combinado em vez de escolhido).
create index if not exists meta_templates_org_status_idx
  on public.meta_templates (organization_id, status, name);

alter table public.meta_templates enable row level security;

drop policy if exists tenant_isolation_meta_templates_all on public.meta_templates;
create policy tenant_isolation_meta_templates_all on public.meta_templates
  for all
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

-- ---- message type: template (migration 0091) ----
-- Espelho idempotente. Racional completo no arquivo da migration: `template` NAO
-- podia ser gravado como 'text' porque o tipo e a unica coluna que carrega custo
-- (template e cobrado por entrega), conformidade de janela, e o que o contato viu.
-- Backfill: nenhum por construcao — o conjunto antigo e subconjunto do novo.

do $$ begin
  alter table public.messages drop constraint if exists messages_type_check;
  alter table public.messages add constraint messages_type_check
    check (type = any (array[
      'text', 'image', 'video', 'audio', 'document', 'sticker',
      'location', 'contact', 'reaction', 'system',
      -- novo: envio de template aprovado (canal oficial, fora da janela de 24h)
      'template'
    ]));
end $$;

-- Nome do template disparado. Fica em coluna, não só em `metadata`, porque é o que
-- responde "quanto gastei com o template X?" sem varrer jsonb — e porque `metadata`
-- é vocabulário aberto por desenho, o que tornaria a consulta uma aposta.
alter table public.messages
  add column if not exists template_name text,
  add column if not exists template_language text;

comment on column public.messages.template_name is
  'Nome do template da Meta quando type = template. Null nos demais tipos. Em coluna (não em metadata) porque é a chave de custo e de auditoria de janela.';

create index if not exists messages_template_idx
  on public.messages (organization_id, template_name)
  where template_name is not null;
-- ---- "não consegui comparar" não é "está em dia" (migration 0093) ----
--
-- Sem esta coluna, o agente que falha ao comparar (clone raso sem conseguir
-- completar a história) simplesmente não anuncia versão nova, e a tela lê a
-- ausência como boa notícia — informando "é a mais recente" a uma instalação
-- atrasada. Idempotente: `add column if not exists` com default.
alter table public.system_version
  add column if not exists compare_failed boolean not null default false;
comment on column public.system_version.compare_failed is
  'true quando o agente do host não conseguiu comparar a versão instalada com a última publicada (ex.: clone raso sem conseguir completar a história). A tela mostra "não consegui checar", nunca "você está em dia".';

-- ---- distingue "à frente da publicada" de "nunca houve publicada" (migration 0094) ----
--
-- Sem esta coluna, um fork sem nenhuma tag `v*` recebia a MESMA combinação
-- (off_release=true, latest_version='', compare_failed=false) de uma
-- instalação que já contém a última tag publicada — e a tela afirmava "você
-- está à frente da versão publicada" sem versão publicada nenhuma existir.
-- Default `true` preserva o comportamento anterior para agentes antigos.
alter table public.system_version
  add column if not exists has_known_release boolean not null default true;
comment on column public.system_version.has_known_release is
  'false quando o agente do host nunca viu nenhuma tag v* no repositório (fork sem releases). Default true preserva o comportamento anterior para agentes antigos que ainda não enviam este campo.';

-- ---- orçamento de IA conta o runtime real (migration 0095) ----
-- O gatilho de consumo existia só em ai_invocations (workers legados); o
-- agent-engine grava em llm_calls, então o contador ficava zerado e o alarme
-- de 80% / pausa em 100% nunca disparavam. Idempotente.
drop trigger if exists trg_llm_calls_budget on public.llm_calls;
create trigger trg_llm_calls_budget
  after insert on public.llm_calls
  for each row execute function public.fn_update_budget_consumption();

-- ESTE RECOMPUTO NÃO É O QUE VALE, e não dá para consertá-lo aqui. Desde a 0130
-- as linhas de `ai_invocations` são copiadas para `llm_calls`, então somar as
-- duas tabelas inteiras conta a MESMA linha duas vezes; a correção precisa da
-- coluna `legacy_invocation_id`, que só nasce lá embaixo, no bloco da 0130 —
-- referenciá-la aqui derruba o install com `column c2.legacy_invocation_id does
-- not exist` (medido). Quem dá a última palavra é o bloco da migration 0140,
-- depois do backfill: ele ATRIBUI o gasto real do mês, contando cada linha uma
-- vez só, e o valor deste bloco é sobrescrito.
insert into public.ai_budgets (organization_id, current_month_consumed_cents)
select o.id,
       coalesce((select sum(cost_cents) from public.llm_calls c
                 where c.organization_id = o.id and c.created_at >= date_trunc('month', now())), 0)
     + coalesce((select sum(cost_cents) from public.ai_invocations i
                 where i.organization_id = o.id and i.created_at >= date_trunc('month', now())), 0)
from public.organizations o
on conflict (organization_id) do update
set current_month_consumed_cents = excluded.current_month_consumed_cents,
    updated_at = now();

-- ---- modelo de LLM padrão da organização (migration 0096) ----
-- Sem isto o caminho GENÉRICO do turno (documentado em resolve-turn-agent.ts)
-- fica sem modelo e o turno morre com 'modelo LLM não definido'. Idempotente.
update public.organizations o
set settings = jsonb_set(
      coalesce(o.settings, '{}'::jsonb),
      '{llm}',
      coalesce(o.settings->'llm', '{}'::jsonb)
        || jsonb_build_object(
             'provider', coalesce(o.settings->'llm'->>'provider', 'anthropic'),
             'default_model', coalesce(
               (select m.model_id from public.ai_models m
                where m.provider = coalesce(o.settings->'llm'->>'provider', 'anthropic')
                  and m.is_default_for_provider
                  and m.deprecated_at is null
                limit 1),
               'claude-sonnet-4-6'
             )
           ),
      true
    )
where coalesce(o.settings->'llm'->>'default_model', '') = '';

-- Organização nova já nasce configurada: o mesmo seed que cria o funil padrão
-- passa a semear o modelo.
CREATE OR REPLACE FUNCTION "public"."fn_seed_org_llm_defaults"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if coalesce(new.settings->'llm'->>'default_model', '') = '' then
    new.settings := jsonb_set(
      coalesce(new.settings, '{}'::jsonb),
      '{llm}',
      coalesce(new.settings->'llm', '{}'::jsonb)
        || jsonb_build_object(
             'provider', 'anthropic',
             'default_model', coalesce(
               (select m.model_id from public.ai_models m
                where m.provider = 'anthropic' and m.is_default_for_provider
                  and m.deprecated_at is null limit 1),
               'claude-sonnet-4-6'
             )
           ),
      true
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_seed_org_llm_defaults on public.organizations;
create trigger trg_seed_org_llm_defaults
  before insert on public.organizations
  for each row execute function public.fn_seed_org_llm_defaults();

-- ---- limiar do RAG calibrado (migration 0097) ----
-- 0.72 descartava toda parafrase; medido: relevante 0.49-0.85, irrelevante 0.27.
alter table public.ai_agents
  alter column config set default jsonb_build_object(
    'temperature', 0.3, 'max_tokens', 1024, 'rag_top_k', 5,
    'rag_similarity_threshold', 0.40, 'context_message_window', 20,
    'confidence_threshold', 0.55, 'sentiment_threshold', 0.3,
    'zero_data_retention', false);

-- Cura quem está com o padrão antigo INTACTO. Quem já ajustou o valor na mão
-- não é tocado.
update public.ai_agents
set config = jsonb_set(config, '{rag_similarity_threshold}', '0.40'::jsonb)
where (config->>'rag_similarity_threshold')::numeric = 0.72;

-- Default da função de busca, para quem chama sem passar o limiar.
CREATE OR REPLACE FUNCTION "public"."retrieve_top_k_chunks"("p_organization_id" "uuid", "p_kb_version_id" "uuid", "p_embedding" "public"."vector", "p_k" integer DEFAULT 5, "p_threshold" real DEFAULT 0.40) RETURNS TABLE("chunk_id" "uuid", "knowledge_source_id" "uuid", "content" "text", "similarity" real, "metadata" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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

-- ---- idioma do contato (migration 0098) ----
-- O ai-response-worker seleciona contacts.locale e o prompt usa {{contact_locale}},
-- mas a coluna nunca existiu no snapshot: em toda instalação self-host o PostgREST
-- respondia "column contacts_1.locale does not exist" e o worker pulava TODA
-- conversa, com o erro escondido num log de nível info.
-- NULL = herda o padrão da organização (o código resolve com fallback pt-BR).
-- Sem CHECK: locale é vocabulário aberto; constraint aqui quebraria o update.sh
-- de clones com valores legados.
alter table public.contacts
  add column if not exists locale text;

comment on column public.contacts.locale is
  'Idioma preferido do contato (ex.: pt-BR, es-PY). NULL = herda o padrão da organização; o código resolve com fallback pt-BR.';
-- ---- foto de perfil do contato (migration 0099) ----
-- O WAHA devolve a foto como URL assinada do CDN do WhatsApp, com validade de
-- ~9 dias (medido). Guardar a URL crua faria todo avatar quebrar em uma semana,
-- em silêncio. Por isso o arquivo vai para o bucket whatsapp-media e aqui fica
-- só o CAMINHO — mesmo padrão de messages.media_storage_path. É também o que
-- torna a LGPD cumprível: foto é dado pessoal e some na anonimização, o que só
-- se garante sobre arquivo próprio.
alter table public.contacts
  add column if not exists avatar_storage_path text,
  add column if not exists avatar_updated_at   timestamptz;

comment on column public.contacts.avatar_storage_path is
  'Caminho da foto de perfil no bucket whatsapp-media. NULL = sem foto. Guardamos o arquivo, não a URL do WhatsApp, que expira em ~9 dias.';
comment on column public.contacts.avatar_updated_at is
  'Quando a foto foi buscada pela última vez. NULL = nunca tentado. Usado pelo cron de refresh para escolher quem revisitar.';

-- Índice PARCIAL, e não composto liderado por organization_id: a varredura do
-- cron não filtra organização nenhuma (varre a plataforma inteira), então com a
-- coluna líder irrestrita o planner não percorre em ordem de avatar_updated_at e
-- cai em seq scan + top-N sort. Medido em pg17 com 20.000 contatos, 17.665
-- elegíveis, melhor de 3:  composto 10,272 ms · parcial 0,090 ms (114x), e o
-- parcial ocupa 160 kB porque só indexa quem o cron pode escolher.
-- O predicado de data fica fora do WHERE: now() não é imutável e o Postgres
-- recusa. Não faz falta — os NULL vêm primeiro e o Index Scan para nas 25.
-- O drop é auto-curativo e só dispara em quem tenha a versão composta: em banco
-- novo, e na re-aplicação do update.sh, o bloco é no-op (nada é reconstruído).
do $$
begin
  if exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname  = 'idx_contacts_avatar_refresh'
      and indexdef ilike '%organization_id%'
  ) then
    execute 'drop index public.idx_contacts_avatar_refresh';
  end if;
end
$$;

create index if not exists idx_contacts_avatar_refresh
  on public.contacts (avatar_updated_at nulls first)
  where wa_identity is not null and is_anonymized = false;


-- ---- autoria da configuração da operação (migration 0101) ----
-- Quem mexeu na CONFIGURAÇÃO, ao lado do estado que mudou.
--
-- ⚠️ POR QUE EXISTE. Até o agente de IA ganhar mãos sobre a operação (épico IA
-- 360), toda mudança em etapa de funil, entrada automática de contatos e regra
-- automática vinha de uma pessoa `manager+` — quem olhava a tela era, por
-- construção, quem tinha mudado. Uma regra automática ligada pelo assistente
-- muda o comportamento do sistema quando ninguém está olhando: sem esta coluna,
-- a tela mostra "Ativa" e não diz mais nada. O `api_audit_log` registra, mas
-- nenhuma tela de configuração o lê — e log que não aparece é log morto
-- (docs/doctrine/sistema-vivo.md, invariante 3).
--
-- ⚠️ NÃO HÁ COLUNA DE "QUAL AGENTE", E É DELIBERADO: `Actor.id` para `ai_agent`
-- ainda não é chave estável de agente nos três caminhos — `lib/mcp/auth.ts`
-- devolve o id do RUN ou do TOKEN no caminho do cliente MCP externo —, então uma
-- FK para `ai_agents(id)` recusaria a escrita com 23503 justamente ali.
--
-- Idempotente e auto-curativo: colunas nullable, sem backfill (linha antiga fica
-- com autoria desconhecida, que é a verdade sobre ela). O CHECK viaja inline no
-- `add column if not exists` — em banco que já tem a coluna o comando inteiro é
-- no-op, que é o que o `update.sh` do clone precisa.

alter table public.crm_stages
  add column if not exists last_change_actor_kind text
  check (last_change_actor_kind in ('user','ai','system'));

alter table public.crm_stages
  add column if not exists last_change_at timestamptz;

alter table public.webhook_sources
  add column if not exists last_change_actor_kind text
  check (last_change_actor_kind in ('user','ai','system'));

alter table public.webhook_sources
  add column if not exists last_change_at timestamptz;

alter table public.automation_rules
  add column if not exists last_change_actor_kind text
  check (last_change_actor_kind in ('user','ai','system'));

alter table public.automation_rules
  add column if not exists last_change_at timestamptz;

comment on column public.crm_stages.last_change_actor_kind is
  'Espécie de quem fez a última mudança de configuração desta etapa: user | ai | system. NULL = anterior à 0101.';
comment on column public.webhook_sources.last_change_actor_kind is
  'Espécie de quem fez a última mudança nesta entrada automática de contatos: user | ai | system. NULL = anterior à 0101.';
comment on column public.automation_rules.last_change_actor_kind is
  'Espécie de quem ligou/desligou/editou esta regra por último: user | ai | system. NULL = anterior à 0101.';



notify pgrst, 'reload schema';

-- ---- uso das capacidades do agente (migration 0103) ----
-- Toda chamada de tool do agente já era auditada em api_audit_log
-- (action='mcp.tool_called') e NENHUMA tela lia — log invisível é log morto
-- (invariante 3 da doutrina do sistema vivo). Esta função é o leitor.
--
-- Vive no banco porque não há FK entre api_audit_log e ai_agent_runs: amarrar os
-- dois no Node exigiria mandar de volta os ids de ~9.000 runs mensais de um
-- tenant PME num in(...). O elo é api_audit_log.request_id = ai_agent_runs.id (o
-- runtime usa o id do run como requestId do McpContext); request_id é text, daí
-- o cast.
--
-- A janela é aplicada nos DOIS lados (r.started_at e a.created_at): os runs saem
-- de ai_agent_runs_agent_idx, e a data no audit deixa o planner cortar por
-- idx_audit_action_time em vez de varrer uma tabela que retém 5 anos. Medido em
-- pg17 com 708.020 linhas de audit (10,2% tool calls) e 36.000 runs, melhor de
-- 3: sem a janela no audit 345,7 ms · com a janela 224,0 ms · com um índice
-- parcial dedicado 165,0 ms — o índice NÃO foi adotado, porque api_audit_log é
-- append-only de escrita altíssima e 60 ms numa aba não pagam manutenção de
-- índice em todo INSERT.
--
-- em_teste separa o que veio de execução de teste (is_dry_run): sem isso a tela
-- diria "usada 4 vezes" quando as 4 foram o dono clicando em Testar.
--
-- security invoker: pelo service role (rota já resolve a org do cookie) a RLS não
-- se aplica; por usuário autenticado, audit_log_select continua exigindo admin.
create or replace function public.fn_agent_tool_usage(
  p_organization_id uuid,
  p_agent_id        uuid,
  p_since           timestamptz
)
returns table (
  tool_name  text,
  total      bigint,
  falhas     bigint,
  em_teste   bigint,
  ultima_vez timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    a.metadata->>'tool_name'                                          as tool_name,
    count(*)::bigint                                                  as total,
    count(*) filter (where a.metadata->>'success' = 'false')::bigint   as falhas,
    count(*) filter (where r.is_dry_run)::bigint                       as em_teste,
    max(a.created_at)                                                 as ultima_vez
  from public.ai_agent_runs r
  join public.api_audit_log a
    on  a.request_id      = r.id::text
    and a.action          = 'mcp.tool_called'
    and a.organization_id = p_organization_id
    and a.created_at     >= p_since
  where r.organization_id = p_organization_id
    and r.agent_id        = p_agent_id
    and r.started_at     >= p_since
    and a.metadata->>'tool_name' is not null
  group by 1
$$;

comment on function public.fn_agent_tool_usage(uuid, uuid, timestamptz) is
  'Uso das capacidades (tools MCP) de um agente: total, falhas, quantos vieram de execução de teste e a última vez. Elo audit<->run é api_audit_log.request_id = ai_agent_runs.id.';

grant execute on function public.fn_agent_tool_usage(uuid, uuid, timestamptz)
  to authenticated, service_role;
-- ---- retorno cancelado ≠ retorno disparado (migration 0102) ----------------
-- `cron_jobs.enabled = false` significa DUAS coisas: o one-shot disparou ou
-- alguém desmarcou. Enquanto forem a mesma linha no banco, o agente não sabe, ao
-- retomar, que o humano cancelou o retorno — o invariante 2 da doutrina
-- (continuidade humano→IA) fica pela metade — e a fila mostra "concluída" para
-- um retorno que ninguém executou.
--
-- Sem backfill: as linhas antigas ficam com `cancelled_at` nulo porque essa é a
-- verdade disponível. Não se sabe quais foram canceladas antes desta coluna
-- existir, e chutar seria gravar ficção em histórico.
alter table public.cron_jobs
  add column if not exists cancelled_at  timestamptz,
  add column if not exists cancel_reason text;

comment on column public.cron_jobs.cancelled_at is
  'Quando o retorno foi desmarcado. NULL = nunca cancelado (disparou ou ainda vai disparar). Distingue cancelado de disparado, que enabled=false sozinho não distingue.';
comment on column public.cron_jobs.cancel_reason is
  'Por que foi desmarcado, em texto curto e sem PII. Mesmo vocabulário de followup_enrollments.cancel_reason.';

create index if not exists idx_cron_jobs_retorno_vivo
  on public.cron_jobs (organization_id, contact_id, next_run_at)
  where enabled = true and job_kind = 'followup_turn';
-- ---- agent_case_events.kind ganha 'agent_noted' (migration 0100) ----
-- O agente conseguia ABRIR um chamado e nada mais: não havia valor honesto no
-- CHECK para "o agente registrou o que aconteceu depois" ('lead_provided' é a
-- informação que o LEAD deu, 'human_replied' é a pessoa). Sem esse registro, o
-- atendente seguinte que abre o chamado começa do zero.
-- Idempotente e auto-curativo: a lista só CRESCE, então nenhuma linha existente
-- viola a constraint nova e não há dado a corrigir antes de criá-la.
alter table public.agent_case_events
  drop constraint if exists agent_case_events_kind_check;

alter table public.agent_case_events
  add constraint agent_case_events_kind_check check (kind in (
    'opened',
    'human_replied',
    'lead_asked',
    'lead_provided',
    'lead_unresponsive',
    'resolved',
    'escalated',
    'cancelled',
    'agent_noted'
  ));

-- ---- catálogo de modelos atualizado (migration 0104) ----
-- O catálogo curado estava duas gerações atrás e o kit self-host aplica SÓ o
-- baseline: sem este apêndice, quem instala numa VPS continua escolhendo entre
-- modelos velhos e pagando mais caro por pior. Ids verificados no provedor
-- (GET /v1/models) para Anthropic e OpenAI; os do Google seguem a convenção e
-- NÃO foram verificados — ver o cabeçalho da migration. Idempotente por
-- `on conflict do update`.

-- ---------------------------------------------------------------------------
-- 1. catálogo curado (o que a tela oferece)
-- ---------------------------------------------------------------------------
insert into public.ai_models
  (provider, model_id, display_name, description,
   input_price_per_million_cents, output_price_per_million_cents, supports_tools)
values
  -- Anthropic
  ('anthropic', 'claude-opus-5',     'Claude Opus 5',
   'O mais capaz da Anthropic para trabalho agêntico complexo.', 500, 2500, true),
  ('anthropic', 'claude-sonnet-5',   'Claude Sonnet 5',
   'Alto desempenho para atendimento e agentes. Preço de introdução ($2/$10 por milhão) até 31/08/2026; depois volta a $3/$15 — reveja este preço nessa data.',
   200, 1000, true),
  ('anthropic', 'claude-opus-4-8',   'Claude Opus 4.8',
   'Geração anterior do Opus.', 500, 2500, true),
  -- OpenAI
  ('openai',    'gpt-5.6-sol',       'GPT-5.6 Sol',
   'O mais capaz da linha 5.6.', 500, 3000, true),
  ('openai',    'gpt-5.6-terra',     'GPT-5.6 Terra',
   'Equilíbrio de custo e capacidade da linha 5.6.', 200, 1200, true),
  ('openai',    'gpt-5.6-luna',      'GPT-5.6 Luna',
   'O mais barato da linha 5.6, para classificação e tarefas simples.', 20, 120, true),
  ('openai',    'gpt-5.5',           'GPT-5.5',              null, 500, 3000, true),
  ('openai',    'gpt-5.5-pro',       'GPT-5.5 Pro',
   'Raciocínio estendido; custo alto.', 3000, 18000, true),
  ('openai',    'gpt-5.4',           'GPT-5.4',              null, 250, 1500, true),
  ('openai',    'gpt-5.4-mini',      'GPT-5.4 Mini',         null, 75, 450, true),
  ('openai',    'gpt-5.4-nano',      'GPT-5.4 Nano',         null, 20, 125, true),
  ('openai',    'gpt-5.4-pro',       'GPT-5.4 Pro',
   'Raciocínio estendido; custo alto.', 3000, 18000, true),
  -- Google (ids NÃO verificados — ver cabeçalho)
  ('google',    'gemini-3.1-pro-preview', 'Gemini 3.1 Pro (Preview)',
   'Prévia; preço sobe para $4/$18 por milhão acima de 200 mil tokens de entrada.', 200, 1200, true),
  ('google',    'gemini-3.5-flash',  'Gemini 3.5 Flash',     null, 150, 900, true),
  ('google',    'gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite',
   'O mais barato da linha Gemini.', 10, 40, true),
  ('google',    'gemini-2.0-flash',  'Gemini 2.0 Flash',     null, 10, 40, true)
on conflict (provider, model_id) do update set
  display_name = excluded.display_name,
  description = excluded.description,
  input_price_per_million_cents = excluded.input_price_per_million_cents,
  output_price_per_million_cents = excluded.output_price_per_million_cents,
  supports_tools = excluded.supports_tools;

-- Correção de preço nos que JÁ existiam e estavam errados: a saída do
-- gemini-2.5-pro é $10 (não $5) e a do gemini-2.5-flash é $2,50 (não $1,20).
-- Preço errado no catálogo vira orçamento errado na tela do cliente.
update public.ai_models set output_price_per_million_cents = 1000
 where provider = 'google' and model_id = 'gemini-2.5-pro';
update public.ai_models set output_price_per_million_cents = 250
 where provider = 'google' and model_id = 'gemini-2.5-flash';

-- ---------------------------------------------------------------------------
-- 2. padrão por provedor
--
-- O índice `ai_models_one_default_per_provider` é UNIQUE parcial e IMEDIATO:
-- limpar o padrão anterior tem de vir ANTES de marcar o novo, senão a migration
-- quebra no meio.
-- ---------------------------------------------------------------------------
update public.ai_models set is_default_for_provider = false
 where provider in ('anthropic', 'openai', 'google') and is_default_for_provider;

update public.ai_models set is_default_for_provider = true
 where (provider = 'anthropic' and model_id = 'claude-sonnet-5')
    or (provider = 'openai'    and model_id = 'gpt-5.6-terra')
    or (provider = 'google'    and model_id = 'gemini-3.5-flash');

-- ---------------------------------------------------------------------------
-- 3. contabilidade de custo — a MESMA lista, senão o gasto é calculado com
--    preço de outro modelo (ou não é calculado, que é pior: some do orçamento).
-- ---------------------------------------------------------------------------
insert into public.ai_pricing
  (model, prompt_cents_per_million_tokens, completion_cents_per_million_tokens, notes)
values
  ('claude-opus-5',          500,   2500,  'catálogo 0101'),
  ('claude-sonnet-5',        200,   1000,  'catálogo 0101 — introdução até 31/08/2026; depois 300/1500'),
  ('claude-opus-4-8',        500,   2500,  'catálogo 0101'),
  ('gpt-5.6-sol',            500,   3000,  'catálogo 0101'),
  ('gpt-5.6-terra',          200,   1200,  'catálogo 0101'),
  ('gpt-5.6-luna',            20,    120,  'catálogo 0101'),
  ('gpt-5.5',                500,   3000,  'catálogo 0101'),
  ('gpt-5.5-pro',           3000,  18000,  'catálogo 0101'),
  ('gpt-5.4',                250,   1500,  'catálogo 0101'),
  ('gpt-5.4-mini',            75,    450,  'catálogo 0101'),
  ('gpt-5.4-nano',            20,    125,  'catálogo 0101'),
  ('gpt-5.4-pro',           3000,  18000,  'catálogo 0101'),
  ('gemini-3.1-pro-preview', 200,   1200,  'catálogo 0101 — sobe acima de 200k tokens de entrada'),
  ('gemini-3.5-flash',       150,    900,  'catálogo 0101'),
  ('gemini-2.5-flash-lite',   10,     40,  'catálogo 0101'),
  ('gemini-2.0-flash',        10,     40,  'catálogo 0101'),
  ('gemini-2.5-pro',         125,   1000,  'catálogo 0101 — saída corrigida de 500 para 1000'),
  ('gemini-2.5-flash',        30,    250,  'catálogo 0101 — saída corrigida de 120 para 250')
on conflict (model) do update set
  prompt_cents_per_million_tokens = excluded.prompt_cents_per_million_tokens,
  completion_cents_per_million_tokens = excluded.completion_cents_per_million_tokens,
  notes = excluded.notes,
  superseded_at = null;

-- ---- agent_inbox_items.kind ganha 'capabilities_missing' (migration 0105capabilities_missing
-- Quando o turno não consegue montar as capacidades configuradas na tela, ele
-- segue sem elas (a conversa do cliente não pode morrer por uma tool extra) —
-- mas o aviso ia só para o log do worker, que numa VPS ninguém abre. Este kind
-- é o que faz o defeito aparecer na Central de avisos. Idempotente: a lista só
-- cresce, nenhuma linha existente viola a constraint nova.
--
-- ESTE É O BLOCO ÚNICO desta constraint, e a migration 0139 não acrescenta
-- outro DE PROPÓSITO. A 0129 reconstruiu a constraint na CADEIA DE MIGRATIONS
-- com 15 valores enquanto esta lista já tinha 18, apagando lá (e só lá)
-- 'contact_proposal_expired', 'promise_unfulfilled' e 'other'. Quem instala
-- pelo kit nunca viu o defeito — recebe este arquivo, que está correto —, e é
-- por isso que a 0139 é uma migration SEM apêndice: um segundo bloco aqui seria
-- exatamente o padrão da issue #159 que `baseline-constraint-reconstruida.test.ts`
-- proíbe. Quem acrescentar um `kind` mexe em DOIS lugares: esta lista e a última
-- migration que reconstrói a constraint. `kind-check-migration-x-baseline.test.ts`
-- reprova quando as duas divergem.

alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'qr_rescan',
    'job_dead',
    'event_dead',
    'budget_exceeded',
    'handoff',
    'promotion_review',
    'judge_unaligned',
    'followup_dead',
    'snooze_expired',
    'next_action_ambiguous',
    'risk_backlog_seeded',
    'reactivation_expired',
    'capabilities_missing',
    -- (migration 0109, issue #129) Mensagem outbound nasce `sending` e, quando o
    -- envio nunca acontece, fica `sending` para sempre — o self-hoster vê uma
    -- mensagem eternamente "enviando", sinal de progresso para algo que não vai
    -- acontecer. O cron `recover-stuck-messages` marca `failed` e usa este kind
    -- para o defeito APARECER na Central de avisos.
    --
    -- Entra NESTA lista, e não num bloco novo no fim do arquivo: o #159 do @jmpo
    -- mostrou que reconstruir a mesma constraint em N blocos quebra o
    -- `update.sh` de todo clone que já tenha uma linha de vocabulário posterior
    -- — os blocos antigos rodam antes e falham em cadeia. Um bloco por
    -- constraint, vigiado por tests/unit/baseline-constraint-reconstruida.test.ts.
    'message_send_stuck',
    -- (migration 0129) O cliente manda foto/áudio e o agente age como se nada
    -- tivesse chegado. Acontece quando o modelo configurado não enxerga imagem,
    -- ou quando falta a chave de transcrição — e antes disto a derivação
    -- devolvia string vazia EM SILÊNCIO: nenhum erro, nenhum log, e o operador
    -- concluindo que o agente ignorou o cliente de propósito.
    'midia_nao_lida',
    'channel_template_review',
    'channel_number_alert',
    -- (migration 0111, spec 16 §3.2) O papel Operador declara promessa em aberto:
    -- o assistente prometeu algo ao cliente e o cumprimento não foi registrado.
    -- A invariante sagrada da spec é "nenhuma promessa deixa de ser cumprida", e
    -- uma promessa sem dono precisa aparecer onde o humano olha — não no log do
    -- worker. Entra NESTA lista pela mesma razão que a de cima.
    'promise_unfulfilled',
    -- (migration 0124, spec 17 §4b) Dado que o assistente ouviu na conversa e
    -- ninguém confirmou até o prazo. `info`, não `warn`: nada quebrou — uma
    -- informação não foi aproveitada, e tratar isso como falha ensinaria a
    -- ignorar os avisos que são falha de verdade. Entra NESTA lista pela mesma
    -- razão das de cima (bloco único por constraint, #159).
    'contact_proposal_expired',
    -- (migration 0159) O gasto passou do aviso que a pessoa definiu e a IA
    -- CONTINUA respondendo — `warn`, nunca `critical`, e um kind SEPARADO de
    -- `budget_exceeded`: colapsar os dois faria o alerta de "parou" perder o
    -- significado. É este kind que torna possível a condição do gate "ninguém é
    -- bloqueado sem ter sido avisado no mês" — sem ele, o salto de 79% para 101%
    -- entre duas chamadas calaria a IA sem nenhum sinal anterior.
    --
    -- Entra NESTA lista, e AQUI no fim, por duas razões distintas: bloco único
    -- por constraint (#159), e porque `tests/unit/midia-nao-lida.test.ts` procura
    -- `'midia_nao_lida'` nos primeiros 2000 caracteres a partir do `add
    -- constraint` — um valor comentado inserido ACIMA dele empurra-o para fora da
    -- janela e reprova um teste que não tem nada a ver com o kind novo (medido:
    -- offset 1532 -> 2275). Kind novo entra no fim da lista.
    'budget_warning',
    -- (migration 0181) O material que a pessoa enviou não entrou na base: falta
    -- chave de embedding, a extração do arquivo falhou, ou nenhum trecho foi
    -- gravado. Antes disto o worker devolvia `skipped` para o próprio log, o drain
    -- tratava `skipped` como sucesso, e a linha da fonte seguia dizendo `ready`.
    -- Irmão direto de `midia_nao_lida`: mesma chave, mesmo silêncio.
    'conhecimento_nao_indexado',
    'other'
  ));



notify pgrst, 'reload schema';

-- ---- channel_sessions.archived_at (migration 0106) ----
-- Arquivar em vez de apagar: conversations/messages referenciam
-- channel_sessions com ON DELETE RESTRICT, então canal com histórico não pode
-- ser removido — some da UI e a linha fica como âncora das FKs.
alter table public.channel_sessions
  add column if not exists archived_at timestamptz;

create index if not exists channel_sessions_org_active_idx
  on public.channel_sessions (organization_id, created_at)
  where archived_at is null;



notify pgrst, 'reload schema';

-- ---- número único só entre canais ATIVOS (migration 0107) ----
-- A trava `channel_sessions_phone_per_org_unique` é do snapshot e não sabe o que
-- é arquivamento: a linha arquivada seguia ocupando o par (org, número), e
-- reparear o MESMO número estourava 23505 na linha nova. O invariante real é "um
-- número vive em UM canal ATIVO" — vira índice parcial `where archived_at is
-- null`, com o MESMO NOME (o invariante do repo cobra o nome dentro da mensagem
-- de erro). Perde o DEFERRABLE: medido, nenhum caminho escreve
-- channel_sessions.phone_number com violação transitória.
--
-- Auto-curativo: a constraint antiga é ESTRITAMENTE mais forte que o índice novo
-- (todas as linhas vs. um subconjunto), então nenhum banco que a satisfazia pode
-- violar o índice — não há dado a deduplicar antes de criá-lo.
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.channel_sessions'::regclass
       and conname = 'channel_sessions_phone_per_org_unique'
  ) then
    alter table public.channel_sessions
      drop constraint channel_sessions_phone_per_org_unique;
  end if;
end $$;

create unique index if not exists channel_sessions_phone_per_org_unique
  on public.channel_sessions (organization_id, phone_number)
  where archived_at is null;

-- ---- SECURITY DEFINER exposta a anon/authenticated (migration 0108) ----
-- Issue #128. O `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon`
-- (e a irmã TO authenticated) lá em cima vale para toda função criada DEPOIS
-- dele — isto é, para TODO apêndice deste arquivo, que sempre nasce no fim — e
-- concede grant DIRETO, que `revoke all ... from public` não remove. Copiar as
-- duas linhas padrão de uma função antiga produz função exposta.
--
-- Medido com o baseline da main aplicado: das 25 `security definer` de public,
-- 8 tinham EXECUTE para anon — incluindo `fn_publish_ai_agent_version`, que
-- ESCREVE e recebe o org por argumento sem checar membership.
--
-- REGRA (vigiada por tests/invariants/hardening-definer-varredura.test.ts):
--   anon          → nenhuma definer de public executável, sem exceção;
--   authenticated → definer VOLÁTIL só continua executável com call site de
--                   sessão de usuário (emit_event, fn_conversation_assign,
--                   fn_log_event). As demais só são chamadas pelo client de
--                   service role, e o grant era escrita cross-tenant à toa.
-- Idempotente e auto-curativo: revoke de privilégio ausente é no-op.

-- ---- anon: nenhuma SECURITY DEFINER de public ----
-- Duas origens de EXECUTE, e cada uma pede um revoke diferente — medir o ACL
-- real (`proacl`) foi o que mostrou isso: `{=X/postgres,...}` é grant a PUBLIC,
-- que `revoke ... from anon` NÃO remove. As duas linhas juntas cobrem os dois
-- caminhos, e o re-grant explícito devolve quem de fato precisa.
revoke execute on function public.fn_is_platform_admin() from public, anon;
revoke execute on function public.fn_user_org_ids() from public, anon;
revoke execute on function public.fn_user_role_in_org(uuid) from public, anon;
revoke execute on function public.fn_user_role_in(uuid) from public, anon;
revoke execute on function public.fn_role_at_least(uuid, text) from public, anon;
revoke execute on function public.fn_publish_ai_agent_version(uuid, uuid, uuid) from public, anon;
revoke execute on function public.fn_emit_conversation_routing() from public, anon;

-- ---- authenticated: definer volátil sem call site de sessão de usuário ----
revoke execute on function public.fn_upsert_wa_contact(uuid, text, text, text, text, text) from authenticated;
revoke execute on function public.fn_upsert_wa_conversation(uuid, uuid, uuid) from authenticated;
revoke execute on function public.fn_mark_conversation_message(uuid, text, text, timestamptz) from authenticated;
revoke execute on function public.fn_publish_ai_agent_version(uuid, uuid, uuid) from authenticated;
revoke execute on function public.activate_kb_version(uuid, uuid) from authenticated;
-- Funções de TRIGGER: ninguém as chama por RPC, e o disparo do trigger não
-- consulta EXECUTE. O grant só existia por herança dos padrões do Postgres.
revoke execute on function public.fn_emit_conversation_routing() from authenticated;

-- ---- re-grant explícito: quem precisa continua podendo (probe positivo) ----
grant execute on function public.fn_upsert_wa_contact(uuid, text, text, text, text, text) to service_role;
grant execute on function public.fn_upsert_wa_conversation(uuid, uuid, uuid) to service_role;
grant execute on function public.fn_mark_conversation_message(uuid, text, text, timestamptz) to service_role;
grant execute on function public.fn_publish_ai_agent_version(uuid, uuid, uuid) to service_role;
grant execute on function public.activate_kb_version(uuid, uuid) to service_role;
grant execute on function public.fn_emit_conversation_routing() to service_role;
-- Helpers de RLS: as policies são avaliadas com o papel de quem consulta, então
-- `authenticated` PRECISA de EXECUTE — sem isto toda leitura logada quebra.
grant execute on function public.fn_is_platform_admin() to authenticated, service_role;
grant execute on function public.fn_user_org_ids() to authenticated, service_role;
grant execute on function public.fn_user_role_in_org(uuid) to authenticated, service_role;
grant execute on function public.fn_user_role_in(uuid) to authenticated, service_role;
grant execute on function public.fn_role_at_least(uuid, text) to authenticated, service_role;

-- ---- ai_invocations.agent_id aceita NULL (migration 0114) ----
-- Issue #160 (@jmpo, medindo a própria VPS): o classificador de sentimento roda
-- mesmo sem agente ativo — lê o agente só para o threshold e cai no default —
-- mas auditava com `agent_id: agent?.id ?? ""` numa coluna `uuid NOT NULL`. O
-- insert é fire-and-forget, então o erro só aparecia como `warn` no log do
-- contêiner: `ai_invocations` ficava VAZIA numa instalação com tráfego real, e
-- as telas de consumo e custo de IA (que leem dela) mostravam zero enquanto o
-- provider era pago. "Sem agente ativo" é o estado normal de quem ainda não
-- publicou o agente.
-- Idempotente: `drop not null` em coluna que já aceita null é no-op.

alter table public.ai_invocations
  alter column agent_id drop not null;

comment on column public.ai_invocations.agent_id is
  'Agente que originou a invocação. NULL = invocação de IA sem agente dono '
  '(ex.: classificador de sentimento numa org sem agente publicado). O custo '
  'existe e precisa aparecer nas telas de consumo — ver issue #160.';


-- ---- Índice de Atrito + DEMANDAS (migrations 0116–0120) ----
-- Spec 17 + doutrina cap. 5. `demandas` é a unidade do PROPÓSITO: contato é
-- quem pede, conversa é por onde se fala, demanda é o que precisa acabar.
-- O índice usa demandas como denominador (0137) e publica o invariante 4 como
-- número (demandas abertas sem próximo passo). Idempotente.

create index if not exists idx_conversations_org_silencio
  on public.conversations (organization_id, last_outbound_at)
  where last_outbound_at is not null;

/**
 * Jaccard de tokens entre dois textos. Tokens com 3+ caracteres (artigos e
 * preposições curtas só somam ruído), sem acento-folding: reformulação real
 * varia palavra, não acento.
 */
create or replace function public.fn_atrito_jaccard(a text, b text)
returns float8
language sql
immutable
set search_path = public
as $$
  with
  ta as (
    select distinct token from unnest(
      string_to_array(lower(regexp_replace(coalesce(a, ''), '[^[:alnum:][:space:]]', ' ', 'g')), ' ')
    ) as token
    where length(token) >= 3
  ),
  tb as (
    select distinct token from unnest(
      string_to_array(lower(regexp_replace(coalesce(b, ''), '[^[:alnum:][:space:]]', ' ', 'g')), ' ')
    ) as token
    where length(token) >= 3
  )
  select case
    when (select count(*) from ta) = 0 or (select count(*) from tb) = 0 then 0::float8
    else (select count(*) from (select token from ta intersect select token from tb) i)::float8
       / nullif((select count(*) from (select token from ta union select token from tb) u), 0)::float8
  end;
$$;

revoke all     on function public.fn_atrito_jaccard(text, text) from public;
revoke execute on function public.fn_atrito_jaccard(text, text) from anon;
grant  execute on function public.fn_atrito_jaccard(text, text) to authenticated, service_role;

create table if not exists public.demandas (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- SOLICITANTE: quem tem o problema (não necessariamente quem escreveu).
  contact_id uuid not null references public.contacts(id) on delete cascade,
  -- Vínculo com o negócio, quando houver. Uma demanda de suporte não tem lead,
  -- e isso é desfecho legítimo — não pendência.
  lead_id uuid references public.crm_leads(id) on delete set null,

  -- Ponteiro para o caso de escalada que originou a demanda, quando houve.
  -- Sem ele, as métricas de toque humano (que vivem em `agent_case_events`)
  -- perderiam a ligação com a demanda ao trocar o denominador do índice.
  agent_case_id uuid references public.agent_cases(id) on delete set null,

  aberta_em timestamptz not null default now(),
  origem text not null default 'inbound'
    check (origem in ('inbound', 'handoff', 'followup', 'manual', 'derivada')),
  assunto text,

  estado text not null default 'aberta'
    check (estado in ('aberta', 'em_atendimento', 'aguardando_cliente', 'resolvida', 'encerrada')),

  -- DONO NUNCA VAZIO (cap. 5 §5.3). Demanda sem dono é a definição operacional
  -- de "vai morrer". Se ninguém assumiu, o dono é a automação — e isso é uma
  -- decisão registrada, não um vazio que ninguém nota.
  dono_kind text not null default 'ia' check (dono_kind in ('ia', 'humano')),
  dono_user_id uuid references auth.users(id) on delete set null,

  -- PRÓXIMO PASSO é CAMPO, não derivação (cap. 5 §5.3): derivado, ele
  -- desapareceria nos casos em que a derivação falha — que são exatamente os
  -- casos em que ele importa. É aqui que o invariante 4 vira verificável.
  proximo_passo text,
  proximo_passo_em timestamptz,
  prazo_em timestamptz,

  -- Desfecho ENUMERADO e terminal. Inclui os que não são vitória: o sistema não
  -- pode ser o único a decidir que uma demanda acabou, senão fecharia por
  -- conveniência (encerrar por inatividade melhora todo número sem melhorar
  -- nada). `expirada_sem_resposta` é desfecho legítimo e RUIM — contável e
  -- vigiado; organização onde ele é zero está mal instrumentada, não saudável.
  desfecho text check (desfecho in (
    'resolvida', 'convertida', 'nao_procede',
    'encerrada_pelo_cliente', 'perdida', 'expirada_sem_resposta'
  )),
  fechada_em timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Desfecho e fechamento andam juntos: um sem o outro é linha meio-fechada,
  -- que nenhuma consulta de "abertas" nem de "encerradas" pegaria.
  constraint demandas_desfecho_coerente
    check ((desfecho is null) = (fechada_em is null)),
  -- Dono humano exige QUEM. `dono_kind='humano'` com user nulo seria dono vazio
  -- com aparência de dono preenchido.
  constraint demandas_dono_humano_tem_user
    check (dono_kind <> 'humano' or dono_user_id is not null)
);

-- Uma demanda atravessa VÁRIOS canais e uma conversa carrega VÁRIAS demandas
-- (cap. 5 §5.4). Resistir a este muitos-para-muitos é a fonte de metade dos
-- problemas de modelagem neste domínio: um-para-um obriga a escolher entre
-- perder o problema que muda de canal e perder o segundo problema da conversa.
create table if not exists public.demanda_conversas (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  demanda_id uuid not null references public.demandas(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  vinculada_em timestamptz not null default now(),
  primary key (demanda_id, conversation_id)
);

create index if not exists idx_demandas_org_abertas
  on public.demandas (organization_id, aberta_em)
  where fechada_em is null;
create index if not exists idx_demandas_org_fechadas
  on public.demandas (organization_id, fechada_em)
  where fechada_em is not null;
create index if not exists idx_demandas_caso
  on public.demandas (organization_id, agent_case_id)
  where agent_case_id is not null;
create index if not exists idx_demandas_contato
  on public.demandas (organization_id, contact_id);
-- O invariante 4 em forma de índice: demanda aberta SEM próximo passo é o
-- vazamento que a doutrina proíbe, e precisa ser barato de enumerar.
create index if not exists idx_demandas_sem_proximo_passo
  on public.demandas (organization_id, aberta_em)
  where fechada_em is null and proximo_passo is null;
create index if not exists idx_demanda_conversas_conv
  on public.demanda_conversas (organization_id, conversation_id);

alter table public.demandas enable row level security;
alter table public.demanda_conversas enable row level security;

drop policy if exists tenant_isolation_demandas_all on public.demandas;
create policy tenant_isolation_demandas_all on public.demandas
  for all
  using (organization_id in (select * from public.fn_user_org_ids()))
  with check (organization_id in (select * from public.fn_user_org_ids()));

drop policy if exists tenant_isolation_demanda_conversas_all on public.demanda_conversas;
create policy tenant_isolation_demanda_conversas_all on public.demanda_conversas
  for all
  using (organization_id in (select * from public.fn_user_org_ids()))
  with check (organization_id in (select * from public.fn_user_org_ids()));

-- ---------------------------------------------------------------------------
-- Passo 2 de 4: derivar o passado por REGRA EXPLÍCITA, nunca por adivinhação.
--
-- A regra fica escrita porque histórico derivado por regra é honesto e
-- histórico derivado por heurística contamina toda comparação futura — e
-- ninguém vai lembrar disso daqui a seis meses, comparando dois trimestres.
--
--   R1. Todo `agent_cases` vira uma demanda (origem 'handoff'). O mapeamento de
--       status é 1:1 e sem interpretação.
--   R2. Toda conversa SEM agent_case vira uma demanda (origem 'derivada'),
--       porque houve uma pessoa com um assunto ali. `assunto` fica NULO — não
--       inventamos o que a conversa tratava.
--
-- Idempotente por `where not exists`: re-aplicar não duplica.
-- ---------------------------------------------------------------------------

-- R1 — a partir dos casos de escalada.
insert into public.demandas
  (organization_id, contact_id, lead_id, agent_case_id, aberta_em, origem, assunto,
   estado, dono_kind, desfecho, fechada_em)
select
  c.organization_id,
  cv.contact_id,
  c.lead_id,
  c.id,
  c.opened_at,
  'handoff',
  c.title,
  case c.status
    when 'awaiting_human' then 'em_atendimento'
    when 'awaiting_lead'  then 'aguardando_cliente'
    when 'resolved'       then 'resolvida'
    when 'escalated'      then 'em_atendimento'
    when 'cancelled'      then 'encerrada'
    else 'aberta'
  end,
  'ia',
  case c.status
    when 'resolved'  then 'resolvida'
    when 'cancelled' then 'nao_procede'
    else null
  end,
  case when c.status in ('resolved', 'cancelled') then c.closed_at else null end
  from public.agent_cases c
  join public.conversations cv on cv.id = c.conversation_id
 where not exists (
   select 1 from public.demandas d
    where d.organization_id = c.organization_id
      and d.contact_id = cv.contact_id
      and d.origem = 'handoff'
      and d.aberta_em = c.opened_at
 );

-- Vínculo N:N das demandas derivadas de caso.
insert into public.demanda_conversas (organization_id, demanda_id, conversation_id)
select d.organization_id, d.id, c.conversation_id
  from public.demandas d
  join public.agent_cases c on c.id = d.agent_case_id
 where d.agent_case_id is not null
   and not exists (
     select 1 from public.demanda_conversas dc
      where dc.demanda_id = d.id and dc.conversation_id = c.conversation_id
   );

-- R2 — conversas que nunca escalaram também são demandas.
insert into public.demandas
  (organization_id, contact_id, aberta_em, origem, estado, dono_kind, desfecho, fechada_em)
select
  cv.organization_id,
  cv.contact_id,
  cv.created_at,
  'derivada',
  case cv.status when 'resolved' then 'resolvida' when 'closed' then 'encerrada' else 'aberta' end,
  'ia',
  case when cv.status in ('resolved', 'closed') then 'resolvida' else null end,
  case when cv.status in ('resolved', 'closed') then cv.status_changed_at else null end
  from public.conversations cv
 where not exists (
   select 1 from public.agent_cases c where c.conversation_id = cv.id
 )
   and not exists (
   select 1 from public.demandas d
    where d.organization_id = cv.organization_id
      and d.contact_id = cv.contact_id
      and d.origem = 'derivada'
      and d.aberta_em = cv.created_at
 );

insert into public.demanda_conversas (organization_id, demanda_id, conversation_id)
select d.organization_id, d.id, cv.id
  from public.demandas d
  join public.conversations cv
    on cv.organization_id = d.organization_id
   and cv.contact_id = d.contact_id
   and cv.created_at = d.aberta_em
 where d.origem = 'derivada'
   and not exists (
     select 1 from public.demanda_conversas dc
      where dc.demanda_id = d.id and dc.conversation_id = cv.id
   );

comment on table public.demandas is
  'A unidade do PROPÓSITO (doutrina cap. 5): uma coisa a ser resolvida. '
  'Contato é quem pede; conversa é por onde se fala; demanda é o que precisa '
  'acabar. Dono nunca vazio; próximo passo é campo, não derivação.';


drop function if exists public.fn_atrito_metrics(uuid, timestamptz, timestamptz, int, float8, int);

create or replace function public.fn_atrito_metrics(
  p_org uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_abandono_horas int default 72,
  p_repeticao_min float8 default 0.7,
  p_espera_horas int default 4
) returns jsonb
language sql stable
set search_path = public
as $$
  with
  -- DENOMINADOR DEFINITIVO: demandas encerradas na janela. Não mais os casos.
  demandas_j as (
    select d.id, d.agent_case_id, d.aberta_em, d.fechada_em, d.desfecho
      from public.demandas d
     where d.organization_id = p_org
       and d.fechada_em is not null
       and d.fechada_em >= p_from
       and d.fechada_em <  p_to
  ),
  -- Turnos: mensagens de TODAS as conversas da demanda (N:N), dentro da vida
  -- dela. Uma demanda que atravessou dois canais soma os dois.
  turnos as (
    select d.id,
           (select count(*)
              from public.demanda_conversas dc
              join public.messages m
                on m.conversation_id = dc.conversation_id
               and m.organization_id = p_org
               and m.sent_at >= d.aberta_em
               and m.sent_at <  d.fechada_em
             where dc.demanda_id = d.id) as n
      from demandas_j d
  ),
  -- Insistência: só existe onde houve caso. O payload declara o denominador
  -- próprio (`demandas_com_caso`) para o número não ser lido como se fosse
  -- sobre o total.
  insistencia as (
    select avg(c.followup_attempts)::float8 as media,
           max(c.followup_attempts)         as maximo,
           count(*)                         as base
      from demandas_j d
      join public.agent_cases c on c.id = d.agent_case_id
  ),
  humano as (
    select e.case_id, count(*) as intervencoes, min(e.created_at) as primeiro_toque
      from public.agent_case_events e
      join demandas_j d on d.agent_case_id = e.case_id
     where e.organization_id = p_org and e.actor_kind = 'human'
     group by e.case_id
  ),
  espera_fila as (
    select extract(epoch from (h.primeiro_toque - d.aberta_em)) as segundos
      from demandas_j d join humano h on h.case_id = d.agent_case_id
     where h.primeiro_toque > d.aberta_em
  ),
  retrabalho as (
    select count(distinct e.case_id) as n
      from public.agent_case_events e
      join demandas_j d on d.agent_case_id = e.case_id
     where e.organization_id = p_org
       and (e.kind = 'escalated' or e.human_action = 'escalate')
  ),
  abandono as (
    select
      count(*) filter (
        where cv.last_outbound_at >= p_from and cv.last_outbound_at < p_to
          and (cv.last_inbound_at is null or cv.last_outbound_at > cv.last_inbound_at)
          and cv.last_outbound_at < now() - make_interval(hours => p_abandono_horas)
          and cv.status not in ('resolved', 'closed')
      ) as abandonadas,
      count(*) filter (
        where cv.last_outbound_at >= p_from and cv.last_outbound_at < p_to
      ) as com_fala_nossa
      from public.conversations cv
     where cv.organization_id = p_org and cv.last_outbound_at is not null
  ),
  -- INVARIANTE 4, agora VERIFICÁVEL: demanda aberta sem próximo passo é o
  -- vazamento que a doutrina proíbe. Antes da 0119 isto não era enumerável.
  sem_proximo_passo as (
    select count(*) as n
      from public.demandas d
     where d.organization_id = p_org
       and d.fechada_em is null
       and d.proximo_passo is null
  ),
  demandas_abertas as (
    select count(*) as n from public.demandas d
     where d.organization_id = p_org and d.fechada_em is null
  ),
  inbounds as (
    select m.conversation_id, m.sent_at, m.body,
           lag(m.body)    over (partition by m.conversation_id order by m.sent_at) as body_anterior,
           lag(m.sent_at) over (partition by m.conversation_id order by m.sent_at) as sent_at_anterior
      from public.messages m
     where m.organization_id = p_org and m.direction = 'inbound' and m.body is not null
       and m.sent_at >= p_from and m.sent_at < p_to
  ),
  repeticao as (
    select
      count(*) filter (
        where i.body_anterior is not null
          and exists (select 1 from public.messages o
                       where o.organization_id = p_org and o.conversation_id = i.conversation_id
                         and o.direction = 'outbound'
                         and o.sent_at > i.sent_at_anterior and o.sent_at < i.sent_at)
          and public.fn_atrito_jaccard(i.body, i.body_anterior) >= p_repeticao_min
      ) as repetidas,
      count(*) filter (
        where i.body_anterior is not null
          and exists (select 1 from public.messages o
                       where o.organization_id = p_org and o.conversation_id = i.conversation_id
                         and o.direction = 'outbound'
                         and o.sent_at > i.sent_at_anterior and o.sent_at < i.sent_at)
      ) as com_resposta_no_meio
      from inbounds i
  ),
  espera_calada as (
    select count(*) filter (where prox.espera_s > p_espera_horas * 3600) as caladas,
           count(*) as com_resposta,
           percentile_cont(0.9) within group (order by prox.espera_s) as p90_s
      from (
        select extract(epoch from (
                 (select min(o.sent_at) from public.messages o
                   where o.organization_id = p_org and o.conversation_id = m.conversation_id
                     and o.direction = 'outbound' and o.sent_at > m.sent_at) - m.sent_at)) as espera_s
          from public.messages m
         where m.organization_id = p_org and m.direction = 'inbound'
           and m.sent_at >= p_from and m.sent_at < p_to
      ) prox
     where prox.espera_s is not null
  ),
  envios as (
    select count(*) filter (where m.sent_via = 'ai')              as por_ia,
           count(*) filter (where m.sent_via = 'user')            as por_humano_no_sistema,
           count(*) filter (where m.sent_via = 'external_device') as por_humano_fora
      from public.messages m
     where m.organization_id = p_org and m.direction = 'outbound'
       and m.sent_at >= p_from and m.sent_at < p_to
  ),
  vetos as (
    select count(*) filter (where t.vetoed_gate is not null) as vetados,
           count(distinct t.job_id) as execucoes
      from public.before_send_traces t
     where t.organization_id = p_org and t.created_at >= p_from and t.created_at < p_to
  ),
  descadastros as (
    select count(*) as n from public.contacts c
     where c.organization_id = p_org and c.blocked_at is not null
       and c.blocked_at >= p_from and c.blocked_at < p_to
  ),
  pedidos_humano as (
    select count(*) as n from public.crm_lead_activities a
     where a.organization_id = p_org and a.type = 'handoff_triggered'
       and a.performed_at >= p_from and a.performed_at < p_to
  ),
  eficiencia as (
    select count(*) filter (where status = 'won')  as ganhos,
           count(*) filter (where status = 'lost') as perdidos
      from public.crm_leads
     where organization_id = p_org and status in ('won', 'lost')
       and closed_at >= p_from and closed_at < p_to
  )
  select jsonb_build_object(
    'escopo', jsonb_build_object(
      'demandas',            (select count(*) from demandas_j),
      'demandas_com_caso',   (select base from insistencia),
      'demandas_abertas',    (select n from demandas_abertas),
      'de', p_from, 'ate', p_to,
      'abandono_horas', p_abandono_horas,
      'repeticao_min',  p_repeticao_min,
      'espera_horas',   p_espera_horas,
      -- Marca a régua do denominador: quem comparar dois períodos precisa saber
      -- se foram medidos sobre casos ou sobre demandas.
      'denominador', 'demandas'
    ),
    'cliente', jsonb_build_object(
      'turnos_p50',        (select percentile_cont(0.5) within group (order by n) from turnos),
      'turnos_p90',        (select percentile_cont(0.9) within group (order by n) from turnos),
      'insistencia_media', (select media  from insistencia),
      'insistencia_max',   (select maximo from insistencia),
      'pedidos_de_humano', (select n from pedidos_humano),
      'descadastros',      (select n from descadastros),
      'abandonos',         (select abandonadas   from abandono),
      'conversas_com_fala_nossa', (select com_fala_nossa from abandono),
      'reperguntas',              (select repetidas            from repeticao),
      'perguntas_com_resposta',   (select com_resposta_no_meio from repeticao),
      'esperas_caladas',          (select caladas      from espera_calada),
      'esperas_medidas',          (select com_resposta from espera_calada),
      'espera_resposta_p90_s',    (select p90_s        from espera_calada)
    ),
    'empresa', jsonb_build_object(
      'intervencoes_por_demanda', (select avg(coalesce(h.intervencoes, 0))::float8
                                     from demandas_j d left join humano h on h.case_id = d.agent_case_id),
      'espera_humana_p50_s',      (select percentile_cont(0.5) within group (order by segundos) from espera_fila),
      'espera_humana_p90_s',      (select percentile_cont(0.9) within group (order by segundos) from espera_fila),
      'retrabalho',               (select n from retrabalho),
      'vetos',                    (select vetados  from vetos),
      'execucoes_medidas',        (select execucoes from vetos),
      'envios_por_ia',            (select por_ia                from envios),
      'envios_humano_no_sistema', (select por_humano_no_sistema from envios),
      'envios_humano_fora',       (select por_humano_fora       from envios),
      -- O invariante 4 vira NÚMERO na tela: demanda aberta sem próximo passo é
      -- vazamento, e vazamento invisível é o que a doutrina inteira combate.
      'demandas_sem_proximo_passo', (select n from sem_proximo_passo)
    ),
    'eficiencia', jsonb_build_object(
      'ganhos',   (select ganhos   from eficiencia),
      'perdidos', (select perdidos from eficiencia)
    )
  );
$$;

revoke all     on function public.fn_atrito_metrics(uuid, timestamptz, timestamptz, int, float8, int) from public;
revoke execute on function public.fn_atrito_metrics(uuid, timestamptz, timestamptz, int, float8, int) from anon;
grant  execute on function public.fn_atrito_metrics(uuid, timestamptz, timestamptz, int, float8, int)
  to authenticated, service_role;





-- ---- demanda nasce no ponto de entrada (migration 0138) ----
-- Sem isto `demandas` só teria o passado derivado: peça que só recebe é ilha
-- pelo invariante 1. Trigger SQL puro, sem I/O externo — a proibição da
-- doutrina é HTTP dentro da transação, e `trg_messages_emit_event` já usa este
-- mesmo mecanismo nesta mesma tabela.

create or replace function public.fn_demanda_abre_no_inbound()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_demanda uuid;
begin
  if new.direction <> 'inbound' then
    return new;
  end if;

  select d.id into v_demanda
    from public.demandas d
   where d.organization_id = new.organization_id
     and d.contact_id = new.contact_id
     and d.fechada_em is null
   order by d.aberta_em desc
   limit 1;

  if v_demanda is null then
    insert into public.demandas
      (organization_id, contact_id, aberta_em, origem, estado, dono_kind)
    values
      (new.organization_id, new.contact_id, new.sent_at, 'inbound', 'aberta', 'ia')
    returning id into v_demanda;
  end if;

  -- O vínculo é por conversa: a mesma demanda acumula os canais por onde a
  -- pessoa falou (cap. 5 §5.4). `on conflict do nothing` porque a chave é o par.
  insert into public.demanda_conversas (organization_id, demanda_id, conversation_id)
  values (new.organization_id, v_demanda, new.conversation_id)
  on conflict do nothing;

  return new;
end;
$$;

-- SECURITY DEFINER porque o trigger roda no INSERT do webhook (service role) e
-- também no de sessão; sem definer, a RLS de `demandas` recusaria a escrita em
-- um dos caminhos e a demanda sumiria justamente na entrada real. O
-- organization_id vem SEMPRE de `new`, nunca de parâmetro — não há superfície
-- para escolher org alheia.
revoke all     on function public.fn_demanda_abre_no_inbound() from public;
revoke execute on function public.fn_demanda_abre_no_inbound() from anon, authenticated;

drop trigger if exists trg_demanda_abre_no_inbound on public.messages;
create trigger trg_demanda_abre_no_inbound
  after insert on public.messages
  for each row execute function public.fn_demanda_abre_no_inbound();

-- ---------------------------------------------------------------------------
-- Fechamento. Sem ele a demanda nunca termina e o denominador do índice (que
-- conta FECHADAS) ficaria vazio para sempre — a métrica morreria em silêncio no
-- exato momento em que a entidade passou a crescer.
-- ---------------------------------------------------------------------------

create or replace function public.fn_demanda_fecha_com_conversa()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status not in ('resolved', 'closed') or old.status = new.status then
    return new;
  end if;

  update public.demandas d
     set estado = 'resolvida',
         desfecho = 'resolvida',
         fechada_em = now(),
         updated_at = now()
   where d.organization_id = new.organization_id
     and d.fechada_em is null
     and exists (
       select 1 from public.demanda_conversas dc
        where dc.demanda_id = d.id and dc.conversation_id = new.id
     )
     -- Só fecha se TODAS as conversas da demanda estiverem encerradas: uma
     -- demanda que atravessou dois canais não acabou porque um deles fechou.
     and not exists (
       select 1
         from public.demanda_conversas dc2
         join public.conversations c2 on c2.id = dc2.conversation_id
        where dc2.demanda_id = d.id
          and c2.id <> new.id
          and c2.status not in ('resolved', 'closed')
     );

  return new;
end;
$$;

revoke all     on function public.fn_demanda_fecha_com_conversa() from public;
revoke execute on function public.fn_demanda_fecha_com_conversa() from anon, authenticated;

drop trigger if exists trg_demanda_fecha_com_conversa on public.conversations;
create trigger trg_demanda_fecha_com_conversa
  after update of status on public.conversations
  for each row execute function public.fn_demanda_fecha_com_conversa();


notify pgrst, 'reload schema';

-- ---- lead_checkpoints.declaracao: a fronteira FALAR/OPERAR (migration 0110) ----
-- Spec 16 §5. NULLABLE de propósito: NULL = o modelo não declarou;
-- {"nada_a_declarar":true} = avaliou e não havia nada. Colapsar os dois num
-- default apagaria o esquecimento, que é o que o invariante 4 manda mostrar.
alter table lead_checkpoints
  add column if not exists declaracao jsonb;

comment on column lead_checkpoints.declaracao is
  'Declaração do turno (spec 16 §5): {intencoes[], promessas[], nada_a_declarar}. '
  'NULL = o modelo não declarou; {"nada_a_declarar":true} = avaliou e não havia nada. '
  'Os dois estados são distintos por desenho.';

notify pgrst, 'reload schema';

-- ---- turno do OPERADOR: config por versão (migration 0111) ----
-- Spec 16 §3.2. O papel que mexe no sistema e nunca fala com o lead; disparo
-- imposto pelo runtime, por evento.
--
-- Os DOIS CHECKs de `job_queue` (kind + coerência kind⇔contato) NÃO estão aqui:
-- eles vivem no bloco único lá em cima, já com 'operator_turn'. Reconstruí-los
-- aqui criaria o segundo bloco que quebra o update.sh do clone.
alter table ai_agent_versions
  add column if not exists operator_enabled boolean not null default false;
alter table ai_agent_versions
  add column if not exists operator_model text;

-- (migration 0112) Ferramentas do papel Operador — coluna PRÓPRIA, não reuso de
-- `tool_ids`: se os dois papéis lessem a mesma lista, a seção "Operador" da tela
-- estaria configurando o que o Conversador executa. Default vazio: o papel nasce
-- sem mão, e herdar as do Conversador em silêncio daria 20 capacidades a quem
-- não escolheu nenhuma.
alter table ai_agent_versions
  add column if not exists operator_tool_ids text[] not null default '{}'::text[];

comment on column ai_agent_versions.operator_tool_ids is
  'Spec 16 §6: capacidades do papel Operador, independentes de `tool_ids` (do '
  'Conversador). Vazio = o papel roda mas não tem mão — estado legítimo: ele '
  'ainda registra promessa em aberto na Central.';

comment on column ai_agent_versions.operator_enabled is
  'Spec 16 §3.2: o papel Operador roda após o turno do Conversador. false = o '
  'registro básico segue por código determinístico (estado, follow-up prometido, '
  'timeline); o que se perde é o julgamento sobre as capacidades do catálogo.';
comment on column ai_agent_versions.operator_model is
  'Modelo do papel Operador. NULL = herda o modelo do agente.';

notify pgrst, 'reload schema';
-- 0115 — duas entidades que não se conseguia apagar.
--
-- Achados ao remover as fixtures de E2E da produção em 2026-08-06. Os dois são
-- da mesma família: uma escrita AUTOMÁTICA (trigger/FK) reagindo ao DELETE e
-- violando uma regra que vale para o estado normal, mas não para a remoção.
--
-- ═══ DEFEITO 1 · não era possível apagar uma ORGANIZAÇÃO ═══
--
--   ERROR: insert or update on table "api_audit_log" violates foreign key
--          constraint "api_audit_log_organization_id_fkey"
--   DETAIL: Key (organization_id)=(…) is not present in table "organizations".
--
-- O cascade apaga os filhos, o trigger de audit de cada um insere em
-- `api_audit_log` com o `organization_id` — e a organização já não existe. Só
-- funcionava apagando os filhos à mão ANTES, com o pai vivo.
--
-- Conserto: no DELETE, o audit é pulado quando a organização já não existe. Não
-- se perde auditoria: a linha que ele escreveria seria apagada pelo cascade da
-- própria organização um instante depois. E a checagem fica SÓ no ramo DELETE —
-- pôr um `exists` no INSERT/UPDATE cobraria um SELECT em todo hot path de
-- escrita para proteger de um caso que não acontece lá.
--
-- ═══ DEFEITO 2 · não era possível apagar um AGENTE que já atendeu ═══
--
--   ERROR: new row for relation "crm_leads" violates check constraint
--          "crm_leads_owner_kind_coherence"
--
-- `crm_leads_owner_agent_id_fkey` é ON DELETE SET NULL; o CHECK exige
-- `owner_agent_id not null` quando `owner_kind = 'ai'`. O SET NULL zera um lado
-- e deixa o outro — estado que a constraint proíbe, com razão.
--
-- Conserto: um BEFORE DELETE em `ai_agents` desfaz a atribuição INTEIRA (os dois
-- campos), antes de a FK agir. O lead fica sem dono (`owner_kind is null`, que o
-- CHECK aceita) em vez de ficar num estado meio-atribuído.
--
-- Não se enfraquece o CHECK para tolerar `'ai'` sem agente: ele descreve um
-- invariante verdadeiro, e afrouxá-lo para acomodar uma operação rara trocaria
-- um erro barulhento por dados incoerentes em silêncio.

-- ── 1 · o audit não persegue uma organização que está sendo removida ────────
create or replace function public.fn_audit_log_row() returns trigger
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_action text;
  v_org    uuid;
begin
  if tg_op = 'INSERT' then
    v_action := tg_table_name || '.created';
    v_org    := new.organization_id;
  elsif tg_op = 'UPDATE' then
    v_action := tg_table_name || '.updated';
    v_org    := new.organization_id;
  elsif tg_op = 'DELETE' then
    v_action := tg_table_name || '.deleted';
    v_org    := old.organization_id;

    -- A organização está indo embora (cascade em curso). Registrar a exclusão
    -- de um filho num tenant que deixa de existir não tem consumidor: a linha
    -- seria apagada pelo cascade em seguida — e tentar escrevê-la aborta a
    -- transação inteira, que era o defeito.
    --
    -- SÓ no ramo DELETE: um `exists` no INSERT/UPDATE cobraria um SELECT em
    -- todo hot path de escrita para cobrir um caso que não ocorre lá.
    if v_org is not null and not exists (select 1 from public.organizations where id = v_org) then
      return old;
    end if;
  end if;

  insert into public.api_audit_log (organization_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_org,
    auth.uid(),
    v_action,
    tg_table_name,
    coalesce(new.id, old.id),
    case when tg_op = 'UPDATE'
      then jsonb_build_object('changed_fields', '[diff suppressed in v0.1]')
      else '{}'::jsonb
    end
  );

  return coalesce(new, old);
end $$;

-- ── 2 · apagar um agente desfaz a atribuição inteira, não metade dela ───────
create or replace function public.fn_liberar_leads_do_agente() returns trigger
    language plpgsql security definer
    set search_path to 'public'
    as $$
begin
  -- ANTES de a FK aplicar seu SET NULL. Zera os DOIS campos: deixar
  -- `owner_kind = 'ai'` com o agente nulo é exatamente o estado que
  -- `crm_leads_owner_kind_coherence` proíbe.
  update public.crm_leads
     set owner_agent_id = null,
         owner_kind     = null
   where owner_agent_id = old.id;
  return old;
end $$;

-- As TRÊS origens de EXECUTE (CLAUDE.md, doutrina de migrations):
--   `public`      — o grant que o Postgres dá a toda função ao criá-la;
--   `anon`        — o ALTER DEFAULT PRIVILEGES do baseline, que alcança toda
--                   função criada depois dele;
--   `authenticated` — idem, e é o que a varredura de hardening cobra.
--
-- Revogar de todas é seguro AQUI porque o único call site é o TRIGGER, e o
-- Postgres não exige EXECUTE do usuário para invocar função de trigger. Nenhuma
-- sessão chama esta função diretamente.
revoke execute on function public.fn_liberar_leads_do_agente() from public, anon, authenticated;
grant  execute on function public.fn_liberar_leads_do_agente() to service_role;

drop trigger if exists trg_liberar_leads_do_agente on public.ai_agents;
create trigger trg_liberar_leads_do_agente
  before delete on public.ai_agents
  for each row execute function public.fn_liberar_leads_do_agente();

comment on function public.fn_liberar_leads_do_agente() is
  'Migration 0115: desfaz a atribuição de leads antes de o agente ser apagado. '
  'Sem isto o SET NULL da FK zera owner_agent_id e deixa owner_kind=''ai'', '
  'violando crm_leads_owner_kind_coherence — e um agente que já atendeu alguém '
  'não podia ser removido.';


-- ---- ai_purpose_bindings: qual modelo cada ponto usa (migration 0126) ----
-- Onde a escolha de modelo de cada ponto do sistema que usa IA passa a morar.
-- Uma linha por (organização, ponto); ausência de linha = comportamento
-- anterior preservado, então re-aplicar num clone não muda o funcionamento de
-- nada. `provider` sem CHECK de propósito: é vocabulário aberto (os três CHECKs
-- de provider que já existem são o que trava a entrada da OpenRouter, e um
-- quarto repetiria o erro). `base_url` nasce para endpoint compatível com a API
-- da OpenAI — OpenRouter hoje, modelo local depois.
create table if not exists public.ai_purpose_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  purpose text not null,
  provider text not null,
  credential_id uuid references public.ai_provider_credentials(id) on delete cascade,
  model_id text not null,
  base_url text,
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Deduplicar ANTES da constraint: um clone que tenha rodado uma versão
-- intermediária desta frente pode ter duas linhas para o mesmo ponto, e aí o
-- update.sh (que roda SEM ON_ERROR_STOP) morreria aqui em silêncio. Fica a
-- mais recente, que é a última escolha do operador.
delete from public.ai_purpose_bindings a
 using public.ai_purpose_bindings b
 where a.organization_id = b.organization_id
   and a.purpose = b.purpose
   and (a.updated_at, a.id) < (b.updated_at, b.id);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'ai_purpose_bindings_org_purpose_unique'
       and conrelid = 'public.ai_purpose_bindings'::regclass
  ) then
    alter table public.ai_purpose_bindings
      add constraint ai_purpose_bindings_org_purpose_unique unique (organization_id, purpose);
  end if;
end $$;

create index if not exists ai_purpose_bindings_org_idx
  on public.ai_purpose_bindings (organization_id);
create index if not exists ai_purpose_bindings_lookup_idx
  on public.ai_purpose_bindings (organization_id, purpose) where is_enabled;
create index if not exists ai_purpose_bindings_credential_idx
  on public.ai_purpose_bindings (credential_id) where credential_id is not null;

-- (migration 0141) A FK da credencial nasceu `on delete cascade`, e isso fazia
-- rotacionar uma chave — apagar a antiga, cadastrar a nova — APAGAR a linha
-- inteira do binding, levando junto provider, model_id e base_url. A tela
-- passava a dizer "Usando o padrão da organização", frase verdadeira sobre um
-- estado que ninguém escolheu. `set null` desvincula sem apagar: NULL já
-- significa "use a chave da instalação", que é como todo binding nasce.
-- Reescrita incondicional (drop + add) para o clone que já tem o CASCADE.
alter table public.ai_purpose_bindings
  drop constraint if exists ai_purpose_bindings_credential_id_fkey;
alter table public.ai_purpose_bindings
  add constraint ai_purpose_bindings_credential_id_fkey
  foreign key (credential_id) references public.ai_provider_credentials(id)
  on delete set null;

alter table public.ai_purpose_bindings enable row level security;

drop policy if exists tenant_isolation_ai_purpose_bindings_all on public.ai_purpose_bindings;
create policy tenant_isolation_ai_purpose_bindings_all on public.ai_purpose_bindings
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

drop trigger if exists ai_purpose_bindings_updated_at on public.ai_purpose_bindings;
create trigger ai_purpose_bindings_updated_at
  before update on public.ai_purpose_bindings
  for each row execute function public.fn_set_updated_at();

comment on table public.ai_purpose_bindings is
  'Migration 0126: qual provedor/credencial/modelo cada ponto do sistema que usa IA deve usar, por organização. O catálogo dos pontos vive em lib/ai/pontos/registro.ts e o par é vigiado por tests/unit/pontos-de-ia-completude.test.ts.';



-- ---- provider vira vocabulário aberto + catálogo sincronizável (migration 0127) ----
-- Os três CHECKs de provider travavam anthropic|openai|google, o que torna
-- impossível cadastrar uma chave da OpenRouter (ou de qualquer provedor novo, ou
-- de um modelo local) — o INSERT viola constraint antes de qualquer código rodar.
-- Vocabulário ABERTO por doutrina: quem recusa provider desconhecido é o registry,
-- com erro tipado, não uma constraint que faria o update.sh do clone quebrar.
alter table public.ai_agent_versions       drop constraint if exists ai_agent_versions_provider_check;
alter table public.ai_models               drop constraint if exists ai_models_provider_check;
alter table public.ai_provider_credentials drop constraint if exists ai_provider_credentials_provider_check;

-- Aberto não é livre: string vazia seria linha que nenhum registry resolve e
-- nenhuma tela exibe.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_models_provider_nao_vazio') then
    alter table public.ai_models add constraint ai_models_provider_nao_vazio check (length(btrim(provider)) > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_provider_credentials_provider_nao_vazio') then
    alter table public.ai_provider_credentials add constraint ai_provider_credentials_provider_nao_vazio check (length(btrim(provider)) > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_agent_versions_provider_nao_vazio') then
    alter table public.ai_agent_versions add constraint ai_agent_versions_provider_nao_vazio check (length(btrim(provider)) > 0);
  end if;
end $$;

alter table public.ai_models add column if not exists source text not null default 'manual';
alter table public.ai_models add column if not exists synced_at timestamptz;
alter table public.ai_models add column if not exists supports_vision boolean not null default false;

-- Deduplicar ANTES do índice único (o update.sh roda sem ON_ERROR_STOP: índice
-- que falha é pulado em silêncio e o upsert do sincronizador volta a duplicar).
delete from public.ai_models a
 using public.ai_models b
 where a.provider = b.provider
   and a.model_id = b.model_id
   and (
     (a.input_price_per_million_cents is null and b.input_price_per_million_cents is not null)
     or (
       (a.input_price_per_million_cents is null) = (b.input_price_per_million_cents is null)
       and a.id < b.id
     )
   );

create unique index if not exists ai_models_provider_model_unique on public.ai_models (provider, model_id);
create index if not exists ai_models_source_idx on public.ai_models (source) where deprecated_at is null;

comment on column public.ai_models.source is
  'Migration 0127: ''manual'' ou o nome do sincronizador (ex.: ''openrouter''). O sincronizador só mexe nas linhas da PRÓPRIA origem — apagar o que um humano cadastrou seria perder configuração sem aviso.';
comment on column public.ai_models.synced_at is
  'Migration 0127: quando a origem confirmou este modelo pela última vez. Modelo que some recebe deprecated_at, nunca DELETE: a linha ainda é referenciada pelo histórico de custo.';



-- ---- llm_calls registra a FALHA, não só o sucesso (migration 0128) ----
-- A tabela gravava uma linha por chamada de modelo e só quando dava certo: o
-- INSERT vivia depois do generateText, sem try em volta. Provedor recusando a
-- chave, modelo inexistente, conta sem saldo — a exceção subia e nada ficava
-- gravado. A tabela que deveria explicar era justamente a que ficava vazia no
-- caso que precisa de explicação, e é a causa direta de "o agente não responde
-- e não aparece erro em lugar nenhum".
alter table public.llm_calls add column if not exists status text not null default 'ok';
alter table public.llm_calls add column if not exists error_code text;
alter table public.llm_calls add column if not exists error_message text;
alter table public.llm_calls add column if not exists http_status int;
alter table public.llm_calls add column if not exists origem_da_escolha text;

-- Corrigir os dados ANTES da constraint: o update.sh roda sem ON_ERROR_STOP, e
-- um CHECK que falhasse seria pulado em silêncio, deixando o clone sem guarda.
update public.llm_calls set status = 'ok' where status is null or status not in ('ok', 'erro');

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'llm_calls_status_check') then
    alter table public.llm_calls add constraint llm_calls_status_check check (status in ('ok', 'erro'));
  end if;
end $$;

create index if not exists llm_calls_erros_idx
  on public.llm_calls (organization_id, created_at desc) where status = 'erro';
create index if not exists llm_calls_purpose_idx
  on public.llm_calls (organization_id, purpose, created_at desc);

comment on column public.llm_calls.status is
  'Migration 0128: ''ok'' | ''erro''. Antes desta migration a tabela só registrava sucesso.';
comment on column public.llm_calls.error_message is
  'Migration 0128: texto do provedor, truncado. NUNCA prompt, resposta ou chave.';
comment on column public.llm_calls.origem_da_escolha is
  'Migration 0128: quem decidiu usar este modelo. Transforma o log de "o que aconteceu" em "por que aconteceu".';






-- ---- uma tabela de telemetria de IA, não duas (migration 0130) ----
-- `agent_id` NÃO existia em llm_calls, e sem ele a unificação jogaria fora a
-- atribuição de custo por agente — junto com o filtro por agente da tela de uso,
-- que é como o operador descobre qual agente está consumindo a conta. Perder uma
-- capacidade em nome de unificar seria trocar um problema por outro.
alter table public.llm_calls add column if not exists agent_id uuid
  references public.ai_agents(id) on delete set null;
create index if not exists llm_calls_agent_idx
  on public.llm_calls (organization_id, agent_id, created_at desc) where agent_id is not null;

alter table public.llm_calls add column if not exists legacy_invocation_id uuid;

create unique index if not exists llm_calls_legacy_invocation_unique
  on public.llm_calls (legacy_invocation_id) where legacy_invocation_id is not null;

comment on column public.llm_calls.legacy_invocation_id is
  'Migration 0130: id da linha de ai_invocations que originou esta. Existe para o backfill ser '
  'idempotente — o update.sh re-aplica o baseline a cada atualização, e sem esta marca o custo '
  'histórico cresceria sozinho a cada execução.';

-- O backfill. `on conflict do nothing` sobre o índice único faz a re-execução
-- ser inócua. `purpose` recebe o `invocation_kind` porque é o mesmo eixo com
-- nomes diferentes; o vocabulário de ambos já está no registro de pontos.
insert into public.llm_calls (
  organization_id, agent_id, contact_id, job_id, purpose, provider, model,
  input_tokens, output_tokens, cost_cents, latency_ms, created_at,
  status, error_code, legacy_invocation_id
)
select
  i.organization_id,
  i.agent_id,
  null,                       -- ai_invocations guarda conversation/message, não contato
  null,
  i.invocation_kind,
  -- O provider não era guardado; deriva-se do prefixo do modelo, e quando não
  -- dá para saber vai 'desconhecido' em vez de um chute que viraria estatística.
  case
    when i.model like 'anthropic/%' then 'anthropic'
    when i.model like 'openai/%'    then 'openai'
    when i.model like 'google/%'    then 'google'
    when i.model like 'claude%'     then 'anthropic'
    when i.model like 'gpt%'        then 'openai'
    when i.model like 'gemini%'     then 'google'
    else 'desconhecido'
  end,
  i.model,
  i.prompt_tokens,
  i.completion_tokens,
  i.cost_cents,
  i.latency_ms,
  i.created_at,
  case when i.error_payload is not null then 'erro' else 'ok' end,
  case when i.error_payload is not null then 'erro_legado' else null end,
  i.id
from public.ai_invocations i
where not exists (
  select 1 from public.llm_calls c where c.legacy_invocation_id = i.id
)
on conflict do nothing;

comment on table public.ai_invocations is
  'DEPRECIADA na migration 0130 — a telemetria de IA vive em llm_calls. Mantida como histórico '
  '(a doutrina do repo é depreciar, não deletar) e porque as linhas antigas são a prova do que foi '
  'gasto. Nada escreve mais aqui; leituras novas usam llm_calls.';

-- ---- o orçamento do mês não conta o backfill como gasto novo (migration 0140) ----
--
-- Este bloco tem de vir DEPOIS do backfill da 0130, e é por isso que ele está
-- aqui e não junto do trigger da 0095. `fn_update_budget_consumption` soma
-- `NEW.cost_cents` sem olhar a data, e o backfill é um INSERT: cada linha
-- migrada — inclusive as de meses passados — era somada ao consumo do mês
-- corrente. Medido em pg17: gasto real do mês 1600, contador em 3000 depois de
-- um `update.sh` e estabilizando em 2600, nunca em 1600. Numa organização sem
-- gasto no mês, o contador saltava de 0 para o histórico inteiro — 200% do
-- limite padrão no caso medido — e a IA do clone podia parar sem nenhuma
-- chamada nova.
--
-- A correção é dar a ÚLTIMA PALAVRA a um recomputo que ATRIBUI (não incrementa)
-- o gasto real do mês, contando cada linha uma vez só. Vale qualquer que tenha
-- sido o estado deixado pelo trigger, e a re-aplicação chega no mesmo número.
-- Racional completo em supabase/migrations/20260808050000_0140_*.sql.
insert into public.ai_budgets (organization_id, current_month_consumed_cents)
select o.id,
       coalesce((select sum(c.cost_cents) from public.llm_calls c
                 where c.organization_id = o.id
                   and c.created_at >= date_trunc('month', now())), 0)
     + coalesce((select sum(i.cost_cents) from public.ai_invocations i
                 where i.organization_id = o.id
                   and i.created_at >= date_trunc('month', now())
                   and not exists (
                     select 1 from public.llm_calls c2 where c2.legacy_invocation_id = i.id
                   )), 0)
from public.organizations o
on conflict (organization_id) do update
set current_month_consumed_cents = excluded.current_month_consumed_cents,
    updated_at = now();
-- ---- telefone do contato @lid (migration 0122) ----
-- O kit self-host aplica SÓ este arquivo — no install (banco novo, ON_ERROR_STOP)
-- e no update (banco existente, SEM a flag). Tudo abaixo é idempotente e
-- auto-curativo: a dedup por lid roda ANTES do índice único, senão o update.sh
-- de um clone com contatos duplicados quebra no meio.
--
-- Racional medido em supabase/migrations/20260807060000_0122_telefone_do_lid.sql.
-- Em uma linha: 76 de 76 payloads @lid trazem o telefone em
-- `_data.key.remoteJidAlt` e ninguém lia; e gravar esse telefone mudava a
-- `wa_identity` GERADA, quebrava o reencontro pelo `on conflict` e duplicava o
-- contato — por isso a correlação passa a ter coluna própria (`wa_lid`).

-- ---- 1 · wa_lid: a correlação que sobrevive ao telefone ----
-- Gerada, e não escrita à mão, pelo mesmo motivo de `wa_identity`: valor
-- derivado que alguém precisa lembrar de atualizar é valor que diverge. O
-- `nullif` no fim evita que contato sem lid vire string vazia e colida no índice
-- único com todos os outros contatos sem lid.
alter table public.contacts
  add column if not exists wa_lid text
  generated always as (
    nullif(regexp_replace(coalesce(source_metadata->>'waha_lid', ''), '@.*$', ''), '')
  ) stored;

-- ---- 2 · deduplicar ANTES da constraint (auto-curativo) ----
-- Um clone pode ter dois contatos com o mesmo lid — nasceram antes da 0027, ou
-- de uma janela em que o upsert ainda fazia check-then-act. Criar o índice único
-- sem tratar isso quebraria o `update.sh` do clone, que é exatamente o que a
-- doutrina de migrations proíbe.
--
-- O sobrevivente é o mais ANTIGO (é dele o histórico); os outros são marcados
-- como fundidos e suas referências repontadas — mesma mecânica do bloco B1 da
-- 0027, que já existe no baseline.
with ranked as (
  select id,
         first_value(id) over (
           partition by organization_id,
             nullif(regexp_replace(coalesce(source_metadata->>'waha_lid', ''), '@.*$', ''), '')
           order by created_at asc, id asc
         ) as canonical_id
    from public.contacts
   where is_merged_into is null
     and nullif(regexp_replace(coalesce(source_metadata->>'waha_lid', ''), '@.*$', ''), '') is not null
)
update public.contacts c
   set is_merged_into = r.canonical_id, merged_at = now()
  from ranked r
 where c.id = r.id and r.id <> r.canonical_id;

update public.conversations       t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.messages            t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.ai_agent_runs       t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.crm_lead_activities t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.crm_leads           t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.lgpd_requests       t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.orders              t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;

create unique index if not exists uniq_contacts_org_wa_lid
  on public.contacts (organization_id, wa_lid)
  where wa_lid is not null and is_merged_into is null;

-- ---- 3 · o upsert passa a reencontrar por LID, e a completar o que falta ----
-- A versão de 6 parâmetros tinha DOIS buracos, além do telefone:
--   (a) no conflito só mexia em `display_name`, com `coalesce(existente, novo)` —
--       um nome ruim gravado uma vez congelava para sempre e nenhum dado
--       descoberto depois entrava;
--   (b) casava só por `wa_identity`, então não reencontrava o contato cuja
--       identidade mudou.
--
-- A regra nova é "completar, nunca sobrescrever": o que já está preenchido
-- vence, o que está vazio é preenchido. Assim um telefone descoberto no 5º
-- webhook entra, e um nome que o atendente corrigiu à mão não é desfeito pelo
-- pushName do WhatsApp.
create or replace function public.fn_upsert_wa_contact(
  p_org uuid, p_kind text, p_phone text, p_lid text, p_chat_id text, p_notify text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_conflito text;
  v_lid text := nullif(regexp_replace(coalesce(p_lid, ''), '@.*$', ''), '');
  v_phone text := nullif(p_phone, '');
begin
  -- ⚠️ A ASSINATURA NÃO MUDA, e não é economia de digitação.
  --
  -- A primeira versão desta migration acrescentava um 7º parâmetro
  -- (`p_phone_alt`) para o telefone vindo de `_data.key.remoteJidAlt`. Isso
  -- criava uma função nova aos olhos do Postgres, obrigava a dropar a de 6 e
  -- forçava a edição de DOIS invariantes de hardening que citam a assinatura —
  -- que o hook do repo (com razão) congela.
  --
  -- Quem sabe QUAL telefone usar é o chamador: `lib/waha/ingest.ts` já resolve o
  -- chatId e agora também lê o `remoteJidAlt`. Ele manda um telefone só, em
  -- `p_phone`. Menos superfície, mesma capacidade, e os grants existentes
  -- continuam valendo — a catraca levou ao desenho menor.

  -- 1 · pela correlação do WhatsApp, que NÃO depende do telefone.
  --     `wa_identity` é gerada com o telefone na frente do lid: um contato @lid
  --     que ganha número passa a valer `phone:+Y` e o `on conflict` antigo
  --     deixava de reencontrá-lo — nascia um contato por mensagem.
  if v_lid is not null then
    select id into v_id from public.contacts
     where organization_id = p_org and wa_lid = v_lid and is_merged_into is null
     limit 1;
  end if;

  -- 2 · pelo telefone — é aqui que a pessoa que já existia por número (import,
  --     formulário, pedido) deixa de virar um segundo contato ao escrever no
  --     WhatsApp. Sem este passo, descobrir o telefone criaria o gêmeo em vez de
  --     evitá-lo.
  if v_id is null and v_phone is not null then
    select id into v_id from public.contacts
     where organization_id = p_org and phone_number = v_phone and is_merged_into is null
     limit 1;
  end if;

  -- 3 · COMPLETA o que falta, nunca sobrescreve.
  --     A versão anterior só mexia em `display_name` no conflito, com
  --     `coalesce(existente, novo)`: um nome ruim gravado uma vez congelava para
  --     sempre, e telefone ou lid descobertos depois NUNCA entravam.
  -- O telefone descoberto só sobe para a coluna ÚNICA se ainda não for de outro
  -- contato vivo da org. Sem esta guarda o caso "contato @lid sem telefone + a
  -- mesma pessoa já cadastrada por número" (import, pedido, formulário) estoura
  -- `uniq_contacts_org_phone`; `lib/waha/ingest.ts:343` transforma a exceção em
  -- `return null` e `:459` descarta a mensagem com o webhook respondendo 200 — a
  -- mensagem do cliente some, e some de novo a cada mensagem seguinte daquele
  -- contato. Medido na triagem; não acontece na `main`, é regressão desta
  -- migration. A etapa 2 (busca por telefone) não protege: ela só roda quando a
  -- etapa 1 NÃO achou.
  --
  -- Fundir os dois contatos seria o desfecho semanticamente certo — é a mesma
  -- pessoa, e o `remoteJidAlt` é justamente quem afirma isso. Mas fusão é
  -- IRREVERSÍVEL, e a regra do tempo da doutrina proíbe consumar irreversível no
  -- tempo da máquina, dentro de um webhook. Aqui o dado não se perde: vai para
  -- `source_metadata.telefone_em_conflito`, que não é único, e a decisão de
  -- fundir fica para quem opera.
  if v_id is not null and v_phone is not null and exists (
    select 1 from public.contacts
     where organization_id = p_org and phone_number = v_phone
       and is_merged_into is null and id <> v_id
  ) then
    v_conflito := v_phone;
    v_phone := null;
  end if;

  if v_id is not null then
    update public.contacts set
      phone_number = coalesce(phone_number, v_phone),
      display_name = coalesce(display_name, nullif(p_notify, '')),
      source_metadata = source_metadata
        || case when v_lid is not null then jsonb_build_object('waha_lid', v_lid) else '{}'::jsonb end
        || case when p_chat_id is not null then jsonb_build_object('waha_chat_id', p_chat_id) else '{}'::jsonb end
        || case when nullif(p_notify, '') is not null then jsonb_build_object('notify_name', p_notify) else '{}'::jsonb end
        || case when v_conflito is not null then jsonb_build_object('telefone_em_conflito', v_conflito) else '{}'::jsonb end,
      updated_at = now()
    where id = v_id;
    return v_id;
  end if;

  insert into public.contacts (organization_id, phone_number, source, consent, tags, source_metadata, display_name)
  values (p_org, v_phone, 'whatsapp', '{}'::jsonb, '{}'::text[],
    case when v_lid is not null
      then jsonb_build_object('waha_lid', v_lid, 'waha_chat_id', p_chat_id, 'notify_name', nullif(p_notify, ''))
      else jsonb_build_object('waha_chat_id', p_chat_id, 'notify_name', nullif(p_notify, '')) end,
    nullif(p_notify, ''))
  returning id into v_id;
  return v_id;
end; $$;

-- Os grants da assinatura de 6 já existem desde a 0027 e continuam valendo — por
-- isso não há `drop function` aqui, e por isso os invariantes de hardening não
-- precisaram ser tocados.

-- ---- 4 · o rótulo técnico legado sai ----
-- Medido na produção: 3 linhas com `Contato 543134@lid` e `Contato 900928` —
-- duas formas, porque duas versões do código antigo os escreveram. Nenhum código
-- vivo produz isso hoje (o produtor morreu no commit c890b403); é resíduo, e o
-- passo seguinte da spec 17 vai LER o nome do contato para o título do card, o
-- que faria o resíduo vazar para o kanban.
--
-- ⚠️ `and is_anonymized = false` NÃO é zelo: `Contato Anonimizado #<id>` também
-- começa com "Contato " e é gravado deliberadamente pela rota de LGPD. Sem esta
-- guarda, o backfill REVERTERIA anonimizações — violação direta da regra L-04,
-- cuja exceção é "Nenhuma".
--
-- Vira NULL, e não um rótulo novo: quem decide o que mostrar quando não há nome
-- é a tela. Gravar texto de exibição no banco foi o que criou este problema.
update public.contacts
   set display_name = null, updated_at = now()
 where display_name ~ '^Contato [0-9]+(@lid)?$'
   and is_anonymized = false;


-- ---- fila de confirmação de dado do contato (migration 0123) ----
-- O Operador PROPÕE, um humano CONFIRMA — o dado que o cliente diz na conversa
-- não é gravado direto (spec 17 §4b). Forma copiada de `crm_lead_reactivations`,
-- que já é uma fila de proposta com prazo, decisão datada e idempotência por
-- índice parcial; a chave aqui é o CONTATO + campo, porque a proposta é sobre a
-- pessoa. Racional completo na migration.
--
-- Idempotente e auto-curativo: `create table if not exists`, constraints com
-- `drop ... if exists` antes, `create or replace function`.

create table if not exists public.contact_field_proposals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,

  -- QUAL campo. Vocabulário FECHADO por CHECK: o que entra aqui vira escrita em
  -- `contacts`, e campo livre deixaria a IA propor qualquer coluna.
  campo text not null,

  -- O valor proposto e o que existia quando a proposta nasceu. O segundo é o
  -- `from` que a regra L-06 exige — e existe ANTES da confirmação justamente
  -- para que a decisão seja tomada com os dois lados à vista.
  valor_proposto text not null,
  valor_anterior text,

  -- DE ONDE veio, para quem decide poder conferir em vez de acreditar.
  -- `trecho` é o que a pessoa escreveu; sem ele a confirmação é um ato de fé.
  conversation_id uuid references public.conversations(id) on delete set null,
  message_id uuid references public.messages(id) on delete set null,
  trecho text,
  proposed_by_agent_id uuid references public.ai_agents(id) on delete set null,

  status text not null default 'pending',

  -- Carimbados pelo BANCO, nunca pelo processo — mesma razão da 0081: instantes
  -- comparados entre si vêm do mesmo relógio.
  proposed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  decided_at timestamptz,
  decided_by_user_id uuid references auth.users(id) on delete set null,
  -- Por que foi recusada. É o LAÇO DE RETORNO (invariante 7): proposta que o
  -- humano rejeita diz onde a IA erra, e sem o motivo o sinal é só um número.
  motivo_recusa text,
  updated_at timestamptz not null default now()
);

comment on table public.contact_field_proposals is
  'Dado do contato que a IA ouviu na conversa e propôs — aguardando confirmação humana (spec 17 §4b). SEMPRE com prazo: proposta que ninguém decide vira badge permanente, que simula atenção e adia a decisão. No vencimento sai da tela e vira item de caixa.';

alter table public.contact_field_proposals
  drop constraint if exists contact_field_proposals_campo_check;
alter table public.contact_field_proposals
  add constraint contact_field_proposals_campo_check check (
    campo = any (array['email', 'name', 'phone_number']::text[])
  );

alter table public.contact_field_proposals
  drop constraint if exists contact_field_proposals_status_check;
alter table public.contact_field_proposals
  add constraint contact_field_proposals_status_check check (
    status = any (array['pending', 'accepted', 'dismissed', 'expired']::text[])
  );

-- Prazo no futuro: proposta que nasce vencida vira item de caixa no primeiro
-- tick e ninguém entende de onde veio.
alter table public.contact_field_proposals
  drop constraint if exists contact_field_proposals_prazo_no_futuro;
alter table public.contact_field_proposals
  add constraint contact_field_proposals_prazo_no_futuro check (expires_at > proposed_at);

-- Decisão e decisor andam juntos. Status decidido sem `decided_at` é registro
-- que não sabe dizer quando aconteceu — e é essa a pergunta que a auditoria faz.
alter table public.contact_field_proposals
  drop constraint if exists contact_field_proposals_decisao_datada;
alter table public.contact_field_proposals
  add constraint contact_field_proposals_decisao_datada check (
    (status = 'pending' and decided_at is null)
    or (status <> 'pending' and decided_at is not null)
  );

-- ⚠️ ESTE ÍNDICE É A IDEMPOTÊNCIA — não é otimização.
--
-- A IA vai ouvir o mesmo e-mail em dez mensagens seguidas. Sem ele, dez
-- propostas idênticas viram dez linhas e a tela do humano vira uma coluna de
-- repetições. `where not exists` no código NÃO substitui: é check-then-act, e
-- dois turnos concorrentes passam pela janela — o mesmo defeito que a 0027 veio
-- matar nos contatos.
--
-- PARCIAL: propostas decididas ficam como histórico e não bloqueiam a próxima. O
-- cliente pode corrigir o e-mail que ele mesmo deu errado, e impedir isso
-- deixaria a correção sem caminho.
create unique index if not exists uq_contact_field_proposals_uma_viva
  on public.contact_field_proposals (organization_id, contact_id, campo)
  where status = 'pending';

-- O worker de vencimento varre por aqui.
create index if not exists idx_contact_field_proposals_vencendo
  on public.contact_field_proposals (organization_id, expires_at)
  where status = 'pending';

alter table public.contact_field_proposals enable row level security;

drop policy if exists tenant_isolation_contact_field_proposals_all on public.contact_field_proposals;
create policy tenant_isolation_contact_field_proposals_all on public.contact_field_proposals
  for all
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

revoke all on public.contact_field_proposals from anon;

-- `proposed_at` e `updated_at` vêm do banco.
create or replace function public.fn_carimba_proposta_de_dado()
  returns trigger
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $$
begin
  if tg_op = 'INSERT' then
    new.proposed_at := now();
  end if;
  new.updated_at := now();
  return new;
end$$;

revoke all on function public.fn_carimba_proposta_de_dado() from public, anon;

drop trigger if exists trg_contact_field_proposals_carimbo on public.contact_field_proposals;
create trigger trg_contact_field_proposals_carimbo
  before insert or update on public.contact_field_proposals
  for each row
  execute function public.fn_carimba_proposta_de_dado();

-- ---- LGPD: anonimizar o contato apaga as propostas dele ----
--
-- Sem isto, anonimizar um contato deixaria o e-mail dele VIVO dentro de uma
-- proposta pendente — PII sobrevivendo ao direito de esquecimento numa tabela
-- que ninguém lembraria de olhar.
--
-- ⚠️ TRIGGER NO ESTADO, não chamada dentro do cascade — e a escolha importa.
-- Há mais de um caminho que anonimiza: `fn_lgpd_cascade_redact_contact` (o
-- cascade completo) e `/api/v1/lgpd/anonymize` (a rota direta), e amanhã pode
-- haver um DBA fazendo à mão. Pendurar a limpeza em UM deles deixaria os outros
-- vazando; pendurar no FATO (`is_anonymized` virou true) cobre todos, inclusive
-- os que ainda não existem. É também a diferença entre editar uma função de 180
-- linhas vinda de dump — com o risco que isso traz — e acrescentar 10.
--
-- As propostas são APAGADAS, não redigidas: diferente da timeline, aqui não há
-- histórico a preservar (proposta não decidida nunca virou fato) e o conteúdo é
-- integralmente dado pessoal.
create or replace function public.fn_apaga_propostas_de_contato_anonimizado()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
begin
  delete from public.contact_field_proposals where contact_id = new.id;
  return new;
end$$;

revoke all on function public.fn_apaga_propostas_de_contato_anonimizado() from public;
revoke execute on function public.fn_apaga_propostas_de_contato_anonimizado() from anon;
revoke execute on function public.fn_apaga_propostas_de_contato_anonimizado() from authenticated;

drop trigger if exists trg_contacts_anonimizado_limpa_propostas on public.contacts;
create trigger trg_contacts_anonimizado_limpa_propostas
  after update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized = true and coalesce(old.is_anonymized, false) = false)
  execute function public.fn_apaga_propostas_de_contato_anonimizado();


-- ---- escopo de funil do agente (migration 0125) ----
-- O agente só ESCREVE nos funis marcados; vazio = NENHUM (falha fechada).
-- Medido: uma organização com 4 funis e 5 agentes de negócios diferentes, todos
-- alcançando todos. A coluna vive na VERSÃO para a permissão subir junto com o
-- resto quando alguém publica — escopo fora do ciclo rascunho→publicar muda o
-- alcance do agente sem ninguém ter publicado nada.
--
-- Traz junto o conserto do trigger de imutabilidade, que parava no `followup` e
-- ignorava as NOVE colunas posteriores: sem isso, um escopo de PERMISSÃO seria
-- editável numa versão publicada sem virar versão nova — a própria ausência de
-- escopo, com aparência de controle. Racional completo na migration.

alter table public.ai_agent_versions
  add column if not exists pipeline_ids uuid[] not null default '{}'::uuid[];

comment on column public.ai_agent_versions.pipeline_ids is
  'Funis em que ESTE agente pode escrever (mover, editar, encerrar, taguear). Vazio = NENHUM: falha fechada. Escopo de ESCRITA; leitura não é filtrada por aqui (declarado na spec 17 §5).';

-- ---- backfill: o que JÁ funcionava continua funcionando ----
--
-- "Agente novo nasce fechado" e "agente existente vira fechado retroativamente"
-- são coisas MUITO diferentes. Sem este bloco, no dia do deploy todo agente em
-- produção pararia de mexer em card — de uma vez, e em silêncio.
--
-- O escopo inicial é DERIVADO do que cada agente realmente fez: os funis onde
-- ele já registrou atividade. Isso respeita o que funcionava E fecha os funis
-- que ele nunca tocou, que é o objetivo.
--
-- Medido antes de escrever: na produção deste projeto, apenas 1 dos 8 agentes
-- tem histórico (o SDR, no funil "Pedidos"). Os outros 7 nascem fechados sem
-- quebrar nada, porque nunca moveram card nenhum.
--
-- Só para versões PUBLICADAS/rascunho que ainda estão vazias — re-aplicar não
-- reabre escopo que alguém tenha fechado à mão depois.
update public.ai_agent_versions v
   set pipeline_ids = sub.funis
  from (
    select a.actor_agent_id as agent_id,
           array_agg(distinct l.pipeline_id) as funis
      from public.crm_lead_activities a
      join public.crm_leads l on l.id = a.lead_id
     where a.actor_agent_id is not null
     group by a.actor_agent_id
  ) sub
 where v.agent_id = sub.agent_id
   and v.pipeline_ids = '{}'::uuid[];

-- ---- o trigger de imutabilidade para de ignorar metade da configuração ----
--
-- ⚠️ CONSERTO OBRIGATÓRIO NO MESMO ARQUIVO, e não uma limpeza de brinde.
--
-- `fn_ai_agent_version_content_immutable` parava no campo `followup` e não
-- conhecia NENHUMA das nove colunas acrescentadas depois dele. Numa versão já
-- PUBLICADA era possível trocar o modelo do Operador, as ferramentas dele, o
-- corte de mensagens — sem virar versão nova e sem deixar trilha.
--
-- Acrescentar `pipeline_ids` sem consertar isso seria pior que não acrescentar:
-- um escopo de PERMISSÃO editável em produção sem publicar nada é a própria
-- ausência de escopo, com aparência de controle.
create or replace function fn_ai_agent_version_content_immutable() returns trigger
language plpgsql as $fn$
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
    -- ↓ as nove que o trigger nunca cobriu, mais a desta migration
    or new.multimodal_input       is distinct from old.multimodal_input
    or new.video_frames_enabled   is distinct from old.video_frames_enabled
    or new.split_messages         is distinct from old.split_messages
    or new.split_max_chars        is distinct from old.split_max_chars
    or new.cases_enabled          is distinct from old.cases_enabled
    or new.operator_enabled       is distinct from old.operator_enabled
    or new.operator_model         is distinct from old.operator_model
    or new.operator_tool_ids      is distinct from old.operator_tool_ids
    or new.pipeline_ids           is distinct from old.pipeline_ids
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

-- ---- camadas de segurança por organização (migration 0142) ----
--
-- As duas verificações que consultam um modelo (e por isso custam por mensagem)
-- passam a ser escolha da organização, na tela do agente, em vez de variável de
-- ambiente do worker — que é por PROCESSO e só alcançável por quem edita o .env
-- da VPS e reinicia o contêiner.
--
-- AUSÊNCIA DE LINHA NÃO É "DESLIGADO": sem linha, vale o ambiente. É o que
-- mantém intacta a instalação que já decidiu isso no .env — aplicar este bloco
-- não muda o comportamento de ninguém, só cria a porta.
--
-- `layer` sem CHECK, de propósito (vocabulário ABERTO, CLAUDE.md): um clone com
-- valor que este build não conhece quebraria o update.sh. O vocabulário vive no
-- TypeScript.
--
-- Idempotente e auto-curativo: `create table if not exists` + `drop policy if
-- exists` antes do `create policy`.
--
-- TABELA NOVA NASCE CONCEDIDA, e não só função: o `ALTER DEFAULT PRIVILEGES ...
-- GRANT ALL ON TABLES TO anon/authenticated` deste mesmo baseline vale para toda
-- tabela criada depois dele. A primeira versão deste bloco dizia "nenhuma função
-- nova, então não há grant a revogar" — leitura errada da doutrina, que fala de
-- FUNÇÃO. O efeito medido está no cabeçalho da migration 0142.

create table if not exists public.org_guardrail_layers (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  layer text not null,
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  primary key (organization_id, layer)
);

alter table public.org_guardrail_layers enable row level security;

-- ---- escrita de guardrail exige admin (migration 0143) ----
--
-- Leitura org-flat, escrita com gate de PAPEL no banco (forma canônica do repo:
-- ver `crm_stages_select` / `crm_stages_manager_write` acima). O `admin` da rota
-- não é fronteira — com a anon key e o próprio JWT, um `viewer` desligava a camada
-- anti-jailbreak da organização pelo PostgREST, sem auditoria. Medido: UPDATE 1 +
-- INSERT 1 num pg17 do zero.
--
-- Auto-curativo: derruba a policy da 0142 por nome antes de criar as duas novas,
-- então o `update.sh` de um clone que parou na 0142 fica correto sem passo manual.
drop policy if exists tenant_isolation_org_guardrail_layers_all on public.org_guardrail_layers;
drop policy if exists org_guardrail_layers_select on public.org_guardrail_layers;
drop policy if exists org_guardrail_layers_admin_write on public.org_guardrail_layers;

create policy org_guardrail_layers_select on public.org_guardrail_layers
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

create policy org_guardrail_layers_admin_write on public.org_guardrail_layers
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'admin'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'admin'))
  );

revoke all on public.org_guardrail_layers from anon;

-- ---- plano de tempo do follow-up (migration 0144) ----
--
-- O modo "Adaptativo (min–max)" do nó de espera existia na tela e não existia no
-- motor: o fluxo esperava SEMPRE o máximo. Esta coluna guarda o plano decidido
-- uma vez no acionamento, para todas as esperas adaptativas de uma vez.
--
-- Sem CHECK e sem NOT NULL de propósito: `null` é "ainda não planejado" e também
-- o estado de todo enrollment anterior — os dois caem no comportamento antigo, e
-- não há dado a corrigir antes de criar a coluna. Um CHECK de shape sobre jsonb
-- quebraria o `update.sh` de um clone que já tivesse gravado algo aqui; quem
-- valida é `lib/followup/timing-plan.ts`, que degrada para o máximo diante de
-- plano ilegível em vez de derrubar o tick.

alter table followup_enrollments
  add column if not exists timing_plan jsonb;

comment on column followup_enrollments.timing_plan is
  'Plano de tempo das esperas adaptativas, decidido uma vez no acionamento do fluxo. null = sem plano (cai no max_ms de cada espera). Ver lib/followup/timing-plan.ts.';

notify pgrst, 'reload schema';

-- ---- o tick do follow-up para de servir uma organização de cada vez (migration 0146) ----
--
-- O claim levava os 20 vencidos MAIS ANTIGOS globalmente. Quem acumulou fila
-- tem, por construção, os mais antigos — então uma organização atrasada ocupa o
-- lote inteiro. Medido em pg17 descartável, teto 20: com 25 vencidos na grande e
-- 1 na pequena, o tick 1 leva 20 da grande e ZERO da pequena; com 300 na grande,
-- a pequena só é atendida no TICK 16 (≈16 min, com o cron de minuto em minuto).
-- Não é inanição eterna — o lease empurra o ponteiro e ela entra em teto(K/20)
-- ticks — mas o atraso não tem limite superior e cresce com a fila do vizinho.
--
-- Passa a ser rodízio: o mais antigo de CADA organização, depois o segundo de
-- cada. Com UMA organização o resultado é idêntico ao de antes (os 20 mais
-- antigos, na mesma ordem), então a instalação de operador único não muda.
--
-- O `limit p_limit` dentro do lateral faz o custo depender do número de
-- organizações com fila, não do tamanho da fila. E `for update skip locked` vira
-- CTE própria porque o Postgres não o aceita junto de window function.
--
-- Só isso NÃO preserva "dois workers nunca pegam a mesma linha": as duas conexões
-- materializam a MESMA lista de candidatos antes de qualquer lock existir, e a
-- segunda, ao esperar o lock da primeira, reavalia apenas o WHERE do UPDATE
-- (READ COMMITTED). Medido: interseção de 5 em 5 no invariante de concorrência.
-- Por isso a condição de lease está REPETIDA no WHERE do UPDATE — é ela que faz
-- a segunda conexão enxergar o lease recém-gravado e desistir da linha.

create index if not exists idx_followup_enrollments_due_por_org
  on followup_enrollments (organization_id, next_eval_at)
  where status in ('active','waiting_reply');

create or replace function fn_claim_due_followup_enrollments(p_limit int, p_lease_seconds int)
returns setof followup_enrollments
language sql
security definer
set search_path = public
as $$
  with orgs as (
    -- Sem a condição de claim aqui de propósito: o lateral abaixo a aplica, e uma
    -- organização cujos vencidos estão todos com lease apenas devolve zero linhas.
    select distinct organization_id
      from followup_enrollments
     where status in ('active','waiting_reply')
       and next_eval_at <= now()
  ),
  fila as (
    select f.id, f.next_eval_at, f.posicao_na_org
      from orgs
      cross join lateral (
        select d.id,
               d.next_eval_at,
               row_number() over (order by d.next_eval_at) as posicao_na_org
          from followup_enrollments d
         where d.organization_id = orgs.organization_id
           and d.status in ('active','waiting_reply')
           and d.next_eval_at <= now()
           and (d.claimed_until is null or d.claimed_until < now())
         order by d.next_eval_at
         limit p_limit
      ) f
  ),
  escolhidos as (
    -- O rodízio: posição 1 de todas as organizações, depois a 2 de todas, etc.
    -- Empate na mesma posição vai para quem esperou mais.
    select id from fila order by posicao_na_org, next_eval_at limit p_limit
  ),
  travados as (
    select e.id from followup_enrollments e
     where e.id in (select id from escolhidos)
     for update skip locked
  )
  update followup_enrollments e
     set claimed_until = now() + make_interval(secs => p_lease_seconds),
         updated_at = now()
   where e.id in (select id from travados)
     -- A condição de lease É REPETIDA AQUI, e não é redundante com a CTE `fila`.
     -- Sem ela, duas conexões simultâneas reclamam as MESMAS linhas: a segunda
     -- espera o lock da primeira, e quando ele sai o Postgres (READ COMMITTED)
     -- reavalia só o WHERE do UPDATE — que não olhava `claimed_until` — e grava
     -- por cima. O `skip locked` da CTE não salva: as duas materializam a mesma
     -- lista antes de qualquer lock existir. Medido: interseção de 5 em 5 no
     -- invariante de concorrência (followup-schema.test.ts).
     and (e.claimed_until is null or e.claimed_until < now())
  returning e.*;
$$;

revoke execute on function fn_claim_due_followup_enrollments(int, int) from public, anon, authenticated;
-- ---- o dossiê do follow-up: tempo escolhido pela IA + pausa manual (migration 0145) ----
--
-- Ver o cabeçalho de `supabase/migrations/20260810120000_0145_dossie_do_followup.sql`
-- para o porquê de cada peça. Aqui vale a nota de re-aplicação: tudo é
-- auto-curativo. O CHECK só ACRESCENTA um valor ao conjunto aceito e o predicado
-- novo do índice cobre as mesmas linhas do antigo (nenhum banco tem
-- `paused_manual` antes desta migration) — nada a deduplicar antes.

-- A coluna `timing_plan` NÃO é recriada aqui: ela pertence ao apêndice da
-- migration 0144 (acima). Duas criações da mesma coluna são idempotentes, mas os
-- dois `comment on column` competem e o último vence — duplicação com dois donos
-- e nenhuma fonte da verdade. Resolvido na integração: 0144 cria e descreve; 0145
-- consome.

-- Os dois CHECKs saem pelo CATÁLOGO, não pelo nome: num clone que passou por
-- dump/restore o nome gerado pode não ser o deste repo, e dropar por nome fixo
-- falharia em silêncio — o `add constraint` tropeçaria no duplicado, o
-- `exception when duplicate_object` engoliria, e o banco ficaria com o CHECK
-- ANTIGO recusando `paused_manual` num INSERT que a aplicação considera válido.
do $$
declare
  c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
     where ns.nspname = 'public'
       and rel.relname = 'followup_enrollments'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) like '%paused_handoff%'
       and pg_get_constraintdef(con.oid) not like '%paused_manual%'
  loop
    execute format('alter table public.followup_enrollments drop constraint %I', c.conname);
  end loop;
end $$;

do $$ begin
  alter table public.followup_enrollments
    add constraint followup_enrollments_status_valido
    check (status in ('active','waiting_reply','paused_handoff','paused_manual','completed','cancelled','dead'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.followup_enrollments
    add constraint followup_enrollments_relogio_coerente
    check (
      (status in ('active','waiting_reply') and next_eval_at is not null)
      or (status in ('paused_handoff','paused_manual','completed','cancelled','dead'))
    );
exception when duplicate_object then null; end $$;

-- ⚠️ AS COLUNAS SÃO (organization_id, contact_id), NÃO (pointer_id, contact_id).
--
-- A DDL original da tabela (bem acima neste arquivo) cria este índice por
-- `pointer_id`; o apêndice da migration 0062 o DERRUBA e recria por
-- `organization_id`, e é essa a definição em vigor: **um follow-up vivo por lead
-- na organização inteira**, não um por fluxo. É o guard anti-empilhamento — sem
-- ele o mesmo contato entra em N sequências ao mesmo tempo e leva N mensagens,
-- que é o bug de spam que a doutrina anti-banimento existe para impedir. O
-- `silence-sweep.ts` e o produtor do gatilho de etapa dependem dele: os dois
-- tratam o `23505` como skip silencioso, e é ele que garante que não há laço.
--
-- Quem precisa MEXER no predicado (como aqui, para incluir `paused_manual`) tem
-- de copiar a definição EM VIGOR, não a da DDL original — recriar a partir da
-- linha errada reverte a garantia sem conflito de merge e sem sintoma imediato.
-- Corrigido na integração; ver a nota no MANIFEST da 0145.
drop index if exists idx_followup_enrollments_one_live;
create unique index if not exists idx_followup_enrollments_one_live
  on public.followup_enrollments (organization_id, contact_id)
  where status in ('active','waiting_reply','paused_handoff','paused_manual');

create index if not exists idx_followup_events_enrollment_tempo
  on public.followup_enrollment_events (enrollment_id, created_at);

notify pgrst, 'reload schema';

-- ⚠️ ESTE BLOCO FICA ACIMA DA VARREDURA DE ANON DE PROPÓSITO, e a posição é
-- parte do conserto. O corpo do baseline traz um `alter default privileges …
-- grant all on functions to anon`, então TODA função nova nasce alcançável
-- pela chave anônima — que vai para o browser. O bloco de varredura no fim do
-- arquivo cura isso, mas só para o que veio ANTES dele: um apêndice colocado
-- depois fica exposto COM os `revoke` escritos e parecendo corretos. Defesa
-- certa na ordem errada é exposição com gate verde.
-- Vigiado por `tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts`.

-- ---- relógio do banco para o agendamento do follow-up (migration 0147) ----
-- Quem AGENDA gravava `next_eval_at` com o relógio do PROCESSO; quem RECLAMA
-- compara com `now()` do POSTGRES. Medido: o banco fica 17–34 ms atrás, então o
-- "agora" do processo ainda é FUTURO para o claim — o tick seguinte não reclama
-- e o enrollment espera o tick DEPOIS (até 60 s, cron de minuto em minuto).
-- Corrigir por margem seria número mágico que envelhece; a correção é os dois
-- lados usarem o mesmo relógio.
--
-- ADITIVO E RETROCOMPATÍVEL: `default` só age na AUSÊNCIA da coluna, então todo
-- insert que já passa `next_eval_at` explicitamente continua idêntico. Nada a
-- corrigir nos dados antes — não há constraint nova.
--
-- O QUE O DEFAULT CUSTA, decidido e não descoberto depois: hoje inserir um
-- enrollment ativo SEM `next_eval_at` falha ALTO (o CHECK recusa); com o
-- default, esquecer o campo passa a ser SILENCIOSO e significa "vencido agora".
-- Troca de falha barulhenta por plausível — aceita porque os dois produtores de
-- nascimento significam "agora", quem quiser outro instante continua passando
-- valor explícito, e a regra está escrita no `comment on column` abaixo.
alter table public.followup_enrollments
  alter column next_eval_at set default now();

comment on column public.followup_enrollments.next_eval_at is
  'Quando este enrollment vence. DEFAULT now() do BANCO (migration 0147): quem agenda "para agora" deve OMITIR a coluna, porque o claim compara com now() do Postgres e o relógio do processo fica milissegundos à frente — o suficiente para o enrollment perder um tick inteiro (60s). Agendamento para o FUTURO continua passando valor explícito.';

-- Para o caso em que `default` não alcança: UPDATE. O supabase-js grava VALOR,
-- nunca EXPRESSÃO, e o PostgREST só expõe tabela e função — sem isto o worker
-- agendaria com o relógio do próprio processo.
create or replace function public.fn_agora()
returns timestamptz
language sql
stable
set search_path to 'public', 'pg_temp'
as $fn$
  select now()
$fn$;

comment on function public.fn_agora() is
  'O relógio do BANCO, para quem precisa gravar um instante que será comparado com now() (migration 0147).';

-- AS DUAS ORIGENS DE EXECUTE (CLAUDE.md, doutrina de migrations, item 9): o
-- grant direto a anon do `alter default privileges` do baseline, que
-- `revoke from public` não remove; e o grant a PUBLIC que o Postgres dá na
-- criação, que `revoke from anon` não remove.
revoke all     on function public.fn_agora() from public;
revoke execute on function public.fn_agora() from anon, authenticated;
grant  execute on function public.fn_agora() to service_role;

-- ---- o caso anuncia abertura e fechamento no barramento (migration 0148) ----
--
-- `agent_cases` é a entidade de escalação e não emitia nada no `event_log`, então
-- nenhum consumidor podia reagir a um caso. TRIGGER e não emissor em código porque
-- o FECHAMENTO tem cinco escritores: caçar emissor deixa a garantia dependendo de
-- alguém lembrar, e o próximo caminho nasce mudo. SQL puro, sem I/O externo — a
-- proibição da doutrina é HTTP dentro da transação, e `fn_emit_conversation_routing`
-- já usa este mesmo mecanismo. Idempotente: `create or replace` + `drop trigger if
-- exists`, então o `update.sh` de um clone re-aplica sem efeito duplo.
create or replace function public.fn_emit_agent_case_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contact_id uuid;
  v_tipo text;
begin
  v_tipo := case when tg_op = 'INSERT' then 'ai.case_opened' else 'ai.case_closed' end;

  -- O contato viaja no PAYLOAD porque ele sempre existe por schema
  -- (`agent_cases.conversation_id` é not null e `conversations.contact_id` é
  -- not null) e porque poupa o consumidor de uma ida ao banco. O consumidor
  -- mantém o fallback de buscar, para não confiar em convenção.
  select c.contact_id into v_contact_id
    from public.conversations c
   where c.id = new.conversation_id;

  perform public.emit_event(
    v_tipo,
    'agent_case',
    new.id,
    jsonb_build_object(
      'case_id',         new.id,
      'conversation_id', new.conversation_id,
      'contact_id',      v_contact_id,
      'lead_id',         new.lead_id,
      'agent_id',        new.agent_id,
      'source',          new.source,
      'status',          new.status
    ),
    '{}'::jsonb,
    new.organization_id   -- SEMPRE de `new`, nunca de parâmetro: é o filtro de tenant
  );
  return null;            -- AFTER trigger: o retorno é ignorado
end;
$$;

alter function public.fn_emit_agent_case_event() owner to postgres;

-- ⚠️ AS DUAS ORIGENS DE EXECUTE (doutrina de migrations, item 9). Tratar só uma
-- deixa a função exposta com o gate verde: (A) o grant a PUBLIC que o Postgres
-- dá a qualquer função ao criá-la, que `revoke from anon` não remove; (B) o
-- `alter default privileges ... to anon` do baseline, que vale para toda função
-- criada depois dele e que `revoke from public` não remove.
revoke all     on function public.fn_emit_agent_case_event() from public;
revoke execute on function public.fn_emit_agent_case_event() from anon, authenticated;

-- ABERTURA: só os dois status que o código considera aberto
-- (`OPEN_STATUSES` em lib/agent-engine/agent/human-cases.ts:75).
drop trigger if exists trg_agent_case_opened on public.agent_cases;
create trigger trg_agent_case_opened
  after insert on public.agent_cases
  for each row
  when (new.status in ('awaiting_human','awaiting_lead'))
  execute function public.fn_emit_agent_case_event();

-- FECHAMENTO: os três status terminais. `escalated` entra porque o caso deixou
-- de esperar o cliente — seguir cobrando quem já foi passado adiante é o mesmo
-- defeito de cobrar quem já foi resolvido.
drop trigger if exists trg_agent_case_closed on public.agent_cases;
create trigger trg_agent_case_closed
  after update of status on public.agent_cases
  for each row
  when (old.status is distinct from new.status
        and new.status in ('resolved','escalated','cancelled'))
  execute function public.fn_emit_agent_case_event();

notify pgrst, 'reload schema';



-- ---- definer valida a organização de quem chamou (migration 0149) ----
--
-- Relatório de segurança da comunidade, auditando a tag v1.0.0. A metade sobre
-- ACL ("definer executáveis por anon") já estava fechada pela 0108/0116 — 0 de
-- 31 hoje. Mas ACL e MEMBERSHIP são defeitos independentes: `emit_event` e
-- `retrieve_top_k_chunks` continuavam usando o `p_organization_id` do ARGUMENTO
-- como único filtro de tenant, e ambas são (corretamente) executáveis por
-- `authenticated`.
--
-- Medido num pg17 com este baseline, usuário papel `viewer` membro só da org A,
-- rodando como role `authenticated` com o `sub` dele em request.jwt.claims:
--
--   INSERT direto em event_log da org B  -> permission denied   (a RLS vale)
--   SELECT direto em ai_chunks da org B  -> 0 linhas            (a RLS vale)
--   emit_event(..., org => B)            -> GRAVOU na org B     ← furo
--   retrieve_top_k_chunks(B, kbv)        -> devolveu o conteúdo ← furo
--
-- Depois deste bloco, os dois furos devolvem `caller_not_authorized_for_org`, e
-- os dois controles positivos seguem verdes: emitir na PRÓPRIA org funciona, e
-- o worker com `service_role` (sem JWT, auth.uid() null) funciona.
--
-- `fn_log_event` delega a `emit_event` e herda o guard — não ganha cópia da regra.
create or replace function public.emit_event(
  p_event_type text,
  p_entity_kind text,
  p_entity_id uuid,
  p_payload jsonb default '{}'::jsonb,
  p_metadata jsonb default '{}'::jsonb,
  p_organization_id uuid default null
) returns uuid
  language plpgsql security definer
  set search_path to 'public'
as $$
declare
  v_org_id uuid;
  v_event_id uuid;
begin
  v_org_id := p_organization_id;
  if v_org_id is null then
    select organization_id into v_org_id
      from public.user_organizations
      where user_id = auth.uid() and revoked_at is null
      limit 1;
  end if;
  if v_org_id is null then
    raise exception 'emit_event: organization_id obrigatorio';
  end if;

  if auth.uid() is not null
     and not public.fn_role_at_least(v_org_id, 'viewer') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'emit_event: caller must be an active member of the organization';
  end if;

  insert into public.event_log
    (organization_id, event_type, entity_kind, entity_id, payload, metadata)
  values
    (v_org_id, p_event_type, p_entity_kind, p_entity_id,
     coalesce(p_payload, '{}'::jsonb),
     coalesce(p_metadata, '{}'::jsonb)
       || jsonb_build_object('emitted_at', extract(epoch from now())))
  returning id into v_event_id;

  return v_event_id;
end $$;

-- Os nomes de parâmetro e das colunas de retorno abaixo são os que estão no
-- banco (`p_embedding`, `p_threshold` default 0.40, coluna `knowledge_source_id`):
-- `create or replace` recusa renomear qualquer um dos dois, e um clone que
-- receba nomes diferentes ganharia uma SOBRECARGA nova, deixando a versão sem
-- guard viva. O `do $$` no fim deste bloco avisa se isso acontecer.
create or replace function public.retrieve_top_k_chunks(
  p_organization_id uuid,
  p_kb_version_id uuid,
  p_embedding public.vector,
  p_k integer default 5,
  p_threshold real default 0.40
) returns table (
  chunk_id uuid,
  knowledge_source_id uuid,
  content text,
  similarity real,
  metadata jsonb
)
  language plpgsql stable security definer
  set search_path to 'public'
as $$
begin
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'viewer') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'retrieve_top_k_chunks: caller must be an active member of the organization';
  end if;

  return query
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
end $$;

revoke execute on function public.emit_event(text, text, uuid, jsonb, jsonb, uuid) from public, anon;
grant  execute on function public.emit_event(text, text, uuid, jsonb, jsonb, uuid) to authenticated, service_role;

revoke execute on function public.retrieve_top_k_chunks(uuid, uuid, public.vector, integer, real) from public, anon;
grant  execute on function public.retrieve_top_k_chunks(uuid, uuid, public.vector, integer, real) to authenticated, service_role;

do $$
declare
  v_extra text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into v_extra
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'retrieve_top_k_chunks'
     and p.oid::regprocedure::text <> 'retrieve_top_k_chunks(uuid,uuid,vector,integer,real)';
  if v_extra is not null then
    raise warning '0149: sobrecarga inesperada de retrieve_top_k_chunks sem o guard de membership: %', v_extra;
  end if;
end $$;

notify pgrst, 'reload schema';



-- ---- RBAC na configuração de IA e canais (migration 0150) ----
--
-- Segundo achado do relatório de segurança da comunidade, e o mais consistente
-- dele. Medido no baseline da main: das 82 policies `ALL` de `public`, **71**
-- não citam `fn_role_at_least` — só tenancy, via `fn_user_org_ids()`, que
-- devolve organizações e nada mais. `authenticated` tem
-- SELECT/INSERT/UPDATE/DELETE nessas tabelas.
--
-- Isso importa porque o `requireRole()` das rotas Next NÃO é a única porta: o
-- PostgREST do Supabase é exposto ao browser por construção (a `anon key` e a
-- URL vão no bundle), e um usuário logado fala com ele DIRETO, com o próprio
-- JWT. Provado num pg17 com este baseline, membro papel `viewer`, rodando como
-- role `authenticated` com o `sub` dele: derrubou `channel_sessions` (o canal de
-- WhatsApp), reescreveu `ai_agents.system_prompt` (o texto que o bot fala com
-- cliente real), subiu `ai_budgets.monthly_limit_cents` de 5.000 para
-- 99.999.999 e DELETOU a linha de `ai_provider_credentials` (mata a IA da org).
-- Controle no mesmo probe: o viewer NÃO alcança a organização vizinha — a
-- tenancy vale, o que falta é o papel.
--
-- ESCOPO DELIBERADO: só as tabelas de CONFIGURAÇÃO de IA e canais, onde o dano
-- é inequívoco e onde a rota Next já exige `admin` hoje (channel-sessions
-- route.ts:61, ai/agents route.ts:67, ai/budget route.ts:46) — a policy passa a
-- espelhar a API, em vez de ficar três níveis mais frouxa que ela. As outras ~63
-- ficam para depois, de propósito: `job_queue`, `llm_calls`, `send_ledger`,
-- `metrics` e afins são escritas pelo motor, e apertá-las no mesmo fôlego
-- trocaria um furo de segurança por uma parada de produção. O gate que impede a
-- lista de crescer vem em `tests/invariants/rbac-config-ia-canais.test.ts`.
--
-- FORMA: cada tabela vira PAR — SELECT só-tenancy (todo membro continua LENDO,
-- inclusive o viewer, senão a tela quebra) + escrita com `fn_role_at_least`.
-- Onde a policy atual tem `or fn_is_platform_admin()`, o par PRESERVA os dois
-- lados: sem isso o super-admin de plataforma perde acesso e o suporte cega.
--
-- O worker não entra nesta conta: usa `service_role`, que é `bypassrls`.

-- ---- canais ----
drop policy if exists channel_sessions_tenant_isolation_all on public.channel_sessions;

drop policy if exists channel_sessions_tenant_select on public.channel_sessions;
create policy channel_sessions_tenant_select on public.channel_sessions
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );

drop policy if exists channel_sessions_tenant_write on public.channel_sessions;
create policy channel_sessions_tenant_write on public.channel_sessions
  for all using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin()
  );

-- ---- agentes de IA ----
drop policy if exists tenant_isolation_ai_agents_all on public.ai_agents;

drop policy if exists tenant_isolation_ai_agents_select on public.ai_agents;
create policy tenant_isolation_ai_agents_select on public.ai_agents
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );

drop policy if exists tenant_isolation_ai_agents_write on public.ai_agents;
create policy tenant_isolation_ai_agents_write on public.ai_agents
  for all using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin()
  );

-- ---- versões de agente ----
drop policy if exists tenant_isolation_ai_agent_versions_all on public.ai_agent_versions;

drop policy if exists tenant_isolation_ai_agent_versions_select on public.ai_agent_versions;
create policy tenant_isolation_ai_agent_versions_select on public.ai_agent_versions
  for select using (organization_id in (select public.fn_user_org_ids()));

drop policy if exists tenant_isolation_ai_agent_versions_write on public.ai_agent_versions;
create policy tenant_isolation_ai_agent_versions_write on public.ai_agent_versions
  for all using (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  ) with check (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  );

-- ---- orçamento de IA ----
drop policy if exists tenant_isolation_ai_budgets_all on public.ai_budgets;

drop policy if exists tenant_isolation_ai_budgets_select on public.ai_budgets;
create policy tenant_isolation_ai_budgets_select on public.ai_budgets
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );

drop policy if exists tenant_isolation_ai_budgets_write on public.ai_budgets;
create policy tenant_isolation_ai_budgets_write on public.ai_budgets
  for all using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin()
  );

-- ---- roteadores de IA ----
drop policy if exists tenant_isolation_ai_routers_all on public.ai_routers;

drop policy if exists tenant_isolation_ai_routers_select on public.ai_routers;
create policy tenant_isolation_ai_routers_select on public.ai_routers
  for select using (organization_id in (select public.fn_user_org_ids()));

drop policy if exists tenant_isolation_ai_routers_write on public.ai_routers;
create policy tenant_isolation_ai_routers_write on public.ai_routers
  for all using (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  ) with check (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  );

drop policy if exists tenant_isolation_ai_router_members_all on public.ai_router_members;

drop policy if exists tenant_isolation_ai_router_members_select on public.ai_router_members;
create policy tenant_isolation_ai_router_members_select on public.ai_router_members
  for select using (organization_id in (select public.fn_user_org_ids()));

drop policy if exists tenant_isolation_ai_router_members_write on public.ai_router_members;
create policy tenant_isolation_ai_router_members_write on public.ai_router_members
  for all using (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  ) with check (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  );

drop policy if exists tenant_isolation_ai_purpose_bindings_all on public.ai_purpose_bindings;

drop policy if exists tenant_isolation_ai_purpose_bindings_select on public.ai_purpose_bindings;
create policy tenant_isolation_ai_purpose_bindings_select on public.ai_purpose_bindings
  for select using (organization_id in (select public.fn_user_org_ids()));

drop policy if exists tenant_isolation_ai_purpose_bindings_write on public.ai_purpose_bindings;
create policy tenant_isolation_ai_purpose_bindings_write on public.ai_purpose_bindings
  for all using (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  ) with check (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  );

-- ---- credenciais de provedor de IA: remover a superfície, não negociá-la ----
--
-- Aqui a policy não é o remédio suficiente. NENHUM caminho de browser precisa
-- desta tabela: o servidor lê as colunas cifradas com `service_role`
-- (lib/ai/credentials.ts, lib/ai/gateway-binding.ts) e a TELA já consome a view
-- `ai_provider_credentials_safe`, que existe justamente para não expor
-- `api_key_encrypted`/`iv`/`tag`. Então o SELECT de `authenticated` sai inteiro
-- em vez de continuar ali sob a promessa de que o ciphertext basta.
--
-- (O ciphertext DE FATO protege a chave — é AES com iv+tag, e um viewer leria
-- bytes inúteis. O que ele não protege é o resto: `provider`, `label`,
-- `api_key_last4`, `validation_error`. E, sobretudo, a linha continuava
-- DELETÁVEL, que é o dano real.)
drop policy if exists tenant_isolation_ai_provider_credentials_select on public.ai_provider_credentials;
drop policy if exists tenant_isolation_ai_provider_credentials_modify on public.ai_provider_credentials;

drop policy if exists tenant_isolation_ai_provider_credentials_write on public.ai_provider_credentials;
create policy tenant_isolation_ai_provider_credentials_write on public.ai_provider_credentials
  for all using (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  ) with check (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  );

-- O SELECT sai por COLUNA, não pela tabela inteira, e a razão é a view:
-- `ai_provider_credentials_safe` é `security_invoker=true` — de propósito, para
-- que a RLS da tabela base valha para o usuário que a consulta. Revogar o SELECT
-- da tabela inteira quebraria a view (o invoker não tem privilégio para ler a
-- base) e, com ela, a tela de provedores. Torná-la `security_invoker=false` para
-- contornar isso seria trocar um furo pequeno por um grande: a RLS pararia de se
-- aplicar e a view passaria a devolver linha de qualquer organização.
--
-- Com grant por coluna, as três colunas do segredo ficam inalcançáveis pelo
-- PostgREST e a view — que só lê as outras doze — continua funcionando. Medido
-- por controle positivo em tests/invariants/rbac-config-ia-canais.test.ts: a
-- primeira versão desta migration revogava a tabela toda, e foi esse controle
-- que reprovou.
revoke select on public.ai_provider_credentials from authenticated, anon;
grant select (
  id, organization_id, provider, label, api_key_last4, validated_at,
  validation_error, models_available, is_active, created_by, created_at, updated_at
) on public.ai_provider_credentials to authenticated;
grant select on public.ai_provider_credentials_safe to authenticated;

-- O PostgREST guarda o schema em cache; sem isto as policies novas só valem no
-- próximo reload dele.
notify pgrst, 'reload schema';



-- ---- o quadro de clientes montado no onboarding (migration 0156) ----
-- O gatilho `trg_seed_default_pipeline_for_org` semeia um funil de e-commerce em
-- TODA organização, e o passo do onboarding troca esse quadro por um do ramo do
-- negócio. A troca é DELETE + INSERT das etapas, e o cliente JS não tem
-- transação: pelo cliente, um DELETE que passa e um INSERT que falha deixariam o
-- funil sem coluna nenhuma. Aqui os dois vivem na mesma transação da função.
--
-- As duas recusas, e a segunda é a silenciosa: `crm_leads_stage_id_fkey` é
-- RESTRICT (o DELETE falharia), mas `webhook_sources.default_stage_id` é
-- **CASCADE** — trocar as colunas apagaria a fonte de webhook inteira sem erro
-- nenhum. Ver o cabeçalho da 0156 para a medição que motivou o passo.
--
-- ⚠️ ESTE BLOCO FICA ACIMA DA VARREDURA DE `anon`, e não é arbitrário: o
-- `ALTER DEFAULT PRIVILEGES` do corpo do baseline faz toda função nova nascer
-- com EXECUTE para `anon`, e quem cura isso é a varredura — que só alcança o
-- que veio ANTES dela. É o que `tests/unit/varredura-anon-e-o-ultimo-bloco`
-- cobra, e foi ele que pegou este apêndice no lugar errado.

create or replace function public.fn_aplicar_quadro_do_onboarding(
  p_organization_id uuid,
  p_pipeline_id uuid,
  p_nome text,
  p_slug text,
  p_etapas jsonb
) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_negocios bigint;
  v_fontes bigint;
  v_criadas bigint;
begin
  -- O funil é DESTA organização? A função roda como `postgres` e passa por cima
  -- da RLS; o filtro de tenant é responsabilidade dela.
  perform 1 from public.crm_pipelines
   where id = p_pipeline_id and organization_id = p_organization_id;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'funil_nao_encontrado');
  end if;

  select count(*) into v_negocios
    from public.crm_leads
   where pipeline_id = p_pipeline_id
     and organization_id = p_organization_id;

  if v_negocios > 0 then
    return jsonb_build_object('ok', false, 'motivo', 'funil_com_negocios', 'quantos', v_negocios);
  end if;

  -- ON DELETE CASCADE: sem esta recusa, trocar as colunas apaga a fonte inteira.
  select count(*) into v_fontes
    from public.webhook_sources w
    join public.crm_stages s on s.id = w.default_stage_id
   where s.pipeline_id = p_pipeline_id;

  if v_fontes > 0 then
    return jsonb_build_object('ok', false, 'motivo', 'etapa_em_uso_por_webhook', 'quantos', v_fontes);
  end if;

  delete from public.crm_stages
   where pipeline_id = p_pipeline_id
     and organization_id = p_organization_id;

  insert into public.crm_stages
    (organization_id, pipeline_id, name, slug, position, is_won, is_lost, agent_stage_hint)
  select p_organization_id,
         p_pipeline_id,
         e->>'nome',
         e->>'slug',
         (e->>'position')::numeric,
         coalesce((e->>'is_won')::boolean, false),
         coalesce((e->>'is_lost')::boolean, false),
         nullif(e->>'agent_stage_hint', '')
    from jsonb_array_elements(p_etapas) as e;
  get diagnostics v_criadas = row_count;

  update public.crm_pipelines
     set name = p_nome,
         slug = p_slug,
         updated_at = now()
   where id = p_pipeline_id
     and organization_id = p_organization_id;

  return jsonb_build_object('ok', true, 'etapas', v_criadas);
end$$;

-- TRÊS origens de EXECUTE, e medi as três antes de escrever esta lista — com o
-- revoke de `public, anon` apenas, `has_function_privilege` ainda respondia
-- `authenticated, service_role`:
--
--   (A) o grant que o Postgres dá a PUBLIC ao criar qualquer função;
--   (B) `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon` (baseline);
--   (C) a irmã dela, `... TO authenticated` (baseline, linha seguinte).
--
-- Nenhum dos revokes remove os outros dois. E aqui (C) é a perigosa, não (B):
-- esta função é SECURITY DEFINER, roda como `postgres` por cima da RLS e recebe
-- `p_organization_id` como ARGUMENTO. Executável por `authenticated`, qualquer
-- usuário logado de qualquer tenant poderia reescrever o funil de OUTRA
-- organização passando o id dela — exatamente a classe de furo que a 0149
-- fechou. O invariante `hardening-definer-varredura` reprova definer volátil
-- alcançável por `authenticated` fora da allowlist, e esta não entra nela.
revoke execute on function public.fn_aplicar_quadro_do_onboarding(uuid, uuid, text, text, jsonb)
  from public, anon, authenticated;
-- Só o service role: o único chamador é a Server Action do onboarding, que já
-- resolveu a organização do cookie de sessão. Quem não precisa não recebe.
grant execute on function public.fn_aplicar_quadro_do_onboarding(uuid, uuid, text, text, jsonb)
  to service_role;

-- ---- marca por organização (migration 0157) ----
--
-- A MARCA DO CLIENTE FINAL SE GRAVA EM UMA INSTRUÇÃO SÓ.
--
-- `organizations.settings` tem três donos com gates diferentes (updateTenant =
-- admin, PATCH de atendimento = manager, régua de atrito = manager) e os três
-- fazem read-modify-write do jsonb INTEIRO, em round-trips HTTP separados. A
-- perda é medida, não deduzida: `visibility_mode` volta de 'own' para 'all' sem
-- erro em lugar nenhum — e essa chave é lida DIRETO pela RLS, dentro de
-- `fn_can_view_conversation`/`fn_can_view_lead`. Um write de COR reverteria, em
-- silêncio, uma decisão de exposição de dado de cliente. Um quarto escritor com
-- o mesmo padrão é inaceitável, então esta escrita passa por função.
--
-- Devolve `integer` (linhas afetadas) porque a única policy de escrita de
-- `organizations` é `orgs_write_platform_admin`: pelo client de sessão o UPDATE
-- de um admin de TENANT casa 0 linhas e o PostgREST responde 204 — a tela diz
-- "salvo" e nada foi gravado (issue #144). O `row_count` é o que permite ao
-- chamador distinguir os dois casos.
--
-- A autorização é REPETIDA aqui (o gate da Server Action usa o snapshot de
-- membership de `loadAuthUser`, não o banco): é o que faz a regra valer para
-- qualquer chamador futuro e o que impede escalação se o EXECUTE escapar um dia.
--
-- Idempotente e auto-curativo: `create or replace function`, revoke/grant
-- declarativos, e nenhuma constraint nova sobre dado existente — não há o que
-- deduplicar antes. Termina com `notify pgrst` próprio, como os blocos
-- vizinhos — o PostgREST guarda o schema em cache e não veria a função nova.
--
-- ⚠️ E entra ANTES do bloco da VARREDURA anon, que é de propósito o último do
-- arquivo: ela mede o privilégio EFETIVO de `authenticated`/`service_role` antes
-- de revogar e o devolve depois, então os revokes acima só sobrevivem porque
-- rodam ANTES dela. Colar no fim do arquivo — o movimento natural de quem
-- adiciona migration — desarmaria a cura para tudo que viesse depois. Vigiado
-- por `tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts`.
create or replace function public.fn_definir_marca_da_organizacao(
  p_org   uuid,
  p_actor uuid,
  p_marca jsonb
) returns integer
    language plpgsql
    volatile
    security definer
    set search_path to 'public', 'pg_temp'
as $$
declare
  v_linhas integer;
  v_hex    text;
  v_limpar boolean;
begin
  if p_org is null or p_actor is null then
    raise exception 'marca_da_organizacao_argumento_nulo'
      using errcode = '22023';
  end if;

  -- "Apague a marca" chega por DUAS formas — SQL NULL e o jsonb `'null'` — e as
  -- duas significam a mesma coisa. NÃO MEDIDO qual delas o PostgREST produz para
  -- `{"p_marca": null}`; tratar só uma deixaria a limpeza levantando 22023 num
  -- dos dois transportes.
  v_limpar := p_marca is null or jsonb_typeof(p_marca) = 'null';

  if not v_limpar and jsonb_typeof(p_marca) <> 'object' then
    raise exception 'marca_da_organizacao_forma_invalida: %', jsonb_typeof(p_marca)
      using errcode = '22023';
  end if;

  -- MESMA regex do CHECK `platform_branding_accent_hex` — que é a forma que
  -- `normalizarHex` emite. Aceitar `#FFF` criaria duas grafias da mesma cor e a
  -- pergunta "mudou?" passaria a mentir. Dentro de jsonb não cabe CHECK de
  -- coluna, então a regra é da função.
  v_hex := nullif(p_marca ->> 'accent_hex', '');
  if v_hex is not null and v_hex !~ '^#[0-9a-f]{6}$' then
    raise exception 'marca_da_organizacao_accent_hex_invalido'
      using errcode = '22023';
  end if;

  -- Papel insuficiente falha ALTO (42501) em vez de devolver 0: 0 já significa
  -- "a organização não existe", e colapsar os dois deixaria o chamador sem saber
  -- se o problema é papel ou id.
  if not exists (
       select 1 from public.user_organizations uo
        where uo.user_id = p_actor
          and uo.organization_id = p_org
          and uo.role = 'admin'
          and uo.revoked_at is null
     )
     and not exists (
       select 1 from public.platform_admins pa
        where pa.user_id = p_actor
          and pa.revoked_at is null
     )
  then
    raise exception 'marca_da_organizacao_sem_permissao'
      using errcode = '42501';
  end if;

  update public.organizations o
     set settings = case
           when v_limpar
             then coalesce(o.settings, '{}'::jsonb) - 'branding'
           else jsonb_set(coalesce(o.settings, '{}'::jsonb), '{branding}', p_marca, true)
         end
   where o.id = p_org;

  get diagnostics v_linhas = row_count;
  return v_linhas;
end;
$$;

comment on function public.fn_definir_marca_da_organizacao(uuid, uuid, jsonb) is
  'Grava organizations.settings.branding com merge ATÔMICO (jsonb_set), sem tocar nas demais chaves do jsonb (llm, routing, visibility_mode, atrito, ai_dispatch_mode, canonical_conversation_tags, lost_reasons_extra, plan). Devolve linhas afetadas: 0 = a organização não existe. Papel insuficiente levanta 42501. Chamador: app/actions/settings/updateMarcaDaOrganizacao.ts.';

-- OS DOIS REVOKES (CLAUDE.md, item 9) — origens DISTINTAS de EXECUTE, e tratar
-- só uma deixa a função exposta com o gate verde:
--   (A) `from public`  — o grant que o Postgres dá a PUBLIC ao criar qualquer
--       função; `revoke ... from anon` não o remove.
--   (B) `from anon`    — o grant DIRETO do `ALTER DEFAULT PRIVILEGES ... GRANT
--       ALL ON FUNCTIONS TO anon` (linha ~3972 deste arquivo), que vale para
--       toda função criada DEPOIS dele — isto é, para todo apêndice, que por
--       construção nasce no fim. `revoke ... from public` não o remove.
-- `from authenticated` pelo motivo de (B) e mais um: esta função é VOLÁTIL.
-- Definer volátil alcançável por qualquer usuário logado é escrita cross-tenant.
revoke execute on function public.fn_definir_marca_da_organizacao(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant  execute on function public.fn_definir_marca_da_organizacao(uuid, uuid, jsonb)
  to service_role;

notify pgrst, 'reload schema';


-- ---- logo da marca: as FUNÇÕES (migration 0158) ----
--
-- O LOGO SAI DA CAIXA DE TEXTO E VIRA ARQUIVO — a metade que cria função.
--
-- ⚠️ POR QUE A 0158 ENTRA NO APÊNDICE EM DOIS PEDAÇOS, E NÃO EM UM.
--
-- `tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts` proíbe `create function` e
-- `grant ... to anon` DEPOIS do bloco da VARREDURA anon (logo abaixo). Mas
-- `platform_branding` — a tabela que ganha a coluna `logo_path` — é criada no
-- bloco da 0155, que vem DEPOIS da varredura, no fim do arquivo. Um bloco único
-- quebraria uma das duas coisas: colado aqui, o `alter table
-- public.platform_branding` rodaria sobre tabela inexistente e o `install.sh`
-- (que usa `ON_ERROR_STOP=1`) abortaria a instalação inteira; colado no fim, as
-- duas funções abaixo nasceriam com EXECUTE para `anon` em todo clone que
-- ATUALIZA, que é o buraco que a varredura existe para fechar.
--
-- Então: FUNÇÕES aqui (antes da varredura), BUCKET e COLUNA no fim do arquivo
-- (depois da 0155). Os dois blocos são idempotentes e independentes na ordem —
-- nenhuma das funções abaixo lê `platform_branding`.
--
-- ─── Por que uma função PRÓPRIA para o logo ─────────────────────────────────
--
-- `fn_definir_marca_da_organizacao` (0157) faz `jsonb_set(settings, '{branding}',
-- p_marca)` — substitui o objeto INTEIRO. Gravar o logo por ela faria "salvar o
-- nome" apagar o logo, em silêncio, com a tela dizendo "salvo". Duas escritas
-- independentes precisam de duas funções que façam merge cada uma no seu campo.
--
-- ─── E por que a 0157 é RECRIADA aqui (forward-fix) ─────────────────────────
--
-- Pelo mesmo motivo, de volta: ela precisa PRESERVAR `logo_path` ao substituir o
-- objeto. Sem isso, a ordem natural de quem configura a marca ("sobe o logo,
-- depois troca o nome") perde o logo.
--
-- Idempotente: `create or replace function`, revokes e grants declarativos.

create or replace function public.fn_definir_logo_da_organizacao(
  p_org   uuid,
  p_actor uuid,
  p_path  text
) returns integer
    language plpgsql
    volatile
    security definer
    set search_path to 'public', 'pg_temp'
as $$
declare
  v_linhas integer;
  v_path   text;
begin
  if p_org is null or p_actor is null then
    raise exception 'logo_da_organizacao_argumento_nulo'
      using errcode = '22023';
  end if;

  v_path := nullif(btrim(coalesce(p_path, '')), '');

  -- O PREFIXO ASSEVERADO DENTRO DO BANCO — o gate que sobrevive ao segundo
  -- chamador. A rota monta o caminho a partir da organização resolvida do
  -- cookie, mas "a rota monta certo" é promessa de UM chamador. Sem esta linha,
  -- um caminho de outro escopo (o `platform/...` que qualquer pessoa lê no HTML
  -- da tela de login) entraria como logo da organização — e o delete-on-replace
  -- da rota, rodando como `service_role`, apagaria o logo da instalação inteira
  -- na troca seguinte.
  if v_path is not null
     and v_path !~ ('^' || p_org::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg)$')
  then
    raise exception 'logo_da_organizacao_caminho_fora_do_escopo'
      using errcode = '22023';
  end if;

  if not exists (
       select 1 from public.user_organizations uo
        where uo.user_id = p_actor
          and uo.organization_id = p_org
          and uo.role = 'admin'
          and uo.revoked_at is null
     )
     and not exists (
       select 1 from public.platform_admins pa
        where pa.user_id = p_actor
          and pa.revoked_at is null
     )
  then
    raise exception 'logo_da_organizacao_sem_permissao'
      using errcode = '42501';
  end if;

  -- Merge no CAMPO. `jsonb_set` direto em '{branding,logo_path}' NÃO serviria:
  -- com `branding` ausente, `create_missing` só cria a ÚLTIMA chave e o caminho
  -- intermediário faltando devolve o jsonb original intocado — silenciosamente.
  update public.organizations o
     set settings = case
           when v_path is null
             then jsonb_set(
                    coalesce(o.settings, '{}'::jsonb), '{branding}',
                    coalesce(o.settings -> 'branding', '{}'::jsonb) - 'logo_path', true)
           else jsonb_set(
                    coalesce(o.settings, '{}'::jsonb), '{branding}',
                    coalesce(o.settings -> 'branding', '{}'::jsonb)
                      || jsonb_build_object('logo_path', v_path), true)
         end
   where o.id = p_org;

  get diagnostics v_linhas = row_count;
  return v_linhas;
end;
$$;

comment on function public.fn_definir_logo_da_organizacao(uuid, uuid, text) is
  'Grava (ou apaga) organizations.settings.branding.logo_path com merge no CAMPO — não toca em app_name, accent_hex nem nas demais chaves de settings. Assevera que o caminho começa pelo proprio organization_id: caminho de outro escopo levanta 22023. Papel insuficiente levanta 42501. Devolve linhas afetadas: 0 = a organização não existe. Chamador: app/api/v1/marca/logo/route.ts.';

-- ── O FORWARD-FIX DA 0157 ───────────────────────────────────────────────────
--
-- As três linhas de `logo_path` no `case` abaixo são a razão de a 0157 aparecer
-- de novo. Sem elas, salvar nome/cor pela tela apaga o logo da organização, em
-- silêncio. Vigiado por `tests/invariants/marca-logo.test.ts`.

create or replace function public.fn_definir_marca_da_organizacao(
  p_org   uuid,
  p_actor uuid,
  p_marca jsonb
) returns integer
    language plpgsql
    volatile
    security definer
    set search_path to 'public', 'pg_temp'
as $$
declare
  v_linhas integer;
  v_hex    text;
  v_limpar boolean;
begin
  if p_org is null or p_actor is null then
    raise exception 'marca_da_organizacao_argumento_nulo'
      using errcode = '22023';
  end if;

  v_limpar := p_marca is null or jsonb_typeof(p_marca) = 'null';

  if not v_limpar and jsonb_typeof(p_marca) <> 'object' then
    raise exception 'marca_da_organizacao_forma_invalida: %', jsonb_typeof(p_marca)
      using errcode = '22023';
  end if;

  v_hex := nullif(p_marca ->> 'accent_hex', '');
  if v_hex is not null and v_hex !~ '^#[0-9a-f]{6}$' then
    raise exception 'marca_da_organizacao_accent_hex_invalido'
      using errcode = '22023';
  end if;

  if not exists (
       select 1 from public.user_organizations uo
        where uo.user_id = p_actor
          and uo.organization_id = p_org
          and uo.role = 'admin'
          and uo.revoked_at is null
     )
     and not exists (
       select 1 from public.platform_admins pa
        where pa.user_id = p_actor
          and pa.revoked_at is null
     )
  then
    raise exception 'marca_da_organizacao_sem_permissao'
      using errcode = '42501';
  end if;

  update public.organizations o
     set settings = case
           -- "Limpar" com logo gravado NÃO apaga o logo: o campo tem controle
           -- próprio na tela, e limpar nome+cor responde a OUTRA pergunta.
           when v_limpar and coalesce(o.settings #>> '{branding,logo_path}', '') = ''
             then coalesce(o.settings, '{}'::jsonb) - 'branding'
           when v_limpar
             then jsonb_set(
                    coalesce(o.settings, '{}'::jsonb), '{branding}',
                    jsonb_build_object('logo_path', o.settings #> '{branding,logo_path}'), true)
           -- `p_marca || preservado`: o lado DIREITO vence em `||`, então o
           -- `logo_path` gravado sobrevive à substituição do objeto.
           -- `jsonb_strip_nulls` SÓ no fragmento preservado — nunca em `p_marca`,
           -- cujo `app_name: null` é um valor com significado.
           else jsonb_set(
                    coalesce(o.settings, '{}'::jsonb), '{branding}',
                    p_marca || jsonb_strip_nulls(
                      jsonb_build_object('logo_path', o.settings #> '{branding,logo_path}')), true)
         end
   where o.id = p_org;

  get diagnostics v_linhas = row_count;
  return v_linhas;
end;
$$;

comment on function public.fn_definir_marca_da_organizacao(uuid, uuid, jsonb) is
  'Grava organizations.settings.branding com merge ATÔMICO (jsonb_set), sem tocar nas demais chaves do jsonb (llm, routing, visibility_mode, atrito, ai_dispatch_mode, canonical_conversation_tags, lost_reasons_extra, plan) e PRESERVANDO branding.logo_path, que tem escritor próprio (fn_definir_logo_da_organizacao, migration 0158). Devolve linhas afetadas: 0 = a organização não existe. Papel insuficiente levanta 42501. Chamador: app/actions/settings/updateMarcaDaOrganizacao.ts.';

-- OS DOIS REVOKES EM CADA FUNÇÃO (CLAUDE.md, item 9) — origens DISTINTAS de
-- EXECUTE, e tratar uma só deixa a função exposta com o gate verde:
--   (A) `from public`  — o grant que o Postgres dá a PUBLIC ao criar qualquer
--       função; `revoke ... from anon` não o remove.
--   (B) `from anon`    — o grant DIRETO do `ALTER DEFAULT PRIVILEGES ... GRANT
--       ALL ON FUNCTIONS TO anon` (linha ~3972 deste arquivo), que vale para
--       toda função criada DEPOIS dele — isto é, para todo apêndice.
-- `from authenticated` pelo motivo de (B) e mais um: as duas são VOLÁTEIS.
-- Definer volátil alcançável por qualquer usuário logado é escrita cross-tenant.
revoke execute on function public.fn_definir_logo_da_organizacao(uuid, uuid, text)
  from public, anon, authenticated;
grant  execute on function public.fn_definir_logo_da_organizacao(uuid, uuid, text)
  to service_role;

revoke execute on function public.fn_definir_marca_da_organizacao(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant  execute on function public.fn_definir_marca_da_organizacao(uuid, uuid, jsonb)
  to service_role;

notify pgrst, 'reload schema';


-- ---- gasto de IA do mês: uma régua só (migration 0159) ----
--
-- O NÚMERO EXIBIDO PASSA A SER O NÚMERO QUE DECIDE.
--
-- Antes desta função havia duas contagens de gasto no produto e elas divergiam:
--
--   * a query inline de `assertBudget` (`lib/agent-engine/edge/llm/run-model-call.ts`),
--     que soma `llm_calls` do mês corrente — é ela que barrava a chamada;
--   * `ai_budgets.current_month_consumed_cents`, que é o que a TELA mostra — um
--     contador materializado pelo gatilho `fn_update_budget_consumption`, que soma
--     `NEW.cost_cents` SEM olhar a data e nunca zera (o `runBudgetReset` jamais foi
--     agendado). O único recomputo em produção é o apêndice da 0140, que só roda
--     no `install.sh`/`update.sh` — numa instalação que não atualiza há três meses,
--     o card compara três meses de gasto contra um teto MENSAL.
--
-- Armar uma proteção contra um número que não é o número que decide é pedir para
-- a pessoa proteger-se de uma mentira. Uma régua só, e ela é esta.
--
-- `security invoker`, NÃO `definer`: a função recebe a organização por argumento
-- e não valida membership. Uma definer alcançável por `authenticated` seria
-- leitura de gasto cross-tenant. Quem a chama já tem o `organization_id` de fonte
-- confiável — o `pg.Pool` do engine (dono do schema) e o admin client via
-- PostgREST (`service_role`).
--
-- ⚠️ E POR SER INVOKER ELA DEPENDE INTEIRAMENTE DOS PRÓPRIOS REVOKES: o bloco
-- `VARREDURA anon` logo abaixo percorre só `p.prosecdef`, então ele NÃO cura
-- função invoker. São duas origens distintas de EXECUTE (CLAUDE.md, item 9):
--   (A) o grant que o Postgres dá a PUBLIC ao criar qualquer função — que
--       `revoke ... from anon` não remove;
--   (B) o grant DIRETO a anon do `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON
--       FUNCTIONS TO anon` do corpo deste arquivo (linha ~3972), que vale para
--       toda função criada depois dele (isto é, para todo apêndice) — que
--       `revoke ... from public` não remove.
-- Tratar só uma deixa a função servida como RPC pela anon key, que vai ao browser.
-- `authenticated` sai pelo motivo de (B) e mais um: é ele que carrega o JWT de
-- qualquer pessoa logada, e a organização vem por argumento.
--
-- ⚠️ E ENTRA ANTES DO BLOCO DA VARREDURA anon, que é de propósito o último do
-- arquivo. `tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts` proíbe QUALQUER
-- `create function` ancorado em início de linha depois dele, e o regex não
-- distingue definer de invoker. É a mesma dança em dois blocos que a 0158 teve de
-- fazer: a função aqui, o resto da migration no fim do arquivo.
create or replace function public.fn_gasto_de_ia_do_mes(p_org uuid)
returns numeric
  language sql
  stable
  security invoker
  set search_path to 'public', 'pg_temp'
as $$
  select coalesce(sum(cost_cents), 0)::numeric
    from public.llm_calls
   where organization_id = p_org
     and created_at >= date_trunc('month', now());
$$;

comment on function public.fn_gasto_de_ia_do_mes(uuid) is
  'Gasto de IA da organização no mês corrente, em centavos de DÓLAR (llm_calls.cost_cents vem de pricing.ts, que calcula em USD). É a ÚNICA definição de gasto do produto: o gate a chama dentro de SQL_ORCAMENTO (lib/agent-engine/edge/llm/orcamento.ts), a tela a chama por RPC e o painel de saúde por tenant a chama. O dashboard de plataforma (app/api/v1/admin/dashboard/kpis) AINDA lê ai_budgets.current_month_consumed_cents, um contador acumulado que nada zera, e por isso pode divergir — a divergência está declarada naquele arquivo e o alerta de lá nunca é critical. Query inline de sum(cost_cents) em outro lugar é uma segunda régua, e a segunda régua sempre diverge — vigiado por tests/unit/orcamento-uma-regua-de-gasto.test.ts. security invoker: recebe a organização por argumento e não valida membership, então definer aqui seria leitura cross-tenant.';

revoke execute on function public.fn_gasto_de_ia_do_mes(uuid)
  from public, anon, authenticated;
grant  execute on function public.fn_gasto_de_ia_do_mes(uuid)
  to service_role;

notify pgrst, 'reload schema';


-- ---- outbound zera unread na fila (migration 0161) ----
create or replace function public.fn_mark_conversation_message(
  p_conv uuid, p_direction text, p_preview text, p_at timestamptz
) returns void language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set
    last_message_at = p_at, last_message_preview = p_preview,
    last_inbound_at  = case when p_direction = 'inbound'  then p_at else last_inbound_at  end,
    last_outbound_at = case when p_direction = 'outbound' then p_at else last_outbound_at end,
    unread_count_for_assignee = case
      when p_direction = 'inbound'  then unread_count_for_assignee + 1
      when p_direction = 'outbound' then 0
      else unread_count_for_assignee
    end,
    updated_at = now()
  where id = p_conv;
end; $$;

comment on function public.fn_mark_conversation_message is
  'Atualiza agregados da conversa: inbound incrementa unread; outbound zera (respondido).';

-- Corrige contadores stale: inbound desde a última resposta do atendente/IA.
update public.conversations c
set unread_count_for_assignee = coalesce((
  select count(*)::integer
  from public.messages m
  where m.conversation_id = c.id
    and m.direction = 'inbound'
    and m.sent_at > coalesce(c.last_outbound_at, '-infinity'::timestamptz)
), 0)
where unread_count_for_assignee <> coalesce((
  select count(*)::integer
  from public.messages m
  where m.conversation_id = c.id
    and m.direction = 'inbound'
    and m.sent_at > coalesce(c.last_outbound_at, '-infinity'::timestamptz)
), 0);

notify pgrst, 'reload schema';

-- ---- contato: última atividade carimbada por mensagem (migration 0162) ----
-- ============================================================================
-- 0162 — Mensagem de conversa carimba `contacts.last_activity_at`.
--
-- A lista /app/contacts mostra "Última atividade" de `contacts.last_activity_at`,
-- denormalizado hoje só pelo trigger de `crm_lead_activities`. Mensagens de
-- WhatsApp/Meta/Zernio passam por `fn_mark_conversation_message` e atualizam
-- `conversations.last_message_at` — mas o contato ficava parado (— ou data velha).
--
-- O relógio do LEAD continua na lista positiva da 0079; aqui só o contato.
-- ============================================================================

create or replace function public.fn_mark_conversation_message(
  p_conv uuid, p_direction text, p_preview text, p_at timestamptz
) returns void language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set
    last_message_at = p_at, last_message_preview = p_preview,
    last_inbound_at  = case when p_direction = 'inbound'  then p_at else last_inbound_at  end,
    last_outbound_at = case when p_direction = 'outbound' then p_at else last_outbound_at end,
    unread_count_for_assignee = case
      when p_direction = 'inbound'  then unread_count_for_assignee + 1
      when p_direction = 'outbound' then 0
      else unread_count_for_assignee
    end,
    updated_at = now()
  where id = p_conv;

  update public.contacts c
     set last_activity_at = greatest(coalesce(c.last_activity_at, '-infinity'::timestamptz), p_at)
    from public.conversations v
   where v.id = p_conv
     and c.id = v.contact_id;
end; $$;

comment on function public.fn_mark_conversation_message is
  'Atualiza agregados da conversa (inbound incrementa unread; outbound zera) e carimba contacts.last_activity_at.';

-- Contatos que já conversaram mas nunca tiveram atividade de lead.
update public.contacts c
   set last_activity_at = sub.max_at
  from (
    select contact_id, max(last_message_at) as max_at
      from public.conversations
     where last_message_at is not null
     group by contact_id
  ) sub
 where c.id = sub.contact_id
   and coalesce(c.last_activity_at, '-infinity'::timestamptz) < sub.max_at;

notify pgrst, 'reload schema';

-- ---- atribuição de anúncio: de qual campanha um contato do WhatsApp veio (migration 0164) ----
--
-- ⚠️ ENTRA ANTES DO BLOCO DA VARREDURA anon, pelo mesmo motivo das funções
-- acima: `tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts` proíbe `create
-- function` depois dele.
create or replace function public.fn_estampar_atribuicao_de_anuncio(
  p_contact uuid,
  p_platform text,
  p_metadata jsonb
) returns void
  language plpgsql
  security definer
  set search_path to 'public'
as $$
begin
  update public.contacts
  set
    source = p_platform,
    source_metadata = source_metadata || p_metadata,
    updated_at = now()
  where id = p_contact
    and source_metadata->>'ad_platform' is null;
end;
$$;

comment on function public.fn_estampar_atribuicao_de_anuncio(uuid, text, jsonb) is
  'Grava de qual anúncio (Meta Ads / Google Ads) um contato veio — só na primeira vez. `source_metadata = source_metadata || p_metadata` faz merge, nunca sobrescreve o que fn_upsert_wa_contact já gravou (waha_lid, waha_chat_id, notify_name). A guarda `source_metadata->>''ad_platform'' is null` é o primeiro-toque: clicar em outro anúncio meses depois, numa conversa já aberta, não reescreve de onde a pessoa veio originalmente — o UPDATE casa zero linhas, silenciosamente. security definer + revoke de anon/authenticated: só o backend (admin client no ingest de canal) chama isto.';

revoke execute on function public.fn_estampar_atribuicao_de_anuncio(uuid, text, jsonb) from public, anon, authenticated;
grant  execute on function public.fn_estampar_atribuicao_de_anuncio(uuid, text, jsonb) to service_role;

notify pgrst, 'reload schema';


-- ---- poda da fila e expurgo do audit (migration 0167) ----
--
-- Nada no produto apagava job terminal (`grep -rn "from job_queue" … | grep -i
-- delete` devolvia zero linhas), e a retenção de 5 anos do `api_audit_log`
-- existia só no COMMENT e na documentação — sem expurgo e sem o "cold storage
-- S3" que seis documentos prometiam. As duas tabelas cresciam desde a
-- instalação, e são as candidatas naturais a estourar os 500 MB do plano free
-- do Supabase antes de qualquer tabela de negócio.
--
-- O QUE TEM DONO NÃO SAI. `pending` (trabalho que ainda vai sair) e `running`
-- (com worker agora; o reaper o devolve se o worker morrer) NUNCA são tocados —
-- terminais são só `done`, `failed` e `dead`. E `dead` com AVISO ABERTO na
-- Central também tem dono: um humano que ainda não olhou. O `not exists` fica
-- ANTES do `limit` de propósito — filtrar depois faria um lote inteiro de jobs
-- protegidos devolver 0, o laço do cron pararia achando que acabou, e a poda
-- morreria de fome com backlog na frente.
--
-- CASCATA DECLARADA: apagar um job leva junto `send_ledger` e
-- `before_send_traces` daquele run (FK `on delete cascade`) — as duas também
-- crescem sem poda, então isso é parte do conserto. `llm_calls`,
-- `lead_checkpoints` e `lead_state_transitions` são `set null`: o histórico
-- fica, só perde o ponteiro. Os dois consumidores de `send_ledger` sem janela
-- (`countPriorAcceptedSends` → disclosure de IA e gate LGPD de 1º toque) falham
-- FECHADO quando a linha some: disclosure a mais e veto a mais, nunca a menos.
--
-- POR QUE `security definer` NO EXPURGO DO AUDIT, E POR QUE NÃO É UMA PORTA: a
-- tabela é append-only NO SCHEMA (o baseline não concede DELETE/UPDATE a
-- ninguém, nem a service_role), então o expurgo não sai pelo admin client. A
-- função (a) não tem seletor de linha — nenhum parâmetro de org, ator, ação ou
-- id, e o único predicado é `created_at < now() - N dias`, ou seja ela só sabe
-- apagar pela ponta mais velha; (b) carrega o PISO de 90 dias dentro do corpo,
-- então nem quem tem a service key remove rastro recente; (c) é revogada das
-- duas origens de EXECUTE e concedida só a service_role; (d) não amplia o raio
-- de quem já tem a chave (service_role já tem TRUNCATE nesta tabela) — dá forma
-- estreita e auditável a um poder que já existia; (e) registra a própria erosão,
-- porque o cron grava `retention.sweep_run` com a contagem, e essa linha é nova
-- demais para a chamada seguinte alcançar.
--
-- Idempotente e auto-curativo: `create or replace`, `create index if not
-- exists`, `revoke` (no-op quando o privilégio já não existe). Sem constraint
-- nova ⇒ sem dado a deduplicar antes.

create index if not exists idx_job_queue_poda
  on public.job_queue (created_at)
  where status in ('done', 'failed', 'dead');

-- Nome próprio da poda de propósito: `create index if not exists` casa por NOME,
-- e um nome genérico (`idx_audit_created_at`) poderia já existir num clone com
-- outra definição e virar no-op silencioso. Nenhum dos cinco índices que a
-- tabela já tem começa por `created_at`.
create index if not exists idx_audit_expurgo_created_at
  on public.api_audit_log (created_at);

create index if not exists idx_agent_inbox_items_ref_aberto
  on public.agent_inbox_items (ref_kind, ref_id)
  where status = 'open';

create or replace function public.fn_podar_fila_de_jobs(
  p_retencao_dias int default null,
  p_limite int default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- Piso de 7 dias: abaixo disso a cascata em `send_ledger` mexeria no horizonte
  -- em que "1º outbound" ainda diz algo sobre um lead vivo.
  v_dias int := greatest(coalesce(p_retencao_dias, 90), 7);
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_apagados int;
begin
  with candidatos as (
    select j.id
      from public.job_queue j
     where j.status in ('done', 'failed', 'dead')
       and j.created_at < now() - make_interval(days => v_dias)
       and not exists (
         select 1
           from public.agent_inbox_items i
          where i.ref_kind = 'job_queue'
            and i.ref_id = j.id
            and i.status = 'open'
       )
     order by j.created_at
     limit v_limite
  )
  delete from public.job_queue j
   using candidatos c
   where j.id = c.id;
  get diagnostics v_apagados = row_count;
  return v_apagados;
end;
$$;

create or replace function public.fn_expurgar_auditoria_vencida(
  p_retencao_dias int default null,
  p_limite int default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- 1825 dias = os 5 anos da regra L-10; o piso de 90 impede que o knob vire
  -- apagador de rastro recente.
  v_dias int := greatest(coalesce(p_retencao_dias, 1825), 90);
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_apagadas int;
begin
  with vencidas as (
    select a.id
      from public.api_audit_log a
     where a.created_at < now() - make_interval(days => v_dias)
     order by a.created_at
     limit v_limite
  )
  delete from public.api_audit_log a
   using vencidas v
   where a.id = v.id;
  get diagnostics v_apagadas = row_count;
  return v_apagadas;
end;
$$;

revoke execute on function public.fn_podar_fila_de_jobs(int, int)
  from public, anon, authenticated;
grant  execute on function public.fn_podar_fila_de_jobs(int, int)
  to service_role;

revoke execute on function public.fn_expurgar_auditoria_vencida(int, int)
  from public, anon, authenticated;
grant  execute on function public.fn_expurgar_auditoria_vencida(int, int)
  to service_role;

comment on table public.api_audit_log is
  'L-10: append-only (sem GRANT de UPDATE/DELETE a ninguém). Retenção default 5 anos, '
  'expurgada por public.fn_expurgar_auditoria_vencida (piso de 90 dias) a partir do cron '
  'app/api/v1/cron/data-retention. Não há camada cold/S3.';

notify pgrst, 'reload schema';
-- ---- quem manda na conversa: "Assumir" cala o automático (migration 0173) ----
--
-- ⚠️ ENTRA ANTES DO BLOCO DA VARREDURA anon, que é de propósito o último do
-- arquivo: `fn_conversation_assign` é recriada aqui e função criada depois da
-- varredura nasce com EXECUTE para anon sem ninguém curar. Os revokes explícitos
-- no fim deste bloco já fecham as duas origens, mas a ordem é a rede que pega o
-- próximo que esquecer. Vigiado por `tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts`.
--
-- Medido no HEAD 927dfa51: `lib/agent-engine/` NUNCA lê `assignee_kind` nem
-- `assigned_to_user_id` (grep → rc=1), e `fn_conversation_assign` nunca tocou
-- `bot_silenced_until`. Um atendente clicava "Assumir" e o automático continuava
-- respondendo o MESMO cliente; ele só calava 5 minutos deslizantes quando a pessoa
-- ENVIAVA (`extendBotSilence`). Dois atores atendendo a mesma pessoa é o defeito, e
-- qualquer selo de "você está no comando" em cima disso seria mentira.
--
-- O conserto entra na função de atribuição e não no motor porque
-- `bot_silenced_until` é o gate que o motor JÁ lê — nenhuma linha do motor muda. A
-- alternativa (ensinar o motor a ler `assignee_kind`) foi medida e REPROVADA:
-- `Fechar` não solta o dono, de propósito, então o fim NORMAL de um atendimento
-- deixaria `assignee_kind='user'` pendurado e o automático mudo para sempre naquele
-- contato — e aquele gate é por CONTATO, então calaria conversa NOVA de outro número.
--
-- O braço do rodízio é o que impede a regressão silenciosa:
--   * `p_reason='routing'` → NÃO MEXE. Distribuir não é assumir.
--     `trg_conversation_routing_requested` dispara em TODA conversa nova e o worker
--     roda 1×/min: sem a ressalva, uma org em `round_robin` ficaria com o automático
--     calado na primeira mensagem da vida de cada cliente.
--   * destino humano (claim/transfer) → 'infinity'.  * destino nulo (release) → null.
--
-- Assinatura IDÊNTICA de 6 args de propósito: parâmetro novo criaria OVERLOAD (o
-- `create or replace` não substitui assinatura diferente) e as cinco chamadas por
-- nome passariam a falhar com `is not unique`. Idempotente; sem dados a corrigir.
--
-- A limpeza do silêncio ao FECHAR mora na rota (`close/route.ts`): fechar não passa
-- por aqui, e sem ela o silêncio vazaria para o próximo episódio — a ingestão reusa
-- a MESMA linha de conversa (`on conflict do update`).

create or replace function public.fn_conversation_assign(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_to_user_id uuid,
  p_reason text,
  p_expected_assignee uuid default null,
  p_enforce_expected boolean default false
) returns setof public.conversations
language plpgsql security definer
set search_path = public
as $$
declare
  v_from uuid;
  v_conv public.conversations%rowtype;
begin
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'agent') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'caller must be an active agent+ member of the organization';
  end if;

  if p_to_user_id is not null then
    if coalesce(public.fn_member_role_in_org(p_to_user_id, p_organization_id), 'none')
         not in ('agent','manager','admin') then
      raise exception 'assignee_not_eligible_member'
        using hint = 'target must be an active agent+ member of the organization';
    end if;
  end if;

  select assigned_to_user_id into v_from
    from public.conversations
   where id = p_conversation_id
     and organization_id = p_organization_id
   for update;

  if not found then
    return;
  end if;

  if p_enforce_expected and v_from is distinct from p_expected_assignee then
    return;
  end if;

  update public.conversations
     set assigned_to_user_id = p_to_user_id,
         assigned_at = case when p_to_user_id is null then null else now() end,
         assignee_kind = case when p_to_user_id is null then null else 'user' end,
         status = case when p_to_user_id is null then 'open' else 'claimed' end,
         status_changed_at = now(),
         unread_count_for_assignee = 0,
         -- A trava só é solta por quem a pôs. `last_handoff_at` é o discriminador
         -- que já existe: uma ESCALAÇÃO o carimba (`performHumanHandoff` e
         -- `triggerHandoff`), um humano ASSUMINDO não. Sem esta condição, o
         -- release apagaria o silêncio de uma conversa que a IA escalou — e o
         -- caminho legado (`triggerHandoff`, usado pelo MCP, pelo handler de
         -- sentimento, pelo worker e pelo teto de gasto) NÃO grava
         -- `contacts.force_human`, então ali o silêncio é a ÚNICA trava. Medido:
         -- `grep -n force_human lib/ai/handoff/orchestrator.ts` → rc=1.
         -- Soltar de propósito é o botão "Devolver ao automático"
         -- (`devolverAtendimentoAoAgente`), que limpa as três travas de uma vez.
         bot_silenced_until = case
           when p_reason = 'routing'  then bot_silenced_until
           when p_to_user_id is null  then (case when last_handoff_at is null
                                                 then null
                                                 else bot_silenced_until end)
           else 'infinity'::timestamptz
         end,
         updated_at = now()
   where id = p_conversation_id
   returning * into v_conv;

  insert into public.conversation_assignment_events
    (organization_id, conversation_id, from_user_id, to_user_id, changed_by, reason)
  values
    (p_organization_id, p_conversation_id, v_from, p_to_user_id, auth.uid(), p_reason);

  return next v_conv;
end;
$$;

-- As DUAS origens de EXECUTE (doutrina, item 9): `revoke from public` não remove o
-- grant direto que `anon` carrega via ALTER DEFAULT PRIVILEGES, e `revoke from anon`
-- não remove o grant a PUBLIC dado na criação. Re-asseridas: é SECURITY DEFINER que
-- reatribui conversa.
revoke all     on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean) from public;
revoke execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean) from anon;
grant  execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean)
  to authenticated, service_role;

-- ---- o histórico de atribuição herda o escopo da conversa (migration 0173) ----
-- Medido: org em `visibility_mode='own'`, agent que não é dono → `select` em
-- `conversations` devolve 0 linhas e `select` em `conversation_assignment_events` da
-- MESMA conversa devolve 1. A policy era membership de org pura enquanto
-- `conversations_select` passa por `fn_can_view_conversation`. A tabela vive no
-- schema `public`, então isso é alcançável pelo PostgREST com a anon key + o JWT do
-- usuário — não depende de existir rota nossa.
--
-- Molde do `messages_select`: o `exists` sobre `conversations` já aplica a RLS de
-- `conversations`, então o escopo é HERDADO em vez de reescrito — duas cópias da
-- mesma regra divergem na primeira mudança de uma delas.
drop policy if exists cae_select on public.conversation_assignment_events;
create policy cae_select on public.conversation_assignment_events
  for select using (
    public.fn_is_platform_admin()
    or (
      -- O filtro de org fica, mesmo com o `exists` ao lado. Os dois predicados
      -- respondem perguntas DIFERENTES: o `exists` diz "você enxerga esta
      -- conversa?", e este diz "esta LINHA é da sua organização?". A policy de
      -- INSERT (intocada) permite gravar uma linha com o `organization_id` de um
      -- tenant e o `conversation_id` de outro; sem esta metade, quem enxerga a
      -- conversa apontada leria a linha do tenant vizinho.
      organization_id in (select public.fn_user_org_ids())
      and exists (
        select 1
          from public.conversations c
         where c.id = conversation_assignment_events.conversation_id
      )
    )
  );

-- ---- LGPD alcança o histórico de captação: função + trigger (migration 0174) ----
--
-- A PRIMEIRA metade da 0174. Está aqui, e não no fim do arquivo, porque cria
-- FUNÇÃO — e o bloco da VARREDURA anon (logo abaixo) proíbe qualquer
-- `create function` depois dele: a função nasceria com EXECUTE para `anon` em
-- quem ATUALIZA, sem nada mais adiante para tirar. A tabela vai no bloco do
-- fim, e a ordem entre os dois não importa: o corpo de uma plpgsql só resolve
-- os nomes na execução, e o trigger é de UPDATE (nada dispara durante o
-- baseline).
--
-- `fn_lgpd_cascade_redact_contact` tem 180 linhas; acrescentar um 9º passo
-- exigiria reescrevê-la inteira aqui, e a partir daí existiriam duas cópias —
-- a do dump e a do apêndice — que divergem no primeiro conserto que alguém
-- fizer na de cima. O gancho é a transição `is_anonymized false → true` na
-- própria `contacts`, que é o último fato da anonimização e roda na MESMA
-- transação do cascade. E alcança mais que o 9º passo alcançaria: qualquer
-- caminho que anonimize um contato passa por este UPDATE.
create or replace function public.fn_redigir_captacoes_do_contato_anonimizado()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.webhook_lead_captures
     set captured_name = null,
         captured_phone = null,
         captured_email = null,
         fields = '{}'::jsonb,
         utm = '{}'::jsonb,
         remote_ip = null,
         user_agent = null
   where organization_id = new.organization_id
     and contact_id = new.id;
  return new;
end;
$$;

revoke execute on function public.fn_redigir_captacoes_do_contato_anonimizado() from public, anon, authenticated;
grant execute on function public.fn_redigir_captacoes_do_contato_anonimizado() to service_role;

notify pgrst, 'reload schema';

-- ---- nono dígito canônico (migration 0198) ----
-- 0198 — celular BR canônico COM o nono dígito
--
-- +553284793302 e +5532984793302 são a MESMA pessoa. O CRM passa a GRAVAR e
-- MOSTRAR a forma com o 9; o WhatsApp/WAHA continuam podendo endereçar sem ele
-- (check-exists tenta as duas grafias).
--
-- A busca por variantes já existia em TypeScript. Sem a RPC e sem o backfill,
-- o webhook que chega sem o 9 ainda nascia um segundo contato.
--
-- Idempotente: create or replace + updates que na segunda passada casam zero
-- linhas. Sem constraint nova.

-- 1 · a RPC reencontra pelas duas grafias e GRAVA a canônica.
create or replace function public.fn_upsert_wa_contact(
  p_org uuid, p_kind text, p_phone text, p_lid text, p_chat_id text, p_notify text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_conflito text;
  v_lid text := nullif(regexp_replace(coalesce(p_lid, ''), '@.*$', ''), '');
  v_phone text := nullif(p_phone, '');
  v_digits text;
  v_alt text;
begin
  -- Celular BR de 12 dígitos (local 6–9) ganha o nono. A grafia sem o 9 fica
  -- em v_alt só para a BUSCA — não se escreve mais.
  if v_phone is not null then
    v_digits := regexp_replace(v_phone, '\D', '', 'g');
    if v_digits ~ '^55[1-9][0-9][6-9][0-9]{7}$' then
      v_alt := '+' || v_digits;
      v_phone := '+55' || substring(v_digits from 3 for 2) || '9' || substring(v_digits from 5);
    elsif v_digits ~ '^55[1-9][0-9]9[6-9][0-9]{7}$' then
      v_phone := '+' || v_digits;
      v_alt := '+55' || substring(v_digits from 3 for 2) || substring(v_digits from 6);
    end if;
  end if;

  if v_lid is not null then
    select id into v_id from public.contacts
     where organization_id = p_org and wa_lid = v_lid and is_merged_into is null
     limit 1;
  end if;

  if v_id is null and v_phone is not null then
    select id into v_id from public.contacts
     where organization_id = p_org and is_merged_into is null
       and phone_number in (v_phone, v_alt)
     order by case when phone_number = v_phone then 0 else 1 end
     limit 1;
  end if;

  if v_id is not null and v_phone is not null and exists (
    select 1 from public.contacts
     where organization_id = p_org and phone_number = v_phone
       and is_merged_into is null and id <> v_id
  ) then
    v_conflito := v_phone;
    v_phone := null;
  end if;

  if v_id is not null then
    update public.contacts set
      -- Promove 12→13 quando é a MESMA pessoa e o canônico está livre.
      -- Outro número (pessoa diferente) continua intocável.
      phone_number = case
        when v_phone is not null and (phone_number is null or phone_number = v_alt) then v_phone
        else phone_number
      end,
      display_name = coalesce(display_name, nullif(p_notify, '')),
      source_metadata = source_metadata
        || case when v_lid is not null then jsonb_build_object('waha_lid', v_lid) else '{}'::jsonb end
        || case when p_chat_id is not null then jsonb_build_object('waha_chat_id', p_chat_id) else '{}'::jsonb end
        || case when nullif(p_notify, '') is not null then jsonb_build_object('notify_name', p_notify) else '{}'::jsonb end
        || case when v_conflito is not null then jsonb_build_object('telefone_em_conflito', v_conflito) else '{}'::jsonb end,
      updated_at = now()
    where id = v_id;
    return v_id;
  end if;

  begin
    insert into public.contacts (organization_id, phone_number, source, consent, tags, source_metadata, display_name)
    values (p_org, v_phone, 'whatsapp', '{}'::jsonb, '{}'::text[],
      case when v_lid is not null
        then jsonb_build_object('waha_lid', v_lid, 'waha_chat_id', p_chat_id, 'notify_name', nullif(p_notify, ''))
        else jsonb_build_object('waha_chat_id', p_chat_id, 'notify_name', nullif(p_notify, '')) end,
      nullif(p_notify, ''))
    returning id into v_id;
    return v_id;
  exception when unique_violation then
    select id into v_id from public.contacts
     where organization_id = p_org and is_merged_into is null
       and (
         (v_phone is not null and phone_number = v_phone)
         or (v_alt is not null and phone_number = v_alt)
         or (v_lid is not null and wa_lid = v_lid)
       )
     order by case when phone_number = v_phone then 0 else 1 end
     limit 1;
    return v_id;
  end;
end; $$;

-- 2 · pares 12+13: funde o de 12 no de 13 (canônico). Conversas 1:1 no mesmo
-- canal são fundidas ANTES de remarcarmos o contact_id, senão
-- uniq_conversations_1to1_per_contact_session estoura.

with pares as (
  select sem.id as loser_id, com.id as winner_id
    from public.contacts sem
    join public.contacts com
      on com.organization_id = sem.organization_id
     and com.is_merged_into is null
     and sem.is_merged_into is null
     and sem.id <> com.id
     and sem.is_anonymized = false
     and com.is_anonymized = false
     and regexp_replace(coalesce(sem.phone_number, ''), '\D', '', 'g') ~ '^55[1-9][0-9][6-9][0-9]{7}$'
     and com.phone_number = '+55'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 3 for 2)
       || '9'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 5)
)
, conv_pares as (
  select loser.id as loser_conv, winner.id as winner_conv, p.winner_id
    from pares p
    join public.conversations loser
      on loser.contact_id = p.loser_id and loser.is_group = false
    join public.conversations winner
      on winner.contact_id = p.winner_id
     and winner.channel_session_id = loser.channel_session_id
     and winner.organization_id = loser.organization_id
     and winner.is_group = false
     and winner.id <> loser.id
)
update public.messages m
   set conversation_id = cp.winner_conv, contact_id = cp.winner_id
  from conv_pares cp
 where m.conversation_id = cp.loser_conv;

with pares as (
  select sem.id as loser_id, com.id as winner_id
    from public.contacts sem
    join public.contacts com
      on com.organization_id = sem.organization_id
     and com.is_merged_into is null
     and sem.is_merged_into is null
     and sem.id <> com.id
     and sem.is_anonymized = false
     and com.is_anonymized = false
     and regexp_replace(coalesce(sem.phone_number, ''), '\D', '', 'g') ~ '^55[1-9][0-9][6-9][0-9]{7}$'
     and com.phone_number = '+55'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 3 for 2)
       || '9'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 5)
)
, conv_pares as (
  select loser.id as loser_conv, winner.id as winner_conv
    from pares p
    join public.conversations loser
      on loser.contact_id = p.loser_id and loser.is_group = false
    join public.conversations winner
      on winner.contact_id = p.winner_id
     and winner.channel_session_id = loser.channel_session_id
     and winner.organization_id = loser.organization_id
     and winner.is_group = false
     and winner.id <> loser.id
)
update public.ai_agent_runs t set conversation_id = cp.winner_conv
  from conv_pares cp where t.conversation_id = cp.loser_conv;

with pares as (
  select sem.id as loser_id, com.id as winner_id
    from public.contacts sem
    join public.contacts com
      on com.organization_id = sem.organization_id
     and com.is_merged_into is null
     and sem.is_merged_into is null
     and sem.id <> com.id
     and sem.is_anonymized = false
     and com.is_anonymized = false
     and regexp_replace(coalesce(sem.phone_number, ''), '\D', '', 'g') ~ '^55[1-9][0-9][6-9][0-9]{7}$'
     and com.phone_number = '+55'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 3 for 2)
       || '9'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 5)
)
, conv_pares as (
  select loser.id as loser_conv, winner.id as winner_conv
    from pares p
    join public.conversations loser
      on loser.contact_id = p.loser_id and loser.is_group = false
    join public.conversations winner
      on winner.contact_id = p.winner_id
     and winner.channel_session_id = loser.channel_session_id
     and winner.organization_id = loser.organization_id
     and winner.is_group = false
     and winner.id <> loser.id
)
update public.ai_invocations t set conversation_id = cp.winner_conv
  from conv_pares cp where t.conversation_id = cp.loser_conv;

with pares as (
  select sem.id as loser_id, com.id as winner_id
    from public.contacts sem
    join public.contacts com
      on com.organization_id = sem.organization_id
     and com.is_merged_into is null
     and sem.is_merged_into is null
     and sem.id <> com.id
     and sem.is_anonymized = false
     and com.is_anonymized = false
     and regexp_replace(coalesce(sem.phone_number, ''), '\D', '', 'g') ~ '^55[1-9][0-9][6-9][0-9]{7}$'
     and com.phone_number = '+55'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 3 for 2)
       || '9'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 5)
)
, conv_pares as (
  select loser.id as loser_conv, winner.id as winner_conv
    from pares p
    join public.conversations loser
      on loser.contact_id = p.loser_id and loser.is_group = false
    join public.conversations winner
      on winner.contact_id = p.winner_id
     and winner.channel_session_id = loser.channel_session_id
     and winner.organization_id = loser.organization_id
     and winner.is_group = false
     and winner.id <> loser.id
)
update public.conversation_notes t set conversation_id = cp.winner_conv
  from conv_pares cp where t.conversation_id = cp.loser_conv;

with pares as (
  select sem.id as loser_id, com.id as winner_id
    from public.contacts sem
    join public.contacts com
      on com.organization_id = sem.organization_id
     and com.is_merged_into is null
     and sem.is_merged_into is null
     and sem.id <> com.id
     and sem.is_anonymized = false
     and com.is_anonymized = false
     and regexp_replace(coalesce(sem.phone_number, ''), '\D', '', 'g') ~ '^55[1-9][0-9][6-9][0-9]{7}$'
     and com.phone_number = '+55'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 3 for 2)
       || '9'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 5)
)
, conv_pares as (
  select loser.id as loser_conv, winner.id as winner_conv
    from pares p
    join public.conversations loser
      on loser.contact_id = p.loser_id and loser.is_group = false
    join public.conversations winner
      on winner.contact_id = p.winner_id
     and winner.channel_session_id = loser.channel_session_id
     and winner.organization_id = loser.organization_id
     and winner.is_group = false
     and winner.id <> loser.id
)
update public.conversation_assignment_events t set conversation_id = cp.winner_conv
  from conv_pares cp where t.conversation_id = cp.loser_conv;

with pares as (
  select sem.id as loser_id, com.id as winner_id
    from public.contacts sem
    join public.contacts com
      on com.organization_id = sem.organization_id
     and com.is_merged_into is null
     and sem.is_merged_into is null
     and sem.id <> com.id
     and sem.is_anonymized = false
     and com.is_anonymized = false
     and regexp_replace(coalesce(sem.phone_number, ''), '\D', '', 'g') ~ '^55[1-9][0-9][6-9][0-9]{7}$'
     and com.phone_number = '+55'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 3 for 2)
       || '9'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 5)
)
, conv_pares as (
  select loser.id as loser_conv, winner.id as winner_conv
    from pares p
    join public.conversations loser
      on loser.contact_id = p.loser_id and loser.is_group = false
    join public.conversations winner
      on winner.contact_id = p.winner_id
     and winner.channel_session_id = loser.channel_session_id
     and winner.organization_id = loser.organization_id
     and winner.is_group = false
     and winner.id <> loser.id
)
update public.agent_cases t set conversation_id = cp.winner_conv
  from conv_pares cp where t.conversation_id = cp.loser_conv;

with pares as (
  select sem.id as loser_id, com.id as winner_id
    from public.contacts sem
    join public.contacts com
      on com.organization_id = sem.organization_id
     and com.is_merged_into is null
     and sem.is_merged_into is null
     and sem.id <> com.id
     and sem.is_anonymized = false
     and com.is_anonymized = false
     and regexp_replace(coalesce(sem.phone_number, ''), '\D', '', 'g') ~ '^55[1-9][0-9][6-9][0-9]{7}$'
     and com.phone_number = '+55'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 3 for 2)
       || '9'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 5)
)
, conv_pares as (
  select loser.id as loser_conv, winner.id as winner_conv
    from pares p
    join public.conversations loser
      on loser.contact_id = p.loser_id and loser.is_group = false
    join public.conversations winner
      on winner.contact_id = p.winner_id
     and winner.channel_session_id = loser.channel_session_id
     and winner.organization_id = loser.organization_id
     and winner.is_group = false
     and winner.id <> loser.id
)
update public.followup_enrollments t set conversation_id = cp.winner_conv
  from conv_pares cp where t.conversation_id = cp.loser_conv;

with pares as (
  select sem.id as loser_id, com.id as winner_id
    from public.contacts sem
    join public.contacts com
      on com.organization_id = sem.organization_id
     and com.is_merged_into is null
     and sem.is_merged_into is null
     and sem.id <> com.id
     and sem.is_anonymized = false
     and com.is_anonymized = false
     and regexp_replace(coalesce(sem.phone_number, ''), '\D', '', 'g') ~ '^55[1-9][0-9][6-9][0-9]{7}$'
     and com.phone_number = '+55'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 3 for 2)
       || '9'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 5)
)
, conv_pares as (
  select loser.id as loser_conv, winner.id as winner_conv
    from pares p
    join public.conversations loser
      on loser.contact_id = p.loser_id and loser.is_group = false
    join public.conversations winner
      on winner.contact_id = p.winner_id
     and winner.channel_session_id = loser.channel_session_id
     and winner.organization_id = loser.organization_id
     and winner.is_group = false
     and winner.id <> loser.id
)
update public.contact_field_proposals t set conversation_id = cp.winner_conv
  from conv_pares cp where t.conversation_id = cp.loser_conv;

with pares as (
  select sem.id as loser_id, com.id as winner_id
    from public.contacts sem
    join public.contacts com
      on com.organization_id = sem.organization_id
     and com.is_merged_into is null
     and sem.is_merged_into is null
     and sem.id <> com.id
     and sem.is_anonymized = false
     and com.is_anonymized = false
     and regexp_replace(coalesce(sem.phone_number, ''), '\D', '', 'g') ~ '^55[1-9][0-9][6-9][0-9]{7}$'
     and com.phone_number = '+55'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 3 for 2)
       || '9'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 5)
)
, conv_pares as (
  select loser.id as loser_conv, winner.id as winner_conv
    from pares p
    join public.conversations loser
      on loser.contact_id = p.loser_id and loser.is_group = false
    join public.conversations winner
      on winner.contact_id = p.winner_id
     and winner.channel_session_id = loser.channel_session_id
     and winner.organization_id = loser.organization_id
     and winner.is_group = false
     and winner.id <> loser.id
)
delete from public.demanda_conversas d
 using conv_pares cp
 where d.conversation_id = cp.loser_conv
   and exists (
     select 1 from public.demanda_conversas w
      where w.demanda_id = d.demanda_id and w.conversation_id = cp.winner_conv
   );

with pares as (
  select sem.id as loser_id, com.id as winner_id
    from public.contacts sem
    join public.contacts com
      on com.organization_id = sem.organization_id
     and com.is_merged_into is null
     and sem.is_merged_into is null
     and sem.id <> com.id
     and sem.is_anonymized = false
     and com.is_anonymized = false
     and regexp_replace(coalesce(sem.phone_number, ''), '\D', '', 'g') ~ '^55[1-9][0-9][6-9][0-9]{7}$'
     and com.phone_number = '+55'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 3 for 2)
       || '9'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 5)
)
, conv_pares as (
  select loser.id as loser_conv, winner.id as winner_conv
    from pares p
    join public.conversations loser
      on loser.contact_id = p.loser_id and loser.is_group = false
    join public.conversations winner
      on winner.contact_id = p.winner_id
     and winner.channel_session_id = loser.channel_session_id
     and winner.organization_id = loser.organization_id
     and winner.is_group = false
     and winner.id <> loser.id
)
update public.demanda_conversas t set conversation_id = cp.winner_conv
  from conv_pares cp where t.conversation_id = cp.loser_conv;

with pares as (
  select sem.id as loser_id, com.id as winner_id
    from public.contacts sem
    join public.contacts com
      on com.organization_id = sem.organization_id
     and com.is_merged_into is null
     and sem.is_merged_into is null
     and sem.id <> com.id
     and sem.is_anonymized = false
     and com.is_anonymized = false
     and regexp_replace(coalesce(sem.phone_number, ''), '\D', '', 'g') ~ '^55[1-9][0-9][6-9][0-9]{7}$'
     and com.phone_number = '+55'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 3 for 2)
       || '9'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 5)
)
, conv_pares as (
  select loser.id as loser_conv, winner.id as winner_conv
    from pares p
    join public.conversations loser
      on loser.contact_id = p.loser_id and loser.is_group = false
    join public.conversations winner
      on winner.contact_id = p.winner_id
     and winner.channel_session_id = loser.channel_session_id
     and winner.organization_id = loser.organization_id
     and winner.is_group = false
     and winner.id <> loser.id
)
delete from public.conversations d
 using conv_pares cp
 where d.id = cp.loser_conv;

-- Marca os de 12 dígitos como fundidos no irmão de 13.
with pares as (
  select sem.id as loser_id, com.id as winner_id
    from public.contacts sem
    join public.contacts com
      on com.organization_id = sem.organization_id
     and com.is_merged_into is null
     and sem.is_merged_into is null
     and sem.id <> com.id
     and sem.is_anonymized = false
     and com.is_anonymized = false
     and regexp_replace(coalesce(sem.phone_number, ''), '\D', '', 'g') ~ '^55[1-9][0-9][6-9][0-9]{7}$'
     and com.phone_number = '+55'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 3 for 2)
       || '9'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 5)
)
update public.contacts c
   set is_merged_into = p.winner_id, merged_at = now()
  from pares p
 where c.id = p.loser_id;

-- lead_state é unique (org, contact): apaga o perdedor se o vencedor já tem linha.
delete from public.lead_state l
 using public.contacts c
 where l.contact_id = c.id and c.is_merged_into is not null
   and exists (
     select 1 from public.lead_state w
      where w.contact_id = c.is_merged_into and w.organization_id = l.organization_id
   );

update public.followup_enrollments e
   set status = 'cancelled', cancel_reason = 'nono_digito_merge', next_eval_at = null, updated_at = now()
  from public.contacts c
 where e.contact_id = c.id and c.is_merged_into is not null
   and e.status in ('active', 'waiting_reply', 'paused_handoff')
   and exists (
     select 1 from public.followup_enrollments w
      where w.organization_id = e.organization_id
        and w.contact_id = c.is_merged_into
        and w.status in ('active', 'waiting_reply', 'paused_handoff')
   );

update public.conversations       t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.messages            t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.ai_agent_runs       t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.crm_lead_activities t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.crm_leads           t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.lgpd_requests       t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.orders              t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.job_queue           t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null
  and not (t.status = 'running' and exists (
    select 1 from public.job_queue w where w.contact_id = c.is_merged_into and w.status = 'running'
  ));
update public.send_ledger         t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.llm_calls           t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.lead_checkpoints    t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.lead_state          t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.lead_state_transitions t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.cron_jobs           t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.lead_notes          t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.before_send_traces  t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.followup_enrollments t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.demandas            t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.contact_field_proposals t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;

-- 3 · quem só tinha a grafia de 12 dígitos ganha o nono. Pula se o canônico
-- já pertence a outro contato vivo (o passo 2 deveria ter fundido; isto é o
-- piso de segurança para o unique).
update public.contacts
   set phone_number = '+55'
     || substring(regexp_replace(phone_number, '\D', '', 'g') from 3 for 2)
     || '9'
     || substring(regexp_replace(phone_number, '\D', '', 'g') from 5),
       updated_at = now()
 where is_merged_into is null
   and is_anonymized = false
   and regexp_replace(coalesce(phone_number, ''), '\D', '', 'g') ~ '^55[1-9][0-9][6-9][0-9]{7}$'
   and not exists (
     select 1 from public.contacts o
      where o.organization_id = contacts.organization_id
        and o.is_merged_into is null
        and o.id <> contacts.id
        and o.phone_number = '+55'
          || substring(regexp_replace(contacts.phone_number, '\D', '', 'g') from 3 for 2)
          || '9'
          || substring(regexp_replace(contacts.phone_number, '\D', '', 'g') from 5)
   );

-- ---- agenda: o cascade que o vínculo polimórfico não tem — função (migration 0177) ----
--
-- A PRIMEIRA metade da 0177. Está aqui, e não no fim do arquivo, porque cria
-- FUNÇÃO — e o bloco da VARREDURA anon (logo abaixo) proíbe qualquer
-- `create function` depois dele: a função nasceria com EXECUTE para `anon` em
-- quem ATUALIZA, sem nada mais adiante para tirar. A tabela, o trigger e a RLS
-- vão no bloco do fim, e a ordem entre os dois não importa: o corpo de uma
-- plpgsql só resolve nomes na execução, e o trigger é de DELETE (nada dispara
-- durante o baseline).
--
-- O agendamento se liga ao lead por `crm_lead_links` (target_kind='appointment',
-- valor que o CHECK daquela tabela já aceitava antes desta migration), e
-- `target_id` é polimórfico: não pode ter FK, logo não tem ON DELETE. Apagar um
-- agendamento deixaria o vínculo apontando para o nada. O caminho normal é que
-- agendamento não se apague — se cancele —, mas isso é prosa, e prosa não é
-- guarda.
-- ────────────────────────────────────────────────────────────────────────────
-- 8 · o cascade que o polimórfico não tem
-- ────────────────────────────────────────────────────────────────────────────
-- O vínculo com o lead vai por `crm_lead_links` (target_kind='appointment'), e
-- `target_id` é polimórfico: não pode ter FK, logo não tem ON DELETE. Apagar
-- um agendamento deixaria o vínculo apontando para o nada.
--
-- O caminho NORMAL é que agendamento não se apague: cancela-se (`status`
-- 'cancelled'), porque o cancelamento é informação de negócio e a aba
-- Histórico existe para mostrá-lo. Mas "ninguém deveria apagar" é prosa, e
-- prosa não é guarda. Este trigger é o mecanismo.
create or replace function public.fn_limpar_vinculos_do_agendamento()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.crm_lead_links
   where organization_id = old.organization_id
     and target_kind = 'appointment'
     and target_id = old.id;
  return old;
end;
$$;

-- Função de trigger não exige EXECUTE de quem dispara o DELETE, então revogar
-- das três origens não a quebra — e mantém a função fora da lista de exceções
-- do invariante de hardening, que é congelada.
revoke execute on function public.fn_limpar_vinculos_do_agendamento() from public, anon, authenticated;
grant  execute on function public.fn_limpar_vinculos_do_agendamento() to service_role;

-- ---- LGPD alcança a agenda: função (migration 0184) ----
--
-- A PRIMEIRA metade da 0184. Está aqui, e não no fim, porque cria FUNÇÃO — e a
-- VARREDURA anon (logo abaixo) proíbe `create function` depois dela: a função
-- nasceria com EXECUTE para `anon` em quem ATUALIZA, sem nada adiante para tirar.
-- O trigger vai no bloco do fim; a ordem não importa, porque o corpo de uma
-- plpgsql só resolve nomes na execução e nada dispara UPDATE durante o baseline.
--
-- `fn_lgpd_cascade_redact_contact` percorre uma lista escrita à mão e
-- `calendar_appointments` não estava nela — e a tabela guarda `title`,
-- `description`, `notes` (numa clínica, queixa clínica), `location_details` e
-- `cancellation_reason`. A função reportava sucesso, a rota reportava sucesso, o
-- SLA de D+15 era marcado como cumprido, e a queixa continuava legível.
--
-- Trigger e não passo dentro da função: ela vem do dump com ~180 linhas, e um
-- passo novo exigiria carregar uma CÓPIA inteira dela aqui — duas cópias que
-- divergem no primeiro conserto. E o trigger escuta a COLUNA, não o chamador,
-- então alcança qualquer caminho de anonimização.
create or replace function public.fn_redigir_agenda_do_contato_anonimizado()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.calendar_appointments
     set title               = 'Compromisso anonimizado',
         description         = null,
         notes               = null,
         location_details    = null,
         meeting_url         = null,
         cancellation_reason = null
   where organization_id = new.organization_id
     and contact_id = new.id;
  return new;
end;
$$;

-- Função de trigger não exige EXECUTE de quem dispara o UPDATE, então revogar
-- das três origens não a quebra — e a mantém fora da lista de exceções do
-- invariante de hardening, que é congelada.
revoke execute on function public.fn_redigir_agenda_do_contato_anonimizado() from public, anon, authenticated;
grant  execute on function public.fn_redigir_agenda_do_contato_anonimizado() to service_role;

-- ---- a agenda nasce com o que marcar: funções (migration 0185) ----
--
-- A PRIMEIRA metade da 0185, aqui porque cria FUNÇÃO e a VARREDURA anon (logo
-- abaixo) proíbe `create function` depois dela.
--
-- Zero INSERT em `calendar_event_types` em todo o repo, medido com controle
-- positivo. Instalação fresca abria a Agenda numa semana em branco, sem nada
-- para clicar e sem mensagem — e grade vazia é indistinguível de "ninguém marcou
-- hoje". É o P0 da doutrina de QA Visual.
--
-- NEUTRO de propósito: o nicho não é persistido em lugar nenhum (a inferência
-- roda em memória no passo do funil e morre lá), e o trigger dispara no INSERT
-- da organização, antes de existir qualquer texto para inferir. Este é o PISO;
-- o enriquecimento por nicho vive onde o nicho existe, no passo do onboarding.
create or replace function public.fn_semear_tipos_de_agendamento(p_organization_id uuid)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_criados integer := 0;
  r record;
begin
  for r in
    select * from (values
      ('Consulta',    'consulta',    'consulta', 30, 1000::numeric),
      ('Reunião',     'reuniao',     'reuniao',  30, 2000::numeric),
      ('Atendimento', 'atendimento', 'outro',    30, 3000::numeric)
    ) as t(nome, slug, categoria, duracao, posicao)
  loop
    insert into public.calendar_event_types
      (organization_id, name, slug, category, duration_minutes, position)
    values
      (p_organization_id, r.nome, r.slug, r.categoria, r.duracao, r.posicao)
    on conflict (organization_id, slug) do nothing;

    if found then
      v_criados := v_criados + 1;
    end if;
  end loop;

  return v_criados;
end;
$$;

create or replace function public.fn_semear_tipos_de_agendamento_na_org_nova()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform public.fn_semear_tipos_de_agendamento(new.id);
  return new;
end;
$$;

-- Função de trigger não exige EXECUTE de quem dispara o INSERT, e a de seed é
-- chamada por ela e pelo backfill — nenhum dos dois passa pelo PostgREST.
revoke execute on function public.fn_semear_tipos_de_agendamento(uuid) from public, anon, authenticated;
revoke execute on function public.fn_semear_tipos_de_agendamento_na_org_nova() from public, anon, authenticated;
grant  execute on function public.fn_semear_tipos_de_agendamento(uuid) to service_role;
grant  execute on function public.fn_semear_tipos_de_agendamento_na_org_nova() to service_role;

-- ---- o espelho do Google é cache com prazo: função (migration 0187) ----
--
-- A PRIMEIRA metade da 0187, aqui porque cria FUNÇÃO e a VARREDURA anon proíbe
-- `create function` depois dela.
--
-- `calendar_external_events` ficou fora da cascata de LGPD (0184) por não ter
-- `contact_id`. A decisão foi declarar ESPELHO — a fonte da verdade é a agenda do
-- Google do próprio cliente. Mas essa declaração só é honesta com três
-- propriedades, e faltava a terceira: PRAZO. Sem ele, "espelho" é um nome mais
-- simpático para arquivo permanente de compromissos de terceiros.
--
-- Corta por `ends_at`, nunca por `created_at`: compromisso futuro não envelhece,
-- e apagá-lo faria a agenda marcar em cima de hora ocupada. Piso de 7 dias e não
-- 90 como o da auditoria — auditoria é rastro que precisa sobreviver a um
-- incidente; isto é cache que o sync repõe.
create or replace function public.fn_expurgar_espelho_da_agenda(
  p_retencao_dias int default null,
  p_limite int default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- 90 dias de passado visível; piso de 7 porque isto é cache reconstruível pelo
  -- sync, e não rastro que precise sobreviver a um incidente.
  v_dias int := greatest(coalesce(p_retencao_dias, 90), 7);
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_apagadas int;
begin
  with vencidos as (
    select e.id
      from public.calendar_external_events e
     -- `ends_at` e não `created_at`: um compromisso futuro não envelhece, e
     -- apagá-lo faria a agenda marcar em cima de hora ocupada.
     where e.ends_at < now() - make_interval(days => v_dias)
     order by e.ends_at
     limit v_limite
  )
  delete from public.calendar_external_events e
   using vencidos v
   where e.id = v.id;
  get diagnostics v_apagadas = row_count;
  return v_apagadas;
end;
$$;

revoke execute on function public.fn_expurgar_espelho_da_agenda(int, int) from public, anon, authenticated;
grant  execute on function public.fn_expurgar_espelho_da_agenda(int, int) to service_role;

-- ---- mensagem editada e mensagem apagada (migration 0153) ----
-- O cliente edita ou apaga no aplicativo e o CRM seguia mostrando a versão
-- velha — sem erro em lugar nenhum. Combinar preço ou endereço a partir de um
-- texto que o cliente já corrigiu gera um erro que ninguém rastreia depois.
-- Duas colunas e não um estado: editada continua valendo (o texto novo conta),
-- apagada deixou de valer (o texto não pode mais aparecer). Timestamp e não
-- booleano porque a pergunta seguinte é "quando?". A linha apagada NÃO some: a
-- remoção levaria junto o contexto das vizinhas e o histórico de quem atendeu.
alter table public.messages add column if not exists edited_at timestamptz;
alter table public.messages add column if not exists revoked_at timestamptz;

-- ---- definição sabe de qual conexão é (migration 0154) ----
-- `meta_templates` nasceu para um canal só: a única marca de origem é
-- `waba_id`, o id da conta na plataforma da Meta. Um segundo canal não tem onde
-- entrar sem mentir sobre o que aquele campo significa — e o endpoint, que
-- resolve a sessão por `metaSessionForOrg`, devolvia lista VAZIA numa
-- instalação que só tem o canal intermediado. A conexão, e não um `provider`:
-- dois números do mesmo provider têm definições diferentes. `set null` no
-- delete porque apagar a conexão não pode apagar o registro do que a
-- plataforma aprovou — ela continua existindo lá.
alter table public.meta_templates
  add column if not exists channel_session_id uuid
    references public.channel_sessions(id) on delete set null;
create index if not exists meta_templates_sessao_idx
  on public.meta_templates (channel_session_id, status)
  where channel_session_id is not null;

-- ---- o arquivo do webhook aceita os canais novos (migration 0151) ----
-- `webhook_events_log` guarda o corpo CRU do que o provedor mandou — é o único
-- lugar onde ele fica. O CHECK do dump conhecia três provedores e nenhum dos
-- canais do seam, então a rota genérica de canal não tinha como gravar sem
-- mentir sobre a origem ('generic' para um canal que se sabe qual é).
--
-- Este é o BLOCO ÚNICO desta constraint (regra da issue #159): canal novo edita
-- ESTA lista, e não acrescenta um segundo bloco — dois blocos fazem o
-- `update.sh` de um clone com dados falhar no primeiro e deixar a tabela sem
-- constraint entre o `drop` e o `add` que funciona.
--
-- Alargamento puro: um CHECK que aceita MAIS valores não pode ser violado por
-- linha que já passava pelo antigo, então não precisa de backfill antes.
alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;
alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check check (provider in (
    'waha', 'nuvemshop', 'generic', 'meta_cloud', 'zernio'
  ));

-- ---- a marca da instalação sai do .env e vai para o banco (migration 0155) ----
--
-- Nome, logo e cor viviam só em `APP_NAME`/`APP_LOGO_URL`/`APP_ACCENT_HEX`:
-- trocar qualquer um exigia SSH na VPS e reiniciar a stack. Para quem compra
-- hospedagem e instala sozinho, isso é o mesmo que não ser configurável.
--
-- O `.env` CONTINUA sendo escrito, e não é redundância: o `agent.sh` do kit, em
-- falha de update, reverte só o `APP_IMAGE` — não o schema, não o `git
-- checkout`. E o `update.sh` aplica ESTE arquivo ANTES de puxar a imagem. Ou
-- seja, o rollback põe código antigo sobre banco novo por construção, e código
-- antigo não conhece esta tabela. Com o `.env` intacto a marca degrada para o
-- valor da instalação em vez de sumir no meio de um rollback.
--
-- ── RLS LIGADA COM ZERO POLICIES + REVOKE EXPLÍCITO ─────────────────────────
--
-- As duas coisas, e nenhuma substitui a outra:
--
--   (1) `enable row level security` sem NENHUMA policy é a forma explícita de
--       dizer "o PostgREST nunca serve isto". A tabela é lida e escrita só
--       server-side, pelo admin client (`service_role`, que é `bypassrls`).
--
--   (2) O `revoke` abaixo é O ANÁLOGO, PARA TABELA, DA REGRA DE `security
--       definer` DO ITEM 9 DO CLAUDE.md — e isso não está documentado em lugar
--       nenhum hoje, e é o furo que a próxima tabela de apêndice repetiria.
--       Este mesmo arquivo traz `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON
--       TABLES TO anon` (linha ~3972) e `... TO authenticated` (~3973), e eles
--       valem para TODA tabela criada DEPOIS deles — isto é, para todo apêndice
--       novo. TABELA NOVA NASCE CONCEDIDA. Foi exatamente assim que nasceu a
--       vulnerabilidade que a 0143 consertou em `org_guardrail_layers` (medido:
--       um `viewer` desligava a camada anti-jailbreak pelo PostgREST — UPDATE 1
--       + INSERT 1), depois de a 0142 ter escrito "nenhuma função nova, então
--       não há grant a revogar": leitura de uma doutrina que fala de FUNÇÃO.
--
--       Aqui revoga-se de `authenticated` também (a 0143 revogou só de `anon`),
--       porque nenhuma tela lê esta tabela pelo client de sessão — quem lê é o
--       `app/layout.tsx`, no servidor. O privilégio é a camada que sobra no dia
--       em que alguém acrescentar "só uma policy de leitura".
--
-- ⚠️ `accent_hex` tem CHECK de REGEX, não de conjunto: ela NÃO entra na lista
-- `PARES` de `tests/invariants/vocabulario-banco-x-typescript.test.ts`, cujo
-- extrator só reconhece `= ANY (ARRAY[...])`. A doutrina "coluna nova com CHECK
-- → uma linha ali" vale para CHECK de CONJUNTO.
--
-- Sem `event_log`: nenhum dos 12 handlers de `lib/event-log/register-handlers.ts`
-- cobriria um tipo `platform_branding.*`, e o drain deixa evento sem handler
-- intocado — a linha nasceria `pending` para sempre em todo clone (anti-pattern
-- nº 3). O registro é `audit()`, com consumidor real.
--
-- Idempotente e auto-curativo: `create table if not exists` + `drop trigger if
-- exists` antes do `create trigger`; grants e revokes são declarativos e podem
-- ser reaplicados. Nenhuma constraint nova sobre dado existente (a tabela nasce
-- vazia), então não há o que deduplicar antes.

create table if not exists public.platform_branding (
  id                  smallint primary key default 1,
  app_name            text,
  logo_url            text,
  accent_hex          text,
  show_powered_by     boolean     not null default true,
  seeded_from_env     boolean     not null default false,
  -- Estado, não configuração: é o que torna a falha OBSERVÁVEL (invariante 6 da
  -- doutrina Sistema Vivo). Sem estas duas, o degrade ("o produto ficou com a
  -- cor dele") é indistinguível de "a feature nunca foi instalada".
  fallback_at         timestamptz,
  fallback_reason     text,
  updated_at          timestamptz not null default now(),
  updated_by          uuid,
  constraint platform_branding_singleton  check (id = 1),
  constraint platform_branding_accent_hex check (accent_hex is null or accent_hex ~ '^#[0-9a-f]{6}$')
);

comment on table public.platform_branding is
  'Marca da INSTALAÇÃO (login, e-mail, 500) — linha única id=1. Semeada do .env na primeira leitura; para NOME e LOGO o .env continua sendo a rede de segurança de rollback (o agent.sh reverte a imagem, não o banco). Para COR não há rede: APP_ACCENT_HEX nasceu junto com esta tabela e o install.sh não o grava — nenhuma versão que desconheça platform_branding pinta accent. Lida/escrita só server-side (service_role). Ver lib/branding/instalacao.ts.';

comment on column public.platform_branding.seeded_from_env is
  'true = os valores vieram do .env e ninguém os editou pela tela. A escrita humana zera isto, e é o que impede a semeadura de reescrever o que uma pessoa apagou de propósito.';

comment on column public.platform_branding.fallback_at is
  'Quando a cor configurada foi RECUSADA e o produto caiu na cor dele. NULL = nenhuma recusa em vigor.';

comment on column public.platform_branding.fallback_reason is
  'Códigos de recusa (FORMA, nunca o hex da marca). Escrito e limpo por lib/branding/instalacao.ts.';

alter table public.platform_branding enable row level security;

-- ZERO POLICIES, DE PROPÓSITO — ver o bloco acima.

revoke all on public.platform_branding from anon, authenticated;
grant select, insert, update on public.platform_branding to service_role;

drop trigger if exists trg_platform_branding_touch on public.platform_branding;
create trigger trg_platform_branding_touch
  before update on public.platform_branding
  for each row execute function public.fn_touch_updated_at();

notify pgrst, 'reload schema';


-- ---- logo da marca: BUCKET e COLUNA (migration 0158) ----
--
-- A segunda metade da 0158. As funções estão ANTES do bloco da VARREDURA anon,
-- e a razão de a migration entrar em dois pedaços está escrita lá: este pedaço
-- depende de `platform_branding`, criada no bloco da 0155, que é o último do
-- arquivo — e aquele pedaço cria função, o que a varredura proíbe depois dela.
--
-- ─── Por que o bucket é PÚBLICO — o primeiro do repositório ─────────────────
--
-- Os quatro que já existiam (`ai-policy`, `lgpd-exports`, `skill-assets`,
-- `whatsapp-media`) nascem `public = false`. Este não, e a razão é medida: o logo
-- é renderizado num `<img>` da tela de LOGIN (`app/(public)/layout.tsx`), servida
-- a quem NÃO tem sessão. URL assinada exige um segredo por requisição e VENCE — a
-- marca da instalação sumiria da fachada no dia do vencimento, sem ninguém tocar
-- em nada, e "o logo sumiu" não apontaria para a causa.
--
-- O que mantém a exceção contida, e o que `tests/invariants/marca-logo.test.ts`
-- mede:
--   * bucket EXCLUSIVO de logo — nada de conversa, export ou base de conhecimento
--     mora aqui, então "público" não vaza histórico de cliente nenhum;
--   * ZERO policy em `storage.objects` para ele. `public = true` no Supabase abre
--     a LEITURA pelo endpoint `/object/public/...`; não abre INSERT nem DELETE,
--     que continuam só pelo `service_role`, pela rota, depois dos gates;
--   * caminho não-enumerável (`<prefixo>/<uuid v4>.<png|jpg>`);
--   * `allowed_mime_types` é BACKSTOP, não a defesa — o Storage compara com o
--     header que QUEM SOBE escolheu. Quem decide é o farejador de bytes em
--     `lib/branding/logo-arquivo.ts`.
--
-- Registrado em `docs/threat-model.md` ao lado da linha de `whatsapp-media`.
--
-- ─── Por que 512 KB ────────────────────────────────────────────────────────
--
-- `next.config.ts` roda com `images.unoptimized` e os dois renders do logo usam
-- `<img>` cru (a URL é de quem hospeda; `next/image` exige allowlist fechada em
-- BUILD e a imagem é pré-buildada). O arquivo vai INTEIRO para o navegador em
-- toda página. E a cota do Supabase é do CLIENTE — 1 GB no plano gratuito,
-- compartilhado com `whatsapp-media`, que não tem poda.
--
-- Idempotente e auto-curativo: `on conflict do update` no bucket (o `update.sh`
-- de um clone precisa CONVERGIR, não só criar), `add column if not exists`, e o
-- BACKFILL vem antes da constraint — o `update.sh` roda SEM `ON_ERROR_STOP`, e
-- uma constraint que estourasse deixaria a coluna sem validação em silêncio.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('brand-logos', 'brand-logos', true, 524288, array['image/png', 'image/jpeg'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

alter table public.platform_branding
  add column if not exists logo_path text;

comment on column public.platform_branding.logo_path is
  'Caminho do arquivo de logo em storage/brand-logos, sempre platform/<uuid>.<png|jpg>. Caminho e NÃO url: a url é função determinística do caminho + host do projeto (DIRC-C), e gravá-la amarraria a marca ao host de hoje. Vence logo_url, que continua como rede de rollback do .env. Escrito por app/api/v1/marca/logo/route.ts.';

update public.platform_branding
   set logo_path = null
 where logo_path is not null
   and logo_path !~ '^platform/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg)$';

-- `drop if exists` + `add`, e não `add ... if not exists` (que o Postgres não tem
-- para constraint): é o que torna a REGRA idempotente, e não só a criação.
alter table public.platform_branding
  drop constraint if exists platform_branding_logo_path;
alter table public.platform_branding
  add constraint platform_branding_logo_path check (
    logo_path is null
    or logo_path ~ '^platform/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg)$'
  );

-- ⚠️ CHECK de REGEX, não de conjunto: fica FORA da lista `PARES` de
-- `tests/invariants/vocabulario-banco-x-typescript.test.ts`, cujo extrator só
-- reconhece `= ANY (ARRAY[...])` e estoura sobre regex. Mesma razão de
-- `platform_branding_accent_hex`.

notify pgrst, 'reload schema';


-- ---- o teto de IA que vincula (migration 0159) ----
--
-- ⚠️ ESTE BLOCO EXISTE EM DOIS ARQUIVOS, PALAVRA POR PALAVRA:
-- `supabase/migrations/20260814210000_0159_o_teto_que_vincula.sql` (o que o
-- Supabase CLI aplica) e o FIM de `supabase/baseline.sql` (o que o kit self-host
-- aplica, no `install.sh` e no `update.sh`).
-- `tests/unit/migracao-nao-arma-ninguem.test.ts` compara os dois textos: divergir
-- significa que o self-hoster recebe um SQL diferente do que a migration afirma,
-- e é justamente o par que ninguém confere lendo só um dos dois.

-- (1) DDL. Idempotente; re-aplicar é no-op. A linha que já existe recebe 'off'
--     pelo próprio ALTER — não há UPDATE nenhum aqui, e é essa ausência que
--     torna impossível esta migration armar alguém.
alter table public.ai_budgets
  add column if not exists enforcement_mode text not null default 'off';
alter table public.ai_budgets
  add column if not exists enforcement_effective_at timestamptz;

comment on column public.ai_budgets.enforcement_mode is
  'A INTENÇÃO, declarada por um admin — nunca inferida do valor do teto. off = só acompanhar (a IA nunca para por gasto); avisar = abre budget_warning ao passar do limiar e SEGUE; bloquear = recusa a chamada quando o gasto atinge o teto. Nasce off por DEFAULT do ALTER, e é por isso que ligar o teto no gate não estrangula quem herdou o DEFAULT 5000 de monthly_limit_cents. Escrito só por PATCH /api/v1/ai/budget (admin, auditado); lido por lib/agent-engine/edge/llm/credentials.ts.';

comment on column public.ai_budgets.enforcement_effective_at is
  'Carência: a partir de quando bloquear passa a valer de fato (now()+72h ao armar pela tela). Nasce NULL, e null <= now() é null — nunca verdadeiro —, então modo bloquear sem esta data ainda não bloqueia. Existe para que armar a proteção não seja um interruptor que corta o WhatsApp do negócio no mesmo instante, sem ninguém ver o aviso antes.';

-- (2) DADOS — RESGATE B->A.
--
-- >>> RESGATE B->A: INICIO <<<
--
-- O ÚNICO bloco desta migration que escreve 'bloquear', e o único que escreve
-- `monthly_limit_cents`. Ele preserva o comportamento de HOJE para a única
-- população que hoje PODE ser bloqueada: quem tem
-- `organizations.settings.llm.monthly_budget_cents` com um número vigente.
--
-- Sem carência (`now()`, não `now()+72h`): essa organização JÁ está capada nesse
-- número, e dar 72h de folga AFROUXARIA o que ela apertou de propósito.
--
-- Garante a linha ANTES do update, porque nenhum gatilho de `organizations`
-- semeia `ai_budgets` — os produtores são o gatilho de `llm_calls`, os dois
-- backfills do baseline e o PATCH. Sem o insert, uma organização com teto vigente
-- e sem linha perderia o bloqueio no instante em que a chave jsonb saísse em (3).
insert into public.ai_budgets (organization_id)
select o.id from public.organizations o
 where jsonb_typeof(o.settings->'llm'->'monthly_budget_cents') = 'number'
   and (o.settings->'llm'->>'monthly_budget_cents')::numeric >= 100
   and (o.settings->'llm'->>'monthly_budget_cents')::numeric <= 2147483647
on conflict (organization_id) do nothing;

update public.ai_budgets b
   set monthly_limit_cents      = (o.settings->'llm'->>'monthly_budget_cents')::numeric::integer,
       enforcement_mode         = 'bloquear',
       enforcement_effective_at = now(),
       updated_at               = now()
  from public.organizations o
 where o.id = b.organization_id
   and jsonb_typeof(o.settings->'llm'->'monthly_budget_cents') = 'number'
   and (o.settings->'llm'->>'monthly_budget_cents')::numeric >= 100
   and (o.settings->'llm'->>'monthly_budget_cents')::numeric <= 2147483647;
--
-- As três condições, e cada uma existe para não derrubar o `update.sh` de um
-- clone ou para não apertar quem ninguém apertou:
--
--   * `jsonb_typeof = 'number'` e NÃO `is not null`: o jsonb `'null'` e um valor
--     com forma errada (string) caem fora. `('"700"'::jsonb->>...)::numeric`
--     funcionaria, mas `'abc'` levantaria 22P02 dentro do `update.sh` de um clone,
--     e a doutrina proíbe migration que quebra. Espelha exatamente o `.catch(null)`
--     do Zod em `credentials.ts`: valor com forma errada JÁ é `null` (ilimitado)
--     hoje, então não resgatar é PRESERVAR.
--   * `>= 100` deixa fora o `0` (artefato de `scripts/smoke-llm.ts`, que grava '0'
--     e NÃO restaura) e o implausível. Um `0` ali bloqueia 100% das chamadas com
--     gasto zero — a inversão perfeita —, e trazê-lo DESARMADO conserta. É a única
--     vez que esta migration muda comportamento, e é na direção que AFROUXA.
--   * `<= 2147483647` porque `monthly_limit_cents` é `integer`. Medido em pg17:
--     `('{"a":1e20}'::jsonb->>'a')::numeric::integer` levanta `22003 integer out of
--     range`, e `jsonb_typeof` daquilo é 'number'. É jsonb LIVRE, editável por
--     qualquer acesso privilegiado ao banco; sem este corte, uma linha assim
--     abortaria o statement dentro de um `update.sh` sem `ON_ERROR_STOP` — erro
--     engolido, resgate não feito, exit 0. Fora do intervalo não é orçamento, é
--     erro de unidade, e erro de unidade não pode calar a IA nem quebrar o kit.
--
-- >>> RESGATE B->A: FIM <<<

-- (3) A duplicata some, para não haver duas verdades. Uma instrução, sem
--     read-modify-write de aplicação — o padrão que a 0157 curou depois de medir
--     perda real de chave irmã em `organizations.settings` (`visibility_mode`
--     voltando de 'own' para 'all' em silêncio, e ele é lido DIRETO pela RLS).
update public.organizations
   set settings = jsonb_set(settings, '{llm}', (settings->'llm') - 'monthly_budget_cents')
 where jsonb_typeof(settings->'llm') = 'object'
   and settings->'llm' ? 'monthly_budget_cents';
-- Idempotência: a segunda passada casa 0 linhas (a chave já saiu), o que também
-- torna (2) idempotente sem precisar de guarda de catálogo.

-- (4) SANEAMENTO. `is_throttled` só teve escritor no cron morto
--     (`workers/ai-budget-checker.cron.ts`, sem rota e sem linha no
--     `docker/scheduler/entrypoint.sh`), então qualquer `true` é estado preso.
--     `is_disabled` NÃO é tocado: significaria "um admin desligou", e limpá-lo
--     religaria IA que alguém desligou de propósito.
update public.ai_budgets set is_throttled = false where is_throttled;

-- (5) CONSTRAINT — depois dos dados, sempre (doutrina de migrations, item 8). O
--     `update.sh` roda SEM `ON_ERROR_STOP` e engoliria um 23514, deixando a
--     coluna sem validação em silêncio. `drop if exists` + `add`, e não
--     `add ... if not exists` (que o Postgres não tem para constraint): é o que
--     torna a REGRA idempotente, e não só a criação.
alter table public.ai_budgets
  drop constraint if exists ai_budgets_enforcement_mode_check;
alter table public.ai_budgets
  add constraint ai_budgets_enforcement_mode_check
  check (enforcement_mode in ('off', 'avisar', 'bloquear'));

alter table public.ai_budgets
  drop constraint if exists ai_budgets_bloquear_precisa_de_teto;
alter table public.ai_budgets
  add constraint ai_budgets_bloquear_precisa_de_teto
  check (enforcement_mode <> 'bloquear' or monthly_limit_cents >= 100);
-- Os dados já satisfazem: 'bloquear' só foi escrito em (2), onde o jsonb era
-- >= 100. O CHECK é o backstop de "armado sem valor útil" tentando renascer pela
-- porta da frente — a régua da vez é o 422 da rota, não ele.
--
-- ⚠️ SÓ `ai_budgets_bloquear_precisa_de_teto` é CHECK cross-coluna / de domínio,
-- e por isso fica FORA da lista `PARES` de
-- `tests/invariants/vocabulario-banco-x-typescript.test.ts` — mesma classificação
-- que os CHECKs de regex da 0155/0157/0158.
--
-- `ai_budgets_enforcement_mode_check` É de vocabulário: um conjunto fechado com
-- par em TypeScript (`ModoDeOrcamento`, em
-- `lib/agent-engine/edge/llm/orcamento.ts`), lido no caminho quente. Ele ESTÁ em
-- `PARES`. Classificá-lo como domínio — o que este comentário e o MANIFEST
-- fizeram — deixava a coluna fora do único gate que pega a classe: um valor novo
-- entra num lado só, passa em typecheck/lint/unit, e aparece como 23514 em
-- produção.

-- (6) INFORMAÇÃO, nunca alarme. Item `info` para as organizações cujo
--     `is_disabled` foi posto à mão (HIPÓTESE: conjunto vazio — nenhum escritor
--     vivo jamais rodou): a flag para de agir quando o guard legado de
--     `workers/ai-response-worker.ts` é repontado para a regra canônica. Mudança
--     real, declarada, não escondida — e `info` porque nada quebrou.
insert into public.agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
select b.organization_id, 'budget_warning', 'info',
       'A pausa antiga de IA por gasto foi desligada',
       'Esta organização estava marcada como desabilitada por gasto num mecanismo '
       'que nunca teve como ser reativado. Para voltar a parar a IA no limite, use '
       'Uso de IA › Orçamento e escolha "Parar a IA ao chegar no limite".',
       'ai_budget', b.organization_id
  from public.ai_budgets b
 where b.is_disabled
   and not exists (
     select 1 from public.agent_inbox_items i
      where i.organization_id = b.organization_id
        and i.kind = 'budget_warning' and i.status = 'open'
   );

notify pgrst, 'reload schema';


-- ---- ai_budgets só se escreve pela rota (migration 0160) ----
--
-- A 0159 pôs em `ai_budgets` os dois campos que decidem se (e quando) a IA para
-- de responder. Toda a regra que os protege — escada `off → avisar → bloquear`,
-- carência de 72h, piso de US$ 1,00 e linha em `api_audit_log` — mora na rota
-- `PATCH /api/v1/ai/budget`, que usa service role. Mas o corpo deste dump traz
-- `GRANT ALL ON TABLE public.ai_budgets TO anon` e `TO authenticated`, e a 0159
-- termina com `notify pgrst, 'reload schema'`: as colunas novas passaram a ser
-- SERVIDAS pelo PostgREST para a chave anon, que vai ao browser. Um PATCH direto
-- na REST do Supabase, com o JWT de um admin do tenant, armava a parada sem
-- escada, sem carência, sem piso e sem auditoria — o comentário da coluna dizia
-- "escrito só por PATCH /api/v1/ai/budget" e era verdade sobre o CÓDIGO, falso
-- sobre o SCHEMA.
--
-- Medido antes de revogar: TODO escritor de `ai_budgets` no repositório usa
-- service role (a rota, `lib/ai/budget/check.ts`, os painéis de admin, os
-- workers e `scripts/qa-wave-11.ts`). Nenhum caminho de produto escreve esta
-- tabela com o JWT do usuário.
--
-- SELECT fica: ler o próprio orçamento pelo PostgREST continua escopado pela
-- policy de SELECT da 0150. `revoke` é idempotente por natureza — este bloco
-- pode ser re-aplicado à vontade pelo `update.sh`.
revoke insert, update, delete on table public.ai_budgets from authenticated, anon;

-- ---- o arquivo do webhook pode perder o corpo (migration 0163) ----
--
-- `webhook_events_log` guarda o payload cru de todo webhook e NUNCA era podado.
-- Medido numa instalação real em 20/08/2026: o banco inteiro em 545 MB, dos
-- quais 468 MB (86%) eram esta tabela — contra 3,2 MB de `messages`. Nenhuma
-- linha com mais de 30 dias: as 56.291 eram de 20 dias. Cresce ~23 MB/dia, e o
-- teto do plano gratuito do Supabase é 500 MB, que é onde a maioria dos clones
-- vive.
--
-- ESVAZIAR o corpo, e não apagar a linha: as três colunas pesadas são ~97% do
-- peso, e a linha sem elas custa ~200 B. Assim o índice forense inteiro
-- (provider, tipo, id externo, horário, assinatura, desfecho) sobrevive por
-- ~11 MB — e é ele que responde as perguntas de depois do incidente.
--
-- `raw_body` precisa aceitar NULL para que "descartado" não se confunda com
-- "corpo vazio", que é caso real (webhook de ping). Medido antes de afrouxar:
-- nenhum leitor consulta essa coluna no repositório inteiro.
--
-- `archived_at` já existia na tabela e não tinha NENHUM dono (0 linhas com
-- valor em 56.350) — promessa de esqueleto, anti-pattern nº 3. Ganha dono aqui
-- em vez de nascer uma coluna nova com o mesmo significado.
alter table public.webhook_events_log
  alter column raw_body drop not null;

comment on column public.webhook_events_log.raw_body is
  'Corpo cru como o provedor mandou. NULL = existiu e foi descartado pela retenção; `archived_at` diz quando.';

comment on column public.webhook_events_log.archived_at is
  'Quando as colunas pesadas (raw_body, payload_parsed, headers) foram descartadas pela retenção. NULL = a linha ainda tem o corpo.';

-- PARCIAL: a varredura procura "velha e ainda com corpo", e o índice encolhe
-- sozinho conforme a poda avança — o oposto de um índice sobre a tabela toda,
-- na única tabela que este bloco existe para impedir que cresça.
create index if not exists webhook_events_log_a_esvaziar_idx
  on public.webhook_events_log (received_at)
  where archived_at is null;

notify pgrst, 'reload schema';


-- ---- índice do cap global do claim da fila (migration 0166) ----
--
-- O QUÊ: um índice parcial em `job_queue (status) where status = 'running'`.
--
-- POR QUÊ: `claimJobs` (lib/agent-engine/queue/queue.ts) abre TODA rodada com
-- `select count(*) from job_queue where status = 'running'` — o cap global de
-- concorrência — e nenhum dos quatro índices da tabela serve esse predicado. O
-- parcial das lanes (`uniq_job_queue_one_running_per_contact`) chega perto e não
-- vale: o predicado dele é mais ESTREITO (exclui `contact_id is null`, que é
-- todo `watchdog`/`flywheel`), então o planejador não pode responder por ele.
-- Medido em pg17 com este baseline, 50.000 linhas `done` + 4 `running`:
-- Seq Scan / 715 buffers → Index Only Scan / 3 buffers. E o custo NÃO depende de
-- linha viva: com as 50.004 apagadas na mesma transação o Seq Scan ainda lê os
-- mesmos 715 buffers, porque ele visita página e não tupla. Fila é escrita o
-- tempo todo e nada no produto a poda.
--
-- O bloco `do $$` existe porque `create index if not exists` casa por NOME e não
-- por definição — medido em pg17, um homônimo com outra definição vira `NOTICE:
-- ... already exists, skipping`, que nem chega ao filtro `ERROR|FATAL` do
-- `update.sh`. Homônimo NOSSO em `job_queue` é derrubado e recriado; homônimo em
-- outro objeto NÃO é apagado (não é nosso) — a atualização grita com a razão, o
-- que é o comportamento certo num script que roda sem `ON_ERROR_STOP`.
--
-- O `comment on index` é o DELATOR: índice ausente levanta `relation ... does
-- not exist`, texto que NÃO casa com nenhum termo da lista benigna do
-- `update.sh` e portanto aparece ao operador — enquanto `already exists` seria
-- engolido. Aditivo e idempotente: sem constraint, sem backfill, sem dado tocado.
do $$
declare
  v_relkind "char";
  v_def     text;
  v_tabela  text;
begin
  select c.relkind,
         case when c.relkind in ('i', 'I') then pg_get_indexdef(c.oid) end,
         t.relname
    into v_relkind, v_def, v_tabela
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_index i on i.indexrelid = c.oid
    left join pg_class t on t.oid = i.indrelid
   where n.nspname = 'public'
     and c.relname = 'idx_job_queue_running';

  if v_relkind is null then
    return;
  end if;

  if v_relkind not in ('i', 'I') or v_tabela is distinct from 'job_queue' then
    raise exception
      'o nome idx_job_queue_running já está tomado em public (relkind=%, tabela=%). '
      'Nome de índice é único por SCHEMA, então o create index if not exists desta '
      'atualização vira no-op silencioso e o claim da fila continua varrendo a tabela '
      'inteira a cada rodada. Não apago o objeto porque ele não é nosso: renomeie-o e '
      'rode a atualização de novo.', v_relkind, coalesce(v_tabela, '(nenhuma)');
  end if;

  if v_def !~ 'USING btree \(status\)' or v_def !~ 'WHERE \(status = ''running''' then
    execute 'drop index public.idx_job_queue_running';
  end if;
end
$$;

create index if not exists idx_job_queue_running
  on job_queue (status) where status = 'running';

comment on index idx_job_queue_running is
  'Cap global do claim: select count(*) from job_queue where status = ''running'' '
  '(lib/agent-engine/queue/queue.ts). Sem ele o claim faz Seq Scan a cada rodada — '
  '715 buffers com 50 mil linhas, e o mesmo custo com zero linha viva, porque Seq '
  'Scan visita página e não tupla. Este COMMENT é o delator do bloco: índice ausente '
  'vira "relation does not exist", que NÃO casa com o filtro benigno do update.sh e '
  'chega ao operador; "already exists" seria engolido.';

-- ---- identificador de canal único entre os ATIVOS (migration 0165) ----
--
-- O QUÊ: dois índices únicos PARCIAIS — um em `meta_phone_number_id`, outro em
-- `zernio_account_id` —, ambos com `where archived_at is null`, precedidos da
-- deduplicação dos dados que os violariam.
--
-- POR QUÊ: `waha_session_name` e `webhook_path_token` são UNIQUE desde o
-- snapshot; os dois identificadores que chegaram depois (0087 e 0131) nasceram
-- sem trava, e é por eles que o código resolve credencial de envio e a
-- ORGANIZAÇÃO dona de uma mensagem que acabou de entrar. Com duas linhas
-- casando, o PostgREST devolve `data: null` com `PGRST116` (não "a primeira
-- linha"), e o `error` era descartado nos três sítios: os dois resolvedores
-- caíam no fallback do `.env` — a mensagem saía pela conta de OUTRA instalação
-- — e a ingestão do canal oficial descartava a mensagem recebida para as DUAS
-- organizações, respondendo 200 (issue #236). A colisão é atingível por
-- CONFIGURAÇÃO LEGÍTIMA (agência, migração de conta entre organizações), não só
-- por abuso.
--
-- PARCIAL, e não total, pelo precedente da 0107: canal arquivado é canal
-- excluído pelo usuário e a linha só sobrevive como âncora das FKs RESTRICT.
-- Trava total impediria reconectar o mesmo número depois de excluí-lo. O recorte
-- é o MESMO que as consultas de `lib/channels/` passam a usar.
--
-- AUTO-CURATIVO: o `update.sh` de um clone roda SEM `ON_ERROR_STOP` e engoliria
-- o 23505 da criação do índice, deixando o clone sem trava e sem aviso. Por isso
-- a deduplicação vem ANTES. Ela NÃO apaga nem arquiva a linha perdedora — apagar
-- sessão de canal de um cliente é destrutivo, arquivar faria o canal sumir da
-- tela sem ninguém pedir: ela RENOMEIA o identificador da perdedora para
-- `<original>-conflito-<id da sessão>`. A linha continua visível, e como o
-- identificador novo não existe no provider, a varredura de saúde
-- (`app/api/v1/cron/channel-health`) grava `FAILED`/`STOPPED` na próxima passada
-- e ABRE aviso na Central (os três estados estão em `STATUS_QUE_AVISAM`), que é
-- o operador sendo avisado em vez de descobrir pelo cliente que não recebeu.
-- Fica com o identificador a sessão ativa MAIS RECENTE: criá-la exigiu provar
-- posse da conta na tela de conexão, então é a intenção mais recente.
--
-- IDEMPOTENTE: o sufixo carrega o `id` da sessão (único), então depois da
-- primeira passada não sobra duplicata e a segunda casa zero linhas — não há
-- como sufixar duas vezes. Os nomes dos índices são novos neste arquivo, então
-- o `if not exists` (que casa por NOME) não vira no-op em cima de um homônimo.

with ativos as (
  select id,
         row_number() over (
           partition by meta_phone_number_id
           order by created_at desc nulls last, id desc
         ) as posicao
    from public.channel_sessions
   where archived_at is null
     and meta_phone_number_id is not null
)
update public.channel_sessions s
   set meta_phone_number_id = s.meta_phone_number_id || '-conflito-' || s.id::text
  from ativos a
 where a.id = s.id
   and a.posicao > 1;

create unique index if not exists channel_sessions_meta_phone_number_id_ativo_unique
  on public.channel_sessions (meta_phone_number_id)
  where archived_at is null and meta_phone_number_id is not null;

with ativos as (
  select id,
         row_number() over (
           partition by zernio_account_id
           order by created_at desc nulls last, id desc
         ) as posicao
    from public.channel_sessions
   where archived_at is null
     and zernio_account_id is not null
)
update public.channel_sessions s
   set zernio_account_id = s.zernio_account_id || '-conflito-' || s.id::text
  from ativos a
 where a.id = s.id
   and a.posicao > 1;

create unique index if not exists channel_sessions_zernio_account_id_ativo_unique
  on public.channel_sessions (zernio_account_id)
  where archived_at is null and zernio_account_id is not null;

-- ---- superfície do pointer de follow-up (migration 0196) ----
-- IA vs automação CRM: um motor, duas listas. Default 'followup' deixa toda
-- linha já existente na superfície de IA. CHECK de conjunto (PARES).
alter table public.followup_flow_pointers
  add column if not exists surface text not null default 'followup';

alter table public.followup_flow_pointers
  drop constraint if exists followup_flow_pointers_surface_check;

alter table public.followup_flow_pointers
  add constraint followup_flow_pointers_surface_check
  check (surface in ('followup', 'crm_automation'));

comment on column public.followup_flow_pointers.surface is
  'Onde o fluxo aparece: followup = /app/ai/followups; crm_automation = CRM Automação. '
  'Vocabulário cobrado por tests/invariants/vocabulario-banco-x-typescript.test.ts.';

-- ---- inscrição Web Push (migrations 0197 e 0199) ----
-- Bandeja do sistema com a aba fechada. A policy abaixo já é a da 0199 (o
-- forward-fix de RBAC): quem atualiza recebe as duas de uma vez, e quem
-- instala do zero nunca chega a existir sem o `fn_role_at_least`.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_subscriptions_org_idx
  on public.push_subscriptions (organization_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists push_subscriptions_own on public.push_subscriptions;
create policy push_subscriptions_own on public.push_subscriptions
  for all
  using (
    organization_id in (select public.fn_user_org_ids())
    and user_id = auth.uid()
    and public.fn_role_at_least(organization_id, 'viewer')
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    and user_id = auth.uid()
    and public.fn_role_at_least(organization_id, 'viewer')
  );

revoke all on public.push_subscriptions from anon, public;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

comment on table public.push_subscriptions is
  'Inscrição Web Push por navegador. Envio é service role; a sessão só vê a própria linha.';

-- ---- a mensagem que responde outra (migration 0168) ----
-- O canal intermediado aceita citação (`replyTo` no envio, com o `wamid` da
-- citada) e o WhatsApp mostra a resposta pendurada na original. Sem guardar
-- QUEM foi citado, o CRM manda a citação para o cliente e não a mostra de volta
-- na própria tela: o atendente vê frases soltas onde o cliente vê um fio.
--
-- FK e não o wamid solto: a pergunta da tela é "qual mensagem NOSSA foi
-- citada?", e a resposta é uma linha desta tabela — inclusive quando ela ainda
-- não tem `external_id` (a nossa, enquanto está `queued`). O id que o provider
-- recebe sai da linha apontada, no envio.
--
-- `set null` no delete: apagar a citada não pode levar junto a resposta, que é
-- conteúdo próprio. Perder o fio é aceitável; perder a resposta é apagar
-- histórico por causa de um ponteiro.
alter table public.messages
  add column if not exists reply_to_message_id uuid
    references public.messages(id) on delete set null;
create index if not exists messages_reply_to_idx
  on public.messages (reply_to_message_id)
  where reply_to_message_id is not null;

notify pgrst, 'reload schema';

-- ---- histórico DURÁVEL de leads captados: tabela (migration 0174) ----
--
-- A SEGUNDA metade da 0174. A função e o trigger de LGPD estão ANTES do bloco
-- da VARREDURA anon, e a razão está escrita lá.
--
-- Quem publica uma landing page precisa responder depois: "chegou alguém?",
-- "com que dados?" e "de onde?". A única coisa que existia era o ARQUIVO
-- FORENSE (`webhook_events_log`), que é DESCARTÁVEL por desenho: o cron
-- `webhook-log-retention` zera `raw_body`/`payload_parsed`/`headers` em D+7 e
-- apaga a linha em D+90 (migration 0163). Foi a decisão certa — ele era 468 MB
-- de um banco de 545 MB numa instalação real — mas transforma qualquer
-- histórico construído sobre ele numa tela que MENTE a partir do sétimo dia.
--
-- O que esta tabela guarda e o arquivo não guardava: o IP em coluna tipada (lá
-- ele só existia solto dentro de `headers`, que é podado); o DESFECHO (o
-- arquivo registra "chegou um POST" e não sabe se virou lead, se caiu na
-- deduplicação, ou se foi RECUSADO — que é justamente o caso em que a pessoa
-- não vê nada hoje); e o nome da fonte NO MOMENTO da captação.
--
-- RLS exige `manager`: `fields` carrega o formulário como a pessoa preencheu, e
-- a policy de `webhook_events_log` é org-flat sem gate de papel — qualquer
-- `viewer` lê aquela PII pelo PostgREST, mesmo com a rota HTTP exigindo
-- manager. Não repetir o buraco. Sem policy de escrita: só o service role
-- escreve (a rota pública de captação), e ele bypassa RLS.
create table if not exists public.webhook_lead_captures (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  webhook_source_id uuid references public.webhook_sources(id) on delete set null,
  source_name text not null,
  lead_id uuid references public.crm_leads(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  outcome text not null
    check (outcome in ('criado', 'duplicado', 'recusado')),
  reject_reason text,
  captured_name text,
  captured_phone text,
  captured_email text,
  fields jsonb not null default '{}'::jsonb,
  utm jsonb not null default '{}'::jsonb,
  remote_ip inet,
  user_agent text,
  origin text,
  request_id uuid,
  received_at timestamptz not null default now()
);

create index if not exists webhook_lead_captures_org_recebido_idx
  on public.webhook_lead_captures (organization_id, received_at desc, id desc);
create index if not exists webhook_lead_captures_fonte_idx
  on public.webhook_lead_captures (webhook_source_id, received_at desc)
  where webhook_source_id is not null;
create index if not exists webhook_lead_captures_lead_idx
  on public.webhook_lead_captures (lead_id)
  where lead_id is not null;
create index if not exists webhook_lead_captures_poda_idx
  on public.webhook_lead_captures (received_at);

comment on table public.webhook_lead_captures is
  'Histórico DURÁVEL de leads captados por formulário/webhook: o que chegou, quando, de onde (IP, página, UTM) e no que deu. '
  'Distinto de webhook_events_log, que é arquivo forense e é PODADO (corpo em D+7, linha em D+90).';
comment on column public.webhook_lead_captures.remote_ip is
  'IP de origem do POST, lido de x-forwarded-for/x-real-ip. Informativo — forjável, nada no produto decide com base nele. NULL = não havia proxy à frente.';
comment on column public.webhook_lead_captures.outcome is
  'criado = virou lead novo; duplicado = mesmo external_id já capturado antes (retry da ferramenta); recusado = não entrou (reject_reason diz por quê).';
comment on column public.webhook_lead_captures.source_name is
  'Nome da fonte NO MOMENTO da captação. Cópia deliberada: a fonte pode ser renomeada ou excluída, e o histórico responde de onde o contato veio.';

alter table public.webhook_lead_captures enable row level security;

drop policy if exists "webhook_lead_captures_manager_read" on public.webhook_lead_captures;
create policy "webhook_lead_captures_manager_read" on public.webhook_lead_captures
  for select using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

-- O trigger vive aqui (e não com a função, no bloco de cima) porque só faz
-- sentido depois que a tabela existe.
drop trigger if exists trg_redigir_captacoes_ao_anonimizar on public.contacts;
create trigger trg_redigir_captacoes_ao_anonimizar
  after update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized is true and old.is_anonymized is distinct from true)
  execute function public.fn_redigir_captacoes_do_contato_anonimizado();


-- ---- a automação precisa poder dizer "ainda não" (migration 0175) ----
--
-- `automation_rule_runs.status` aceitava success/partial/failed. Faltava o
-- quarto estado que o motor JÁ produz: quando uma ação de envio pede adiamento
-- (fora da janela do número, cap diário), `runAutomationForEvent` devolve
-- `retry` e sai SEM GRAVAR LINHA NENHUMA — e a aba Atividade não mostra nada
-- enquanto isso. Para quem montou a regra, "não apareceu nada" e "não rodou"
-- são a mesma tela.
--
-- Valor novo em vez de reusar `partial`: `partial` é "algumas ações falharam" e
-- a tela pinta de amarelo com esse texto; adiamento não é falha nenhuma.
--
-- CHECK reconstruído em UM bloco só (lição do #159, a mesma de
-- `agent_inbox_items_kind_check`): N blocos quebram o `update.sh` de um clone
-- com vocabulário posterior. Aditiva — só alarga o conjunto, nada a corrigir
-- antes.
alter table public.automation_rule_runs
  drop constraint if exists automation_rule_runs_status_check;

alter table public.automation_rule_runs
  add constraint automation_rule_runs_status_check check (status in (
    'success',
    'partial',
    'failed',
    'adiado'
  ));

comment on column public.automation_rule_runs.status is
  'success = todas as ações funcionaram; partial = algumas falharam; failed = todas falharam; '
  'adiado = nada chegou ao cliente e ainda pode chegar — a regra espera a janela de envio do '
  'número, ou a mensagem ficou na fila do canal.';

notify pgrst, 'reload schema';

-- ---- agenda: o compromisso marcado — tabelas, cor do membro, RLS (migration 0177) ----
--
-- A SEGUNDA metade da 0177. A função de limpeza do vínculo está ANTES do bloco
-- da VARREDURA anon, e a razão está escrita lá.
--
-- O produto sabia agendar um RETORNO — o sistema volta a falar com o lead
-- daqui a X, em `cron_jobs` (kind='at', job_kind='followup_turn') — e não sabia
-- guardar o oposto: DUAS PESSOAS COMBINARAM ESTAR JUNTAS ÀS 14h DE QUINTA.
-- Retorno é decisão interna, não ocupa agenda de ninguém e o cliente não sabe;
-- compromisso tem hora, tem dono, ocupa a agenda de um atendente e foi
-- combinado com o cliente. Ficam separados, e a aresta entre eles é o índice
-- `calendar_appointments_org_vivos_idx`: quem tem consulta marcada não é lead
-- parado e não pode ser cobrado com "ainda tem interesse?".
--
-- NENHUMA tabela de jornada semanal: ela já existe em
-- `attendant_availability.schedule`, lida pelo roteamento de conversa e com
-- tela própria. A agenda lê aquela coluna com OUTRA régua (`windows` vazio ali
-- é 24/7; aqui é "não publicou horário" ⇒ zero slots) e não escreve outra.
-- A única tabela nova de disponibilidade é a de EXCEÇÃO por data, que é
-- informação que o jsonb não sabe dar.
--
-- Sem constraint de sobreposição de horário: exigiria `btree_gist`, que não
-- existe neste baseline nem no prelude do harness de teste — quebraria o
-- install de todo clone.
--
-- `calendar_connections` é a única com gate de papel, porque guarda token
-- OAuth: lê o DONO da conexão ou `manager`+. Os tokens são `bytea` cifrado por
-- `fn_encrypt_oauth`, cuja decifragem só `service_role` executa.
--
-- Aditiva e idempotente: seis tabelas novas e uma coluna nova e nullable numa
-- tabela existente. Nenhuma linha atual passa a violar nada.
-- ────────────────────────────────────────────────────────────────────────────
-- 1 · o molde: que tipos de compromisso esta organização marca
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.calendar_event_types (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  name text not null,
  -- Identificador legível e estável. NÃO é para URL pública (auto-agendamento
  -- ficou fora do escopo): serve para (a) impedir dois "Consulta" iguais na
  -- mesma organização e (b) dar à IA um handle que ela não alucina, ao
  -- contrário de um uuid. Renomear o tipo não muda o slug.
  slug text not null,
  description text,

  category text not null default 'outro',
  duration_minutes int not null default 30,
  buffer_before_minutes int not null default 0,
  buffer_after_minutes int not null default 0,
  minimum_notice_minutes int not null default 120,
  -- null = a grade anda de duração em duração. Preenchido, permite oferecer
  -- 09:00/09:15/09:30 para um serviço de 30min.
  slot_interval_minutes int,
  booking_window_days int not null default 60,

  color text,
  location_kind text not null default 'in_person',
  location_details text,
  requires_confirmation boolean not null default false,
  is_active boolean not null default true,

  -- ─── o lembrete, e por que ele é COLUNA e não detalhe de implementação ───
  -- Em canal oficial (meta_cloud, zernio) texto livre fora da janela de 24h é
  -- recusado — e o lembrete cai exatamente aí: a pessoa marca na terça, o
  -- lembrete sai na quinta, e ela não mandou mensagem desde então, que é o
  -- normal de quem já marcou. Medido em lib/channels/capabilities.ts:
  -- `freeformOutsideWindow` é true só para `waha`; meta_cloud e zernio exigem
  -- template, e o gate de envio (guardrails/before-send.ts) só abre a porta
  -- para `isTemplate === true`.
  --
  -- ⚠️ O que torna isto grave não é a recusa, é a FORMA dela: a API responde
  -- 200 com wamid e a Meta recusa a ENTREGA depois, pelo webhook (131047,
  -- re-engagement). Quem lê o 200 como "enviado" acha que funcionou. Sem esta
  -- coluna, num canal oficial, o lembrete NÃO SAI e o sistema ACHA QUE SAIU —
  -- o cliente falta à consulta e não há erro nenhum para investigar.
  --
  -- O mecanismo de mandar template já existe (`sendTemplateForSession`). O que
  -- não existia é o DADO que diz qual template este tipo de compromisso usa.
  reminder_enabled boolean not null default true,
  -- 1440 = 24h antes. É quanto tempo ANTES do compromisso o lembrete sai.
  reminder_minutes_before int not null default 1440,
  -- NULL = texto livre, que basta em WAHA. Preenchido, é o nome do template
  -- aprovado no provedor oficial. Cadastro e escolha de template são tela de
  -- outra wave; o que não podia era a coluna faltar.
  reminder_template_name text,

  -- `numeric`, NUNCA `int`: a lista é arrastável e o repo usa fractional
  -- indexing (CLAUDE.md § Modelagem, mesma razão de crm_leads.position_in_stage).
  position numeric not null default 1000,
  default_owner_user_id uuid references auth.users(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint calendar_event_types_category_check check (category in (
    'consulta','procedimento','retorno','visita','vistoria',
    'reuniao','call','orcamento','demonstracao','outro'
  )),
  constraint calendar_event_types_location_kind_check check (location_kind in (
    'in_person','phone','whatsapp','video_link','google_meet'
  )),
  -- Mesma forma de crm_stages_color_format, e a mesma tolerância a maiúscula.
  -- (platform_branding.accent_hex exige minúscula; é cor de MARCA, outra régua.)
  constraint calendar_event_types_color_format
    check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
  constraint calendar_event_types_duracao_sensata
    check (duration_minutes between 5 and 1440),
  constraint calendar_event_types_intervalo_sensato
    check (slot_interval_minutes is null or slot_interval_minutes between 5 and 1440),
  constraint calendar_event_types_lembrete_sensato
    check (reminder_minutes_before between 0 and 43200),
  constraint calendar_event_types_buffers_nao_negativos
    check (buffer_before_minutes >= 0 and buffer_after_minutes >= 0
           and minimum_notice_minutes >= 0 and booking_window_days > 0)
);

create unique index if not exists calendar_event_types_org_slug_key
  on public.calendar_event_types (organization_id, slug);
create index if not exists calendar_event_types_org_ativos_idx
  on public.calendar_event_types (organization_id, position)
  where is_active;

comment on table public.calendar_event_types is
  'O MOLDE de um compromisso: quanto dura, com que folga, com que antecedência mínima se marca. Distinto de calendar_appointments, que é o compromisso marcado — mudar o molde não reescreve o que já foi combinado.';
comment on column public.calendar_event_types.slug is
  'Handle estável e legível dentro da organização. Não é URL pública: serve para a IA referenciar o tipo sem inventar uuid, e para impedir dois tipos com o mesmo nome.';
comment on column public.calendar_event_types.minimum_notice_minutes is
  'Antecedência mínima para marcar. 120 = ninguém marca para daqui a meia hora. É o que impede a agenda de aceitar um encaixe que o atendente não tem como cumprir.';
comment on column public.calendar_event_types.slot_interval_minutes is
  'De quanto em quanto tempo a grade oferece horário. NULL = de duração em duração.';
comment on column public.calendar_event_types.reminder_template_name is
  'Nome do template aprovado no provedor, para o lembrete. NULL = texto livre, que basta em WAHA. Em canal oficial (meta_cloud, zernio) texto livre fora da janela de 24h é aceito com 200 e tem a ENTREGA recusada depois pelo webhook — sem template, o lembrete não sai e o sistema acha que saiu.';
comment on column public.calendar_event_types.reminder_minutes_before is
  'Quantos minutos ANTES do compromisso o lembrete sai. 1440 = 24h.';
comment on column public.calendar_event_types.category is
  'consulta/procedimento/retorno = clínica; visita/vistoria = imobiliária; reuniao/call = serviços e agência; orcamento = obra e serviço; demonstracao = loja e software; outro = qualquer. Espelha os nichos de lib/onboarding/pacotes-de-funil.ts.';

-- ────────────────────────────────────────────────────────────────────────────
-- 2 · o compromisso marcado
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.calendar_appointments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- `set null`: apagar o molde não pode apagar o histórico do que já aconteceu.
  event_type_id uuid references public.calendar_event_types(id) on delete set null,

  title text not null,
  description text,

  starts_at timestamptz not null,
  ends_at timestamptz not null,
  -- O fuso em que a pessoa MARCOU. Guardado porque "quinta às 14h" é o que foi
  -- combinado; o instante UTC sozinho não sabe dizer isso depois de uma virada
  -- de horário de verão. Sem CHECK: a validação de fuso é do Intl, e o repo já
  -- tem o lugar dela — `fusoValido` em lib/tempo/fusos.ts, aplicado no Zod.
  time_zone text not null default 'America/Sao_Paulo',

  status text not null default 'confirmed',

  -- O ATENDENTE dono. `set null` e não cascade: o compromisso aconteceu mesmo
  -- que a pessoa saia da empresa depois.
  owner_user_id uuid references auth.users(id) on delete set null,

  -- QUEM VAI SER ATENDIDO. `restrict` acompanha conversations.contact_id e
  -- messages.contact_id — as duas únicas FKs RESTRICT do schema, e existem
  -- pela mesma razão: apagar um contato não pode apagar o histórico dele. Na
  -- prática a LGPD deste produto anonimiza em vez de apagar (CLAUDE.md § LGPD),
  -- então o RESTRICT nunca é o caminho normal — é o cinto.
  contact_id uuid references public.contacts(id) on delete restrict,
  conversation_id uuid references public.conversations(id) on delete set null,

  location_kind text not null default 'in_person',
  location_details text,
  meeting_url text,
  notes text,

  cancellation_reason text,
  cancelled_at timestamptz,
  -- A cadeia de remarcações. `set null` porque a remarcação sobrevive ao
  -- sumiço do compromisso original.
  rescheduled_from_id uuid references public.calendar_appointments(id) on delete set null,

  -- QUEM MARCOU. O par `created_by_*` espelha `created_by_user_id`, que já
  -- existe em crm_leads e crm_lead_links.
  -- ⚠️ Os VALORES seguem crm_lead_activities.actor_kind ('user','ai','system',
  -- 'rule','contact') e não o par 'human'/'agent' que a outra tabela usa,
  -- porque é na timeline do lead que esta autoria vai ser RENDERIZADA: gravar
  -- 'human' aqui e 'user' lá faria a tela mostrar duas palavras para a mesma
  -- pessoa. 'sync' é o único acréscimo, e não é ator do produto: significa que
  -- a linha nasceu de um evento que já existia na agenda externa.
  created_by_kind text not null default 'user',
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_by_agent_id uuid references public.ai_agents(id) on delete set null,
  source text not null default 'ui',

  -- Lembrete: idempotência do lado do dado. Quem DISPARA é a fila
  -- (`cron_jobs` kind='at' agenda; `job_queue` executa), e o envio passa pela
  -- MESMA cadeia de saída do produto — janela horária, espaçamento, opt-out.
  -- Nenhum caminho novo de saída: esta base já pagou por uma automação com
  -- janela paralela.
  reminder_sent_at timestamptz,

  -- Espelho do Google. 1:1 e por isso mora aqui (DIRC: duplicar).
  google_connection_id uuid,
  google_calendar_id text,
  google_event_id text,
  google_ical_uid text,
  google_sequence int not null default 0,
  google_synced_at timestamptz,
  google_sync_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint calendar_appointments_status_check check (status in (
    'pending','confirmed','cancelled','completed','no_show'
  )),
  constraint calendar_appointments_location_kind_check check (location_kind in (
    'in_person','phone','whatsapp','video_link','google_meet'
  )),
  constraint calendar_appointments_created_by_kind_check check (created_by_kind in (
    'user','ai','system','contact','sync'
  )),
  constraint calendar_appointments_source_check check (source in (
    'ui','mcp','google_sync','public_page'
  )),
  constraint calendar_appointments_periodo_valido check (ends_at > starts_at),
  -- Regra de negócio em constraint SEPARADA da de vocabulário, de propósito:
  -- duas constraints casando `col in (...)` na mesma coluna fazem o extrator
  -- do invariante de vocabulário se recusar a escolher. É a mesma convivência
  -- de crm_leads.status com crm_leads_closed_at_consistency.
  constraint calendar_appointments_cancelamento_coerente check (
    (status <> 'cancelled' and cancelled_at is null)
    or (status = 'cancelled' and cancelled_at is not null)
  )
);

-- A grade: "o que há entre terça e domingo".
create index if not exists calendar_appointments_org_periodo_idx
  on public.calendar_appointments (organization_id, starts_at);
-- O filtro por pessoa, que é o requisito explícito da tela.
create index if not exists calendar_appointments_org_dono_idx
  on public.calendar_appointments (organization_id, owner_user_id, starts_at)
  where owner_user_id is not null;
-- A ARESTA COM O FOLLOW-UP (e com o Radar de Risco): "este lead tem consulta
-- marcada?". Quem tem compromisso vivo no futuro NÃO é lead parado, e cobrar
-- "ainda tem interesse?" de quem marcou para amanhã é o tipo de erro que faz
-- desinstalar o produto. Parcial nos dois estados vivos porque cancelado e
-- realizado não seguram ninguém. A consulta canônica, já que o vínculo com o
-- lead é polimórfico:
--   select 1 from crm_lead_links l join calendar_appointments a on a.id = l.target_id
--    where l.lead_id = $1 and l.target_kind = 'appointment'
--      and a.organization_id = $2 and a.status in ('pending','confirmed')
--      and a.starts_at > now();
create index if not exists calendar_appointments_org_vivos_idx
  on public.calendar_appointments (organization_id, starts_at)
  where status in ('pending','confirmed');
create index if not exists calendar_appointments_contato_idx
  on public.calendar_appointments (contact_id, starts_at desc)
  where contact_id is not null;
-- Idempotência do sync: o mesmo evento do Google não vira dois agendamentos.
-- O parceiro disto no código é a captura de `23505` no INSERT (CLAUDE.md
-- § Idempotência), não um SELECT-antes-de-inserir.
create unique index if not exists calendar_appointments_google_evento_key
  on public.calendar_appointments (organization_id, google_connection_id, google_event_id)
  where google_event_id is not null;

comment on table public.calendar_appointments is
  'O compromisso COMBINADO: hora marcada, com alguém, ocupando a agenda de um atendente. Distinto do RETORNO agendado (cron_jobs kind=at, job_kind=followup_turn), que é decisão interna do sistema, não ocupa agenda de ninguém e o cliente não sabe.';
comment on column public.calendar_appointments.time_zone is
  'O fuso em que foi marcado. "Quinta às 14h" é o que se combinou — o instante UTC sozinho não reconstrói isso depois de uma virada de horário de verão.';
comment on column public.calendar_appointments.created_by_kind is
  'user = pessoa da equipe pela tela; ai = agente de IA; system = o próprio produto; contact = o cliente (auto-agendamento, quando existir); sync = a linha nasceu de evento que já estava na agenda externa. Valores alinhados a crm_lead_activities.actor_kind, que é onde esta autoria aparece na tela.';
comment on column public.calendar_appointments.reminder_sent_at is
  'Carimbo de que o lembrete SAIU — idempotência do lado do dado, para remarcação ou reprocesso não avisarem duas vezes. Quem agenda o disparo é cron_jobs (kind=at); quem envia é a cadeia de saída do produto, com janela, espaçamento e opt-out.';
comment on column public.calendar_appointments.google_sequence is
  'O `sequence` do evento no Google. Ele exige que uma atualização venha com sequence >= o que está lá; guardar o nosso evita sobrescrever uma edição feita do lado de lá.';

-- ────────────────────────────────────────────────────────────────────────────
-- 3 · a exceção por data — a ÚNICA tabela nova de disponibilidade
-- ────────────────────────────────────────────────────────────────────────────
-- `attendant_availability.schedule` sabe dizer "atendo de segunda a sexta, das
-- 9h às 18h". Não sabe dizer "no dia 12 eu não atendo" nem "neste sábado, das
-- 9h ao meio-dia, atendo". Isso é informação NOVA — inflar o jsonb com ela é
-- que seria o lock-in do anti-pattern nº 6.
create table if not exists public.calendar_availability_exceptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,

  exception_date date not null,
  -- true = este pedaço do dia NÃO tem atendimento (o caso comum: feriado,
  -- férias, congresso). false = tem atendimento AQUI mesmo que a jornada
  -- semanal diga que não (o sábado excepcional).
  is_unavailable boolean not null default true,

  -- Minutos desde 00:00, NO MESMO FUSO da jornada da pessoa
  -- (`attendant_availability.schedule.timezone`). Minutos inteiros e não
  -- `time`: elimina a classe inteira de bug de fuso que um `time` carrega.
  --
  -- ⚠️ NOT NULL com default, e não nullable, e a razão é uma armadilha de
  -- Postgres: numa UNIQUE, NULL não colide com NULL. Com `start_minute`
  -- nullable, dois "dia 12 bloqueado o dia todo" para a mesma pessoa passariam
  -- os dois, em silêncio, e a tela mostraria a exceção duplicada. Dia inteiro
  -- é (0, 1440) — que é a mesma coisa e colide como deve.
  start_minute int not null default 0,
  end_minute int not null default 1440,
  reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint calendar_exceptions_faixa_valida
    check (start_minute >= 0 and end_minute <= 1440 and end_minute > start_minute)
);

create unique index if not exists calendar_exceptions_pessoa_dia_faixa_key
  on public.calendar_availability_exceptions (organization_id, user_id, exception_date, start_minute);
create index if not exists calendar_exceptions_org_dia_idx
  on public.calendar_availability_exceptions (organization_id, exception_date);

comment on table public.calendar_availability_exceptions is
  'O que a jornada semanal não sabe dizer: "neste dia não atendo" e "neste sábado atendo". A jornada continua morando em attendant_availability.schedule — esta tabela não a duplica, a excepciona.';
comment on column public.calendar_availability_exceptions.start_minute is
  'Minutos desde 00:00 no fuso da JORNADA da pessoa (attendant_availability.schedule.timezone), não em UTC. Dia inteiro = 0..1440.';
comment on column public.calendar_availability_exceptions.is_unavailable is
  'true = bloqueia esta faixa; false = ABRE esta faixa mesmo fora da jornada semanal.';

-- ────────────────────────────────────────────────────────────────────────────
-- 4 · a agenda conectada (BYO) — uma por PESSOA, não por organização
-- ────────────────────────────────────────────────────────────────────────────
-- `tenant_integrations` foi desenhada para OAuth com refresh e serviria — não
-- fosse a cardinalidade: ela tem UNIQUE (organization_id, provider), uma
-- conexão por organização. A agenda do Google é de cada atendente. Mudar
-- aquela unique reescreveria o contrato de uma tabela viva para servir outro
-- caso.
--
-- O que É reusado dela, porque é mecanismo e não modelo: a cifra
-- (`fn_encrypt_oauth`/`fn_decrypt_oauth`, pgp_sym AES-256 com a chave em
-- `private.fn_oauth_key()`, EXECUTE só para service_role), os nomes das
-- colunas de token, e o vocabulário de `status` — os SETE valores de
-- `tenant_integrations_status_check`, incluindo `rate_limited`, que é
-- justamente o estado que uma API de calendário mais produz.
create table if not exists public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,

  provider text not null default 'google_calendar',
  account_email text not null,

  -- `bytea`, como as nove colunas cifradas do repo. Passe o valor CRU de
  -- fn_encrypt_oauth (com o `\x`); tirar o prefixo é regra de quem guarda
  -- cifrado dentro de jsonb, e aqui não é o caso.
  oauth_access_token_encrypted bytea,
  oauth_refresh_token_encrypted bytea,
  token_expires_at timestamptz,
  scopes text[] not null default array[]::text[],

  status text not null default 'connecting',
  last_sync_at timestamptz,
  last_sync_error text,
  -- Sync incremental da CONTA. O do calendário individual mora na tabela de
  -- baixo, porque o Google versiona por calendário.
  sync_token text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint calendar_connections_provider_check check (provider in ('google_calendar')),
  constraint calendar_connections_status_check check (status in (
    'connecting','healthy','token_expired','scope_missing','disconnected','rate_limited','error'
  ))
);

create unique index if not exists calendar_connections_conta_key
  on public.calendar_connections (organization_id, user_id, provider, account_email);
-- A varredura do worker de renovação: quem está para vencer. Parcial porque
-- conexão desconectada não se renova.
create index if not exists calendar_connections_renovacao_idx
  on public.calendar_connections (token_expires_at)
  where status in ('healthy','rate_limited') and token_expires_at is not null;
create index if not exists calendar_connections_org_pessoa_idx
  on public.calendar_connections (organization_id, user_id);

comment on table public.calendar_connections is
  'A conta de agenda externa que UMA PESSOA conectou. Uma por atendente, e por isso não cabe em tenant_integrations, que é uma por organização e por provedor.';
comment on column public.calendar_connections.status is
  'connecting = o OAuth começou e ainda não voltou; healthy = renovando e sincronizando; token_expired = o refresh falhou com invalid_grant e SÓ a pessoa resolve, reconectando; scope_missing = conectou sem a permissão de calendário; rate_limited = o Google recusou por volume e vale tentar depois; disconnected = a pessoa desligou; error = falha que não se encaixa nas anteriores. Vocabulário idêntico ao de tenant_integrations.status — mesma pergunta, mesma palavra.';
comment on column public.calendar_connections.oauth_access_token_encrypted is
  'Cifrado por public.fn_encrypt_oauth (pgp_sym AES-256). NUNCA em claro. A chave vive em private.fn_oauth_key() e só service_role executa a decifragem.';
comment on column public.calendar_connections.token_expires_at is
  'Quando o access_token vence (~1h no Google). É o que o worker de renovação varre. Sem esse worker a integração morre em uma hora — e é por isso que o índice calendar_connections_renovacao_idx existe desde o primeiro dia, e não depois.';

-- ────────────────────────────────────────────────────────────────────────────
-- 5 · quais agendas daquela conta contam
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.calendar_connection_calendars (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null references public.calendar_connections(id) on delete cascade,

  external_calendar_id text not null,
  name text not null,
  is_primary boolean not null default false,
  -- O que este produto pergunta a cada agenda de fora: "você ocupa o horário
  -- desta pessoa?" e "você recebe o que eu marcar?". São perguntas diferentes:
  -- a agenda de aniversários ocupa nada e recebe nada; a pessoal ocupa e não
  -- recebe; a de trabalho faz as duas.
  counts_for_conflicts boolean not null default true,
  is_destination boolean not null default false,
  sync_token text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists calendar_connection_calendars_key
  on public.calendar_connection_calendars (organization_id, connection_id, external_calendar_id);
-- Só UM destino por conexão: se dois calendários recebessem, o mesmo
-- compromisso apareceria duas vezes na agenda da pessoa.
create unique index if not exists calendar_connection_calendars_um_destino_key
  on public.calendar_connection_calendars (connection_id)
  where is_destination;

comment on table public.calendar_connection_calendars is
  'As agendas dentro de uma conta conectada, e o que cada uma faz por nós: ocupar horário (counts_for_conflicts) e/ou receber o que marcamos (is_destination). São perguntas independentes.';

-- ────────────────────────────────────────────────────────────────────────────
-- 6 · o que veio de fora e ocupa a hora
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.calendar_external_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null references public.calendar_connections(id) on delete cascade,

  external_calendar_id text not null,
  external_event_id text not null,
  title text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  is_all_day boolean not null default false,
  status text not null default 'confirmed',
  -- O vocabulário é do próprio Google: `opaque` ocupa o horário, `transparent`
  -- não. Um evento marcado como livre lá não pode bloquear horário aqui.
  transparency text not null default 'opaque',
  external_updated_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint calendar_external_events_status_check check (status in (
    'confirmed','tentative','cancelled'
  )),
  constraint calendar_external_events_transparency_check check (transparency in (
    'opaque','transparent'
  )),
  constraint calendar_external_events_periodo_valido check (ends_at > starts_at)
);

create unique index if not exists calendar_external_events_key
  on public.calendar_external_events (organization_id, connection_id, external_calendar_id, external_event_id);
-- A pergunta do motor de slots: "o que ocupa esta janela?". Parcial, porque
-- evento cancelado ou marcado como livre não ocupa nada e só engordaria o
-- índice.
create index if not exists calendar_external_events_ocupam_idx
  on public.calendar_external_events (organization_id, external_calendar_id, starts_at)
  where status <> 'cancelled' and transparency = 'opaque';

comment on table public.calendar_external_events is
  'Espelho, somente-leitura, do que já existe na agenda conectada. Ocupa horário e aparece na grade, mas não é compromisso NOSSO: não tem lead, não tem estado de atendimento e nunca é reescrito por nós.';
comment on column public.calendar_external_events.transparency is
  'opaque = ocupa o horário; transparent = a pessoa marcou como livre lá, e não bloqueia nada aqui. É o vocabulário do próprio Google.';

-- ────────────────────────────────────────────────────────────────────────────
-- 7 · a cor da pessoa, na tabela de membros
-- ────────────────────────────────────────────────────────────────────────────
-- A cor é DA PESSOA NAQUELA ORGANIZAÇÃO, e por isso mora em user_organizations
-- e não em auth.users: quem trabalha em duas organizações pode ser verde numa
-- e azul na outra, e a cor de uma não vaza para a outra.
alter table public.user_organizations
  add column if not exists calendar_color text;

alter table public.user_organizations
  drop constraint if exists user_organizations_calendar_color_format;
alter table public.user_organizations
  add constraint user_organizations_calendar_color_format
  check (calendar_color is null or calendar_color ~ '^#[0-9a-fA-F]{6}$');

comment on column public.user_organizations.calendar_color is
  'Cor desta pessoa na grade da Agenda, nesta organização. NULL = a tela deriva uma cor estável do user_id, para ninguém nascer sem cor. ⚠️ A policy de SELECT desta tabela é self-OU-manager+: um `agent` NÃO lê a linha dos colegas pelo PostgREST. A tela recebe as cores pela rota que já monta o roster com service role (GET /api/v1/team), não por leitura direta.';

drop trigger if exists trg_limpar_vinculos_do_agendamento on public.calendar_appointments;
create trigger trg_limpar_vinculos_do_agendamento
  after delete on public.calendar_appointments
  for each row
  execute function public.fn_limpar_vinculos_do_agendamento();

-- ────────────────────────────────────────────────────────────────────────────
-- 9 · updated_at
-- ────────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'calendar_event_types','calendar_appointments','calendar_availability_exceptions',
    'calendar_connections','calendar_connection_calendars','calendar_external_events'
  ]
  loop
    execute format('drop trigger if exists trg_%s_updated_at on public.%I', t, t);
    execute format(
      'create trigger trg_%s_updated_at before update on public.%I
         for each row execute function public.fn_set_updated_at()', t, t);
  end loop;
end
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 10 · tenancy E PAPEL
-- ────────────────────────────────────────────────────────────────────────────
-- A primeira versão deste bloco dava `for all` só-tenancy às cinco tabelas de
-- agenda, e o invariante `rbac-config-ia-canais` reprovou as cinco. Ele estava
-- certo, e não é allowlist: `DIVIDA_RBAC_CONHECIDA` é uma CATRACA — a lista
-- congelada das tabelas que JÁ nasceram só-tenancy antes da migration 0150. O
-- teste se chama "a dívida de RBAC não cresce", e pôr tabela nova ali é
-- exatamente o movimento que ele existe para impedir.
--
-- A razão de fundo (migration 0150): `requireRole()` na rota Next NÃO é a única
-- porta. O PostgREST é exposto ao browser por construção — URL e anon key vão no
-- bundle — e um usuário logado fala com ele direto, com o próprio JWT. Uma
-- policy `for all` só-tenancy significa que o papel mais fraco do tenant escreve
-- tudo o que a organização tem.
--
-- Por tabela, e cada uma tem uma razão diferente:
--
--   event_types            lê membro · escreve manager+   é CONFIGURAÇÃO do
--     negócio: quanto dura uma consulta, que folga tem, quando se pode marcar.
--     O atendente usa; quem define é quem responde pelo negócio.
--
--   appointments           lê membro · escreve agent+     é a OPERAÇÃO do dia.
--     Marcar, remarcar e cancelar é o trabalho do atendente. O `viewer` vê a
--     agenda e não mexe nela.
--
--   availability_exceptions lê membro · escreve o DONO ou manager+
--     "No dia 12 eu não atendo" é da pessoa. Ela mesma escreve a sua, sem
--     depender de ninguém; manager+ escreve a dos outros porque escala é
--     trabalho de quem coordena.
--
--   connection_calendars   acompanha a conexão · escreve ninguém
--     Ele é filho de `calendar_connections` e herda o escopo dela, como
--     `crm_lead_links` herda o do lead. Quem escreve é o callback do OAuth.
--
--   external_events        lê membro · escreve NINGUÉM além de service_role
--     Vem do sync e é espelho. Escrita humana aqui só teria um caso de uso:
--     corromper a fonte de conflito, fazendo a agenda marcar em cima de
--     compromisso real. Ausência de policy de escrita é a decisão.
--
-- Nenhuma leva `for all` só-tenancy, e por isso nenhuma precisa entrar na
-- catraca.

-- ─── os tipos de agendamento: configuração do negócio ─────────────────────
alter table public.calendar_event_types enable row level security;
drop policy if exists tenant_isolation_calendar_event_types_all on public.calendar_event_types;
drop policy if exists calendar_event_types_select on public.calendar_event_types;
create policy calendar_event_types_select on public.calendar_event_types
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );
drop policy if exists calendar_event_types_write on public.calendar_event_types;
create policy calendar_event_types_write on public.calendar_event_types
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );
revoke all on public.calendar_event_types from anon;

-- ─── os compromissos: a operação do dia ───────────────────────────────────
alter table public.calendar_appointments enable row level security;
drop policy if exists tenant_isolation_calendar_appointments_all on public.calendar_appointments;
drop policy if exists calendar_appointments_select on public.calendar_appointments;
create policy calendar_appointments_select on public.calendar_appointments
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );
drop policy if exists calendar_appointments_write on public.calendar_appointments;
create policy calendar_appointments_write on public.calendar_appointments
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );
revoke all on public.calendar_appointments from anon;

-- ─── as exceções: a agenda é de quem a vive ───────────────────────────────
alter table public.calendar_availability_exceptions enable row level security;
drop policy if exists tenant_isolation_calendar_availability_exceptions_all on public.calendar_availability_exceptions;
drop policy if exists calendar_availability_exceptions_select on public.calendar_availability_exceptions;
create policy calendar_availability_exceptions_select on public.calendar_availability_exceptions
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );
drop policy if exists calendar_availability_exceptions_write on public.calendar_availability_exceptions;
create policy calendar_availability_exceptions_write on public.calendar_availability_exceptions
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and (user_id = auth.uid() or public.fn_role_at_least(organization_id, 'manager')))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and (user_id = auth.uid() or public.fn_role_at_least(organization_id, 'manager')))
  );
revoke all on public.calendar_availability_exceptions from anon;

-- ─── os calendários da conexão: herdam o escopo do pai ────────────────────
alter table public.calendar_connection_calendars enable row level security;
drop policy if exists tenant_isolation_calendar_connection_calendars_all on public.calendar_connection_calendars;
drop policy if exists calendar_connection_calendars_select on public.calendar_connection_calendars;
create policy calendar_connection_calendars_select on public.calendar_connection_calendars
  for select using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and exists (
          select 1 from public.calendar_connections c
           where c.id = connection_id
             and (c.user_id = auth.uid()
                  or public.fn_role_at_least(c.organization_id, 'manager'))
        ))
  );
revoke all on public.calendar_connection_calendars from anon;

-- ─── o espelho do Google: leitura de todos, escrita de ninguém ────────────
alter table public.calendar_external_events enable row level security;
drop policy if exists tenant_isolation_calendar_external_events_all on public.calendar_external_events;
drop policy if exists calendar_external_events_select on public.calendar_external_events;
create policy calendar_external_events_select on public.calendar_external_events
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );
revoke all on public.calendar_external_events from anon;

alter table public.calendar_connections enable row level security;

drop policy if exists tenant_isolation_calendar_connections_all on public.calendar_connections;
drop policy if exists calendar_connections_dono_ou_manager_read on public.calendar_connections;
create policy calendar_connections_dono_ou_manager_read on public.calendar_connections
  for select using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and (user_id = auth.uid() or public.fn_role_at_least(organization_id, 'manager')))
  );

-- Escrita não tem policy: quem conecta e desconecta é o callback do OAuth e o
-- worker de renovação, ambos com service role, e ambos filtram organization_id
-- de fonte confiável. Uma policy de escrita aqui só abriria caminho para
-- gravar token pelo PostgREST.
revoke all on public.calendar_connections from anon;

notify pgrst, 'reload schema';

-- ---- dois cliques não marcam duas vezes (migration 0182) ----
--
-- Entre a validação do motor de slots e o INSERT há uma janela em que o banco
-- não repete a pergunta: dois POSTs simultâneos para o mesmo horário passam OS
-- DOIS na checagem e criam dois agendamentos. É o duplo clique, e é a corrida
-- entre duas pessoas marcando o mesmo slot.
--
-- Não é a constraint de sobreposição que a 0177 recusou, e a distinção importa:
-- `exclude using gist` proibiria SOBREPOSIÇÃO (14h-15h contra 14h30-15h30, que é
-- o encaixe legítimo) e exigiria `btree_gist`, ausente deste baseline. Índice
-- único parcial é btree PURO e proíbe só a COINCIDÊNCIA EXATA de instante para o
-- mesmo dono.
--
-- ⚠️ `owner_user_id is not null` NÃO conserta buraco nenhum, e a primeira versão
-- deste comentário dizia que sim. Medido num pg17 descartável: com a condição e
-- sem ela, duas linhas com dono NULL no mesmo instante entram IGUAL — `NULL`
-- nunca colide com `NULL` numa UNIQUE, esteja a linha dentro ou fora do índice.
-- A condição fica porque mantém fora do índice o que nunca colidiria e porque
-- DECLARA o alcance da guarda (ela é sobre a agenda de uma PESSOA), não porque
-- proteja. Comentário que promete guarda inexistente é pior que nenhum: quem lê
-- para de procurar.
--
-- Custo declarado: proíbe dois compromissos do mesmo atendente no MESMO
-- instante, que numa clínica às vezes é o encaixe deliberado. A troca é
-- consciente, e a contrapartida é a rota devolver 409 dizendo QUAL compromisso
-- está ali — senão troca-se uma corrida rara por uma parede diária.
--
-- Deduplica ANTES da constraint, e deslocando em vez de apagar: cancelar a
-- duplicata destruiria um compromisso combinado com uma pessoa real, e isso uma
-- migration não faz. Nenhum clone tem linha nesta tabela hoje (nasceu na 0177 e
-- a rota que grava não existe); o bloco é para o clone que vier a ter.
-- ─── 1 · deduplicar deslocando, sem perder nenhum compromisso ──────────────
-- Empurra a 2ª, 3ª… ocorrência em 1 segundo cada, levando `ends_at` junto para
-- a duração não mudar. Em laço porque um deslocamento pode cair em cima de
-- outro instante já ocupado; 10 passadas cobrem qualquer caso real e o teto
-- impede laço infinito num dado patológico.
do $$
declare
  mexidas integer;
  passada integer := 0;
begin
  loop
    with duplicadas as (
      select id,
             row_number() over (
               partition by organization_id, owner_user_id, starts_at
               order by created_at, id
             ) - 1 as posicao
        from public.calendar_appointments
       where status in ('pending', 'confirmed')
         and owner_user_id is not null
    )
    update public.calendar_appointments a
       set starts_at = a.starts_at + (d.posicao * interval '1 second'),
           ends_at   = a.ends_at   + (d.posicao * interval '1 second')
      from duplicadas d
     where d.id = a.id
       and d.posicao > 0;

    get diagnostics mexidas = row_count;
    passada := passada + 1;
    exit when mexidas = 0 or passada >= 10;
  end loop;
end
$$;

-- ─── 2 · a guarda ─────────────────────────────────────────────────────────
create unique index if not exists calendar_appointments_sem_duplicata_idx
  on public.calendar_appointments (organization_id, owner_user_id, starts_at)
  where status in ('pending', 'confirmed') and owner_user_id is not null;

comment on index public.calendar_appointments_sem_duplicata_idx is
  'Fecha a janela entre a validação do motor de slots e o INSERT: dois POSTs simultâneos para o mesmo instante e o mesmo atendente não viram dois compromissos. Parcial em (pending, confirmed) porque cancelado e realizado não ocupam ninguém, e em owner_user_id não nulo porque NULL não colide com NULL numa UNIQUE — e porque agendamento sem atendente não ocupa agenda. Quem captura o 23505 é a rota, que devolve 409 dizendo qual compromisso está ali.';

notify pgrst, 'reload schema';

-- ---- a grade da agenda não se move sozinha (migration 0183) ----
--
-- `calendar_appointments` não estava na publicação: o `.channel()` sobe, o
-- `subscribe` devolve SUBSCRIBED, nenhum erro em lugar nenhum, e nenhum evento
-- chega nunca. Duas pessoas com a agenda aberta não veem o que a outra marcou.
-- Agravante de diagnóstico: nesta base o canal já morre calado por outro motivo
-- quando o token não chega ao socket, então quem investigar vai para o `setAuth`
-- e não para a publicação — dois defeitos com o MESMO sintoma.
--
-- SÓ ela entra, e a doutrina julga tabela a tabela: `calendar_external_events` é
-- espelho reescrito em lote pelo sync (200 eventos = 200 pulsos: o "pulso que
-- mente" da 0075 em forma de calendário); `calendar_connections` guarda token; as
-- de configuração mudam com quem já está na tela.
--
-- ⚠️ NÃO resolve o DELETE: `replica identity` tem zero ocorrência neste schema,
-- então o payload de DELETE traz só o `id` e um canal com `filter` por
-- `owner_user_id` não o recebe — o card apagado fica na tela até o F5. Não ligo
-- `replica identity full` aqui porque hoje não há assinante nenhum, e o custo em
-- WAL seria para servir um consumidor que não existe.
do $$
begin
  if not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    create publication supabase_realtime;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'calendar_appointments'
  ) then
    execute 'alter publication supabase_realtime add table public.calendar_appointments';
  end if;
end $$;

comment on table public.calendar_appointments is
  'O compromisso COMBINADO: hora marcada, com alguém, ocupando a agenda de um atendente. Distinto do RETORNO agendado (cron_jobs kind=at, job_kind=followup_turn), que é decisão interna do sistema, não ocupa agenda de ninguém e o cliente não sabe. ESTÁ na publicação supabase_realtime (migration 0183) porque marcar e cancelar é mudança de estado, não telemetria — mas o DELETE só traz o id, então um canal com filter por owner_user_id não o recebe.';

notify pgrst, 'reload schema';

-- ---- LGPD alcança a agenda: trigger (migration 0184) ----
--
-- A SEGUNDA metade da 0184. A função está ANTES do bloco da VARREDURA anon, e a
-- razão está escrita lá.
--
-- Redige o texto livre e PRESERVA `starts_at`, `ends_at`, `status` e
-- `owner_user_id`: a clínica precisa responder "quantos atendimentos houve em
-- março" depois de anonimizar. O QUE aconteceu e QUANDO fica; COM QUEM e SOBRE O
-- QUÊ sai.
--
-- `calendar_external_events` fica de fora e NÃO por esquecimento: ela não tem
-- `contact_id`, e o único vínculo com a pessoa é o `title` copiado do Google.
-- Alcançá-la exige uma decisão de produto — declarar que é espelho de terceiro,
-- ou apagar a janela da conexão.
drop trigger if exists trg_redigir_agenda_ao_anonimizar on public.contacts;
create trigger trg_redigir_agenda_ao_anonimizar
  after update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized is true and old.is_anonymized is distinct from true)
  execute function public.fn_redigir_agenda_do_contato_anonimizado();

comment on column public.calendar_appointments.notes is
  'Anotação livre do atendimento — numa clínica, queixa clínica. É dado pessoal: o trigger trg_redigir_agenda_ao_anonimizar (migration 0184) a apaga quando o contato é anonimizado, junto com title, description, location_details, meeting_url e cancellation_reason. Horário, status e dono são PRESERVADOS: o que aconteceu e quando é registro de operação.';

notify pgrst, 'reload schema';

-- ---- a agenda nasce com o que marcar: trigger e backfill (migration 0185) ----
--
-- A SEGUNDA metade da 0185. As funções estão ANTES do bloco da VARREDURA anon.
--
-- TRIGGER e BACKFILL, e não um só: o baseline nunca semeia organização que ainda
-- não existe (só faz backfill das de hoje), e o único mecanismo que alcança
-- organização FUTURA é trigger em `organizations`. Só backfill deixaria a
-- segunda organização do dono vazia; só trigger deixaria sem nada todo clone que
-- já instalou.
--
-- `on conflict do nothing` e nunca `do update`: o `update.sh` re-aplica este
-- arquivo a cada atualização, e `do update` sobrescreveria em silêncio o tipo
-- que o dono já editou. É a diferença entre semear e mandar.
drop trigger if exists trg_semear_tipos_de_agendamento on public.organizations;
create trigger trg_semear_tipos_de_agendamento
  after insert on public.organizations
  for each row
  execute function public.fn_semear_tipos_de_agendamento_na_org_nova();

-- Backfill: os clones que JÁ instalaram. Guardado por `not exists` para o
-- `update.sh` poder re-aplicar sem duplicar e sem tocar em quem já editou.
do $$
declare o record;
begin
  for o in
    select id from public.organizations
     where not exists (
       select 1 from public.calendar_event_types t where t.organization_id = organizations.id
     )
  loop
    perform public.fn_semear_tipos_de_agendamento(o.id);
  end loop;
end
$$;

comment on function public.fn_semear_tipos_de_agendamento(uuid) is
  'O PISO da agenda: três tipos neutros (Consulta, Reunião, Atendimento) para que instalação fresca tenha o que marcar. Não é o teto — o enriquecimento por nicho vive no passo do funil do onboarding, onde o nicho existe. `on conflict do nothing` para nunca sobrescrever o que o dono editou.';

notify pgrst, 'reload schema';

-- ---- a cor da pessoa é uma trilha, e a do tipo não existe (migration 0186) ----
--
-- A 0177 criou duas colunas de cor guardando hex. As duas estavam erradas, e o
-- argumento é do @VPS: hex guardado é "um segundo lugar para a mesma verdade, e
-- o tema escuro fica de fora". Medido: as cores vivem em `--agenda-pessoa-1..8`
-- no globals.css, em TRÊS blocos de tema, e a mesma trilha tem hex diferente em
-- cada um.
--
-- `calendar_color` VIRA TRILHA e a escolha manual FICA: a derivação a partir do
-- `user_id` é estável mas COLIDE (oito trilhas, mais de oito pessoas), e quem
-- administra vai querer desempatar. NULL = use a derivada.
--
-- `calendar_event_types.color` SAI: há UM pixel por compromisso na grade, e duas
-- colorações competindo pelo mesmo lugar significam que uma delas mente. O pedido
-- é cor POR PESSOA. Se voltar um dia, volta como trilha, com alternador.
--
-- ⚠️ DROP COLUMN é destrutivo. O que autoriza: as colunas nasceram na 0177 hoje,
-- o seed da 0185 não preenche nenhuma, e a varredura por consumidor devolveu zero
-- com controle positivo. Não há dado de cliente a perder porque não há caminho
-- que grave.
-- ─── 1 · a cor da pessoa vira trilha ──────────────────────────────────────
alter table public.user_organizations
  add column if not exists calendar_trilha smallint;

alter table public.user_organizations
  drop constraint if exists user_organizations_calendar_trilha_valida;
alter table public.user_organizations
  add constraint user_organizations_calendar_trilha_valida
  check (calendar_trilha is null or calendar_trilha between 1 and 8);

comment on column public.user_organizations.calendar_trilha is
  'A trilha de cor desta pessoa na grade da Agenda, nesta organização (1..8). NULL = use a derivada de trilhaPadraoDoMembro(user_id), que é estável mas colide para alguns pares — esta coluna existe para quem administra desempatar. A COR de cada trilha vive em app/globals.css (--agenda-pessoa-N) e muda com o tema; guardar hex aqui seria um segundo lugar para a mesma verdade, sem tema escuro. ⚠️ A policy de SELECT desta tabela é self-OU-manager+: um `agent` não lê a linha dos colegas pelo PostgREST, então as trilhas chegam à tela pela rota que monta o roster com service role.';

alter table public.user_organizations
  drop constraint if exists user_organizations_calendar_color_format;
alter table public.user_organizations
  drop column if exists calendar_color;

-- ─── 2 · a cor do tipo de agendamento sai ─────────────────────────────────
alter table public.calendar_event_types
  drop constraint if exists calendar_event_types_color_format;
alter table public.calendar_event_types
  drop column if exists color;

notify pgrst, 'reload schema';

-- ---- o espelho do Google é cache com prazo (migration 0187) ----
--
-- A SEGUNDA metade da 0187. A função está ANTES do bloco da VARREDURA anon.
comment on table public.calendar_external_events is
  'ESPELHO, somente-leitura, do que já existe na agenda conectada. Ocupa horário e aparece na grade, mas NÃO é compromisso nosso: não tem lead, não tem estado de atendimento e nunca é reescrito por nós. É CACHE — reconstruível pelo sync, apagado em cascata quando a conexão sai, e com prazo (fn_expurgar_espelho_da_agenda, migration 0187). Fica FORA da cascata de LGPD por não ter contact_id: o único vínculo com a pessoa é o title copiado do Google, e a fonte da verdade daquele dado é a agenda do próprio cliente, onde o titular exerce o direito com o controlador de lá. A mira de verdade só nasce com o escritor do sync, que terá o ical_uid para ligar — decisão de QUANDO, não de SE.';

create index if not exists calendar_external_events_poda_idx
  on public.calendar_external_events (ends_at);

notify pgrst, 'reload schema';

-- ---- o espelho não se limpa sozinho (migration 0189) ----
--
-- A 0187 deu prazo ao espelho e o comentário passou a dizer "cache com prazo".
-- Está certo e é insuficiente: quem ler aquilo conclui que ele se limpa sozinho.
--
-- O caso que a poda NÃO alcança: evento com `ends_at` no FUTURO, de conexão
-- VIVA, apagado no Google. Nunca envelhece — o corte é `ends_at < now() - N`, e
-- futuro não vence. Fica aqui para sempre, ocupando horário que na agenda do
-- cliente já está livre, e fazendo a agenda RECUSAR hora que existe. Quem limpa
-- é a RECONCILIAÇÃO do sync, que é de outra frente e não existe hoje.
--
-- Merece migration e não linha de doc porque `comment on table` é o que se lê no
-- `\d+` e é a única declaração que viaja com o schema para todo clone. Ressalva
-- que fica no briefing morre com a entrega.
comment on table public.calendar_external_events is
  'ESPELHO, somente-leitura, do que já existe na agenda conectada. Ocupa horário e aparece na grade, mas NÃO é compromisso nosso: não tem lead, não tem estado de atendimento e nunca é reescrito por nós. '
  'É CACHE — reconstruível pelo sync, apagado em cascata quando a conexão sai, e com prazo para o PASSADO (fn_expurgar_espelho_da_agenda, migration 0187). '
  '⚠️ O PRAZO NÃO LIMPA O FANTASMA: evento com ends_at no FUTURO, de conexão viva, apagado lá no Google, nunca envelhece e fica aqui para sempre — ocupando um horário que na agenda do cliente já está livre, e fazendo a agenda RECUSAR hora que existe. Quem limpa isso é a RECONCILIAÇÃO do sync (remover o que não veio na resposta da janela), que é da frente do Google e não existe hoje. '
  'Fica FORA da cascata de LGPD por não ter contact_id: o único vínculo com a pessoa é o title copiado do Google, e a fonte da verdade daquele dado é a agenda do próprio cliente, onde o titular exerce o direito com o controlador de lá. A mira de verdade só nasce com o escritor do sync, que terá o ical_uid para ligar — decisão de QUANDO, não de SE.';

notify pgrst, 'reload schema';
-- ---- a volta do Google precisa de identidade (migration 0188) ----
-- `calendar_appointments.google_ical_uid` existe desde a 0177 e diz qual evento
-- do Google é nosso. A linha de VOLTA não tinha equivalente, e sem chave entre
-- os dois o mesmo compromisso movido no Google passa a bloquear DOIS horários —
-- o novo, pela linha externa, e o antigo, pelo agendamento — sem nada que os
-- ligue para desfazer. Aditiva e idempotente.
alter table public.calendar_external_events
  add column if not exists ical_uid text;

create index if not exists calendar_external_events_ical_uid_idx
  on public.calendar_external_events (organization_id, ical_uid)
  where ical_uid is not null;

-- ---- o mesmo state do Google valia duas vezes (migration 0190) ----
-- Tabela de nonces queimados. Postgres e nao Redis porque o Upstash e opcional
-- no self-host, e propriedade de seguranca que degrada em silencio onde a
-- dependencia falta e pior que propriedade nenhuma. Aditiva e idempotente.
create table if not exists public.calendar_oauth_nonces (
  nonce text primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- O prazo do próprio `state`. Depois dele a linha não serve para mais nada:
  -- um `state` vencido já é recusado pela assinatura, antes de chegar aqui.
  expira_em timestamptz not null,
  usado_em timestamptz not null default now()
);

comment on table public.calendar_oauth_nonces is
  'Nonces de state do OAuth do Google já usados. A chave primária é o próprio nonce: a segunda tentativa viola a unicidade, e é assim que o replay é recusado.';

create index if not exists calendar_oauth_nonces_expiracao_idx
  on public.calendar_oauth_nonces (expira_em);

alter table public.calendar_oauth_nonces enable row level security;

-- Sem policy nenhuma, e é deliberado: quem escreve é o callback do OAuth, com
-- service role, e ninguém precisa LER isto pela API. Policy aqui só abriria
-- caminho para enumerar tentativas de conexão pelo PostgREST.
revoke all on public.calendar_oauth_nonces from anon, authenticated;

-- Negação ESCRITA (migration 0192). RLS ligada sem policy já nega tudo, mas no
-- catálogo negação deliberada e negação esquecida são indistinguíveis — e é
-- disso que o invariante de completude reclama, com razão. Não abre nada.
drop policy if exists tenant_isolation_calendar_oauth_nonces_all on public.calendar_oauth_nonces;
drop policy if exists calendar_oauth_nonces_ninguem_le on public.calendar_oauth_nonces;
create policy calendar_oauth_nonces_ninguem_le
  on public.calendar_oauth_nonces
  for select
  using (false);

-- A quarta poda do `data-retention`. Assinatura idêntica às três irmãs
-- (`p_dias`, `p_lote`) para o mesmo laço de lotes servir sem caso especial.
create or replace function public.fn_expurgar_nonces_de_oauth(p_dias int, p_lote int default 500)
returns int
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_removidas int;
begin
  -- Piso no CORPO, como as irmãs: um chamador que passe 0 não apaga nonce que
  -- ainda protege. O prazo do state é de 10 minutos, então um dia já é folga
  -- de duas ordens de grandeza.
  if p_dias is null or p_dias < 1 then
    p_dias := 1;
  end if;

  with alvo as (
    select nonce
      from public.calendar_oauth_nonces
     where expira_em < now() - make_interval(days => p_dias)
     limit greatest(p_lote, 1)
  )
  delete from public.calendar_oauth_nonces n
   using alvo
   where n.nonce = alvo.nonce;

  get diagnostics v_removidas = row_count;
  return v_removidas;
end$$;

-- Função nova em `public` nasce EXPOSTA — as DUAS origens de EXECUTE.
-- `authenticated` entra aqui pela migration 0192: as duas irmãs de assinatura
-- idêntica já o revogavam, e o grant vem do `ALTER DEFAULT PRIVILEGES` do
-- corpo deste arquivo — omissão que aparece como linha AUSENTE, não errada.
revoke execute on function public.fn_expurgar_nonces_de_oauth(int, int) from public, anon, authenticated;
grant execute on function public.fn_expurgar_nonces_de_oauth(int, int) to service_role;
-- ---- playbook `agendamento` v2: cita as ferramentas de agenda (migration 0191) ----
do $pub$
declare
  -- md5 do corpo abaixo. Conferido logo após o insert — ver item 2 do cabeçalho.
  v_md5 constant text := 'c2022f05f5b5d9451e727cf0f4187f8a';
  v_id  uuid;
begin
  select id into v_id
    from skill_versions
   where organization_id is null and name = 'agendamento' and md5(body) = v_md5
   limit 1;

  if v_id is null then
    insert into skill_versions (organization_id, name, description, body, matcher)
    values (
      null,
      'agendamento',
      'Playbook pra marcar/remarcar horário (consulta, visita, sessão) — consulta a agenda real pelas ferramentas quando elas existem, nunca inventa disponibilidade, e confirma por escrito antes de fechar.',
      $body$# Playbook: marcar horário/agendamento

## Quando usar
O lead pede pra marcar um horário, consulta, visita, demonstração ou sessão —
qualquer compromisso com data/hora. Comum em clínicas, imobiliárias (visitas),
serviços e consultorias.

## Regra de ouro: consulte a agenda, não adivinhe
Você tem acesso à agenda **se, e somente se**, a ferramenta `crm_find_free_slots`
estiver disponível para você. Não julgue isso por intuição — chame e leia a resposta.
- Voltou com horários → ofereça 2 ou 3 deles, concretos.
- Voltou `publicou_horarios: false` → o atendente ainda não publicou os horários de
  trabalho dele. Isso NÃO é "está lotado" e NÃO é "não tem vaga": não invente horário,
  não diga que a agenda está cheia, e avise que alguém da equipe confirma.
- Voltou com `motivo` → leia a `mensagem` e faça o que ela manda. Ela foi escrita para
  o cliente ouvir.
- Voltou `fuso_suposto: true` → o fuso da agenda veio do padrão e ninguém confirmou.
  Ofereça pedindo confirmação — "consigo terça às 14h; confere se esse horário bate aí
  pra você?" — em vez de afirmar.
- Você não tem essa ferramenta → aí sim: não ofereça horário nenhum, diga que vai
  confirmar a disponibilidade e sinalize handoff para quem tem acesso.
Prometer um horário que depois não existe quebra confiança e gera reagendamento
forçado. Inventar é pior do que demorar um instante a mais para responder.

## Fluxo padrão (if-then)

**1. Identifique o serviço/motivo antes de oferecer horário**
- SE o lead só disse "quero agendar" sem contexto → pergunte o motivo/serviço
  primeiro. Agendar sem saber o quê gera erro de encaixe (ex.: consulta de 20min
  marcada num slot de 1h de procedimento).

**2. Ofereça opções fechadas, não uma pergunta aberta**
- SE `crm_find_free_slots` respondeu com horários → ofereça 2-3 concretos ("tenho terça
  14h ou quarta 10h, qual funciona?"). Pergunta aberta tipo "qual horário você prefere?"
  gera ida e volta desnecessária e trava a conversa.
- SE você não tem a ferramenta → não invente. Diga algo como "vou confirmar a
  disponibilidade e te retorno em instantes" e sinalize handoff/task pra quem tem
  acesso.

**3. Colete os dados obrigatórios antes de confirmar**
- Nome completo do lead (ou confirme o que já está no CRM).
- Serviço/motivo específico.
- Unidade/local, se o tenant tiver mais de uma (clínica com filiais, imobiliária com
  múltiplos imóveis).
- Se for reagendamento, o horário anterior a ser substituído.

**4. Confirme por escrito antes de encerrar**
- SE o lead aceitar um horário → repita de volta por escrito: "Confirmado:
  [serviço] dia [data] às [hora], em [local]. Confirma pra mim?"
- Só considere o agendamento fechado depois do "sim"/confirmação explícita do lead —
  silêncio ou "ok" vago não é confirmação suficiente pra compromissos com custo de
  no-show alto (ex. consulta médica, visita a imóvel).

**5. Reagendamento e cancelamento**
- SE o lead pedir pra remarcar E você tem `crm_reschedule_appointment` → use ela.
  NÃO cancele e marque de novo: é o MESMO compromisso mudando de hora. O histórico
  continua um só e o lembrete é refeito sozinho para o horário novo.
- SE o lead pedir pra remarcar e você NÃO tem essa ferramenta → então cancelar e marcar
  de novo é o único caminho, e ele tem um custo que você precisa administrar: o cliente
  pode receber dois avisos seguidos e contraditórios ("desmarcado" e depois "marcado").
  Antes de fazer, diga a ele em uma frase o que vai acontecer — "vou desmarcar o horário
  antigo e já marcar o novo, você pode receber dois avisos" — e nunca deixe os dois
  compromissos de pé ao mesmo tempo.
- SE o lead pedir pra cancelar → use `crm_cancel_appointment` se você a tiver, informe o
  motivo, e pergunte se quer remarcar pra outra data, sem pressionar. Cancelar libera
  aquele horário para outra pessoa e não dá para desfazer: confirme antes.

**6. Risco de no-show**
- Se o negócio tiver política de confirmação D-1 documentada na base de
  conhecimento, siga-a (ex.: mensagem de lembrete automática). Se não houver, não
  invente política — apenas confirme o agendamento normalmente.

## Regras duras
- Nunca confirme horário sem ter checado disponibilidade real (ou sem sinalizar que
  ainda vai confirmar).
- Nunca marque dois compromissos conflitantes pro mesmo lead sem avisar.
- Se o lead pedir um horário fora do funcionamento do negócio (ex. domingo,
  madrugada) e isso não estiver nas regras do tenant, não confirme — explique a
  janela real de atendimento.
- Dado sensível (endereço completo, documento) só é coletado se o fluxo do tenant
  realmente exigir — não peça informação a mais que o agendamento precisa.
- Marcar consulta e agendar retorno são coisas DIFERENTES. `crm_book_appointment` é para
  hora combinada COM o cliente, que ele reservou e vai comparecer — alguém espera por ele.
  `crm_schedule_followup` é decisão interna nossa de voltar a falar: o cliente não fica
  sabendo e nada é reservado na agenda de ninguém. Se ele ESCOLHEU um horário para ser
  atendido, é a primeira.

## Exemplos de resposta (tom, não copiar literal)
- "Pra eu te encaixar certo: é pra qual serviço/motivo?"
- "Tenho quinta às 15h ou sexta às 9h — qual fica melhor pra você?"
- "Confirmado: consulta dia 28/07 às 15h, na unidade Centro. Pode confirmar pra
  mim?"

## O que NÃO fazer
- Não pergunte "qual horário você prefere?" sem oferecer opções concretas quando
  você tem a agenda.
- Não confirme agendamento sem resposta explícita do lead.
- Não invente disponibilidade que você não checou.$body$,
      '{"any_keywords": ["agendar", "marcar horário", "marcar consulta", "marcar uma visita", "agenda", "que horas vocês", "horário disponível", "remarcar", "reagendar", "cancelar o horário", "desmarcar"], "probe_keywords": ["que horas", "qual dia", "tem vaga", "disponibilidade"]}'::jsonb
    )
    returning id into v_id;

    if (select md5(body) from skill_versions where id = v_id) is distinct from v_md5 then
      raise exception 'playbook agendamento: o md5 declarado (%) nao corresponde ao corpo inserido. Recalcule antes de publicar.', v_md5;
    end if;
  end if;

  -- Repointe SEMPRE. O ponteiro global e unico por nome (uniq_skill_pointers_platform,
  -- parcial em organization_id is null), entao update-senao-insert e seguro e nao depende
  -- de inferencia de conflito sobre indice parcial.
  update skill_pointers
     set version_id = v_id, updated_at = now()
   where organization_id is null and name = 'agendamento';

  if not found then
    insert into skill_pointers (organization_id, name, version_id)
    values (null, 'agendamento', v_id);
  end if;
end
$pub$;


-- ---- ⚠️ RESTAURADA AO FIM (2026-08-27) ----
--
-- Este bloco diz de si mesmo que é o ÚLTIMO do arquivo, e havia 24 apêndices
-- depois dele. A cura deixou de alcançar tudo que veio no meio, e o gate
-- `tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts` só reprova quando um
-- desses blocos CRIA FUNÇÃO — o que levou 24 blocos para acontecer, com
-- `fn_expurgar_nonces_de_oauth` (commit 75383e5a).
--
-- Movido em vez de remendado: mover o bloco novo para cima resolveria a
-- INSTÂNCIA e deixaria a armadilha armada para o próximo. Mover a varredura
-- para o fim resolve a CLASSE e restaura o que o texto dela já prometia.
--
-- Seguro porque a varredura preserva o que encontra: ela lê
-- `has_function_privilege` de `authenticated` e `service_role` ANTES do
-- revoke e regrava os dois. Rodar mais tarde só faz alcançar mais funções.

-- ---- FK e fuso da conexão do Google (migration 0193) ----
-- ⚠️ ENTRA ANTES DO BLOCO DA VARREDURA anon, que é de propósito o último do arquivo.
-- Este bloco não cria função, então a varredura não o cura nem precisa curar — mas pôr
-- apêndice DEPOIS dela recria a erosão que a 0192 acabou de consertar.
alter table public.calendar_appointments
  add column if not exists google_connection_id uuid;

-- Backfill ANTES da constraint: a coluna é nova e nada escreve nela hoje, mas um clone
-- adiantado poderia ter linha com ponteiro morto — e constraint criada sobre dado que a
-- viola quebra o `update.sh` do clone, que roda SEM ON_ERROR_STOP e falharia no meio.
update public.calendar_appointments a
   set google_connection_id = null
 where a.google_connection_id is not null
   and not exists (select 1 from public.calendar_connections c where c.id = a.google_connection_id);

do $fk$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.calendar_appointments'::regclass
       and conname = 'calendar_appointments_google_connection_id_fkey'
  ) then
    alter table public.calendar_appointments
      add constraint calendar_appointments_google_connection_id_fkey
      foreign key (google_connection_id)
      references public.calendar_connections(id) on delete set null;
  end if;
end
$fk$;

comment on column public.calendar_appointments.google_connection_id is
  'Conexão do Google que espelha este compromisso. `set null`: conexão revogada não apaga compromisso — ele é do CRM, não da integração.';

alter table public.calendar_connection_calendars
  add column if not exists time_zone text;

comment on column public.calendar_connection_calendars.time_zone is
  'Fuso IANA do calendário, como o Google devolve (`timeZone`). NULL = ainda não sincronizado; quem lê deve tratar NULL como "não sei", nunca como UTC — foi o `?? UTC` que fez evento de dia inteiro vazar a noite anterior.';

-- ---- lembrete nasce desligado (migration 0194) ----
-- ⚠️ ENTRA ANTES DO BLOCO DA VARREDURA anon, pelo mesmo motivo da 0193.
alter table public.calendar_event_types
  alter column reminder_enabled set default false;

-- As linhas JÁ criadas também voltam: com zero leitores e zero disparador, nada depende do
-- valor atual, então este é o único momento em que corrigir o histórico não regride
-- comportamento de ninguém. Depois do disparador, isto seria apagar a escolha de um operador.
update public.calendar_event_types
   set reminder_enabled = false
 where reminder_enabled is true;

comment on column public.calendar_event_types.reminder_enabled is
  'Lembrete automático deste tipo. Nasce DESLIGADO de propósito: enviar mensagem é irreversível, e um default ligado inscreveria o histórico inteiro sem ninguém ter escolhido. Ligar por padrão é decisão do dono do produto, a ser tomada quando o disparador existir.';

-- ---- tipo semeado adota dono no primeiro membro (migration 0195) ----
-- ⚠️ ENTRA ANTES DO BLOCO DA VARREDURA anon: aqui é OBRIGATÓRIO, não preferência —
-- este bloco CRIA FUNÇÃO, e função nova em `public` nasce exposta a `anon` pelo
-- ALTER DEFAULT PRIVILEGES. Depois da varredura, ela ficaria sem a cura.
create or replace function public.fn_adotar_tipos_de_agendamento_sem_dono()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- Só o primeiro membro ATIVO da organização.
  --
  -- ⚠️ As duas condições nasceram de um caso que a predição pegou antes do commit: sem
  -- `new.revoked_at is null`, uma linha que JÁ nasce revogada adota os tipos e o dono padrão
  -- da agenda vira alguém que nunca esteve lá. E contar TODOS em vez de só os ativos criaria
  -- o furo simétrico: numa org com um ex-membro, o primeiro membro de verdade veria contagem
  -- 2 e não adotaria nada — a org ficaria órfã para sempre.
  --
  -- `= 1` e não `> 0`: neste ponto a linha nova já está na tabela, então o primeiro ativo
  -- vê contagem 1.
  if new.revoked_at is null
     and (select count(*) from public.user_organizations u
           where u.organization_id = new.organization_id
             and u.revoked_at is null) = 1 then
    update public.calendar_event_types
       set default_owner_user_id = new.user_id
     where organization_id = new.organization_id
       and default_owner_user_id is null;
  end if;
  return new;
end
$fn$;

revoke execute on function public.fn_adotar_tipos_de_agendamento_sem_dono() from public, anon, authenticated;
grant  execute on function public.fn_adotar_tipos_de_agendamento_sem_dono() to service_role;

drop trigger if exists trg_adotar_tipos_de_agendamento_sem_dono on public.user_organizations;
create trigger trg_adotar_tipos_de_agendamento_sem_dono
  after insert on public.user_organizations
  for each row execute function public.fn_adotar_tipos_de_agendamento_sem_dono();

-- Backfill: organizações que JÁ nasceram com os tipos órfãos e já têm membro. Adota o
-- membro ATIVO mais antigo — o mesmo que o trigger teria escolhido se existisse na época.
--
-- ⚠️ `revoked_at is null` nas DUAS metades, e não é detalhe: `user_organizations` guarda o
-- ex-membro em vez de apagá-lo. Sem o filtro, o backfill adotaria como dono padrão da agenda
-- alguém que já saiu da empresa — e o `exists` sem filtro faria pior, deixando o tipo órfão
-- numa org que só tem ex-membros parecer "já resolvido" por ter alguém na tabela.
update public.calendar_event_types t
   set default_owner_user_id = (
         select u.user_id from public.user_organizations u
          where u.organization_id = t.organization_id
            and u.revoked_at is null
          order by u.created_at, u.user_id
          limit 1)
 where t.default_owner_user_id is null
   and exists (select 1 from public.user_organizations u
                where u.organization_id = t.organization_id and u.revoked_at is null);

-- ---- o acervo é da organização; o agente escolhe o que lê (migration 0181) ----
--
-- A base de conhecimento PERTENCIA a um agente (`ai_knowledge_sources.agent_id`
-- NOT NULL, FK CASCADE) e o acervo do agente era UMA versão monolítica. Daí
-- saíam, em cadeia: material impossível de compartilhar; UM documento por
-- categoria por agente (índice único `(agent_id, source_type) WHERE is_active`,
-- e todo arquivo enviado virava `policy`, então o SEGUNDO PDF colidia);
-- pipelines competindo pelo mesmo ponteiro (a ingestão de conversas ativava a
-- versão dela e DESATIVAVA a de FAQ do mesmo agente, e vice-versa); e apagar o
-- agente apagava a base junto.
--
-- Agora a fonte é da ORGANIZAÇÃO. `agent_id` fica como histórico (nullable, ON
-- DELETE SET NULL). Quem lê o quê é `ai_agent_versions.knowledge_source_ids`,
-- molde exato de `pipeline_ids` (0125) e pela mesma razão: escopo fora do ciclo
-- rascunho→publicar muda o alcance do agente sem ninguém publicar nada. Coluna
-- `uuid[]` na versão e não junção, porque o runtime lê a config em UMA query
-- sem cache — junção custaria uma query a mais por turno atendido.
--
-- O ponteiro de índice vira POR FONTE (`ai_knowledge_sources.active_kb_version_id`).
-- As versões legadas continuam válidas sem serem quebradas: a busca casa
-- `(kb_version_id, knowledge_source_id)`, então uma versão compartilhada devolve
-- para cada fonte exatamente os chunks daquela fonte.
--
-- Racional completo no cabeçalho da migration. Idempotente e auto-curativo.

drop index if exists public.ai_knowledge_sources_unique_per_agent;

alter table public.ai_knowledge_sources
  alter column agent_id drop not null;

alter table public.ai_knowledge_sources
  drop constraint if exists ai_knowledge_sources_agent_id_fkey;
alter table public.ai_knowledge_sources
  add constraint ai_knowledge_sources_agent_id_fkey
  foreign key (agent_id) references public.ai_agents(id) on delete set null;

comment on column public.ai_knowledge_sources.agent_id is
  'HISTÓRICO: o agente a partir do qual a fonte foi criada. NÃO é dono — desde a 0181 quem lê o quê é `ai_agent_versions.knowledge_source_ids`. Nullable e ON DELETE SET NULL de propósito.';

-- A VERSÃO DE ÍNDICE TAMBÉM DEIXA DE PERTENCER A UM AGENTE.
--
-- `agent_id` era NOT NULL aqui, e um material da organização (sem agente
-- nenhum) não tinha como ser indexado: `createKnowledgeVersion` batia em
-- "null value in column agent_id violates not-null constraint" — medido na
-- prova de tela, com o material parado em `indexando` para sempre.
--
-- E o CASCADE sai junto, por uma razão pior: os chunks apontam para a VERSÃO
-- (`ai_chunks.kb_version_id ... on delete cascade`), então apagar o agente
-- levava a versão, e a versão levava os trechos — o material da EMPRESA sumia
-- porque alguém apagou um assistente. `SET NULL`: a versão pertence à fonte.
alter table public.ai_knowledge_versions
  alter column agent_id drop not null;

alter table public.ai_knowledge_versions
  drop constraint if exists ai_knowledge_versions_agent_id_fkey;
alter table public.ai_knowledge_versions
  add constraint ai_knowledge_versions_agent_id_fkey
  foreign key (agent_id) references public.ai_agents(id) on delete set null;

comment on column public.ai_knowledge_versions.agent_id is
  'HISTÓRICO: o agente a partir do qual esta indexação foi disparada. Nullable desde a 0181 — a versão pertence à FONTE, e o acervo é da organização.';

-- Vocabulário ABERTO (precedente da 0127): o CHECK tinha 6 valores com dois
-- pares de sinônimos e nenhum valor para "documento avulso".
alter table public.ai_knowledge_sources
  drop constraint if exists ai_knowledge_sources_source_type_check;

update public.ai_knowledge_sources
   set source_type = case source_type
         when 'policy'            then 'documento'
         when 'conversation'      then 'conversas'
         when 'nuvemshop_catalog' then 'catalogo'
         when 'catalog'           then 'catalogo'
         else source_type
       end
 where source_type in ('policy', 'conversation', 'nuvemshop_catalog', 'catalog');

comment on column public.ai_knowledge_sources.source_type is
  'Vocabulário ABERTO (sem CHECK, precedente da 0127). A lista que a tela oferece vive em lib/ai/rag/tipos-de-fonte.ts: faq | documento | conversas | catalogo.';

-- Nome vira identidade: batizar o que está sem nome e desempatar homônimos
-- ANTES do índice único, senão o `update.sh` do clone morre aqui.
update public.ai_knowledge_sources
   set name = case source_type
         when 'faq'       then 'Perguntas frequentes'
         when 'documento' then 'Documento'
         when 'conversas' then 'Conversas anteriores'
         when 'catalogo'  then 'Catálogo de produtos'
         else 'Material'
       end || ' ' || left(id::text, 8)
 where coalesce(btrim(name), '') = '';

with duplicados as (
  select id,
         row_number() over (
           partition by organization_id, lower(btrim(name))
           order by created_at, id
         ) as n
    from public.ai_knowledge_sources
   where is_active
)
update public.ai_knowledge_sources s
   set name = s.name || ' (' || left(s.id::text, 4) || ')'
  from duplicados d
 where d.id = s.id
   and d.n > 1;

create unique index if not exists ai_knowledge_sources_nome_unico_por_org
  on public.ai_knowledge_sources (organization_id, lower(btrim(name)))
  where is_active;

-- Arquivar desliga de verdade: nenhuma linha do repo jamais escreveu
-- `is_active = false`, e com o índice único antigo isso deixava o "slot"
-- ocupado por uma fonte arquivada para sempre.
update public.ai_knowledge_sources
   set is_active = false
 where status = 'archived' and is_active;

alter table public.ai_knowledge_sources
  drop constraint if exists ai_knowledge_sources_arquivada_nao_e_ativa;
alter table public.ai_knowledge_sources
  add constraint ai_knowledge_sources_arquivada_nao_e_ativa
  check (not is_active or status <> 'archived');

-- Os dois estados que o produto JÁ produz e a tela não sabia mostrar.
-- Reconstruído em UM bloco só (lição do #159). Aditivo.
alter table public.ai_knowledge_sources
  drop constraint if exists ai_knowledge_sources_last_index_status_check;
alter table public.ai_knowledge_sources
  add constraint ai_knowledge_sources_last_index_status_check
  check (last_index_status is null or last_index_status = any (array[
    'success', 'partial', 'failed', 'indexando', 'sem_credencial'
  ]));

alter table public.ai_knowledge_sources
  add column if not exists active_kb_version_id uuid;

alter table public.ai_knowledge_versions
  add column if not exists knowledge_source_id uuid;
alter table public.ai_knowledge_versions
  add column if not exists embedding_model text;
alter table public.ai_knowledge_versions
  add column if not exists embedding_dims integer;

comment on column public.ai_knowledge_versions.knowledge_source_id is
  'A fonte que esta versão indexa. NULL nas versões anteriores à 0181, que continham chunks de várias fontes — e continuam válidas: a busca casa (kb_version_id, knowledge_source_id) por fonte.';
comment on column public.ai_knowledge_versions.embedding_model is
  'Modelo com que os vetores desta versão foram calculados. NULL = anterior à 0181. A busca recusa a fonte cuja versão foi indexada com outro modelo — recall quebrado em silêncio é pior que fonte de fora.';

-- Ponteiros pendurados saem ANTES das FKs. Um `active_kb_version_id` apontando
-- para versão apagada é hoje indistinguível de "base vazia": zero chunk, zero erro.
update public.ai_agents a
   set active_kb_version_id = null
 where a.active_kb_version_id is not null
   and not exists (select 1 from public.ai_knowledge_versions v where v.id = a.active_kb_version_id);

delete from public.ai_chunks c
 where not exists (select 1 from public.ai_knowledge_versions v where v.id = c.kb_version_id);

alter table public.ai_agents
  drop constraint if exists ai_agents_active_kb_version_id_fkey;
alter table public.ai_agents
  add constraint ai_agents_active_kb_version_id_fkey
  foreign key (active_kb_version_id) references public.ai_knowledge_versions(id) on delete set null;

alter table public.ai_chunks
  drop constraint if exists ai_chunks_kb_version_id_fkey;
alter table public.ai_chunks
  add constraint ai_chunks_kb_version_id_fkey
  foreign key (kb_version_id) references public.ai_knowledge_versions(id) on delete cascade;

alter table public.ai_knowledge_sources
  drop constraint if exists ai_knowledge_sources_active_kb_version_id_fkey;
alter table public.ai_knowledge_sources
  add constraint ai_knowledge_sources_active_kb_version_id_fkey
  foreign key (active_kb_version_id) references public.ai_knowledge_versions(id) on delete set null;

alter table public.ai_knowledge_versions
  drop constraint if exists ai_knowledge_versions_knowledge_source_id_fkey;
alter table public.ai_knowledge_versions
  add constraint ai_knowledge_versions_knowledge_source_id_fkey
  foreign key (knowledge_source_id) references public.ai_knowledge_sources(id) on delete cascade;

-- Cada fonte herda a versão ATIVA do agente dela, mas SÓ se aquela versão
-- realmente contiver chunks daquela fonte.
update public.ai_knowledge_sources s
   set active_kb_version_id = v.id
  from public.ai_knowledge_versions v
 where v.agent_id = s.agent_id
   and v.organization_id = s.organization_id
   and v.is_active
   and s.active_kb_version_id is null
   and exists (
     select 1 from public.ai_chunks c
      where c.kb_version_id = v.id and c.knowledge_source_id = s.id
   );

drop index if exists public.ai_kbv_one_active_per_agent;
create unique index if not exists ai_kbv_uma_ativa_por_fonte
  on public.ai_knowledge_versions (knowledge_source_id)
  where is_active and knowledge_source_id is not null;

create index if not exists ai_knowledge_sources_org_idx
  on public.ai_knowledge_sources (organization_id, is_active);
create index if not exists ai_knowledge_versions_org_idx
  on public.ai_knowledge_versions (organization_id, knowledge_source_id);

alter table public.ai_agent_versions
  add column if not exists knowledge_source_ids uuid[] not null default '{}'::uuid[];

comment on column public.ai_agent_versions.knowledge_source_ids is
  'Materiais que ESTE agente consulta. Vazio = NENHUM (falha fechada): ele conversa normalmente e a ferramenta de busca some do turno. Molde e racional de `pipeline_ids` (0125): escopo mora na versão publicada.';

update public.ai_agent_versions v
   set knowledge_source_ids = sub.fontes
  from (
    select agent_id, array_agg(id order by created_at) as fontes
      from public.ai_knowledge_sources
     where is_active and agent_id is not null
     group by agent_id
  ) sub
 where v.agent_id = sub.agent_id
   and v.knowledge_source_ids = '{}'::uuid[];

-- CONSERTO OBRIGATÓRIO no mesmo bloco: escopo de leitura editável numa versão
-- PUBLICADA sem virar versão nova é a própria ausência de escopo, com aparência
-- de controle.
create or replace function fn_ai_agent_version_content_immutable() returns trigger
language plpgsql as $fn$
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

-- A busca que aceita VÁRIAS fontes. A antiga (`retrieve_top_k_chunks`) continua
-- existindo: o worker legado e a capacidade MCP a chamam.
--
-- Preserva as duas decisões de que o chamador depende: quem corta pelo limiar é
-- o TypeScript (o caller passa o piso −1, para enxergar o melhor candidato
-- REPROVADO), e o gate de membership só morde quando há `auth.uid()` — o engine
-- roda com role `bypassrls` e para ele o isolamento é o `organization_id = $1`.
create or replace function public.fn_buscar_trechos_das_fontes(
  p_organization_id uuid,
  p_source_ids uuid[],
  p_embedding public.vector,
  p_k integer default 5,
  p_threshold real default 0.40,
  p_embedding_model text default null
) returns table(
  chunk_id uuid,
  knowledge_source_id uuid,
  source_name text,
  content text,
  similarity real,
  metadata jsonb
)
  language plpgsql stable security definer
  set search_path to 'public'
as $$
begin
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'viewer') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'fn_buscar_trechos_das_fontes: caller must be an active member of the organization';
  end if;

  return query
  select
    c.id as chunk_id,
    c.knowledge_source_id,
    s.name as source_name,
    c.content,
    (1 - (c.embedding <=> p_embedding))::real as similarity,
    c.metadata
  from public.ai_chunks c
  join public.ai_knowledge_sources s
    on s.id = c.knowledge_source_id
   and s.organization_id = c.organization_id
  join public.ai_knowledge_versions v
    on v.id = c.kb_version_id
  where c.organization_id = p_organization_id
    and s.id = any(p_source_ids)
    and s.is_active
    and s.status = 'ready'
    and c.kb_version_id = s.active_kb_version_id
    and (
      p_embedding_model is null
      or v.embedding_model is null
      or v.embedding_model = p_embedding_model
    )
    and (1 - (c.embedding <=> p_embedding)) >= p_threshold
  order by c.embedding <=> p_embedding asc
  limit greatest(p_k, 0);
end $$;

comment on function public.fn_buscar_trechos_das_fontes(uuid, uuid[], public.vector, integer, real, text) is
  'Top-K por similaridade de cosseno sobre os materiais que o agente pode ler (0181). SECURITY DEFINER + filtro programático de organização — quem chama valida o tenant.';

revoke execute on function public.fn_buscar_trechos_das_fontes(uuid, uuid[], public.vector, integer, real, text) from public, anon;
grant  execute on function public.fn_buscar_trechos_das_fontes(uuid, uuid[], public.vector, integer, real, text) to authenticated, service_role;

-- `ai_models` não tinha NENHUM modelo de embedding, e é por isso que o painel de
-- provedores não conseguia oferecer chave para `embedding_indexar` e
-- `embedding_consultar`: não havia o que listar.
alter table public.ai_models
  add column if not exists supports_embedding boolean not null default false;
alter table public.ai_models
  add column if not exists embedding_dims integer;

insert into public.ai_models
  (provider, model_id, display_name, description,
   input_price_per_million_cents, output_price_per_million_cents,
   supports_tools, supports_embedding, embedding_dims)
values
  ('openai', 'text-embedding-3-small', 'Text Embedding 3 Small',
   'O modelo que indexa e consulta o seu material. Trocar exige reindexar tudo de uma vez.',
   2, 0, false, true, 1536)
on conflict (provider, model_id) do update set
  supports_embedding = excluded.supports_embedding,
  embedding_dims     = excluded.embedding_dims,
  supports_tools     = excluded.supports_tools;

-- RBAC nas quatro tabelas de RAG (formato da 0150). Elas ficaram de fora do
-- aperto e ainda estão como o relatório de segurança da comunidade descreveu:
-- policy `ALL` só-tenancy mais `GRANT ALL ... TO anon`. Um membro papel `viewer`
-- DELETA a base de conhecimento da própria organização falando direto com o
-- PostgREST, com o JWT dele.
drop policy if exists tenant_isolation_ai_knowledge_sources_all on public.ai_knowledge_sources;

drop policy if exists tenant_isolation_ai_knowledge_sources_select on public.ai_knowledge_sources;
create policy tenant_isolation_ai_knowledge_sources_select on public.ai_knowledge_sources
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );

drop policy if exists tenant_isolation_ai_knowledge_sources_write on public.ai_knowledge_sources;
create policy tenant_isolation_ai_knowledge_sources_write on public.ai_knowledge_sources
  for all using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager'))
    or public.fn_is_platform_admin()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager'))
    or public.fn_is_platform_admin()
  );

drop policy if exists tenant_isolation_ai_faq_items_all on public.ai_faq_items;

drop policy if exists tenant_isolation_ai_faq_items_select on public.ai_faq_items;
create policy tenant_isolation_ai_faq_items_select on public.ai_faq_items
  for select using (organization_id in (select public.fn_user_org_ids()));

drop policy if exists tenant_isolation_ai_faq_items_write on public.ai_faq_items;
create policy tenant_isolation_ai_faq_items_write on public.ai_faq_items
  for all using (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager')
  ) with check (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager')
  );

drop policy if exists tenant_isolation_ai_kbv_all on public.ai_knowledge_versions;

drop policy if exists tenant_isolation_ai_kbv_select on public.ai_knowledge_versions;
create policy tenant_isolation_ai_kbv_select on public.ai_knowledge_versions
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );

drop policy if exists tenant_isolation_ai_kbv_write on public.ai_knowledge_versions;
create policy tenant_isolation_ai_kbv_write on public.ai_knowledge_versions
  for all using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin()
  );

drop policy if exists tenant_isolation_ai_chunks_all on public.ai_chunks;

drop policy if exists tenant_isolation_ai_chunks_select on public.ai_chunks;
create policy tenant_isolation_ai_chunks_select on public.ai_chunks
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );

drop policy if exists tenant_isolation_ai_chunks_write on public.ai_chunks;
create policy tenant_isolation_ai_chunks_write on public.ai_chunks
  for all using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin()
  );

revoke all on table public.ai_knowledge_sources  from anon;
revoke all on table public.ai_knowledge_versions from anon;
revoke all on table public.ai_chunks             from anon;
revoke all on table public.ai_faq_items          from anon;

drop trigger if exists trg_ai_knowledge_sources_audit on public.ai_knowledge_sources;
create trigger trg_ai_knowledge_sources_audit
  after insert or update or delete on public.ai_knowledge_sources
  for each row execute function public.fn_audit_log_row();

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- 12. A telemetria de busca aprende QUEM perguntou e SOBRE O QUÊ
-- ---------------------------------------------------------------------------
--
-- `knowledge_searches` registrava organização, job, versão de índice, número de
-- acertos, melhor nota e limiar. Faltava o que a torna acionável: QUAL
-- assistente perguntou e em QUAIS materiais. Sem isso, "o recall está ruim" não
-- tem como virar "o recall está ruim NAQUELE material", que é o conserto.
--
-- `kb_version_id` passa a aceitar NULL porque a busca deixou de ser sobre UMA
-- versão: ela é sobre um conjunto de materiais, cada um com o índice dele.
--
-- A decisão declarada no cabeçalho da 0086 continua valendo: esta tabela NÃO
-- guarda o texto da pergunta. Acrescentar ids é compatível com ela; acrescentar
-- a pergunta seria PII contra a decisão.

alter table public.knowledge_searches
  alter column kb_version_id drop not null;

alter table public.knowledge_searches
  add column if not exists agent_id uuid references public.ai_agents(id) on delete set null;

alter table public.knowledge_searches
  add column if not exists knowledge_source_ids uuid[] not null default '{}'::uuid[];

comment on column public.knowledge_searches.knowledge_source_ids is
  'Materiais consultados nesta busca. Vazio nas linhas anteriores à 0181, quando a busca era sobre uma única versão de índice.';

notify pgrst, 'reload schema';

-- ---- o que ainda não foi ao Google (migration 0200) ----
-- O worker `agenda-google-push` pedia os pendentes com
-- `.or("google_synced_at.is.null,updated_at.gt.google_synced_at")`, e o PostgREST
-- trata o lado DIREITO de `gt.` como VALOR LITERAL: ele tentava converter a
-- string "google_synced_at" em `timestamptz` e recusava a consulta INTEIRA. Em
-- produção isso é um `warn` a cada 5 minutos desde o deploy da v1.7.0 e ZERO
-- compromissos empurrados — a ida ao Google nunca aconteceu em instalação
-- nenhuma. A coluna derivada é o que dá ao PostgREST um filtro que ele sabe
-- fazer (`.eq("needs_google_push", true)`).
--
-- ⚠️ O TRIGGER NÃO É ENFEITE — sem ele o conserto troca "nunca empurra" por
-- "empurra para sempre". `updated_at` vem do `now()` do POSTGRES (trigger) e
-- `google_synced_at` vinha do `new Date()` do NODE, calculado antes de a
-- requisição sair: o do Node é sempre ANTERIOR, então `updated_at >
-- google_synced_at` continuava verdadeiro logo depois de uma sincronização
-- bem-sucedida e a linha voltava à fila na rodada seguinte, para sempre. O
-- trigger faz o carimbo sair do MESMO relógio dos dois lados. Ele não carimba
-- quando o valor novo é NULL: zerar a coluna é como se força re-sincronização de
-- propósito.
--
-- Aditiva e idempotente: `add column if not exists` sobre coluna GERADA é no-op
-- quando ela já existe, `create or replace function` e `drop trigger if exists`
-- fazem o resto. Não há dado a curar — o valor é derivado das duas colunas que
-- já estão lá e nasce correto para o histórico inteiro.
--
-- ⚠️ CRIA FUNÇÃO, então entra ANTES da varredura de `anon` logo abaixo: função
-- nova em `public` nasce exposta pelo ALTER DEFAULT PRIVILEGES, e depois da
-- varredura ela ficaria sem a cura. Os `revoke` explícitos abaixo já a fecham
-- nas duas origens; a varredura é a rede, não a trava.
alter table public.calendar_appointments
  add column if not exists needs_google_push boolean
  generated always as (google_synced_at is null or updated_at > google_synced_at) stored;

comment on column public.calendar_appointments.needs_google_push is
  'Derivada: a linha ainda não foi ao Google, ou mudou depois da última ida. Existe porque o PostgREST não compara coluna com coluna — o filtro do worker de push é `.eq("needs_google_push", true)`.';

create or replace function public.fn_carimbar_ida_ao_google()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  -- `now()` e não `new.updated_at`: os dois são o instante de início da
  -- transação, então o valor é o mesmo — e usar `now()` remove a dependência de
  -- ORDEM entre este trigger e o de `updated_at`.
  if new.google_synced_at is not null
     and (tg_op = 'INSERT' or new.google_synced_at is distinct from old.google_synced_at) then
    new.google_synced_at := now();
  end if;
  return new;
end
$fn$;

revoke execute on function public.fn_carimbar_ida_ao_google() from public, anon, authenticated;
grant  execute on function public.fn_carimbar_ida_ao_google() to service_role;

drop trigger if exists trg_calendar_appointments_carimbo_do_google on public.calendar_appointments;
create trigger trg_calendar_appointments_carimbo_do_google
  before insert or update on public.calendar_appointments
  for each row execute function public.fn_carimbar_ida_ao_google();

create index if not exists calendar_appointments_pendente_no_google_idx
  on public.calendar_appointments (starts_at)
  where needs_google_push and owner_user_id is not null;

-- ---- credencial do Google pela tela (migration 0201) ----
-- Conectar o Google exigia SSH na VPS e editar o `.env`. O produto é self-host
-- para quem NÃO programa: nomear variáveis de ambiente para essa pessoa é o
-- mesmo que dizer que a funcionalidade não existe.
--
-- Singleton de INSTALAÇÃO, clone do molde de `platform_branding` (0155): o
-- `redirect_uri` sai de `NEXT_PUBLIC_APP_URL` e o app OAuth é registrado no
-- console do Google pelo dono da instalação — a credencial pareia 1:1 com ela.
--
-- ⚠️ RLS LIGADA COM ZERO POLICIES é o desenho, não descuido. A anon key vai para
-- o browser; tabela servida pelo PostgREST e "protegida por policy" depende de a
-- policy estar certa, esta simplesmente não é servida. O `client_secret` permite
-- trocar códigos e refresh tokens em nome da instalação — ou seja, ler a agenda
-- de todos os atendentes que conectaram.
--
-- Não cria função: usa `fn_encrypt_oauth`/`fn_decrypt_oauth` da 0041, a mesma
-- cifra que o callback do Google já usa para os tokens. Entra antes da varredura
-- de `anon` pela regra do arquivo, não por necessidade.
--
-- Aditiva e idempotente: `create table if not exists`, `revoke`/`grant` que
-- reafirmam, `drop trigger if exists` antes de recriar. Sem dado a curar.
create table if not exists public.platform_google_oauth (
  id smallint primary key default 1,
  client_id text,
  client_secret_encrypted bytea,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint platform_google_oauth_singleton check (id = 1)
);

comment on table public.platform_google_oauth is
  'O app OAuth do Google DESTA INSTALAÇÃO (singleton). Server-side only: RLS ligada sem policies e grants revogados de anon/authenticated — o PostgREST não a serve. O segredo nunca volta ao browser; a tela devolve apenas se existe.';
comment on column public.platform_google_oauth.client_secret_encrypted is
  'Cifrado por fn_encrypt_oauth (pgp_sym_encrypt/aes256), a mesma cifra dos tokens em calendar_connections. Nunca gravar em claro: sem a chave mestra o save recusa.';

alter table public.platform_google_oauth enable row level security;

revoke all on public.platform_google_oauth from anon, authenticated;
grant select, insert, update on public.platform_google_oauth to service_role;

drop trigger if exists trg_platform_google_oauth_updated_at on public.platform_google_oauth;
create trigger trg_platform_google_oauth_updated_at
  before update on public.platform_google_oauth
  for each row execute function public.fn_set_updated_at();

-- ---- desnormaliza assigned_to_user_name em conversations (migration 0202) ----
--
-- GET /api/v1/conversations resolvia o nome do atendente via N chamadas ao
-- GoTrue Admin API (uma por atendente único da página, medido em
-- lib/users/nome-do-atendente.ts: ~1,2s para 50 atendentes). Toda atribuição
-- de conversa passa por fn_conversation_assign (claim/release/transfer e o
-- roteamento automático) — grava o nome ali, uma vez, no mesmo UPDATE que
-- grava o id, em vez de replicar a resolução em 4 call sites TS.

alter table public.conversations
  add column if not exists assigned_to_user_name text;

comment on column public.conversations.assigned_to_user_name is
  'Cópia do nome de quem atende (auth.users.raw_user_meta_data->>''full_name''), escrita por fn_conversation_assign no mesmo UPDATE que grava assigned_to_user_id, e zerada junto quando a atribuição é removida. Existe para evitar 1 chamada HTTP ao GoTrue Admin API por atendente único na listagem do Inbox — ver lib/users/nome-do-atendente.ts. NULL quando a conversa não está atribuída, ou quando o atendente não tem full_name em user_metadata.';

-- Backfill: só linhas já atribuídas, e só quando o nome ainda não está
-- presente — não sobrescreve dado que uma reaplicação já preencheu.
update public.conversations c
   set assigned_to_user_name = u.raw_user_meta_data ->> 'full_name'
  from auth.users u
 where c.assigned_to_user_id = u.id
   and c.assigned_to_user_name is null;

create or replace function public.fn_conversation_assign(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_to_user_id uuid,
  p_reason text,
  p_expected_assignee uuid default null,
  p_enforce_expected boolean default false
) returns setof public.conversations
language plpgsql security definer
set search_path = public
as $$
declare
  v_from uuid;
  v_conv public.conversations%rowtype;
begin
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'agent') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'caller must be an active agent+ member of the organization';
  end if;

  if p_to_user_id is not null then
    if coalesce(public.fn_member_role_in_org(p_to_user_id, p_organization_id), 'none')
         not in ('agent','manager','admin') then
      raise exception 'assignee_not_eligible_member'
        using hint = 'target must be an active agent+ member of the organization';
    end if;
  end if;

  select assigned_to_user_id into v_from
    from public.conversations
   where id = p_conversation_id
     and organization_id = p_organization_id
   for update;

  if not found then
    return;
  end if;

  if p_enforce_expected and v_from is distinct from p_expected_assignee then
    return;
  end if;

  update public.conversations
     set assigned_to_user_id = p_to_user_id,
         -- Desnormalizado JUNTO com o dono, na mesma transação: nunca existe
         -- uma janela em que id e nome discordam. NULL junto com o id quando
         -- a atribuição é removida (release) — nunca sobra um nome órfão de
         -- dono nenhum. Lido de auth.users porque quem chama esta função
         -- (RPC) não necessariamente tem acesso ao Admin API — a definer
         -- resolve por dentro.
         assigned_to_user_name = case
           when p_to_user_id is null then null
           else (select raw_user_meta_data ->> 'full_name' from auth.users where id = p_to_user_id)
         end,
         assigned_at = case when p_to_user_id is null then null else now() end,
         assignee_kind = case when p_to_user_id is null then null else 'user' end,
         status = case when p_to_user_id is null then 'open' else 'claimed' end,
         status_changed_at = now(),
         unread_count_for_assignee = 0,
         bot_silenced_until = case
           when p_reason = 'routing'  then bot_silenced_until
           when p_to_user_id is null  then (case when last_handoff_at is null
                                                 then null
                                                 else bot_silenced_until end)
           else 'infinity'::timestamptz
         end,
         updated_at = now()
   where id = p_conversation_id
   returning * into v_conv;

  insert into public.conversation_assignment_events
    (organization_id, conversation_id, from_user_id, to_user_id, changed_by, reason)
  values
    (p_organization_id, p_conversation_id, v_from, p_to_user_id, auth.uid(), p_reason);

  return next v_conv;
end;
$$;

revoke all     on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean) from public;
revoke execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean) from anon;
grant  execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean)
  to authenticated, service_role;

-- ---- o banco passa a saber quem manda na conversa (migration 0203) ----
--
-- ## O defeito, medido na VPS do dono em 2026-08-30
--
-- As abas da Inbox descreviam QUEM MANDA lendo `conversations.status` cru. O
-- motor de IA nunca lê essa coluna. Na base real:
--
--     aba "IA"   (?status=ai_handling)              ->  2 conversas
--     aba "Fila" (sem dono + status open|pending)   -> 83 conversas
--     o motor realmente atenderia                   -> 49 conversas
--
-- `ai_handling` só é escrito por UM caminho em produção (a volta pelo botão
-- "Devolver ao automático"), então a aba da IA ficava quase vazia enquanto o robô
-- atendia quase tudo, e a Fila chamava de "aguardando atendente" o que o robô
-- estava atendendo naquele instante.
--
-- ## Por que a regra desce para o banco
--
-- O filtro precisa de `contacts.force_human` e `contacts.is_blocked`, que moram em
-- OUTRA tabela — reescrevê-lo no construtor de query seria a regra em duas
-- encarnações, que é exatamente o defeito que o worker legado acabou de pagar
-- (comparava `new Date('infinity')`, que é NaN, e a guarda nunca disparava).
--
-- Como campo calculado, o predicado vira UM só: a lista, os contadores, o painel
-- do gerente e o "você é o Nº da fila" que o cliente ouve pelo WhatsApp passam a
-- perguntar a mesma coisa ao mesmo lugar, e o cursor de paginação continua
-- intacto (filtrar em memória o quebraria).
--
-- ## O que impede TS e SQL de divergirem
--
-- `tests/invariants/comando-da-conversa-espelha-o-ts.test.ts` — produto cartesiano
-- do espaço de entrada inteiro (o domínio de `status` é lido de `pg_constraint`,
-- não digitado), comparado caso a caso com `comandoDaConversa()` de
-- `lib/inbox/comando-da-conversa.ts`. Status novo no CHECK que o corpus não cubra
-- REPROVA, em vez de sair da conta em silêncio.
--
-- ## Duas funções, e a separação tem motivo
--
-- `fn_comando_da_conversa` é a REGRA: `immutable`, sem tocar em tabela, com
-- `p_agora` como parâmetro — é o que o teste de espelho consegue chamar com um
-- relógio fixo, e sem isso o gate teria dois relógios e falharia de vez em quando
-- sozinho. `comando_da_conversa(conversations)` é a EXPOSIÇÃO: resolve o contato e
-- carimba `now()`; a assinatura de um argumento do tipo da tabela é o que faz o
-- PostgREST publicá-la como campo calculado (medido no PostgREST 14.10: aparece em
-- `?select=` e FILTRA em `?comando_da_conversa=in.(...)`).
create or replace function public.fn_comando_da_conversa(
  p_status                text,
  p_assigned_to_user_id   uuid,
  p_bot_silenced_until    timestamptz,
  p_force_human           boolean,
  p_is_blocked            boolean,
  p_agora                 timestamptz
) returns text
language sql
immutable
set search_path = public
as $fn_comando$
  select case
    -- A ordem é a mesma de `comandoDaConversa`, e ela é o contrato: dono primeiro
    -- (a aba "Fechadas" precisa continuar dizendo QUEM atendeu), encerrada depois,
    -- e só então as travas.
    when p_assigned_to_user_id is not null then 'humano'
    when p_status in ('closed', 'archived', 'resolved') then 'encerrada'
    when p_force_human is true
      or p_is_blocked is true
      or (p_bot_silenced_until is not null and p_bot_silenced_until > p_agora) then 'aguardando'
    else 'automatico'
  end;
$fn_comando$;

comment on function public.fn_comando_da_conversa(text, uuid, timestamptz, boolean, boolean, timestamptz)
  is 'Quem manda na conversa. Espelho SQL de comandoDaConversa() (lib/inbox/comando-da-conversa.ts); as duas são casadas por tests/invariants/comando-da-conversa-espelha-o-ts.test.ts.';

create or replace function public.comando_da_conversa(c public.conversations)
returns text
language sql
stable
set search_path = public
as $comando$
  select public.fn_comando_da_conversa(
    c.status,
    c.assigned_to_user_id,
    c.bot_silenced_until,
    -- `coalesce` porque `contact_id` é anulável no schema: contato ausente não pode
    -- virar `null` e derrubar a linha inteira para fora de todo filtro — o efeito
    -- seria uma conversa invisível em TODAS as abas.
    coalesce((select ct.force_human from public.contacts ct where ct.id = c.contact_id), false),
    coalesce((select ct.is_blocked  from public.contacts ct where ct.id = c.contact_id), false),
    now()
  );
$comando$;

comment on function public.comando_da_conversa(public.conversations)
  is 'Campo calculado exposto pelo PostgREST: ?select=comando_da_conversa e ?comando_da_conversa=in.(...). Resolve o contato e carimba now(); a regra em si é fn_comando_da_conversa.';

-- Doutrina de migrations, regra 9: função nova em `public` nasce EXPOSTA, e são
-- DUAS origens de EXECUTE. A varredura auto-curativa no fim deste arquivo NÃO
-- alcança estas duas — o laço dela percorre só `p.prosecdef` (security definer), e
-- estas são invoker de propósito (o campo calculado tem de respeitar a RLS de quem
-- pergunta). Então a revogação é explícita aqui.
revoke execute on function public.fn_comando_da_conversa(text, uuid, timestamptz, boolean, boolean, timestamptz) from public, anon;
revoke execute on function public.comando_da_conversa(public.conversations) from public, anon;
grant  execute on function public.fn_comando_da_conversa(text, uuid, timestamptz, boolean, boolean, timestamptz) to authenticated, service_role;
grant  execute on function public.comando_da_conversa(public.conversations) to authenticated, service_role;

-- Sem isto o campo existe no banco e o PostgREST segue servindo o schema velho:
-- `?comando_da_conversa=...` volta 400 e a Inbox inteira fica vazia até alguém
-- reiniciar o serviço à mão — que é justamente o passo manual que a doutrina de
-- packaging proíbe pedir a quem opera uma VPS.
notify pgrst, 'reload schema';

-- ---- o catálogo de produtos da loja (migration 0204) ----
create table if not exists public.catalog_products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- O código do dono da loja (SKU, código interno). É por ele que a importação
  -- de planilha reconhece "isto é o mesmo produto, atualize" em vez de duplicar.
  codigo text not null,
  nome text not null,
  descricao text,

  marca text,
  categoria text,

  -- `_cents` + `moeda`, a regra do CLAUDE.md. `nuvemshop_products` não tem
  -- moeda e é a exceção errada, não o padrão: `orders` e `crm_leads` têm.
  preco_cents bigint not null,
  moeda text not null default 'BRL',
  -- O que a loja pagou. Existe para a regra de desconto do agente ter piso: sem
  -- custo, "pode dar 10%" é um número que ninguém sabe se cabe. Opcional porque
  -- muita loja não quer essa informação no sistema.
  custo_cents bigint,

  -- ⚠️ `controla_estoque` NÃO é firula, é o conserto de uma armadilha medida na
  -- tool antiga: ela filtra `available_qty > 0` por default, então uma loja que
  -- não conta estoque (decant de perfume, item sob encomenda) teria o catálogo
  -- INTEIRO invisível para o agente. Com este campo, quem não controla estoque
  -- continua aparecendo.
  controla_estoque boolean not null default true,
  quantidade integer not null default 0,

  ativo boolean not null default true,
  -- 'manual' | 'planilha' | 'nuvemshop'. Vocabulário ABERTO de propósito (sem
  -- CHECK): um clone com origem legada quebraria o `update.sh`, e a doutrina de
  -- migrations proíbe. Quem escreve usa a constante de `lib/catalogo/tipos.ts`.
  origem text not null default 'manual',

  imagem_url text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint catalog_products_preco_nao_negativo check (preco_cents >= 0),
  constraint catalog_products_custo_nao_negativo check (custo_cents is null or custo_cents >= 0),
  constraint catalog_products_quantidade_nao_negativa check (quantidade >= 0),
  constraint catalog_products_moeda_iso check (moeda ~ '^[A-Z]{3}$')
);

-- O código é a identidade dentro da organização: é ele que a planilha reusa.
create unique index if not exists catalog_products_org_codigo_key
  on public.catalog_products (organization_id, codigo);

-- A lista da tela: ativos primeiro, depois por nome.
create index if not exists catalog_products_org_ativos_idx
  on public.catalog_products (organization_id, ativo, nome);

-- ⚠️ O ÍNDICE QUE FAZ A BUSCA DO AGENTE FUNCIONAR.
--
-- O cliente escreve "ifone 15 pro 256", e o catálogo diz "iPhone 15 Pro 256GB".
-- Medido em 20 mil títulos: `ilike '%ifone 15%'` devolve ZERO linhas, e a
-- similaridade da frase inteira não separa 128GB de 256GB — que é exatamente
-- onde o preço erra. A busca é por TOKEN (ver `lib/catalogo/busca.ts`), e o
-- trigrama serve a parte difusa dela.
create index if not exists catalog_products_nome_trgm
  on public.catalog_products using gin (nome public.gin_trgm_ops);

alter table public.catalog_products enable row level security;

-- Leitura para a organização; ESCRITA só de `manager` para cima. É o molde da
-- 0177 (`calendar_event_types`), e é o que a tabela da Nuvemshop não tem: preço
-- de venda não se altera com papel de leitura.
drop policy if exists catalog_products_select on public.catalog_products;
create policy catalog_products_select on public.catalog_products
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists catalog_products_write on public.catalog_products;
create policy catalog_products_write on public.catalog_products
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

-- `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon` do baseline alcança
-- TODA tabela criada depois dele — inclusive esta. Sem o revoke, o catálogo
-- inteiro fica legível pela anon key, que vai para o browser.
revoke all on public.catalog_products from anon;
grant select, insert, update, delete on public.catalog_products to authenticated;
grant all on public.catalog_products to service_role;

drop trigger if exists trg_catalog_products_updated_at on public.catalog_products;
create trigger trg_catalog_products_updated_at
  before update on public.catalog_products
  for each row execute function public.fn_set_updated_at();

comment on table public.catalog_products is
  'O catálogo que a LOJA possui — uma linha por item vendável, com o preço que o agente de IA responde. Distinto de nuvemshop_products, que é ESPELHO de uma loja remota: aqui a loja é a fonte da verdade.';
comment on column public.catalog_products.codigo is
  'Código interno do dono (SKU). É a identidade que a importação de planilha reusa para atualizar em vez de duplicar.';
comment on column public.catalog_products.custo_cents is
  'O que a loja pagou. Existe para a regra de desconto do agente ter piso — sem custo, um teto de desconto é um número que ninguém sabe se cabe.';
comment on column public.catalog_products.controla_estoque is
  'false = item que não se conta (decant, sob encomenda). A busca do agente não o esconde por quantidade zero.';


-- ---- VARREDURA anon: função nova nasce exposta em quem ATUALIZA (migration 0116) ----
--
-- ⚠️ ESTE BLOCO É, DE PROPÓSITO, O ÚLTIMO DO ARQUIVO. Apêndice novo entra ANTES
-- dele — quem o empurrar para o meio desarma a cura para tudo que vier depois.
-- Vigiado por `tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts`.
--
-- A 0108 revogou anon numa LISTA de 8 funções, medida num banco instalado do
-- ZERO. Quem ATUALIZA tem outro estado: o `ALTER DEFAULT PRIVILEGES ... GRANT
-- ALL ON FUNCTIONS TO anon` do corpo deste arquivo grava uma entrada em
-- `pg_default_acl` que fica no catálogo PARA SEMPRE, e a partir daí toda função
-- criada em `public` nasce com EXECUTE para anon — inclusive as deste apêndice.
--
-- Medido numa VPS real (2026-08-07), comparando com o que um install fresco
-- produz: 6 definer expostas a anon e 5 a authenticated, entre elas
-- `fn_decrypt_oauth` — alcançável pela anon key, que vai para o browser.
--
-- Lista conserta o estoque e reabre no próximo `create function`. Esta varredura
-- é auto-curativa e roda DEPOIS de tudo que cria função, então cura no mesmo run
-- em que o defeito nasceria. Desfazer o ALTER DEFAULT PRIVILEGES não serve: ele
-- vem do `pg_dump` do Supabase e é reescrito a cada re-aplicação.
--
-- As duas origens de EXECUTE (a mesma lição da 0108): grant DIRETO a anon, que
-- `revoke from public` não remove; e grant a PUBLIC, do qual anon HERDA, que
-- `revoke from anon` não remove. O privilégio EFETIVO de authenticated e
-- service_role é medido ANTES e devolvido depois — tira anon sem tirar leitura.
do $$
declare
  f record;
  tinha_auth boolean;
  tinha_service boolean;
begin
  if to_regrole('anon') is null then
    return;
  end if;

  for f in
    select p.oid, p.oid::regprocedure as assinatura
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosecdef
  loop
    tinha_auth := to_regrole('authenticated') is not null
                  and has_function_privilege('authenticated', f.oid, 'EXECUTE');
    tinha_service := to_regrole('service_role') is not null
                     and has_function_privilege('service_role', f.oid, 'EXECUTE');

    execute format('revoke execute on function %s from public, anon', f.assinatura);

    if tinha_auth then
      execute format('grant execute on function %s to authenticated', f.assinatura);
    end if;
    if tinha_service then
      execute format('grant execute on function %s to service_role', f.assinatura);
    end if;
  end loop;
end $$;

-- regra 2 (authenticated): as 5 que o update abriu e o install não abre. Aqui não
-- cabe varredura — `authenticated` PRECISA de EXECUTE nos helpers de RLS e em
-- `retrieve_top_k_chunks` (num install fresco ele tem). É julgamento por função,
-- e o alvo de cada linha é o valor que um install fresco produz, medido.
revoke execute on function public.fn_audit_log_row() from authenticated;
revoke execute on function public.fn_decrypt_oauth(bytea) from authenticated;
revoke execute on function public.fn_encrypt_oauth(text) from authenticated;
revoke execute on function public.fn_lgpd_cascade_redact_contact(uuid, uuid, uuid) from authenticated;
revoke execute on function public.fn_update_budget_consumption() from authenticated;

grant execute on function public.fn_audit_log_row() to service_role;
grant execute on function public.fn_decrypt_oauth(bytea) to service_role;
grant execute on function public.fn_encrypt_oauth(text) to service_role;
grant execute on function public.fn_lgpd_cascade_redact_contact(uuid, uuid, uuid) to service_role;
grant execute on function public.fn_update_budget_consumption() to service_role;

-- ---- versão de acervo conta por MATERIAL, não por agente (migration 0205) ----
--
-- O índice `ai_kbv_version_unique` era `(agent_id, version_number)`, mas desde a
-- 0181 o número é contado por `knowledge_source_id`. Toda fonte nova nasce com
-- `version_number = 1`, então a SEGUNDA fonte do mesmo agente colidia com a
-- primeira e nunca indexava — a tela dizia "pronto" e `chunks_count` ficava 0.
-- Determinístico, não corrida. Medido em produção: 5 materiais, 1 indexou.
--
-- Dois índices parciais porque há dois regimes: versões anteriores à 0181 têm
-- `knowledge_source_id` NULL e guardam o invariante antigo (por agente); sem o
-- segundo índice elas ficariam sem restrição, já que NULL não colide com NULL.
delete from public.ai_knowledge_versions v
 where v.knowledge_source_id is not null
   and exists (
     select 1 from public.ai_knowledge_versions o
      where o.knowledge_source_id = v.knowledge_source_id
        and o.version_number = v.version_number
        and o.id < v.id
   );

alter table public.ai_knowledge_versions
  drop constraint if exists ai_kbv_version_unique;

drop index if exists public.ai_kbv_version_unique;

create unique index if not exists ai_kbv_version_por_fonte
  on public.ai_knowledge_versions (knowledge_source_id, version_number)
  where knowledge_source_id is not null;

create unique index if not exists ai_kbv_version_por_agente_legado
  on public.ai_knowledge_versions (agent_id, version_number)
  where knowledge_source_id is null;
