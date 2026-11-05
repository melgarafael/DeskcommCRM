-- manifest: **Um serviço pode reservar um LUGAR com capacidade por período (mesa, camarote, quadra).** `calendar_resources` ganha `kind` ('resource' | 'space') e `sector`, e a reserva grava `service_space_id` + `service_party_size`; a capacidade do lugar é contada em PESSOAS pelo máximo simultâneo do período, no MESMO ponto que já conta a capacidade do serviço (`fn_calendar_service_check`, chamado pela reserva, pela prévia e pelo gatilho). Recurso 'space' deixa de ser exigência (todos livres) e passa a ser escolha (um por reserva). Aditiva e idempotente: recurso existente nasce `kind='resource'` e reserva existente nasce `service_party_size=1`, então a contagem em pessoas é idêntica à contagem em linhas de hoje.
--
-- 9224 — o lugar tem nome, área e capacidade de pessoas; a reserva escolhe um.
--
-- ─── O que já existia (medido, não suposto) ─────────────────────────────────
--
-- A agenda de serviços (0716, v1.87.0) já reserva por PERÍODO com teto de
-- pessoas: `calendar_event_types.booking_mode='collective_limited'` +
-- `service_capacity`, exceção por horário em `calendar_service_schedule`
-- (`capacity_rule`/`capacity_limit`) e a contagem feita em
-- `fn_calendar_service_check` sobre TODO o intervalo da reserva.
--
-- O que NÃO existia:
--
--   * um lugar com nome, área e capacidade própria. `calendar_resources` tem
--     `name`/`capacity`, mas o recurso é EXIGÊNCIA: `fn_calendar_service_check`
--     percorre TODOS os recursos do serviço e recusa se qualquer um estiver
--     ocupado (o laço `for resource in select ... from
--     calendar_service_resources`). Um serviço com oito mesas exigiria as oito
--     livres para qualquer reserva — não há "escolha uma".
--   * o tamanho do grupo. A capacidade conta LINHAS (`select ... ,1 delta from
--     intervals`), então "seis pessoas na mesa de quatro" e "uma pessoa na
--     mesa de quatro" pesam igual, e a reserva não guarda quantas pessoas vêm.
--   * o registro do lugar na reserva: `calendar_appointments` não tem coluna
--     de recurso/lugar, então nada liga a reserva à mesa escolhida.
--
-- ─── A decisão ──────────────────────────────────────────────────────────────
--
-- O lugar é o MESMO recurso que a agenda já conhece, marcado `kind='space'`
-- (capacidade em pessoas, `sector` opcional). Recurso `kind='resource'`
-- continua sendo exigência com `units`, exatamente como antes. Quando o
-- serviço tem ao menos um lugar, a reserva ESCOLHE um (`space_id`) e declara
-- quantas pessoas vêm (`party_size`); a ocupação do lugar é o MÁXIMO
-- simultâneo de `service_party_size` das reservas que se sobrepõem (a mesma
-- régua da capacidade do serviço), inclusive de outro serviço que ofereça o
-- mesmo lugar físico — a mesa é uma só. O lugar e as pessoas entram em
-- `service_operation_request`: repetir a chave com outra mesa é conflito.
--
-- ─── O que NÃO faz ──────────────────────────────────────────────────────────
--
-- Não escolhe o lugar sozinho (auto-atribuição), não desenha o salão, não cria
-- painel do dia e não muda a programação com validade: são fatias próprias.
-- Não mexe em reserva existente: linha antiga fica com `service_party_size=1`
-- e sem lugar, e continua contando exatamente como contava.

alter table public.calendar_resources
  add column if not exists kind text not null default 'resource',
  add column if not exists sector text;

alter table public.calendar_resources drop constraint if exists calendar_resources_kind_valid;
alter table public.calendar_resources add constraint calendar_resources_kind_valid
  check (kind in ('resource','space'));
alter table public.calendar_resources drop constraint if exists calendar_resources_sector_valid;
alter table public.calendar_resources add constraint calendar_resources_sector_valid
  check (sector is null or length(btrim(sector)) between 1 and 40);

alter table public.calendar_appointments
  add column if not exists service_space_id uuid,
  add column if not exists service_party_size integer not null default 1;

alter table public.calendar_appointments drop constraint if exists calendar_appointments_service_space_fk;
alter table public.calendar_appointments add constraint calendar_appointments_service_space_fk
  foreign key (organization_id,service_space_id) references public.calendar_resources(organization_id,id) on delete restrict;
alter table public.calendar_appointments drop constraint if exists calendar_appointments_service_party_valid;
alter table public.calendar_appointments add constraint calendar_appointments_service_party_valid
  check (service_party_size between 1 and 100000);

comment on column public.calendar_resources.kind is
  'resource = exigência (unidades consumidas por reserva); space = lugar reservável (capacidade em pessoas).';
comment on column public.calendar_appointments.service_party_size is
  'Pessoas desta reserva; a capacidade (do serviço e do lugar) é contada em pessoas desde a 9224.';

