-- manifest: adiciona o gpt-6.1-terra ao catálogo (ai_models + ai_pricing), para aparecer em Provedores de IA e no seletor do agente e ser contabilizado no orçamento.
--
-- A 0646 trouxe a linha 6 (gpt-6-luna, gpt-6.1-sol, gpt-6-astra); o Terra da
-- linha 6 saiu depois e o catálogo ficou no gpt-5.6-terra.
--
-- Id, janela de contexto e preço conferidos na documentação oficial, NÃO na API:
--   developers.openai.com/api/docs/models/gpt-6.1-terra e
--   developers.openai.com/api/docs/pricing (tabela Standard), consultadas em 27/10/2026.
--   Também listado no AI Gateway da Vercel como openai/gpt-6.1-terra.
-- ⚠️ Sem chave OpenAI nesta máquina: o id NÃO foi conferido em GET /v1/models.
-- `released_at` fica NULL: a página não publica data.
--
-- Preço (centavos por milhão de tokens, entrada/saída), prompt até 272 mil tokens:
--   gpt-6.1-terra ........  100 /  500  ($1 / $5)
-- Acima de 272 mil tokens de entrada, 200/750. A coluna só guarda um preço, e vale
-- o da faixa comum.
--
-- NÃO mexe no padrão da OpenAI (segue gpt-5.6-terra). Idempotente nas duas
-- tabelas (on conflict do update). O invariante tests/invariants/catalogo-de-modelos.test.ts
-- exige preço IGUAL nos dois lados e notes começando com 'catálogo'.
-- supports_tools = true: senão o modelo não aparece no seletor do agente.

-- ---------------------------------------------------------------------------
-- 1. catálogo (o que a tela oferece)
-- ---------------------------------------------------------------------------
insert into public.ai_models
  (provider, model_id, display_name, description, context_window,
   input_price_per_million_cents, output_price_per_million_cents, supports_tools)
values
  ('openai', 'gpt-6.1-terra', 'GPT-6.1 Terra',
   'Intermediário da linha 6: mais capaz que o Luna, metade do preço do Sol.',
   1050000, 100, 500, true)
on conflict (provider, model_id) do update set
  display_name = excluded.display_name,
  description = excluded.description,
  context_window = excluded.context_window,
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
  ('gpt-6.1-terra', 100, 500, 'catálogo 9031 — acima de 272k tokens de entrada, 200/750')
on conflict (model) do update set
  prompt_cents_per_million_tokens = excluded.prompt_cents_per_million_tokens,
  completion_cents_per_million_tokens = excluded.completion_cents_per_million_tokens,
  notes = excluded.notes,
  superseded_at = null;
