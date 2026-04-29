# Architecture — DeskcommCRM

> Visão de 1 página. Profundidade vive em `docs/specs/` e `docs/stories/epics/MASTER.md`.

## Camadas

- **App (Next.js 15 App Router)**: UI + Route Handlers no mesmo repo. Server Components por default, Client onde precisa de estado.
- **DB (Supabase Postgres)**: RLS em toda tabela tenant-aware via `fn_user_org_ids()`. Migrations versionadas em `supabase/migrations/`.
- **Auth (Supabase Auth + `@supabase/ssr`)**: cookie SameSite=Strict, MFA TOTP forçado pra admin/super-admin. Sempre `getUser()` no server.
- **Realtime (Supabase Realtime)**: `postgres_changes` para inbox/kanban; `broadcast` para sinais leves.
- **Storage (Supabase Storage)**: bucket `whatsapp-media` privado, URLs assinadas.
- **WhatsApp (WAHA Plus / engine NOWEB)**: HMAC-SHA512 webhooks; throttle anti-banimento; STOP detection.
- **Filas (event sourcing leve)**: `event_log` table + workers via cron. Trigger Postgres NUNCA faz HTTP.
- **Rate limit (Upstash Redis)**: sliding window.
- **AI (Vercel AI Gateway)**: Anthropic primário, OpenAI backup pra embeddings.
- **Observability (Sentry)**: `beforeSend` scrubs PII (CPF/email/phone) e headers sensíveis.

## Multi-tenancy

`organization_id uuid not null` em toda tabela tenant-aware. RLS via helper. Service role bypassa RLS — handlers admin **DEVEM** filtrar `organization_id` manualmente, resolvido de fonte confiável (cookie/JWT/webhook secret/path token), nunca do body.

Detalhes: [`docs/specs/01-spec-platform-base.md`](docs/specs/01-spec-platform-base.md).

## API REST `/api/v1/`

- JSON snake_case. UUID v4. ISO-8601 UTC. Dinheiro `_cents` + `currency`.
- Wrappers `ok()` / `fail()` em `lib/api/wrappers.ts`.
- Auth dual: cookie session (frontend) ou `Authorization: Bearer tok_...` (server-to-server).
- `Idempotency-Key` para POSTs de criação. `X-Request-Id` em toda response.
- Detalhes: [`docs/specs/01-spec-platform-base.md`](docs/specs/01-spec-platform-base.md) §API.

## Event log + workers

Triggers Postgres emitem linhas em `event_log`. Workers (cron / Realtime listener) consomem e disparam side effects. Idempotência via `unique (organization_id, external_id)` + captura `code === '23505'`.

## Hardening

- Error boundaries em `app/error.tsx`, `app/app/error.tsx`, `app/(public)/error.tsx`, `app/global-error.tsx` (Sentry capture + eventId visível).
- Páginas customizadas 404/403/500/503 com copy PT-BR canônica.
- Loading skeletons em rotas P0.
- E2E Playwright + axe-core.
- Detalhes: [`docs/stories/epics/EPIC-12-hardening.md`](docs/stories/epics/EPIC-12-hardening.md).

## Onde olhar a fundo

- [`docs/prd/`](docs/prd/) — PRDs (visão, escopo MVP, KPIs, plataforma base, customer 360, WhatsApp, pipeline, IA-RAG, Nuvemshop).
- [`docs/specs/`](docs/specs/) — specs técnicas com schema SQL e payloads.
- [`docs/business-rules/`](docs/business-rules/) — regras de negócio fora do código.
- [`docs/stories/epics/MASTER.md`](docs/stories/epics/MASTER.md) — plano de execução por epic/wave.
- [`CLAUDE.md`](CLAUDE.md) — convenções não-negociáveis (multi-tenancy, idempotência, RBAC, LGPD, WAHA, anti-patterns).
