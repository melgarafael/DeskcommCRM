-- 9477 — o tipo de agendamento segue o fuso da empresa (#5205)
-- manifest: O tipo de agendamento (calendar_event_types.service_timezone) nasce e acompanha o fuso da organização (organizations.timezone), em vez de ficar travado em America/Sao_Paulo. (a) backfill idempotente dos tipos já semeados, roda uma vez; (b) trigger BEFORE INSERT herda o fuso da empresa ao criar tipo; (c) trigger AFTER UPDATE OF timezone propaga a troca de fuso da empresa para os tipos que ainda estavam no fuso antigo; (d) revoke de EXECUTE nas duas funções definer. Psql puro, sem BEGIN/COMMIT, idempotente.

-- (a) Ajuste dos tipos que já existem — roda UMA vez só.
-- O update.sh reaplica o apêndice do baseline a cada atualização; um update
-- solto desfaria, a cada versão, a escolha de quem pôs São Paulo de propósito.
-- Regra: tipo com service_timezone = 'America/Sao_Paulo' numa organização cujo
-- timezone é diferente de 'America/Sao_Paulo' E válido em pg_timezone_names
-- passa para organizations.timezone. Laço linha a linha com exceção 22023
-- (guard do serviço ativo sem programação) para não derrubar a atualização.
do $tipo_segue_ajuste_existentes$
declare r record;
begin
  if to_regprocedure('public.fn_tipo_segue_o_fuso_da_empresa()') is null then
    for r in
      select t.id, t.organization_id, o.timezone
        from public.calendar_event_types t
        join public.organizations o on o.id = t.organization_id
       where t.service_timezone = 'America/Sao_Paulo'
         and o.timezone <> 'America/Sao_Paulo'
         and exists(select 1 from pg_timezone_names where name = o.timezone)
    loop
      begin
        update public.calendar_event_types
           set service_timezone = r.timezone
         where id = r.id
           and organization_id = r.organization_id;
      exception when sqlstate '22023' then
        raise warning 'tipo % não mudou de fuso: serviço ativo sem programação', r.id;
      end;
    end loop;
  end if;
end $tipo_segue_ajuste_existentes$;

-- (b) O tipo nasce no fuso da empresa.
create or replace function public.fn_tipo_nasce_no_fuso_da_empresa()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fuso text;
begin
  if new.service_timezone is null or new.service_timezone = 'America/Sao_Paulo' then
    select o.timezone into v_fuso
      from public.organizations o
     where o.id = new.organization_id
       and exists(select 1 from pg_timezone_names where name = o.timezone);
    if v_fuso is not null then
      new.service_timezone := v_fuso;
    else
      new.service_timezone := 'America/Sao_Paulo';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function public.fn_tipo_nasce_no_fuso_da_empresa() from public, anon, authenticated;

drop trigger if exists trg_tipo_nasce_no_fuso_da_empresa on public.calendar_event_types;
create trigger trg_tipo_nasce_no_fuso_da_empresa
  before insert on public.calendar_event_types
  for each row
  execute function public.fn_tipo_nasce_no_fuso_da_empresa();

-- (c) O tipo acompanha a empresa.
create or replace function public.fn_tipo_segue_o_fuso_da_empresa()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  if new.timezone is distinct from old.timezone
     and exists(select 1 from pg_timezone_names where name = new.timezone) then
    for r in
      select id
        from public.calendar_event_types
       where organization_id = new.id
         and service_timezone = old.timezone
    loop
      begin
        update public.calendar_event_types
           set service_timezone = new.timezone
         where id = r.id
           and organization_id = new.id;
      exception when sqlstate '22023' then
        raise warning 'tipo % não acompanhou o fuso da empresa: serviço ativo sem programação', r.id;
      end;
    end loop;
  end if;
  return new;
end;
$$;
revoke execute on function public.fn_tipo_segue_o_fuso_da_empresa() from public, anon, authenticated;

drop trigger if exists trg_tipo_segue_o_fuso_da_empresa on public.organizations;
create trigger trg_tipo_segue_o_fuso_da_empresa
  after update of timezone on public.organizations
  for each row
  execute function public.fn_tipo_segue_o_fuso_da_empresa();
