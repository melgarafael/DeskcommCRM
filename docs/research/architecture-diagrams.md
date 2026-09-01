---
title: SonghaiCRM — Diagramas de Arquitetura
version: 0.1
status: em revisão
date: 2026-04-28
owner: Songhai, Lda
referencia_arquitetural: docs/research/reference-synthesis.md
formato: Mermaid
---

# SonghaiCRM — Diagramas de Arquitetura

Este documento consolida os diagramas canônicos do SonghaiCRM em sintaxe Mermaid. Serve como referência visual única para discussões de arquitetura, onboarding técnico, revisão de PRs estruturais e auditoria LGPD. Os diagramas aderem ao modelo C4 (níveis 1, 2 e 3), complementados por ER, sequência, deployment, fluxo de dados e máquinas de estado. Toda decisão arquitetural representada aqui foi herdada do bundle de referência (`reference-synthesis.md`) ou explicitada nos sub-PRDs `01` a `06`.

---

## 1. C4 Level 1 — System Context

Visão macro do SonghaiCRM como sistema único, mostrando os atores humanos (operadores BPO, lojistas, clientes finais) e os sistemas externos (Nuvemshop, WhatsApp via WAHA, AI Gateway, ANPD). O foco é responder "quem fala com quem" e "qual é a fronteira do produto". O SonghaiCRM concentra a lógica de negócio; tudo que aparece ao redor é dependência ou usuário.

```mermaid
graph TD
    OperadorBPO[Operador BPO<br/>caixa de entrada unificada cross-tenant]
    Tenant[Tenant / Lojista Nuvemshop<br/>gestor do e-commerce]
    Cliente[Cliente Final<br/>comprador no e-commerce]
    SuperAdmin[Super-admin de Plataforma<br/>sócio empresa operadora]
    Auditor[ANPD / Auditor LGPD<br/>regulador]

    SonghaiCRM[SonghaiCRM<br/>CRM operacional + IA + LGPD<br/>multi-tenant SaaS/BPO]

    Nuvemshop[Nuvemshop API<br/>OAuth + 8 webhooks<br/>+ catálogo + pedidos]
    WAHA[WAHA Plus<br/>WhatsApp HTTP API<br/>multi-sessão NOWEB]
    AIGW[Vercel AI Gateway<br/>Anthropic primário<br/>OpenAI fallback]
    Sentry[Sentry<br/>error tracking]

    OperadorBPO -->|atende multi-tenant| SonghaiCRM
    SuperAdmin -->|gerencia plataforma| SonghaiCRM
    Tenant -->|configura RAG, vê KPIs| SonghaiCRM
    Auditor -.->|requisita audit trail| SonghaiCRM

    Cliente <-->|conversa via WhatsApp| WAHA
    WAHA <-->|webhooks + send| SonghaiCRM

    SonghaiCRM <-->|OAuth + webhooks + sync| Nuvemshop
    SonghaiCRM -->|chat completion + embeddings| AIGW
    SonghaiCRM -->|telemetria de erros| Sentry
```

---

## 2. C4 Level 2 — Container Diagram

Decomposição do SonghaiCRM em containers de runtime. O Next.js App é o monolito hospedado na Vercel; Supabase entrega Postgres, Realtime e Storage gerenciados; Upstash provê Redis para rate-limit; WAHA Plus roda em VPS própria (Docker); o MCP server é projeto separado entrando na Fase 2. A linha pontilhada para o MCP marca componentes ainda não construídos no MVP.

