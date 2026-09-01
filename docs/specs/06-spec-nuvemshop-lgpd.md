---
title: Spec Técnica 06 — Integração Nuvemshop + LGPD
parent: 06-prd-nuvemshop-lgpd.md
depends_on: 01-spec-platform-base.md, 02-spec-customer-360.md
version: 0.1
status: em revisão
date: 2026-04-28
owner: Songhai, Lda
referencia_arquitetural: docs/research/reference-synthesis.md
business_rules: L-01, L-02, L-03, L-04, L-05, L-06, L-07, L-08, L-09, L-10, B-05
---

# Spec Técnica 06 — Integração Nuvemshop + LGPD

> Tradução engenheirística do Sub-PRD 06. Fixa: o adapter `EcommercePlatformAdapter` e a impl `NuvemshopAdapter`, o schema SQL completo das tabelas `tenant_integrations`, `orders`, `nuvemshop_products` e o reuso de `webhook_events_log` (definida na Spec 03), o fluxo OAuth 2.0 com tokens encrypted-at-rest, os 8 receivers de webhook (5 operacionais + 3 LGPD), os workers de sync inicial e o pipeline LGPD reativo. Toda decisão diverge do bundle herdado **somente quando explicitamente justificada**.

---

## 1. Visão Geral

### 1.1 Objetivo

Conectar o SonghaiCRM ao backend de e-commerce do tenant (Nuvemshop no MVP) de forma **plugável**, **resiliente** e **LGPD-compliant**. Tudo o que entra ou sai pra um provedor e-commerce passa por uma camada de abstração (`EcommercePlatformAdapter`) que isola o domínio (`crm_leads`, `contacts`, `orders`) de qualquer mudança contratual ou substituição de provedor.

### 1.2 Componentes

```
┌──────────────────────┐    ┌─────────────────────────┐
│  Nuvemshop API/Hooks │◄──►│  NuvemshopAdapter (TS)  │
└──────────────────────┘    └────────────┬────────────┘
                                         │ implements
                                         ▼
                            ┌─────────────────────────┐
                            │ EcommercePlatformAdapter│
                            └────────────┬────────────┘
                                         │ usado por
                ┌────────────────────────┼────────────────────────┐
                ▼                        ▼                        ▼
      ┌─────────────────┐     ┌──────────────────┐    ┌──────────────────┐
      │ OAuth Routes    │     │ Webhook Routes   │    │ Workers (sync,   │
      │ /connect /cb    │     │ /nuvemshop/*     │    │ refresh, lgpd)   │
      └─────────────────┘     └────────┬─────────┘    └──────────────────┘
                                       │ emite
                                       ▼
                              ┌──────────────────┐
                              │   event_log      │
                              └──────────────────┘
                                       │ consumido por
                                       ▼
                              ┌──────────────────┐
                              │ Domain workers   │
                              │ (lead/contact)   │
                              └──────────────────┘
```

### 1.3 Princípios não-negociáveis

1. **Adapter stateless.** Estado vive em `tenant_integrations`, `webhook_events_log`, `orders`, `event_log`. O adapter é uma função de transformação.
2. **Trigger nunca faz HTTP.** Toda fan-out é via `event_log` consumido por worker (regra herdada).
3. **Pagar HMAC primeiro, pensar depois.** Rejeitar antes de logar conteúdo se HMAC inválido — mas log mínimo (sem payload) sempre.
4. **Idempotência forte.** `unique (organization_id, external_provider, external_event_id)` em `webhook_events_log`; `unique (organization_id, external_provider, external_id)` em `orders`.
5. **Tokens encrypted-at-rest com chave separada.** L-09. `pgcrypto` com `NUVEMSHOP_OAUTH_ENCRYPTION_KEY` distinto de `CPF_ENCRYPTION_KEY`.
6. **200 imediato.** Receiver retorna em <300ms p95; processamento downstream é assíncrono.
7. **LGPD é caminho feliz.** Os 3 webhooks LGPD têm pipeline próprio com auditoria reforçada e callback de confirmação à Nuvemshop.

### 1.4 Decisões fixadas nesta Spec

| Decisão | Escolha | Justificativa |
|---|---|---|
| App embedded vs External | **External** | Mais flexibilidade de UI custom (admin SonghaiCRM tem UX própria); evita iframe sandbox; consent renderizado no domínio Nuvemshop é suficiente |
| Lib Nuvemshop | **Wrapper próprio em `lib/nuvemshop/`** | SDK oficial PT-BR é incompleto pra webhooks LGPD; wrapper fino sobre `fetch` permite tipagem rigorosa e telemetria custom |
| Worker runtime | **Vercel Cron + Upstash QStash** pra jobs longos (>30s); Edge Functions pros receivers | Hobby/Pro têm limite de 5/15 min; QStash dá retry e dedupe de fila; mantém stack Vercel-only |
| Particionamento `webhook_events_log` | **Por mês (`PARTITION BY RANGE (received_at)`)** | Hot 90 dias acessível; partições antigas detacháveis pra cold S3 |
| Roteamento receiver | **`/api/v1/webhooks/nuvemshop/<event>?t=<webhook_path_token>`** | Token por tenant gerado no onboarding (Spec 01); evita subdomínio dinâmico |
| Mapeamento status | Tabela canônica + override em `tenant_integrations.store_metadata.stage_mapping` | Configurável por tenant (PRD §3.10) |
| Política retry | 8 tentativas, backoff `2^n` minutos (1, 2, 4, 8, 16, 32, 64, 128) com jitter ±20% | Total ~4h; depois DLQ |

---

## 2. Adapter Pattern

### 2.1 Interface TypeScript completa

`lib/ecommerce/types.ts`:

```typescript
export type IsoDate = string; // ISO 8601 with TZ
export type Cents = number;   // integer cents
export type CursorString = string;

export interface AdapterContext {
  organizationId: string;
  integrationId: string;
  // Provided by adapter factory; adapter does not read DB itself.
  credentials: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: IsoDate;
    scopes: string[];
    storeId?: string;
  };
  logger: Logger;
}

export interface FetchPage<T> {
  items: T[];
  nextCursor: CursorString | null;
  rateLimit: { remaining: number; retryAfterSeconds: number | null };
}

export interface NormalizedCustomer {
  externalId: string;
  email: string | null;
  phoneE164: string | null;
  cpf: string | null; // L-07: caller is responsible for at-rest encryption
  firstName: string | null;
  lastName: string | null;
  addresses: Array<{ zip: string; city: string; state: string; country: string; street: string }>;
  consent: { marketing: boolean | null; transactional: boolean | null };
  createdAt: IsoDate;
  updatedAt: IsoDate;
  raw: unknown; // sanitized snapshot for payload jsonb
}

export interface NormalizedOrderItem {
  productExternalId: string;
  variantExternalId: string | null;
  title: string;
  quantity: number;
  unitPriceCents: Cents;
  totalCents: Cents;
}

export interface NormalizedOrder {
  externalId: string;
  customerExternalId: string | null;
  status:
    | 'pending'        // order/created
    | 'paid'           // order/paid
    | 'cancelled'      // order/cancelled
    | 'fulfilled'      // order/fulfilled (sub-status in payload)
    | 'shipped'
    | 'delivered'
    | 'refunded';
  totalCents: Cents;
  currency: 'BRL';
  paymentMethod: string | null;
  fulfillmentStatus: 'unpacked' | 'packed' | 'shipped' | 'delivered' | null;
  trackingCode: string | null;
  items: NormalizedOrderItem[];
  shippingAddress: NormalizedCustomer['addresses'][number] | null;
  orderedAt: IsoDate;
  updatedAt: IsoDate;
  raw: unknown;
}

export interface NormalizedProduct {
  externalId: string;
  title: string;
  description: string | null;
  priceCents: Cents;
  availableQty: number;
  url: string | null;
  imageUrl: string | null;
  updatedAt: IsoDate;
  raw: unknown;
}

export interface WebhookSubscriptionResult {
  event: string;
  externalSubscriptionId: string;
  url: string;
}

export interface HealthStatus {
  ok: boolean;
  reason?: 'token_expired' | 'scope_missing' | 'store_disconnected' | 'rate_limited' | 'upstream_error';
  storeMetadata?: { storeId: string; storeName: string; planName: string };
}

export interface RedactResult {
  acceptedAt: IsoDate;
  cascade: { contacts: number; conversations: number; messages: number; activities: number; orders: number };
}

export interface ExportArchive {
  jsonUri: string; // signed URL; expires in 7d
  pdfUri: string;
  generatedAt: IsoDate;
  sha256: string;
}

export interface EcommercePlatformAdapter {
  readonly provider: 'nuvemshop' | 'vtex' | 'shopify' | 'mock';

  fetchOrders(ctx: AdapterContext, params: { since?: IsoDate; cursor?: CursorString; pageSize?: number }): Promise<FetchPage<NormalizedOrder>>;

  fetchCustomers(ctx: AdapterContext, params: { since?: IsoDate; cursor?: CursorString; pageSize?: number }): Promise<FetchPage<NormalizedCustomer>>;

  fetchProducts(ctx: AdapterContext, params: { cursor?: CursorString; pageSize?: number }): Promise<FetchPage<NormalizedProduct>>;

  subscribeWebhooks(ctx: AdapterContext, params: { events: string[]; baseUrl: string; pathToken: string }): Promise<WebhookSubscriptionResult[]>;

  unsubscribeWebhooks(ctx: AdapterContext, params: { externalSubscriptionIds: string[] }): Promise<void>;

  redactCustomer(ctx: AdapterContext, params: { customerExternalId: string }): Promise<RedactResult>;

  exportCustomerData(ctx: AdapterContext, params: { customerExternalId: string }): Promise<ExportArchive>;

  healthCheck(ctx: AdapterContext): Promise<HealthStatus>;

  // Refresh tokens; returns new credentials to be persisted by caller.
  refreshAccessToken(ctx: AdapterContext): Promise<{ accessToken: string; refreshToken: string; expiresAt: IsoDate; scopes: string[] }>;
}
```

