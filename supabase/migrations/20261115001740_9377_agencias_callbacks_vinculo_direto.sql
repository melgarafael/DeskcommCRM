-- manifest: Revalidar callbacks pela delegação mais recente, preservando vínculo direto legítimo após sair da agência.
create or replace function public.fn_support_callback_write_allowed(p_org uuid,p_actor uuid default null,p_session uuid default null)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select public.fn_platform_support_callback_write_allowed(p_org,p_actor,p_session)
 and not exists(select 1 from agencia_sessoes s
 left join auth.sessions a on a.id=s.auth_session_id and a.user_id=s.actor_user_id
 join organizations o on o.id=s.organization_id
 where s.organization_id=p_org and (p_actor is null or s.actor_user_id=p_actor)
 and (p_session is null or s.auth_session_id=p_session)
 and (s.ended_at is null or p_session is not null)
 and s.id=(select recente.id from agencia_sessoes recente
   where recente.organization_id=s.organization_id and recente.actor_user_id=s.actor_user_id
   and recente.auth_session_id=s.auth_session_id order by recente.created_at desc,recente.id desc limit 1)
 and (a.id is null or (a.not_after is not null and a.not_after<=now()) or o.status<>'active'
 or (exists(select 1 from auth.mfa_factors f where f.user_id=s.actor_user_id and f.status='verified') and coalesce(a.aal::text,'aal1')<>'aal2')
 or (s.ended_at is null and (s.expires_at<=now() or not public.fn_agencia_autoridade(s.actor_user_id,s.agencia_id)
   or not exists(select 1 from agencia_clientes c where c.organization_id=p_org and c.agencia_id=s.agencia_id)))
 or (s.ended_at is not null and not exists(select 1 from user_organizations u
   where u.organization_id=p_org and u.user_id=s.actor_user_id and u.role='admin'
   and u.accepted_at is not null and u.revoked_at is null))));
$$;
revoke all on function public.fn_support_callback_write_allowed(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_support_callback_write_allowed(uuid,uuid,uuid) to service_role;