create or replace function public.fn_calendar_service_read(p_org uuid,p_type uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare t public.calendar_event_types; result jsonb;
begin
  if auth.uid() is not null and not public.fn_role_at_least(p_org,'viewer') then raise exception 'service_forbidden' using errcode='42501';end if;
  if auth.uid() is null and current_setting('role',true)='authenticated' then raise exception 'service_forbidden' using errcode='42501';end if;
  select * into t from public.calendar_event_types where organization_id=p_org and id=p_type;
  if not found then return null;end if;
  result:=jsonb_build_object('event_type_id',t.id,'name',t.name,'slug',t.slug,'is_active',t.is_active,
    'service_enabled',t.service_enabled,'booking_mode',t.booking_mode,'service_capacity',t.service_capacity,'service_timezone',t.service_timezone,
    'duration_minutes',t.duration_minutes,'slot_interval_minutes',t.slot_interval_minutes,'minimum_notice_minutes',t.minimum_notice_minutes,
    'booking_window_days',t.booking_window_days,'buffer_before_minutes',t.buffer_before_minutes,'buffer_after_minutes',t.buffer_after_minutes,
    'requires_confirmation',t.requires_confirmation,'destination_calendar_id',t.destination_calendar_id,'service_revision',t.service_revision,'service_publication_mode',t.service_publication_mode,
    'schedule',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'weekday',s.weekday,'on_date',s.on_date,'timing_kind',s.timing_kind,
      'start_minute',s.start_minute,'end_minute',s.end_minute,'duration_minutes',s.duration_minutes,'capacity_rule',s.capacity_rule,'capacity_limit',s.capacity_limit)
      order by s.on_date,s.weekday,s.start_minute) from public.calendar_service_schedule s where s.organization_id=p_org and s.event_type_id=p_type),'[]'::jsonb),
    'professionals',coalesce((select jsonb_agg(s.user_id order by s.user_id) from public.calendar_service_professionals s where s.organization_id=p_org and s.event_type_id=p_type),'[]'::jsonb),
    -- O recurso vai com o tipo e a área: é o que a tela precisa para separar exigência de lugar reservável.
    'resources',coalesce((select jsonb_agg(jsonb_build_object('resource_id',s.resource_id,'units',s.units,
      'kind',r.kind,'name',r.name,'capacity',r.capacity,'sector',r.sector) order by s.resource_id)
      from public.calendar_service_resources s join public.calendar_resources r on r.organization_id=s.organization_id and r.id=s.resource_id
      where s.organization_id=p_org and s.event_type_id=p_type),'[]'::jsonb),
    'calendar_sources',coalesce((select jsonb_agg(s.calendar_id order by s.calendar_id) from public.calendar_service_calendar_sources s where s.organization_id=p_org and s.event_type_id=p_type),'[]'::jsonb));
  return result;
end $$;
revoke all on function public.fn_calendar_service_read(uuid,uuid) from public,anon;
grant execute on function public.fn_calendar_service_read(uuid,uuid) to authenticated,service_role;

