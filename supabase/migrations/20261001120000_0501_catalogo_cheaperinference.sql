-- ============================================================================
-- 0501: CATÁLOGO DA CHEAPER INFERENCE
--
-- A Cheaper Inference é um roteador OpenAI-compatível, como a Requesty: uma
-- chave dá acesso a modelos de vários fabricantes. Os ids vêm SEM prefixo de
-- fabricante (`gpt-5.4-mini`). Entra pela mesma fábrica `@ai-sdk/openai` (base
-- URL própria, `.chat()`), sem SDK novo, e pelo vocabulário aberto de
-- `provider` da 0127.
--
-- ## Procedência dos ids e dos preços (NÃO foram inventados)
--
--   GET https://api.cheaperinference.com/v1/models (com a chave; sem ela é 401)
--   → os cinco ids abaixo, todos com `type = text` e `/v1/chat/completions`.
--   `supports_vision` vem de `capabilities.vision`. O preço vem do mesmo
--   endpoint, em dólares POR MILHÃO (`pricing.input_per_million`,
--   `pricing.output_per_million`), convertido para CENTAVOS por milhão:
--
--     gpt-5.4-mini        0,525 / 3,15 US$/1M  →   53 /  315  (52,5 arredondado para cima)
--     gpt-5.4             1,75  / 10,50 US$/1M →  175 / 1050
--     gemini-3.1-pro      1,70  / 10,20 US$/1M →  170 / 1020
--     claude-sonnet-5     1,40  / 7,00 US$/1M  →  140 /  700
--     deepseek-v4-flash   0,09  / 0,36 US$/1M  →    9 /   36
--
--   `supports_tools = true`: o endpoint não declara ferramentas, então foi
--   medido com uma chamada `tools` real (gpt-5.4-mini e deepseek-v4-flash
--   devolveram `tool_calls`); os outros três são famílias com ferramentas.
--
-- `supports_vision` entra junto porque a Cheaper Inference está em `ROTEADORES`
-- (`lib/agent-engine/edge/llm/capabilities.ts`): num roteador, é o catálogo
-- que diz se o modelo enxerga imagem. Aqui isso pesa mais que na Requesty: o id
-- não tem prefixo de fabricante, então o registro não tem nem o palpite.
--
-- Esta migration não insere em `ai_pricing`, como a 0410: o bloco "ai_pricing
-- backfill (migration 0113)" do `baseline.sql` deriva a linha de `ai_models`
-- para todo `model_id` ainda sem linha. `ai_pricing` e `precoDoCatalogo`
-- (`lib/ai/cost.ts`) resolvem só por `model_id`, sem provider: `gpt-5.4-mini`,
-- `gpt-5.4` e `claude-sonnet-5` já têm linha (catálogo 0101, OpenAI e
-- Anthropic diretas), e a conta da Cheaper Inference nesses ids sai com aquele
-- preço. O mesmo limite do esquema que a 0410 descreve, anterior a esta
-- migration.
--
-- Sem `is_default_for_provider`: a escolha recai no mais barato com
-- ferramentas (`escolherModeloDoProvedor`), como na Requesty.
--
-- Idempotente: `on conflict do update`. Sem coluna nova, sem função, sem
-- backfill de dado existente.
-- ============================================================================

insert into public.ai_models
  (provider, model_id, display_name, description, context_window,
   input_price_per_million_cents, output_price_per_million_cents,
   supports_tools, supports_vision)
values
  ('cheaperinference', 'gpt-5.4-mini', 'GPT-5.4 mini (Cheaper Inference)',
   'Barato e rápido, bom para atendimento de volume. Enxerga imagem.',
   400000, 53, 315, true, true),
  ('cheaperinference', 'gpt-5.4', 'GPT-5.4 (Cheaper Inference)',
   'Mais capaz que o mini, com contexto longo. Enxerga imagem.',
   1000000, 175, 1050, true, true),
  ('cheaperinference', 'gemini-3.1-pro', 'Gemini 3.1 Pro (Cheaper Inference)',
   'Contexto muito longo. Enxerga imagem.',
   1048576, 170, 1020, true, true),
  ('cheaperinference', 'claude-sonnet-5', 'Claude Sonnet 5 (Cheaper Inference)',
   'Segue bem instruções longas e usa as ferramentas do CRM. Enxerga imagem.',
   1000000, 140, 700, true, true),
  ('cheaperinference', 'deepseek-v4-flash', 'DeepSeek V4 Flash (Cheaper Inference)',
   'O de menor custo do catálogo, para atendimento de volume. Não enxerga imagem.',
   1000000, 9, 36, true, false)
on conflict (provider, model_id) do update set
  display_name = excluded.display_name,
  description = excluded.description,
  context_window = excluded.context_window,
  input_price_per_million_cents = excluded.input_price_per_million_cents,
  output_price_per_million_cents = excluded.output_price_per_million_cents,
  supports_tools = excluded.supports_tools,
  supports_vision = excluded.supports_vision;
