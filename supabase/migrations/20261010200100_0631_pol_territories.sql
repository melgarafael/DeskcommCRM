-- manifest: tabelas pol_territories, pol_territory_metrics, pol_tse_data, pol_territory_flags — modelagem territorial hierárquica para o War Room 2.0, com dados do TSE, métricas por período e sistema de alertas por território

-- ══════════════════════════════════════════════════════════════════
-- pol_territories — territórios hierárquicos
--
-- Modelo hierárquico via parent_id: estado → cidade → bairro → zona → seção.
-- Integração com IBGE (ibge_code) e TSE (via pol_tse_data).
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_territories (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  name                    text         not null check (char_length(name) between 1 and 200),
  -- Tipo de território. Vocabulário controlado por CHECK.
  type                    text         not null
                          check (type in (
                            'estado', 'cidade', 'bairro', 'zona_eleitoral', 'secao', 'regiao', 'distrito'
                          )),
  -- Hierarquia: estado → cidade → bairro → zona → seção
  parent_id               uuid         references public.pol_territories(id) on delete set null,
  -- Integração IBGE
  ibge_code               text,
  state_code              char(2),
  -- Geo
  latitude                numeric,
  longitude               numeric,
  -- Dados demográficos
  population              integer,
  electorate              integer,
  created_at              timestamptz  not null default now(),
  updated_at              timestamptz  not null default now(),
  -- IBGE code único por organização quando presente
  constraint pol_territories_org_ibge_uq unique (organization_id, ibge_code)
);

-- Índice parcial: o unique constraint acima já cobre ibge_code not null,
-- mas precisamos de lookup por org + type para listagens
create index if not exists pol_territories_org_type_idx
  on public.pol_territories (organization_id, type);

create index if not exists pol_territories_parent_idx
  on public.pol_territories (parent_id)
  where parent_id is not null;

create index if not exists pol_territories_org_state_idx
  on public.pol_territories (organization_id, state_code)
  where state_code is not null;

comment on table public.pol_territories is
  'Territórios hierárquicos (estado → cidade → bairro → zona → seção) com integração IBGE/TSE para análise territorial do War Room.';

-- Touch updated_at
create or replace trigger pol_territories_touch
  before update on public.pol_territories
  for each row execute function public.fn_touch_updated_at();

-- RLS
alter table public.pol_territories enable row level security;

create policy tenant_isolation_pol_territories_all
  on public.pol_territories for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));

-- ══════════════════════════════════════════════════════════════════
-- Agora que pol_territories existe, adicionar a FK em pol_leads
-- ══════════════════════════════════════════════════════════════════

alter table public.pol_leads
  add constraint pol_leads_territory_fk
  foreign key (territory_id) references public.pol_territories(id) on delete set null;

-- ══════════════════════════════════════════════════════════════════
-- pol_territory_metrics — métricas periódicas por território
--
-- Snapshot mensal/semanal de indicadores por território.
-- Permite análise de evolução temporal e comparação entre regiões.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_territory_metrics (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  territory_id            uuid         not null references public.pol_territories(id) on delete cascade,
  -- Primeiro dia do período medido
  period                  date         not null,
  -- Contadores
  supporters              integer      not null default 0,
  militants               integer      not null default 0,
  participants            integer      not null default 0,
  -- Scores calculados
  influence_score         numeric      not null default 0,
  growth_rate             numeric      not null default 0,
  dominance_score         numeric      not null default 0,
  -- Status estratégico
  strategic_status        text         not null default 'normal'
                          check (strategic_status in (
                            'normal', 'prioritario', 'critico', 'consolidado', 'oportunidade'
                          )),
  created_at              timestamptz  not null default now(),
  -- Um registro por território por período
  constraint pol_territory_metrics_territory_period_uq unique (territory_id, period)
);

comment on table public.pol_territory_metrics is
  'Métricas periódicas por território — supporters, militants, scores de influência e dominância, status estratégico.';

create index if not exists pol_territory_metrics_org_idx
  on public.pol_territory_metrics (organization_id);

create index if not exists pol_territory_metrics_period_idx
  on public.pol_territory_metrics (period);

-- RLS
alter table public.pol_territory_metrics enable row level security;

create policy tenant_isolation_pol_territory_metrics_all
  on public.pol_territory_metrics for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));

-- ══════════════════════════════════════════════════════════════════
-- pol_tse_data — dados eleitorais do TSE por território
--
-- Dados históricos de votação importados do TSE.
-- Permite projeção eleitoral e análise de desempenho por território.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_tse_data (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  territory_id            uuid         not null references public.pol_territories(id) on delete cascade,
  election_year           integer      not null,
  -- Cargo disputado
  cargo                   text         not null
                          check (cargo in (
                            'prefeito', 'vice_prefeito', 'vereador',
                            'governador', 'vice_governador',
                            'deputado_estadual', 'deputado_federal',
                            'senador', 'presidente', 'vice_presidente'
                          )),
  -- Números absolutos
  total_voters            integer,
  valid_votes             integer,
  candidate_votes         integer,
  -- Taxas
  turnout_rate            numeric,
  created_at              timestamptz  not null default now(),
  -- Um registro por território + ano + cargo
  constraint pol_tse_data_territory_year_cargo_uq unique (territory_id, election_year, cargo)
);

comment on table public.pol_tse_data is
  'Dados eleitorais do TSE — votação por território, ano e cargo para projeção eleitoral.';

create index if not exists pol_tse_data_org_idx
  on public.pol_tse_data (organization_id);

create index if not exists pol_tse_data_year_idx
  on public.pol_tse_data (election_year);

-- RLS
alter table public.pol_tse_data enable row level security;

create policy tenant_isolation_pol_tse_data_all
  on public.pol_tse_data for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));

-- ══════════════════════════════════════════════════════════════════
-- pol_territory_flags — alertas e flags por território
--
-- Sistema de sinalizações: queda de engajamento, região sem líder,
-- oportunidade detectada, conflito identificado etc.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_territory_flags (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  territory_id            uuid         not null references public.pol_territories(id) on delete cascade,
  -- Tipo de flag (vocabulário aberto — sem CHECK — para extensibilidade)
  flag_type               text         not null,
  severity                text         not null default 'medium'
                          check (severity in ('low', 'medium', 'high', 'critical')),
  description             text,
  resolved_at             timestamptz,
  resolved_by             uuid         references auth.users(id) on delete set null,
  created_at              timestamptz  not null default now()
);

comment on table public.pol_territory_flags is
  'Flags e alertas por território — queda de engajamento, região sem líder, oportunidade, conflito. Resolvidos por um usuário.';

create index if not exists pol_territory_flags_org_territory_idx
  on public.pol_territory_flags (organization_id, territory_id);

create index if not exists pol_territory_flags_org_open_idx
  on public.pol_territory_flags (organization_id, severity)
  where resolved_at is null;

-- RLS
alter table public.pol_territory_flags enable row level security;

create policy tenant_isolation_pol_territory_flags_all
  on public.pol_territory_flags for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));
