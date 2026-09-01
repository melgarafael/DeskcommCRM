---
title: Spec Técnica 03 — Canal WhatsApp via WAHA Plus
parent: 03-prd-whatsapp-waha.md
depends_on: 01-spec-platform-base.md, 02-spec-customer-360.md
version: 0.1
status: em revisão
date: 2026-04-28
owner: Songhai, Lda
referencia_arquitetural: docs/research/reference-synthesis.md
related_rules: T-07, W-01, W-02, W-03, W-04, W-05, W-06, W-07, W-08, W-09, W-10, W-11, W-12, AT-07
---

# Spec Técnica 03 — Canal WhatsApp via WAHA Plus

> Especificação de implementação do canal WhatsApp. Toda decisão arquitetural já foi tomada nos PRDs; aqui virou DDL Postgres, código TypeScript, configuração de container, fluxo de cron e runbooks. Esse documento é o contrato técnico que o squad implementa sem precisar voltar pra discussão de produto.

---

## 1. Visão Geral

### 1.1 Posição na arquitetura

Esta spec implementa o **Sub-PRD 03**. Materializa, em código e schema, as 12 regras de negócio do domínio WhatsApp (W-01 a W-12), mais T-07 (`webhook_path_token` único global) e AT-07 (chunking de texto >4096). Toda decisão diferida pra Spec na §9 do PRD-03 é resolvida aqui.

Componentes envolvidos:

```
┌─────────────────────┐                                ┌────────────────────┐
│  Frontend Next.js   │                                │   WAHA Plus        │
│  - QR scan UI       │  ◄──────── Realtime ──────────►│   (Docker, NOWEB)  │
│  - Composer chat    │                                │   - 1 instância    │
│  - Health dash      │                                │   - N sessões      │
└─────────┬───────────┘                                └────────┬───────────┘
          │ Server Actions / REST                               │
          ▼                                                     ▼
┌─────────────────────┐    ◄── HMAC-SHA512 webhooks ────────────┘
│  Backend Next.js    │
│  - /api/wa/*        │  ────► event_log ────► workers (IA, atendimento, RAG)
│  - WAHA client      │                                          
│  - Webhook receiver │  ────► usage_events ──► billing
└─────────┬───────────┘
          │ pg_boss / Inngest                                    
          ▼                                                      
┌─────────────────────┐         ┌─────────────────────┐         
│  Postgres (Supabase)│         │  Upstash Redis      │         
│  - 5 tabelas WA     │         │  - daily counters   │         
│  - RLS ativa        │         │  - send lock        │         
│  - event_log        │         │  - rate limit       │         
└─────────────────────┘         └─────────────────────┘         
```

### 1.2 Decisões fechadas nesta spec

1. **Roteamento webhook**: path-token assinado (UUIDv4) em vez de subdomain — `POST /api/wa/webhook/:webhook_path_token`. Atende T-07 e isola tenant sem expor `session_name`.
2. **Fila de outbound**: **pg_boss** (Postgres-backed) no MVP por simplicidade operacional (zero infra extra) e custo; migração pra Inngest fica trivial pós-MVP se throughput exigir.
3. **Engine WAHA**: **NOWEB** default global. WEBJS opcional por feature (stickers animados, listas/botões) — flag por sessão `engine='WEBJS'`; revisitar se o catálogo de features WEBJS-only crescer.
4. **Áudio OGG no Safari**: `<audio preload="none">` + botão "Baixar" como fallback inicial; **re-encode server-side** com ffmpeg fica como fast-follow se complaints de UX surgirem (cron `transcode-audio` opt-in por tenant).
5. **Spinning de copy**: DSL inline `{a|b|c}` + variáveis `{{var}}` parseado server-side com gramática regex bem definida (vide §8.2).
6. **Warm-up**: tabela auxiliar `channel_session_warmup` mantém contagens diárias (não calcula on-demand — performance sob carga).
7. **Retenção `webhook_events_log`**: 30 dias hot + cold storage S3 lifecycle.
8. **Hospedagem WAHA**: Railway no MVP; produção em **VPS própria (mín. 2 vCPU / 4 GB RAM / 80 GB SSD, datacenter mais próximo do público, ~R$140/mês num provedor típico com esse perfil)** com Nginx + Let's Encrypt. Sem parceria comercial — a escolha de provedor é livre, priorizando latência/custo.

### 1.3 Dependências externas

| Componente | Versão | Provisão |
|---|---|---|
| `@supabase/supabase-js` | ^2.45 | npm |
| `pg-boss` | ^10 | npm + Postgres extension |
| `@upstash/redis` | ^1.34 | npm |
| WAHA Plus | `devlikeapro/waha-plus:latest` (digest pinado) | Docker |
| `zod` | ^3.23 | npm |
| `pino` (logger) | ^9 | npm |

---

## 2. Setup do WAHA Plus

### 2.1 `docker-compose.yml` (engine NOWEB)

Arquivo `infra/waha/docker-compose.yml` no repo. Pinning de digest é obrigatório pra reprodutibilidade; tag `latest` apenas como referência.

```yaml
version: "3.9"

services:
  waha:
    image: devlikeapro/waha-plus@sha256:<DIGEST_PINNED_NA_PROD>
    container_name: deskcomm-waha
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"   # bind localhost; Nginx faz TLS termination
    environment:
      # Auth (vide §2.2)
      WAHA_API_KEY: ${WAHA_API_KEY_SHA512}
      WAHA_DASHBOARD_USERNAME: ${WAHA_DASHBOARD_USERNAME}
      WAHA_DASHBOARD_PASSWORD: ${WAHA_DASHBOARD_PASSWORD}

      # Engine
      WAHA_DEFAULT_ENGINE: NOWEB
      WAHA_LOG_LEVEL: info
      WAHA_LOG_FORMAT: json

      # Storage de mídia inbound (S3-compatible; opcional)
      WAHA_S3_ENABLED: "true"
      WAHA_S3_REGION: ${WAHA_S3_REGION}
      WAHA_S3_BUCKET: ${WAHA_S3_BUCKET}
      WAHA_S3_ACCESS_KEY_ID: ${WAHA_S3_ACCESS_KEY_ID}
      WAHA_S3_SECRET_ACCESS_KEY: ${WAHA_S3_SECRET_ACCESS_KEY}
      WAHA_S3_FORCE_PATH_STYLE: "true"

      # Webhooks: globais por sessão (configurados via API; aqui só defaults)
      WAHA_WEBHOOK_HMAC_ALGORITHM: sha512

      # Sessions persistentes (multi-tenant Plus)
      WAHA_SESSIONS_AUTOSTART: "true"
      WAHA_PRINT_QR: "false"          # QR só via API; nada no log

    volumes:
      - waha_sessions:/app/.sessions   # estado das sessões (NOWEB) — backup obrigatório
      - waha_media:/app/.media         # cache curto de mídia inbound
      - waha_logs:/app/logs

    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/api/server/version"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s

    deploy:
      resources:
        limits:
          memory: 1.5G
          cpus: "1.0"
        reservations:
          memory: 512M

    logging:
      driver: json-file
      options:
        max-size: "20m"
        max-file: "5"

volumes:
  waha_sessions:
    driver: local
  waha_media:
    driver: local
  waha_logs:
    driver: local
```

### 2.2 Variáveis de ambiente

A `WAHA_API_KEY` do servidor é o **hash SHA512 hex (lowercase) do plaintext**. O backend SonghaiCRM guarda **só** o plaintext em Vercel Encrypted Env Var; nunca a hash duplicada. Geração:

```bash
# Gerar plaintext seguro (nunca commitar; armazenar em 1Password/Vercel)
PLAINTEXT=$(openssl rand -hex 32)
echo "Plaintext (env do app): $PLAINTEXT"

# Gerar hash pro env do WAHA
echo -n "$PLAINTEXT" | sha512sum | awk '{print $1}'
# → cole o resultado em WAHA_API_KEY_SHA512 do compose
```

`.env.production.example` (não commitar valores reais):

```dotenv
# === WAHA server (no host do WAHA, NÃO no Vercel) ===
WAHA_API_KEY_SHA512=<sha512 hex do plaintext>
WAHA_DASHBOARD_USERNAME=admin_deskcomm
WAHA_DASHBOARD_PASSWORD=<senha forte gerada>
WAHA_S3_REGION=auto
WAHA_S3_BUCKET=deskcomm-waha-media
WAHA_S3_ACCESS_KEY_ID=<r2/s3 access key>
WAHA_S3_SECRET_ACCESS_KEY=<r2/s3 secret>

# === Backend Vercel (Encrypted Env) ===
WAHA_API_KEY=<plaintext — só aqui>
WAHA_BASE_URL=https://waha.deskcomm.internal
WAHA_WEBHOOK_PUBLIC_BASE_URL=https://api.deskcomm.com
INTERNAL_CRON_SECRET=<openssl rand -hex 32>
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

### 2.3 Health check endpoint

Internamente o WAHA expõe `GET /api/server/version` (não requer auth; usado pelo Docker healthcheck) e `GET /api/sessions/:name` (requer `X-Api-Key`; usado pelo cron `sync-sessions`).

Exposição externa via `/api/wa/health` no Next.js (vide §10.1) — agrega WAHA + DB + Redis, com cache curto:

```ts
// apps/web/app/api/wa/health/route.ts
export async function GET() {
  const checks = await Promise.allSettled([
    fetch(`${process.env.WAHA_BASE_URL}/api/server/version`, {
      signal: AbortSignal.timeout(3000),
    }),
    pingDb(),
    pingRedis(),
  ]);
  const ok = checks.every((c) => c.status === "fulfilled");
  return Response.json(
    { ok, checks: checks.map(serializeCheck) },
    { status: ok ? 200 : 503 }
  );
}
```

### 2.4 Recovery & persistência

- **Volume `/app/.sessions`** é a *crown jewel*: contém o estado de pareamento. Perdê-lo força re-scan de QR em todos os números (W-11). Backup obrigatório:
  - Snapshot diário do volume (restic snapshot pra Backblaze B2 ou `restic` pra Backblaze B2).
  - Retenção: 7 daily + 4 weekly.
- **Restart policy** `unless-stopped` (não `always`) — em failure loop, container fica parado pra investigação manual em vez de rodar em loop infinito mascarando bug.
- **Nginx upstream config** (produção) com timeouts longos pra acomodar pareamento:

```nginx
upstream waha_backend {
  server 127.0.0.1:3000 max_fails=3 fail_timeout=30s;
}