```mermaid
graph TB
    subgraph Vercel
        NextApp[Next.js 14+ App Router<br/>Route Handlers + Server Actions<br/>Cron Vercel]
        AIGW[Vercel AI Gateway<br/>fallback Anthropic→OpenAI]
    end

    subgraph Supabase
        PG[(Postgres<br/>RLS + pgvector<br/>event_log)]
        RT[Supabase Realtime<br/>postgres_changes + broadcast]
        ST[Supabase Storage<br/>bucket whatsapp-media privado]
        Auth[Supabase Auth<br/>JWT + MFA TOTP]
    end

    subgraph Upstash
        Redis[(Redis<br/>sliding-window rate limit<br/>idempotency cache)]
    end

    subgraph VpsWaha["VPS WAHA"]
        Nginx[Nginx<br/>proxy_buffering off]
        WAHA[WAHA Plus<br/>engine NOWEB<br/>N sessões]
    end

    Sentry[Sentry SaaS]
    Anthropic[Anthropic API]
    OpenAI[OpenAI API]
    NS[Nuvemshop API]

    MCP[MCP Server<br/>Node 20 ESM<br/>Fase 2]:::future

    NextApp <--> PG
    NextApp <--> RT
    NextApp <--> ST
    NextApp <--> Auth
    NextApp <--> Redis
    NextApp -->|chat + embeddings| AIGW
    AIGW --> Anthropic
    AIGW --> OpenAI
    NextApp <-->|REST + webhooks| NS
    Nginx --> WAHA
    NextApp <-->|webhook receive + send| Nginx
    NextApp -->|errors| Sentry
    WAHA -->|errors| Sentry

    MCP -.->|REST API Bearer| NextApp
    MCP -.-> Anthropic

    classDef future stroke-dasharray: 5 5,stroke:#888,color:#888
```

---

## 3. C4 Level 3 — Component (App Backend)

Componentes internos do Next.js App. Camada externa: webhook receivers e API REST canônica. Camada de orquestração: middleware de auth, cron handlers, workers consumindo `event_log`. Camada de acesso: clientes Postgres (RLS-aware via cookie OU admin com filtro manual). Triggers Postgres NUNCA fazem HTTP — apenas escrevem em `event_log`; workers fazem o trabalho assíncrono.

```mermaid
graph TB
    subgraph EdgeBoundary[Camada Pública / Borda]
        APIv1[API REST /api/v1/*<br/>cursor pagination<br/>idempotency-key<br/>dual auth]
        WHWA[Webhook /api/wa/webhook<br/>HMAC SHA512]
        WHNS[Webhook /api/v1/webhooks/nuvemshop/*<br/>HMAC + path token]
        WHLGPD[Webhook /api/v1/webhooks/nuvemshop/lgpd/*<br/>redact + data_request + store_redact]
    end

    subgraph Orchestration[Orquestração]
        MW[Auth Middleware<br/>getUser + tenant resolve]
        Cron[Cron Handlers<br/>recover-stuck-messages<br/>sync-sessions<br/>process-pending-webhooks<br/>rag-reindex]
    end

    subgraph Workers[Workers - consomem event_log]
        WSend[whatsapp-send-worker<br/>throttle 1msg/1.2s]
        WAI[ai-response-worker<br/>RAG + Sonnet 4.6]
        WSent[sentiment-worker<br/>Haiku 4.5]
        WSync[nuvemshop-sync-worker<br/>orders + products]
        WRedact[lgpd-redact-worker<br/>cascade anonimização]
        WExport[lgpd-export-worker<br/>JSON + PDF D+7]
        WDisp[webhook-dispatch-worker<br/>backoff exponencial]
        WRAG[rag-indexer-worker<br/>chunker + embedder]
    end

    subgraph DataAccess[Acesso a Dados]
        ClientRLS[RLS-aware DB Client<br/>cookie session]
        ClientAdmin[Admin DB Client<br/>service_role + filter manual]
        StorageCli[Storage Client<br/>signed URLs]
    end

    DB[(Postgres<br/>+ event_log<br/>+ pgvector)]

    APIv1 --> MW
    MW --> ClientRLS
    WHWA --> ClientAdmin
    WHNS --> ClientAdmin
    WHLGPD --> ClientAdmin
    Cron --> ClientAdmin

    ClientRLS --> DB
    ClientAdmin --> DB
    ClientAdmin --> StorageCli

    DB -.->|trigger NÃO faz HTTP<br/>apenas event_log insert| DB

    DB ==>|Realtime / pull-loop| WSend
    DB ==> WAI
    DB ==> WSent
    DB ==> WSync
    DB ==> WRedact
    DB ==> WExport
    DB ==> WDisp
    DB ==> WRAG
```

---

## 4. ER Diagram — Schema completo

