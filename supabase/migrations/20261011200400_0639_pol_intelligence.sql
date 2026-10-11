-- manifest: tabelas pol_decision_signals, pol_alerts, pol_crisis_predictions, pol_fake_news, pol_engagement_weights — inteligência e alertas do War Room 2.0, consolidando motor de decisão, alertas unificados, predições de crise, fake news e pesos de engajamento

-- ══════════════════════════════════════════════════════════════════
-- pol_decision_signals — sinais para o motor de decisão
--
-- Consolida decision_signals do WR1.
-- Cada sinal representa um dado de entrada para decisões
-- automatizadas: pesquisas, redes sociais, denúncias, etc.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_decision_signals (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  -- Tipo e fonte do sinal
  signal_type             text         not null
                          check (signal_type in (
                            'survey_result', 'social_mention', 'sentiment_shift',
                            'territory_change', 'opponent_action', 'media_coverage',
                            'engagement_spike', 'crisis_indicator', 'other'
                          )),
  source                  text         not null,
  -- Entidade referenciada (polimórfico)
  entity_type             text,
  entity_id               uuid,
  -- Severidade e payload
  severity                text         not null default 'info'
                          check (severity in (
                            'info', 'low', 'medium', 'high', 'critical'
                          )),
  data                    jsonb        not null default '{}'::jsonb,
  -- Processamento
  processed_at            timestamptz,
  action_taken            text,
  created_at              timestamptz  not null default now()
);

comment on table public.pol_decision_signals is
  'Sinais para o motor de decisão — entradas de pesquisas, redes sociais, sentimento, territórios e adversários com severidade e processamento.';

-- Índices
create index if not exists pol_decision_signals_org_type_idx
  on public.pol_decision_signals (organization_id, signal_type);

create index if not exists pol_decision_signals_org_severity_idx
  on public.pol_decision_signals (organization_id, severity);

create index if not exists pol_decision_signals_org_unprocessed_idx
  on public.pol_decision_signals (organization_id, created_at)
  where processed_at is null;

create index if not exists pol_decision_signals_entity_idx
  on public.pol_decision_signals (entity_type, entity_id)
  where entity_id is not null;

create index if not exists pol_decision_signals_created_idx
  on public.pol_decision_signals (created_at);

-- RLS
alter table public.pol_decision_signals enable row level security;

create policy tenant_isolation_pol_decision_signals_all
  on public.pol_decision_signals for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));

-- ══════════════════════════════════════════════════════════════════
-- pol_alerts — sistema unificado de alertas
--
-- Consolida 6 tabelas de alertas do WR1 (alerts, digital_alerts,
-- monitoring_alerts, growth_alerts, momentum_alerts + outros).
-- Cada alerta tem tipo, severidade, fonte polimórfica e status
-- com reconhecimento por operador.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_alerts (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  -- Tipo e severidade
  alert_type              text         not null
                          check (alert_type in (
                            'sentiment', 'engagement', 'crisis', 'opponent',
                            'territory', 'fake_news', 'growth', 'momentum',
                            'media', 'survey', 'custom'
                          )),
  severity                text         not null default 'medium'
                          check (severity in (
                            'info', 'low', 'medium', 'high', 'critical'
                          )),
  -- Fonte polimórfica
  source_type             text,
  source_id               uuid,
  -- Conteúdo
  title                   text         not null,
  description             text,
  -- Status e reconhecimento
  status                  text         not null default 'open'
                          check (status in (
                            'open', 'acknowledged', 'investigating',
                            'resolved', 'dismissed'
                          )),
  acknowledged_by         uuid         references auth.users(id),
  acknowledged_at         timestamptz,
  created_at              timestamptz  not null default now(),
  updated_at              timestamptz  not null default now()
);

comment on table public.pol_alerts is
  'Sistema unificado de alertas — consolida 6 tabelas do WR1. Tipo, severidade, fonte polimórfica e status com reconhecimento.';

-- Índices
create index if not exists pol_alerts_org_status_idx
  on public.pol_alerts (organization_id, status);

create index if not exists pol_alerts_org_type_idx
  on public.pol_alerts (organization_id, alert_type);

create index if not exists pol_alerts_org_severity_idx
  on public.pol_alerts (organization_id, severity);

create index if not exists pol_alerts_org_open_idx
  on public.pol_alerts (organization_id, created_at)
  where status = 'open';

create index if not exists pol_alerts_source_idx
  on public.pol_alerts (source_type, source_id)
  where source_id is not null;

create index if not exists pol_alerts_created_idx
  on public.pol_alerts (created_at);

-- Touch updated_at
create or replace trigger pol_alerts_touch
  before update on public.pol_alerts
  for each row execute function public.fn_touch_updated_at();

-- RLS
alter table public.pol_alerts enable row level security;

create policy tenant_isolation_pol_alerts_all
  on public.pol_alerts for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));

