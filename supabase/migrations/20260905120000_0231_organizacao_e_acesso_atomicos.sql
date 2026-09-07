-- Criação administrativa atômica; chave existente com endpoint por ator, sem tokens.
-- Apenas service_role: identidade/plataforma/MFA são verificadas pelo handler.
create or replace function public.fn_create_tenant_with_owner(
  p_actor uuid, p_key uuid, p_request jsonb, p_hash text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  prior public.idempotency_keys%rowtype;
  org public.organizations%rowtype;
  result jsonb;
begin
  if not exists (select 1 from public.platform_admins where user_id = p_actor
    and revoked_at is null and scope = 'full') then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text || ':' || p_key::text, 0));
  select * into prior from public.idempotency_keys
    where key = p_key::text and endpoint = '/api/v1/admin/tenants:' || p_actor::text
      and expires_at > now();
  if found then
    if prior.request_hash <> decode(p_hash, 'hex') then
      raise exception 'idempotency_conflict' using errcode = '22023';
    end if;
    return prior.response_body || jsonb_build_object('created', false);
  end if;
  insert into public.organizations(display_name, slug, legal_name, cnpj, status, settings, created_by)
    values (p_request->>'display_name', p_request->>'slug', coalesce(nullif(p_request->>'legal_name', ''), p_request->>'display_name'),
      p_request->>'cnpj', 'active', jsonb_build_object('plan', p_request->>'plan'), p_actor)
    returning * into org;
  insert into public.user_organizations(organization_id, user_id, role, accepted_at)
    values (org.id, p_actor, 'admin', now());
  result := jsonb_build_object('id', org.id, 'slug', org.slug, 'display_name', org.display_name,
    'invite_id', gen_random_uuid(), 'issued_at', floor(extract(epoch from now()))::bigint);
  insert into public.idempotency_keys(organization_id, key, endpoint, request_hash, status_code, response_body)
    values (org.id, p_key::text, '/api/v1/admin/tenants:' || p_actor::text,
      decode(p_hash, 'hex'), 201, result);
  return result || jsonb_build_object('created', true);
end $$;
revoke all on function public.fn_create_tenant_with_owner(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.fn_create_tenant_with_owner(uuid, uuid, jsonb, text) to service_role;

-- O token HMAC/e-mail são verificados no servidor. Serialização impede duas
-- aceitações concorrentes de reescrever o vínculo. Replay ativo não muda nada;
-- revogado exige convite NOVO com iat posterior à revogação (legado é negado).
create or replace function public.fn_accept_team_invite(
  p_user uuid, p_org uuid, p_role text, p_invited_by uuid,
  p_issued_at timestamptz, p_invited_at timestamptz
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.user_organizations%rowtype;
begin
  if p_role not in ('viewer','agent','manager','admin') then
    raise exception 'invalid_role' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user::text || ':' || p_org::text, 0));
  if not exists(select 1 from public.organizations where id = p_org and status = 'active') then
    raise exception 'organization_unavailable' using errcode = '42501';
  end if;
  select * into m from public.user_organizations
    where organization_id = p_org and user_id = p_user for update;
  if found and m.revoked_at is null and m.accepted_at is not null then
    return jsonb_build_object('id', m.id, 'changed', false);
  end if;
  if found and m.revoked_at is not null and (p_issued_at is null or p_issued_at <= m.revoked_at) then
    raise exception 'invite_revoked' using errcode = '42501';
  end if;
  if m.id is not null then
    update public.user_organizations set role = p_role, revoked_at = null,
      invited_by = coalesce(p_invited_by, invited_by), invited_at = p_invited_at,
      accepted_at = now(), updated_at = now()
      where organization_id = p_org and id = m.id returning * into m;
  else
    insert into public.user_organizations(organization_id, user_id, role, invited_by, invited_at, accepted_at)
      values (p_org, p_user, p_role, p_invited_by, p_invited_at, now()) returning * into m;
  end if;
  return jsonb_build_object('id', m.id, 'changed', true);
end $$;
revoke all on function public.fn_accept_team_invite(uuid, uuid, text, uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.fn_accept_team_invite(uuid, uuid, text, uuid, timestamptz, timestamptz) to service_role;
