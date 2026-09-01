---
title: Spec Técnica 10 — AI Agents Module (Runtime, Schema, Endpoints)
parent: docs/research/pre-development/ai-agent-framework-deskcomm-whatsapp/09-handoff.md
extends: 05-spec-ai-rag-handoff.md
depends_on: 01-spec-platform-base.md, 03-spec-whatsapp-waha.md, 05-spec-ai-rag-handoff.md, 07-spec-events-workers.md
related: 11-spec-mcp-server-internal.md, 12-spec-ai-agents-ui.md
version: 0.1
status: draft (pre-implementation)
date: 2026-05-05
owner: Songhai, Lda
---

# Spec 10 — AI Agents Module (Runtime, Schema, Endpoints)

> Camada de **agentes configuráveis por tenant** que processam mensagens WhatsApp inbound usando LLM + tools MCP. Estende o módulo IA-RAG existente (Spec 05): onde a Spec 05 define **um bot single-tenant com RAG sobre KB**, esta spec define **N agentes por tenant com tool-calling sobre MCP server interno** (Spec 11), versionamento Save/Publish, gatilhos configuráveis, prioridade, e UI de gestão (Spec 12).
>
> A Spec 05 e a Spec 10 **coexistem**: o bot RAG da 05 é uma forma especializada (com KB) do que a 10 generaliza. O dispatcher decide qual caminho ativar — se há agente publicado matching o gatilho, usa Spec 10; senão, fallback Spec 05 se `ai_agents.is_default` ainda apontar para o bot legado.

---

## 1. Visão Geral

### 1.1 O que muda em relação à Spec 05

| Aspecto | Spec 05 (vigente) | Spec 10 (novo) |
|---|---|---|
| Cardinalidade | 1 bot default por tenant | N agentes publicados por tenant, ranqueados por `priority` |
| Tools | Apenas RAG retrieval (interno) | Catálogo MCP completo selecionável por agente (Spec 11) |
| Provider key | Plataforma (AI Gateway pooled) | Tenant BYO (chave por tenant cifrada AES-GCM) |
| Versionamento | Edição direta (sem versão) | Save (cria draft) → Publish (atomic switch) |
| Gatilho | Sempre roda em `message.received` | `trigger_config jsonb` por agente (eventos + filtros) |
| WhatsApp session | Implícito (qualquer sessão) | Explícito (`channel_session_id` por agente) |
| Multi-provider | String AI Gateway, mas modelo único | Tenant escolhe provider+model por agente, com 3 providers (Anthropic, OpenAI, Google) |
| Concorrência | 1 default | N publicados por sessão; dispatcher escolhe top-priority match |
| Handoff | Determinístico (G1-G4) + sentiment | Mantém G1-G4 + tool MCP `request_human_handoff` que o agente chama por intent |
| Test mode | Apenas em produção | Painel inline com dry-run e trace completa |

### 1.2 Princípios não-negociáveis (herdados + novos)

Herdados (não repetir):
- Strings de modelo via AI Gateway (regra Spec 05 §2.1) — **agora aceitando provider keys do tenant via header injection do Gateway**
- RLS estrita + `organization_id` em toda query (regra T-01)
- Trigger Postgres nunca faz HTTP (Spec 07) — agente roda em worker do `event_log`
- Idempotência por `external_id` no inbound (Spec 03)
- Audit log obrigatório em mutações sensíveis (Spec 01)

Novos (este módulo):
- **`ToolLoopAgent` do Vercel AI SDK v6** é o runtime canônico (decisão da pesquisa pré-dev). Sem Mastra, sem LangGraph, sem OpenAI Agents SDK.
- **MCP HTTP transport remoto** (Spec 11) — sem stdio em produção.
- **Loop budget é defesa em três camadas**: `stepCountIs(max_steps)` + token budget per-run + cost budget per-run + monthly cap per-tenant (já existente em `ai_budget_*`, reusar).
- **Provider key do tenant nunca em URL/log/breadcrumb** — header only, AES-GCM at rest, decrypt just-in-time.
- **Prioridade entre agentes**: dispatcher escolhe **1 e somente 1** agente por mensagem inbound (`ORDER BY priority DESC, created_at ASC LIMIT 1`). Nunca dois agentes respondem à mesma mensagem.

---

## 2. Stack & Decisões

### 2.1 Pacotes novos

```json
{
  "ai": "^6",                                  // Vercel AI SDK v6 — ToolLoopAgent
  "@ai-sdk/gateway": "^1",                     // Gateway routing + BYO keys
  "@modelcontextprotocol/sdk": "^1",           // MCP client (Spec 11 server side)
  "@noble/ciphers": "^1"                       // AES-GCM para credentials (já em uso? confirmar)
}
```

