-- 0428 — CADÊNCIAS DE E-MAIL (sequência por lead)
--
-- ═══ O que nasce aqui ═══
--
-- Três tabelas:
--
--   * `email_cadences` — a cadência que o marketing monta (`manager`+): nome,
--     status, configuração e a ÁRVORE de passos. Configuração e passos são jsonb
--     com schema central em `lib/cadencias/schemas.ts` (Zod) — a tela e o worker
--     leem pelo mesmo schema, nunca por path solto (anti-pattern nº 6).
--   * `email_cadence_enrollments` — o lead DENTRO da cadência. É linha, e não
--     lista em jsonb, porque cada inscrição tem relógio próprio (`proximo_em`),
--     passo próprio e parada própria, e duas rodadas do cron não podem perder
--     uma da outra. `unique (cadence_id, lead_id)`: o mesmo lead não corre duas
--     vezes a mesma cadência; reinscrever reaproveita a linha.
--   * `email_cadence_events` — a linha do tempo (inscrito, enviado, aberto,
--     ramo, parada...). É o que a aba "Atividade" mostra e o que as métricas
--     contam.
--
-- ═══ Quem escreve ═══
--
-- Montar cadência é `manager` (marketing); pôr lead em cadência é `agent`
-- (vendedor). As duas escritas passam pelo servidor com client admin e
-- `organization_id` resolvido do `requireRole()` — `authenticated` só lê, como
-- em `campaigns` (0375).
--
-- ═══ LGPD ═══
--
-- Nenhuma das três tabelas guarda endereço de e-mail, nome ou texto renderizado:
-- o endereço é lido do contato NO ENVIO, e o texto é renderizado na hora. Contato
-- anonimizado fica sem e-mail e a inscrição para por `sem_email` na rodada
-- seguinte — não há coluna para redigir.

create table if not exists public.email_cadences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  status text not null default 'rascunho',
  configuracao jsonb not null default '{}'::jsonb,
  passos jsonb not null default '[]'::jsonb,
  -- Sobe a cada gravação de passos: a inscrição guarda o passo por id, e o
  -- worker confere que o id ainda existe na versão atual.
  versao integer not null default 1,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_cadences_status_check check (status in ('rascunho','ativa','pausada')),
  constraint email_cadences_name_check check (btrim(name) <> ''),
  constraint email_cadences_passos_array check (jsonb_typeof(passos) = 'array'),
  constraint email_cadences_config_object check (jsonb_typeof(configuracao) = 'object')
);

create index if not exists idx_email_cadences_org_status
  on public.email_cadences (organization_id, status, updated_at desc);

comment on table public.email_cadences is
  'Cadência de e-mail (sequência por lead). configuracao/passos seguem o schema de lib/cadencias/schemas.ts.';

create table if not exists public.email_cadence_enrollments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  cadence_id uuid not null references public.email_cadences(id) on delete cascade,
  lead_id uuid not null references public.crm_leads(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  status text not null default 'ativa',
  motivo_parada text,
  origem text not null default 'manual',
  inscrito_por uuid references auth.users(id) on delete set null,
  -- Id do PRÓXIMO passo a executar (null = não há mais passos: conclui).
  passo_atual_id text,
  proximo_em timestamptz not null default now(),
  -- Trava otimista da rodada: quem reivindica a linha grava até quando é dono.
  processando_ate timestamptz,
  ultimo_email_em timestamptz,
  ultimo_email_passo_id text,
  emails_enviados integer not null default 0,
  aberturas integer not null default 0,
  cliques integer not null default 0,
  primeira_abertura_em timestamptz,
  ultima_abertura_em timestamptz,
  ultimo_clique_em timestamptz,
  tentativas integer not null default 0,
  ultimo_erro text,
  concluida_em timestamptz,
  parada_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_cadence_enrollments_status_check check (status in ('ativa','concluida','parada')),
  constraint email_cadence_enrollments_origem_check check (origem in ('manual','tag')),
  constraint email_cadence_enrollments_motivo_check check (
    motivo_parada is null or motivo_parada in (
      'respondeu','bounce','descadastro','ganho_ou_perdido','manual','sem_email','falha'
    )
  ),
  constraint email_cadence_enrollments_parada_consistente check (
    (status = 'parada') = (motivo_parada is not null)
  ),
  constraint email_cadence_enrollments_unica unique (cadence_id, lead_id)
);

-- A pergunta do worker: quais inscrições ativas já venceram.
create index if not exists idx_email_cadence_enrollments_vencidas
  on public.email_cadence_enrollments (proximo_em)
  where status = 'ativa';
create index if not exists idx_email_cadence_enrollments_lead
  on public.email_cadence_enrollments (organization_id, lead_id);
create index if not exists idx_email_cadence_enrollments_cadencia
  on public.email_cadence_enrollments (cadence_id, status, created_at desc);

create table if not exists public.email_cadence_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  cadence_id uuid not null references public.email_cadences(id) on delete cascade,
  enrollment_id uuid not null references public.email_cadence_enrollments(id) on delete cascade,
  lead_id uuid not null references public.crm_leads(id) on delete cascade,
  tipo text not null,
  passo_id text,
  ator_user_id uuid references auth.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint email_cadence_events_tipo_check check (tipo in (
    'inscrito','reinscrito','email_enviado','email_falhou','aberto','clicado',
    'descadastrou','ramo_sim','ramo_nao','tarefa_criada','parada','concluida'
  ))
);

create index if not exists idx_email_cadence_events_cadencia
  on public.email_cadence_events (cadence_id, created_at desc);
create index if not exists idx_email_cadence_events_inscricao
  on public.email_cadence_events (enrollment_id, created_at desc);

-- ═══ RLS ═══
-- SELECT aberto ao tenant; escrita só pelo servidor (service_role), que filtra
-- `organization_id` manualmente a partir de `requireRole()`.
alter table public.email_cadences enable row level security;
alter table public.email_cadence_enrollments enable row level security;
alter table public.email_cadence_events enable row level security;

drop policy if exists email_cadences_select on public.email_cadences;
create policy email_cadences_select on public.email_cadences
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists email_cadence_enrollments_select on public.email_cadence_enrollments;
create policy email_cadence_enrollments_select on public.email_cadence_enrollments
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists email_cadence_events_select on public.email_cadence_events;
create policy email_cadence_events_select on public.email_cadence_events
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

revoke all on public.email_cadences from anon, authenticated;
revoke all on public.email_cadence_enrollments from anon, authenticated;
revoke all on public.email_cadence_events from anon, authenticated;
grant select on public.email_cadences to authenticated;
grant select on public.email_cadence_enrollments to authenticated;
grant select on public.email_cadence_events to authenticated;
grant all on public.email_cadences to service_role;
grant all on public.email_cadence_enrollments to service_role;
grant all on public.email_cadence_events to service_role;
