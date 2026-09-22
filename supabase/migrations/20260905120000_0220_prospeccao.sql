-- ============================================================================
-- 0220 — PROSPECÇÃO DE EMPRESAS (descoberta por região + categoria)
--
-- `prospecting_searches`: uma busca = um job. Parâmetros, grade de células
--   (total/next/processed = checkpoint: continuar da 188, nunca recomeçar),
--   status queued/running/paused/completed/failed/cancelled, estatísticas
--   (encontradas/novas/duplicadas/erros), custo (requests/details/cents) e
--   hash dos parâmetros para cache (TTL configurável, sem reconsultar tudo).
-- `business_prospects`: a empresa descoberta, normalizada. Deduplicação em
--   camadas (ver lib/prospeccao/dedup.ts): unique SÓ em (provider,
--   external_id) — telefone e domínio viram ÍNDICE, nunca unique (matriz e
--   franquia compartilham os dois; unique fundiria lojas distintas).
-- `prospect_search_results`: N:N busca↔prospect com primeira_vez (de onde
--   sai "novas nesta busca" sem comparar coletas).
-- `prospecting_campaigns`: multi-cidades + recorrência (dias; o agendador é
--   fase futura — a coluna guarda a intenção, não finge agendar).
-- `prospecting_settings`: singleton por org. A chave do Google vai CIFRADA
--   (mesma infra fn_encrypt_oauth); o GET nunca a devolve (só `tem_chave`).
--
-- RLS molde 0204: leitura org, escrita agent+ (settings manager+).
-- ============================================================================

create table if not exists public.prospecting_searches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid,

  categorias text[] not null default '{}',
  cidade text,
  estado text,
  pais text not null default 'BR',
  latitude double precision,
  longitude double precision,
  raio_km integer not null default 30,
  max_empresas integer not null default 500,
  provider text not null default 'google_places',

  status text not null default 'queued',

  grid_size_km numeric(6, 2) not null default 5,
  grid_overlap_pct numeric(5, 2) not null default 10,
  total_celulas integer not null default 0,
  celulas_processadas integer not null default 0,

  encontradas integer not null default 0,
  novas integer not null default 0,
  duplicadas integer not null default 0,
  erros integer not null default 0,
  requisicoes integer not null default 0,
  detalhes integer not null default 0,
  custo_estimado_cents integer not null default 0,
  ultimo_erro text,

  search_hash text,

  created_by uuid references auth.users(id) on delete set null,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint prospecting_searches_status_valido check (
    status in ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')
  ),
  constraint prospecting_searches_raio_positivo check (raio_km > 0 and raio_km <= 500),
  constraint prospecting_searches_max_positivo check (max_empresas > 0 and max_empresas <= 10000)
);

create index if not exists prospecting_searches_org_status_idx
  on public.prospecting_searches (organization_id, status, created_at desc);
create index if not exists prospecting_searches_hash_idx
  on public.prospecting_searches (organization_id, search_hash);

alter table public.prospecting_searches enable row level security;

drop policy if exists prospecting_searches_select on public.prospecting_searches;
create policy prospecting_searches_select on public.prospecting_searches
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists prospecting_searches_write on public.prospecting_searches;
create policy prospecting_searches_write on public.prospecting_searches
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

revoke all on public.prospecting_searches from anon;
grant select, insert, update, delete on public.prospecting_searches to authenticated;
grant all on public.prospecting_searches to service_role;

drop trigger if exists trg_prospecting_searches_updated_at on public.prospecting_searches;
create trigger trg_prospecting_searches_updated_at
  before update on public.prospecting_searches
  for each row execute function public.fn_set_updated_at();

-- ─── Prospects ──────────────────────────────────────────────────────────────

