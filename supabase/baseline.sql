


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
      'type', new.type, 'status', new.status, 'external_id', new.external_id
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
    email_normalized = null,
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

  -- 4. crm_lead_activities — strip both payload and metadata (jsonb may contain message bodies / contact info)
  update crm_lead_activities set
    payload = '{}'::jsonb,
    metadata = '{}'::jsonb
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
      ('Em separacao',         'em_separacao',         false, false),
      ('Enviado',              'enviado',              false, false),
      ('Entregue',             'entregue',             false, false),
      ('Pos-venda',            'pos_venda',            false, false),
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



CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."rls_auto_enable"() OWNER TO "postgres";

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


ALTER TABLE ONLY "public"."ai_agent_runs"
    ADD CONSTRAINT "ai_agent_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_agent_versions"
    ADD CONSTRAINT "ai_agent_versions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_agent_versions"
    ADD CONSTRAINT "ai_agent_versions_unique_number" UNIQUE ("agent_id", "version_number");



ALTER TABLE ONLY "public"."ai_agents"
    ADD CONSTRAINT "ai_agents_name_unique" UNIQUE ("organization_id", "name");



ALTER TABLE ONLY "public"."ai_agents"
    ADD CONSTRAINT "ai_agents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_budgets"
    ADD CONSTRAINT "ai_budgets_pkey" PRIMARY KEY ("organization_id");



ALTER TABLE ONLY "public"."ai_chunks"
    ADD CONSTRAINT "ai_chunks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_chunks"
    ADD CONSTRAINT "ai_chunks_position_unique" UNIQUE ("knowledge_source_id", "kb_version_id", "position");



ALTER TABLE ONLY "public"."ai_faq_items"
    ADD CONSTRAINT "ai_faq_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_invocations"
    ADD CONSTRAINT "ai_invocations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_knowledge_versions"
    ADD CONSTRAINT "ai_kbv_version_unique" UNIQUE ("agent_id", "version_number");



ALTER TABLE ONLY "public"."ai_knowledge_sources"
    ADD CONSTRAINT "ai_knowledge_sources_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_knowledge_versions"
    ADD CONSTRAINT "ai_knowledge_versions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_models"
    ADD CONSTRAINT "ai_models_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_models"
    ADD CONSTRAINT "ai_models_unique" UNIQUE ("provider", "model_id");



ALTER TABLE ONLY "public"."ai_pricing"
    ADD CONSTRAINT "ai_pricing_pkey" PRIMARY KEY ("model");



ALTER TABLE ONLY "public"."ai_provider_credentials"
    ADD CONSTRAINT "ai_provider_credentials_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_provider_credentials"
    ADD CONSTRAINT "ai_provider_credentials_unique" UNIQUE ("organization_id", "provider", "label");



ALTER TABLE ONLY "public"."api_audit_log"
    ADD CONSTRAINT "api_audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."api_tokens"
    ADD CONSTRAINT "api_tokens_organization_id_prefix_key" UNIQUE ("organization_id", "prefix");



ALTER TABLE ONLY "public"."api_tokens"
    ADD CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."channel_session_warmup"
    ADD CONSTRAINT "channel_session_warmup_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."channel_sessions"
    ADD CONSTRAINT "channel_sessions_phone_per_org_unique" UNIQUE ("organization_id", "phone_number") DEFERRABLE INITIALLY DEFERRED;



ALTER TABLE ONLY "public"."channel_sessions"
    ADD CONSTRAINT "channel_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."channel_sessions"
    ADD CONSTRAINT "channel_sessions_waha_session_name_unique" UNIQUE ("waha_session_name");



ALTER TABLE ONLY "public"."channel_sessions"
    ADD CONSTRAINT "channel_sessions_webhook_path_token_unique" UNIQUE ("webhook_path_token");



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_unique_per_contact_session" UNIQUE ("organization_id", "contact_id", "channel_session_id", "group_chat_id");



ALTER TABLE ONLY "public"."crm_lead_activities"
    ADD CONSTRAINT "crm_lead_activities_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."crm_lead_links"
    ADD CONSTRAINT "crm_lead_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."crm_leads"
    ADD CONSTRAINT "crm_leads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."crm_pipelines"
    ADD CONSTRAINT "crm_pipelines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."crm_stages"
    ADD CONSTRAINT "crm_stages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_log"
    ADD CONSTRAINT "event_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."idempotency_keys"
    ADD CONSTRAINT "idempotency_keys_organization_id_key_endpoint_key" UNIQUE ("organization_id", "key", "endpoint");



ALTER TABLE ONLY "public"."idempotency_keys"
    ADD CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."incidents"
    ADD CONSTRAINT "incidents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lgpd_requests"
    ADD CONSTRAINT "lgpd_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."merge_queue"
    ADD CONSTRAINT "merge_queue_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_org_external_id_unique" UNIQUE ("organization_id", "external_id") DEFERRABLE INITIALLY DEFERRED;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."nuvemshop_products"
    ADD CONSTRAINT "nuvemshop_products_organization_id_external_id_key" UNIQUE ("organization_id", "external_id");



ALTER TABLE ONLY "public"."nuvemshop_products"
    ADD CONSTRAINT "nuvemshop_products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_organization_id_external_provider_external_id_key" UNIQUE ("organization_id", "external_provider", "external_id");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_cnpj_key" UNIQUE ("cnpj");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."platform_admins"
    ADD CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."storage_redaction_queue"
    ADD CONSTRAINT "storage_redaction_queue_bucket_object_path_key" UNIQUE ("bucket", "object_path");