server {
  listen 443 ssl http2;
  server_name waha.deskcomm.internal;

  ssl_certificate     /etc/letsencrypt/live/waha.deskcomm.internal/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/waha.deskcomm.internal/privkey.pem;

  client_max_body_size 64M;     # mídia até 50MB + overhead

  # Allowlist do Vercel (egress IPs) — atualizar via cron
  include /etc/nginx/conf.d/vercel-egress-allowlist.conf;
  deny all;

  location / {
    proxy_pass http://waha_backend;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_read_timeout 120s;    # screenshots/QR podem ser lentos
    proxy_send_timeout 60s;
    proxy_connect_timeout 5s;

    # SSE/long-poll friendly
    proxy_buffering off;
  }
}
```

---

## 3. Schema SQL

DDL completo. Toda tabela é tenant-aware (T-01) com RLS via `fn_user_org_ids()`. Criação em migration única `2026XXXXXX_03_whatsapp.sql`. Pré-requisito: extensions `pgcrypto`, `uuid-ossp`, e tabelas de Sub-PRDs 01 e 02 já aplicadas.

### 3.1 `channel_sessions`

```sql
create table public.channel_sessions (
  id                       uuid primary key default uuid_generate_v4(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,

  -- Identificação WAHA
  waha_session_name        text not null,
  -- formato: 'org_<org_id>_<seq>' (ex: 'org_a1b2c3d4_1')
  -- precisa ser único GLOBALMENTE (regra implícita do WAHA, 1 instância compartilhada)
  engine                   text not null default 'NOWEB'
                           check (engine in ('NOWEB','WEBJS')),

  -- Webhook (T-07)
  webhook_path_token       text not null default replace(uuid_generate_v4()::text,'-',''),
  webhook_secret_encrypted bytea not null,
  -- AES-GCM via pgcrypto; chave WEBHOOK_SECRET_ENCRYPTION_KEY em env

  -- Estado
  status                   text not null default 'STARTING'
                           check (status in (
                             'STARTING','SCAN_QR_CODE','WORKING',
                             'STOPPED','FAILED'
                           )),
  status_reason            text,
  phone_number             text,                 -- E.164, populado após WORKING
  display_name             text,                 -- nome do perfil WhatsApp

  -- Health
  last_health_check_at     timestamptz,
  last_status_change_at    timestamptz not null default now(),
  consecutive_health_fails integer not null default 0,

  -- Operacional
  daily_message_limit      integer not null default 300,  -- W-06
  warmup_started_at        timestamptz,
  warmup_completed_at      timestamptz,
  is_warmup_complete       boolean generated always as (
                             warmup_completed_at is not null
                           ) stored,

  -- Metadata flexível
  metadata                 jsonb not null default '{}'::jsonb,

  -- Auditoria
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  created_by               uuid references auth.users(id),

  constraint channel_sessions_waha_session_name_unique unique (waha_session_name),
  constraint channel_sessions_webhook_path_token_unique unique (webhook_path_token),
  constraint channel_sessions_phone_per_org_unique unique (organization_id, phone_number)
                                                  deferrable initially deferred
);

create index idx_channel_sessions_org_status
  on public.channel_sessions (organization_id, status);
create index idx_channel_sessions_health
  on public.channel_sessions (last_health_check_at)
  where status = 'WORKING';

alter table public.channel_sessions enable row level security;

create policy "channel_sessions_tenant_isolation_all"
  on public.channel_sessions for all
  using (organization_id in (select organization_id from public.fn_user_org_ids()))
  with check (organization_id in (select organization_id from public.fn_user_org_ids()));

create trigger trg_channel_sessions_updated_at
  before update on public.channel_sessions
  for each row execute function public.fn_set_updated_at();

create trigger trg_channel_sessions_status_audit
  after update of status on public.channel_sessions
  for each row when (old.status is distinct from new.status)
  execute function public.fn_emit_channel_session_status_changed();
```

Tabela auxiliar de warm-up:

```sql
create table public.channel_session_warmup (
  id                  uuid primary key default uuid_generate_v4(),
  channel_session_id  uuid not null references public.channel_sessions(id) on delete cascade,
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  day                 date not null,
  messages_sent       integer not null default 0,
  messages_received   integer not null default 0,
  unique_contacts     integer not null default 0,

  constraint warmup_session_day_unique unique (channel_session_id, day)
);

create index idx_warmup_org_day on public.channel_session_warmup (organization_id, day desc);

alter table public.channel_session_warmup enable row level security;
create policy "warmup_tenant_isolation_all"
  on public.channel_session_warmup for all
  using (organization_id in (select organization_id from public.fn_user_org_ids()))
  with check (organization_id in (select organization_id from public.fn_user_org_ids()));
```

### 3.2 `conversations`

```sql
create table public.conversations (
  id                          uuid primary key default uuid_generate_v4(),
  organization_id             uuid not null references public.organizations(id) on delete cascade,

  contact_id                  uuid not null references public.contacts(id) on delete restrict,
  channel_session_id          uuid not null references public.channel_sessions(id) on delete restrict,
  channel                     text not null default 'whatsapp'
                              check (channel in ('whatsapp')),  -- prep multi-canal

  status                      text not null default 'open'
                              check (status in ('open','pending','resolved')),
  status_changed_at           timestamptz not null default now(),

  assigned_to_user_id         uuid references auth.users(id) on delete set null,
  assigned_at                 timestamptz,

  last_inbound_at             timestamptz,
  last_outbound_at            timestamptz,
  last_message_at             timestamptz,
  last_message_preview        text,

  unread_count_for_assignee   integer not null default 0,

  is_group                    boolean not null default false,  -- W-09
  group_chat_id               text,                            -- @g.us se grupo

  metadata                    jsonb not null default '{}'::jsonb,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  constraint conversations_unique_per_contact_session
    unique (organization_id, contact_id, channel_session_id, group_chat_id)
);

create index idx_conversations_org_last_msg
  on public.conversations (organization_id, last_message_at desc nulls last);
create index idx_conversations_assigned
  on public.conversations (assigned_to_user_id, status)
  where assigned_to_user_id is not null;
create index idx_conversations_open_unassigned
  on public.conversations (organization_id, last_inbound_at desc)
  where status = 'open' and assigned_to_user_id is null;

alter table public.conversations enable row level security;
create policy "conversations_tenant_isolation_all"
  on public.conversations for all
  using (organization_id in (select organization_id from public.fn_user_org_ids()))
  with check (organization_id in (select organization_id from public.fn_user_org_ids()));

create trigger trg_conversations_updated_at
  before update on public.conversations
  for each row execute function public.fn_set_updated_at();
```

### 3.3 `messages`

```sql
create table public.messages (
  id                  uuid primary key default uuid_generate_v4(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,

  conversation_id     uuid not null references public.conversations(id) on delete cascade,
  channel_session_id  uuid not null references public.channel_sessions(id) on delete restrict,
  contact_id          uuid not null references public.contacts(id) on delete restrict,

  -- Identidade WAHA
  external_id         text,    -- nullable: outbound em sending ainda não tem ID
  type                text not null
                      check (type in (
                        'text','image','video','audio','document',
                        'sticker','location','contact','reaction','system'
                      )),
  direction           text not null check (direction in ('inbound','outbound')),

  -- Status (W-12)
  status              text not null default 'received'
                      check (status in (
                        'received',
                        'sending','sent','delivered','read','failed'
                      )),
  ack                 integer,    -- WAHA: -1 error, 0 pending, 1 server, 2 device, 3 read, 4 played
  error_code          text,
  error_message       text,

  -- Conteúdo
  body                text,
  media_url           text,        -- URL assinada do Supabase Storage
  media_mime          text,
  media_size_bytes    bigint,
  media_storage_path  text,        -- path canônico no bucket

  -- Origem (W-10)
  sent_via            text not null default 'crm'
                      check (sent_via in ('crm','external_device','automation','ai')),
  sent_by_user_id     uuid references auth.users(id) on delete set null,

  -- Timestamps WhatsApp (W8 — ordenar por sent_at)
  sent_at             timestamptz not null default now(),
  delivered_at        timestamptz,
  read_at             timestamptz,

  -- Idempotência & metadata
  metadata            jsonb not null default '{}'::jsonb,

  -- Polimorfismo de timeline (vide Sub-PRD 02)
  activity_id         uuid references public.crm_lead_activities(id) on delete set null,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Idempotência forte (W-05). Deferrable pra permitir update do
  -- external_id no commit (envio: insert sem ID, update após WAHA retornar).
  constraint messages_org_external_id_unique
    unique (organization_id, external_id)
    deferrable initially deferred
);

create index idx_messages_conversation_sent
  on public.messages (conversation_id, sent_at desc);
create index idx_messages_org_status_created
  on public.messages (organization_id, status, created_at)
  where status in ('sending','failed');
create index idx_messages_external_lookup
  on public.messages (organization_id, external_id)
  where external_id is not null;

alter table public.messages enable row level security;
create policy "messages_tenant_isolation_all"
  on public.messages for all
  using (organization_id in (select organization_id from public.fn_user_org_ids()))
  with check (organization_id in (select organization_id from public.fn_user_org_ids()));

create trigger trg_messages_updated_at
  before update on public.messages
  for each row execute function public.fn_set_updated_at();

-- Trigger NUNCA faz HTTP — apenas escreve em event_log (Sub-PRD 01)
create trigger trg_messages_emit_event
  after insert on public.messages
  for each row execute function public.fn_emit_message_event();
```

### 3.4 `webhook_events_log`

Append-only. Source of truth de inbound bruto. Retenção 30d hot + cold S3.

```sql
create table public.webhook_events_log (
  id                   uuid primary key default uuid_generate_v4(),
  organization_id      uuid,                                   -- nullable: pode falhar antes de resolver
  channel_session_id   uuid references public.channel_sessions(id) on delete set null,

  webhook_path_token   text,
  http_method          text not null default 'POST',
  headers              jsonb,
  raw_body             text not null,                          -- corpo CRU (pra HMAC re-check)
  payload_parsed       jsonb,

  signature_header     text,
  valid_signature      boolean,

  event_type           text,        -- 'message','message.any','message.ack','session.status', etc.
  external_id          text,        -- pra debug/idempotência

  status               text not null default 'received'
                       check (status in ('received','processed','error','dead')),
  attempts             integer not null default 0,
  error_message        text,
  processed_at         timestamptz,

  received_at          timestamptz not null default now(),
  archived_at          timestamptz
);

create index idx_webhook_events_status_received
  on public.webhook_events_log (status, received_at)
  where status in ('received','error');
create index idx_webhook_events_org_received
  on public.webhook_events_log (organization_id, received_at desc);
create index idx_webhook_events_external_id
  on public.webhook_events_log (organization_id, external_id)
  where external_id is not null;

-- RLS: super-admin lê tudo; tenant lê apenas o seu (via app, com filtro manual)
alter table public.webhook_events_log enable row level security;
create policy "webhook_events_log_tenant_read"
  on public.webhook_events_log for select
  using (
    organization_id is not null
    and organization_id in (select organization_id from public.fn_user_org_ids())
  );
-- INSERT/UPDATE: apenas service role (handler de webhook)
revoke insert, update, delete on public.webhook_events_log from anon, authenticated;
```

### 3.5 RLS — recap & policies extras

Toda tabela tenant-aware acima já tem `tenant_isolation_*_all`. Pra `messages` e `conversations`, RLS adicional pra `agent` (W2/W3): só pode `SELECT` conversations atribuídas + não-atribuídas; pode `INSERT message` apenas em conversation atribuída a si:

```sql
create policy "messages_agent_insert_own_conversation"
  on public.messages for insert
  to authenticated
  with check (
    organization_id in (select organization_id from public.fn_user_org_ids())
    and (
      auth.jwt() ->> 'role' in ('manager','admin')
      or exists (
        select 1 from public.conversations c
        where c.id = messages.conversation_id
          and c.assigned_to_user_id = auth.uid()
      )
    )
  );
```

### 3.6 Indexes (resumo cross-tabela)

| Tabela | Index | Justificativa |
|---|---|---|
| `messages` | `(conversation_id, sent_at desc)` | Listagem de thread (UI) |
| `messages` | `(organization_id, status, created_at) where status in ('sending','failed')` | Cron `recover-stuck` |
| `messages` | `(organization_id, external_id) where external_id is not null` | Idempotency lookup |
| `conversations` | `(organization_id, last_message_at desc nulls last)` | Inbox listing |
| `conversations` | `(organization_id, last_inbound_at desc) where status='open' and assigned_to is null` | Fila de não-atribuídas |
| `channel_sessions` | `(last_health_check_at) where status='WORKING'` | Cron `sync-sessions` |
| `webhook_events_log` | `(status, received_at) where status in ('received','error')` | Cron `process-pending-webhooks` |

---

## 4. WAHA Client (TypeScript wrapper)

Localização: `apps/web/src/server/waha/`. Cliente fino, fortemente tipado, com retry e classificação de erro próprios. Injetável (`getWahaClient()`).

### 4.1 Factory & tipos

```ts
// apps/web/src/server/waha/client.ts
import { z } from "zod";

export type WahaSessionStatus =
  | "STARTING" | "SCAN_QR_CODE" | "WORKING" | "STOPPED" | "FAILED";

export interface WahaClientConfig {
  baseUrl: string;
  apiKey: string;          // plaintext (server-side only)
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class WahaError extends Error {
  constructor(
    public readonly code:
      | "session_not_found" | "session_already_exists"
      | "qr_not_available"  | "rate_limited"
      | "upstream_5xx"      | "timeout" | "network" | "unknown",
    message: string,
    public readonly httpStatus?: number,
    public readonly cause?: unknown,
  ) { super(message); this.name = "WahaError"; }
}

export function getWahaClient(cfg?: Partial<WahaClientConfig>): WahaClient {
  return new WahaClient({
    baseUrl: cfg?.baseUrl ?? requireEnv("WAHA_BASE_URL"),
    apiKey:  cfg?.apiKey  ?? requireEnv("WAHA_API_KEY"),
    timeoutMs: cfg?.timeoutMs ?? 15_000,
    fetchImpl: cfg?.fetchImpl ?? fetch,
  });
}
```

### 4.2 Implementação dos métodos

```ts
export class WahaClient {
  constructor(private cfg: WahaClientConfig) {}

  private async request<T>(
    path: string,
    init: RequestInit = {},
    schema?: z.ZodType<T>,
  ): Promise<T> {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs!);
    try {
      const res = await this.cfg.fetchImpl!(`${this.cfg.baseUrl}${path}`, {
        ...init,
        signal: ctrl.signal,
        headers: {
          "X-Api-Key": this.cfg.apiKey,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });
      if (!res.ok) throw await this.classifyError(res);
      const data = await res.json();
      return schema ? schema.parse(data) : (data as T);
    } catch (err) {
      if (err instanceof WahaError) throw err;
      if ((err as Error).name === "AbortError") {
        throw new WahaError("timeout", `WAHA timeout after ${this.cfg.timeoutMs}ms`);
      }
      throw new WahaError("network", "WAHA network error", undefined, err);
    } finally { clearTimeout(timeoutId); }
  }

  private async classifyError(res: Response): Promise<WahaError> {
    const body = await res.text().catch(() => "");
    if (res.status === 404) return new WahaError("session_not_found", body, 404);
    if (res.status === 409) return new WahaError("session_already_exists", body, 409);
    if (res.status === 422) return new WahaError("qr_not_available", body, 422);
    if (res.status === 429) return new WahaError("rate_limited", body, 429);
    if (res.status >= 500)  return new WahaError("upstream_5xx", body, res.status);
    return new WahaError("unknown", `${res.status} ${body}`, res.status);
  }

  // ── Sessions ────────────────────────────────────────────────
  async createSession(input: {
    name: string;
    engine?: "NOWEB" | "WEBJS";
    webhookUrl: string;
    webhookSecret: string;
  }) {
    return this.request("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        config: {
          metadata: { source: "deskcomm" },
          webhooks: [{
            url: input.webhookUrl,
            events: [
              "message.any",
              "message.ack",
              "session.status",
              "presence.update",
            ],
            hmac: { key: input.webhookSecret },
            retries: { delaySeconds: 2, attempts: 3 },
          }],
        },
        start: true,
      }),
    });
  }

  async getSession(name: string) {
    return this.request<{
      name: string; status: WahaSessionStatus;
      me?: { id: string; pushName?: string };
    }>(`/api/sessions/${encodeURIComponent(name)}`);
  }

  async listSessions() {
    return this.request<Array<{ name: string; status: WahaSessionStatus }>>(
      `/api/sessions`,
    );
  }

  async deleteSession(name: string) {
    return this.request(`/api/sessions/${encodeURIComponent(name)}`,
      { method: "DELETE" });
  }

  async getQR(name: string): Promise<{ image: string; mimetype: string }> {
    return this.request(
      `/api/${encodeURIComponent(name)}/auth/qr?format=image`,
    );
  }

  // ── Messages ────────────────────────────────────────────────
  async sendText(input: { session: string; chatId: string; text: string }) {
    return this.request<{ id: { id: string; _serialized: string } }>(
      `/api/sendText`, {
        method: "POST",
        body: JSON.stringify({
          session: input.session,
          chatId:  input.chatId,
          text:    input.text,
        }),
      },
    );
  }

  async sendImage(input: {
    session: string; chatId: string;
    fileUrl: string; caption?: string;
  }) {
    return this.request(`/api/sendImage`, {
      method: "POST",
      body: JSON.stringify({
        session: input.session,
        chatId:  input.chatId,
        file:    { url: input.fileUrl },
        caption: input.caption,
      }),
    });
  }

  async sendFile(input: {
    session: string; chatId: string;
    fileUrl: string; filename: string; caption?: string;
  }) {
    return this.request(`/api/sendFile`, {
      method: "POST",
      body: JSON.stringify({
        session: input.session,
        chatId:  input.chatId,
        file:    { url: input.fileUrl, filename: input.filename },
        caption: input.caption,
      }),
    });
  }

  async sendVoice(input: { session: string; chatId: string; fileUrl: string }) {
    return this.request(`/api/sendVoice`, {
      method: "POST",
      body: JSON.stringify({
        session: input.session, chatId: input.chatId,
        file: { url: input.fileUrl },
      }),
    });
  }

  async sendLocation(input: {
    session: string; chatId: string;
    latitude: number; longitude: number; title?: string;
  }) {
    return this.request(`/api/sendLocation`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
}
```

### 4.3 Auth headers

`X-Api-Key` carrega o **plaintext** (a `WAHA_API_KEY` do server é o SHA512 do mesmo). Header `Content-Type: application/json` em todos os POSTs. Nenhuma rota suporta `Authorization: Bearer`.

### 4.4 Tratamento de erros

`WahaError` carrega `code` semântico pra que callers decidam: retry (network/timeout/upstream_5xx) vs falha terminal (session_not_found/qr_not_available). O worker de envio (vide §7) usa essa classificação pra distinguir "retry com backoff" de "falha definitiva → mark message failed".

---

## 5. Conexão de Sessão (Fluxo QR)

### 5.1 Criação da sessão

```ts
// apps/web/app/api/wa/sessions/route.ts
import { NextRequest } from "next/server";
import { z } from "zod";
import { getServerSession } from "@/server/auth";
import { getDb } from "@/server/db";
import { getWahaClient } from "@/server/waha/client";
import { encryptSecret, generateSecret } from "@/server/crypto";

const Body = z.object({ engine: z.enum(["NOWEB","WEBJS"]).default("NOWEB") });

export async function POST(req: NextRequest) {
  const session = await getServerSession(req);
  if (!session) return json({ error: "unauthorized" }, 401);
  if (!hasRole(session, "admin")) return json({ error: "forbidden" }, 403);

  const body = Body.parse(await req.json());
  const db = getDb();
  const orgId = session.organizationId;

  // Próximo seq por org (transacional)
  const seq = await db.tx(async (t) => {
    const { count } = await t.from("channel_sessions")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", orgId);
    return (count ?? 0) + 1;
  });

  const sessionName = `org_${orgId.replaceAll("-","")}_${seq}`;
  const webhookSecret = generateSecret(64);  // 64 bytes hex
  const encryptedSecret = encryptSecret(webhookSecret);

  // 1) INSERT no DB primeiro (transactional outbox-like)
  const { data: row, error } = await db
    .from("channel_sessions").insert({
      organization_id: orgId,
      waha_session_name: sessionName,
      engine: body.engine,
      webhook_secret_encrypted: encryptedSecret,
      status: "STARTING",
      created_by: session.userId,
    }).select().single();
  if (error) return json({ error: error.message }, 500);

  // 2) Cria sessão na WAHA
  const webhookUrl = `${process.env.WAHA_WEBHOOK_PUBLIC_BASE_URL}` +
                     `/api/wa/webhook/${row.webhook_path_token}`;
  try {
    await getWahaClient().createSession({
      name: sessionName, engine: body.engine,
      webhookUrl, webhookSecret,
    });
  } catch (err) {
    await db.from("channel_sessions").update({
      status: "FAILED",
      status_reason: err instanceof Error ? err.message : String(err),
    }).eq("id", row.id);
    return json({ error: "waha_create_failed" }, 502);
  }

  return json({ id: row.id, status: "STARTING" }, 201);
}
```

### 5.2 Polling do QR

```ts
// apps/web/app/api/wa/sessions/[id]/qr/route.ts
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(req);
  if (!session) return json({ error: "unauthorized" }, 401);

  const { data: cs } = await getDb()
    .from("channel_sessions")
    .select("id, waha_session_name, status")
    .eq("id", params.id)
    .eq("organization_id", session.organizationId)
    .single();
  if (!cs) return json({ error: "not_found" }, 404);
  if (cs.status === "WORKING") return json({ error: "already_connected" }, 409);
  if (cs.status === "FAILED")  return json({ error: "session_failed" }, 409);

  try {
    const qr = await getWahaClient().getQR(cs.waha_session_name);
    return json({ status: cs.status, qr_image_base64: qr.image });
  } catch (err) {
    if (err instanceof WahaError && err.code === "qr_not_available") {
      return json({ status: cs.status, qr_image_base64: null });
    }
    throw err;
  }
}
```

Frontend faz polling a cada 5s; força refresh do QR a cada 30s mesmo sem mudança (QR expira ~60s).

### 5.3 Webhook `session.status=WORKING`

Quando WAHA emite `session.status` com `status='WORKING'`, payload inclui `me.id` (formato `5511999998888@c.us`). Handler extrai phone_number:

```ts
function handleSessionStatus(payload: any, csRow: any, db: Db) {
  const newStatus = payload.status as WahaSessionStatus;
  const phoneFromWaha = payload?.me?.id?.split("@")[0];
  const phoneE164 = phoneFromWaha ? `+${phoneFromWaha}` : null;

  return db.from("channel_sessions").update({
    status: newStatus,
    status_reason: payload.reason ?? null,
    phone_number: phoneE164 ?? csRow.phone_number,
    display_name: payload?.me?.pushName ?? csRow.display_name,
    last_status_change_at: new Date().toISOString(),
    warmup_started_at:
      newStatus === "WORKING" && !csRow.warmup_started_at
        ? new Date().toISOString() : csRow.warmup_started_at,
  }).eq("id", csRow.id);
}
```

### 5.4 UI flow (mockup textual)

```
┌─────────────────── Conectar número WhatsApp ───────────────────┐
│                                                                │
│   [1] Criando sessão...                                        │
│       ↓ (≤10s)                                                 │
│   [2] ┌────────────────────────┐                               │
│       │   ████  ▓▓  ████  ▓▓   │                               │
│       │   ██  ████  ██  ████   │   Escaneie com seu WhatsApp:  │
│       │   ████  ██  ████  ██   │   1. Abra WhatsApp → Aparelhos│
│       │   ██  ▓▓██  ██  ████   │   2. Conectar um aparelho     │
│       │   ████  ██  ████  ██   │   3. Aponte a câmera aqui     │
│       └────────────────────────┘                               │
│                                                                │
│       Atualiza em 23s (auto-refresh)         [Cancelar]        │
│       ↓ (após scan, ≤5s)                                       │
│   [3] ✓ Conectado: +55 11 99999-8888 (João da Silva)          │
│       Status: WORKING                       [Ir pra inbox]     │
└────────────────────────────────────────────────────────────────┘
```

---

## 6. Webhook Receiver Inbound

### 6.1 Handler completo

```ts
// apps/web/app/api/wa/webhook/[token]/route.ts
import { NextRequest } from "next/server";
import crypto from "node:crypto";
import { getDb } from "@/server/db";
import { decryptSecret } from "@/server/crypto";
import { logger } from "@/server/logger";
import { resolveContactFromInbound } from "@/server/customer-360/identity";

