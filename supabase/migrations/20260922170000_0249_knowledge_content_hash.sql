-- 0249 · Reindexação incremental: hash do conteúdo indexado por fonte.
--
-- ─── O que muda ─────────────────────────────────────────────────────────────
-- "Preparar tudo" reindexava TODOS os materiais, mesmo os que não mudaram. Caro,
-- lento e, no plano gratuito do provedor de embedding, esbarra no limite por
-- minuto. `content_hash` guarda o hash do conteúdo EFETIVAMENTE indexado: o
-- indexador compara com o hash atual e PULA quando não mudou (e o modelo de
-- embedding da versão ativa é o mesmo).
--
-- Nenhuma função nova em `public` ⇒ item 9 da doutrina de migrations não acionado.

alter table public.ai_knowledge_sources
  add column if not exists content_hash text;

comment on column public.ai_knowledge_sources.content_hash is
  'Hash do conteúdo que foi indexado por último. O indexador pula a reindexação quando o hash atual é igual E o modelo de embedding da versão ativa é o mesmo.';
