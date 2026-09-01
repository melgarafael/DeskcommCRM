---
epic_id: EPIC-06-ai-rag
epic_name: AI Agent + RAG + Sentiment + Handoff
priority: P0
estimated_waves: 12
estimated_total_points: 42
depends_on: [EPIC-00, EPIC-01, EPIC-03]
exposes_contracts:
  - "worker.ai-response-worker"
  - "worker.ai-sentiment-worker"
  - "worker.rag-indexer"
  - "worker.handoff-orchestrator"
  - "api.POST /api/v1/ai/agents"
  - "api.POST /api/v1/ai/knowledge/sources"
  - "api.GET /api/v1/ai/usage"
  - "api.GET /api/v1/ai/budget"
  - "realtime.ai-budget-{org_id}"
  - "event.ai.responded"
  - "event.ai.handoff_triggered"
  - "event.ai.sentiment_alert"
  - "event.ai.budget_warning"
  - "event.ai.budget_throttled"
status: pending
created_at: 2026-04-28
owner: Songhai, Lda
---

# EPIC-06 — AI Agent + RAG + Sentiment + Handoff

> **Para o epic-executor**: leia este arquivo inteiro antes de qualquer wave. As stories estão em ordem de dependência. Cada story = 1 wave. Não pular ordem mesmo que pareça independente — `Deps:` é lei. Toda chamada LLM passa por **Vercel AI Gateway com strings de modelo** (Spec 05 §2.1) — nunca importar `@anthropic-ai/sdk`. Toda query no `pgvector` filtra `organization_id` em camada programática **e** RLS (defesa em profundidade — Spec 05 §5.3).

## 1. Objetivo

Entregar a camada de IA conversacional do SonghaiCRM: bot que responde inbounds via Sonnet 4.6 com contexto RAG (4 fontes), sentiment classifier paralelo via Haiku 4.5, orquestrador de handoff com 4 gatilhos OR-lógicos (IA-05), pipeline de ingestão versionado para FAQ/Policy/Catálogo Nuvemshop/Conversas resolvidas, UI de configuração de agents/knowledge/usage e enforcement de orçamento mensal por tenant (alarme 80%, throttle 100%). Ao final, um inbound em conversation com bot ativo recebe resposta IA em <3s p95 ou um handoff registrado em activity, com custo rateado por tenant em `ai_invocations`.

## 2. Resultado esperado (Definition of Done do Epic)

- [ ] Inbound em conversation com `force_human=false`, `is_blocked=false`, dentro da janela 24h, agent ativo e budget OK → bot responde via WhatsApp com `messages.metadata.ai_generated=true` e `citations[]` populado quando RAG hit
- [ ] Sentiment score persistido em `messages.metadata.sentiment_score` (0-1) para todo inbound com body texto
- [ ] G1 (regex pedido humano), G2 (`sentiment_score < threshold`), G3 (`confidence < threshold` ou marcador de incerteza), G4 (regex jurídico OU `stage.requires_human=true`) disparam handoff: `conversations.status='pending'`, activity `handoff_triggered`, evento `ai.handoff_triggered`, broadcast realtime
- [ ] Bot **não reassume** após handoff (IA-06) até atendente clicar "Passar pra IA"
- [ ] Re-indexação automática <30s p95 após `nuvemshop.product_synced` (IA-11) ou `knowledge_source.updated`
- [ ] Pipelines de ingestão funcionando: FAQ markdown via UI, Policy PDF/MD via upload, Catálogo Nuvemshop via event consumer, Conversas resolvidas opt-in com anonymizer (CPF/email/phone/CEP/nome) — todos versionados em `ai_knowledge_versions` com swap atômico
- [ ] Pages `/app/ai/agents`, `/app/ai/agents/[id]`, `/app/ai/knowledge/sources`, `/app/ai/usage` funcionais
- [ ] Trigger em `ai_invocations` mantém `ai_budgets.current_month_consumed_cents` atualizado; cron horário emite `ai.budget_warning` em 80% e `ai.budget_throttled` em 100% com `is_throttled=true`
- [ ] Citations debug toggle exibe `metadata.citations[]` no `ChatThread` para mensagens IA-generated
- [ ] Cross-tenant isolation auditado: tenant A nunca recebe chunk/invocation/budget de B (RLS + filtro programático em `retrieve_top_k_chunks`)
- [ ] Regression suite cobre 4 workers + 5 API routes + UI + budget enforcement

## 3. Pré-requisitos

- Epics anteriores completos: `EPIC-00`, `EPIC-01`, `EPIC-03`
- Migrations Supabase aplicadas: 0001-0007 + nova migration deste epic com tabelas `ai_agents`, `ai_knowledge_sources`, `ai_chunks`, `ai_knowledge_versions`, `ai_invocations`, `ai_pricing`, `ai_budgets` (Spec 05 §3)
- Extensions Postgres: `vector`, `pg_trgm`, `pgcrypto` habilitadas
- Variáveis de env: `AI_GATEWAY_API_KEY`, `AI_GATEWAY_BASE_URL`, `OPENAI_API_KEY` (fallback embedding), `SUPABASE_SERVICE_ROLE_KEY`, `EVENT_LOG_WORKER_ENABLED=true`
- Buckets Storage: `ai-policy/` (privado), `ai-logs/` (privado, 90d hot)
- Dev server rodando em `localhost:3001`
- Playwright MCP conectado pra QA
- Vercel AI SDK v6 instalado (`ai`, `@ai-sdk/openai` opcional pra embeddings)

## 4. Architecture Contracts

### 4.1 Contracts consumidos (de epics anteriores)

