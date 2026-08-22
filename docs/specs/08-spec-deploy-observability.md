---
title: Spec Técnica 08 — Deploy, Infraestrutura e Observability
parent: 00-prd-master.md
escopo: transversal
version: 0.1
status: em revisão
date: 2026-04-28
owner: Songhai, Lda
referencias:
  - docs/prd/00-prd-master.md
  - docs/prd/01-prd-platform-base.md
  - docs/prd/02-prd-customer-360.md
  - docs/prd/03-prd-whatsapp-waha.md
  - docs/prd/04-prd-pipeline-attendance.md
  - docs/prd/05-prd-ai-rag-handoff.md
  - docs/prd/06-prd-nuvemshop-lgpd.md
  - docs/research/reference-synthesis.md
---

# Spec Técnica 08 — Deploy + Infra + Observability

> Documento transversal que rege topologia de produção, ambiente local, secrets, CI/CD, observability, alertas, runbooks, performance targets, disaster recovery e custo. Toda decisão arquitetural conflitante com este documento exige justificativa explícita no PRD/Spec de origem.

---

## 1. Visão Geral

### 1.1 Objetivos
- **Operação determinística** desde dia 1 em ambiente single-region (sa-east-1 e/ou eu-central-1) com latência aceitável pro Brasil.
- **Custo previsível** pro estágio MVP (1–3 tenants) com headroom pra crescer 10× sem rearquitetar.
- **Observabilidade densa o suficiente** pra debugar incidentes WAHA, Nuvemshop e LGPD em <30min de MTTR.
- **Compliance LGPD operacional**: logs com PII redacted, exports auditáveis, audit trail íntegro 5 anos.
- **Mean time to recovery (MTTR) ≤ 30 min** pros 6 incidentes mais frequentes documentados em runbooks.

### 1.2 Princípios não-negociáveis
1. **Stateless app.** Nada de estado em filesystem do Vercel. Toda persistência vai pra Supabase, Storage, Upstash ou volume Docker do WAHA.
2. **Trigger NUNCA faz HTTP.** Workers consomem `event_log` via Realtime/cron — herdado da referência.
3. **Service role bypassa RLS — filtro manual obrigatório.** Em todo handler que usa admin client, `organization_id` é resolvido a partir de cookie/JWT/path token, NUNCA do body.
4. **Encryption-at-rest separada por contexto.** Chaves distintas pra CPF, OAuth tokens Nuvemshop, e WAHA BYO API keys.
5. **Backups verificados.** Restore drill trimestral em ambiente de staging; backup que não foi restaurado é teoria.
6. **Logs estruturados em JSON.** Nada de `console.log("erro: " + e)`.
7. **Deploy = git push.** Sem `vercel deploy` manual em produção. Tudo passa por main.

### 1.3 Estados e ambientes
| Ambiente | Branch | Domínio | Supabase | WAHA | Sentry env |
|---|---|---|---|---|---|
| Production | `main` | `app.deskcomm.com.br` + `admin.deskcomm.com.br` | projeto Pro `deskcomm-prod` | `waha.deskcomm.com.br` (VPS própria) | `production` |
| Staging | `staging` | `staging.deskcomm.com.br` | projeto Free `deskcomm-staging` | `waha-staging.deskcomm.com.br` (mesma VPS, container separado) | `staging` |
| Preview | qualquer PR | `*.vercel.app` | projeto Free `deskcomm-preview` (compartilhado) | mock/staging | `preview` |
| Local dev | local | `localhost:3000` | `supabase start` (Docker) | `localhost:3000` (compose) | `development` |

---

## 2. Topologia de Produção

### 2.1 Componentes

#### Vercel (Next.js app + API + crons)
- **Plano:** Pro ($20/mês/seat).
- **Região:** `gru1` (São Paulo) prioritária; fallback `iad1`. Edge functions só onde latência precisa <50ms (rate-limit middleware).
- **Hospeda:**
  - Next.js 14+ App Router (frontend `/`, super-admin `/admin`)
  - Route Handlers `/api/v1/*`
  - 7 Vercel Crons (lista exaustiva em §5.3)
  - Webhook receivers WAHA (`/api/webhooks/waha/[sessionId]`) e Nuvemshop (`/api/webhooks/nuvemshop/[event]`)
- **Não hospeda:** workers de longa duração (>60s no Pro com Fluid Compute), processamento síncrono de mídia >25MB, base vetorial (vai pro Postgres com pgvector).

#### Supabase (Postgres + Auth + Realtime + Storage)
- **Plano:** Pro ($25/mês) + add-ons conforme necessidade (compute upgrade `Small → Medium` quando p95 DB >100ms; PITR addon $100/mês opcional).
- **Região:** `sa-east-1` (São Paulo). Mesmo provider da Vercel `gru1` minimiza RTT (~5ms).
- **Componentes ativos:**
  - Postgres 15 (`deskcomm-prod`)
  - Supabase Auth (email/password + OAuth Google opcional + MFA TOTP)
  - Supabase Realtime (postgres_changes habilitado nas tabelas listadas em §4.5)
  - Supabase Storage (buckets `whatsapp-media` privado, `lgpd-exports` privado)
  - pgvector + pg_cron + pgcrypto + uuid-ossp + pg_stat_statements
- **Não usa Supabase Edge Functions no MVP** (toda lógica fica no Next.js pra colocação simples). Edge Function entra só se aparecer caso de processamento dentro do RLS Postgres não-replicável em Node.

#### VPS própria (WAHA Plus + Nginx + Let's Encrypt)
- **Tipo:** Turing (3 vCPU AMD, 4GB RAM, 80GB NVMe) — €8.21/mês ≈ $10/mês.
- **Localização:** `nbg1` (São Paulo). RTT pro Brasil ~210ms. Aceitável porque WAHA fala com servidores WhatsApp (Meta) majoritariamente em US/EU; latência cliente final é absorvida pelo Brazilian POP de WhatsApp.
- **Stack:**
  - Ubuntu 22.04 LTS
  - Docker + docker-compose (versão `compose v2` plugin)
  - WAHA Plus (engine NOWEB) — container `devlikeapro/waha-plus:latest`
  - Nginx (reverse proxy + TLS termination)
  - Let's Encrypt via certbot (renovação automática via systemd timer)
  - UFW firewall + fail2ban
  - Sentry agent opcional pra logs do host
- **Diretórios persistentes:**
  - `/srv/waha/sessions/` → volume `.sessions` do WAHA (multi-tenant)
  - `/srv/waha/media/` → cache local de mídia antes do upload pro Supabase Storage
  - `/srv/waha/logs/` → logs rotacionados via logrotate

#### Upstash Redis (rate limit + cache)
- **Plano:** Pay-as-you-go regional — $0.20 / 100k requests, free tier 10k/day. Estimativa MVP $5–15/mês.
- **Região:** `sa-east-1` (São Paulo) — global database opcional se latência cross-region for problema.
- **Uso:**
  - Rate limit sliding window por API key e por IP (`@upstash/ratelimit`)
  - Cache de ID resolution Nuvemshop ↔ contact (TTL 1h)
  - Cache de `crm://schema` resource pro MCP (TTL 5min)
  - Idempotency-Key store (TTL 24h)
  - **NÃO usa Redis pra fila de jobs** (fica em Postgres `event_log` + cron).
- **Fallback in-memory** quando Redis está down (rate-limit fica permissivo, log warning, alerta Sentry).

#### Sentry (errors + performance)
- **Plano:** Team ($26/mês) — 50k errors/mês + 100k performance units. Suficiente pro MVP.
- **Project:** `deskcomm-app` (Next.js) + `deskcomm-mcp` (MCP server fase 2).
- **Features ativas:** Errors, Performance (tracing), Session Replay desligado no MVP (custo + LGPD), Profiling desligado.
- **PII scrubbing** ativado server-side + `beforeSend` custom (§9.1).

#### Vercel AI Gateway (LLM proxy)
- **Plano:** incluso no Vercel Pro com markup ~2% sobre custos de inferência.
- **Provedores configurados:**
  - Anthropic primário: `anthropic/claude-sonnet-4-6` (atendimento) e `anthropic/claude-haiku-4-5` (sentiment + embeddings).
  - OpenAI fallback: `openai/gpt-4o-mini` (apenas health-check de fallback).
- **Configuração:** zero data retention ativado nos 2 provedores. Observability nativa (tokens/latency/cost) por tenant via header `x-tenant-id` no request.

