---
epic_id: EPIC-07-nuvemshop
epic_name: Nuvemshop Integration
priority: P0
estimated_waves: 11
estimated_total_points: 36
depends_on: [EPIC-00, EPIC-01, EPIC-02, EPIC-04, EPIC-05]
exposes_contracts:
  - "server_action.connectNuvemshop"
  - "api.GET /api/v1/integrations/nuvemshop/callback"
  - "api.POST /api/v1/integrations/nuvemshop/resync"
  - "api.POST /api/v1/webhooks/nuvemshop/order-created"
  - "api.POST /api/v1/webhooks/nuvemshop/order-paid"
  - "api.POST /api/v1/webhooks/nuvemshop/order-cancelled"
  - "api.POST /api/v1/webhooks/nuvemshop/order-fulfilled"
  - "api.POST /api/v1/webhooks/nuvemshop/cart-abandoned"
  - "lib.EcommercePlatformAdapter"
  - "lib.NuvemshopAdapter"
  - "lib.processWebhook"
  - "worker.nuvemshop-oauth-refresh"
  - "worker.nuvemshop-sync-products"
  - "worker.nuvemshop-sync-customers"
  - "worker.nuvemshop-sync-orders"
  - "worker.nuvemshop-post-connect"
  - "event.nuvemshop.order_created"
  - "event.nuvemshop.order_paid"
  - "event.nuvemshop.order_cancelled"
  - "event.nuvemshop.order_fulfilled"
  - "event.nuvemshop.cart_abandoned"
  - "db.tenant_integrations"
  - "db.orders"
  - "db.nuvemshop_products"
  - "db.sync_progress"
  - "route./app/integrations/nuvemshop"
status: completed
created_at: 2026-04-28
owner: Songhai, Lda
---

# EPIC-07 — Nuvemshop Integration

> **Para o epic-executor**: leia este arquivo inteiro antes de qualquer wave. Stories em ordem estrita de dependência. As 3 webhooks LGPD (`customer/redact`, `customer/data_request`, `store/redact`) **NÃO** estão neste epic — ficam em EPIC-08. Aqui entregamos a infraestrutura OAuth + adapter + 5 webhooks operacionais + sync workers + UI de configuração. EPIC-08 reusa `processWebhook`, `NuvemshopAdapter`, `tenant_integrations` e `webhook_events_log`.

## 1. Objetivo

Conectar tenant SonghaiCRM a uma loja Nuvemshop via OAuth, ingerir pedidos/clientes/produtos via 5 webhooks operacionais + 3 sync workers iniciais, e materializar cada pedido como lead no pipeline "Pedidos" (criado por T-05). Resultado mensurável: ao final do epic, conectar uma loja real → ver pedidos abertos virando cards no Kanban em <30s do `order/created`.

## 2. Resultado esperado (Definition of Done do Epic)

- [ ] Admin clica "Conectar Nuvemshop" em `/app/integrations/nuvemshop` → Server Action `connectNuvemshop` redireciona pra Nuvemshop authorize URL com state HMAC válido
- [ ] Callback `/api/v1/integrations/nuvemshop/callback` troca code por tokens, persiste encrypted via `fn_encrypt_oauth`, registra 8 webhook subscriptions (5 operacionais + 3 LGPD placeholders consumidos por EPIC-08) na Nuvemshop API
- [ ] Worker cron `nuvemshop-oauth-refresh` renova tokens com `expires_at < now() + 24h`
- [ ] `EcommercePlatformAdapter` interface + `NuvemshopAdapter` impl com 8 métodos (fetchOrders/fetchCustomers/fetchProducts/subscribeWebhooks/unsubscribeWebhooks/redactCustomer/exportCustomerData/healthCheck/refreshAccessToken)
- [ ] Middleware `processWebhook` valida HMAC + skew ±5min + log raw em `webhook_events_log` + idempotência via UNIQUE constraint, reusável pelos 8 receivers
- [ ] `order/created` cria order + lead em pipeline "Pedidos" stage "Aguardando pagamento" via identity resolution (Sub-PRD 02)
- [ ] `order/paid` move lead pra stage "Pago" + activity
- [ ] `order/cancelled` marca lead como `status='lost'` com `lost_reason` mapeado (`cancelled_by_customer` | `cancelled_by_store`)
- [ ] `order/fulfilled` move lead conforme `fulfillment_status` (packed/shipped/delivered)
- [ ] `cart/abandoned` cria lead em stage "Carrinho abandonado" (sem row em `orders`)
- [ ] 3 sync workers (products/customers/orders 90d) rodam paginados com rate limit + backoff
- [ ] UI `/app/integrations/nuvemshop`: status de conexão, re-sync manual em 4 modos, log dos últimos 50 webhooks, editor de stage_mapping
- [ ] RLS isolation: tenant A não vê integration/orders/products de tenant B (smoke test obrigatório)
- [ ] Regression suite cumulativo passa em todas as waves anteriores do epic

## 3. Pré-requisitos

- Epics anteriores completos: EPIC-00, EPIC-01, EPIC-02, EPIC-04 (pipeline "Pedidos" canônico via T-05), EPIC-05 (`contacts`, `contact_external_ids`, `resolveContact`, `merge_queue`)
- Migrations Supabase 0001-0007 aplicadas + nova migration 0008 introduzida pela S-07.01 (tabelas `tenant_integrations`, `orders`, `nuvemshop_products`, `sync_progress` + funções `fn_encrypt_oauth`/`fn_decrypt_oauth`)
- Variáveis de env configuradas: `NUVEMSHOP_CLIENT_ID`, `NUVEMSHOP_CLIENT_SECRET`, `NUVEMSHOP_APP_ID`, `OAUTH_STATE_SECRET`, `NUVEMSHOP_OAUTH_ENCRYPTION_KEY` (≥32 bytes), `PUBLIC_BASE_URL`, `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`
- Chave `app.nuvemshop_oauth_key` injetada no Postgres via `ALTER DATABASE ... SET app.nuvemshop_oauth_key = '...'`
- Dev server em `localhost:3001` com `ngrok`/proxy público pra receber webhooks Nuvemshop em dev (a Nuvemshop não bate em localhost)
- Conta dev Nuvemshop (Partner Portal) com app de teste configurado e callback URL apontando pro env de dev
- Playwright MCP conectado pra QA

## 4. Architecture Contracts

### 4.1 Contracts consumidos (de epics anteriores)

| Contract ID | Tipo | Origem | Como usar |
|---|---|---|---|
| `auth.user-session` | session | EPIC-01 | `requireOrgAdmin()` em Server Actions, `requireAuth()` no callback |
| `lib.requireRole` | guard | EPIC-01 | Apenas `admin`/`manager` conectam/desconectam |
| `db.organizations` | db_table | EPIC-00 | FK em `tenant_integrations.organization_id` |
| `db.contacts` | db_table | EPIC-05 | FK em `orders.contact_id` |
| `db.contact_external_ids` | db_table | EPIC-05 | Mapping `(provider='nuvemshop', external_id)` → `contact_id` |
| `lib.resolveContact` | fn | EPIC-05 | Identity resolution determinística (email/phone/cpf) |
| `lib.enqueueMergeReview` | fn | EPIC-05 | Em conflito de identity resolution |
| `db.crm_leads` | db_table | EPIC-04 | Insert lead com pipeline "Pedidos" |
| `db.crm_lead_links` | db_table | EPIC-04 | Link `target_kind='order'` |
| `db.crm_lead_activities` | db_table | EPIC-04 | Activities `nuvemshop_*` |
| `db.crm_pipelines` (seed T-05) | db_table | EPIC-02 | Pipeline "Pedidos" 7 stages canônicas já existe |
| `db.webhook_events_log` | db_table | EPIC-03 | Reuso pra log raw + idempotência (`provider='nuvemshop'`) |
| `db.event_log` | db_table | EPIC-00 | Emit `nuvemshop.<event>` events |
| `lib.emitEvent` | fn | EPIC-00 | Trigger downstream workers |
| `lib.audit` | fn | EPIC-01 | `integration.connected`, `integration.token_refreshed` |
| `infra.qstash` | infra | EPIC-00 | Worker queue pra sync jobs |
| `infra.vercel-cron` | infra | EPIC-00 | OAuth refresh cron */15 |
| `ui.<Button>`, `<Card>`, `<Table>` | components | EPIC-01 | UI de configuração |

