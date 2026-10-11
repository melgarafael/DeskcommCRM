-- manifest: tabelas pol_opponents, pol_opponent_snapshots, pol_opponent_posts, pol_opponent_signals — rastreamento de adversários políticos do War Room 2.0, com métricas históricas, coleta de posts e sistema de sinais de alerta por severidade

-- ══════════════════════════════════════════════════════════════════
-- pol_opponents — perfis de oponentes/adversários políticos
--
-- Cadastro de adversários com métricas correntes, nível de ameaça
-- e scoring de risco. Vinculado à organização, não a um contato.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_opponents (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  -- Identificação
  name                    text         not null,
  platform                text         not null
                          check (platform in (
                            'instagram', 'facebook', 'twitter', 'tiktok', 'youtube', 'linkedin', 'website'
                          )),
  username                text,
  bio                     text,
  -- Métricas correntes
  followers               integer      not null default 0,
  engagement_rate         numeric(7,4) not null default 0,
  -- Avaliação de risco
  risk_level              text         not null default 'low'
                          check (risk_level in ('low', 'medium', 'high', 'critical')),
  threat_score            numeric(5,2) not null default 0,
  -- Status
  active                  boolean      not null default true,
  created_at              timestamptz  not null default now(),
  updated_at              timestamptz  not null default now()
);

comment on table public.pol_opponents is
  'Perfis de oponentes/adversários políticos — métricas correntes, nível de risco e scoring de ameaça para monitoramento estratégico.';

-- Índices
create index if not exists pol_opponents_org_risk_idx
  on public.pol_opponents (organization_id, risk_level);

create index if not exists pol_opponents_org_platform_idx
  on public.pol_opponents (organization_id, platform);

create index if not exists pol_opponents_org_active_idx
  on public.pol_opponents (organization_id, active)
  where active = true;

create index if not exists pol_opponents_org_threat_idx
  on public.pol_opponents (organization_id, threat_score)
  where threat_score > 0;

-- Touch updated_at
create or replace trigger pol_opponents_touch
  before update on public.pol_opponents
  for each row execute function public.fn_touch_updated_at();

-- RLS
alter table public.pol_opponents enable row level security;

create policy tenant_isolation_pol_opponents_all
  on public.pol_opponents for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));

-- ══════════════════════════════════════════════════════════════════
-- pol_opponent_snapshots — histórico de métricas de adversários
--
-- Registra métricas periódicas dos oponentes para análise de
-- tendências e detecção de crescimento anômalo.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_opponent_snapshots (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  opponent_id             uuid         not null references public.pol_opponents(id) on delete cascade,
  -- Métricas do snapshot
  followers               integer      not null default 0,
  engagement_rate         numeric(7,4) not null default 0,
  posts_count             integer      not null default 0,
  growth_weekly           numeric(7,4) not null default 0,
  -- Timestamp do registro
  recorded_at             timestamptz  not null default now(),
  created_at              timestamptz  not null default now()
);

comment on table public.pol_opponent_snapshots is
  'Histórico de métricas de adversários — snapshots periódicos para análise de tendências e detecção de crescimento anômalo.';

-- Índices
create index if not exists pol_opponent_snapshots_org_opponent_idx
  on public.pol_opponent_snapshots (organization_id, opponent_id);

create index if not exists pol_opponent_snapshots_recorded_idx
  on public.pol_opponent_snapshots (recorded_at);

create index if not exists pol_opponent_snapshots_opponent_recorded_idx
  on public.pol_opponent_snapshots (opponent_id, recorded_at);

-- RLS
alter table public.pol_opponent_snapshots enable row level security;

create policy tenant_isolation_pol_opponent_snapshots_all
  on public.pol_opponent_snapshots for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));

-- ══════════════════════════════════════════════════════════════════
-- pol_opponent_posts — posts coletados de adversários
--
-- Posts publicados por adversários, coletados automaticamente
-- para análise de narrativa, engajamento e viralidade.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_opponent_posts (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  opponent_id             uuid         not null references public.pol_opponents(id) on delete cascade,
  -- Post
  post_url                text,
  caption                 text,
  -- Métricas
  likes                   integer      not null default 0,
  comments                integer      not null default 0,
  viral_score             numeric(5,2) not null default 0,
  -- Análise de conteúdo
  hashtags                text[],
  mentions                text[],
  -- Timestamps
  collected_at            timestamptz  not null default now(),
  created_at              timestamptz  not null default now()
);

comment on table public.pol_opponent_posts is
  'Posts coletados de adversários políticos — métricas de engajamento, hashtags, menções e viral score para análise estratégica.';

-- Índices
create index if not exists pol_opponent_posts_org_opponent_idx
  on public.pol_opponent_posts (organization_id, opponent_id);

create index if not exists pol_opponent_posts_collected_idx
  on public.pol_opponent_posts (collected_at);

create index if not exists pol_opponent_posts_viral_idx
  on public.pol_opponent_posts (organization_id, viral_score)
  where viral_score > 0;

create index if not exists pol_opponent_posts_hashtags_idx
  on public.pol_opponent_posts using gin (hashtags)
  where hashtags is not null;

-- RLS
alter table public.pol_opponent_posts enable row level security;

create policy tenant_isolation_pol_opponent_posts_all
  on public.pol_opponent_posts for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));

-- ══════════════════════════════════════════════════════════════════
-- pol_opponent_signals — sinais de alerta de adversários
--
-- Sinais detectados por monitoramento automático ou manual:
-- crescimento anômalo, mudança de narrativa, aliança, ataque etc.
-- Severidade de low a critical para priorização.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_opponent_signals (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  opponent_id             uuid         not null references public.pol_opponents(id) on delete cascade,
  -- Sinal
  signal_type             text         not null
                          check (signal_type in (
                            'growth_anomaly', 'narrative_shift', 'alliance', 'attack',
                            'viral_content', 'media_mention', 'event', 'other'
                          )),
  severity                text         not null default 'medium'
                          check (severity in ('low', 'medium', 'high', 'critical')),
  description             text         not null,
  -- Metadados adicionais (flexível)
  metadata                jsonb,
  created_at              timestamptz  not null default now()
);

comment on table public.pol_opponent_signals is
  'Sinais de alerta de adversários — crescimento anômalo, mudança de narrativa, ataques, alianças. Severidade de low a critical.';

-- Índices
create index if not exists pol_opponent_signals_org_opponent_idx
  on public.pol_opponent_signals (organization_id, opponent_id);

create index if not exists pol_opponent_signals_org_severity_idx
  on public.pol_opponent_signals (organization_id, severity);

create index if not exists pol_opponent_signals_org_type_idx
  on public.pol_opponent_signals (organization_id, signal_type);

create index if not exists pol_opponent_signals_created_idx
  on public.pol_opponent_signals (created_at);

-- RLS
alter table public.pol_opponent_signals enable row level security;

create policy tenant_isolation_pol_opponent_signals_all
  on public.pol_opponent_signals for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));