export const runtime = "nodejs";          // precisa de Node crypto
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { token: string } },
) {
  const rawBody = await req.text();         // CRU — antes de qualquer parse
  const signatureHeader = req.headers.get("x-webhook-hmac") ?? "";

  const db = getDb();

  // 1) Resolver tenant via webhook_path_token
  const { data: cs } = await db
    .from("channel_sessions")
    .select("id, organization_id, waha_session_name, webhook_secret_encrypted, status")
    .eq("webhook_path_token", params.token)
    .single();

  // Sempre logar (mesmo se token inválido) com flag
  if (!cs) {
    await db.from("webhook_events_log").insert({
      raw_body: rawBody, headers: headersToJson(req.headers),
      webhook_path_token: params.token,
      valid_signature: false, status: "error",
      error_message: "unknown_webhook_path_token",
      signature_header: signatureHeader,
    });
    return new Response(null, { status: 401 });
  }

  // 2) Validar HMAC-SHA512 (timing-safe)
  const secret = decryptSecret(cs.webhook_secret_encrypted);
  const valid = verifyHmacSha512(rawBody, signatureHeader, secret);

  if (!valid) {
    await db.from("webhook_events_log").insert({
      raw_body: rawBody, headers: headersToJson(req.headers),
      webhook_path_token: params.token,
      organization_id: cs.organization_id,
      channel_session_id: cs.id,
      valid_signature: false, status: "error",
      error_message: "hmac_validation_failed",
      signature_header: signatureHeader,
    });
    return new Response(null, { status: 401 });
  }

  // 3) Parse e log raw
  let payload: any;
  try { payload = JSON.parse(rawBody); }
  catch { return new Response(null, { status: 400 }); }

  const { data: logRow } = await db.from("webhook_events_log").insert({
    raw_body: rawBody, payload_parsed: payload,
    headers: headersToJson(req.headers),
    webhook_path_token: params.token,
    organization_id: cs.organization_id,
    channel_session_id: cs.id,
    valid_signature: true,
    event_type: payload.event,
    external_id: payload?.payload?.id ?? null,
    signature_header: signatureHeader,
    status: "received",
  }).select("id").single();

  // 4) Despachar por tipo de evento
  try {
    await dispatchWahaEvent({ db, cs, payload });
    await db.from("webhook_events_log").update({
      status: "processed", processed_at: new Date().toISOString(),
    }).eq("id", logRow!.id);
  } catch (err) {
    logger.error({ err, logId: logRow?.id }, "wa_webhook_dispatch_failed");
    await db.from("webhook_events_log").update({
      status: "error",
      error_message: err instanceof Error ? err.message : String(err),
      attempts: 1,
    }).eq("id", logRow!.id);
    // 200 mesmo em erro: cron `process-pending-webhooks` re-processa
  }

  return new Response(null, { status: 200 });
}

