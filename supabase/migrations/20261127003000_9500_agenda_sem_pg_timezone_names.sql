-- manifest: **A agenda de serviço deixa de consultar `pg_timezone_names` a cada conferência de profissional (`fn_calendar_service_person_available`).** A consulta à visão custa ~63 ms e roda uma vez por profissional e por horário: com 7 profissionais, a semana de um serviço passava do statement timeout e o `crm_find_free_slots` do agente voltava vazio ("vou confirmar e volto"). Fuso inválido continua devolvendo `false`: o `at time zone` levanta 22023 (data_exception), que o handler da própria função já captura. Corpo copiado da última definição do baseline; muda a conferência do fuso: o catálogo só é consultado quando o nome não tem o formato Área/Local.
-- Sem tabela temporária, sem BEGIN/COMMIT, sem id de tenant, psql puro, idempotente.

create or replace function public.fn_calendar_service_person_available(p_org uuid,p_owner uuid,p_start timestamptz,p_end timestamptz,p_ignore uuid default null,p_type uuid default null)
returns boolean language plpgsql stable security definer set search_path=public as $$
declare schedule jsonb;zone text; local_start timestamp;local_end timestamp;day_date date;start_min integer;end_min integer;windows int4multirange;
begin
  if not exists(select 1 from public.user_organizations where organization_id=p_org and user_id=p_owner and revoked_at is null) then return false;end if;
  select a.schedule into schedule from public.attendant_availability a where a.organization_id=p_org and a.user_id=p_owner and a.is_available;
  if not found or jsonb_typeof(schedule->'windows')<>'array' then return false;end if;
  zone:=coalesce(nullif(schedule->>'timezone',''),'America/Sao_Paulo');
  -- Nome no formato Área/Local vai direto ao `at time zone` (inválido levanta 22023, capturado abaixo).
  -- Qualquer outra forma ainda passa pelo catálogo: `-03:00` seria lido como POSIX, com o sinal invertido.
  if zone !~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+)+$' then
    if not exists(select 1 from pg_timezone_names where name=zone) then return false;end if;
  end if;
  local_start:=p_start at time zone zone;local_end:=p_end at time zone zone;day_date:=local_start::date;
  if local_end::date<>day_date and local_end::time<>'00:00:00' then return false;end if;
  start_min:=extract(hour from local_start)::int*60+extract(minute from local_start)::int;
  end_min:=case when local_end::date<>day_date then 1440 else extract(hour from local_end)::int*60+extract(minute from local_end)::int end;
  if end_min<=start_min then return false;end if;
  select range_agg(r) into windows from (
    select int4range(split_part(w->>'start',':',1)::int*60+split_part(w->>'start',':',2)::int,
      split_part(w->>'end',':',1)::int*60+split_part(w->>'end',':',2)::int,'[)') r
      from jsonb_array_elements(schedule->'windows') w where (w->>'dow')::int=extract(dow from local_start)::int
    union all select int4range(start_minute,end_minute,'[)') from public.calendar_availability_exceptions
      where organization_id=p_org and user_id=p_owner and exception_date=day_date and not is_unavailable
  ) x;
  if not coalesce(windows @> int4range(start_min,end_min,'[)'),false) then return false;end if;
  if exists(select 1 from public.calendar_availability_exceptions where organization_id=p_org and user_id=p_owner and exception_date=day_date and is_unavailable
    and start_minute<end_min and end_minute>start_min) then return false;end if;
  if exists(select 1 from public.calendar_appointments a where a.organization_id=p_org and a.id is distinct from p_ignore
    and a.status in ('pending','confirmed') and a.starts_at<p_end and a.ends_at>p_start
    and (
      (a.owner_user_id=p_owner
        and not (p_type is not null and a.event_type_id=p_type
          and a.starts_at-make_interval(mins=>(select buffer_before_minutes from public.calendar_event_types where organization_id=p_org and id=p_type))=p_start
          and a.ends_at+make_interval(mins=>(select buffer_after_minutes from public.calendar_event_types where organization_id=p_org and id=p_type))=p_end
          and a.service_occurrence_id is not null and a.service_booking_mode in ('collective_limited','collective_unlimited')))
      or exists(select 1 from public.calendar_appointment_responsibles r
        where r.organization_id=a.organization_id and r.appointment_id=a.id and r.user_id=p_owner)
    )) then return false;end if;
  if exists(select 1 from public.calendar_service_blocks where organization_id=p_org and scope_kind='professional' and owner_user_id=p_owner and archived_at is null
    and starts_at<p_end and ends_at>p_start) then return false;end if;
  return true;
exception when invalid_text_representation or data_exception then return false;
end $$;

revoke all on function public.fn_calendar_service_person_available(uuid,uuid,timestamptz,timestamptz,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_calendar_service_person_available(uuid,uuid,timestamptz,timestamptz,uuid,uuid) to service_role;
