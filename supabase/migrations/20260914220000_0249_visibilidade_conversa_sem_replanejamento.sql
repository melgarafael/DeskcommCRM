-- O Inbox de atendentes excedia 8 s com 3.242 conversas. O helper SQL
-- replanejava a expressão de autorização e resolvia o papel duas vezes por linha.
-- PL/pgSQL mantém planos das consultas internas e resolve o papel uma vez.
-- Preserva plataforma, suporte temporário, revogação e os três modos de leitura.
create or replace function public.fn_can_view_conversation(
  p_org uuid, p_assigned_to_user_id uuid
) returns boolean
language plpgsql stable security definer
set search_path = public
as $visibility$
declare
  v_role text;
  v_mode text;
begin
  if public.fn_is_platform_admin() then return true; end if;
  v_role := public.fn_user_role_in_org(p_org);
  if v_role is null then return false; end if;
  if v_role in ('viewer','manager','admin') then return true; end if;
  if p_assigned_to_user_id = auth.uid() then return true; end if;
  select o.settings->>'visibility_mode' into v_mode
    from public.organizations o where o.id = p_org;
  case coalesce(v_mode, 'own_and_unassigned')
    when 'all' then return true;
    when 'own_and_unassigned' then return p_assigned_to_user_id is null;
    else return false;
  end case;
end;
$visibility$;
revoke execute on function public.fn_can_view_conversation(uuid,uuid) from public,anon;
grant execute on function public.fn_can_view_conversation(uuid,uuid) to authenticated,service_role;

-- O contexto de suporte tem consulta composta. Materializá-lo em uma variável
-- evita que o inlining SQL repita essa resolução a cada referência ao JSON.
create or replace function public.fn_user_role_in_org(p_org uuid)
returns text language plpgsql stable security definer set search_path = public
as $role$
declare
  v_support jsonb;
  v_role text;
begin
  v_support := public.fn_support_context();
  if v_support->>'status' = 'active'
    and (v_support->>'organization_id')::uuid = p_org then
    return case when v_support->>'access_mode' = 'full' then 'admin' else 'viewer' end;
  end if;
  select m.role into v_role from public.user_organizations m
    where m.user_id = auth.uid() and m.organization_id = p_org
      and m.revoked_at is null limit 1;
  return v_role;
end;
$role$;
revoke execute on function public.fn_user_role_in_org(uuid) from public,anon;
grant execute on function public.fn_user_role_in_org(uuid) to authenticated,service_role;
