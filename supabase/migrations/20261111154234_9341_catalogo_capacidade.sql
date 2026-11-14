-- manifest: catálogo ganha capacidade do produto (opcional, texto livre até 60 caracteres: 128GB, 1TB, 500ml), ligada por empresa em settings.catalogo.capacidade (#3472)
--
-- Coluna opcional, sem default e sem backfill: nenhum produto já cadastrado muda.
-- A tabela é a mesma para todos os nichos, e quem decide se o campo aparece é a
-- empresa (`capacidade_do_produto` em lib/organizacao/capacidades.ts).

alter table public.catalog_products add column if not exists capacidade text;

do $capacidade$
begin
  alter table public.catalog_products drop constraint if exists catalog_products_capacidade_tamanho;
  alter table public.catalog_products
    add constraint catalog_products_capacidade_tamanho
    check (capacidade is null or char_length(capacidade) <= 60);
end
$capacidade$;

comment on column public.catalog_products.capacidade is
  'Capacidade do produto (opcional, texto livre: 128GB, 1TB, 500ml). A empresa liga em settings.catalogo.capacidade.';
