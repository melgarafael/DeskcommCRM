---
epic_id: EPIC-03-inbox-messaging
epic_name: Inbox + Messaging (WhatsApp ponta-a-ponta)
priority: P0
estimated_waves: 15
estimated_total_points: 55
depends_on: [EPIC-00, EPIC-01]
exposes_contracts:
  - "route./app/inbox"
  - "route./app/inbox/[id]"
  - "api.POST /api/wa/webhook"
  - "api.POST /api/v1/conversations/[id]/messages"
  - "api.POST /api/v1/conversations/[id]/claim"
  - "api.POST /api/v1/conversations/[id]/resolve"
  - "api.POST /api/v1/upload/sign"
  - "worker.whatsapp-inbound-worker"
  - "worker.whatsapp-send-worker"
  - "realtime.inbox-{org_id}"
  - "realtime.messages-{conv_id}"
  - "realtime.typing-{conv_id}"
  - "hook.useConversationsRealtime"
  - "hook.useMessagesRealtime"
  - "hook.useSendMessage"
  - "hook.useClaimConversation"
  - "hook.useResolveConversation"
  - "hook.useTyping"
  - "hook.useMarkAsRead"
  - "ui.<ConversationList>"
  - "ui.<ChatThread>"
  - "ui.<MessageBubble>"
  - "ui.<Composer>"
  - "ui.<CRMSidePanel>"
  - "event.message.received"
  - "event.message.queued"
  - "event.message.sent"
  - "event.message.failed"
  - "event.conversation.claimed"
  - "event.conversation.resolved"
status: completed (partial: WhatsApp E2E send/receive precisa WAHA com sessão WhatsApp ativa)
created_at: 2026-04-28
owner: Rafael Melgaço
---

# EPIC-03 — Inbox + Messaging

> **Para o epic-executor**: leia este arquivo inteiro antes de qualquer wave. Este é o **coração do produto**. Stories 01-04 = backbone do canal WhatsApp; 05-07 = APIs de operação; 08-09 = realtime; 10-13 = UI; 14-15 = atalhos + regras de negócio. Não pular ordem — `Deps:` é lei. Cada story = 1 wave.

## 1. Objetivo

Entregar a Inbox de 3 colunas (lista de conversas + chat + side-panel CRM) com WhatsApp via WAHA funcionando ponta-a-ponta: receber mensagens via webhook idempotente, enviar via worker com rate-limit por sessão, atualizar UI em realtime via Supabase Realtime, com optimistic UI por `client_message_id` e atalhos de teclado para velocidade de operador.

## 2. Resultado esperado (Definition of Done do Epic)

- [ ] Operador acessa `/app/inbox`, vê lista de conversas da org com badge de não lidas, filtros (todas/não lidas/abertas/resolvidas/minhas) e busca
- [ ] Cliente envia mensagem WhatsApp → aparece na inbox em <2s sem refresh (realtime)
- [ ] Webhook do WAHA é idempotente (replay 100× = 1 mensagem persistida) e valida HMAC-SHA512 timing-safe
- [ ] Operador clica "Eu cuido" → conversa atomicamente atribuída a ele; segundo operador clicando recebe 409 `conversation_already_claimed`
- [ ] Operador escreve no Composer + Enter → bubble aparece como `sending` instantaneamente (Pattern A optimistic) → vira `sent` após WAHA 200, ou `failed` com retry button
- [ ] Operador anexa imagem/áudio/doc → upload direto pro Storage via signed URL → mensagem enviada com mídia
- [ ] Side-panel mostra Contact + Deal (mover stage inline) + Notes + Timeline
- [ ] Atalhos `j/k/r/e/a/?/Esc` funcionam em todas as situações
- [ ] Janela 24h: badge vermelho quando última mensagem inbound > 23h; STOP em texto inbound bloqueia contato (`is_blocked=true`) + emite `system` event
- [ ] Worker de envio respeita rate-limit por sessão (W-01: 1 msg/s default, configurável)
- [ ] RLS: org A nunca vê conversa de org B (validado por test cross-tenant)
- [ ] Regression suite cumulativa do epic = 100% verde

## 3. Pré-requisitos

