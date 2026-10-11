-- manifest: tabelas pol_surveys, pol_survey_questions, pol_survey_responses — pesquisas de campo do War Room 2.0 com formulários públicos via token, perguntas tipadas e respostas com geolocalização

-- ══════════════════════════════════════════════════════════════════
-- pol_surveys — pesquisas de campo
--
-- Consolida pesquisas do WR1.
-- Cada pesquisa tem tipo, status, período de vigência
-- e um token público para acesso externo sem autenticação.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_surveys (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  -- Identificação
  title                   text         not null,
  description             text,
  -- Tipo e status
  type                    text         not null default 'field'
                          check (type in (
                            'field', 'online', 'phone', 'door_to_door', 'other'
                          )),
  status                  text         not null default 'draft'
                          check (status in (
                            'draft', 'active', 'paused', 'completed', 'archived'
                          )),
  -- Período de vigência
  start_date              timestamptz,
  end_date                timestamptz,
  -- Token público (gerado server-side)
  public_token            text         not null default replace(gen_random_uuid()::text, '-', ''),
  created_at              timestamptz  not null default now(),
  updated_at              timestamptz  not null default now(),
  -- Token único por organização
  constraint pol_surveys_public_token_uq unique (public_token)
);

comment on table public.pol_surveys is
  'Pesquisas de campo — formulários com tipo, status, período de vigência e token público para acesso externo.';

-- Índices
create index if not exists pol_surveys_org_status_idx
  on public.pol_surveys (organization_id, status);

create index if not exists pol_surveys_org_type_idx
  on public.pol_surveys (organization_id, type);

create index if not exists pol_surveys_token_idx
  on public.pol_surveys (public_token);

create index if not exists pol_surveys_created_idx
  on public.pol_surveys (created_at);

-- Touch updated_at
create or replace trigger pol_surveys_touch
  before update on public.pol_surveys
  for each row execute function public.fn_touch_updated_at();

-- RLS
alter table public.pol_surveys enable row level security;

create policy tenant_isolation_pol_surveys_all
  on public.pol_surveys for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));

-- ══════════════════════════════════════════════════════════════════
-- pol_survey_questions — perguntas das pesquisas
--
-- Consolida pesquisa_perguntas do WR1.
-- Cada pergunta tem ordem, tema, tipo de resposta (text, choice,
-- scale, boolean, number, date, multi_choice) e opções em jsonb.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_survey_questions (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  survey_id               uuid         not null references public.pol_surveys(id) on delete cascade,
  -- Ordem e agrupamento
  "order"                 integer      not null default 0,
  theme                   text,
  -- Conteúdo
  question                text         not null,
  response_type           text         not null default 'text'
                          check (response_type in (
                            'text', 'choice', 'scale', 'boolean',
                            'number', 'date', 'multi_choice'
                          )),
  -- Opções para choice/multi_choice/scale
  options                 jsonb,
  required                boolean      not null default true,
  created_at              timestamptz  not null default now(),
  updated_at              timestamptz  not null default now()
);

comment on table public.pol_survey_questions is
  'Perguntas das pesquisas — ordenadas, com tema, tipo de resposta e opções configuráveis em jsonb.';

-- Índices
create index if not exists pol_survey_questions_org_survey_idx
  on public.pol_survey_questions (organization_id, survey_id);

create index if not exists pol_survey_questions_survey_order_idx
  on public.pol_survey_questions (survey_id, "order");

-- Touch updated_at
create or replace trigger pol_survey_questions_touch
  before update on public.pol_survey_questions
  for each row execute function public.fn_touch_updated_at();

-- RLS
alter table public.pol_survey_questions enable row level security;

create policy tenant_isolation_pol_survey_questions_all
  on public.pol_survey_questions for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));

-- ══════════════════════════════════════════════════════════════════
-- pol_survey_responses — respostas coletadas
--
-- Consolida pesquisa_respostas do WR1.
-- Cada resposta associa pesquisa + contato (opcional para anônimas),
-- com token de sessão, respostas em jsonb, duração, geo e referral.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_survey_responses (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  survey_id               uuid         not null references public.pol_surveys(id) on delete cascade,
  -- Respondente (nullable para respostas anônimas)
  contact_id              uuid         references public.contacts(id) on delete set null,
  -- Token de sessão da resposta
  token                   text         not null default replace(gen_random_uuid()::text, '-', ''),
  -- Respostas: { "question_id": "resposta" }
  answers                 jsonb        not null default '{}'::jsonb,
  -- Status
  completed               boolean      not null default false,
  -- Métricas
  duration_seconds        integer,
  -- Geolocalização
  city                    text,
  state                   char(2),
  -- Referral
  shared_by               uuid         references auth.users(id),
  created_at              timestamptz  not null default now(),
  updated_at              timestamptz  not null default now()
);

comment on table public.pol_survey_responses is
  'Respostas de pesquisas — jsonb com respostas por pergunta, duração, geolocalização e referral.';

-- Índices
create index if not exists pol_survey_responses_org_survey_idx
  on public.pol_survey_responses (organization_id, survey_id);

create index if not exists pol_survey_responses_survey_completed_idx
  on public.pol_survey_responses (survey_id, completed)
  where completed = true;

create index if not exists pol_survey_responses_contact_idx
  on public.pol_survey_responses (contact_id)
  where contact_id is not null;

create index if not exists pol_survey_responses_token_idx
  on public.pol_survey_responses (token);

create index if not exists pol_survey_responses_created_idx
  on public.pol_survey_responses (created_at);

-- Touch updated_at
create or replace trigger pol_survey_responses_touch
  before update on public.pol_survey_responses
  for each row execute function public.fn_touch_updated_at();

-- RLS
alter table public.pol_survey_responses enable row level security;

create policy tenant_isolation_pol_survey_responses_all
  on public.pol_survey_responses for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));
