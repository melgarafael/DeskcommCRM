-- manifest: Avalia papel e contexto de suporte uma vez por verificação RBAC (#3087), preservando regras, grants e limites.
-- Mesmo RBAC; o InitPlan avalia o papel uma vez por chamada, não uma vez
-- para cada linha da tabela de níveis. Não altera timeout, grants ou triggers.
CREATE OR REPLACE FUNCTION public.fn_user_role_in_org(p_org uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
 with context AS MATERIALIZED (select public.fn_support_context() s)
 select case when s->>'status'='active' and (s->>'organization_id')::uuid=p_org
 then case when s->>'access_mode'='full' then 'admin' else 'viewer' end
 else (select role from public.user_organizations where user_id=auth.uid() and organization_id=p_org and revoked_at is null limit 1) end
 from context;
$f$;

CREATE OR REPLACE FUNCTION public.fn_role_at_least(p_org uuid, p_min text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO public
AS $$
  with levels(role, lvl) as (
    values ('viewer',1),('agent',2),('manager',3),('admin',4)
  )
  select coalesce(
    (select user_lvl.lvl >= min_lvl.lvl
     from levels user_lvl
     join levels min_lvl on min_lvl.role = p_min
     where user_lvl.role = (select public.fn_user_role_in_org(p_org))),
    false
  );
$$;

-- Explicita a mesma superfície RPC já existente; nunca expor os helpers ao anon.
REVOKE EXECUTE ON FUNCTION public.fn_role_at_least(uuid,text), public.fn_user_role_in_org(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_role_at_least(uuid,text), public.fn_user_role_in_org(uuid) TO authenticated, service_role;
