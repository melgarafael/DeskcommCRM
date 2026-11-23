-- manifest: atualiza ai_models e ai_pricing do Gemini 3.5 Flash para 150/750 centavos por milhão, alinhando ao motor e ao roteamento oficial do Google pelo 3.6 Flash (#5090).
--
-- O #4968 corrigiu no motor a tarifa do gemini-3.5-flash, que o Google atende
-- pelo 3.6: saída de 900 para 750 centavos por milhão (entrada segue 150).
-- O banco ainda guardava o valor antigo em ai_pricing e ai_models (150/900).
-- Esta migration alinha as duas tabelas ao motor e ao catálogo oficial do Google.
--
-- Idempotente. No desenho da 0649.

insert into public.ai_models
  (provider, model_id, display_name, description,
   input_price_per_million_cents, output_price_per_million_cents, supports_tools)
values
  ('google', 'gemini-3.5-flash', 'Gemini 3.5 Flash',
   'Roteado ao 3.6 Flash. Preço de catálogo: tarifa de 01/01/2027 (US$ 1,50/US$ 7,50); o motor cobra a promo até essa data (UTC).',
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
  ('gemini-3.5-flash', 150, 750, 'catálogo 9462 — alinhado ao motor e ao roteamento pelo 3.6 Flash (#5090)')
on conflict (model) do update set
  prompt_cents_per_million_tokens = excluded.prompt_cents_per_million_tokens,
  completion_cents_per_million_tokens = excluded.completion_cents_per_million_tokens,
  notes = excluded.notes,
  superseded_at = null;
