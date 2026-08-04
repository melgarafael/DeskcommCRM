-- Onda 5 — debounce de rajada inbound configurável por organização.
-- Vive em organizations.settings.inbound_debounce (jsonb), mesmo padrão de
-- routing / context_lifecycle / llm. Sem tabela nova.
--
-- Não há backfill: quando a chave está ausente, o runtime usa
-- INBOUND_DEBOUNCE_MS. Isso preserva a configuração global de instalações
-- existentes, inclusive quando o operador usa 0 para desligar o debounce.

comment on column public.organizations.settings is
  'JSONB de config da org. Chaves conhecidas: llm, routing, context_lifecycle, ai_dispatch_mode, visibility_mode, canonical_conversation_tags, inbound_debounce ({enabled, window_ms, max_window_ms?}) — coalescência de rajada inbound (Onda 5).';
