-- manifest: **Catálogo da AI/ML API.** Agregador OpenAI-compatível como a Requesty (0410), pela mesma fábrica `@ai-sdk/openai` com `.chat()` e pelo vocabulário aberto de `provider` da 0127. Cinco modelos com ids, contexto e preço conferidos em `GET https://api.aimlapi.com/v1/models?include=all` (linhas `type = openai/chat-completions`, todas com `tools` e `vision` em `capabilities`), convertidos para centavos por milhão. Insere em `ai_pricing` os mesmos cinco ids com `on conflict do nothing`: três são também da Requesty, e sem a linha o backfill 0113 da cadeia tenta a mesma chave duas vezes. Sem `is_default_for_provider`. Idempotente (`on conflict do update`), sem coluna nem função nova.
-- ============================================================================
-- 9475: CATÁLOGO DA AI/ML API
--
-- A AI/ML API é um agregador OpenAI-compatível, como a Requesty: uma chave dá
-- acesso a modelos de vários fabricantes, com ids `fabricante/modelo`. Entra
-- pela mesma fábrica `@ai-sdk/openai` (`.chat()`), sem SDK novo, com endpoint
-- fixo em `https://api.aimlapi.com/v1`.
--
-- ## Procedência dos ids e dos preços (NÃO foram inventados)
--
--   GET https://api.aimlapi.com/v1/models?include=all (público, sem chave),
--   consultado em 2026-11-25. O mesmo id aparece em mais de um formato de API;
--   valem só as linhas `type = openai/chat-completions`, que é o que a fábrica
--   fala. Todas as cinco trazem `tools`, `vision` e `streaming` em
--   `capabilities`. Preço em dólares POR MILHÃO de tokens (`pricing.units`,
--   `origin = provided` e `origin = generated`), convertido para CENTAVOS por
--   milhão e arredondado para o centavo:
--
--     openai/gpt-4o-mini            0,15  / 0,60  US$/1M  →   15 /   60
--     openai/gpt-4.1-mini           0,40  / 1,60  US$/1M  →   40 /  160
--     google/gemini-2.5-flash       0,30  / 2,50  US$/1M  →   30 /  250
--     anthropic/claude-haiku-4.5    1,058 / 5,29  US$/1M  →  106 /  529
--     anthropic/claude-sonnet-4.5   3,174 / 15,87 US$/1M  →  317 / 1587
--
-- Os ids da Anthropic levam PONTO (`claude-haiku-4.5`), que é como o catálogo
-- deles os publica; `claude-haiku-4-5` é só alias lá.
--
-- `supports_vision` entra junto porque a AI/ML API está em `ROTEADORES`
-- (`lib/agent-engine/edge/llm/capabilities.ts`): num agregador, é o catálogo
-- que diz se o modelo enxerga imagem, não o provedor.
--
-- Mesmo limite de `ai_pricing` descrito na 0410: o preço resolve só por
-- `model_id`, sem provider. `openai/gpt-4o-mini`, `openai/gpt-4.1-mini` e
-- `google/gemini-2.5-flash` são também da Requesty, com o mesmo preço publicado;
-- por isso a linha de `ai_pricing` nasce aqui (ver o fim do arquivo).
--
-- Sem `is_default_for_provider`: a escolha recai no mais barato com
-- ferramentas (`escolherModeloDoProvedor`), como na Requesty e na OpenRouter.
--
-- Idempotente: `on conflict do update`. Sem coluna nova, sem função, sem
-- backfill de dado existente.
-- ============================================================================

insert into public.ai_models
  (provider, model_id, display_name, description, context_window,
   input_price_per_million_cents, output_price_per_million_cents,
   supports_tools, supports_vision)
values
  ('aimlapi', 'openai/gpt-4o-mini', 'GPT-4o mini (AI/ML API)',
   'Barato e rápido, bom para atendimento de volume. Enxerga imagem.',
   128000, 15, 60, true, true),
  ('aimlapi', 'openai/gpt-4.1-mini', 'GPT-4.1 mini (AI/ML API)',
   'Segue instruções melhor que o 4o mini, com contexto longo. Enxerga imagem.',
   1000000, 40, 160, true, true),
  ('aimlapi', 'google/gemini-2.5-flash', 'Gemini 2.5 Flash (AI/ML API)',
   'Contexto muito longo e custo baixo. Enxerga imagem.',
   1000000, 30, 250, true, true),
  ('aimlapi', 'anthropic/claude-haiku-4.5', 'Claude Haiku 4.5 (AI/ML API)',
   'Rápido, para atendimentos curtos e classificação. Enxerga imagem.',
   200000, 106, 529, true, true),
  ('aimlapi', 'anthropic/claude-sonnet-4.5', 'Claude Sonnet 4.5 (AI/ML API)',
   'O que melhor segue instruções longas e usa as ferramentas do CRM. Enxerga imagem.',
   200000, 317, 1587, true, true)
on conflict (provider, model_id) do update set
  display_name = excluded.display_name,
  description = excluded.description,
  context_window = excluded.context_window,
  input_price_per_million_cents = excluded.input_price_per_million_cents,
  output_price_per_million_cents = excluded.output_price_per_million_cents,
  supports_tools = excluded.supports_tools,
  supports_vision = excluded.supports_vision;

-- O preço nasce aqui, e não no próximo `update.sh`: `ai_pricing.model` é chave
-- primária, e três destes ids também são da Requesty. Num banco recém-instalado
-- nenhum dos dois tem linha ainda, e o backfill 0113 da cadeia, que é um INSERT
-- só sem `distinct on`, tentaria a mesma chave duas vezes. Mesmo preço publicado
-- nos dois provedores; `do nothing` não pisa na linha que um clone já tem.
insert into public.ai_pricing
  (model, prompt_cents_per_million_tokens, completion_cents_per_million_tokens, notes)
values
  ('openai/gpt-4o-mini',          15,   60, 'catálogo 9475 (AI/ML API)'),
  ('openai/gpt-4.1-mini',         40,  160, 'catálogo 9475 (AI/ML API)'),
  ('google/gemini-2.5-flash',     30,  250, 'catálogo 9475 (AI/ML API)'),
  ('anthropic/claude-haiku-4.5', 106,  529, 'catálogo 9475 (AI/ML API)'),
  ('anthropic/claude-sonnet-4.5', 317, 1587, 'catálogo 9475 (AI/ML API)')
on conflict (model) do nothing;