### 2.2 Diagrama textual

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         CLIENTES (browser, WhatsApp)                      │
└────────────┬───────────────────────────────────────────┬─────────────────┘
             │ HTTPS                                     │ WhatsApp protocol
             ▼                                           ▼
   ┌──────────────────────┐                    ┌─────────────────────────┐
   │   Vercel Edge        │                    │   WhatsApp servers      │
   │   (CDN + middleware) │                    │   (Meta)                │
   └─────────┬────────────┘                    └────────────┬────────────┘
             │                                              │
             ▼                                              ▼
   ┌──────────────────────┐                    ┌─────────────────────────┐
   │  Vercel Functions    │                    │  VPS própria (São Paulo) │
   │  - Next.js App       │                    │  ┌──────────────────┐   │
   │  - /api/v1/*         │                    │  │ Nginx 443/TLS    │   │
   │  - 7 Crons           │                    │  └────────┬─────────┘   │
   │  - Webhook handlers  │                    │           ▼             │
   └──┬────┬────┬────┬────┘                    │  ┌──────────────────┐   │
      │    │    │    │                          │  │ WAHA Plus :3000  │   │
      │    │    │    └──── HTTPS ──────────────►│  │ (NOWEB engine)   │   │
      │    │    │                               │  │ N sessões        │   │
      │    │    │                               │  └────────┬─────────┘   │
      │    │    │                               │           │             │
      │    │    │  ◄────── HTTPS webhooks ──────┼───────────┘             │
      │    │    │  (HMAC SHA512)                │  Volume /srv/waha/      │
      │    │    │                               └─────────────────────────┘
      │    │    │
      │    │    └─────────► Upstash Redis (rate limit, cache, idempotency)
      │    │
      │    └──────────────► Vercel AI Gateway ──► Anthropic / OpenAI
      │
      ▼
   ┌──────────────────────────┐
   │  Supabase (sa-east-1)    │
   │  - Postgres + pgvector   │
   │  - Auth (JWT)            │
   │  - Realtime (WS)         │
   │  - Storage (buckets)     │
   │  - Daily backup + PITR   │
   └──────────────────────────┘
             │
             ▼
   ┌──────────────────────────┐
   │  Sentry (errors + perf)  │
   │  Vercel Analytics        │
   └──────────────────────────┘
```

---

## 3. Setup do Ambiente Local

### 3.1 Pré-requisitos
| Ferramenta | Versão mínima | Como instalar (macOS) |
|---|---|---|
| Node.js | 20.x LTS | `brew install node@20` ou `nvm install 20` |
| pnpm | 9.x | `corepack enable && corepack prepare pnpm@latest --activate` |
| Docker Desktop | 4.30+ | https://www.docker.com/products/docker-desktop |
| Supabase CLI | 1.180+ | `brew install supabase/tap/supabase` |
| ngrok | 3.x | `brew install ngrok` (auth-token requerido) |
| gh CLI | 2.x | `brew install gh` |
| direnv (opcional) | 2.x | `brew install direnv` (carrega `.envrc` automático) |
| pre-commit | 3.x | `brew install pre-commit` |
| gitleaks | 8.x | `brew install gitleaks` |

Linux/WSL: equivalentes via `apt` ou Docker oficial. Windows nativo não é suportado pra dev (use WSL2).

### 3.2 Clone + install + .env.local
```bash
git clone git@github.com:deskcomm/deskcommcrm.git
cd deskcommcrm
pnpm install                  # instala root + workspaces (app, mcp futuro)
cp .env.example .env.local    # template versionado; .env.local é gitignored
```

`.env.local` mínimo pra subir local (lista exaustiva em §7.1):
```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=...    # printado por `supabase start`
SUPABASE_SERVICE_ROLE_KEY=...        # idem
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres

WAHA_BASE_URL=http://localhost:3001
WAHA_API_KEY_PLAINTEXT=local-dev-key-change-me
WAHA_WEBHOOK_SECRET=local-dev-secret-32-bytes-min

UPSTASH_REDIS_REST_URL=...           # Upstash dev DB free tier
UPSTASH_REDIS_REST_TOKEN=...

AI_GATEWAY_API_KEY=...               # opcional; sem isso usa MOCK_AI=true
MOCK_AI=true                         # IA local responde com fixtures determinísticas

SENTRY_DSN=                          # vazio em dev; só ativa em staging+
NEXT_PUBLIC_SENTRY_DSN=

# Encryption keys (geradas com `openssl rand -hex 32`)
ENCRYPTION_KEY_CPF=...
ENCRYPTION_KEY_OAUTH=...
ENCRYPTION_KEY_WAHA_BYO=...

NUVEMSHOP_CLIENT_ID=...              # app de teste no dashboard Nuvemshop
NUVEMSHOP_CLIENT_SECRET=...
NUVEMSHOP_WEBHOOK_HMAC_SECRET=...

NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_APP_DOMAIN=localhost:3000
```

### 3.3 Supabase local via CLI
```bash
supabase init                        # 1ª vez apenas (cria supabase/config.toml)
supabase start                       # sobe Postgres + Auth + Storage + Studio em Docker
supabase db reset                    # aplica todas migrations + seed.sql
supabase status                      # imprime URLs e keys pra .env.local
```

`supabase/config.toml` ajustes principais:
```toml
[db]
major_version = 15

[db.extensions]
enabled = ["pgcrypto", "pgvector", "uuid-ossp", "pg_cron", "pg_stat_statements"]

[realtime]
enabled = true

[storage]
enabled = true
file_size_limit = "50MiB"

[auth]
enabled = true
site_url = "http://localhost:3000"
additional_redirect_urls = ["http://localhost:3000/auth/callback"]

[auth.mfa]
max_enrolled_factors = 10

[auth.mfa.totp]
enroll_enabled = true
verify_enabled = true
```

Migrations ficam em `supabase/migrations/YYYYMMDDHHMMSS_*.sql`. Seed em `supabase/seed.sql` cria 1 organization, 1 user `dev@deskcomm.local`, 1 pipeline default.

### 3.4 WAHA via docker-compose

`docker-compose.dev.yml` (versionado):
```yaml
services:
  waha:
    image: devlikeapro/waha-plus:latest
    container_name: deskcomm-waha-dev
    restart: unless-stopped
    ports:
      - "3001:3000"
    environment:
      WAHA_API_KEY: ${WAHA_API_KEY_HASH}        # SHA512 hex do plaintext
      WAHA_LOG_LEVEL: info
      WAHA_LOG_FORMAT: JSON
      WAHA_PRINT_QR: "false"
      WAHA_DASHBOARD_ENABLED: "true"
      WAHA_DASHBOARD_USERNAME: dev
      WAHA_DASHBOARD_PASSWORD: dev
      # Engine default
      WHATSAPP_DEFAULT_ENGINE: NOWEB
      # Webhook global (override per-session quando criar sessão)
      WHATSAPP_HOOK_URL: ${NGROK_URL}/api/webhooks/waha
      WHATSAPP_HOOK_EVENTS: "message.any,session.status,message.ack,call.received"
      # Storage local em dev
      WAHA_FILES_FOLDER: /app/.media
      WAHA_FILES_LIFETIME: "0"                  # nunca deleta em dev
    volumes:
      - waha_sessions:/app/.sessions
      - waha_media:/app/.media

volumes:
  waha_sessions:
  waha_media:
```

Comandos comuns:
```bash
# Gerar hash pro WAHA_API_KEY (plaintext "local-dev-key-change-me")
echo -n "local-dev-key-change-me" | shasum -a 512 | awk '{print $1}'
export WAHA_API_KEY_HASH=<resultado>

docker compose -f docker-compose.dev.yml up -d
docker compose logs -f waha
docker compose down                  # mantém volumes
docker compose down -v               # apaga volumes (logout total das sessões)
```

### 3.5 ngrok pra expor webhook em dev
WAHA precisa enviar webhook pra URL pública mesmo em dev. Solução padrão:
```bash
ngrok config add-authtoken <token>
ngrok http 3000 --domain=deskcomm-dev.ngrok.dev   # plano pago dá domínio fixo
```

Domínio fixo é importante porque mudar URL de webhook a cada `ngrok` reconecta = reconfigurar todas sessões WAHA. Sem domínio fixo, usar script `scripts/dev/update-waha-webhook.sh` que pega URL atual e atualiza WAHA via API.

Para Nuvemshop em dev: criar app de teste no dashboard Nuvemshop apontando webhook pro ngrok URL.

---

## 4. Configuração do Supabase

### 4.1 Projeto Pro mínimo pra produção
- **Plan:** Pro $25/mês
- **Compute:** começar `Small` ($0), upgrade pra `Medium` ($60/mês) quando p95 DB >100ms ou conexões saturarem
- **Disk:** 8GB inicial; auto-scale ativado (até 100GB sem touch ops)
- **Connection pooling:** Supavisor `transaction mode` (porta 6543) pro app Vercel; `session mode` (porta 5432) pra migrations e MCP server
- **PITR:** opcional ($100/mês). MVP: backup daily basta. Ativar quando primeiro tenant atinge >R$ 50k/mês de transação
- **Network restrictions:** allowlist do egress IP da Vercel (lista pública) + IPs do dev team. WAHA VPS NÃO precisa de acesso direto ao Supabase (toda comunicação passa pelo Vercel)
- **SSL enforce:** sim (default). `?sslmode=require` em todo connection string
- **JWT secret:** rotacionado **apenas** na criação do projeto. Rotação programada exige revogação de todas sessões ativas (runbook §11.4)

### 4.2 Extensions necessárias

```sql
-- supabase/migrations/00000000000001_extensions.sql
create extension if not exists pgcrypto       with schema extensions;
create extension if not exists "uuid-ossp"    with schema extensions;
create extension if not exists vector         with schema extensions;  -- pgvector
create extension if not exists pg_cron        with schema extensions;
create extension if not exists pg_stat_statements;
create extension if not exists pg_trgm        with schema extensions;  -- search
create extension if not exists btree_gin      with schema extensions;  -- tags index
```

`pgcrypto` é crítico: usado pra `encrypt(cpf, key)` em column-level encryption do CPF (PRD-02). `pgvector` pro RAG (PRD-05). `pg_cron` pra jobs leves dentro do DB (limpeza de `event_log` >90d). `pg_stat_statements` pra detectar queries lentas em produção (§9.4).

### 4.3 Auth providers config
| Provider | MVP | Notas |
|---|---|---|
| Email + Password | sim | Confirmação por email obrigatória; site URL apontando pro app |
| Magic Link | sim | Default pra signup novo |
| OAuth Google | sim | Opcional; útil pra atendentes BPO sem criar senha extra |
| OAuth GitHub | não | Sem caso de uso PME |
| Phone OTP | não | Custo SMS Brasil + abuso; entra na Fase 2 se demanda |
| MFA TOTP | **forçado** pra `admin` e `super-admin` | Configurado na primeira sessão; recovery codes gerados |

Configuração via Supabase Dashboard ou `supabase/config.toml`:
```toml
[auth]
site_url = "https://app.deskcomm.com.br"
additional_redirect_urls = [
  "https://app.deskcomm.com.br/auth/callback",
  "https://admin.deskcomm.com.br/auth/callback",
]
jwt_expiry = 3600                          # 1h, refresh token rotation ativa
refresh_token_rotation_enabled = true
refresh_token_reuse_interval = 10          # segundos

[auth.email]
enable_signup = false                      # signup só via convite no MVP
double_confirm_changes = true
enable_confirmations = true
```

JWT custom claims: hook Postgres `auth.jwt_custom_claims` injeta `tenant_ids` (array) e `is_platform_admin` (bool) lendo de `user_organizations` + `platform_admins`.

### 4.4 Storage buckets

| Bucket | Privado? | Tamanho max | Retenção | Uso |
|---|---|---|---|---|
| `whatsapp-media` | sim | 50MB | 365d (config por tenant) | Mídia inbound/outbound WhatsApp |
| `lgpd-exports` | sim | 100MB | 30d (auto-delete) | Exports gerados pra `data_request` |
| `tenant-assets` | sim | 10MB | sem limite | Logo do tenant, PDFs de política da loja (RAG ingestion) |
| `rag-uploads` | sim | 50MB | 7d (após processamento) | Staging de PDFs/docs antes de embedding |

Policies RLS por bucket:
```sql
-- whatsapp-media: leitura via signed URL apenas; insert via service_role
create policy "wa_media_read_signed_only"
  on storage.objects for select
  using (false);                            -- nunca direto

create policy "wa_media_service_role_insert"
  on storage.objects for insert
  to service_role
  with check (bucket_id = 'whatsapp-media');

-- lgpd-exports: cliente só baixa o seu próprio export via signed URL gerada por endpoint LGPD
```

Signed URL TTL default: 5 minutos pra mídia WhatsApp (inline em UI), 1 hora pra exports LGPD.

### 4.5 Realtime publications

Tabelas com `postgres_changes` ativado:
- `messages` (filter `organization_id=eq.{tenantId}`)
- `conversations` (filter idem)
- `crm_leads` (filter idem)
- `crm_lead_activities` (filter idem)
- `channel_sessions` (filter idem)
- `event_log` (filter idem) — workers consomem aqui

Tabelas **não** publicadas (usar polling/cron):
- `api_audit_log` (alto volume, sem caso de UI realtime)
- `webhook_deliveries` (idem)
- `embeddings` (RAG; consulta sob demanda)
- `messages_archive` (cold storage)

Configuração via SQL:
```sql
alter publication supabase_realtime add table messages;
alter publication supabase_realtime add table conversations;
-- ... etc
```

Channels broadcast (não postgres_changes, mas eventos custom): `agent-presence:{tenantId}`, `typing:{conversationId}`. RLS authorization configurada via `realtime.broadcast_changes()` lendo `fn_user_org_ids()`.

### 4.6 Backups
- **Daily backup** do Supabase Pro (automático, retenção 7 dias). Acessível via Dashboard.
- **Adicional:** cron Vercel diário às 03:00 BRT executa `pg_dump --schema-only` + dump de tabelas críticas (`organizations`, `pipelines`, `stages`, `crm_leads`) e envia pra bucket S3 externo (Wasabi/Cloudflare R2 — $5/mês). Retenção 30 dias.
- **Restore drill** trimestral: restaurar backup da semana em projeto Supabase de staging. Validar (a) row count das 5 tabelas core, (b) audit log último mês, (c) signed URL de uma mídia.
- **PITR:** opcional. Ativar quando RPO <24h virar requisito de cliente.
- **WAHA sessions:** snapshot semanal do volume `/srv/waha/sessions/` pra Wasabi (cron systemd no VPS, §6.5).

---

## 5. Configuração do Vercel

### 5.1 vercel.ts (recomendado sobre vercel.json)

`vercel.ts` na raiz do projeto (Next.js 15+ suporta config tipada):
```typescript
import type { VercelConfig } from "@vercel/types";

const config: VercelConfig = {
  buildCommand: "pnpm turbo run build --filter=app",
  installCommand: "pnpm install --frozen-lockfile",
  framework: "nextjs",
  regions: ["gru1"],                       // São Paulo primário
  functions: {
    "app/api/webhooks/waha/[sessionId]/route.ts": {
      maxDuration: 30,                     // webhook precisa responder rápido
      memory: 1024,
    },
    "app/api/webhooks/nuvemshop/[event]/route.ts": {
      maxDuration: 30,
      memory: 1024,
    },
    "app/api/v1/lgpd/data-request/route.ts": {
      maxDuration: 300,                    // export pode demorar
      memory: 3008,
    },
    "app/api/cron/**/route.ts": {
      maxDuration: 300,
      memory: 1024,
    },
  },
  crons: [
    { path: "/api/cron/recover-stuck-messages", schedule: "*/5 * * * *" },
    { path: "/api/cron/sync-waha-sessions",      schedule: "*/2 * * * *" },
    { path: "/api/cron/process-pending-webhooks", schedule: "*/1 * * * *" },
    { path: "/api/cron/lgpd-sla-warning",         schedule: "0 9 * * *" },
    { path: "/api/cron/event-log-cleanup",        schedule: "0 3 * * *" },
    { path: "/api/cron/nuvemshop-sync-incremental", schedule: "*/15 * * * *" },
    { path: "/api/cron/audit-log-archive",         schedule: "0 4 * * 0" },
  ],
  headers: [
    {
      source: "/api/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
      ],
    },
  ],
  rewrites: [
    { source: "/admin/:path*", destination: "/admin/:path*" },
  ],
};