Sem novos workers de infra — reusa `event_log` + cron Spec 07.

### 2.2 Modelos suportados (curados na tabela `ai_models`)

| Provider | Model ID | Display | Notas |
|---|---|---|---|
| anthropic | `claude-opus-4-7` | Claude Opus 4.7 | Flagship, raciocínio complexo |
| anthropic | `claude-sonnet-4-6` | Claude Sonnet 4.6 | **Default recomendado** |
| anthropic | `claude-haiku-4-5` | Claude Haiku 4.5 | Cheap/fast |
| openai | `gpt-5` | GPT-5 | Flagship OpenAI |
| openai | `gpt-5-mini` | GPT-5 Mini | Cheap/fast |
| openai | `gpt-4o` | GPT-4o (legacy) | Compat |
| google | `gemini-2.5-pro` | Gemini 2.5 Pro | Flagship Google |
| google | `gemini-2.5-flash` | Gemini 2.5 Flash | Cheap/fast |

A tabela `ai_models` é populada via seed. UI consulta `GET /api/v1/ai/providers/{p}/models` que retorna lista filtrada por `deprecated_at IS NULL`.

### 2.3 Decisões locked (do dossier de pesquisa)

- **D1**: Vercel AI SDK v6 direto. Sem wrapper.
- **D2**: Tenant BYO API keys, cifradas AES-GCM com KMS-managed key.
- **D3**: Multi-agente por sessão, prioridade configurável, mas **1 dispara por mensagem** (top match).
- **D4**: Handoff humano via tool MCP `request_human_handoff(reason, urgency)` + sentinela determinística em `prepareStep` para keywords críticas (`/falar com humano|atendente|pessoa real/i`).
- **D5**: Test mode inline (UI Spec 12) com `dry_run=true` — não envia ao WAHA, retorna trace.
- **D6**: Sem streaming pro WhatsApp (não suporta). Streaming interno apenas para registro de steps em `ai_agent_runs`.
- **D7**: Rate limit per-agent (1 reply/conv/5s) + per-tenant (default 60 runs/min, configurável).

---

## 3. Schema SQL (delta sobre Spec 05)

### 3.1 Estende `ai_agents` (existing)

```sql
-- Adiciona colunas necessárias ao módulo de agentes configuráveis.
alter table public.ai_agents
  add column if not exists published_version_id uuid,
  add column if not exists priority integer not null default 0,
  add column if not exists archived_at timestamptz,
  add column if not exists kind text not null default 'rag_bot'
    check (kind in ('rag_bot', 'mcp_agent'));

-- 'rag_bot' = comportamento Spec 05 (legado). 'mcp_agent' = comportamento Spec 10 (novo).
-- Migration de dados: agents existentes recebem kind='rag_bot', priority=0.

create index if not exists ai_agents_published_idx
  on public.ai_agents (organization_id, priority desc)
  where published_version_id is not null and archived_at is null;
```

**Notas críticas**:
- `published_version_id` NULL = agente em modo paused/draft (não responde gatilhos).
- `priority` empate desempatado por `created_at ASC` no dispatcher.
- `kind='rag_bot'` mantém comportamento legado (Spec 05). Novos agentes criados na UI Spec 12 nascem com `kind='mcp_agent'`.

### 3.2 Nova tabela `ai_agent_versions`

```sql
create table public.ai_agent_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_id uuid not null references public.ai_agents(id) on delete cascade,
  version_number integer not null,

  -- Configuração do agente nesta versão
  system_prompt text not null,
  provider text not null check (provider in ('anthropic', 'openai', 'google')),
  model text not null,                           -- ex: 'claude-sonnet-4-6'
  credential_id uuid references public.ai_provider_credentials(id) on delete restrict,

  -- Tools MCP selecionadas (subset do catálogo Spec 11)
  tool_ids text[] not null default '{}',         -- ex: ['crm_search_contacts', 'crm_send_whatsapp_message']

  -- Configuração de gatilho
  trigger_config jsonb not null default jsonb_build_object(
    'events', jsonb_build_array('message'),
    'filters', jsonb_build_object(
      'ignore_groups', true,
      'ignore_self', true,
      'keyword_regex', null,
      'business_hours', null
    ),
    'concurrency', 'one_per_conversation'
  ),

  -- WhatsApp binding
  channel_session_id uuid not null references public.channel_sessions(id) on delete restrict,

  -- Limites operacionais
  max_steps integer not null default 10 check (max_steps between 1 and 25),
  token_budget integer not null default 50000 check (token_budget between 1000 and 500000),
  cost_budget_cents integer not null default 50 check (cost_budget_cents between 1 and 10000),
  history_message_window integer not null default 20,
  history_token_window integer not null default 8000,

  -- Handoff
  handoff_keywords text[] not null default array['falar com humano', 'atendente', 'pessoa real'],
  handoff_tool_enabled boolean not null default true,

  -- Estado
  status text not null default 'draft' check (status in ('draft', 'published', 'superseded', 'archived')),
  published_at timestamptz,
  superseded_at timestamptz,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),

  constraint ai_agent_versions_unique_number unique (agent_id, version_number)
);

create index ai_agent_versions_agent_idx on public.ai_agent_versions (agent_id, version_number desc);

alter table public.ai_agent_versions enable row level security;
create policy tenant_isolation_ai_agent_versions_all on public.ai_agent_versions for all
  using (organization_id in (select organization_id from public.fn_user_org_ids()))
  with check (organization_id in (select organization_id from public.fn_user_org_ids()));

create trigger trg_ai_agent_versions_audit
  after insert or update or delete on public.ai_agent_versions
  for each row execute function public.fn_audit_log_row();
```

