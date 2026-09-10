-- 0233 — módulo Academia opt-in por organização; ausência equivale a desligado.
create or replace function public.fn_definir_modulo_academia(p_org uuid, p_enabled boolean)
returns boolean language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'admin')
   or not public.fn_support_write_allowed(p_org) or not public.fn_session_mfa_proven()
 then raise exception 'module_forbidden' using errcode='42501'; end if;
 if p_enabled is null then raise exception 'module_invalid' using errcode='22023'; end if;
 update public.organizations set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{modules}',
   (case when jsonb_typeof(settings->'modules')='object' then settings->'modules' else '{}'::jsonb end)
   || jsonb_build_object('academia',p_enabled),true) where id=p_org;
 if not found then raise exception 'organization_not_found' using errcode='P0002'; end if;
 return p_enabled;
end; $$;
revoke all on function public.fn_definir_modulo_academia(uuid,boolean) from public,anon,authenticated;
grant execute on function public.fn_definir_modulo_academia(uuid,boolean) to authenticated;
notify pgrst,'reload schema';
