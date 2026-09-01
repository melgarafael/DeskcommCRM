# Frente A — Adaptação técnica (Docker + código) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar o SonghaiCRM rodável 100% via `docker compose up` num VPS HostGator, sem quebrar o deploy Vercel atual.

**Architecture:** Híbrido — compute no VPS (containers app+waha+redis+srh+scheduler+caddy), DB no Supabase Cloud. Mudanças de código mínimas e aditivas (atrás de config/flag); infra nova em arquivos novos.

**Tech Stack:** Next.js 15 (standalone), pnpm, Docker multi-stage (node:20-alpine), Caddy, Ofelia, serverless-redis-http, Supabase CLI/psql, WAHA Core.

## Global Constraints

- Node `>=20`; gerenciador de pacotes **pnpm** (há `pnpm-lock.yaml`); build **`pnpm build`** (turbopack). **Revisado na execução:** o plano original mandava `build:webpack` pelo plugin Sentry, mas foi medido **34min (webpack) vs ~4min (turbopack)** — inviável pro leigo. Turbopack pula o processamento de sourcemap do Sentry em build-time (irrelevante no self-host; Sentry runtime segue ativo via DSN hardcoded).
- Build do Next estoura o heap default do Node (~2GB) → `NODE_OPTIONS=--max-old-space-size=4096` no Dockerfile; **requer VPS ≥4GB RAM ou swap** (o `install.sh` checa).
- **Não** quebrar o deploy Vercel: toda mudança de código é aditiva/atrás de flag; `vercel.ts` e `.vercel/` permanecem.
- Segredos server-only **nunca** como build ARG (vazam nas camadas da imagem). Só `NEXT_PUBLIC_*` são build-time.
- `.env` do template com segredos gerados por `openssl rand`; template default: `NUVEMSHOP_ENABLED=false`, `INTERNAL_AGENT_RUN_STUB=false`.
- Só o Caddy publica portas (80/443). WAHA/redis/srh/app só na rede interna.
- Commits atômicos por tarefa, conventional commits, trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `next.config.ts` | Modify | `output: 'standalone'` + `images: { unoptimized: true }` |
| `lib/env.ts` | Modify | guarda de fase de build; Nuvemshop opcional + `NUVEMSHOP_ENABLED` |
| `app/onboarding/page.tsx` | Modify | skip do passo Nuvemshop quando flag off |
| `Dockerfile` | Create | build multi-stage → runner standalone |
| `.dockerignore` | Create | enxugar contexto de build |
| `docker-compose.prod.yml` | Create | 6 serviços + rede + volumes + healthchecks + log rotation |
| `Caddyfile` | Create | reverse proxy + HTTPS auto + timeout do runner de agente |
| `ofelia.ini` | Create | 4 jobs de cron (curl na rede interna) |
| `.env.hostgator.example` | Create | template de env comentado (build-time vs runtime vs gerado) |
| `supabase/baseline.sql` | Create | dump consolidado do schema real (public+storage+publication) |
| `scripts/bootstrap-owner.ts` | Create | cria 1º dono: user+org+membership+platform_admins |
| `package.json` | Modify | `db:migrate` aponta pro fluxo baseline (remove stub) |

---

## Task 1: Portabilidade de build (standalone + guarda de fase)

**Files:**
- Modify: `next.config.ts`
- Modify: `lib/env.ts` (bloco de `throw` no fim do módulo)

**Interfaces:**
- Produces: build `pnpm build:webpack` que completa **sem** segredos de runtime (só `NEXT_PUBLIC_*`), gerando `.next/standalone/server.js`.

- [ ] **Step 1:** Em `next.config.ts`, no objeto `nextConfig`, adicionar `output: 'standalone'` e `images: { unoptimized: true }` (preservando o resto e o `withSentryConfig`).

- [ ] **Step 2:** Em `lib/env.ts`, localizar o bloco que faz `throw` quando a validação Zod falha (≈ linhas 114-121). Envolver o `throw` com guarda de fase:

