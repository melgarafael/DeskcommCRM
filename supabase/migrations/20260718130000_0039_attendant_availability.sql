-- 0039_attendant_availability — G5-01: config de roteamento + disponibilidade/
-- horário por atendente (spec 13 §3.4/§3.5/§5). Persiste o <AttendantStatusToggle>
-- da spec 04 §8.1-8.2 (100% ausente hoje — Apêndice B): is_available (toggle),
-- capacity (ajustável por atendente, nunca constante no código), schedule
-- (janela tz-aware) e last_heartbeat_at (AT-08: worker marca offline após 15min
-- sem heartbeat — trigger NUNCA faz HTTP; o worker é um cron TS que faz UPDATE).
--
-- RLS por-comando (nunca FOR ALL — lição G5/G4-01: o USING de um FOR ALL
-- permissivo TAMBÉM governa o SELECT via OR e vazaria escopo):
--   SELECT: org-wide (fn_user_org_ids) — disponibilidade da equipe é visível a
--           todo membro para o roteamento (spec 13 §4, nota 5).
--   INSERT/UPDATE/DELETE: a própria linha (user_id = auth.uid() + membro) OU
--           manager+ (fn_role_at_least). service_role (worker/ingestão) bypassa.
--
-- settings.routing (§3.5) é jsonb em organizations.settings (já existe no
-- baseline) — validado por Zod declarativo em lib/schemas/routing.ts, sem coluna
-- nem tabela nova. A elegibilidade (§5: disponível ∧ dentro do horário ∧ abaixo
-- da capacidade) é lógica TS pura (lib/routing/eligibility.ts) que o worker de
-- G5-02 consome — não fn SQL, pois o worker é TS e o teste usa clock mockado.
--
-- Idempotente (create ... if not exists / drop policy if exists + create),
-- portável em psql puro (sem BEGIN/COMMIT, sem temp tables).

create table if not exists public.attendant_availability (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  is_available      boolean not null default false,
  capacity          integer not null default 5 check (capacity > 0),
  schedule          jsonb not null default '{}',
  last_heartbeat_at timestamptz,
  updated_at        timestamptz not null default now(),
  unique (organization_id, user_id)
);

-- Elegibilidade/roteamento varre por (org, is_available); índice parcial fica
-- pequeno (só os online).
create index if not exists idx_attendant_availability_available
  on public.attendant_availability (organization_id)
  where is_available;

alter table public.attendant_availability enable row level security;

-- SELECT: org-wide (todo membro vê a disponibilidade da equipe).
drop policy if exists "attendant_availability_select" on public.attendant_availability;
create policy "attendant_availability_select" on public.attendant_availability
  for select using (
    public.fn_is_platform_admin()
    or organization_id in (select public.fn_user_org_ids())
  );

-- WRITE por-comando: própria linha OU manager+.
drop policy if exists "attendant_availability_insert" on public.attendant_availability;
create policy "attendant_availability_insert" on public.attendant_availability
  for insert with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and (user_id = auth.uid()
             or public.fn_role_at_least(organization_id, 'manager')))
  );

drop policy if exists "attendant_availability_update" on public.attendant_availability;
create policy "attendant_availability_update" on public.attendant_availability
  for update using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and (user_id = auth.uid()
             or public.fn_role_at_least(organization_id, 'manager')))
  ) with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and (user_id = auth.uid()
             or public.fn_role_at_least(organization_id, 'manager')))
  );

drop policy if exists "attendant_availability_delete" on public.attendant_availability;
create policy "attendant_availability_delete" on public.attendant_availability
  for delete using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and (user_id = auth.uid()
             or public.fn_role_at_least(organization_id, 'manager')))
  );