ALTER TABLE ONLY "public"."storage_redaction_queue"
    ADD CONSTRAINT "storage_redaction_queue_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tenant_integrations"
    ADD CONSTRAINT "tenant_integrations_organization_id_provider_key" UNIQUE ("organization_id", "provider");



ALTER TABLE ONLY "public"."tenant_integrations"
    ADD CONSTRAINT "tenant_integrations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_organizations"
    ADD CONSTRAINT "user_organizations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_organizations"
    ADD CONSTRAINT "user_organizations_user_id_organization_id_key" UNIQUE ("user_id", "organization_id");



ALTER TABLE ONLY "public"."user_recovery_codes"
    ADD CONSTRAINT "user_recovery_codes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."channel_session_warmup"
    ADD CONSTRAINT "warmup_session_day_unique" UNIQUE ("channel_session_id", "day");



ALTER TABLE ONLY "public"."webhook_events_log"
    ADD CONSTRAINT "webhook_events_log_pkey" PRIMARY KEY ("id");



CREATE INDEX "ai_agent_runs_agent_idx" ON "public"."ai_agent_runs" USING "btree" ("agent_id", "started_at" DESC);



CREATE UNIQUE INDEX "ai_agent_runs_one_running_per_conv" ON "public"."ai_agent_runs" USING "btree" ("conversation_id") WHERE (("status" = 'running'::"text") AND ("is_dry_run" = false));



CREATE INDEX "ai_agent_runs_org_started_idx" ON "public"."ai_agent_runs" USING "btree" ("organization_id", "started_at" DESC);



CREATE INDEX "ai_agent_runs_status_idx" ON "public"."ai_agent_runs" USING "btree" ("status", "started_at") WHERE ("status" = ANY (ARRAY['pending'::"text", 'running'::"text"]));



CREATE INDEX "ai_agent_versions_agent_idx" ON "public"."ai_agent_versions" USING "btree" ("agent_id", "version_number" DESC);



CREATE UNIQUE INDEX "ai_agents_one_default_per_org" ON "public"."ai_agents" USING "btree" ("organization_id") WHERE "is_default";



CREATE INDEX "ai_agents_org_active_idx" ON "public"."ai_agents" USING "btree" ("organization_id") WHERE "is_active";



CREATE INDEX "ai_agents_published_idx" ON "public"."ai_agents" USING "btree" ("organization_id", "priority" DESC) WHERE (("published_version_id" IS NOT NULL) AND ("archived_at" IS NULL));



CREATE INDEX "ai_chunks_embedding_ivfflat_idx" ON "public"."ai_chunks" USING "ivfflat" ("embedding" "public"."vector_cosine_ops") WITH ("lists"='100');



CREATE INDEX "ai_chunks_metadata_gin_idx" ON "public"."ai_chunks" USING "gin" ("metadata");



CREATE INDEX "ai_chunks_org_kbv_idx" ON "public"."ai_chunks" USING "btree" ("organization_id", "kb_version_id");



CREATE INDEX "ai_chunks_source_idx" ON "public"."ai_chunks" USING "btree" ("knowledge_source_id");



CREATE INDEX "ai_faq_items_org_idx" ON "public"."ai_faq_items" USING "btree" ("organization_id");



CREATE INDEX "ai_faq_items_source_idx" ON "public"."ai_faq_items" USING "btree" ("knowledge_source_id", "position");



CREATE INDEX "ai_invocations_agent_kind_idx" ON "public"."ai_invocations" USING "btree" ("agent_id", "invocation_kind");



CREATE INDEX "ai_invocations_conversation_idx" ON "public"."ai_invocations" USING "btree" ("conversation_id") WHERE ("conversation_id" IS NOT NULL);



CREATE INDEX "ai_invocations_org_created_idx" ON "public"."ai_invocations" USING "btree" ("organization_id", "created_at" DESC);



CREATE UNIQUE INDEX "ai_kbv_one_active_per_agent" ON "public"."ai_knowledge_versions" USING "btree" ("agent_id") WHERE "is_active";



CREATE INDEX "ai_knowledge_sources_agent_idx" ON "public"."ai_knowledge_sources" USING "btree" ("agent_id", "is_active");



CREATE UNIQUE INDEX "ai_knowledge_sources_unique_per_agent" ON "public"."ai_knowledge_sources" USING "btree" ("agent_id", "source_type") WHERE "is_active";



CREATE UNIQUE INDEX "ai_models_one_default_per_provider" ON "public"."ai_models" USING "btree" ("provider") WHERE "is_default_for_provider";



CREATE INDEX "ai_provider_credentials_org_provider_idx" ON "public"."ai_provider_credentials" USING "btree" ("organization_id", "provider") WHERE "is_active";



CREATE INDEX "conversations_bot_silenced_idx" ON "public"."conversations" USING "btree" ("bot_silenced_until") WHERE ("bot_silenced_until" IS NOT NULL);



CREATE INDEX "conversations_usable_rag_idx" ON "public"."conversations" USING "btree" ("organization_id", "usable_for_rag", "usable_for_rag_marked_at") WHERE ("usable_for_rag" = true);



CREATE INDEX "event_log_consumed_by_gin" ON "public"."event_log" USING "gin" ("consumed_by");



CREATE INDEX "event_log_dead_idx" ON "public"."event_log" USING "btree" ("organization_id", "created_at" DESC) WHERE ("status" = 'dead'::"text");



CREATE INDEX "event_log_entity_idx" ON "public"."event_log" USING "btree" ("entity_kind", "entity_id", "created_at" DESC);