### 4.2 Contracts expostos (consumíveis por epics futuros)

| Contract ID | Tipo | Wave que expõe | Descrição pra consumidores |
|---|---|---|---|
| `db.tenant_integrations` | db_table | S-07.01 | OAuth state + webhook routing por tenant; consumido por EPIC-08 LGPD e EPIC-11 admin |
| `db.orders` | db_table | S-07.01 | Pedidos materializados; EPIC-08 cascade redact, EPIC-05 timeline |
| `db.nuvemshop_products` | db_table | S-07.01 | Cache de catálogo pro RAG (EPIC-06) |
| `db.sync_progress` | db_table | S-07.01 | UI de progresso |
| `server_action.connectNuvemshop` | server_action | S-07.01 | Botão "Conectar" (R-05) |
| `api.GET /api/v1/integrations/nuvemshop/callback` | api_route | S-07.02 | OAuth redirect handler |
| `api.POST /api/v1/integrations/nuvemshop/resync` | api_route | S-07.10 | `{ mode: 'all'\|'customers'\|'products'\|'last_7d_orders' }` |
| `lib.EcommercePlatformAdapter` | ts_interface | S-07.04 | Plugável pra VTEX/Shopify futuros |
| `lib.NuvemshopAdapter` | ts_class | S-07.04 | Impl concreta; EPIC-08 reusa `redactCustomer`/`exportCustomerData` |
| `lib.getAdapter`, `lib.loadContext` | factory | S-07.04 | Carrega ctx decryptado de `tenant_integrations` |
| `lib.processWebhook` | middleware | S-07.05 | Reusado pelos 8 receivers (5 aqui + 3 LGPD em EPIC-08) |
| `event.nuvemshop.order_created` | domain_event | S-07.06 | Payload `{ integrationId, webhookLogId, externalEventId, data }` |
| `event.nuvemshop.order_paid` | domain_event | S-07.07 | idem |
| `event.nuvemshop.order_cancelled` | domain_event | S-07.08 | idem |
| `event.nuvemshop.order_fulfilled` | domain_event | S-07.09 | idem |
| `event.nuvemshop.cart_abandoned` | domain_event | S-07.09 | idem |
| `worker.nuvemshop-oauth-refresh` | cron | S-07.03 | `*/15 * * * *` |
| `worker.nuvemshop-sync-products` | qstash_job | S-07.10 | Job `nuvemshop.sync_products` |
| `worker.nuvemshop-sync-customers` | qstash_job | S-07.10 | Job `nuvemshop.sync_customers` |
| `worker.nuvemshop-sync-orders` | qstash_job | S-07.10 | Job `nuvemshop.sync_orders` |
| `route./app/integrations/nuvemshop` | route | S-07.11 | Página de configuração |

## 5. Stories (em ordem de dependência)

> Cada story = 1 wave. Deps internos respeitados pela ordem.

---

### S-07.01 — Migration 0008 + Server Action `connectNuvemshop`

**Points**: 4 | **Priority**: P0 | **Deps**: (none) | **FR refs**: Spec 06 §3.1, §4.2; RECONCILIATION-LOG R-05; Business rules: T-01, T-02, T-08, B-05, L-09

#### Contexto

Wave fundadora. Cria todas as tabelas do epic e o ponto de entrada do OAuth como **Server Action** (R-05 sobrescreve a Spec 06 §4.2 antiga que era REST GET). A Server Action gera token `state` HMAC (10min TTL, amarrado a `org_id+user_id+nonce`) e dispara `redirect()` pra Nuvemshop authorize URL. Mantém rota REST `GET /connect` como fallback documentado pra clients server-to-server.

`tenant_integrations` traz `webhook_path_token` (UUID v4, único globalmente — R-W) e `webhook_secret_encrypted` rotacionáveis. Tokens OAuth ficam em `bytea` encrypted-at-rest via `fn_encrypt_oauth` que lê `current_setting('app.nuvemshop_oauth_key')` (chave de env, nunca em SQL versionado — L-09).

#### Files to create

- `supabase/migrations/0008_nuvemshop_integration.sql` — tabelas `tenant_integrations`, `orders`, `nuvemshop_products`, `sync_progress`; funções `fn_encrypt_oauth`/`fn_decrypt_oauth`; RLS policies; indexes
- `lib/oauth/state.ts` — `signState({orgId,userId,nonce,issuedAt})` e `verifyState(token)` via JWT HS256 com `OAUTH_STATE_SECRET`, TTL 10min
- `app/(app)/integrations/nuvemshop/_actions.ts` — Server Action `connectNuvemshop()` com `'use server'`
- `lib/auth/guards.ts` — adicionar `requireOrgAdmin()` se ainda não existe (caso EPIC-01 tenha exposto só `requireAuth`)

#### Files to modify

- `supabase/migrations/MANIFEST.md` — adicionar entrada 0008
- `.env.example` — adicionar `NUVEMSHOP_CLIENT_ID`, `NUVEMSHOP_CLIENT_SECRET`, `NUVEMSHOP_APP_ID`, `OAUTH_STATE_SECRET`, `NUVEMSHOP_OAUTH_ENCRYPTION_KEY`, `PUBLIC_BASE_URL`

#### Implementation steps (sequential)

1. Escrever migration 0008 com schema completo da Spec 06 §3.1–§3.3 + tabela `sync_progress` (§6.4) + funções de cripto (§3.1 final)
2. Aplicar via `mcp__plugin_supabase_supabase__apply_migration`
3. Setar `app.nuvemshop_oauth_key` via SQL `ALTER DATABASE postgres SET app.nuvemshop_oauth_key = '<32-byte-hex>'`
4. Implementar `signState`/`verifyState` em `lib/oauth/state.ts` (JWT HS256, claims `{org_id, user_id, nonce, iat, exp}`, TTL 600s)
5. Implementar Server Action `connectNuvemshop()`: `requireOrgAdmin()` → `signState({...})` → monta URL `https://www.nuvemshop.com.br/apps/${APP_ID}/authorize?client_id=${CID}&state=${state}` → `redirect(url)`
6. Smoke test manual: chamar Server Action via botão temporário, verificar redirect 302 com state válido decodificável

#### Acceptance Criteria

```gherkin
Given migration 0008 aplicada
When inspeciono o schema via list_tables
Then existem tabelas tenant_integrations, orders, nuvemshop_products, sync_progress todas com RLS habilitada
And existem funções fn_encrypt_oauth e fn_decrypt_oauth com SECURITY DEFINER
```

```gherkin
Given user role admin no tenant A
When chama Server Action connectNuvemshop
Then resposta é redirect 302 pra https://www.nuvemshop.com.br/apps/.../authorize
And query param state decodifica como JWT válido com org_id=A e exp dentro de 10 min
```

```gherkin
Given user role agent (não-admin)
When chama Server Action connectNuvemshop
Then erro thrown com code 'auth_required' ou 'forbidden_role' (depende de requireOrgAdmin)
```

```gherkin
Given tenant_integrations row com oauth_access_token_encrypted preenchido
When chamo SELECT fn_decrypt_oauth(oauth_access_token_encrypted) como service_role
Then retorna o plaintext original
And o mesmo SELECT como role anon retorna ERROR (revoke)
```

