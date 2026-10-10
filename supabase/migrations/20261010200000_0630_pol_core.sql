-- manifest: tabelas pol_leads, pol_lead_scores_history, pol_funnel_transitions — núcleo político do War Room 2.0 sobre o DeskcommCRM, com funil político (novo_cadastro → simpatizante → apoiador → militante → voto_certo), scoring multidimensional e rastreamento de transições

-- ══════════════════════════════════════════════════════════════════
-- pol_leads — extensão política de contacts
--
-- NÃO substitui a tabela contacts do CRM; é uma extensão que agrega
-- dados exclusivamente políticos a um contato existente.
-- O funil político é separado do funil comercial (crm_leads).
-- support_level: novo_cadastro → simpatizante → apoiador → militante → voto_certo
-- temperature: frio → morno → quente
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_leads (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  contact_id              uuid         not null references public.contacts(id) on delete cascade,
  -- Nível de apoio (funil político). Vocabulário controlado por CHECK.
  support_level           text         not null default 'novo_cadastro'
                          check (support_level in (
                            'novo_cadastro', 'simpatizante', 'apoiador', 'militante', 'voto_certo'
                          )),
  political_score         integer      not null default 0,
  -- Temperatura de engajamento
  temperature             text         not null default 'frio'
                          check (temperature in ('frio', 'morno', 'quente')),
  -- Dados eleitorais
  zona_eleitoral          text,
  secao_eleitoral         text,
  -- Mobilizador responsável (referência a outro contato)
  mobilizer_id            uuid         references public.contacts(id) on delete set null,
  leader_potential        boolean      not null default false,
  community_role          text,
  -- Território (FK adicionada na migration 0631)
  territory_id            uuid,
  -- LGPD
  opt_out                 boolean      not null default false,
  consent_origin          text,
  consent_at              timestamptz,
  created_at              timestamptz  not null default now(),
  updated_at              timestamptz  not null default now(),
  -- Um contato por organização
  constraint pol_leads_contact_org_uq unique (contact_id, organization_id)
);

comment on table public.pol_leads is
  'Extensão política de contacts — funil político, scoring, dados eleitorais e mobilização. Um registro por contato por organização.';

-- Índices
create index if not exists pol_leads_org_support_idx
  on public.pol_leads (organization_id, support_level);

create index if not exists pol_leads_org_temp_idx
  on public.pol_leads (organization_id, temperature);

create index if not exists pol_leads_org_territory_idx
  on public.pol_leads (organization_id, territory_id)
  where territory_id is not null;

create index if not exists pol_leads_org_mobilizer_idx
  on public.pol_leads (organization_id, mobilizer_id)
  where mobilizer_id is not null;

create index if not exists pol_leads_contact_idx
  on public.pol_leads (contact_id);

-- Touch updated_at
create or replace trigger pol_leads_touch
  before update on public.pol_leads
  for each row execute function public.fn_touch_updated_at();

-- RLS
alter table public.pol_leads enable row level security;

create policy tenant_isolation_pol_leads_all
  on public.pol_leads for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));

-- ══════════════════════════════════════════════════════════════════
-- pol_lead_scores_history — histórico de scoring multidimensional
--
-- Registra cada mudança de score (político, confiança, mobilização,
-- influência) para auditoria e análise de tendências.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_lead_scores_history (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  contact_id              uuid         not null references public.contacts(id) on delete cascade,
  -- Tipo de score. Vocabulário controlado por CHECK.
  score_type              text         not null
                          check (score_type in (
                            'political', 'trust', 'mobilization', 'influence'
                          )),
  old_value               integer,
  new_value               integer      not null,
  reason                  text,
  changed_by              uuid         references auth.users(id) on delete set null,
  created_at              timestamptz  not null default now()
);

comment on table public.pol_lead_scores_history is
  'Histórico de mudanças de scoring político — cada entrada registra old→new com tipo, razão e autor.';

-- Índices
create index if not exists pol_lead_scores_history_org_contact_idx
  on public.pol_lead_scores_history (organization_id, contact_id);

create index if not exists pol_lead_scores_history_org_type_idx
  on public.pol_lead_scores_history (organization_id, score_type);

create index if not exists pol_lead_scores_history_created_idx
  on public.pol_lead_scores_history (created_at);

-- RLS
alter table public.pol_lead_scores_history enable row level security;

create policy tenant_isolation_pol_lead_scores_history_all
  on public.pol_lead_scores_history for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));

-- ══════════════════════════════════════════════════════════════════
-- pol_funnel_transitions — transições do funil político
--
-- Cada mudança de support_level gera uma linha aqui, rastreando
-- quem fez, por quê, e o timestamp exato. Permite reconstruir
-- a jornada política completa de cada contato.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_funnel_transitions (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  contact_id              uuid         not null references public.contacts(id) on delete cascade,
  from_stage              text         not null,
  to_stage                text         not null,
  changed_by              uuid         references auth.users(id) on delete set null,
  reason                  text,
  created_at              timestamptz  not null default now()
);

comment on table public.pol_funnel_transitions is
  'Histórico de transições do funil político — de qual estágio para qual, com autor e razão. Permite reconstruir jornada completa.';

-- Índices
create index if not exists pol_funnel_transitions_org_contact_idx
  on public.pol_funnel_transitions (organization_id, contact_id);

create index if not exists pol_funnel_transitions_org_to_idx
  on public.pol_funnel_transitions (organization_id, to_stage);

create index if not exists pol_funnel_transitions_created_idx
  on public.pol_funnel_transitions (created_at);

-- RLS
alter table public.pol_funnel_transitions enable row level security;

create policy tenant_isolation_pol_funnel_transitions_all
  on public.pol_funnel_transitions for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));
