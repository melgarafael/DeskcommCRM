-- 0184_estoque_no_catalogo_magento
--
-- O agente de WhatsApp apresentou 4 rendas ao cliente e 2 estavam sem estoque:
-- o `shoppingCartProductAdd` do Magento reprova o lote inteiro e nada entrou no
-- carrinho. `commerce_products` não guardava estoque — a busca não tinha como
-- deixar de oferecer o que a loja não pode vender.
--
-- Aditivo e nulável: NULL = "ainda não sabemos" (linha anterior a esta
-- migration, ou sync de estoque que falhou). A busca trata NULL como disponível
-- (fail-open) — a conferência ao vivo em `present_product` é a trava de verdade;
-- esta coluna é só o filtro barato que evita oferecer o inofertável.
--
-- `qty > 0` NÃO é vendabilidade: a loja de referência devolve linhas com
-- qty=2 e is_in_stock=0. Por isso os dois campos, e a busca filtra por
-- `is_in_stock`, nunca por `qty`.

alter table public.commerce_products
  add column if not exists is_in_stock boolean,
  add column if not exists stock_qty numeric,
  add column if not exists stock_synced_at timestamptz;

comment on column public.commerce_products.is_in_stock is
  'catalogInventoryStockItemList.is_in_stock. NULL = desconhecido (busca trata como disponível; present_product reconfere ao vivo).';
comment on column public.commerce_products.stock_qty is
  'catalogInventoryStockItemList.qty — informativo. NÃO decide vendabilidade: existe qty>0 com is_in_stock=false.';
comment on column public.commerce_products.stock_synced_at is
  'Quando o estoque desta linha foi lido da loja pela última vez.';

-- Filtro da busca: parcial, só o que é ofertável.
create index if not exists commerce_products_in_stock_idx
  on public.commerce_products (organization_id, integration_id)
  where is_in_stock is distinct from false;

notify pgrst, 'reload schema';
