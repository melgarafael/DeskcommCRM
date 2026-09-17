-- Pool da instalação: revela somente se IDs já conhecidos estão reservados.
-- Nenhuma identidade de organização/canal atravessa esta consulta global.
create or replace function public.fn_reserved_channel_proxies(p_ids text[])
returns setof text language sql stable security definer set search_path=public as $$
 select proxy_id from public.channel_proxy_bindings where proxy_id=any(p_ids);
$$;
revoke execute on function public.fn_reserved_channel_proxies(text[]) from public,anon,authenticated;
grant execute on function public.fn_reserved_channel_proxies(text[]) to service_role;
