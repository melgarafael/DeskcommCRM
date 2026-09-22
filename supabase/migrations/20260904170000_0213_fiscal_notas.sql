-- ============================================================================
-- 0213 — FISCAL: CONFIG + NOTAS (ATT.txt Fase 3, Grupo 6)
--
-- `fiscal_settings`: UMA linha por org (singleton por unique em
--   organization_id) — série, natureza de operação, CFOP padrão, documento do
--   emitente. Sem ela, emitir é impossível e a rota diz isso (422 nomeando a
--   tela), em vez de presumir série 1.
--
-- `invoices`: a nota. `numero` ANULÁVEL de propósito: quem numera é a SEFAZ
--   na autorização, não o app na criação — pendente nasce sem número, e o
--   unique parcial (serie, numero) só vale quando há número. Criar pendente
--   com número inventado seria prometer documento que não existe.
--
-- Status (CHECK fechado): pendente → autorizada | denegada | erro;
--   cancelada só de autorizada (com motivo) ou pendente. XML e chave chegam
--   na autorização; o stub (lib/fiscal/provedor.ts) nunca os inventa.
-- ============================================================================

create table if not exists public.fiscal_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  serie text not null default '1',
  natureza_operacao text not null default 'Venda de mercadoria',
  cfop_padrao text not null default '5102',
  emitente_documento text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fiscal_settings_serie_obrigatoria check (char_length(trim(serie)) > 0)
);

alter table public.fiscal_settings enable row level security;

drop policy if exists fiscal_settings_select on public.fiscal_settings;
create policy fiscal_settings_select on public.fiscal_settings
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

-- Config fiscal é `manager` para cima: série e CFOP errados geram nota
-- inválida para a empresa inteira.
drop policy if exists fiscal_settings_write on public.fiscal_settings;
create policy fiscal_settings_write on public.fiscal_settings
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

revoke all on public.fiscal_settings from anon;
grant select, insert, update, delete on public.fiscal_settings to authenticated;
grant all on public.fiscal_settings to service_role;

drop trigger if exists trg_fiscal_settings_updated_at on public.fiscal_settings;
create trigger trg_fiscal_settings_updated_at
  before update on public.fiscal_settings
  for each row execute function public.fn_set_updated_at();

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid references public.commercial_orders(id) on delete set null,

  serie text not null,
  -- NULL até a autorização: quem numera é a SEFAZ, não o app.
  numero integer,
  chave_acesso text,
  xml text,

  status text not null default 'pendente',
  provedor text not null default 'stub',
  erro text,

  total_cents bigint not null,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint invoices_status_valido check (
    status in ('pendente', 'autorizada', 'denegada', 'cancelada', 'erro')
  ),
  constraint invoices_numero_positivo check (numero is null or numero > 0),
  constraint invoices_total_nao_negativo check (total_cents >= 0)
);

create unique index if not exists invoices_org_serie_numero_key
  on public.invoices (organization_id, serie, numero)
  where numero is not null;

create unique index if not exists invoices_chave_unica
  on public.invoices (chave_acesso)
  where chave_acesso is not null;

create index if not exists invoices_org_status_idx
  on public.invoices (organization_id, status, created_at desc);

create index if not exists invoices_org_pedido_idx
  on public.invoices (organization_id, order_id);

alter table public.invoices enable row level security;

drop policy if exists invoices_select on public.invoices;
create policy invoices_select on public.invoices
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists invoices_write on public.invoices;
create policy invoices_write on public.invoices
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

revoke all on public.invoices from anon;
grant select, insert, update, delete on public.invoices to authenticated;
grant all on public.invoices to service_role;

drop trigger if exists trg_invoices_updated_at on public.invoices;
create trigger trg_invoices_updated_at
  before update on public.invoices
  for each row execute function public.fn_set_updated_at();

comment on table public.fiscal_settings is
  'Config fiscal da org (singleton): série, natureza, CFOP, documento do emitente. Sem ela, emitir é 422 nomeando a tela.';
comment on table public.invoices is
  'Notas fiscais. numero NULL até a autorização (quem numera é a SEFAZ). O provedor stub nunca autoriza: pendente é o estado honesto sem emissor.';
comment on column public.invoices.numero is
  'NULL até a autorização. Criar pendente COM número inventado seria prometer documento que não existe.';