export default config;
```

### 5.2 Env vars production vs preview

Estratégia:
- **Production:** vars setadas no Dashboard Vercel scope `Production` apenas. Encryption keys reais. Tokens Nuvemshop reais.
- **Preview:** vars setadas em scope `Preview` apontando pra projeto Supabase `deskcomm-preview` compartilhado, WAHA mock ou staging, AI Gateway com `MOCK_AI=true` por default.
- **Development (Vercel CLI):** `vercel env pull .env.local` puxa vars Preview pra rodar local com infra remota quando precisar.

Vars NUNCA commitadas: tudo prefixado `*_KEY`, `*_SECRET`, `*_TOKEN`, `DATABASE_URL`, `*_DSN`. Pre-commit gitleaks bloqueia (§7.5).

### 5.3 Vercel Cron schedules (lista exaustiva)

| # | Path | Schedule (UTC) | Descrição | Owner PRD | Timeout |
|---|---|---|---|---|---|
| 1 | `/api/cron/recover-stuck-messages` | `*/5 * * * *` | Mensagens em `status='sending'` há >5min viram `failed` + alerta | 03 | 60s |
| 2 | `/api/cron/sync-waha-sessions` | `*/2 * * * *` | Pull `GET /api/sessions` do WAHA e atualiza `channel_sessions.status` | 03 | 60s |
| 3 | `/api/cron/process-pending-webhooks` | `*/1 * * * *` | Processa webhooks deduplicados com `status='pending'` (Nuvemshop + WAHA) | 03/06 | 60s |
| 4 | `/api/cron/lgpd-sla-warning` | `0 9 * * *` | Alerta em `data_request` ainda não respondidas em D+5 | 06 | 60s |
| 5 | `/api/cron/event-log-cleanup` | `0 3 * * *` | Move events >90d pra `event_log_archive`, depois pra S3 cold storage | 01 | 300s |
| 6 | `/api/cron/nuvemshop-sync-incremental` | `*/15 * * * *` | Pull diff de orders/products desde último checkpoint | 06 | 300s |
| 7 | `/api/cron/audit-log-archive` | `0 4 * * 0` | Semanal: comprime audit log antigo +18m e move pra S3 | 01 | 300s |

Cada cron handler:
1. Valida header `Authorization: Bearer ${CRON_SECRET}` (Vercel injeta automático).
2. Loga `event_log` row `cron.{name}.started` no início e `cron.{name}.completed` no fim, com `metadata.duration_ms` e `metadata.rows_processed`.
3. Se falha: Sentry capture + `cron.{name}.failed` no event_log + retorno 500 (Vercel marca como failed, dashboard alerta).

### 5.4 AI Gateway integration

Setup via Vercel Marketplace → AI Gateway. Após instalação, env var `AI_GATEWAY_API_KEY` injetada automaticamente.

Wrapper ÚNICO em `lib/ai/client.ts`:
```typescript
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export const aiGateway = createOpenAICompatible({
  baseURL: "https://gateway.ai.vercel.app/v1",
  apiKey: process.env.AI_GATEWAY_API_KEY!,
  headers: () => ({
    "x-tenant-id": currentTenantId(),       // injeta pra observability per-tenant
  }),
});

