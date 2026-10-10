-- 0089 — Atualização self-service pela UI.
--
-- Duas tabelas de INSTÂNCIA (sem organization_id): descrevem o servidor, não o
-- inquilino. Sem policy de RLS de propósito — com RLS habilitada e zero policy,
-- `anon` e `authenticated` não leem nada pelo PostgREST; o acesso passa só pelas
-- rotas /api/v1/system/*, que usam service role e checam is_platform_admin.

create table if not exists public.system_version (
  id                  smallint primary key default 1 check (id = 1),
  current_version     text not null default '',
  current_sha         text not null default '',
  off_release         boolean not null default false,
  latest_version      text not null default '',
  changelog_raw       text not null default '',
  agent_last_seen_at  timestamptz,
  update_requested_at timestamptz,
  update_requested_by uuid references auth.users(id) on delete set null,
  updated_at          timestamptz not null default now()
);

comment on table public.system_version is
  'Singleton: versão instalada e disponível desta instância. Escrito pelo agente do host.';

insert into public.system_version (id) values (1) on conflict (id) do nothing;

create table if not exists public.system_update_runs (
  id            uuid primary key default gen_random_uuid(),
  from_version  text not null default '',
  to_version    text not null default '',
  status        text not null default 'dispatched'
                check (status in ('dispatched','success','failed','failed_rolled_back')),
  last_step     text check (last_step in ('backup','codigo','banco')),
  requested_by  uuid references auth.users(id) on delete set null,
  dispatched_at timestamptz not null default now(),
  finished_at   timestamptz,
  log_tail      text not null default ''
);

comment on table public.system_update_runs is
  'Histórico append de atualizações disparadas pela UI. status/last_step espelham RunStatus/RunStep em lib/system/update-run.ts.';

create index if not exists idx_system_update_runs_dispatched
  on public.system_update_runs (dispatched_at desc);

alter table public.system_version    enable row level security;
alter table public.system_update_runs enable row level security;
