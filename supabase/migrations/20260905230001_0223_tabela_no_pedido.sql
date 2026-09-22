-- ============================================================================
-- 0223 — TABELA USADA NO PEDIDO (filtro e auditoria da lista refeita)
--
-- O POST aceitava `price_table_id` mas não persistia: o preço aplicado
-- ficava sem rastro de QUAL tabela o gerou, e a lista não filtrava por
-- tabela. FK anulável com `set null` (apagar tabela não apaga venda).
-- ============================================================================

alter table public.commercial_orders
  add column if not exists price_table_id uuid references public.price_tables(id) on delete set null;

create index if not exists commercial_orders_tabela_idx
  on public.commercial_orders (organization_id, price_table_id);

comment on column public.commercial_orders.price_table_id is
  'Tabela que gerou os preços (NULL = preço base/negociado). Auditoria do preço, não só do valor.';