create table if not exists public.business_prospects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  nome text not null,
  nome_normalizado text not null,
  categoria text,
  categorias text[] not null default '{}',

  telefone text,
  telefone_normalizado text,
  whatsapp_potencial boolean not null default false,
  website text,
  dominio text,
  email text,

  endereco text,
  logradouro text,
  numero_end text,
  bairro text,
  cidade text,
  estado text,
  cep text,
  pais text not null default 'BR',
  latitude double precision,
  longitude double precision,

  provider text not null,
  external_id text,
  external_url text,

  nota numeric(2, 1),
  total_avaliacoes integer not null default 0,
  horario_funcionamento jsonb,

  status_comercial text not null default 'novo',
  score integer not null default 0,

  -- Vínculo CRM (não duplica cliente: ver §17 do plano).
  contact_id uuid references public.contacts(id) on delete set null,
  lead_id uuid references public.crm_leads(id) on delete set null,

  -- Sugestão de duplicata (revisão humana, nunca merge automático).
  candidato_duplicado_de uuid references public.business_prospects(id) on delete set null,

  -- LGPD/governança (§26): origem, verificação, não-contatar, bloqueio.
  source text,
  source_url text,
  discovered_at timestamptz not null default now(),
  last_verified_at timestamptz,
  do_not_contact boolean not null default false,
  bloqueado boolean not null default false,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint business_prospects_status_valido check (
    status_comercial in ('novo', 'nao_analisado', 'qualificado', 'contato_pendente', 'contatado', 'respondeu', 'sem_interesse', 'cliente', 'descartado')
  ),
  constraint business_prospects_score_faixa check (score >= 0 and score <= 100),
  constraint business_prospects_nota_faixa check (nota is null or (nota >= 0 and nota <= 5))
);

-- Deduplicação nível 1 (§8): provider + id externo é identidade.
create unique index if not exists business_prospects_provider_id_key
  on public.business_prospects (organization_id, provider, external_id)
  where external_id is not null;

-- Níveis 2–5 viram ÍNDICE (não unique): matriz/franquia compartilha telefone
-- e domínio entre lojas distintas — unique fundiria o que não deve.
create index if not exists business_prospects_org_fone_idx
  on public.business_prospects (organization_id, telefone_normalizado)
  where telefone_normalizado is not null;
create index if not exists business_prospects_org_dominio_idx
  on public.business_prospects (organization_id, dominio)
  where dominio is not null;
create index if not exists business_prospects_org_nome_idx
  on public.business_prospects (organization_id, nome_normalizado);
create index if not exists business_prospects_org_cidade_idx
  on public.business_prospects (organization_id, cidade, estado);
create index if not exists business_prospects_org_status_idx
  on public.business_prospects (organization_id, status_comercial);

alter table public.business_prospects enable row level security;

drop policy if exists business_prospects_select on public.business_prospects;
create policy business_prospects_select on public.business_prospects
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists business_prospects_write on public.business_prospects;
create policy business_prospects_write on public.business_prospects
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

revoke all on public.business_prospects from anon;
grant select, insert, update, delete on public.business_prospects to authenticated;
grant all on public.business_prospects to service_role;

drop trigger if exists trg_business_prospects_updated_at on public.business_prospects;
create trigger trg_business_prospects_updated_at
  before update on public.business_prospects
  for each row execute function public.fn_set_updated_at();

-- ─── N:N busca↔prospect ─────────────────────────────────────────────────────