function verifyHmacSha512(rawBody: string, header: string, secret: string): boolean {
  if (!header) return false;
  // WAHA envia formato 'sha512=<hex>'
  const expected = header.startsWith("sha512=") ? header.slice(7) : header;
  const computed = crypto
    .createHmac("sha512", secret)
    .update(rawBody)
    .digest("hex");
  if (expected.length !== computed.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(computed, "hex"),
  );
}
```

### 6.2 Dispatch por tipo

```ts
async function dispatchWahaEvent(ctx: {
  db: Db; cs: ChannelSessionRow; payload: any;
}) {
  const { db, cs, payload } = ctx;
  switch (payload.event) {
    case "session.status":
      return handleSessionStatus(payload.payload, cs, db);
    case "message":
    case "message.any":
      return handleInboundMessage(payload.payload, cs, db);
    case "message.ack":
      return handleMessageAck(payload.payload, cs, db);
    default:
      logger.warn({ event: payload.event }, "wa_event_unhandled");
  }
}

async function handleInboundMessage(
  msg: WahaMessagePayload, cs: ChannelSessionRow, db: Db,
) {
  // W-09: grupos não criam lead, apenas persistem
  const isGroup = msg.from?.endsWith("@g.us") || msg.chatId?.endsWith("@g.us");

  // Phone E.164 do remetente real
  const senderRaw = isGroup ? msg.author : msg.from;
  const senderPhone = senderRaw ? `+${senderRaw.split("@")[0]}` : null;
  if (!senderPhone) throw new Error("no_sender_phone");

  // W-10: outbound vindo de outro device (fromMe=true) — tratar idempotente
  const direction: "inbound" | "outbound" =
    msg.fromMe ? "outbound" : "inbound";

  // Upsert contact (Sub-PRD 02 §3.3) — pula em grupo
  let contactId: string;
  if (isGroup) {
    contactId = await getOrCreateGroupGhostContact(db, cs.organization_id, msg.chatId);
  } else {
    contactId = await resolveContactFromInbound(db, {
      organization_id: cs.organization_id,
      phone_e164: senderPhone,
      display_name: msg.notifyName ?? msg.pushName,
    });
  }

  // Upsert conversation
  const { data: conv } = await db.from("conversations").upsert({
    organization_id: cs.organization_id,
    contact_id: contactId,
    channel_session_id: cs.id,
    is_group: isGroup,
    group_chat_id: isGroup ? msg.chatId : null,
    last_message_at: new Date(msg.timestamp * 1000).toISOString(),
    last_message_preview: previewOf(msg),
    last_inbound_at:
      direction === "inbound" ? new Date(msg.timestamp * 1000).toISOString() : undefined,
    last_outbound_at:
      direction === "outbound" ? new Date(msg.timestamp * 1000).toISOString() : undefined,
  }, { onConflict: "organization_id,contact_id,channel_session_id,group_chat_id" })
    .select("id").single();

  // Mídia: persistir em Storage se aplicável
  let mediaInfo: MediaInfo | null = null;
  if (msg.hasMedia) {
    mediaInfo = await persistMediaFromWaha(msg, cs.organization_id, conv!.id);
  }

  // INSERT message — captura 23505 (W-05)
  try {
    const { error } = await db.from("messages").insert({
      organization_id: cs.organization_id,
      conversation_id: conv!.id,
      channel_session_id: cs.id,
      contact_id: contactId,
      external_id: msg.id,
      type: mapWahaType(msg.type),
      direction,
      status: direction === "inbound" ? "received"
              : msg.fromMe ? "sent" : "received",
      ack: msg.ack,
      body: msg.body ?? null,
      media_url: mediaInfo?.url ?? null,
      media_mime: mediaInfo?.mime ?? null,
      media_size_bytes: mediaInfo?.size ?? null,
      media_storage_path: mediaInfo?.path ?? null,
      sent_via: msg.fromMe ? "external_device" : "crm",  // crm já teria insertado antes
      sent_at: new Date(msg.timestamp * 1000).toISOString(),
      metadata: { is_group: isGroup, raw_type: msg.type },
    });
    if (error && (error as any).code === "23505") {
      // Idempotência — ok, já temos
      return;
    }
    if (error) throw error;
  } catch (e: any) {
    if (e?.code === "23505") return;  // belt + suspenders
    throw e;
  }

  // Atividade na timeline (skip em grupo) — vide Sub-PRD 02
  if (!isGroup) {
    await insertLeadActivity(db, {
      organization_id: cs.organization_id,
      contact_id: contactId,
      type: direction === "inbound" ? "whatsapp_inbound" : "whatsapp_outbound",
      source_module: "whatsapp",
      source_id: msg.id,
    });
  }

  // Emit event_log (consumido por IA, atendimento, sentiment, billing)
  await db.from("event_log").insert({
    organization_id: cs.organization_id,
    event_type: direction === "inbound"
      ? "whatsapp.message_received"
      : "whatsapp.message_sent_externally",
    payload: {
      conversation_id: conv!.id,
      contact_id: contactId,
      channel_session_id: cs.id,
      external_id: msg.id,
      is_group: isGroup,
      body_preview: previewOf(msg),
    },
  });

  // W-02: detector STOP — apenas inbound de não-grupo
  if (direction === "inbound" && !isGroup && msg.type === "chat" && msg.body) {
    if (isStopMessage(msg.body)) {
      await markContactBlockedByStop(db, cs.organization_id, contactId, msg.id);
    }
  }
}
```

### 6.3 Idempotência

A captura de `code === '23505'` ocorre em **dois lugares** (defesa em profundidade): (1) no insert direto e (2) no catch genérico. A constraint `messages_org_external_id_unique` é `deferrable initially deferred` pra suportar o fluxo de outbound (insert sem `external_id`, update após despacho).

### 6.4 Tipos suportados

```ts
function mapWahaType(t: string): MessageType {
  switch (t) {
    case "chat":      return "text";
    case "image":     return "image";
    case "video":     return "video";
    case "ptt":
    case "audio":     return "audio";
    case "document":  return "document";
    case "sticker":   return "sticker";
    case "location":  return "location";
    case "vcard":     return "contact";
    case "reaction":  return "reaction";
    case "revoked":
    case "edited":    return "system";
    default:          return "system";
  }
}
```

Mensagens `revoked`/`edited` atualizam o registro original via `external_id` em vez de inserir nova linha; histórico vai pra `metadata.previous_text` / `metadata.is_revoked=true`.

---

## 7. Send Pipeline (Outbound)

### 7.1 Endpoint `POST /api/wa/send`

```ts
// apps/web/app/api/wa/send/route.ts
import { z } from "zod";

