-- ============================================================================
-- 0228 — VITRINE (destaques e promoções do catálogo)
--
-- Três colunas em `catalog_products`, sem tabela nova de propósito: promoção
-- aqui é atributo do produto (preço + validade), não campanha com regras —
-- campanha com regras (cupom, leve-3-pague-2) é outra feature com outro nome.
-- NULL = sem promoção; data ausente = por tempo indeterminado.
-- ============================================================================

alter table public.catalog_products
  add column if not exists destaque boolean not null default false;

alter table public.catalog_products
  add column if not exists preco_promocional_cents bigint;

alter table public.catalog_products
  add column if not exists promocao_ate date;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'catalog_products_promo_nao_negativa'
  ) then
    alter table public.catalog_products
      add constraint catalog_products_promo_nao_negativa
      check (preco_promocional_cents is null or preco_promocional_cents >= 0);
  end if;
end $$;

create index if not exists catalog_products_destaque_idx
  on public.catalog_products (organization_id, destaque)
  where destaque is true;

comment on column public.catalog_products.destaque is
  'Vai para a aba Destaques do catálogo (curadoria manual da loja).';

comment on column public.catalog_products.preco_promocional_cents is
  'Preço da promoção. Vale com promocao_ate nula (indeterminada) ou futura.';

comment on column public.catalog_products.promocao_ate is
  'Último dia da promoção (YYYY-MM-DD, vale o dia inteiro). NULL = indeterminada.';
