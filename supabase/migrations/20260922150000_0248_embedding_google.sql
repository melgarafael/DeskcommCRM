-- 0248 · Embedding pelo Google (Gemini): opção ao provedor OpenAI para o RAG.
--
-- ─── O que muda ─────────────────────────────────────────────────────────────
-- O `ai_models` só tinha `openai/text-embedding-3-small` como modelo de embedding
-- (migration 0181). Com o embedding passando a aceitar o provedor **Google**
-- (`lib/ai/embeddings/chave.ts`, `lib/ai/embed.ts`), o catálogo precisa listar o
-- `gemini-embedding-001` para o painel de provedores oferecê-lo nos pontos
-- `embedding_indexar`/`embedding_consultar`.
--
-- A dimensão é **1536** nos dois modelos (o Gemini usa `outputDimensionality`),
-- então a coluna `ai_chunks.embedding vector(1536)` NÃO migra. Trocar de provedor,
-- porém, exige REINDEXAR: a busca casa o `embedding_model` gravado na versão.
--
-- Nenhuma função nova em `public` ⇒ item 9 da doutrina de migrations não acionado.

insert into public.ai_models
  (provider, model_id, display_name, description,
   input_price_per_million_cents, output_price_per_million_cents,
   supports_tools, supports_embedding, embedding_dims)
values
  ('google', 'gemini-embedding-001', 'Gemini Embedding 001',
   'Alternativa sem OpenAI para indexar e consultar o seu material. Dimensão 1536 (MRL) — a coluna vetorial não muda. Trocar de provedor exige reindexar o material.',
   0, 0, false, true, 1536)
on conflict (provider, model_id) do update set
  display_name       = excluded.display_name,
  description        = excluded.description,
  supports_embedding = excluded.supports_embedding,
  embedding_dims     = excluded.embedding_dims,
  supports_tools     = excluded.supports_tools;