**Regras de transição**:
- `draft` → `published` ao chamar `:publish` endpoint (atomic com update do `ai_agents.published_version_id`)
- Publicar versão B → versão A anterior vira `superseded`, `superseded_at = now()`
- Não pode editar versão `published` (cria nova versão)
- `archived` apenas via DBA manual (preserva histórico mesmo após delete do agente — soft delete)

### 3.3 Nova tabela `ai_provider_credentials`

```sql
create table public.ai_provider_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  provider text not null check (provider in ('anthropic', 'openai', 'google')),
  label text not null,                           -- "Produção", "Testes", etc

  -- API key cifrada (AES-GCM, key em KMS/Vercel KV secret)
  api_key_encrypted bytea not null,
  api_key_iv bytea not null,                     -- 12 bytes IV
  api_key_tag bytea not null,                    -- 16 bytes auth tag
  api_key_last4 text not null,                   -- '••••abcd' display

  -- Validação
  validated_at timestamptz,
  validation_error text,
  models_available text[],                       -- snapshot de models do provider no save

  is_active boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ai_provider_credentials_unique unique (organization_id, provider, label)
);

create index ai_provider_credentials_org_provider_idx
  on public.ai_provider_credentials (organization_id, provider)
  where is_active;

alter table public.ai_provider_credentials enable row level security;

-- Policy: SELECT só campos não-secretos via view; write via RPC
create policy tenant_isolation_ai_provider_credentials_select on public.ai_provider_credentials for select
  using (organization_id in (select organization_id from public.fn_user_org_ids()));

create policy tenant_isolation_ai_provider_credentials_modify on public.ai_provider_credentials for all
  using (organization_id in (select organization_id from public.fn_user_org_ids()))
  with check (organization_id in (select organization_id from public.fn_user_org_ids()));

-- View segura para SELECT no app (esconde campos cifrados)
create view public.ai_provider_credentials_safe as
  select id, organization_id, provider, label, api_key_last4,
         validated_at, validation_error, models_available, is_active,
         created_by, created_at, updated_at
  from public.ai_provider_credentials;

create trigger trg_ai_provider_credentials_audit
  after insert or update or delete on public.ai_provider_credentials
  for each row execute function public.fn_audit_log_row();
```

**Regras**:
- API key plaintext **nunca** retorna do DB. Decrypt apenas no runtime, fora-de-band do query result.
- Audit log captura **eventos** (created/deleted/validated) sem o valor da key.
- `last4` permite UI mostrar "•••• abcd" sem expor a key.

### 3.4 Nova tabela `ai_agent_runs`

```sql
create table public.ai_agent_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_id uuid not null references public.ai_agents(id) on delete restrict,
  agent_version_id uuid not null references public.ai_agent_versions(id) on delete restrict,

  -- Contexto da execução
  conversation_id uuid references public.conversations(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  channel_session_id uuid references public.channel_sessions(id) on delete set null,
  inbound_message_id uuid references public.messages(id) on delete set null,
  outbound_message_id uuid references public.messages(id) on delete set null,

  -- Status
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed', 'aborted', 'handoff')),
  abort_reason text,                             -- ex: 'token_budget_exceeded', 'max_steps_reached'
  error_code text,
  error_message text,

  -- Métricas
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  cost_cents numeric(10, 4) not null default 0,
  latency_ms integer,
  steps_count integer not null default 0,

  -- Trace (para debug/test mode)
  tool_calls jsonb not null default '[]'::jsonb,
  -- shape: [{ step, tool_name, args, result, started_at, ended_at, error? }]

  -- Modo
  is_dry_run boolean not null default false,

  started_at timestamptz not null default now(),
  completed_at timestamptz,

  created_at timestamptz not null default now()
);

-- Concurrency guard: 1 run "running" por conversation (anti-double-reply)
create unique index ai_agent_runs_one_running_per_conv
  on public.ai_agent_runs (conversation_id)
  where status = 'running' and is_dry_run = false;

create index ai_agent_runs_org_started_idx
  on public.ai_agent_runs (organization_id, started_at desc);

create index ai_agent_runs_agent_idx
  on public.ai_agent_runs (agent_id, started_at desc);

create index ai_agent_runs_status_idx
  on public.ai_agent_runs (status, started_at)
  where status in ('pending', 'running');

alter table public.ai_agent_runs enable row level security;
create policy tenant_isolation_ai_agent_runs_all on public.ai_agent_runs for all
  using (organization_id in (select organization_id from public.fn_user_org_ids()))
  with check (organization_id in (select organization_id from public.fn_user_org_ids()));
```