CREATE INDEX "event_log_org_type_idx" ON "public"."event_log" USING "btree" ("organization_id", "event_type", "created_at" DESC);



CREATE INDEX "event_log_pending_idx" ON "public"."event_log" USING "btree" ("organization_id", "created_at") WHERE ("status" = 'pending'::"text");



CREATE INDEX "idx_api_tokens_hash" ON "public"."api_tokens" USING "btree" ("token_hash") WHERE ("revoked_at" IS NULL);



CREATE INDEX "idx_api_tokens_org" ON "public"."api_tokens" USING "btree" ("organization_id") WHERE ("revoked_at" IS NULL);



CREATE INDEX "idx_audit_action_time" ON "public"."api_audit_log" USING "btree" ("action", "created_at" DESC);



CREATE INDEX "idx_audit_actor_time" ON "public"."api_audit_log" USING "btree" ("actor_user_id", "created_at" DESC);



CREATE INDEX "idx_audit_org_time" ON "public"."api_audit_log" USING "btree" ("organization_id", "created_at" DESC);



CREATE INDEX "idx_audit_request" ON "public"."api_audit_log" USING "btree" ("request_id");



CREATE INDEX "idx_audit_resource" ON "public"."api_audit_log" USING "btree" ("resource_type", "resource_id");



CREATE INDEX "idx_channel_sessions_health" ON "public"."channel_sessions" USING "btree" ("last_health_check_at") WHERE ("status" = 'WORKING'::"text");



CREATE INDEX "idx_channel_sessions_org_status" ON "public"."channel_sessions" USING "btree" ("organization_id", "status");



CREATE INDEX "idx_contacts_consent_gin" ON "public"."contacts" USING "gin" ("consent" "jsonb_path_ops");



CREATE INDEX "idx_contacts_org_blocked" ON "public"."contacts" USING "btree" ("organization_id") WHERE ("is_blocked" = true);



CREATE INDEX "idx_contacts_org_last_activity" ON "public"."contacts" USING "btree" ("organization_id", "last_activity_at" DESC NULLS LAST);



CREATE INDEX "idx_contacts_org_name_trgm" ON "public"."contacts" USING "gin" ("name" "public"."gin_trgm_ops");



CREATE INDEX "idx_contacts_tags_gin" ON "public"."contacts" USING "gin" ("tags");



CREATE INDEX "idx_conversations_assigned" ON "public"."conversations" USING "btree" ("assigned_to_user_id", "status") WHERE ("assigned_to_user_id" IS NOT NULL);



CREATE INDEX "idx_conversations_open_unassigned" ON "public"."conversations" USING "btree" ("organization_id", "last_inbound_at" DESC) WHERE (("status" = 'open'::"text") AND ("assigned_to_user_id" IS NULL));



CREATE INDEX "idx_conversations_org_last_msg" ON "public"."conversations" USING "btree" ("organization_id", "last_message_at" DESC NULLS LAST);



CREATE INDEX "idx_crm_lead_links_lead" ON "public"."crm_lead_links" USING "btree" ("lead_id");



CREATE INDEX "idx_crm_lead_links_org_target" ON "public"."crm_lead_links" USING "btree" ("organization_id", "target_kind", "target_id");



CREATE INDEX "idx_crm_leads_custom_fields_gin" ON "public"."crm_leads" USING "gin" ("custom_fields" "jsonb_path_ops");



CREATE INDEX "idx_crm_leads_org_contact" ON "public"."crm_leads" USING "btree" ("organization_id", "contact_id");



CREATE INDEX "idx_crm_leads_org_expected_close_overdue" ON "public"."crm_leads" USING "btree" ("organization_id", "expected_close_date") WHERE (("status" = 'open'::"text") AND ("expected_close_date" IS NOT NULL));



CREATE INDEX "idx_crm_leads_org_last_activity" ON "public"."crm_leads" USING "btree" ("organization_id", "last_activity_at" DESC NULLS LAST);



CREATE INDEX "idx_crm_leads_org_owner_status" ON "public"."crm_leads" USING "btree" ("organization_id", "owner_user_id", "status") WHERE ("status" = 'open'::"text");



CREATE INDEX "idx_crm_leads_org_pipeline_status" ON "public"."crm_leads" USING "btree" ("organization_id", "pipeline_id", "status");



CREATE INDEX "idx_crm_leads_org_stage_position" ON "public"."crm_leads" USING "btree" ("organization_id", "stage_id", "position_in_stage");



CREATE INDEX "idx_crm_leads_tags_gin" ON "public"."crm_leads" USING "gin" ("tags");



CREATE INDEX "idx_crm_pipelines_org_position" ON "public"."crm_pipelines" USING "btree" ("organization_id", "position") WHERE ("is_archived" = false);



CREATE INDEX "idx_crm_stages_pipeline_position" ON "public"."crm_stages" USING "btree" ("pipeline_id", "position") WHERE ("is_archived" = false);



CREATE INDEX "idx_idem_expiry" ON "public"."idempotency_keys" USING "btree" ("expires_at");



CREATE INDEX "idx_idem_lookup" ON "public"."idempotency_keys" USING "btree" ("organization_id", "key", "endpoint");



CREATE INDEX "idx_lead_activities_org_contact" ON "public"."crm_lead_activities" USING "btree" ("organization_id", "contact_id", "performed_at" DESC);



CREATE INDEX "idx_lead_activities_org_lead_perf" ON "public"."crm_lead_activities" USING "btree" ("organization_id", "lead_id", "performed_at" DESC);