Schema central do SonghaiCRM. Em torno de `organizations` orbitam três sub-domínios: (a) chat/canal — `channel_sessions`, `contacts`, `conversations`, `messages`; (b) CRM core — `crm_pipelines` → `crm_stages` → `crm_leads` → `crm_lead_activities` (timeline polimórfica) + `crm_lead_links` (vínculos polimórficos); (c) integração e-commerce e LGPD — `tenant_integrations`, `orders`, `nuvemshop_products`. Tabelas de plataforma (`api_tokens`, `event_log`, `webhook_subscriptions`, `usage_events`) servem o monolito inteiro. Multi-tenancy aplicada via `organization_id` em toda tabela tenant-aware.

```mermaid
erDiagram
    organizations ||--o{ user_organizations : has
    organizations ||--o{ channel_sessions : has
    organizations ||--o{ contacts : has
    organizations ||--o{ conversations : has
    organizations ||--o{ messages : has
    organizations ||--o{ crm_pipelines : has
    organizations ||--o{ tenant_integrations : has
    organizations ||--o{ orders : has
    organizations ||--o{ nuvemshop_products : has
    organizations ||--o{ ai_agents : has
    organizations ||--o{ ai_knowledge_sources : has
    organizations ||--o{ api_tokens : has
    organizations ||--o{ webhook_subscriptions : has
    organizations ||--o{ usage_events : has

    user_organizations }o--|| auth_users : "user_id"
    platform_admins }o--|| auth_users : "user_id (cross-tenant)"

    channel_sessions ||--o{ conversations : routes
    contacts ||--o{ conversations : "starts"
    conversations ||--o{ messages : contains
    contacts ||--o{ crm_leads : "linked via lead_links"
    contacts ||--o{ merge_queue : "candidate"

    crm_pipelines ||--o{ crm_stages : has
    crm_stages ||--o{ crm_leads : holds
    crm_leads ||--o{ crm_lead_activities : timeline
    crm_leads ||--o{ crm_lead_links : "polymorphic links"
    orders ||--o{ crm_lead_links : "linked"

    ai_agents ||--o{ ai_invocations : invocations
    ai_knowledge_sources ||--o{ ai_chunks : "chunked + embedded"
    conversations ||--o{ ai_invocations : "context"

    webhook_subscriptions ||--o{ webhook_deliveries : dispatches
    api_tokens ||--o{ api_audit_log : "actor"
    auth_users ||--o{ api_audit_log : "actor"

    organizations ||--o{ event_log : emits
    organizations ||--o{ webhook_events_log : "raw inbound"
    organizations ||--o{ idempotency_keys : "POST dedupe"

    organizations {
        uuid id PK
        text slug UK
        text name
        jsonb settings
        timestamptz created_at
    }
    user_organizations {
        uuid user_id PK_FK
        uuid organization_id PK_FK
        text role "viewer|agent|manager|admin"
    }
    platform_admins {
        uuid user_id PK_FK
        timestamptz granted_at
    }
    contacts {
        uuid id PK
        uuid organization_id FK
        text phone_e164
        text email
        text cpf
        bool is_blocked
        bool is_anonymized
        jsonb custom_fields
    }
    channel_sessions {
        uuid id PK
        uuid organization_id FK
        text waha_session_name
        text status "STARTING|SCAN_QR|WORKING|FAILED|STOPPED"
        text webhook_secret
    }
    conversations {
        uuid id PK
        uuid organization_id FK
        uuid contact_id FK
        uuid channel_session_id FK
        text status "open|pending|resolved"
        uuid assigned_user_id
    }
    messages {
        uuid id PK
        uuid organization_id FK
        uuid conversation_id FK
        text external_id "WAHA id"
        text direction "in|out"
        text status "sending|sent|delivered|read|failed"
        text body
        jsonb media
    }
    webhook_events_log {
        uuid id PK
        uuid organization_id FK
        text provider
        text external_id
        jsonb raw_payload
        timestamptz received_at
    }
    crm_pipelines {
        uuid id PK
        uuid organization_id FK
        text name
        jsonb vocabulary
        jsonb settings "fields schema"
    }
    crm_stages {
        uuid id PK
        uuid pipeline_id FK
        text name
        numeric position
        bool is_won
        bool is_lost
    }
    crm_leads {
        uuid id PK
        uuid organization_id FK
        uuid stage_id FK
        uuid owner_user_id
        numeric position_in_stage
        text status "open|won|lost"
        text lost_reason
        text external_id "Nuvemshop order id"
        jsonb custom_fields
        text[] tags
    }
    crm_lead_activities {
        uuid id PK
        uuid organization_id FK
        uuid lead_id FK
        text type "whatsapp_inbound|stage_changed|handoff_triggered|..."
        text source_module
        uuid source_id
        jsonb metadata
    }
    crm_lead_links {
        uuid id PK
        uuid lead_id FK
        text target_kind "contact|order|conversation|message"
        uuid target_id
        text link_kind
    }
    merge_queue {
        uuid id PK
        uuid organization_id FK
        uuid contact_a FK
        uuid contact_b FK
        text status "pending|merged|rejected"
    }
    ai_agents {
        uuid id PK
        uuid organization_id FK
        text model "anthropic/claude-sonnet-4-6"
        text system_prompt
        jsonb config
    }
    ai_knowledge_sources {
        uuid id PK
        uuid organization_id FK
        text kind "faq|policy_pdf|catalog|resolved_conv"
        text source_uri
    }
    ai_chunks {
        uuid id PK
        uuid source_id FK
        text content
        vector embedding
    }
    ai_invocations {
        uuid id PK
        uuid organization_id FK
        uuid conversation_id FK
        text purpose "chat|sentiment|rag"
        int tokens_in
        int tokens_out
        numeric cost_cents
    }
    tenant_integrations {
        uuid id PK
        uuid organization_id FK
        text provider "nuvemshop"
        jsonb credentials_encrypted
        text status
    }
    orders {
        uuid id PK
        uuid organization_id FK
        text external_id "Nuvemshop order id"
        text status
        int total_cents
        timestamptz placed_at
    }
    nuvemshop_products {
        uuid id PK
        uuid organization_id FK
        text external_id
        text name
        jsonb data
    }
    api_tokens {
        uuid id PK
        uuid organization_id FK
        text token_hash
        text scopes
    }
    api_audit_log {
        uuid id PK
        uuid organization_id FK
        uuid actor_user_id
        text action
        text target_kind
        uuid target_id
        jsonb diff
    }
    event_log {
        uuid id PK
        uuid organization_id FK
        text event_name "lead.created|message.received|..."
        jsonb payload
        timestamptz emitted_at
    }
    idempotency_keys {
        text key PK
        uuid organization_id FK
        jsonb response
        timestamptz expires_at
    }
    webhook_subscriptions {
        uuid id PK
        uuid organization_id FK
        text url
        text secret
        text[] events
    }
    webhook_deliveries {
        uuid id PK
        uuid subscription_id FK
        text status "pending|delivering|success|failed|dead"
        int attempts
        timestamptz next_retry_at
    }
    usage_events {
        uuid id PK
        uuid organization_id FK
        text metric "messages_sent|ai_tokens|storage_mb"
        numeric value
    }
```

