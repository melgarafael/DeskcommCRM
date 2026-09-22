-- ============================================================================
-- 0234 — FILA FISCAL E EVENTOS (emissão assíncrona + timeline)
--
-- `fiscal_jobs`: um pedido de trabalho por nota (emitir). `fiscal_events`:
-- a timeline imutável da nota (criada, enviada, autorizada, rejeitada, erro,
-- retry, cancelada) — o que a tela de detalhe lê; `invoices.*` continua sendo
-- o estado atual, nunca o histórico.
--
-- Por que fila em tabela e não BullMQ/Redis: o projeto já opera assim
-- (prospecção drena `prospecting_searches` pelo cron da VPS). Mesmo molde:
-- claim por UPDATE condicional, backoff exponencial, dead-letter em `erro`
-- após 5 tentativas. Sem worker novo, sem dependência nova no self-host.
--
-- `em_emissao` entra no CHECK de `invoices.status`: é o estado entre "pedido
-- aceito" e "SEFAZ respondeu". Transições válidas vivem em
-- `lib/fiscal/fila.ts` (testadas); o banco só impede lixo com o CHECK.
--
-- RLS molde 0204: leitura org, escrita via service-role (drain) — o cron usa
-- admin client; RLS de sessão para leitura org como nas demais.
-- ============================================================================

alter table public.invoices drop constraint if exists invoices_status_valido;

alter table public.invoices add constraint invoices_status_valido check (
  status in ('pendente', 'em_emissao', 'autorizada', 'denegada', 'cancelada', 'erro')
);

create table if not exists public.fiscal_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  tipo text not null default 'emitir' check (tipo in ('emitir')),
  status text not null default 'pendente'
    check (status in ('pendente', 'processando', 'concluido', 'erro')),
  tentativas integer not null default 0 check (tentativas >= 0),
  max_tentativas integer not null default 5 check (max_tentativas > 0),
  proxima_tentativa timestamptz not null default now(),
  ultimo_erro text,
  idempotency_key text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Um job aberto por nota: retry é re-enfileirar a mesma nota, nunca duplicar
-- trabalho (o emit em si continua idempotente por 1-nota-viva/pedido).
create unique index if not exists fiscal_jobs_nota_aberta_key
  on public.fiscal_jobs (organization_id, invoice_id)
  where status in ('pendente', 'processando');

create index if not exists fiscal_jobs_drain_idx
  on public.fiscal_jobs (status, proxima_tentativa);

create table if not exists public.fiscal_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  tipo text not null check (tipo in ('criada', 'enviada', 'autorizada', 'rejeitada', 'erro', 'retry', 'cancelada')),
  status text,
  protocolo text,
  mensagem text,
  xml text,
  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists fiscal_events_nota_idx
  on public.fiscal_events (organization_id, invoice_id, created_at);

alter table public.fiscal_jobs enable row level security;
alter table public.fiscal_events enable row level security;

drop policy if exists fiscal_jobs_select on public.fiscal_jobs;
create policy fiscal_jobs_select on public.fiscal_jobs
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

-- Escrita agent+: o POST /invoices enfileira com o client de sessão (mesma
-- régua da criação da nota); o drain escreve com service-role.
drop policy if exists fiscal_jobs_insert on public.fiscal_jobs;
create policy fiscal_jobs_insert on public.fiscal_jobs
  for insert with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

drop policy if exists fiscal_events_select on public.fiscal_events;
create policy fiscal_events_select on public.fiscal_events
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

revoke all on public.fiscal_jobs from anon;
grant select on public.fiscal_jobs to authenticated;
grant all on public.fiscal_jobs to service_role;

revoke all on public.fiscal_events from anon;
grant select on public.fiscal_events to authenticated;
grant all on public.fiscal_events to service_role;

comment on table public.fiscal_jobs is
  'Fila de emissão fiscal (dreno pelo cron fiscal-drain). Um job aberto por nota.';
comment on table public.fiscal_events is
  'Timeline imutável da nota (o estado atual mora em invoices.status).';
