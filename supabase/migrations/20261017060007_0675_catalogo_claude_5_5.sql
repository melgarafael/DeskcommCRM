-- manifest: adiciona ao catálogo os Claude Haiku 5.5, Sonnet 5.5 e Opus 5.5 (ai_models + ai_pricing), para aparecerem em Provedores de IA e no seletor do agente e serem contabilizados no orçamento; corrige a descrição do Opus 5 e do Sonnet 5, que ficaram falsas.
--
-- O catálogo da Anthropic parou no Opus 5 / Sonnet 5 (migration 0104): quem
-- instala hoje não consegue escolher a geração 5.5, que custa igual ou menos.
--
-- Ids, janela de contexto e data de lançamento conferidos na documentação
-- oficial, NÃO na API (11/10/2026):
--   platform.claude.com/docs/en/about-claude/models/overview → claude-haiku-5-5,
--   claude-sonnet-5-5, claude-opus-5-5; 1M tokens nos três.
--   platform.claude.com/docs/en/models/<modelo>/overview → "Released": Haiku 5.5
--   em 07/10/2026, Sonnet 5.5 em 28/09/2026, Opus 5.5 em 22/09/2026.
-- ⚠️ Sem chave Anthropic nesta máquina: os ids NÃO foram conferidos em
-- GET /v1/models, como a 0104 fez com os dela.
--
-- Preços (centavos por milhão de tokens, entrada/saída), fonte:
-- platform.claude.com/docs/en/about-claude/pricing, consultada em 11/10/2026:
--   claude-haiku-5-5 .....  10 /   50  ($0,10 / $0,50 com prompt até 100 mil tokens;
--                                      acima disso $0,50 / $2,50 — a coluna só tem
--                                      um preço, e vale o da faixa comum)
--   claude-sonnet-5-5 .... 200 / 1000  ($2 / $10)
--   claude-opus-5-5 ...... 400 / 2000  ($4 / $20)
--
-- Fora: claude-fable-5-1 ($10 / $50). É 2,5× o Opus 5.5, a Anthropic o descreve
-- como "Slower" e para raciocínio de horizonte longo — turnos de minutos, o
-- oposto de uma resposta de WhatsApp — e exige retenção de dados de 30 dias
-- (organização em retenção zero recebe 400). O critério da 0104 é não deixar o
-- cliente pagar mais caro sem ganho para o atendimento.
--
-- NÃO mexe no padrão da Anthropic (segue claude-sonnet-5). Idempotente nas duas
-- tabelas (on conflict do update). O invariante tests/invariants/catalogo-de-modelos.test.ts
-- exige preço IGUAL nos dois lados e notes começando com 'catálogo'.
-- supports_tools = true: senão o modelo não aparece no seletor do agente.

-- ---------------------------------------------------------------------------
-- 1. catálogo (o que a tela oferece)
-- ---------------------------------------------------------------------------
insert into public.ai_models
  (provider, model_id, display_name, description, context_window, released_at,
   input_price_per_million_cents, output_price_per_million_cents, supports_tools)
values
  ('anthropic', 'claude-haiku-5-5', 'Claude Haiku 5.5',
   'O mais rápido e barato da Anthropic, para alto volume e classificação. Acima de 100 mil tokens de entrada numa chamada o preço sobe para $0,50/$2,50 por milhão.',
   1000000, '2026-10-07', 10, 50, true),
  ('anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5',
   'Equilíbrio de velocidade e capacidade; sucessor do Sonnet 5, pelo mesmo preço.',
   1000000, '2026-09-28', 200, 1000, true),
  ('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5',
   'O Opus atual, para trabalho agêntico complexo; custa menos que o Opus 5.',
   1000000, '2026-09-22', 400, 2000, true)
on conflict (provider, model_id) do update set
  display_name = excluded.display_name,
  description = excluded.description,
  context_window = excluded.context_window,
  released_at = excluded.released_at,
  input_price_per_million_cents = excluded.input_price_per_million_cents,
  output_price_per_million_cents = excluded.output_price_per_million_cents,
  supports_tools = excluded.supports_tools,
  deprecated_at = null;

-- O Opus 5 deixou de ser "o mais capaz", e o Sonnet 5 não volta a $3/$15: a
-- Anthropic tornou $2/$10 o preço padrão e cancelou o aumento de 01/09/2026.
update public.ai_models set description = 'Geração anterior do Opus.'
 where provider = 'anthropic' and model_id = 'claude-opus-5';
update public.ai_models set description = 'Geração anterior do Sonnet.'
 where provider = 'anthropic' and model_id = 'claude-sonnet-5';

-- ---------------------------------------------------------------------------
-- 2. contabilidade de custo — a MESMA lista, mesmos números (senão o gasto é
--    somado com preço de outro modelo, ou não é somado e some do orçamento).
-- ---------------------------------------------------------------------------
insert into public.ai_pricing
  (model, prompt_cents_per_million_tokens, completion_cents_per_million_tokens, notes)
values
  ('claude-haiku-5-5',   10,   50, 'catálogo 0675 — acima de 100k tokens de entrada, 50/250'),
  ('claude-sonnet-5-5', 200, 1000, 'catálogo 0675'),
  ('claude-opus-5-5',   400, 2000, 'catálogo 0675')
on conflict (model) do update set
  prompt_cents_per_million_tokens = excluded.prompt_cents_per_million_tokens,
  completion_cents_per_million_tokens = excluded.completion_cents_per_million_tokens,
  notes = excluded.notes,
  superseded_at = null;
