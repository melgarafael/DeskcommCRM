---
title: Spec Técnica 05 — IA Conversacional + RAG + Sentiment + Handoff
parent: 05-prd-ai-rag-handoff.md
depends_on: 01-spec-platform-base.md, 02-spec-customer-360.md, 03-spec-whatsapp-waha.md, 04-spec-pipeline-attendance.md
version: 0.1
status: em revisão
date: 2026-04-28
owner: Songhai, Lda
referencia_arquitetural: docs/research/reference-synthesis.md
---

# Spec 05 — IA Conversacional + RAG + Sentiment + Handoff

> Detalhamento técnico da camada de IA do SonghaiCRM. Define schema SQL completo das tabelas `ai_*`, pipeline de ingestão das 4 fontes de RAG, roteamento da chamada do bot via Vercel AI SDK + AI Gateway, sentiment detection paralelo, 4 gatilhos de handoff, guardrails declarativos e prompts canônicos em PT-BR. Esta spec assume a fundação herdada (event_log, RLS, audit, polimorfismo de activities) das specs 01–04.

---

## 1. Visão Geral

A camada de IA é um conjunto de **workers idempotentes** acoplados ao `event_log` (doutrina §2: trigger nunca faz HTTP), consumindo eventos `message.received` e produzindo `message.sent`/`activity.recorded`. Ela é **stateless por chamada** (todo contexto é montado a cada inbound) e **stateful por base de conhecimento** (RAG versionada por tenant). Três caminhos paralelos disparam ao receber inbound:

1. **Triagem síncrona pré-bot** — regex de pedido explícito (G1) e regex de fraude/jurídico (G4 parcial). Roda em <50ms; se hit, dispara handoff e bypassa bot.
2. **Bot path** — montagem de contexto, RAG retrieval, invocação Sonnet 4.6, validação de guardrails, persistência. Alvo <3s p95.
3. **Sentiment path** — invocação paralela Haiku 4.5, persistência em `messages.metadata.sentiment_score`, avaliação de threshold pra G2. Alvo <2s p95, fora do path crítico.

Princípios não-negociáveis:

- **Strings de modelo, não imports** — `"anthropic/claude-sonnet-4-6"` resolve via Vercel AI Gateway. Nunca `import { Anthropic } from "@anthropic-ai/sdk"`.
- **Isolamento cross-tenant rígido** — toda query no vector store filtra `organization_id` em camada programática (defesa em profundidade) + RLS no Postgres.
- **Defesa em profundidade nos guardrails** — instrução no system prompt + validador programático pós-resposta. Modelo pode ignorar prompt; validador intercepta.
- **Fail-graceful** — vector store down → bot continua sem RAG (maior chance de handoff por incerteza). Sentiment worker down → bot funciona normalmente, threshold G2 simplesmente não dispara.
- **Custo controlado** — orçamento por tenant com alarme 80% e ação configurável em 100%; observability via AI Gateway.

Esta spec cobre apenas o lado IA. Captura/envio físico WhatsApp está na spec 03; UI de fila e roteamento humano está na spec 04; sync de catálogo Nuvemshop está na spec 06.

---

## 2. Stack & Decisões

### 2.1 Vercel AI SDK v6 + AI Gateway

