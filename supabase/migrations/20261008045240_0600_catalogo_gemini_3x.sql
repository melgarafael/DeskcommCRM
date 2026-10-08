-- manifest: adiciona ao catálogo os Gemini 3.x que o Google já serve (3.1 Flash-Lite,
-- 3.6/3.7/3.8 Flash) em ai_models + ai_pricing, para aparecerem no
-- seletor de modelo do agente e serem contabilizados no orçamento.
--
-- Preços (centavos por milhão de tokens, input/output), fonte: documentação de
-- pricing do Gemini (ai.google.dev/gemini-api/docs/pricing), consultada 2026-10-07:
--   gemini-3.1-flash-lite .......  25 / 150   ($0.25 / $1.50)
--   gemini-3.6-flash ............  75 / 375   ($0.75 / $3.75; promo até 31/12/2026)
--   gemini-3.7-flash ............  75 / 375   (promo até 31/12/2026)
--   gemini-3.8-flash ............  75 / 375   (promo até 31/12/2026)
-- Em 01/01/2027 o 3.6/3.7/3.8 Flash passa a $1.50 / $7.50 (150 / 750).
-- O gemini-3.5-flash-lite entra pela migration do #2453, com o preço oficial.
--
-- NÃO mexe no default do Google (segue gemini-3.5-flash). Idempotente nas duas
-- tabelas (on conflict do update). O invariante tests/invariants/catalogo-de-modelos.ts
-- exige preço IGUAL nos dois lados e notes começando com 'catálogo'.
-- supports_tools = true: senão o modelo não aparece no ModelPicker do agente.

-- ---------------------------------------------------------------------------
-- 1. catálogo (o que a tela oferece)
-- ---------------------------------------------------------------------------
insert into public.ai_models
  (provider, model_id, display_name, description,
   input_price_per_million_cents, output_price_per_million_cents, supports_tools)
values
  ('google', 'gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite',
   'Barato e rápido da linha 3.1.', 25, 150, true),
  ('google', 'gemini-3.6-flash', 'Gemini 3.6 Flash', null, 75, 375, true),
  ('google', 'gemini-3.7-flash', 'Gemini 3.7 Flash', null, 75, 375, true),
  ('google', 'gemini-3.8-flash', 'Gemini 3.8 Flash',
   'Preço promocional de introdução ($0,75/$3,75) até 31/12/2026.', 75, 375, true)
on conflict (provider, model_id) do update set
  display_name = excluded.display_name,
  description = excluded.description,
  input_price_per_million_cents = excluded.input_price_per_million_cents,
  output_price_per_million_cents = excluded.output_price_per_million_cents,
  supports_tools = excluded.supports_tools,
  deprecated_at = null;

-- ---------------------------------------------------------------------------
-- 2. contabilidade de custo — a MESMA lista, mesmos números (senão o gasto é
--    somado com preço de outro modelo, ou não é somado e some do orçamento).
-- ---------------------------------------------------------------------------
insert into public.ai_pricing
  (model, prompt_cents_per_million_tokens, completion_cents_per_million_tokens, notes)
values
  ('gemini-3.1-flash-lite', 25, 150, 'catálogo 0600'),
  ('gemini-3.6-flash',      75, 375, 'catálogo 0600 — promo até 31/12/2026'),
  ('gemini-3.7-flash',      75, 375, 'catálogo 0600 — promo até 31/12/2026'),
  ('gemini-3.8-flash',      75, 375, 'catálogo 0600 — promo até 31/12/2026')
on conflict (model) do update set
  prompt_cents_per_million_tokens = excluded.prompt_cents_per_million_tokens,
  completion_cents_per_million_tokens = excluded.completion_cents_per_million_tokens,
  notes = excluded.notes,
  superseded_at = null;