CREATE INDEX "idx_lead_activities_org_type_perf" ON "public"."crm_lead_activities" USING "btree" ("organization_id", "type", "performed_at" DESC);



CREATE INDEX "idx_lead_activities_payload_gin" ON "public"."crm_lead_activities" USING "gin" ("payload" "jsonb_path_ops");



CREATE INDEX "idx_merge_queue_org_status" ON "public"."merge_queue" USING "btree" ("organization_id", "status", "created_at");



CREATE INDEX "idx_messages_conversation_sent" ON "public"."messages" USING "btree" ("conversation_id", "sent_at" DESC);



CREATE INDEX "idx_messages_external_lookup" ON "public"."messages" USING "btree" ("organization_id", "external_id") WHERE ("external_id" IS NOT NULL);



CREATE INDEX "idx_messages_org_status_created" ON "public"."messages" USING "btree" ("organization_id", "status", "created_at") WHERE ("status" = ANY (ARRAY['sending'::"text", 'failed'::"text"]));



CREATE INDEX "idx_organizations_pending_onboarding" ON "public"."organizations" USING "btree" ("id") WHERE ("onboarded_at" IS NULL);



CREATE INDEX "idx_orgs_slug" ON "public"."organizations" USING "btree" ("slug");



CREATE INDEX "idx_orgs_status" ON "public"."organizations" USING "btree" ("status") WHERE ("status" = 'active'::"text");



CREATE UNIQUE INDEX "idx_recovery_unique" ON "public"."user_recovery_codes" USING "btree" ("user_id", "code_hash");



CREATE INDEX "idx_recovery_user" ON "public"."user_recovery_codes" USING "btree" ("user_id") WHERE ("used_at" IS NULL);



CREATE INDEX "idx_user_orgs_org_role" ON "public"."user_organizations" USING "btree" ("organization_id", "role") WHERE ("revoked_at" IS NULL);



CREATE INDEX "idx_user_orgs_user" ON "public"."user_organizations" USING "btree" ("user_id") WHERE ("revoked_at" IS NULL);



CREATE INDEX "idx_warmup_org_day" ON "public"."channel_session_warmup" USING "btree" ("organization_id", "day" DESC);



CREATE INDEX "idx_webhook_events_external_id" ON "public"."webhook_events_log" USING "btree" ("organization_id", "provider", "external_id") WHERE ("external_id" IS NOT NULL);



CREATE INDEX "idx_webhook_events_org_received" ON "public"."webhook_events_log" USING "btree" ("organization_id", "received_at" DESC);



CREATE INDEX "idx_webhook_events_status_received" ON "public"."webhook_events_log" USING "btree" ("status", "received_at") WHERE ("status" = ANY (ARRAY['received'::"text", 'error'::"text"]));



CREATE INDEX "incidents_org_idx" ON "public"."incidents" USING "btree" ("organization_id", "created_at" DESC);



CREATE INDEX "incidents_severity_idx" ON "public"."incidents" USING "btree" ("severity", "status");



CREATE INDEX "incidents_status_idx" ON "public"."incidents" USING "btree" ("status", "created_at" DESC) WHERE ("status" <> 'resolved'::"text");



CREATE INDEX "lgpd_requests_contact_idx" ON "public"."lgpd_requests" USING "btree" ("contact_id") WHERE ("contact_id" IS NOT NULL);



CREATE INDEX "lgpd_requests_emergency_idx" ON "public"."lgpd_requests" USING "btree" ("organization_id", "emergency", "due_at") WHERE ("emergency" = true);



CREATE INDEX "lgpd_requests_org_due_idx" ON "public"."lgpd_requests" USING "btree" ("organization_id", "due_at") WHERE ("status" = ANY (ARRAY['received'::"text", 'processing'::"text"]));



CREATE INDEX "lgpd_requests_org_status_idx" ON "public"."lgpd_requests" USING "btree" ("organization_id", "status");



CREATE INDEX "nuvemshop_products_org_idx" ON "public"."nuvemshop_products" USING "btree" ("organization_id");



CREATE INDEX "nuvemshop_products_rag_pending_idx" ON "public"."nuvemshop_products" USING "btree" ("organization_id") WHERE ("rag_indexed_at" IS NULL);



CREATE INDEX "nuvemshop_products_title_trgm" ON "public"."nuvemshop_products" USING "gin" ("title" "public"."gin_trgm_ops");



CREATE INDEX "orders_contact_idx" ON "public"."orders" USING "btree" ("contact_id") WHERE ("contact_id" IS NOT NULL);



CREATE INDEX "orders_customer_external_idx" ON "public"."orders" USING "btree" ("organization_id", "external_provider", "customer_external_id");



CREATE INDEX "orders_org_ordered_idx" ON "public"."orders" USING "btree" ("organization_id", "ordered_at" DESC);



CREATE INDEX "orders_payload_gin" ON "public"."orders" USING "gin" ("payload" "jsonb_path_ops");



CREATE INDEX "orders_status_idx" ON "public"."orders" USING "btree" ("organization_id", "status");



CREATE INDEX "storage_redaction_queue_org_idx" ON "public"."storage_redaction_queue" USING "btree" ("organization_id");



CREATE INDEX "storage_redaction_queue_status_idx" ON "public"."storage_redaction_queue" USING "btree" ("status", "enqueued_at") WHERE ("status" = 'pending'::"text");



CREATE INDEX "tenant_integrations_expires_idx" ON "public"."tenant_integrations" USING "btree" ("expires_at") WHERE ("expires_at" IS NOT NULL);