```ts
if (process.env.NEXT_PHASE !== 'phase-production-build') {
  throw new Error(`Variáveis de ambiente inválidas:\n${issues}`);
} else {
  console.warn(`[env] validação adiada na fase de build; segredos de runtime serão exigidos no boot.\n${issues}`);
}
```

- [ ] **Step 3 (verificação):** rodar o build só com as públicas e provar que completa:

```bash
env -i PATH="$PATH" HOME="$HOME" \
  NEXT_PUBLIC_SUPABASE_URL=https://x.supabase.co \
  NEXT_PUBLIC_SUPABASE_ANON_KEY=dummy \
  NEXT_PUBLIC_APP_URL=https://example.com \
  pnpm build:webpack
```
Expected: build conclui; existe `.next/standalone/server.js` e `.next/static/`.

- [ ] **Step 4 (commit):**
```bash
git add next.config.ts lib/env.ts
git commit -m "feat(hostgator): output standalone + guarda de fase de build no env"
```

---

## Task 2: Nuvemshop opcional (flag + auto-skip)

**Files:**
- Modify: `lib/env.ts` (as 4 vars `NUVEMSHOP_*` e nova `NUVEMSHOP_ENABLED`)
- Modify: `app/onboarding/page.tsx:17`

**Interfaces:**
- Consumes: `env` de `lib/env.ts`.
- Produces: `env.NUVEMSHOP_ENABLED: boolean` (default false); app sobe em produção com as 4 `NUVEMSHOP_*` vazias.

- [ ] **Step 1:** Em `lib/env.ts`, trocar as 4 declarações `NUVEMSHOP_OAUTH_ENCRYPTION_KEY`, `NUVEMSHOP_APP_ID`, `NUVEMSHOP_CLIENT_ID`, `NUVEMSHOP_CLIENT_SECRET` de `required(...)` para `z.string().optional().default("")`.

- [ ] **Step 2:** Adicionar (mesmo padrão de `EVENT_LOG_WORKER_ENABLED`):
```ts
NUVEMSHOP_ENABLED: z.enum(['true', 'false']).optional().default('false').transform((v) => v === 'true'),
```

- [ ] **Step 3:** Em `app/onboarding/page.tsx:17`, gatear o redirect:
```ts
if (env.NUVEMSHOP_ENABLED && !state.nuvemshop) redirect('/onboarding/connect-nuvemshop');
```

- [ ] **Step 4 (verificação):** `pnpm typecheck` passa; repetir o build da Task 1 (sem `NUVEMSHOP_*`) e confirmar que conclui.

- [ ] **Step 5 (commit):**
```bash
git add lib/env.ts app/onboarding/page.tsx
git commit -m "feat(hostgator): Nuvemshop opcional via NUVEMSHOP_ENABLED + auto-skip onboarding"
```

---

## Task 3: Dockerfile multi-stage

**Files:**
- Create: `Dockerfile`, `.dockerignore`

**Interfaces:**
- Consumes: `.next/standalone` (Task 1).
- Produces: imagem que roda `node server.js` em `:3000`, `HOSTNAME=0.0.0.0`, user non-root.

- [ ] **Step 1:** Criar `.dockerignore` com `node_modules`, `.next`, `.git`, `test-results`, `*.png`, `.env*`.

- [ ] **Step 2:** Criar `Dockerfile` (deps → build → runner). ARGs só `NEXT_PUBLIC_*`; runner copia `.next/standalone`, `.next/static`, `public`; `ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0`; `USER nextjs`; `CMD ["node","server.js"]`; build com `pnpm build:webpack` via `corepack`.

- [ ] **Step 3 (verificação):**
```bash
docker build --build-arg NEXT_PUBLIC_SUPABASE_URL=https://x.supabase.co \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=dummy \
  --build-arg NEXT_PUBLIC_APP_URL=https://example.com \
  -t deskcomm-app:test .
```
Expected: imagem builda. `docker run --rm -e SUPABASE_SERVICE_ROLE_KEY=... deskcomm-app:test` sobe e loga listen em `:3000` (pode falhar em deps externas, mas o processo inicia).

- [ ] **Step 4 (commit):** `git add Dockerfile .dockerignore && git commit -m "feat(hostgator): Dockerfile multi-stage standalone"`

---