| Contract ID | Tipo | Origem | Como usar |
|---|---|---|---|
| `auth.user-session` | session | EPIC-01 | `useAuth()` em pages /app/ai/* |
| `db.organizations` | db_table | EPIC-00 mig 0001 | FK em todas tabelas `ai_*` |
| `db.fn_user_org_ids` | db_function | EPIC-00 | Base das policies RLS `ai_*` |
| `db.event_log` | db_table | EPIC-00 | Workers consomem `message.received`, `nuvemshop.product_synced`, `knowledge_source.updated` |
| `db.conversations` | db_table | EPIC-03 | Worker atualiza `status`, `last_handoff_at`, `bot_silenced_until` |
| `db.messages` | db_table | EPIC-03 | Worker insere outbound bot + grava `metadata.sentiment_score`/`citations` |
| `db.contacts` | db_table | EPIC-05 (lookup via EPIC-03) | Bot lê `is_blocked`, `force_human`, `tags` |
| `db.crm_lead_activities` | db_table | EPIC-04 | Activity polimórfica `ai_responded`, `handoff_triggered` |
| `db.crm_stages` | db_table | EPIC-04 | G4 lê `stage.requires_human` |
| `event.message.received` | domain_event | EPIC-03 | Trigger principal de bot + sentiment |
| `event.message.send_requested` | domain_event | EPIC-03 | Bot emite pra dispatcher WAHA enviar |
| `event.nuvemshop.product_synced` | domain_event | EPIC-07 (stub no MVP-B se ainda não pronto) | Re-indexa catálogo |
| `realtime.org-{org_id}` | realtime_channel | EPIC-01 | Broadcast `handoff_pending` |

### 4.2 Contracts expostos (consumíveis por epics futuros)

| Contract ID | Tipo | Wave que expõe | Descrição pra consumidores |
|---|---|---|---|
| `db.ai_agents` | db_table | S-06.01 | Config do bot por tenant |
| `db.ai_knowledge_sources` | db_table | S-06.04 | 4 fontes RAG |
| `db.ai_chunks` | db_table | S-06.04 | Vetores pgvector(1536) |
| `db.ai_invocations` | db_table | S-06.01 | Log de toda chamada LLM |
| `db.ai_budgets` | db_table | S-06.11 | Orçamento + estado runtime |
| `worker.ai-response-worker` | worker | S-06.01 | Consome `message.received`, produz outbound |
| `worker.ai-sentiment-worker` | worker | S-06.02 | Consome `message.received`, grava score |
| `worker.handoff-orchestrator` | worker | S-06.03 | 4 gatilhos OR-lógicos |
| `worker.rag-indexer` | worker | S-06.04 | Consome `nuvemshop.product_synced`, `knowledge_source.updated` |
| `api.POST /api/v1/ai/agents` | api_route | S-06.08 | CRUD agents |
| `api.POST /api/v1/ai/knowledge/sources` | api_route | S-06.05/06/07 | Upload FAQ/Policy/conversations opt-in |
| `api.POST /api/v1/ai/knowledge/sources/:id/reindex` | api_route | S-06.09 | Re-indexação manual |
| `api.GET /api/v1/ai/usage` | api_route | S-06.10 | Métricas custo/tokens/latência/handoff |
| `api.GET /api/v1/ai/budget` | api_route | S-06.11 | Status budget |
| `realtime.ai-budget-{org_id}` | realtime_channel | S-06.11 | Alarmes 80%/100% |
| `event.ai.responded` | domain_event | S-06.01 | Bot enviou resposta |
| `event.ai.handoff_triggered` | domain_event | S-06.03 | Handoff ocorreu (qualquer gatilho) |
| `event.ai.sentiment_alert` | domain_event | S-06.02 | Sentiment baixo detectado |
| `event.ai.budget_warning` | domain_event | S-06.11 | 80% atingido |
| `event.ai.budget_throttled` | domain_event | S-06.11 | 100% — bot pausado |
| `hook.useAgent` | react_hook | S-06.08 | Carrega/edita agent config |
| `hook.useKnowledgeSources` | react_hook | S-06.09 | Lista fontes + status indexação |
| `hook.useAiUsage` | react_hook | S-06.10 | Time-series de custo/tokens |
| `hook.useAiBudget` | react_hook | S-06.11 | Subscribe a `realtime.ai-budget-{org_id}` |
| `ui.<GuardrailsEditor>` | react_component | S-06.08 | jsonb editor com schema |
| `ui.<KnowledgeSourceCard>` | react_component | S-06.09 | Status + reindex |
| `ui.<UsageChart>` | react_component | S-06.10 | Recharts custo/dia |
| `ui.<CitationsPanel>` | react_component | S-06.12 | Debug toggle no ChatThread |

## 5. Stories (em ordem de dependência)

> Cada story abaixo vira UMA wave do epic-executor. Wave 1 = primeira story; wave 12 = última. Deps internos respeitados pela ordem.

---

### S-06.01 — Worker `ai-response-worker` (bot pipeline base)

**Points**: 6 | **Priority**: P0 | **Deps**: (none — primeira) | **FR refs**: Spec 05 §5, IA-01, IA-02, IA-03

#### Contexto

Story-coração do epic. Cria a migration completa das tabelas `ai_*` (Spec 05 §3.1–3.8), o RPC `retrieve_top_k_chunks` (Spec 05 §5.3), a tabela `ai_pricing` com seed de preços abr/2026, e o worker que consome `message.received` do `event_log` (push handler, Spec 07). Para cada inbound: monta contexto (últimas 20 msgs + perfil contact + lead vocabulary + RAG top-K=5 com threshold 0.72), invoca Sonnet 4.6 via Vercel AI Gateway com `streamText`, detecta violação mid-stream, computa confidence, persiste outbound `status='sending'` com `metadata.ai_generated=true`, emite `message.send_requested` pro dispatcher WAHA (EPIC-03). Insert em `ai_invocations` é fire-and-forget. **Decisões já lockadas**: pgvector (não Supabase Vector), text-embedding-3-small 1536-dim, ivfflat lists=100. Handoff cases (G1/G3/G4 base) ficam stubs neste wave; lógica detalhada em S-06.03.

#### Files to create

- `supabase/migrations/0008_ai_rag_schema.sql` — todas tabelas `ai_*`, indexes, RLS policies, RPC `retrieve_top_k_chunks`, RPC `activate_kb_version`, seed `ai_pricing`
- `lib/ai/gateway.ts` — wrapper sobre `streamText`/`generateText`/`generateObject`/`embed` com headers `X-AI-Gateway-Tenant-Id`, `X-AI-Gateway-Zero-Retention`
- `lib/ai/embed.ts` — `embedText(content)` via `openai/text-embedding-3-small`, batched
- `lib/ai/cost.ts` — `computeCost(model, promptTokens, completionTokens)` lendo `ai_pricing`
- `lib/ai/log-invocation.ts` — fire-and-forget insert em `ai_invocations`
- `workers/ai-response-worker.ts` — handler principal (`buildContext`, `invokeBot`, `postProcess` parcial, `persistAndDispatch`)
- `workers/ai-response-worker.handler.ts` — registro do consumer no event-log dispatcher (EPIC-00 contract)
- `lib/ai/render-system-prompt.ts` — template renderer com placeholders (Spec 05 §11.1)
- `lib/ai/types.ts` — `BotContext`, `BotResponse`, `RagHit`, `Citation`, `PostProcessResult`

#### Files to modify

- `lib/event-log/dispatcher.ts` — registrar `message.received` → `ai-response-worker.handler`
- `package.json` — adicionar `ai@^6`, `@ai-sdk/openai` (embeddings), `gpt-tokenizer`, `zod`

#### Implementation steps (sequential)

1. Migration 0008: criar 7 tabelas + extensions (`vector`, `pg_trgm`, `pgcrypto`) + indexes (incluindo ivfflat) + RLS policies + RPCs + seed pricing + bucket `ai-logs` privado
2. `lib/ai/gateway.ts`: factory que lê `AI_GATEWAY_API_KEY`/`AI_GATEWAY_BASE_URL` e injeta headers de tenant
3. `lib/ai/embed.ts`: `embedText` chamando `embed({ model: "openai/text-embedding-3-small", value })`
4. Worker: implementa `buildContext` com guards (`is_blocked`, `force_human`, `isOutsideWindow24h`, `isBudgetExhausted`, `last_handoff_at` recente → skip por IA-06)
5. Retrieval: chama RPC `retrieve_top_k_chunks(p_organization_id, p_kb_version_id, p_embedding, p_k, p_threshold)` — **filtro programático de `organization_id` é mandatório**
6. `invokeBot` com `streamText`, abort on mid-stream guardrail violation (regex output block do agent)
7. `postProcess` parcial: extrai citations de RAG hits, computa confidence (heurística composta Spec 05 §7.3); flag `low_confidence` retorna stub `action: "handoff"` que será conectado em S-06.03
8. `persistAndDispatch`: insert em `messages` com `status='sending'` + `metadata.ai_generated=true`, activity `ai_responded`, emit `message.send_requested` e `ai.responded`
9. `logInvocation` em `queueMicrotask` — nunca bloqueia path crítico
10. Smoke test local: enviar inbound mock via SQL `event_log` insert → verificar outbound message inserida + `ai_invocations` row

#### Acceptance Criteria

```gherkin
Given um agent ativo com is_default=true e knowledge version ativa em tenant A
And contact.is_blocked=false e force_human=false
When event_log recebe `message.received` com body "qual o prazo de entrega?"
Then ai-response-worker monta contexto com últimas <=20 msgs e top-K=5 chunks com score >= 0.72
And invoca anthropic/claude-sonnet-4-6 via AI Gateway
And insere outbound em messages com status='sending' e metadata.ai_generated=true
And emite event message.send_requested
And insere row em ai_invocations com invocation_kind='bot_respond' e cost_cents > 0
```

```gherkin
Given um contact com is_blocked=true
When event_log recebe `message.received` desse contact
Then ai-response-worker pula com skip="contact_blocked"
And NÃO insere outbound nem ai_invocations.kind='bot_respond'
```

```gherkin
Given conversa fora da janela 24h (last_inbound_at > 24h)
When ai-response-worker tenta processar
Then aborta com skip="window_24h_expired" (IA-01)
And NÃO chama LLM
```

```gherkin
Given tenant A tem chunk em ai_chunks com organization_id=A
And user logado em tenant B chama RPC retrieve_top_k_chunks com p_organization_id=A
Then retorno é vazio (RLS bloqueia leitura cross-tenant)
And nenhum vector de A vaza para B
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | db | Migration 0008 aplica + extension `vector` ativa | `mcp__plugin_supabase_supabase__list_extensions` mostra vector |
| t2 | rls | `ai_chunks` RLS bloqueia cross-tenant | SQL como user A: `select * from ai_chunks where organization_id = 'B-uuid'` retorna 0 |
| t3 | worker | Inbound com agent ativo gera outbound em <3s | Insert mock em `event_log` + poll `messages` table |
| t4 | api | `ai_invocations` registra cost_cents calculado de `ai_pricing` | Verificar `cost_cents = (prompt_tokens * 300 + completion_tokens * 1500) / 1e6` para Sonnet |
| t5 | guard | `is_blocked=true` skipa bot | SQL set `contacts.is_blocked=true`, emit event, verificar zero outbounds |
| t6 | rag | Top-K respeita `rag_top_k` do agent.config | Set `rag_top_k=3`, verificar `ai_invocations.citations.length <= 3` |

#### Architecture contracts emitted

```yaml
exposes:
  - type: db_table
    id: "ai_agents"
    columns: [id, organization_id, name, is_active, is_default, model, system_prompt, config, guardrails, active_kb_version_id]
  - type: db_table
    id: "ai_chunks"
    columns: [id, organization_id, knowledge_source_id, kb_version_id, content, embedding, metadata]
    notes: "vector(1536), ivfflat lists=100, RLS via fn_user_org_ids"
  - type: db_table
    id: "ai_invocations"
    columns: [id, organization_id, agent_id, conversation_id, message_id, invocation_kind, model, prompt_tokens, completion_tokens, latency_ms, cost_cents, citations, finish_reason]
  - type: db_function
    id: "retrieve_top_k_chunks"
    signature: "(p_organization_id uuid, p_kb_version_id uuid, p_embedding vector(1536), p_k int, p_threshold real) → table"
    notes: "security definer + filtro programático de org_id"
  - type: worker
    id: "ai-response-worker"
    consumes: ["message.received"]
    emits: ["message.send_requested", "ai.responded"]
  - type: domain_event
    id: "ai.responded"
    payload: "{ message_id, conversation_id, agent_id, confidence, citations[] }"
```

#### Decisões a registrar

- **Strings de modelo, nunca imports**: `"anthropic/claude-sonnet-4-6"` resolve via Gateway. PR com `import Anthropic from "@anthropic-ai/sdk"` é rejeitado.
- **Filtro programático de `organization_id` em todo retrieval** mesmo quando RLS aplicada (defesa em profundidade).
- `ivfflat lists=100` é decisão MVP; revisitar HNSW quando algum tenant passar 100k chunks.

#### Definition of Done

- [ ] Todos os ACs passam
- [ ] Migration 0008 aplicada no Supabase remote
- [ ] Typecheck/lint zero novos erros
- [ ] Smoke test: inbound mock → outbound IA gerado em <3s p95 local
- [ ] Commit `feat(EPIC-06): ai-response-worker base + schema [wave 1]`
- [ ] Architecture contracts no state file

---

### S-06.02 — Worker `ai-sentiment-worker` (paralelo)

**Points**: 3 | **Priority**: P0 | **Deps**: S-06.01 | **FR refs**: Spec 05 §6, IA-04

#### Contexto

Segundo consumer do mesmo `message.received`, paralelo ao bot. Usa `generateObject` do AI SDK com Zod schema `{ sentiment_score: z.number().min(0).max(1), reasoning_short: z.string().max(100) }` chamando `anthropic/claude-haiku-4-5`. Persiste em `messages.metadata.sentiment_score` (merge com metadata existente). Custo ~10× menor que Sonnet, latência <1s p95. Falha graceful: timeout/erro loga warning e segue (G2 simplesmente não dispara aquele inbound). G2 trigger fica stub aqui — orquestração em S-06.03.

#### Files to create

- `workers/ai-sentiment-worker.ts` — handler do consumer
- `lib/ai/prompts/sentiment.ts` — `SENTIMENT_SYSTEM_PROMPT` em PT-BR
- `workers/ai-sentiment-worker.handler.ts` — registro no dispatcher

#### Files to modify

- `lib/event-log/dispatcher.ts` — registrar segundo handler `message.received` → `ai-sentiment-worker`

#### Implementation steps (sequential)

1. Prompt PT-BR retornando 0 (muito negativo) a 1 (muito positivo); 0.5 neutro
2. Worker chama `generateObject({ model: "anthropic/claude-haiku-4-5", schema, system, prompt: msg.body, temperature: 0, maxTokens: 80 })`
3. Update `messages.metadata = jsonb_set(metadata, '{sentiment_score}', $1) || jsonb_build_object('sentiment_latency_ms', $2)`
4. `logInvocation` com `invocation_kind='sentiment_classify'`
5. Se score < `agent.config.sentiment_threshold` (default 0.3, IA-04) → emit `ai.sentiment_alert` (handoff em S-06.03 consome)
6. Try/catch global: erro só loga warn

#### Acceptance Criteria

```gherkin
Given inbound com body "isso é uma palhaçada, vocês são incompetentes"
When ai-sentiment-worker processa
Then messages.metadata.sentiment_score < 0.3
And ai_invocations row com invocation_kind='sentiment_classify' e model='anthropic/claude-haiku-4-5'
And event ai.sentiment_alert emitido
```

```gherkin
Given AI Gateway timeout (mock)
When ai-sentiment-worker processa
Then bot path principal continua funcionando normalmente
And worker loga warning sentiment_classify_failed
```

```gherkin
Given inbound sem body (apenas mídia)
When ai-sentiment-worker processa
Then retorna early sem chamar LLM
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | worker | Score <0.3 em mensagem hostil | Insert mock + poll `messages.metadata->>'sentiment_score'` |
| t2 | worker | Falha de Gateway não quebra bot | Mock fetch 500, verificar bot ainda respondeu |
| t3 | api | `ai_invocations.invocation_kind='sentiment_classify'` | DB query |

#### Architecture contracts emitted

```yaml
exposes:
  - type: worker
    id: "ai-sentiment-worker"
    consumes: ["message.received"]
    emits: ["ai.sentiment_alert"]
  - type: domain_event
    id: "ai.sentiment_alert"
    payload: "{ message_id, conversation_id, sentiment_score }"
```

#### Definition of Done

- [ ] ACs passam
- [ ] Falha de Gateway não regride S-06.01
- [ ] Commit `feat(EPIC-06): sentiment classifier worker [wave 2]`

---

### S-06.03 — Handoff orchestrator (4 gatilhos OR-lógicos)

**Points**: 4 | **Priority**: P0 | **Deps**: S-06.01, S-06.02 | **FR refs**: Spec 05 §7, IA-05, IA-06, IA-07, IA-08, IA-09

#### Contexto

Centraliza os 4 gatilhos em um único orchestrator chamado por: (a) triagem síncrona pré-bot (G1, G4 jurídico) — adiciona step antes de `ai-response-worker.invokeBot`; (b) pós-resposta do bot (G3 confidence/uncertainty markers, G4 stage.requires_human); (c) consumer de `ai.sentiment_alert` (G2). Ação canônica: `conversations.status='pending'` + `last_handoff_at=now()` + `bot_silenced_until='infinity'` (IA-06) + activity `handoff_triggered` + emit `ai.handoff_triggered` + broadcast realtime `org:{org_id}:queue` event `handoff_pending`. Gatilhos não se anulam (IA-05); G1/G3 always-on, G2/G4 podem ser desativados via `agent.config`.

#### Files to create

- `lib/ai/handoff/orchestrator.ts` — `triggerHandoff({ conversation_id, reason, metadata, organization_id, lead_id })`
- `lib/ai/handoff/triggers.ts` — `checkG1`, `checkG3` (uncertainty markers + confidence threshold), `checkG4` (regex jurídico + stage.requires_human)
- `lib/ai/handoff/regex.ts` — `G1_REGEX`, `G4_LEGAL_REGEX`, `UNCERTAINTY_MARKERS`
- `workers/ai-handoff-from-sentiment.handler.ts` — consumer de `ai.sentiment_alert`
- `app/api/v1/conversations/[id]/reactivate-bot/route.ts` — endpoint pra atendente passar pra IA (audit + reset `bot_silenced_until`)

#### Files to modify

- `workers/ai-response-worker.ts` — chamar `checkG1`/`checkG4` no início de `buildContext`; chamar `checkG3` em `postProcess`; chamar `triggerHandoff` em todos os caminhos de handoff
- `supabase/migrations/0008_ai_rag_schema.sql` — adicionar coluna `conversations.bot_silenced_until timestamptz` e `last_handoff_at timestamptz`, `last_handoff_reason text` se não existirem em EPIC-03 (validar)

#### Implementation steps (sequential)

1. Implementar `triggerHandoff` idempotente (guard: se `last_handoff_at` foi <5s atrás com mesmo reason, skip — evita duplicata em race entre G2 e G3)
2. `checkG1` no triage síncrono (regex local <50ms) — bypassa bot
3. `checkG4 jurídico` no triage síncrono (regex Spec 05 §7.4)
4. `checkG4 stage`: query `crm_leads → crm_stages` antes de invocar LLM
5. `checkG3`: chamado em `postProcess` após resposta — `containsUncertaintyMarkers` + `computeConfidence < threshold`
6. Consumer `ai.sentiment_alert` chama `triggerHandoff(reason='low_sentiment')`
7. `bot_silenced_until='infinity'` — em `buildContext` checar `if (conv.bot_silenced_until > now()) skip="bot_silenced"`
8. Endpoint `POST /api/v1/conversations/:id/reactivate-bot`: requer role >= agent, audita `ai_reactivated_by_agent`, set `bot_silenced_until=null`
9. Realtime broadcast em `org:{org_id}:queue` com `event: 'handoff_pending'`

#### Acceptance Criteria

```gherkin
Given inbound "quero falar com humano"
When ai-response-worker processa
Then triage síncrono detecta G1 (regex)
And NÃO invoca Sonnet
And conversations.status='pending', activity handoff_triggered com trigger_reason='requested_human'
And evento ai.handoff_triggered emitido
And broadcast realtime org:{org_id}:queue recebe handoff_pending
```

```gherkin
Given inbound mencionando "vou processar vocês no procon"
When triagem síncrona processa
Then G4 jurídico dispara handoff_immediate (IA-09)
And NÃO chama LLM principal
```

```gherkin
Given resposta do bot contém "não tenho certeza"
When postProcess avalia
Then G3 (uncertainty marker) dispara handoff
And outbound NÃO é enviado pro WhatsApp
```

```gherkin
Given handoff foi triggered (bot_silenced_until=infinity)
When cliente envia novo inbound 1h depois
Then bot NÃO reassume (IA-06)
And outbound não é gerado
```

```gherkin
Given atendente clica "Passar pra IA" via POST /api/v1/conversations/:id/reactivate-bot
Then bot_silenced_until=null
And próximo inbound é processado pelo bot
And audit log registra ai_reactivated_by_agent
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | worker | G1 regex em PT-BR | Inbound "quero atendimento humano" → handoff sem LLM call |
| t2 | worker | G2 dispara após sentiment | Mock score=0.1 → poll activities |
| t3 | worker | G3 confidence | Mock RAG score baixo → handoff |
| t4 | worker | G4 stage critical | Lead em stage com `requires_human=true` → handoff |
| t5 | rt | Broadcast handoff_pending recebido | Subscribe channel, emit event, verificar |
| t6 | guard | Bot não reassume | 2 inbounds seguidos pós-handoff, segundo é skipado |
| t7 | api | Reactivate endpoint requer role agent+ | curl como `viewer` → 403 |

#### Architecture contracts emitted

```yaml
exposes:
  - type: worker
    id: "handoff-orchestrator"
    consumes: ["ai.sentiment_alert", "(invocação direta de ai-response-worker)"]
    emits: ["ai.handoff_triggered"]
  - type: api_route
    id: "POST /api/v1/conversations/:id/reactivate-bot"
    auth: "role >= agent"
  - type: domain_event
    id: "ai.handoff_triggered"
    payload: "{ conversation_id, organization_id, reason: 'requested_human'|'low_sentiment'|'low_confidence'|'critical_stage'|'legal_mention'|'refund_mention', metadata }"
  - type: realtime_channel
    id: "org:{org_id}:queue"
    events: ["handoff_pending"]
```

#### Definition of Done

- [ ] Todos 4 gatilhos testados em isolamento e em combinação
- [ ] IA-06 verificado (bot não reassume sem ação humana)
- [ ] Commit `feat(EPIC-06): handoff orchestrator 4 triggers [wave 3]`

---

### S-06.04 — Worker `rag-indexer` (consumer event-driven)

**Points**: 4 | **Priority**: P0 | **Deps**: S-06.01 | **FR refs**: Spec 05 §4, IA-11

#### Contexto

Worker idempotente que consome `nuvemshop.product_synced` e `knowledge_source.updated` (genérico). Cria nova `ai_knowledge_versions` (staging), processa em batches, faz `upsert` em `ai_chunks` com `content_hash` pra dedup, e ao final chama RPC `activate_kb_version` (swap atômico). Debounce 30s via Redis SET com TTL — coalesce múltiplos eventos do mesmo source. Falha de batch marca versão como `failed`, mantém versão anterior ativa. IA-11 exige re-indexação ≤30s p95 após `nuvemshop.product_synced`.

#### Files to create

- `workers/rag-indexer.ts` — handler principal
- `workers/rag-indexer.handler.ts` — registro no dispatcher
- `lib/ai/rag/chunker.ts` — `chunkText` semantic-aware (Spec 05 §4.5)
- `lib/ai/rag/version.ts` — `createKnowledgeVersion`, `activateVersion` (chama RPC)
- `lib/ai/rag/debounce.ts` — Redis-backed debouncer
- `lib/ai/rag/format-product.ts` — template de catálogo (1 produto = 1 chunk)

#### Files to modify

- `lib/event-log/dispatcher.ts` — registrar `nuvemshop.product_synced`, `knowledge_source.updated` → `rag-indexer.handler`

#### Implementation steps (sequential)

1. Debouncer: `SET rag:debounce:{agent_id}:{source_type} 1 EX 30 NX` — se já existe, skip; processa após TTL
2. Para `nuvemshop.product_synced`: fetch produto via API, formata via `formatProductForRag`, embed, upsert em `ai_chunks` com `metadata.product_id` na onConflict key
3. Para `knowledge_source.updated`: re-indexa source inteira (chama story-specific pipelines de S-06.05/06/07)
4. `createKnowledgeVersion` com `version_number = max + 1` por agent
5. `activateVersion` via RPC `activate_kb_version` — swap atômico
6. Em erro: `markVersionFailed`, mantém versão anterior ativa, emite Sentry
7. Lag monitor: alarme Sentry se lag entre evento e indexação >5min (IA-11)

#### Acceptance Criteria

```gherkin
Given evento nuvemshop.product_synced no event_log
When rag-indexer consome após debounce 30s
Then ai_chunks tem chunk com metadata->>'product_id' atualizado em <30s p95
And nova ai_knowledge_versions criada e ativada via activate_kb_version
And ai_knowledge_versions.is_active=true só pra a nova versão
```

```gherkin
Given embedding falha mid-batch
When rag-indexer processa
Then versão é marcada failed
And versão anterior continua is_active=true (rollback automático)
```

```gherkin
Given 5 eventos product_synced em 10s pro mesmo agent
When debouncer atua
Then apenas 1 ciclo de indexação roda (após TTL 30s)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | worker | Re-index <30s p95 | Bench script emit 100 events, mede p95 |
| t2 | db | Swap atômico não tem janela inconsistente | Race test: query `is_active` durante swap, sempre exatamente 1 |
| t3 | worker | Debouncer coalesce eventos | Emit 5 events, verificar 1 ciclo |
| t4 | worker | Falha mantém versão anterior | Mock embedding 500, verificar rollback |

#### Architecture contracts emitted

```yaml
exposes:
  - type: worker
    id: "rag-indexer"
    consumes: ["nuvemshop.product_synced", "knowledge_source.updated"]
    emits: []
  - type: db_function
    id: "activate_kb_version"
    signature: "(p_agent_id uuid, p_version_id uuid) → void"
    notes: "security definer, swap atômico"
```

#### Definition of Done

- [ ] IA-11 SLA verificado (re-index <30s p95)
- [ ] Commit `feat(EPIC-06): rag-indexer worker [wave 4]`

---

### S-06.05 — Pipeline ingestão FAQ markdown

**Points**: 3 | **Priority**: P0 | **Deps**: S-06.04 | **FR refs**: Spec 05 §4.1

#### Contexto

Admin cola markdown estruturado (cada item delimitado por `## Pergunta` / `## Resposta` ou frontmatter YAML). Endpoint `POST /api/v1/ai/knowledge/sources` com `source_type='faq'` persiste em `ai_knowledge_sources` + tabela auxiliar `ai_faq_items`, emite `knowledge_source.updated` (consumido por S-06.04). Chunker: 1 item = 1 chunk no formato `Pergunta: ...\nResposta: ...\nTags: ...` (sem overlap, FAQ é auto-contida).

#### Files to create

- `app/api/v1/ai/knowledge/sources/route.ts` — POST/GET genérico
- `app/api/v1/ai/knowledge/sources/[id]/route.ts` — PATCH/DELETE
- `lib/ai/rag/ingest/faq.ts` — parser markdown + chunker FAQ
- `supabase/migrations/0008_ai_rag_schema.sql` — extender com `ai_faq_items` (id, source_id, question, answer, tags[], locale, position)

#### Implementation steps (sequential)

1. Migration extend com `ai_faq_items` + RLS
2. Endpoint POST aceita `{ agent_id, source_type:'faq', items: [{question, answer, tags, locale}] }` ou `markdown_blob`
3. Parser markdown: split por `## Pergunta:`/`## Resposta:` ou frontmatter YAML
4. Persiste items + emite `knowledge_source.updated`
5. `ingest/faq.ts` carrega items, gera chunks 1:1, retorna pra rag-indexer

#### Acceptance Criteria

```gherkin
Given admin cola markdown com 10 items FAQ via POST /api/v1/ai/knowledge/sources
When endpoint persiste
Then ai_faq_items tem 10 rows
And evento knowledge_source.updated emitido
And rag-indexer (S-06.04) cria 10 chunks em <60s
```

```gherkin
Given markdown malformado (sem ## Pergunta)
When endpoint processa
Then retorna 400 com schema error
And nada é persistido
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | POST FAQ válido cria source + items | curl + verifica db |
| t2 | rls | FAQ items isolated cross-tenant | Tenant A não vê items de B |
| t3 | worker | RAG retrieval encontra FAQ chunk | embed query similar, verifica top-K inclui faq |

#### Architecture contracts emitted

```yaml
exposes:
  - type: api_route
    id: "POST /api/v1/ai/knowledge/sources"
    request_schema: "{ agent_id, source_type, items? | markdown_blob?, source_metadata }"
  - type: db_table
    id: "ai_faq_items"
```

#### Definition of Done

- [ ] AC passam
- [ ] Commit `feat(EPIC-06): faq ingestion pipeline [wave 5]`

---

### S-06.06 — Pipeline ingestão policy PDF/Markdown

**Points**: 3 | **Priority**: P0 | **Deps**: S-06.05 | **FR refs**: Spec 05 §4.2

#### Contexto

Admin upload PDF/MD via UI (multipart), arquivo vai pra Storage `ai-policy/{org}/{uuid}.pdf` (privado). `pdf-parse` extrai texto, fallback `pdfjs-dist` se layout complexo. Chunker 400 tokens overlap 50, semantic-aware por heading markdown (`#`, `##`). Emite `knowledge_source.updated`. Versão registrada em `source_metadata.version` + `uploaded_by`.

#### Files to create

- `app/api/v1/ai/knowledge/sources/upload/route.ts` — multipart handler
- `lib/ai/rag/ingest/policy.ts` — extract + chunk
- `lib/ai/rag/extractors/pdf.ts` — `pdf-parse` + fallback `pdfjs-dist`
- `lib/ai/rag/extractors/markdown.ts` — leitura raw

#### Files to modify

- `package.json` — `pdf-parse`, `pdfjs-dist`, `unified`, `remark-parse`

#### Implementation steps (sequential)

1. Endpoint multipart valida `Content-Type` (pdf/md), max 20MB
2. Upload pra `ai-policy/{org_id}/{uuid}.{ext}` privado
3. Extract: `pdf-parse(buffer)` → fallback `pdfjs-dist` se erro
4. Chunker 400/50 com `splitOnHeadings=true`
5. Insere `ai_knowledge_sources` com `source_metadata={filename, version, uploaded_by, blob_path}`
6. Emite `knowledge_source.updated`

#### Acceptance Criteria

```gherkin
Given admin faz upload de policy.pdf 5 páginas
When endpoint processa
Then arquivo persistido em ai-policy/ bucket privado
And ai_knowledge_sources row criada com source_type='policy'
And rag-indexer cria N chunks 400-token com overlap 50
```

```gherkin
Given PDF com layout corrompido
When pdf-parse falha
Then fallback pdfjs-dist é tentado
And se ambos falham, retorna 422 + mensagem clara
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | Upload PDF cria source | curl multipart |
| t2 | storage | Bucket `ai-policy` é privado | unauthenticated GET retorna 403 |
| t3 | rls | Policy de tenant A não acessível por B | Signed URL gerada por B falha |

#### Architecture contracts emitted

```yaml
exposes:
  - type: api_route
    id: "POST /api/v1/ai/knowledge/sources/upload"
    request_schema: "multipart { agent_id, file, source_type:'policy' }"
  - type: storage_bucket
    id: "ai-policy"
    visibility: "private"
```

#### Definition of Done

- [ ] AC passam
- [ ] Commit `feat(EPIC-06): policy pdf ingestion [wave 6]`

---

### S-06.07 — Pipeline ingestão conversas resolvidas (opt-in + anonymizer)

**Points**: 3 | **Priority**: P0 | **Deps**: S-06.06 | **FR refs**: Spec 05 §4.4, A11

#### Contexto

Atendente marca `conversations.usable_for_rag=true` na UI. Cron `kb-conversations-batch` (diário 03h) processa novas marcadas. Anonymizer com regex CPF/phone/email/CEP + heurística nomes próprios PT-BR (~5k nomes). Validador automático: se `hits.length===0` em conversa de 10+ msgs → flagga pra revisão manual. Chunker agrupa turnos em janelas ~400 tokens. **Crítico LGPD** (L-08): nenhum CPF/email/phone vai pro embedding.

#### Files to create

- `lib/ai/rag/ingest/conversations.ts` — batch processor
- `lib/ai/anonymize/index.ts` — `anonymize(text)` + `PII_PATTERNS`
- `lib/ai/anonymize/pt-br-first-names.ts` — `FIRST_NAMES_PT_BR` Set
- `workers/kb-conversations-batch.cron.ts` — cron handler
- `app/api/v1/conversations/[id]/usable-for-rag/route.ts` — toggle endpoint (audit)

#### Files to modify

- `supabase/migrations/0008_ai_rag_schema.sql` — adicionar `conversations.usable_for_rag boolean default false` e `usable_for_rag_marked_at`, `usable_for_rag_marked_by`

#### Implementation steps (sequential)

1. Migration: 3 colunas em conversations + audit trigger
2. Endpoint toggle: requer role >= agent, audita
3. Anonymizer com 4 regex + dicionário nomes
4. Validador: `hits.length===0 && msgs >=10` → flag pra `pending_review`, NÃO ingere
5. Cron diário: select conversations marcadas + anonimiza + chunkeriza + embed + upsert
6. `ai_chunks.metadata.anonymized=true, conversation_id, resolved_at`

#### Acceptance Criteria

```gherkin
Given conversa contendo "meu CPF é 123.456.789-00 e meu email é joao@x.com"
When anonymizer processa
Then chunk contém [CPF] e [EMAIL] (zero PII residual)
And ai_chunks.metadata.anonymized=true
```

```gherkin
Given conversa de 15 msgs sem nenhum match de regex
When validador atua
Then conversa é marcada pending_review
And NÃO entra em ai_chunks
```

```gherkin
Given conversation.usable_for_rag=true marcada
When cron noturno roda
Then chunks da conversa anonimizada aparecem em ai_chunks
And evento knowledge_source.updated emitido
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | unit | Anonymizer cobre 4 PII types + nome | snapshot test com fixtures |
| t2 | lgpd | Zero CPF residual em chunks | grep regex CPF em `ai_chunks.content` retorna 0 |
| t3 | cron | Cron processa só marcadas | Insert mix marcadas/não-marcadas, verificar |

#### Architecture contracts emitted

```yaml
exposes:
  - type: api_route
    id: "POST /api/v1/conversations/:id/usable-for-rag"
    auth: "role >= agent"
  - type: cron
    id: "kb-conversations-batch"
    schedule: "0 3 * * *"
```

#### Definition of Done

- [ ] LGPD validator zero PII residual confirmado
- [ ] Commit `feat(EPIC-06): conversations rag ingestion + anonymizer [wave 7]`

---

### S-06.08 — Pages `/app/ai/agents` (lista + editor)

**Points**: 4 | **Priority**: P0 | **Deps**: S-06.01 | **FR refs**: Spec 05 §3.1, §8

#### Contexto

UI de configuração do agent. Lista em `/app/ai/agents` mostra agents do tenant (no MVP só 1 default). Editor `/app/ai/agents/[id]` tem 4 abas: **Geral** (name, description, is_active), **Modelo** (model dropdown, system_prompt textarea com placeholders helper, temperature/max_tokens/context_message_window), **RAG** (rag_top_k, rag_similarity_threshold, confidence_threshold), **Guardrails** (jsonb editor com schema validation Zod do formato Spec 05 §8.1). Save é otimista (TanStack Query mutation) com rollback. Mudanças são auditadas via `trg_ai_agents_audit`.

#### Files to create

- `app/(app)/ai/agents/page.tsx` — lista
- `app/(app)/ai/agents/[id]/page.tsx` — editor com tabs
- `app/api/v1/ai/agents/route.ts` — GET/POST
- `app/api/v1/ai/agents/[id]/route.ts` — GET/PATCH/DELETE
- `hooks/useAgent.ts` — query + mutation
- `components/ai/AgentEditor.tsx` — shell tabs
- `components/ai/GuardrailsEditor.tsx` — jsonb editor com Zod schema visual
- `components/ai/SystemPromptEditor.tsx` — textarea com placeholder helper sidebar
- `lib/ai/guardrails-schema.ts` — Zod schema dos 5 kinds (regex_output_block, rag_must_hit, regex_input_block, window_check, contact_flag)

#### Implementation steps (sequential)

1. APIs CRUD com Zod validation
2. `useAgent` hook com TanStack Query
3. `GuardrailsEditor` com array editor + Zod runtime validation antes de save
4. `SystemPromptEditor` com lista lateral de placeholders disponíveis (`{tenant_name}`, `{vocabulary}`, `{rag_chunks}`, etc)
5. Save dispara mutation otimista; rollback toast em erro
6. Audit verificado: alterar `system_prompt` cria row em audit log

#### Acceptance Criteria

```gherkin
Given user role admin em /app/ai/agents
When clica no agent default
Then é redirecionado pra /app/ai/agents/[id] com 4 abas
```

```gherkin
Given user edita system_prompt e salva
When mutation completa
Then ai_agents.system_prompt atualizado
And audit_log tem entrada com diff
And toast "Salvo" aparece
```

```gherkin
Given user adiciona guardrail inválido (kind desconhecido)
When tenta salvar
Then Zod bloqueia, toast erro com path do campo
And nada é persistido
```

```gherkin
Given user role agent (não admin)
When acessa /app/ai/agents/[id]
Then 403 ou view-only mode
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Tabs renderizam | Playwright getByRole tab |
| t2 | api | PATCH agent valida guardrails Zod | curl com guardrail malformado → 400 |
| t3 | rls | User de tenant A não vê agent de B | login B, GET id de A → 404/403 |
| t4 | audit | Mudança em system_prompt audita | verifica audit_log |

#### Architecture contracts emitted

```yaml
exposes:
  - type: api_route
    id: "GET /api/v1/ai/agents"
  - type: api_route
    id: "PATCH /api/v1/ai/agents/:id"
  - type: react_hook
    id: "useAgent"
    signature: "(id) => { data, isLoading, mutate }"
  - type: route
    id: "/app/ai/agents/[id]"
  - type: react_component
    id: "GuardrailsEditor"
```

#### Definition of Done

- [ ] AC passam
- [ ] Commit `feat(EPIC-06): agents config UI [wave 8]`

---

### S-06.09 — Page `/app/ai/knowledge/sources`

**Points**: 3 | **Priority**: P0 | **Deps**: S-06.05, S-06.06, S-06.07, S-06.08 | **FR refs**: Spec 05 §4

#### Contexto

Lista as 4 fontes do agent ativo: FAQ, Policy, Catálogo Nuvemshop, Conversas opt-in. Cada source mostra `last_indexed_at`, `last_index_status` (success/partial/failed), `chunks_count`, badge de status, botão **"Re-indexar"** (chama `POST /api/v1/ai/knowledge/sources/:id/reindex` que emite `knowledge_source.updated`). FAQ tem botão "Editar markdown"; Policy tem "Upload novo arquivo" + lista de versões; Catálogo mostra "Conectado a Nuvemshop loja X" + lag indicator; Conversas mostra "X conversas opt-in pendentes".

#### Files to create

- `app/(app)/ai/knowledge/sources/page.tsx` — lista
- `app/api/v1/ai/knowledge/sources/[id]/reindex/route.ts` — POST trigger
- `hooks/useKnowledgeSources.ts` — query
- `components/ai/KnowledgeSourceCard.tsx` — card com status + actions

#### Implementation steps (sequential)

1. Page agrega 4 sources do agent default; se source não existe ainda, mostra CTA "Configurar"
2. `KnowledgeSourceCard` mostra ícone tipo + status badge + métricas + botões
3. Endpoint reindex emite `knowledge_source.updated` (consumido por S-06.04)
4. Status de indexação realtime via subscribe a updates em `ai_knowledge_sources`

#### Acceptance Criteria

```gherkin
Given page /app/ai/knowledge/sources com 4 sources
Then exibe 4 cards com status atualizado
And para FAQ: botão "Editar" + chunks_count visível
```

```gherkin
Given user clica "Re-indexar" em policy
When endpoint emite knowledge_source.updated
Then rag-indexer processa
And status do card muda pra "Indexando..." → "Sucesso" em <60s
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | 4 cards renderizam | Playwright |
| t2 | api | Reindex endpoint emite evento | poll event_log |
| t3 | rt | Status atualiza realtime | subscribe + emit |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/app/ai/knowledge/sources"
  - type: api_route
    id: "POST /api/v1/ai/knowledge/sources/:id/reindex"
  - type: react_hook
    id: "useKnowledgeSources"
```

#### Definition of Done

- [ ] AC passam
- [ ] Commit `feat(EPIC-06): knowledge sources UI [wave 9]`

---

### S-06.10 — Page `/app/ai/usage`

**Points**: 3 | **Priority**: P0 | **Deps**: S-06.01, S-06.02 | **FR refs**: Spec 05 §10

#### Contexto

Dashboard de observability. Time-series com Recharts: custo R$/dia (últimos 30d), tokens/dia, latência p50/p95, taxa de handoff (handoffs / inbounds), top-K usage histogram. Filtros: agent, invocation_kind, range de datas. Endpoint `GET /api/v1/ai/usage` agrega `ai_invocations` por dia.

#### Files to create

- `app/(app)/ai/usage/page.tsx` — dashboard
- `app/api/v1/ai/usage/route.ts` — GET com filtros
- `hooks/useAiUsage.ts` — query
- `components/ai/UsageChart.tsx` — Recharts wrapper
- `lib/ai/usage/aggregate.ts` — SQL aggregator (date_trunc + sum)

#### Implementation steps (sequential)

1. SQL aggregator agrupa por `date_trunc('day', created_at)` + filters
2. Endpoint retorna `{ series: { cost_cents[], total_tokens[], p50_latency[], p95_latency[], handoff_rate[] } }`
3. UsageChart com 4 sub-charts (Recharts AreaChart/BarChart)
4. Filtros via URL search params

#### Acceptance Criteria

```gherkin
Given /app/ai/usage com 30 dias de dados
Then 4 charts renderizam (custo, tokens, latência, handoff rate)
And total custo do mês exibido em card de topo
```

```gherkin
Given filtro invocation_kind=bot_respond
When user aplica
Then charts atualizam mostrando só bot (sem sentiment)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Charts renderizam | Playwright |
| t2 | api | Aggregator agrupa por dia corretamente | seed 100 rows, verifica buckets |
| t3 | rls | Tenant A não vê uso de B | API call cross-tenant retorna vazio |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/app/ai/usage"
  - type: api_route
    id: "GET /api/v1/ai/usage"
    query_params: "agent_id?, invocation_kind?, from?, to?"
  - type: react_hook
    id: "useAiUsage"
```

#### Definition of Done

- [ ] AC passam
- [ ] Commit `feat(EPIC-06): ai usage dashboard [wave 10]`

---

### S-06.11 — Budget enforcement (alarme 80% + throttle 100%)

**Points**: 4 | **Priority**: P0 | **Deps**: S-06.01, S-06.10 | **FR refs**: Spec 05 §10.3, IA-10

#### Contexto

Trigger Postgres `trg_ai_invocations_budget` after insert em `ai_invocations` faz `update ai_budgets set current_month_consumed_cents = current_month_consumed_cents + NEW.cost_cents` (transação atômica). Cron horário `ai-budget-checker`: para cada tenant, calcula `pct = consumed / monthly_limit`. Se `pct >= alarm_threshold_pct` (default 80) e `last_alarm_sent_at` >24h → emite `ai.budget_warning` + envia email admin. Se `pct >= 100`: se `action_at_100pct='throttle'` → set `is_throttled=true`, emite `ai.budget_throttled`; se `disable` → `is_disabled=true`. Bot worker (S-06.01) já checa `isBudgetExhausted` antes de invocar. Reset mensal: cron mensal zera `current_month_consumed_cents` no dia 1. Realtime: channel `realtime.ai-budget-{org_id}` recebe broadcast em mudanças de status. **Importante**: throttle pausa bot mas **handoff continua funcionando** (cliente sempre tem humano — IA-10).

#### Files to create

- `supabase/migrations/0008_ai_rag_schema.sql` — extender com trigger `trg_ai_invocations_budget` + função `fn_update_budget_consumption`
- `workers/ai-budget-checker.cron.ts` — cron horário
- `workers/ai-budget-reset.cron.ts` — cron mensal (dia 1, 00:05)
- `lib/ai/budget/check.ts` — `isBudgetExhausted(org_id)`, `currentBudgetStatus(org_id)`
- `app/api/v1/ai/budget/route.ts` — GET status + PATCH config (monthly_limit_cents, action_at_100pct, alarm_threshold_pct)
- `hooks/useAiBudget.ts` — query + realtime subscribe
- `components/ai/BudgetCard.tsx` — card com gauge + edit modal
- `lib/email/templates/ai-budget-alarm.tsx` — react-email template

#### Files to modify

- `app/(app)/ai/usage/page.tsx` — adicionar `<BudgetCard>` no topo
- `workers/ai-response-worker.ts` — `isBudgetExhausted` guard antes de invocar (já stub em S-06.01, agora real)

#### Implementation steps (sequential)

1. Migration: trigger after insert ai_invocations atualiza ai_budgets atomicamente
2. Cron horário: scan ai_budgets, calcula pct, dispara warning/throttle conforme thresholds; debounce alarme via `last_alarm_sent_at >24h`
3. Cron mensal: reset `current_month_consumed_cents=0`, `current_period_start=current_date`, `is_throttled=false` (mantém `is_disabled` se admin setou)
4. Email template react-email; envio via Resend/SES (decisão herdada EPIC-00)
5. Realtime broadcast em `realtime.ai-budget-{org_id}` quando status muda
6. Endpoint GET retorna estado runtime; PATCH valida (admin only) e audita
7. `BudgetCard` exibe gauge + status + botão "Editar limite"
8. Bot guard real: `isBudgetExhausted` retorna `is_throttled || is_disabled`

#### Acceptance Criteria

```gherkin
Given tenant com monthly_limit=5000 cents e consumed=4001
When trigger ai_invocations soma cost
Then pct=80.02% e cron emite ai.budget_warning
And email admin enviado uma vez (next 24h debounced)
And realtime broadcast em ai-budget-{org_id}
```

```gherkin
Given tenant atinge consumed >= monthly_limit
When cron processa
Then ai_budgets.is_throttled=true
And evento ai.budget_throttled emitido
And próximo inbound: bot worker skip="budget_exhausted"
And handoff continua funcionando (cliente vê atendente humano)
```

```gherkin
Given dia 1 do mês 00:05
When cron reset roda
Then ai_budgets.current_month_consumed_cents=0
And is_throttled=false
And bot volta a responder
```

```gherkin
Given user admin acessa /app/ai/usage
Then BudgetCard mostra gauge atual (ex: 67% de R$50)
And é o único role que vê botão "Editar limite"
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | db | Trigger atualiza ai_budgets atomicamente | insert ai_invocations, verifica delta |
| t2 | cron | 80% emite warning uma vez/24h | seed 80%, run cron 2× em 1h, verificar 1 alarme |
| t3 | worker | Throttle skipa bot mas handoff funciona | set is_throttled=true, emit message.received com G1 → handoff ainda dispara |
| t4 | cron | Reset mensal zera | mock data dia 1, verifica reset |
| t5 | rt | Realtime broadcast recebido | subscribe + simular mudança |
| t6 | email | Email admin enviado | mock Resend, verificar payload |

#### Architecture contracts emitted

```yaml
exposes:
  - type: db_table
    id: "ai_budgets"
  - type: db_trigger
    id: "trg_ai_invocations_budget"
  - type: cron
    id: "ai-budget-checker"
    schedule: "0 * * * *"
  - type: cron
    id: "ai-budget-reset"
    schedule: "5 0 1 * *"
  - type: api_route
    id: "GET /api/v1/ai/budget"
  - type: api_route
    id: "PATCH /api/v1/ai/budget"
    auth: "role admin"
  - type: realtime_channel
    id: "ai-budget-{org_id}"
    events: ["budget_warning", "budget_throttled", "budget_reset"]
  - type: domain_event
    id: "ai.budget_warning"
  - type: domain_event
    id: "ai.budget_throttled"
  - type: react_hook
    id: "useAiBudget"
```

#### Decisões a registrar

- Throttle pausa bot mas **nunca pausa handoff** — cliente sempre tem caminho pra humano (IA-10).
- Debounce de alarme 24h pra evitar spam de email.

#### Definition of Done

- [ ] IA-10 verificado (handoff funciona em estado throttled)
- [ ] Commit `feat(EPIC-06): budget enforcement [wave 11]`

---

### S-06.12 — Citations capture + UI debug toggle

**Points**: 2 | **Priority**: P0 | **Deps**: S-06.01, EPIC-03 ChatThread | **FR refs**: Spec 05 §9

#### Contexto

Citations já são extraídas em `postProcess` (S-06.01) e persistidas em `messages.metadata.citations[]` + `ai_invocations.citations`. Esta story conecta a UI: no `ChatThread` (EPIC-03), mensagens com `metadata.ai_generated=true` ganham botão "i" que abre `<CitationsPanel>` lateral mostrando lista de chunks com `score`, `source_type`, `source_anchor`, link pra source. Toggle global de debug em user preferences (`/app/settings/preferences`) controla se ícone aparece (default: visível só pra admin/agent).

#### Files to create

- `components/ai/CitationsPanel.tsx` — drawer lateral com lista
- `components/ai/CitationButton.tsx` — botão "i" no MessageBubble
- `hooks/useDebugToggle.ts` — leitura de user preferences

#### Files to modify

- `components/inbox/MessageBubble.tsx` (EPIC-03) — renderizar `<CitationButton>` se `message.metadata.ai_generated && debugToggle && metadata.citations?.length`
- `app/(app)/settings/preferences/page.tsx` (EPIC-10 ou stub se ainda não existe) — toggle "Mostrar citações IA"

#### Implementation steps (sequential)

1. `CitationButton` ícone Phosphor `Info` discreto no canto da bubble
2. Click abre `CitationsPanel` (Sheet shadcn) com lista dos chunks
3. Cada item: badge tipo (FAQ/Policy/Catalog/Conv), score (%), `metadata.source_anchor`, snippet 200 chars, link "Ver fonte"
4. `useDebugToggle` lê de `user_preferences.show_ai_citations` (default true pra admin/agent, false pra viewer)

#### Acceptance Criteria

```gherkin
Given mensagem outbound com metadata.ai_generated=true e 3 citations
When user (admin) com show_ai_citations=true abre conversa
Then ícone "i" aparece na bubble
And clique abre painel com 3 chunks listados
And cada chunk mostra score, source_type, snippet
```

```gherkin
Given user role viewer com show_ai_citations=false
Then ícone "i" NÃO aparece nas bubbles
```

```gherkin
Given mensagem do bot sem citations (ex: resposta sem RAG hit)
Then ícone "i" também aparece mas painel mostra "Resposta sem RAG hits"
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Ícone aparece em bubble IA-generated | Playwright |
| t2 | ui | Painel exibe N citations | seed message com citations |
| t3 | ui | Toggle off esconde ícone | preferences false → 0 ícones |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_component
    id: "CitationsPanel"
    props: "{ citations: Citation[], onClose }"
  - type: react_hook
    id: "useDebugToggle"
```

#### Definition of Done

- [ ] AC passam
- [ ] Não regride EPIC-03 (ChatThread continua funcionando sem flag)
- [ ] Commit `feat(EPIC-06): citations capture + debug toggle [wave 12]`

---

## 6. Regression Suite Cumulativo (esperado ao final)

| Categoria | # de tests | Origem |
|---|---|---|
| UI rendering (4 pages + components) | 12 | S-06.08, S-06.09, S-06.10, S-06.11, S-06.12 |
| API contracts (5 routes + reindex + reactivate-bot + budget) | 14 | S-06.01, S-06.05, S-06.06, S-06.08, S-06.09, S-06.10, S-06.11 |
| Worker behavior (4 workers + 2 crons) | 18 | todas |
| RLS isolation (7 tabelas ai_*) | 7 | S-06.01 |
| Realtime (handoff_pending + budget alarms) | 4 | S-06.03, S-06.11 |
| Guardrails (5 kinds + post-process) | 6 | S-06.01, S-06.03, S-06.08 |
| Handoff triggers G1-G4 + reactivate-bot | 6 | S-06.03 |
| Anonymizer (4 PII types + nome) | 5 | S-06.07 |
| Budget enforcement (warning/throttle/reset) | 5 | S-06.11 |
| **Total** | **~77** | |

## 7. Riscos & Mitigações específicos do epic

| Risco | Severidade | Mitigação |
|---|---|---|
| Latência p95 do bot > 3s estoura SLA | Alta | streamText com early-detect guardrail; AI Gateway fallback Anthropic→OpenAI; medir em S-06.10; budget de prompt size em context_message_window |
| Vector store retorna chunks de outro tenant | Crítico | Filtro programático `organization_id` em RPC + RLS policy + test t2 em S-06.01 |
| PII vaza pra embedding em conversas opt-in | Crítico (LGPD) | Anonymizer obrigatório + validador `hits.length===0` flagga revisão |
| Re-indexação trava com erro mid-batch | Média | Versionamento atômico; falha mantém versão anterior ativa |
| Bot promete reembolso (IA-07) | Alta | Guardrail dual: prompt + regex pós-resposta; teste em S-06.03 |
| Custo IA estoura sem alarme | Alta | Trigger DB + cron horário + email + realtime broadcast |
| Tenant em 100% perde acesso a humano | Crítico | Throttle pausa bot mas handoff continua (IA-10 + teste t3 S-06.11) |
| Cliente fica preso com bot ruim sem opção | Alta | G1 regex always-on + handoff sempre disponível |
| Mid-stream guardrail violation desperdiça tokens | Baixa | `result.controller.abort()` no momento do detect |
| Lag de re-indexação >5min (IA-11) | Média | Sentry alarme; debouncer 30s; medir p95 |

## 8. Decisões arquiteturais novas que este epic introduz

- **ADR-EPIC06-01**: pgvector (não Supabase Vector) — RLS unificada, joins triviais, sem lock-in
- **ADR-EPIC06-02**: Strings de modelo via Vercel AI Gateway — `"anthropic/claude-sonnet-4-6"`, nunca `import Anthropic`
- **ADR-EPIC06-03**: Embeddings text-embedding-3-small 1536-dim — fixado por migration; mudança exige re-embed total
- **ADR-EPIC06-04**: Defesa em profundidade — guardrails como prompt + validador programático; filtro org_id programático + RLS
- **ADR-EPIC06-05**: Versionamento atômico de KB com swap RPC — rollback em <2s
- **ADR-EPIC06-06**: Bot não reassume após handoff (IA-06) — `bot_silenced_until='infinity'` até endpoint reactivate
- **ADR-EPIC06-07**: Throttle pausa bot mas nunca handoff — cliente sempre tem caminho humano (IA-10)
- **ADR-EPIC06-08**: Citations são snapshot (jsonb), não FK — preserva histórico após purge de chunks de versões antigas
- **ADR-EPIC06-09**: Insert em `ai_invocations` é fire-and-forget via `queueMicrotask` — log nunca bloqueia path crítico
- **ADR-EPIC06-10**: ivfflat lists=100 default — migrar HNSW quando algum tenant passar 100k chunks

## 9. Anexos

- Spec ref principal: `docs/specs/05-spec-ai-rag-handoff.md` (todas seções §1–§11)
- Spec eventos/workers: `docs/specs/07-spec-events-workers.md` (push handler pattern, dispatcher)
- Business rules: IA-01 a IA-11, L-08 (PII em logs/embeddings), L-09 (token Nuvemshop), B-02 (custo rateado)
- Reconciliation log: R-04 (RAG cross-tenant filter), R-08 (model strings) se aplicáveis
- Screen flow: `docs/design-system/screen-flow/03-screen-inventory.md` rotas `/app/ai/agents`, `/app/ai/agents/[id]`, `/app/ai/knowledge/sources`, `/app/ai/usage`
- Design system: `docs/design-system/components/` (cards, tabs, drawer/sheet, charts wrappers)