// Modelos como STRINGS — nunca importar SDKs diretos.
export const MODELS = {
  ATTENDANCE: "anthropic/claude-sonnet-4-6",
  SENTIMENT:  "anthropic/claude-haiku-4-5",
  EMBEDDING:  "openai/text-embedding-3-small",
  FALLBACK:   "openai/gpt-4o-mini",
} as const;
```

Config no Gateway dashboard:
- **Failover policy:** primary `anthropic`, on 5xx ou timeout 30s → `openai/gpt-4o-mini` (apenas modelos ATTENDANCE/SENTIMENT; embedding fica fixo na OpenAI).
- **Zero data retention:** ativado nos 2 provedores.
- **Budget alerts:** $300/mês por tenant alerta Slack; $500/mês corta requests com 503.
- **Prompt caching:** ativado pra Anthropic (system prompt do bot por tenant é estável; ganho 50–70% em token cost).

### 5.5 Edge config
Não usado no MVP. Rate limit fica no Upstash, feature flags ficam em `tenant_settings.feature_flags` (JSONB). Edge Config entra se precisar killswitch global cross-tenant <50ms.

---

## 6. Configuração do WAHA Plus

### 6.1 docker-compose.yml completo (produção VPS)

`/srv/deskcomm/docker-compose.yml`:
```yaml
services:
  waha:
    image: devlikeapro/waha-plus:latest
    container_name: deskcomm-waha
    restart: always
    networks:
      - waha-net
    expose:
      - "3000"                            # apenas interno; Nginx proxa
    environment:
      WAHA_API_KEY: ${WAHA_API_KEY_HASH}
      WAHA_LOG_LEVEL: info
      WAHA_LOG_FORMAT: JSON
      WAHA_PRINT_QR: "false"
      WAHA_DASHBOARD_ENABLED: "false"     # desabilita em prod
      WAHA_SWAGGER_ENABLED: "false"
      WHATSAPP_DEFAULT_ENGINE: NOWEB
      WHATSAPP_HOOK_URL: https://app.deskcomm.com.br/api/webhooks/waha
      WHATSAPP_HOOK_EVENTS: "message.any,session.status,message.ack,call.received,group.v2.join,group.v2.leave"
      WHATSAPP_HOOK_HMAC_ALGORITHM: SHA512
      WHATSAPP_HOOK_HMAC_KEY: ${WAHA_WEBHOOK_HMAC_KEY}
      WAHA_FILES_FOLDER: /app/.media
      WAHA_FILES_LIFETIME: "604800"       # 7 dias; após isso WAHA limpa
      WAHA_MEDIA_STORAGE: "S3"
      WAHA_S3_REGION: ${SUPABASE_S3_REGION}
      WAHA_S3_BUCKET: whatsapp-media
      WAHA_S3_ACCESS_KEY_ID: ${SUPABASE_S3_ACCESS_KEY}
      WAHA_S3_SECRET_ACCESS_KEY: ${SUPABASE_S3_SECRET_KEY}
      WAHA_S3_ENDPOINT: ${SUPABASE_S3_ENDPOINT}
      WAHA_S3_FORCE_PATH_STYLE: "true"
      # Worker concurrency (NOWEB)
      WHATSAPP_RESTART_ALL_SESSIONS: "false"
      WAHA_WORKERS: "4"
    volumes:
      - waha_sessions:/app/.sessions
      - waha_media_cache:/app/.media
      - /etc/timezone:/etc/timezone:ro
      - /etc/localtime:/etc/localtime:ro
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/api/server/status"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s
    deploy:
      resources:
        limits:
          memory: 3G
          cpus: "2.5"

  nginx:
    image: nginx:alpine
    container_name: deskcomm-nginx
    restart: always
    networks:
      - waha-net
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/conf.d:/etc/nginx/conf.d:ro
      - ./nginx/snippets:/etc/nginx/snippets:ro
      - /etc/letsencrypt:/etc/letsencrypt:ro
      - certbot_webroot:/var/www/certbot:ro
      - nginx_logs:/var/log/nginx
    depends_on:
      - waha

  certbot:
    image: certbot/certbot:latest
    container_name: deskcomm-certbot
    volumes:
      - /etc/letsencrypt:/etc/letsencrypt
      - certbot_webroot:/var/www/certbot
    entrypoint: |
      sh -c 'trap exit TERM;
      while :; do
        certbot renew --webroot -w /var/www/certbot --quiet;
        sleep 12h & wait $${!};
      done'

networks:
  waha-net:
    driver: bridge

volumes:
  waha_sessions:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /srv/waha/sessions
  waha_media_cache:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /srv/waha/media
  certbot_webroot:
  nginx_logs:
```

`.env` no VPS (modo 0600, owner root):
```bash
WAHA_API_KEY_HASH=<sha512 hex do plaintext>
WAHA_WEBHOOK_HMAC_KEY=<32+ bytes hex>
SUPABASE_S3_ACCESS_KEY=...
SUPABASE_S3_SECRET_KEY=...
SUPABASE_S3_ENDPOINT=https://<project>.supabase.co/storage/v1/s3
SUPABASE_S3_REGION=sa-east-1
```

### 6.2 Volumes (.sessions persistente)
- **`/srv/waha/sessions/`** → volume crítico. Cada subdir é uma sessão (= 1 número WhatsApp). Perda = todos números deslogam, atendentes precisam re-escanear QR. Backup semanal obrigatório.
- **`/srv/waha/media/`** → cache local antes de upload pro S3. Pode ser perdido sem impacto (WAHA refaz fetch).
- **Owner:** `root:root`, modo `0700`. WAHA roda como UID 1000 dentro do container; map de UID via Docker user namespace (opcional, complica permissões — começar sem).

Backup script `/srv/deskcomm/scripts/backup-sessions.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
TS=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=/srv/waha/backups
mkdir -p "$BACKUP_DIR"
# Pause WAHA briefly pra consistência
docker compose -f /srv/deskcomm/docker-compose.yml stop waha
tar czf "$BACKUP_DIR/sessions-$TS.tar.gz" -C /srv/waha sessions
docker compose -f /srv/deskcomm/docker-compose.yml start waha
# Upload pro Wasabi/R2
aws s3 cp "$BACKUP_DIR/sessions-$TS.tar.gz" \
  "s3://deskcomm-backups/waha-sessions/sessions-$TS.tar.gz" \
  --endpoint-url=https://s3.wasabisys.com
# Limpar locais >7d
find "$BACKUP_DIR" -name 'sessions-*.tar.gz' -mtime +7 -delete
```

Systemd timer `waha-backup.timer` weekly Sunday 04:00 BRT.

### 6.3 Nginx reverse proxy + Let's Encrypt

`nginx/conf.d/waha.conf`:
```nginx
upstream waha_upstream {
    server waha:3000;
    keepalive 32;
}

# HTTP → HTTPS redirect + ACME challenge
server {
    listen 80;
    server_name waha.deskcomm.com.br;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name waha.deskcomm.com.br;

    ssl_certificate     /etc/letsencrypt/live/waha.deskcomm.com.br/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/waha.deskcomm.com.br/privkey.pem;
    include             /etc/nginx/snippets/ssl-hardening.conf;

    # Apenas Vercel egress IPs + IPs do dev team
    include             /etc/nginx/snippets/vercel-allowlist.conf;
    deny all;

    # Limites de body pra mídia
    client_max_body_size 60M;
    client_body_buffer_size 1M;

    # Logs estruturados
    access_log /var/log/nginx/waha-access.log json_combined;
    error_log  /var/log/nginx/waha-error.log warn;

    # Auth Header passthrough
    proxy_set_header X-Api-Key       $http_x_api_key;
    proxy_set_header Host            $host;
    proxy_set_header X-Real-IP       $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;

    # Streaming (mídia, SSE)
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_http_version 1.1;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;

    location / {
        proxy_pass http://waha_upstream;
    }

    # Bloqueia rotas de management que não devem ser públicas
    location ~ ^/(swagger|dashboard) {
        return 404;
    }
}
```

Bootstrap inicial certbot (1ª vez, fora do compose):
```bash
docker run --rm -v /etc/letsencrypt:/etc/letsencrypt -v /var/www/certbot:/var/www/certbot \
  -p 80:80 certbot/certbot certonly --standalone \
  -d waha.deskcomm.com.br --email ops@deskcomm.com.br --agree-tos --no-eff-email
```

### 6.4 Firewall

**Decisão:** allowlist apenas Vercel egress IPs + dev IPs. Path token + HMAC bastam **logicamente** (defesa em profundidade), mas IP allowlist:
1. Reduz superfície de bruteforce no `/api/server/start` etc.
2. Reduz custo de log (95% menos noise).
3. Vercel publica lista de IPs egress estável (https://vercel.com/docs/edge-network/regions). Atualização via cron mensal pull + reload Nginx.

UFW config:
```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow from <admin-ip> to any port 22 proto tcp
ufw allow 80/tcp                          # ACME challenge
ufw allow 443/tcp                         # HTTPS — Nginx aplica allowlist app-level
ufw enable
```

fail2ban com filter pra Nginx 403/401 (banir IPs que tentam paths bloqueados).

### 6.5 Backup das sessões
Coberto em §6.2. Verificação trimestral: restore em VPS de staging, conferir que sessão volta `WORKING` sem re-QR.

---

## 7. Secrets Management

### 7.1 Lista exaustiva de env vars

| Var | Escopo | Tipo | Rotação | Onde nasce |
|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | público | URL | nunca | Supabase Dashboard |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | público | JWT | nunca (rotação = recriar projeto) | Supabase Dashboard |
| `SUPABASE_SERVICE_ROLE_KEY` | server | JWT | nunca | Supabase Dashboard |
| `DATABASE_URL` | server | URI | nunca | Supabase Dashboard |
| `DIRECT_DATABASE_URL` | server (migrations) | URI | nunca | Supabase Dashboard (porta 5432) |
| `SUPABASE_JWT_SECRET` | server | hex | rotação = blackout | Supabase Dashboard |
| `WAHA_BASE_URL` | server | URL | nunca | infra |
| `WAHA_API_KEY_PLAINTEXT` | server | string | trimestral | gerado `openssl rand -hex 32` |
| `WAHA_WEBHOOK_HMAC_KEY` | server | hex | trimestral | gerado `openssl rand -hex 32` |
| `UPSTASH_REDIS_REST_URL` | server | URL | nunca | Upstash Dashboard |
| `UPSTASH_REDIS_REST_TOKEN` | server | string | trimestral | Upstash Dashboard |
| `AI_GATEWAY_API_KEY` | server | string | trimestral | Vercel AI Gateway |
| `SENTRY_DSN` | server | URL | nunca | Sentry Dashboard |
| `NEXT_PUBLIC_SENTRY_DSN` | público | URL | nunca | Sentry Dashboard |
| `SENTRY_AUTH_TOKEN` | CI | string | trimestral | Sentry → CLI Auth Tokens |
| `ENCRYPTION_KEY_CPF` | server | hex 32B | anual + on-incident | gerado |
| `ENCRYPTION_KEY_OAUTH` | server | hex 32B | anual | gerado |
| `ENCRYPTION_KEY_WAHA_BYO` | server | hex 32B | anual | gerado |
| `NUVEMSHOP_CLIENT_ID` | server | string | nunca | Nuvemshop Partner Dashboard |
| `NUVEMSHOP_CLIENT_SECRET` | server | string | quando vazado | Nuvemshop Partner Dashboard |
| `NUVEMSHOP_WEBHOOK_HMAC_SECRET` | server | string | quando vazado | Nuvemshop Partner Dashboard |
| `CRON_SECRET` | server | hex | trimestral | Vercel auto-gen |
| `INTERNAL_API_TOKEN` | server (MCP fase 2) | string | trimestral | gerado |
| `SUPABASE_S3_ACCESS_KEY` | WAHA VPS | string | trimestral | Supabase Storage S3 creds |
| `SUPABASE_S3_SECRET_KEY` | WAHA VPS | string | trimestral | idem |
| `WASABI_ACCESS_KEY` / `WASABI_SECRET` | WAHA VPS + cron | string | anual | Wasabi |
| `NEXT_PUBLIC_APP_URL` | público | URL | nunca | infra |
| `RESEND_API_KEY` (notifs email) | server | string | trimestral | Resend |
| `SLACK_WEBHOOK_ALERTS_URL` | server | URL | quando vazado | Slack admin |
| `PAGERDUTY_INTEGRATION_KEY` | server | string | quando vazado | PagerDuty |

### 7.2 Vercel env (production / preview / development)
- **Production:** scope `Production` apenas. Visível só pra owners da team.
- **Preview:** scope `Preview`. Aponta pra Supabase/WAHA staging.
- **Development:** vazio (devs usam `.env.local` próprio puxado de 1Password Family vault).

Nunca: var de produção em scope `Preview`. CI verifica via `vercel env ls --environment=preview` + grep por chaves prod conhecidas.

### 7.3 Encryption keys separadas
3 keys distintas porque rotação é diferente:
- `ENCRYPTION_KEY_CPF` — column-level encryption do CPF em `contacts` (LGPD). Rotação anual ou em incidente. Re-encrypt em background com dual-read window 30d.
- `ENCRYPTION_KEY_OAUTH` — tokens Nuvemshop (`oauth_credentials.encrypted_access_token`). Rotação anual. Re-encrypt no próximo refresh OAuth.
- `ENCRYPTION_KEY_WAHA_BYO` — futura feature BYO WAHA do tenant. Mantém separado pra que vazamento de uma key não comprometa as outras.

Implementação: `pgp_sym_encrypt(plaintext, key)` da `pgcrypto`. Wrapper TS em `lib/crypto/encrypt.ts` valida que a key vem de env, nunca hardcoded.

### 7.4 Rotação trimestral
Calendário fixo: 1º dia útil de Jan/Abr/Jul/Out.
- Issue tracker template `chore/secrets-rotation-Q{n}` aberto automaticamente via GitHub Actions cron.
- Checklist por var (gerar nova → atualizar Vercel/Upstash/etc → deploy → invalidar antiga após 24h grace period).
- Audit log: `event_log.type='secret.rotated'` com hash dos 4 últimos chars da key antiga vs nova (não a key).

### 7.5 .gitleaks pre-commit
`.gitleaks.toml` com regras Brasil-aware (CPF, OAB, etc) + extends default. Pre-commit hook bloqueia commit se detectar. CI também roda `gitleaks detect --source . --redact` em PR.

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.18.0
    hooks:
      - id: gitleaks
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.5.0
    hooks:
      - id: detect-private-key
      - id: check-added-large-files
        args: [--maxkb=500]
```

