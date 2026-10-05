-- manifest: Criação atômica de contato no negócio existente, sem conversa ou evento contact.created. Trava o negócio para impedir contatos órfãos em concorrência; respeita organização, papel, visibilidade e acompanhamento somente leitura.
create or replace function public.fn_create_contact_for_lead(
  p_organization_id uuid, p_lead_id uuid, p_contact jsonb
) returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_lead public.crm_leads%rowtype;
  v_input public.contacts%rowtype;
  v_contact public.contacts%rowtype;
begin
  if auth.uid() is null
    or not public.fn_role_at_least(p_organization_id, 'agent')
    or not public.fn_support_write_allowed(p_organization_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_lead from public.crm_leads
    where organization_id = p_organization_id and id = p_lead_id for update;
  if not found then raise exception 'not_found' using errcode = 'PT404'; end if;
  if not public.fn_can_view_lead(p_organization_id, v_lead.owner_user_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_lead.contact_id is not null then
    raise exception 'already_linked' using errcode = 'PT409';
  end if;
  -- Whitelist: o JSON não pode escolher organização, autor, id ou estado LGPD.
  v_input := jsonb_populate_record(null::public.contacts, p_contact);
  insert into public.contacts (
    organization_id, created_by_user_id, name, display_name, email, phone_number,
    birthdate, tags, source, source_metadata, custom_fields, consent, cpf_hash, cpf_encrypted
  ) values (
    p_organization_id, auth.uid(), v_input.name, v_input.display_name, v_input.email,
    v_input.phone_number, v_input.birthdate, coalesce(v_input.tags, '{}'),
    coalesce(v_input.source, 'manual'), coalesce(v_input.source_metadata, '{}'::jsonb),
    coalesce(v_input.custom_fields, '{}'::jsonb), coalesce(v_input.consent, '{}'::jsonb),
    v_input.cpf_hash, v_input.cpf_encrypted
  ) returning * into v_contact;
  update public.crm_leads set contact_id = v_contact.id
    where id = p_lead_id and organization_id = p_organization_id;
  if not found then raise exception 'forbidden' using errcode = '42501'; end if;
  -- Não devolve o documento cifrado ao navegador.
  return jsonb_build_object(
    'id', v_contact.id,
    'organization_id', v_contact.organization_id,
    'name', v_contact.name,
    'display_name', v_contact.display_name,
    'email', v_contact.email,
    'email_normalized', v_contact.email_normalized,
    'phone_number', v_contact.phone_number,
    'cpf_hash', v_contact.cpf_hash,
    'birthdate', v_contact.birthdate,
    'is_blocked', v_contact.is_blocked,
    'blocked_reason', v_contact.blocked_reason,
    'is_anonymized', v_contact.is_anonymized,
    'anonymized_at', v_contact.anonymized_at,
    'is_merged_into', v_contact.is_merged_into,
    'merged_at', v_contact.merged_at,
    'consent', v_contact.consent,
    'tags', v_contact.tags,
    'source', v_contact.source,
    'source_metadata', v_contact.source_metadata,
    'custom_fields', v_contact.custom_fields,
    'created_at', v_contact.created_at,
    'updated_at', v_contact.updated_at,
    'last_activity_at', v_contact.last_activity_at,
    'first_service_at', v_contact.first_service_at
  );
end;
$$;
revoke execute on function public.fn_create_contact_for_lead(uuid, uuid, jsonb) from public, anon;
grant execute on function public.fn_create_contact_for_lead(uuid, uuid, jsonb) to authenticated;
