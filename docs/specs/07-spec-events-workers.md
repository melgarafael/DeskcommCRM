---
title: "Spec Técnica 07 — Event Log + Workers + Crons (transversal)"
parent: 00-prd-master.md
type: spec
scope: transversal
status: draft
version: 1.0.0
owner: arquitetura
created_at: 2026-04-28
related:
  - 01-prd-platform-base.md
  - 02-prd-customer-360.md
  - 03-prd-whatsapp-waha.md
  - 04-prd-pipeline-attendance.md
  - 05-prd-ai-rag-handoff.md
  - 06-prd-nuvemshop-lgpd.md
  - research/reference-synthesis.md
---

# Spec 07 — Event Log + Workers + Crons (transversal)

> Esta spec define o **bus interno** do SonghaiCRM: como módulos publicam eventos no banco, como workers consomem, quais crons rodam no Vercel, como tratamos retries, dead-letter, idempotência e observabilidade. É **transversal** — todos os outros sub-PRDs (02–06) emitem ou consomem deste bus.

---

## 1. Visão Geral & Princípios

### 1.1 Por que existe

O sistema é multi-módulo, com side-effects assíncronos pesados:
- mensagens recebidas precisam disparar IA, sentiment, automações, CRM updates;
- pedidos pagos precisam atualizar lead, criar tag, registrar venda;
- requisições LGPD precisam orquestrar export D+7 e redact D+15;
- webhooks externos precisam de retry com backoff;
- reindexação RAG ocorre quando produtos mudam.

Acoplar tudo em ServerActions síncronas seria frágil: latência alta, falhas em cascata, sem retry, sem auditoria. Acoplar em **triggers que fazem HTTP** é o anti-pattern explicitamente proibido pela `reference-synthesis.md` ("trigger faz HTTP" → bloqueia transação, falha silenciosa, deadlock potencial em alta carga).

A solução adotada:

> **Triggers e ServerActions só escrevem em `event_log` (transação local). Workers leem `event_log` e fazem o resto fora da transação.**

### 1.2 Princípios canônicos

1. **Trigger NUNCA faz HTTP.** Trigger pode: `INSERT INTO event_log`, `UPDATE` outra tabela, `RAISE NOTICE`. Não pode: `pg_net.http_post`, chamar Edge Function, falar com fila externa.
2. **Event log é o bus interno.** Toda integração assíncrona entre módulos passa pelo `event_log`. Não criamos N tabelas-fila por módulo.
3. **Naming `{entity}.{action}` snake_case.** Sempre. `lead.stage_changed`, nunca `LeadStageChanged` ou `lead-stage-changed`.
4. **Idempotência first-class.** Workers podem ser invocados N vezes pro mesmo evento; side-effects devem ser idempotentes.
5. **Retry com backoff exponencial + DLQ.** Falha transitória ≠ falha permanente. Após N tentativas, vai pra DLQ pra inspeção humana.
6. **Observability obrigatória.** Cada evento tem `event_id` correlato a `request_id` (audit_log) e `trace_id` (Sentry).
7. **Workers idempotentes e stateless.** Podem ser killed e restarted a qualquer momento sem perda.
8. **Pull > Push.** Preferimos pull-loop (`FOR UPDATE SKIP LOCKED`) sobre Realtime pra paths críticos. Realtime é pra UI.

### 1.3 Topologia

```
                         ┌──────────────────────────┐
   ServerAction / RPC ───▶│  event_log (Postgres)   │◀── Trigger SQL
                         └──────────────┬───────────┘
                                        │
                ┌───────────────────────┼────────────────────────┐
                │                       │                        │
        pg_boss queue            Pull-loop workers        Realtime (UI)
        (specialized jobs)       (FOR UPDATE SKIP         (live updates,
                                  LOCKED, batch)           não crítico)
                │                       │
                ▼                       ▼
        Vercel Cron / Background      Side-effects:
        Functions                     - WAHA send
                                      - AI bot
                                      - Webhooks out
                                      - Nuvemshop sync
                                      - LGPD cascade
                                      - RAG reindex
```

---

## 2. Schema SQL

### 2.1 Tabela `event_log`

```sql
create table public.event_log (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  event_type      text not null,                 -- ex: "lead.stage_changed"
  entity_kind     text not null,                 -- ex: "lead", "message", "order"
  entity_id       uuid,                          -- nullable (eventos system.* podem não ter)

  payload         jsonb not null default '{}'::jsonb,
  metadata        jsonb not null default '{}'::jsonb,
  -- metadata padrão: { request_id, actor_id, source, trace_id, idempotency_key, schema_version }

  consumed_by     text[] not null default '{}',  -- nomes de workers que já processaram
  attempts        smallint not null default 0,
  last_error      text,
  next_attempt_at timestamptz,                   -- backoff scheduling
  status          text not null default 'pending'
                  check (status in ('pending','processing','done','dead')),

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint event_type_format
    check (event_type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$')
);

comment on table public.event_log is
  'Bus interno do CRM. Triggers e ServerActions inserem aqui. Workers consomem.';
```