---

## 8. CI/CD

### 8.1 Vercel Git integration
- GitHub repo conectado ao project Vercel via OAuth.
- Trigger: push em `main` → deploy `Production`. Push em qualquer outra branch → `Preview`.
- Deploy protection: branch `main` requer (a) PR aprovado, (b) checks verdes, (c) 1 reviewer mínimo.

### 8.2 Preview deployments
- 1 deploy por commit. URL `deskcomm-app-git-{branch}-{team}.vercel.app`.
- Cada Preview cria uma branch Supabase (`supabase branch create --name preview-{pr}`) automaticamente via GitHub Action.
- Comentário automático no PR com URL Preview + link Sentry environment.

### 8.3 Rolling releases
Vercel Pro com Skew Protection ativado garante que clients antigos não chamem API nova quebrada durante deploy. Toggle no Dashboard: **Settings → Deployment → Skew Protection** (max age 12h).

Para rollback: `vercel rollback <previous-deployment-url>` ou via UI. Banco de dados não rollbacka — toda migration é forward-compatible (regra de ouro: nunca DROP COLUMN no mesmo PR que adiciona uso novo; espalhar em 2 PRs com 1 release no meio).

### 8.4 Migrations runner (Supabase CLI no CI)

`.github/workflows/db-migrations.yml`:
```yaml
name: DB Migrations
on:
  push:
    branches: [main]
    paths: ["supabase/migrations/**"]
  workflow_dispatch:

jobs:
  migrate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
        with: { version: latest }
      - name: Apply migrations to production
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
          SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}
        run: |
          supabase link --project-ref ${{ secrets.SUPABASE_PROJECT_REF }}
          supabase db push --include-all
      - name: Notify Slack on success
        if: success()
        run: curl -X POST -H 'Content-Type: application/json' \
          --data "{\"text\":\"✅ Migrations applied to production: ${{ github.sha }}\"}" \
          ${{ secrets.SLACK_WEBHOOK_ALERTS_URL }}
      - name: Notify Slack on failure
        if: failure()
        run: curl -X POST -H 'Content-Type: application/json' \
          --data "{\"text\":\"🚨 Migration FAILED on production: ${{ github.sha }}\"}" \
          ${{ secrets.SLACK_WEBHOOK_ALERTS_URL }}
```

Fluxo: PR adiciona migration → Preview cria branch Supabase + aplica → merge em `main` aplica em produção. Falha aborta o deploy Vercel via deployment status check.

CI lint suite (separado): `pnpm typecheck && pnpm lint && pnpm test && pnpm test:rls && pnpm test:e2e`. RLS test obrigatório (cria 2 tenants, garante que A não vê B).

---

## 9. Observability

### 9.1 Sentry config (com beforeSend pra sanitização de PII)

`sentry.server.config.ts`:
```typescript
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.VERCEL_ENV ?? "development",
  release: process.env.VERCEL_GIT_COMMIT_SHA,
  tracesSampleRate: process.env.VERCEL_ENV === "production" ? 0.1 : 1.0,
  profilesSampleRate: 0,                       // desligado MVP
  sendDefaultPii: false,
  beforeSend(event, hint) {
    // 1. Drop em paths de health (noise)
    if (event.request?.url?.includes("/api/v1/health")) return null;

    // 2. Redact CPF, telefone, email, tokens em qualquer string profunda
    const PATTERNS = [
      { re: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, label: "[CPF_REDACTED]" },
      { re: /\b\+?55\s?\(?\d{2}\)?\s?\d{4,5}-?\d{4}\b/g, label: "[PHONE_REDACTED]" },
      { re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, label: "[EMAIL_REDACTED]" },
      { re: /Bearer\s+[A-Za-z0-9._-]+/g, label: "Bearer [TOKEN_REDACTED]" },
      { re: /sk_[A-Za-z0-9]{20,}/g, label: "[SECRET_REDACTED]" },
    ];
    const redact = (s: string) =>
      PATTERNS.reduce((acc, p) => acc.replace(p.re, p.label), s);
    const walk = (obj: any): any => {
      if (typeof obj === "string") return redact(obj);
      if (Array.isArray(obj)) return obj.map(walk);
      if (obj && typeof obj === "object") {
        return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, walk(v)]));
      }
      return obj;
    };
    return walk(event);
  },
  integrations: [
    Sentry.httpIntegration({ breadcrumbs: true }),
    Sentry.postgresIntegration(),
  ],
  ignoreErrors: [
    "AbortError",                              // cancellations não são bug
    "ResizeObserver loop limit exceeded",
  ],
});
```

Tags úteis injetadas via `Sentry.setTag()` em middleware:
- `tenant_id` (organization id; **não** o nome — privacidade)
- `user_role` (`viewer|agent|manager|admin|platform_admin`)
- `route` (rota Next normalizada)

### 9.2 Structured logs (formato JSON; logger wrapper)

`lib/log/logger.ts`:
```typescript
import pino from "pino";

export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-api-key']",
      "*.password", "*.cpf", "*.phone_number",
      "*.access_token", "*.refresh_token",
    ],
    censor: "[REDACTED]",
  },
  base: {
    service: "deskcomm-app",
    env: process.env.VERCEL_ENV,
    region: process.env.VERCEL_REGION,
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7),
  },
});

// Helpers tipados
export const logEvent = (
  type: string,
  payload: { tenant_id?: string; user_id?: string; [k: string]: unknown },
) => log.info({ event: type, ...payload }, type);
```

Toda chamada de log deve passar por esse wrapper. ESLint rule custom `no-console` enforce.

Sample event:
```json
{
  "level":"info","time":"2026-04-28T14:32:11.234Z",
  "service":"deskcomm-app","env":"production","commit":"a1b2c3d",
  "event":"waha.message.received",
  "tenant_id":"3f1e...","conversation_id":"...", "external_id":"...",
  "duration_ms":42,
  "msg":"waha.message.received"
}
```

Ingestão dos logs: Vercel Log Drains → Logflare ou Axiom (decisão pendente — Axiom $25/mês 0.5TB; Logflare free tier suficiente até 10M events/mês). Search e dashboard nesse provedor; alertas críticos vão pro Sentry+Slack.

### 9.3 Métricas custom

**Sem instalar Prometheus/Grafana próprio no MVP.** Usar:
- **Sentry Metrics** (beta) pra contadores essenciais.
- **Vercel Analytics** pra Web Vitals e edge metrics.
- **AI Gateway dashboard** pra tokens/latência/custo per-tenant.
- **Postgres `pg_stat_statements`** pra DB perf, query via SQL ad-hoc + view materializada `dba.slow_queries_top20`.

Métricas custom no Sentry (via SDK):
```typescript
Sentry.metrics.increment("waha.message.received", 1, {
  tags: { tenant_id, direction: "inbound", status: "delivered" },
});
Sentry.metrics.distribution("waha.message.send_latency_ms", duration, {
  tags: { tenant_id },
});
Sentry.metrics.gauge("waha.session.health", session.status === "WORKING" ? 1 : 0, {
  tags: { tenant_id, session_id },
});
```

Lista canônica de métricas:
| Nome | Tipo | Tags | Owner |
|---|---|---|---|
| `waha.message.received` | counter | tenant, direction, status | 03 |
| `waha.message.send_latency_ms` | distribution | tenant | 03 |
| `waha.session.health` | gauge | tenant, session_id | 03 |
| `api.request.duration_ms` | distribution | route, method, status | 01 |
| `api.rate_limit.exceeded` | counter | tenant, route | 01 |
| `lgpd.request.received` | counter | tenant, type | 06 |
| `lgpd.request.sla_lag_hours` | gauge | tenant | 06 |
| `ai.token.cost_usd` | distribution | tenant, model, purpose | 05 |
| `nuvemshop.sync.lag_seconds` | gauge | tenant | 06 |
| `event_log.consume_lag_seconds` | gauge | event_type | 01 |