```gherkin
Given duas orgs A e B inserem cada uma um tenant_integrations
When user de A faz SELECT * FROM tenant_integrations
Then só vê a row de A (RLS via fn_user_org_ids)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | db | Migration 0008 aplica sem erro | `mcp__plugin_supabase_supabase__apply_migration` retorna ok |
| t2 | db | RLS habilitada nas 4 tabelas novas | `select tablename, rowsecurity from pg_tables where tablename in (...)` |
| t3 | db | Indexes criados | `\di tenant_integrations*` mostra 4 indexes |
| t4 | db | webhook_path_token tem unique global | `insert` duplicado retorna 23505 |
| t5 | unit | signState/verifyState round-trip | vitest: sign então verify retorna mesmo payload |
| t6 | unit | verifyState rejeita expired | vitest com clock fake +11min |
| t7 | api | Server Action redirect c/ state | Playwright: click botão temp, intercept response, decode state |
| t8 | rls | Cross-tenant isolation tenant_integrations | DB query como user de B vê 0 rows quando A tem 1 |
| t9 | crypto | Tokens não vazam em logs | grep nos logs de qa após inserção, não acha o plaintext |

#### Architecture contracts emitted

```yaml
exposes:
  - type: db_table
    id: "tenant_integrations"
    schema: "Spec 06 §3.1"
  - type: db_table
    id: "orders"
    schema: "Spec 06 §3.2"
  - type: db_table
    id: "nuvemshop_products"
    schema: "Spec 06 §3.3"
  - type: db_table
    id: "sync_progress"
    schema: "Spec 06 §6.4"
  - type: server_action
    id: "connectNuvemshop"
    file: "app/(app)/integrations/nuvemshop/_actions.ts"
    behavior: "redirect to Nuvemshop authorize URL with HMAC state"
  - type: lib
    id: "oauth/state"
    api: "signState(payload), verifyState(token)"
```

#### Decisões a registrar

- Server Action é caminho default (R-05 confirmado nesta wave); rota REST fica como fallback em S-07.02 só pro callback (start REST não será implementado neste epic — entra como tech debt se demanda surgir)
- Chave `app.nuvemshop_oauth_key` injetada via `ALTER DATABASE` em provisioning manual; documentado em README de deploy

#### Definition of Done

- [ ] Todos os ACs passam
- [ ] Typecheck zero erros novos
- [ ] Lint zero erros novos
- [ ] Migration 0008 documentada em MANIFEST
- [ ] Commit `feat(EPIC-07): migration 0008 + connectNuvemshop server action [wave 1]`
- [ ] Architecture contracts registrados em state file

---

### S-07.02 — OAuth callback handler

**Points**: 4 | **Priority**: P0 | **Deps**: S-07.01 | **FR refs**: Spec 06 §4.3, §4.6; Business rules: L-09, R-W

#### Contexto

Receber `?code=...&state=...`, verificar HMAC do state (anti-CSRF), trocar code por tokens via `POST /apps/authorize/token` da Nuvemshop, persistir encrypted (UPSERT por `unique(org, provider)`), e enfileirar job `nuvemshop.post_connect` que registra os 8 webhook subscriptions e dispara health check + initial sync. Retorna redirect `/app/integrations/nuvemshop?ok=1` em sucesso ou `?error=...` em falha (audit log antes do redirect em qualquer caso).

8 webhooks registrados (mesmo nesta wave): 5 operacionais + 3 LGPD. Os receivers LGPD ficam stubs de 200 nesta wave (EPIC-08 implementa a lógica). A Nuvemshop precisa que estejam registrados antes do go-live LGPD.

#### Files to create

- `app/api/v1/integrations/nuvemshop/callback/route.ts` — handler GET
- `lib/nuvemshop/post-connect.ts` — worker `postConnect({integrationId})` (consumido por QStash)
- `app/api/v1/workers/nuvemshop/post-connect/route.ts` — endpoint QStash que invoca `postConnect`

#### Files to modify

- `lib/audit/index.ts` — adicionar event types `integration.oauth_failed`, `integration.connected`

#### Implementation steps (sequential)

1. Implementar GET callback per Spec 06 §4.3: parse code+state, `verifyState`, `fetch` token endpoint, parse body
2. UPSERT em `tenant_integrations` usando `fn_encrypt_oauth(body.access_token)` + refresh + scopes + `expires_at` calculado de `expires_in`
3. Gerar `webhook_secret` random, encriptar e salvar
4. Audit log `integration.connected`
5. Enqueue QStash job pra `postConnect` (passa `integrationId`)
6. Implementar `postConnect`: load context, healthCheck (delegado pro adapter — implementado em S-07.04, mas neste wave podemos stub o adapter com call HTTP direta a `/store`), `subscribeWebhooks` pra 8 eventos
7. Update `tenant_integrations.status='healthy'` + `webhook_subscriptions` jsonb + `store_metadata`
8. Stubs: `app/api/v1/webhooks/nuvemshop/customer-redact/route.ts`, `customer-data-request`, `store-redact` retornando 200 com TODO comment apontando pra EPIC-08

#### Acceptance Criteria

```gherkin
Given state token válido e code Nuvemshop válido (mocked sandbox)
When chega GET /api/v1/integrations/nuvemshop/callback
Then row em tenant_integrations criada com status='connecting'
And tokens estão encrypted (bytea, não plaintext)
And QStash recebeu job nuvemshop.post_connect
And response é redirect 302 pra /app/integrations/nuvemshop?ok=1
```

```gherkin
Given state token expirado (>10min)
When chega GET /callback
Then response é 400 com error 'invalid_state'
And nenhuma row criada em tenant_integrations
And audit log integration.oauth_failed registrado
```

```gherkin
Given postConnect roda com sucesso
When inspeciono tenant_integrations
Then status='healthy', webhook_subscriptions tem 8 entries (8 events), store_metadata populated
```

```gherkin
Given mesma org reconecta (já tem row)
When callback processa
Then UPSERT atualiza tokens existentes (não cria duplicata)
And status volta pra 'connecting' antes do post_connect rodar
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | Callback c/ state inválido | curl com state forjado → 400 |
| t2 | api | Callback c/ code inválido | mock Nuvemshop retorna 401 → audit + redirect ?error=token_exchange |
| t3 | db | Tokens encrypted at rest | `SELECT octet_length(oauth_access_token_encrypted)` > 0, `SELECT pg_typeof()` é bytea |
| t4 | api | Reconexão idempotente | 2x callback → 1 row, tokens atualizados |
| t5 | worker | postConnect registra 8 webhooks | mock Nuvemshop API, verifica 8 chamadas POST /webhooks |
| t6 | api | LGPD stubs respondem 200 | curl POST /webhooks/nuvemshop/customer-redact?t=x → 200 |
| t7 | rls | tenant_integrations só visível pelo dono | cross-org SELECT retorna 0 |

#### Architecture contracts emitted

```yaml
exposes:
  - type: api_route
    id: "GET /api/v1/integrations/nuvemshop/callback"
    behavior: "OAuth code exchange + persist + enqueue post_connect"
  - type: worker
    id: "nuvemshop.post_connect"
    queue: "qstash"
    payload_schema: "{ integrationId: string }"
  - type: api_route_stub
    id: "POST /api/v1/webhooks/nuvemshop/{customer-redact,customer-data-request,store-redact}"
    note: "Stub 200 — implementação real em EPIC-08"
```

#### Definition of Done

- [ ] Todos os ACs passam
- [ ] OAuth flow E2E funciona em dev com app sandbox da Nuvemshop
- [ ] Commit `feat(EPIC-07): oauth callback + post-connect job [wave 2]`

---

### S-07.03 — Cron worker `oauth-refresh`

**Points**: 2 | **Priority**: P0 | **Deps**: S-07.02 | **FR refs**: Spec 06 §4.7

#### Contexto

Vercel Cron `*/15 * * * *` chama `/api/v1/cron/nuvemshop/oauth-refresh`. Varre `tenant_integrations where provider='nuvemshop' and status='healthy' and expires_at < now() + interval '24 hours'` (escopo desta story usa 24h, não 30min como na Spec — janela mais segura porque Nuvemshop OAuth refresh ainda é raro no MVP). Pra cada row: refresh via wrapper Nuvemshop, persist new tokens encrypted, audit. Falha marca `status='token_expired'` e dispara notificação ao admin.

#### Files to create

- `app/api/v1/cron/nuvemshop/oauth-refresh/route.ts` — endpoint cron
- `lib/nuvemshop/refresh.ts` — função `refreshExpiringTokens()`
- `vercel.json` (modify ou create) — adicionar cron entry

#### Files to modify

- `vercel.json` — `crons: [{ path: '/api/v1/cron/nuvemshop/oauth-refresh', schedule: '*/15 * * * *' }]`

#### Implementation steps (sequential)

1. Implementar `refreshExpiringTokens()` per Spec 06 §4.7
2. Endpoint cron valida `Authorization: Bearer ${CRON_SECRET}`
3. Pra cada row expiring: chamar `POST /apps/authorize/token` com `grant_type=refresh_token` (wrapper direto; adapter completo vem em S-07.04)
4. UPSERT tokens novos via `fn_encrypt_oauth`
5. Em caso de erro: mark `status='token_expired'`, audit `integration.token_refresh_failed`, notify admin via `notifications` table