**Notas de design:**
- `consumed_by text[]` em vez de tabela de junção: eventos têm 1–5 consumers tipicamente; array é mais barato em leitura/escrita. Se passar de ~20 consumers por evento, refatorar pra `event_consumption(event_id, worker, consumed_at)`.
- `status` é redundante a `consumed_by` mas facilita queries de DLQ (`status = 'dead'`).
- `next_attempt_at` permite agendar retry sem job externo: worker filtra `where next_attempt_at <= now()`.

### 2.2 Indexes

```sql
-- 1. Pull principal (workers): pendentes por org, ordem de criação
create index event_log_pending_idx
  on public.event_log (organization_id, created_at)
  where status = 'pending' and (next_attempt_at is null or next_attempt_at <= now());

-- 2. Por tipo de evento (filtro de worker específico)
create index event_log_org_type_idx
  on public.event_log (organization_id, event_type, created_at desc);

-- 3. DLQ inspection
create index event_log_dead_idx
  on public.event_log (organization_id, created_at desc)
  where status = 'dead';

-- 4. Lookup por entidade (debug, audit)
create index event_log_entity_idx
  on public.event_log (entity_kind, entity_id, created_at desc);

-- 5. Consumed_by GIN (raro mas útil pra "quais eventos worker X processou")
create index event_log_consumed_by_gin
  on public.event_log using gin (consumed_by);
```

### 2.3 Particionamento e retenção

**Estratégia:** partição **mensal por `created_at`** + retenção quente de **90 dias**.

```sql
-- Tabela mãe partitioned (alternativa: criar desde o início particionada)
-- Para MVP: começamos não-particionado e migramos quando volume > 5M rows.

-- Trigger de retenção: archive worker move > 90d pra cold storage (S3/Storage)
-- e DELETE da tabela quente. Detalhado em §6.9 (audit-archive-worker, mesmo padrão).
```

**Heurística:** se `count(*) from event_log > 10M` ou `pg_total_relation_size > 20GB`, migrar pra `partition by range (created_at)` com partição mensal.

### 2.4 RLS

```sql
alter table public.event_log enable row level security;

-- Tenant isolation: usuário só vê eventos da sua org
create policy event_log_select_own_org on public.event_log
  for select using (organization_id = auth.organization_id());

-- INSERT: apenas service role (workers) ou via funções SECURITY DEFINER
-- ServerActions e triggers usam RPC `emit_event(...)` SECURITY DEFINER
revoke insert, update, delete on public.event_log from authenticated, anon;

-- Workers acessam via service_role key (bypass RLS) → ver §4
```

**Função canônica de emissão:**

```sql
create or replace function public.emit_event(
  p_event_type     text,
  p_entity_kind    text,
  p_entity_id      uuid,
  p_payload        jsonb default '{}'::jsonb,
  p_metadata       jsonb default '{}'::jsonb,
  p_organization_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_event_id uuid;
begin
  v_org_id := coalesce(p_organization_id, auth.organization_id());
  if v_org_id is null then
    raise exception 'emit_event: organization_id obrigatório';
  end if;

  insert into public.event_log
    (organization_id, event_type, entity_kind, entity_id, payload, metadata)
  values
    (v_org_id, p_event_type, p_entity_kind, p_entity_id,
     coalesce(p_payload, '{}'::jsonb),
     coalesce(p_metadata, '{}'::jsonb)
       || jsonb_build_object('emitted_at', extract(epoch from now())))
  returning id into v_event_id;

  return v_event_id;
end $$;
```

---

## 3. Catálogo Canônico de Events

> **Regras:** todo evento tem `event_type` snake_case `{entity}.{action}`, `entity_kind`, `entity_id` (quando aplicável), `payload` documentado, `schema_version` em metadata. Mudança breaking → `schema_version++` e suporte ao schema antigo por 30 dias.

### 3.1 `lead.*`

| event_type | payload mínimo | emitido por | consumido por |
|---|---|---|---|
| `lead.created` | `{ name, source, owner_id?, pipeline_id, stage_id }` | ServerAction `createLead` | webhook-dispatch, audit |
| `lead.updated` | `{ changes: { field: { from, to } } }` | trigger `lead_updated_emit` | webhook-dispatch, audit |
| `lead.stage_changed` | `{ from_stage_id, to_stage_id, automation_run? }` | trigger | automation engine, webhook, audit |
| `lead.won` | `{ value, won_at, reason? }` | RPC `mark_lead_won` | webhook, automation, analytics |
| `lead.lost` | `{ reason, lost_at }` | RPC `mark_lead_lost` | webhook, automation |
| `lead.assigned` | `{ from_owner_id?, to_owner_id }` | trigger `lead_assigned_emit` | notification, webhook |
| `lead.deleted` | `{ soft: true, deleted_by }` | trigger | webhook, audit |

