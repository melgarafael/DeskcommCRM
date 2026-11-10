-- manifest: Reutiliza o papel uma vez por chamada de visibilidade, preservando curto-circuito master e regras por linha (#3882).
-- Contexto por CHAMADA, não cache por consulta ou entre instruções.
create or replace function public.fn_can_view_lead(
  p_org uuid,
  p_owner_user_id uuid
) returns boolean
language sql stable security definer
set search_path = public
as $$
  select case
    when public.fn_is_platform_admin() then true
    else (
      with actor as materialized (
        select public.fn_user_role_in_org(p_org) as role
      )
      select case
        when actor.role is null then false
        when actor.role in ('viewer','manager','admin') then true
        when p_owner_user_id = auth.uid() then true
        else case coalesce(
               (select settings->>'visibility_mode' from public.organizations where id = p_org),
               'own_and_unassigned')
             when 'all' then true
             when 'own_and_unassigned' then p_owner_user_id is null
             else false
           end
      end
      from actor
    )
  end;
$$;

create or replace function public.fn_can_view_conversation(
  p_org uuid,
  p_assigned_to_user_id uuid
) returns boolean
language sql stable security definer
set search_path = public
as $$
  select case
    when public.fn_is_platform_admin() then true
    else (
      with actor as materialized (
        select public.fn_user_role_in_org(p_org) as role
      )
      select case
        when actor.role is null then false
        when actor.role in ('viewer','manager','admin') then true
        when p_assigned_to_user_id = auth.uid() then true
        else case coalesce(
               (select settings->>'visibility_mode' from public.organizations where id = p_org),
               'own_and_unassigned')
             when 'all' then true
             when 'own_and_unassigned' then p_assigned_to_user_id is null
             else false
           end
      end
      from actor
    )
  end;
$$;

-- Mesma superfície já concedida na main; nenhuma role nova.
REVOKE EXECUTE ON FUNCTION public.fn_can_view_lead(uuid,uuid), public.fn_can_view_conversation(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_can_view_lead(uuid,uuid), public.fn_can_view_conversation(uuid,uuid) TO authenticated, service_role;