CREATE INDEX "tenant_integrations_org_idx" ON "public"."tenant_integrations" USING "btree" ("organization_id");



CREATE UNIQUE INDEX "tenant_integrations_path_token_idx" ON "public"."tenant_integrations" USING "btree" ("webhook_path_token");



CREATE INDEX "tenant_integrations_status_idx" ON "public"."tenant_integrations" USING "btree" ("status") WHERE ("status" = ANY (ARRAY['token_expired'::"text", 'error'::"text"]));



CREATE UNIQUE INDEX "uniq_contacts_org_cpf" ON "public"."contacts" USING "btree" ("organization_id", "cpf_hash") WHERE (("cpf_hash" IS NOT NULL) AND ("is_merged_into" IS NULL));



CREATE UNIQUE INDEX "uniq_contacts_org_email" ON "public"."contacts" USING "btree" ("organization_id", "email_normalized") WHERE (("email_normalized" IS NOT NULL) AND ("is_merged_into" IS NULL));



CREATE UNIQUE INDEX "uniq_contacts_org_phone" ON "public"."contacts" USING "btree" ("organization_id", "phone_number") WHERE (("phone_number" IS NOT NULL) AND ("is_merged_into" IS NULL));



CREATE UNIQUE INDEX "uniq_crm_lead_links_lead_target_link" ON "public"."crm_lead_links" USING "btree" ("lead_id", "target_kind", "target_id", "link_kind");



CREATE UNIQUE INDEX "uniq_crm_leads_org_source_external" ON "public"."crm_leads" USING "btree" ("organization_id", "source", "external_id") WHERE ("external_id" IS NOT NULL);



CREATE UNIQUE INDEX "uniq_crm_pipelines_org_default" ON "public"."crm_pipelines" USING "btree" ("organization_id") WHERE ("is_default" = true);



CREATE UNIQUE INDEX "uniq_crm_pipelines_org_slug" ON "public"."crm_pipelines" USING "btree" ("organization_id", "slug");



CREATE UNIQUE INDEX "uniq_crm_stages_pipeline_lost" ON "public"."crm_stages" USING "btree" ("pipeline_id") WHERE (("is_lost" = true) AND ("is_archived" = false));



CREATE UNIQUE INDEX "uniq_crm_stages_pipeline_slug" ON "public"."crm_stages" USING "btree" ("pipeline_id", "slug");



CREATE UNIQUE INDEX "uniq_crm_stages_pipeline_won" ON "public"."crm_stages" USING "btree" ("pipeline_id") WHERE (("is_won" = true) AND ("is_archived" = false));



CREATE INDEX "webhook_events_log_dlq_idx" ON "public"."webhook_events_log" USING "btree" ("organization_id", "provider") WHERE ("status" = 'dead'::"text");



CREATE INDEX "webhook_events_log_lgpd_idx" ON "public"."webhook_events_log" USING "btree" ("organization_id", "provider", "event_type", "received_at" DESC) WHERE ("event_type" = ANY (ARRAY['customer/redact'::"text", 'customer/data_request'::"text", 'store/redact'::"text"]));



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



