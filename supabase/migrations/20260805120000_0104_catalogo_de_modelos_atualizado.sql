-- 0101 — catálogo de modelos atualizado (Anthropic, OpenAI, Google)
--
-- O catálogo curado (`ai_models`) e a tabela de custo (`ai_pricing`) estavam
-- duas gerações atrás: o padrão da OpenAI era `gpt-5-mini` e o da Anthropic
-- `claude-sonnet-4-6`. Quem instala numa VPS escolhe modelo pelo que este
-- catálogo oferece — catálogo velho é o cliente pagando mais caro por um modelo
-- pior, sem saber que existe melhor.
--
-- OS IDS FORAM VERIFICADOS NO PROVEDOR, não derivados do nome comercial:
--   GET https://api.anthropic.com/v1/models  → claude-opus-5, claude-sonnet-5,
--       claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5-20251001
--       (o alias `claude-haiku-4-5` resolve — conferido em /v1/models/<id>)
--   GET https://api.openai.com/v1/models     → gpt-5.6-sol/terra/luna, gpt-5.5,
--       gpt-5.5-pro, gpt-5.4, gpt-5.4-mini, gpt-5.4-nano, gpt-5.4-pro
-- Id errado só falha na hora da chamada, com o cliente esperando.
--
-- ⚠️ OS IDS DO GOOGLE NÃO FORAM VERIFICADOS — não há chave Google nesta máquina.
-- Seguem a convenção do provedor e do que já estava no catálogo (`gemini-2.5-pro`,
-- `gemini-2.5-flash` já funcionavam). Confira antes de anunciar como suportados.
--
-- `context_window` e `released_at` ficam NULL nos modelos novos DE PROPÓSITO: eu
-- não tinha o dado, e número inventado numa coluna que a tela mostra é pior que
-- coluna vazia — a tela sabe lidar com null, o usuário não sabe lidar com mentira.
--
-- Preços em CENTAVOS por milhão de tokens (a unidade já usada nas duas tabelas).
-- Idempotente: `on conflict do update`, seguro em re-aplicação.

-- ---------------------------------------------------------------------------
-- 1. catálogo curado (o que a tela oferece)
-- ---------------------------------------------------------------------------
insert into public.ai_models
  (provider, model_id, display_name, description,
   input_price_per_million_cents, output_price_per_million_cents, supports_tools)
values
  -- Anthropic
  ('anthropic', 'claude-opus-5',     'Claude Opus 5',
   'O mais capaz da Anthropic para trabalho agêntico complexo.', 500, 2500, true),
  ('anthropic', 'claude-sonnet-5',   'Claude Sonnet 5',
   'Alto desempenho para atendimento e agentes. Preço de introdução ($2/$10 por milhão) até 31/08/2026; depois volta a $3/$15 — reveja este preço nessa data.',
   200, 1000, true),
  ('anthropic', 'claude-opus-4-8',   'Claude Opus 4.8',
   'Geração anterior do Opus.', 500, 2500, true),
  -- OpenAI
  ('openai',    'gpt-5.6-sol',       'GPT-5.6 Sol',
   'O mais capaz da linha 5.6.', 500, 3000, true),
  ('openai',    'gpt-5.6-terra',     'GPT-5.6 Terra',
   'Equilíbrio de custo e capacidade da linha 5.6.', 200, 1200, true),
  ('openai',    'gpt-5.6-luna',      'GPT-5.6 Luna',
   'O mais barato da linha 5.6, para classificação e tarefas simples.', 20, 120, true),
  ('openai',    'gpt-5.5',           'GPT-5.5',              null, 500, 3000, true),
  ('openai',    'gpt-5.5-pro',       'GPT-5.5 Pro',
   'Raciocínio estendido; custo alto.', 3000, 18000, true),
  ('openai',    'gpt-5.4',           'GPT-5.4',              null, 250, 1500, true),
  ('openai',    'gpt-5.4-mini',      'GPT-5.4 Mini',         null, 75, 450, true),
  ('openai',    'gpt-5.4-nano',      'GPT-5.4 Nano',         null, 20, 125, true),
  ('openai',    'gpt-5.4-pro',       'GPT-5.4 Pro',
   'Raciocínio estendido; custo alto.', 3000, 18000, true),
  -- Google (ids NÃO verificados — ver cabeçalho)
  ('google',    'gemini-3.1-pro-preview', 'Gemini 3.1 Pro (Preview)',
   'Prévia; preço sobe para $4/$18 por milhão acima de 200 mil tokens de entrada.', 200, 1200, true),
  ('google',    'gemini-3.5-flash',  'Gemini 3.5 Flash',     null, 150, 900, true),
  ('google',    'gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite',
   'O mais barato da linha Gemini.', 10, 40, true),
  ('google',    'gemini-2.0-flash',  'Gemini 2.0 Flash',     null, 10, 40, true)
