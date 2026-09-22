-- ============================================================================
-- 0231 — ROTEIRIZADOR DE ENTREGAS (Expedição + Leaflet + GPS)
--
-- A carga vira rota de verdade: origem, sequência otimizada, geometria pelas
-- ruas (OSRM) e acompanhamento GPS do motorista — sem entidade paralela de
-- pedidos: a parada continua sendo `shipment_orders` + `commercial_orders`.
--
-- `contacts` (cache de geocodificação): latitude/longitude + geo_status
--   (pendente|ok|nao_encontrado|ambiguo|erro) + geo_em + geo_fonte
--   (nominatim|manual). Geocodifica uma vez, reusa sempre — o mapa não
--   reconsulta a cada abertura.
-- `shipments` (a rota planejada): origem (endereço + coords), retornar_origem,
--   tempo_parada_min, distância/duração planejadas, geometria GeoJSON,
--   rota_versao (conflito operador×motorista: sequência nova invalida a antiga),
--   started/finished (+por quem).
-- `shipment_orders`: 'em_atendimento' (cheguei ≠ entregue) + motivo da
--   devolução + onde/quando entregou (entregue_em/lat/lng).
-- `shipment_positions`: pings de GPS do motorista (só com rota ativa; a rota
--   valida, não o frontend). Histórico da rota = posições + desfechos.
-- ============================================================================

-- ── 1. Cache de geocodificação no contato ────────────────────────────────

alter table public.contacts
  add column if not exists latitude double precision;

alter table public.contacts
  add column if not exists longitude double precision;

alter table public.contacts
  add column if not exists geo_status text not null default 'pendente';

alter table public.contacts
  add column if not exists geo_em timestamptz;

alter table public.contacts
  add column if not exists geo_fonte text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'contacts_geo_status_valido'
  ) then
    alter table public.contacts
      add constraint contacts_geo_status_valido
      check (geo_status in ('pendente', 'ok', 'nao_encontrado', 'ambiguo', 'erro'));
  end if;
end $$;

create index if not exists contacts_org_geo_idx
  on public.contacts (organization_id, geo_status);

comment on column public.contacts.latitude is
  'Cache da geocodificação (roteirizador). NULL = ainda não localizado; nunca ponto inventado.';
comment on column public.contacts.geo_status is
  'pendente|ok|nao_encontrado|ambiguo|erro. Ambíguo/erro pedem correção manual, nunca chute.';
comment on column public.contacts.geo_fonte is
  'nominatim|manual. Manual = operador marcou no mapa.';

-- ── 2. A rota planejada na carga ─────────────────────────────────────────

alter table public.shipments
  add column if not exists origem_endereco text;

alter table public.shipments
  add column if not exists origem_lat double precision;

alter table public.shipments
  add column if not exists origem_lng double precision;

alter table public.shipments
  add column if not exists retornar_origem boolean not null default false;

alter table public.shipments
  add column if not exists tempo_parada_min integer not null default 8;

alter table public.shipments
  add column if not exists distancia_m integer;

alter table public.shipments
  add column if not exists duracao_s integer;

alter table public.shipments
  add column if not exists rota_geojson jsonb;

alter table public.shipments
  add column if not exists rota_em timestamptz;

alter table public.shipments
  add column if not exists rota_versao integer not null default 0;

alter table public.shipments
  add column if not exists started_at timestamptz;

alter table public.shipments
  add column if not exists started_by uuid references auth.users(id) on delete set null;

alter table public.shipments
  add column if not exists finished_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'shipments_tempo_parada_faixa'
  ) then
    alter table public.shipments
      add constraint shipments_tempo_parada_faixa
      check (tempo_parada_min >= 0 and tempo_parada_min <= 120);
  end if;
end $$;

comment on column public.shipments.rota_geojson is
  'Geometria da rota pelas ruas (GeoJSON LineString, [lng,lat]) + resumo. Cache: invalida quando destinos, sequência ou origem mudam.';
comment on column public.shipments.rota_versao is
  'Versão da sequência. O app do motorista aplica a nova só com confirmação — nunca sobrescreve em silêncio.';

-- ── 3. Desfecho por pedido: atendimento, motivo, onde/quando ─────────────

alter table public.shipment_orders
  add column if not exists motivo text;

alter table public.shipment_orders
  add column if not exists entregue_em timestamptz;

alter table public.shipment_orders
  add column if not exists entregue_lat double precision;

alter table public.shipment_orders
  add column if not exists entregue_lng double precision;

alter table public.shipment_orders
  drop constraint if exists shipment_orders_status_valido;

alter table public.shipment_orders
  add constraint shipment_orders_status_valido check (
    status in ('na_carga', 'em_rota', 'em_atendimento', 'entregue', 'devolvido')
  );

comment on column public.shipment_orders.motivo is
  'Motivo da não-entrega (cliente ausente, endereço incorreto, recusado, fechado, problema no pedido, outro).';
comment on column public.shipment_orders.entregue_lat is
  'Onde o motorista marcou a entrega (GPS do aparelho). Chegar perto não marca sozinho: em_atendimento ≠ entregue.';

-- ── 4. Pings de GPS do motorista ─────────────────────────────────────────

create table if not exists public.shipment_positions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  shipment_id uuid not null references public.shipments(id) on delete cascade,

  latitude double precision not null,
  longitude double precision not null,
  precisao_m double precision,

  em timestamptz not null default now(),
  por uuid references auth.users(id) on delete set null,

  constraint shipment_positions_lat_faixa check (latitude >= -90 and latitude <= 90),
  constraint shipment_positions_lng_faixa check (longitude >= -180 and longitude <= 180)
);

create index if not exists shipment_positions_carga_idx
  on public.shipment_positions (shipment_id, em desc);

alter table public.shipment_positions enable row level security;

drop policy if exists shipment_positions_select on public.shipment_positions;
create policy shipment_positions_select on public.shipment_positions
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists shipment_positions_write on public.shipment_positions;
create policy shipment_positions_write on public.shipment_positions
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

revoke all on public.shipment_positions from anon;
grant select, insert, delete on public.shipment_positions to authenticated;
grant all on public.shipment_positions to service_role;

comment on table public.shipment_positions is
  'Rastro GPS da rota ativa (posição do motorista). Só existe com carga em_rota — fora dela o ping é recusado e o rastreio, encerrado.';

-- Realtime para o mapa acompanhar sem polling: idempotente.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'shipment_positions'
  ) then
    execute 'alter publication supabase_realtime add table public.shipment_positions';
  end if;
end $$;
