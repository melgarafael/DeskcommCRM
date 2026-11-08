-- manifest: Avaliação — search_path no trigger de status; membership em fn_avaliacao_resolver_consultor (padrão 0149).

create or replace function public.trg_avaliacao_status_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $g$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if current_setting('avaliacao.alterando_status', true) is distinct from '1' then
      raise exception 'avaliacao_status_somente_por_rpc' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$g$;

create or replace function public.fn_avaliacao_resolver_consultor(p_org uuid, p_unit uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $f$
declare
  v_consultor uuid;
begin
  if auth.uid() is not null
     and not public.fn_role_at_least(p_org, 'viewer') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'fn_avaliacao_resolver_consultor: caller must be an active member of the organization';
  end if;

  if to_regclass('public.avaliacao_agendamentos') is null then
    raise exception 'avaliacao_modulo_nao_instalado' using errcode = '42P01';
  end if;

  select m.user_id into v_consultor
    from public.user_organizations m
   where m.organization_id = p_org
     and m.revoked_at is null
     and m.role <> 'viewer'
   order by (
     select count(*)::bigint
       from public.avaliacao_agendamentos a
      where a.organization_id = p_org
        and a.unit_id = p_unit
        and a.consultant_user_id = m.user_id
        and a.scheduled_at >= date_trunc('day', now() at time zone 'America/Sao_Paulo')
   ), m.user_id
   limit 1;

  return v_consultor;
end;
$f$;

revoke execute on function public.fn_avaliacao_resolver_consultor(uuid, uuid) from public, anon;
grant execute on function public.fn_avaliacao_resolver_consultor(uuid, uuid) to authenticated, service_role;