create or replace function public.fn_calendar_service_resource(p_org uuid,p_actor jsonb,p_config jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.calendar_resources;resource uuid:=coalesce((p_config->>'id')::uuid,gen_random_uuid());
  v_kind text:=nullif(btrim(p_config->>'kind'),'');
begin
 perform public.fn_calendar_service_assert_actor(p_org,p_actor,'manager');
 perform public.fn_calendar_service_lock(p_org);
 if coalesce(length(trim(p_config->>'name')),0) not between 2 and 100 or coalesce((p_config->>'capacity')::integer,0) not between 1 and 100000
   or (v_kind is not null and v_kind not in ('resource','space')) or coalesce(length(btrim(p_config->>'sector')),0)>40
  then raise exception 'service_resource_invalid' using errcode='22023';end if;
 select * into r from public.calendar_resources where organization_id=p_org and id=resource for update;
 if found then
  if r.revision is distinct from (p_config->>'expected_revision')::bigint then raise exception 'service_stale' using errcode='PT409';end if;
  -- Omitir o tipo mantém o que já era: editar o nome de uma mesa não a rebaixa a exigência.
  v_kind:=coalesce(v_kind,r.kind);
  -- Trocar o tipo de um recurso já comprometido reescreveria a regra de reservas que existem.
  if v_kind is distinct from r.kind and (exists(select 1 from public.calendar_service_resources s where s.organization_id=p_org and s.resource_id=r.id)
    or exists(select 1 from public.calendar_appointments a where a.organization_id=p_org and a.service_space_id=r.id and a.status in ('pending','confirmed')))
    then raise exception 'service_resource_in_use' using errcode='22023';end if;
  update public.calendar_resources set name=trim(p_config->>'name'),capacity=(p_config->>'capacity')::integer,kind=v_kind,
    sector=case when p_config?'sector' then nullif(btrim(p_config->>'sector'),'') else sector end,
    is_active=coalesce((p_config->>'is_active')::boolean,true),revision=revision+1 where organization_id=p_org and id=resource returning * into r;
 else
  if p_config?'id' then raise exception 'service_resource_not_found' using errcode='P0002';end if;
  insert into public.calendar_resources(id,organization_id,name,capacity,kind,sector)
    values(resource,p_org,trim(p_config->>'name'),(p_config->>'capacity')::integer,coalesce(v_kind,'resource'),nullif(btrim(p_config->>'sector'),'')) returning * into r;
 end if;
 return to_jsonb(r);
end $$;
revoke all on function public.fn_calendar_service_resource(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.fn_calendar_service_resource(uuid,jsonb,jsonb) to service_role;

-- A assinatura antiga sai: duas versões com contagem diferente seriam duas fontes de verdade.
drop function if exists public.fn_calendar_service_check(uuid,uuid,timestamptz,uuid,uuid,timestamptz);
create or replace function public.fn_calendar_service_check(p_org uuid,p_type uuid,p_start timestamptz,p_owner uuid default null,p_ignore uuid default null,p_now timestamptz default now(),p_space uuid default null,p_party integer default null)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare t public.calendar_event_types;s public.calendar_service_schedule;local_start timestamp;minute integer;priority_date boolean;priority_fixed boolean;
  rule_count integer;duration integer;end_at timestamptz;start_inflated timestamptz;end_inflated timestamptz;limit_value integer;occupied integer;
  person record;resource record;google jsonb;selected_owner uuid;available_owners uuid[]:='{}';own_occ uuid;held integer;consumed integer;coverage_failed boolean:=false;destination uuid;
  party integer;chosen_space uuid;row_space uuid;row_party integer;space_count integer;space_name text;space_sector text;space_capacity integer;space_occupied integer:=0;
begin
  select * into t from public.calendar_event_types where organization_id=p_org and id=p_type;
  if not found then return jsonb_build_object('available',false,'reason','service_not_found');end if;
  if not t.is_active or not t.service_enabled then return jsonb_build_object('available',false,'reason','service_inactive');end if;
  -- Remarcação revalida a MESMA reserva: o lugar e as pessoas dela vêm da linha apagada do cálculo.
  party:=coalesce(p_party,1);chosen_space:=p_space;
  if p_ignore is not null and (p_space is null or p_party is null) then
    select a.service_space_id,a.service_party_size into row_space,row_party
      from public.calendar_appointments a where a.organization_id=p_org and a.id=p_ignore;
    -- Sem linha (ainda inserindo), mantém o que veio: SELECT INTO vazio não zera o pedido.
    if found then
      chosen_space:=coalesce(chosen_space,row_space);
      if p_party is null then party:=coalesce(row_party,1);end if;
    end if;
  end if;
  if party not between 1 and 100000 then return jsonb_build_object('available',false,'reason','party_invalid');end if;
  if t.destination_calendar_id is not null and not exists(select 1 from public.calendar_connection_calendars k
    join public.calendar_connections c on c.organization_id=k.organization_id and c.id=k.connection_id
    join public.user_organizations m on m.organization_id=c.organization_id and m.user_id=c.user_id and m.revoked_at is null
    where k.organization_id=p_org and k.id=t.destination_calendar_id and k.available and c.status='healthy' and k.access_role in ('owner','writer'))
    then return jsonb_build_object('available',false,'reason','publication_unavailable');end if;
  local_start:=p_start at time zone t.service_timezone;minute:=extract(hour from local_start)::int*60+extract(minute from local_start)::int;
  if extract(second from local_start)<>0 then return jsonb_build_object('available',false,'reason','outside_schedule');end if;
  select exists(select 1 from public.calendar_service_schedule where organization_id=p_org and event_type_id=p_type and on_date=local_start::date
    and ((timing_kind='fixed' and start_minute=minute) or (timing_kind='window' and start_minute<=minute and end_minute>minute))) into priority_date;
  select exists(select 1 from public.calendar_service_schedule where organization_id=p_org and event_type_id=p_type
    and case when priority_date then on_date=local_start::date else on_date is null and weekday=extract(dow from local_start)::int end
    and timing_kind='fixed' and start_minute=minute) into priority_fixed;
  select count(*) into rule_count from public.calendar_service_schedule where organization_id=p_org and event_type_id=p_type
    and case when priority_date then on_date=local_start::date else on_date is null and weekday=extract(dow from local_start)::int end
    and case when priority_fixed then timing_kind='fixed' and start_minute=minute else timing_kind='window' and start_minute<=minute and end_minute>minute end;
  if rule_count<>1 then return jsonb_build_object('available',false,'reason',case when rule_count=0 then 'outside_schedule' else 'schedule_ambiguous' end);end if;
  select * into s from public.calendar_service_schedule where organization_id=p_org and event_type_id=p_type
    and case when priority_date then on_date=local_start::date else on_date is null and weekday=extract(dow from local_start)::int end
    and case when priority_fixed then timing_kind='fixed' and start_minute=minute else timing_kind='window' and start_minute<=minute and end_minute>minute end;
  duration:=coalesce(s.duration_minutes,t.duration_minutes);end_at:=p_start+make_interval(mins=>duration);
  if s.timing_kind='window' and (minute+duration>s.end_minute or (minute-s.start_minute)%coalesce(t.slot_interval_minutes,duration)<>0)
    then return jsonb_build_object('available',false,'reason','outside_schedule');end if;
  if p_start<p_now+make_interval(mins=>t.minimum_notice_minutes) or p_start>p_now+make_interval(days=>t.booking_window_days)
    then return jsonb_build_object('available',false,'reason','outside_booking_window');end if;
  start_inflated:=p_start-make_interval(mins=>t.buffer_before_minutes);end_inflated:=end_at+make_interval(mins=>t.buffer_after_minutes);
  google:=public.fn_calendar_service_google_state(p_org,p_type,null,start_inflated,end_inflated);
  if not (google->>'coverage_verified')::boolean then return jsonb_build_object('available',false,'reason','availability_unverified');end if;
  if (google->>'busy')::boolean or exists(select 1 from public.calendar_service_blocks where organization_id=p_org and scope_kind='service'
    and event_type_id=p_type and archived_at is null and starts_at<end_inflated and ends_at>start_inflated)
    then return jsonb_build_object('available',false,'reason','blocked');end if;
  if p_owner is not null and not exists(select 1 from public.calendar_service_professionals where organization_id=p_org and event_type_id=p_type and user_id=p_owner)
    then return jsonb_build_object('available',false,'reason','professional_not_eligible');end if;
  for person in select user_id from public.calendar_service_professionals where organization_id=p_org and event_type_id=p_type
    and (p_owner is null or user_id=p_owner) order by user_id loop
    google:=public.fn_calendar_service_google_state(p_org,p_type,person.user_id,start_inflated,end_inflated);
    if not (google->>'coverage_verified')::boolean then coverage_failed:=true;continue;end if;
    if not (google->>'busy')::boolean and public.fn_calendar_service_person_available(p_org,person.user_id,start_inflated,end_inflated,p_ignore,case when t.booking_mode<>'individual' then p_type else null end)
      then available_owners:=array_append(available_owners,person.user_id);end if;
  end loop;
  if (t.booking_mode='individual' or exists(select 1 from public.calendar_service_professionals where organization_id=p_org and event_type_id=p_type))
    and cardinality(available_owners)=0 then return jsonb_build_object('available',false,'reason',case when coverage_failed then 'availability_unverified' else 'professional_unavailable' end);end if;
  selected_owner:=available_owners[1];
  destination:=case when t.service_publication_mode='service' then t.destination_calendar_id else null end;
  if t.service_publication_mode='professional' then
    select k.id into destination from public.calendar_connection_calendars k join public.calendar_connections c on c.organization_id=k.organization_id and c.id=k.connection_id
      where k.organization_id=p_org and c.user_id=selected_owner and k.is_destination and k.available and c.status='healthy' and k.access_role in ('owner','writer');
    if destination is null then return jsonb_build_object('available',false,'reason','publication_unavailable');end if;
  end if;
  -- O lugar é escolhido, não exigido: um recurso 'space' do serviço hospeda UMA reserva por período.
  select count(*) into space_count from public.calendar_service_resources sr
    join public.calendar_resources r on r.organization_id=sr.organization_id and r.id=sr.resource_id
    where sr.organization_id=p_org and sr.event_type_id=p_type and r.kind='space';
  if space_count>0 then
    if chosen_space is null then return jsonb_build_object('available',false,'reason','space_required');end if;
    select r.name,r.sector,r.capacity into space_name,space_sector,space_capacity from public.calendar_resources r
      where r.organization_id=p_org and r.id=chosen_space and r.kind='space' and r.is_active
        and exists(select 1 from public.calendar_service_resources sr where sr.organization_id=p_org and sr.event_type_id=p_type and sr.resource_id=r.id);
    if not found then return jsonb_build_object('available',false,'reason','space_not_eligible','space_id',chosen_space);end if;
    if exists(select 1 from public.calendar_service_blocks b where b.organization_id=p_org and b.scope_kind='resource' and b.resource_id=chosen_space
      and b.archived_at is null and b.starts_at<end_inflated and b.ends_at>start_inflated)
      then return jsonb_build_object('available',false,'reason','space_unavailable','space_id',chosen_space,'space_name',space_name);end if;
    if party>space_capacity then
      return jsonb_build_object('available',false,'reason','party_exceeds_space_capacity','space_id',chosen_space,'space_name',space_name,
        'capacity_limit',space_capacity,'party_size',party);
    end if;
    -- A mesa é uma só: conta reservas de qualquer serviço que ofereça o mesmo lugar, pelo MÁXIMO simultâneo
    -- (a mesma régua da capacidade do serviço, abaixo): reservas em pontas opostas do período não se somam.
    with intervals as (
      select greatest(a.starts_at,p_start) s,least(a.ends_at,end_at) e,a.service_party_size n from public.calendar_appointments a
        where a.organization_id=p_org and a.service_space_id=chosen_space and a.id is distinct from p_ignore
          and not a.service_block and a.status in ('pending','confirmed') and a.starts_at<end_at and a.ends_at>p_start
    ),changes as (select i.s at,i.n delta from intervals i union all select i.e at,-i.n delta from intervals i),totals as (select at,sum(delta) delta from changes group by at),running as (
      select sum(delta) over(order by at rows unbounded preceding) count from totals)
    select coalesce(max(count),0)::integer into space_occupied from running;
    if space_occupied+party>space_capacity then
      return jsonb_build_object('available',false,'reason','space_capacity_reached','space_id',chosen_space,'space_name',space_name,
        'occupied',space_occupied,'capacity_limit',space_capacity,'party_size',party);
    end if;
  elsif chosen_space is not null then
    return jsonb_build_object('available',false,'reason','space_not_eligible','space_id',chosen_space);
  end if;
  -- O máximo simultâneo mede toda a duração, em PESSOAS; consultas disjuntas não se somam como se fossem simultâneas.
  with intervals as (
    select greatest(starts_at,p_start) s,least(ends_at,end_at) e,coalesce(service_party_size,1) n from public.calendar_appointments
      where organization_id=p_org and event_type_id=p_type and id is distinct from p_ignore and not service_block and status in ('pending','confirmed') and starts_at<end_at and ends_at>p_start
  ),changes as (select i.s at,i.n delta from intervals i union all select i.e at,-i.n delta from intervals i),totals as (select at,sum(delta) delta from changes group by at),running as (
    select sum(delta) over(order by at rows unbounded preceding) count from totals)
  select coalesce(max(count),0)::integer into occupied from running;
  limit_value:=case when t.booking_mode='individual' then null when s.capacity_rule='unlimited' then null when s.capacity_rule='limited' then s.capacity_limit
    when t.booking_mode='collective_limited' then t.service_capacity else null end;
  if limit_value is not null and occupied+party>limit_value then return jsonb_build_object('available',false,'reason','capacity_reached','occupied',occupied,'capacity_limit',limit_value,'party_size',party);end if;
  select id into own_occ from public.calendar_service_occurrences where organization_id=p_org and event_type_id=p_type and starts_at=p_start and ends_at=end_at
    and allocation_key=case when t.booking_mode='individual' then selected_owner else '00000000-0000-0000-0000-000000000000'::uuid end;
  -- Só recurso de EXIGÊNCIA consome unidades; lugar é contado em pessoas, acima.
  for resource in select r.id,r.capacity,r.is_active,sr.units from public.calendar_service_resources sr join public.calendar_resources r on r.organization_id=sr.organization_id and r.id=sr.resource_id
    where sr.organization_id=p_org and sr.event_type_id=p_type and r.kind='resource' order by r.id loop
    if not resource.is_active or exists(select 1 from public.calendar_service_blocks where organization_id=p_org and scope_kind='resource' and resource_id=resource.id
      and archived_at is null and starts_at<end_inflated and ends_at>start_inflated) then return jsonb_build_object('available',false,'reason','resource_unavailable');end if;
    select coalesce(max(units),0) into held from public.calendar_service_occurrence_resources where organization_id=p_org and occurrence_id=own_occ and resource_id=resource.id;
    with intervals as (
      select greatest(o.starts_at,start_inflated) s,least(o.ends_at,end_inflated) e,rr.units from public.calendar_service_occurrence_resources rr
        join public.calendar_service_occurrences o on o.organization_id=rr.organization_id and o.id=rr.occurrence_id
        where rr.organization_id=p_org and rr.resource_id=resource.id and rr.occurrence_id is distinct from own_occ
          and o.starts_at<end_inflated and o.ends_at>start_inflated
          and exists(select 1 from public.calendar_appointments a where a.organization_id=p_org and a.service_occurrence_id=o.id and a.id is distinct from p_ignore and a.status in ('pending','confirmed'))
    ),changes as(select i.s at,i.units delta from intervals i union all select i.e,-i.units from intervals i),totals as(select at,sum(delta) delta from changes group by at),running as(
      select sum(delta) over(order by at rows unbounded preceding) count from totals)
    select coalesce(max(count),0)::integer into consumed from running;
    if consumed+greatest(held,resource.units)>resource.capacity then return jsonb_build_object('available',false,'reason','resource_unavailable');end if;
  end loop;
  return jsonb_build_object('available',true,'reason',null,'starts_at',p_start,'ends_at',end_at,'duration_minutes',duration,'time_zone',t.service_timezone,
    'owner_user_id',selected_owner,'available_professionals',cardinality(available_owners),'booking_mode',t.booking_mode,'capacity_rule',s.capacity_rule,
    'capacity_limit',limit_value,'occupied',occupied,'remaining_capacity',case when cardinality(available_owners)>0 then
      case when limit_value is null then cardinality(available_owners) else least(limit_value-occupied,cardinality(available_owners)) end
      when limit_value is null then null else limit_value-occupied end,
    'party_size',party,'space_id',chosen_space,'space_name',space_name,'space_sector',space_sector,'space_capacity',space_capacity,
    'space_occupied',space_occupied,'space_remaining_capacity',case when chosen_space is null then null else space_capacity-space_occupied end,
    'service_revision',t.service_revision,'coverage_verified',true,'destination_calendar_id',destination,'service_publication_mode',t.service_publication_mode,'requires_confirmation',t.requires_confirmation);
end $$;
revoke all on function public.fn_calendar_service_check(uuid,uuid,timestamptz,uuid,uuid,timestamptz,uuid,integer) from public,anon,authenticated;
grant execute on function public.fn_calendar_service_check(uuid,uuid,timestamptz,uuid,uuid,timestamptz,uuid,integer) to service_role;

drop function if exists public.fn_calendar_service_preview(uuid,uuid,jsonb,uuid,timestamptz);
create or replace function public.fn_calendar_service_preview(p_org uuid,p_type uuid,p_starts jsonb,p_owner uuid default null,p_now timestamptz default now(),p_space uuid default null,p_party integer default null)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare item jsonb;result jsonb:='[]';
begin
  if auth.uid() is not null and not public.fn_role_at_least(p_org,'viewer') then raise exception 'service_forbidden' using errcode='42501';end if;
  if auth.uid() is null and current_setting('role',true)='authenticated' then raise exception 'service_forbidden' using errcode='42501';end if;
  if jsonb_typeof(p_starts)<>'array' or jsonb_array_length(p_starts)>500 then raise exception 'service_preview_invalid' using errcode='22023';end if;
  for item in select value from jsonb_array_elements(p_starts) loop
    result:=result||jsonb_build_array(public.fn_calendar_service_check(p_org,p_type,(item#>>'{}')::timestamptz,p_owner,null,p_now,p_space,p_party)||jsonb_build_object('starts_at',item#>>'{}'));
  end loop;
  return result;
end $$;
revoke all on function public.fn_calendar_service_preview(uuid,uuid,jsonb,uuid,timestamptz,uuid,integer) from public,anon;
grant execute on function public.fn_calendar_service_preview(uuid,uuid,jsonb,uuid,timestamptz,uuid,integer) to authenticated,service_role;

create or replace function public.fn_calendar_service_occurrence(p_org uuid,p_type uuid,p_check jsonb)
returns uuid language plpgsql security definer set search_path=public as $$
declare result uuid;assignment uuid;item record;
begin
  assignment:=case when p_check->>'booking_mode'='individual' then (p_check->>'owner_user_id')::uuid else '00000000-0000-0000-0000-000000000000'::uuid end;
  insert into public.calendar_service_occurrences(organization_id,event_type_id,starts_at,ends_at,booking_mode,allocation_key)
    values(p_org,p_type,(p_check->>'starts_at')::timestamptz,(p_check->>'ends_at')::timestamptz,p_check->>'booking_mode',assignment)
    on conflict(organization_id,event_type_id,starts_at,ends_at,allocation_key) do update set allocation_key=excluded.allocation_key returning id into result;
  -- Lugar não entra em ocorrência: a ocupação dele é por reserva (pessoas), não por unidades da turma.
  for item in select sr.resource_id,sr.units from public.calendar_service_resources sr
    join public.calendar_resources r on r.organization_id=sr.organization_id and r.id=sr.resource_id
    where sr.organization_id=p_org and sr.event_type_id=p_type and r.kind='resource' order by sr.resource_id loop
    insert into public.calendar_service_occurrence_resources(organization_id,occurrence_id,resource_id,units) values(p_org,result,item.resource_id,item.units)
      on conflict(organization_id,occurrence_id,resource_id) do update set units=greatest(calendar_service_occurrence_resources.units,excluded.units);
  end loop;
  return result;
end $$;
revoke all on function public.fn_calendar_service_occurrence(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.fn_calendar_service_occurrence(uuid,uuid,jsonb) to service_role;

create or replace function public.fn_calendar_service_book(p_org uuid,p_actor jsonb,p_input jsonb,p_execution jsonb default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare t public.calendar_event_types;a public.calendar_appointments;fact jsonb;occurrence uuid;contact uuid:=(p_input->>'contact_id')::uuid;
  type_id uuid:=(p_input->>'event_type_id')::uuid;start_at timestamptz:=(p_input->>'starts_at')::timestamptz;
  participant text;participant_name text:=nullif(trim(p_input->>'participant_name'),'');command_key text:=p_input->>'operation_key';
begin
  perform public.fn_calendar_service_assert_actor(p_org,p_actor,'agent');
  if contact is null or command_key is null or length(command_key)>500 or not exists(select 1 from public.contacts where organization_id=p_org and id=contact and not is_anonymized)
    then raise exception 'service_contact_not_found' using errcode='P0002';end if;
  perform public.fn_service_lock(p_org,contact);
  perform public.fn_calendar_service_lock(p_org);
  -- Anonimização pode ter aguardado a mesma trava enquanto o pedido esperava.
  if not exists(select 1 from public.contacts where organization_id=p_org and id=contact and not is_anonymized)
    then raise exception 'service_contact_not_found' using errcode='P0002';end if;
  if p_input->>'conversation_id' is not null and not exists(select 1 from public.conversations where organization_id=p_org
    and id=(p_input->>'conversation_id')::uuid and contact_id=contact and not is_group)
    then raise exception 'service_conversation_not_found' using errcode='P0002';end if;
  if p_actor->>'type'='ai_agent' and (p_actor->>'api_token_id' is null or p_actor->>'native_job' is not null or p_execution is not null)
    and (not public.fn_calendar_service_execution_current(p_org,contact,p_execution)
      or (p_actor->>'native_job' is not null and p_execution->'job'->>'id' is distinct from p_actor->>'native_job'))
    then raise exception 'service_execution_stale' using errcode='42501';end if;
  participant:=contact::text||':'||coalesce(lower(regexp_replace(participant_name,'\s+',' ','g')),'primary');
  -- Retry de comando também confere o conteúdo; não devolve uma operação alheia.
  select * into a from public.calendar_appointments where organization_id=p_org and service_operation_key=command_key;
  if found then
    if a.service_operation_request is distinct from jsonb_build_object('event_type_id',type_id,'contact_id',contact,'starts_at',start_at,'participant_key',participant)
      ||jsonb_strip_nulls(jsonb_build_object('space_id',(p_input->>'space_id')::uuid,'party_size',nullif(coalesce((p_input->>'party_size')::integer,1),1)))
      then raise exception 'service_idempotency_conflict' using errcode='PT409';end if;
    return to_jsonb(a)||jsonb_build_object('deduplicated',true);
  end if;
  select * into t from public.calendar_event_types where organization_id=p_org and id=type_id;
  if not found then raise exception 'service_not_found' using errcode='P0002';end if;
  -- A pessoa já reservada é encontrada antes de consumir vaga ou exigir outro profissional.
  select * into a from public.calendar_appointments where organization_id=p_org and event_type_id=type_id and starts_at=start_at
    and participant_key=participant and status in ('pending','confirmed');
  if found then return to_jsonb(a)||jsonb_build_object('deduplicated',true);end if;
  if p_input?'expected_revision' and t.service_revision is distinct from (p_input->>'expected_revision')::bigint then raise exception 'service_stale' using errcode='PT409';end if;
  fact:=public.fn_calendar_service_check(p_org,type_id,start_at,(p_input->>'owner_user_id')::uuid,null,now(),
    (p_input->>'space_id')::uuid,(p_input->>'party_size')::integer);
  if not coalesce((fact->>'available')::boolean,false) then raise exception '%',fact->>'reason' using errcode='PT409';end if;
  if p_actor->>'type'='user' and fact->>'owner_user_id' is not null and fact->>'owner_user_id' is distinct from p_actor->>'id'
    and not exists(select 1 from public.user_organizations where organization_id=p_org and user_id=(p_actor->>'id')::uuid
      and revoked_at is null and role in ('manager','admin')) and not public.fn_colegas_podem_mexer_na_agenda(p_org)
    then raise exception 'appointment_do_colega' using errcode='42501';end if;
  occurrence:=public.fn_calendar_service_occurrence(p_org,type_id,fact);
  insert into public.calendar_appointments(organization_id,event_type_id,title,starts_at,ends_at,time_zone,status,owner_user_id,contact_id,conversation_id,
    description,notes,location_kind,location_details,guest_email,meeting_delivery,created_by_kind,created_by_user_id,source,service_occurrence_id,participant_key,participant_name,
    service_booking_mode,service_capacity_rule,service_capacity_limit,service_rule_revision,service_destination_calendar_id,service_publication_mode,service_requires_confirmation,service_operation_key,service_operation_request,
    service_space_id,service_party_size)
    values(p_org,type_id,coalesce(nullif(p_input->>'title',''),t.name||case when participant_name is null then '' else ' · '||participant_name end),start_at,(fact->>'ends_at')::timestamptz,t.service_timezone,
      case when t.requires_confirmation then 'pending' else 'confirmed' end,(fact->>'owner_user_id')::uuid,contact,(p_input->>'conversation_id')::uuid,
      nullif(trim(p_input->>'description'),''),nullif(p_input->>'notes',''),t.location_kind,
      case when p_input?'location_details' then nullif(trim(p_input->>'location_details'),'') else t.location_details end,
      nullif(trim(p_input->>'guest_email'),''),coalesce(p_input->'meeting_delivery',jsonb_build_object('state','none')),
      case when p_actor->>'type'='user' then 'user' when p_actor->>'type'='ai_agent' then 'ai' else 'system' end,
      case when p_actor->>'type'='user' then (p_actor->>'id')::uuid else null end,
      case when p_actor->>'type'='user' then 'ui' else 'mcp' end,occurrence,participant,participant_name,
      t.booking_mode,fact->>'capacity_rule',(fact->>'capacity_limit')::integer,t.service_revision,(fact->>'destination_calendar_id')::uuid,t.service_publication_mode,t.requires_confirmation,command_key,
      jsonb_build_object('event_type_id',type_id,'contact_id',contact,'starts_at',start_at,'participant_key',participant)
      ||jsonb_strip_nulls(jsonb_build_object('space_id',(p_input->>'space_id')::uuid,'party_size',nullif(coalesce((p_input->>'party_size')::integer,1),1))),
      (fact->>'space_id')::uuid,coalesce((fact->>'party_size')::integer,1))
    returning * into a;
  return to_jsonb(a)||jsonb_build_object('deduplicated',false,'service_facts',fact);
end $$;
revoke all on function public.fn_calendar_service_book(uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.fn_calendar_service_book(uuid,jsonb,jsonb,jsonb) to service_role;

create or replace function public.fn_calendar_service_book_group(p_org uuid,p_actor jsonb,p_input jsonb,p_execution jsonb default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare item jsonb;result jsonb:='[]';names text[]:='{}';canonical text;one jsonb;
begin
  if jsonb_typeof(p_input->'participants')<>'array' or jsonb_array_length(p_input->'participants') not between 1 and 20
    then raise exception 'service_participants_invalid' using errcode='22023';end if;
  for item in select value from jsonb_array_elements(p_input->'participants') loop
    canonical:=lower(regexp_replace(trim(item#>>'{}'),'\s+',' ','g'));
    if coalesce(length(canonical),0) not between 1 and 120 or canonical=any(names) then raise exception 'service_participants_invalid' using errcode='22023';end if;
    names:=array_append(names,canonical);
    -- Cada participante é UMA pessoa no lugar; o tamanho do grupo é a contagem deles.
    one:=public.fn_calendar_service_book(p_org,p_actor,(p_input-'participants'-'party_size')||jsonb_build_object('participant_name',item#>>'{}',
      'operation_key',(p_input->>'operation_key')||':'||md5(canonical)),p_execution);
    result:=result||jsonb_build_array(one);
  end loop;
  return result;
end $$;
revoke all on function public.fn_calendar_service_book_group(uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.fn_calendar_service_book_group(uuid,jsonb,jsonb,jsonb) to service_role;

-- O gatilho revalida lugar e pessoas junto com horário/ocupação: escrita direta não vira segunda régua.
create or replace function public.fn_calendar_service_appointment_guard()
returns trigger language plpgsql security definer set search_path=public as $$
declare fact jsonb;checked boolean;type_row public.calendar_event_types;
begin
  if tg_op='DELETE' then return old;end if;
  if tg_op='INSERT' and new.service_occurrence_id is null and not new.service_block
    and exists(select 1 from public.calendar_event_types where organization_id=new.organization_id and id=new.event_type_id and service_enabled)
    then raise exception 'service_writer_required' using errcode='42501';end if;
  if tg_op='INSERT' and auth.uid() is not null and (new.service_block or (new.service_occurrence_id is null and (new.service_destination_calendar_id is not null or new.service_publication_mode is not null)))
    then raise exception 'service_writer_required' using errcode='42501';end if;
  if tg_op='UPDATE' and auth.uid() is not null and row(new.participant_key,new.participant_name,new.service_destination_calendar_id,new.service_publication_mode,new.service_requires_confirmation,new.service_operation_key,new.service_operation_request,new.service_block,new.service_space_id,new.service_party_size)
    is distinct from row(old.participant_key,old.participant_name,old.service_destination_calendar_id,old.service_publication_mode,old.service_requires_confirmation,old.service_operation_key,old.service_operation_request,old.service_block,old.service_space_id,old.service_party_size)
    then raise exception 'service_writer_required' using errcode='42501';end if;
  if tg_op='UPDATE' and auth.uid() is not null and ((old.service_occurrence_id is null and new.service_occurrence_id is not null)
    or (old.service_occurrence_id is not null and row(new.contact_id,new.event_type_id) is distinct from row(old.contact_id,old.event_type_id))
    or (row(new.starts_at,new.ends_at,new.owner_user_id,new.service_occurrence_id) is not distinct from row(old.starts_at,old.ends_at,old.owner_user_id,old.service_occurrence_id)
      and row(new.service_booking_mode,new.service_capacity_rule,new.service_capacity_limit,new.service_rule_revision) is distinct from row(old.service_booking_mode,old.service_capacity_rule,old.service_capacity_limit,old.service_rule_revision)))
    then raise exception 'service_writer_required' using errcode='42501';end if;
  if tg_op='UPDATE' and row(new.starts_at,new.ends_at,new.owner_user_id,new.status,new.service_occurrence_id,new.contact_id,new.event_type_id,new.service_destination_calendar_id,new.service_space_id,new.service_party_size)
    is not distinct from row(old.starts_at,old.ends_at,old.owner_user_id,old.status,old.service_occurrence_id,old.contact_id,old.event_type_id,old.service_destination_calendar_id,old.service_space_id,old.service_party_size) then return new;end if;
  if tg_op='INSERT' and new.service_occurrence_id is not null and new.contact_id is not null then perform public.fn_service_lock(new.organization_id,new.contact_id);end if;
  perform public.fn_calendar_service_lock(new.organization_id);
  if tg_op='INSERT' and new.service_occurrence_id is not null then
    if new.contact_id is null or new.service_operation_key is null or not exists(select 1 from public.contacts where organization_id=new.organization_id and id=new.contact_id and not is_anonymized)
      or new.status not in ('pending','confirmed') then raise exception 'service_creation_invalid' using errcode='22023';end if;
    if auth.uid() is not null then
      perform public.fn_calendar_service_assert_actor(new.organization_id,jsonb_build_object('type','user','id',auth.uid()),'agent');
      new.created_by_kind:='user';new.created_by_user_id:=auth.uid();new.source:='ui';
      new.meeting_delivery:=jsonb_build_object('state','none');
    end if;
    if new.conversation_id is not null and not exists(select 1 from public.conversations where organization_id=new.organization_id and id=new.conversation_id and contact_id=new.contact_id and not is_group)
      then raise exception 'service_conversation_not_found' using errcode='P0002';end if;
    new.participant_key:=new.contact_id::text||':'||coalesce(lower(regexp_replace(nullif(trim(new.participant_name),''),'\s+',' ','g')),'primary');
    -- O lugar e as pessoas entram no pedido: a mesma chave com outra mesa é conflito, não a reserva antiga devolvida.
    new.service_operation_request:=jsonb_build_object('event_type_id',new.event_type_id,'contact_id',new.contact_id,'starts_at',new.starts_at,'participant_key',new.participant_key)
      ||jsonb_strip_nulls(jsonb_build_object('space_id',new.service_space_id,'party_size',nullif(new.service_party_size,1)));
  end if;
  if new.status not in ('pending','confirmed') or new.service_block then return new;end if;
  checked:=new.service_occurrence_id is not null;
  if checked then
    if not exists(select 1 from public.calendar_service_occurrences o where o.organization_id=new.organization_id and o.id=new.service_occurrence_id
      and o.event_type_id=new.event_type_id and o.starts_at=new.starts_at and o.ends_at=new.ends_at)
      then raise exception 'service_occurrence_mismatch' using errcode='23503';end if;
    -- Confirmação não reabre uma reserva já ocupante; mudança de horário, de lugar, de pessoas ou reativação revalida.
    if tg_op='INSERT' or row(new.starts_at,new.ends_at,new.owner_user_id,new.service_occurrence_id) is distinct from row(old.starts_at,old.ends_at,old.owner_user_id,old.service_occurrence_id)
      or row(new.service_space_id,new.service_party_size) is distinct from row(old.service_space_id,old.service_party_size)
      or old.status not in ('pending','confirmed') then
      fact:=public.fn_calendar_service_check(new.organization_id,new.event_type_id,new.starts_at,new.owner_user_id,new.id,now(),new.service_space_id,new.service_party_size);
      if not coalesce((fact->>'available')::boolean,false) then raise exception '%',fact->>'reason' using errcode='PT409';end if;
      if (fact->>'ends_at')::timestamptz is distinct from new.ends_at then raise exception 'service_duration_mismatch' using errcode='PT409';end if;
      new.service_booking_mode:=fact->>'booking_mode';new.service_capacity_rule:=fact->>'capacity_rule';
      new.service_capacity_limit:=(fact->>'capacity_limit')::integer;new.service_rule_revision:=(fact->>'service_revision')::bigint;
      new.service_space_id:=(fact->>'space_id')::uuid;new.service_party_size:=coalesce((fact->>'party_size')::integer,1);
      new.service_occurrence_id:=public.fn_calendar_service_occurrence(new.organization_id,new.event_type_id,fact);
      if tg_op='INSERT' then
        select * into type_row from public.calendar_event_types where organization_id=new.organization_id and id=new.event_type_id;
        new.service_destination_calendar_id:=(fact->>'destination_calendar_id')::uuid;
        new.service_publication_mode:=type_row.service_publication_mode;new.service_requires_confirmation:=type_row.requires_confirmation;
        new.status:=case when type_row.requires_confirmation then 'pending' else 'confirmed' end;
      end if;
    end if;
  end if;
  if new.owner_user_id is not null and exists(select 1 from public.calendar_appointments a where a.organization_id=new.organization_id and a.id<>new.id
    and a.owner_user_id=new.owner_user_id and a.status in ('pending','confirmed') and a.starts_at<new.ends_at and a.ends_at>new.starts_at
    and not (new.service_occurrence_id is not null and a.service_occurrence_id=new.service_occurrence_id
      and new.service_booking_mode in ('collective_limited','collective_unlimited'))
    and (checked or a.service_occurrence_id is not null)) then raise exception 'professional_unavailable' using errcode='PT409';end if;
  return new;
end $$;
revoke all on function public.fn_calendar_service_appointment_guard() from public,anon,authenticated;
drop trigger if exists trg_calendar_service_appointment_guard on public.calendar_appointments;
create trigger trg_calendar_service_appointment_guard before insert or update on public.calendar_appointments for each row execute function public.fn_calendar_service_appointment_guard();

notify pgrst,'reload schema';
