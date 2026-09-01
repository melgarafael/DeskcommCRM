-- 0165 — Agenda nativa do CRM (Frente A): tipos de agendamento, horário de
-- trabalho por atendente, e o agendamento em si.
--
-- Três tabelas, organization_id + RLS desde o nascimento (doutrina de
-- multi-tenancy). `attendant_schedule` é DELIBERADAMENTE separada de
-- `attendant_availability` (migration 0039/epic de Governança) — aquela é o
-- toggle efêmero de fila de chat, esta é o horário estrutural de agendamento.
-- Acoplar os dois faria conceitos de negócio diferentes evoluírem juntos sem
-- necessidade.

create extension if not exists btree_gist with schema extensions;

-- Wrapper IMMUTABLE do `scheduled_at + (duration_minutes || ' minutos')::interval`.
-- O operador `timestamptz + interval` do Postgres é marcado STABLE (não
-- IMMUTABLE) porque em geral um `interval` pode carregar meses/anos, cuja
-- duração depende de calendário/timezone — mas aqui `duration_minutes` é
-- SEMPRE um interval puro de minutos, sem ambiguidade de calendário. Esta
-- função é a asserção explícita e documentada dessa garantia, permitindo usar
-- a expressão numa exclusion constraint (`gist`) e numa coluna gerada — ambos
-- exigem IMMUTABLE, e o Postgres não tem como provar isso sozinho a partir do
-- operador genérico.
create or replace function public.fn_appointment_ends_at(p_scheduled_at timestamptz, p_duration_minutes integer)
returns timestamptz
language sql
immutable
set search_path = public
as $$
  select p_scheduled_at + (p_duration_minutes || ' minutes')::interval
$$;

revoke all     on function public.fn_appointment_ends_at(timestamptz, integer) from public;
revoke execute on function public.fn_appointment_ends_at(timestamptz, integer) from anon;
grant  execute on function public.fn_appointment_ends_at(timestamptz, integer) to authenticated, service_role;

create table if not exists public.appointment_types (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  name                text not null check (length(name) > 0),
  duration_minutes    integer not null check (duration_minutes > 0),
  responsible_user_id uuid not null references auth.users(id),
  color               text check (color is null or color ~ '^#[0-9a-f]{6}$'),
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_appointment_types_org
  on public.appointment_types (organization_id);

alter table public.appointment_types enable row level security;

drop policy if exists "appointment_types_select" on public.appointment_types;
create policy "appointment_types_select" on public.appointment_types
  for select using (
    public.fn_is_platform_admin()
    or organization_id in (select public.fn_user_org_ids())
  );

-- `responsible_user_id` precisa ser MEMBRO da mesma organização (não só um
-- usuário existente em algum lugar do banco) — sem isso um manager podia
-- gravar tipo de agendamento apontando para usuário de outra organização, ou
-- para membro já removido (`revoked_at` preenchido).
drop policy if exists "appointment_types_write" on public.appointment_types;
create policy "appointment_types_write" on public.appointment_types
  for all using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'manager')
        and exists (
          select 1 from public.user_organizations uo
          where uo.user_id = appointment_types.responsible_user_id
            and uo.organization_id = appointment_types.organization_id
            and uo.revoked_at is null
        ))
  ) with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'manager')
        and exists (
          select 1 from public.user_organizations uo
          where uo.user_id = appointment_types.responsible_user_id
            and uo.organization_id = appointment_types.organization_id
            and uo.revoked_at is null
        ))
  );

create or replace trigger trg_appointment_types_updated_at
  before update on public.appointment_types
  for each row execute function public.fn_set_updated_at();

-- ---------------------------------------------------------------------------

create table if not exists public.attendant_schedule (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  day_of_week     smallint not null check (day_of_week between 0 and 6),
  starts_at       time not null,
  ends_at         time not null check (ends_at > starts_at),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, user_id, day_of_week, starts_at)
);

create index if not exists idx_attendant_schedule_org_user
  on public.attendant_schedule (organization_id, user_id);

alter table public.attendant_schedule enable row level security;

drop policy if exists "attendant_schedule_select" on public.attendant_schedule;
create policy "attendant_schedule_select" on public.attendant_schedule
  for select using (
    public.fn_is_platform_admin()
    or organization_id in (select public.fn_user_org_ids())
  );

