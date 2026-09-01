---
epic_id: EPIC-13-ai-agents-module
epic_name: AI Agents Module (Configurable WhatsApp Agents + Internal MCP)
priority: P0
estimated_waves: 12
estimated_total_points: 44
depends_on: [EPIC-00, EPIC-01, EPIC-03, EPIC-04, EPIC-05, EPIC-06]
exposes_contracts:
  - "db.ai_agent_versions"
  - "db.ai_provider_credentials"
  - "db.ai_agent_runs"
  - "db.ai_models"
  - "api.GET /api/v1/ai/providers/:p/models"
  - "api.POST /api/v1/ai/credentials"
  - "api.POST /api/v1/ai/agents (kind=mcp_agent)"
  - "api.POST /api/v1/ai/agents/:id/versions"
  - "api.POST /api/v1/ai/agents/:id:publish"
  - "api.POST /api/v1/ai/agents/:id/versions/:vid:test"
  - "api.POST /api/v1/ai/agents/:id/runs"
  - "mcp.endpoint /api/mcp"
  - "mcp.tool.crm_search_contacts"
  - "mcp.tool.crm_get_conversation_history"
  - "mcp.tool.crm_send_whatsapp_message"
  - "mcp.tool.crm_create_lead"
  - "mcp.tool.crm_move_lead_stage"
  - "mcp.tool.crm_request_human_handoff"
  - "worker.agent-dispatcher"
  - "endpoint.internal /api/internal/agents/run"
  - "event.ai_agent.dispatch_requested"
  - "event.ai_agent.run_started"
  - "event.ai_agent.run_completed"
  - "event.ai_agent.handoff_triggered"
  - "event.ai_agent.published"
  - "realtime.ai_agent_runs-{org_id}"
status: pending
created_at: 2026-05-05
owner: Songhai, Lda
research_dossier: ~/tino-ai/Tino/research/pre-development/ai-agent-framework-deskcomm-whatsapp/
specs:
  - docs/specs/10-spec-ai-agents-runtime.md
  - docs/specs/11-spec-mcp-server-internal.md
  - docs/specs/12-spec-ai-agents-ui.md
---

# EPIC-13 — AI Agents Module (Configurable WhatsApp Agents + Internal MCP)

> **Para o epic-executor**: leia este arquivo inteiro antes de qualquer wave. As stories estão em ordem de dependência. Cada story = 1 wave. Não pular ordem mesmo que pareça independente — `Deps:` é lei.
>
> **Documentos canônicos** (leitura obrigatória antes de qualquer wave):
> - **Spec 10** (`docs/specs/10-spec-ai-agents-runtime.md`) — schema + endpoints + worker + runtime
> - **Spec 11** (`docs/specs/11-spec-mcp-server-internal.md`) — catálogo MCP + auth + transport
> - **Spec 12** (`docs/specs/12-spec-ai-agents-ui.md`) — telas, fluxos, wireframes
> - **Research dossier** (`~/tino-ai/Tino/research/pre-development/ai-agent-framework-deskcomm-whatsapp/`) — decisão de stack e tradeoffs
>
> **Decisões locked do dossier (não revisitar)**:
> 1. Vercel AI SDK v6 direto. Sem Mastra, sem LangGraph, sem OpenAI Agents SDK.
> 2. MCP HTTP transport (Streamable HTTP / SSE) — sem stdio em produção.
> 3. Multi-provider via AI Gateway com strings `"provider/model"` aceitando BYO keys do tenant.
> 4. Tenant BYO API keys cifradas AES-GCM. Plataforma não pooleia.
> 5. Multi-agente por sessão WAHA, prioridade configurável, mas dispatcher escolhe **1 e somente 1** por mensagem (`ORDER BY priority DESC, created_at ASC LIMIT 1`).
> 6. Handoff humano: tool MCP `crm_request_human_handoff` (intent) + sentinela determinística por keywords (bypass LLM).
> 7. Save/Publish: versionamento atomic via `ai_agents.published_version_id`.
>
> **Coexistência com EPIC-06**: agentes da Spec 05 ganham `kind='rag_bot'` (legado, mantido). Novos agentes deste epic nascem com `kind='mcp_agent'`. Os dois caminhos coexistem; dispatcher decide qual ativar por gatilho match.
>
> **Anti-patterns proibidos** (PR rejeitado):
> - `import Anthropic from "@anthropic-ai/sdk"` — sempre via AI Gateway com string
> - Trigger Postgres fazendo HTTP — usar `event_log` + worker (regra Spec 07)
> - Service role em handler sem filtrar `organization_id` manualmente
> - API key (provider OU bearer) em URL/log/Sentry breadcrumb
> - `getSession()` no backend — sempre `getUser()`
> - Tool MCP que faz query SQL custom — sempre via handler core extraído (`_handler.ts`)

## 1. Objetivo

Entregar o **módulo de agentes configuráveis de IA** do SonghaiCRM: cada tenant configura N agentes com prompt + provider/model + chave BYO + tools MCP + sessão WhatsApp + gatilhos + prioridade. Um webhook WAHA inbound dispara o dispatcher que seleciona o agente top-priority cujo gatilho match, executa o `ToolLoopAgent` (Vercel AI SDK v6) contra MCP server interno (que expõe os endpoints REST existentes do CRM), e devolve a resposta via `WAHA sendText` na mesma sessão. UI permite Save/Publish com versionamento atômico, test mode com trace, log de execuções em realtime.

## 2. Resultado esperado (Definition of Done do Epic)

- [ ] Tenant cria credencial Anthropic/OpenAI/Google via UI; key cifrada AES-GCM; validação async ping `/v1/models` do provider; `last4` exposto, plaintext nunca volta do DB
- [ ] Tenant cria agente `kind='mcp_agent'` com prompt + provider+model + tools + sessão + gatilhos; salva como draft v1
- [ ] Test mode renderiza trace passo-a-passo (tool calls, tokens, custo, latência) sem enviar ao WAHA real
- [ ] Publish atômico: previous version → `superseded`, new version → `published`, `ai_agents.published_version_id` aponta nova versão; audit log entry `ai_agent.published`
- [ ] Webhook WAHA inbound (não-grupo, não-fromMe) emite `event_log` `ai_agent.dispatch_requested`
- [ ] Worker `agent-dispatcher` (cron) lê eventos, escolhe top-priority agente match, valida budget, cria `ai_agent_runs` row e dispara `/api/internal/agents/run`
- [ ] Runtime carrega versão + decrypt credential + history + MCP tools selecionadas, roda `ToolLoopAgent` com `stopWhen: stepCountIs(N)` + token/cost budget guards, envia resposta final via `WAHA sendText` na mesma sessão e `chat_id`
- [ ] Sentinela determinística: keyword `falar com humano|atendente|pessoa real` no inbound bypassa LLM, dispara handoff direto, run.status='handoff'
- [ ] Tool `crm_request_human_handoff` invocada pelo agente atribui conversation a user disponível, emite event `ai_agent.handoff_triggered`, run.status='handoff'
- [ ] Concorrência: 2 dispatches simultâneos para mesma `conversation_id` → apenas 1 vira `running` (partial unique index `ai_agent_runs_one_running_per_conv`)
- [ ] Multi-agente: 2 agentes publicados na mesma sessão com prioridades 10 e 5 → dispatcher sempre escolhe o de priority=10
- [ ] MCP server `/api/mcp` retorna 13 tools via `tools/list`; bearer token efêmero do agente autoriza `actor_type='ai_agent'`
- [ ] Audit log entries com `actor_type='ai_agent'` aparecem para cada tool call (mutations) e para mutations REST do módulo
- [ ] UI: lista, edit, test, runs (realtime), history, credentials — todas funcionais com RBAC (viewer read-only, manager full-read, admin write)
- [ ] Cross-tenant isolation auditado: tenant A não vê agentes/versões/runs/credentials/tool_calls de tenant B (RLS + filtro programático em handlers admin client)
- [ ] Sentry `beforeSend` strippa `authorization`, `x-api-key`, `*_key`, `*_secret` — smoke test no CI confirma 0 occurrences em runs
- [ ] Regression suite cobre 12 stories: schema, MCP, endpoints REST, worker, runtime, webhook hook, UI 4 telas

## 3. Pré-requisitos

- Epics anteriores completos: `EPIC-00` (foundation), `EPIC-01` (auth/RBAC/api_tokens), `EPIC-03` (WAHA + channel_sessions + webhook + messages), `EPIC-04` (pipelines + lead activities + assignment), `EPIC-05` (customer 360 + contacts), `EPIC-06` (ai_agents/ai_budgets — mesmo schema base, este epic estende)
- Migrations Supabase 0001-0022 aplicadas
- Variáveis de env novas:
  - `AI_CRED_AES_KEY` — 32 bytes base64 (encryption key para `ai_provider_credentials`)
  - `INTERNAL_SECRET` — bearer para `/api/internal/agents/run`
  - `INTERNAL_MCP_URL` — URL do `/api/mcp` (mesma origem em prod, override em dev)
  - `AI_GATEWAY_API_KEY` — já existente (EPIC-06), reutilizado
- Pacotes npm novos: `ai@^6`, `@ai-sdk/gateway@latest`, `@modelcontextprotocol/sdk@latest`, `@noble/ciphers@latest`
- Dev server rodando em `localhost:3001`
- Playwright MCP conectado pra QA
- Upstash Redis configurado (rate limit já em uso)

## 4. Architecture Contracts

### 4.1 Contracts consumidos (de epics anteriores)