#### Acceptance Criteria

```gherkin
Given integration com expires_at em 2 horas
When cron roda
Then tokens são renovados, expires_at é novo, status permanece 'healthy'
And audit log integration.token_refreshed registrado
```

```gherkin
Given Nuvemshop retorna 401 no refresh (refresh token revogado)
When cron processa
Then status='token_expired', notification criada pro admin do tenant
```

```gherkin
Given integration com expires_at em 48h
When cron roda
Then row não é tocada (fora da janela de 24h)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | cron | Endpoint requer Bearer secret | curl sem header → 401 |
| t2 | worker | Refresh sucesso atualiza expires_at | seed row + mock Nuvemshop ok → row atualizada |
| t3 | worker | Refresh falha marca expired | mock Nuvemshop 401 → status=token_expired |
| t4 | worker | Janela de 24h respeitada | seed row +48h → não tocada |
| t5 | rls | Cron usa service_role bypass | service_role SELECT vê todas as orgs |

#### Architecture contracts emitted

```yaml
exposes:
  - type: cron
    id: "nuvemshop-oauth-refresh"
    schedule: "*/15 * * * *"
    path: "/api/v1/cron/nuvemshop/oauth-refresh"
```

#### Definition of Done

- [ ] ACs passam
- [ ] Vercel cron configurado em vercel.json
- [ ] Commit `feat(EPIC-07): oauth-refresh cron worker [wave 3]`

---

### S-07.04 — `EcommercePlatformAdapter` interface + `NuvemshopAdapter` impl

**Points**: 5 | **Priority**: P0 | **Deps**: S-07.03 | **FR refs**: Spec 06 §2.1, §2.3, §2.4

#### Contexto

Refatora as chamadas HTTP ad-hoc das waves 2-3 pra usar a abstração canônica. Interface `EcommercePlatformAdapter` (Spec 06 §2.1) com 9 métodos. Impl `NuvemshopAdapter` (§2.3) com `request<T>()` privado que normaliza erros via `AdapterError` (`platform_token_expired` | `platform_scope_missing` | `platform_rate_limited` | `platform_not_found` | `platform_validation` | `platform_upstream_5xx` | `platform_network`). Mappers `mapOrder`/`mapCustomer`/`mapProduct` em arquivos separados.

`redactCustomer` e `exportCustomerData` aqui só fazem o **callback à Nuvemshop**; o cascade interno (LGPD) é responsabilidade dos workers do EPIC-08. Adapter expõe primitives.

#### Files to create

- `lib/ecommerce/types.ts` — Interface + tipos `NormalizedOrder`/`NormalizedCustomer`/`NormalizedProduct`/`AdapterContext`/`FetchPage<T>`/`AdapterError`
- `lib/ecommerce/factory.ts` — `getAdapter(provider)` + `loadContext(integrationId)` (com `fn_decrypt_oauth`)
- `lib/nuvemshop/adapter.ts` — class `NuvemshopAdapter implements EcommercePlatformAdapter`
- `lib/nuvemshop/mappers.ts` — `mapOrder`, `mapCustomer`, `mapProduct` (raw Nuvemshop → Normalized)

#### Files to modify

- `lib/nuvemshop/post-connect.ts` (S-07.02) — substituir chamada HTTP direta por `getAdapter('nuvemshop').healthCheck()` + `subscribeWebhooks()`
- `lib/nuvemshop/refresh.ts` (S-07.03) — usar `adapter.refreshAccessToken()`

#### Implementation steps (sequential)

1. Definir tipos em `lib/ecommerce/types.ts` (copy literal da Spec 06 §2.1)
2. Implementar `AdapterError` class
3. Implementar `NuvemshopAdapter` per §2.3 com todos os 9 métodos
4. Implementar mappers
5. Implementar `factory.ts` com `loadContext` que faz `SELECT` em `tenant_integrations` + `fn_decrypt_oauth`
6. Refatorar S-07.02 e S-07.03 pra consumir adapter
7. Verificar regressão: re-rodar testes das waves 2-3

#### Acceptance Criteria

```gherkin
Given adapter inicializado
When chamo healthCheck com credentials válidas
Then retorna { ok: true, storeMetadata: { storeId, storeName, planName } }
```

```gherkin
Given Nuvemshop API retorna 401
When adapter faz request
Then throw AdapterError com code='platform_token_expired' e retryable=true
```

```gherkin
Given Nuvemshop retorna 429 com Retry-After: 30
When adapter faz request
Then AdapterError com code='platform_rate_limited' e retryAfterSeconds=30
```

```gherkin
Given fetchOrders com pageSize=50
When 50 items retornam
Then nextCursor é '2', rateLimit.remaining preenchido do header
```

```gherkin
Given subscribeWebhooks([8 events])
When chamado
Then 8 POST /webhooks executados com Idempotency-Key único por event
And retorna 8 WebhookSubscriptionResult com externalSubscriptionId
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | unit | AdapterError mapping de status codes | vitest tabela parametrizada |
| t2 | unit | mapOrder converte raw → normalized | fixture JSON Nuvemshop → assert shape |
| t3 | unit | loadContext decrypta tokens | seed row + chamada → ctx.credentials.accessToken plaintext |
| t4 | integ | healthCheck contra mock Nuvemshop | nock/msw simula /store → assert |
| t5 | integ | subscribeWebhooks idempotente | duplo call mesmo event → 1 sub no upstream |
| t6 | regression | post-connect ainda funciona | rerun S-07.02 t5 |
| t7 | regression | oauth-refresh ainda funciona | rerun S-07.03 t2 |

#### Architecture contracts emitted

```yaml
exposes:
  - type: ts_interface
    id: "EcommercePlatformAdapter"
    file: "lib/ecommerce/types.ts"
  - type: ts_class
    id: "NuvemshopAdapter"
    file: "lib/nuvemshop/adapter.ts"
  - type: factory
    id: "getAdapter, loadContext"
    file: "lib/ecommerce/factory.ts"
```

#### Decisões a registrar

- Adapter é stateless; estado vive em `tenant_integrations` + `webhook_events_log` + `orders` + `event_log` (princípio §1.3.1 da Spec 06)
- Caller decryptografa tokens via `loadContext` antes de chamar adapter; adapter nunca toca DB

#### Definition of Done

- [ ] ACs passam
- [ ] Regression das waves 1-3 passa
- [ ] Commit `feat(EPIC-07): EcommercePlatformAdapter + NuvemshopAdapter [wave 4]`

---

### S-07.05 — Middleware canônico `processWebhook`

**Points**: 4 | **Priority**: P0 | **Deps**: S-07.04 | **FR refs**: Spec 06 §5.0; Business rules: T-02, R-W

#### Contexto

Middleware reusável pelos 8 receivers. Cumpre pipeline canônico: (1) resolver tenant via `webhook_path_token` da query string `?t=`, (2) ler raw body **antes** de qualquer parse JSON, (3) HMAC SHA-256 base64 timing-safe equal contra `webhook_secret_encrypted` decryptado, (4) skew check ±5min via header `x-nuvemshop-event-ts`, (5) log raw em `webhook_events_log` (sempre, mesmo HMAC inválido — auditoria), (6) idempotência via `unique(organization_id, provider, external_event_id)` retorna 200 no-op em conflito, (7) `emitEvent('nuvemshop.<event>')` pro `event_log`, (8) retorna 200 em <300ms p95.

Crítico: rejeitar 401 antes de processar payload se HMAC inválido, **mas** o log mínimo (com `valid_signature=false`) sempre é gravado.

#### Files to create

- `lib/nuvemshop/webhook-handler.ts` — `processWebhook(req, expectedEvent)`
- `lib/nuvemshop/sanitize.ts` — `sanitizeHeaders(h)`, `sanitizePayload(p)` (remove tokens/secrets)
- `lib/crypto/timing-safe.ts` — wrapper `timingSafeEqual(a, b)` (se ainda não existe)

#### Implementation steps (sequential)

