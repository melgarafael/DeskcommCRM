-- manifest: **O `gemini-3.5-flash` passa a 150/750 centavos por milhão em `ai_models` e `ai_pricing` (#5090).** O banco carregava 150/900 da 0101, preço que a página oficial do Google nunca teve; o endpoint foi aposentado em 19/05/2026 e todo pedido é roteado ao 3.6 Flash, cuja tarifa de 01/01/2027 é 1,50/7,50 — e é essa que o motor (`pricing.ts`, #4968) já cobra. Mesmo desenho da 0649: uma linha por tabela, tarifa de 2027, promo 75/375 aplicada pelo motor até 2027-01-01T00:00:00Z.
--
-- Estado medido em 22/11/2026, `origin/main` 90dc16fc3c:
--   `ai_models`   ('google', 'gemini-3.5-flash') .......... 150 / 900
--   `ai_pricing`  ('gemini-3.5-flash', 'catálogo 0101') ... 150 / 900
--   `pricing.ts`  'gemini-3.5-flash' ...................... 1,5 / 7,5 USD por milhão
--                                                          (0,75/3,75 na promo)
--
-- A saída 900 é 20% acima do que o Google fatura pelo 3.6 Flash (7,50) e a
-- entrada de 1,50 é o dobro da promo; com o banco em 900, a tela mostra um
-- preço e o orçamento soma outro. O motor está CERTO desde o #4968 — quem
-- diverge é o banco, e é ele que esta migration alinha.
--
-- Fonte: ai.google.dev/gemini-api/docs/pricing e .../docs/models/gemini-3.5-flash
-- (deprecations), lidas em 18/11/2026. Standard, faixa paga, por 1M tokens:
--   até 31/12/2026 ........ entrada 0,75 / saída 3,75 / leitura de cache 0,075
--   a partir de 01/01/2027  entrada 1,50 / saída 7,50 / leitura de cache 0,15
-- UTC: a página não publica fuso; o repo grava instante em ISO-8601 UTC.
--
-- Por que um número só, e não duas linhas: `ai_pricing_pkey` é só `model` (o
-- apêndice da 0068 explica — uma segunda linha futura exigiria trocar a PK e
-- todos os `on conflict (model)`). A coluna guarda a tarifa de 2027; a promo é
-- decisão do motor, aplicada por `PROMOCOES` até 2027-01-01T00:00:00Z.
--
-- Idempotente nas duas tabelas (`on conflict do update`). NÃO mexe no default
-- do Google (segue `gemini-3.5-flash`), nem no preço de nenhum outro modelo,
-- nem em `pricing.ts`. `notes` começa com `catálogo`: o invariante
-- `tests/invariants/catalogo-de-modelos.test.ts` cobra procedência do apêndice e
-- preço IGUAL nas duas tabelas.

-- ---------------------------------------------------------------------------
-- 1. catálogo (o que a tela oferece)
-- ---------------------------------------------------------------------------
insert into public.ai_models
  (provider, model_id, display_name, description,
   input_price_per_million_cents, output_price_per_million_cents, supports_tools)
values
  ('google', 'gemini-3.5-flash', 'Gemini 3.5 Flash',
   'Aposentado em 19/05/2026 e roteado ao 3.6 Flash. Preço de catálogo: tarifa de 01/01/2027 (US$ 1,50/US$ 7,50); o motor cobra a promo até essa data (UTC).',
   150, 750, true)
on conflict (provider, model_id) do update set
  input_price_per_million_cents = excluded.input_price_per_million_cents,
  output_price_per_million_cents = excluded.output_price_per_million_cents,
  supports_tools = excluded.supports_tools,
  deprecated_at = null;

-- ---------------------------------------------------------------------------
-- 2. contabilidade de custo — os MESMOS números (senão o gasto é somado com
--    preço de outro modelo, ou não é somado e some do orçamento).
-- ---------------------------------------------------------------------------
insert into public.ai_pricing
  (model, prompt_cents_per_million_tokens, completion_cents_per_million_tokens, notes)
values
  ('gemini-3.5-flash', 150, 750, 'catálogo 9460 — tarifa de 01/01/2027 UTC; o motor aplica 75/375 até lá')
on conflict (model) do update set
  prompt_cents_per_million_tokens = excluded.prompt_cents_per_million_tokens,
  completion_cents_per_million_tokens = excluded.completion_cents_per_million_tokens,
  notes = excluded.notes,
  superseded_at = null;
