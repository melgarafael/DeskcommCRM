-- manifest: tabelas pol_invisible_funnel, pol_invisible_funnel_content, pol_invisible_funnel_events — funil invisível do War Room 2.0 para nurturing automático de contatos com scoring de afinidade, rastreamento de eventos e conteúdo com métricas de conversão

-- ══════════════════════════════════════════════════════════════════
-- pol_invisible_funnel — perfis no funil invisível
--
-- Consolida invisible_funnel_profiles do WR1.
-- Cada contato tem um perfil no funil invisível com stage,
-- score, afinidade temática, classe de interação e métricas
-- de engajamento acumulado.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_invisible_funnel (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  contact_id              uuid         not null references public.contacts(id) on delete cascade,
  -- Posição no funil
  funnel_stage            text         not null default 'awareness'
                          check (funnel_stage in (
                            'awareness', 'interest', 'consideration',
                            'intent', 'evaluation', 'conversion'
                          )),
  funnel_score            numeric(5,2) not null default 0,
  -- Afinidade temática
  theme_affinity          text,
  -- Classificação de interação
  interaction_class       text         not null default 'cold'
                          check (interaction_class in (
                            'cold', 'warm', 'hot', 'engaged', 'advocate'
                          )),
  -- Métricas acumuladas
  total_clicks            integer      not null default 0,
  total_replies           integer      not null default 0,
  contents_received       integer      not null default 0,
  consecutive_weeks_active integer     not null default 0,
  -- Próxima ação recomendada
  next_action             text,
  created_at              timestamptz  not null default now(),
  updated_at              timestamptz  not null default now(),
  -- Um perfil por contato por organização
  constraint pol_invisible_funnel_contact_org_uq unique (organization_id, contact_id)
);

comment on table public.pol_invisible_funnel is
  'Perfis no funil invisível — nurturing automático com stage, score de afinidade, classe de interação e métricas de engajamento acumulado.';

-- Índices
create index if not exists pol_invisible_funnel_org_stage_idx
  on public.pol_invisible_funnel (organization_id, funnel_stage);

create index if not exists pol_invisible_funnel_org_class_idx
  on public.pol_invisible_funnel (organization_id, interaction_class);

create index if not exists pol_invisible_funnel_contact_idx
  on public.pol_invisible_funnel (contact_id);

create index if not exists pol_invisible_funnel_org_score_idx
  on public.pol_invisible_funnel (organization_id, funnel_score)
  where funnel_score > 0;

-- Touch updated_at
create or replace trigger pol_invisible_funnel_touch
  before update on public.pol_invisible_funnel
  for each row execute function public.fn_touch_updated_at();

-- RLS
alter table public.pol_invisible_funnel enable row level security;

create policy tenant_isolation_pol_invisible_funnel_all
  on public.pol_invisible_funnel for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));

-- ══════════════════════════════════════════════════════════════════
-- pol_invisible_funnel_content — conteúdo do funil invisível
--
-- Consolida invisible_funnel_content do WR1.
-- Peças de conteúdo que alimentam o funil: textos, vídeos, links
-- com tema, stage alvo, formato e métricas de performance.
-- DEVE ser criada ANTES de pol_invisible_funnel_events (FK).
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_invisible_funnel_content (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  -- Identificação do conteúdo
  title                   text         not null,
  theme                   text,
  -- Stage alvo
  stage                   text         not null default 'awareness'
                          check (stage in (
                            'awareness', 'interest', 'consideration',
                            'intent', 'evaluation', 'conversion'
                          )),
  -- Formato e conteúdo
  format                  text         not null default 'text'
                          check (format in (
                            'text', 'image', 'video', 'link', 'carousel',
                            'audio', 'document', 'other'
                          )),
  url                     text,
  cta                     text,
  body                    text,
  -- Métricas de performance
  sends                   integer      not null default 0,
  clicks                  integer      not null default 0,
  replies                 integer      not null default 0,
  conversion_rate         numeric(5,2) not null default 0,
  -- Status
  active                  boolean      not null default true,
  created_at              timestamptz  not null default now(),
  updated_at              timestamptz  not null default now()
);

comment on table public.pol_invisible_funnel_content is
  'Conteúdo do funil invisível — peças de nurturing com tema, stage alvo, formato e métricas de conversão.';

-- Índices
create index if not exists pol_invisible_funnel_content_org_stage_idx
  on public.pol_invisible_funnel_content (organization_id, stage);

create index if not exists pol_invisible_funnel_content_org_format_idx
  on public.pol_invisible_funnel_content (organization_id, format);

create index if not exists pol_invisible_funnel_content_org_active_idx
  on public.pol_invisible_funnel_content (organization_id, active)
  where active = true;

create index if not exists pol_invisible_funnel_content_org_conversion_idx
  on public.pol_invisible_funnel_content (organization_id, conversion_rate)
  where conversion_rate > 0;

-- Touch updated_at
create or replace trigger pol_invisible_funnel_content_touch
  before update on public.pol_invisible_funnel_content
  for each row execute function public.fn_touch_updated_at();

-- RLS
alter table public.pol_invisible_funnel_content enable row level security;

create policy tenant_isolation_pol_invisible_funnel_content_all
  on public.pol_invisible_funnel_content for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));

-- ══════════════════════════════════════════════════════════════════
-- pol_invisible_funnel_events — eventos rastreados do funil
--
-- Consolida invisible_funnel_events do WR1.
-- Cada evento registra uma interação do contato com conteúdo
-- do funil: clique, resposta, abertura, compartilhamento etc.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_invisible_funnel_events (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  contact_id              uuid         not null references public.contacts(id) on delete cascade,
  -- Evento
  event_type              text         not null
                          check (event_type in (
                            'content_sent', 'content_opened', 'link_clicked',
                            'reply_received', 'shared', 'unsubscribed',
                            'stage_changed', 'score_updated', 'other'
                          )),
  content_id              uuid         references public.pol_invisible_funnel_content(id) on delete set null,
  -- Metadados do evento
  metadata                jsonb,
  created_at              timestamptz  not null default now()
);

comment on table public.pol_invisible_funnel_events is
  'Eventos rastreados do funil invisível — cliques, respostas, aberturas e mudanças de stage por contato.';

-- Índices
create index if not exists pol_invisible_funnel_events_org_contact_idx
  on public.pol_invisible_funnel_events (organization_id, contact_id);

create index if not exists pol_invisible_funnel_events_org_type_idx
  on public.pol_invisible_funnel_events (organization_id, event_type);

create index if not exists pol_invisible_funnel_events_content_idx
  on public.pol_invisible_funnel_events (content_id)
  where content_id is not null;

create index if not exists pol_invisible_funnel_events_created_idx
  on public.pol_invisible_funnel_events (created_at);

-- RLS
alter table public.pol_invisible_funnel_events enable row level security;

create policy tenant_isolation_pol_invisible_funnel_events_all
  on public.pol_invisible_funnel_events for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));