1. Implementar `processWebhook` per Spec 06 §5.0
2. Resolução de tenant: `SELECT id, organization_id, webhook_secret_encrypted FROM tenant_integrations WHERE webhook_path_token = $1`
3. HMAC: `crypto.createHmac('sha256', secret).update(rawBody).digest('base64')` + `timingSafeEqual` contra header `x-linkedstore-hmac-sha256`
4. Skew: parse `x-nuvemshop-event-ts` (epoch ms), reject se `|now - ts| > 5min`
5. Log raw: insert em `webhook_events_log` com `payload_raw_hash = sha256(rawBody)`, `valid_signature`, `is_lgpd = event_type IN ('customer/redact','customer/data_request','store/redact')`
6. Idempotência: `ON CONFLICT (organization_id, provider, external_event_id) DO NOTHING RETURNING id`. Se `null`, retornar 200 idempotent
7. `emitEvent` em `event_log` pro worker downstream
8. Return 200

#### Acceptance Criteria

```gherkin
Given webhook com HMAC válido + body válido
When chega no receiver
Then response 200 em <300ms
And row criada em webhook_events_log com valid_signature=true, status='received'
And event nuvemshop.<event> emitido em event_log
```

```gherkin
Given webhook com HMAC inválido
When chega
Then response 401
And row em webhook_events_log com valid_signature=false, status='failed'
And NENHUM event emitido em event_log
```

```gherkin
Given mesmo external_event_id chega 2x
When segundo arriva
Then primeiro processa normalmente, segundo retorna 200 com {idempotent: true}
And só 1 row em webhook_events_log
And só 1 event emitido em event_log
```

```gherkin
Given header x-nuvemshop-event-ts é -10min do now
When chega
Then response 401 com error 'webhook_timestamp_skew'
```

```gherkin
Given path token desconhecido
When chega
Then response 401 'unknown_token' sem revelar nada do tenant
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | HMAC válido → 200 + log + event | curl com hmac correto, assert DB |
| t2 | api | HMAC inválido → 401 + log com valid_signature=false | curl com hmac fake |
| t3 | api | Idempotência | 2x mesma payload → 1 row |
| t4 | api | Skew rejeita | header ts antigo → 401 |
| t5 | api | Token desconhecido | ?t=fake → 401 |
| t6 | perf | p95 <300ms | autocannon 100 req em série |
| t7 | security | Raw body lido antes de json | log do sha256 do raw matcha o body |

#### Architecture contracts emitted

```yaml
exposes:
  - type: middleware
    id: "processWebhook"
    file: "lib/nuvemshop/webhook-handler.ts"
    signature: "(req: NextRequest, expectedEvent: string) => Promise<NextResponse>"
    behavior: "HMAC + skew + log raw + idempotência + emit event"
```

#### Definition of Done

- [ ] ACs passam
- [ ] Smoke test contra app sandbox real Nuvemshop
- [ ] Commit `feat(EPIC-07): processWebhook canonical middleware [wave 5]`

---

### S-07.06 — Webhook handler `order/created`

**Points**: 4 | **Priority**: P0 | **Deps**: S-07.05, EPIC-04 (pipeline Pedidos), EPIC-05 (resolveContact) | **FR refs**: Spec 06 §5.1; Business rules: T-05

#### Contexto

Receiver `POST /api/v1/webhooks/nuvemshop/order-created` chama `processWebhook(req, 'order/created')`. Worker consumidor de `nuvemshop.order_created` (QStash): (1) `mapOrder` raw → normalized, (2) se tem `customer`, `resolveContact` por `email|phoneE164|cpf` — `matched`/`created`/`conflict` (conflict enfileira `merge_queue` mas attacha ao `bestCandidateId`), (3) UPSERT em `orders` (idempotente via unique constraint), (4) insert em `crm_leads` na pipeline "Pedidos" stage "Aguardando pagamento" via `resolveStage(orgId, 'pedidos', 'aguardando_pagamento')`, (5) insert em `crm_lead_links target_kind='order'`, (6) insert em `crm_lead_activities type='nuvemshop_order_created'`, (7) marca `webhook_events_log.status='processed'`.

#### Files to create

- `app/api/v1/webhooks/nuvemshop/order-created/route.ts` — receiver
- `app/api/v1/workers/nuvemshop/order-created/route.ts` — QStash worker endpoint
- `lib/nuvemshop/handlers/order-created.ts` — `handleOrderCreated(ev)` (lógica core, testável)
- `lib/pipelines/resolve-stage.ts` — helper `resolveStage(orgId, pipelineSlug, stageSlug)` se ainda não existe (EPIC-04 deveria ter exposto; verificar)

#### Files to modify

- `lib/event-bus/index.ts` — wire dispatch de `nuvemshop.order_created` pro worker

#### Implementation steps (sequential)

1. Receiver chama `processWebhook(req, 'order/created')`
2. Worker recebe job (assinatura QStash validada)
3. `handleOrderCreated` per Spec 06 §5.1
4. UPSERT `orders` com `ON CONFLICT (organization_id, external_provider, external_id) DO UPDATE` preservando `contact_id` se já existia
5. Insert `crm_leads` (idempotência aqui é por checagem prévia: se já existe lead linkado a esse order, skip)
6. Insert `crm_lead_links ON CONFLICT DO NOTHING`
7. Insert activity (aqui idempotência via dedup pelo `external_event_id` no payload da activity)
8. Update `webhook_events_log status='processed', processed_at=now()`

#### Acceptance Criteria

```gherkin
Given webhook order/created com customer email = "alice@x.com" novo
When worker processa
Then contact criado, order persistido, lead criado em pipeline 'Pedidos' stage 'Aguardando pagamento'
And crm_lead_links com target_kind='order' linkando lead → order
And activity 'nuvemshop_order_created' criada
```

```gherkin
Given customer email já existe em contacts
When order/created processa
Then resolveContact retorna 'matched', order linka ao contact existente, lead novo criado
```

```gherkin
Given resolveContact retorna 'conflict' (2 candidatos)
When worker processa
Then merge_queue recebe item, lead linka ao bestCandidate, processamento continua sem bloquear
```

```gherkin
Given mesmo external_event_id chega 2x
When ambos processam
Then só 1 order, 1 lead, 1 activity (idempotência)
```

```gherkin
Given order/created sem customer
When worker processa
Then order persistido com contact_id=null, lead criado com contact_id=null, sem activity de contact
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | e2e | Webhook real → card no Kanban | dispara webhook fake, abre /app/pipelines/pedidos, vê card |
| t2 | db | Order UPSERT idempotente | rodar handler 2x → 1 row |
| t3 | db | Lead em stage correto | SELECT stage_id, comparar com seed T-05 |
| t4 | unit | resolveContact conflict path | mock retorna conflict → assert merge_queue insert |
| t5 | rls | Lead/order isolados por tenant | cross-org SELECT → 0 |
| t6 | regression | processWebhook ainda funciona | rerun S-07.05 t1 |

#### Architecture contracts emitted

```yaml
exposes:
  - type: api_route
    id: "POST /api/v1/webhooks/nuvemshop/order-created"
  - type: domain_event
    id: "nuvemshop.order_created"
    payload: "{ integrationId, webhookLogId, externalEventId, data }"
  - type: worker_handler
    id: "handleOrderCreated"
    file: "lib/nuvemshop/handlers/order-created.ts"
```

#### Definition of Done

- [ ] ACs passam, incluindo E2E Playwright ver card aparecer no Kanban
- [ ] Commit `feat(EPIC-07): order-created webhook handler [wave 6]`

---

### S-07.07 — Webhook handler `order/paid`

**Points**: 3 | **Priority**: P0 | **Deps**: S-07.06 | **FR refs**: Spec 06 §5.2

#### Contexto

Move o lead pra stage "Pago" do pipeline "Pedidos". Atualiza `orders.status='paid'`. Se lead não existe ainda (race com `order/created` ou tenant conectou meio do dia), cria-o (mesmo código de S-07.06 mas com stage diferente). Idempotência pelo external_event_id.

#### Files to create

- `app/api/v1/webhooks/nuvemshop/order-paid/route.ts`
- `app/api/v1/workers/nuvemshop/order-paid/route.ts`
- `lib/nuvemshop/handlers/order-paid.ts`
- `lib/pipelines/move-lead.ts` — `moveLeadToStage(leadId, stageSlug)` se ainda não existe (EPIC-04 deveria expor)

