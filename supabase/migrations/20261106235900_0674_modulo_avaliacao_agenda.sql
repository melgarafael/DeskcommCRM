-- manifest: Módulo opcional `avaliacao` (ADR-0002): unidades e agendamentos de avaliação veicular; provisionadora `fn_avaliacao_provisionar`; transição de status só por `fn_avaliacao_transicao_status`; cron `fn_avaliacao_marcar_atrasados` marca `agendado` atrasado após o horário; distribuição automática de consultor por round-robin na unidade.

create or replace function public.fn_avaliacao_provisionar()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
begin
  create table if not exists public.avaliacao_unidades (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    name text not null check (char_length(trim(name)) > 0),
    sort_order integer not null default 0,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint avaliacao_unidades_nome_unico unique (organization_id, name)
  );

  create index if not exists avaliacao_unidades_org_idx
    on public.avaliacao_unidades (organization_id);

  create table if not exists public.avaliacao_agendamentos (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    contact_id uuid not null references public.contacts(id) on delete restrict,
    lead_id uuid references public.crm_leads(id) on delete set null,
    unit_id uuid not null references public.avaliacao_unidades(id) on delete restrict,
    consultant_user_id uuid references auth.users(id) on delete set null,
    attendant_user_id uuid references auth.users(id) on delete set null,
    scheduled_at timestamptz not null,
    duration_minutes integer not null default 20 check (duration_minutes > 0 and duration_minutes <= 480),
    client_email text,
    vehicle_plate text,
    vehicle_brand text,
    vehicle_model text,
    notes text,
    status text not null default 'agendado'
      check (status in ('agendado', 'em_avaliacao', 'cancelado', 'atrasado', 'aguardando', 'avaliado')),
    external_id text,
    evaluation_started_at timestamptz,
    cancelled_at timestamptz,
    evaluated_at timestamptz,
    evaluation_record_id uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint avaliacao_agendamentos_ext_unico unique (organization_id, external_id)
  );

  create index if not exists avaliacao_agendamentos_org_scheduled_idx
    on public.avaliacao_agendamentos (organization_id, scheduled_at);
  create index if not exists avaliacao_agendamentos_org_status_idx
    on public.avaliacao_agendamentos (organization_id, status);
  create index if not exists avaliacao_agendamentos_contact_idx
    on public.avaliacao_agendamentos (organization_id, contact_id);
  create index if not exists avaliacao_agendamentos_plate_idx
    on public.avaliacao_agendamentos (organization_id, vehicle_plate)
    where vehicle_plate is not null;

  alter table public.avaliacao_unidades enable row level security;
  drop policy if exists tenant_isolation_avaliacao_unidades_all on public.avaliacao_unidades;
  drop policy if exists avaliacao_unidades_select on public.avaliacao_unidades;
  create policy avaliacao_unidades_select
    on public.avaliacao_unidades
    for select using (
      organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
    );
  drop policy if exists avaliacao_unidades_insert on public.avaliacao_unidades;
  create policy avaliacao_unidades_insert
    on public.avaliacao_unidades
    for insert with check (
      public.fn_is_platform_admin()
      or (organization_id in (select public.fn_user_org_ids())
          and public.fn_role_at_least(organization_id, 'manager'))
    );
  drop policy if exists avaliacao_unidades_update on public.avaliacao_unidades;
  create policy avaliacao_unidades_update
    on public.avaliacao_unidades
    for update using (
      public.fn_is_platform_admin()
      or (organization_id in (select public.fn_user_org_ids())
          and public.fn_role_at_least(organization_id, 'manager'))
    ) with check (
      public.fn_is_platform_admin()
      or (organization_id in (select public.fn_user_org_ids())
          and public.fn_role_at_least(organization_id, 'manager'))
    );
  drop policy if exists avaliacao_unidades_delete on public.avaliacao_unidades;
  create policy avaliacao_unidades_delete
    on public.avaliacao_unidades
    for delete using (
      public.fn_is_platform_admin()
      or (organization_id in (select public.fn_user_org_ids())
          and public.fn_role_at_least(organization_id, 'manager'))
    );
  revoke all on public.avaliacao_unidades from anon;

  alter table public.avaliacao_agendamentos enable row level security;
  drop policy if exists tenant_isolation_avaliacao_agendamentos_all on public.avaliacao_agendamentos;
  drop policy if exists avaliacao_agendamentos_select on public.avaliacao_agendamentos;
  create policy avaliacao_agendamentos_select
    on public.avaliacao_agendamentos
    for select using (
      organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
    );
  drop policy if exists avaliacao_agendamentos_insert on public.avaliacao_agendamentos;
  create policy avaliacao_agendamentos_insert
    on public.avaliacao_agendamentos
    for insert with check (
      public.fn_is_platform_admin()
      or (organization_id in (select public.fn_user_org_ids())
          and public.fn_role_at_least(organization_id, 'agent'))
    );
  drop policy if exists avaliacao_agendamentos_update on public.avaliacao_agendamentos;
  create policy avaliacao_agendamentos_update
    on public.avaliacao_agendamentos
    for update using (
      public.fn_is_platform_admin()
      or (organization_id in (select public.fn_user_org_ids())
          and public.fn_role_at_least(organization_id, 'agent'))
    ) with check (
      public.fn_is_platform_admin()
      or (organization_id in (select public.fn_user_org_ids())
          and public.fn_role_at_least(organization_id, 'agent'))
    );
  drop policy if exists avaliacao_agendamentos_delete on public.avaliacao_agendamentos;
  create policy avaliacao_agendamentos_delete
    on public.avaliacao_agendamentos
    for delete using (
      public.fn_is_platform_admin()
      or (organization_id in (select public.fn_user_org_ids())
          and public.fn_role_at_least(organization_id, 'manager'))
    );
  revoke all on public.avaliacao_agendamentos from anon;

  drop trigger if exists avaliacao_agendamentos_status_guard on public.avaliacao_agendamentos;
  create trigger avaliacao_agendamentos_status_guard
    before update on public.avaliacao_agendamentos
    for each row execute function public.trg_avaliacao_status_guard();

  perform public.fn_avaliacao_declarar_secoes_lgpd();
  perform public.fn_proteger_modulo_provisionado();
