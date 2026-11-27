-- manifest: **Agenda do Outlook (Microsoft 365 e conta pessoal): o horário ocupado lá fora bloqueia a grade daqui (#1754, fatia 1).** `calendar_connections.provider` passa a aceitar `microsoft_calendar`; tabela de instalação `platform_microsoft_oauth` (singleton, RLS sem policy, grants só de service_role, segredo cifrado), irmã de `platform_google_oauth`; função `fn_microsoft_calendar_save` (service_role) troca numa transação o espelho de ocupação de UMA agenda e carimba a cobertura. `fn_google_selection` e `fn_calendar_service_sources_to_refresh` passam a mexer só em agendas do Google, para salvar a escolha do Google não desligar a do Outlook e o leitor do Google não receber agenda alheia. Aditiva e idempotente, sem backfill. Espelho no apêndice do `supabase/baseline.sql`, antes da cascata da 9243 e da VARREDURA anon.

alter table public.calendar_connections drop constraint if exists calendar_connections_provider_check;
alter table public.calendar_connections add constraint calendar_connections_provider_check
  check (provider in ('google_calendar','microsoft_calendar'));

create table if not exists public.platform_microsoft_oauth (
  id smallint primary key default 1,
  client_id text,
  client_secret_encrypted bytea,
  -- NULL = qualquer conta (empresa ou pessoal). Preenchido = só aquele diretório.
  tenant text,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint platform_microsoft_oauth_singleton check (id = 1)
);

comment on table public.platform_microsoft_oauth is
  'O aplicativo OAuth da Microsoft DESTA INSTALAÇÃO (singleton). Server-side only: RLS ligada sem policies e grants revogados de anon/authenticated. O segredo nunca volta ao navegador.';
comment on column public.platform_microsoft_oauth.client_secret_encrypted is
  'Cifrado por fn_encrypt_oauth (pgp_sym/aes256), a mesma cifra dos tokens em calendar_connections. Nunca gravar em claro.';

alter table public.platform_microsoft_oauth enable row level security;
revoke all on public.platform_microsoft_oauth from public, anon, authenticated;
grant select, insert, update on public.platform_microsoft_oauth to service_role;

drop trigger if exists trg_platform_microsoft_oauth_updated_at on public.platform_microsoft_oauth;
create trigger trg_platform_microsoft_oauth_updated_at
  before update on public.platform_microsoft_oauth
  for each row execute function public.fn_set_updated_at();

-- A troca do espelho é UMA transação: apagar e inserir em duas chamadas deixaria
-- a grade livre no intervalo, e é no intervalo que se marca em cima.
create or replace function public.fn_microsoft_calendar_save(
  p_org uuid, p_calendar uuid, p_items jsonb, p_start timestamptz, p_end timestamptz
) returns integer
language plpgsql security definer set search_path=public as $$
declare c public.calendar_connection_calendars; total integer;
begin
  select k.* into c from public.calendar_connection_calendars k
    join public.calendar_connections x on x.organization_id=k.organization_id and x.id=k.connection_id
    join public.user_organizations m on m.organization_id=x.organization_id and m.user_id=x.user_id and m.revoked_at is null
   where k.organization_id=p_org and k.id=p_calendar and x.provider='microsoft_calendar' and x.status='healthy'
     for update of k;
  -- Desconectou, saiu da empresa ou agenda alheia: nada é gravado.
  if c.id is null then raise exception 'microsoft_calendar_unavailable' using errcode='42501'; end if;
  if p_end <= p_start then raise exception 'microsoft_window_invalid' using errcode='22023'; end if;

  delete from public.calendar_external_events
   where organization_id=p_org and connection_id=c.connection_id and external_calendar_id=c.external_calendar_id;

  insert into public.calendar_external_events(
    organization_id, connection_id, external_calendar_id, external_event_id, starts_at, ends_at,
    is_all_day, status, transparency, ical_uid)
  select distinct on (i->>'external_event_id')
    p_org, c.connection_id, c.external_calendar_id, i->>'external_event_id',
    (i->>'starts_at')::timestamptz, (i->>'ends_at')::timestamptz,
    coalesce((i->>'is_all_day')::boolean,false), i->>'status', i->>'transparency', i->>'ical_uid'
  from jsonb_array_elements(p_items) i
  order by i->>'external_event_id';
  get diagnostics total = row_count;

  update public.calendar_connection_calendars set
    sync_coverage=jsonb_build_object('generation',gen_random_uuid(),'window_start',p_start,'window_end',p_end,'completed_at',now()),
    last_sync_at=now(), sync_error=null, sync_next_attempt_at=now()+interval '5 minutes'
   where organization_id=p_org and id=p_calendar;
  update public.calendar_connections set last_sync_at=now(), last_sync_error=null
   where organization_id=p_org and id=c.connection_id;
  return total;
end $$;
revoke execute on function public.fn_microsoft_calendar_save(uuid,uuid,jsonb,timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.fn_microsoft_calendar_save(uuid,uuid,jsonb,timestamptz,timestamptz) to service_role;

create or replace function public.fn_google_selection(p_org uuid,p_revisions jsonb,p_sources uuid[],p_destination uuid)
returns void language plpgsql security definer set search_path=public as $$
declare actor uuid:=auth.uid(); expected jsonb; actual jsonb;
begin
 if actor is null or not public.fn_role_at_least(p_org,'agent') or not public.fn_support_write_allowed(p_org) then raise exception 'google_selection_forbidden' using errcode='42501';end if;
 if not public.fn_session_mfa_proven() then raise exception 'google_mfa_required' using errcode='42501';end if;
 perform 1 from public.user_organizations where organization_id=p_org and user_id=actor and revoked_at is null for update;
 if not found then raise exception 'google_owner_unavailable' using errcode='42501';end if;
 select jsonb_agg(value order by value->>'connection_id') into expected from jsonb_array_elements(p_revisions);
 select jsonb_agg(jsonb_build_object('connection_id',id,'revision',calendar_selection_revision::text) order by id::text) into actual from public.calendar_connections where organization_id=p_org and user_id=actor and provider='google_calendar';
 if actual is distinct from expected then raise exception 'google_selection_stale' using errcode='PT409';end if;
 if not exists(select 1 from public.calendar_connection_calendars k join public.calendar_connections c on c.id=k.connection_id and c.organization_id=k.organization_id
  where k.organization_id=p_org and k.id=p_destination and c.user_id=actor and c.provider='google_calendar' and c.status='healthy' and k.available and k.access_role in ('owner','writer')) then raise exception 'google_destination_unavailable' using errcode='42501';end if;
 if exists(select 1 from unnest(p_sources) selected(id) where not exists(select 1 from public.calendar_connection_calendars k join public.calendar_connections c on c.id=k.connection_id and c.organization_id=k.organization_id
  where k.organization_id=p_org and k.id=selected.id and c.user_id=actor and c.provider='google_calendar' and c.status='healthy' and k.available and k.access_role in ('owner','writer','reader','writerWithoutPrivateAccess'))) then raise exception 'google_source_unavailable' using errcode='42501';end if;
 update public.calendar_connection_calendars k set is_destination=false from public.calendar_connections c where k.organization_id=p_org and c.organization_id=p_org and k.connection_id=c.id and c.user_id=actor and c.provider='google_calendar';
 update public.calendar_connection_calendars k set is_destination=k.id=p_destination,counts_for_conflicts=k.id=any(p_sources),sync_next_attempt_at=now() from public.calendar_connections c where k.organization_id=p_org and c.organization_id=p_org and k.connection_id=c.id and c.user_id=actor and c.provider='google_calendar';
 update public.calendar_connections set calendar_selection_revision=calendar_selection_revision+1 where organization_id=p_org and user_id=actor and provider='google_calendar';
end;$$;
revoke all on function public.fn_google_selection(uuid,jsonb,uuid[],uuid) from public,anon;
grant execute on function public.fn_google_selection(uuid,jsonb,uuid[],uuid) to authenticated;

create or replace function public.fn_calendar_service_sources_to_refresh(p_org uuid,p_type uuid,p_owner uuid default null)
returns jsonb language sql stable security definer set search_path=public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',id) order by id),'[]'::jsonb) from (
    select distinct k.id from public.calendar_connection_calendars k
      join public.calendar_connections c on c.organization_id=k.organization_id and c.id=k.connection_id
      join public.user_organizations m on m.organization_id=c.organization_id and m.user_id=c.user_id and m.revoked_at is null
      join public.calendar_event_types t on t.organization_id=k.organization_id and t.id=p_type
      where k.organization_id=p_org and c.provider='google_calendar' and (
        k.id=t.destination_calendar_id or
        exists(select 1 from public.calendar_service_calendar_sources s where s.organization_id=p_org and s.event_type_id=p_type and s.calendar_id=k.id) or
        (k.counts_for_conflicts and exists(select 1 from public.calendar_service_professionals s where s.organization_id=p_org and s.event_type_id=p_type
          and s.user_id=c.user_id and (p_owner is null or s.user_id=p_owner))))
  ) x;
$$;
revoke all on function public.fn_calendar_service_sources_to_refresh(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_calendar_service_sources_to_refresh(uuid,uuid,uuid) to service_role;

notify pgrst,'reload schema';
