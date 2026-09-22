-- ============================================================================
-- 0212 — EXPEDIÇÃO E ROMANEIO (ATT.txt Fase 3, transporte próprio)
--
-- `shipments`: uma carga — veículo (placa/tipo/motorista em linha, sem tabela
--   de frota: frota é entidade com ciclo próprio e hoje ninguém a pede),
--   status do ciclo (montando → em_rota → concluída; cancelada fora da linha).
-- `shipment_orders`: um pedido dentro da carga — sequência de entrega
--   (a rota) + status por pedido (na_carga → em_rota → entregue/devolvido).
--
-- `commercial_orders.endereco_entrega`: o endereço onde ESTE pedido desce.
--   Coluna anulável no pedido (não no contato): o mesmo cliente recebe em
--   endereços diferentes por pedido, e o romaneio imprime o do pedido.
--   Sem ela o romaneio seria lista de nomes sem onde ir.
--
-- Integração com o ciclo do pedido: confirmar entrega avança o pedido para
-- `entregue` (a rota faz, não trigger — trigger escondendo transição de
-- status é o tipo de mágica que ninguém acha depurando).
-- ============================================================================

alter table public.commercial_orders
  add column if not exists endereco_entrega text;

comment on column public.commercial_orders.endereco_entrega is
  'Onde ESTE pedido desce. Por pedido, não por cliente: o mesmo cliente recebe em endereços diferentes. O romaneio imprime este.';

create table if not exists public.shipments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  numero integer not null,

  placa text,
  veiculo_tipo text,
  motorista_nome text,

  status text not null default 'montando',

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint shipments_numero_positivo check (numero > 0),
  constraint shipments_status_valido check (
    status in ('montando', 'em_rota', 'concluida', 'cancelada')
  )
);

-- O número da carga é sequencial por tenant, como o do pedido. Reusa a
-- mecânica atômica (contador próprio): MAX()+1 na rota teria a mesma janela
-- de corrida da 0208.
create table if not exists public.commercial_shipment_counters (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  ultimo_numero integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint commercial_shipment_counters_ultimo_nao_negativo check (ultimo_numero >= 0)
);

alter table public.commercial_shipment_counters enable row level security;

drop policy if exists commercial_shipment_counters_select on public.commercial_shipment_counters;
create policy commercial_shipment_counters_select on public.commercial_shipment_counters
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists commercial_shipment_counters_write on public.commercial_shipment_counters;
create policy commercial_shipment_counters_write on public.commercial_shipment_counters
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

revoke all on public.commercial_shipment_counters from anon;
grant select, insert, update, delete on public.commercial_shipment_counters to authenticated;
grant all on public.commercial_shipment_counters to service_role;

create or replace function public.fn_proximo_numero_carga(p_org uuid)
returns integer
  language plpgsql security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_numero integer;
begin
  if not exists (select 1 from public.fn_user_org_ids() where fn_user_org_ids = p_org)
     and not public.fn_is_platform_admin() then
    raise exception 'carga_numero_org_invalida' using errcode = '42501';
  end if;

  insert into public.commercial_shipment_counters (organization_id, ultimo_numero, updated_at)
  values (p_org, 1, now())
  on conflict (organization_id)
  do update set ultimo_numero = public.commercial_shipment_counters.ultimo_numero + 1,
                updated_at = now()
  returning ultimo_numero into v_numero;

  return v_numero;
end;
$$;

alter function public.fn_proximo_numero_carga(uuid) owner to postgres;

revoke execute on function public.fn_proximo_numero_carga(uuid) from public, anon;
grant execute on function public.fn_proximo_numero_carga(uuid) to authenticated;
grant execute on function public.fn_proximo_numero_carga(uuid) to service_role;

create unique index if not exists shipments_org_numero_key
  on public.shipments (organization_id, numero);

create index if not exists shipments_org_status_idx
  on public.shipments (organization_id, status, created_at desc);

alter table public.shipments enable row level security;

drop policy if exists shipments_select on public.shipments;
create policy shipments_select on public.shipments
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists shipments_write on public.shipments;
create policy shipments_write on public.shipments
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

revoke all on public.shipments from anon;
grant select, insert, update, delete on public.shipments to authenticated;
grant all on public.shipments to service_role;

drop trigger if exists trg_shipments_updated_at on public.shipments;
create trigger trg_shipments_updated_at
  before update on public.shipments
  for each row execute function public.fn_set_updated_at();

create table if not exists public.shipment_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  shipment_id uuid not null references public.shipments(id) on delete cascade,
  order_id uuid not null references public.commercial_orders(id) on delete restrict,

  -- A ordem de entrega (a rota). Base 1, sem buraco obrigatório.
  sequencia integer not null default 1,

  status text not null default 'na_carga',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint shipment_orders_sequencia_positiva check (sequencia > 0),
  constraint shipment_orders_status_valido check (
    status in ('na_carga', 'em_rota', 'entregue', 'devolvido')
  )
);

-- Um pedido, uma carga por vez: sem isto o mesmo pedido entra em dois
-- romaneios e é entregue duas vezes (ou nenhuma, cada motorista achando que
-- é do outro).
create unique index if not exists shipment_orders_order_unico
  on public.shipment_orders (order_id);

create index if not exists shipment_orders_carga_idx
  on public.shipment_orders (shipment_id, sequencia);

alter table public.shipment_orders enable row level security;

drop policy if exists shipment_orders_select on public.shipment_orders;
create policy shipment_orders_select on public.shipment_orders
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists shipment_orders_write on public.shipment_orders;
create policy shipment_orders_write on public.shipment_orders
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

revoke all on public.shipment_orders from anon;
grant select, insert, update, delete on public.shipment_orders to authenticated;
grant all on public.shipment_orders to service_role;

drop trigger if exists trg_shipment_orders_updated_at on public.shipment_orders;
create trigger trg_shipment_orders_updated_at
  before update on public.shipment_orders
  for each row execute function public.fn_set_updated_at();

comment on table public.shipments is
  'Cargas do transporte próprio: veículo + motorista + rota de entregas. O romaneio imprime os pedidos em ordem de sequência.';
comment on table public.shipment_orders is
  'Pedidos dentro da carga, com sequência de entrega e status próprio. Um pedido por vez (unique em order_id): sem isto o mesmo pedido entra em dois romaneios.';
comment on function public.fn_proximo_numero_carga(uuid) is
  'Avança atomicamente o contador de cargas da org. Mesmo molde da fn_proximo_numero_pedido (0209).';