-- ══════════════════════════════════════════════════════════════════
-- pol_crisis_predictions — predições de crise por IA
--
-- Consolida crisis_predictions do WR1.
-- Cada predição tem tipo, probabilidade, impacto, descrição,
-- ações recomendadas e expiração.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_crisis_predictions (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  -- Tipo e métricas
  prediction_type         text         not null
                          check (prediction_type in (
                            'reputation', 'electoral', 'media', 'social',
                            'legal', 'political', 'security', 'other'
                          )),
  probability             numeric(5,2) not null default 0
                          check (probability >= 0 and probability <= 100),
  impact                  text         not null default 'medium'
                          check (impact in (
                            'negligible', 'low', 'medium', 'high', 'catastrophic'
                          )),
  -- Descrição e ações
  description             text         not null,
  recommended_actions     jsonb,
  -- Payload extra
  metadata                jsonb,
  -- Vigência
  expires_at              timestamptz,
  created_at              timestamptz  not null default now(),
  updated_at              timestamptz  not null default now()
);

comment on table public.pol_crisis_predictions is
  'Predições de crise por IA — tipo, probabilidade, impacto e ações recomendadas com expiração.';

-- Índices
create index if not exists pol_crisis_predictions_org_type_idx
  on public.pol_crisis_predictions (organization_id, prediction_type);

create index if not exists pol_crisis_predictions_org_impact_idx
  on public.pol_crisis_predictions (organization_id, impact);

create index if not exists pol_crisis_predictions_org_active_idx
  on public.pol_crisis_predictions (organization_id, expires_at)
  where expires_at is null or expires_at > now();

create index if not exists pol_crisis_predictions_created_idx
  on public.pol_crisis_predictions (created_at);

-- Touch updated_at
create or replace trigger pol_crisis_predictions_touch
  before update on public.pol_crisis_predictions
  for each row execute function public.fn_touch_updated_at();

-- RLS
alter table public.pol_crisis_predictions enable row level security;

create policy tenant_isolation_pol_crisis_predictions_all
  on public.pol_crisis_predictions for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));

-- ══════════════════════════════════════════════════════════════════
-- pol_fake_news — registro de fake news detectadas
--
-- Consolida fake_news_cases do WR1.
-- Cada caso tem título, fonte, plataforma, severidade,
-- status de resposta e contra-narrativa preparada.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_fake_news (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  -- Identificação
  title                   text         not null,
  description             text,
  -- Fonte e plataforma
  source_url              text,
  platform                text
                          check (platform is null or platform in (
                            'whatsapp', 'facebook', 'instagram', 'twitter',
                            'tiktok', 'youtube', 'telegram', 'website',
                            'radio', 'tv', 'print', 'other'
                          )),
  -- Status e severidade
  status                  text         not null default 'detected'
                          check (status in (
                            'detected', 'analyzing', 'confirmed',
                            'responding', 'contained', 'resolved'
                          )),
  severity                text         not null default 'medium'
                          check (severity in (
                            'low', 'medium', 'high', 'critical'
                          )),
  -- Contra-narrativa
  counter_narrative       text,
  created_at              timestamptz  not null default now(),
  updated_at              timestamptz  not null default now()
);

comment on table public.pol_fake_news is
  'Registro de fake news — casos detectados com fonte, plataforma, severidade, status de resposta e contra-narrativa.';

-- Índices
create index if not exists pol_fake_news_org_status_idx
  on public.pol_fake_news (organization_id, status);

create index if not exists pol_fake_news_org_severity_idx
  on public.pol_fake_news (organization_id, severity);

create index if not exists pol_fake_news_org_platform_idx
  on public.pol_fake_news (organization_id, platform)
  where platform is not null;

create index if not exists pol_fake_news_created_idx
  on public.pol_fake_news (created_at);

-- Touch updated_at
create or replace trigger pol_fake_news_touch
  before update on public.pol_fake_news
  for each row execute function public.fn_touch_updated_at();

-- RLS
alter table public.pol_fake_news enable row level security;

create policy tenant_isolation_pol_fake_news_all
  on public.pol_fake_news for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));

-- ══════════════════════════════════════════════════════════════════
-- pol_engagement_weights — pesos de tipos de engajamento
--
-- Consolida engagement_event_weights do WR1.
-- Tabela simples: tipo de evento → peso numérico para scoring.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_engagement_weights (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  -- Tipo e peso
  event_type              text         not null,
  weight                  numeric(5,2) not null default 1.0,
  created_at              timestamptz  not null default now(),
  updated_at              timestamptz  not null default now(),
  -- Um peso por tipo de evento por organização
  constraint pol_engagement_weights_type_org_uq unique (organization_id, event_type)
);

comment on table public.pol_engagement_weights is
  'Pesos de engajamento — peso numérico por tipo de evento para scoring de contatos.';

-- Índices
create index if not exists pol_engagement_weights_org_idx
  on public.pol_engagement_weights (organization_id);

-- Touch updated_at
create or replace trigger pol_engagement_weights_touch
  before update on public.pol_engagement_weights
  for each row execute function public.fn_touch_updated_at();

-- RLS
alter table public.pol_engagement_weights enable row level security;

create policy tenant_isolation_pol_engagement_weights_all
  on public.pol_engagement_weights for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));