---

## 5. Sequence Diagram — Inbound WhatsApp message

Trajeto de uma mensagem que chega do cliente final. WAHA dispara webhook assinado; nosso receiver valida HMAC, persiste o payload bruto em `webhook_events_log` (auditoria), executa identity resolution determinística, faz upsert idempotente em `contacts`, `conversations` e `messages`, emite eventos em `event_log` e responde 200 imediatamente. Workers (sentimento e bot) consomem em paralelo, sem bloquear a resposta.

```mermaid
sequenceDiagram
    autonumber
    participant Cliente as Cliente Final
    participant WA as WhatsApp
    participant WAHA as WAHA Plus
    participant API as /api/wa/webhook
    participant DB as Postgres
    participant W1 as ai-response-worker
    participant W2 as sentiment-worker

    Cliente->>WA: envia mensagem
    WA->>WAHA: deliver
    WAHA->>API: POST webhook<br/>+ X-WAHA-Signature
    API->>API: HMAC SHA512 timingSafeEqual
    API->>DB: insert webhook_events_log (raw)
    API->>DB: identity resolution<br/>(phone E.164 + email + CPF)
    API->>DB: upsert contact ON CONFLICT
    API->>DB: upsert conversation
    API->>DB: insert message<br/>unique (org, external_id)
    API->>DB: insert event_log<br/>message.received
    API-->>WAHA: 200 OK
    par Workers em paralelo
        DB-->>W1: notify message.received
        W1->>W1: build context + RAG + Sonnet
    and
        DB-->>W2: notify message.received
        W2->>W2: Haiku score sentiment
    end
```