### 3.2 `lead_activity.*`

| event_type | payload | consumido por |
|---|---|---|
| `lead_activity.recorded` | `{ activity_type, lead_id, content_excerpt }` | analytics-aggregator, webhook |

### 3.3 `contact.*`

| event_type | payload | consumido por |
|---|---|---|
| `contact.created` | `{ phone, name?, source }` | rag-indexer (perfil), webhook |
| `contact.merged` | `{ from_contact_id, into_contact_id, merged_fields }` | rag-indexer, audit, webhook |
| `contact.blocked` | `{ reason: 'stop'\|'manual', actor_id? }` | system.send-blocker, webhook |
| `contact.anonymized` | `{ lgpd_request_id, anonymized_fields }` | webhook, audit |

### 3.4 `message.*`

| event_type | payload | consumido por |
|---|---|---|
| `message.received` | `{ direction:'in', conversation_id, contact_id, body, media_urls?, waha_message_id }` | ai-response, ai-sentiment, automation, webhook |
| `message.sent` | `{ direction:'out', conversation_id, contact_id, channel:'whatsapp', body, message_id }` | webhook, analytics |
| `message.delivered` | `{ message_id, delivered_at }` | analytics, webhook |
| `message.read` | `{ message_id, read_at }` | analytics, webhook |
| `message.failed` | `{ message_id, error_code, error_message, retryable: bool }` | recovery worker, alert, webhook |

### 3.5 `conversation.*`

| event_type | payload | consumido por |
|---|---|---|
| `conversation.opened` | `{ conversation_id, contact_id, channel }` | sla-tracker, webhook |
| `conversation.assigned` | `{ from_user_id?, to_user_id, mode:'manual'\|'round_robin' }` | notification, webhook |
| `conversation.resolved` | `{ resolved_by, resolution_note?, duration_s }` | csat-trigger, analytics, webhook |
| `conversation.reopened` | `{ reopened_by, reason? }` | analytics, webhook |

### 3.6 `ai.*`

| event_type | payload | consumido por |
|---|---|---|
| `ai.responded` | `{ conversation_id, message_id, model, tokens_in, tokens_out, cost_cents, latency_ms }` | budget-tracker, analytics |
| `ai.handoff_triggered` | `{ conversation_id, reason, from:'bot', to_user_id? }` | notification, audit, webhook |
| `ai.sentiment_alert` | `{ conversation_id, sentiment:'angry'\|'frustrated', score }` | notification, webhook |
| `ai.budget_warning` | `{ pct_used, daily_budget_cents, current_cents }` | notification (admin), alert |
| `ai.budget_throttled` | `{ daily_budget_cents, current_cents, throttle_until }` | ai-response-worker (skip), alert |

### 3.7 `nuvemshop.*`

| event_type | payload | consumido por |
|---|---|---|
| `nuvemshop.order_created` | `{ order_id, ns_order_id, contact_id?, total_cents }` | crm-sync, webhook |
| `nuvemshop.order_paid` | `{ order_id, paid_at, amount_cents }` | crm-sync (lead.won?), automation, webhook |
| `nuvemshop.order_cancelled` | `{ order_id, cancelled_at, reason? }` | webhook |
| `nuvemshop.order_fulfilled` | `{ order_id, fulfilled_at, tracking? }` | webhook, csat-trigger |
| `nuvemshop.cart_abandoned` | `{ cart_id, contact_id?, value_cents, abandoned_at }` | automation (recovery), webhook |
| `nuvemshop.customer_redact_received` | `{ ns_customer_id, ns_request_id }` | lgpd-redact-worker |
| `nuvemshop.product_synced` | `{ product_id, action:'created'\|'updated'\|'deleted' }` | rag-indexer, webhook |

### 3.8 `lgpd.*`

| event_type | payload | consumido por |
|---|---|---|
| `lgpd.consent_changed` | `{ contact_id, consent_type, granted, source }` | webhook, audit |
| `lgpd.data_request_received` | `{ request_id, request_type:'access'\|'redact', contact_id, channel }` | lgpd-export ou lgpd-redact, audit |
| `lgpd.export_generated` | `{ request_id, export_url_signed, expires_at }` | notification (envia ao titular), webhook |
| `lgpd.redact_applied` | `{ request_id, contact_id, scope:'crm_only'\|'crm_and_nuvemshop' }` | webhook, audit |

### 3.9 `system.*`

Eventos infra/runtime, sem entity_id obrigatório.

| event_type | payload | consumido por |
|---|---|---|
| `system.contact_blocked_by_stop` | `{ contact_id, keyword:'STOP'\|'SAIR' }` | send-blocker (cache invalidate), audit |
| `system.send_blocked` | `{ contact_id, reason, attempted_message_id? }` | analytics, alert |
| `system.window_24h_expired` | `{ conversation_id, contact_id, expired_at }` | template-suggester, automation |

