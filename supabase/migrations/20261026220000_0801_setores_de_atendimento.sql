-- manifest: **Setores de atendimento.** Duas tabelas novas: `attendant_sectors` (o cadastro de setores da organização — nome único por organização, sem diferenciar maiúsculas, e descrição opcional) e `attendant_sector_members` (cada atendente em no máximo UM setor, chave `(organization_id, user_id)`). FKs compostas com `organization_id` dos dois lados: o setor e o membro têm de ser da MESMA organização, e o banco segura isso. Apagar o setor solta os atendentes dele (eles ficam "sem setor"); apagar a filiação do membro (`user_organizations`) apaga o vínculo; membro revogado some das listas porque elas só leem filiação ativa. RLS: leitura por qualquer membro da organização; `authenticated` não escreve — a escrita é das rotas `/api/v1/attendants/sectors*`, que exigem manager e auditam. Idempotente; apêndice espelhado no `baseline.sql`; `MANIFEST.md` é histórico e não recebe linha.

-- 0801 — setores de atendimento.
--
-- ─── O que entra ───────────────────────────────────────────────────────────
--
--   1. `attendant_sectors`: o setor (Comercial, Suporte, Financeiro…). O nome
--      é único por organização com `lower(btrim(name))` — "Suporte" e
--      "suporte " seriam o mesmo setor para quem lê a tela.
--   2. `attendant_sector_members`: o vínculo atendente → setor. A chave
--      primária `(organization_id, user_id)` é a regra "um setor por
--      atendente": trocar de setor é UPDATE da mesma linha, nunca duas linhas.
--
-- ─── Por que uma tabela de vínculo, e não `sector_id` em outra tabela ──────
--
-- `attendant_availability` deixa o PRÓPRIO atendente escrever a linha dele
-- (RLS own OR manager). Um `sector_id` ali deixaria qualquer atendente se
-- mudar de setor pela REST com a anon key. O vínculo numa tabela própria, sem
-- escrita para `authenticated`, deixa a decisão com quem gerencia.
--
-- ─── Compatibilidade ───────────────────────────────────────────────────────
--
-- Tabelas novas, sem dado legado: os CHECKs não quebram o `update.sh` de
-- clone nenhum. Tudo `if not exists` / `drop ... if exists` — reaplicável.

create table if not exists public.attendant_sectors (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 1 and 60),
  description     text check (description is null or char_length(description) <= 280),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id)
);

create unique index if not exists attendant_sectors_org_name_unique
  on public.attendant_sectors (organization_id, lower(btrim(name)));

-- Sem FK direta para `organizations`: a PK (organization_id, user_id) já cobre a
-- FK para `user_organizations`, e cobrir também uma para `organizations` faz o
-- PostgREST ver esta tabela como junção user_organizations <-> organizations e
-- responder 300 PGRST201 em todo embed sem nome de FK (#3219, o defeito que a
-- 0717 desfez em calendar_service_professionals). A organização continua
-- garantida e em cascata: pela FK para `user_organizations`, que referencia
-- `organizations`, e pela FK para `attendant_sectors`.
create table if not exists public.attendant_sector_members (
  organization_id uuid not null,
  sector_id       uuid not null,
  user_id         uuid not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (organization_id, user_id),
  foreign key (organization_id, sector_id)
    references public.attendant_sectors (organization_id, id) on delete cascade,
  foreign key (organization_id, user_id)
    references public.user_organizations (organization_id, user_id) on delete cascade
);

-- Quem aplicou uma versão anterior desta migration, com a FK direta, perde-a aqui.
alter table public.attendant_sector_members
  drop constraint if exists attendant_sector_members_organization_id_fkey;

create index if not exists attendant_sector_members_sector
  on public.attendant_sector_members (organization_id, sector_id);

alter table public.attendant_sectors enable row level security;
alter table public.attendant_sector_members enable row level security;

revoke all on public.attendant_sectors, public.attendant_sector_members
  from public, anon, authenticated, service_role;
grant select on public.attendant_sectors, public.attendant_sector_members to authenticated;
grant select, insert, update, delete
  on public.attendant_sectors, public.attendant_sector_members to service_role;

drop policy if exists tenant_isolation_attendant_sectors_select on public.attendant_sectors;
create policy tenant_isolation_attendant_sectors_select on public.attendant_sectors
  for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());

drop policy if exists tenant_isolation_attendant_sector_members_select on public.attendant_sector_members;
create policy tenant_isolation_attendant_sector_members_select on public.attendant_sector_members
  for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());

comment on table public.attendant_sectors is
  'Setores de atendimento da organização (migration 0801). Nome único por organização (lower/btrim). Escrita só pelas rotas /api/v1/attendants/sectors (manager+).';
comment on table public.attendant_sector_members is
  'Vínculo atendente → setor (migration 0801). Um setor por atendente: PK (organization_id, user_id). Apagar o setor solta os atendentes.';

notify pgrst, 'reload schema';