---

## 6. Sequence Diagram — AI bot response with handoff

Pós-evento `message.received`, o `ai-response-worker` constrói contexto (últimas 20 mensagens + perfil do contato + último pedido + RAG hits), chama Sonnet 4.6 via AI Gateway, passa por guardrail (políticas, PII, comprimento). Se gatilho de handoff (cliente pediu humano, sentimento baixo, IA admite incerteza, estágio crítico), registra activity e marca `conversation.status='pending'` notificando atendentes via Realtime. Caso contrário, despacha resposta via WAHA com persistência otimista.

```mermaid
sequenceDiagram
    autonumber
    participant DB as Postgres event_log
    participant AIW as ai-response-worker
    participant Ctx as Context Builder
    participant RAG as pgvector RAG
    participant GW as Vercel AI Gateway
    participant LLM as Sonnet 4.6
    participant Guard as Guardrail
    participant WAHA as WAHA Plus
    participant RT as Realtime

    DB-->>AIW: message.received
    AIW->>Ctx: load last 20 msgs + contact + last order
    AIW->>RAG: similarity search top-k
    AIW->>GW: chat.completions<br/>"anthropic/claude-sonnet-4-6"
    GW->>LLM: forward
    LLM-->>GW: completion
    GW-->>AIW: response + usage
    AIW->>Guard: check policy + PII + handoff triggers

    alt Handoff disparado
        AIW->>DB: insert activity handoff_triggered<br/>+ metadata.sentiment
        AIW->>DB: update conversation status='pending'
        AIW->>RT: broadcast handoff to agents
    else IA responde
        AIW->>DB: insert message status='sending'
        AIW->>WAHA: POST send (throttle 1msg/1.2s)
        WAHA-->>AIW: external_id
        AIW->>DB: update message status='sent' + external_id
        AIW->>DB: insert event_log message.sent
    end
```

---

## 7. Sequence Diagram — Nuvemshop order/paid webhook

A Nuvemshop assina webhooks por loja. O endpoint resolve o tenant via path token (URL canônica `/api/v1/webhooks/nuvemshop/order-paid/:tenantToken`), valida HMAC, deduplica por `unique (provider, external_id)`, resolve ou cria contato a partir do customer da Nuvemshop, localiza o `crm_lead` por `external_id` e move para o estágio "Pago". Resposta 200 imediata; downstream (notificações, cálculo de KPIs) flui via `event_log`.

```mermaid
sequenceDiagram
    autonumber
    participant NS as Nuvemshop
    participant API as /api/v1/webhooks/nuvemshop/order-paid/:token
    participant DB as Postgres
    participant W as nuvemshop-sync-worker

    NS->>API: POST order/paid<br/>+ HMAC header
    API->>API: HMAC verify (timing-safe)
    API->>DB: resolve tenant via path token
    API->>DB: idempotency check<br/>unique (provider, external_id)
    alt já processado
        API-->>NS: 200 OK (no-op)
    else novo
        API->>DB: upsert contact (email + phone E.164)
        API->>DB: find crm_lead by external_id
        API->>DB: move lead to stage "Pago"<br/>(fractional reposition)
        API->>DB: insert lead_activity stage_changed
        API->>DB: insert event_log lead.stage_changed
        API-->>NS: 200 OK
        DB-->>W: notify lead.stage_changed
        W->>W: post-actions (notify agent, NPS schedule)
    end
```

---

## 8. Sequence Diagram — LGPD data_request