**Notas**:
- Tabela é **append-mostly**. Update apenas em `status`, `completed_at`, métricas, `tool_calls`, `error_*`.
- `is_dry_run=true` bypassa idempotência e o partial unique index — múltiplos test runs simultâneos OK.
- `tool_calls` jsonb é a trace mostrada na UI Spec 12 §4.3.

### 3.5 Nova tabela `ai_models` (catálogo curado)

```sql
create table public.ai_models (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('anthropic', 'openai', 'google')),
  model_id text not null,                        -- 'claude-sonnet-4-6'
  display_name text not null,                    -- 'Claude Sonnet 4.6'
  description text,
  context_window integer,
  input_price_per_million_cents integer,         -- ex: 300 = $3.00/1M tokens
  output_price_per_million_cents integer,
  supports_tools boolean not null default true,
  is_default_for_provider boolean not null default false,
  deprecated_at timestamptz,
  released_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,

  constraint ai_models_unique unique (provider, model_id)
);

-- Tabela é GLOBAL (não tenant-aware). Acesso público read-only.
alter table public.ai_models enable row level security;
create policy ai_models_read_all on public.ai_models for select using (true);
-- Write apenas via service role (seed/migration).

create unique index ai_models_one_default_per_provider
  on public.ai_models (provider) where is_default_for_provider;
```

Seed inicial: ver §2.2 acima. Refresh trimestral via migration (não cron).

### 3.6 Estende `event_log` (Spec 07)

Novos `event_type` que o módulo emite/consome:

| Event Type | Producer | Consumer | Payload Shape |
|---|---|---|---|
| `ai_agent.dispatch_requested` | webhook WAHA (após insert message inbound) | worker `agent-dispatcher` | `{conversation_id, contact_id, channel_session_id, inbound_message_id, organization_id}` |
| `ai_agent.run_started` | worker `agent-runner` | observability sink | `{run_id, agent_id, version_id, conversation_id}` |
| `ai_agent.run_completed` | worker `agent-runner` | observability sink, billing | `{run_id, status, tokens_in, tokens_out, cost_cents, latency_ms, steps_count}` |
| `ai_agent.handoff_triggered` | runtime (tool ou sentinela) | worker pipeline (atribuição humana) | `{run_id, conversation_id, reason, urgency}` |
| `ai_agent.published` | endpoint `:publish` | audit sink | `{agent_id, version_id, previous_version_id}` |

---

## 4. Endpoints REST

Todos `/api/v1/ai/...`, auth dual (cookie session OU bearer), wrappers `ok()`/`fail()`, `X-Request-Id` em toda resposta.

### 4.1 Catálogo de modelos

```
GET /api/v1/ai/providers
  → 200 { data: [{ provider: 'anthropic', display_name, models_count }] }

GET /api/v1/ai/providers/:provider/models
  → 200 { data: [{ model_id, display_name, context_window, input_price_per_million_cents, ... }] }
```

Auth: qualquer role autenticada (`viewer+`).

### 4.2 Provider credentials (BYO keys)

```
GET    /api/v1/ai/credentials                    [manager+]
POST   /api/v1/ai/credentials                    [admin]
DELETE /api/v1/ai/credentials/:id                [admin]
POST   /api/v1/ai/credentials/:id:revalidate     [manager+]
```

**POST body**:
```json
{
  "provider": "anthropic",
  "label": "Produção",
  "api_key": "sk-ant-..."  // plaintext, NEVER stored, encrypted on receipt
}
```

**Side effects do POST**:
1. Validate format (regex per provider)
2. Encrypt AES-GCM, derive `last4`
3. Insert row
4. Async fire-and-forget: ping provider's `/v1/models` para validar a key
5. Atualiza `validated_at` ou `validation_error` no row
6. Audit log entry `ai_credential.created`