| Contract ID | Tipo | Origem | Como usar |
|---|---|---|---|
| `auth.user-session` | session | EPIC-01 | `useAuth()` em `/app/ai/agents/*` |
| `db.organizations` | db_table | EPIC-00 | FK em todas tabelas novas |
| `db.fn_user_org_ids` | db_function | EPIC-00 | Base das policies RLS |
| `db.fn_audit_log_row` | db_function | EPIC-01 | Trigger audit em todas tabelas mutáveis |
| `db.event_log` | db_table | EPIC-00 | Worker consome `ai_agent.dispatch_requested`; emite outros 4 eventos |
| `db.api_tokens` | db_table | EPIC-01 | Auth bearer reutilizado pra MCP |
| `db.ai_agents` | db_table | EPIC-06 | **Estendido** com `published_version_id`, `priority`, `archived_at`, `kind` |
| `db.ai_budgets` | db_table | EPIC-06 | Worker valida budget antes de dispatch |
| `db.channel_sessions` | db_table | EPIC-03 | FK em `ai_agent_versions.channel_session_id` |
| `db.conversations` | db_table | EPIC-03 | Run referencia + handoff atualiza `assigned_user_id` |
| `db.messages` | db_table | EPIC-03 | Inbound dispara dispatch; outbound criado pelo runtime |
| `db.contacts` | db_table | EPIC-05 | Tool `crm_search_contacts` lê |
| `db.crm_leads` + stages | db_table | EPIC-04 | Tools `crm_*_lead*` |
| `db.crm_lead_activities` | db_table | EPIC-04 | Activity `handoff` polimórfica |
| `event.message.received` | domain_event | EPIC-03 | Webhook handler emite ANTES de `ai_agent.dispatch_requested` (mantido) |
| `realtime.org-{org_id}` | realtime_channel | EPIC-01 | Broadcast estados de run |
| `lib.api.wrappers` | shared_lib | EPIC-00 | `ok()`/`fail()` em todos endpoints novos |
| `lib.supabase.{server,admin}` | shared_lib | EPIC-00 | Clients canônicos |
| `lib.upstash.rateLimit` | shared_lib | EPIC-01 | Per-tenant rate limit no dispatcher |

### 4.2 Contracts expostos (consumíveis por epics futuros)

| Contract ID | Tipo | Wave que expõe | Descrição pra consumidores |
|---|---|---|---|
| `db.ai_agent_versions` | db_table | S-13.01 | Versionamento Save/Publish |
| `db.ai_provider_credentials` | db_table | S-13.01 | Keys BYO cifradas AES-GCM |
| `db.ai_agent_runs` | db_table | S-13.01 | Log de execuções com trace jsonb |
| `db.ai_models` | db_table | S-13.01 | Catálogo curado read-only |
| `view.ai_provider_credentials_safe` | db_view | S-13.01 | SELECT sem campos cifrados |
| `lib.crypto.aes_gcm` | shared_lib | S-13.05 | `encryptKey()`/`decryptKey()` |
| `lib.api.handlers.contacts` | shared_lib | S-13.02 | Handler core extraído de `_handler.ts` |
| `lib.api.handlers.conversations` | shared_lib | S-13.02 | idem |
| `lib.api.handlers.messages` | shared_lib | S-13.02 | idem |
| `lib.api.handlers.leads` | shared_lib | S-13.02 | idem |
| `lib.api.handlers.pipelines` | shared_lib | S-13.02 | idem |
| `mcp.endpoint /api/mcp` | mcp_server | S-13.03 | Streamable HTTP transport |
| `mcp.tool.crm_search_contacts` | mcp_tool | S-13.03 | Spec 11 §3.1 |
| `mcp.tool.crm_get_contact` | mcp_tool | S-13.03 | idem |
| `mcp.tool.crm_list_conversations` | mcp_tool | S-13.03 | idem |
| `mcp.tool.crm_get_conversation` | mcp_tool | S-13.03 | idem |
| `mcp.tool.crm_get_conversation_history` | mcp_tool | S-13.03 | idem |
| `mcp.tool.crm_list_leads` | mcp_tool | S-13.04 | Spec 11 §3.1 |
| `mcp.tool.crm_get_lead` | mcp_tool | S-13.04 | idem |
| `mcp.tool.crm_list_pipelines` | mcp_tool | S-13.04 | idem |
| `mcp.tool.crm_send_whatsapp_message` | mcp_tool | S-13.04 | Spec 11 §3.2 |
| `mcp.tool.crm_create_lead` | mcp_tool | S-13.04 | idem |
| `mcp.tool.crm_update_lead` | mcp_tool | S-13.04 | idem |
| `mcp.tool.crm_move_lead_stage` | mcp_tool | S-13.04 | idem |
| `mcp.tool.crm_request_human_handoff` | mcp_tool | S-13.04 | Spec 11 §3.3 |
| `api.GET /api/v1/ai/providers/:p/models` | api_route | S-13.01 | Catálogo curado |
| `api.GET /api/v1/mcp/tools` | api_route | S-13.04 | Lista tools p/ UI popular checklist |
| `api.* /api/v1/ai/credentials` | api_route | S-13.05 | CRUD credentials BYO |
| `api.* /api/v1/ai/agents` | api_route | S-13.06 | CRUD agentes + versões |
| `api.POST /api/v1/ai/agents/:id:publish` | api_route | S-13.06 | Atomic version flip |
| `api.POST /api/v1/ai/agents/:id/versions/:vid:test` | api_route | S-13.06 | Dry-run com trace |
| `api.GET /api/v1/ai/agents/:id/runs` | api_route | S-13.06 | Log paginado |
| `worker.agent-dispatcher` | worker | S-13.07 | Cron consumer de `event_log` |
| `endpoint.internal /api/internal/agents/run` | internal_endpoint | S-13.08 | ToolLoopAgent runtime |
| `event.ai_agent.dispatch_requested` | domain_event | S-13.09 | Webhook hook emite |
| `event.ai_agent.run_started` | domain_event | S-13.08 | Runtime emite |
| `event.ai_agent.run_completed` | domain_event | S-13.08 | Runtime emite |
| `event.ai_agent.handoff_triggered` | domain_event | S-13.08 | Runtime emite (tool ou sentinela) |
| `event.ai_agent.published` | domain_event | S-13.06 | Endpoint :publish emite |
| `realtime.ai_agent_runs-{org_id}` | realtime_channel | S-13.12 | UI tab Runs subscribe |
| `hook.useAgents` | react_hook | S-13.10 | Lista + filtros |
| `hook.useAgent` | react_hook | S-13.11 | Detail + versions |
| `hook.useAgentRuns` | react_hook | S-13.12 | Realtime runs |
| `hook.useCredentials` | react_hook | S-13.10 | Credenciais (safe view) |
| `ui.<AgentForm>` | react_component | S-13.11 | Form principal de configuração |
| `ui.<ToolPicker>` | react_component | S-13.11 | Checklist de MCP tools |
| `ui.<RunTrace>` | react_component | S-13.12 | Render passo-a-passo |
| `ui.<VersionDiff>` | react_component | S-13.12 | Side-by-side de versões |

## 5. Stories (em ordem de dependência)

> Cada story abaixo vira UMA wave do epic-executor. Wave 1 = primeira story; wave 12 = última. Deps internos respeitados pela ordem.

---

### S-13.01 — Schema delta + RLS + seed `ai_models`

**Points**: 3 | **Priority**: P0 | **Deps**: (none) | **FR refs**: Spec 10 §3

#### Contexto
Fundação do módulo. Estende `ai_agents` (não recria) e adiciona 4 tabelas novas com RLS via `fn_user_org_ids()` e audit triggers via `fn_audit_log_row()`. Sem RLS = vazamento cross-tenant garantido — gate de CI bloqueia. Seed inicial de `ai_models` com 8 modelos curados (Spec 10 §2.2). Migration deve ser idempotente.

#### Files to create
- `supabase/migrations/20260505_0023_ai_agents_module.sql` — migration completa

#### Files to modify
- `supabase/migrations/MANIFEST.md` — adicionar entry da nova migration

#### Implementation steps (sequential)
1. Criar migration com:
   - `alter table ai_agents add column published_version_id uuid, priority int default 0, archived_at timestamptz, kind text default 'rag_bot' check (...)`
   - Backfill: agentes existentes recebem `kind='rag_bot'`, `priority=0`
   - `create table ai_agent_versions ...` (Spec 10 §3.2)
   - `create table ai_provider_credentials ...` (Spec 10 §3.3)
   - `create view ai_provider_credentials_safe as select (sem campos cifrados)` (Spec 10 §3.3)
   - `create table ai_agent_runs ...` com partial unique index `one_running_per_conv` (Spec 10 §3.4)
   - `create table ai_models ...` (Spec 10 §3.5)
   - RLS em todas as tabelas tenant-aware via `fn_user_org_ids()`
   - Audit triggers `trg_<tabela>_audit` via `fn_audit_log_row()`
   - INSERT com 8 rows em `ai_models` (Spec 10 §2.2)
2. Aplicar migration no Supabase remoto via `supabase db push`
3. Verificar `mcp__plugin_supabase_supabase__list_tables` retorna as 4 novas tabelas com RLS habilitada

#### Acceptance Criteria

```gherkin
Given a fresh database
When migration 0023 is applied
Then tables ai_agent_versions, ai_provider_credentials, ai_agent_runs, ai_models exist
And ai_provider_credentials_safe view exists
And ai_agents has new columns published_version_id, priority, archived_at, kind
And RLS is enabled on all 4 tenant-aware tables
And audit triggers exist on the 3 mutable tables (not ai_models which is global)
And ai_models has 8 rows seeded
```

```gherkin
Given organization A and B exist
When user from org A queries ai_agent_versions
Then they see only versions belonging to org A
And service role admin client can read all but handler must filter org_id
```

```gherkin
Given two ai_agent_runs are inserted with same conversation_id, status='running'
When the second insert is attempted
Then it fails with unique violation 23505
And the partial index ai_agent_runs_one_running_per_conv guards correctness
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | db | Migration applies clean | `mcp__plugin_supabase_supabase__list_migrations` mostra 0023 success |
| t2 | rls | Tenant isolation funciona | SQL como user A → 0 rows de B em todas as 4 tabelas |
| t3 | db | ai_models seed presente | `select count(*) from ai_models where deprecated_at is null` >= 8 |
| t4 | db | Partial unique index aplica | inserts paralelos same conv → 1 OK, 1 falha 23505 |
| t5 | db | Audit trigger captura | `update ai_agent_versions ... ; select * from api_audit_log where resource_type='ai_agent_versions'` retorna entry |

#### Architecture contracts emitted

```yaml
exposes:
  - type: db_table
    id: "ai_agent_versions"
    columns: [id, organization_id, agent_id, version_number, system_prompt, provider, model, credential_id, tool_ids, trigger_config, channel_session_id, max_steps, token_budget, cost_budget_cents, history_message_window, history_token_window, handoff_keywords, handoff_tool_enabled, status, published_at, superseded_at, created_at, created_by]
    rls_policy: "tenant_isolation_ai_agent_versions_all"
  - type: db_table
    id: "ai_provider_credentials"
    rls_policy: "tenant_isolation_ai_provider_credentials_*"
    notes: "API key plaintext NEVER returned. Use ai_provider_credentials_safe view for SELECT."
  - type: db_table
    id: "ai_agent_runs"
    indexes: ["one_running_per_conv (partial unique)", "org_started_idx", "agent_idx", "status_idx"]
  - type: db_table
    id: "ai_models"
    notes: "GLOBAL (not tenant-aware). Read-all, write-via-migration only."
  - type: db_view
    id: "ai_provider_credentials_safe"
    columns: [id, organization_id, provider, label, api_key_last4, validated_at, validation_error, models_available, is_active, created_by, created_at, updated_at]
