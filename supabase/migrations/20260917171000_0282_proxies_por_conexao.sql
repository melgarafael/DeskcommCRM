-- Guarda apenas o vínculo; credenciais são obtidas da Webshare no servidor.
alter table public.channel_sessions drop constraint if exists channel_sessions_engine_check;
alter table public.channel_sessions add constraint channel_sessions_engine_check check (engine in ('NOWEB','WEBJS','GOWS'));
create unique index if not exists channel_sessions_proxy_org_id_unique on public.channel_sessions(organization_id,id);
create table if not exists public.channel_proxy_bindings (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid primary key,
  proxy_id text not null unique check(length(proxy_id) between 1 and 100),
  country_code text not null check(country_code ~ '^[A-Z]{2}$'),
  transport_origin text not null,
  updated_at timestamptz not null default now(),
  foreign key(organization_id,channel_session_id) references public.channel_sessions(organization_id,id) on delete cascade
);
alter table public.channel_proxy_bindings enable row level security;
revoke all on public.channel_proxy_bindings from anon,authenticated;
grant select on public.channel_proxy_bindings to authenticated;
grant all on public.channel_proxy_bindings to service_role;
drop policy if exists tenant_isolation_channel_proxy_bindings_all on public.channel_proxy_bindings;
create policy tenant_isolation_channel_proxy_bindings_all on public.channel_proxy_bindings
 for select to authenticated using (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id,'admin'));

create or replace function public.fn_bind_channel_proxy(p_org uuid,p_channel uuid,p_proxy text,p_country text,p_origin text,p_previous text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c public.channel_sessions; b public.channel_proxy_bindings;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_channel::text,246));
 select * into c from public.channel_sessions where organization_id=p_org and id=p_channel and provider='waha' and archived_at is null for update;
 if not found then raise exception 'proxy_channel_not_found' using errcode='P0002'; end if;
 select * into b from public.channel_proxy_bindings where organization_id=p_org and channel_session_id=p_channel for update;
 if found then
  if b.transport_origin<>p_origin then raise exception 'proxy_transport_changed' using errcode='22023'; end if;
  if b.proxy_id=p_proxy and b.country_code=p_country then return to_jsonb(b); end if;
  if b.proxy_id is distinct from p_previous then raise exception 'proxy_binding_changed' using errcode='40001'; end if;
  if c.status not in ('STOPPED','FAILED') then raise exception 'proxy_change_requires_stop' using errcode='22023'; end if;
 elsif p_previous is not null then raise exception 'proxy_binding_changed' using errcode='40001';
 end if;
 insert into public.channel_proxy_bindings(organization_id,channel_session_id,proxy_id,country_code,transport_origin)
 values(p_org,p_channel,p_proxy,p_country,p_origin)
 on conflict(channel_session_id) do update set proxy_id=excluded.proxy_id,country_code=excluded.country_code,updated_at=now()
 returning * into b;
 return to_jsonb(b);
exception when unique_violation then raise exception 'proxy_in_use' using errcode='23505';
end;$$;
revoke execute on function public.fn_bind_channel_proxy(uuid,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.fn_bind_channel_proxy(uuid,uuid,text,text,text,text) to service_role;
