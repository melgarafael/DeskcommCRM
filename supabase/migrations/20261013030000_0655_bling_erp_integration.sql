-- manifest: 0655 infraestrutura e isolamento multi-tenant da integracao opcional com Bling ERP v3
-- Migration 0655: Suporte multi-tenant e RLS para o conector opcional do Bling ERP

create table if not exists public.bling_integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  is_enabled boolean not null default false,
  client_id text,
  client_secret_encrypted text,
  access_token_encrypted text,
  refresh_token_encrypted text,
  token_expires_at timestamptz,
  features jsonb not null default '{
    "sync_contacts": false,
    "sync_products": false,
    "ai_stock_consult": false,
    "auto_create_order": false,
    "invoice_emission": false,
    "tracking_notifications": false,
    "financial_bills": false,
    "ai_fiscal_agent": false
  }'::jsonb,
  status text not null default 'disconnected',
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_bling_integrations_org unique (organization_id)
);

create index if not exists idx_bling_integrations_org
  on public.bling_integrations (organization_id);

alter table public.bling_integrations enable row level security;

drop policy if exists tenant_isolation_bling_integrations_all on public.bling_integrations;
create policy tenant_isolation_bling_integrations_all on public.bling_integrations
  for all using (organization_id in (select fn_user_org_ids()));

-- Tabela de auditoria e logs de sincronização do Bling ERP
create table if not exists public.bling_sync_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  operation text not null,
  direction text not null default 'outbound',
  status text not null,
  details jsonb default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists idx_bling_sync_logs_org_created
  on public.bling_sync_logs (organization_id, created_at desc);

alter table public.bling_sync_logs enable row level security;

drop policy if exists tenant_isolation_bling_sync_logs_all on public.bling_sync_logs;
create policy tenant_isolation_bling_sync_logs_all on public.bling_sync_logs
  for all using (organization_id in (select fn_user_org_ids()));