```

#### Decisões a registrar
- Migration adota timestamp `20260505_0023`. Próximas migrations do epic seguem 0024+.
- `ai_models.is_default_for_provider` partial unique — apenas 1 default por provider.

#### Definition of Done
- [ ] Todos os ACs passam
- [ ] Migration roda em dev + remote idempotente (rerun = no-op)
- [ ] Typecheck zero, lint zero
- [ ] Commit `feat(EPIC-13): schema delta + ai_models seed [wave 1]`
- [ ] Contracts registrados

---

### S-13.02 — Refactor REST handlers para `_handler.ts` extraídos

**Points**: 4 | **Priority**: P0 | **Deps**: S-13.01 | **FR refs**: Spec 11 §5.2

#### Contexto
Pré-requisito do MCP server (S-13.03/04). Cada Route Handler em `app/api/v1/<resource>/route.ts` precisa ter sua lógica core extraída para `_handler.ts` reutilizável. Mantém audit, RLS, validação Zod centralizados — MCP tools chamarão os mesmos handlers que os endpoints REST. Sem isto, MCP tools duplicariam lógica e divergiriam da REST.

#### Files to create
- `app/api/v1/contacts/_handler.ts` — `listContactsHandler`, `getContactHandler`
- `app/api/v1/conversations/_handler.ts` — `listConversationsHandler`, `getConversationHandler`
- `app/api/v1/messages/_handler.ts` — `listMessagesHandler`, `sendMessageHandler`
- `app/api/v1/leads/_handler.ts` — `listLeadsHandler`, `getLeadHandler`, `createLeadHandler`, `updateLeadHandler`
- `app/api/v1/pipelines/_handler.ts` — `listPipelinesHandler`

#### Files to modify
- `app/api/v1/contacts/route.ts` — Route Handler chama `listContactsHandler`
- `app/api/v1/contacts/[id]/route.ts` — chama `getContactHandler`
- `app/api/v1/conversations/route.ts` + `[id]/route.ts`
- `app/api/v1/messages/route.ts`
- `app/api/v1/leads/route.ts` + `[id]/route.ts` + `bulk/route.ts`
- `app/api/v1/pipelines/route.ts`

#### Implementation steps (sequential)
1. Para cada resource, criar `_handler.ts` exportando funções puras:
   ```ts
   export async function listContactsHandler(input: {
     organization_id: string,
     query?: string,
     limit?: number,
     cursor?: string,
     actor: { type: 'user' | 'ai_agent', id: string, role: string }
   }): Promise<{ contacts: Contact[], has_more: boolean, cursor?: string }>
   ```
2. Mover lógica de query/audit/Zod do Route Handler pra dentro do handler
3. Route Handler vira thin wrapper: parse req → chama handler → wrap em `ok()`/`fail()`
4. Audit log dentro do handler usa `actor.type` e `actor.id` (não mais hardcoded `auth.users.id`)
5. Garantir que todos os testes existentes do REST continuam passando

#### Acceptance Criteria

```gherkin
Given a Route Handler /api/v1/contacts/route.ts before refactor
When the refactor is done
Then the file is now < 60 LOC (thin wrapper)
And the listContactsHandler in _handler.ts contains the actual logic
And calling listContactsHandler with actor={type:'ai_agent', id:'run_x', role:'admin'} works identically to user
```

```gherkin
Given existing E2E tests of /api/v1/contacts, /api/v1/leads, /api/v1/messages
When the refactor is done
Then all tests still pass without modification
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | GET /api/v1/contacts retorna lista paginada | curl com session cookie + valida shape |
| t2 | api | POST /api/v1/leads cria lead | curl POST + valida 201 + audit log entry |
| t3 | unit | Handlers testáveis sem Route Handler | Vitest importa `_handler.ts` direto, mocka supabase, valida output |
| t4 | rls | Handler com `actor.type='ai_agent'` respeita RLS | DB query com client autenticado retorna apenas org do actor |
| t5 | api | Audit log entry tem `actor_type='ai_agent'` quando passado | curl + select api_audit_log |

#### Architecture contracts emitted

```yaml
exposes:
  - type: shared_lib
    id: "lib.api.handlers.contacts"
    file: "app/api/v1/contacts/_handler.ts"
    exports: ["listContactsHandler", "getContactHandler"]
    actor_aware: true  # accepts { type: 'user' | 'ai_agent', id, role }
  - type: shared_lib
    id: "lib.api.handlers.conversations"
    exports: ["listConversationsHandler", "getConversationHandler"]
  - type: shared_lib
    id: "lib.api.handlers.messages"
    exports: ["listMessagesHandler", "sendMessageHandler"]
  - type: shared_lib
    id: "lib.api.handlers.leads"
    exports: ["listLeadsHandler", "getLeadHandler", "createLeadHandler", "updateLeadHandler"]
  - type: shared_lib
    id: "lib.api.handlers.pipelines"
    exports: ["listPipelinesHandler"]
```

#### Definition of Done
- [ ] Todos os ACs passam
- [ ] Suite existente de testes REST passa sem mudança
- [ ] Typecheck/lint zero
- [ ] Commit `feat(EPIC-13): extract REST handlers to _handler.ts [wave 2]`

---

### S-13.03 — MCP server scaffold + auth bearer + 5 read tools

**Points**: 5 | **Priority**: P0 | **Deps**: S-13.02 | **FR refs**: Spec 11 §2, §3.1, §5

#### Contexto
Cria o MCP server em `app/api/mcp/route.ts` usando `@modelcontextprotocol/sdk`. Streamable HTTP transport. Auth via Bearer reutilizando `api_tokens` (EPIC-01) com `actor_type='ai_agent'` aceito. Implementa as 5 read tools de leitura segura: `crm_search_contacts`, `crm_get_contact`, `crm_list_conversations`, `crm_get_conversation`, `crm_get_conversation_history`. Cada tool wrappa o `_handler.ts` da S-13.02.

#### Files to create
- `app/api/mcp/route.ts` — entrypoint POST/GET (Streamable HTTP)
- `lib/mcp/server.ts` — `createMcpServer()` que registra tools
- `lib/mcp/auth.ts` — `validateBearerToken()` retorna `{ organization_id, role, actor }`
- `lib/mcp/types.ts` — `McpToolHandler`, `McpContext`
- `lib/mcp/tools/index.ts` — agrega + `VALID_TOOL_IDS`
- `lib/mcp/tools/contacts.ts` — `crm_search_contacts`, `crm_get_contact`
- `lib/mcp/tools/conversations.ts` — 3 tools
- `lib/mcp/audit.ts` — `auditMcpToolCall()` insere em `api_audit_log` com `action='mcp.tool_called'`

#### Implementation steps (sequential)
1. Instalar `@modelcontextprotocol/sdk`
2. Implementar `lib/mcp/auth.ts`: SHA256 hash do bearer → lookup `api_tokens`, retorna actor (user ou ai_agent)
3. Implementar `createMcpServer()` que registra tools via `server.tool(name, desc, schema, handler)`
4. Cada tool handler chama o `_handler.ts` correspondente passando `ctx.organization_id` e `ctx.actor`
5. `app/api/mcp/route.ts`: validar bearer, criar transport, conectar server, `transport.handleRequest()`
6. Audit log per call em `api_audit_log` com `actor_type='ai_agent'` quando aplicável
7. Endpoint `GET /api/v1/mcp/tools` (separado, em `app/api/v1/mcp/tools/route.ts`) retorna catálogo com Zod schemas serializados pra UI consumir

#### Acceptance Criteria

```gherkin
Given a valid bearer token tok_abc with actor_type='user', role='manager'
When client calls POST /api/mcp with method=tools/list
Then response includes 5 tools: crm_search_contacts, crm_get_contact, crm_list_conversations, crm_get_conversation, crm_get_conversation_history
And each tool has inputSchema and description
```

```gherkin
Given a valid bearer token
When client calls tools/call with name=crm_search_contacts, args={query:"joao"}
Then response returns matching contacts (RLS-scoped to token's organization_id)
And api_audit_log has new entry with action='mcp.tool_called', resource_id='crm_search_contacts'
```

```gherkin
Given an invalid bearer token
When client calls POST /api/mcp
Then response is 401 with MCP error code -32001
```

```gherkin
Given GET /api/v1/mcp/tools as authenticated manager
When request is made
Then response is { data: { tools: [{ id, description, input_schema, category, requires_role }, ...] } }
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | tools/list retorna 5 tools | curl POST /api/mcp + parse JSON-RPC response |
| t2 | api | tools/call com bearer válido retorna data | curl + valida shape |
| t3 | rls | Tool respeita org isolation | bearer da org A, query nome de contato que existe só em B → 0 results |
| t4 | api | Bearer inválido → 401 -32001 | curl sem header → erro |
| t5 | audit | Audit log entry criada com actor_type | select api_audit_log where actor_type='ai_agent' |
| t6 | api | GET /mcp/tools retorna catálogo serializado | Playwright network capture |

#### Architecture contracts emitted

```yaml
exposes:
  - type: mcp_server
    id: "mcp.endpoint /api/mcp"
    transport: "streamable-http"
    auth: "Bearer (api_tokens)"
  - type: mcp_tool
    id: "mcp.tool.crm_search_contacts"
    backed_by: "lib.api.handlers.contacts.listContactsHandler"
  - type: mcp_tool
    id: "mcp.tool.crm_get_contact"
  - type: mcp_tool
    id: "mcp.tool.crm_list_conversations"
  - type: mcp_tool
    id: "mcp.tool.crm_get_conversation"
  - type: mcp_tool
    id: "mcp.tool.crm_get_conversation_history"
  - type: api_route
    id: "api.GET /api/v1/mcp/tools"
    response_schema: "{ tools: [{ id, description, input_schema, category, requires_role }] }"