Toda chamada LLM passa pelo **Vercel AI Gateway** (https://vercel.com/docs/ai-gateway). Razões:

- **Provider routing por string**: `"anthropic/claude-sonnet-4-6"`, `"anthropic/claude-haiku-4-5"`, `"openai/gpt-4.1"`. Sem lock-in de SDK.
- **Fallback automático** Anthropic → OpenAI configurado no Gateway (transparente pra app).
- **Observability nativa** — tokens/latência/custo por request com tag `tenant_id`.
- **Zero data retention** configurável por tenant via header `X-AI-Gateway-Zero-Retention: true`.
- **Pin de versão** controlado no Gateway (mitiga Risco A6).

**Padrão de uso (TypeScript)**:

```ts
import { streamText, generateText, generateObject, embed } from "ai";

// Uso normal — string identifica provider+model; Gateway resolve
const result = await streamText({
  model: "anthropic/claude-sonnet-4-6",
  system: systemPrompt,
  messages: contextMessages,
  temperature: 0.3,
  maxTokens: 1024,
  headers: {
    "X-AI-Gateway-Zero-Retention": tenant.zero_data_retention ? "true" : "false",
    "X-AI-Gateway-Tenant-Id": tenant.id,
  },
  experimental_telemetry: { isEnabled: true, functionId: "bot.respond" },
});
```

**Anti-pattern proibido**: `import Anthropic from "@anthropic-ai/sdk"`. PR é rejeitado.

### 2.2 Modelos

| Uso | Modelo | Justificativa |
|---|---|---|
| Resposta principal do bot | `anthropic/claude-sonnet-4-6` | Qualidade PT-BR + tool use + steerability via system prompt |
| Sentiment binário | `anthropic/claude-haiku-4-5` | Latência <1s, custo ~10× menor que Sonnet, suficiente pra binário |
| Triagem secundária / classificação | `anthropic/claude-haiku-4-5` | Idem |
| Modo throttle (orçamento 100%) | `anthropic/claude-haiku-4-5` | Degrada qualidade controlando custo |
| Embeddings | `openai/text-embedding-3-small` | Custo $0.02/1M tokens, 1536-dim, bom em PT-BR; via AI Gateway |

### 2.3 Vector Store: pgvector vs Supabase Vector — DECISÃO

**Decisão: pgvector**, no mesmo Postgres do CRM.

**Razões**:

1. **Menor lock-in** — Supabase Vector é wrapper proprietário sobre pgvector com APIs específicas; pgvector é o padrão Postgres aberto, portável pra qualquer Postgres (RDS, Cloud SQL, self-hosted).
2. **RLS unificada** — `kb_chunks` herda o mesmo modelo de `fn_user_org_ids()` das outras tabelas. Sem ponte de auth entre serviços.
3. **Joins triviais** — `kb_chunks JOIN ai_knowledge_sources JOIN ai_agents` numa query só, sem RPC.
4. **Custo previsível** — extension grátis no Supabase Postgres; sem billing separado.
5. **Trade-off aceito** — DX um pouco mais crua (queries SQL direto vs API REST) é pago pelo controle fino e pela ausência de surpresa de pricing.

**Configuração**: extension `vector` habilitada via migration. Embedding model fixado em 1536-dim (text-embedding-3-small). Index inicial `ivfflat` (lists=100); migrar pra `hnsw` quando volume passar de 100k chunks por tenant (decisão revisitada na §15.2).

### 2.4 Embeddings: text-embedding-3-small

Default. Razões: barato ($0.02/1M tokens; <$1/mês pra tenant médio com 10k chunks), 1536-dim cabem confortável em ivfflat, qualidade PT-BR comprovada em benchmarks internos da OpenAI. Voyage `voyage-3-large` é opção pós-MVP se qualidade PT-BR provar insuficiente — migração custa só re-indexação total (operação de horas, não dias).

### 2.5 Outras dependências

- **PDF parsing**: `pdf-parse` (Node) com fallback `pdfjs-dist` se layout complexo.
- **Markdown chunking**: `unified` + `remark-parse` pra respeitar headings.
- **Tokenizer pra contagem**: `gpt-tokenizer` (compatível com cl100k_base; aproximação suficiente).
- **PII detection**: regex próprias (CPF, telefone E.164, email, CEP) + lista de nomes próprios PT-BR (heurística).

---

## 3. Schema SQL

Todas as tabelas tenant-aware têm `organization_id uuid not null references organizations(id) on delete cascade` e RLS habilitada com policy `tenant_isolation_<tabela>_all` baseada em `fn_user_org_ids()` (regra T-01).

### 3.1 `ai_agents`

```sql
create table public.ai_agents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  name text not null,
  description text,
  is_active boolean not null default true,
  is_default boolean not null default false,

  -- Modelo & invocação
  model text not null default 'anthropic/claude-sonnet-4-6',
  system_prompt text not null,

  -- Configuração de invocação (jsonb pra evolução sem migration)
  config jsonb not null default jsonb_build_object(
    'temperature', 0.3,
    'max_tokens', 1024,
    'rag_top_k', 5,
    'rag_similarity_threshold', 0.72,
    'context_message_window', 20,
    'confidence_threshold', 0.55,
    'sentiment_threshold', 0.3,
    'zero_data_retention', false
  ),

  -- Guardrails declarativos (formato em §8)
  guardrails jsonb not null default '[]'::jsonb,

  -- Versão da KB ativa (FK lógica pra ai_knowledge_versions)
  active_kb_version_id uuid,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),

  constraint ai_agents_name_unique unique (organization_id, name),
  constraint ai_agents_one_default check (
    -- Garantido por trigger fn_ai_agents_enforce_single_default abaixo
    true
  )
);

create index ai_agents_org_active_idx on public.ai_agents (organization_id) where is_active;
create unique index ai_agents_one_default_per_org on public.ai_agents (organization_id) where is_default;

alter table public.ai_agents enable row level security;
create policy tenant_isolation_ai_agents_all on public.ai_agents for all
  using (organization_id in (select organization_id from public.fn_user_org_ids()))
  with check (organization_id in (select organization_id from public.fn_user_org_ids()));

create trigger trg_ai_agents_audit
  after insert or update or delete on public.ai_agents
  for each row execute function public.fn_audit_log_row();
```

**Notas**:
- `is_default=true` único por tenant via partial unique index (regra: 1 tenant tem N agents mas só 1 default; MVP usa só o default).
- Mudanças de `system_prompt`, `guardrails`, `is_active`, `config` auditadas via `trg_ai_agents_audit` (regra IA-cross com Sub-PRD 01 §3.5).
- `model` pode ser sobrescrito (ex: tenant rodando experimento com Sonnet 4.7) sem mudar código.

### 3.2 `ai_knowledge_sources`

```sql
create table public.ai_knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_id uuid not null references public.ai_agents(id) on delete cascade,

  source_type text not null check (source_type in ('faq', 'policy', 'catalog', 'conversations')),
  source_metadata jsonb not null default '{}'::jsonb,
  -- Para 'faq': { name, locale }
  -- Para 'policy': { filename, version, uploaded_by }
  -- Para 'catalog': { provider: 'nuvemshop', external_account_id }
  -- Para 'conversations': { criteria: 'resolved_with_flag' }

  is_active boolean not null default true,

  -- Telemetria
  last_indexed_at timestamptz,
  last_index_status text check (last_index_status in ('success', 'partial', 'failed')),
  last_index_error text,
  chunks_count integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index ai_knowledge_sources_agent_idx on public.ai_knowledge_sources (agent_id, is_active);
create unique index ai_knowledge_sources_unique_per_agent
  on public.ai_knowledge_sources (agent_id, source_type)
  where is_active;

alter table public.ai_knowledge_sources enable row level security;
create policy tenant_isolation_ai_knowledge_sources_all on public.ai_knowledge_sources for all
  using (organization_id in (select organization_id from public.fn_user_org_ids()))
  with check (organization_id in (select organization_id from public.fn_user_org_ids()));
```

**Notas**:
- Unique parcial: 1 source ativo por tipo por agent. Pra trocar política, marca antiga `is_active=false` e cria nova ativa (mantém histórico).

### 3.3 `ai_chunks`

```sql
create extension if not exists vector;

create table public.ai_chunks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  knowledge_source_id uuid not null references public.ai_knowledge_sources(id) on delete cascade,
  kb_version_id uuid not null,  -- FK lógica para ai_knowledge_versions

  position integer not null,
  content text not null,
  content_hash text not null,  -- sha256 hex pra dedup em re-indexação
  token_count integer not null,
  embedding vector(1536) not null,

  -- Metadados pra filtragem e citação
  metadata jsonb not null default '{}'::jsonb,
  -- Comum: { source_anchor: 'Política #troca', tags: ['frete','prazo'] }
  -- Catálogo: { product_id, product_name, sku, availability }
  -- Conversations: { conversation_id, resolved_at, anonymized: true }

  created_at timestamptz not null default now(),

  constraint ai_chunks_position_unique unique (knowledge_source_id, kb_version_id, position)
);

-- Index vetorial principal — ivfflat com lists=100 cobre até ~100k vetores por tenant
create index ai_chunks_embedding_ivfflat_idx
  on public.ai_chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- Filtros tenant-aware (todos os retrievals filtram org_id antes do KNN)
create index ai_chunks_org_kbv_idx on public.ai_chunks (organization_id, kb_version_id);
create index ai_chunks_source_idx on public.ai_chunks (knowledge_source_id);
create index ai_chunks_metadata_gin_idx on public.ai_chunks using gin (metadata);

alter table public.ai_chunks enable row level security;
create policy tenant_isolation_ai_chunks_all on public.ai_chunks for all
  using (organization_id in (select organization_id from public.fn_user_org_ids()))
  with check (organization_id in (select organization_id from public.fn_user_org_ids()));
```

**Notas**:
- `vector(1536)` casa com text-embedding-3-small. Se trocar pra Voyage 1024 ou outro, exige migration + re-embedding total.
- Decisão **ivfflat vs hnsw**: ivfflat é mais rápido pra criar (segundos), hnsw tem recall melhor mas custa memória/build. MVP escolhe ivfflat com `lists=100` (boa pra 1k–100k vetores). Quando algum tenant passar 100k, criar índice hnsw separado por tenant via partial index ou migrar coleção.
- Pós-criação rodar `ANALYZE ai_chunks` pra atualizar planner.

### 3.4 `ai_knowledge_versions`

```sql
create table public.ai_knowledge_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_id uuid not null references public.ai_agents(id) on delete cascade,

  version_number integer not null,
  description text,
  is_active boolean not null default false,

  -- Snapshot de quais sources estavam ativos quando criada
  sources_snapshot jsonb not null default '[]'::jsonb,
  total_chunks integer not null default 0,

  created_at timestamptz not null default now(),
  activated_at timestamptz,
  activated_by uuid references auth.users(id),

  constraint ai_kbv_version_unique unique (agent_id, version_number)
);

create index ai_kbv_agent_active_idx on public.ai_knowledge_versions (agent_id) where is_active;
create unique index ai_kbv_one_active_per_agent on public.ai_knowledge_versions (agent_id) where is_active;

alter table public.ai_knowledge_versions enable row level security;
create policy tenant_isolation_ai_kbv_all on public.ai_knowledge_versions for all
  using (organization_id in (select organization_id from public.fn_user_org_ids()))
  with check (organization_id in (select organization_id from public.fn_user_org_ids()));
```

**Notas**:
- Re-indexação cria nova versão; ativação é swap atômico (`update ... set is_active=true where id=$1; update ... set is_active=false where agent_id=$2 and id<>$1`). Rollback = reativar versão anterior.
- `ai_chunks.kb_version_id` aponta pra versão; chunks de versões inativas ficam até purge (worker `kb-prune` mantém últimas 3 versões).

### 3.5 `ai_invocations`

```sql
create table public.ai_invocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_id uuid not null references public.ai_agents(id) on delete cascade,

  conversation_id uuid references public.conversations(id) on delete set null,
  message_id uuid references public.messages(id) on delete set null,
  invocation_kind text not null check (invocation_kind in (
    'bot_respond', 'sentiment_classify', 'triage_classify', 'embedding_generate'
  )),

  model text not null,
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  total_tokens integer generated always as (prompt_tokens + completion_tokens) stored,
  latency_ms integer not null,
  cost_cents numeric(10,4) not null default 0,
  finish_reason text,
  -- 'stop' | 'length' | 'guardrail_blocked' | 'error' | 'timeout'

  -- Citações de RAG (snapshot, não FK pra preservar mesmo após purge de chunks)
  citations jsonb not null default '[]'::jsonb,
  -- [{ chunk_id, source_type, source_id, score, kb_version_id }]

  -- Para debug; comprimido + retenção 90d hot, depois cold storage
  prompt_blob_path text,  -- caminho em Supabase Storage (bucket ai-logs)
  response_blob_path text,

  -- Erro estruturado (se finish_reason='error')
  error_payload jsonb,

  created_at timestamptz not null default now()
);

create index ai_invocations_org_created_idx on public.ai_invocations (organization_id, created_at desc);
create index ai_invocations_conversation_idx on public.ai_invocations (conversation_id) where conversation_id is not null;
create index ai_invocations_agent_kind_idx on public.ai_invocations (agent_id, invocation_kind);

alter table public.ai_invocations enable row level security;
create policy tenant_isolation_ai_invocations_all on public.ai_invocations for all
  using (organization_id in (select organization_id from public.fn_user_org_ids()))
  with check (organization_id in (select organization_id from public.fn_user_org_ids()));
```

**Notas**:
- Insert fire-and-forget (worker faz `void` na promessa). Falha de log nunca bloqueia resposta ao cliente.
- `prompt_blob_path`/`response_blob_path` apontam pra `ai-logs` bucket privado; download requer role admin do tenant + audit (regra L-06).
- Custo é calculado a partir de `ai_pricing` table (§3.6).

### 3.6 `ai_pricing` (global, não tenant-aware)

```sql
create table public.ai_pricing (
  model text primary key,
  prompt_cents_per_million_tokens numeric(10,4) not null,
  completion_cents_per_million_tokens numeric(10,4) not null,
  embedding_cents_per_million_tokens numeric(10,4),
  effective_from timestamptz not null default now(),
  superseded_at timestamptz,
  notes text
);

-- Seed inicial (preços referência abr/2026; revisitar trimestralmente)
insert into public.ai_pricing (model, prompt_cents_per_million_tokens, completion_cents_per_million_tokens, embedding_cents_per_million_tokens) values
  ('anthropic/claude-sonnet-4-6', 300.00, 1500.00, null),
  ('anthropic/claude-haiku-4-5', 80.00, 400.00, null),
  ('openai/text-embedding-3-small', null, null, 2.00);
```

Sem RLS (leitura pública por todos os tenants; escrita só por DBA via migration).

### 3.7 `ai_budgets`

```sql
create table public.ai_budgets (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  monthly_limit_cents integer not null default 5000,  -- R$ 50/mês default
  action_at_100pct text not null default 'throttle' check (action_at_100pct in ('throttle', 'disable')),
  alarm_threshold_pct integer not null default 80 check (alarm_threshold_pct between 50 and 99),

  -- Estado runtime (atualizado em rolling window pelo trigger de ai_invocations)
  current_month_consumed_cents numeric(12,4) not null default 0,
  current_period_start date not null default date_trunc('month', now())::date,
  last_alarm_sent_at timestamptz,
  is_throttled boolean not null default false,
  is_disabled boolean not null default false,

  updated_at timestamptz not null default now()
);

alter table public.ai_budgets enable row level security;
create policy tenant_isolation_ai_budgets_all on public.ai_budgets for all
  using (organization_id in (select organization_id from public.fn_user_org_ids()))
  with check (organization_id in (select organization_id from public.fn_user_org_ids()));
```

### 3.8 Indexes globais e extensions

```sql
-- Garantir que extensions existem
create extension if not exists vector;
create extension if not exists pg_trgm;  -- usado em fallback BM25 hybrid (§4.5)
create extension if not exists pgcrypto;
```

---

## 4. Pipeline de Ingestão

Quatro fontes feedam o vector store. Todas seguem o mesmo loop genérico:

```
[gatilho] → emit event_log(`kb_source.changed`) → worker `kb-reindex`
  → fetch source → extract → chunk → embed → upsert ai_chunks
  → snapshot ai_knowledge_versions → swap atômico is_active
```

### 4.1 FAQ manual

**Gatilho**: admin edita FAQ na UI (`POST /api/v1/ai/faq` ou `PATCH /api/v1/ai/faq/:id`). Cada item tem `{ id, question, answer, tags[], locale }`.

**Pipeline**:

```ts
// app/api/v1/ai/faq/route.ts (excerpt)
export async function POST(req: Request) {
  const { agent_id, items } = await req.json();
  // Persiste em ai_faq_items (tabela auxiliar; CRUD direto)
  // ...
  await emitEvent("kb_source.changed", {
    organization_id,
    agent_id,
    source_type: "faq",
    debounce_key: `faq:${agent_id}`,
  });
}
```

**Chunker**: cada item FAQ é 1 chunk (formato: `Pergunta: ...\nResposta: ...\nTags: ...`). Sem overlap (FAQ é auto-contida).

### 4.2 Política da loja (PDF/Markdown)

**Gatilho**: admin faz upload de PDF/MD via UI (`POST /api/v1/ai/policy` multipart). Arquivo vai pro Supabase Storage `ai-policy/${org}/${uuid}.pdf`.

**Pipeline**:

```ts
import pdfParse from "pdf-parse";

async function extractPolicyText(blobPath: string): Promise<string> {
  const blob = await supabaseAdmin.storage.from("ai-policy").download(blobPath);
  if (blobPath.endsWith(".pdf")) {
    const buffer = Buffer.from(await blob.data!.arrayBuffer());
    const parsed = await pdfParse(buffer);
    return parsed.text;
  } else {
    // markdown
    return await blob.data!.text();
  }
}
```

**Chunker**: semantic-aware (split por heading + parágrafo); fallback fixed-size 400 tokens overlap 50.

### 4.3 Catálogo Nuvemshop

**Gatilho**: event consumer escuta `nuvemshop.product_created`, `nuvemshop.product_updated`, `nuvemshop.product_deleted` no event_log (origem: spec 06).

**Pipeline**:

```ts
// workers/kb-catalog-consumer.ts
async function onProductChanged(evt: ProductEvent) {
  if (evt.action === "deleted") {
    await sb.from("ai_chunks")
      .delete()
      .eq("organization_id", evt.organization_id)
      .filter("metadata->>product_id", "eq", String(evt.product_id));
    return;
  }

  const product = await fetchProduct(evt.organization_id, evt.product_id);
  const content = formatProductForRag(product); // template em §11
  const embedding = await embedText(content);

  await sb.from("ai_chunks").upsert({
    organization_id: evt.organization_id,
    knowledge_source_id: evt.catalog_source_id,
    kb_version_id: evt.staging_kbv_id,
    content,
    content_hash: sha256(content),
    token_count: countTokens(content),
    embedding,
    position: 0,  // catalog não usa position semântico
    metadata: {
      product_id: product.id,
      product_name: product.name,
      sku: product.sku,
      availability: product.stock > 0 ? "in_stock" : "out_of_stock",
    },
  }, { onConflict: "knowledge_source_id,kb_version_id,metadata->>product_id" });
}
```

Debounce 30s (regra IA-11): coalesce múltiplos eventos do mesmo produto numa janela curta. Implementação via Redis SET com TTL.

### 4.4 Conversas resolvidas (opt-in)

**Gatilho**: atendente marca `conversation.usable_for_rag=true` na UI (manualmente). Worker `kb-conversations-batch` roda 1×/noite, processa novas marcadas.

**Anonimização** (regra A11):

```ts
const PII_PATTERNS = [
  { name: "cpf",      regex: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, replacement: "[CPF]" },
  { name: "phone",    regex: /\b(?:\+?55\s?)?\(?\d{2}\)?\s?9?\d{4}-?\d{4}\b/g, replacement: "[TELEFONE]" },
  { name: "email",    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: "[EMAIL]" },
  { name: "cep",      regex: /\b\d{5}-?\d{3}\b/g, replacement: "[CEP]" },
];

const FIRST_NAMES_PT_BR = new Set([/* lista de ~5k nomes próprios brasileiros */]);

function anonymize(text: string): { sanitized: string; hits: PiiHit[] } {
  let out = text;
  const hits: PiiHit[] = [];
  for (const p of PII_PATTERNS) {
    out = out.replace(p.regex, (match) => {
      hits.push({ type: p.name, original_length: match.length });
      return p.replacement;
    });
  }
  // Heurística pra nomes próprios: capitalizado + match no dicionário
  out = out.replace(/\b([A-Z][a-zà-ú]{2,})\b/g, (match) => {
    if (FIRST_NAMES_PT_BR.has(match.toLowerCase())) {
      hits.push({ type: "name", original_length: match.length });
      return "[NOME]";
    }
    return match;
  });
  return { sanitized: out, hits };
}
```

**Validador automático**: se `hits.length === 0` numa conversa de 10+ mensagens, flagga pra revisão manual (suspeita de PII não detectada).

### 4.5 Chunking strategy

Default genérico: **fixed-size com overlap, semantic-aware quando heading disponível**.

```ts
type ChunkOptions = {
  targetTokens: number;   // default 400
  overlapTokens: number;  // default 50
  splitOnHeadings: boolean; // default true
};

function chunkText(text: string, opts: ChunkOptions): Chunk[] {
  const sections = opts.splitOnHeadings ? splitByHeadings(text) : [text];
  const chunks: Chunk[] = [];

  for (const section of sections) {
    const tokens = tokenize(section.body);
    if (tokens.length <= opts.targetTokens) {
      chunks.push({ content: section.body, anchor: section.heading });
      continue;
    }

    // Janela deslizante por sentença
    const sentences = splitBySentence(section.body);
    let buffer: string[] = [];
    let bufferTokens = 0;
    for (const s of sentences) {
      const sTok = countTokens(s);
      if (bufferTokens + sTok > opts.targetTokens && buffer.length > 0) {
        chunks.push({ content: buffer.join(" "), anchor: section.heading });
        // overlap: mantém últimas N tokens
        const tail = takeLastTokens(buffer, opts.overlapTokens);
        buffer = [tail];
        bufferTokens = countTokens(tail);
      }
      buffer.push(s);
      bufferTokens += sTok;
    }
    if (buffer.length > 0) {
      chunks.push({ content: buffer.join(" "), anchor: section.heading });
    }
  }
  return chunks;
}
```

**Por fonte**:
- FAQ: 1 item = 1 chunk (não chunka mais).
- Política: 400/50 com split por heading markdown (`#`, `##`).
- Catálogo: 1 produto = 1 chunk (formato curto; nunca passa de 300 tokens).
- Conversas: agrupa turnos em janelas de ~400 tokens.

### 4.6 Versionamento e rollback

```ts
// Pseudocódigo do worker kb-reindex
async function reindex(agentId: string, sources: KnowledgeSource[]) {
  const newVersion = await createKnowledgeVersion(agentId);
  try {
    for (const src of sources) {
      const items = await loadItems(src);
      for (const item of items) {
        const chunks = chunkText(item.text, item.chunkOpts);
        const embeddings = await embedBatch(chunks.map(c => c.content));
        await sb.from("ai_chunks").insert(chunks.map((c, i) => ({
          organization_id: src.organization_id,
          knowledge_source_id: src.id,
          kb_version_id: newVersion.id,
          position: i,
          content: c.content,
          content_hash: sha256(c.content),
          token_count: countTokens(c.content),
          embedding: embeddings[i],
          metadata: c.metadata,
        })));
      }
    }
    // Swap atômico
    await sb.rpc("activate_kb_version", { p_agent_id: agentId, p_version_id: newVersion.id });
  } catch (e) {
    await markVersionFailed(newVersion.id, e);
    throw e;
  }
}
```

```sql
-- RPC para swap atômico
create or replace function public.activate_kb_version(p_agent_id uuid, p_version_id uuid)
returns void language plpgsql security definer as $$
begin
  update public.ai_knowledge_versions set is_active = false
    where agent_id = p_agent_id and id <> p_version_id;
  update public.ai_knowledge_versions set is_active = true, activated_at = now()
    where id = p_version_id;
  update public.ai_agents set active_kb_version_id = p_version_id, updated_at = now()
    where id = p_agent_id;
end;
$$;
```

**Rollback**: admin clica "reativar versão N" → mesma RPC com `p_version_id = N` → swap em <2s.

---

## 5. Roteamento da Chamada do Bot

### 5.1 Trigger e fluxo

```
WAHA webhook → spec 03 persiste message → emit event_log("message.received", { message_id, conversation_id })
                                            │
                                            ├── worker `triage-pre-bot` (síncrono, bloqueia)
                                            │     ├── G1 regex pedido humano? → handoff, return
                                            │     ├── G4 regex jurídico? → handoff, return
                                            │     └── pass through
                                            │
                                            ├── worker `bot-respond` (depois de triage pass)
                                            │
                                            └── worker `sentiment-classify` (paralelo, fire-and-forget)
```

Triage roda primeiro porque é barato (regex local) e curto-circuita o bot. `bot-respond` só executa se triage não disparou handoff.

### 5.2 Construção de contexto

```ts
// workers/bot-respond.ts
async function buildContext(messageId: string): Promise<BotContext> {
  const { data: msg } = await sb.from("messages").select("*, conversation:conversations(*, contact:contacts(*))").eq("id", messageId).single();
  const conv = msg.conversation;
  const contact = conv.contact;

  const agent = await loadActiveAgent(msg.organization_id);
  if (!agent) return { skip: "no_active_agent" };
  if (contact.is_blocked) return { skip: "contact_blocked" };
  if (contact.force_human) return { skip: "force_human" };
  if (await isOutsideWindow24h(contact)) return { skip: "window_24h_expired" };
  if (await isBudgetExhausted(msg.organization_id)) return { skip: "budget_exhausted" };

  // Janela 24h: mas inbound recém chegou então last_inbound_at é agora; OK
  // Esta check protege caso bot tente proativo (pós-MVP)

  // Últimas N mensagens
  const window = agent.config.context_message_window ?? 20;
  const { data: recentMsgs } = await sb.from("messages")
    .select("id, direction, body, created_at")
    .eq("conversation_id", conv.id)
    .order("created_at", { ascending: false })
    .limit(window);
  const messagesAsc = recentMsgs!.reverse();

  // Último pedido linkado
  const lastOrder = await fetchLastLinkedOrder(conv.lead_id);

  // RAG retrieval
  const queryEmbedding = await embedText(msg.body);
  const ragHits = await retrieveTopK({
    organization_id: msg.organization_id,
    kb_version_id: agent.active_kb_version_id,
    embedding: queryEmbedding,
    k: agent.config.rag_top_k ?? 5,
    threshold: agent.config.rag_similarity_threshold ?? 0.72,
  });

  // System prompt com placeholders renderizados (§11)
  const systemPrompt = renderSystemPrompt(agent.system_prompt, {
    tenant_name: contact.organization.name,
    vocabulary: conv.lead.pipeline.vocabulary,
    contact: { name: contact.name, tags: contact.tags },
    last_order: lastOrder,
    rag_chunks: ragHits,
    guardrails: agent.guardrails,
    current_datetime: new Date().toISOString(),
  });

  return {
    skip: null,
    agent,
    systemPrompt,
    messagesAsc,
    ragHits,
    contact,
    conversation: conv,
  };
}
```

### 5.3 Retrieval no pgvector

```ts
async function retrieveTopK(opts: {
  organization_id: string;
  kb_version_id: string;
  embedding: number[];
  k: number;
  threshold: number;
}): Promise<RagHit[]> {
  // Vector format: "[0.1,0.2,...]"
  const embStr = `[${opts.embedding.join(",")}]`;
  const { data, error } = await sb.rpc("retrieve_top_k_chunks", {
    p_organization_id: opts.organization_id,
    p_kb_version_id: opts.kb_version_id,
    p_embedding: embStr,
    p_k: opts.k,
    p_threshold: opts.threshold,
  });
  if (error) throw error;
  return data;
}
```

```sql
create or replace function public.retrieve_top_k_chunks(
  p_organization_id uuid,
  p_kb_version_id uuid,
  p_embedding vector(1536),
  p_k integer,
  p_threshold real
)
returns table (
  chunk_id uuid,
  content text,
  metadata jsonb,
  source_type text,
  knowledge_source_id uuid,
  score real
)
language sql stable security definer set search_path = public as $$
  select
    c.id as chunk_id,
    c.content,
    c.metadata,
    s.source_type,
    c.knowledge_source_id,
    1 - (c.embedding <=> p_embedding) as score
  from public.ai_chunks c
  join public.ai_knowledge_sources s on s.id = c.knowledge_source_id
  where c.organization_id = p_organization_id
    and c.kb_version_id = p_kb_version_id
    and s.is_active = true
    and (1 - (c.embedding <=> p_embedding)) >= p_threshold
  order by c.embedding <=> p_embedding
  limit p_k;
$$;
```

**Crítico**: a função é `security definer` mas filtra `organization_id` explícito (defesa em profundidade — regra A5). RLS continua aplicada via `ai_chunks` policy se chamada via cliente normal; quando chamada por worker (service role), o filtro programático protege.

### 5.4 Stream response

```ts
import { streamText } from "ai";

async function invokeBot(ctx: BotContext): Promise<BotResponse> {
  const start = Date.now();
  const result = streamText({
    model: ctx.agent.model,
    system: ctx.systemPrompt,
    messages: ctx.messagesAsc.map(m => ({
      role: m.direction === "inbound" ? "user" : "assistant",
      content: m.body ?? "",
    })),
    temperature: ctx.agent.config.temperature ?? 0.3,
    maxTokens: ctx.agent.config.max_tokens ?? 1024,
    headers: {
      "X-AI-Gateway-Zero-Retention": ctx.agent.config.zero_data_retention ? "true" : "false",
      "X-AI-Gateway-Tenant-Id": ctx.agent.organization_id,
    },
    experimental_telemetry: { isEnabled: true, functionId: "bot.respond" },
  });

  // Stream consume — no MVP não streamamos pra o cliente (WhatsApp não suporta);
  // mas usamos streamText pra captura cedo de tokens e cancel se guardrail violado mid-stream
  let fullText = "";
  for await (const delta of result.textStream) {
    fullText += delta;
    if (detectMidStreamViolation(fullText, ctx.agent.guardrails)) {
      await result.controller?.abort();
      return { kind: "guardrail_blocked_mid_stream", reason: "...", partial: fullText };
    }
  }

  const usage = await result.usage;
  const latencyMs = Date.now() - start;
  return {
    kind: "ok",
    text: fullText,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    latencyMs,
    finishReason: await result.finishReason,
  };
}
```

### 5.5 Pós-processamento

```ts
async function postProcess(rsp: BotResponse, ctx: BotContext): Promise<PostProcessResult> {
  // 1. Validar guardrails programaticamente (defesa em profundidade)
  const guardrailResult = await validateGuardrails(rsp.text, ctx);
  if (guardrailResult.blocked) {
    return { action: "handoff", reason: guardrailResult.reason };
  }

  // 2. Detectar incerteza (G3)
  if (containsUncertaintyMarkers(rsp.text)) {
    return { action: "handoff", reason: "ai_uncertainty_marker" };
  }
  const confidence = computeConfidence(rsp, ctx.ragHits);
  if (confidence < ctx.agent.config.confidence_threshold) {
    return { action: "handoff", reason: "low_confidence", confidence };
  }

  // 3. Extrair citations
  const citations = extractCitations(rsp.text, ctx.ragHits);

  return {
    action: "send",
    text: rsp.text,
    confidence,
    citations,
  };
}
```

### 5.6 Persistência outbound

```ts
async function persistAndDispatch(result: PostProcessResult, ctx: BotContext) {
  if (result.action === "handoff") {
    await triggerHandoff(ctx, result.reason);
    return;
  }

  // 1. Insert message status='sending' (otimismo — spec 03 pattern)
  const { data: msg } = await sb.from("messages").insert({
    organization_id: ctx.contact.organization_id,
    conversation_id: ctx.conversation.id,
    direction: "outbound",
    body: result.text,
    status: "sending",
    metadata: {
      ai_generated: true,
      ai_agent_id: ctx.agent.id,
      ai_invocation_id: ctx.invocation.id,
      confidence_score: result.confidence,
      citations: result.citations,
    },
  }).select().single();

  // 2. Activity ai_responded
  await sb.from("crm_lead_activities").insert({
    organization_id: ctx.contact.organization_id,
    lead_id: ctx.conversation.lead_id,
    type: "ai_responded",
    source_module: "ai_bot",
    source_id: msg.id,
    metadata: {
      tokens: ctx.invocation.totalTokens,
      latency_ms: ctx.invocation.latencyMs,
      confidence_score: result.confidence,
      citations: result.citations,
    },
  });

  // 3. Emit event pra worker outbound dispatcher (spec 03)
  await emitEvent("message.send_requested", { message_id: msg.id });
}
```

---

## 6. Sentiment Detection

### 6.1 Worker paralelo

```ts
// workers/sentiment-classify.ts
async function onMessageReceived(evt: MessageReceivedEvent) {
  const { data: msg } = await sb.from("messages").select("*, conversation:conversations(*, contact:contacts(*))").eq("id", evt.message_id).single();
  if (msg.direction !== "inbound" || !msg.body) return;

  const start = Date.now();
  const result = await generateObject({
    model: "anthropic/claude-haiku-4-5",
    schema: z.object({
      sentiment_score: z.number().min(0).max(1),
      reasoning_short: z.string().max(100),
    }),
    system: SENTIMENT_SYSTEM_PROMPT,
    prompt: `Mensagem: """${msg.body}"""`,
    temperature: 0,
    maxTokens: 80,
  });

  const score = result.object.sentiment_score;
  const latencyMs = Date.now() - start;

  await sb.from("messages").update({
    metadata: { ...msg.metadata, sentiment_score: score, sentiment_latency_ms: latencyMs },
  }).eq("id", msg.id);

  await logInvocation({
    kind: "sentiment_classify",
    organization_id: msg.organization_id,
    message_id: msg.id,
    model: "anthropic/claude-haiku-4-5",
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    latencyMs,
  });

  // Avaliar G2
  const tenantThreshold = await getSentimentThreshold(msg.organization_id);
  if (score < tenantThreshold) {
    await triggerHandoff({
      conversation_id: msg.conversation_id,
      reason: "low_sentiment",
      metadata: { sentiment_score: score },
    });
  }
}
```

### 6.2 Prompt do classificador

Ver §11.2 para texto completo. Usa `generateObject` com Zod schema pra garantir output estruturado (não-textual).

### 6.3 Falha graceful

Se invocação falha (timeout, rede, Gateway down), worker loga warning + segue. Bot principal não é afetado. G2 simplesmente não dispara naquele inbound. Threshold check em workers subsequentes pode pegar outras mensagens.

---

## 7. Handoff Automático

### 7.1 G1 — Pedido explícito (síncrono pré-bot)

```ts
const G1_REGEX = /\b(humano|atendente|pessoa|gente real|falar com algu[eé]m|n[aã]o quero (bot|rob[oô])|quero falar com|quero atendimento humano)\b/i;

async function checkG1(messageBody: string): Promise<boolean> {
  return G1_REGEX.test(messageBody ?? "");
}
```

### 7.2 G2 — Sentiment (assíncrono)

Avaliado no worker de sentiment depois de gravar score (§6.1).

### 7.3 G3 — Incerteza IA (pós-resposta, pré-despacho)

Duas vias:

```ts
const UNCERTAINTY_MARKERS = [
  /\bn[aã]o sei\b/i,
  /\bn[aã]o tenho certeza\b/i,
  /\bvou (verificar|consultar|confirmar)\b/i,
  /\bdeixa eu (confirmar|verificar)\b/i,
  /\bn[aã]o consigo (ajudar|responder)\b/i,
];

function containsUncertaintyMarkers(text: string): boolean {
  return UNCERTAINTY_MARKERS.some(r => r.test(text));
}

function computeConfidence(rsp: BotResponse, ragHits: RagHit[]): number {
  // Heurística composta:
  // - Score médio dos RAG hits (50%)
  // - Penalidade por response curta (<30 chars) (20%)
  // - Bonus por response com citação (15%)
  // - Penalidade por marcadores fracos (15%)
  let conf = 0;
  const ragScore = ragHits.length > 0 ? ragHits.reduce((s, h) => s + h.score, 0) / ragHits.length : 0.4;
  conf += 0.5 * ragScore;
  conf += rsp.text.length >= 30 ? 0.2 : 0.05;
  conf += hasCitation(rsp.text, ragHits) ? 0.15 : 0;
  conf += hasWeakMarker(rsp.text) ? 0 : 0.15;
  return Math.min(1, conf);
}
```

Threshold default: 0.55 (config `confidence_threshold`).

### 7.4 G4 — Estágio crítico

Avaliado quando o lead está em stage com `requires_human=true` (config no schema do pipeline da spec 04). Bot consulta antes de invocar:

```ts
async function checkG4(leadId: string): Promise<{ trigger: boolean; reason?: string }> {
  const { data } = await sb.from("crm_leads").select("stage:crm_stages(requires_human)").eq("id", leadId).single();
  if (data.stage?.requires_human) return { trigger: true, reason: "critical_stage" };

  return { trigger: false };
}
```

Adicionalmente o regex de fraude/jurídico (IA-09) entra como sub-caso de G4 e roda síncrono no triage:

```ts
const G4_LEGAL_REGEX = /\b(fraude|estelionato|pol[ií]cia|justi[çc]a|processo|advogad[oa]?|ANPD|procon|jur[ií]dic[oa])\b/i;
```

### 7.5 Ação de handoff

```ts
async function triggerHandoff(opts: HandoffOpts) {
  const { conversation_id, reason, metadata = {} } = opts;

  // 1. Atualiza conversation.status (spec 04 owns this column)
  await sb.from("conversations").update({
    status: "pending",
    last_handoff_at: new Date().toISOString(),
    last_handoff_reason: reason,
  }).eq("id", conversation_id);

  // 2. Activity polimórfica
  await sb.from("crm_lead_activities").insert({
    organization_id: opts.organization_id,
    lead_id: opts.lead_id,
    type: "handoff_triggered",
    source_module: "ai_bot",
    source_id: conversation_id,
    metadata: {
      trigger_reason: reason,
      ...metadata,
      timestamp: new Date().toISOString(),
    },
  });

  // 3. Emit event_log para roteamento (spec 04 worker `auto-assignment` consome)
  await emitEvent("conversation.handoff_triggered", {
    conversation_id,
    organization_id: opts.organization_id,
    reason,
  });

  // 4. Realtime broadcast para atendentes online
  await sb.channel(`org:${opts.organization_id}:queue`)
    .send({ type: "broadcast", event: "handoff_pending", payload: { conversation_id, reason } });
}
```

### 7.6 Política de retomada

Default IA-06: bot **não reassume**. `conversations.bot_silenced_until` (timestamptz) é setado pra `'infinity'` no handoff. Atendente clica "Passar pra IA" → endpoint:

```ts
// POST /api/v1/conversations/:id/reactivate-bot
// requires role >= agent
// audita ai_reactivated_by_agent
```

Próxima conversation no mesmo contact (status=resolved + nova abertura) começa com bot, exceto `contacts.force_human=true`.

---

## 8. Guardrails LLM

Stored em `ai_agents.guardrails jsonb` como array de regras declarativas.

### 8.1 Formato

```jsonc
[
  {
    "id": "no_refund_promise",
    "kind": "regex_output_block",
    "pattern": "(reembols|estorn|devolv|ressarc|cr[eé]dit)",
    "flags": "i",
    "action": "handoff",
    "reason": "refund_mention",
    "doc": "IA-07: nunca prometer ressarcimento"
  },
  {
    "id": "product_outside_catalog",
    "kind": "rag_must_hit",
    "topic_intent": "product_inquiry",
    "min_score": 0.7,
    "action": "handoff",
    "reason": "product_outside_catalog",
    "doc": "IA-08"
  },
  {
    "id": "legal_fraud_input",
    "kind": "regex_input_block",
    "pattern": "(fraude|estelionato|pol[ií]cia|justi[çc]a|processo|advogad|ANPD|procon|jur[ií]dic)",
    "flags": "i",
    "action": "handoff_immediate",
    "reason": "legal_mention",
    "doc": "IA-09"
  },
  {
    "id": "window_24h",
    "kind": "window_check",
    "max_hours_since_inbound": 24,
    "action": "block_outbound",
    "reason": "window_24h_expired",
    "doc": "IA-01"
  },
  {
    "id": "respect_blocked",
    "kind": "contact_flag",
    "field": "is_blocked",
    "expected": true,
    "action": "block_outbound",
    "reason": "contact_blocked",
    "doc": "IA-02"
  }
]
```

### 8.2 Validador

```ts
async function validateGuardrails(text: string, ctx: BotContext): Promise<GuardrailResult> {
  for (const rule of ctx.agent.guardrails) {
    switch (rule.kind) {
      case "regex_output_block": {
        const r = new RegExp(rule.pattern, rule.flags ?? "");
        if (r.test(text)) return { blocked: true, reason: rule.reason };
        break;
      }
      case "rag_must_hit": {
        const intent = await classifyIntent(ctx.lastInboundText);
        if (intent === rule.topic_intent) {
          const hasHit = ctx.ragHits.some(h => h.score >= rule.min_score && h.source_type === "catalog");
          if (!hasHit) return { blocked: true, reason: rule.reason };
        }
        break;
      }
      // demais casos (window, contact_flag) já avaliados em buildContext
    }
  }
  return { blocked: false };
}
```

### 8.3 Aplicação dual

Cada guardrail aparece em **dois lugares**:

1. **Instrução no system prompt** (§11.1) — "Se cliente pedir reembolso, responda 'vou verificar com nossa equipe' e nada mais. Não prometa devolução."
2. **Validador programático** — regex pós-resposta acima.

Defesa em profundidade: modelo pode ignorar prompt; validador intercepta.

---

## 9. Citações

Persistidas em `messages.metadata.citations` e em `ai_invocations.citations`. Snapshot — não FK pra preservar mesmo após purge de chunks de versões antigas.

```ts
type Citation = {
  chunk_id: string;
  source_type: "faq" | "policy" | "catalog" | "conversations";
  knowledge_source_id: string;
  kb_version_id: string;
  score: number;
};
```

UI debug do atendente exibe citations ao expandir mensagem do bot. **Não** vai pro cliente final no MVP (resposta WhatsApp vai limpa).

---

## 10. Logging & Custo

### 10.1 Insert em `ai_invocations`

Cada chamada LLM grava 1 linha. Insert é fire-and-forget no path crítico do bot:

```ts
queueMicrotask(async () => {
  try {
    await sb.from("ai_invocations").insert({ /* ... */ });
  } catch (e) {
    logger.warn("ai_invocation_log_failed", { e });
  }
});
```

### 10.2 Cálculo de custo

```ts
async function computeCost(model: string, promptTokens: number, completionTokens: number): Promise<number> {
  const { data: pricing } = await sb.from("ai_pricing").select("*").eq("model", model).single();
  if (!pricing) return 0;
  const promptCost = (promptTokens / 1_000_000) * pricing.prompt_cents_per_million_tokens;
  const completionCost = (completionTokens / 1_000_000) * pricing.completion_cents_per_million_tokens;
  return Number((promptCost + completionCost).toFixed(4));
}
```

### 10.3 Trigger de orçamento

```sql
create or replace function public.fn_ai_invocation_update_budget()
returns trigger language plpgsql as $$
declare
  v_budget public.ai_budgets;
begin
  -- Reset mensal lazy
  update public.ai_budgets
    set current_month_consumed_cents = 0,
        current_period_start = date_trunc('month', now())::date,
        last_alarm_sent_at = null,
        is_throttled = false,
        is_disabled = false
    where organization_id = new.organization_id
      and current_period_start < date_trunc('month', now())::date;

  update public.ai_budgets
    set current_month_consumed_cents = current_month_consumed_cents + new.cost_cents,
        updated_at = now()
    where organization_id = new.organization_id
    returning * into v_budget;

  -- Alarme 80%
  if v_budget.current_month_consumed_cents >= v_budget.monthly_limit_cents * v_budget.alarm_threshold_pct / 100.0
     and v_budget.last_alarm_sent_at is null then
    insert into public.event_log (event_type, payload)
      values ('ai_budget.alarm_threshold_reached',
              jsonb_build_object('organization_id', new.organization_id, 'consumed_pct', 80));
    update public.ai_budgets set last_alarm_sent_at = now() where organization_id = new.organization_id;
  end if;

  -- Ação 100%
  if v_budget.current_month_consumed_cents >= v_budget.monthly_limit_cents then
    if v_budget.action_at_100pct = 'throttle' then
      update public.ai_budgets set is_throttled = true where organization_id = new.organization_id;
    else
      update public.ai_budgets set is_disabled = true where organization_id = new.organization_id;
    end if;
    insert into public.event_log (event_type, payload)
      values ('ai_budget.exhausted',
              jsonb_build_object('organization_id', new.organization_id, 'action', v_budget.action_at_100pct));
  end if;

  return new;
end;
$$;

create trigger trg_ai_invocation_update_budget
  after insert on public.ai_invocations
  for each row execute function public.fn_ai_invocation_update_budget();
```

### 10.4 Dashboard

Endpoint `GET /api/v1/ai/usage?period=current_month` retorna:

```json
{
  "data": {
    "period": { "start": "2026-04-01", "end": "2026-04-28" },
    "consumed_cents": 4234.50,
    "limit_cents": 5000,
    "consumed_pct": 84.7,
    "is_throttled": false,
    "is_disabled": false,
    "by_model": [
      { "model": "anthropic/claude-sonnet-4-6", "invocations": 8234, "tokens_total": 4123455, "cost_cents": 3987.20 },
      { "model": "anthropic/claude-haiku-4-5", "invocations": 9123, "tokens_total": 1234567, "cost_cents": 247.30 }
    ],
    "by_kind": [
      { "invocation_kind": "bot_respond", "count": 8234, "avg_latency_ms": 2150 },
      { "invocation_kind": "sentiment_classify", "count": 9123, "avg_latency_ms": 870 }
    ],
    "handoff_rate_pct": 38.5,
    "trend_vs_previous_month_pct": 12.3
  }
}
```

UI admin renderiza com Recharts (linha temporal + breakdown por modelo).

---

## 11. Prompts Canônicos

### 11.1 System prompt template (PT-BR, default)

```
Você é o assistente virtual da {{tenant_name}}, uma loja online.
Seu papel é atender {{vocabulary.lead_plural}} com cordialidade, eficiência e precisão. Trate o cliente em português brasileiro, tom claro e direto, evitando jargão técnico.

CONTEXTO DO CLIENTE:
- Nome: {{contact.name}}
- Tags: {{contact.tags}}
{{#if last_order}}
- Último pedido: #{{last_order.number}} | Status: {{last_order.status}} | Valor: R$ {{last_order.total}} | Data: {{last_order.created_at}}
{{/if}}

DATA E HORA ATUAL: {{current_datetime}}

BASE DE CONHECIMENTO RELEVANTE (top {{rag_chunks.length}} resultados):
{{#each rag_chunks}}
[{{@index}}] (fonte: {{source_type}} | score: {{score}})
{{content}}
---
{{/each}}

REGRAS DE COMPORTAMENTO (não negociáveis):
1. NUNCA prometa reembolso, estorno, devolução, ressarcimento ou crédito sem confirmar com a equipe humana. Se o cliente pedir, responda apenas "Vou verificar isso com nossa equipe e te respondo em breve" e nada mais.
2. NUNCA fale de produtos que não estejam na base de conhecimento (catálogo). Se o cliente perguntar de produto não listado, diga "Vou verificar a disponibilidade com nossa equipe".
3. Se o cliente mencionar fraude, polícia, justiça, processo, ANPD, advogado, Procon ou termos jurídicos: NÃO responda nada além de "Vou direcionar você para nossa equipe especializada".
4. Se você não souber a resposta com certeza, diga "Vou verificar com nossa equipe" — não invente informação.
5. Use SEMPRE a base de conhecimento acima como fonte da verdade. Se a resposta não estiver lá, escale para humano.
6. Mantenha respostas curtas (idealmente 2-4 frases). WhatsApp não é blog.
7. Não use emojis excessivos (máximo 1 por mensagem, e só quando agregar).
8. Não peça dados sensíveis (CPF de terceiros, senha, dados bancários completos).
9. Sempre que citar pedido, use o número exato do contexto. Não invente número.
10. Se não houver pedido no contexto e o cliente perguntar de pedido, peça o número do pedido educadamente.

FORMATO DA RESPOSTA:
- Apenas o texto da mensagem que vai pro cliente. Sem prefixos como "Resposta:" ou "Bot:".
- Sem markdown (asteriscos, hashes). WhatsApp renderiza em texto plano.

Agora responda à última mensagem do cliente.
```

Renderização via Mustache-like simples (escolha sobre Handlebars: dependência menor, sem helpers, suficiente). Implementação custom de ~50 linhas.

### 11.2 Sentiment classifier prompt (Haiku 4.5)

```
Você é um classificador de sentimento de mensagens de clientes em atendimento de e-commerce no WhatsApp.

Sua tarefa: avaliar o nível de FRUSTRAÇÃO do cliente na mensagem fornecida.

Output: JSON com:
- sentiment_score: número entre 0.0 e 1.0
  - 0.0 = altamente frustrado, irritado, agressivo, ameaçando deixar a loja, palavrões
  - 0.5 = neutro
  - 1.0 = satisfeito, gentil, paciente, agradecido
- reasoning_short: explicação em até 100 caracteres (português)

Considere contexto cultural brasileiro:
- "Tô puto" / "Que absurdo" / "Inadmissível" → alta frustração (score < 0.3)
- "Por favor" / "Obrigado" / "Show" → satisfação (score > 0.7)
- Pergunta neutra ou fatual → neutro (score ~0.5)
- Pedido educado mas com urgência ("Preciso urgente") → score ~0.45
- Repetição de pergunta ("Já te perguntei isso 3 vezes") → frustração (score < 0.4)

Responda APENAS o JSON. Nada mais.
```

### 11.3 Few-shot examples (opt-in)

Quando `ai_agents.config.enable_few_shot=true`, system prompt inclui bloco extra com 3 exemplos curados pelo admin do tenant (vindos de conversas anonimizadas marcadas como exemplares). Limit: 3 exemplos × 200 tokens = 600 tokens extras de prompt.

---

## 12. Re-indexação Incremental

### 12.1 Event consumers

```ts
// workers/kb-event-consumer.ts
const DEBOUNCE_MS = 30_000;

async function onKbSourceChanged(evt: KbChangeEvent) {
  const debounceKey = `kb-debounce:${evt.organization_id}:${evt.agent_id}:${evt.source_type}`;
  // Se há marker recente, não re-enfileira
  const exists = await redis.set(debounceKey, "1", "NX", "PX", DEBOUNCE_MS);
  if (!exists) return;

  // Agenda execução em DEBOUNCE_MS — coalesce eventos múltiplos
  setTimeout(() => reindexAgentSource(evt.agent_id, evt.source_type), DEBOUNCE_MS);
}
```

### 12.2 SLA

- Edit FAQ → bot usa novo conteúdo em ≤30s p95.
- Upload PDF → re-indexação completa em ≤5min pra documento de até 50 páginas.
- `nuvemshop.product_updated` → chunk atualizado em ≤30s p95 (regra IA-11).
- Re-indexação em massa de 1k itens em ≤5min.

Alerta Sentry se lag médio > 5min sustained.

---

## 13. Modo "Humano Sempre"

### 13.1 Por tenant

```sql
alter table public.organizations add column ai_disabled boolean not null default false;
```

Quando `true`, worker `bot-respond` retorna `skip: "ai_disabled_at_org_level"` cedo. Inbounds entram direto na fila com `conversation.status='pending'`.

Override por admin:
```http
PATCH /api/v1/admin/ai-settings
{ "ai_disabled": true }
```
Auditado.

### 13.2 Por contact

```sql
alter table public.contacts add column force_human boolean not null default false;
```

Quando `true`, bot nunca responde. UI mostra badge "Humano forçado" + botão "Reativar IA" (manager+).

### 13.3 Combinação

```ts
async function shouldBotRespond(ctx: BotContext): Promise<{ ok: boolean; reason?: string }> {
  if (ctx.contact.organization.ai_disabled) return { ok: false, reason: "ai_disabled_at_org" };
  if (ctx.contact.force_human) return { ok: false, reason: "force_human" };
  if (!ctx.agent || !ctx.agent.is_active) return { ok: false, reason: "no_active_agent" };
  if (ctx.budget.is_disabled) return { ok: false, reason: "budget_exhausted_disabled" };
  if (ctx.budget.is_throttled) {
    // Modo throttle: usa Haiku em vez de Sonnet
    ctx.agent = { ...ctx.agent, model: "anthropic/claude-haiku-4-5" };
  }
  return { ok: true };
}
```

---

## 14. Plano de Validação

### 14.1 Testes unitários

- `chunkText` com headings markdown, fixed-size fallback, overlap.
- `anonymize` com payloads contendo CPF/telefone/email/CEP — validar todas as substituições.
- `validateGuardrails` para cada `kind` declarado.
- `computeConfidence` em casos limite (sem RAG, RAG fraco, response curta).
- Renderização de system prompt com placeholders ausentes → fallback graceful.

### 14.2 Testes de integração

- Fluxo end-to-end: simular `message.received` → bot responde → activity gravada → ai_invocations contém linha.
- Handoff G1: inbound "quero falar com humano" → conversation.status='pending' em <500ms; sem outbound do bot.
- Handoff G2: mock sentiment retornando 0.15 (threshold 0.3) → handoff em <2s.
- Handoff G3: mock LLM retornando "não sei como ajudar" → bot retém, dispara handoff.
- Handoff G4: lead em stage requires_human=true → bot nem invoca.
- Guardrail ressarcimento: mock LLM retornando "vou te dar reembolso" → handoff (não envia).
- Guardrail produto fora catálogo: pergunta sobre produto inexistente → handoff.
- Re-indexação: edit FAQ → query vetorial retorna conteúdo novo em <30s.
- Rollback de KB: ativar versão anterior → query usa chunks antigos em <2s.

### 14.3 Testes de isolamento cross-tenant

CI obrigatório (regra A5):

- Criar 2 tenants A e B, cada um com agent + chunks distintos.
- Forçar query `retrieve_top_k_chunks(p_organization_id=B.id, ...)` sob contexto auth de A.
- Validar: retorno vazio + alerta logado.

### 14.4 Testes de carga

- 50 inbounds concorrentes em 1 tenant → bot responde todos em <3s p95.
- Re-indexação total de 1k chunks em <5min.
- Sentiment 100 inbounds em 60s sem afetar bot main.

### 14.5 Testes de custo

- Simulação de 10k mensagens/mês com modelo de tráfego típico (60% bot, 40% handoff): custo total ≤ R$ 50/mês com setup default.
- Validar diff <2% entre `ai_invocations.cost_cents` e fatura do AI Gateway.

---

## 15. Migrations

### 15.1 Ordem

```
20260501_001_ai_extensions.sql       -- create extension vector, pg_trgm
20260501_002_ai_agents.sql           -- ai_agents + RLS + audit trigger
20260501_003_ai_knowledge.sql        -- ai_knowledge_sources, ai_knowledge_versions, ai_chunks
20260501_004_ai_invocations.sql      -- ai_invocations + RLS
20260501_005_ai_pricing.sql          -- ai_pricing seed
20260501_006_ai_budgets.sql          -- ai_budgets + trigger fn_ai_invocation_update_budget
20260501_007_ai_rpc_retrieve.sql     -- function retrieve_top_k_chunks + activate_kb_version
20260501_008_org_ai_disabled.sql     -- alter organizations add ai_disabled
20260501_009_contacts_force_human.sql-- alter contacts add force_human
20260501_010_conversation_handoff.sql-- alter conversations add last_handoff_*, bot_silenced_until
20260501_011_seed_default_agent.sql  -- trigger pra criar default agent no signup
```

### 15.2 Rollback

Cada migration tem `.down.sql` correspondente. `vector` extension não é dropada em rollback (persistir; futuro uso). Re-running idempotente via `if not exists`.

### 15.3 Decisão de migração ivfflat → hnsw

Quando algum tenant ultrapassar 100k chunks: criar índice hnsw paralelo, validar latência, dropar ivfflat. Documentado em `docs/runbooks/ai-vector-index-migration.md` (a escrever).

### 15.4 Buckets Storage

```ts
// Setup via API ou painel — não em migration SQL
// - bucket "ai-policy"  (private, max 20MB por arquivo, 90d retenção do upload original)
// - bucket "ai-logs"    (private, 90d hot, lifecycle pra cold S3)
```

---

## Anexos

- `docs/prd/05-prd-ai-rag-handoff.md` — PRD pai
- `docs/prd/00-prd-master.md` — visão e §6.5 AI strategy
- `docs/specs/01-spec-platform-base.md` — auth, RLS, audit, event_log
- `docs/specs/02-spec-customer-360.md` — activities polimórficas, contacts
- `docs/specs/03-spec-whatsapp-waha.md` — inbound webhook, outbound dispatcher, janela 24h
- `docs/specs/04-spec-pipeline-attendance.md` — conversations.status, stages.requires_human, fila humana
- `docs/business-rules/00-business-rules-catalog.md` — IA-01 a IA-11, B-02
- `docs/research/reference-synthesis.md` — doutrina arquitetural herdada