ALTER TABLE ONLY "public"."ai_agent_runs"
    ADD CONSTRAINT "ai_agent_runs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agents"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."ai_agent_runs"
    ADD CONSTRAINT "ai_agent_runs_agent_version_id_fkey" FOREIGN KEY ("agent_version_id") REFERENCES "public"."ai_agent_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."ai_agent_runs"
    ADD CONSTRAINT "ai_agent_runs_channel_session_id_fkey" FOREIGN KEY ("channel_session_id") REFERENCES "public"."channel_sessions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ai_agent_runs"
    ADD CONSTRAINT "ai_agent_runs_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ai_agent_runs"
    ADD CONSTRAINT "ai_agent_runs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ai_agent_runs"
    ADD CONSTRAINT "ai_agent_runs_inbound_message_id_fkey" FOREIGN KEY ("inbound_message_id") REFERENCES "public"."messages"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ai_agent_runs"
    ADD CONSTRAINT "ai_agent_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_agent_runs"
    ADD CONSTRAINT "ai_agent_runs_outbound_message_id_fkey" FOREIGN KEY ("outbound_message_id") REFERENCES "public"."messages"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ai_agent_versions"
    ADD CONSTRAINT "ai_agent_versions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_agent_versions"
    ADD CONSTRAINT "ai_agent_versions_channel_session_id_fkey" FOREIGN KEY ("channel_session_id") REFERENCES "public"."channel_sessions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."ai_agent_versions"
    ADD CONSTRAINT "ai_agent_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."ai_agent_versions"
    ADD CONSTRAINT "ai_agent_versions_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "public"."ai_provider_credentials"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."ai_agent_versions"
    ADD CONSTRAINT "ai_agent_versions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_agents"
    ADD CONSTRAINT "ai_agents_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."ai_agents"
    ADD CONSTRAINT "ai_agents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_agents"
    ADD CONSTRAINT "ai_agents_published_version_id_fkey" FOREIGN KEY ("published_version_id") REFERENCES "public"."ai_agent_versions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ai_budgets"
    ADD CONSTRAINT "ai_budgets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_chunks"
    ADD CONSTRAINT "ai_chunks_knowledge_source_id_fkey" FOREIGN KEY ("knowledge_source_id") REFERENCES "public"."ai_knowledge_sources"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_chunks"
    ADD CONSTRAINT "ai_chunks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_faq_items"
    ADD CONSTRAINT "ai_faq_items_knowledge_source_id_fkey" FOREIGN KEY ("knowledge_source_id") REFERENCES "public"."ai_knowledge_sources"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_faq_items"
    ADD CONSTRAINT "ai_faq_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_invocations"
    ADD CONSTRAINT "ai_invocations_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_invocations"
    ADD CONSTRAINT "ai_invocations_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ai_invocations"
    ADD CONSTRAINT "ai_invocations_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ai_invocations"
    ADD CONSTRAINT "ai_invocations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_knowledge_sources"
    ADD CONSTRAINT "ai_knowledge_sources_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_knowledge_sources"
    ADD CONSTRAINT "ai_knowledge_sources_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_knowledge_versions"
    ADD CONSTRAINT "ai_knowledge_versions_activated_by_fkey" FOREIGN KEY ("activated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."ai_knowledge_versions"
    ADD CONSTRAINT "ai_knowledge_versions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_knowledge_versions"
    ADD CONSTRAINT "ai_knowledge_versions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_provider_credentials"
    ADD CONSTRAINT "ai_provider_credentials_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."ai_provider_credentials"
    ADD CONSTRAINT "ai_provider_credentials_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."api_audit_log"
    ADD CONSTRAINT "api_audit_log_actor_api_token_id_fkey" FOREIGN KEY ("actor_api_token_id") REFERENCES "public"."api_tokens"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."api_audit_log"
    ADD CONSTRAINT "api_audit_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."api_audit_log"
    ADD CONSTRAINT "api_audit_log_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."api_tokens"
    ADD CONSTRAINT "api_tokens_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."api_tokens"
    ADD CONSTRAINT "api_tokens_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."api_tokens"
    ADD CONSTRAINT "api_tokens_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."channel_session_warmup"
    ADD CONSTRAINT "channel_session_warmup_channel_session_id_fkey" FOREIGN KEY ("channel_session_id") REFERENCES "public"."channel_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."channel_session_warmup"
    ADD CONSTRAINT "channel_session_warmup_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."channel_sessions"
    ADD CONSTRAINT "channel_sessions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."channel_sessions"
    ADD CONSTRAINT "channel_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_is_merged_into_fkey" FOREIGN KEY ("is_merged_into") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_assigned_to_user_id_fkey" FOREIGN KEY ("assigned_to_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_channel_session_id_fkey" FOREIGN KEY ("channel_session_id") REFERENCES "public"."channel_sessions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_usable_for_rag_marked_by_fkey" FOREIGN KEY ("usable_for_rag_marked_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."crm_lead_activities"
    ADD CONSTRAINT "crm_lead_activities_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."crm_lead_activities"
    ADD CONSTRAINT "crm_lead_activities_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."crm_leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."crm_lead_activities"
    ADD CONSTRAINT "crm_lead_activities_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."crm_lead_links"
    ADD CONSTRAINT "crm_lead_links_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."crm_leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."crm_lead_links"
    ADD CONSTRAINT "crm_lead_links_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."crm_leads"
    ADD CONSTRAINT "crm_leads_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."crm_leads"
    ADD CONSTRAINT "crm_leads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."crm_leads"
    ADD CONSTRAINT "crm_leads_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "public"."crm_pipelines"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."crm_leads"
    ADD CONSTRAINT "crm_leads_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "public"."crm_stages"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."crm_pipelines"
    ADD CONSTRAINT "crm_pipelines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."crm_stages"
    ADD CONSTRAINT "crm_stages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."crm_stages"
    ADD CONSTRAINT "crm_stages_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "public"."crm_pipelines"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_log"
    ADD CONSTRAINT "event_log_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."idempotency_keys"
    ADD CONSTRAINT "idempotency_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."incidents"
    ADD CONSTRAINT "incidents_acknowledged_by_fkey" FOREIGN KEY ("acknowledged_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."incidents"
    ADD CONSTRAINT "incidents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."incidents"
    ADD CONSTRAINT "incidents_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."lgpd_requests"
    ADD CONSTRAINT "lgpd_requests_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."lgpd_requests"
    ADD CONSTRAINT "lgpd_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."merge_queue"
    ADD CONSTRAINT "merge_queue_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "public"."crm_lead_activities"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_channel_session_id_fkey" FOREIGN KEY ("channel_session_id") REFERENCES "public"."channel_sessions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_sent_by_user_id_fkey" FOREIGN KEY ("sent_by_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."nuvemshop_products"
    ADD CONSTRAINT "nuvemshop_products_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_suspended_by_fkey" FOREIGN KEY ("suspended_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."platform_admins"
    ADD CONSTRAINT "platform_admins_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."platform_admins"
    ADD CONSTRAINT "platform_admins_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."platform_admins"
    ADD CONSTRAINT "platform_admins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."storage_redaction_queue"
    ADD CONSTRAINT "storage_redaction_queue_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."storage_redaction_queue"
    ADD CONSTRAINT "storage_redaction_queue_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."lgpd_requests"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tenant_integrations"
    ADD CONSTRAINT "tenant_integrations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_organizations"
    ADD CONSTRAINT "user_organizations_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."user_organizations"
    ADD CONSTRAINT "user_organizations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_organizations"
    ADD CONSTRAINT "user_organizations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_recovery_codes"
    ADD CONSTRAINT "user_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."webhook_events_log"
    ADD CONSTRAINT "webhook_events_log_channel_session_id_fkey" FOREIGN KEY ("channel_session_id") REFERENCES "public"."channel_sessions"("id") ON DELETE SET NULL;



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


CREATE POLICY "ai_models_read_all" ON "public"."ai_models" FOR SELECT USING (true);



ALTER TABLE "public"."ai_pricing" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ai_pricing_public_read" ON "public"."ai_pricing" FOR SELECT USING (true);



ALTER TABLE "public"."ai_provider_credentials" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."api_audit_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."api_tokens" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "api_tokens_admin_only" ON "public"."api_tokens" USING (("public"."fn_role_at_least"("organization_id", 'admin'::"text") OR "public"."fn_is_platform_admin"())) WITH CHECK (("public"."fn_role_at_least"("organization_id", 'admin'::"text") OR "public"."fn_is_platform_admin"()));



CREATE POLICY "audit_log_insert_tenant_member" ON "public"."api_audit_log" FOR INSERT TO "authenticated" WITH CHECK ((("organization_id" IS NULL) OR ("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));



CREATE POLICY "audit_log_select" ON "public"."api_audit_log" FOR SELECT USING (("public"."fn_is_platform_admin"() OR (("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'admin'::"text"))));



ALTER TABLE "public"."channel_session_warmup" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."channel_sessions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "channel_sessions_tenant_isolation_all" ON "public"."channel_sessions" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));



ALTER TABLE "public"."contacts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."conversations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "conversations_tenant_isolation_all" ON "public"."conversations" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));



ALTER TABLE "public"."crm_lead_activities" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."crm_lead_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."crm_leads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."crm_pipelines" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."crm_stages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."event_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "event_log_select" ON "public"."event_log" FOR SELECT USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));



ALTER TABLE "public"."idempotency_keys" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "idempotency_tenant" ON "public"."idempotency_keys" USING (("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids"))) WITH CHECK (("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")));



ALTER TABLE "public"."incidents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lgpd_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "lgpd_requests_admin_select" ON "public"."lgpd_requests" FOR SELECT USING (("public"."fn_is_platform_admin"() OR (("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'admin'::"text"))));



CREATE POLICY "lgpd_requests_admin_write" ON "public"."lgpd_requests" USING (("public"."fn_is_platform_admin"() OR (("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'admin'::"text")))) WITH CHECK (("public"."fn_is_platform_admin"() OR (("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'admin'::"text"))));



ALTER TABLE "public"."merge_queue" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "merge_queue_manager_select" ON "public"."merge_queue" FOR SELECT USING (("public"."fn_is_platform_admin"() OR (("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'manager'::"text"))));



CREATE POLICY "merge_queue_manager_write" ON "public"."merge_queue" USING (("public"."fn_is_platform_admin"() OR (("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'manager'::"text")))) WITH CHECK (("public"."fn_is_platform_admin"() OR (("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'manager'::"text"))));



ALTER TABLE "public"."messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "messages_tenant_isolation_all" ON "public"."messages" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));



ALTER TABLE "public"."nuvemshop_products" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "nuvemshop_products_tenant" ON "public"."nuvemshop_products" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));



ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "orders_tenant_select" ON "public"."orders" FOR SELECT USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));



CREATE POLICY "orders_tenant_write" ON "public"."orders" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));