```

#### Definition of Done
- [ ] Todos os ACs passam
- [ ] MCP Inspector (`npx @modelcontextprotocol/inspector`) conecta com sucesso usando bearer e lista tools
- [ ] Audit log entries aparecem com `actor_type='ai_agent'` quando token é mintado pra agente
- [ ] Typecheck/lint zero
- [ ] Sentry beforeSend strippa `authorization` (smoke test)
- [ ] Commit `feat(EPIC-13): MCP server scaffold + 5 read tools [wave 3]`

---

### S-13.04 — MCP write tools + handoff tool + tools catalog endpoint

**Points**: 4 | **Priority**: P0 | **Deps**: S-13.03 | **FR refs**: Spec 11 §3.1, §3.2, §3.3

#### Contexto
Completa o catálogo MCP. Adiciona 4 read tools restantes (`crm_list_leads`, `crm_get_lead`, `crm_list_pipelines`) + 4 write tools (`crm_send_whatsapp_message`, `crm_create_lead`, `crm_update_lead`, `crm_move_lead_stage`) + 1 tool especial sem mirror REST (`crm_request_human_handoff`). Total final: 13 tools. Write tools requerem `role >= manager` no token. Handoff tool tem side effects (assign user, activity, event_log).

#### Files to create
- `lib/mcp/tools/leads.ts` — 4 tools
- `lib/mcp/tools/pipelines.ts` — 1 tool
- `lib/mcp/tools/messages.ts` — `crm_send_whatsapp_message`
- `lib/mcp/tools/handoff.ts` — `crm_request_human_handoff` (logic completa)

#### Files to modify
- `lib/mcp/tools/index.ts` — adiciona 8 tools, atualiza `VALID_TOOL_IDS`
- `app/api/v1/mcp/tools/route.ts` — categoriza tools (read/write/special)

#### Implementation steps (sequential)
1. Tools de leads/pipelines/messages: wrappers sobre `_handler.ts`
2. `crm_send_whatsapp_message`: chama `sendMessageHandler` que já existe (S-13.02), idempotência via `Idempotency-Key` derivado de `run_id+step`
3. `crm_request_human_handoff`:
   - Round-robin entre users com role >= `suggested_assignee_role` e `presence='online'` na org
   - `update conversations set assigned_user_id=..., status='pending'`
   - `insert crm_lead_activities (type='handoff', metadata={reason, urgency, source:'ai_agent', run_id})`
   - `insert event_log (event_type='ai_agent.handoff_triggered', payload={...})`
   - Audit log
   - Retorna `next_action` string sugerindo mensagem final
4. Validação no MCP server: write tools verificam `ctx.role >= manager`; senão MCP error -32002

#### Acceptance Criteria

```gherkin
Given a bearer with role='viewer'
When tools/call name=crm_create_lead is invoked
Then response is MCP error -32002 (Forbidden)
```

```gherkin
Given a bearer with role='manager' and an open conversation
When tools/call name=crm_request_human_handoff with reason="cliente solicitou", urgency='normal' is invoked
Then conversations.assigned_user_id is set to an online user with role >= agent
And conversations.status='pending'
And crm_lead_activities has new row type='handoff' with metadata.source='ai_agent'
And event_log has new row event_type='ai_agent.handoff_triggered'
And response includes { handoff_recorded: true, conversation_id, next_action }
```

```gherkin
Given a bearer with role='manager'
When tools/call name=crm_move_lead_stage with lead_id and to_stage_id is invoked
Then crm_leads.stage_id is updated
And api_audit_log has entry with metadata.from_stage_id and metadata.to_stage_id
```

```gherkin
Given GET /api/v1/mcp/tools
When request is made
Then response includes 13 tools categorized: read (8), write (4), special (1)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | 13 tools no tools/list | curl + count |
| t2 | api | Write tool com viewer → 403 | curl com viewer bearer |
| t3 | api | Handoff atomic side effects | exec + select 4 tabelas: conversations, activities, event_log, audit |
| t4 | api | Round-robin handoff distribui | exec 5x → users diferentes (com mocks) |
| t5 | api | Idempotency-Key dedupe send_whatsapp | call 2x mesmo key → 1 message inserted |
| t6 | api | move_lead_stage audit metadata | select api_audit_log → from_stage_id presente |

#### Architecture contracts emitted

```yaml
exposes:
  - type: mcp_tool
    id: "mcp.tool.crm_list_leads"
  - type: mcp_tool
    id: "mcp.tool.crm_get_lead"
  - type: mcp_tool
    id: "mcp.tool.crm_list_pipelines"
  - type: mcp_tool
    id: "mcp.tool.crm_send_whatsapp_message"
    requires_role: "manager"
    idempotency: "Idempotency-Key header (24h TTL Upstash)"
  - type: mcp_tool
    id: "mcp.tool.crm_create_lead"
    requires_role: "manager"
  - type: mcp_tool
    id: "mcp.tool.crm_update_lead"
    requires_role: "manager"
  - type: mcp_tool
    id: "mcp.tool.crm_move_lead_stage"
    requires_role: "manager"
    audit_metadata: ["from_stage_id", "to_stage_id", "reason"]
  - type: mcp_tool
    id: "mcp.tool.crm_request_human_handoff"
    side_effects: ["conversations.assigned_user_id", "crm_lead_activities INSERT", "event_log INSERT"]
    no_rest_mirror: true
```

#### Definition of Done
- [ ] Todos os ACs passam
- [ ] 13 tools registradas
- [ ] Write tools rate-limited a 30/min/token (Upstash)
- [ ] Commit `feat(EPIC-13): MCP write tools + handoff [wave 4]`

---

### S-13.05 — Endpoints `/ai/credentials` + AES-GCM encryption

**Points**: 4 | **Priority**: P0 | **Deps**: S-13.01 | **FR refs**: Spec 10 §4.2, §7

#### Contexto
CRUD de credentials BYO. Plaintext só recebido no POST. Cifra AES-GCM com key em `process.env.AI_CRED_AES_KEY`. Validação async ping ao provider `/v1/models`. View `_safe` esconde campos cifrados. Audit captura eventos sem valor da key. Sentry beforeSend strippa `api_key` do body.

#### Files to create
- `lib/crypto/aes_gcm.ts` — `encryptKey()`, `decryptKey()` usando `@noble/ciphers`
- `lib/ai/provider-validators.ts` — `validateAnthropicKey()`, `validateOpenAIKey()`, `validateGoogleKey()` (ping `/v1/models`)
- `app/api/v1/ai/credentials/route.ts` — GET list, POST create
- `app/api/v1/ai/credentials/[id]/route.ts` — DELETE
- `app/api/v1/ai/credentials/[id]/revalidate/route.ts` — POST revalidate
- `app/api/v1/ai/providers/route.ts` — GET list providers
- `app/api/v1/ai/providers/[provider]/models/route.ts` — GET models
- `lib/ai/credentials.ts` — `loadCredential(id, organization_id): Promise<{ apiKey, provider, label }>` (decrypt just-in-time)

#### Implementation steps (sequential)
1. `lib/crypto/aes_gcm.ts`: AES-256-GCM, IV 12 bytes random, tag 16 bytes
2. Endpoint POST `/credentials`:
   - Zod validate body
   - Encrypt → bytea fields + last4
   - Insert via admin client (RLS skip; manual `organization_id` filter)
   - Spawn async validation (não bloqueia response)
   - Audit `ai_credential.created`
3. Endpoint DELETE: bloquear se referenciado por `ai_agent_versions.credential_id` em version `published`
4. Validators: timeout 5s, capturar erros de auth (401) vs network (timeout)
5. `loadCredential()`: usado pelo runtime (S-13.08); lança erro se `is_active=false` ou `validated_at IS NULL`

#### Acceptance Criteria

```gherkin
Given an admin user
When POST /api/v1/ai/credentials with provider=anthropic, label="Prod", api_key="sk-ant-real-key"
Then response 201 with safe view (last4='real', no api_key)
And ai_provider_credentials row has api_key_encrypted, api_key_iv, api_key_tag (bytea, non-null)
And api_key_last4 = 'real'
And async validation eventually sets validated_at OR validation_error
And audit log entry ai_credential.created (without plaintext)
```

```gherkin
Given a credential is referenced by a published agent version
When DELETE /api/v1/ai/credentials/:id
Then response is 409 conflict with code "credential_in_use"
And the row is not deleted
```

```gherkin
Given an admin
When loadCredential(id, organization_id) is called
Then it returns { apiKey: 'sk-ant-real-key', provider, label }
And the plaintext is never logged or in Sentry breadcrumb
```

```gherkin
Given a viewer or manager
When POST /api/v1/ai/credentials
Then response is 403 forbidden_role
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | POST cifra corretamente | inserir + manualmente decifrar com AES_KEY → match |
| t2 | api | Validation async funciona | mock provider 200 → validated_at set; 401 → validation_error |
| t3 | api | DELETE bloqueado se em uso | 409 + row preservada |
| t4 | adversarial | Plaintext nunca em log | Sentry capture run, search breadcrumbs por 'sk-' → 0 |
| t5 | rls | Tenant isolation | org A não vê credentials de B |
| t6 | api | Revalidate endpoint reseta validated_at e retesta | POST + check validated_at atualizado |

#### Architecture contracts emitted

```yaml
exposes:
  - type: shared_lib
    id: "lib.crypto.aes_gcm"
    exports: ["encryptKey", "decryptKey"]
    env_required: ["AI_CRED_AES_KEY"]
  - type: shared_lib
    id: "lib.ai.credentials"
    exports: ["loadCredential"]
    notes: "decrypts just-in-time, plaintext only in returned object scope"
  - type: api_route
    id: "api.POST /api/v1/ai/credentials"
    request_schema: "{ provider: 'anthropic'|'openai'|'google', label: string, api_key: string }"
    response_schema: "ai_provider_credentials_safe row"
    requires_role: "admin"
  - type: api_route
    id: "api.DELETE /api/v1/ai/credentials/:id"
    requires_role: "admin"
    error_codes: ["credential_in_use", "not_found"]
  - type: api_route
    id: "api.GET /api/v1/ai/providers/:p/models"
    response_schema: "{ models: [{ model_id, display_name, context_window, prices }] }"