### 3.10 `webhook.*`

| event_type | payload | consumido por |
|---|---|---|
| `webhook.delivery_failed` | `{ subscription_id, event_id, attempt, error, status_code? }` | webhook-dispatch (retry), alert |
| `webhook.subscription_disabled` | `{ subscription_id, reason:'10_consecutive_failures', last_error }` | notification (admin), audit |

---

## 4. Worker Patterns

Três padrões; usar o certo pro caso certo.

### 4.1 Pull-loop com `FOR UPDATE SKIP LOCKED` (PADRÃO)

**Quando usar:** todo worker crítico (mensagens, IA, webhooks, LGPD). É o default.

```typescript
// workers/lib/pull-loop.ts
import { createClient } from '@supabase/supabase-js';

type WorkerHandler<T = unknown> = (event: EventRow) => Promise<void>;

export async function runPullLoop(opts: {
  workerName: string;        // ex: 'whatsapp-send-worker'
  eventTypes: string[];      // ex: ['message.queued']
  batchSize?: number;        // default 25
  pollIntervalMs?: number;   // default 1000
  handler: WorkerHandler;
}) {
  const sb = createClient(URL, SERVICE_ROLE);
  const batch = opts.batchSize ?? 25;

  while (!shutdownRequested()) {
    const { data: events, error } = await sb.rpc('claim_events', {
      p_worker: opts.workerName,
      p_event_types: opts.eventTypes,
      p_limit: batch,
    });

    if (error) { reportError(error); await sleep(5000); continue; }
    if (!events?.length) { await sleep(opts.pollIntervalMs ?? 1000); continue; }

    await Promise.allSettled(events.map(async (ev) => {
      try {
        await opts.handler(ev);
        await sb.rpc('ack_event', { p_event_id: ev.id, p_worker: opts.workerName });
      } catch (err) {
        await sb.rpc('nack_event', {
          p_event_id: ev.id, p_worker: opts.workerName,
          p_error: serializeError(err),
        });
        reportError(err, { event_id: ev.id });
      }
    }));
  }
}
```

**RPC `claim_events` (server-side, atomic):**

```sql
create or replace function public.claim_events(
  p_worker text,
  p_event_types text[],
  p_limit int default 25
) returns setof public.event_log
language plpgsql
security definer
as $$
begin
  return query
  with picked as (
    select id from public.event_log
    where status = 'pending'
      and event_type = any(p_event_types)
      and not (p_worker = any(consumed_by))
      and (next_attempt_at is null or next_attempt_at <= now())
    order by created_at
    limit p_limit
    for update skip locked
  )
  update public.event_log e
     set status = 'processing',
         attempts = attempts + 1,
         updated_at = now()
    from picked
   where e.id = picked.id
  returning e.*;
end $$;
```

**RPCs `ack_event` e `nack_event`:** atualizam `consumed_by`, `status`, computam `next_attempt_at` com backoff (§8).

### 4.2 Realtime consumer (Supabase Realtime)

**Quando usar:** apenas pra **UI** (live updates de pipeline, conversa, dashboard). NUNCA pra side-effect crítico.

```typescript
// app/(authenticated)/inbox/realtime.ts (client)
const channel = sb.channel('inbox')
  .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'event_log',
        filter: `event_type=eq.message.received` },
      (payload) => updateLocalCache(payload.new))
  .subscribe();
```

**Por quê não pra crítico:** Realtime não tem ack, não tem retry, não garante delivery em reconnect. UI pode revalidar via React Query; worker crítico não pode "perder" evento.

### 4.3 LISTEN/NOTIFY

**Quando usar:** raro. Casos onde queremos **wakeup imediato** de um worker já rodando, sem esperar próximo poll. Útil pra latência sub-segundo em volume baixo.

```sql
-- Trigger emite NOTIFY após INSERT em event_log de tipos high-priority
create or replace function notify_high_priority_event() returns trigger as $$
begin
  if NEW.event_type in ('message.received', 'ai.handoff_triggered') then
    perform pg_notify('event_log_high', NEW.id::text);
  end if;
  return NEW;
end $$ language plpgsql;

create trigger event_log_notify_high_priority
  after insert on public.event_log
  for each row execute function notify_high_priority_event();
```

Worker faz `LISTEN event_log_high_priority` e usa o NOTIFY como **hint de wakeup**, mas ainda precisa do pull-loop como fallback (NOTIFY não é durável).

### 4.4 Decisão

| Cenário | Padrão recomendado |
|---|---|
| Send WhatsApp, AI bot, webhooks out, LGPD cascade, NS sync | **Pull-loop** |
| UI: inbox live, pipeline kanban live, dashboard | **Realtime** |
| Latência sub-segundo crítica em baixa frequência | **LISTEN/NOTIFY como wakeup** + pull-loop |
| Anything que precisa retry | **Pull-loop** (Realtime não retry) |

