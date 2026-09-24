-- 0250 · Catálogo: quais campos aparecem na legenda que vai com a foto.
--
-- ─── O que muda ─────────────────────────────────────────────────────────────
-- A legenda enviada JUNTO com a foto da moto era fixa (ano, cor, km, preço) e
-- derivada de o papel estar mapeado. Agora o dono escolhe, coluna a coluna, o
-- que APARECE no texto (`legenda`) — independente de o motor USAR o dado por
-- dentro (semelhança, disponibilidade).
--
-- `legenda` é o array de PAPÉIS que aparecem na legenda. Default = o
-- comportamento atual (`ano`,`cor`,`km`,`preco`).
--
-- Nenhuma função nova em `public` ⇒ item 9 da doutrina de migrations não acionado.

alter table public.catalog_mappings
  add column if not exists legenda jsonb not null default '[]'::jsonb;

comment on column public.catalog_mappings.legenda is
  'Papéis de coluna que aparecem na legenda enviada com a foto da moto (ex.: ["ano","cor","preco"]). Independente do uso interno do dado (semelhança/disponibilidade). Default: ano, cor, km, preço.';