const Body = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    conversation_id: z.string().uuid(),
    body: z.string().min(1).max(64_000),
  }),
  z.object({
    type: z.literal("image"),
    conversation_id: z.string().uuid(),
    storage_path: z.string(),
    caption: z.string().max(1024).optional(),
  }),
  z.object({
    type: z.literal("document"),
    conversation_id: z.string().uuid(),
    storage_path: z.string(),
    filename: z.string().min(1).max(255),
    caption: z.string().max(1024).optional(),
  }),
  z.object({
    type: z.literal("audio"),
    conversation_id: z.string().uuid(),
    storage_path: z.string(),
  }),
]);

export async function POST(req: NextRequest) {
  const session = await getServerSession(req);
  if (!session) return json({ error: "unauthorized" }, 401);
  const body = Body.parse(await req.json());

  const db = getDb();
  const conv = await loadConvWithGuards(db, body.conversation_id, session);
  if (!conv) return json({ error: "not_found" }, 404);

  // W-04 (janela 24h) é alertado mas não bloqueia humano
  // W-03 (contato bloqueado) — endpoint humano permite mas exige confirm
  // W-08 (mídia inline >1MB → Storage) — UI já forçou isso

  // AT-07: chunking de texto
  let chunks: SendChunk[];
  if (body.type === "text" && body.body.length > 4000) {
    chunks = chunkText(body.body, 4000).map((c, i, arr) => ({
      type: "text", body: c,
      metadata: { chunk_index: i, chunk_total: arr.length },
    }));
  } else {
    chunks = [body as unknown as SendChunk];
  }

  const messageIds: string[] = [];
  for (const chunk of chunks) {
    // 7.2: optimistic insert — status='sending'
    const { data: msg, error } = await db.from("messages").insert({
      organization_id: session.organizationId,
      conversation_id: conv.id,
      channel_session_id: conv.channel_session_id,
      contact_id: conv.contact_id,
      type: chunk.type,
      direction: "outbound",
      status: "sending",
      body: chunk.type === "text" ? chunk.body : null,
      media_storage_path: chunk.type !== "text" ? chunk.storage_path : null,
      sent_via: "crm",
      sent_by_user_id: session.userId,
      external_id: null,
      metadata: chunk.metadata ?? {},
    }).select().single();
    if (error) throw error;
    messageIds.push(msg.id);

    // Enfileira no pg_boss
    await getQueue().send("waha-send", {
      message_id: msg.id,
      organization_id: session.organizationId,
      channel_session_id: conv.channel_session_id,
    }, {
      singletonKey: `send-${conv.channel_session_id}-${msg.id}`,
      retryLimit: 5,
      retryBackoff: true,
      retryDelay: 5,
    });
  }

  return json({ message_ids: messageIds }, 202);
}
```

### 7.2 Worker pg_boss

```ts
// apps/web/src/server/queues/waha-send.worker.ts
import PgBoss from "pg-boss";
import { getDb } from "@/server/db";
import { getWahaClient, WahaError } from "@/server/waha/client";
import { acquireSendLock } from "./send-lock";
import { signedUrlFor } from "@/server/storage";