```

#### Definition of Done
- [ ] Todos os ACs passam
- [ ] AES_KEY env var validada no startup (`lib/env.ts`)
- [ ] Rotation playbook documentado em `docs/runbooks/ai-credentials-rotation.md`
- [ ] Commit `feat(EPIC-13): AI credentials BYO + AES-GCM [wave 5]`

---

### S-13.06 — Endpoints `/ai/agents` + versions + publish + test

**Points**: 5 | **Priority**: P0 | **Deps**: S-13.01, S-13.05 | **FR refs**: Spec 10 §4.3, §4.4, §4.5

#### Contexto
CRUD completo de agentes do tipo `mcp_agent`, versionamento Save/Publish atômico, endpoint `:test` (que usa o runtime parcialmente — preview before S-13.08 wires it fully). Toda mutação valida cross-references (credential exists+validated, channel_session working, tools válidas no catálogo MCP, modelo existe em `ai_models`).

#### Files to create
- `app/api/v1/ai/agents/[id]/route.ts` — GET detail, PATCH, DELETE (soft archive)
- `app/api/v1/ai/agents/[id]/versions/route.ts` — GET list, POST create draft
- `app/api/v1/ai/agents/[id]/versions/[vid]/route.ts` — GET, PATCH (only draft)
- `app/api/v1/ai/agents/[id]/versions/[vid]/test/route.ts` — POST :test
- `app/api/v1/ai/agents/[id]/publish/route.ts` — POST :publish
- `app/api/v1/ai/agents/[id]/duplicate/route.ts` — POST :duplicate
- `app/api/v1/ai/agents/[id]/pause/route.ts` — POST :pause
- `app/api/v1/ai/agents/[id]/runs/route.ts` — GET paginated runs
- `lib/ai/agents/validation.ts` — Zod schemas + cross-reference validators
- `lib/ai/agents/publish.ts` — atomic transaction logic

#### Files to modify
- `app/api/v1/ai/agents/route.ts` — POST agora aceita `kind='mcp_agent'` + nested first version draft

#### Implementation steps (sequential)
1. Zod schemas em `lib/ai/agents/validation.ts` mirror Spec 10 §3.2 e §4.3
2. POST `/agents` cria agent + version v1 atomicamente
3. POST `/agents/:id/versions`:
   - Calcula próximo `version_number` (max+1)
   - Cria com `status='draft'`
4. POST `:publish`:
   - Validar version belongs to agent, status in (draft, superseded)
   - Validar credential.is_active && validated_at != NULL && credential.provider == version.provider
   - Validar channel_sessions.status='working'
   - Validar tool_ids ⊂ VALID_TOOL_IDS (Spec 11 §4)
   - Validar model existe em ai_models para provider
   - SQL transaction: superseded antiga + published nova + update `ai_agents.published_version_id`
   - Insert event_log `ai_agent.published`
   - Audit
5. POST `:test`:
   - Cria `ai_agent_runs` com `is_dry_run=true`
   - Chama `/api/internal/agents/run` (S-13.08 — stub agora, real depois — usa flag `__test_stub` que retorna fake trace; quando S-13.08 está pronto, remove stub)
6. POST `:duplicate`: clona agent + versão atual draft, novo nome `${name} (cópia)`
7. POST `:pause`: clear `published_version_id`, audit
8. DELETE: soft (`archived_at=now()`), audit `ai_agent.archived`
9. GET `/runs`: cursor pagination via `lib/api/cursor.ts`

#### Acceptance Criteria

```gherkin
Given an admin user with valid credential and channel_session
When POST /api/v1/ai/agents with body { name, version: {...} }
Then response 201 with { agent: { kind: 'mcp_agent', published_version_id: null }, version: { version_number: 1, status: 'draft' } }
```

```gherkin
Given agent with v3 published and v4 draft
When POST /api/v1/ai/agents/:id:publish with version_id=v4
Then in single transaction:
  v3 → status='superseded', superseded_at=now()
  v4 → status='published', published_at=now()
  ai_agents.published_version_id=v4.id
And event_log has ai_agent.published with payload.previous_version_id=v3.id
And audit log entry ai_agent.published
```

```gherkin
Given a credential is invalid (validated_at=null)
When POST /api/v1/ai/agents/:id:publish referencing it
Then response 422 with code 'credential_not_validated'
And no transaction commits
```

```gherkin
Given a published agent
When PATCH /api/v1/ai/agents/:id/versions/:vid
Then response 409 with code 'version_immutable'
And the version is unchanged
```

```gherkin
Given an admin
When POST /api/v1/ai/agents/:id/versions/:vid:test with sample_message
Then response includes run_id, trace, final_text
And ai_agent_runs row has is_dry_run=true
And no outbound message is created
And no WAHA call is made
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | Create agent + first version atomic | POST + select 2 tabelas |
| t2 | api | Publish atomic transition | POST + select 3 estados em ordem |
| t3 | api | Cross-ref validation falha | publish com credential.validated_at=null → 422 |
| t4 | api | Edit published version blocked | PATCH version published → 409 |
| t5 | api | Test mode dry_run flag | POST :test + select ai_agent_runs.is_dry_run=true |
| t6 | api | Duplicate creates new agent | POST :duplicate + count agents +1 |
| t7 | api | Pause clears published_version_id | POST :pause + select ai_agents |
| t8 | api | Archive soft deletes | DELETE + select archived_at NOT NULL |
| t9 | rls | Cross-tenant version access blocked | bearer A query version de B → 404 |

#### Architecture contracts emitted

```yaml
exposes:
  - type: api_route
    id: "api.GET /api/v1/ai/agents"
    response_schema: "{ agents: [...], cursor }"
  - type: api_route
    id: "api.POST /api/v1/ai/agents"
    creates: ["ai_agents row (kind='mcp_agent')", "ai_agent_versions v1 draft"]
  - type: api_route
    id: "api.POST /api/v1/ai/agents/:id/versions"
  - type: api_route
    id: "api.POST /api/v1/ai/agents/:id:publish"
    body: "{ version_id }"
    error_codes: ["credential_not_validated", "channel_session_offline", "tool_id_invalid", "model_not_found"]
  - type: api_route
    id: "api.POST /api/v1/ai/agents/:id/versions/:vid:test"
    body: "{ sample_message: string, sample_contact?: {...} }"
  - type: api_route
    id: "api.POST /api/v1/ai/agents/:id:duplicate"
  - type: api_route
    id: "api.POST /api/v1/ai/agents/:id:pause"
  - type: api_route
    id: "api.GET /api/v1/ai/agents/:id/runs"
  - type: domain_event
    id: "event.ai_agent.published"
    payload_schema: "{ agent_id, version_id, previous_version_id }"
```

#### Definition of Done
- [ ] Todos os ACs passam
- [ ] Test mode usa stub temporário até S-13.08 (flag `INTERNAL_AGENT_RUN_STUB=true`)
- [ ] Commit `feat(EPIC-13): agents CRUD + versions + publish [wave 6]`

---

### S-13.07 — Worker `agent-dispatcher` (cron + matching + concurrency)

**Points**: 4 | **Priority**: P0 | **Deps**: S-13.06 | **FR refs**: Spec 10 §5

#### Contexto
Worker cron que consome `event_log` `ai_agent.dispatch_requested`, escolhe agente top-priority match, valida budget + rate limit, cria `ai_agent_runs` row e dispara `/api/internal/agents/run`. Concorrência garantida pelo partial unique index. Multi-agente: N publicados na mesma sessão; dispatcher escolhe 1 via priority + created_at.

#### Files to create
- `app/api/v1/cron/agent-dispatcher/route.ts` — cron handler
- `lib/ai/dispatcher/index.ts` — `dispatchAgents()` algoritmo principal
- `lib/ai/dispatcher/triggers.ts` — `triggerMatches()` (events, ignore_groups, ignore_self, keyword_regex, business_hours)
- `lib/ai/dispatcher/budget.ts` — `checkTenantBudget()` reusing ai_budgets

#### Files to modify
- `vercel.json` — adicionar cron `*/1 * * * *` para dispatcher (Vercel não suporta sub-minute, processa batch)

#### Implementation steps (sequential)
1. Cron entrypoint valida `X-Cron-Secret`
2. Pull events `is null processed_at`, limit 100, lock with `for update skip locked`
3. Para cada event:
   - Load message + conversation
   - Query candidatos: `JOIN ai_agent_versions ON published_version_id WHERE channel_session_id=$ AND archived_at IS NULL ORDER BY priority DESC, created_at ASC`
   - Filter via `triggerMatches()`
   - Top match (LIMIT 1) — ou skip se vazio
   - Concurrency guard: `INSERT INTO ai_agent_runs ... ON CONFLICT (conversation_id) WHERE status='running' DO NOTHING` — se 0 rows affected, skip
   - Budget check via `ai_budgets`
   - Rate limit Upstash: `ai-runs:${org_id}` 60/min default
   - Fire-and-forget POST `/api/internal/agents/run` com `INTERNAL_SECRET`
4. Mark event `processed_at` com `metadata.outcome` (dispatched, no_match, conv_busy, budget_exceeded, rate_limited)

#### Acceptance Criteria

```gherkin
Given event_log has ai_agent.dispatch_requested unprocessed
And 2 agents are published on the same channel_session: A (priority=10), B (priority=5)
When dispatcher runs
Then exactly 1 ai_agent_runs row is created with agent_id=A
And event is marked processed_at with outcome='dispatched'
```

```gherkin
Given a conversation with active running run
When a new dispatch event arrives for same conversation
Then no new run is created
And event marked outcome='conv_busy'
```

```gherkin
Given organization budget is exhausted (current_month_consumed_cents >= max)
When dispatcher processes event
Then no run is created
And event marked outcome='budget_exceeded'
And Sentry warn 'ai_budget_exceeded' captured
```

