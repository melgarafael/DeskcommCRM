-- =============================================================================
-- Migration 0068 — ai_pricing nasce vazia em instalação nova
-- =============================================================================
-- BUG
--   Os seeds de `ai_pricing` existem só na migration 0010, mas a cadeia fresh
--   de migrations não sobe — as 10 primeiras são stubs `SELECT 1;`. Quem
--   instala aplica o `supabase/baseline.sql` (é o que o hostgator-setup-kit/
--   install.sh faz), e o baseline semeia `ai_models` mas NÃO `ai_pricing`.
--
--   Resultado: em TODA instalação self-host nova a tabela `ai_pricing` fica
--   vazia. Como `computeCost()` (lib/ai/cost.ts) faz lookup exato por `model`
--   e devolve 0 quando não acha a linha — sem log, sem throw:
--
--     * `ai_invocations.cost_cents` grava 0 pra qualquer chamada de LLM;
--     * `ai_budgets` nunca acumula gasto, então o teto por organização JAMAIS
--       dispara. O tenant configura limite de gasto, a UI mostra o limite, e
--       ele não existe na prática.
--
--   Reproduz assim, em banco recém-instalado pelo baseline:
--     select count(*) from public.ai_pricing;              -- 0
--     -- e no app:
--     computeCost({ model: 'claude-sonnet-4-6',
--                   promptTokens: 1e6, completionTokens: 1e6 })  -- 0
--
-- FIX
--   Genérico e auto-curativo: `ai_models` já carrega
--   input/output_price_per_million_cents corretos pra todo o catálogo, então
--   derivamos `ai_pricing` dele em vez de repetir números à mão. Vale pra
--   qualquer provedor e pra qualquer modelo que entre no catálogo depois —
--   re-aplicar preenche só o que falta e não duplica o que já existe.
--
--   `openai/text-embedding-3-small` entra à parte: embedding não é modelo de
--   chat, não está em `ai_models`, e é a string que `lib/ai/embed.ts` usa no
--   log de invocação. Valor 20¢/M — o mesmo seed da 0010.
--
--   Depois desta migration, num banco novo:
--     computeCost({ model: 'claude-sonnet-4-6',
--                   promptTokens: 1e6, completionTokens: 1e6 })  -- 1800
--
--   Bancos que já rodavam com a 0010 aplicada não mudam: o NOT EXISTS protege
--   as linhas existentes, e nada é sobrescrito (ai_pricing é versionada por
--   `superseded_at` — correção de preço é INSERT novo, nunca UPDATE).
--
-- Idempotente: pode ser re-aplicada (é o que o update.sh do kit faz).
-- =============================================================================

insert into public.ai_pricing (model, prompt_cents_per_million_tokens, completion_cents_per_million_tokens, notes)
select
  m.model_id,
  m.input_price_per_million_cents,
  m.output_price_per_million_cents,
  'backfill 0068 a partir de ai_models'
from public.ai_models m
where m.deprecated_at is null
  and m.input_price_per_million_cents is not null
  and m.output_price_per_million_cents is not null
  and not exists (
    select 1 from public.ai_pricing p
    where p.model = m.model_id and p.superseded_at is null
  );

-- Embedding do RAG — não vive em ai_models.
insert into public.ai_pricing (model, embedding_cents_per_million_tokens, notes)
select 'openai/text-embedding-3-small', 20, 'backfill 0068 (seed original da 0010)'
where not exists (
  select 1 from public.ai_pricing p
  where p.model = 'openai/text-embedding-3-small' and p.superseded_at is null
);