Tenant (ou titular via webhook Nuvemshop `customer/data_request`) inicia um pedido de exportação. Endpoint enfileira via `event_log`; `lgpd-export-worker` coleta dados de `contacts`, `crm_leads`, `crm_lead_activities`, `messages`, `orders`; gera JSON estruturado + PDF; sobe pra Storage com URL assinada de TTL curto; notifica titular e tenant; tudo logado em `api_audit_log`. SLA D+7 com alarme em D+5.

```mermaid
sequenceDiagram
    autonumber
    participant T as Tenant / Titular
    participant API as POST /api/v1/lgpd/data-request
    participant DB as Postgres
    participant W as lgpd-export-worker
    participant ST as Supabase Storage
    participant Mail as Email/WhatsApp

    T->>API: solicita export
    API->>DB: insert lgpd_request status='queued'
    API->>DB: insert event_log lgpd.export_requested
    API-->>T: 202 Accepted (request_id)

    DB-->>W: notify lgpd.export_requested
    W->>DB: collect contacts + leads + activities + messages + orders
    W->>W: generate structured JSON
    W->>W: render PDF (titular-friendly)
    W->>ST: upload (path por org + request_id)
    ST-->>W: signed URL TTL=72h
    W->>DB: update request status='delivered' + url
    W->>DB: insert api_audit_log lgpd.export_delivered
    W->>Mail: send link to titular + tenant
    Note over W,DB: SLA D+7 monitorado<br/>alarme em D+5
```

---

## 9. Sequence Diagram — Multi-tenant request flow

Como cada request entra no monolito Next.js e é isolado por tenant. O middleware lê o cookie de sessão Supabase, valida o JWT, resolve o `organization_id` do usuário (ou via super-admin override). A escolha do client Postgres define a postura de segurança: cliente RLS-aware (frontend e endpoints user-facing) ou admin client (webhooks, cron) com filtro manual obrigatório. RLS aplica `fn_user_org_ids()` em toda tabela tenant-aware.

```mermaid
sequenceDiagram
    autonumber
    participant U as Usuário
    participant Edge as Vercel Edge
    participant MW as Next.js Middleware
    participant Auth as Supabase Auth
    participant Route as Route Handler
    participant Cli as DB Client
    participant PG as Postgres + RLS

    U->>Edge: request + cookie
    Edge->>MW: forward
    MW->>Auth: getUser() valida JWT
    Auth-->>MW: user + claims
    MW->>MW: resolve tenant_id<br/>(claim ou path param)
    MW->>Route: req + ctx{user, org}

    alt user-facing
        Route->>Cli: RLS-aware client (cookie)
        Cli->>PG: SELECT/UPDATE
        PG->>PG: RLS via fn_user_org_ids()
        PG-->>Cli: linhas filtradas
    else webhook / cron
        Route->>Cli: admin client (service_role)
        Cli->>PG: SELECT WHERE org_id = $resolvido
        Note over Cli,PG: RLS bypass — filtro manual obrigatório
        PG-->>Cli: linhas
    end

    Cli-->>Route: data
    Route-->>U: response (data, meta)
```

---

## 10. Deployment Diagram

Topologia física de produção. Vercel hospeda o Next.js (Edge + serverless), Supabase entrega os 3 serviços gerenciados, Upstash o Redis, uma VPS própria roda WAHA atrás de Nginx. AI Gateway é proxy interno da Vercel para Anthropic e OpenAI. Sentry recebe telemetria do Next.js e do host WAHA. Conexões críticas: Realtime via WebSocket persistente, webhooks WAHA via HTTPS, AI calls via HTTPS com observability nativa.

