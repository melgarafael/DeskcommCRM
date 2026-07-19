# CLAUDE.md — DeskcommCRM

> Instruções pra futuras sessões Claude trabalhando neste repo. Leitura obrigatória antes de qualquer task de código.

---

## Visão (1 parágrafo)

DeskcommCRM é um CRM operacional multi-tenant para e-commerce com IA conversacional nativa. Unifica atendimento humano, chatbot RAG por tenant, gestão de pedidos e pós-venda — WhatsApp como canal primário (via WAHA). Modo atual = BPO (operadora atende N tenants); modo futuro = SaaS direto pra lojistas. Arquitetura multi-tenant com RLS desde o dia 1; LGPD nativa; MCP-ready.

---

## Stack canônica

- **Frontend:** Next.js 16 App Router (Turbopack) + React 19 + TypeScript 6 estrito + Tailwind + shadcn/ui (style: `new-york`, neutral)
- **Backend:** Next.js Route Handlers (mesmo repo); workers via `event_log` table + cron
- **DB:** Supabase (Postgres). RLS em toda tabela tenant-aware. Extensions: `uuid-ossp`, `pgcrypto`, `vector`
- **Auth:** Supabase Auth via `@supabase/ssr`. Cookie SameSite=Strict, HttpOnly, Secure
- **Realtime:** Supabase Realtime (postgres_changes + broadcast)
- **Storage:** Supabase Storage (bucket `whatsapp-media` privado, URLs assinadas)
- **WhatsApp:** WAHA Plus, engine NOWEB
- **Filas/eventos:** `event_log` table + workers (não usar Inngest/Trigger no MVP)
- **Rate limit:** Upstash Redis sliding window
- **AI:** Vercel AI Gateway (Anthropic primário; OpenAI backup pra embeddings); strings tipo `"anthropic/claude-sonnet-4-6"`
- **Validação:** Zod em todo input externo (request body, webhook payload, env)
- **Observability:** Sentry com `beforeSend` sanitizado

---

## Convenções críticas (NÃO NEGOCIÁVEIS)

### Multi-tenancy
- `organization_id uuid not null references organizations(id) on delete cascade` em **toda** tabela tenant-aware
- RLS policy `tenant_isolation_<tabela>_all` aplicada via helper `fn_user_org_ids()`
- Service role bypassa RLS — handlers que usam admin client **DEVEM** filtrar `organization_id` manualmente, resolvido de fonte confiável (cookie/JWT/webhook secret/path token), **NUNCA do body**
- Toda query que cruza tabelas tenant-aware filtra `organization_id` explicitamente
- Teste de isolamento (cria 2 tenants, verifica não-vazamento) é obrigatório no CI antes de merge

### Idempotência & event sourcing leve
- Mensagens WhatsApp e eventos externos: `unique (organization_id, external_id)` + captura `code === '23505'` no INSERT
- POSTs de criação na API aceitam header `Idempotency-Key: <uuid>` (TTL 24h via Upstash)
- **Trigger Postgres NUNCA faz HTTP.** Trigger emite linha em `event_log`; worker (cron / Realtime listener) consome e dispara side effect

### API REST `/api/v1/`
- Versionamento por path. JSON snake_case. UUID v4. ISO-8601 UTC. Dinheiro em `_cents` + `currency` ISO-4217
- Wrapper sucesso: `{ data, meta?: { cursor, has_more, total } }`
- Wrapper erro: `{ error: { code, message, details? } }` — usar helpers `ok()` / `fail()` de `lib/api/wrappers.ts`
- Paginação: cursor opaco base64+HMAC por default
- Auth dual: cookie session (frontend) OU `Authorization: Bearer tok_...` (server-to-server)
- **API key NUNCA em query string** (vaza em logs Vercel/CF). Sempre header
- Plaintext de bearer token mostrado **uma vez** na criação; depois apenas hash SHA256 no DB
- Rate limit headers: `X-RateLimit-*` + `Retry-After` em 429
- `X-Request-Id` em toda response (correlaciona com audit log)

