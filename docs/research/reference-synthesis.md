# Reference Synthesis — Aula CRM Nichado com WhatsApp (WAHA)

**Origem:** `/Users/rafaelmelgaco/Documents/Obsidian Vault/Ecossistema Labs/AutomatikLabs/Treinamentos e Cursos/Aula - CRM Nichado com WhatsApp (WAHA)/`

**Status:** Adotada integralmente como linha de base arquitetural do SonghaiCRM (decisão registrada em memória do projeto).

Esse documento extrai apenas as decisões e padrões da referência que o SonghaiCRM herda. Para citações literais, schema SQL completo e edge cases detalhados, consultar a fonte original.

---

## 1. Stack canônica

| Camada | Escolha |
|---|---|
| Frontend | Next.js 14+ App Router + TypeScript + Tailwind + shadcn/ui + lucide-icons |
| Backend | Next.js Route Handlers / Server Actions (mesmo repo) |
| DB | Supabase (Postgres gerenciado) |
| Realtime | Supabase Realtime (postgres_changes + broadcast) |
| Auth | Supabase Auth via `@supabase/ssr` (cookie SameSite=Strict) |
| Storage | Supabase Storage (bucket `whatsapp-media` privado, URLs assinadas) |
| WhatsApp | WAHA Plus (multi-tenant); engine NOWEB |
| Hospedagem app | Vercel |
| Hospedagem WAHA | Railway (MVP) → VPS própria (produção) |
| Validação | Zod em todo input |
| Rate limit | Upstash Redis (sliding window) com fallback in-memory |
| Cron | Vercel Cron |
| Filas | Inngest / Trigger.dev / pg_boss (a definir) |
| Drag-drop | `@hello-pangea/dnd` |
| MCP server | Node 20+ ESM + `@modelcontextprotocol/sdk` + Express + Zod (projeto separado `/crm-mcp`) |

---

## 2. Arquitetura

**Estilo:** monolito Next.js + Supabase + serviço externo só pra WAHA. Não é microsserviços. Não é event sourcing puro — usa `event_log` + workers (pub/sub leve). Sem CQRS.

```
Frontend (Next.js App Router)
      │ Supabase Realtime
      ▼
Backend (Next.js Route Handlers + Cron)
      │
      ▼
Postgres (Supabase) ── event_log + triggers ──► workers
      ▲
      │ Bearer token
      │
MCP Server (Node ESM, /crm-mcp) ── REST API ──► Postgres
      ▲
      │
WAHA (Docker, 1 instância, N sessões) ── webhooks ──► Backend
```

**Padrões obrigatórios:**
- **Núcleo gravitacional**: 5 tabelas core CRM (pipelines, stages, leads, lead_activities polimórfica, lead_links polimórfica)
- **Event log + workers**: trigger Postgres NUNCA faz HTTP. Trigger emite linha em `event_log`; worker consome via Realtime, pull-loop ou LISTEN/NOTIFY
- **Polimorfismo explícito**: timeline (`source_module`, `source_id`) e vínculos (`target_kind`, `target_id`, `link_kind`)
- **Idempotência**: `unique (organization_id, external_id)` + captura `code === '23505'`
- **Doutrina DIRC** (Duplicar / Integrar / Referenciar / Calcular): heurística antes de criar qualquer campo

---

## 3. Data model (resumo)

### 5 tabelas core CRM
```
crm_pipelines (org → N pipelines)
  └── crm_stages (pipeline → N stages, ordenadas por position)
        └── crm_leads (stage → N leads, ordenados por position_in_stage NUMERIC)
              ├── crm_lead_activities (timeline polimórfica)
              └── crm_lead_links (vínculos polimórficos)
```

### Tabelas WhatsApp/Chat
```
organizations
└── channel_sessions (1 sessão WAHA = 1 número; webhook_secret por sessão)
    └── contacts (único por org+phone_number)
        └── conversations (thread por contact + channel_session)
            └── messages (idempotente via unique org+external_id)
```

### Decisões críticas de modelagem
- `position_in_stage` é `numeric` (fractional indexing via midpoint) — **não usar `int`**
- `external_id` nullable (mensagem outbound em `sending` ainda não tem ID WAHA)
- `type` é text + check constraint, não enum (enum é difícil de estender)
- `tags` é `text[]` + GIN; promove pra coluna gerada apenas quando vira hot path
- `custom_fields` jsonb com schema declarativo em `pipeline.settings.fields` — Zod construído dinamicamente
- `vocabulary` jsonb em `pipeline` permite renomear lead/deal/won/lost por nicho

---

## 4. Multi-tenancy via RLS

**Modelo escolhido:** `organization_id uuid not null` em toda tabela tenant-aware + RLS em todas. NÃO schema-per-tenant.

