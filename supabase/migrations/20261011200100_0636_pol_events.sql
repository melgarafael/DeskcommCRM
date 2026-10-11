-- manifest: tabelas pol_events, pol_event_attendance, pol_event_participants — eventos políticos do War Room 2.0 com controle de presença, papéis de participantes e dados institucionais

-- ══════════════════════════════════════════════════════════════════
-- pol_events — eventos políticos
--
-- Consolida events + political_events do WR1.
-- Cada evento tem tipo, tema, localização, data e controle
-- de público estimado vs real (actual_attendance).
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_events (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  -- Identificação do evento
  title                   text         not null,
  type                    text         not null default 'reuniao'
                          check (type in (
                            'reuniao', 'comicio', 'caminhada', 'carreata',
                            'debate', 'audiencia', 'assembleia', 'workshop',
                            'live', 'entrevista', 'visita', 'outro'
                          )),
  theme                   text,
  description             text,
  -- Localização
  city                    text,
  state                   char(2),
  neighborhood            text,
  venue                   text,
  -- Data e hora
  event_date              timestamptz  not null,
  event_end_date          timestamptz,
  -- Público
  estimated_audience      integer,
  actual_attendance       integer,
  -- Organizador
  organizer_contact_id    uuid         references public.contacts(id),
  -- Status
  status                  text         not null default 'scheduled'
                          check (status in (
                            'scheduled', 'confirmed', 'in_progress',
                            'completed', 'cancelled', 'postponed'
                          )),
  created_at              timestamptz  not null default now(),
  updated_at              timestamptz  not null default now()
);

comment on table public.pol_events is
  'Eventos políticos — consolida events e political_events do WR1. Tipo, tema, localização e controle de público estimado vs real.';

-- Índices
create index if not exists pol_events_org_status_idx
  on public.pol_events (organization_id, status);

create index if not exists pol_events_org_type_idx
  on public.pol_events (organization_id, type);

create index if not exists pol_events_org_date_idx
  on public.pol_events (organization_id, event_date);

create index if not exists pol_events_org_city_idx
  on public.pol_events (organization_id, city)
  where city is not null;

create index if not exists pol_events_created_idx
  on public.pol_events (created_at);

-- Touch updated_at
create or replace trigger pol_events_touch
  before update on public.pol_events
  for each row execute function public.fn_touch_updated_at();

-- RLS
alter table public.pol_events enable row level security;

create policy tenant_isolation_pol_events_all
  on public.pol_events for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));

-- ══════════════════════════════════════════════════════════════════
-- pol_event_attendance — presença em eventos
--
-- Consolida event_attendance do WR1.
-- Registra check-in de cada contato em cada evento,
-- com papel desempenhado e notas.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_event_attendance (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  event_id                uuid         not null references public.pol_events(id) on delete cascade,
  contact_id              uuid         not null references public.contacts(id) on delete cascade,
  -- Presença
  role                    text         not null default 'participante'
                          check (role in (
                            'organizador', 'palestrante', 'moderador',
                            'voluntario', 'participante', 'imprensa', 'outro'
                          )),
  checked_in_at           timestamptz,
  notes                   text,
  created_at              timestamptz  not null default now(),
  -- Um contato por evento
  constraint pol_event_attendance_event_contact_uq unique (organization_id, event_id, contact_id)
);

comment on table public.pol_event_attendance is
  'Presença em eventos políticos — check-in de contatos com papel e notas.';

-- Índices
create index if not exists pol_event_attendance_org_event_idx
  on public.pol_event_attendance (organization_id, event_id);

create index if not exists pol_event_attendance_contact_idx
  on public.pol_event_attendance (contact_id);

create index if not exists pol_event_attendance_checked_idx
  on public.pol_event_attendance (checked_in_at)
  where checked_in_at is not null;

-- RLS
alter table public.pol_event_attendance enable row level security;

create policy tenant_isolation_pol_event_attendance_all
  on public.pol_event_attendance for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));

-- ══════════════════════════════════════════════════════════════════
-- pol_event_participants — dados extras de participantes
--
-- Consolida participants do WR1.
-- Extensão de contacts com dados institucionais para contexto
-- político: instituição, tipo, papel e score de influência.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_event_participants (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  contact_id              uuid         not null references public.contacts(id) on delete cascade,
  -- Dados institucionais
  institution_name        text,
  institution_type        text
                          check (institution_type is null or institution_type in (
                            'partido', 'sindicato', 'associacao', 'ong',
                            'igreja', 'empresa', 'governo', 'universidade',
                            'midia', 'outro'
                          )),
  role_in_institution     text,
  -- Influência
  influence_score         numeric(5,2) not null default 0,
  created_at              timestamptz  not null default now(),
  updated_at              timestamptz  not null default now(),
  -- Um registro por contato por organização
  constraint pol_event_participants_contact_org_uq unique (organization_id, contact_id)
);

comment on table public.pol_event_participants is
  'Dados extras de participantes — extensão de contacts com dados institucionais, papel e score de influência para contexto político.';

-- Índices
create index if not exists pol_event_participants_org_idx
  on public.pol_event_participants (organization_id);

create index if not exists pol_event_participants_contact_idx
  on public.pol_event_participants (contact_id);

create index if not exists pol_event_participants_org_type_idx
  on public.pol_event_participants (organization_id, institution_type)
  where institution_type is not null;

create index if not exists pol_event_participants_org_influence_idx
  on public.pol_event_participants (organization_id, influence_score)
  where influence_score > 0;

-- Touch updated_at
create or replace trigger pol_event_participants_touch
  before update on public.pol_event_participants
  for each row execute function public.fn_touch_updated_at();

-- RLS
alter table public.pol_event_participants enable row level security;

create policy tenant_isolation_pol_event_participants_all
  on public.pol_event_participants for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));