---

## 5. Fila / Queue Choice

### 5.1 Trade-off

| Opção | Prós | Contras |
|---|---|---|
| **Inngest** | DX excelente, observability built-in, step-functions | SaaS pago, vendor-lock-in, overhead pra MVP |
| **Trigger.dev v3** | Self-hostable, durable, rich SDK | Infra extra (workers Node 24/7), custo |
| **pg_boss** | Postgres-only, zero infra extra, transações ACID com app data, gratuito | Throughput limitado (~10k jobs/s), sem step-functions nativos |
| **BullMQ + Redis** | Throughput alto, ecosystem maduro | Redis extra, fora da transação Postgres |

### 5.2 Recomendação

> **MVP → pg_boss.** Usa o Postgres que já temos, transação atomic com `event_log` (emit + enqueue na mesma TX), zero infra extra, retry/DLQ built-in. Migrate pra Inngest se: (a) volume > 100k jobs/dia consistente, ou (b) precisamos de step-functions complexas (saga patterns), ou (c) timer-jobs com cron preciso > 1min.

### 5.3 Schema pg_boss

`pg_boss` cria seu próprio schema (`pgboss`) com tabelas `job`, `archive`, `schedule`, `version`. Init via:

```typescript
// workers/lib/queue.ts
import PgBoss from 'pg-boss';
export const boss = new PgBoss({
  connectionString: process.env.SUPABASE_DB_URL,
  schema: 'pgboss',
  retentionDays: 7,
  archiveCompletedAfterSeconds: 60 * 60 * 24,   // 1d
});
await boss.start();
```

**Quando pg_boss vs event_log puro:**
- **event_log:** bus pub/sub interno, fan-out pra múltiplos consumers, audit trail.
- **pg_boss:** filas específicas com retry/scheduled (`boss.schedule`, `boss.send`). Útil pra "executa essa função X exatamente uma vez", "retry 3x com backoff 30s".

**Padrão híbrido (recomendado):** workers leem `event_log` e, quando precisam executar trabalho retry-aware, enfileiram em `pg_boss`. Ex: `whatsapp-send-worker` lê `message.queued`, enfileira `boss.send('whatsapp-send', payload)`.

---

## 6. Worker Implementations

> Padrão: cada worker = arquivo TS em `workers/`, deploy como **Vercel Background Function** (long-running) OU **Edge Function Supabase agendada**. Para o MVP usamos Vercel Background Functions com **fluid compute**.

### 6.1 `whatsapp-send-worker`

- **Consome:** `message.queued` (emitido por ServerAction `sendMessage`).
- **Faz:** chama `POST /api/sendText` da WAHA, atualiza `messages.status='sent'|'failed'`, emite `message.sent` ou `message.failed`.
- **Retry:** 8 tentativas com backoff (§8). Após DLQ, alerta admin.
- **Idempotência:** chave = `messages.id` (unique). Se WAHA retornou 200 mas worker crashou antes de marcar `sent`, próxima tentativa detecta `messages.waha_message_id IS NOT NULL` e skip-faz só o emit.

### 6.2 `ai-response-worker`

- **Consome:** `message.received` onde `conversation.bot_active = true`.
- **Faz:** chama bot pipeline (RAG + LLM), gera resposta, emite `message.queued` (out) e `ai.responded`. Checa budget antes (`ai.budget_throttled` → skip).
- **Idempotência:** se já existe `message` com `metadata->>'reply_to' = event.payload.message_id`, skip.

### 6.3 `ai-sentiment-worker`

- **Consome:** `message.received` (in).
- **Faz:** classifica sentiment (modelo barato: Haiku/local). Se `angry|frustrated`, emite `ai.sentiment_alert`. Persiste em `messages.sentiment`.
- **Idempotência:** `messages.sentiment IS NOT NULL` → skip.
- **Não-crítico:** falha não-fatal, registra `last_error` mas não bloqueia outros workers.

### 6.4 `nuvemshop-sync-worker`

- **Consome:** `nuvemshop.product_synced`, `nuvemshop.order_*`, e job manual `nuvemshop.full_resync` (via pg_boss).
- **Faz:** sync inicial (paginated GET de produtos/clientes/pedidos) + sync incremental por webhook NS.
- **Idempotência:** upsert por `ns_id`.
- **Rate limit:** respeita NS API (300 req/min). Usa `bottleneck` ou similar.

### 6.5 `lgpd-export-worker`

- **Consome:** `lgpd.data_request_received` com `request_type='access'`, **agendado D+7** (via `next_attempt_at = created_at + interval '7 days'`).
- **Faz:** roda pipeline de export (bundle JSON + media URLs assinados), upload em Supabase Storage com signed URL 30d, emite `lgpd.export_generated`.
- **Idempotência:** `lgpd_requests.export_url IS NOT NULL` → skip.