end;
$f$;

revoke execute on function public.fn_avaliacao_provisionar() from public, anon, authenticated;
grant execute on function public.fn_avaliacao_provisionar() to service_role;

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

create or replace function public.fn_avaliacao_transicao_status(
  p_org uuid,
  p_id uuid,
  p_acao text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
declare
  v_status text;
  v_novo text;
begin
  if auth.uid() is null then
    raise exception 'avaliacao_forbidden' using errcode = '42501';
  end if;
  if not public.fn_role_at_least(p_org, 'agent') and not public.fn_is_platform_admin() then
    raise exception 'avaliacao_forbidden' using errcode = '42501';
  end if;
  if not public.fn_support_write_allowed(p_org) then
    raise exception 'support_readonly' using errcode = '42501';
  end if;

  select status into v_status
    from public.avaliacao_agendamentos
   where id = p_id and organization_id = p_org
   for update;

  if not found then
    raise exception 'avaliacao_nao_encontrado' using errcode = 'P0002';
  end if;

  v_novo := case p_acao
    when 'cancelar' then
      case when v_status in ('agendado', 'atrasado', 'aguardando') then 'cancelado' else null end
    when 'reativar' then
      case when v_status = 'cancelado' then 'agendado' else null end
    when 'aguardando' then
      case when v_status = 'agendado' then 'aguardando' else null end
    when 'reverter' then
      case when v_status = 'aguardando' then 'agendado' else null end
    when 'iniciar_avaliacao' then
      case when v_status in ('agendado', 'atrasado') then 'em_avaliacao' else null end
    when 'concluir' then
      case when v_status = 'em_avaliacao' then 'avaliado' else null end
    else null
  end;

  if v_novo is null then
    raise exception 'avaliacao_transicao_invalida' using errcode = '22023';
  end if;

  if p_acao = 'iniciar_avaliacao' and v_status = 'cancelado' then
    raise exception 'avaliacao_cancelado_nao_inicia' using errcode = '22023';
  end if;

  perform set_config('avaliacao.alterando_status', '1', true);

  update public.avaliacao_agendamentos
     set status = v_novo,
         updated_at = now(),
         cancelled_at = case when v_novo = 'cancelado' then now() else cancelled_at end,
         evaluation_started_at = case when v_novo = 'em_avaliacao' then coalesce(evaluation_started_at, now()) else evaluation_started_at end,
         evaluated_at = case when v_novo = 'avaliado' then now() else evaluated_at end
   where id = p_id and organization_id = p_org;

  return (
    select jsonb_build_object(
      'id', a.id,
      'status', a.status,
      'evaluation_started_at', a.evaluation_started_at,
      'cancelled_at', a.cancelled_at,
      'evaluated_at', a.evaluated_at
    )
    from public.avaliacao_agendamentos a
    where a.id = p_id
  );
end;
$f$;

revoke execute on function public.fn_avaliacao_transicao_status(uuid, uuid, text) from public, anon;
grant execute on function public.fn_avaliacao_transicao_status(uuid, uuid, text) to authenticated, service_role;

create or replace function public.fn_avaliacao_marcar_atrasados()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
declare
  v_count integer;
begin
  if to_regclass('public.avaliacao_agendamentos') is null then
    return 0;
  end if;

  perform set_config('avaliacao.alterando_status', '1', true);

  with atualizados as (
    update public.avaliacao_agendamentos
       set status = 'atrasado',
           updated_at = now()
     where status = 'agendado'
       and scheduled_at < now()
            and public.fn_org_operante(organization_id)
     returning 1
  )
  select count(*)::integer into v_count from atualizados;

  return coalesce(v_count, 0);
end;
$f$;

revoke execute on function public.fn_avaliacao_marcar_atrasados() from public, anon, authenticated;
grant execute on function public.fn_avaliacao_marcar_atrasados() to service_role;

create or replace function public.fn_avaliacao_declarar_secoes_lgpd()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
begin
  if to_regclass('public.avaliacao_agendamentos') is null then
    return;
  end if;

  insert into public.modulo_secoes_lgpd
      (modulo, tabela, ligacao, colunas, colunas_rotulo, colunas_redigidas, colunas_agora)
    values (
      'avaliacao',
      'avaliacao_agendamentos',
      'organization_id = $1 and contact_id = $2',
      array['notes', 'client_email', 'vehicle_plate', 'vehicle_brand', 'vehicle_model'],
      '{}'::text[],
      '{}'::text[],
      array['updated_at']
    )
    on conflict (modulo, tabela) do update
      set ligacao = excluded.ligacao,
          colunas = excluded.colunas,
          colunas_rotulo = excluded.colunas_rotulo,
          colunas_redigidas = excluded.colunas_redigidas,
          colunas_agora = excluded.colunas_agora;
end;
$f$;

revoke execute on function public.fn_avaliacao_declarar_secoes_lgpd() from public, anon, authenticated;
grant execute on function public.fn_avaliacao_declarar_secoes_lgpd() to service_role;

comment on function public.fn_avaliacao_declarar_secoes_lgpd() is
  'Declara a seção de LGPD dos agendamentos de avaliação em modulo_secoes_lgpd (D8, 0485). Chamada pela provisionadora.';