#### Implementation steps (sequential)

1. Receiver canônico
2. Worker: tenta achar lead por `crm_lead_links` join `orders.external_id`. Se acha → move pra stage "Pago" via `moveLeadToStage` + activity. Se não → fallback chama `handleOrderCreated` com stage "Pago" diretamente
3. Update `orders.status='paid'` + payload snapshot

#### Acceptance Criteria

```gherkin
Given lead já existe em stage 'Aguardando pagamento'
When order/paid chega
Then lead move pra stage 'Pago'
And orders.status='paid'
And activity 'nuvemshop_order_paid' adicionada
```

```gherkin
Given order/paid chega sem order/created prévio (race ou backfill)
When worker processa
Then order é criado, lead é criado direto em stage 'Pago'
```

```gherkin
Given mesmo evento processa 2x
When idempotência kicks in
Then status final consistente, sem duplicate activities
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | e2e | order/created seguido de order/paid | sequência de webhooks → card move stage |
| t2 | e2e | order/paid sozinho | backfill → card aparece direto em Pago |
| t3 | regression | order/created ainda funciona | rerun S-07.06 t1 |

#### Architecture contracts emitted

```yaml
exposes:
  - type: domain_event
    id: "nuvemshop.order_paid"
  - type: api_route
    id: "POST /api/v1/webhooks/nuvemshop/order-paid"
```

#### Definition of Done

- [ ] ACs passam
- [ ] Commit `feat(EPIC-07): order-paid webhook handler [wave 7]`

---

### S-07.08 — Webhook handler `order/cancelled`

**Points**: 3 | **Priority**: P0 | **Deps**: S-07.07 | **FR refs**: Spec 06 §5.3; Business rules: P-03 (lost_reason required)

#### Contexto

Cancela lead: `crm_leads.status='lost'` + `lost_reason` mapeado a partir de `payload.cancel_reason`. Mapeamento (helper `mapCancellationReason`): `customer` → `cancelled_by_customer`, `fraud`/`inventory`/`other`/null → `cancelled_by_store`. Move pra stage "Cancelado" (mas a stage final é configurável; default cobre P-03 sem violação porque `lost_reason` está sempre presente). Activity `nuvemshop_order_cancelled` com `{ lost_reason }`.

#### Files to create

- `app/api/v1/webhooks/nuvemshop/order-cancelled/route.ts`
- `app/api/v1/workers/nuvemshop/order-cancelled/route.ts`
- `lib/nuvemshop/handlers/order-cancelled.ts`
- `lib/nuvemshop/cancellation-mapping.ts` — `mapCancellationReason(raw): 'cancelled_by_customer'|'cancelled_by_store'`

#### Implementation steps (sequential)

1. Receiver + worker per padrão
2. `handleOrderCancelled` per Spec 06 §5.3
3. Update `orders.status='cancelled'`
4. Find lead, move pra stage "Cancelado", `update crm_leads set status='lost', lost_reason=$mapped`
5. Insert activity

#### Acceptance Criteria

```gherkin
Given order com cancel_reason='customer'
When webhook processa
Then crm_leads.lost_reason='cancelled_by_customer', status='lost'
```

```gherkin
Given order com cancel_reason='fraud'
When webhook processa
Then crm_leads.lost_reason='cancelled_by_store'
```

```gherkin
Given order com cancel_reason null/desconhecido
When webhook processa
Then crm_leads.lost_reason='cancelled_by_store' (default)
```

```gherkin
Given lead não existe ainda
When order/cancelled chega
Then nenhum lead criado, order persistido com status='cancelled', warning logado
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | unit | mapCancellationReason todas as variantes | tabela parametrizada |
| t2 | e2e | Card desaparece do Kanban (status=lost) | webhook → assert UI |
| t3 | db | lost_reason válido (P-03) | constraint check passa |

#### Architecture contracts emitted

```yaml
exposes:
  - type: domain_event
    id: "nuvemshop.order_cancelled"
  - type: api_route
    id: "POST /api/v1/webhooks/nuvemshop/order-cancelled"
```

#### Definition of Done

- [ ] ACs passam
- [ ] Commit `feat(EPIC-07): order-cancelled webhook handler [wave 8]`

---

### S-07.09 — Webhook handlers `order/fulfilled` + `cart/abandoned`

**Points**: 3 | **Priority**: P0 | **Deps**: S-07.08 | **FR refs**: Spec 06 §5.4, §5.5

#### Contexto

**`order/fulfilled`**: lê `payload.fulfillment_status` ou `shipping_status`. Mapeamento default → stage CRM:

| Nuvemshop | Stage |
|---|---|
| packed | "Em separação" |
| shipped | "Enviado" |
| delivered | "Entregue" |

Atualiza `orders.fulfillment_status` + `orders.tracking_code`. Move lead. Activity `nuvemshop_order_fulfilled` com `fulfillment_status` no payload.

**`cart/abandoned`**: cria lead em stage "Carrinho abandonado" (pipeline "Pedidos") **sem** criar row em `orders` (carrinho ≠ pedido). Activity `nuvemshop_cart_abandoned` com snapshot do carrinho (`{ items, estimated_value_cents }`). Identity resolution igual a `order/created`. Stage mapping configurável também (mas default vem do seed T-05).

#### Files to create

- `app/api/v1/webhooks/nuvemshop/order-fulfilled/route.ts`
- `app/api/v1/workers/nuvemshop/order-fulfilled/route.ts`
- `lib/nuvemshop/handlers/order-fulfilled.ts`
- `app/api/v1/webhooks/nuvemshop/cart-abandoned/route.ts`
- `app/api/v1/workers/nuvemshop/cart-abandoned/route.ts`
- `lib/nuvemshop/handlers/cart-abandoned.ts`
- `lib/nuvemshop/fulfillment-mapping.ts` — mapping fulfillment_status → stage_slug

#### Implementation steps (sequential)

1. Receivers + workers + handlers per padrão
2. `order/fulfilled` lookup mapping em `tenant_integrations.store_metadata.stage_mapping` (override) com fallback no default
3. `cart/abandoned` reusa `resolveContact` mas pula UPSERT em `orders`
4. Activity payload pra cart inclui valor estimado (sum de items)

#### Acceptance Criteria

```gherkin
Given order/fulfilled com fulfillment_status='shipped' + tracking_code
When worker processa
Then orders.fulfillment_status='shipped', tracking_code persistido
And lead move pra stage 'Enviado'
And activity nuvemshop_order_fulfilled com fulfillment_status='shipped'
```

```gherkin
Given tenant tem store_metadata.stage_mapping override pra 'shipped' → 'Stage Custom'
When worker processa
Then lead move pra 'Stage Custom' em vez do default
```

```gherkin
Given cart/abandoned com 3 items
When worker processa
Then lead criado em stage 'Carrinho abandonado'
And activity nuvemshop_cart_abandoned com payload.items.length === 3
And nenhuma row em orders
```

```gherkin
Given cart/abandoned para email já existente
When processa
Then contact reusado, lead novo
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | e2e | order/fulfilled move card | sequência de webhooks → assert UI |
| t2 | e2e | cart/abandoned cria card sem order | webhook → SELECT orders WHERE customer = 0 |
| t3 | unit | stage_mapping override funciona | seed override + worker run |
| t4 | db | tracking_code persiste | SELECT orders.tracking_code |

#### Architecture contracts emitted

```yaml
exposes:
  - type: domain_event
    id: "nuvemshop.order_fulfilled"
  - type: domain_event
    id: "nuvemshop.cart_abandoned"
  - type: api_route
    id: "POST /api/v1/webhooks/nuvemshop/order-fulfilled"
  - type: api_route
    id: "POST /api/v1/webhooks/nuvemshop/cart-abandoned"