Resposta retorna `*_safe` view (sem campos cifrados).

### 4.3 Agentes (CRUD)

```
GET    /api/v1/ai/agents                         [manager+]
POST   /api/v1/ai/agents                         [admin]   (kind='mcp_agent')
GET    /api/v1/ai/agents/:id                     [manager+]
PATCH  /api/v1/ai/agents/:id                     [admin]   (name, description, priority)
DELETE /api/v1/ai/agents/:id                     [admin]   (soft delete: archived_at)
POST   /api/v1/ai/agents/:id:duplicate           [admin]   (cria novo agent com mesmo current draft)
POST   /api/v1/ai/agents/:id:pause               [admin]   (clear published_version_id)
POST   /api/v1/ai/agents/:id:publish             [admin]   body: { version_id }
GET    /api/v1/ai/agents/:id/runs                [manager+] paginated
```

**POST `/api/v1/ai/agents`** body (cria agente + primeira versão draft):
```json
{
  "name": "Suporte Pré-venda",
  "description": "Tira dúvidas sobre catálogo",
  "priority": 10,
  "version": {
    "system_prompt": "Você é...",
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "credential_id": "uuid",
    "tool_ids": ["crm_search_contacts", "crm_get_conversation_history", "crm_send_whatsapp_message", "crm_request_human_handoff"],
    "trigger_config": { "events": ["message"], "filters": { "ignore_groups": true } },
    "channel_session_id": "uuid",
    "max_steps": 10,
    "token_budget": 50000,
    "cost_budget_cents": 50
  }
}
```

Resposta 201:
```json
{
  "data": {
    "agent": { "id", "name", "kind": "mcp_agent", "published_version_id": null, ... },
    "version": { "id", "version_number": 1, "status": "draft", ... }
  }
}
```

### 4.4 Versões

```
GET   /api/v1/ai/agents/:id/versions             [manager+]
POST  /api/v1/ai/agents/:id/versions             [admin]   (Save = nova versão draft)
GET   /api/v1/ai/agents/:id/versions/:vid        [manager+]
PATCH /api/v1/ai/agents/:id/versions/:vid        [admin]   (apenas se status='draft')
POST  /api/v1/ai/agents/:id/versions/:vid:test   [admin]   (dry-run)
```

**POST `/versions:test`** body:
```json
{
  "sample_message": "Oi, quanto custa o produto X?",
  "sample_contact": { "name": "Cliente Teste", "phone": "+5511..." }   // opcional
}
```

Resposta:
```json
{
  "data": {
    "run_id": "uuid",
    "status": "completed",
    "final_text": "...",
    "tool_calls": [...trace...],
    "tokens_in": 1234, "tokens_out": 567, "cost_cents": 0.4, "latency_ms": 3200,
    "would_send_to": { "session": "...", "chat_id": "..." }   // mostra mas não envia
  }
}
```

### 4.5 Publish / lifecycle

**POST `/api/v1/ai/agents/:id:publish`** body `{ version_id }`:
1. Validar versão pertence ao agent e está `draft` ou `superseded`
2. Validar `credential_id` ainda existe e `is_active`
3. Validar `channel_session_id` ainda existe e `status='working'`
4. Validar todos `tool_ids` existem no catálogo MCP (Spec 11)
5. **Atomic transaction**:
   ```sql
   begin;
     update ai_agent_versions set status='superseded', superseded_at=now()
       where id = (select published_version_id from ai_agents where id=$agent_id);
     update ai_agent_versions set status='published', published_at=now()
       where id=$version_id;
     update ai_agents set published_version_id=$version_id, updated_at=now()
       where id=$agent_id;
     insert into event_log (event_type, payload) values ('ai_agent.published', ...);
   commit;
   ```
6. Audit log entry `ai_agent.published`

### 4.6 Webhook hook (estende Spec 03 §webhook)

Adiciona ao final do handler `POST /api/v1/webhooks/waha`, **após** insert do inbound message:

```ts
if (!isGroup && !fromMe && message.kind === 'inbound') {
  await admin.from('event_log').insert({
    organization_id,
    event_type: 'ai_agent.dispatch_requested',
    payload: {
      conversation_id, contact_id, channel_session_id,
      inbound_message_id: message.id
    }
  })
}
```

---

## 5. Runtime — Worker `agent-dispatcher`

### 5.1 Cron (Spec 07)

```
schedule: "*/5 * * * * *"   (a cada 5s; Vercel não suporta sub-minute, então roda a cada 1min e processa batch)
endpoint: POST /api/v1/cron/agent-dispatcher
auth: header X-Cron-Secret
```

### 5.2 Algoritmo

