-- ---------------------------------------------------------------------------
-- 0386 — as DUAS tabelas de preço do OpenAI passam a dizer o que a fonte mediu
-- (issue #1490, acompanhamento do #1486)
--
-- A tabela de preços versionada (`lib/agent-engine/edge/llm/pricing.ts`, o que
-- grava `llm_calls.cost_cents`) cobra gpt-5.6-sol a 400/2000 centavos por 1M —
-- preço PROMOCIONAL medido na fonte oficial em 2026-09-23
-- (developers.openai.com/api/docs/pricing, faixa Standard, contexto curto; a
-- própria página declara que a promoção vale ao menos até 21/11/2026). As duas
-- tabelas do schema continuavam com 500/3000, a versão não promocional do
-- catálogo 0101: quem escolhia o modelo via a tela um preço, a conta somava
-- outro, e os dois divergiam do que a API cobra.
--
-- `ai_models` E `ai_pricing` mudam JUNTAS de propósito: o invariante
-- tests/invariants/catalogo-de-modelos.test.ts ("o preço da tela é o MESMO que
-- a conta usa") reprova qualquer um dos lados que ande sozinho. A linha de
-- `ai_pricing` mantém o prefixo `catálogo` nas `notes`, que é o que o invariante
-- de procedência exige (preço vindo do apêndice, não da cura automática do
-- backfill 0113).
--
-- Entram também os três ids OpenAI que o `pricing.ts` já cobrava e a tabela não
-- conhecia (gpt-4o, gpt-4o-mini, gpt-4o-2024-05-13): sem linha em `ai_pricing`,
-- `computeCost()` cai no catálogo/backfill e o número pode não ser o do código —
-- o mesmo buraco da #1478 por outro caminho.
--
-- Idempotente: o `update` só age quando há divergência; o `insert` fecha em
-- `on conflict`. Preço promocional muda: o que a `notes` grava é a FONTE e a
-- DATA da medição, para a próxima correção saber o que estava vigente e desde
-- quando.
-- ---------------------------------------------------------------------------
update public.ai_models
   set input_price_per_million_cents = 400,
       output_price_per_million_cents = 2000
 where provider = 'openai'
   and model_id = 'gpt-5.6-sol'
   and (input_price_per_million_cents <> 400
     or output_price_per_million_cents <> 2000);

insert into public.ai_pricing
  (model, prompt_cents_per_million_tokens, completion_cents_per_million_tokens, notes)
values
  ('gpt-5.6-sol',         400,   2000, 'catálogo 0386 — preço promocional medido na fonte em 2026-09-23 (developers.openai.com/api/docs/pricing); promoção vale ao menos até 21/11/2026'),
  ('gpt-4o',              250,   1000, 'catálogo 0386 — linha que o pricing.ts já cobrava e a tabela não tinha; preço medido na fonte em 2026-09-23'),
  ('gpt-4o-mini',          15,     60, 'catálogo 0386 — linha que o pricing.ts já cobrava e a tabela não tinha; preço medido na fonte em 2026-09-23'),
  ('gpt-4o-2024-05-13',   500,   1500, 'catálogo 0386 — snapshot com preço próprio; linha que o pricing.ts já cobrava e a tabela não tinha; medido em 2026-09-23')
on conflict (model) do update set
  prompt_cents_per_million_tokens = excluded.prompt_cents_per_million_tokens,
  completion_cents_per_million_tokens = excluded.completion_cents_per_million_tokens,
  notes = excluded.notes,
  superseded_at = null;