```mermaid
graph LR
    User[Usuário<br/>Browser]
    Edge[Vercel Edge<br/>CDN + Middleware]
    App[Next.js App<br/>serverless functions]

    PG[(Supabase Postgres<br/>RLS + pgvector)]
    RT[Supabase Realtime<br/>WebSocket]
    ST[Supabase Storage]
    Redis[(Upstash Redis<br/>rate limit)]

    AIGW[Vercel AI Gateway]
    Anthropic[Anthropic API]
    OpenAI[OpenAI API]

    NS[Nuvemshop API]

    subgraph VpsWaha[VPS WAHA]
        Nginx[Nginx<br/>TLS + buffering off]
        WAHA[WAHA Plus<br/>Docker NOWEB]
    end

    Sentry[Sentry SaaS]

    User -->|HTTPS| Edge
    Edge --> App
    App -->|SQL| PG
    App <-->|WS| RT
    App -->|signed URL| ST
    App -->|TCP| Redis
    App -->|HTTPS| AIGW
    AIGW --> Anthropic
    AIGW --> OpenAI
    App <-->|HTTPS REST| NS
    NS -.->|webhooks| App

    WAHA --> Nginx
    Nginx -.->|webhook HTTPS| App
    App -->|send HTTPS| Nginx

    App -->|telemetry| Sentry
    WAHA -->|telemetry| Sentry
```

---

## 11. Data Flow — RAG ingestion pipeline

Quatro fontes alimentam a base vetorial por tenant: FAQ (markdown manual), política da loja (PDF), catálogo Nuvemshop (sync periódico), conversas resolvidas (corpus de exemplos). Cada fonte passa pelo chunker (tamanho configurável + overlap), embedder OpenAI (text-embedding-3-small por padrão), grava em `ai_chunks` com `vector` e `source_id`. Re-indexação por cron `rag-reindex` ou trigger ao atualizar fonte. Consumo pelo `ai-response-worker` na busca top-k.

```mermaid
graph TD
    F1[FAQ markdown<br/>manual via UI]
    F2[Política da loja<br/>PDF upload]
    F3[Catálogo Nuvemshop<br/>sync API produtos]
    F4[Conversas resolvidas<br/>conversation.status='resolved']

    Norm[Normalizer<br/>strip HTML + clean]
    Chunk[Chunker<br/>~512 tokens + overlap]
    Embed[Embedder<br/>OpenAI text-embedding-3-small]

    Sources[(ai_knowledge_sources)]
    Chunks[(ai_chunks<br/>pgvector)]

    Reidx[Cron rag-reindex<br/>delta + full]

    F1 --> Norm
    F2 --> Norm
    F3 --> Norm
    F4 --> Norm
    Norm --> Sources
    Sources --> Chunk
    Chunk --> Embed
    Embed --> Chunks

    Reidx -.->|força reprocessamento| Sources

    Q[ai-response-worker query]
    Chunks --> Q
```

---

## 12. State Machine — Conversation status

Toda conversa transita entre três estados auditáveis. `open` é o estado inicial; transições são registradas como activities. `pending` indica handoff pendente; `resolved` fecha a conversa e dispara NPS automatizado. Reabertura é permitida (cliente volta a falar após `resolved`).

```mermaid
stateDiagram-v2
    [*] --> open : primeira mensagem inbound
    open --> pending : handoff_triggered<br/>(sentiment baixo, pedido humano, etc.)
    pending --> open : agente assume e continua
    pending --> resolved : agente marca resolvida
    open --> resolved : IA encerra com sucesso<br/>ou agente marca
    resolved --> open : nova mensagem do cliente<br/>(reabertura)
    resolved --> [*] : retenção / arquivamento

    note right of pending
        notifica atendentes via Realtime
        SLA tempo de espera começa aqui
    end note
```

---

## 13. State Machine — Lead status

Lead segue ciclo `open → won|lost`, com possibilidade de reabertura. `won` e `lost` derivam do flag `is_won`/`is_lost` do estágio destino, não de coluna independente. `lost` exige `lost_reason`. Reabertura volta para `open` num estágio explicitamente escolhido.

```mermaid
stateDiagram-v2
    [*] --> open : lead criado<br/>(novo cliente / pedido)
    open --> won : move para stage com is_won=true<br/>(ex: "Pago", "Entregue")
    open --> lost : move para stage com is_lost=true<br/>+ lost_reason obrigatório
    won --> open : reabertura<br/>(ex: troca, devolução)
    lost --> open : reativação manual
    won --> [*] : ciclo encerrado
    lost --> [*] : ciclo encerrado

    note right of lost
        lost_reason em texto livre
        + categoria opcional
    end note
```