## Task 4: `baseline.sql` do schema real

**Files:**
- Create: `supabase/baseline.sql`
- Modify: `package.json` (`db:migrate`)

**Interfaces:**
- Produces: SQL idempotente que num projeto Supabase novo cria as 38 tabelas + RLS + funções + buckets (`ai-policy`, `lgpd-exports`) + `publication supabase_realtime` (incl. `messages`, `conversations`, `crm_leads`) + `REPLICA IDENTITY FULL`.

- [ ] **Step 1:** Gerar o dump do projeto remoto `rrydmwnporysaiysiztn` (via `pg_dump` com a connection string do dashboard, schemas `public` + `storage`, `--no-owner --no-privileges`, incluindo extensions). Consolidar em `supabase/baseline.sql`.

- [ ] **Step 2:** Garantir no baseline: `alter publication supabase_realtime add table public.messages, public.conversations, public.crm_leads;` e `alter table ... replica identity full;` nessas 3 (+ conferir as de IA).

- [ ] **Step 3:** Em `package.json`, trocar o stub `db:migrate` por: `psql "$SUPABASE_DB_URL" -f supabase/baseline.sql && supabase db push`.

- [ ] **Step 4 (verificação):** aplicar num **projeto Supabase de teste** (branch/efêmero) e conferir 38 tabelas, os 2 buckets e a publication:
```sql
select count(*) from information_schema.tables where table_schema='public';           -- 38
select id from storage.buckets order by id;                                            -- ai-policy, lgpd-exports
select tablename from pg_publication_tables where pubname='supabase_realtime';         -- inclui messages/conversations/crm_leads
```

- [ ] **Step 5 (commit):** `git add supabase/baseline.sql package.json && git commit -m "feat(hostgator): baseline.sql consolidado + db:migrate real"`

---

## Task 5: Compose + Caddy + Ofelia + env template

**Files:**
- Create: `docker-compose.prod.yml`, `Caddyfile`, `ofelia.ini`, `.env.hostgator.example`

**Interfaces:**
- Consumes: imagem da Task 3; `INTERNAL_SECRET` para os crons.
- Produces: stack que sobe com `docker compose -f docker-compose.prod.yml up -d` e responde HTTPS.

- [ ] **Step 1:** `docker-compose.prod.yml` com serviços `app`, `waha`, `redis`, `srh`, `scheduler`, `caddy` numa rede interna; **só** `caddy` publica `80/443`; volumes `waha-data`,`waha-media`,`caddy-data`; `logging` json-file `max-size:10m max-file:3` em todos; healthcheck do `app` = probe TCP (`nc -z localhost 3000`), **não** `/api/v1/health` (evita que WAHA down derrube o app); `depends_on` com `condition: service_started` para srh/waha.

- [ ] **Step 2:** `Caddyfile`: `{$DOMAIN} { reverse_proxy app:3000 }` + bloco com `handle /api/internal/agents/run*` timeout ≥300s; HTTPS/redirect automáticos.

- [ ] **Step 3:** `ofelia.ini` com os 4 jobs `[job-run]` usando `curlimages/curl` na rede interna, header `Authorization: Bearer ${INTERNAL_SECRET}`: `agent-dispatcher @every 30s`, `storage-redaction?limit=50 @every 5m`, `lgpd-sla-watcher 0 0 12 * * *`, `kb-conversations-batch 0 30 3 * * *`; `TZ=UTC`.

- [ ] **Step 4:** `.env.hostgator.example` comentado em 3 blocos (build-time / runtime-externo / runtime-gerado), com `WAHA_API_BASE_URL=http://waha:3000`, `WAHA_WEBHOOK_BASE_URL=http://app:3000`, `UPSTASH_REDIS_REST_URL=http://srh:80`, `NUVEMSHOP_ENABLED=false`, `INTERNAL_AGENT_RUN_STUB=false`, e comandos `openssl rand` como comentário em cada segredo.

- [ ] **Step 5 (verificação):** `docker compose -f docker-compose.prod.yml --env-file .env.local config` valida sem erro; subir a stack com um `.env` real de teste e `curl -f https://<dom>/api/v1/health` (ou `http://localhost` se testar sem TLS) retornar 200.