### Auth & RBAC
- Sempre `getUser()` (valida JWT no backend). NUNCA `getSession()` (confia no cookie local)
- 4 roles dentro do tenant: `viewer` (1) < `agent` (2) < `manager` (3) < `admin` (4)
- Super-admin de plataforma é uma role transversal — `is_platform_admin` (decisão final na Spec 01)
- MFA TOTP **forçado** pra `admin` e super-admin
- Permissão por pipeline (`user_pipeline_access`) **NÃO** entra no MVP

### Audit log
- Toda mutação POST/PATCH/DELETE bem-sucedida → 1 entrada em `api_audit_log` (fire-and-forget, p99 ≤500ms)
- Audit é append-only. Sem RLS de UPDATE/DELETE. Edição apenas via DBA manual
- Retenção 5 anos. Hot 90 dias, cold (S3) o resto
- Falha de write em audit gera alerta Sentry, não bloqueia mutação principal

### LGPD
- Anonimização preferida sobre delete. Nome do contato vira `Cliente Anonimizado #N`
- Cascade de redact: contact + conversations + messages (mídia removida do storage) + activities (preserva timestamps)
- Reversão de anonimização: 403 `lgpd_anonymization_irreversible`
- SLA: data_request entregue D+7; redact executado D+15
- Action audit obrigatória: `lgpd.data_request_received`, `lgpd.export_generated`, `lgpd.redact_executed`, `lgpd.consent_changed`

### WAHA
- Plus obrigatório (Core não suporta multi-tenant, sem retry, sem S3)
- Engine NOWEB default; WEBJS apenas se precisar stickers animados / botões
- Auth: env do WAHA recebe **hash SHA512 hex** da api key; cliente envia plaintext em `X-Api-Key`
- Webhooks: HMAC SHA512 com `crypto.timingSafeEqual`
- Anti-banimento: throttle 1 msg/1.2s + jitter ≤800ms. Campanha 1 msg/5s. Warm-up 7-14d. Spinning de copy. Janela 7h-22h, evitar domingo
- STOP detection: regex `/STOP|PARAR|SAIR|UNSUBSCRIBE/i` no inbound → `is_blocked=true` automaticamente
- Mídia: subir pro Supabase Storage primeiro, passar URL ao WAHA (não inline base64)
- Multi-device: assinar `message.any` (não só `message`); tratar `fromMe=true` sem duplicar
- Grupos: SKIP CRM binding se `chatId.endsWith('@g.us')`. Sender é `p.author`, não `p.from`
- Cron `recover-stuck-messages`: marca `status='sending'` há >5min como `failed`

### Doutrina DIRC (antes de adicionar campo)
- **D**uplicar — vive aqui mesmo?
- **I**ntegrar — vem de outra tabela via FK?
- **R**eferenciar — só ponteiro?
- **C**alcular — pode ser computado on-demand?

### Modelagem
- 5 tabelas core CRM: `crm_pipelines`, `crm_stages`, `crm_leads`, `crm_lead_activities` (polimórfica timeline), `crm_lead_links` (polimórficos vínculos)
- `position_in_stage numeric` (fractional indexing via `midpoint()`) — **NUNCA `int`**
- `external_id` nullable (mensagem outbound `sending` ainda não tem ID WAHA)
- `type` é `text` + `check constraint`, **não enum** (enum é difícil de estender)
- `tags text[]` + GIN index; promove pra coluna gerada apenas quando vira hot path
- `custom_fields jsonb` com schema declarativo em `pipeline.settings.fields`; Zod construído dinamicamente
- `vocabulary jsonb` em pipeline permite renomear lead/deal/won/lost (e-commerce: lead=Cliente, deal=Pedido, won=Pago, lost=Cancelado)

---

## Anti-patterns proibidos