```ts
async function dispatchAgents() {
  const events = await admin
    .from('event_log')
    .select('*')
    .eq('event_type', 'ai_agent.dispatch_requested')
    .is('processed_at', null)
    .order('created_at')
    .limit(100)

  for (const evt of events) {
    const { organization_id, conversation_id, channel_session_id, inbound_message_id } = evt.payload

    // 1. Find candidate agents
    const { data: candidates } = await admin
      .from('ai_agents')
      .select(`
        id, priority,
        version:ai_agent_versions!published_version_id (*)
      `)
      .eq('organization_id', organization_id)
      .is('archived_at', null)
      .not('published_version_id', 'is', null)
      .eq('version.channel_session_id', channel_session_id)
      .order('priority', { ascending: false })
      .order('created_at', { ascending: true })

    // 2. Filter by trigger_config (events match + filters match)
    const message = await loadMessage(inbound_message_id)
    const matched = candidates.filter(a => triggerMatches(a.version.trigger_config, message))

    if (matched.length === 0) {
      await markEventProcessed(evt.id, 'no_match')
      continue
    }

    // 3. Pick the top one
    const agent = matched[0]

    // 4. Concurrency guard: skip if there's a running run for this conversation
    const { data: existing } = await admin
      .from('ai_agent_runs')
      .select('id')
      .eq('conversation_id', conversation_id)
      .eq('status', 'running')
      .eq('is_dry_run', false)
      .maybeSingle()

    if (existing) {
      await markEventProcessed(evt.id, 'conv_busy')
      continue
    }

    // 5. Tenant budget guard (reuse ai_budget_*)
    const budgetOk = await checkTenantBudget(organization_id)
    if (!budgetOk) {
      await markEventProcessed(evt.id, 'budget_exceeded')
      await sentryWarn('ai_budget_exceeded', { organization_id })
      continue
    }

    // 6. Per-tenant rate limit (Upstash)
    const rateOk = await rateLimit(`ai-runs:${organization_id}`, 60, '1m')
    if (!rateOk) {
      // requeue with delay
      await requeueEvent(evt.id, 5000)
      continue
    }

    // 7. Create run + dispatch to runner
    const { data: run } = await admin
      .from('ai_agent_runs')
      .insert({
        organization_id,
        agent_id: agent.id,
        agent_version_id: agent.version.id,
        conversation_id,
        contact_id: message.contact_id,
        channel_session_id,
        inbound_message_id,
        status: 'pending'
      })
      .select()
      .single()

    // 8. Invoke runner (fire-and-forget; runner is its own route handler)
    await fetch(internalUrl('/api/internal/agents/run'), {
      method: 'POST',
      headers: { 'X-Internal-Secret': process.env.INTERNAL_SECRET },
      body: JSON.stringify({ run_id: run.id })
    })

    await markEventProcessed(evt.id, 'dispatched')
  }
}
```

### 5.3 Trigger matching helper

```ts
function triggerMatches(config: TriggerConfig, msg: Message): boolean {
  // Event type
  if (!config.events.includes('message') && !config.events.includes('message.any')) return false

  const f = config.filters
  if (f.ignore_groups && msg.chat_id.endsWith('@g.us')) return false
  if (f.ignore_self && msg.from_me) return false
  if (f.keyword_regex && !new RegExp(f.keyword_regex, 'i').test(msg.body)) return false
  if (f.business_hours && !inBusinessHours(f.business_hours, msg.received_at)) return false

  return true
}
```

---

## 6. Runtime — Endpoint `/api/internal/agents/run`

Não é parte de `/api/v1/`. É **internal-only**, autenticado por `X-Internal-Secret` (env var). Vercel function com `maxDuration = 300`.

### 6.1 Algoritmo