ALTER TABLE "public"."organizations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "orgs_select" ON "public"."organizations" FOR SELECT USING ((("id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));



CREATE POLICY "orgs_write_platform_admin" ON "public"."organizations" USING ("public"."fn_is_platform_admin"()) WITH CHECK ("public"."fn_is_platform_admin"());



CREATE POLICY "platform_admin_only_incidents" ON "public"."incidents" USING ("public"."fn_is_platform_admin"()) WITH CHECK ("public"."fn_is_platform_admin"());



ALTER TABLE "public"."platform_admins" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "platform_admins_self" ON "public"."platform_admins" FOR SELECT USING ("public"."fn_is_platform_admin"());



CREATE POLICY "recovery_codes_self" ON "public"."user_recovery_codes" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."storage_redaction_queue" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tenant_integrations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tenant_integrations_admin_write" ON "public"."tenant_integrations" USING (("public"."fn_is_platform_admin"() OR (("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'manager'::"text")))) WITH CHECK (("public"."fn_is_platform_admin"() OR (("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) AND "public"."fn_role_at_least"("organization_id", 'manager'::"text"))));



CREATE POLICY "tenant_integrations_select" ON "public"."tenant_integrations" FOR SELECT USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));



CREATE POLICY "tenant_isolation_ai_agent_runs_all" ON "public"."ai_agent_runs" USING (("organization_id" IN ( SELECT "fn_user_org_ids"."fn_user_org_ids"
   FROM "public"."fn_user_org_ids"() "fn_user_org_ids"("fn_user_org_ids")))) WITH CHECK (("organization_id" IN ( SELECT "fn_user_org_ids"."fn_user_org_ids"
   FROM "public"."fn_user_org_ids"() "fn_user_org_ids"("fn_user_org_ids"))));



CREATE POLICY "tenant_isolation_ai_agent_versions_all" ON "public"."ai_agent_versions" USING (("organization_id" IN ( SELECT "fn_user_org_ids"."fn_user_org_ids"
   FROM "public"."fn_user_org_ids"() "fn_user_org_ids"("fn_user_org_ids")))) WITH CHECK (("organization_id" IN ( SELECT "fn_user_org_ids"."fn_user_org_ids"
   FROM "public"."fn_user_org_ids"() "fn_user_org_ids"("fn_user_org_ids"))));



CREATE POLICY "tenant_isolation_ai_agents_all" ON "public"."ai_agents" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));



CREATE POLICY "tenant_isolation_ai_budgets_all" ON "public"."ai_budgets" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));



