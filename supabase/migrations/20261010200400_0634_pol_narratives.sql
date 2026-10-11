-- manifest: tabelas pol_narratives, pol_narrative_signals, pol_generated_content, pol_video_analyses — radar de narrativas, sinais de tendência, Motor Viral de geração de conteúdo IA e análise de vídeo para o War Room 2.0

-- ══════════════════════════════════════════════════════════════════
-- pol_narratives — radar de narrativas ativas
--
-- Consolida narrative_radar + narrative_clusters do WR1.
-- Cada narrativa tem tema, plataforma, sentimento, força e
-- recomendação estratégica. Vinculada à cidade para análise local.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_narratives (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  -- Identificação da narrativa
  theme                   text         not null,
  platform                text
                          check (platform is null or platform in (
                            'instagram', 'facebook', 'twitter', 'tiktok', 'youtube',
                            'linkedin', 'whatsapp', 'news', 'cross_platform'
                          )),
  city                    text,
  -- Métricas de narrativa
  sentiment               text         not null default 'neutral'
                          check (sentiment in ('positive', 'negative', 'neutral', 'mixed')),
  strength                numeric(5,2) not null default 0,
  posts_count             integer      not null default 0,
  reach                   integer      not null default 0,
  engagement_score        numeric(7,2) not null default 0,
  -- Status estratégico
  strategic_status        text         not null default 'monitoring'
                          check (strategic_status in (
                            'monitoring', 'opportunity', 'threat', 'crisis', 'resolved'
                          )),
  recommended_action      text,
  created_at              timestamptz  not null default now(),
  updated_at              timestamptz  not null default now()
);

comment on table public.pol_narratives is
  'Radar de narrativas ativas — consolida narrative_radar e clusters do WR1. Tema, sentimento, força e recomendação estratégica por plataforma e cidade.';

-- Índices
create index if not exists pol_narratives_org_sentiment_idx
  on public.pol_narratives (organization_id, sentiment);

create index if not exists pol_narratives_org_status_idx
  on public.pol_narratives (organization_id, strategic_status);

create index if not exists pol_narratives_org_platform_idx
  on public.pol_narratives (organization_id, platform)
  where platform is not null;

create index if not exists pol_narratives_org_strength_idx
  on public.pol_narratives (organization_id, strength)
  where strength > 0;

create index if not exists pol_narratives_created_idx
  on public.pol_narratives (created_at);

-- Touch updated_at
create or replace trigger pol_narratives_touch
  before update on public.pol_narratives
  for each row execute function public.fn_touch_updated_at();

-- RLS
alter table public.pol_narratives enable row level security;

create policy tenant_isolation_pol_narratives_all
  on public.pol_narratives for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));

-- ══════════════════════════════════════════════════════════════════
-- pol_narrative_signals — sinais de narrativa detectados
--
-- Consolida narrative_signals + narrative_trends +
-- narrative_keywords do WR1 em UMA tabela.
-- Cada sinal vinculado a uma narrativa, com tipo, fonte,
-- conteúdo e severidade.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_narrative_signals (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  narrative_id            uuid         not null references public.pol_narratives(id) on delete cascade,
  -- Sinal
  signal_type             text         not null
                          check (signal_type in (
                            'keyword_spike', 'sentiment_shift', 'new_source',
                            'viral_content', 'influencer_mention', 'media_coverage',
                            'hashtag_trend', 'counter_narrative', 'other'
                          )),
  source                  text,
  content                 text         not null,
  severity                text         not null default 'medium'
                          check (severity in ('low', 'medium', 'high', 'critical')),
  -- Metadados adicionais
  metadata                jsonb,
  created_at              timestamptz  not null default now()
);

comment on table public.pol_narrative_signals is
  'Sinais de narrativa detectados — consolida signals, trends e keywords do WR1. Tipo, fonte, conteúdo e severidade para cada detecção.';

-- Índices
create index if not exists pol_narrative_signals_org_narrative_idx
  on public.pol_narrative_signals (organization_id, narrative_id);

create index if not exists pol_narrative_signals_org_type_idx
  on public.pol_narrative_signals (organization_id, signal_type);