### 2.2 Erros normalizados

```typescript
export class AdapterError extends Error {
  constructor(
    public readonly code:
      | 'platform_token_expired'
      | 'platform_token_invalid'
      | 'platform_scope_missing'
      | 'platform_rate_limited'
      | 'platform_not_found'
      | 'platform_validation'
      | 'platform_upstream_5xx'
      | 'platform_network',
    public readonly retryable: boolean,
    public readonly retryAfterSeconds: number | null,
    message: string,
    public readonly upstream?: { status: number; body: unknown },
  ) {
    super(message);
  }
}
```

Camada de domínio só lida com `AdapterError.code`; nunca importa client-specific.

### 2.3 Implementação `NuvemshopAdapter`

`lib/nuvemshop/adapter.ts` (esqueleto canônico — endpoints exatos seguem doc oficial Nuvemshop API v1):

```typescript
const NS_API_BASE = 'https://api.nuvemshop.com.br/v1';

export class NuvemshopAdapter implements EcommercePlatformAdapter {
  readonly provider = 'nuvemshop' as const;

  private async request<T>(ctx: AdapterContext, path: string, init: RequestInit & { idempotencyKey?: string } = {}): Promise<{ data: T; rateLimit: FetchPage<T>['rateLimit'] }> {
    const storeId = ctx.credentials.storeId!;
    const url = `${NS_API_BASE}/${storeId}${path}`;
    const headers: Record<string, string> = {
      'Authentication': `bearer ${ctx.credentials.accessToken}`,
      'User-Agent': 'SonghaiCRM/1.0 (info@songhai.cc)',
      'Content-Type': 'application/json',
      ...(init.idempotencyKey ? { 'Idempotency-Key': init.idempotencyKey } : {}),
    };
    const res = await fetch(url, { ...init, headers });
    const remaining = Number(res.headers.get('X-Rate-Limit-Remaining') ?? '999');
    const retryAfterSeconds = res.headers.get('Retry-After') ? Number(res.headers.get('Retry-After')) : null;

    if (res.status === 401) throw new AdapterError('platform_token_expired', true, null, 'Token expirado/invalido');
    if (res.status === 403) throw new AdapterError('platform_scope_missing', false, null, 'Escopo insuficiente');
    if (res.status === 404) throw new AdapterError('platform_not_found', false, null, 'Recurso nao encontrado');
    if (res.status === 429) throw new AdapterError('platform_rate_limited', true, retryAfterSeconds ?? 60, 'Rate limited');
    if (res.status >= 500) throw new AdapterError('platform_upstream_5xx', true, 30, `Upstream ${res.status}`);
    if (!res.ok) throw new AdapterError('platform_validation', false, null, `HTTP ${res.status}`, { status: res.status, body: await res.json().catch(() => null) });

    const data = await res.json() as T;
    return { data, rateLimit: { remaining, retryAfterSeconds } };
  }

  async fetchOrders(ctx, { since, cursor, pageSize = 50 }) {
    const qs = new URLSearchParams();
    qs.set('per_page', String(pageSize));
    if (since) qs.set('updated_at_min', since);
    if (cursor) qs.set('page', cursor);
    const { data, rateLimit } = await this.request<NuvemshopOrderRaw[]>(ctx, `/orders?${qs}`);
    return { items: data.map(mapOrder), nextCursor: data.length === pageSize ? String(Number(cursor ?? '1') + 1) : null, rateLimit };
  }

  async fetchCustomers(ctx, params) { /* idêntico, GET /customers */ }
  async fetchProducts(ctx, params)  { /* idêntico, GET /products  */ }

  async subscribeWebhooks(ctx, { events, baseUrl, pathToken }) {
    const out: WebhookSubscriptionResult[] = [];
    for (const event of events) {
      const url = `${baseUrl}/api/v1/webhooks/nuvemshop/${event.replace('/', '-')}?t=${pathToken}`;
      const { data } = await this.request<{ id: number; event: string; url: string }>(ctx, '/webhooks', {
        method: 'POST',
        body: JSON.stringify({ event, url }),
        idempotencyKey: `subscribe-${ctx.integrationId}-${event}`,
      });
      out.push({ event, externalSubscriptionId: String(data.id), url: data.url });
    }
    return out;
  }

  async unsubscribeWebhooks(ctx, { externalSubscriptionIds }) {
    for (const id of externalSubscriptionIds) {
      await this.request(ctx, `/webhooks/${id}`, { method: 'DELETE' });
    }
  }

  async redactCustomer(ctx, { customerExternalId }) {
    // Nuvemshop permite redact via API quando origem é tenant; quando origem é Nuvemshop, é só callback.
    // Aqui só confirmamos receipt — cascade interno é responsabilidade do worker LGPD.
    return {
      acceptedAt: new Date().toISOString(),
      cascade: { contacts: 0, conversations: 0, messages: 0, activities: 0, orders: 0 }, // preenchido pelo worker
    };
  }

  async exportCustomerData(ctx, params) {
    // Coletar via fetchCustomers + fetchOrders filtrados por externalId; agregação fica em worker.
    throw new Error('Export agregado é responsabilidade do worker LGPD; adapter só expõe primitives.');
  }

  async healthCheck(ctx) {
    try {
      const { data } = await this.request<{ id: number; name: string; plan_name: string }>(ctx, '/store');
      return { ok: true, storeMetadata: { storeId: String(data.id), storeName: data.name, planName: data.plan_name } };
    } catch (e) {
      if (e instanceof AdapterError) {
        const reason = e.code === 'platform_token_expired' ? 'token_expired'
                     : e.code === 'platform_scope_missing' ? 'scope_missing'
                     : e.code === 'platform_rate_limited' ? 'rate_limited'
                     : 'upstream_error';
        return { ok: false, reason };
      }
      return { ok: false, reason: 'upstream_error' };
    }
  }

  async refreshAccessToken(ctx) {
    const res = await fetch(`https://www.nuvemshop.com.br/apps/authorize/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.NUVEMSHOP_CLIENT_ID,
        client_secret: process.env.NUVEMSHOP_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: ctx.credentials.refreshToken,
      }),
    });
    if (!res.ok) throw new AdapterError('platform_token_invalid', false, null, 'Refresh failed');
    const body = await res.json();
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: new Date(Date.now() + body.expires_in * 1000).toISOString(),
      scopes: (body.scope as string).split(','),
    };
  }
}
```

### 2.4 Factory

`lib/ecommerce/factory.ts`:

```typescript
export async function getAdapter(provider: 'nuvemshop'): Promise<EcommercePlatformAdapter> {
  switch (provider) {
    case 'nuvemshop': return new NuvemshopAdapter();
    default: throw new Error(`Provider ${provider} não suportado nesta versão`);
  }
}

export async function loadContext(integrationId: string): Promise<AdapterContext> {
  // SELECT criptografado decryptado via fn_decrypt_oauth(); RLS verifica organization_id.
  const row = await sql`SELECT * FROM tenant_integrations WHERE id = ${integrationId}`;
  return {
    organizationId: row.organization_id,
    integrationId: row.id,
    credentials: {
      accessToken: await decryptOauth(row.oauth_access_token_encrypted),
      refreshToken: row.oauth_refresh_token_encrypted ? await decryptOauth(row.oauth_refresh_token_encrypted) : undefined,
      expiresAt: row.expires_at,
      scopes: row.scopes,
      storeId: row.store_metadata?.store_id,
    },
    logger: createLogger({ org: row.organization_id, integration: row.id }),
  };
}
```

---

## 3. Schema SQL

Migrations vivem em `supabase/migrations/`. Toda tabela tenant-aware tem `organization_id uuid not null` e RLS via `fn_user_org_ids()` (helper definido na Spec 01).

### 3.1 `tenant_integrations`

```sql
create extension if not exists pgcrypto;