- EPIC-00 completo: TanStack Query provider, `useApiClient`, `useRealtimeChannel`, sonner toast, phosphor-icons, Playwright MCP
- EPIC-01 completo: `useAuth`, middleware, `(app)/layout.tsx` shell, `useUser`/`usePermission`
- Migrations 0001–0007 aplicadas: tabelas `organizations`, `users`, `org_members`, `contacts`, `conversations`, `messages`, `event_log`, `whatsapp_sessions`, `webhook_logs`, `notes`, `deals`, `pipeline_stages`, `tenant_storage_buckets`, RLS via `fn_user_org_ids()`
- Env vars: `WAHA_BASE_URL`, `WAHA_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `WORKER_QUEUE_URL` (pgmq schema), `STORAGE_BUCKET_PREFIX`
- Dev server rodando em `localhost:3001`
- Playwright MCP conectado pra QA gate
- WAHA em ambiente de dev acessível (mock OK pra unit; integração real em waves 02 e 04)

## 4. Architecture Contracts

### 4.1 Contracts consumidos (de epics anteriores)

| Contract ID | Tipo | Origem | Como usar |
|---|---|---|---|
| `auth.user-session` | session | EPIC-01 | `useAuth()`; server: `getServerSession()` em route handlers |
| `hook.useApiClient` | hook | EPIC-00 | `apiClient.post(url, body, { idempotencyKey })` |
| `hook.useRealtimeChannel` | hook | EPIC-00 | Subscription primitive (cleanup automático) |
| `lib.toast` | lib | EPIC-00 | `toast.error()`, `toast.success()` em mutations |
| `db.organizations` | db_table | migration 0001 | RLS via `fn_user_org_ids()` |
| `db.contacts` | db_table | migration 0002 | `unique(org_id, channel, channel_user_id)` |
| `db.conversations` | db_table | migration 0003 | `unique(org_id, channel, channel_thread_id)` |
| `db.messages` | db_table | migration 0003 | `unique(org_id, external_id) WHERE external_id IS NOT NULL`; `unique(org_id, client_message_id) WHERE client_message_id IS NOT NULL` |
| `db.event_log` | db_table | migration 0006 | INSERT-only, particionado por mês |
| `db.webhook_logs` | db_table | migration 0006 | Raw payload + headers, retention 30d |
| `db.whatsapp_sessions` | db_table | migration 0004 | `session_name`, `rate_limit_per_second` |
| `infra.pgmq` | queue | EPIC-00 | `pgmq.send()`, `pgmq.read()`, `pgmq.archive()` |
| `middleware.ts` | middleware | EPIC-01 | Protege `/app/*` |
| `app/(app)/layout.tsx` | layout | EPIC-01 | Sidebar + topbar shell |

### 4.2 Contracts expostos

| Contract ID | Tipo | Wave que expõe | Descrição |
|---|---|---|---|
| `api.POST /api/wa/webhook` | api_route | S-03.01 | Receiver WAHA. Headers: `X-Webhook-Signature` (HMAC-SHA512 hex). Body: WAHA event JSON. Returns 200 sempre que assinatura válida (idempotente). |
| `worker.whatsapp-inbound-worker` | worker | S-03.02 | Consome `wa-inbound` queue. Resolve identity → upsert contact + conversation → insert message → emit `message.received`. |
| `api.POST /api/v1/conversations/[id]/messages` | api_route | S-03.03 | Body `{ client_message_id, type, body?, media_storage_path?, reply_to_message_id? }`. Header `Idempotency-Key` (=client_message_id). Returns `{ data: Message }` com `status='sending'`. |
| `worker.whatsapp-send-worker` | worker | S-03.04 | Consome `wa-outbound`. Rate-limited por sessão. POST WAHA `/api/sendText`/`/api/sendImage` etc. Atualiza message `status` + `external_id`. |
| `api.POST /api/v1/conversations/[id]/claim` | api_route | S-03.05 | Atomic UPDATE. 200 `{ data: Conversation }` ou 409 `conversation_already_claimed`. |
| `api.POST /api/v1/conversations/[id]/resolve` | api_route | S-03.06 | Transição `open→resolved`. 409 se já resolved. Audit. |
| `api.POST /api/v1/upload/sign` | api_route | S-03.07 | Body `{ filename, mime_type, size_bytes, conversation_id }`. Returns `{ upload_url, storage_path, expires_at }`. |
| `realtime.inbox-{org_id}` | realtime_channel | S-03.08 | Broadcast em INSERT/UPDATE de `conversations` da org. Payload `{ event, conversation }`. |
| `realtime.messages-{conv_id}` | realtime_channel | S-03.09 | Broadcast em INSERT/UPDATE de `messages` da conversa. Payload `{ event, message }`. |
| `realtime.typing-{conv_id}` | realtime_channel | S-03.11 | Broadcast presence/typing (sem persistência). |
| `hook.useConversationsRealtime` | react_hook | S-03.08 | `(filters?) => { conversations, isLoading, error }`. Merge realtime no TanStack cache. |
| `hook.useMessagesRealtime` | react_hook | S-03.09 | `(convId) => { messages, isLoading, hasMore, fetchMore }`. Dedup via `client_message_id`. |
| `hook.useSendMessage` | react_hook | S-03.12 | `(convId) => { sendMessage, isSending }`. Pattern A: insert otimista → server confirma. |
| `hook.useClaimConversation` | react_hook | S-03.05 | Mutation com toast 409 `Já foi pega por <fulano>`. |
| `hook.useResolveConversation` | react_hook | S-03.06 | Mutation. |
| `hook.useTyping` | react_hook | S-03.11 | `(convId) => { sendTyping, peerTyping }`. Throttle 1s. |
| `hook.useMarkAsRead` | react_hook | S-03.10 | Auto-invocado quando conversa entra em foco >1.5s. |
| `ui.<ConversationList>` | react_component | S-03.10 | Lista virtualizada + filtros + busca. |
| `ui.<ChatThread>` | react_component | S-03.11 | Header + scrollable bubbles + typing indicator. |
| `ui.<MessageBubble>` | react_component | S-03.11 | Por type (text/image/video/audio/document/location/reaction/system). |
| `ui.<Composer>` | react_component | S-03.12 | Paperclip + textarea + send + drag-drop. |
| `ui.<CRMSidePanel>` | react_component | S-03.13 | ContactSection + DealSection + NotesSection + TimelineSection. |
| `event.message.received` | domain_event | S-03.02 | Payload `{ message_id, conversation_id, contact_id, channel }`. |
| `event.message.queued` | domain_event | S-03.03 | Payload `{ message_id, conversation_id }`. |
| `event.message.sent` | domain_event | S-03.04 | Payload `{ message_id, external_id, sent_at }`. |
| `event.message.failed` | domain_event | S-03.04 | Payload `{ message_id, error_code, error_message }`. |
| `event.conversation.claimed` | domain_event | S-03.05 | Payload `{ conversation_id, claimed_by }`. |
| `event.conversation.resolved` | domain_event | S-03.06 | Payload `{ conversation_id, resolved_by }`. |
| `event.contact.blocked` | domain_event | S-03.15 | Payload `{ contact_id, reason: 'stop_keyword' }`. |
| `route./app/inbox` | route | S-03.10 | Lista + thread vazio. |
| `route./app/inbox/[id]` | route | S-03.11 | Lista + thread + side-panel. |

## 5. Stories (em ordem de dependência)

> Cada story = 1 wave do epic-executor. Wave 1 = S-03.01.

---

### S-03.01 — Webhook receiver com HMAC + idempotência

**Points**: 4 | **Priority**: P0 | **Deps**: (none) | **FR refs**: Spec 03 §2 webhook receiver, Spec 07 §3 webhook_logs, Business rule W-02 (HMAC), W-03 (idempotência)

#### Contexto
Porta de entrada de tudo. WAHA dispara POST aqui pra cada evento (mensagem recebida, ack, presence, typing). Precisa: (a) validar HMAC-SHA512 com `crypto.timingSafeEqual` pra evitar timing attack, (b) gravar payload raw em `webhook_logs` ANTES de qualquer processamento (pra debug + replay), (c) ser idempotente — replay 100× = 1 row em `messages`. Idempotência via `unique(org_id, external_id)` na tabela `messages` + capture do `23505 unique_violation` retornando 200 OK como se fosse sucesso. Worker é fire-and-forget via `pgmq.send('wa-inbound', payload)` — webhook responde 202 Accepted em <100ms.

#### Files to create
- `app/api/wa/webhook/route.ts` — POST handler
- `lib/security/hmac.ts` — `verifyWahaSignature(rawBody, header, secret): boolean`
- `lib/queue/pgmq.ts` — `enqueue(topic, payload)` thin wrapper
- `lib/db/webhook-logs.ts` — `logWebhook({ source, headers, raw_payload, signature_valid })`
- `tests/api/wa-webhook.spec.ts` — Vitest: HMAC valid/invalid, replay idempotência, malformed payload

#### Files to modify
- `middleware.ts` — adicionar `/api/wa/webhook` à allowlist sem auth (já validado por HMAC)

#### Implementation steps
1. Ler raw body com `req.text()` ANTES de parsear JSON (necessário pro HMAC)
2. Extrair `X-Webhook-Signature` (formato `sha512=<hex>`)
3. Resolver `org_id` do header `X-Tenant-Id` (WAHA configurado pra mandar) → fetch `whatsapp_sessions.webhook_secret`
4. `crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))` — se falhar, 401 + log com `signature_valid=false`
5. Persist em `webhook_logs` (raw payload + headers + signature_valid=true)
6. `pgmq.send('wa-inbound', { webhook_log_id, org_id, payload })` — queue garante durabilidade
7. Return 202 `{ accepted: true }`
8. Erros 5xx só pra falhas reais de DB; nunca pra payload malformado (logamos + 200 pra evitar retry storm)

#### Acceptance Criteria

```gherkin
Given WAHA configurado com secret "abc123" pra org X
When POST /api/wa/webhook com signature válida e payload de mensagem
Then resposta 202 em <100ms
And row criada em webhook_logs com signature_valid=true e raw_payload completo
And mensagem enfileirada em pgmq topic "wa-inbound"
```

```gherkin
Given mesma payload com signature inválida
When POST /api/wa/webhook
Then resposta 401
And row em webhook_logs com signature_valid=false
And nada enfileirado
```

```gherkin
Given mesmo payload (mesmo external_id) enviado 100 vezes em paralelo
When todos os 100 requests chegarem
Then exatamente 1 row em messages depois do worker processar
And os 100 requests retornam 202
And webhook_logs tem 100 rows (todos os payloads são logados, é idempotência só na message)
```

```gherkin
Given header X-Tenant-Id ausente
When POST /api/wa/webhook
Then resposta 400 "missing_tenant_id"
And nada em webhook_logs (não conseguimos atribuir tenant)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | Signature válida → 202 + log + queue | curl com HMAC correto, verificar `webhook_logs` row + `pgmq.read('wa-inbound')` |
| t2 | api | Signature inválida → 401 | curl com HMAC errado |
| t3 | api | Replay 100× = 1 message (após worker) | bash loop curl 100× mesmo payload, então rodar worker, query `select count(*) from messages where external_id=...` = 1 |
| t4 | sec | Timing attack resistance | Test com strings de tamanhos diferentes — tempo de resposta indistinguível (within stdev) |
| t5 | rls | webhook_logs visível só pra org dona | Login org B, query `webhook_logs` com filter ID de org A → 0 rows |
| t6 | perf | p95 < 100ms sob load | k6 ou similar, 50 rps por 30s |

#### Architecture contracts emitted

```yaml
exposes:
  - type: api_route
    id: "POST /api/wa/webhook"
    request_schema: "raw WAHA event JSON"
    response_schema: "{ accepted: boolean }"
    error_codes: [invalid_signature, missing_tenant_id, internal_error]
    auth: "HMAC-SHA512 via X-Webhook-Signature, no JWT"
  - type: queue_topic
    id: "wa-inbound"
    payload: "{ webhook_log_id, org_id, payload }"
  - type: db_write
    id: "webhook_logs.insert"
```

#### Decisões a registrar
- `X-Tenant-Id` header obrigatório no WAHA — config no momento de connect (S-03.04 do EPIC-02)
- `webhook_logs` retém 30d (TTL via cron — fora deste epic, registrado pra EPIC-10)
- Rota fora do middleware de auth (allowlist explícita)

#### Definition of Done
- [ ] Todos os ACs passam
- [ ] Typecheck + lint zero erros novos
- [ ] Sem warnings em dev
- [ ] Commit `feat(EPIC-03): webhook receiver with HMAC + idempotency [wave 1]`
- [ ] Contracts registrados no state file

---

### S-03.02 — Worker pipeline inbound

**Points**: 5 | **Priority**: P0 | **Deps**: S-03.01 | **FR refs**: Spec 03 §3 inbound pipeline, Spec 04 §6 hooks de pipeline, Spec 07 §4 workers

#### Contexto
Consumer da queue `wa-inbound`. Por mensagem: (1) resolve identity (channel_user_id = WhatsApp JID) → `upsert contacts ON CONFLICT (org_id, channel, channel_user_id)`; (2) upsert conversations idem (`channel_thread_id` = JID pra 1:1, group_id pra grupos); (3) insert message com `external_id` = WAHA `message.id` — captura `23505` retornando idempotente; (4) emit `message.received` em `event_log`; (5) marca conversation `last_inbound_at = now()`, `unread_count += 1`; (6) ack/archive da queue. Idempotência é a principal preocupação — uma falha no insert de message NÃO pode resultar em contact/conversation duplicados; usa transação única.

#### Files to create
- `workers/whatsapp-inbound-worker.ts` — main loop consumer
- `lib/messaging/identity-resolver.ts` — `resolveContact({ org_id, channel, channel_user_id, profile_name? })`
- `lib/messaging/conversation-resolver.ts` — `resolveConversation({ org_id, contact_id, channel_thread_id })`
- `lib/messaging/message-persister.ts` — `persistInbound(payload): { message, isDuplicate }`
- `lib/events/emit.ts` — `emitEvent({ org_id, type, payload, actor })`
- `tests/workers/inbound.spec.ts` — Vitest com fixtures WAHA reais

#### Files to modify
- `package.json` — script `worker:inbound`
- `infra/process-manager.config.ts` (ou Procfile) — registrar worker

#### Implementation steps
1. Loop: `pgmq.read('wa-inbound', vt=30, batch_size=10)`
2. Pra cada msg: BEGIN tx
3. Parse WAHA payload (text/image/video/audio/document/location/reaction)
4. `resolveContact`: SELECT WHERE channel_user_id; se NULL → INSERT (capture 23505 → SELECT again, race condition handler)
5. `resolveConversation`: idem
6. `persistInbound`: INSERT messages (org_id, conversation_id, contact_id, direction='inbound', type, body/media_storage_path, external_id, created_at=WAHA timestamp)
   - se 23505 → SELECT existing → return `{ isDuplicate: true }`
7. UPDATE conversations SET last_message_at=now(), last_inbound_at=now(), unread_count=unread_count+1, status=COALESCE(status,'open') WHERE id=...
8. `emitEvent('message.received', { message_id, conversation_id, contact_id, channel: 'whatsapp' })`
9. COMMIT
10. `pgmq.archive(msg_id)` — só após commit (at-least-once semantics)
11. Erros: rollback + `pgmq.set_vt(msg_id, 60s)` pra retry; após 5 fails → DLQ `wa-inbound-dlq`

#### Acceptance Criteria

```gherkin
Given queue tem 1 mensagem WAHA inbound texto "oi"
When worker processa
Then row em contacts com channel_user_id=WAHA JID
And row em conversations com status='open', unread_count=1
And row em messages direction='inbound', type='text', body='oi', external_id=WAHA id
And row em event_log type='message.received'
```

```gherkin
Given mesma payload entra na queue 2x (replay)
When worker processa ambas
Then exatamente 1 message persistida
And 2 events 'message.received'? NÃO — só 1 (verificar via dedup do isDuplicate)
And contacts/conversations não duplicaram
```

```gherkin
Given mensagem de imagem com media_url WAHA
When worker processa
Then message.type='image', media_storage_path=NULL (download é S-03.07/04 — aqui só registra media_url temporário em metadata)
And worker enfileira sub-tarefa 'media-download' (out of scope desta story — basta registrar)
```

```gherkin
Given DB indisponível por 5s
When worker tenta processar
Then mensagem volta pra queue com vt=60s
And após 5 fails consecutivos vai pra wa-inbound-dlq
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | worker | Inbound text → DB consistente | Inject fixture na queue, run worker 1 iter, query 4 tabelas |
| t2 | worker | Idempotência via external_id | 2× mesma payload → count=1 |
| t3 | worker | Race upsert contact | 2 workers simultâneos com mesmo channel_user_id (novo) → 1 contact, sem deadlock |
| t4 | worker | Failure → retry | Mock DB throw 1×, depois OK → message persistida na 2ª try |
| t5 | event | event.message.received emitido | Query event_log após processamento |
| t6 | rls | Worker bypass RLS via service role | Confirmar `SUPABASE_SERVICE_ROLE_KEY` em uso |

#### Architecture contracts emitted

```yaml
exposes:
  - type: worker
    id: "whatsapp-inbound-worker"
    consumes_queue: "wa-inbound"
    emits_events: ["message.received"]
    writes_tables: ["contacts", "conversations", "messages", "event_log"]
  - type: domain_event
    id: "message.received"
    payload_schema: "{ message_id: uuid, conversation_id: uuid, contact_id: uuid, channel: 'whatsapp' }"
```

#### Decisões a registrar
- Worker usa service role key (bypass RLS) — toda escrita inclui `org_id` explícito (defense in depth)
- Race condition em upsert resolvida com `INSERT ... ON CONFLICT DO NOTHING RETURNING *` + SELECT fallback
- Mídia: persiste só metadata WAHA aqui; download separado (out of scope desta story; tracking ticket EPIC-03 aux)

#### Definition of Done
- [ ] ACs passam
- [ ] Typecheck + lint OK
- [ ] Worker roda sem crash em loop por 60s com fixtures
- [ ] Commit `feat(EPIC-03): inbound worker pipeline [wave 2]`

---

### S-03.03 — API send message (enqueue + Idempotency-Key)

**Points**: 4 | **Priority**: P0 | **Deps**: S-03.02 | **FR refs**: Spec 03 §4 outbound, Spec 09 §7 Pattern A, Business rule W-04 (idempotency)

#### Contexto
Endpoint que o frontend chama no Composer. Recebe `client_message_id` (UUID gerado no client) → também serve como `Idempotency-Key`. Persiste imediatamente em `messages` com `status='sending'`, direction='outbound', e enfileira em `wa-outbound`. Retorna a Message sintética pra frontend confirmar o optimistic insert. RLS valida que user pertence à org. Permission: precisa de `messages.send` no `org_member.role`.

#### Files to create
- `app/api/v1/conversations/[id]/messages/route.ts` — POST handler
- `lib/api/idempotency.ts` — `withIdempotency(key, handler)` — usa `unique(org_id, client_message_id)` pra dedup
- `lib/permissions/check.ts` (se não existe de EPIC-01) — `requirePermission(user, perm)`
- `tests/api/send-message.spec.ts`

#### Implementation steps
1. Auth: `getServerSession()`; 401 se ausente
2. Validate body Zod: `{ client_message_id: uuid, type: enum, body?: string, media_storage_path?: string, reply_to_message_id?: uuid }`
3. Header `Idempotency-Key` deve === `client_message_id`; 400 se mismatch
4. Permission: `requirePermission(user, 'messages.send')`
5. Verify conversation: SELECT FROM conversations WHERE id=$1 — RLS enforce org; 404 se não existe
6. INSERT messages (status='sending', direction='outbound', sender_user_id=user.id, ...) — capture 23505 → SELECT existing e retorne (Idempotency Replay)
7. `pgmq.send('wa-outbound', { message_id, conversation_id })`
8. UPDATE conversations.last_message_at=now()
9. emit `message.queued`
10. Return 201 `{ data: message }`

#### Acceptance Criteria

```gherkin
Given operador autenticado em org X com permission messages.send
When POST /api/v1/conversations/<id>/messages com body válido + Idempotency-Key
Then 201 com message status='sending'
And message persistida com client_message_id
And evento 'message.queued' em event_log
And payload em pgmq wa-outbound
```

```gherkin
Given mesmo client_message_id reenviado (retry de network)
When POST chega 2ª vez
Then 201 com a MESMA message (não duplicada)
And nada novo enfileirado
```

```gherkin
Given user de org B tenta enviar em conversation de org A
When POST
Then 404 "conversation_not_found" (RLS oculta)
```

```gherkin
Given header Idempotency-Key != body.client_message_id
When POST
Then 400 "idempotency_key_mismatch"
```

```gherkin
Given user com role 'viewer' (sem messages.send)
When POST
Then 403 "permission_denied"
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | Happy path 201 + DB row | curl autenticado |
| t2 | api | Replay com mesmo Idempotency-Key | 2× curl, check 1 row |
| t3 | rls | Cross-tenant 404 | Login org B, POST conv de org A |
| t4 | api | Missing Idempotency-Key → 400 | curl sem header |
| t5 | perm | Viewer → 403 | Login com role viewer |
| t6 | event | message.queued no event_log | Query após POST |

#### Architecture contracts emitted

```yaml
exposes:
  - type: api_route
    id: "POST /api/v1/conversations/[id]/messages"
    request_schema: "{ client_message_id, type, body?, media_storage_path?, reply_to_message_id? }"
    response_schema: "{ data: Message }"
    headers: { Idempotency-Key: "= client_message_id" }
    error_codes: [unauthenticated, permission_denied, conversation_not_found, idempotency_key_mismatch, validation_error]
  - type: domain_event
    id: "message.queued"
```

#### Definition of Done
- [ ] ACs passam (Playwright + curl)
- [ ] Commit `feat(EPIC-03): send message API with idempotency [wave 3]`

---

### S-03.04 — Worker outbound (rate-limited, WAHA POST)

**Points**: 5 | **Priority**: P0 | **Deps**: S-03.03 | **FR refs**: Spec 03 §4-5 send pipeline, Business rule W-01 (rate limit), W-05 (status transitions)

#### Contexto
Consumer de `wa-outbound`. Por message: (1) lookup `whatsapp_sessions` da org pra obter `session_name` e `rate_limit_per_second`; (2) acquire token de rate-limit (Redis-based ou pgmq + sleep); (3) POST WAHA endpoint apropriado pelo type (`/api/sendText`, `/api/sendImage`, etc); (4) update message status='sent', external_id=WAHA id, sent_at=now() em sucesso; ou status='failed', error_code, error_message em falha (4xx WAHA = sem retry; 5xx = retry com backoff até 3×; após = `failed`); (5) emit `message.sent` ou `message.failed`.

#### Files to create
- `workers/whatsapp-send-worker.ts` — main loop
- `lib/rate-limit/session-bucket.ts` — token bucket por session_id (Postgres advisory lock + sleep, ou Redis)
- `lib/messaging/waha-client.ts` — `sendText`, `sendImage`, `sendVideo`, `sendAudio`, `sendDocument`, `sendLocation`
- `lib/messaging/send-handler.ts` — orquestra: lookup → rate-limit → send → update
- `tests/workers/send.spec.ts`

#### Implementation steps
1. Loop `pgmq.read('wa-outbound')`
2. Lookup message + conversation + session
3. Acquire rate-limit token (`SELECT pg_advisory_xact_lock(session_id_hash)` + dynamic sleep based on `rate_limit_per_second`)
4. Build WAHA request por type
5. POST WAHA com timeout 15s
6. Sucesso: UPDATE message SET status='sent', external_id=resp.id, sent_at=now(); emit `message.sent`
7. Falha 4xx: UPDATE status='failed', error_code=resp.code (ex: `not_in_whitelist`, `not_in_24h_window`), error_message; emit `message.failed`; archive (sem retry)
8. Falha 5xx ou timeout: `pgmq.set_vt(msg_id, exp_backoff)`; após 3 fails → status='failed' com `error_code='max_retries_exceeded'`
9. Janela 24h pre-check (W-12): se conversation.last_inbound_at < (now - 24h) AND não é template → fail com `error_code='outside_24h_window'` SEM chamar WAHA

#### Acceptance Criteria

```gherkin
Given message status='sending' enfileirada
When worker processa
Then POST WAHA disparado com payload correto
And sucesso → status='sent', external_id preenchido, sent_at preenchido
And event 'message.sent' emitido
```

```gherkin
Given 3 mensagens enfileiradas pra mesma session com rate_limit_per_second=1
When worker processa em paralelo
Then WAHA recebe espaçado (>900ms entre chamadas)
And tempo total >= 2s
```

```gherkin
Given last_inbound_at > 24h atrás e mensagem não é template
When worker tenta enviar
Then NÃO chama WAHA
And status='failed' com error_code='outside_24h_window'
```

```gherkin
Given WAHA retorna 503
When worker tenta enviar
Then primeiro retry após 1s, segundo após 2s, terceiro após 4s
And após 3 falhas → status='failed' error_code='max_retries_exceeded'
```

```gherkin
Given WAHA retorna 400 'invalid_jid'
When worker tenta enviar
Then sem retry, status='failed' error_code='invalid_jid'
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | worker | Happy path send | Mock WAHA 200, verifica status='sent' |
| t2 | worker | Rate limit 1/s | 3 mensagens, verificar timestamps WAHA |
| t3 | worker | 24h window block | Set last_inbound_at -25h, verificar fail sem WAHA hit |
| t4 | worker | Retry 5xx → success | Mock 503 then 200 |
| t5 | worker | Max retries → failed | Mock 503 always |
| t6 | worker | 4xx no-retry | Mock 400, verifica fail imediato |
| t7 | event | Events emitidos | Query event_log |

#### Architecture contracts emitted

```yaml
exposes:
  - type: worker
    id: "whatsapp-send-worker"
    consumes_queue: "wa-outbound"
    emits_events: ["message.sent", "message.failed"]
    writes_tables: ["messages", "event_log"]
  - type: business_rule
    id: "W-01-rate-limit"
    description: "1 msg/s default per WhatsApp session, configurable"
  - type: business_rule
    id: "W-12-24h-window"
    description: "outbound bloqueado se last_inbound > 24h e não é template"
```

#### Definition of Done
- [ ] ACs passam
- [ ] Worker em loop estável 60s
- [ ] Commit `feat(EPIC-03): outbound worker with rate-limit + 24h window [wave 4]`

---

### S-03.05 — API claim atomic + 409 conflict

**Points**: 3 | **Priority**: P0 | **Deps**: S-03.03 | **FR refs**: Spec 04 §7 atendimento, Business rule AT-01 (claim atomic)

#### Contexto
Operador clica "Eu cuido". Atomicamente: `UPDATE conversations SET assigned_to=$user, claimed_at=now() WHERE id=$conv AND assigned_to IS NULL RETURNING *`. Se RETURNING vazio → outro pegou primeiro → 409 `conversation_already_claimed` com info de quem pegou (`assigned_to_name`). Emit `conversation.claimed`. Audit em event_log.

#### Files to create
- `app/api/v1/conversations/[id]/claim/route.ts`
- `tests/api/claim.spec.ts`

#### Implementation steps
1. Auth + permission `conversations.claim`
2. UPDATE atomic com WHERE assigned_to IS NULL
3. Se 0 rows: SELECT atual → return 409 com `{ error: 'conversation_already_claimed', claimed_by: { user_id, name } }`
4. Se 1 row: emit event + return 200 `{ data: conversation }`

#### Acceptance Criteria

```gherkin
Given conversation com assigned_to=NULL
When operator A faz POST claim
Then 200 com assigned_to=A
And event_log conversation.claimed
```

```gherkin
Given conversation já claimed por A
When operator B faz POST claim
Then 409 conversation_already_claimed
And response inclui { claimed_by: { user_id, name } }
And assigned_to NÃO muda
```

```gherkin
Given 2 operadores fazem claim simultaneamente em conv unclaimed
When ambos POST chegam no mesmo ms
Then exatamente 1 recebe 200 e outro 409
And é race-safe (testar com 50 concurrent)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | Claim happy path | curl |
| t2 | api | Claim já claimed → 409 | 2 curls sequenciais |
| t3 | api | Race condition 50 concurrent | bash xargs -P50 |
| t4 | rls | Claim cross-tenant → 404 | Org B tenta conv de A |
| t5 | event | claimed event no event_log | Query |

#### Architecture contracts emitted

```yaml
exposes:
  - type: api_route
    id: "POST /api/v1/conversations/[id]/claim"
    response_schema: "{ data: Conversation } | { error: 'conversation_already_claimed', claimed_by: User }"
    error_codes: [conversation_already_claimed, conversation_not_found, permission_denied]
  - type: domain_event
    id: "conversation.claimed"
```

#### Definition of Done
- [ ] ACs passam incl race
- [ ] Commit `feat(EPIC-03): atomic claim API [wave 5]`

---

### S-03.06 — API resolve conversation

**Points**: 2 | **Priority**: P0 | **Deps**: S-03.05 | **FR refs**: Spec 04 §7 resolve, Business rule AT-04

#### Contexto
Transição `open → resolved`. Persiste `resolved_at`, `resolved_by`. Se já resolved → 409 `conversation_already_resolved`. Audit. (Reabrir é EPIC-04 ou EPIC-10.)

#### Files to create
- `app/api/v1/conversations/[id]/resolve/route.ts`
- `tests/api/resolve.spec.ts`

#### Implementation steps
1. Auth + permission `conversations.resolve`
2. UPDATE conversations SET status='resolved', resolved_at=now(), resolved_by=$user WHERE id=$1 AND status='open' RETURNING *
3. 0 rows → 409
4. emit event

#### Acceptance Criteria

```gherkin
Given conversation status='open'
When POST resolve
Then status='resolved', resolved_at + resolved_by preenchidos
And event conversation.resolved
```

```gherkin
Given já resolved
When POST resolve novamente
Then 409 conversation_already_resolved
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | Resolve happy | curl |
| t2 | api | Already resolved → 409 | 2× curl |
| t3 | event | Event emitido | Query |
| t4 | rls | Cross-tenant | Org B tenta |

#### Architecture contracts emitted

```yaml
exposes:
  - type: api_route
    id: "POST /api/v1/conversations/[id]/resolve"
    error_codes: [conversation_already_resolved, conversation_not_found, permission_denied]
  - type: domain_event
    id: "conversation.resolved"
```

#### Definition of Done
- [ ] ACs passam
- [ ] Commit `feat(EPIC-03): resolve conversation API [wave 6]`

---

### S-03.07 — Storage upload signed URL flow

**Points**: 4 | **Priority**: P0 | **Deps**: S-03.03 | **FR refs**: Spec 03 §6 mídia, Spec 06 §3 storage tenancy

#### Contexto
Operador clica paperclip → escolhe arquivo → frontend chama `POST /api/v1/upload/sign` com metadata → backend gera signed upload URL no bucket da org (`tenant_storage_buckets.bucket_name`) com path `{org_id}/{conv_id}/{uuid}-{filename}` → retorna URL → cliente faz PUT direto no Supabase Storage → frontend chama `POST /messages` com `media_storage_path` retornado. Validação: max 16MB, mime-types permitidos por tipo (image/jpeg|png|webp; video/mp4; audio/ogg|mpeg; application/pdf etc).

#### Files to create
- `app/api/v1/upload/sign/route.ts`
- `lib/storage/sign-upload.ts` — `createSignedUploadUrl(orgId, path, mimeType)` via Supabase admin
- `lib/validation/media-types.ts` — allowlist por type
- `hooks/useUpload.ts` — `(file) => { upload, progress, isUploading }` (progress via PUT XHR)
- `tests/api/upload-sign.spec.ts`

#### Implementation steps
1. Validate body: filename (sanitize), mime_type (allowlist), size_bytes (<= 16MB), conversation_id (RLS check)
2. Resolve org bucket (do `tenant_storage_buckets`)
3. Path: `${orgId}/${conversationId}/${randomUuid}-${sanitizedFilename}`
4. `supabaseAdmin.storage.from(bucket).createSignedUploadUrl(path, { upsert: false })`
5. Return `{ upload_url, storage_path, expires_at }`

#### Acceptance Criteria

```gherkin
Given operator com permission messages.send
When POST upload/sign com {filename:'foto.jpg', mime_type:'image/jpeg', size:500000, conversation_id:X}
Then 200 com upload_url válida (expira em 5min)
And storage_path = "{org_id}/{conv_id}/<uuid>-foto.jpg"
```

```gherkin
Given mime_type='application/exe'
When POST upload/sign
Then 400 'mime_type_not_allowed'
```

```gherkin
Given size_bytes=20MB
When POST upload/sign
Then 400 'file_too_large'
```

```gherkin
Given cliente PUT na upload_url
When PUT chega
Then 200 + arquivo no bucket
And storage_path retornado pode ser usado em /messages POST como media_storage_path
```

```gherkin
Given user de org B tenta sign pra conv de org A
When POST
Then 404
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | Sign + PUT funciona end-to-end | curl sign → curl PUT na URL |
| t2 | api | Mime denylist | curl com .exe |
| t3 | api | Size limit | curl com 20MB |
| t4 | rls | Cross-tenant | Org B |
| t5 | sec | Path traversal | filename "../../etc/passwd" sanitizado |

#### Architecture contracts emitted

```yaml
exposes:
  - type: api_route
    id: "POST /api/v1/upload/sign"
    request_schema: "{ filename, mime_type, size_bytes, conversation_id }"
    response_schema: "{ upload_url, storage_path, expires_at }"
    error_codes: [mime_type_not_allowed, file_too_large, conversation_not_found]
  - type: react_hook
    id: "useUpload"
    signature: "(file) => { upload(): Promise<{storage_path}>, progress, isUploading }"
```

#### Decisões a registrar
- Bucket por tenant (`tenant_storage_buckets.bucket_name`) — convenção `tenant-{org_id}` definida em EPIC-02
- Signed URL expira em 5min
- Path inclui org_id pra defense-in-depth (mesmo se bucket vazar config, RLS de Storage adiciona camada)

#### Definition of Done
- [ ] ACs passam
- [ ] Commit `feat(EPIC-03): storage signed upload flow [wave 7]`

---

### S-03.08 — useConversationsRealtime hook

**Points**: 3 | **Priority**: P0 | **Deps**: S-03.02 | **FR refs**: Spec 09 §6 realtime channels

#### Contexto
Hook canônico pra inbox list. Subscribe em canal `inbox-{org_id}` (Postgres Changes filter `organization_id=eq.X` em `conversations`). Em INSERT/UPDATE: merge no TanStack cache key `['conversations', orgId, filters]`. Optimistic-friendly: se row já está no cache (assigned_to mudou via API), o realtime confirma idempotente. Cleanup: unsubscribe no unmount.

#### Files to create
- `hooks/useConversationsRealtime.ts`
- `lib/realtime/merge.ts` — `mergeRow(cache, row, dedupKey)` helper
- `tests/hooks/useConversationsRealtime.spec.tsx` — Vitest + Testing Library

#### Implementation steps
1. `useEffect` subscribe canal Realtime via `useRealtimeChannel` de EPIC-00
2. Filter: `schema=public, table=conversations, filter=organization_id=eq.{user.activeOrgId}`
3. On INSERT/UPDATE: `queryClient.setQueryData(['conversations', orgId, ...], (old) => mergeRow(old, payload.new, 'id'))`
4. Initial fetch via TanStack `useQuery` paralelo
5. Sort: por `last_message_at desc`
6. Filtros lado-cliente: `unread`, `mine`, `open`, `resolved` (server-side filtros virão em S-03.10)

#### Acceptance Criteria

```gherkin
Given operador na inbox
When nova mensagem chega via worker → INSERT em conversations
Then conversation aparece no topo da lista em <2s sem refresh
```

```gherkin
Given conversation existente recebe nova mensagem
When UPDATE last_message_at
Then conversation sobe pro topo
And unread_count atualiza no badge
```

```gherkin
Given operador desmonta o componente
When unmount
Then channel é unsubscribed (sem leak)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | realtime | Insert → cache update | Playwright: trigger worker, observa DOM |
| t2 | realtime | Update → reorder | idem |
| t3 | mem | No leak ao remontar 10× | Verifica subscription count |
| t4 | rls | Org B não recebe canal de A | Login B, check só vê suas conversas |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_hook
    id: "useConversationsRealtime"
    signature: "(filters?) => { conversations, isLoading, error }"
  - type: realtime_channel
    id: "inbox-{org_id}"
    table: "conversations"
    filter: "organization_id=eq.{org_id}"
```

#### Definition of Done
- [ ] ACs passam
- [ ] Commit `feat(EPIC-03): useConversationsRealtime hook [wave 8]`

---

### S-03.09 — useMessagesRealtime hook (dedup client_message_id)

**Points**: 3 | **Priority**: P0 | **Deps**: S-03.08 | **FR refs**: Spec 09 §7 Pattern A optimistic

#### Contexto
Pra thread aberta. Subscribe `messages-{conv_id}`. Pattern A: optimistic insert local com `client_message_id` antes do POST; quando server INSERT chega via Realtime, dedup por `client_message_id` (substitui a row otimista; não duplica). Suporta paginação reversa (load older); novos vão pro fim, antigos no topo via fetchMore.

#### Files to create
- `hooks/useMessagesRealtime.ts`
- `lib/realtime/dedup.ts` — `dedupByClientId(cache, row)` — substitui se `client_message_id` match, senão append
- `tests/hooks/useMessagesRealtime.spec.tsx`

#### Implementation steps
1. Initial fetch: paginated `messages WHERE conversation_id=X ORDER BY created_at DESC LIMIT 50` (newest-first, render reverse)
2. Subscribe canal `messages-{conv_id}`
3. On INSERT: dedupByClientId — se cache tem row com mesmo `client_message_id` (otimista), MERGE (preserva otimista mas atualiza id, status, sent_at, external_id)
4. On UPDATE (status sent→failed etc): merge em row existente
5. `fetchMore`: cursor `created_at` do oldest

#### Acceptance Criteria

```gherkin
Given operator envia mensagem (otimista local com client_message_id=X, status='sending')
When server retorna 201 + canal Realtime emite INSERT com client_message_id=X
Then UI mostra exatamente 1 bubble (não duplica)
And bubble agora tem real id + status='sending' (vai virar 'sent' em outro Realtime UPDATE)
```

```gherkin
Given thread com 200 mensagens
When abre conversa
Then carrega últimas 50 (lazy)
And scroll up dispara fetchMore das 50 anteriores
```

```gherkin
Given mensagem inbound chega via worker
When INSERT no DB
Then UI mostra novo bubble no fim em <2s
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | realtime | Dedup otimista vs server | Playwright: send → observa 1 bubble |
| t2 | realtime | Inbound chega | Trigger worker, observa DOM |
| t3 | pagination | fetchMore | Scroll up, verifica chamada |
| t4 | rls | Org B não recebe | idem |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_hook
    id: "useMessagesRealtime"
    signature: "(convId) => { messages, isLoading, hasMore, fetchMore }"
  - type: realtime_channel
    id: "messages-{conv_id}"
    table: "messages"
    filter: "conversation_id=eq.{conv_id}"
```

#### Definition of Done
- [ ] ACs passam
- [ ] Commit `feat(EPIC-03): useMessagesRealtime hook with dedup [wave 9]`

---

### S-03.10 — `<ConversationList>` component (search + filtros + virtualização)

**Points**: 4 | **Priority**: P0 | **Deps**: S-03.08 | **FR refs**: Design system 06 ConversationItem, Screen flow 02 jornada 1

#### Contexto
Coluna esquerda da inbox. Header: search input + dropdown filtros (todas/não lidas/abertas/resolvidas/minhas). Body: lista virtualizada (`@tanstack/react-virtual`) — projetada pra 10k items. Cada item: `<ConversationItem>` (avatar+name+last_message_preview+timestamp+unread_badge+status_indicator). Click → navega `/app/inbox/[id]`. `useMarkAsRead` dispara após 1.5s focus. Empty state quando lista vazia.

#### Files to create
- `components/inbox/ConversationList.tsx`
- `components/inbox/ConversationItem.tsx`
- `components/inbox/ConversationFilters.tsx`
- `components/inbox/ConversationSearch.tsx`
- `hooks/useMarkAsRead.ts`
- `app/(app)/inbox/page.tsx` — usa ConversationList + thread vazio
- `tests/inbox/list.spec.ts`

#### Implementation steps
1. `useConversationsRealtime({ filter, query })` (search é client-side por enquanto; futura migração pra server)
2. `useVirtualizer` com itemSize=72px
3. Filter logic:
   - `all`: todas
   - `unread`: `unread_count > 0`
   - `open`: `status='open'`
   - `resolved`: `status='resolved'`
   - `mine`: `assigned_to=user.id`
4. Search: debounce 200ms, filter por contact.name OR last_message_text
5. ConversationItem styling conforme design-system 06
6. `useMarkAsRead`: timer 1500ms quando `convId` ativo; chama `POST /api/v1/conversations/[id]/mark-read` (helper minimal nesta wave)

#### Files to modify
- `app/(app)/layout.tsx` — adicionar item "Inbox" na sidebar (se não tem ainda)

#### Acceptance Criteria

```gherkin
Given inbox com 5 conversas
When acessa /app/inbox
Then 5 ConversationItem renderizados ordenados por last_message_at desc
```

```gherkin
Given filtro 'unread' selecionado
When 3 conversas têm unread_count > 0
Then mostra apenas as 3
```

```gherkin
Given busca "joão"
When digita
Then filtra após 200ms para conversas com contact.name LIKE %joão% OR last_message_text LIKE %joão%
```

```gherkin
Given lista com 1000 conversas
When abre inbox
Then DOM tem ~15 items renderizados (virtualização)
And scroll é 60fps
```

```gherkin
Given clico em conversation card
When click
Then navega /app/inbox/[id]
And após 1500ms unread_count = 0 (mark-as-read)
```

```gherkin
Given empty state (0 conversas)
When acessa
Then mensagem "Nenhuma conversa ainda" + ilustração
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Lista renderiza | Playwright getByTestId conversation-item count=5 |
| t2 | ui | Filtro funciona | Click filter, verifica count |
| t3 | ui | Search debounced | Type, espera 200ms, verifica filter |
| t4 | perf | Virtualização 1000 items | Inject 1000, snapshot DOM nodes count <30 |
| t5 | flow | Click → navigate | Click, verifica URL |
| t6 | api | Mark-as-read fires | Network tab |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_component
    id: "<ConversationList>"
    props: "{ activeId?: string }"
  - type: react_component
    id: "<ConversationItem>"
    props: "{ conversation: Conversation, isActive: boolean }"
  - type: react_hook
    id: "useMarkAsRead"
    signature: "(convId) => void (auto-fires on focus 1.5s)"
  - type: route
    id: "/app/inbox"
```

#### Definition of Done
- [ ] ACs passam
- [ ] Commit `feat(EPIC-03): ConversationList with filters + virtualization [wave 10]`

---

### S-03.11 — `<ChatThread>` + `<MessageBubble>` por type

**Points**: 5 | **Priority**: P0 | **Deps**: S-03.09, S-03.10 | **FR refs**: Design system 06 ChatThread, MessageBubble; Screen flow 02

#### Contexto
Coluna central. Header: contact avatar+name+last_seen, botões `Eu cuido` (se unclaimed) e `Resolver` (se claimed). Scrollable: bubbles ordenados ASC por created_at, agrupados por dia (separator "Hoje", "Ontem", "12 abr"). Auto-scroll bottom on new msg unless user scrolled up. Typing indicator (de S-03.11 hook) na parte inferior. MessageBubble por type:
- `text`: bubble com body
- `image`: thumbnail + lightbox click
- `video`: player inline (HTML5)
- `audio`: player WhatsApp-style (waveform opcional)
- `document`: card com filename + download
- `location`: mini-map ou link
- `reaction`: emoji float anchor à msg pai
- `system`: centered gray (ex: "Conversation resolved by Maria")

Status indicator (sending/sent/failed) + timestamp + retry button em failed.

#### Files to create
- `components/inbox/ChatThread.tsx`
- `components/inbox/ChatHeader.tsx`
- `components/inbox/MessageBubble.tsx`
- `components/inbox/bubbles/TextBubble.tsx`
- `components/inbox/bubbles/ImageBubble.tsx`
- `components/inbox/bubbles/VideoBubble.tsx`
- `components/inbox/bubbles/AudioBubble.tsx`
- `components/inbox/bubbles/DocumentBubble.tsx`
- `components/inbox/bubbles/LocationBubble.tsx`
- `components/inbox/bubbles/ReactionBubble.tsx`
- `components/inbox/bubbles/SystemBubble.tsx`
- `components/inbox/TypingIndicator.tsx`
- `components/inbox/DaySeparator.tsx`
- `hooks/useTyping.ts` — broadcast presence + listen
- `app/(app)/inbox/[id]/page.tsx`
- `tests/inbox/thread.spec.ts`

#### Implementation steps
1. Page `[id]`: layout 3 colunas (List | Thread | SidePanel) — SidePanel placeholder pra S-03.13
2. ChatHeader: useConversation, useClaimConversation, useResolveConversation
3. ChatThread: useMessagesRealtime → group por day → render bubbles
4. MessageBubble switch por type, despacha pra subcomponent
5. Auto-scroll: ref no container, scrollTop=scrollHeight em new msg, mas só se estava no bottom (threshold 100px)
6. useTyping: presence canal, broadcast `{ user_id, isTyping }` debounced 1s; listen mostra "Cliente está digitando..."
7. Failed bubble: clica botão "tentar novamente" → re-enqueue (POST /messages com mesmo client_message_id, idempotente)

#### Acceptance Criteria

```gherkin
Given conversation com 3 mensagens (text, image, audio)
When abre
Then 3 bubbles render corretos por type
And ordem cronológica ASC
```

```gherkin
Given mensagens de hoje e ontem
When render
Then separators "Hoje" e "Ontem" aparecem
```

```gherkin
Given conversation unclaimed
When abre
Then header mostra botão "Eu cuido"
And clicar dispara claim → vira "Resolver"
```

```gherkin
Given mensagem failed
When click "tentar novamente"
Then re-POST com mesmo client_message_id
And status volta a 'sending'
```

```gherkin
Given outro user/cliente está digitando
When typing presence chega
Then "Está digitando..." aparece
```

```gherkin
Given user scrollou pra cima
When nova msg chega
Then NÃO auto-scroll (preserva contexto leitura)
And badge "↓ 1 nova" aparece
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | 8 types render | Fixture com 1 de cada type, snapshot |
| t2 | ui | Day separator | Mensagens de 2 dias, verificar separator |
| t3 | ui | Auto-scroll bottom | Send msg, verificar scrolled to bottom |
| t4 | ui | Preserva scroll | Scroll up, nova msg, verifica position |
| t5 | flow | Claim button | Click, verifica API + UI mudou |
| t6 | flow | Retry failed | Click, verifica POST |
| t7 | realtime | Typing indicator | Trigger presence, observa DOM |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_component
    id: "<ChatThread>"
    props: "{ conversationId: string }"
  - type: react_component
    id: "<MessageBubble>"
    props: "{ message: Message, isOwn: boolean }"
  - type: react_hook
    id: "useTyping"
    signature: "(convId) => { sendTyping, peerTyping }"
  - type: realtime_channel
    id: "typing-{conv_id}"
    transport: "presence"
  - type: route
    id: "/app/inbox/[id]"
```

#### Definition of Done
- [ ] ACs passam
- [ ] Commit `feat(EPIC-03): ChatThread + 8 bubble types + typing [wave 11]`

---

### S-03.12 — `<Composer>` + useSendMessage (Pattern A optimistic)

**Points**: 4 | **Priority**: P0 | **Deps**: S-03.07, S-03.11 | **FR refs**: Spec 09 Pattern A, Design system 06 Composer

#### Contexto
Input do operador. Layout: paperclip (abre file picker) + textarea autosize + send button (Enter envia, Shift+Enter quebra linha). Suporta drag-drop de arquivo. Pattern A: ao submit, gera `client_message_id=crypto.randomUUID()`, insert otimista no cache `useMessagesRealtime` com status='sending', POST /messages com Idempotency-Key. Server INSERT chega via Realtime → dedup por client_message_id substitui a row mantendo posição. Em erro 4xx/5xx → marca local como 'failed' com retry.

Anexos: 1) chama `useUpload` → recebe storage_path, 2) cria optimistic bubble já com preview do arquivo (URL.createObjectURL), 3) POST /messages com `media_storage_path`.

#### Files to create
- `components/inbox/Composer.tsx`
- `components/inbox/AttachmentPreview.tsx`
- `hooks/useSendMessage.ts`
- `tests/inbox/send.spec.ts`

#### Implementation steps
1. Composer state: `body`, `attachments[]`, `isSending`
2. Send flow:
   - Build `client_message_id`
   - Optimistic insert via `queryClient.setQueryData` em `messages-{conv_id}` cache
   - Pra cada attachment: useUpload → storage_path
   - POST /messages com Idempotency-Key=client_message_id
   - Sucesso: nada (Realtime confirma)
   - Erro: setQueryData → marca status='failed' com error_message
3. Enter sends, Shift+Enter newline
4. Drag-drop: handle `onDrop` → adicionar a attachments
5. Paperclip → input file hidden → onChange adiciona

#### Acceptance Criteria

```gherkin
Given Composer com texto "olá"
When pressiono Enter
Then bubble aparece imediatamente (status sending) em <50ms
And POST /messages disparado com Idempotency-Key
And quando worker confirma → bubble vira 'sent' (sem flicker, sem duplicar)
```

```gherkin
Given network offline
When pressiono Enter
Then bubble vira 'failed' com retry button
And clicar retry re-POST com mesmo client_message_id (idempotente)
```

```gherkin
Given drag-drop arquivo .jpg
When solto na área
Then thumbnail preview aparece
And ao Enter: upload-sign → PUT → POST /messages com media_storage_path
And bubble image aparece otimista com URL.createObjectURL
And quando real chega via Realtime, substitui sem flicker
```

```gherkin
Given Shift+Enter
When pressiono
Then quebra linha no textarea (não envia)
```

```gherkin
Given textarea vazio
When pressiono Enter
Then nada acontece (não envia mensagem em branco)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Optimistic <50ms | Playwright: type+Enter, measure DOM update |
| t2 | flow | Send + confirm | Type+Enter, espera worker, verifica status sent |
| t3 | flow | Failed + retry | Disconnect, send, reconnect, retry |
| t4 | flow | Anexo image | Drop file, verifica upload+send |
| t5 | ui | Shift+Enter newline | keyboard test |
| t6 | ui | Empty Enter no-op | keyboard test |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_component
    id: "<Composer>"
    props: "{ conversationId: string, disabled?: boolean }"
  - type: react_hook
    id: "useSendMessage"
    signature: "(convId) => { sendMessage(input), isSending }"
    pattern: "Pattern A optimistic via client_message_id"
```

#### Definition of Done
- [ ] ACs passam
- [ ] Commit `feat(EPIC-03): Composer + optimistic send (Pattern A) [wave 12]`

---

### S-03.13 — `<CRMSidePanel>` (Contact + Deal + Notes + Timeline)

**Points**: 4 | **Priority**: P0 | **Deps**: S-03.11 | **FR refs**: Design system 06 CRMSidePanel; Screen flow 02

#### Contexto
Coluna direita. 4 sections collapsible:
- **ContactSection**: avatar, name (inline edit), tags, phone, email, custom fields, "ver perfil completo" (link futuro EPIC-05)
- **DealSection**: lista de deals abertos do contact; cada um com stage selector inline (mover stage com optimistic — feedback EPIC-04)
- **NotesSection**: lista de notas (privadas do operador) + textarea pra nova nota → POST /api/v1/notes
- **TimelineSection**: últimas N entries do `event_log` filtrado por contact_id (tipo, autor, timestamp)

Esta wave faz a UI consumindo APIs minimal — full APIs em EPIC-04/EPIC-05. Aqui criamos:
- `GET /api/v1/contacts/[id]` (minimal — full em EPIC-05)
- `GET /api/v1/contacts/[id]/deals` (minimal)
- `GET /api/v1/contacts/[id]/notes`, `POST /api/v1/notes`
- `GET /api/v1/contacts/[id]/timeline` (lê event_log)
- `POST /api/v1/deals/[id]/move` (minimal — full em EPIC-04)

#### Files to create
- `components/inbox/CRMSidePanel.tsx`
- `components/inbox/sections/ContactSection.tsx`
- `components/inbox/sections/DealSection.tsx`
- `components/inbox/sections/NotesSection.tsx`
- `components/inbox/sections/TimelineSection.tsx`
- `app/api/v1/contacts/[id]/route.ts`
- `app/api/v1/contacts/[id]/deals/route.ts`
- `app/api/v1/contacts/[id]/notes/route.ts`
- `app/api/v1/notes/route.ts`
- `app/api/v1/contacts/[id]/timeline/route.ts`
- `app/api/v1/deals/[id]/move/route.ts`
- `hooks/useContact.ts`, `useDealsByContact.ts`, `useNotes.ts`, `useTimeline.ts`
- `tests/inbox/sidepanel.spec.ts`

#### Implementation steps
1. Sections collapsible com state localStorage `sidepanel-{section}-collapsed`
2. ContactSection inline edit name: PATCH /api/v1/contacts/[id]
3. DealSection: select de stage → optimistic UI → POST /deals/[id]/move (registra `event.deal.stage_changed`, full handler em EPIC-04)
4. NotesSection: textarea → Cmd+Enter envia → optimistic insert
5. TimelineSection: paginação simples, lê event_log

#### Acceptance Criteria

```gherkin
Given conversation aberta
When carregada
Then sidepanel mostra contact info, deals, notes, timeline
```

```gherkin
Given operator edita name do contact
When salva
Then PATCH dispara, UI atualiza otimista
```

```gherkin
Given deal "Lead → Qualified"
When operator muda dropdown pra "Qualified"
Then UI updated
And POST /deals/[id]/move com from='Lead' to='Qualified'
```

```gherkin
Given operator adiciona nota
When Cmd+Enter
Then POST /notes
And nota aparece imediatamente no topo da lista
```

```gherkin
Given event_log com 20 events do contact
When TimelineSection render
Then mostra últimos 10
And "ver mais" carrega próximos 10
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | 4 sections render | Playwright |
| t2 | flow | Edit name | Click edit, type, save, verify PATCH |
| t3 | flow | Move deal | Click select, choose, verify POST |
| t4 | flow | Add note | Type+Cmd+Enter, verify in DOM + DB |
| t5 | flow | Timeline pagination | Click "ver mais" |
| t6 | rls | Cross-tenant | Org B contact ID → 404 |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_component
    id: "<CRMSidePanel>"
    props: "{ contactId: string }"
  - type: api_route
    id: "GET /api/v1/contacts/[id]"
  - type: api_route
    id: "POST /api/v1/notes"
  - type: api_route
    id: "POST /api/v1/deals/[id]/move"
    note: "Minimal handler; full impl em EPIC-04"
```

#### Definition of Done
- [ ] ACs passam
- [ ] Commit `feat(EPIC-03): CRMSidePanel with 4 sections [wave 13]`

---

### S-03.14 — Atalhos de teclado (j/k/r/e/a/?/Esc)

**Points**: 3 | **Priority**: P0 | **Deps**: S-03.12, S-03.13 | **FR refs**: Design system 06; Screen flow 02 jornada 1; AT-08 (atalhos)

#### Contexto
Velocidade de operador. Bindings globais na inbox (não disparam quando dentro de input/textarea exceto onde explicitamente ok):
- `j` — próxima conversa na lista
- `k` — anterior
- `r` — reply (foca textarea do Composer)
- `e` — resolve (chama mutation)
- `a` — claim (assigna pra mim)
- `?` — abre modal de cheatsheet
- `Esc` — fecha modal aberto / sai de input

Implementação via `useHotkeys` (lib `react-hotkeys-hook` ou custom). Fora de inputs (`input,textarea,[contenteditable]`) por default.

#### Files to create
- `hooks/useInboxShortcuts.ts`
- `components/inbox/ShortcutsModal.tsx`
- `tests/inbox/shortcuts.spec.ts`

#### Implementation steps
1. `useInboxShortcuts({ conversations, activeId })` registra os bindings
2. j/k: calcula prev/next index → router.push(`/app/inbox/${nextId}`)
3. r: ref no Composer textarea → focus()
4. e: chama useResolveConversation
5. a: chama useClaimConversation
6. ?: setModalOpen(true)
7. Esc: setModalOpen(false) ou blur active input

#### Acceptance Criteria

```gherkin
Given inbox com 5 conversations, activeId=conversa[2]
When pressiono j
Then activeId vira conversa[3], URL atualiza
```

```gherkin
Given foco fora de input
When pressiono r
Then Composer textarea recebe focus
```

```gherkin
Given conversation aberta unclaimed
When pressiono a
Then claim dispara
And se 200 → header atualiza
```

```gherkin
Given conversation claimed
When pressiono e
Then resolve dispara
```

```gherkin
Given pressiono ?
When
Then modal "Atalhos" abre listando todos
And Esc fecha
```

```gherkin
Given foco em textarea do Composer
When pressiono j
Then NADA acontece (não trapped)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | kbd | j/k navega | Playwright keyboard |
| t2 | kbd | r foca composer | keyboard + check activeElement |
| t3 | kbd | a claim | keyboard, verify API |
| t4 | kbd | e resolve | keyboard, verify API |
| t5 | kbd | ? modal | keyboard, verify modal visible |
| t6 | kbd | Esc fecha | open modal, Esc, verify closed |
| t7 | kbd | Não dispara em input | focus textarea, j → no nav |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_hook
    id: "useInboxShortcuts"
    signature: "({ conversations, activeId }) => void"
  - type: react_component
    id: "<ShortcutsModal>"
```

#### Definition of Done
- [ ] ACs passam
- [ ] Commit `feat(EPIC-03): keyboard shortcuts [wave 14]`

---

### S-03.15 — Janela 24h badge + STOP detection

**Points**: 2 | **Priority**: P0 | **Deps**: S-03.11 | **FR refs**: Business rule W-12 (24h), W-08 (STOP), AT-06

#### Contexto
Duas regras de compliance/UX:

**(A) Janela 24h**: WhatsApp Business permite reply outbound livre se houve inbound nas últimas 24h. Se `last_inbound_at < now - 23h` → badge vermelho "⚠ Janela fechando" no header da conversa (avisa ANTES de fechar). Se já fechou (>24h), Composer mostra warning "Fora da janela 24h — só template" e o worker (S-03.04) já bloqueia. Badge calculado client-side a partir de `last_inbound_at`.

**(B) STOP detection**: regex `^(STOP|SAIR|PARAR|CANCELAR)$` (case-insensitive, trim) em mensagens inbound (worker S-03.02 já tem o gancho). Quando match: UPDATE contacts SET is_blocked=true, blocked_reason='stop_keyword', blocked_at=now(); INSERT system message na conversation ("Cliente solicitou opt-out"); emit `contact.blocked`. UI: bubble system na thread + Composer disabled com warning "Contato bloqueado por opt-out (LGPD/GDPR)".

#### Files to create
- `lib/messaging/stop-detector.ts` — `isStopKeyword(text): boolean`
- `components/inbox/Window24hBadge.tsx`
- `components/inbox/BlockedBanner.tsx`
- `tests/messaging/stop.spec.ts`
- `tests/ui/window-24h.spec.ts`

#### Files to modify
- `workers/whatsapp-inbound-worker.ts` (de S-03.02) — após persist message inbound, run stop detector → if match → block contact + emit
- `components/inbox/ChatHeader.tsx` (de S-03.11) — montar Window24hBadge
- `components/inbox/Composer.tsx` (de S-03.12) — desabilitar se contact.is_blocked

#### Implementation steps
1. `isStopKeyword`: regex `/^\s*(STOP|SAIR|PARAR|CANCELAR)\s*$/i`
2. Worker hook: após persistir inbound text, se match → tx: UPDATE contacts is_blocked, INSERT system message ("Cliente solicitou opt-out — conversa bloqueada"), emit event
3. Window24hBadge: calcula minutos desde last_inbound_at, mostra se 23h≤Δ<24h amarelo "⚠ Janela 24h fechando em Xm"; se Δ≥24h vermelho "Janela 24h fechada"
4. Composer: se `contact.is_blocked` → disabled + tooltip "Contato bloqueado"
5. BlockedBanner topo da thread quando blocked

#### Acceptance Criteria

```gherkin
Given conversation com last_inbound_at = now - 23h30min
When abre conversa
Then Window24hBadge mostra "Janela fechando em 30m" amarelo
```

```gherkin
Given last_inbound_at = now - 25h
When abre
Then badge vermelho "Janela 24h fechada"
And Composer warning "Fora da janela — só template"
```

```gherkin
Given inbound message body="STOP"
When worker processa
Then contact.is_blocked = true
And blocked_reason = 'stop_keyword'
And system message inserida ("Cliente solicitou opt-out")
And event 'contact.blocked' emitido
```

```gherkin
Given inbound "stop  " (lowercase + trailing spaces)
When worker processa
Then também detecta (case-insensitive + trim)
```

```gherkin
Given inbound "Eu quero parar de receber esses cupons"
When worker processa
Then NÃO bloqueia (não é match exato; só palavra única)
```

```gherkin
Given contact is_blocked=true
When operator abre conversa
Then BlockedBanner topo + Composer disabled
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | regex | 4 variantes match | Unit test stop-detector |
| t2 | regex | Frases não match | Unit |
| t3 | worker | Bloqueio + system msg | Inject inbound STOP, run worker, verify DB |
| t4 | event | contact.blocked emitido | Query event_log |
| t5 | ui | Window24hBadge amarelo @23h30 | Mock data, snapshot |
| t6 | ui | Window24hBadge vermelho @25h | Mock data |
| t7 | ui | Composer disabled if blocked | Mock contact, verify |

#### Architecture contracts emitted

```yaml
exposes:
  - type: business_rule
    id: "W-08-stop-detection"
  - type: business_rule
    id: "W-12-24h-window-ui"
  - type: domain_event
    id: "contact.blocked"
    payload: "{ contact_id, reason: 'stop_keyword' }"
  - type: react_component
    id: "<Window24hBadge>"
  - type: react_component
    id: "<BlockedBanner>"
```

#### Decisões a registrar
- STOP regex é match exato (palavra isolada). Frases livres NÃO bloqueiam — evita falsos positivos. LGPD opt-out por frase livre fica em EPIC-08 com fluxo manual.
- Janela 24h é UX warning; bloqueio real está no worker S-03.04 (defense in depth).

#### Definition of Done
- [ ] ACs passam
- [ ] Commit `feat(EPIC-03): 24h window badge + STOP detection [wave 15]`

---

## 6. Regression Suite Cumulativo (esperado ao final)

| Categoria | # de tests | Origem |
|---|---|---|
| API contracts | 18 | S-03.01, .03, .05, .06, .07, .13 |
| Webhook idempotência + HMAC | 6 | S-03.01 |
| Workers (inbound + outbound + rate-limit + 24h + retries) | 14 | S-03.02, .04 |
| RLS cross-tenant | 8 | toda story |
| Realtime (inbox + messages + typing + dedup) | 10 | S-03.08, .09, .11 |
| Optimistic UI + Pattern A rollback | 6 | S-03.12 |
| UI rendering (List + Thread + Bubbles + SidePanel + Composer) | 18 | S-03.10, .11, .12, .13 |
| Atalhos teclado | 7 | S-03.14 |
| Compliance (24h + STOP + bloqueio UX) | 7 | S-03.15 |
| **Total** | **94** | |

## 7. Riscos & Mitigações

| Risco | Severidade | Mitigação |
|---|---|---|
| Worker inbound duplica contact em race condition | Alto | Insert ON CONFLICT DO NOTHING + SELECT fallback; test concurrent (S-03.02 t3) |
| WAHA muda contrato de webhook entre versões | Médio | Adapter `lib/messaging/waha-client.ts` isolado; pin version WAHA |
| Realtime perde subscription e UI fica stale | Alto | Reconnect logic em `useRealtimeChannel` (EPIC-00); polling fallback a cada 60s como safety net |
| Pattern A dedup falha → bubbles duplicam | Alto | Test com 50 sends concorrentes (S-03.09 t1); chave canônica `client_message_id` em ambos lados |
| Rate limit per-session vaza tokens entre orgs | Crítico | Token bucket por `session_id` (não global); test cross-tenant em S-03.04 |
| HMAC timing attack | Médio | `crypto.timingSafeEqual` obrigatório; test t4 em S-03.01 |
| Storage signed URL vazada permite upload arbitrário | Médio | Path inclui org_id; expiração 5min; mime allowlist no sign |
| Atalhos quebram acessibilidade (screen readers) | Médio | Bindings só fora de input/textarea; modal `?` lista todos |
| 24h badge calculado errado em timezones | Baixo | Usa `last_inbound_at` UTC; client converte só pra display |

## 8. Decisões arquiteturais novas

- **ADR-EPIC03-01**: Idempotência de mensagens via `unique(org_id, external_id)` (inbound) e `unique(org_id, client_message_id)` (outbound). Capture 23505 retorna OK.
- **ADR-EPIC03-02**: Pattern A optimistic — frontend gera `client_message_id` (UUID v4) que é também `Idempotency-Key` HTTP. Realtime dedup substitui row otimista.
- **ADR-EPIC03-03**: HMAC-SHA512 com `crypto.timingSafeEqual`; secret per-tenant em `whatsapp_sessions.webhook_secret`.
- **ADR-EPIC03-04**: Workers via pgmq (não BullMQ/Redis) — alinhamento com Spec 07.
- **ADR-EPIC03-05**: Storage path convention `{org_id}/{conversation_id}/{uuid}-{filename}` em bucket `tenant-{org_id}`.
- **ADR-EPIC03-06**: Atalhos `j/k/r/e/a/?/Esc` canônicos pra inbox; outras telas podem reusar mas devem documentar.
- **ADR-EPIC03-07**: STOP detection é match exato regex (palavra isolada). Frases livres NÃO bloqueiam.
- **ADR-EPIC03-08**: Realtime canais nomeados `{resource}-{scope_id}` (`inbox-{org}`, `messages-{conv}`, `typing-{conv}`).

## 9. Anexos

- Specs: 03 (todo), 04 §5-8, 07 (todo), 09 §6-7
- Design system: 06 (ConversationItem, ChatThread, MessageBubble, Composer, CRMSidePanel)
- Screen flow: 02 jornada 1 (Operador atende)
- Business rules: W-01, W-02, W-03, W-04, W-05, W-08, W-12; AT-01, AT-04, AT-06, AT-08
- Reconciliation log: aplica ADRs novos acima ao log no fim do epic

## 10. Wave Completion Log

| Wave | Scope | Commits |
|---|---|---|
| 1-6 | Schema migrations (conversations, messages, channel_sessions, RLS, triggers); Combo-A | EPIC-03 Combo-A commits |
| 7-12 | API endpoints (list/get/patch, claim/release/close, messages send/list, WAHA webhook) + components (`InboxLayout`, `ConversationList`, `ChatThread`, `Composer`, `ConversationHeader`, `CRMSidePanel`, `InboxKeyboardShortcuts`) + hooks (`useConversationsRealtime`, `useMessagesRealtime`, `useSendMessage`, `useClaimConversation`, `useReleaseConversation`, `useCloseConversation`); Combo-B | EPIC-03 Combo-B commits |
| 13 | Page wiring: `app/app/inbox/page.tsx` (server) + `[id]/page.tsx` (deep-link redirect) + `initialSelectedId` prop em `InboxLayout` | feat(EPIC-03): inbox page wiring + seed mock conversations [waves 13-15] |
| 14 | Seed 4 mock conversations + 14 messages cobrindo `open` (não atribuído João), `open` atribuído (Maria), `pending` (Pedro AI), `resolved` (Ana) — link com 5 contatos do EPIC-05 + channel_session existente | mesmo commit |
| 15 | Sidebar nav já apontando pra `/app/inbox` (sem mudança); typecheck/lint/test:unit verde; smokes 307 OK | mesmo commit |

**Deferred**: Send/receive WhatsApp end-to-end requer WAHA Plus rodando + número WhatsApp autenticado na sessão `74ca5a45-181a-4f74-8da4-7144bf4cfe65`. UI/API/seed estão prontos; basta plugar a sessão real.

**Adaptações de seed**: o check constraint atual de `conversations.status` aceita apenas `open|pending|resolved` (não `claimed|ai_handling|closed`) e `messages.sent_via` aceita `crm|external_device|automation|ai` (não `system|user`). Mapeamento adotado: `claimed→open` com `assigned_to_user_id` set, `ai_handling→pending`, `closed→resolved`; `system→external_device`, `user→crm`. Há divergência pre-existente entre constraint do DB e código da API claim — fora do escopo deste combo, registrar pra hardening.
