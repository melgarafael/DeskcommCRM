-- ============================================================================
-- 0218 — COMPROVANTE DE ENTREGA (ATT.txt F3, controle de entrega)
--
-- `shipment_proofs`: a foto/assinatura da entrega — um registro por pedido
-- (unique em order_id: a última prova vale; reentrega sobrescreve via
-- upsert, e a história de QUEM entregou QUANDO está no audit log).
--
-- Bucket `delivery-proofs` PRIVADO, mesmo molde do `whatsapp-media` (0055):
-- sem policies em storage.objects para anon/authenticated; upload e signed
-- URL só via service role nos endpoints. Teto 10 MB (foto de celular) e só
-- imagem — o Storage compara o header que QUEM SOBE escolhe, então a rota
-- fareja os bytes mágicos antes de aceitar (JPEG/PNG/WebP).
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('delivery-proofs', 'delivery-proofs', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.shipment_proofs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  shipment_id uuid not null references public.shipments(id) on delete cascade,
  order_id uuid not null references public.commercial_orders(id) on delete cascade,

  -- Caminho no bucket (org/order/uuid.ext). Grava-se o CAMINHO, nunca a URL
  -- (DIRC-C, mesmo motivo do logo em 0158): URL assinada vence.
  storage_path text not null,
  observacao text,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint shipment_proofs_path_obrigatorio check (char_length(trim(storage_path)) > 0)
);

-- Um comprovante por pedido: reentrega com foto nova substitui (upsert), e
-- QUEM/QUANDO fica no audit log, não em N linhas.
create unique index if not exists shipment_proofs_order_unico
  on public.shipment_proofs (order_id);

create index if not exists shipment_proofs_carga_idx
  on public.shipment_proofs (shipment_id);

alter table public.shipment_proofs enable row level security;

drop policy if exists shipment_proofs_select on public.shipment_proofs;
create policy shipment_proofs_select on public.shipment_proofs
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists shipment_proofs_write on public.shipment_proofs;
create policy shipment_proofs_write on public.shipment_proofs
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

revoke all on public.shipment_proofs from anon;
grant select, insert, update, delete on public.shipment_proofs to authenticated;
grant all on public.shipment_proofs to service_role;

comment on table public.shipment_proofs is
  'Comprovantes de entrega (foto/assinatura): um por pedido, caminho no bucket delivery-proofs. Reentrega sobrescreve via upsert.';
