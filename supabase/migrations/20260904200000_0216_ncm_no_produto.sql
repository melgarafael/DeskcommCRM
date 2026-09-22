-- ============================================================================
-- 0216 — NCM E UNIDADE NO PRODUTO (base fiscal do item)
--
-- A NF-e exige NCM por item: sem ele, o sidecar sped-nfe não tem o que
-- mandar, e a emissão morre em 422 nomeando o produto. Colunas anuláveis —
-- produto sem NCM vende normal no balcão/WhatsApp; só não vira nota até
-- alguém preencher (a rota de emissão lista quais faltam).
--
-- `unidade` (UN, CX, KG…) e `cfop` específico do produto seguem a mesma
-- regra: NULL = vale o padrão (unidade UN, CFOP da config fiscal).
-- ============================================================================

alter table public.catalog_products
  add column if not exists ncm text,
  add column if not exists unidade text,
  add column if not exists cfop text;

alter table public.catalog_products
  drop constraint if exists catalog_products_ncm_formato;

alter table public.catalog_products
  add constraint catalog_products_ncm_formato
  check (ncm is null or ncm ~ '^\d{8}$');

comment on column public.catalog_products.ncm is
  'NCM com 8 dígitos, sem ponto. NULL = vende sem nota até preencher; a emissão lista os produtos sem NCM em vez de presumir.';
comment on column public.catalog_products.unidade is
  'Unidade comercial (UN, CX, KG). NULL = UN.';
comment on column public.catalog_products.cfop is
  'CFOP específico do produto. NULL = o CFOP padrão da config fiscal.';

-- Código IBGE do município do emitente (7 dígitos): a NF-e exige cMunFG, e
-- nome de município não vira código sozinho. NULL = a emissão pede.
alter table public.fiscal_settings
  add column if not exists codigo_municipio text;

comment on column public.fiscal_settings.codigo_municipio is
  'IBGE com 7 dígitos (ex.: 3550308 São Paulo). Exigido na emissão; sem ele, 422 nomeando o campo.';
