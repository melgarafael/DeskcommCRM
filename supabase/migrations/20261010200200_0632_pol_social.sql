-- manifest: tabelas pol_social_profiles, pol_social_snapshots, pol_social_posts, pol_social_intelligence — monitoramento social do War Room 2.0, consolidando 12+ tabelas do WR1 em 4 tabelas normalizadas com snapshots diários, posts coletados e inteligência IA

-- ══════════════════════════════════════════════════════════════════
-- pol_social_profiles — perfis sociais monitorados
--
-- Consolida monitored_profiles + strategic_accounts do WR1.
-- Cada perfil pertence a uma organização e pode ter múltiplos
-- snapshots diários e posts coletados. category distingue
-- influenciadores de perfis regulares sem tabela separada.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_social_profiles (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  -- Rede social e identificação
  platform                text         not null
                          check (platform in (
                            'instagram', 'facebook', 'twitter', 'tiktok', 'youtube', 'linkedin'
                          )),
  username                text         not null,
  display_name            text,
  bio                     text,
  -- Métricas correntes (snapshot mais recente)
  followers               integer      not null default 0,
  following               integer      not null default 0,
  posts_count             integer      not null default 0,
  engagement_rate         numeric(7,4) not null default 0,
  -- Classificação
  category                text         not null default 'monitorado'
                          check (category in (
                            'monitorado', 'influencer', 'aliado', 'neutro', 'adversario'
                          )),
  -- Status do monitoramento
  active                  boolean      not null default true,
  created_at              timestamptz  not null default now(),
  updated_at              timestamptz  not null default now(),
  -- Um perfil por plataforma+username por organização
  constraint pol_social_profiles_platform_user_org_uq unique (organization_id, platform, username)
);

comment on table public.pol_social_profiles is
  'Perfis sociais monitorados — consolida monitored_profiles e strategic_accounts do WR1. category=influencer substitui tabela separada de influenciadores.';

-- Índices
create index if not exists pol_social_profiles_org_platform_idx
  on public.pol_social_profiles (organization_id, platform);

create index if not exists pol_social_profiles_org_category_idx
  on public.pol_social_profiles (organization_id, category);

create index if not exists pol_social_profiles_org_active_idx
  on public.pol_social_profiles (organization_id, active)
  where active = true;

-- Touch updated_at
create or replace trigger pol_social_profiles_touch
  before update on public.pol_social_profiles
  for each row execute function public.fn_touch_updated_at();

-- RLS
alter table public.pol_social_profiles enable row level security;

create policy tenant_isolation_pol_social_profiles_all
  on public.pol_social_profiles for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));

-- ══════════════════════════════════════════════════════════════════
-- pol_social_snapshots — snapshots diários de métricas
--
-- Consolida profile_daily_snapshots + profile_snapshots +
-- profile_metrics + profile_metrics_cache do WR1 em UMA tabela.
-- Um snapshot por perfil por dia, permitindo análise de crescimento.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_social_snapshots (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  profile_id              uuid         not null references public.pol_social_profiles(id) on delete cascade,
  -- Métricas do snapshot
  followers               integer      not null default 0,
  following               integer      not null default 0,
  posts_count             integer      not null default 0,
  engagement_rate         numeric(7,4) not null default 0,
  growth_daily            numeric(7,4) not null default 0,
  -- Timestamp do registro
  recorded_at             timestamptz  not null default now(),
  created_at              timestamptz  not null default now()
);

comment on table public.pol_social_snapshots is
  'Snapshots diários de métricas de perfis sociais — consolida 4 tabelas do WR1. Um snapshot por perfil por dia para análise de crescimento.';

-- Índices
create index if not exists pol_social_snapshots_org_profile_idx
  on public.pol_social_snapshots (organization_id, profile_id);

create index if not exists pol_social_snapshots_recorded_idx
  on public.pol_social_snapshots (recorded_at);

create index if not exists pol_social_snapshots_profile_recorded_idx
  on public.pol_social_snapshots (profile_id, recorded_at);