### 6.6 `lgpd-redact-worker`

- **Consome:** `lgpd.data_request_received` com `request_type='redact'`, **agendado D+15**.
- **Faz:** cascade de anonimização (CRM contact_id → null, mensagens → mantém com PII removido, ordens → mantém financeiro mas anonimiza identificação). Se Nuvemshop integrado, propaga via API NS. Emite `lgpd.redact_applied` + `contact.anonymized`.
- **Idempotência:** `contacts.anonymized_at IS NOT NULL` → skip.
- **Crítico:** falha aqui é compliance issue → vai pra DLQ depois de 3 tentativas (não 8) e alerta DPO.

### 6.7 `webhook-dispatch-worker`

- **Consome:** **todos** eventos cuja org tem `webhook_subscriptions` configuradas pra esse `event_type`.
- **Faz:** POST com HMAC SHA-256 signature, header `X-Deskcomm-Signature`, timeout 10s. Sucesso = 2xx.
- **Retry:** backoff (§8). Após 8 falhas → DLQ. Após **10 falhas consecutivas** numa subscription → `webhook.subscription_disabled` + desabilita `webhook_subscriptions.enabled = false`.
- **Idempotência:** header `X-Deskcomm-Idempotency-Key = event.id`.

### 6.8 `rag-indexer-worker`

- **Consome:** `nuvemshop.product_synced`, `contact.created/merged`, `lead.created/updated`, eventos KB-edit.
- **Faz:** chunking + embedding + upsert em `pgvector`. Background, não-crítico.
- **Idempotência:** chunk_id determinístico (hash do conteúdo).

### 6.9 `audit-archive-worker`

- **Roda:** diário (cron).
- **Faz:** move `audit_log` e `event_log` rows com `created_at < now() - interval '90 days'` pra Supabase Storage (NDJSON gzip), depois `DELETE` da tabela quente.
- **Idempotência:** chunks por dia (`audit-2026-01-15.ndjson.gz`); se arquivo já existe, skip pra esse dia.

---

## 7. Crons (Vercel Cron)

Configuração em `vercel.json` (ou `app/api/cron/[name]/route.ts` com schedule). Todos os crons batem em `/api/cron/{name}` autenticados via `CRON_SECRET` (header `Authorization: Bearer ...`).

```json
{
  "crons": [
    { "path": "/api/cron/sync-sessions",            "schedule": "* * * * *" },
    { "path": "/api/cron/recover-stuck-messages",   "schedule": "* * * * *" },
    { "path": "/api/cron/process-pending-webhooks", "schedule": "* * * * *" },
    { "path": "/api/cron/health-check-integrations","schedule": "*/15 * * * *" },
    { "path": "/api/cron/oauth-refresh-tokens",     "schedule": "0 * * * *" },
    { "path": "/api/cron/daily-budget-reset",       "schedule": "0 3 * * *" },
    { "path": "/api/cron/prune-old-media",          "schedule": "30 3 * * *" }
  ]
}
```

> Nota: Vercel cron usa **UTC**. `0 3 * * *` ≈ 00:00 BRT (UTC-3).

### 7.1 `sync-sessions` (1min)
Verifica WAHA sessions ativas vs `whatsapp_sessions` no DB, sincroniza status (`WORKING`, `STOPPED`, `FAILED`), emite `system.session_changed` quando status diverge.

### 7.2 `recover-stuck-messages` (1min)
Procura `messages.status='sending'` com `created_at < now() - interval '2 minutes'`. Reprocessa (re-enqueue em `whatsapp-send-worker` ou marca `failed` se attempts esgotados).

### 7.3 `process-pending-webhooks` (1min)
Wakeup pro `webhook-dispatch-worker` (caso ele esteja idle). Também processa webhooks `next_attempt_at <= now()`.

### 7.4 `prune-old-media` (daily)
Remove anexos de mensagens > 365d (configurável por org), limpa Supabase Storage, atualiza referências.

### 7.5 `oauth-refresh-tokens` (hourly)
Refresh proativo de tokens Nuvemshop / outras integrações OAuth que expiram em <24h. Falha emite alert.

### 7.6 `daily-budget-reset` (00:00 BRT)
Reseta `ai_budget_daily` por org. Emite snapshot de uso do dia anterior pra analytics.

### 7.7 `health-check-integrations` (15min)
Ping nas dependências críticas: WAHA `/api/sessions`, Nuvemshop `/v1/{store}/store`, LLM provider. Falhas registradas em `integration_health` e alertam após 2 falhas consecutivas.

---

## 8. Dead-Letter Queue & Retry

### 8.1 Backoff exponencial