export async function registerWahaSendWorker(boss: PgBoss) {
  await boss.work<SendJob>(
    "waha-send",
    { teamSize: 4, teamConcurrency: 1, batchSize: 1 },
    async ([job]) => {
      const db = getDb();
      const { data: msg } = await db.from("messages")
        .select("*, channel_session:channel_sessions(*), contact:contacts(*)")
        .eq("id", job.data.message_id)
        .single();
      if (!msg || msg.status !== "sending") return;     // já processada

      // W-01: rate limit por sessão (1 msg/1.2s + jitter ≤800ms)
      await acquireSendLock(msg.channel_session_id);

      // W-03: re-check bloqueio (caso tenha mudado entre enqueue e dispatch)
      if (msg.contact.is_blocked && msg.sent_via !== "crm") {
        await failMessage(db, msg.id, "contact_blocked", "Contact STOP'd");
        return;
      }

      const chatId = `${msg.contact.phone_number.replace("+","")}@c.us`;
      const waha = getWahaClient();

      try {
        let res: { id: { _serialized: string } };
        switch (msg.type) {
          case "text":
            res = await waha.sendText({
              session: msg.channel_session.waha_session_name,
              chatId, text: msg.body!,
            });
            break;
          case "image": {
            const url = await signedUrlFor(msg.media_storage_path!, 30 * 60);
            res = await waha.sendImage({
              session: msg.channel_session.waha_session_name,
              chatId, fileUrl: url, caption: msg.body ?? undefined,
            });
            break;
          }
          case "audio": {
            const url = await signedUrlFor(msg.media_storage_path!, 30 * 60);
            res = await waha.sendVoice({
              session: msg.channel_session.waha_session_name,
              chatId, fileUrl: url,
            });
            break;
          }
          case "document": {
            const url = await signedUrlFor(msg.media_storage_path!, 30 * 60);
            res = await waha.sendFile({
              session: msg.channel_session.waha_session_name,
              chatId, fileUrl: url,
              filename: msg.metadata?.filename ?? "file",
              caption: msg.body ?? undefined,
            });
            break;
          }
          default:
            throw new Error(`unsupported_type_${msg.type}`);
        }

        // 7.5: marca sent + external_id
        await db.from("messages").update({
          status: "sent",
          external_id: res.id._serialized,
          sent_at: new Date().toISOString(),
        }).eq("id", msg.id);

        // Bump warmup counter
        await bumpWarmupCounter(db, msg.organization_id, msg.channel_session_id);
      } catch (err) {
        if (err instanceof WahaError &&
            ["network","timeout","upstream_5xx","rate_limited"].includes(err.code)) {
          throw err;   // pg_boss retry com backoff exponencial
        }
        await failMessage(
          db, msg.id,
          err instanceof WahaError ? err.code : "unknown",
          err instanceof Error ? err.message : String(err),
        );
      }
    },
  );
}
```

### 7.3 Send lock (rate limiter §8.1)

Vide §8.1 — implementação completa do `acquireSendLock`.

### 7.4 Retry exponencial

pg_boss `retryLimit: 5` + `retryBackoff: true` produz delays 5s → 25s → 125s → 625s → 3125s. Após esgotar, mensagem fica `failed` e atendente vê retry manual na UI.

### 7.5 Acks via webhook

```ts
async function handleMessageAck(payload: any, cs: ChannelSessionRow, db: Db) {
  const ack = payload.ack as number;  // -1, 0, 1, 2, 3, 4
  const status =
    ack === -1 ? "failed" :
    ack >= 3   ? "read" :
    ack >= 2   ? "delivered" :
    ack >= 1   ? "sent" : null;
  if (!status) return;

  await db.from("messages").update({
    status, ack,
    delivered_at: ack >= 2 ? new Date().toISOString() : undefined,
    read_at:      ack >= 3 ? new Date().toISOString() : undefined,
  })
  .eq("organization_id", cs.organization_id)
  .eq("external_id", payload.id);
}
```

### 7.6 Mídia outbound

UI faz upload direto pro Storage (signed URL com `fileSizeLimit: 16MB`); backend recebe `storage_path` e gera signed URL com TTL ≤30min na hora do dispatch (refresh se retry após expirar).

---

## 8. Anti-Banimento

### 8.1 Rate limiter por sessão (W-01)

```ts
// apps/web/src/server/queues/send-lock.ts
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const MIN_INTERVAL_MS = 1200;
const MAX_JITTER_MS   = 800;

export async function acquireSendLock(channelSessionId: string): Promise<void> {
  const key = `wa:sendlock:${channelSessionId}`;
  while (true) {
    const lastSent = Number(await redis.get(key) ?? 0);
    const now = Date.now();
    const wait = lastSent + MIN_INTERVAL_MS - now;
    if (wait > 0) {
      await sleep(wait + Math.floor(Math.random() * MAX_JITTER_MS));
      continue;
    }
    // Tentativa atômica de claim
    const claimed = await redis.set(key, String(now), {
      nx: true,
      ex: 10,                  // safety expiry (lock antigo solta sozinho)
    });
    if (claimed === "OK") {
      // Soltura: marcar timestamp REAL e deixar TTL grande
      await redis.set(key, String(Date.now()), { ex: 60 });
      const jitter = Math.floor(Math.random() * MAX_JITTER_MS);
      if (jitter > 0) await sleep(jitter);
      return;
    }
    // contenção: outro worker pegou; loop e re-checa
    await sleep(50 + Math.random() * 100);
  }
}
```

### 8.2 Spinning de copy

DSL: `Olá {oi|opa|e aí} {{first_name}}, viu o {pedido|seu pedido} #{{order_id}}?`

```ts
// apps/web/src/server/automation/spin.ts
export function spinCopy(
  template: string,
  vars: Record<string, string | number>,
): string {
  // 1) Substituir {{var}} primeiro (regex que não pega {opt|opt})
  const varRe = /\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g;
  let out = template.replace(varRe, (_, name) => {
    if (!(name in vars)) throw new Error(`spin_missing_var:${name}`);
    return String(vars[name]);
  });

  // 2) Resolver alternâncias {a|b|c} (não-aninhadas no MVP)
  const altRe = /\{([^{}]+?)\}/g;
  out = out.replace(altRe, (_, group) => {
    const opts = group.split("|").map((s: string) => s.trim());
    return opts[Math.floor(Math.random() * opts.length)];
  });
  return out;
}

export function validateCampaignVariations(templates: string[]): void {
  if (templates.length < 5) {
    throw new ValidationError("min_5_variations_required");
  }
  // Cobertura mínima: cada template deve produzir 5 variantes distintas
  for (const t of templates) {
    const seen = new Set<string>();
    for (let i = 0; i < 50 && seen.size < 5; i++) {
      seen.add(spinCopy(t, dummyVars(t)));
    }
    if (seen.size < 5) throw new ValidationError("template_too_static");
  }
}
```

### 8.3 Daily limit (W-06)

```ts
// apps/web/src/server/automation/daily-limit.ts
export async function consumeDailyQuota(
  channelSessionId: string,
  limit: number,
): Promise<{ ok: boolean; remaining: number }> {
  const day = new Date().toISOString().slice(0, 10);   // YYYY-MM-DD UTC
  const key = `wa:daily:${channelSessionId}:${day}`;
  const next = await redis.incr(key);
  if (next === 1) {
    // 36h TTL pra cobrir transição de fuso
    await redis.expire(key, 36 * 3600);
  }
  if (next > limit) {
    await redis.decr(key);                // rollback do incr
    return { ok: false, remaining: 0 };
  }
  return { ok: true, remaining: limit - next };
}
```

Chamado no worker antes de `acquireSendLock` apenas pra envios `automation`/`ai`; envios humanos (`crm`) ignoram (alertam mas não bloqueiam — decisão de produto).

### 8.4 Janela horária (W-07)

```ts
export function isWithinSendWindow(tenant: { timezone: string }, now = new Date()): boolean {
  const local = new Date(now.toLocaleString("en-US", { timeZone: tenant.timezone }));
  const hour = local.getHours();
  const dow  = local.getDay();   // 0 = domingo
  return dow !== 0 && hour >= 7 && hour < 22;
}

// Worker que enfileira fora de janela
export async function scheduleAutomatedSend(
  job: SendJob, tenant: { timezone: string }, boss: PgBoss,
) {
  if (isWithinSendWindow(tenant)) {
    await boss.send("waha-send", job);
    return;
  }
  const nextWindow = nextValidWindowStart(tenant);
  await boss.sendAfter("waha-send", job, {}, nextWindow);
}
```

### 8.5 Detector STOP (W-02)