```

#### Definition of Done

- [ ] ACs passam
- [ ] 5 webhooks operacionais funcionais ponta-a-ponta
- [ ] Commit `feat(EPIC-07): order-fulfilled + cart-abandoned handlers [wave 9]`

---

### S-07.10 — Sync workers iniciais (products/customers/orders) + re-sync API

**Points**: 4 | **Priority**: P0 | **Deps**: S-07.09 | **FR refs**: Spec 06 §6.1, §6.2, §6.3, §6.4, §6.5; Business rules: B-05

#### Contexto

3 workers QStash + 1 API endpoint. Cada worker: paginação cursor, observa `X-Rate-Limit-Remaining` (sleep `Retry-After` quando <5 remaining), atualiza `sync_progress` por batch (UI lê pra ETA). `syncProducts` força `rag_indexed_at=null` em UPDATE pra forçar re-indexação no EPIC-06. `syncCustomers` chama `resolveContact` por item; conflict → `enqueueMergeReview` mas continua (não bloqueia). `syncOrders` filtra `since = now() - 90d` por default; cada item passa por `applyOrderUpsert` (mesma função de `handleOrderCreated` mas sem criar lead retroativo — checa se já existe lead linkado e skip pra não poluir o pipeline com pedidos antigos finalizados).

`POST /api/v1/integrations/nuvemshop/resync` body `{ mode: 'all'|'customers'|'products'|'last_7d_orders' }`. Apenas role admin. Enqueua jobs.

#### Files to create

- `lib/nuvemshop/sync/products.ts` — `syncProducts(integrationId)`
- `lib/nuvemshop/sync/customers.ts` — `syncCustomers(integrationId)`
- `lib/nuvemshop/sync/orders.ts` — `syncOrders(integrationId, sinceDays=90)`
- `lib/nuvemshop/sync/apply-order-upsert.ts` — função compartilhada com S-07.06 (refatora extração)
- `app/api/v1/workers/nuvemshop/sync-products/route.ts`
- `app/api/v1/workers/nuvemshop/sync-customers/route.ts`
- `app/api/v1/workers/nuvemshop/sync-orders/route.ts`
- `app/api/v1/integrations/nuvemshop/resync/route.ts` — POST API

#### Files to modify

- `lib/nuvemshop/post-connect.ts` — após registrar webhooks, enfileirar `nuvemshop.sync_initial` que dispara os 3 syncs sequencialmente

#### Implementation steps (sequential)

1. Implementar `syncProducts` per Spec 06 §6.1 (UPSERT em batches, rate limit handling)
2. Implementar `syncCustomers` per §6.2 (identity resolution + merge_queue + `contact_external_ids` mapping)
3. Implementar `syncOrders` per §6.3 (idempotente, sem activity retroativa)
4. Implementar `sync_progress` updates a cada N items (default 25)
5. API resync: validate role admin, switch case por mode, enqueue
6. Wire post-connect → sync inicial automático

#### Acceptance Criteria

```gherkin
Given tenant conecta loja Nuvemshop
When post-connect job completa
Then 3 sync jobs enfileirados (products, customers, orders 90d)
And sync_progress mostra status=running pra cada domain
```

```gherkin
Given Nuvemshop retorna X-Rate-Limit-Remaining: 2
When worker continua
Then worker sleep por Retry-After segundos antes do próximo request
```

```gherkin
Given syncCustomers encontra conflito de identity
When worker processa
Then merge_queue recebe item, sync continua sem abortar
And contact_external_ids tem mapping (provider='nuvemshop', external_id=X) → contact_id
```

```gherkin
Given POST /resync body={mode:'last_7d_orders'} role=admin
When request chega
Then 202 Accepted, syncOrders enqueued com sinceDays=7
```

```gherkin
Given POST /resync com role=agent
When request chega
Then 403 forbidden_role
```

```gherkin
Given syncProducts roda e re-roda
When inspeciono nuvemshop_products
Then UPSERT funcionou, rag_indexed_at=null pra produtos atualizados
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | worker | syncProducts paginação | mock 250 items em 5 pages → 250 rows |
| t2 | worker | rate limit respeitado | mock retorna remaining=2 + Retry-After=10 → assert sleep |
| t3 | worker | syncCustomers conflict não aborta | seed 2 contacts mesmo email → run → merge_queue tem item, sync completa |
| t4 | worker | syncOrders idempotente | run 2x → mesmo número de orders |
| t5 | api | /resync valida role | curl com agent → 403 |
| t6 | api | /resync 4 modes | tabela parametrizada de modes |
| t7 | db | sync_progress atualiza | SELECT items_synced cresce durante run |
| t8 | regression | webhooks ainda funcionam | rerun S-07.06..09 |

#### Architecture contracts emitted

```yaml
exposes:
  - type: worker
    id: "nuvemshop.sync_products"
  - type: worker
    id: "nuvemshop.sync_customers"
  - type: worker
    id: "nuvemshop.sync_orders"
  - type: api_route
    id: "POST /api/v1/integrations/nuvemshop/resync"
    request: "{ mode: 'all'|'customers'|'products'|'last_7d_orders' }"
    response: "202 Accepted | 403 forbidden_role"
```

#### Definition of Done

- [ ] ACs passam
- [ ] Sync inicial dispara automaticamente após connect
- [ ] Commit `feat(EPIC-07): sync workers + resync api [wave 10]`

---

### S-07.11 — Página `/app/integrations/nuvemshop`

**Points**: 4 | **Priority**: P0 | **Deps**: S-07.10 | **FR refs**: Spec 06 §3.10 (PRD); todas as anteriores

#### Contexto

UI admin: status de conexão (badge `healthy`/`token_expired`/`error`/`disconnected`), botão "Conectar"/"Reconectar" (Server Action `connectNuvemshop`), botão "Desconectar" (Server Action que chama `unsubscribeWebhooks` + delete row), seção re-sync com 4 botões (`all`/`customers`/`products`/`last_7d_orders`), tabela dos 50 últimos webhooks (`webhook_events_log`) com filtro por event_type, editor de stage_mapping (form que persiste em `tenant_integrations.store_metadata.stage_mapping`).

Realtime opcional: subscribe em `tenant-integrations-{org_id}` pra atualizar o badge ao vivo quando `status` muda (ex: cron refresh marca expired).

#### Files to create

- `app/(app)/integrations/nuvemshop/page.tsx` — server component com data fetching
- `app/(app)/integrations/nuvemshop/_components/ConnectionStatus.tsx`
- `app/(app)/integrations/nuvemshop/_components/ResyncPanel.tsx`
- `app/(app)/integrations/nuvemshop/_components/WebhookLog.tsx`
- `app/(app)/integrations/nuvemshop/_components/StageMappingEditor.tsx`
- `app/(app)/integrations/nuvemshop/_actions.ts` (modify de S-07.01) — adicionar `disconnectNuvemshop()`, `updateStageMapping(mapping)`, `triggerResync(mode)`
- `hooks/useNuvemshopIntegration.ts` — TanStack Query hook + realtime channel

#### Implementation steps (sequential)

1. Page server-side carrega `tenant_integrations` row + últimos 50 webhook logs + stage mapping atual
2. ConnectionStatus mostra badge + storeMetadata + botão conectar/desconectar
3. ResyncPanel: 4 botões → Server Action `triggerResync(mode)` → toast de sucesso
4. WebhookLog: tabela com `event_type`, `received_at`, `status`, `valid_signature`, `attempt_count`, ícone de sucesso/erro; filtro client-side
5. StageMappingEditor: form com 7 dropdowns (uma por evento) populando stages do pipeline "Pedidos" + ações (`order/created`, `order/paid`, `order/cancelled`, `order/fulfilled+packed`, `+shipped`, `+delivered`, `cart/abandoned`)
6. Realtime channel `tenant-integrations-{org_id}` re-fetch on update
7. Empty state: se nenhuma row, mostra hero "Conectar Nuvemshop" centralizado

#### Acceptance Criteria

```gherkin
Given org sem integration
When admin abre /app/integrations/nuvemshop
Then vê hero "Conectar sua loja Nuvemshop" + botão CTA
```

```gherkin
Given integration healthy
When admin abre página
Then vê badge verde "Conectado", store name, plan name, último sync, botões de re-sync e desconectar
```

```gherkin
Given admin clica "Re-sync produtos"
When request envia
Then toast "Re-sync iniciado", sync_progress atualiza em <2s via realtime
```

```gherkin
Given admin altera stage mapping de 'order/paid' → 'Stage Custom'
When salva
Then tenant_integrations.store_metadata.stage_mapping persiste
And próximo webhook order/paid usa novo mapping
```