```gherkin
Given trigger_config { filters: { ignore_groups: true } }
When inbound is from chat_id ending with @g.us
Then triggerMatches returns false
And event marked outcome='no_match'
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | worker | Multi-agent priority | seed 2 agents, run dispatcher, assert agent_id |
| t2 | worker | Concurrency guard | seed running run + dispatch → 1 ainda |
| t3 | worker | Group filter | inbound @g.us → no_match |
| t4 | worker | Self filter | inbound fromMe=true → no_match |
| t5 | worker | Keyword regex | inbound matching/not matching → match/no_match |
| t6 | worker | Business hours | mock now() outside window → no_match |
| t7 | worker | Budget block | budget exhausted → outcome budget_exceeded |
| t8 | worker | Rate limit | 70 events same org/min → 60 dispatch + 10 requeue |

#### Architecture contracts emitted

```yaml
exposes:
  - type: worker
    id: "worker.agent-dispatcher"
    schedule: "*/1 * * * *"
    consumes: "event.ai_agent.dispatch_requested"
    produces:
      - "ai_agent_runs row (status='pending')"
      - "POST /api/internal/agents/run (fire-and-forget)"
  - type: shared_lib
    id: "lib.ai.dispatcher.triggers"
    exports: ["triggerMatches"]
```

#### Definition of Done
- [ ] Todos os ACs passam
- [ ] Cron registrado em `vercel.json`
- [ ] Sentry monitora `ai_dispatcher.no_match` se ratio > 30% (alarme info)
- [ ] Commit `feat(EPIC-13): agent-dispatcher worker [wave 7]`

---

### S-13.08 — Endpoint `/api/internal/agents/run` (ToolLoopAgent runtime)

**Points**: 6 | **Priority**: P0 | **Deps**: S-13.04, S-13.05, S-13.07 | **FR refs**: Spec 10 §6

#### Contexto
Coração do epic. Roda o `ToolLoopAgent` do Vercel AI SDK v6 com tools MCP. Gerencia budgets em 3 camadas (`stepCountIs`, `prepareStep` token+cost), envia resposta via WAHA, detecta handoff (tool ou sentinela), persiste trace, emite eventos. Não está em `/api/v1/` — interno, autenticado por `INTERNAL_SECRET`.

#### Files to create
- `app/api/internal/agents/run/route.ts` — endpoint runtime
- `lib/ai/runtime/agent.ts` — `runAgent(run_id)` função principal
- `lib/ai/runtime/history.ts` — `loadHistoryWithBudget(conv, msgWindow, tokenWindow)`
- `lib/ai/runtime/cost.ts` — `computeCost(provider, model, usage)` lookup `ai_models`
- `lib/ai/runtime/tools.ts` — `pickToolsFromMcp(client, tool_ids)` + handoff tool injection
- `lib/ai/runtime/mcp_token.ts` — `mintEphemeralToken(org_id, run_id, ttl=300)`
- `lib/ai/runtime/handoff.ts` — `finalizeHandoff(run, reason, urgency, result?)`
- `lib/ai/runtime/finalize.ts` — `finalizeRun(run, status, error?, result?)`
- `lib/ai/runtime/serialize.ts` — `serializeStep(step)` para `tool_calls` jsonb
- `lib/waha/send.ts` — `sendWAHA(session_id, chat_id, text)` (se ainda não existe da EPIC-03)

#### Files to modify
- `app/api/v1/ai/agents/[id]/versions/[vid]/test/route.ts` — remover stub, chamar runtime real com `is_dry_run=true`

#### Implementation steps (sequential)
1. Endpoint valida `X-Internal-Secret`
2. Load run + version + decrypt credential
3. Update run status → 'running'
4. Setup MCP client com bearer efêmero (S-13.04 token mint)
5. Carregar history sliding window (msg + token aware)
6. Load inbound message
7. **Sentinela determinística**: regex match em `version.handoff_keywords` no inbound.body → call `finalizeHandoff('keyword_match')`, return
8. Build `ToolLoopAgent`:
   - `model: gateway('${provider}/${model}', { apiKey })`
   - `system: version.system_prompt`
   - `tools: { ...mcpTools, [handoff_tool_enabled && 'crm_request_human_handoff']: ... }`
   - `stopWhen: [stepCountIs(version.max_steps)]`
   - `prepareStep`: enforce token+cost budget, persist trace incremental
9. `agent.generate({ messages: [...history, { role: 'user', content: inbound.body }] })`
10. Detectar tool call de handoff em `result.steps` → `finalizeHandoff('agent_invoked_tool')`
11. Senão: se `!is_dry_run` → `sendWAHA(session_id, chat_id, result.text)`
12. `finalizeRun(run, 'completed', null, result)`:
    - Update metricas (tokens, cost, latency, steps_count)
    - `tool_calls: result.steps.map(serializeStep)` (limpar PII em args)
    - Insert outbound message (se !dry_run)
    - Insert event_log `ai_agent.run_completed`
    - Audit log
13. Try/catch global: erros → `finalizeRun(run, 'failed', err)`

#### Acceptance Criteria

```gherkin
Given a run with version that has tool_ids=['crm_search_contacts', 'crm_get_conversation_history', 'crm_request_human_handoff']
And inbound message "Quanto é X?"
When POST /api/internal/agents/run with run_id
Then ToolLoopAgent runs the loop with those 3 tools available
And final text is sent via WAHA sendText to inbound.chat_id with version.channel_session_id
And ai_agent_runs row updated to status='completed' with tokens_in, tokens_out, cost_cents, latency_ms, tool_calls jsonb
And messages has new outbound row with body=result.text, sent_by='ai_agent', metadata.run_id
And event_log has ai_agent.run_completed
```

```gherkin
Given a run with inbound "falar com humano agora"
When runtime starts
Then sentinela bypasses LLM
And conversations.assigned_user_id is set
And run.status='handoff' with abort_reason='keyword_match'
And no LLM call was made (cost_cents=0 in run)
```

```gherkin
Given an agent that gets stuck calling tools
When step count exceeds version.max_steps
Then run aborts with status='aborted', abort_reason='max_steps_reached'
And final response was NOT sent
```

```gherkin
Given budget cost_budget_cents=10
When prepareStep callback detects total cost > 10
Then run aborts with status='aborted', abort_reason='cost_budget_exceeded'
```

```gherkin
Given is_dry_run=true (test mode)
When run completes
Then no WAHA sendText call is made
And no outbound message row is created
And response includes full trace
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | runtime | Happy path | seed run + inbound, exec, assert outbound + event |
| t2 | runtime | Sentinela handoff | inbound matching keyword → handoff sem LLM |
| t3 | runtime | Tool handoff | mock LLM call tool → conversation assigned |
| t4 | runtime | Max steps abort | mock LLM forever-loop → abort step_count_reached |
| t5 | runtime | Token budget abort | mock huge prompts → abort token_budget_exceeded |
| t6 | runtime | Cost budget abort | model expensive → abort cost_budget_exceeded |
| t7 | runtime | Dry run no WAHA | is_dry_run=true → 0 WAHA calls captured |
| t8 | adversarial | API key leak | Sentry capture → 0 occurrences plaintext |
| t9 | runtime | Invalid credential aborts | credential.validated_at=null → run.status='failed', error_code='credential_invalid' |

#### Architecture contracts emitted

```yaml
exposes:
  - type: internal_endpoint
    id: "endpoint.internal /api/internal/agents/run"
    auth: "X-Internal-Secret header"
    body: "{ run_id }"
    timeout: 300s
  - type: shared_lib
    id: "lib.ai.runtime.agent"
    exports: ["runAgent"]
  - type: shared_lib
    id: "lib.ai.runtime.cost"
    exports: ["computeCost"]
  - type: shared_lib
    id: "lib.ai.runtime.history"
    exports: ["loadHistoryWithBudget"]
  - type: domain_event
    id: "event.ai_agent.run_started"
  - type: domain_event
    id: "event.ai_agent.run_completed"
    payload: "{ run_id, status, tokens_in, tokens_out, cost_cents, latency_ms, steps_count }"
  - type: domain_event
    id: "event.ai_agent.handoff_triggered"
    payload: "{ run_id, conversation_id, reason, urgency, source: 'tool'|'keyword' }"
```

#### Definition of Done
- [ ] Todos os ACs passam
- [ ] `vercel.json` configura `maxDuration: 300` para `/api/internal/agents/run`
- [ ] Sentry breadcrumbs estruturados (sem args completos das tools — só nome+latency+error)
- [ ] Smoke test no CI: run real com fake provider mock → 0 plaintext leaks
- [ ] Commit `feat(EPIC-13): agent runtime ToolLoopAgent [wave 8]`

---

### S-13.09 — Webhook WAHA hook → event_log dispatch

**Points**: 1 | **Priority**: P0 | **Deps**: S-13.07 | **FR refs**: Spec 10 §4.6

#### Contexto
Tiny wave: estende o webhook WAHA existente (EPIC-03) para emitir `event_log` `ai_agent.dispatch_requested` após inserir mensagem inbound. Apenas mensagens não-grupo, não-fromMe. Não bloqueia o webhook (handler retorna 200 < 500ms).

#### Files to modify
- `app/api/v1/webhooks/waha/route.ts` — adicionar emissão após insert message

#### Implementation steps (sequential)
1. Após o INSERT da mensagem inbound bem-sucedido (sem 23505 conflict)
2. Validar `kind='inbound'`, `!chat_id.endsWith('@g.us')`, `!from_me`
3. Insert `event_log` em fire-and-forget batched com a transação principal:
   ```ts
   await admin.from('event_log').insert({
     organization_id, event_type: 'ai_agent.dispatch_requested',
     payload: { conversation_id, contact_id, channel_session_id, inbound_message_id }
   })
   ```
4. Não falhar webhook se event_log insert falhar (Sentry capture, return 200)

#### Acceptance Criteria

```gherkin
Given a WAHA webhook POST with inbound message (non-group, non-self)
When the webhook handler processes successfully
Then a new event_log row exists with event_type='ai_agent.dispatch_requested'
And payload includes conversation_id, contact_id, channel_session_id, inbound_message_id
And response was 200 OK in under 500ms
```