create index if not exists pol_narrative_signals_org_severity_idx
  on public.pol_narrative_signals (organization_id, severity);

create index if not exists pol_narrative_signals_created_idx
  on public.pol_narrative_signals (created_at);

-- RLS
alter table public.pol_narrative_signals enable row level security;

create policy tenant_isolation_pol_narrative_signals_all
  on public.pol_narrative_signals for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));

-- ══════════════════════════════════════════════════════════════════
-- pol_generated_content — conteúdo gerado pelo Motor Viral
--
-- Consolida narrative_scripts do WR1.
-- Armazena conteúdos gerados por IA (scripts de vídeo, captions,
-- roteiros de lives, posts) com scoring de qualidade e viralidade.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_generated_content (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  -- Identificação do conteúdo
  title                   text         not null,
  topic                   text         not null,
  target_audience         text,
  -- Tipo de conteúdo
  content_type            text         not null
                          check (content_type in (
                            'video_script', 'caption', 'carousel', 'story',
                            'reel_script', 'live_script', 'article', 'thread', 'other'
                          )),
  -- Conteúdo gerado
  script                  text,
  caption                 text,
  hashtags                text[],
  cta                     text,
  -- Plataforma alvo
  platform                text
                          check (platform is null or platform in (
                            'instagram', 'facebook', 'twitter', 'tiktok', 'youtube',
                            'linkedin', 'whatsapp', 'cross_platform'
                          )),
  -- Scoring
  viral_score             numeric(5,2) not null default 0,
  quality_score           numeric(5,2) not null default 0,
  -- Origem da geração
  generation_source       text         not null default 'manual'
                          check (generation_source in ('manual', 'ai_auto', 'ai_assisted', 'template')),
  created_at              timestamptz  not null default now(),
  updated_at              timestamptz  not null default now()
);

comment on table public.pol_generated_content is
  'Conteúdo gerado pelo Motor Viral — scripts de vídeo, captions, roteiros de lives e posts com scoring de qualidade e viralidade.';

-- Índices
create index if not exists pol_generated_content_org_type_idx
  on public.pol_generated_content (organization_id, content_type);

create index if not exists pol_generated_content_org_platform_idx
  on public.pol_generated_content (organization_id, platform)
  where platform is not null;

create index if not exists pol_generated_content_org_viral_idx
  on public.pol_generated_content (organization_id, viral_score)
  where viral_score > 0;

create index if not exists pol_generated_content_created_idx
  on public.pol_generated_content (created_at);

-- Touch updated_at
create or replace trigger pol_generated_content_touch
  before update on public.pol_generated_content
  for each row execute function public.fn_touch_updated_at();

-- RLS
alter table public.pol_generated_content enable row level security;

create policy tenant_isolation_pol_generated_content_all
  on public.pol_generated_content for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));

-- ══════════════════════════════════════════════════════════════════
-- pol_video_analyses — análises de vídeo por IA
--
-- Armazena análises detalhadas de vídeos por IA, incluindo
-- momentos-chave, sentimento geral e recomendações.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_video_analyses (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  -- Vídeo analisado
  video_url               text         not null,
  -- Resultado da análise
  analysis                text         not null,
  key_moments             jsonb,
  sentiment               text         not null default 'neutral'
                          check (sentiment in ('positive', 'negative', 'neutral', 'mixed')),
  recommendations         text,
  created_at              timestamptz  not null default now()
);

comment on table public.pol_video_analyses is
  'Análises de vídeo por IA — momentos-chave, sentimento geral e recomendações para cada vídeo analisado.';

-- Índices
create index if not exists pol_video_analyses_org_idx
  on public.pol_video_analyses (organization_id);

create index if not exists pol_video_analyses_sentiment_idx
  on public.pol_video_analyses (organization_id, sentiment);

create index if not exists pol_video_analyses_created_idx
  on public.pol_video_analyses (created_at);

-- RLS
alter table public.pol_video_analyses enable row level security;

create policy tenant_isolation_pol_video_analyses_all
  on public.pol_video_analyses for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));
