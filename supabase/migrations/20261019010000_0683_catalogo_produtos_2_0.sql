-- manifest: **Catálogo de Produtos 2.0 (preço promocional De/Por, vídeo demonstrativo e exclusão).** Expande o catálogo com suporte a preço original de tabela (`preco_de_cents`) para promoções (De R$ X por R$ Y com cálculo de desconto), suporte a vídeo demonstrativo (`video_url`) e controle completo de ciclo de vida com exclusão de produtos e limpeza automática de mídias associadas.

-- 0683: Catálogo de Produtos 2.0 - preço promocional e vídeo demonstrativo
alter table public.catalog_products
  add column if not exists preco_de_cents bigint
    check (preco_de_cents is null or preco_de_cents >= 0),
  add column if not exists video_url text;

comment on column public.catalog_products.preco_de_cents is
  'Preço original ("De:") em centavos. Quando preenchido e maior que preco_cents ("Por:"), a tela exibe o preço riscado com o percentual de desconto.';

comment on column public.catalog_products.video_url is
  'URL de vídeo demonstrativo do produto (YouTube, Vimeo ou arquivo MP4/WebM no storage) para envio e apresentação ao cliente.';