create table public.tenant_integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (provider in ('nuvemshop', 'vtex', 'shopify')),

  -- OAuth credentials (encrypted with NUVEMSHOP_OAUTH_ENCRYPTION_KEY for provider='nuvemshop')
  oauth_access_token_encrypted bytea not null,
  oauth_refresh_token_encrypted bytea,
  scopes text[] not null default array[]::text[],
  expires_at timestamptz,

  status text not null default 'connecting'
    check (status in ('connecting', 'healthy', 'token_expired', 'scope_missing', 'disconnected', 'rate_limited', 'error')),
  status_reason text,

  -- Store metadata (non-secret): { store_id, store_name, plan_name, currency, country, ... }
  store_metadata jsonb not null default '{}'::jsonb,

  -- Webhook routing token (per tenant, per integration); rotatable via UI
  webhook_path_token text not null default encode(gen_random_bytes(24), 'hex'),
  webhook_secret_encrypted bytea not null, -- HMAC secret; rotatable

  -- Webhook subscriptions registered upstream
  webhook_subscriptions jsonb not null default '[]'::jsonb,
  -- shape: [{ event, external_subscription_id, url, subscribed_at }]

  last_sync_at timestamptz,
  last_health_check_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- 1 active integration per (org, provider) for MVP
  unique (organization_id, provider)
);

create index tenant_integrations_org_idx on public.tenant_integrations (organization_id);
create index tenant_integrations_status_idx on public.tenant_integrations (status) where status in ('token_expired', 'error');
create index tenant_integrations_expires_idx on public.tenant_integrations (expires_at) where expires_at is not null;
create unique index tenant_integrations_path_token_idx on public.tenant_integrations (webhook_path_token);

alter table public.tenant_integrations enable row level security;

create policy tenant_integrations_select on public.tenant_integrations
  for select using (organization_id in (select fn_user_org_ids()));

create policy tenant_integrations_admin_write on public.tenant_integrations
  for all using (
    organization_id in (select fn_user_org_ids())
    and fn_user_role_in_org(organization_id) in ('admin', 'manager')
  );
```

**Funções de criptografia** (env-only; chave nunca em DB):

```sql
-- Wrapper que usa pgsodium (preferido) ou pgcrypto + chave de env via Vault
create or replace function fn_encrypt_oauth(plaintext text)
returns bytea
language plpgsql
security definer
as $$
declare
  k text := current_setting('app.nuvemshop_oauth_key', true);
begin
  if k is null or length(k) < 32 then
    raise exception 'NUVEMSHOP_OAUTH_ENCRYPTION_KEY ausente';
  end if;
  return pgp_sym_encrypt(plaintext, k, 'cipher-algo=aes256');
end$$;

create or replace function fn_decrypt_oauth(ciphertext bytea)
returns text
language plpgsql
security definer
as $$
declare
  k text := current_setting('app.nuvemshop_oauth_key', true);
begin
  return pgp_sym_decrypt(ciphertext, k);
end$$;

revoke all on function fn_encrypt_oauth(text) from public;
revoke all on function fn_decrypt_oauth(bytea) from public;
grant execute on function fn_encrypt_oauth(text) to service_role;
grant execute on function fn_decrypt_oauth(bytea) to service_role;
```

A chave é injetada via `ALTER DATABASE ... SET app.nuvemshop_oauth_key = '...'` no provisioning (ou em `set_config()` por sessão de service_role). **Nunca** em SQL versionado.

### 3.2 `orders`

```sql
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  external_id text not null,
  external_provider text not null check (external_provider in ('nuvemshop', 'vtex', 'shopify')),

  -- linkage
  customer_external_id text,
  contact_id uuid references public.contacts(id) on delete set null,

  -- status mirror (not source of truth; lead is)
  status text not null check (status in ('pending', 'paid', 'cancelled', 'fulfilled', 'shipped', 'delivered', 'refunded')),
  total_cents bigint not null check (total_cents >= 0),
  currency char(3) not null default 'BRL',
  payment_method text,
  fulfillment_status text check (fulfillment_status in ('unpacked', 'packed', 'shipped', 'delivered')),
  tracking_code text,

  payload jsonb not null default '{}'::jsonb, -- last raw snapshot from provider (sanitized)
  ordered_at timestamptz not null,
  updated_at_remote timestamptz,

  is_anonymized boolean not null default false, -- L-04 cascade flag

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (organization_id, external_provider, external_id)
);

create index orders_org_ordered_idx on public.orders (organization_id, ordered_at desc);
create index orders_contact_idx on public.orders (contact_id) where contact_id is not null;
create index orders_status_idx on public.orders (organization_id, status);
create index orders_customer_external_idx on public.orders (organization_id, external_provider, customer_external_id);
create index orders_payload_gin on public.orders using gin (payload jsonb_path_ops);

alter table public.orders enable row level security;

create policy orders_tenant_select on public.orders
  for select using (organization_id in (select fn_user_org_ids()));

create policy orders_tenant_write on public.orders
  for all using (organization_id in (select fn_user_org_ids()))
  with check (organization_id in (select fn_user_org_ids()));
```

**Linkagem com `crm_leads`:** insert em `crm_lead_links` com `target_kind='order'`, `target_id=orders.id` (Sub-PRD 02).

### 3.3 `nuvemshop_products`

Cache local pra alimentar o RAG (Sub-PRD 05). Não duplica preço de pedido — produto evolui independentemente.

```sql
create table public.nuvemshop_products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  external_id text not null,

  title text not null,
  description text,
  price_cents bigint not null check (price_cents >= 0),
  available_qty integer not null default 0,
  url text,
  image_url text,

  -- For RAG ingestion pipeline (Sub-PRD 05); flag toggled by indexer worker
  rag_indexed_at timestamptz,
  rag_chunk_count integer not null default 0,

  payload jsonb not null default '{}'::jsonb,
  last_updated_at timestamptz not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (organization_id, external_id)
);

create index nuvemshop_products_org_idx on public.nuvemshop_products (organization_id);
create index nuvemshop_products_rag_pending_idx on public.nuvemshop_products (organization_id)
  where rag_indexed_at is null;
create index nuvemshop_products_title_trgm on public.nuvemshop_products using gin (title gin_trgm_ops);

alter table public.nuvemshop_products enable row level security;

create policy nuvemshop_products_tenant on public.nuvemshop_products
  for all using (organization_id in (select fn_user_org_ids()))
  with check (organization_id in (select fn_user_org_ids()));
```

### 3.4 `webhook_events_log` (reuso da Spec 03)

A tabela canônica é definida na Spec 03 (WhatsApp). Pra Nuvemshop reutilizamos com `provider='nuvemshop'`. Schema relevante (referência):

```sql
-- DEFINIDA EM 03-spec-whatsapp-waha.md; aqui apenas índices/constraints suplementares
-- Particionamento mensal por received_at.

-- Índice extra pra LGPD audit
create index if not exists webhook_events_log_lgpd_idx
  on public.webhook_events_log (organization_id, provider, event_type, received_at desc)
  where event_type in ('customer/redact', 'customer/data_request', 'store/redact');

-- Índice extra pra DLQ
create index if not exists webhook_events_log_dlq_idx
  on public.webhook_events_log (organization_id, provider)
  where status = 'dead_letter';
```

Campos esperados (contrato com Spec 03): `id`, `organization_id`, `provider`, `event_type`, `external_event_id`, `received_at`, `headers_sanitized jsonb`, `payload_sanitized jsonb`, `payload_raw_hash text`, `valid_signature bool`, `is_lgpd bool`, `status` (`received | processing | processed | failed | dead_letter`), `attempt_count int`, `last_attempt_at`, `last_error`, `processed_at`, `unique (organization_id, provider, external_event_id)`.

### 3.5 RLS — sumário

| Tabela | SELECT | INSERT/UPDATE/DELETE |
|---|---|---|
| `tenant_integrations` | membros do org | admin/manager do org |
| `orders` | membros do org | service_role + members (via API, role-checked acima) |
| `nuvemshop_products` | membros do org | service_role |
| `webhook_events_log` | super-admin + admin do org | service_role only |

### 3.6 Indexes consolidados

Já listados inline. Critério: cada query do hot path tem index dedicado.

---

## 4. OAuth Flow Nuvemshop

### 4.1 Decisão: External app

**External** (não embedded). Justificativa:
- UI custom no admin SonghaiCRM (sem iframe Nuvemshop sandbox)
- Permite callback em domínio próprio com cookie de sessão SonghaiCRM
- Mantém scopes mínimos visíveis ao admin antes do consent
- Fluxo idêntico pra reconexão (caso de primeira classe — PRD §3.3)

### 4.2 `connectNuvemshop` — Server Action canônica

> **Nota canônica (RECONCILIATION-LOG vs Spec 09 ADR-02)**: a forma idiomática Next.js 15 pra iniciar OAuth é uma **Server Action** chamada do botão "Conectar Nuvemshop", que internamente faz o `redirect()` pra Nuvemshop authorize URL. Mantém o mesmo `state` token (HMAC-protected) e o mesmo callback `/api/v1/integrations/nuvemshop/callback`. A rota `GET /api/v1/integrations/nuvemshop/connect` abaixo continua existindo como fallback pra clients server-to-server (ex: testes) mas o caminho default da UI é a Server Action.

```ts
// app/(app)/integrations/nuvemshop/_actions.ts
'use server';
import { redirect } from 'next/navigation';
import { requireOrgAdmin } from '@/lib/auth/guards';
import { generateOAuthState } from '@/lib/oauth/state';

