-- manifest: **A chave de mapas da organização (`map_provider_credentials`).** Com uma chave da Geocoding API do Google, o pino de localização do WhatsApp — que chegava só com coordenadas (medido: 10 de 10 pinos do mês) — ganha rua, cidade e região aproximados (bairro e número não saem: medidos pouco confiáveis), e o agente deixa de perguntar a cidade. Opcional: sem chave, nada muda. Server-side only como a 0214: RLS ligada sem policies, grants revogados de anon/authenticated, chave cifrada por `fn_encrypt_oauth` e só os 4 últimos caracteres na tela.
-- 0504 — A chave de MAPAS da organização (geocodificação reversa do pino).
--
-- Medido numa loja que vende pelo WhatsApp (28/09/2026): 10 de 47 conversas do
-- mês tiveram pino de localização, e os 10 chegaram só com coordenadas. O agente
-- lia um link e não sabia em que cidade o cliente estava. Com uma chave da
-- Geocoding API do Google, o pino ganha rua, cidade e região aproximados
-- (`lib/mapas/`). Opcional: sem linha aqui, nada muda.
--
-- Server-side only, como `ad_insights_connections` (0214): RLS ligada, zero
-- policies, grants revogados de anon/authenticated. A chave nunca volta ao
-- browser — a tela vê os 4 últimos caracteres.
--
-- Nenhuma função nova em `public` ⇒ o item 9 da doutrina de migrations não é
-- acionado por este arquivo.

create table if not exists public.map_provider_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null default 'google_maps',
  api_key_encrypted bytea not null,
  -- Para a tela reconhecer QUAL chave está gravada sem ver a chave.
  api_key_last4 text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint map_provider_credentials_provider_conhecido
    check (provider in ('google_maps'))
);

-- Uma chave por provedor por organização: trocar é gravar de novo (upsert).
create unique index if not exists map_provider_credentials_org_provider_uk
  on public.map_provider_credentials (organization_id, provider);

comment on table public.map_provider_credentials is
  'Chave de mapas da organização (hoje: Google Geocoding API), usada para transformar o pino de localização do WhatsApp em rua/cidade/região aproximados. Opcional. Server-side only: RLS ligada sem policies e grants revogados de anon/authenticated. A chave nunca volta ao browser.';
comment on column public.map_provider_credentials.api_key_encrypted is
  'Cifrado por fn_encrypt_oauth (pgp_sym/aes256), a mesma cifra de channel_sessions e ad_platform_connections.';

alter table public.map_provider_credentials enable row level security;
revoke all on public.map_provider_credentials from anon, authenticated;
grant select, insert, update, delete on public.map_provider_credentials to service_role;

drop trigger if exists trg_map_provider_credentials_updated_at on public.map_provider_credentials;
create trigger trg_map_provider_credentials_updated_at
  before update on public.map_provider_credentials
  for each row execute function public.fn_set_updated_at();