```ts
import { ToolLoopAgent, stepCountIs } from 'ai'
import { createMCPClient } from '@modelcontextprotocol/sdk/client'
import { gateway } from '@ai-sdk/gateway'

export async function POST(req: NextRequest) {
  const { run_id } = await req.json()
  const run = await loadRun(run_id)
  const version = await loadVersion(run.agent_version_id)
  const apiKey = await decryptCredential(version.credential_id)

  // Update to running
  await admin.from('ai_agent_runs').update({ status: 'running' }).eq('id', run_id)

  // Setup MCP client (Spec 11)
  const mcpClient = await createMCPClient({
    transport: { type: 'sse', url: process.env.INTERNAL_MCP_URL! },
    headers: { 'Authorization': `Bearer ${await mintMCPTokenFor(run.organization_id)}` }
  })
  const allTools = await mcpClient.tools()
  const tools = pickTools(allTools, version.tool_ids)
  if (version.handoff_tool_enabled) {
    tools.crm_request_human_handoff = allTools.crm_request_human_handoff
  }

  // Load conversation history
  const history = await loadHistoryWithBudget(
    run.conversation_id,
    version.history_message_window,
    version.history_token_window
  )

  // Determinístico: handoff por keyword antes do LLM
  const inbound = await loadMessage(run.inbound_message_id)
  if (matchesHandoffKeyword(inbound.body, version.handoff_keywords)) {
    return await finalizeHandoff(run, 'keyword_match', 'normal')
  }

  // Build agent
  const agent = new ToolLoopAgent({
    model: gateway(`${version.provider}/${version.model}`, { apiKey }),
    system: version.system_prompt,
    tools,
    stopWhen: [stepCountIs(version.max_steps)],
    prepareStep: async ({ steps, totalUsage }) => {
      const totalTokens = (totalUsage.inputTokens ?? 0) + (totalUsage.outputTokens ?? 0)
      if (totalTokens > version.token_budget) {
        throw new BudgetExceeded('token_budget_exceeded')
      }
      const cost = computeCost(version.provider, version.model, totalUsage)
      if (cost > version.cost_budget_cents) {
        throw new BudgetExceeded('cost_budget_exceeded')
      }
      // Persist intermediate trace every step
      await admin.from('ai_agent_runs').update({
        steps_count: steps.length,
        tool_calls: steps.map(serializeStep)
      }).eq('id', run.id)
      return {}
    }
  })

  let result
  try {
    result = await agent.generate({
      messages: [
        ...history.map(toModelMessage),
        { role: 'user', content: inbound.body }
      ]
    })
  } catch (err) {
    return await finalizeRun(run, 'failed', err)
  }

  // Detecta handoff via tool call
  if (result.steps.some(s => s.toolCalls?.some(tc => tc.toolName === 'crm_request_human_handoff'))) {
    return await finalizeHandoff(run, 'agent_invoked_tool', 'normal', result)
  }

  // Send out via WAHA (skip if dry_run)
  if (!run.is_dry_run) {
    await sendWAHA(version.channel_session_id, inbound.chat_id, result.text)
  }

  return await finalizeRun(run, 'completed', null, result)
}
```

### 6.2 `finalizeRun` / `finalizeHandoff`

Updates `ai_agent_runs` com métricas finais, insere outbound `messages` row (se enviou), emite event_log `ai_agent.run_completed` ou `ai_agent.handoff_triggered`. Audit log se mutação relevante.

### 6.3 Cost computation

```ts
function computeCost(provider: string, model: string, usage: Usage): number {
  const m = AI_MODELS[`${provider}/${model}`]
  return (
    (usage.inputTokens ?? 0) * m.inputPricePerToken +
    (usage.outputTokens ?? 0) * m.outputPricePerToken
  )
}
```

Preços vêm do seed `ai_models`. Sem hardcode.

---

## 7. Segurança & RBAC

| Operação | Role mínima | Notas |
|---|---|---|
| List agents | `manager` | RLS faz scoping |
| List runs | `manager` | |
| List credentials (safe view) | `manager` | Sem campo cifrado |
| View run trace | `manager` | |
| Create/edit/publish agent | `admin` | MFA forçado |
| Add/delete credential | `admin` | MFA forçado |
| Test agent (dry-run) | `admin` | Custo conta no budget mas é destacado em UI |
| Pause/archive agent | `admin` | |

**Provider key handling — defesa em profundidade**:
1. Plaintext recebido só no POST `/credentials` (HTTPS, body)
2. Cifrado AES-GCM no servidor antes de bater no DB
3. Key de criptografia em `process.env.AI_CRED_AES_KEY` (gerenciado por Vercel/KMS, rotacionado anualmente)
4. Decrypt apenas no `/api/internal/agents/run`, key fica só em variável de função
5. Sentry `beforeSend` strip: `authorization`, `x-api-key`, `api_key`, `*_key`, `*_secret`
6. Logs estruturados (lib/logger) já strippa esses campos

---

## 8. Observabilidade

### 8.1 Métricas

Coletadas em `ai_agent_runs` + agregadas em `ai_usage` (já existe da Spec 05):

- `runs_total` por agent / por dia / por tenant
- `runs_failed` (status='failed')
- `runs_handoff` (status='handoff')
- `latency_ms` p50/p95/p99
- `tokens_in/out` total
- `cost_cents` total
- `tool_call_count` médio por run

Dashboard adicionado em `/admin/ai-usage` (estende existente).

### 8.2 Sentry