```ts
const STOP_RE = /^\s*(stop|parar|pare|sair|sai|cancelar|unsubscribe|descadastrar)\s*[!.]*\s*$/i;

export function isStopMessage(body: string): boolean {
  return STOP_RE.test(body);
}

export async function markContactBlockedByStop(
  db: Db, orgId: string, contactId: string, sourceMessageId: string,
) {
  await db.from("contacts").update({ is_blocked: true })
    .eq("id", contactId).eq("organization_id", orgId);

  await db.from("crm_lead_activities").insert({
    organization_id: orgId,
    contact_id: contactId,
    type: "system",
    subtype: "contact_blocked_by_stop",
    metadata: { source_message_id: sourceMessageId, regex: "STOP_RE" },
  });

  await db.from("event_log").insert({
    organization_id: orgId,
    event_type: "contact.blocked",
    payload: { contact_id: contactId, reason: "stop_keyword" },
  });
}
```

### 8.6 Warm-up tracking

```ts
export async function bumpWarmupCounter(
  db: Db, orgId: string, channelSessionId: string,
) {
  const day = new Date().toISOString().slice(0, 10);
  await db.rpc("fn_bump_warmup", {
    p_org: orgId, p_session: channelSessionId, p_day: day,
  });
  // function impl: INSERT ... ON CONFLICT UPDATE SET messages_sent=messages_sent+1
}

export function recommendDailyLimit(daysActive: number): number {
  if (daysActive <  2) return  50;
  if (daysActive <  4) return 100;
  if (daysActive <  7) return 200;
  if (daysActive < 30) return 500;
  return 1000;
}
```

UI exibe alarmes: número novo enviou >50 no dia 1 → toast amarelo; dia 1 >100 → bloqueia novo envio automatizado.

---

## 9. Multi-Device & Multi-Atendente

### 9.1 Subscribe `message.any`

Configurado no `createSession` (§4.2) — `events: ["message.any", ...]`. Não usar `message` puro (perde outbound de outros devices).

### 9.2 Tratar `fromMe=true`

Na §6.2 — `direction='outbound'` + `sent_via='external_device'`. Se `external_id` já existe (CRM enviou e o eco voltou), `code === '23505'` cuida da idempotência.

### 9.3 Identificação do atendente

WAHA não retorna qual device enviou. Estratégia:

1. **Eco do CRM** — `messages.sent_by_user_id` foi setado no insert (§7.1). Eco webhook não atualiza esse campo.
2. **Device externo** — `sent_by_user_id = null`, `sent_via = 'external_device'`, UI marca como "Enviado pelo celular do tenant" em cinza.

Pra distinguir múltiplos celulares vinculados, fora do escopo MVP (WAHA não expõe).

---

## 10. Crons (Vercel Cron)

`vercel.json`:

```json
{
  "crons": [
    { "path": "/api/cron/wa/sync-sessions",            "schedule": "* * * * *" },
    { "path": "/api/cron/wa/recover-stuck-messages",   "schedule": "* * * * *" },
    { "path": "/api/cron/wa/process-pending-webhooks", "schedule": "* * * * *" }
  ]
}
```

Auth via header `Authorization: Bearer ${INTERNAL_CRON_SECRET}` + `x-vercel-cron: 1`.

### 10.1 `sync-sessions`

```ts
// apps/web/app/api/cron/wa/sync-sessions/route.ts
export async function GET(req: NextRequest) {
  if (!isCronAuthed(req)) return new Response(null, { status: 401 });

  const db = getDbServiceRole();
  const waha = getWahaClient();

  const { data: sessions } = await db
    .from("channel_sessions")
    .select("id, organization_id, waha_session_name, status, last_status_change_at")
    .neq("status", "FAILED")          // FAILED só sai por ação manual
    .neq("status", "STOPPED");

  const results: any[] = [];
  for (const cs of sessions ?? []) {
    try {
      const remote = await waha.getSession(cs.waha_session_name);
      const newStatus = remote.status;
      const updates: any = {
        last_health_check_at: new Date().toISOString(),
        consecutive_health_fails: 0,
      };
      if (newStatus !== cs.status) {
        updates.status = newStatus;
        updates.last_status_change_at = new Date().toISOString();
      }
      if (newStatus === "WORKING" && remote.me?.id && !cs.phone_number) {
        updates.phone_number = `+${remote.me.id.split("@")[0]}`;
      }
      await db.from("channel_sessions").update(updates).eq("id", cs.id);

      // W-11: STARTING há mais de 5 min → alerta
      if (newStatus === "STARTING") {
        const stuck =
          Date.now() - new Date(cs.last_status_change_at).getTime() > 5 * 60_000;
        if (stuck) await emitAlert(db, cs, "session_starting_too_long");
      }
      results.push({ id: cs.id, status: newStatus });
    } catch (err) {
      await db.from("channel_sessions").update({
        consecutive_health_fails: (cs as any).consecutive_health_fails + 1,
        last_health_check_at: new Date().toISOString(),
      }).eq("id", cs.id);
      results.push({ id: cs.id, error: String(err) });
    }
  }
  return Response.json({ checked: results.length, results });
}
```

### 10.2 `recover-stuck-messages` (W-12)

```ts
export async function GET(req: NextRequest) {
  if (!isCronAuthed(req)) return new Response(null, { status: 401 });
  const db = getDbServiceRole();
  const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();

  const { data: stuck } = await db.from("messages")
    .update({
      status: "failed",
      error_code: "stuck_in_sending",
      error_message: "Worker did not finish in 5 minutes",
    })
    .eq("status", "sending")
    .lt("created_at", cutoff)
    .select("id, organization_id, conversation_id");

  for (const m of stuck ?? []) {
    await db.from("event_log").insert({
      organization_id: m.organization_id,
      event_type: "message.failed",
      payload: { message_id: m.id, conversation_id: m.conversation_id, reason: "stuck" },
    });
  }
  return Response.json({ recovered: stuck?.length ?? 0 });
}
```

### 10.3 `process-pending-webhooks`

```ts
export async function GET(req: NextRequest) {
  if (!isCronAuthed(req)) return new Response(null, { status: 401 });
  const db = getDbServiceRole();

  const { data: pending } = await db.from("webhook_events_log")
    .select("*")
    .in("status", ["received","error"])
    .lt("attempts", 3)
    .order("received_at", { ascending: true })
    .limit(100);

  let processed = 0, dead = 0;
  for (const evt of pending ?? []) {
    try {
      const cs = await db.from("channel_sessions")
        .select("*").eq("id", evt.channel_session_id).single();
      await dispatchWahaEvent({
        db, cs: cs.data!, payload: evt.payload_parsed,
      });
      await db.from("webhook_events_log").update({
        status: "processed",
        processed_at: new Date().toISOString(),
        attempts: evt.attempts + 1,
      }).eq("id", evt.id);
      processed++;
    } catch (err) {
      const newAttempts = evt.attempts + 1;
      await db.from("webhook_events_log").update({
        status: newAttempts >= 3 ? "dead" : "error",
        attempts: newAttempts,
        error_message: err instanceof Error ? err.message : String(err),
      }).eq("id", evt.id);
      if (newAttempts >= 3) dead++;
    }
  }
  return Response.json({ processed, dead });
}
```

---

## 11. Edge Cases

### 11.1 QR expira

WhatsApp invalida QR em ~60s. Frontend:

```ts
// apps/web/components/qr-scan.tsx (essência)
useEffect(() => {
  if (status !== "SCAN_QR_CODE") return;
  const tick = async () => {
    const r = await fetch(`/api/wa/sessions/${id}/qr`);
    const d = await r.json();
    setQr(d.qr_image_base64);
    setStatus(d.status);
  };
  const fast = setInterval(tick, 5000);    // status check
  const refresh = setInterval(tick, 30_000); // force refresh
  return () => { clearInterval(fast); clearInterval(refresh); };
}, [status, id]);
```

### 11.2 Sessão STARTING indefinido

`sync-sessions` (§10.1) emite alerta `session_starting_too_long` em >5min; runbook:

1. Verificar logs WAHA (`docker logs deskcomm-waha --tail 500`).
2. Se volume `/app/.sessions` corrompido: backup + `docker volume rm` + re-criar sessão (re-scan obrigatório).
3. Documentar no incident log; super-admin notifica tenant.

### 11.3 Mídia >50MB inbound

