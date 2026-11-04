-- manifest: Habilitação de agência na criação global na mesma transação e revalidação da delegação em callbacks externos.
create or replace function public.fn_platform_create_tenant_with_owner(
  p_actor uuid, p_key uuid, p_request jsonb, p_hash text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  prior public.idempotency_keys%rowtype;
  org public.organizations%rowtype;
  result jsonb;
  dono_e_outra_pessoa boolean;
  v_plano_id uuid;
  v_trial_dias integer;
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

  v_plano_id := nullif(p_request->>'plano_id', '')::uuid;
  if v_plano_id is not null then
    if not public.fn_cobranca_ligada() then
      raise exception 'cobranca_desligada' using errcode = '22023';
    end if;
    select p.trial_dias into v_trial_dias
      from public.cobranca_planos p
     where p.id = v_plano_id and p.arquivado_em is null;
    if not found then
      raise exception 'plano_invalido' using errcode = '22023';
    end if;
  end if;

  dono_e_outra_pessoa := lower(p_request->>'owner_email') is distinct from
    (select lower(email) from auth.users where id = p_actor);

  insert into public.organizations(display_name, slug, legal_name, cnpj, status, settings, created_by)
    values (p_request->>'display_name', p_request->>'slug', coalesce(nullif(p_request->>'legal_name', ''), p_request->>'display_name'),
      p_request->>'cnpj', 'active',
      case when p_request ? 'plan' then jsonb_build_object('plan', p_request->>'plan') else '{}'::jsonb end,
      p_actor)
    returning * into org;
  insert into public.user_organizations(organization_id, user_id, role, accepted_at, interface_settings, provisional_until_handover)
    values (org.id, p_actor, 'admin', now(),
      case when dono_e_outra_pessoa
        then '{"preset":"completa"}'::jsonb
        else coalesce(p_request->'owner_interface_settings', '{"preset":"completa"}'::jsonb) end,
      dono_e_outra_pessoa);

  if v_plano_id is not null then
    insert into public.cobranca_assinaturas
      (organization_id, plano_id, estado, trial_ate, pagamento_inicial_pendente)
    values (org.id, v_plano_id,
      'trial',
      now() + make_interval(days => v_trial_dias), v_trial_dias = 0);
    if v_trial_dias = 0 then
      perform public.fn_suspender_organizacao(org.id, 'cobranca', 'Aguardando o primeiro pagamento', null);
    end if;
  end if;

  result := jsonb_build_object('id', org.id, 'slug', org.slug, 'display_name', org.display_name,
    'invite_id', gen_random_uuid(), 'issued_at', floor(extract(epoch from now()))::bigint);
  insert into public.idempotency_keys(organization_id, key, endpoint, request_hash, status_code, response_body, tenant_creation_trusted)
    values (org.id, p_key::text, '/api/v1/admin/tenants:' || p_actor::text,
      decode(p_hash, 'hex'), 201, result, true);
  return result || jsonb_build_object('created', true);
end $$;
revoke all on function public.fn_platform_create_tenant_with_owner(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.fn_platform_create_tenant_with_owner(uuid,uuid,jsonb,text) to service_role;
create or replace function public.fn_create_tenant_with_owner(p_actor uuid,p_key uuid,p_request jsonb,p_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare resultado jsonb;
begin
 resultado:=public.fn_platform_create_tenant_with_owner(p_actor,p_key,p_request,p_hash);
 if (resultado->>'created')::boolean and p_request ? 'agencia' then
 insert into agencia_configuracoes(organization_id,habilitada,limite_clientes)
 values((resultado->>'id')::uuid,(p_request->'agencia'->>'habilitada')::boolean,(p_request->'agencia'->>'limite_clientes')::integer);
 end if;
 return resultado;
end; $$;
revoke all on function public.fn_create_tenant_with_owner(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.fn_create_tenant_with_owner(uuid,uuid,jsonb,text) to service_role;
create or replace function public.fn_platform_support_callback_write_allowed(p_org uuid,p_actor uuid default null,p_session uuid default null)
returns boolean language sql stable security definer set search_path=public as $f$
 select not exists(
 select 1 from platform_support_sessions s
 left join platform_admins p on p.user_id=s.actor_user_id and p.revoked_at is null
 left join auth.sessions a on a.id=s.auth_session_id and a.user_id=s.actor_user_id
 join organizations o on o.id=s.organization_id
 where s.organization_id=p_org and s.ended_at is null
 and (p_actor is null or s.actor_user_id=p_actor)
 and (p_session is null or s.auth_session_id=p_session)
 and (s.access_mode<>'full' or p.scope<>'full' or p.user_id is null or s.expires_at<=now()
 or a.id is null or (a.not_after is not null and a.not_after<=now()) or o.status<>'active'
 or ((p.mfa_required or exists(select 1 from auth.mfa_factors f where f.user_id=s.actor_user_id and f.status='verified')) and coalesce(a.aal::text,'aal1')<>'aal2')));
$f$;
revoke all on function public.fn_platform_support_callback_write_allowed(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_platform_support_callback_write_allowed(uuid,uuid,uuid) to service_role;
create or replace function public.fn_support_callback_write_allowed(p_org uuid,p_actor uuid default null,p_session uuid default null)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select public.fn_platform_support_callback_write_allowed(p_org,p_actor,p_session)
 and not exists(select 1 from agencia_sessoes s
 left join auth.sessions a on a.id=s.auth_session_id and a.user_id=s.actor_user_id
 join organizations o on o.id=s.organization_id
 where s.organization_id=p_org and (p_actor is null or s.actor_user_id=p_actor)
 and (p_session is null or s.auth_session_id=p_session)
 and (s.ended_at is null or p_session is not null)
 and (s.ended_at is not null or s.expires_at<=now() or a.id is null
 or (a.not_after is not null and a.not_after<=now()) or o.status<>'active'
 or not public.fn_agencia_autoridade(s.actor_user_id,s.agencia_id)
 or not exists(select 1 from agencia_clientes c where c.organization_id=p_org and c.agencia_id=s.agencia_id)
 or (exists(select 1 from auth.mfa_factors f where f.user_id=s.actor_user_id and f.status='verified') and coalesce(a.aal::text,'aal1')<>'aal2')));
$$;
revoke all on function public.fn_support_callback_write_allowed(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_support_callback_write_allowed(uuid,uuid,uuid) to service_role;