1. String que deveria ser FK (ex: `owner_email text` em vez de `owner_user_id uuid`)
2. Duplicação sem source of truth declarado
3. Evento sem consumer (emite e ninguém escuta)
4. FK ausente que vira inferência por nome
5. Campo sincronizado por cron quando devia ser realtime/trigger
6. `jsonb` lock-in (UI lê path direto sem schema central)
7. Cascade fantasma (deletar contact cascade em messages perde histórico)
8. Polimórfico sem padronização (`target_kind` cada lugar grava diferente)
9. **Trigger Postgres faz HTTP** (letal — espera rede dentro da transação)
10. Service role usado em request handler sem filtrar `organization_id` manualmente
11. `getSession()` no backend
12. API key em query string
13. Bearer plaintext armazenado no DB (deve ser hash SHA256)
14. `console.log` deixado em código merged (use logger estruturado ou Sentry breadcrumb)

---

## Paths importantes

| Path | Conteúdo |
|---|---|
| `docs/prd/00-prd-master.md` | Visão geral, escopo MVP, KPIs |
| `docs/prd/01-prd-platform-base.md` | Auth, tenancy, RBAC, LGPD framework |
| `docs/prd/02-...06-` | Customer 360, WhatsApp, Pipeline, IA-RAG, Nuvemshop |
| `docs/specs/` | Specs técnicas detalhadas (schema SQL, payloads exatos) |
| `docs/business-rules/` | Regras de negócio fora do código |
| `docs/research/reference-synthesis.md` | Arquitetura herdada do curso WAHA |
| `tasks/todo.md` | Workflow de construção atual |
| `lib/api/wrappers.ts` | `ok()`, `fail()`, tipos `ApiSuccess<T>` / `ApiError` |
| `lib/api/errors.ts` | Códigos de erro canônicos |
| `lib/env.ts` | Validação Zod das env vars (lança no startup se faltar crítica) |
| `lib/supabase/{browser,server,admin}.ts` | Clients canônicos |
| `app/api/v1/health/route.ts` | Health check (Supabase + Redis + WAHA) |
| `supabase/migrations/` | Schema versionado |

---

## Como rodar local

```bash
nvm use                    # node 20
npm install
cp .env.example .env.local  # preencher
docker compose up -d        # WAHA local
npm run dev                 # http://localhost:3000
```

Ver `README.md` pra detalhes de setup.

---

## Testes

```bash
npm run typecheck   # tsc --noEmit (estrito)
npm run lint        # eslint next/core-web-vitals
npm run test:unit   # Vitest
npm run test:e2e    # Playwright
```

CI deve rodar todos antes de merge. Teste de isolamento RLS é gate obrigatório.

---

## Migrations & Banco — DOUTRINA (projeto open-source)

**Este projeto é open-source. Toda mudança de schema DEVE sair como migration versionada** — quem clonou uma versão antiga do banco precisa conseguir atualizar aplicando as migrations em ordem. **Nunca** aplique `ALTER`/`CREATE` solto no banco sem o arquivo correspondente. Isto é critério de aceite de TODA sessão, não opcional.

Processo padrão (siga sempre):

