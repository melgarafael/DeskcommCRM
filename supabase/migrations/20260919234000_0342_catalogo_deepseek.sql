-- ============================================================================
-- 0342 — CATÁLOGO DA DEEPSEEK
--
-- A migration 0127 abriu o vocabulário de `provider` dizendo textualmente que
-- era para destravar "o próximo provedor". A DeepSeek é esse próximo provedor:
-- OpenAI-compatível (mesma fábrica `@ai-sdk/openai`, base URL própria) e com
-- desconto automático de prefixo de cache, que baixa o custo de um roteiro de
-- atendimento que não muda sem o operador configurar nada.
--
-- ## Procedência dos ids e dos preços (NÃO foram inventados)
--
--   GET https://api.deepseek.com/models → `deepseek-flash`, `deepseek-v4-pro`
--   Preço (docs oficiais, dólares por 1M de tokens):
--     entrada (cache miss)  $0,14  → 14 centavos por 1M
--     saída                 $0,28  → 28 centavos por 1M
--     entrada (cache hit)   $0,0028 → 0,28 centavo por 1M
--
--   ⚠️ O preço de CACHE HIT (0,28¢/1M) NÃO entra aqui: a coluna
--   `input_price_per_million_cents` é `integer` e guarda UM preço de entrada (o
--   cheio). O desconto de cache é aplicado na COBRANÇA do provedor, não é um
--   preço de catálogo — e um valor sub-centavo não caberia no integer de
--   qualquer forma. Fica registrado aqui para quem um dia for somar cache no
--   orçamento: a coluna certa não existe ainda.
--
-- Os dois modelos entram com `supports_tools = true` — o tool calling foi
-- verificado no provedor (finish=tool_calls). Sem isso o painel recusaria a
-- DeepSeek nos pontos que agem no funil.
--
-- Sem `is_default_for_provider`: o padrão por provedor é curadoria dos três
-- semeadores originais, e marcar um aqui mexeria no invariante `catalogo-de-
-- modelos` (que espera exatamente um padrão para anthropic/openai/google). A
-- escolha recai no mais barato com ferramentas via `escolherModeloDoProvedor`,
-- como já acontece com a OpenRouter.
--
-- Idempotente: `on conflict do update` nas duas tabelas. Preço em CENTAVOS por
-- MILHÃO — a mesma unidade do resto do catálogo.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. catálogo curado (o que a tela oferece)
-- ---------------------------------------------------------------------------
insert into public.ai_models
  (provider, model_id, display_name, description,
   input_price_per_million_cents, output_price_per_million_cents, supports_tools)
values
  ('deepseek', 'deepseek-flash',  'DeepSeek Flash',
   'O mais barato da DeepSeek, para atendimento de volume. Tem desconto automático do trecho repetido da conversa.',
   14, 28, true),
  ('deepseek', 'deepseek-v4-pro', 'DeepSeek V4 Pro',
   'O mais capaz da linha v4, para conversas que exigem raciocínio. Também desconta o trecho repetido da conversa.',
   44, 87, true)
on conflict (provider, model_id) do update set
  display_name = excluded.display_name,
  description = excluded.description,
  input_price_per_million_cents = excluded.input_price_per_million_cents,
  output_price_per_million_cents = excluded.output_price_per_million_cents,
  supports_tools = excluded.supports_tools;

-- ---------------------------------------------------------------------------
-- 2. contabilidade de custo — a MESMA lista, senão o gasto é somado com preço
--    de outro modelo (ou não é somado, que é pior: some do orçamento).
--    `ai_pricing` é keyed por `model` (sem prefixo de provider).
-- ---------------------------------------------------------------------------
insert into public.ai_pricing
  (model, prompt_cents_per_million_tokens, completion_cents_per_million_tokens, notes)
values
  ('deepseek-flash',   14, 28, 'catálogo 0342 — cache hit 0,28¢/1M não cabe no catálogo'),
  ('deepseek-v4-pro',  44, 87, 'catálogo 0342 — cache hit 0,28¢/1M não cabe no catálogo')
on conflict (model) do update set
  prompt_cents_per_million_tokens = excluded.prompt_cents_per_million_tokens,
  completion_cents_per_million_tokens = excluded.completion_cents_per_million_tokens,
  notes = excluded.notes,
  superseded_at = null;