-- RLS
alter table public.pol_social_snapshots enable row level security;

create policy tenant_isolation_pol_social_snapshots_all
  on public.pol_social_snapshots for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));

-- ══════════════════════════════════════════════════════════════════
-- pol_social_posts — posts coletados de perfis monitorados
--
-- Consolida instagram_posts + profile_posts_collected do WR1.
-- Cada post vinculado a um perfil monitorado com métricas de
-- engajamento, sentimento e viral score.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_social_posts (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  profile_id              uuid         not null references public.pol_social_profiles(id) on delete cascade,
  -- Identificação do post
  platform                text         not null
                          check (platform in (
                            'instagram', 'facebook', 'twitter', 'tiktok', 'youtube', 'linkedin'
                          )),
  post_url                text,
  caption                 text,
  media_type              text
                          check (media_type is null or media_type in (
                            'image', 'video', 'carousel', 'reel', 'story', 'text'
                          )),
  -- Métricas de engajamento
  likes                   integer      not null default 0,
  comments                integer      not null default 0,
  shares                  integer      not null default 0,
  saves                   integer      not null default 0,
  -- Análise
  viral_score             numeric(5,2) not null default 0,
  sentiment               text
                          check (sentiment is null or sentiment in (
                            'positive', 'negative', 'neutral', 'mixed'
                          )),
  hashtags                text[],
  -- Timestamps
  posted_at               timestamptz,
  collected_at            timestamptz  not null default now(),
  created_at              timestamptz  not null default now()
);

comment on table public.pol_social_posts is
  'Posts coletados de perfis monitorados — consolida instagram_posts e profile_posts_collected do WR1. Métricas de engajamento, sentimento e viral score.';

-- Índices
create index if not exists pol_social_posts_org_profile_idx
  on public.pol_social_posts (organization_id, profile_id);

create index if not exists pol_social_posts_org_platform_idx
  on public.pol_social_posts (organization_id, platform);

create index if not exists pol_social_posts_posted_idx
  on public.pol_social_posts (posted_at)
  where posted_at is not null;

create index if not exists pol_social_posts_viral_idx
  on public.pol_social_posts (organization_id, viral_score)
  where viral_score > 0;

create index if not exists pol_social_posts_hashtags_idx
  on public.pol_social_posts using gin (hashtags)
  where hashtags is not null;

-- RLS
alter table public.pol_social_posts enable row level security;

create policy tenant_isolation_pol_social_posts_all
  on public.pol_social_posts for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));

-- ══════════════════════════════════════════════════════════════════
-- pol_social_intelligence — inteligência IA sobre perfis
--
-- Consolida profile_intelligence do WR1.
-- Armazena análises geradas por IA sobre perfis monitorados,
-- com tipo de análise e nível de confiança.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_social_intelligence (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  profile_id              uuid         not null references public.pol_social_profiles(id) on delete cascade,
  -- Tipo de análise
  analysis_type           text         not null
                          check (analysis_type in (
                            'profile_summary', 'trend_analysis', 'audience_insight',
                            'content_strategy', 'risk_assessment', 'opportunity'
                          )),
  content                 text         not null,
  confidence              numeric(3,2) not null default 0
                          check (confidence >= 0 and confidence <= 1),
  created_at              timestamptz  not null default now()
);

comment on table public.pol_social_intelligence is
  'Inteligência IA sobre perfis sociais — análises geradas (sumário, tendência, audiência, risco, oportunidade) com nível de confiança.';

-- Índices
create index if not exists pol_social_intelligence_org_profile_idx
  on public.pol_social_intelligence (organization_id, profile_id);

create index if not exists pol_social_intelligence_org_type_idx
  on public.pol_social_intelligence (organization_id, analysis_type);

create index if not exists pol_social_intelligence_created_idx
  on public.pol_social_intelligence (created_at);

-- RLS
alter table public.pol_social_intelligence enable row level security;

create policy tenant_isolation_pol_social_intelligence_all
  on public.pol_social_intelligence for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));