1. **Arquivo versionado** em `supabase/migrations/` com o padrão do repo: `<timestamp>_<NNNN>_<slug>.sql` (ex.: `20260706210000_0027_whatsapp_conversation_unification.sql`). `NNNN` é o próximo número sequencial (veja o último em `ls supabase/migrations/`).
2. **Idempotente sempre que possível**: `add column if not exists`, `create ... if not exists`, `create or replace function`. Uma migration deve poder ser re-aplicada sem quebrar nem duplicar efeito.
3. **Portável em `psql` puro** (clones podem não usar o MCP/CLI Supabase): **sem** `create temporary table ... on commit drop` fora de transação explícita; **sem** `BEGIN`/`COMMIT` explícito (o runner já envolve em transação, como as demais migrations). Prefira CTEs, subqueries de janela e colunas-mapa (ex.: `is_merged_into`) a temp tables.
4. **Data migrations genéricas**: se a migration corrige/deduplica dados, escreva pensando em QUALQUER banco de clone (não hardcode IDs do seu tenant). Repointe FKs conferindo o catálogo (`information_schema` FK map) para não perder histórico.
5. **Registre no MANIFEST**: adicione uma linha em `supabase/migrations/MANIFEST.md` (tabela "Applied") descrevendo versão, nome e o QUÊ/PORQUÊ.
6. **Reflita no `supabase/baseline.sql` (OBRIGATÓRIO — é o que o kit self-host aplica).** O baseline é um dump `--schema-only` + um **apêndice idempotente** no fim do arquivo (blocos rotulados `-- ---- <coisa> (migration NNNN) ----`). O kit HostGator aplica **só o baseline.sql**, tanto no `install.sh` (banco novo, `ON_ERROR_STOP=1`) quanto no `update.sh` (re-aplica em banco existente, **sem** `ON_ERROR_STOP`). Então toda mudança de schema pós-snapshot DEVE ser acrescentada ao apêndice, **idempotente e auto-curativa**: `add column if not exists`, `create ... if not exists`, `create or replace function`, e — se a mudança adiciona constraint — **deduplicar/corrigir os dados ANTES** de criar a constraint (senão o `update.sh` de um clone bugado quebra). Sem isto, clones não recebem a mudança (ou quebram ao atualizar). Migração adicionada só em `migrations/` mas não no baseline **não chega aos self-hosters**.
7. **Aplique e prove**: aplique via `mcp__plugin_supabase_supabase__apply_migration` (ou `supabase db push`), capture o estado ANTES/DEPOIS e prove invariantes (ex.: contagem de linhas que não pode mudar). Se mexeu em contrato, regenere `lib/database.types.ts`. Para mudanças de schema no kit, valide o baseline num Postgres descartável (`pgvector/pgvector:pg17` + extensões) aplicando `install` (fresh, `ON_ERROR_STOP=1`) e `update` (re-aplicar, sem a flag) — ambos têm que passar.
8. **Backfill de dados quebrados existentes**: constraint nova falha se os dados atuais a violam — a migration (e o apêndice do baseline) deve deduplicar/corrigir ANTES de criar a constraint.

**Resumo do fluxo de uma mudança de schema:** arquivo em `migrations/` (fonte da verdade p/ Supabase CLI) **+** apêndice idempotente no `baseline.sql` (p/ o kit self-host) **+** linha no MANIFEST. Os dois artefatos de schema andam juntos. Nunca edite migrations já aplicadas — corrija com uma "forward-fix" nova (e mais um apêndice no baseline).

---

## Skills relevantes a usar (Claude Code)

- `superpowers:brainstorming` — antes de implementar feature não-trivial
- `superpowers:writing-plans` — pra task com mais de 1 etapa de DB/API
- `superpowers:test-driven-development` — feature crítica (LGPD, RLS, anti-banimento)
- `superpowers:systematic-debugging` — bugs reportados
- `superpowers:verification-before-completion` — antes de declarar "pronto"
- `tomik-db-doctrine` — referência cruzada de doutrina de schema
- `supabase:supabase` — qualquer task com Supabase
- `vercel:nextjs` — App Router, Server Components, edge runtime
- `vercel:ai-gateway` — config de fallback de provider
- `frontend-design` — UI distinta (não cair em shadcn-default genérico)

---

## Definition of Done

Antes de declarar uma task pronta:

1. `npm run typecheck` passa zerado
2. `npm run lint` zerado
3. Testes unit/e2e relevantes existem e passam
4. RLS testada se feature toca tabela tenant-aware
5. Audit log emitido se há mutação relevante
6. Rate limit aplicado se rota é pública
7. Zod valida todo input externo
8. Sem `console.log` esquecido
9. Env vars novas adicionadas em `.env.example` + `lib/env.ts`
10. Doc atualizada se mudou contrato (PRD/spec)
11. **Mudança de schema saiu como migration versionada + linha no MANIFEST** (ver Doutrina de Migrations) — clones conseguem atualizar

Um staff engineer aprovaria? Se não, itera.