```sql
create or replace function public.fn_user_org_ids()
returns table(organization_id uuid)
language sql stable security definer set search_path = public as $$
  select organization_id from public.user_organizations where user_id = auth.uid()
$$;

-- Aplicado a TODA tabela tenant-aware:
create policy "tenant_isolation_X_all" on public.<tabela> for all
  using (organization_id in (select organization_id from public.fn_user_org_ids()))
  with check (organization_id in (select organization_id from public.fn_user_org_ids()));
```

**Service role bypassa RLS** — webhook handlers e cron usam admin client, e devem **filtrar manualmente** `organization_id` resolvido a partir de fonte confiável (cookie, JWT, webhook secret ou path token), nunca do body.

---

## 5. WAHA (WhatsApp) — pontos críticos

- **Plus obrigatório em multi-tenant** (Core só suporta 1 sessão; sem retry de webhook; sem S3 storage)
- **Engine NOWEB** por default (mais leve, ~150MB; estável). WEBJS apenas quando precisa de stickers animados ou listas/botões
- **Auth Plus**: `WAHA_API_KEY` no env é o hash SHA512 hex; cliente envia plaintext em `X-Api-Key`
- **HMAC SHA512** em webhooks com `crypto.timingSafeEqual`
- **Rate limit anti-banimento**: 1 msg/1.2s + jitter ≤800ms (campanha: 1 msg/5s); warm-up 7-14d; spinning de copy; limites 200-500/dia em número novo; janela 7h-22h, evitar domingo
- **Detecção STOP automática**: regex `/STOP|PARAR|SAIR|UNSUBSCRIBE/i` no inbound → `is_blocked=true`
- **Mídia**: sobe pro Storage primeiro, passa URL ao WAHA (não inline base64)
- **Cron `recover-stuck-messages`**: marca `status='sending'` há mais de 5 min como `failed`
- **Multi-device sync**: assinar `message.any` (não só `message`), tratar `fromMe=true` sem duplicar
- **Grupos**: SKIP CRM binding se `chatId.endsWith('@g.us')` (evita deal infinito); sender é `p.author`, não `p.from`

---

## 6. API REST canônica

- **Base path** `/api/v1/` (versionamento por path)
- **JSON snake_case**, IDs UUID v4, ISO-8601 UTC, dinheiro em `_cents`
- **Paginação cursor por default** (cursor opaco base64 com HMAC pra prevenir tampering)
- **Dual auth**: cookie session (frontend) OU `Authorization: Bearer tok_...` (server-to-server). API key NUNCA em query string
- **Idempotency-Key** header em POST de criação (TTL 24h)
- **Rate limit**: Upstash Redis sliding window; headers `X-RateLimit-*` + `Retry-After`
- **Wrapper**: `{ data, meta }` em sucesso; `{ error: { code, message, details } }` em falha
- **Audit log** denso (`api_audit_log`) em toda mutação; fire-and-forget

### Status codes mapeados
200 / 201 / 204 / 400 (body malformado) / 401 / 403 / 404 / 409 (estado conflitante) / 422 (Zod falhou) / 429 / 500.

### Webhooks de saída
`webhook_subscriptions` + `webhook_deliveries` (fila pending/delivering/success/failed/dead). Backoff exponencial 30s→1m→2m→5m→10m→30m→1h (8 tentativas). Auto-disable após 10 falhas. Payload assinado com `X-Webhook-Signature: sha256=<hex>`. Worker dispatcher SEMPRE fora da transação.

---

## 7. RBAC (4 roles)

| Role | Pode |
|---|---|
| `viewer` (1) | GET tudo |
| `agent` (2) | + POST/PATCH em leads/activities atribuídos. Não deleta |
| `manager` (3) | + DELETE leads. Cria/edita pipelines |
| `admin` (4) | Tudo. Cria tokens, gerencia webhooks, vê audit |

**Permissão por pipeline:** começar SEM essa tabela; adicionar quando cliente real pedir.

**MFA TOTP forçado pra admin.** Session timeout 1h com refresh rotation.

---

## 8. MCP server (pós-MVP)

- **Projeto separado** `/crm-mcp/` (Node 20+ ESM)
- **Stack**: `@modelcontextprotocol/sdk` ^1.29 + Express + Zod
- **Dois entry points** no mesmo código: `src/index.ts` (stdio) + `src/index-http.ts` (Streamable HTTP)
- **MCP → REST API → DB**, NUNCA direto ao banco. Reusa toda validação/RLS/lógica
- **Auth Bearer** validado via `GET /api/me` da REST API; MCP NÃO armazena credenciais permanentes
- **1 sessão = 1 McpServer + 1 Transport + 1 AuthContext** (não compartilhar entre clients)
- **DNS rebinding protection ativada** + CORS com allowlist explícita
- **Nginx pra SSE**: `proxy_buffering off`

