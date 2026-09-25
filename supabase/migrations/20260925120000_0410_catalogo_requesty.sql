-- ============================================================================
-- 0410: CATÁLOGO DA REQUESTY
--
-- A Requesty é um roteador OpenAI-compatível, como a OpenRouter: uma chave dá
-- acesso a modelos de vários fabricantes, com ids `fabricante/modelo`. Entra
-- pela mesma fábrica `@ai-sdk/openai` (base URL própria, `.chat()`), sem SDK
-- novo, e pelo vocabulário aberto de `provider` da 0127.
--
-- ## Procedência dos ids e dos preços (NÃO foram inventados)
--
--   GET https://router.requesty.ai/v1/models → os cinco ids abaixo, todos com
--   `api = chat`, `supports_tool_calling = true` e `supports_vision = true`.
--   O preço vem do mesmo endpoint, em dólares POR TOKEN (`input_price`,
--   `output_price`), convertido para CENTAVOS por MILHÃO:
--
--     openai/gpt-4o-mini           0,15 / 0,60 US$/1M  →   15 /   60
--     openai/gpt-4.1-mini          0,40 / 1,60 US$/1M  →   40 /  160
--     google/gemini-2.5-flash      0,30 / 2,50 US$/1M  →   30 /  250
--     anthropic/claude-haiku-4-5   1,00 / 5,00 US$/1M  →  100 /  500
--     anthropic/claude-sonnet-4-5  3,00 / 15,00 US$/1M →  300 / 1500
--
-- `supports_vision` entra junto porque a Requesty está em `ROTEADORES`
-- (`lib/agent-engine/edge/llm/capabilities.ts`): num roteador, é o catálogo
-- que diz se o modelo enxerga imagem, não o provedor.
--
-- Esta migration não insere em `ai_pricing`, mas a linha aparece mesmo assim:
-- o bloco "ai_pricing backfill (migration 0113)" do `baseline.sql` deriva
-- `ai_pricing` de `ai_models` para todo `model_id` ainda sem linha, e o
-- `update.sh` reaplica o baseline. Numa instalação nova a linha nasce no
-- primeiro `update.sh` (no install o backfill roda antes deste bloco).
-- `ai_pricing` e `precoDoCatalogo` (`lib/ai/cost.ts`) resolvem só por
-- `model_id`, sem provider: o mesmo id servido pela OpenRouter e pela Requesty
-- divide o preço com ou sem essa linha. Os números acima são o preço publicado
-- pela Requesty; se a OpenRouter cobrar diferente pelo mesmo id, a conta de uma
-- das duas sai com o preço da outra. Limite do esquema, anterior a esta
-- migration.
--
-- Sem `is_default_for_provider`: a escolha recai no mais barato com
-- ferramentas (`escolherModeloDoProvedor`), como na OpenRouter e na DeepSeek.
--
-- Idempotente: `on conflict do update`. Sem coluna nova, sem função, sem
-- backfill de dado existente.
-- ============================================================================

insert into public.ai_models
  (provider, model_id, display_name, description, context_window,
   input_price_per_million_cents, output_price_per_million_cents,
   supports_tools, supports_vision)
values
  ('requesty', 'openai/gpt-4o-mini', 'GPT-4o mini (Requesty)',
   'Barato e rápido, bom para atendimento de volume. Enxerga imagem.',
   128000, 15, 60, true, true),
  ('requesty', 'openai/gpt-4.1-mini', 'GPT-4.1 mini (Requesty)',
   'Segue instruções melhor que o 4o mini, com contexto longo. Enxerga imagem.',
   1047576, 40, 160, true, true),
  ('requesty', 'google/gemini-2.5-flash', 'Gemini 2.5 Flash (Requesty)',
   'Contexto muito longo e custo baixo. Enxerga imagem.',
   1048576, 30, 250, true, true),
  ('requesty', 'anthropic/claude-haiku-4-5', 'Claude Haiku 4.5 (Requesty)',
   'Rápido, para atendimentos curtos e classificação. Enxerga imagem.',
   200000, 100, 500, true, true),
  ('requesty', 'anthropic/claude-sonnet-4-5', 'Claude Sonnet 4.5 (Requesty)',
   'O que melhor segue instruções longas e usa as ferramentas do CRM. Enxerga imagem.',
   1000000, 300, 1500, true, true)
on conflict (provider, model_id) do update set
  display_name = excluded.display_name,
  description = excluded.description,
  context_window = excluded.context_window,
  input_price_per_million_cents = excluded.input_price_per_million_cents,
  output_price_per_million_cents = excluded.output_price_per_million_cents,
  supports_tools = excluded.supports_tools,
  supports_vision = excluded.supports_vision;