- [ ] **Step 6 (commit):** `git add docker-compose.prod.yml Caddyfile ofelia.ini .env.hostgator.example && git commit -m "feat(hostgator): compose prod + Caddy + Ofelia + env template"`

---

## Task 6: Validação WAHA Core + API key (resolve incertezas da spec §17)

**Files:**
- Modify: `docker-compose.prod.yml` (imagem/engine WAHA conforme resultado), `.env.hostgator.example`

**Interfaces:**
- Produces: config WAHA confirmada empiricamente (imagem grátis, engine, formato da key).

- [ ] **Step 1:** Subir só o WAHA Core (`docker run` com a imagem grátis `devlikeapro/waha`) e confirmar engine suportada (NOWEB vs WEBJS) e limite de sessão.

- [ ] **Step 2:** Resolver a ambiguidade da key: testar `X-Api-Key` com **hash SHA512** e com **plaintext** contra `/api/sessions`; fixar o formato correto no `.env.hostgator.example` e no passo do `install.sh`.

- [ ] **Step 3:** Ajustar `docker-compose.prod.yml` (imagem `devlikeapro/waha`, `WAHA_DEFAULT_ENGINE` conforme resultado). Se o Core não pareia/limita demais, escalar a decisão ao Rafael (Plus opcional via `WAHA_IMAGE`).

- [ ] **Step 4 (verificação):** parear um número de teste via QR (`/api/<session>/auth/qr`) e enviar 1 mensagem via `/api/sendText`. Documentar o resultado no topo do compose.

- [ ] **Step 5 (commit):** `git add docker-compose.prod.yml .env.hostgator.example && git commit -m "fix(hostgator): valida WAHA Core (engine + formato da api key)"`

---

## Task 7: Bootstrap do 1º dono

**Files:**
- Create: `scripts/bootstrap-owner.ts`

**Interfaces:**
- Consumes: `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_DB_URL`.
- Produces: idempotente — cria `auth` user (email_confirm), `organizations`, `user_organizations` (admin), pipeline default, `platform_admins`.

- [ ] **Step 1:** Escrever `scripts/bootstrap-owner.ts` adaptando `scripts/seed-e2e-credentials.ts`: recebe `OWNER_EMAIL`/`OWNER_PASSWORD` do env; `admin.createUser({email, password, email_confirm:true})`; insere org + membership admin + pipeline default; `insert into platform_admins`. Idempotente (`on conflict do nothing` / checagem prévia).

- [ ] **Step 2 (verificação):** rodar contra o projeto de teste; confirmar login e 1 linha em `platform_admins`:
```bash
OWNER_EMAIL=dono@teste.com OWNER_PASSWORD='Snh!forte123' npx tsx scripts/bootstrap-owner.ts
```
Expected: usuário existe, org criada, `select count(*) from platform_admins` = 1; rodar 2x não duplica.

- [ ] **Step 3 (commit):** `git add scripts/bootstrap-owner.ts && git commit -m "feat(hostgator): bootstrap-owner (user+org+platform_admins idempotente)"`

---

## Self-Review

- **Cobertura da spec:** §5 (mudanças código)→T1/T2; §6 (baseline)→T4; §9 (bootstrap)→T7; §10 (Ofelia)→T5; §16 (healthcheck TCP)→T5; §17 (WAHA)→T6; Dockerfile→T3. Coberto.
- **Placeholders:** artefatos grandes (compose/Caddy/Dockerfile) descritos por responsabilidade + pontos exatos; conteúdo final se materializa na execução com verificação empírica (build/compose config/curl) — não há "TODO" solto.
- **Consistência:** `INTERNAL_SECRET` (crons), `SUPABASE_DB_URL` (baseline+bootstrap), `NUVEMSHOP_ENABLED` (T2) usados de forma consistente entre tarefas.

## Fora desta Frente (planos separados)

- **Frente B** (tutorial leigo) e **Frente C** (setup kit `.zip` + `install.sh`/`update.sh`/`restore.sh`/`reset-*.sh`) — planejadas após A entregar, para documentarem os comandos/arquivos reais.