### 19 tools canônicas
Read: `list_pipelines`, `get_pipeline`, `list_stages`, `list_leads`, `get_lead`, `search_leads`, `list_activities`, `get_lead_metrics`.
Write: `create_lead`, `update_lead`, `move_lead_to_stage`, `delete_lead`, `mark_lead_won`, `mark_lead_lost`, `assign_lead`, `add_activity`, `link_lead_to_resource`, `add_tags` / `remove_tags`, `bulk_update_leads`.

### Resources e Prompts
- Resource `crm://schema` (snapshot live de pipelines/stages/vocabulary/custom_fields/tags) — LLM lê primeiro pra grounding
- Prompt `analyze_stuck_leads(days, pipeline_id)` — template de ação rápida

### Princípios de tool design
- 1 tool = 1 intenção humana
- Descrições escritas pra LLM (verbo + objeto + constraints)
- IDs sempre UUID (LLM aluciona nomes, não UUIDs)
- Mutações idempotentes (`add_tags` em vez de `set_tags`)
- Outputs compactos (não devolver row inteira)

---

## 9. Anti-patterns nomeados (proibidos)

1. String que deveria ser FK (ex: `owner_email text` em vez de `owner_user_id uuid`)
2. Duplicação sem source of truth (snapshot sem trigger nem comentário)
3. Evento sem consumer (emite e ninguém escuta)
4. FK ausente que vira inferência por nome (busca por string em title)
5. Campo sincronizado por cron quando devia ser realtime/trigger
6. Lock-in de jsonb (UI lê path direto sem schema central)
7. Cascade fantasma (deletar contact cascade em messages perde histórico)
8. Polimórfico sem padronização (`target_kind` cada lugar grava diferente)
9. **Trigger faz HTTP** (anti-pattern letal — esperar rede dentro da transação)

---

## 10. Naming convention de eventos (event_log)

`{entity}.{action}` em snake_case. Lista canônica:
- `lead.created`, `lead.stage_changed`, `lead.won`, `lead.lost`, `lead.assigned`
- `lead_activity.recorded`
- `message.received`, `message.sent`, `message.failed`
- `contact.created`, `contact.blocked`
- `appointment.scheduled`, `invoice.paid`
- `webhook.delivery_failed`

---

## 11. Gaps a desenhar do SonghaiCRM (não cobertos pela referência)

1. **Integração Nuvemshop** — OAuth, webhooks `order/created|paid|cancelled|fulfilled|cart_abandoned|customer/redact|customer/data_request`, sync inicial, tabela `orders` linkada a `crm_leads`
2. **LGPD webhooks Nuvemshop específicos** — pseudonimização vs delete, audit trail, export estruturado
3. **Sentiment detection + handoff bot→humano** — onde rodar, threshold, marcador de timeline, política de retomada
4. **Chatbot RAG por tenant** — vector store (pgvector? Supabase Vector?), ingestão (FAQ + política + catálogo Nuvemshop), roteamento contexto+RAG
5. **Super-admin de plataforma** — coluna `is_platform_admin` ou tabela separada; helper RLS retorna TRUE para essa role; UI separada (`admin.deskcomm.com`)
6. **AI provider strategy** — Vercel AI Gateway recomendado (model fallback, observability, zero data retention)
7. **Adapter pattern de e-commerce** — `EcommercePlatformAdapter` interface; Nuvemshop é primeira impl; VTEX/Shopify ficam plugáveis

---

## 12. Ordem de implementação herdada (do checklist `12-checklist-implementacao.md`)

| Fase | Tempo estimado | Foco |
|---|---|---|
| 0 — Preparação | 1-2h | Next.js scaffold, deps, Supabase setup, .env |
| 1 — DB | 30 min | Rodar schema.sql + RLS + bucket |
| 2 — WAHA up | 30 min | docker-compose Core + ngrok |
| 3 — WAHA client + sessão | 1h | Endpoints + UI conexão por QR |
| 4 — Webhook handler | 1.5h | HMAC + dispatcher + handlers + media |
| 5 — Realtime frontend | 1h | Hooks Supabase Realtime |
| 6 — UI Chat Live | 2-3h | Layout 3 colunas + composer |
| 7 — Envio de mensagens | 1h | Endpoints + rate limit |
| 8 — Binding CRM | 1.5h | Schemas CRM + sidepanel |
| 9 — Robustez | 1-2h | Crons + audit + Sentry + MFA |
| 10 — Produção | 1h | Deploy Vercel + WAHA VPS + Nginx |

**Cronograma total da fundação WAHA: ~16h focado, 1 semana.** CRM-core (REST API + Kanban) e MCP server vêm em fases adicionais.
