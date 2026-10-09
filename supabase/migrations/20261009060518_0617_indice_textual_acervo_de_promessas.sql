-- manifest: Índice textual português para recuperar evidências de ofertas antes da revisão de promessas.
-- A expressão é a mesma da consulta e mantém acentos nos dois lados.
-- Sem alteração de linhas, políticas RLS ou concessões de acesso.
create index if not exists ai_chunks_content_pt_gin
  on public.ai_chunks using gin (to_tsvector('portuguese'::regconfig, content));
