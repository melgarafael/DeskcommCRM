# lib/ai/

> Placeholder. Implementação real virá da Spec 05 — IA Conversacional + RAG + Handoff.

Escopo previsto:

- `gateway.ts` — wrapper Vercel AI Gateway (fallback de provedor; observability por tenant)
- `agent.ts` — orquestrador do chatbot por tenant (carrega config de `ai_agents`)
- `rag/`
  - `ingest.ts` — pipeline de ingestão (FAQ + política + catálogo CSV + conversas resolvidas)
  - `embed.ts` — wrapper OpenAI `text-embedding-3-large`
  - `retrieve.ts` — query top-K em `ai_chunks` (pgvector) + reranking
- `sentiment.ts` — análise binária alta/baixa frustração via Haiku 4.5
- `handoff.ts` — política de transição bot → humano (threshold + audit em `crm_lead_activities.type='handoff_triggered'`)

## Strings de modelo (canônicas)

- `"anthropic/claude-sonnet-4-6"` — agente principal (atendimento)
- `"anthropic/claude-haiku-4-5"` — sentiment + classificação
- `"openai/text-embedding-3-large"` — embeddings RAG

Prefira sempre roteamento via Vercel AI Gateway. Import direto do SDK Anthropic só como fallback.