```gherkin
Given a WAHA webhook from a group chat (chat_id ending @g.us)
When processed
Then NO event_log row is created
And the existing message.received event is still emitted (legacy)
```

```gherkin
Given event_log INSERT fails (e.g. transient DB issue)
When webhook is processed
Then webhook still returns 200 (fire-and-forget)
And Sentry captures the failure
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | Inbound non-group emits event | POST webhook + select event_log |
| t2 | api | Group inbound skipped | POST webhook chat_id @g.us + assert no event |
| t3 | api | fromMe skipped | POST webhook fromMe=true + assert no event |
| t4 | api | Latency p99 < 500ms | k6 load test 100 webhooks |
| t5 | api | Event_log fail doesn't fail webhook | mock insert fail → 200 + Sentry |

#### Architecture contracts emitted

```yaml
exposes:
  - type: domain_event
    id: "event.ai_agent.dispatch_requested"
    emitted_by: "POST /api/v1/webhooks/waha"
    payload_schema: "{ conversation_id, contact_id, channel_session_id, inbound_message_id }"
    filters: ["non-group", "non-fromMe", "kind=inbound"]
```

#### Definition of Done
- [ ] Todos os ACs passam
- [ ] Latência webhook não regrediu (k6 baseline)
- [ ] Commit `feat(EPIC-13): WAHA webhook emits dispatch event [wave 9]`

---

### S-13.10 — UI Lista agentes + Credentials

**Points**: 4 | **Priority**: P0 | **Deps**: S-13.05, S-13.06 | **FR refs**: Spec 12 §2, §7

#### Contexto
Primeiras telas: `/ai/agents` (lista com cards, filtros, menu de ações) e `/ai/credentials` (gestão BYO keys, modal de criação). Adiciona item "Agentes IA" no sidebar. Server Components para fetch, Client Components para interatividade. Server Actions para mutations.

#### Files to create
- `app/(app)/ai/agents/page.tsx` — Server Component lista
- `app/(app)/ai/agents/_components/AgentsList.tsx`
- `app/(app)/ai/agents/_components/AgentCard.tsx`
- `app/(app)/ai/agents/_components/AgentRowMenu.tsx` (Client)
- `app/(app)/ai/agents/_components/AgentsListFilters.tsx` (Client)
- `app/(app)/ai/agents/_components/AgentStatusBadge.tsx`
- `app/(app)/ai/agents/_actions.ts` — Server Actions duplicateAgent, pauseAgent, archiveAgent, renameAgent
- `app/(app)/ai/credentials/page.tsx` — Server Component
- `app/(app)/ai/credentials/_components/CredentialsList.tsx`
- `app/(app)/ai/credentials/_components/CredentialCard.tsx`
- `app/(app)/ai/credentials/_components/AddCredentialDialog.tsx` (Client, modal)
- `app/(app)/ai/credentials/_actions.ts` — addCredentialAction, deleteCredentialAction, revalidateCredentialAction
- `hooks/useAgents.ts`, `hooks/useCredentials.ts`

#### Files to modify
- `components/Sidebar.tsx` (ou equivalente) — adicionar item "Agentes IA" entre Pipelines e Configurações

#### Implementation steps (sequential)
1. Sidebar entry com Phosphor icon `Robot`
2. Page `/ai/agents` Server Component fetch via `GET /api/v1/ai/agents`
3. AgentCard mostra: nome, status badge, prioridade, sessão, modelo, métricas hoje (counts), trigger summary
4. Empty state com CTA "+ Novo agente"
5. Filtros via `useQueryState` (status, sessão, busca)
6. Menu actions: Editar (link), Duplicar, Renomear (modal inline), Pausar/Despausar, Arquivar (confirm modal)
7. Page `/ai/credentials` lista por provider em sections
8. Modal Add: form validado Zod, "Salvar e validar" feedback
9. Delete bloqueado se em uso (UI disabled + tooltip "Em uso por X agentes")
10. RBAC: viewer read-only (sem CTAs), manager full-read, admin write

#### Acceptance Criteria

```gherkin
Given an admin with no agents
When navigating to /ai/agents
Then page shows empty state with CTA "+ Novo agente"
```

```gherkin
Given an admin with 3 agents (1 published, 1 paused, 1 draft)
When navigating to /ai/agents
Then 3 cards render with correct status badges (🟢, ⚪, 🟡)
And filters work (filter by status='published' shows 1)
```

```gherkin
Given an admin
When clicking menu > Duplicar on an agent
Then a new agent appears in the list with name "{original} (cópia)"
And status is draft
```

```gherkin
Given a viewer
When navigating to /ai/agents
Then list renders read-only
And no "+ Novo" button is visible
And menu actions (duplicate, archive) are not visible
```

```gherkin
Given an admin
When navigating to /ai/credentials and clicking "+ Adicionar credencial" with provider=anthropic, label="Prod", api_key="sk-ant-..."
Then POST /api/v1/ai/credentials is called
And toast shows "Credencial salva. Validando..."
And after async validation toast updates to "Validada — N modelos disponíveis"
And row appears with last4
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Lista renderiza | Playwright /ai/agents + assert cards |
| t2 | ui | Filtros funcionam | click filtro + assert count |
| t3 | ui | Duplicate funciona | click + reload + assert +1 |
| t4 | ui | RBAC viewer read-only | login viewer + assert no CTAs |
| t5 | ui | Modal credential add → toast | exec + assert toast |
| t6 | ui | Delete bloqueado se em uso | UI mostra disabled + tooltip |
| t7 | ui | Empty state | usuário sem agentes → empty CTA |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_hook
    id: "hook.useAgents"
    signature: "(filters?) => { agents, isLoading, error, refetch }"
  - type: react_hook
    id: "hook.useCredentials"
    signature: "() => { credentials, isLoading, error }"
  - type: react_component
    id: "ui.<AgentCard>"
  - type: react_component
    id: "ui.<AgentStatusBadge>"
    props: "{ status: 'published'|'draft'|'paused'|'invalid' }"
  - type: page_route
    id: "/app/ai/agents"
  - type: page_route
    id: "/app/ai/credentials"
```

#### Definition of Done
- [ ] Todos os ACs passam
- [ ] Sidebar entry visible com role-aware
- [ ] Empty/loading/error states implementados
- [ ] Mobile responsivo (single column < 768px)
- [ ] Commit `feat(EPIC-13): UI lista agentes + credentials [wave 10]`

---

### S-13.11 — UI Edit agent (form principal de configuração)

**Points**: 5 | **Priority**: P0 | **Deps**: S-13.10, S-13.04 | **FR refs**: Spec 12 §3

#### Contexto
Tela cheia de configuração com form de duas colunas, todas as seções: Identificação, Provider+Modelo, Credencial, Limites, Prompt (com token counter), Tools (checklist via `GET /api/v1/mcp/tools`), WhatsApp session, Gatilhos (eventos + filtros + horário), Handoff. Estados de save/publish (clean/dirty/draft saved/invalid). Modal de confirmação para publish com diff vs versão atual.

#### Files to create
- `app/(app)/ai/agents/[id]/page.tsx` — Server Component com tabs
- `app/(app)/ai/agents/new/page.tsx` — wrapper que reutiliza AgentForm vazio
- `app/(app)/ai/agents/[id]/_components/AgentTabs.tsx` (Client) — Configuration | Test | Runs | History
- `app/(app)/ai/agents/[id]/_components/AgentForm.tsx` (Client, react-hook-form)
- `app/(app)/ai/agents/[id]/_components/ModelPicker.tsx`
- `app/(app)/ai/agents/[id]/_components/CredentialPicker.tsx`
- `app/(app)/ai/agents/[id]/_components/ToolPicker.tsx`
- `app/(app)/ai/agents/[id]/_components/TriggerEditor.tsx`
- `app/(app)/ai/agents/[id]/_components/HandoffKeywordsInput.tsx`
- `app/(app)/ai/agents/[id]/_components/PublishConfirmDialog.tsx`
- `app/(app)/ai/agents/[id]/_actions.ts` — saveAgentDraftAction, publishAgentAction
- `lib/ui/TokenCounter.tsx` — gpt-tokenizer reativo
- `hooks/useAgent.ts`

#### Implementation steps (sequential)
1. Page `[id]/page.tsx` Server Component fetch agent + last draft + published version
2. Tabs Component (Client): mantém state localmente, primeiro tab = Configuration
3. AgentForm com react-hook-form + Zod resolver (mesma schema Spec 10)
4. ModelPicker fetch `/ai/providers/{p}/models` quando provider muda
5. CredentialPicker filtra por provider, mostra status (validada/inválida)
6. ToolPicker agrupa por categoria (Leitura, Escrita, Especiais), checklist
7. TriggerEditor: events checklist + filtros (groups/self/keyword/business hours)
8. HandoffKeywordsInput: chips input com autocomplete dos defaults
9. TokenCounter no system_prompt (debounce 200ms, gpt-tokenizer no client)
10. Estados:
    - Track form.formState.isDirty
    - Compare current values with published version → habilita Publish
    - Validações cross-ref: credential validated, channel session working — bloqueiam publish com tooltip
11. PublishConfirmDialog: mostra diff (modelo, tools added/removed, prompt token delta)
12. saveAgentDraftAction → POST `/versions` (cria nova draft) ou PATCH se draft existente do mesmo número
13. publishAgentAction → POST `:publish`

#### Acceptance Criteria

```gherkin
Given an admin in /ai/agents/new
When all required fields are filled and "Salvar rascunho" is clicked
Then a new agent is created with kind='mcp_agent' and version v1 status='draft'
And page redirects to /ai/agents/:id with toast success
```

```gherkin
Given an admin editing an agent with v3 published, no draft yet
When changes are made and "Salvar rascunho" is clicked
Then version v4 status='draft' is created
And badge shows "Publicado v3 + Rascunho v4"
And "Publicar v4" button is enabled
```

```gherkin
Given a draft v4 with credential whose validated_at IS NULL
When clicking "Publicar v4"
Then publish button shows tooltip "Credencial Anthropic não validada"
And button is disabled
```

```gherkin
Given a valid draft
When clicking "Publicar v4" and confirming in dialog
Then POST :publish is called
And badge updates to "Publicado v4" without draft
And toast "v4 publicada e ativa"
```

```gherkin
Given an admin editing prompt
When typing in the textarea
Then token counter updates with debounce 200ms
And shows token count vs context window with warning at >80%
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Form valida required | submit sem name → erro |
| t2 | ui | ModelPicker muda com provider | switch anthropic → openai, models updated |
| t3 | ui | CredentialPicker filtra | provider=openai → mostra só credentials openai |
| t4 | ui | Save creates draft | save + reload + assert v existe |
| t5 | ui | Publish atomic | publish + assert badge published_version_id mudou |
| t6 | ui | Token counter | type long prompt → count atualiza |
| t7 | ui | Publish blocked invalid | credential invalid → button disabled tooltip |
| t8 | ui | Publish dialog diff | mostra diff visual |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_hook
    id: "hook.useAgent"
    signature: "(id) => { agent, publishedVersion, draftVersion, mutate }"
  - type: react_component
    id: "ui.<AgentForm>"
  - type: react_component
    id: "ui.<ToolPicker>"
    props: "{ availableTools: McpToolMeta[], value: string[], onChange }"
  - type: react_component
    id: "ui.<ModelPicker>"
  - type: react_component
    id: "ui.<TriggerEditor>"
  - type: server_action
    id: "saveAgentDraftAction"
  - type: server_action
    id: "publishAgentAction"
