-- manifest: atualiza ai_models e ai_pricing do Gemini 3.6/3.7/3.8 Flash para 150/750 centavos por milhão, a tarifa Standard de 01/01/2027; costCents e computeCost aplicam a promo (75/375/7,5 centavos) até 2027-01-01T00:00:00Z.
--
-- Página ai.google.dev/gemini-api/docs/pricing, lida em 2026-10-12 (HTTP Date:
-- Mon, 12 Oct 2026 06:52:04 GMT). Standard, faixa paga, por 1M tokens:
--   até 31/12/2026 ........ entrada 0,75 / saída 3,75 / leitura de cache 0,075
--   a partir de 01/01/2027  entrada 1,50 / saída 7,50 / leitura de cache 0,15
-- O 3.6 e o 3.8 trazem esses números na página. O 3.7 NÃO está mais na página
-- de preços: a ficha do modelo (mesmo dia) diz que gemini-3.7-flash está
-- depreciado e que todo pedido é roteado para gemini-3.8-flash. A tarifa
-- registrada aqui é a do 3.8, que é o que o Google cobra nesse roteamento.
-- Não mexe em nenhum outro modelo.
--
-- Por que um número só, e não duas linhas: `ai_pricing_pkey` é só `model`
-- (o apêndice da 0068 explica o porquê — a reaplicação do baseline duplicava
-- a chave). `effective_from` e `superseded_at` existem, mas `loadPricing`
-- descarta só `superseded_at is not null` e guarda um Map por `model`, sem
-- olhar `effective_from`. Uma segunda linha futura exigiria trocar a PK e
-- todos os `on conflict (model)` do apêndice. As colunas ficam com a tarifa
-- de 2027 (150/750), igual nas duas tabelas, notes começando com `catálogo`.
-- A lista mostra 150/750 assim que esta migration aplica. O gasto em
-- `llm_calls.cost_cents` destes três ids não sai só de `pricing.ts`:
-- o seam chama `costCents`, e o sentimento e o respondedor legado gravam
-- via `computeCost` (`lib/ai/cost.ts`), que desvia para o mesmo corte.
-- Promo enquanto `em < 2027-01-01T00:00:00Z`: 75/375/7,5 centavos por
-- milhão (entrada, saída, leitura de cache). Nesse instante e depois:
-- 150/750/15. UTC: a página não publica fuso; o repo grava instante em UTC.
--
-- Idempotente. Não mexe no default do Google (segue gemini-3.5-flash).
-- Não deprecia o 3.7: sumir do seletor é outra decisão.

insert into public.ai_models
  (provider, model_id, display_name, description,
   input_price_per_million_cents, output_price_per_million_cents, supports_tools)
values
  ('google', 'gemini-3.6-flash', 'Gemini 3.6 Flash',
   'Preço de catálogo: tarifa de 01/01/2027 (US$ 1,50/US$ 7,50). O motor cobra a promo até essa data (UTC).',
   150, 750, true),
  ('google', 'gemini-3.7-flash', 'Gemini 3.7 Flash',
   'Preço de catálogo: tarifa de 01/01/2027 (US$ 1,50/US$ 7,50). O motor cobra a promo até essa data (UTC).',
   150, 750, true),
  ('google', 'gemini-3.8-flash', 'Gemini 3.8 Flash',
   'Preço de catálogo: tarifa de 01/01/2027 (US$ 1,50/US$ 7,50). O motor cobra a promo até essa data (UTC).',
   150, 750, true)
on conflict (provider, model_id) do update set
  display_name = excluded.display_name,
  description = excluded.description,
  input_price_per_million_cents = excluded.input_price_per_million_cents,
  output_price_per_million_cents = excluded.output_price_per_million_cents,
  supports_tools = excluded.supports_tools,
  deprecated_at = null;

insert into public.ai_pricing
  (model, prompt_cents_per_million_tokens, completion_cents_per_million_tokens, notes)
values
  ('gemini-3.6-flash', 150, 750, 'catálogo 0649 — tarifa de 01/01/2027 UTC; o motor aplica 75/375 até lá'),
  ('gemini-3.7-flash', 150, 750, 'catálogo 0649 — tarifa de 01/01/2027 UTC; o motor aplica 75/375 até lá'),
  ('gemini-3.8-flash', 150, 750, 'catálogo 0649 — tarifa de 01/01/2027 UTC; o motor aplica 75/375 até lá')
on conflict (model) do update set
  prompt_cents_per_million_tokens = excluded.prompt_cents_per_million_tokens,
  completion_cents_per_million_tokens = excluded.completion_cents_per_million_tokens,
  notes = excluded.notes,
  superseded_at = null;