export async function connectNuvemshop() {
  const { orgId, userId } = await requireOrgAdmin();
  const state = await generateOAuthState({ orgId, userId, provider: 'nuvemshop' });
  const url = new URL('https://www.nuvemshop.com.br/apps/authorize/authorize');
  url.searchParams.set('client_id', process.env.NUVEMSHOP_CLIENT_ID!);
  url.searchParams.set('state', state);
  redirect(url.toString());
}
```

Resto da seção descreve a rota REST `GET /connect` legacy/fallback:

### 4.2.1 `GET /api/v1/integrations/nuvemshop/connect` (fallback)

`app/api/v1/integrations/nuvemshop/connect/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth';
import { createState, signState } from '@/lib/oauth/state';

export async function GET(req: NextRequest) {
  const { user, organizationId } = await requireAuth(req);
  await requireRole(user, organizationId, ['admin', 'manager']);

  const state = await signState({
    organizationId,
    userId: user.id,
    nonce: crypto.randomUUID(),
    issuedAt: Date.now(),
  });

  const params = new URLSearchParams({
    client_id: process.env.NUVEMSHOP_CLIENT_ID!,
    state,
  });
  const authUrl = `https://www.nuvemshop.com.br/apps/${process.env.NUVEMSHOP_APP_ID}/authorize?${params}`;

  return NextResponse.redirect(authUrl, 302);
}
```

`state` é JWT (HS256 com `OAUTH_STATE_SECRET`) com TTL 10min — protege CSRF e amarra o callback ao tenant que iniciou.

### 4.3 `GET /api/v1/integrations/nuvemshop/callback?code=...&state=...`

```typescript
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return NextResponse.json({ error: 'missing_params' }, { status: 400 });

  const decoded = await verifyState(state); // throws if invalid/expired
  const { organizationId, userId } = decoded;

  // 4.4: trade code
  const tokenRes = await fetch('https://www.nuvemshop.com.br/apps/authorize/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.NUVEMSHOP_CLIENT_ID,
      client_secret: process.env.NUVEMSHOP_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
    }),
  });
  if (!tokenRes.ok) {
    await audit('integration.oauth_failed', { organizationId, provider: 'nuvemshop', reason: 'token_exchange' });
    return NextResponse.redirect('/admin/integrations/nuvemshop?error=token_exchange', 302);
  }
  const body = await tokenRes.json();
  // body: { access_token, token_type, scope, user_id (= store_id) }

  // 4.5: persist encrypted-at-rest
  const integrationId = await sql`
    insert into public.tenant_integrations (
      organization_id, provider,
      oauth_access_token_encrypted,
      oauth_refresh_token_encrypted,
      scopes, expires_at,
      status, store_metadata,
      webhook_secret_encrypted
    ) values (
      ${organizationId}, 'nuvemshop',
      fn_encrypt_oauth(${body.access_token}),
      ${body.refresh_token ? sql`fn_encrypt_oauth(${body.refresh_token})` : null},
      ${(body.scope as string).split(',')},
      ${body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null},
      'connecting', ${{ store_id: String(body.user_id) }},
      fn_encrypt_oauth(${crypto.randomUUID()})
    )
    on conflict (organization_id, provider) do update set
      oauth_access_token_encrypted = excluded.oauth_access_token_encrypted,
      oauth_refresh_token_encrypted = excluded.oauth_refresh_token_encrypted,
      scopes = excluded.scopes,
      expires_at = excluded.expires_at,
      status = 'connecting',
      store_metadata = tenant_integrations.store_metadata || excluded.store_metadata,
      updated_at = now()
    returning id
  `;

  // 4.6: schedule async post-connect job (healthcheck + auto-subscribe + initial sync)
  await enqueue('nuvemshop.post_connect', { integrationId: integrationId.id, organizationId });

  await audit('integration.connected', { organizationId, provider: 'nuvemshop', actor: userId });

  return NextResponse.redirect(`/admin/integrations/nuvemshop?ok=1`, 302);
}
```

### 4.6 Auto-subscribe nos 8 webhooks

Worker `nuvemshop.post_connect` (QStash):

```typescript
const EVENTS = [
  'order/created', 'order/paid', 'order/cancelled', 'order/fulfilled',
  'cart/abandoned',
  'customer/redact', 'customer/data_request', 'store/redact',
];

export async function postConnect({ integrationId, organizationId }: PostConnectJob) {
  const ctx = await loadContext(integrationId);
  const adapter = await getAdapter('nuvemshop');

  const health = await adapter.healthCheck(ctx);
  if (!health.ok) {
    await sql`update tenant_integrations set status='error', status_reason=${health.reason} where id=${integrationId}`;
    return;
  }

  const subs = await adapter.subscribeWebhooks(ctx, {
    events: EVENTS,
    baseUrl: process.env.PUBLIC_BASE_URL!,
    pathToken: (await sql`select webhook_path_token from tenant_integrations where id=${integrationId}`).webhook_path_token,
  });

  await sql`
    update tenant_integrations set
      status = 'healthy',
      store_metadata = store_metadata || ${health.storeMetadata},
      webhook_subscriptions = ${JSON.stringify(subs)},
      last_health_check_at = now()
    where id = ${integrationId}
  `;

  await enqueue('nuvemshop.sync_initial', { integrationId, organizationId });
}
```

### 4.7 Refresh token rotation worker

Cron `*/15 * * * *` (Vercel Cron) varre `tenant_integrations` com `expires_at < now() + interval '30 minutes'`:

```typescript
export async function refreshExpiringTokens() {
  const rows = await sql`
    select id from tenant_integrations
    where provider='nuvemshop' and status='healthy'
      and expires_at is not null
      and expires_at < now() + interval '30 minutes'
  `;
  for (const row of rows) {
    try {
      const ctx = await loadContext(row.id);
      const adapter = await getAdapter('nuvemshop');
      const fresh = await adapter.refreshAccessToken(ctx);
      await sql`
        update tenant_integrations set
          oauth_access_token_encrypted = fn_encrypt_oauth(${fresh.accessToken}),
          oauth_refresh_token_encrypted = fn_encrypt_oauth(${fresh.refreshToken}),
          expires_at = ${fresh.expiresAt},
          scopes = ${fresh.scopes},
          status = 'healthy',
          updated_at = now()
        where id = ${row.id}
      `;
      await audit('integration.token_refreshed', { integrationId: row.id });
    } catch (e) {
      await sql`update tenant_integrations set status='token_expired', status_reason=${String(e)} where id=${row.id}`;
      await notifyAdminTokenExpired(row.id);
    }
  }
}
```

---

## 5. 8 Webhook Receivers

Todos compartilham o mesmo middleware (`processWebhook`) que cumpre o pipeline canônico do PRD §3.6. Sufixo de path corresponde ao evento Nuvemshop com `/` substituído por `-`.

### 5.0 Middleware comum

`lib/nuvemshop/webhook-handler.ts`:

```typescript
const MAX_SKEW_MS = 5 * 60 * 1000;