create table if not exists public.prospect_search_results (
  search_id uuid not null references public.prospecting_searches(id) on delete cascade,
  prospect_id uuid not null references public.business_prospects(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  primeira_vez boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (search_id, prospect_id)
);

create index if not exists prospect_search_results_prospect_idx
  on public.prospect_search_results (prospect_id);

alter table public.prospect_search_results enable row level security;

drop policy if exists prospect_search_results_select on public.prospect_search_results;
create policy prospect_search_results_select on public.prospect_search_results
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists prospect_search_results_write on public.prospect_search_results;
create policy prospect_search_results_write on public.prospect_search_results
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

revoke all on public.prospect_search_results from anon;
grant select, insert, update, delete on public.prospect_search_results to authenticated;
grant all on public.prospect_search_results to service_role;

-- ─── Campanhas ──────────────────────────────────────────────────────────────

create table if not exists public.prospecting_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  nome text not null,
  categorias text[] not null default '{}',
  -- [{cidade, estado}] — JSON porque cidade não é entidade (sem ciclo próprio).
  cidades jsonb not null default '[]',
  status text not null default 'rascunho',
  recorrencia_dias integer,
  ultima_execucao_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint prospecting_campaigns_status_valido check (
    status in ('rascunho', 'ativa', 'pausada', 'concluida')
  )
);

alter table public.prospecting_campaigns enable row level security;

drop policy if exists prospecting_campaigns_select on public.prospecting_campaigns;
create policy prospecting_campaigns_select on public.prospecting_campaigns
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists prospecting_campaigns_write on public.prospecting_campaigns;
create policy prospecting_campaigns_write on public.prospecting_campaigns
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

revoke all on public.prospecting_campaigns from anon;
grant select, insert, update, delete on public.prospecting_campaigns to authenticated;
grant all on public.prospecting_campaigns to service_role;

drop trigger if exists trg_prospecting_campaigns_updated_at on public.prospecting_campaigns;
create trigger trg_prospecting_campaigns_updated_at
  before update on public.prospecting_campaigns
  for each row execute function public.fn_set_updated_at();

alter table public.prospecting_searches
  add constraint prospecting_searches_campaign_fk
  foreign key (campaign_id) references public.prospecting_campaigns(id) on delete set null;

-- ─── Settings (singleton por org) ───────────────────────────────────────────

create table if not exists public.prospecting_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  provider_ativo text not null default 'google_places',
  -- Cifrada (mesma infra fn_encrypt_oauth). O GET nunca a devolve.
  google_api_key_encrypted bytea,
  limite_por_busca integer not null default 500,
  limite_diario integer not null default 2000,
  grid_size_km numeric(6, 2) not null default 5,
  raio_padrao_km integer not null default 30,
  concorrencia integer not null default 2,
  retries integer not null default 3,
  timeout_ms integer not null default 15000,
  requisicoes_por_minuto integer not null default 60,
  cache_ttl_dias integer not null default 30,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint prospecting_settings_limites_positivos check (
    limite_por_busca > 0 and limite_diario > 0 and concorrencia > 0 and concorrencia <= 10
  )
);

alter table public.prospecting_settings enable row level security;

drop policy if exists prospecting_settings_select on public.prospecting_settings;
create policy prospecting_settings_select on public.prospecting_settings
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

-- Config é `manager` para cima: chave de API e teto de custo.
drop policy if exists prospecting_settings_write on public.prospecting_settings;
create policy prospecting_settings_write on public.prospecting_settings
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

revoke all on public.prospecting_settings from anon;
grant select, insert, update, delete on public.prospecting_settings to authenticated;
grant all on public.prospecting_settings to service_role;

drop trigger if exists trg_prospecting_settings_updated_at on public.prospecting_settings;
create trigger trg_prospecting_settings_updated_at
  before update on public.prospecting_settings
  for each row execute function public.fn_set_updated_at();

comment on table public.prospecting_settings is
  'Config da prospecção (singleton): provider, limites, grade, ritmo. Chave cifrada; GET devolve só tem_chave.';

comment on table public.prospecting_searches is
  'Uma busca = um job com checkpoint (total/next/processed). Cache por search_hash; custo em requests/details/cents.';
comment on table public.business_prospects is
  'Empresas descobertas e normalizadas. Dedup: unique só em (provider, external_id); telefone/domínio são índice (matriz compartilha). Score é heurística documentada.';
comment on table public.prospecting_campaigns is
  'Multi-cidades + categorias. recorrencia_dias guarda a intenção; o agendador é fase futura.';