```

#### Definition of Done
- [ ] Todos os ACs passam
- [ ] Form keyboard-accessible (Tab nav, Esc dismisses dialogs)
- [ ] Skeleton durante save/publish
- [ ] Commit `feat(EPIC-13): UI agent edit form [wave 11]`

---

### S-13.12 — UI Test mode + Runs (realtime) + History

**Points**: 4 | **Priority**: P0 | **Deps**: S-13.08, S-13.11 | **FR refs**: Spec 12 §4, §5, §6

#### Contexto
Últimos 3 tabs do detail. Test panel envia sample message via `:test` e renderiza trace passo-a-passo. Runs tab mostra log paginated com Supabase Realtime (toast em new run). History tab compara versões side-by-side.

#### Files to create
- `app/(app)/ai/agents/[id]/_components/TestPanel.tsx` (Client)
- `app/(app)/ai/agents/[id]/_components/RunTrace.tsx` (recursivo, expansível por step)
- `app/(app)/ai/agents/[id]/_components/RunsTable.tsx` (Client, com Realtime)
- `app/(app)/ai/agents/[id]/_components/RunDetailDrawer.tsx`
- `app/(app)/ai/agents/[id]/_components/VersionHistory.tsx`
- `app/(app)/ai/agents/[id]/_components/VersionDiff.tsx`
- `hooks/useAgentRuns.ts` — TanStack Query + Realtime channel
- `app/(app)/ai/agents/[id]/_actions.ts` — testAgentAction (já estendido), revertToVersionAction

#### Implementation steps (sequential)
1. TestPanel: textarea sample message + opcional contact data + botão "Executar teste"
2. testAgentAction → `:test` endpoint + retorna run com trace
3. RunTrace: render lista de steps; cada step expansível com tool_name, args (JSON syntax highlight), result (truncated), latency, error
4. Mostrar "Mensagem que SERIA enviada" no final
5. RunsTable: TanStack Query com `useAgentRuns(agentId)` + Supabase Realtime channel `ai_agent_runs:agent_id=eq.X` (subscribe quando tab aberta, unsubscribe ao trocar)
6. Toast on insert/update event
7. RunDetailDrawer: mesma RunTrace UI + links "Ver conversa", "Ver inbound"
8. VersionHistory: timeline visual das versions
9. VersionDiff: react-diff-viewer pra system_prompt, tabs adds/removes, table de mudanças de provider/model/limits
10. Revert: cria nova versão idêntica à selecionada e publica

#### Acceptance Criteria

```gherkin
Given an admin on tab Test
When entering "Oi, quanto custa X?" and clicking Executar
Then loader shows during ~3s
And trace renders with 2-3 steps showing tool calls
And "Mensagem que SERIA enviada" shows the final text
And no actual WAHA send was made (verified via lack of new outbound message in DB)
```

```gherkin
Given an admin on tab Runs
When a new run completes (simulated via DB insert event)
Then a toast appears
And the table top row updates without page reload
```

```gherkin
Given an admin on tab History with v3 published, v4 draft
When clicking "Diff vs v4" on v3 row
Then a side-by-side diff renders showing prompt changes, tools added/removed, model changes
```

```gherkin
Given an admin
When clicking "Reverter" on v2
Then a new version v5 is created identical to v2 and published
And toast "Revertido para versão equivalente a v2 (publicada como v5)"
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Test panel run | submit + assert trace visible + final text |
| t2 | ui | Trace expansível | click step → expanded |
| t3 | ui | Realtime update | insert run via SQL → toast aparece |
| t4 | ui | Run drawer | click row → drawer opens with full trace |
| t5 | ui | Version diff | click → side-by-side render |
| t6 | ui | Revert flow | click revert v2 → v5 created and published |
| t7 | ui | Test mode tem warning custo | UI mostra "consome créditos do provider" |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_hook
    id: "hook.useAgentRuns"
    realtime_channel: "ai_agent_runs:agent_id=eq.X"
  - type: react_component
    id: "ui.<RunTrace>"
    props: "{ run: AiAgentRun, expandable?: boolean }"
  - type: react_component
    id: "ui.<RunsTable>"
  - type: react_component
    id: "ui.<VersionDiff>"
    props: "{ versionA, versionB }"
  - type: realtime_channel
    id: "realtime.ai_agent_runs-{org_id}"
```

#### Definition of Done
- [ ] Todos os ACs passam
- [ ] Realtime subscribe/unsubscribe sem leak
- [ ] Run drawer keyboard accessible
- [ ] Trace renderiza JSON highlight
- [ ] Performance: tabela com 100 rows não trava
- [ ] Commit `feat(EPIC-13): UI test + runs + history [wave 12]`
- [ ] **Final wave** — full epic regression suite passes

---

## 6. Regression Suite Cumulativo (esperado ao final)

| Categoria | # de tests | Origem |
|---|---|---|
| DB schema + RLS | 9 | S-13.01 |
| REST handlers refactored | 5 | S-13.02 |
| MCP server + read tools | 6 | S-13.03 |
| MCP write + handoff tools | 6 | S-13.04 |
| Credentials BYO + AES | 6 | S-13.05 |
| Agents CRUD + versions + publish | 9 | S-13.06 |
| Worker dispatcher | 8 | S-13.07 |
| Runtime ToolLoopAgent | 9 | S-13.08 |
| Webhook hook | 5 | S-13.09 |
| UI lista + credentials | 7 | S-13.10 |
| UI edit form | 8 | S-13.11 |
| UI test + runs + history | 7 | S-13.12 |
| **Total** | **85** | |

## 7. Riscos & Mitigações específicos do epic

| Risco | Severidade | Mitigação |
|---|---|---|
| API key vaza em log/Sentry | CRÍTICO | Smoke test no CI; Sentry beforeSend strip; refusal em PR review |
| Tool loop infinito custa $$$ | ALTO | stepCountIs + token + cost budget per-run + monthly cap |
| Two agents responding to same msg | CRÍTICO | partial unique index + LIMIT 1 dispatcher + adversarial test |
| Mastra/AI SDK function size > 250 MB | MÉDIO | HTTP MCP (no SDK bundle per server); monitor `vercel inspect` |
| Provider deprecated model breaks prod | MÉDIO | `ai_models.deprecated_at`; alert quando agente usa deprecated; fallback documentado |
| Refactor de S-13.02 quebra REST existente | ALTO | Suite REST existente como gate; rollback plan |
| Realtime subscribe vaza memória | BAIXO | unsubscribe explicit no useEffect cleanup; teste manual |
| Webhook latência regride com novo event_log insert | MÉDIO | k6 baseline antes/depois; fire-and-forget pattern |

## 8. Decisões arquiteturais novas que este epic introduz

- **ADR-14**: `_handler.ts` extraído por resource — Route Handlers viram thin wrappers; MCP tools chamam handlers via mesma função (DRY audit/RLS/Zod). Convenção: `app/api/v1/<resource>/_handler.ts` exporta `<verb><Resource>Handler({input, actor})`.
- **ADR-15**: `actor_type='ai_agent'` em audit log + handlers; api_audit_log captura origem da mutação (humana vs automática).
- **ADR-16**: Versionamento Save/Publish — `published_version_id` pointer atomic; nunca editar versão `published`.
- **ADR-17**: Provider keys BYO cifradas AES-GCM com `AI_CRED_AES_KEY` em env; rotation playbook anual.
- **ADR-18**: Coexistência `kind` em `ai_agents` — `rag_bot` (legado) vs `mcp_agent` (novo) no mesmo schema.
- **ADR-19**: Bearer token efêmero (TTL 5min) mintado por agent run pra MCP — `actor_type='ai_agent'`, `agent_run_id` no scope.

## 9. Anexos

- **Specs canônicos** (leitura obrigatória):
  - `docs/specs/10-spec-ai-agents-runtime.md` — schema, endpoints, runtime
  - `docs/specs/11-spec-mcp-server-internal.md` — catálogo MCP, transport, auth
  - `docs/specs/12-spec-ai-agents-ui.md` — telas, fluxos, wireframes
- **Research dossier** (decisão de stack):
  - `~/tino-ai/Tino/research/pre-development/ai-agent-framework-deskcomm-whatsapp/00-brief.md` ... `09-handoff.md`
- **Specs de referência** (consumidos):
  - Spec 01 (auth/RBAC/api_tokens)
  - Spec 03 (WAHA + channel_sessions + webhook)
  - Spec 04 (pipelines + lead activities)
  - Spec 05 (IA-RAG legado — base de `ai_agents`)
  - Spec 07 (events/workers padrão)
  - Spec 09 (frontend-backend integration)
- **Reconciliation log**: novas entradas R-XX serão criadas para ADR-14 a ADR-19 ao final do epic
- **Memória relevante**: `feedback_subagent_atomic_commits` (1 commit por wave), `project_design_system_locked` (Sage + Atkinson), `feedback_admin_mfa` (admin requer MFA pra ações sensíveis)