-- `user_id` precisa ser MEMBRO da mesma organização, pelo mesmo motivo da
-- `appointment_types_write` acima. Quando `user_id = auth.uid()` a checagem é
-- redundante (a sessão já é membro da org, por `fn_user_org_ids()`), mas
-- aplicá-la sem exceção evita que um manager grave horário para usuário de
-- outra organização ou já removido (`revoked_at` preenchido).
drop policy if exists "attendant_schedule_write" on public.attendant_schedule;
create policy "attendant_schedule_write" on public.attendant_schedule
  for all using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and (user_id = auth.uid() or public.fn_role_at_least(organization_id, 'manager'))
        and exists (
          select 1 from public.user_organizations uo
          where uo.user_id = attendant_schedule.user_id
            and uo.organization_id = attendant_schedule.organization_id
            and uo.revoked_at is null
        ))
  ) with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and (user_id = auth.uid() or public.fn_role_at_least(organization_id, 'manager'))
        and exists (
          select 1 from public.user_organizations uo
          where uo.user_id = attendant_schedule.user_id
            and uo.organization_id = attendant_schedule.organization_id
            and uo.revoked_at is null
        ))
  );

create or replace trigger trg_attendant_schedule_updated_at
  before update on public.attendant_schedule
  for each row execute function public.fn_set_updated_at();

-- ---------------------------------------------------------------------------

create table if not exists public.appointments (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  lead_id              uuid not null references public.crm_leads(id) on delete cascade,
  appointment_type_id  uuid not null references public.appointment_types(id),
  responsible_user_id  uuid not null references auth.users(id),
  scheduled_at         timestamptz not null,
  duration_minutes     integer not null check (duration_minutes > 0),
  status               text not null default 'scheduled'
                       check (status in ('scheduled','completed','cancelled','no_show')),
  reminder_sent_at     timestamptz,
  created_by_user_id   uuid not null references auth.users(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- Regra dura, no banco: a mesma pessoa nunca tem 2 agendamentos `scheduled`
  -- sobrepostos, mesmo com duas requisições concorrentes.
  exclude using gist (
    responsible_user_id with =,
    tstzrange(scheduled_at, public.fn_appointment_ends_at(scheduled_at, duration_minutes)) with &&
  ) where (status = 'scheduled')
);

create index if not exists idx_appointments_org_lead on public.appointments (organization_id, lead_id);
create index if not exists idx_appointments_org_responsible_date
  on public.appointments (organization_id, responsible_user_id, scheduled_at);
create index if not exists idx_appointments_reminder_pending
  on public.appointments (scheduled_at)
  where status = 'scheduled' and reminder_sent_at is null;

alter table public.appointments enable row level security;

-- SELECT herda a visibilidade do lead-pai (mesmo idioma de
-- `crm_lead_activities_select`, migration 0042) — quem não pode ver o lead
-- não pode ver o agendamento dele.
drop policy if exists "appointments_select" on public.appointments;
create policy "appointments_select" on public.appointments
  for select using (
    exists (
      select 1 from public.crm_leads l
      where l.id = appointments.lead_id
        and public.fn_can_view_lead(l.organization_id, l.owner_user_id)
    )
  );

-- `lead_id` e `appointment_type_id` precisam apontar para linhas da MESMA
-- organização do agendamento — FK sozinha só garante que a linha existe em
-- ALGUMA organização, não na organização certa. Sem isto um agent da org A
-- conseguia gravar `organization_id = org_A` com `lead_id`/`appointment_type_id`
-- de outra organização, e como a exclusion constraint abaixo (`gist`, escopo
-- só por `responsible_user_id` + intervalo) não é escopada por organização,
-- isso vira vetor cross-tenant de probing/DoS contra a agenda de um
-- `responsible_user_id` de outra org. **`appointments.responsible_user_id`
-- fica FORA do escopo desta checagem de propósito** — nada aqui garante que
-- ele seja membro da organização (pode divergir do `responsible_user_id` do
-- `appointment_type` referenciado); é uma lacuna conhecida, deliberadamente
-- não coberta por este fix para não misturar o escopo do achado de referência
-- cruzada (lead/tipo) com o de membership do responsável.
drop policy if exists "appointments_write" on public.appointments;
create policy "appointments_write" on public.appointments
  for all using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'agent')
        and exists (
          select 1 from public.crm_leads l
          where l.id = appointments.lead_id
            and l.organization_id = appointments.organization_id
        )
        and exists (
          select 1 from public.appointment_types t
          where t.id = appointments.appointment_type_id
            and t.organization_id = appointments.organization_id
        ))
  ) with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'agent')
        and exists (
          select 1 from public.crm_leads l
          where l.id = appointments.lead_id
            and l.organization_id = appointments.organization_id
        )
        and exists (
          select 1 from public.appointment_types t
          where t.id = appointments.appointment_type_id
            and t.organization_id = appointments.organization_id
        ))
  );

create or replace trigger trg_appointments_updated_at
  before update on public.appointments
  for each row execute function public.fn_set_updated_at();

revoke all on public.appointment_types from anon;
revoke all on public.attendant_schedule from anon;
revoke all on public.appointments from anon;
