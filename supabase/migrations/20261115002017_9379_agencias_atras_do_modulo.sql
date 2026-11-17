-- manifest: Agências atrás do módulo opcional da instalação (doc 321, #4034): com MODULO_AGENCIAS desligado, nenhuma sessão de agência vale, nenhuma policy de agência devolve linha e nada de agência é criado.
-- O portão é a função `fn_agencias_ligado()`, e ele mora nos QUATRO lugares por
-- onde a agência alcança alguém — não nas rotas só:
--   · `fn_agencia_pode_gerir`  → as duas policies de leitura, a criação de cliente
--                                e o `requireAgencia` do Next;
--   · `fn_agencia_autoridade`  → abrir cliente e a revalidação dos callbacks;
--   · `fn_support_context`     → o ramo de agência some (NULL), e com ele o acesso
--                                que `fn_user_org_ids`/`fn_user_role_in_org`
--                                concediam. Some, e não vira 'revoked': revogado,
--                                a faixa de "Voltar à agência" apareceria com o
--                                botão apontando para uma rota que responde 404;
--   · `fn_create_tenant_with_owner` → a habilitação na criação global é recusada.
-- Só o valor `ligado` liga (a mesma regra de `lib/instalacao/modulos.ts`).
create or replace function public.fn_agencias_ligado()
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.platform_config where chave='MODULO_AGENCIAS' and valor='ligado');
$$;
revoke execute on function public.fn_agencias_ligado() from public,anon,authenticated;
grant execute on function public.fn_agencias_ligado() to service_role;

create or replace function public.fn_agencia_pode_gerir(p_agencia uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.fn_agencias_ligado() and exists (
    select 1 from public.agencia_configuracoes c
    join public.organizations o on o.id = c.organization_id
    join public.user_organizations u on u.organization_id = c.organization_id
    where c.organization_id = p_agencia and c.habilitada and o.status = 'active'
      and u.user_id = auth.uid() and u.role = 'admin'
      and u.revoked_at is null and u.accepted_at is not null
      and public.fn_support_context() is null
  );
$$;
revoke execute on function public.fn_agencia_pode_gerir(uuid) from public, anon;
grant execute on function public.fn_agencia_pode_gerir(uuid) to authenticated, service_role;

create or replace function public.fn_agencia_autoridade(p_actor uuid,p_agencia uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select public.fn_agencias_ligado() and exists(select 1 from agencia_configuracoes c
 join organizations o on o.id=c.organization_id
 join user_organizations u on u.organization_id=o.id
 where c.organization_id=p_agencia and c.habilitada and o.status='active'
 and u.user_id=p_actor and u.role='admin' and u.accepted_at is not null and u.revoked_at is null);
$$;
revoke all on function public.fn_agencia_autoridade(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_agencia_autoridade(uuid,uuid) to service_role;

create or replace function public.fn_support_context()
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce(public.fn_platform_support_context(),(
 select jsonb_build_object('id',s.id,'organization_id',s.organization_id,'agency_id',s.agencia_id,
 'actor_user_id',s.actor_user_id,'auth_session_id',s.auth_session_id,
 'previous_organization_id',s.agencia_id,'expires_at',s.expires_at,'name',o.display_name,
 'locale',o.locale,'access_mode','full','status',case
 when s.expires_at<=now() then 'expired'
 when not public.fn_agencia_autoridade(s.actor_user_id,s.agencia_id)
 or a.id is null or (a.not_after is not null and a.not_after<=now()) or o.status<>'active'
 or not exists(select 1 from agencia_clientes c where c.organization_id=s.organization_id and c.agencia_id=s.agencia_id)
 or (exists(select 1 from auth.mfa_factors f where f.user_id=s.actor_user_id and f.status='verified') and coalesce(auth.jwt()->>'aal','aal1')<>'aal2')
 then 'revoked' else 'active' end)
 from agencia_sessoes s join organizations o on o.id=s.organization_id
 left join auth.sessions a on a.id=s.auth_session_id and a.user_id=s.actor_user_id
 where public.fn_agencias_ligado()
 and s.actor_user_id=auth.uid() and s.auth_session_id=nullif(auth.jwt()->>'session_id','')::uuid
 and s.ended_at is null limit 1));
$$;
revoke all on function public.fn_support_context() from public,anon;
grant execute on function public.fn_support_context() to authenticated,service_role;

create or replace function public.fn_create_tenant_with_owner(p_actor uuid,p_key uuid,p_request jsonb,p_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare resultado jsonb;
begin
 if p_request ? 'agencia' and not public.fn_agencias_ligado() then
 raise exception 'agencias_desligado' using errcode='22023'; end if;
 resultado:=public.fn_platform_create_tenant_with_owner(p_actor,p_key,p_request,p_hash);
 if (resultado->>'created')::boolean and p_request ? 'agencia' then
 insert into agencia_configuracoes(organization_id,habilitada,limite_clientes,clientes_inclusos)
 values((resultado->>'id')::uuid,(p_request->'agencia'->>'habilitada')::boolean,(p_request->'agencia'->>'limite_clientes')::integer,coalesce((p_request->'agencia'->>'clientes_inclusos')::boolean,false));
 end if;
 return resultado;
end; $$;
revoke all on function public.fn_create_tenant_with_owner(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.fn_create_tenant_with_owner(uuid,uuid,jsonb,text) to service_role;