```gherkin
Given últimos 50 webhooks recebidos
When abro WebhookLog
Then vejo tabela ordenada desc por received_at, com filtro por event_type
And clique em row mostra payload_sanitized em modal
```

```gherkin
Given role agent
When abre /app/integrations/nuvemshop
Then 403 forbidden (apenas admin/manager)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Empty state | nova org → hero visible |
| t2 | ui | Badge healthy | seed integration → badge green |
| t3 | ui | Re-sync triggers | click → assert API call + toast |
| t4 | ui | Stage mapping persiste | edit + save + reload → valor mantém |
| t5 | ui | WebhookLog tabela | seed 50 logs → 50 rows visíveis |
| t6 | rls | Admin only | agent → 403 |
| t7 | realtime | Status update ao vivo | UPDATE tenant_integrations.status → badge muda sem refresh |
| t8 | a11y | Keyboard nav | Tab através dos botões funciona |
| t9 | regression | Todos os webhooks ainda funcionam | rerun S-07.05..10 |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/app/integrations/nuvemshop"
    role_required: "admin|manager"
  - type: server_action
    id: "disconnectNuvemshop"
  - type: server_action
    id: "updateStageMapping"
  - type: server_action
    id: "triggerResync"
  - type: react_hook
    id: "useNuvemshopIntegration"
  - type: realtime_channel
    id: "tenant-integrations-{org_id}"
```

#### Definition of Done

- [ ] Todos os ACs passam em Playwright
- [ ] Typecheck + lint zero erros novos
- [ ] Sem warnings no console
- [ ] E2E: connect real → ver pedido virar card no Kanban
- [ ] Regression cumulativo passa
- [ ] Commit `feat(EPIC-07): integration UI + stage mapping editor [wave 11]`

---

## 6. Regression Suite Cumulativo (esperado ao final)

| Categoria | # de tests | Origem |
|---|---|---|
| DB schema/RLS | 12 | S-07.01 (4 tabelas × isolation+rls+indexes) |
| OAuth flow | 6 | S-07.01..03 |
| Adapter unit | 8 | S-07.04 |
| Webhook middleware | 7 | S-07.05 |
| Webhook handlers | 12 | S-07.06..09 (3 por handler médio) |
| Sync workers | 8 | S-07.10 |
| API contracts | 5 | callback, resync, 5 webhooks |
| UI rendering | 9 | S-07.11 |
| Realtime updates | 1 | S-07.11 t7 |
| E2E golden path | 3 | connect → order/created → card; order/paid → move; cart/abandoned → card |
| **Total** | **71** | |

## 7. Riscos & Mitigações específicos do epic

| Risco | Severidade | Mitigação |
|---|---|---|
| Nuvemshop API muda contrato sem aviso | Alta | Adapter pattern isola; testes de smoke contra sandbox em CI |
| Token leak em logs | Crítica | `sanitizeHeaders`/`sanitizePayload` em todos os logs; revoke de `fn_decrypt_oauth` pra anon; teste t9 da S-07.01 |
| Webhook duplicado causa lead duplicado | Alta | Idempotência via `unique(org, provider, external_event_id)` em `webhook_events_log` (S-07.05) + UPSERT em `orders` |
| Rate limit Nuvemshop bloqueia sync inicial | Média | Worker observa `X-Rate-Limit-Remaining`, sleep `Retry-After`; sync é resumível via `sync_progress.cursor` |
| Race entre `order/created` e `order/paid` | Média | `order/paid` cria lead se não existe (S-07.07 fallback) |
| Identity resolution em conflito bloqueia ingestão | Média | `merge_queue` recebe item mas processamento continua attachando ao bestCandidate (Spec 02) |
| Chave de cripto perdida = todos os tokens inutilizáveis | Crítica | Documentar processo de rotação + backup da chave em vault (fora do scope deste epic; apontar pra deploy doc) |
| Webhook secret comprometido | Alta | Rotação via UI (S-07.11 — feature opcional, default mantém); `webhook_secret_encrypted` é por integration |
| Stage "Pedidos" não existe no tenant | Alta | T-05 trigger seed garante; smoke test em S-07.06 valida |
| 8 webhooks registrados mas só 5 implementados | Média | Stubs LGPD (S-07.02) retornam 200 e logam pra evitar erro upstream; EPIC-08 substitui |

## 8. Decisões arquiteturais novas que este epic introduz

- **ADR-14**: Server Action é o caminho default de OAuth start (R-05 já registrado); REST `/connect` removido do escopo MVP
- **ADR-15**: `processWebhook` é canônico — qualquer integração futura (VTEX/Shopify/etc.) reusa o mesmo middleware com path token + HMAC + log raw + idempotência
- **ADR-16**: Adapter sempre stateless; estado vive em `tenant_integrations`/`webhook_events_log`/`orders`; `loadContext` é o único bridge entre DB e adapter
- **ADR-17**: Sync workers usam `sync_progress` como source of truth de progresso pra UI (não in-memory, não eventbus); permite resume após crash
- **ADR-18**: Stage mapping é jsonb override em `tenant_integrations.store_metadata.stage_mapping` com fallback no default canônico (T-05); evita tabela separada no MVP

## 9. Anexos

- Spec base: `docs/specs/06-spec-nuvemshop-lgpd.md` §1-§6 (LGPD §7-§9 fica em EPIC-08)
- Reconciliation: R-05 (Server Action OAuth)
- Business rules: T-01 (RLS), T-02 (org_id de fonte confiável), T-05 (pipeline Pedidos seed), T-08 (org_id em logs), R-W (webhook_path_token único global), B-05 (catálogo synced), L-09 (cripto separada)
- Specs cruzadas: 02 (resolveContact), 04 (pipeline Pedidos + leads + activities), 09 §11 (Server Actions catalog inclui `connectNuvemshop`)
- Screen flow: `/app/integrations/nuvemshop` (a inventariar em screen-inventory)
- EPIC seguinte: EPIC-08 LGPD reusa `processWebhook`, `NuvemshopAdapter`, `tenant_integrations`, `webhook_events_log` pra implementar os 3 receivers LGPD

---

## ✅ Wave Completion Log (env-empty-ready)

Concluído em 2026-04-28 (sessão 2). Construído via Web Fetch da doc oficial Nuvemshop.

**IMPORTANT**: `NUVEMSHOP_APP_ID`/`CLIENT_ID`/`CLIENT_SECRET` ficam vazios em `.env.local`. Código degrada gracioso com `{ ok: false, error: 'not_configured' }`. Quando você registrar app em https://partners.tiendanube.com/ e dropar as keys, OAuth + webhooks ativam direto.

| Story | Commit |
|-------|--------|
| OAuth flow (authorize URL, exchange, HMAC state CSRF) | `b98ce6b` |
| 8 webhook receivers (catch-all dynamic route) | `b98ce6b` |
| API client com Authentication: bearer header | `b98ce6b` |
| Integration UI page (status: not_configured / not_connected / connected) | `b98ce6b` |
| connectNuvemshop + disconnectNuvemshop Server Actions | `b98ce6b` |
| webhook HMAC verification (timingSafeEqual sobre Buffers) | `b98ce6b` |
| Idempotency via webhook_events_log + emit_event | `b98ce6b` |

### 8 webhook events configurados
order/created, order/updated, order/paid, order/cancelled, product/created, product/updated, product/deleted, app/uninstalled

LGPD redact webhooks (store/redact, customers/redact, customers/data_request) **deferred pra EPIC-08**.

### Architecture contracts emitted
- `api.GET /api/v1/integrations/nuvemshop/callback` (OAuth callback)
- `api.POST /api/v1/webhooks/nuvemshop/{event}` (catch-all dynamic)
- `action.connectNuvemshop` / `action.disconnectNuvemshop` Server Actions
- `route./app/integrations/nuvemshop` (status UI)
- `lib/nuvemshop/{config,oauth,api-client,state}` exports
- `tenant_integrations` row com `provider='nuvemshop'`, `oauth_access_token_encrypted` (via fn_encrypt_oauth)

### Pendências
- Backfill workers (sync de orders existentes pós-conexão) — vem em EPIC-12
- LGPD redact webhooks — vem em EPIC-08
- Pra dev local, webhook URL precisa de tunnel HTTPS público (Cloudflared/ngrok)