- `ai_agent_run.failed` — captura com tags `{agent_id, version_id, error_code}`
- `ai_agent_run.budget_exceeded` — warning level
- `ai_agent_run.tool_loop_suspicious` — quando >5 tool calls idênticas seguidas (heurística)
- `ai_agent.dispatcher.no_match` — info level se taxa > 30% (config inválida)

### 8.3 Logs estruturados

Cada run emite, em JSON:
```json
{ "ts", "level": "info", "module": "ai_agent_runner",
  "run_id", "agent_id", "version_id", "organization_id",
  "step_index", "event": "tool_called", "tool_name", "tokens_in", "tokens_out", "cost_cents" }
```

---

## 9. Testes (gates de CI)

- **Unit**: `triggerMatches()`, `matchesHandoffKeyword()`, `computeCost()`, `pickTools()`, `loadHistoryWithBudget()` — Vitest
- **Integration**:
  - Dispatch end-to-end com fixture WAHA event → run row criada
  - Publish atomic switch → previous version goes to superseded
  - Test mode dry-run → `ai_agent_runs.is_dry_run=true`, sem outbound message
  - Concurrency guard → 2 dispatches simultâneos para mesma conversation → só 1 vira `running`
- **RLS isolation** (gate obrigatório):
  - Org A não vê agentes / versões / runs / credentials de Org B
  - Service role bypassa mas handlers filtram `organization_id` manualmente
- **E2E (Playwright)**:
  - Criar agente via UI Spec 12, salvar, testar com sample message, publicar, ver run no log
- **Adversarial**:
  - Provider key leak: scan logs/Sentry breadcrumbs após run, garantir 0 ocorrências
  - Tool loop infinito simulado: agente que sempre retoma → para em `stepCountIs`
  - Cost budget breach: simula provider lento → para em `cost_budget_cents`

---

## 10. Definition of Done (módulo)

1. Migrations aplicadas em dev + staging, RLS policies testadas
2. Endpoints `/api/v1/ai/credentials`, `/agents`, `/agents/.../versions`, `/agents/...:publish`, `/agents/.../runs` cobertos por testes
3. MCP server (Spec 11) deployado e endpoint `/api/mcp` retornando tools list
4. Worker `agent-dispatcher` rodando em cron, processando event_log
5. Endpoint `/api/internal/agents/run` deployado com `maxDuration: 300`
6. UI Spec 12 implementada (todas 4 telas)
7. Seed `ai_models` aplicado com 8 modelos
8. Provider keys: encryption key configurada em env, rotation playbook documentado
9. Sentry `beforeSend` validado contra leak de api keys
10. Audit log captura: `ai_agent.created`, `ai_agent.published`, `ai_agent.paused`, `ai_agent.archived`, `ai_credential.created`, `ai_credential.deleted`
11. Gate de RLS isolation passa no CI
12. Documentação tenant-facing escrita (como gerar API key Anthropic, OpenAI, Google e plugar)

---

## 11. Riscos & mitigações

| ID | Risco | Severidade | Mitigação |
|---|---|---|---|
| R1 | Provider key vaza em logs/Sentry | CRÍTICO | beforeSend strip + smoke test no CI |
| R2 | Tool loop infinito custa $$$ | ALTO | stepCountIs hard cap + token/cost budget per-run + monthly cap |
| R3 | Dispatcher escolhe agente errado por timing | MÉDIO | priority + created_at ASC determinístico; teste com fixture multi-agent |
| R4 | Versão publicada referencia credential deletada | MÉDIO | FK on delete restrict; UI bloqueia delete se em uso |
| R5 | Two agents responding to same message | CRÍTICO | partial unique index `one_running_per_conv`; LIMIT 1 no dispatcher |
| R6 | MCP server down derruba todos agentes | ALTO | health check no dispatcher; circuit breaker; fallback para handoff humano automático |
| R7 | Provider deprecated model breaks production | MÉDIO | `ai_models.deprecated_at`; alert quando agente usa modelo deprecated |
| R8 | Concorrência: dispatcher dispara antes de WAHA confirmar idempotência | BAIXO | webhook handler insere event_log apenas após `code !== '23505'` no insert message |

---

## 12. Cross-references

- Spec 11 — Internal MCP Server: catálogo de tools que `version.tool_ids` referencia
- Spec 12 — AI Agents UI: implementação das telas que consomem estes endpoints
- Spec 05 — IA-RAG legado: agentes `kind='rag_bot'` continuam usando aquela rota; novos `kind='mcp_agent'` usam esta
- Spec 03 — WAHA: `channel_sessions`, webhook handler estendido em §4.6
- Spec 07 — Events/Workers: novo cron `agent-dispatcher` segue padrão existente
- Spec 01 — Platform Base: RLS via `fn_user_org_ids()`, audit log via `fn_audit_log_row()`