---

## 14. State Machine — Channel session

Estados da sessão WAHA (1 sessão = 1 número). Reflete o ciclo de vida do par WAHA-WhatsApp. `STARTING` → `SCAN_QR_CODE` (UI mostra QR) → `WORKING` (operacional). `FAILED` é absorvente em caso de banimento; `STOPPED` é desligamento controlado. Cron `sync-sessions` reconcilia status com o WAHA periodicamente.

```mermaid
stateDiagram-v2
    [*] --> STARTING : create session
    STARTING --> SCAN_QR_CODE : aguarda pareamento
    SCAN_QR_CODE --> WORKING : QR escaneado com sucesso
    SCAN_QR_CODE --> FAILED : timeout ou erro
    STARTING --> FAILED : erro init
    WORKING --> STOPPED : desligamento manual
    WORKING --> FAILED : banimento WhatsApp<br/>ou erro fatal
    STOPPED --> STARTING : reconectar
    FAILED --> STARTING : recriar (após investigação)
    STOPPED --> [*]
    FAILED --> [*]

    note right of FAILED
        runbook obrigatório
        número backup pré-aquecido
    end note
```

---

## 15. Diagrama de Multi-tenancy

Como o isolamento é garantido em todas as camadas. Toda tabela tenant-aware tem `organization_id uuid not null`. RLS aplica policy idêntica usando `fn_user_org_ids()` (security definer, retorna orgs do usuário). Super-admin ganha um helper que retorna TRUE para qualquer tenant — usado na "caixa de entrada unificada". Service role bypassa RLS, então webhook handlers e cron precisam filtrar manualmente o `organization_id` resolvido a partir de fonte confiável (cookie, JWT claim, webhook secret ou path token), nunca do body.

```mermaid
graph TB
    subgraph Frontend[Frontend - cookie session]
        UI[UI Tenant<br/>vê apenas seu org_id]
        UISA[UI Super-admin<br/>vê todos]
    end

    subgraph API[API Layer]
        EP[Route Handler]
        MW[Middleware<br/>resolve tenant_id]
    end

    subgraph DBClients[Postgres Clients]
        Cli1[RLS-aware Client<br/>cookie session]
        Cli2[Admin Client<br/>service_role]
    end

    subgraph PG[Postgres]
        Helper[fn_user_org_ids<br/>security definer]
        HelperSA[fn_is_platform_admin<br/>retorna TRUE para super-admin]
        Policy["RLS Policy:<br/>org_id IN fn_user_org_ids()<br/>OR fn_is_platform_admin()"]
        Tables[(Tabelas tenant-aware<br/>contacts, leads, messages...)]
    end

    Webhook[Webhook Receiver<br/>resolve org via path token<br/>+ HMAC]
    Cron[Cron Handler<br/>resolve org via tabela]

    UI --> EP
    UISA --> EP
    EP --> MW
    MW --> Cli1
    Cli1 --> Tables
    Tables -.->|aplica| Policy
    Policy --> Helper
    Policy --> HelperSA

    Webhook --> Cli2
    Cron --> Cli2
    Cli2 -->|WHERE org_id = $resolvido<br/>filtro manual obrigatório| Tables

    note1[Anti-pattern proibido:<br/>service_role sem filtro manual<br/>= vazamento cross-tenant]
    Cli2 -.-> note1
```

---

## Notas finais

Este documento é vivo. Toda alteração arquitetural relevante (nova tabela tenant-aware, novo worker, novo provider externo, novo estado em máquina) exige atualização correspondente do diagrama afetado e bump da versão no frontmatter. Mantenha a sintaxe Mermaid testada antes de mergear: o GitHub renderiza nativamente; em VS Code use a extensão Mermaid Preview.

Diagramas omissos por estarem fora do escopo do MVP (mas previstos pra documentar quando entrarem):

- MCP Server Component Diagram (Fase 2)
- Sequence de OAuth Nuvemshop (instalação de app)
- Deployment com VTEX/Shopify (Fase 5)
- State machine de webhook_deliveries (pending → delivering → success | failed | dead)