on conflict (provider, model_id) do update set
  display_name = excluded.display_name,
  description = excluded.description,
  input_price_per_million_cents = excluded.input_price_per_million_cents,
  output_price_per_million_cents = excluded.output_price_per_million_cents,
  supports_tools = excluded.supports_tools;

-- Correção de preço nos que JÁ existiam e estavam errados: a saída do
-- gemini-2.5-pro é $10 (não $5) e a do gemini-2.5-flash é $2,50 (não $1,20).
-- Preço errado no catálogo vira orçamento errado na tela do cliente.
update public.ai_models set output_price_per_million_cents = 1000
 where provider = 'google' and model_id = 'gemini-2.5-pro';
update public.ai_models set output_price_per_million_cents = 250
 where provider = 'google' and model_id = 'gemini-2.5-flash';

-- ---------------------------------------------------------------------------
-- 2. padrão por provedor
--
-- O índice `ai_models_one_default_per_provider` é UNIQUE parcial e IMEDIATO:
-- limpar o padrão anterior tem de vir ANTES de marcar o novo, senão a migration
-- quebra no meio.
-- ---------------------------------------------------------------------------
update public.ai_models set is_default_for_provider = false
 where provider in ('anthropic', 'openai', 'google') and is_default_for_provider;

update public.ai_models set is_default_for_provider = true
 where (provider = 'anthropic' and model_id = 'claude-sonnet-5')
    or (provider = 'openai'    and model_id = 'gpt-5.6-terra')
    or (provider = 'google'    and model_id = 'gemini-3.5-flash');

-- ---------------------------------------------------------------------------
-- 3. contabilidade de custo — a MESMA lista, senão o gasto é calculado com
--    preço de outro modelo (ou não é calculado, que é pior: some do orçamento).
-- ---------------------------------------------------------------------------
insert into public.ai_pricing
  (model, prompt_cents_per_million_tokens, completion_cents_per_million_tokens, notes)
values
  ('claude-opus-5',          500,   2500,  'catálogo 0101'),
  ('claude-sonnet-5',        200,   1000,  'catálogo 0101 — introdução até 31/08/2026; depois 300/1500'),
  ('claude-opus-4-8',        500,   2500,  'catálogo 0101'),
  ('gpt-5.6-sol',            500,   3000,  'catálogo 0101'),
  ('gpt-5.6-terra',          200,   1200,  'catálogo 0101'),
  ('gpt-5.6-luna',            20,    120,  'catálogo 0101'),
  ('gpt-5.5',                500,   3000,  'catálogo 0101'),
  ('gpt-5.5-pro',           3000,  18000,  'catálogo 0101'),
  ('gpt-5.4',                250,   1500,  'catálogo 0101'),
  ('gpt-5.4-mini',            75,    450,  'catálogo 0101'),
  ('gpt-5.4-nano',            20,    125,  'catálogo 0101'),
  ('gpt-5.4-pro',           3000,  18000,  'catálogo 0101'),
  ('gemini-3.1-pro-preview', 200,   1200,  'catálogo 0101 — sobe acima de 200k tokens de entrada'),
  ('gemini-3.5-flash',       150,    900,  'catálogo 0101'),
  ('gemini-2.5-flash-lite',   10,     40,  'catálogo 0101'),
  ('gemini-2.0-flash',        10,     40,  'catálogo 0101'),
  ('gemini-2.5-pro',         125,   1000,  'catálogo 0101 — saída corrigida de 500 para 1000'),
  ('gemini-2.5-flash',        30,    250,  'catálogo 0101 — saída corrigida de 120 para 250')
on conflict (model) do update set
  prompt_cents_per_million_tokens = excluded.prompt_cents_per_million_tokens,
  completion_cents_per_million_tokens = excluded.completion_cents_per_million_tokens,
  notes = excluded.notes,
  superseded_at = null;
