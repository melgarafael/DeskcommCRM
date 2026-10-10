-- 0097 — limiar de similaridade do RAG calibrado com medição
--
-- O padrão era 0.72. Medido nesta VPS com `text-embedding-3-small` (o modelo
-- default) sobre um FAQ real em português:
--
--   pergunta LITERAL do FAQ ............................. 0.849  ✓
--   "quanto tempo demora pra chegar em BH?" ............. 0.653  ✓
--   "posso trocar se nao servir?" ....................... 0.537  ✓
--   "aceita pix?" ....................................... 0.490  ✓
--   "qual a capital da franca?" (irrelevante) ........... 0.265  ✗
--
-- Com 0.72, só a pergunta literal passava: TODA paráfrase — que é como o
-- cliente escreve de verdade — era descartada, e o RAG parecia quebrado mesmo
-- funcionando. O vão entre relevante (0.49–0.85) e irrelevante (0.27) é largo,
-- e 0.40 fica no meio dele com folga dos dois lados.
--
-- É um knob por agente (ai_agents.config.rag_similarity_threshold): quem tiver
-- base maior e quiser mais rigor sobe o valor pela configuração do agente.

alter table public.ai_agents
  alter column config set default jsonb_build_object(
    'temperature', 0.3, 'max_tokens', 1024, 'rag_top_k', 5,
    'rag_similarity_threshold', 0.40, 'context_message_window', 20,
    'confidence_threshold', 0.55, 'sentiment_threshold', 0.3,
    'zero_data_retention', false);

-- Cura quem está com o padrão antigo INTACTO. Quem já ajustou o valor na mão
-- não é tocado.
update public.ai_agents
set config = jsonb_set(config, '{rag_similarity_threshold}', '0.40'::jsonb)
where (config->>'rag_similarity_threshold')::numeric = 0.72;

-- Default da função de busca, para quem chama sem passar o limiar.
CREATE OR REPLACE FUNCTION "public"."retrieve_top_k_chunks"("p_organization_id" "uuid", "p_kb_version_id" "uuid", "p_embedding" "public"."vector", "p_k" integer DEFAULT 5, "p_threshold" real DEFAULT 0.40) RETURNS TABLE("chunk_id" "uuid", "knowledge_source_id" "uuid", "content" "text", "similarity" real, "metadata" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select
    c.id as chunk_id,
    c.knowledge_source_id,
    c.content,
    (1 - (c.embedding <=> p_embedding))::real as similarity,
    c.metadata
  from public.ai_chunks c
  where c.organization_id = p_organization_id
    and c.kb_version_id   = p_kb_version_id
    and (1 - (c.embedding <=> p_embedding)) >= p_threshold
  order by c.embedding <=> p_embedding asc
  limit greatest(p_k, 0);
$$;