CREATE POLICY "tenant_isolation_ai_chunks_all" ON "public"."ai_chunks" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));



CREATE POLICY "tenant_isolation_ai_faq_items_all" ON "public"."ai_faq_items" USING (("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids"))) WITH CHECK (("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")));



CREATE POLICY "tenant_isolation_ai_invocations_all" ON "public"."ai_invocations" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));



CREATE POLICY "tenant_isolation_ai_kbv_all" ON "public"."ai_knowledge_versions" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));



CREATE POLICY "tenant_isolation_ai_knowledge_sources_all" ON "public"."ai_knowledge_sources" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));



CREATE POLICY "tenant_isolation_ai_provider_credentials_modify" ON "public"."ai_provider_credentials" USING (("organization_id" IN ( SELECT "fn_user_org_ids"."fn_user_org_ids"
   FROM "public"."fn_user_org_ids"() "fn_user_org_ids"("fn_user_org_ids")))) WITH CHECK (("organization_id" IN ( SELECT "fn_user_org_ids"."fn_user_org_ids"
   FROM "public"."fn_user_org_ids"() "fn_user_org_ids"("fn_user_org_ids"))));



CREATE POLICY "tenant_isolation_ai_provider_credentials_select" ON "public"."ai_provider_credentials" FOR SELECT USING (("organization_id" IN ( SELECT "fn_user_org_ids"."fn_user_org_ids"
   FROM "public"."fn_user_org_ids"() "fn_user_org_ids"("fn_user_org_ids"))));



CREATE POLICY "tenant_isolation_contacts_all" ON "public"."contacts" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));



CREATE POLICY "tenant_isolation_crm_lead_activities_insert" ON "public"."crm_lead_activities" FOR INSERT WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));



CREATE POLICY "tenant_isolation_crm_lead_activities_select" ON "public"."crm_lead_activities" FOR SELECT USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));



CREATE POLICY "tenant_isolation_crm_lead_links_all" ON "public"."crm_lead_links" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));



CREATE POLICY "tenant_isolation_crm_leads_all" ON "public"."crm_leads" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));



CREATE POLICY "tenant_isolation_crm_pipelines_all" ON "public"."crm_pipelines" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));



CREATE POLICY "tenant_isolation_crm_stages_all" ON "public"."crm_stages" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));



CREATE POLICY "tenant_isolation_storage_redaction_queue_all" ON "public"."storage_redaction_queue" USING (("organization_id" IN ( SELECT "fn_user_org_ids"."fn_user_org_ids"
   FROM "public"."fn_user_org_ids"() "fn_user_org_ids"("fn_user_org_ids")))) WITH CHECK (("organization_id" IN ( SELECT "fn_user_org_ids"."fn_user_org_ids"
   FROM "public"."fn_user_org_ids"() "fn_user_org_ids"("fn_user_org_ids"))));



ALTER TABLE "public"."user_organizations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_orgs_delete" ON "public"."user_organizations" FOR DELETE USING (("public"."fn_role_at_least"("organization_id", 'admin'::"text") OR "public"."fn_is_platform_admin"()));



CREATE POLICY "user_orgs_insert" ON "public"."user_organizations" FOR INSERT WITH CHECK (("public"."fn_role_at_least"("organization_id", 'admin'::"text") OR "public"."fn_is_platform_admin"()));



CREATE POLICY "user_orgs_select" ON "public"."user_organizations" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR "public"."fn_role_at_least"("organization_id", 'admin'::"text") OR "public"."fn_is_platform_admin"()));



CREATE POLICY "user_orgs_update" ON "public"."user_organizations" FOR UPDATE USING (("public"."fn_role_at_least"("organization_id", 'admin'::"text") OR "public"."fn_is_platform_admin"()));



ALTER TABLE "public"."user_recovery_codes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "warmup_tenant_isolation_all" ON "public"."channel_session_warmup" USING ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"())) WITH CHECK ((("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")) OR "public"."fn_is_platform_admin"()));



ALTER TABLE "public"."webhook_events_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "webhook_events_log_tenant_read" ON "public"."webhook_events_log" FOR SELECT USING (("public"."fn_is_platform_admin"() OR (("organization_id" IS NOT NULL) AND ("organization_id" IN ( SELECT "public"."fn_user_org_ids"() AS "fn_user_org_ids")))));



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



GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "anon";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "service_role";



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

-- ---- realtime: inbox (messages/conversations), kanban (crm_leads) e IA ----
do $$ begin
  if not exists (select 1 from pg_publication where pubname='supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
do $$
declare t text;
begin
  foreach t in array array['messages','conversations','crm_leads','ai_agents','ai_agent_runs','ai_knowledge_sources']
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
    unread_count_for_assignee = unread_count_for_assignee + case when p_direction = 'inbound' then 1 else 0 end,
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
-- Idempotente (create or replace + drop/create trigger). Ver migrations/20260718160000_0043.
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
  allow_sunday boolean,               -- domingo evitado por default
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

-- ---- bucket whatsapp-media (migration 0055) ----
insert into storage.buckets (id, name, public, file_size_limit)
values ('whatsapp-media', 'whatsapp-media', false, 52428800)
on conflict (id) do update set file_size_limit = excluded.file_size_limit;

-- ---- media multimodal: derivado + flags (migration 0056) ----
alter table messages
  add column if not exists media_derived_text text,
  add column if not exists media_derived_status text;
alter table ai_agent_versions
  add column if not exists multimodal_input boolean not null default true,
  add column if not exists video_frames_enabled boolean not null default false;