### 9.4 Dashboards essenciais

**Sentry Dashboard "SonghaiCRM Ops":**
- Errors per hour by environment
- p50/p95/p99 latência por endpoint top-20
- Top issues últimos 7d
- Crash-free sessions

**Vercel Analytics:**
- TTFB, LCP, CLS, INP por país (Brasil only filtro)
- Top routes
- Cron success rate

**Axiom/Logflare Dashboard:**
- WAHA inbound/outbound por tenant
- LGPD requests pendentes
- Eventos `event_log` por tipo (24h heatmap)

**Postgres (consulta SQL ad-hoc, salva em views):**
```sql
create or replace view dba.slow_queries_top20 as
select substring(query, 1, 120) as q, calls, mean_exec_time, total_exec_time
from pg_stat_statements
where query not ilike '%pg_stat_statements%'
order by mean_exec_time desc
limit 20;
```

### 9.5 Health check endpoint `/api/v1/health`

```typescript
// app/api/v1/health/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  const checks = await Promise.allSettled([
    checkSupabase(),    // SELECT 1
    checkRedis(),       // PING
    checkWAHA(),        // GET /api/server/status
    checkAIGateway(),   // models list (cached 60s)
  ]);

  const result = {
    status: checks.every(c => c.status === "fulfilled" && c.value.ok) ? "ok" : "degraded",
    checks: {
      supabase: serializeCheck(checks[0]),
      redis:    serializeCheck(checks[1]),
      waha:     serializeCheck(checks[2]),
      ai_gateway: serializeCheck(checks[3]),
    },
    duration_ms: Date.now() - started,
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev",
    region: process.env.VERCEL_REGION ?? "local",
  };

  return NextResponse.json(result, {
    status: result.status === "ok" ? 200 : 503,
  });
}
```

UptimeRobot externo (free tier) pinga `/api/v1/health` a cada 1min. Falha 2 consecutivas → PagerDuty.

---

## 10. Alertas

| # | Sinal | Threshold | Canal | Severidade | Owner |
|---|---|---|---|---|---|
| A1 | Sentry novo issue (unhandled exception em prod) | 1ª ocorrência | Slack #deskcomm-alerts | warn | dev on-call |
| A2 | Sentry issue volume spike | >50 events/h | Slack + PagerDuty | crit | dev on-call |
| A3 | WAHA session FAILED | qualquer | Slack #deskcomm-ops + email tenant | crit | DevOps |
| A4 | WAHA session STARTING >5min | sustentado | Slack #deskcomm-ops | warn | DevOps |
| A5 | LGPD `data_request` SLA D+5 | cron diário | Slack #deskcomm-lgpd + email DPO | warn | LGPD owner |
| A6 | LGPD `data_request` SLA D+6 | cron diário | PagerDuty | crit | LGPD owner |
| A7 | Rate limit Nuvemshop estourado | >5 429s/min | Slack #deskcomm-ops | warn | dev on-call |
| A8 | Audit log lag (event_log unconsumed) >5min | gauge | Slack | crit | dev on-call |
| A9 | API p95 >300ms (rolling 15min) | sustentado 30min | Slack | warn | dev on-call |
| A10 | API p99 >2s | sustentado 15min | Slack + PagerDuty | crit | dev on-call |
| A11 | DB query p95 >100ms | sustentado 30min | Slack | warn | DBA/DevOps |
| A12 | Realtime lag >500ms | gauge | Slack | warn | dev on-call |
| A13 | Health check `/api/v1/health` failing | 2 consecutivos | PagerDuty | crit | on-call rotation |
| A14 | Cron run falhou | qualquer | Slack | warn | dev on-call |
| A15 | Cron `recover-stuck-messages` reprocessou >100 msgs | spike | Slack | warn | dev on-call (algo travou upstream) |
| A16 | AI cost por tenant >$300/mês | budget alert | Slack + email tenant | warn | finops |
| A17 | AI cost por tenant >$500/mês | budget alert | Slack + corte automático | crit | finops |
| A18 | Disk WAHA VPS >80% | gauge | Slack | warn | DevOps |
| A19 | Sessões WAHA banidas (qualquer) | 1 evento | PagerDuty + reunião pós-mortem obrigatória | crit | DevOps + produto |
| A20 | Backup daily Supabase falhou | dashboard check | Slack | crit | DevOps |

Configuração: Sentry → Slack via integração nativa. Slack → PagerDuty via Slack workflow. Crons monitoram seus próprios alerts emitindo Sentry messages com `level=error`.

---

## 11. Runbooks

> Convenção: cada runbook tem **Sintoma → Diagnóstico → Ação → Verificação → Pós-mortem**. Salvos também em `/srv/deskcomm/runbooks/` no VPS pra acesso offline.

### 11.1 Número WAHA banido — fluxo de troca

**Sintoma.** Alerta A19 disparado. Sessão `FAILED`, logs WAHA com erro `phone_banned` ou `not_authorized`.

**Diagnóstico.**
1. Confirmar via WAHA dashboard interno (port-forward ssh) ou `docker exec deskcomm-waha curl localhost:3000/api/sessions`.
2. Validar que não é falso positivo (network glitch). Tentar reconectar via UI: se falha imediata após QR scan, é ban.
3. Pesquisar logs últimos 7d: enviou >500 msgs/dia? campanha não-warmed? muitas STOP recebidas?

**Ação.**
1. **Imediata (<10min):** marcar `channel_sessions.status='banned'` + `is_active=false`. Trigger UI: tenant vê banner "Número fora de operação".
2. **Comunicação:** email ao admin do tenant + Slack #deskcomm-ops com root-cause hypothesis.
3. **Substituição:** ativar número backup pré-aquecido (todo tenant deve ter 2º número em warm-up contínuo). UI tenant: "Conectar número de backup" → re-QR no novo.
4. **Migration de conversas:** novas mensagens vão pro novo número; histórico permanece linkado a session antiga (read-only).

**Verificação.**
- Nova session `WORKING` em <30min.
- Próximas 24h sem ban no número novo.
- Cliente final não percebeu fricção (verificar via NPS pós-conversa).

**Pós-mortem.** Reunião obrigatória ≤72h. Registrar em `docs/postmortems/YYYY-MM-DD-tenant-X-ban.md`. Action items revisam thresholds anti-banimento.

### 11.2 Sessão STARTING travada — docker volume rm

**Sintoma.** A4 dispara. UI mostra spinner infinito após QR scan.

**Diagnóstico.**
```bash
ssh ops@waha.deskcomm.com.br
docker logs deskcomm-waha --tail 200 | grep -i "session-{id}"
docker exec deskcomm-waha ls /app/.sessions/{sessionId}
```
Geralmente: arquivo `creds.json` ou diretório `.sessions/{sessionId}` corrompido (timeout durante init).

**Ação.**
1. Stop sessão via WAHA API: `POST /api/sessions/{id}/stop`.
2. Remover diretório:
   ```bash
   docker compose stop waha
   rm -rf /srv/waha/sessions/{sessionId}
   docker compose start waha
   ```
3. Re-QR no UI (status volta a `SCAN_QR_CODE`).

**Verificação.** `GET /api/sessions/{id}` retorna `WORKING` em ≤2min após scan.

### 11.3 Tenant report data_request — execução manual de fallback

**Sintoma.** A6 dispara D+6 (1 dia antes do SLA). Cron `lgpd-data-request-runner` falhou repetidamente.

**Diagnóstico.**
1. Sentry: ver exceção do worker.
2. SQL: `select * from lgpd_requests where id='...';` — checar `status` e `error_log`.

**Ação manual.**
1. Run script `scripts/lgpd/manual-export.ts <request_id>` que:
   - Coleta todos dados do titular (contacts, conversations, messages, lead_activities, orders).
   - Gera JSON canônico + PDF render via Puppeteer.
   - Sobe pra `lgpd-exports` bucket com TTL 7d.
   - Atualiza `lgpd_requests.status='completed'` + `delivered_at=now()`.
2. Notifica titular via canal informado no webhook (email).
3. Audit log entry tipo `lgpd.data_request.manual_fallback` com `metadata.operator_id`.