```typescript
// workers/lib/backoff.ts
const BACKOFF_SECONDS = [30, 60, 120, 300, 600, 1800, 3600, 7200];
//                      30s  1m  2m   5m   10m  30m   1h    2h
export function nextAttemptAt(attempts: number): Date {
  const idx = Math.min(attempts - 1, BACKOFF_SECONDS.length - 1);
  const base = BACKOFF_SECONDS[idx] * 1000;
  const jitter = Math.random() * 0.3 * base; // 0-30% jitter
  return new Date(Date.now() + base + jitter);
}
```

Implementado dentro de `nack_event(...)`:

```sql
create or replace function public.nack_event(
  p_event_id uuid, p_worker text, p_error text
) returns void language plpgsql security definer as $$
declare
  v_attempts smallint;
  v_max_attempts smallint := 8;
  v_backoff interval;
begin
  select attempts into v_attempts from public.event_log where id = p_event_id;

  if v_attempts >= v_max_attempts then
    update public.event_log
       set status = 'dead', last_error = p_error, updated_at = now()
     where id = p_event_id;
  else
    v_backoff := (case v_attempts
      when 1 then '30 seconds' when 2 then '1 minute' when 3 then '2 minutes'
      when 4 then '5 minutes'  when 5 then '10 minutes' when 6 then '30 minutes'
      when 7 then '1 hour'     else '2 hours' end)::interval;
    update public.event_log
       set status = 'pending', last_error = p_error,
           next_attempt_at = now() + v_backoff
                            + (random() * 0.3 * v_backoff),
           updated_at = now()
     where id = p_event_id;
  end if;
end $$;
```

### 8.2 Max attempts → DLQ

Default 8 (`status='dead'`). Workers críticos como `lgpd-redact-worker` reduzem pra 3 (compliance preferes alert humano sobre retry cego).

### 8.3 Auto-disable webhook após 10 falhas consecutivas

```sql
-- Em webhook_subscriptions:
alter table webhook_subscriptions
  add column consecutive_failures int not null default 0,
  add column enabled boolean not null default true;

-- worker incrementa em falha, zera em sucesso, e quando atinge 10:
update webhook_subscriptions
   set enabled = false, consecutive_failures = 0
 where id = $1;
-- + emit webhook.subscription_disabled
```

### 8.4 UI admin pra reprocessar

Tela `/admin/dlq`:
- Lista eventos `status='dead'` filtrados por `event_type`, `entity_kind`, período.
- Botão "Reprocessar" → `update event_log set status='pending', attempts=0, next_attempt_at=now(), last_error=null, consumed_by = consumed_by - $worker where id = $1`.
- Botão "Descartar" → `delete from event_log where id = $1` (soft? por ora hard delete + audit).

---

## 9. Idempotência

### 9.1 Event ID + `consumed_by`

Cada evento tem `id uuid` único. Worker checa `not ($worker = any(consumed_by))` no `claim_events`. Garante que worker X não processa duas vezes o mesmo evento (mesmo se invocado em paralelo).

### 9.2 Worker checa antes

Antes de fazer side-effect, worker re-valida estado via `select ... for update`. Ex: `whatsapp-send-worker` antes de chamar WAHA:

```typescript
const { data: msg } = await sb.from('messages').select('id, status, waha_message_id')
  .eq('id', payload.message_id).single();
if (msg.status === 'sent' || msg.waha_message_id) {
  // já enviado, só re-emit message.sent (idempotente)
  return;
}
```

### 9.3 Idempotência em side-effects

- **DB:** `unique constraint` em `(messages.organization_id, waha_message_id)`, `(orders.organization_id, ns_order_id)`.
- **HTTP outbound (webhooks):** header `X-Deskcomm-Idempotency-Key = event_id`.
- **WAHA send:** WAHA aceita `idempotency_key` em `sendText` (se não, usar `clientMessageId`).
- **Embeddings:** chunk_id = `sha256(content + version)`; upsert idempotente.

---

## 10. Observability

### 10.1 Métricas custom

Exportar via OpenTelemetry → Sentry / Vercel Observability:

| Métrica | Tipo | Labels | Alerta |
|---|---|---|---|
| `event_log.emitted` | counter | `event_type`, `org_id` | — |
| `event_log.consumed` | counter | `event_type`, `worker` | — |
| `event_log.lag_seconds` | gauge | `event_type` | > 60s sustained |
| `event_log.fail_rate` | gauge (5min window) | `worker` | > 5% |
| `event_log.dlq_size` | gauge | `event_type` | > 100 |
| `worker.processing_duration_ms` | histogram | `worker`, `event_type` | p95 > 5s |
| `pg_boss.queue_size` | gauge | `queue` | > 1000 |

Query exemplo (lag):

```sql
select event_type,
       extract(epoch from (now() - min(created_at))) as lag_seconds
  from event_log
 where status = 'pending'
 group by event_type;
```

### 10.2 Sentry breadcrumbs

Cada worker, ao processar evento:

```typescript
Sentry.addBreadcrumb({
  category: 'event_log',
  message: `consume ${event.event_type}`,
  data: { event_id: event.id, attempts: event.attempts, org_id: event.organization_id },
  level: 'info',
});
Sentry.setContext('event', { id: event.id, type: event.event_type });
```

Erros automaticamente carregam contexto do evento.

### 10.3 Audit cross-correlation

Em `audit_log` e `event_log`, ambos carregam `metadata.request_id`. Permite query:

```sql
-- "tudo que aconteceu na request X"
select 'audit' as src, * from audit_log where metadata->>'request_id' = $1
union all
select 'event' as src, * from event_log where metadata->>'request_id' = $1
order by created_at;
```

`trace_id` (Sentry) também propagado em metadata.

---

## 11. Plano de Validação

### 11.1 Testes unitários

- `emit_event` valida org_id obrigatório.
- `emit_event` rejeita `event_type` fora do regex.
- `nextAttemptAt(n)` retorna intervalo correto para n=1..10.
- Workers handlers idempotentes: chamar 2x com mesmo event → 1 side-effect.

### 11.2 Testes de integração

- Inserir 1000 eventos `message.received`, rodar 3 workers em paralelo, garantir cada evento processado por cada worker exatamente 1x (`consumed_by` consistente, sem duplicação de side-effects).
- Forçar erro em handler → verificar backoff e DLQ após 8 attempts.
- Webhook 10 falhas consecutivas → verificar `webhook_subscriptions.enabled = false`.

### 11.3 Testes de carga

- 10k eventos/min sustained por 10min: verificar lag < 30s, sem perda.
- Kill worker mid-processing: verificar evento volta pra `pending` (via `status='processing'` + timeout reaper) ou é re-claimed.

### 11.4 Reaper de processing órfão

```sql
-- Cron auxiliar: marca como pending eventos 'processing' há > 5min (worker crashou)
update event_log
   set status = 'pending', updated_at = now()
 where status = 'processing'
   and updated_at < now() - interval '5 minutes';
```

### 11.5 Chaos checks

- Drop conexão Postgres mid-claim → worker recupera no próximo loop.
- Latência WAHA 30s → backoff escala corretamente.
- pg_boss schema corrompido → boot do worker falha loud, alert.

---

## 12. Migrations

Ordem recomendada (sob `supabase/migrations/`):

1. `2026XX01_event_log_table.sql` — tabela, constraint, comments.
2. `2026XX02_event_log_indexes.sql` — todos os 5 indexes.
3. `2026XX03_event_log_rls.sql` — políticas + revokes.
4. `2026XX04_emit_event_function.sql` — RPC `emit_event`.
5. `2026XX05_claim_ack_nack_functions.sql` — RPCs `claim_events`, `ack_event`, `nack_event`.
6. `2026XX06_event_log_notify_trigger.sql` — LISTEN/NOTIFY pra high-priority.
7. `2026XX07_pgboss_schema.sql` — `create schema pgboss;` + grants (pg_boss cria tabelas no init runtime).
8. `2026XX08_event_archive_storage_bucket.sql` — bucket Storage `event-archive` private.
9. `2026XX09_webhook_subscriptions_columns.sql` — `consecutive_failures`, `enabled`.
10. `2026XX10_event_log_reaper_cron.sql` — `pg_cron` (se disponível) ou Vercel cron equivalente.

Cada migration tem **rollback** (`down.sql`) testado em branch Supabase antes de merge.

---

## Apêndice A — Convenções rápidas

- **Event_type:** `lower_snake.lower_snake`. Regex: `^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`.
- **Schema versioning:** `metadata.schema_version` (semver). Mudança breaking = bump major.
- **Worker name:** kebab-case sufixado `-worker`. Ex: `whatsapp-send-worker`.
- **Cron path:** `/api/cron/{kebab-name}`.
- **DLQ inspection:** `select * from event_log where status='dead' order by created_at desc limit 50;`.
- **Reprocessar único:** `update event_log set status='pending', attempts=0, next_attempt_at=now(), last_error=null, consumed_by='{}' where id=$1;`.

## Apêndice B — Anti-patterns proibidos

1. ❌ Trigger SQL chamando `pg_net.http_post`.
2. ❌ ServerAction fazendo side-effect HTTP síncrono crítico (sem fila/event).
3. ❌ Worker processando sem checar `consumed_by`.
4. ❌ Retry sem backoff (DDoS no upstream).
5. ❌ DLQ sem alerta humano.
6. ❌ Realtime como bus crítico (não retry, não durável).
7. ❌ Webhook outbound sem HMAC + idempotency-key.
8. ❌ Event_type CamelCase ou kebab.
9. ❌ Worker que silencia erro com `try { ... } catch { /* ignore */ }`.
10. ❌ Mudar payload de event existente sem bump `schema_version`.