export async function processWebhook(req: NextRequest, expectedEvent: string) {
  const url = new URL(req.url);
  const pathToken = url.searchParams.get('t');
  if (!pathToken) return NextResponse.json({ error: 'missing_token' }, { status: 401 });

  // 1. Resolver integration via path token (sem expor tenant)
  const integration = await sql`
    select id, organization_id, webhook_secret_encrypted
    from tenant_integrations where webhook_path_token = ${pathToken}
  `;
  if (!integration) return NextResponse.json({ error: 'unknown_token' }, { status: 401 });

  const rawBody = await req.text(); // CRITICAL: read raw before any json parse
  const signature = req.headers.get('x-linkedstore-hmac-sha256') ?? '';
  const secret = await decryptOauthValue(integration.webhook_secret_encrypted);

  // 2. HMAC validation
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const validSig = timingSafeEqual(signature, expected);

  // 3. Replay protection (timestamp header)
  const tsHeader = req.headers.get('x-nuvemshop-event-ts'); // hypothetical
  const skewOk = !tsHeader || Math.abs(Date.now() - Number(tsHeader)) < MAX_SKEW_MS;

  let payload: any;
  try { payload = JSON.parse(rawBody); } catch { payload = null; }

  const externalEventId = payload?.id ?? req.headers.get('x-nuvemshop-event-id') ?? crypto.randomUUID();
  const eventType = payload?.event ?? expectedEvent;

  // 4. Log raw (sempre, mesmo HMAC inválido)
  const logRow = await sql`
    insert into webhook_events_log (
      organization_id, provider, event_type, external_event_id,
      received_at, headers_sanitized, payload_sanitized, payload_raw_hash,
      valid_signature, is_lgpd, status, attempt_count
    ) values (
      ${integration.organization_id}, 'nuvemshop', ${eventType}, ${externalEventId},
      now(), ${sanitizeHeaders(req.headers)}, ${sanitizePayload(payload)},
      ${sha256(rawBody)},
      ${validSig && skewOk},
      ${eventType.startsWith('customer/') || eventType === 'store/redact'},
      ${validSig && skewOk ? 'received' : 'failed'},
      0
    )
    on conflict (organization_id, provider, external_event_id) do nothing
    returning id, status
  `;

  if (!validSig) return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });
  if (!skewOk)   return NextResponse.json({ error: 'webhook_timestamp_skew' }, { status: 401 });

  // 5. Idempotência: se já existia, retornar 200 (no-op)
  if (!logRow) return NextResponse.json({ ok: true, idempotent: true }, { status: 200 });

  // 6. Emit canonical event for downstream worker (200 imediato)
  await emitEvent({
    type: `nuvemshop.${eventType.replace('/', '_')}`,
    organizationId: integration.organization_id,
    payload: {
      integrationId: integration.id,
      webhookLogId: logRow.id,
      externalEventId,
      data: payload,
    },
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}
```

### 5.1 `POST /api/v1/webhooks/nuvemshop/order-created`

```typescript
export async function POST(req: NextRequest) {
  return processWebhook(req, 'order/created');
}
```

Worker consumidor de `nuvemshop.order_created`:

```typescript
async function handleOrderCreated(ev: Event) {
  const { integrationId, webhookLogId, data } = ev.payload;
  const orgId = ev.organizationId;

  const order = mapOrder(data); // NormalizedOrder
  const customer = data.customer ? mapCustomer(data.customer) : null;

  // Identity resolution determinística (Sub-PRD 02)
  let contactId: string | null = null;
  if (customer) {
    const result = await resolveContact(orgId, {
      email: customer.email, phoneE164: customer.phoneE164, cpf: customer.cpf,
    });
    if (result.kind === 'matched') contactId = result.contactId;
    else if (result.kind === 'created') contactId = result.contactId;
    else if (result.kind === 'conflict') {
      await enqueueMergeReview(orgId, result.candidates, { reason: 'nuvemshop_order_created' });
      contactId = result.bestCandidateId; // attach to best; merge UI resolves later
    }
  }

  // Upsert order (idempotente)
  const orderRow = await sql`
    insert into orders (
      organization_id, external_id, external_provider, customer_external_id,
      contact_id, status, total_cents, currency, payment_method,
      fulfillment_status, payload, ordered_at, updated_at_remote
    ) values (
      ${orgId}, ${order.externalId}, 'nuvemshop', ${order.customerExternalId},
      ${contactId}, 'pending', ${order.totalCents}, 'BRL', ${order.paymentMethod},
      ${order.fulfillmentStatus}, ${order.raw}, ${order.orderedAt}, ${order.updatedAt}
    )
    on conflict (organization_id, external_provider, external_id) do update set
      contact_id = coalesce(orders.contact_id, excluded.contact_id),
      payload = excluded.payload,
      updated_at_remote = excluded.updated_at_remote,
      updated_at = now()
    returning id
  `;

  // Create lead in pipeline "Pedidos", stage "Aguardando pagamento" (mapped)
  const stageId = await resolveStage(orgId, 'pedidos', 'aguardando_pagamento');
  const leadId = await sql`
    insert into crm_leads (organization_id, pipeline_id, stage_id, contact_id, value_cents, currency, status, source)
    values (${orgId}, ${stageId.pipeline_id}, ${stageId.id}, ${contactId}, ${order.totalCents}, 'BRL', 'open', 'nuvemshop')
    returning id
  `;

  await sql`
    insert into crm_lead_links (lead_id, target_kind, target_id)
    values (${leadId.id}, 'order', ${orderRow.id})
    on conflict do nothing
  `;

  await sql`
    insert into crm_lead_activities (organization_id, lead_id, type, payload, occurred_at)
    values (${orgId}, ${leadId.id}, 'nuvemshop_order_created', ${{ order_external_id: order.externalId, total_cents: order.totalCents }}, ${order.orderedAt})
  `;

  await sql`update webhook_events_log set status='processed', processed_at=now() where id=${webhookLogId}`;
}
```

### 5.2 `order/paid`

Move pra stage "Pago" (configurável). Atualiza `orders.status='paid'`, registra activity `nuvemshop_order_paid`. Se lead não existe ainda (race com `order/created`), cria-o (a query é a mesma do 5.1, com stage diferente). Idempotência protege.

### 5.3 `order/cancelled`

```typescript
async function handleOrderCancelled(ev: Event) {
  const order = mapOrder(ev.payload.data);
  const lostReason = mapCancellationReason(ev.payload.data.cancel_reason);
  // mapCancellationReason: 'customer' → 'cancelled_by_customer', 'fraud'/'inventory' → 'cancelled_by_store', etc.

  await sql`update orders set status='cancelled', payload=${order.raw}, updated_at=now()
            where organization_id=${ev.organizationId} and external_provider='nuvemshop' and external_id=${order.externalId}`;

  const lead = await sql`select cl.id from crm_leads cl
    join crm_lead_links cll on cll.lead_id = cl.id and cll.target_kind='order'
    join orders o on o.id = cll.target_id
    where o.organization_id=${ev.organizationId} and o.external_id=${order.externalId}`;

  if (lead) {
    await moveLeadToStage(lead.id, 'cancelado');
    await sql`update crm_leads set status='lost', lost_reason=${lostReason} where id=${lead.id}`;
    await recordActivity(lead.id, 'nuvemshop_order_cancelled', { lost_reason: lostReason });
  }
}
```

### 5.4 `order/fulfilled`

Lê `payload.fulfillment_status` ou `payload.shipping_status` da Nuvemshop. Mapeamento:

| Nuvemshop | Stage CRM (default) |
|---|---|
| `packed` | "Em separação" |
| `shipped` | "Enviado" |
| `delivered` | "Entregue" |

Atualiza `orders.fulfillment_status` + `orders.tracking_code`. Move lead. Activity `nuvemshop_order_fulfilled` com `fulfillment_status` no payload.

### 5.5 `cart/abandoned`

Cria lead em stage "Carrinho abandonado" (pipeline "Pedidos"). Não cria row em `orders` (carrinho não é pedido); cria activity `nuvemshop_cart_abandoned` com snapshot do carrinho (items, valor estimado). Target de recovery do chatbot RAG (Sub-PRD 05) e do operador.

### 5.6 `customer/redact` (LGPD)

Pipeline LGPD especial — cumpre L-01, L-03, L-06.

```typescript
async function handleCustomerRedact(ev: Event) {
  const { data, integrationId, webhookLogId } = ev.payload;
  const orgId = ev.organizationId;
  const customerExternalId = String(data.customer.id);

  // Mapear cliente Nuvemshop para contact local
  const contact = await sql`
    select c.id from contacts c
    join contact_external_ids cei on cei.contact_id = c.id
    where c.organization_id = ${orgId}
      and cei.provider = 'nuvemshop'
      and cei.external_id = ${customerExternalId}
  `;

  if (!contact) {
    // Customer só existia na Nuvemshop, sem footprint local — confirma sem cascade
    await audit('lgpd.redact_no_local_footprint', { orgId, customerExternalId, webhookLogId });
    await confirmRedactToNuvemshop(integrationId, customerExternalId);
    return;
  }

  // Enfileirar com SLA D+15
  await enqueue('lgpd.execute_redact', {
    organizationId: orgId,
    contactId: contact.id,
    sourceWebhookLogId: webhookLogId,
    integrationId,
    customerExternalId,
    deadline: addBusinessDays(new Date(), 15),
    alarmAt: addBusinessDays(new Date(), 10),
  });
}
```

Worker `lgpd.execute_redact` cumpre o cascade SQL (vide §7.1).

### 5.7 `customer/data_request` (LGPD)

```typescript
async function handleCustomerDataRequest(ev: Event) {
  await enqueue('lgpd.execute_data_request', {
    organizationId: ev.organizationId,
    customerExternalId: String(ev.payload.data.customer.id),
    integrationId: ev.payload.integrationId,
    requestedAt: ev.payload.data.created_at ?? new Date().toISOString(),
    deadline: addBusinessDays(new Date(), 7),
    alarmAt: addBusinessDays(new Date(), 5),
  });
}
```

Worker gera export (vide §7.2). SLA D+7 (L-02).

### 5.8 `store/redact` (LGPD massivo)

```typescript
async function handleStoreRedact(ev: Event) {
  const orgId = ev.organizationId;

  // Notificação imediata ao super-admin
  await notifySuperAdmin({
    severity: 'critical',
    type: 'lgpd.store_redact_received',
    organizationId: orgId,
    receivedAt: new Date().toISOString(),
  });

  await audit('lgpd.store_redact_received', {
    organizationId: orgId,
    integrationId: ev.payload.integrationId,
    emergency: true,
  });

  await enqueue('lgpd.execute_store_redact', {
    organizationId: orgId,
    integrationId: ev.payload.integrationId,
    sourceWebhookLogId: ev.payload.webhookLogId,
    emergency: true,
    deadline: addBusinessDays(new Date(), 15),
  });
}
```

Worker `lgpd.execute_store_redact` (vide §7.3).

### 5.9 Fluxo comum (resumo)

Já implementado em `processWebhook` §5.0:

1. Validate HMAC (rejeita 401 se inválido, mas grava log mínimo)
2. Log raw em `webhook_events_log`
3. Resolver tenant via `webhook_path_token`
4. Idempotência check (constraint UNIQUE)
5. Emit `nuvemshop.<event>` em `event_log`
6. Retornar 200 imediato

Workers consumidores fazem (5) resolver/criar contact + (6) aplicar mudança no domínio.

---

## 6. Workers de Sync Inicial

### 6.1 `syncProducts(integrationId)`

Cumpre B-05. Paginação cursor com respeito a `X-Rate-Limit-Remaining`.

```typescript
export async function syncProducts(integrationId: string) {
  const ctx = await loadContext(integrationId);
  const adapter = await getAdapter('nuvemshop');
  let cursor: string | null = null;
  let total = 0;

  while (true) {
    const page = await adapter.fetchProducts(ctx, { cursor: cursor ?? undefined, pageSize: 50 });

    for (const p of page.items) {
      await sql`
        insert into nuvemshop_products (organization_id, external_id, title, description, price_cents, available_qty, url, image_url, payload, last_updated_at)
        values (${ctx.organizationId}, ${p.externalId}, ${p.title}, ${p.description}, ${p.priceCents}, ${p.availableQty}, ${p.url}, ${p.imageUrl}, ${p.raw}, ${p.updatedAt})
        on conflict (organization_id, external_id) do update set
          title = excluded.title,
          description = excluded.description,
          price_cents = excluded.price_cents,
          available_qty = excluded.available_qty,
          url = excluded.url,
          image_url = excluded.image_url,
          payload = excluded.payload,
          last_updated_at = excluded.last_updated_at,
          rag_indexed_at = null,  -- forces re-indexing
          updated_at = now()
      `;
      total++;
    }

    await updateSyncProgress(integrationId, 'products', { itemsSynced: total, cursor });

    if (page.rateLimit.remaining < 5) {
      const waitMs = (page.rateLimit.retryAfterSeconds ?? 60) * 1000;
      await sleep(waitMs);
    }

    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  await sql`update tenant_integrations set last_sync_at = now() where id = ${integrationId}`;
  await emitEvent({ type: 'nuvemshop.products_synced', organizationId: ctx.organizationId, payload: { total } });
}
```

### 6.2 `syncCustomers(integrationId)`

Mesmo padrão. Cada customer roda identity resolution determinística (Sub-PRD 02). Conflito → `merge_queue`.

```typescript
for (const c of page.items) {
  const result = await resolveContact(ctx.organizationId, {
    email: c.email, phoneE164: c.phoneE164, cpf: c.cpf,
  });
  if (result.kind === 'conflict') {
    await enqueueMergeReview(ctx.organizationId, result.candidates, { reason: 'nuvemshop_initial_sync' });
  }
  // Garante external_id mapping
  await sql`
    insert into contact_external_ids (contact_id, provider, external_id)
    values (${result.contactId}, 'nuvemshop', ${c.externalId})
    on conflict (provider, external_id) do nothing
  `;
}
```

### 6.3 `syncOrders(integrationId, sinceDays = 90)`

```typescript
export async function syncOrders(integrationId: string, sinceDays = 90) {
  const ctx = await loadContext(integrationId);
  const adapter = await getAdapter('nuvemshop');
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();
  let cursor: string | null = null;

  while (true) {
    const page = await adapter.fetchOrders(ctx, { since, cursor: cursor ?? undefined, pageSize: 50 });

    for (const o of page.items) {
      // Idempotência via unique (org, provider, external_id)
      await applyOrderUpsert(ctx.organizationId, o);
      // Não cria activity retroativa duplicada — checamos existence antes
    }

    if (page.rateLimit.remaining < 5) await sleep((page.rateLimit.retryAfterSeconds ?? 60) * 1000);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
}
```

### 6.4 Progress tracking

Tabela auxiliar:

```sql
create table public.sync_progress (
  integration_id uuid not null references public.tenant_integrations(id) on delete cascade,
  domain text not null check (domain in ('products', 'customers', 'orders')),
  status text not null check (status in ('pending', 'running', 'completed', 'failed')),
  items_synced integer not null default 0,
  items_total integer,
  cursor text,
  started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (integration_id, domain)
);

alter table public.sync_progress enable row level security;
create policy sync_progress_tenant on public.sync_progress
  for select using (
    integration_id in (select id from tenant_integrations where organization_id in (select fn_user_org_ids()))
  );
```

UI admin lê `items_synced / items_total` + ETA computado por taxa observada (rolling 5 min).

### 6.5 Re-sync manual

```
POST /api/v1/integrations/nuvemshop/resync
body: { mode: 'all' | 'customers' | 'products' | 'last_7d_orders' }
```

Apenas role `admin`. Enfileira jobs correspondentes (mesmo código de §6.1–6.3 reutilizado, com `sinceDays=7` para o último modo).

---

## 7. LGPD Endpoints

### 7.1 Pipeline `customer/redact` (cascade SQL)

Worker `lgpd.execute_redact`:

```typescript
export async function executeRedact(job: RedactJob) {
  const { organizationId, contactId, sourceWebhookLogId, integrationId, customerExternalId } = job;

  const cascade = await sql.transaction(async tx => {
    // 1. Anonimizar contact
    await tx`
      update contacts set
        email = null,
        email_anon_hash = encode(digest(coalesce(email, ''), 'sha256'), 'hex'),
        phone_number = null,
        phone_anon_hash = encode(digest(coalesce(phone_number, ''), 'sha256'), 'hex'),
        cpf_encrypted = null,
        first_name = 'Cliente',
        last_name = 'Anonimizado #' || substring(id::text, 1, 8),
        is_anonymized = true,
        anonymized_at = now(),
        consent = '{}'::jsonb
      where id = ${contactId} and organization_id = ${organizationId}
    `;

    // 2. Conversations: limpar metadata sensível mas preservar timestamps
    const convs = await tx`
      update conversations set
        metadata = metadata - 'customer_name' - 'customer_email' - 'customer_phone',
        is_anonymized = true
      where contact_id = ${contactId} returning id
    `;

    // 3. Messages: redact de mídia + sanitização opcional de texto
    const msgs = await tx`
      update messages set
        media_url = null,
        media_storage_path = null,
        body = case when ${shouldRedactBody(organizationId)} then '[redacted]' else body end,
        is_anonymized = true
      where conversation_id in (select id from conversations where contact_id = ${contactId}) returning id
    `;
    // Storage cleanup é assíncrono (worker separado le messages.is_anonymized e remove blobs)
    await tx`insert into storage_redaction_queue (organization_id, message_ids) values (${organizationId}, ${msgs.map(m=>m.id)})`;

    // 4. Activities: sanitizar payload sensível, manter tipo + timestamp
    const acts = await tx`
      update crm_lead_activities set
        payload = jsonb_strip_nulls(payload - 'customer_name' - 'customer_email' - 'customer_phone' - 'cpf'),
        is_anonymized = true
      where lead_id in (select id from crm_leads where contact_id = ${contactId}) returning id
    `;

    // 5. Orders: PRESERVAR (obrigação fiscal); só marca flag pra documentar
    const orders = await tx`
      update orders set is_anonymized = true,
        payload = jsonb_strip_nulls(payload - 'customer' - 'billing_address' - 'shipping_address')
      where contact_id = ${contactId} returning id
    `;

    return { contacts: 1, conversations: convs.length, messages: msgs.length, activities: acts.length, orders: orders.length };
  });

  // 6. Audit denso — L-06, L-10
  await audit('lgpd.redact_executed', {
    organizationId,
    contactId,
    customerExternalId,
    mode: 'anonymize',
    cascadedTo: cascade,
    sourceWebhookLogId,
    confirmedAt: new Date().toISOString(),
  });

  // 7. Confirmar à Nuvemshop
  await confirmRedactToNuvemshop(integrationId, customerExternalId);

  await sql`update webhook_events_log set status='processed', processed_at=now() where id=${sourceWebhookLogId}`;
}
```

Cron de monitoramento dispara alarme em `alarmAt` se job ainda não foi processado.

### 7.2 Pipeline `customer/data_request`

Worker `lgpd.execute_data_request`:

```typescript
export async function executeDataRequest(job: DataRequestJob) {
  const { organizationId, customerExternalId, integrationId, deadline } = job;

  // 1. Coletar dados
  const contact = await sql`
    select c.* from contacts c
    join contact_external_ids cei on cei.contact_id = c.id
    where c.organization_id = ${organizationId} and cei.provider='nuvemshop' and cei.external_id=${customerExternalId}
  `;
  if (!contact) {
    await audit('lgpd.data_request_no_local_data', { organizationId, customerExternalId });
    return;
  }

  const orders = await sql`select * from orders where contact_id=${contact.id}`;
  const conversations = await sql`select * from conversations where contact_id=${contact.id}`;
  const messages = await sql`select * from messages where conversation_id in (select id from conversations where contact_id=${contact.id})`;
  const activities = await sql`select * from crm_lead_activities where lead_id in (select id from crm_leads where contact_id=${contact.id})`;

  // 2. Estruturar JSON conforme schema
  const exportJson = buildExportJson({ contact, orders, conversations, messages, activities });

  // 3. Gerar PDF assinado
  const pdfBuffer = await renderPdf({ exportJson, organizationId });
  const signedPdf = await signPdfPades(pdfBuffer, process.env.LGPD_SIGNING_KEY!);

  // 4. Upload em Storage privado, gerar URLs assinadas (TTL 7d)
  const jsonPath = `lgpd-exports/${organizationId}/${contact.id}/${Date.now()}.json`;
  const pdfPath  = `lgpd-exports/${organizationId}/${contact.id}/${Date.now()}.pdf`;
  await uploadStorage(jsonPath, JSON.stringify(exportJson), { contentType: 'application/json' });
  await uploadStorage(pdfPath, signedPdf, { contentType: 'application/pdf' });
  const jsonUri = await signedUrl(jsonPath, 7 * 86400);
  const pdfUri  = await signedUrl(pdfPath, 7 * 86400);

  // 5. Notificar tenant + entregar à Nuvemshop conforme contrato
  await deliverDataRequestExport(integrationId, customerExternalId, { jsonUri, pdfUri });

  await audit('lgpd.data_request_completed', {
    organizationId,
    contactId: contact.id,
    customerExternalId,
    sha256: { json: sha256(JSON.stringify(exportJson)), pdf: sha256(signedPdf) },
    deliveredAt: new Date().toISOString(),
    deadline,
  });
}
```

### 7.3 Pipeline `store/redact`

Operação grande. Worker `lgpd.execute_store_redact`:

```typescript
export async function executeStoreRedact(job: StoreRedactJob) {
  const { organizationId, integrationId, emergency } = job;

  // Modo emergency: roda em background mas com prioridade alta + audit reforçado
  await audit('lgpd.store_redact_started', { organizationId, emergency, integrationId });

  // Em batches de 1000 contacts pra evitar lock longo
  let lastId: string | null = null;
  const BATCH = 1000;
  let total = { contacts: 0, conversations: 0, messages: 0, activities: 0, orders: 0 };

  while (true) {
    const batch = await sql`
      select id from contacts
      where organization_id = ${organizationId} and is_anonymized = false
        ${lastId ? sql`and id > ${lastId}` : sql``}
      order by id limit ${BATCH}
    `;
    if (batch.length === 0) break;

    for (const c of batch) {
      const cascade = await runRedactTransaction(organizationId, c.id);
      total.contacts += cascade.contacts;
      total.conversations += cascade.conversations;
      total.messages += cascade.messages;
      total.activities += cascade.activities;
      total.orders += cascade.orders;
    }
    lastId = batch[batch.length - 1].id;
  }

  // Desconectar OAuth + revogar webhooks
  const ctx = await loadContext(integrationId);
  const adapter = await getAdapter('nuvemshop');
  const subs = (await sql`select webhook_subscriptions from tenant_integrations where id=${integrationId}`).webhook_subscriptions;
  await adapter.unsubscribeWebhooks(ctx, { externalSubscriptionIds: subs.map((s: any) => s.external_subscription_id) }).catch(() => {});

  await sql`update tenant_integrations set status='disconnected', oauth_access_token_encrypted=fn_encrypt_oauth(''), oauth_refresh_token_encrypted=null where id=${integrationId}`;

  await audit('lgpd.store_redact_executed', {
    organizationId, integrationId, emergency,
    cascadedTo: total,
    completedAt: new Date().toISOString(),
  });

  await confirmStoreRedactToNuvemshop(integrationId);
}
```

### 7.4 Confirmation callback à Nuvemshop

```typescript
async function confirmRedactToNuvemshop(integrationId: string, customerExternalId: string) {
  const ctx = await loadContext(integrationId);
  // Endpoint conforme contrato Nuvemshop (ex.: POST /lgpd/redact/{customer_id}/confirm)
  await fetch(`${NS_API_BASE}/${ctx.credentials.storeId}/lgpd/redact/${customerExternalId}/confirm`, {
    method: 'POST',
    headers: { 'Authentication': `bearer ${ctx.credentials.accessToken}` },
  });
}
```

### 7.5 Audit log denso

Eventos canônicos emitidos no `api_audit_log` (formato Spec 01):

- `lgpd.redact_executed` — `{ contact_id, customer_external_id, mode, cascaded_to, source_webhook_log_id, confirmed_at }`
- `lgpd.data_request_completed` — `{ contact_id, customer_external_id, sha256, delivered_at, deadline, files }`
- `lgpd.store_redact_executed` — `{ integration_id, cascaded_to, emergency, completed_at }`
- `lgpd.redact_alarm_d10`, `lgpd.data_request_alarm_d5` — disparados quando SLA aproxima

Retenção 5 anos (L-10).

### 7.6 Layout do export

**JSON schema** (`docs/specs/06-export-schema.json` referenciado):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "SonghaiCRM LGPD Export v1",
  "type": "object",
  "required": ["meta", "subject", "data"],
  "properties": {
    "meta": {
      "type": "object",
      "required": ["generated_at", "tenant_id", "format_version", "sha256"],
      "properties": {
        "generated_at": { "type": "string", "format": "date-time" },
        "tenant_id": { "type": "string", "format": "uuid" },
        "format_version": { "const": "1.0" },
        "sha256": { "type": "string", "pattern": "^[a-f0-9]{64}$" }
      }
    },
    "subject": {
      "type": "object",
      "properties": {
        "contact_id": { "type": "string", "format": "uuid" },
        "external_ids": { "type": "array", "items": { "type": "object" } },
        "personal_data": { "type": "object" },
        "consent_history": { "type": "array" }
      }
    },
    "data": {
      "type": "object",
      "properties": {
        "orders": { "type": "array" },
        "conversations": { "type": "array" },
        "messages": { "type": "array" },
        "activities": { "type": "array" }
      }
    }
  }
}
```

**PDF template** (`templates/lgpd-export.pdf.hbs`): cabeçalho com logo + tenant, sumário tabular (totais por categoria), seção por dataset (orders/conversations/messages/activities) renderizadas como tabelas, rodapé com hash SHA-256 do JSON anexado e assinatura PAdES (chave em `LGPD_SIGNING_KEY`).

---

## 8. Mapping Nuvemshop → SonghaiCRM

### 8.1 `customer.email/phone/identification` → `contacts`

| Campo Nuvemshop | Campo SonghaiCRM | Notas |
|---|---|---|
| `customer.email` | `contacts.email` | Normalizar lowercase |
| `customer.phone` | `contacts.phone_number` | Normalizar E.164 (default BR +55) |
| `customer.identification` | `contacts.cpf_encrypted` | L-07: pgcrypto, chave `CPF_ENCRYPTION_KEY` |
| `customer.first_name` / `last_name` | idem | trim |
| `customer.id` | `contact_external_ids (provider='nuvemshop')` | tabela definida em Sub-PRD 02 |
| `customer.created_at` | `contacts.first_seen_at` | só se < atual |

### 8.2 `order` → `crm_lead` + `orders` + `crm_lead_links`

1 pedido = 1 row em `orders` + 1 lead em `crm_leads` linkados via `crm_lead_links (target_kind='order', target_id=orders.id)`.

`crm_leads.value_cents = orders.total_cents`. Status segue mapping configurável (§8.6).

### 8.3 `cart` → `crm_lead` (sem `orders`)

Carrinho não vira `orders` (não é pedido). Vira lead em pipeline "Pedidos", stage "Carrinho abandonado", com snapshot do carrinho em `crm_lead_activities[type='nuvemshop_cart_abandoned'].payload.cart`.

### 8.4 `product` → `nuvemshop_products` + chunks RAG

Worker de ingestão RAG (Sub-PRD 05) seleciona linhas com `rag_indexed_at IS NULL`, gera embeddings (title + description + price formatado), upsert em `rag_chunks`, atualiza `rag_indexed_at = now()` e `rag_chunk_count`.

### 8.5 `payment_method` → tag/custom_field

Configurável por tenant via `tenant_integrations.store_metadata.payment_method_mapping`:

```jsonb
{
  "payment_method_mapping": {
    "boleto": { "tag": "pagamento-boleto" },
    "credit_card": { "custom_field": "metodo_pagamento", "value": "Cartão" },
    "pix": { "tag": "pagamento-pix" }
  }
}
```

Worker de `order/paid` lê esse mapeamento e aplica.

### 8.6 Stage mapping configurável

Default em código:

```typescript
const DEFAULT_STAGE_MAPPING = {
  'order/created':   'aguardando_pagamento',
  'order/paid':      'pago',
  'order/cancelled': 'cancelado',
  'order/fulfilled.packed':    'em_separacao',
  'order/fulfilled.shipped':   'enviado',
  'order/fulfilled.delivered': 'entregue',
  'cart/abandoned':  'carrinho_abandonado',
};
```

Override em `tenant_integrations.store_metadata.stage_mapping`. UI admin (§10.5) edita esse JSON. Mudanças aplicam-se prospectivamente (eventos passados não são reprocessados).

---

## 9. Rate Limit & Retry

### 9.1 Backoff exponencial em chamadas saintes

```typescript
async function callWithRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      if (e instanceof AdapterError && e.retryable) {
        const wait = e.retryAfterSeconds ? e.retryAfterSeconds * 1000 : Math.min(2 ** i * 1000, 60_000);
        await sleep(wait + Math.random() * wait * 0.2); // ±20% jitter
        continue;
      }
      throw e;
    }
  }
  throw new Error('Retry attempts exhausted');
}
```

### 9.2 Worker respeita `X-Rate-Limit-Remaining`

Workers de sync (§6) já checam `page.rateLimit.remaining < 5` e dormem `retryAfterSeconds`.

### 9.3 Dead-letter queue após 8 tentativas

Cron `*/2 * * * *` consome `webhook_events_log` com `status='received'` e `processed_at IS NULL`:

```sql
update webhook_events_log set
  status = case when attempt_count >= 7 then 'dead_letter' else 'failed' end,
  attempt_count = attempt_count + 1,
  last_attempt_at = now(),
  last_error = $err
where id = $id;
```

Worker reenfileira em `event_log` com delay `2^attempt_count` minutos. Após 8 (≈4h cumulativos), entra em DLQ e dispara alerta.

### 9.4 Re-processamento manual via admin UI

```
POST /api/v1/integrations/nuvemshop/webhooks/{webhook_log_id}/retry
```

Reset `status='received'`, `attempt_count=0`. Worker pega no próximo tick.

---

## 10. UI de Configuração

Rotas no app admin (`/admin/integrations/nuvemshop`).

### 10.1 Botão "Conectar Nuvemshop"

Quando `tenant_integrations` row inexistente ou `status='disconnected'`. Click → `GET /api/v1/integrations/nuvemshop/connect` → redirect.

### 10.2 Status

Card com:
- Badge: `healthy` (verde) / `token_expired` (amarelo) / `scope_missing` (laranja) / `disconnected` (cinza) / `error` (vermelho)
- `last_health_check_at`, `last_sync_at`
- Webhook count last 24h (query em `webhook_events_log`)
- Botão "Reconectar" se status ≠ healthy

### 10.3 Re-sync manual

4 botões: "Tudo" / "Clientes" / "Produtos" / "Pedidos últimos 7d". Cada um POSTa em `/resync`. Mostra barra de progresso (lê `sync_progress`).

### 10.4 Logs recentes

Tabela com últimos 50 webhooks (query `webhook_events_log` `where provider='nuvemshop' order by received_at desc limit 50`). Colunas: timestamp, event_type, status, valid_signature, attempt_count. Click abre drawer com payload sanitizado.

Botão "Reprocessar" se `status in ('failed','dead_letter')`.

### 10.5 Stage mapping editor

UI tabular: linhas = eventos canônicos; coluna = stage CRM (select sourcing `crm_stages where pipeline.slug='pedidos'`). Submit faz `PATCH /api/v1/integrations/nuvemshop` com `store_metadata.stage_mapping`.

---

## 11. Eventos emitidos no `event_log`

| Tipo | Quando | Payload |
|---|---|---|
| `nuvemshop.order_created` | Receiver após log raw | `{integrationId, webhookLogId, externalEventId, data}` |
| `nuvemshop.order_paid` | idem | idem |
| `nuvemshop.order_cancelled` | idem | idem |
| `nuvemshop.order_fulfilled` | idem | idem |
| `nuvemshop.cart_abandoned` | idem | idem |
| `nuvemshop.customer_redact` | idem | `{integrationId, webhookLogId, customerExternalId}` |
| `nuvemshop.customer_data_request` | idem | idem |
| `nuvemshop.store_redact` | idem | `{integrationId, webhookLogId, emergency: true}` |
| `nuvemshop.products_synced` | Worker §6.1 | `{total}` |
| `nuvemshop.customers_synced` | Worker §6.2 | `{total, mergeQueueAdded}` |
| `nuvemshop.orders_synced` | Worker §6.3 | `{total, sinceDays}` |
| `integration.connected` | OAuth callback | `{provider, actor}` |
| `integration.disconnected` | store/redact ou ação manual | `{provider, reason}` |
| `integration.token_refreshed` | Worker §4.7 | `{integrationId}` |
| `integration.token_expired` | Worker §4.7 falha | `{integrationId, reason}` |
| `lgpd.redact_executed` | Worker §7.1 | `{contactId, cascadedTo}` |
| `lgpd.data_request_completed` | Worker §7.2 | `{contactId, files, sha256}` |
| `lgpd.store_redact_executed` | Worker §7.3 | `{integrationId, cascadedTo, emergency}` |
| `lgpd.redact_alarm_d10` | Cron monitor | `{contactId, dueAt}` |
| `lgpd.data_request_alarm_d5` | Cron monitor | `{contactId, dueAt}` |

---

## 12. Plano de Validação

### 12.1 Testes unitários (Vitest)

- `NuvemshopAdapter` com `fetch` mockado: cada método cobre happy path + cada `AdapterError.code`
- `mapOrder`, `mapCustomer`, `mapProduct` com fixtures reais salvas em `tests/fixtures/nuvemshop/`
- `processWebhook` middleware: HMAC válido, HMAC inválido, replay (skew >5min), idempotência (mesmo `external_event_id`), payload corrompido
- `executeRedact` em DB de teste: cascade conta certo; `is_anonymized` em todas tabelas; orders preservadas
- `executeDataRequest`: JSON respeita schema (`ajv` valida); PDF é assinado (verificação PAdES)

### 12.2 Testes de integração

- E2E OAuth: stub do servidor Nuvemshop devolve `code` → callback persiste tokens criptografados → `fn_decrypt_oauth` retorna plaintext
- Re-conexão preserva `tenant_integrations.id` (não duplica)
- Sync de 1000 produtos com mock de rate limit (429 a cada 100): worker pausa e retoma; total final correto
- Webhook DLQ: forçar 8 falhas consecutivas → row em `status='dead_letter'`; retry manual via API → row volta a `received` → processa OK

### 12.3 Testes de RLS

- Tenant A não enxerga `tenant_integrations`, `orders`, `nuvemshop_products`, `webhook_events_log` de tenant B (auth.jwt forjado)
- Service role bypassa RLS pra workers

### 12.4 Testes de contrato Nuvemshop

CI agendado (semanal) roda contra sandbox Nuvemshop com loja de teste:
- OAuth flow completo
- Subscribe/unsubscribe webhooks
- Receive de cada um dos 8 eventos com payload real
- Verificar que `mapOrder`/`mapCustomer` ainda decodificam payload v atual

### 12.5 Testes de carga

- 1000 webhooks/min por 10 min: receiver p95 <300ms; nenhum perdido (idempotência)
- Sync inicial 50k pedidos: ≤6h; respeita rate limit (zero 429 não-tratado)

### 12.6 Testes LGPD

- `customer/redact` end-to-end: webhook → cascade → audit → confirm callback. Verifica que tentativa subsequente de UPDATE em contact retorna 403 `lgpd_anonymization_irreversible` (L-04)
- `customer/data_request` em D-2: SLA monitor não dispara alarme; em D-5: dispara
- `store/redact` em tenant com 10k contacts: completa em <2h batch; super-admin notificado em <1min do receipt

### 12.7 Critérios de pronto

Os 14 ACs do PRD §5 verdes em CI verde por 7 dias consecutivos com smoke test em produção.

---

## 13. Migrations

Ordem de execução:

```
2026XXXX01_create_tenant_integrations.sql      -- §3.1
2026XXXX02_create_orders.sql                   -- §3.2
2026XXXX03_create_nuvemshop_products.sql       -- §3.3
2026XXXX04_extend_webhook_events_log.sql       -- §3.4 (índices LGPD/DLQ; partição por mês se ainda não)
2026XXXX05_create_sync_progress.sql            -- §6.4
2026XXXX06_create_storage_redaction_queue.sql  -- §7.1
2026XXXX07_oauth_encryption_functions.sql      -- §3.1 helpers
2026XXXX08_audit_event_types_seed.sql          -- §11 (tipos canônicos)
```

Pré-requisitos:
- Spec 01 aplicada (`organizations`, `fn_user_org_ids`, `api_audit_log`, `event_log`, `pgcrypto`)
- Spec 02 aplicada (`contacts`, `crm_leads`, `crm_lead_activities`, `crm_lead_links`, `contact_external_ids`, `merge_queue`)
- Spec 03 aplicada (`webhook_events_log` base; `messages.is_anonymized`; `conversations.is_anonymized`)
- Env vars: `NUVEMSHOP_CLIENT_ID`, `NUVEMSHOP_CLIENT_SECRET`, `NUVEMSHOP_APP_ID`, `NUVEMSHOP_OAUTH_ENCRYPTION_KEY`, `OAUTH_STATE_SECRET`, `LGPD_SIGNING_KEY`, `PUBLIC_BASE_URL`, `QSTASH_TOKEN`

Rollback: `down.sql` por migration; em produção, `tenant_integrations` é destrutivo (perde tokens) — exigir double confirmation.

---

## Anexos

- `docs/prd/06-prd-nuvemshop-lgpd.md` — PRD origem
- `docs/specs/01-spec-platform-base.md` — auth, RLS, audit, event_log, framework LGPD
- `docs/specs/02-spec-customer-360.md` — contacts, leads, identity resolution, merge_queue
- `docs/specs/03-spec-whatsapp-waha.md` — `webhook_events_log` base
- `docs/business-rules/00-business-rules-catalog.md` — L-01 a L-10, B-05
- `docs/research/reference-synthesis.md` — pontos herdados (§6, §11, §13)
