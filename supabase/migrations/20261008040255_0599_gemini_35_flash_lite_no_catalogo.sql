-- manifest: Gemini 3.5 Flash-Lite no catálogo Google, com preço Standard em ambas as tabelas.
-- Fonte (06/10/2026): https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite
-- Preço: https://ai.google.dev/gemini-api/docs/pricing
-- O sincronizador automático só consulta a OpenRouter; modelos Google são curados.

insert into public.ai_models
  (provider, model_id, display_name, description, context_window,
   input_price_per_million_cents, output_price_per_million_cents,
   supports_tools, supports_vision, is_default_for_provider, deprecated_at)
values
  ('google', 'gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite',
   'Modelo Google de baixa latência para atendimento com ferramentas; aceita texto, imagem, áudio, vídeo e PDF.',
   1048576, 30, 250, true, true, false, null)
on conflict (provider, model_id) do update set
  display_name = excluded.display_name,
  description = excluded.description,
  context_window = excluded.context_window,
  input_price_per_million_cents = excluded.input_price_per_million_cents,
  output_price_per_million_cents = excluded.output_price_per_million_cents,
  supports_tools = excluded.supports_tools,
  supports_vision = excluded.supports_vision,
  deprecated_at = null;

insert into public.ai_pricing
  (model, prompt_cents_per_million_tokens, completion_cents_per_million_tokens, notes)
values
  ('gemini-3.5-flash-lite', 30, 250,
   'catálogo 0599 — Google Gemini API Standard, 06/10/2026; cache e armazenamento cobrados à parte')
on conflict (model) do update set
  prompt_cents_per_million_tokens = excluded.prompt_cents_per_million_tokens,
  completion_cents_per_million_tokens = excluded.completion_cents_per_million_tokens,
  notes = excluded.notes,
  superseded_at = null;
