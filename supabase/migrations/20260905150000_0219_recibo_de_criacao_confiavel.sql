-- Recibo que será autoridade de assinatura não pode ser escrito por membro.
-- DEFAULT false marca TODA linha anterior como não confiável, inclusive forjada.
-- Não fazemos backfill nem apagamos recibos: só a RPC abaixo produz confiança.
-- Os namespaces LGPD/MCP continuam com o contrato de leitura/escrita original.
alter table public.idempotency_keys add column if not exists tenant_creation_trusted boolean not null default false;
drop policy if exists idempotency_platform_creation_server_only on public.idempotency_keys;
create policy idempotency_platform_creation_server_only on public.idempotency_keys
  as restrictive for all to anon, authenticated
  using (endpoint not like '/api/v1/admin/tenants:%' and not tenant_creation_trusted)
  with check (endpoint not like '/api/v1/admin/tenants:%' and not tenant_creation_trusted);
-- TRUNCATE ignora RLS; nenhum consumidor de idempotência precisa dele.
revoke truncate on public.idempotency_keys from public, anon, authenticated;

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
      and expires_at > now() and tenant_creation_trusted;
  if found then
    if prior.request_hash <> decode(p_hash, 'hex') then
      raise exception 'idempotency_conflict' using errcode = '22023';
    end if;
    if prior.response_body->>'id' is distinct from prior.organization_id::text
      or not exists (select 1 from public.organizations where id = prior.organization_id and created_by = p_actor) then
      raise exception 'idempotency_provenance_invalid' using errcode = '22023';
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
  insert into public.idempotency_keys(organization_id, key, endpoint, request_hash, status_code, response_body, tenant_creation_trusted)
    values (org.id, p_key::text, '/api/v1/admin/tenants:' || p_actor::text,
      decode(p_hash, 'hex'), 201, result, true);
  return result || jsonb_build_object('created', true);
end $$;
revoke all on function public.fn_create_tenant_with_owner(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.fn_create_tenant_with_owner(uuid, uuid, jsonb, text) to service_role;

