-- 0240 · Fluxo de atendimento robusto: RBAC das tabelas novas + LGPD da síntese/trilha.
--
-- ─── O que entra ────────────────────────────────────────────────────────────
-- 1. RBAC — `contact_flow_data` (0236) e `contact_flow_events` (0239) nasceram com
--    policy `ALL` só-tenancy (`organization_id in fn_user_org_ids()`), sem
--    `fn_role_at_least`. O invariante `tests/invariants/rbac-config-ia-canais.test.ts`
--    ("nenhuma tabela NOVA entra com policy ALL só-tenancy") reprova as duas. Aqui
--    elas seguem o padrão das tabelas já corrigidas: SELECT por tenancy e escrita
--    para `manager`+ (é o papel que edita fluxo; o motor escreve com `service_role`,
--    que bypassa RLS — logo o aperto não toca o runtime).
-- 2. LGPD — `followup_enrollments.completion_note` (síntese, coluna `_note`) faz a
--    tabela entrar no escopo de `fn_lgpd_cascade_redact_contact`. A função ganha o
--    passo que zera a síntese e a trilha (`contact_flow_events.payload/field_key`),
--    preservando as linhas (o vínculo com o fluxo é operacional, não da pessoa).
--
-- Aditiva e idempotente (drop if exists + create or replace). Nenhuma função NOVA
-- em `public` ⇒ o item 9 da doutrina de migrations não é acionado.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. RBAC: contact_flow_data
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists tenant_isolation_contact_flow_data_all on public.contact_flow_data;

drop policy if exists tenant_isolation_contact_flow_data_select on public.contact_flow_data;
create policy tenant_isolation_contact_flow_data_select on public.contact_flow_data
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );

drop policy if exists tenant_isolation_contact_flow_data_write on public.contact_flow_data;
create policy tenant_isolation_contact_flow_data_write on public.contact_flow_data
  for all using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager'))
    or public.fn_is_platform_admin()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager'))
    or public.fn_is_platform_admin()
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. RBAC: contact_flow_events
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists tenant_isolation_contact_flow_events_all on public.contact_flow_events;

drop policy if exists tenant_isolation_contact_flow_events_select on public.contact_flow_events;
create policy tenant_isolation_contact_flow_events_select on public.contact_flow_events
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );

drop policy if exists tenant_isolation_contact_flow_events_write on public.contact_flow_events;
create policy tenant_isolation_contact_flow_events_write on public.contact_flow_events
  for all using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager'))
    or public.fn_is_platform_admin()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager'))
    or public.fn_is_platform_admin()
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. LGPD: a cascata alcança a síntese e a trilha do fluxo de atendimento.
--    Mesma função da 0229, com o passo 6b acrescentado.
-- ─────────────────────────────────────────────────────────────────────────────
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
  perform public.fn_service_lock(p_organization_id,p_contact_id);
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

  -- 3. messages: redact body + null media + strip metadata
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

  -- 5. crm_leads — strip title/description/custom_fields/source_metadata/tags
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

  -- 6b. Fluxo de atendimento — a SÍNTESE (`completion_note`) e a TRILHA
  --     (`contact_flow_events.payload/field_key/message_id`) guardam o que o
  --     cliente respondeu/fez. Zera o conteúdo pessoal PRESERVANDO a linha: o
  --     vínculo com o fluxo é dado operacional, não da pessoa. O `contact_flow_data`
  --     não entra aqui porque seus valores passam por anonimização do contato e
  --     suas CHAVES não carregam nome de pessoa; a linha sai pela FK ao apagar.
  update followup_enrollments set
    completion_note = null,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('followup_enrollments', v_count);

  update contact_flow_events set
    payload = '{}'::jsonb,
    field_key = null,
    message_id = null
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('contact_flow_events', v_count);

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

revoke all on function public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid) to service_role;

notify pgrst, 'reload schema';