```ts
async function persistMediaFromWaha(
  msg: WahaMessagePayload, orgId: string, conversationId: string,
): Promise<MediaInfo | null> {
  const sizeBytes = msg.media?.size ?? 0;
  if (sizeBytes > 50 * 1024 * 1024) {
    // WAHA Plus já guardou em S3 próprio; salvamos referência
    return {
      url: msg.media!.url!, mime: msg.media!.mimetype!,
      size: sizeBytes, path: `external://waha-s3/${msg.id}`,
    };
  }
  // Fluxo normal: download → re-upload pro Supabase Storage
  const buf = await fetchMedia(msg.media!.url!);
  const path = `${orgId}/${conversationId}/${msg.id}.${extOf(msg.media!.mimetype!)}`;
  await uploadToSupabaseStorage("whatsapp-media", path, buf, msg.media!.mimetype!);
  return { url: await signedUrlFor(path, 30*60), mime: msg.media!.mimetype!,
           size: sizeBytes, path };
}
```

### 11.4 Áudio OGG no Safari

MVP: `<audio preload="none">` + botão "Baixar" como fallback. Fast-follow opt-in: cron `transcode-audio` que roda ffmpeg (`-c:a aac -b:a 64k`) e adiciona `metadata.transcoded_url` na message; UI prefere transcoded em Safari.

### 11.5 Texto >4096 (AT-07)

```ts
export function chunkText(text: string, max = 4000): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(". ", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.3) cut = max;             // hard-cut, sem boundary boa
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}
```

### 11.6 Grupos (W-09)

`is_group=true` na conversation; lead/activity NÃO são criados (`if (!isGroup) await insertLeadActivity(...)` em §6.2).

### 11.7 Mensagem fora de ordem (W8)

UI sempre ordena por `sent_at desc` (não `created_at`). Re-render reativo via Supabase Realtime cobre o caso de mensagem chegar com `sent_at` anterior à última renderizada.

---

## 12. Eventos emitidos no `event_log`

| `event_type` | Payload | Emitido em | Consumidores |
|---|---|---|---|
| `whatsapp.message_received` | `{conversation_id, contact_id, channel_session_id, external_id, body_preview, is_group}` | webhook handler (inbound) | Sub-PRD 04 (atribuição), Sub-PRD 05 (IA, sentiment) |
| `whatsapp.message_sent_externally` | mesmo, `direction='outbound'` | webhook handler (`fromMe=true` novo) | Sub-PRD 04 (timeline) |
| `message.sent` | `{message_id, conversation_id, external_id}` | worker após `status=sent` | analytics, billing |
| `message.failed` | `{message_id, error_code, reason}` | cron stuck OU worker terminal | Sentry alert, atendente |
| `contact.blocked` | `{contact_id, reason}` | detector STOP | Sub-PRD 04, Sub-PRD 05 (guardrail) |
| `channel_session.status_changed` | `{from, to, reason}` | trigger DB | dashboard health, alerting |
| `channel_session.qr_expired` | `{}` | (futuro) cron QR refresh | UI notification |

---

## 13. Hospedagem WAHA

### 13.1 MVP — Railway

- 1 service Docker rodando o `docker-compose` simplificado (apenas `waha`).
- Variáveis de ambiente coladas do `.env.production`.
- Volume persistente provisionado (Railway Volumes) montado em `/app/.sessions` — **crítico** marcar como persistente.
- Domínio gerado pela Railway (`waha-deskcomm.up.railway.app`); usado em `WAHA_BASE_URL` (Vercel).
- Custo: $5-10/mês.

### 13.2 Produção — VPS própria

> Runbook operacional completo (passo-a-passo, troubleshooting, restore drill) em [`docs/runbooks/waha-vps.md`](../runbooks/waha-vps.md). Os parágrafos abaixo são referência rápida; o runbook é a fonte de verdade pra deploy/recuperação.

- Plano equivalente: Ubuntu 22.04/24.04 LTS, mín. 2 vCPU, 4GB RAM, 80GB SSD.
- Custo: ~R$140/mês (~$28/mês) num provedor típico com esse perfil. Datacenter mais próximo do público (latência baixa pro WhatsApp).
- Acesso root via painel do provedor ou SSH direto (escolher SSH-only após setup).
- Vários provedores de hospedagem com painel **não** oferecem Volume Snapshots nativos (diferente de cloud providers): backup/restore é responsabilidade nossa via `restic` → Backblaze B2.
- Instalação:
  ```bash
  apt-get update && apt-get install -y docker.io docker-compose-plugin nginx certbot python3-certbot-nginx ufw fail2ban restic
  ufw allow 22/tcp && ufw allow 443/tcp && ufw enable
  certbot --nginx -d waha.deskcomm.internal
  cd /opt/deskcomm-waha && docker compose up -d
  ```
- Nginx config: vide §2.4.
- Backup `restic` diário pra Backblaze B2 (volumes `/var/lib/docker/volumes/waha_sessions`).
- Monitoramento: UptimeRobot apontando pra `/api/server/version` (5 min ping); alerta em PagerDuty.
- **Egress allowlist**: Nginx só aceita conexões do range de IPs do Vercel (atualizado por cron diário consultando `https://api.vercel.com/v1/edge-config/...` ou hardcode atualizada manualmente).

### 13.3 Migração Railway → VPS própria

1. Criar VPS, configurar Nginx + TLS.
2. Subir docker-compose com volumes vazios.
3. Pause sessões (downtime planejado, ~5 min).
4. `restic restore` ou `rsync` do volume `/app/.sessions` da Railway pro VPS.
5. Atualizar `WAHA_BASE_URL` na Vercel.
6. Re-criar webhooks (mesma URL pública; não re-scan).

---

## 14. Plano de validação

### 14.1 Testes de integração obrigatórios

| ID | Cenário | Ferramenta |
|---|---|---|
| WA-IT-01 | Criar sessão → mockar QR → mockar `session.status=WORKING` → `phone_number` populado | Vitest + msw |
| WA-IT-02 | Webhook HMAC inválido → 401, nenhum write em `messages`, log com `valid_signature=false` | Vitest |
| WA-IT-03 | Webhook HMAC válido → contact + conversation + message + activity em <2s | Vitest + Postgres test container |
| WA-IT-04 | Webhook duplicado mesmo `external_id` → 200, sem duplicata | Vitest |
| WA-IT-05 | Webhook em grupo `@g.us` → message gravada `is_group=true`, sem activity | Vitest |
| WA-IT-06 | Send text → `sending` → mock WAHA 200 → `sent` com `external_id` | Vitest |
| WA-IT-07 | 100 msgs em lote → tempo total ≥ 160s (rate limit) | Vitest |
| WA-IT-08 | Inbound "PARAR" → `is_blocked=true` em <2s | Vitest |
| WA-IT-09 | Cron `sync-sessions` detecta `STOPPED` em <2min | Vitest + time mock |
| WA-IT-10 | Cron `recover-stuck-messages` em mensagem >5min → `failed` | Vitest |
| WA-IT-11 | `message.any` com `fromMe=true` (eco do CRM) → no-op idempotente | Vitest |
| WA-IT-12 | Texto 5000 chars → 2 messages com `metadata.chunk_*` corretos | Unit test |
| WA-IT-13 | Spinning template <5 variações distintas → 422 | Unit test |
| WA-IT-14 | Cross-tenant: webhook do tenant A NÃO aparece em queries do tenant B | Vitest + 2 RLS sessions |

### 14.2 Validação manual (E2E real)

1. Criar tenant + scan QR com número real teste.
2. Mandar inbound de outro celular; ver chegar na inbox em <5s.
3. Responder pelo CRM; conferir status `sending → sent → delivered → read`.
4. Mandar imagem 5MB; conferir Storage path correto + thumbnail.
5. Mandar áudio do celular do gerente; ver chegar como `external_device`.
6. Mandar "PARAR"; tentar campanha; conferir bloqueio.
7. Stop manual da sessão WAHA; conferir cron detecta + alerta em ≤2 min.
8. Restart container WAHA; conferir auto-recovery (sem re-scan).

### 14.3 Critérios de Go-Live

- [ ] 14 testes WA-IT-* passando no CI
- [ ] Validação manual completa em staging com 2 números reais
- [ ] Backup `restic` configurado e restore testado em dry-run
- [ ] Alertas Sentry/PagerDuty configurados pra sessão FAILED, dead-letter, cron failure
- [ ] Runbook de troca-de-número documentado e revisado por 2 engenheiros
- [ ] Quota Vercel Cron e pg_boss dimensionada pra 10x carga estimada

---

## 15. Migrations

Ordem de aplicação (todas em `packages/db/migrations/`):

```
2026XXXXXX_03_01_extensions.sql            -- pgcrypto, uuid-ossp (idempotente)
2026XXXXXX_03_02_helpers.sql               -- fn_set_updated_at, fn_emit_message_event,
                                              fn_emit_channel_session_status_changed,
                                              fn_bump_warmup
2026XXXXXX_03_03_channel_sessions.sql      -- §3.1 + RLS + triggers
2026XXXXXX_03_04_channel_session_warmup.sql
2026XXXXXX_03_05_conversations.sql         -- §3.2 + RLS
2026XXXXXX_03_06_messages.sql              -- §3.3 + RLS + indexes + trigger
2026XXXXXX_03_07_webhook_events_log.sql    -- §3.4 + RLS read
2026XXXXXX_03_08_storage_bucket.sql        -- bucket whatsapp-media + RLS
2026XXXXXX_03_09_pgboss_schema.sql         -- pg_boss create schema
```

Smoke-test pós-migration (`scripts/migrate-smoke-wa.sql`):

```sql
-- Sanity: RLS ativa em todas
select tablename, rowsecurity from pg_tables
 where schemaname = 'public'
   and tablename in ('channel_sessions','channel_session_warmup',
                     'conversations','messages','webhook_events_log')
   and rowsecurity = false;
-- expect: 0 rows

-- Sanity: indexes esperados existem
select indexname from pg_indexes where schemaname = 'public'
  and indexname in (
    'idx_messages_conversation_sent',
    'idx_messages_org_status_created',
    'idx_conversations_open_unassigned',
    'idx_channel_sessions_health'
  );
-- expect: 4 rows
```

---

## Confirmação

Spec 03 escrita em `/Users/rafaelmelgaco/SonghaiCRM/docs/specs/03-spec-whatsapp-waha.md`. Contém: schema SQL completo das 5 tabelas (channel_sessions + warmup, conversations, messages, webhook_events_log) com RLS e indexes; wrapper TypeScript do WAHA com classes de erro; handlers completos de criação de sessão, webhook receiver com HMAC-SHA512 timing-safe, send pipeline com optimistic UI e pg_boss; rate limiter Redis (1msg/1.2s + jitter), spinning de copy DSL, daily limit, janela horária, detector STOP, warm-up; 3 crons; 7 edge cases tratados; hospedagem Railway → Hostgator; 14 testes de integração mapeados; 9 migrations ordenadas. Todas as regras W-01 a W-12, T-07 e AT-07 estão materializadas em código. Pronto pra crítica e Epics.