**Verificação.** SLA D+7 não estoura. Próxima auditoria revisa motivo do fallback.

### 11.4 Rotação de chaves de encryption

**Quando.** Calendário trimestral OU vazamento detectado.

**Procedimento (CPF como exemplo):**
1. Gerar nova: `NEW_KEY=$(openssl rand -hex 32)`.
2. Adicionar `ENCRYPTION_KEY_CPF_NEW` em Vercel env (Production).
3. Deploy: app passa a fazer **dual-read** (tenta nova; se falha, lê com antiga).
4. Background job `lib/jobs/reencrypt-cpf.ts` percorre `contacts` em batches 1k:
   - Decrypt com antiga
   - Encrypt com nova
   - Update + audit
5. Após job completar (ETA por volume): renomear env vars (NEW vira atual, antiga removida).
6. Audit log: `secret.rotated` por tenant.

**Verificação.** Sample 100 rows: lê CPF correto. Job completou 100% sem erros. Antiga key removida do Vercel + 1Password.

### 11.5 Restore de backup

**Sintoma.** Corrupção, deleção acidental, dúvida sobre integridade.

**Procedimento (full restore Supabase):**
1. **NÃO restaurar em prod direto.** Sempre passar por staging.
2. Supabase Dashboard → Project Settings → Backups → "Restore to new project". Aguarda ~30min.
3. Apontar app de staging pra projeto restaurado.
4. Validar: row counts, audit log último mês, signed URL de mídia.
5. Decisão: se OK e restore é necessário em prod, abrir change-request (RTO target 4h) e:
   - Pause produção (banner "Manutenção 30min").
   - `pg_dump` do prod atual (paranoia backup).
   - Promote restore como novo prod ou aplicar diff seletivo.
6. Audit log: `dr.restore.executed` com `metadata.backup_timestamp`.

**Verificação.** Smoke test E2E pós-restore (criar lead, mandar msg WAHA, fazer LGPD export dummy).

### 11.6 LGPD ANPD audit trail extraction

**Demanda.** Auditor solicita evidência de operação X em titular Y.

**Procedimento.**
1. Identificar titular: `select id from contacts where cpf = pgp_sym_decrypt(...) or email = '...';`
2. Query consolidada:
   ```sql
   select a.*, u.email as actor_email
   from api_audit_log a
   left join auth.users u on u.id = a.actor_user_id
   where a.target_id::text = ANY(ARRAY[
     <contact_id>, <conversation_ids>, <lead_ids>
   ]) order by a.created_at;
   ```
3. Export como CSV + assinar SHA256.
4. Entregar via canal seguro (email PGP ou portal).
5. Audit log: `lgpd.audit_extraction` registra a operação.

**Verificação.** Hash conferido com auditor. Range temporal cobre solicitação.

---

## 12. Performance Targets

| Métrica | Target | Alerta warn | Alerta crit | Como medir |
|---|---|---|---|---|
| API p95 (rotas `/api/v1/*` excluindo `/lgpd/*` e `/health`) | <300ms | >300ms 30min | >500ms 15min | Vercel Analytics + Sentry |
| API p99 | <2s | >1s 30min | >2s 15min | idem |
| Webhook handler p99 (WAHA + Nuvemshop) | <2s | >2s | >5s | log custom + Sentry |
| DB query p95 (`pg_stat_statements`) | <100ms | >100ms | >300ms | view `dba.slow_queries_top20` |
| Realtime lag (postgres_changes inbound→client) | <500ms | >500ms | >2s | medição cliente injeta `client_received_at` |
| TTFB Brasil | <500ms | >800ms | >1.5s | Vercel Web Vitals |
| LCP (UI atendimento principal) | <2.5s | >2.5s | >4s | Vercel Web Vitals |
| WAHA send latency (POST → ack) | <1.5s p95 | >2s | >5s | metric custom |
| Cron success rate | 100% | <99% (rolling 7d) | <95% | dashboard Vercel |
| Health endpoint uptime | 99.95% | <99.9% | <99% | UptimeRobot |

Budget de erro: 0.05% / mês ≈ 21min downtime tolerado. Excedeu? Freeze de features novas, foco hardening.

---

## 13. Disaster Recovery

### 13.1 RPO / RTO targets

| Cenário | RPO | RTO | Estratégia |
|---|---|---|---|
| Falha Vercel region (gru1) | 0 | 5min | Auto-failover Vercel pra `iad1`; latência aumenta ~120ms mas funcional |
| Supabase down (DB total) | 24h (sem PITR) / 5min (com PITR) | 4h | Restore daily backup em projeto novo; DNS swap |
| VPS própria down (WAHA) | 7d (snapshot semanal) | 2h | Subir docker-compose em VPS reserva (restic restore + cloud-init); re-QR todas sessões NÃO afetadas se sessions restoradas |
| Upstash Redis down | 0 (não persistente crítico) | 1min | Fallback in-memory; rate limit fica permissivo, idempotency vira best-effort |
| AI Gateway down | 0 | 1min | Failover automático Anthropic→OpenAI via Gateway; se Gateway todo cai, modo "humano-only" (banner UI) |

### 13.2 Read-only mode quando Supabase down

Feature flag `READ_ONLY_MODE` em Edge Config. Quando ativada:
- Frontend mostra banner "Manutenção; novas mensagens serão processadas em breve".
- Webhook receivers WAHA/Nuvemshop persistem **payload bruto** em Upstash Redis (key TTL 24h) e respondem 200 (idempotência via external_id).
- Background queue, ao restaurar DB, drena Redis na ordem por `received_at`.
- Envio de mensagens bloqueado (`POST /api/v1/messages` retorna 503).

Trigger: manual via super-admin. Auto-trigger desligado (risco de flap).

### 13.3 Fallback strategies adicionais
- **WAHA banimento generalizado da conta SonghaiCRM (modelo BPO):** plano de migração pra API oficial Meta documentado no PRD-03 (Fase 2.5).
- **Nuvemshop deprecação de webhook:** adapter pattern + assinar feed de release notes; testes de contrato no CI dão alerta.

---

## 14. Custo Estimado (MVP, 1–3 tenants)

| Item | Plano | Custo mensal | Notas |
|---|---|---|---|
| Vercel Pro | 1 seat | $20 | seats adicionais $20/dev. Frontend + API + crons |
| Supabase Pro | base | $25 | + ~$10 compute upgrade quando p95 >100ms |
| Supabase PITR (opcional) | addon | $0 (MVP) → $100 | ativar quando primeiro tenant >R$50k/mês |
| VPS própria (equiv. Turing) | mensal | ~R$140 (~$28) | WAHA Plus + Nginx; datacenter São Paulo (latência baixa pro WhatsApp BR) |
| WAHA Plus license | mensal | $30 | https://waha.devlike.pro pricing |
| Upstash Redis | pay-as-you-go | $5–15 | rate limit + idempotency |
| Sentry Team | base | $26 | 50k errors / 100k perf |
| AI Gateway markup (~2%) | variável | incluso | Vercel Pro |
| Anthropic via Gateway | variável | $50–300/tenant | depende de volume; Sonnet $3/1M in, $15/1M out |
| Wasabi/R2 backup storage | mensal | $5 | <1TB |
| Resend (transacional email) | free tier | $0 | 3k emails/mês free |
| UptimeRobot | free tier | $0 | 50 monitors |
| Logflare/Axiom | free tier | $0–25 | escolher após 30d uso |
| Domínio + DNS Cloudflare | anual | ~$1/mês | |

**Total infra fixa (sem IA):** ~$120–145/mês para 1–3 tenants.
**Total com IA (3 tenants ativos médio uso):** ~$270–550/mês.
**Total com IA (3 tenants alto uso):** $1k+/mês — acionar budget alerts.

Faturamento mínimo viável por tenant (margem 60%): R$ 600–1.000/mês. ROI fecha já no 2º tenant.

---

## Anexos

- `scripts/dev/update-waha-webhook.sh` — atualiza URL ngrok no WAHA local
- `scripts/lgpd/manual-export.ts` — fallback manual data_request
- `scripts/ops/rotate-encryption-key.ts` — runner de rotação de chaves com dual-read
- `nginx/snippets/ssl-hardening.conf` — TLS config Mozilla intermediate
- `nginx/snippets/vercel-allowlist.conf` — gerado por cron mensal pull dos IPs Vercel
- `docs/postmortems/` — diretório de pós-mortems (1 arquivo por incidente A19/A20)
