# Sistema de Follow-up Inteligente — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **PROTOCOLO DO RAFAEL (inegociável):** cada onda termina com PROVA VISÍVEL (output de teste real, curl real, screenshot Playwright) + atualização e commit do `HANDOFF.md`. Nenhuma onda avança sem os critérios de aceite da anterior provados. Medidas de front por ferramenta, nunca a olho.

**Goal:** Motor único de follow-up (grafo versionado + enrollment + relógio único) com builder visual React Flow, fila UI e seletor no agente — spec em `docs/superpowers/specs/2026-07-21-followup-system-design.md`.

**Architecture:** 4 tabelas novas no padrão `*_versions`/`*_pointers` do harness; worker step-per-tick com `FOR UPDATE SKIP LOCKED` em cron route; nós de IA delegam a `job_queue` (`followup_turn`); envio 100% pelo pipeline anti-ban existente.

**Tech Stack:** Next.js 16 App Router, TS estrito, Supabase/Postgres + RLS, Zod, Vitest (+ vitest.db p/ testes com Postgres real), Playwright, `@xyflow/react` (dep nova, só no builder).

## Global Constraints

- Toda mudança de schema: migration `supabase/migrations/20260721TTTTTT_00NN_<slug>.sql` (próximo NNNN: **0054**) + apêndice idempotente no `supabase/baseline.sql` + linha no `MANIFEST.md`.
- `organization_id` + RLS `tenant_isolation_<tabela>_all` via `fn_user_org_ids()` em toda tabela nova; workers com admin client filtram org manualmente.
- API: wrappers `ok()`/`fail()` de `lib/api/wrappers.ts` (**sem** double-nest `ok({data:...})`), Zod em todo input, audit em toda mutação, `X-Request-Id`.
- Cron route: auth Bearer `INTERNAL_CRON_SECRET|INTERNAL_SECRET` fail-closed (padrão de `app/api/v1/cron/routing-worker/route.ts`).
- Sem `console.log`; sem enum Postgres (text + CHECK); dinheiro N/A; timestamps ISO-8601 UTC; tz IANA explícita em toda espera.
- PII nunca em `last_error`/logs.
- Design system Sage (tokens em `app/design/lib/`), nada de shadcn cru.
- Commits atômicos por task: `feat(followup): <slug> [onda N]`.

## Ambiente de execução

- Worktree: `.claude/worktrees/followup`, branch `feat/followup-flows` (base `feat/operacao-visivel` — contém spec+mineração). Copiar `.env.local` e `.e2e-creds.json` do checkout principal.
- Testes DB-reais: `vitest.db.config.ts` roda contra Postgres 17 efêmero do `baseline.sql` (`npm run test:invariants`) — usar para SKIP LOCKED/RLS/durabilidade.
- E2E: `npm run test:e2e` (Playwright, `tests/e2e/`, helpers em `tests/e2e/utils`, creds de `scripts/seed-e2e-credentials.ts`).
- Ledger de progresso: `.superpowers/sdd/progress.md` + **`HANDOFF.md` na raiz** (commit a cada atualização).

---

## Onda 0 — Setup (sem código de produto)

### Task 0.1: Worktree + branch + HANDOFF

**Files:** Create: `HANDOFF.md` (raiz, novo conteúdo); Move: `HANDOFF.md` atual → `docs/superpowers/handoffs/2026-07-17-webhooks.md`.

- [ ] `git mv HANDOFF.md docs/superpowers/handoffs/2026-07-17-webhooks.md` no branch atual; commit `chore: arquiva handoff de webhooks`.
- [ ] `git worktree add .claude/worktrees/followup -b feat/followup-flows` (base HEAD atual).
- [ ] Copiar `.env.local` e `.e2e-creds.json` para o worktree.
- [ ] Escrever `HANDOFF.md` novo (template na Onda 0 do HANDOFF — já criado junto deste plano) e commitar.
- [ ] **Prova:** `git worktree list` mostra o worktree; `cat HANDOFF.md | head -5` no worktree.

### Task 0.2: Dependência do canvas

- [ ] `npm install @xyflow/react` no worktree (checar versão instalada e registrar no HANDOFF).
- [ ] `npm run typecheck` limpo. Commit `chore(followup): add @xyflow/react`.

---

## Onda 1 — Schema (migration 0054) + RLS

**Critérios de aceite da onda:** (1) as 4 tabelas existem no Postgres efêmero construído do baseline (install fresh E update re-aplicado); (2) teste de isolamento 2-tenants passa nas 4 tabelas; (3) unique parcial impede 2º enrollment vivo do mesmo lead/fluxo; (4) unique `(enrollment_id, idempotency_key)` impede evento duplicado. Prova: output do `npm run test:invariants` + psql `\dt`.

### Task 1.1: Migration 0054

**Files:** Create: `supabase/migrations/20260721120000_0054_followup_flows.sql`; Modify: `supabase/baseline.sql` (apêndice), `supabase/migrations/MANIFEST.md`.

Conteúdo integral da migration (idempotente, psql puro, sem BEGIN/COMMIT):

```sql
-- 0054 — Sistema de follow-up: fluxos versionados + enrollments (spec 2026-07-21)

create table if not exists followup_flow_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  graph jsonb not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists followup_flow_pointers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  status text not null default 'draft' check (status in ('draft','active','disabled')),
  active_version_id uuid references followup_flow_versions(id),
  draft_graph jsonb,
  handoff_policy text not null default 'pause' check (handoff_policy in ('pause','cancel','allow')),
  trigger_config jsonb not null default '{"kind":"manual"}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

create table if not exists followup_enrollments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  pointer_id uuid not null references followup_flow_pointers(id) on delete cascade,
  version_id uuid not null references followup_flow_versions(id),
  contact_id uuid not null references contacts(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  current_node_id text not null,
  status text not null default 'active'
    check (status in ('active','waiting_reply','paused_handoff','completed','cancelled','dead')),
  next_eval_at timestamptz,
  claimed_until timestamptz,
  attempts smallint not null default 0,
  max_attempts smallint not null default 5,
  last_error text,
  steps_taken smallint not null default 0,
  outcome text check (outcome in ('converted','replied','exhausted','opted_out','handoff')),
  cancel_reason text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  -- estados com relógio TÊM next_eval_at; pausados/terminais NÃO — coerência no schema
  check (
    (status in ('active','waiting_reply') and next_eval_at is not null)
    or (status in ('paused_handoff','completed','cancelled','dead'))
  )
);

create index if not exists idx_followup_enrollments_due
  on followup_enrollments (next_eval_at)
  where status in ('active','waiting_reply');

create unique index if not exists idx_followup_enrollments_one_live
  on followup_enrollments (pointer_id, contact_id)
  where status in ('active','waiting_reply','paused_handoff');

create index if not exists idx_followup_enrollments_contact
  on followup_enrollments (organization_id, contact_id);

create table if not exists followup_enrollment_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  enrollment_id uuid not null references followup_enrollments(id) on delete cascade,
  node_id text,
  event_type text not null,
  payload jsonb not null default '{}',
  idempotency_key text,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_followup_events_idem
  on followup_enrollment_events (enrollment_id, idempotency_key)
  where idempotency_key is not null;

-- RLS (padrão fn_user_org_ids)
alter table followup_flow_versions enable row level security;
alter table followup_flow_pointers enable row level security;
alter table followup_enrollments enable row level security;
alter table followup_enrollment_events enable row level security;

do $$ begin
  create policy tenant_isolation_followup_flow_versions_all on followup_flow_versions
    for all using (organization_id in (select fn_user_org_ids()))
    with check (organization_id in (select fn_user_org_ids()));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy tenant_isolation_followup_flow_pointers_all on followup_flow_pointers
    for all using (organization_id in (select fn_user_org_ids()))
    with check (organization_id in (select fn_user_org_ids()));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy tenant_isolation_followup_enrollments_all on followup_enrollments
    for all using (organization_id in (select fn_user_org_ids()))
    with check (organization_id in (select fn_user_org_ids()));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy tenant_isolation_followup_enrollment_events_all on followup_enrollment_events
    for all using (organization_id in (select fn_user_org_ids()))
    with check (organization_id in (select fn_user_org_ids()));
exception when duplicate_object then null; end $$;

-- Claim atômico do worker (SKIP LOCKED) — service role only
create or replace function fn_claim_due_followup_enrollments(p_limit int, p_lease_seconds int)
returns setof followup_enrollments
language sql
security definer
set search_path = public
as $$
  update followup_enrollments e
  set claimed_until = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  where e.id in (
    select id from followup_enrollments
    where status in ('active','waiting_reply')
      and next_eval_at <= now()
      and (claimed_until is null or claimed_until < now())
    order by next_eval_at
    limit p_limit
    for update skip locked
  )
  returning e.*;
$$;
revoke all on function fn_claim_due_followup_enrollments(int, int) from public, anon, authenticated;
```

- [ ] Escrever o arquivo acima; adicionar o MESMO conteúdo como apêndice `-- ---- followup flows (migration 0054) ----` no fim de `supabase/baseline.sql`; linha no MANIFEST.
- [ ] Aplicar no banco dev (`supabase db push` ou MCP `apply_migration`); regenerar `lib/database.types.ts`.
- [ ] **Prova:** psql efêmero — `docker run` pgvector:pg17, aplicar baseline com `ON_ERROR_STOP=1` (fresh) e reaplicar sem a flag (update); `\dt followup*` lista as 4 tabelas nas duas execuções.
- [ ] Commit `feat(followup): migration 0054 — flow versions/pointers/enrollments/events [onda 1]`.

### Task 1.2: Testes de invariante DB (RLS + uniques + claim)

**Files:** Create: `tests/db/followup-schema.test.ts` (padrão dos testes `vitest.db` existentes — ver `tests/db/` para setup helper).

Casos (todos rodando no Postgres efêmero):
- [ ] `rls: org A não lê pointers/enrollments/events/versions da org B` (2 tenants seedados, client com JWT de A consulta, espera 0 rows).
- [ ] `unique: segundo enrollment vivo do mesmo (pointer, contact) → 23505`; após `status='completed'` do 1º, o 2º insere ok.
- [ ] `unique: evento com mesmo (enrollment_id, idempotency_key) → 23505`.
- [ ] `check: enrollment active sem next_eval_at → 23514`.
- [ ] `claim: fn_claim_due_followup_enrollments com 2 conexões concorrentes não retorna o mesmo id nas duas` (seed 5 due, cada conexão pede limit 5, união = 5 sem interseção).
- [ ] **Prova:** `npm run test:invariants -- followup-schema` verde; colar output no HANDOFF.
- [ ] Commit.

---

## Onda 2 — Grafo: schema Zod + validador de publish (lib pura, TDD)

**Critérios de aceite:** validador aceita fixture válida com os 6 nós e rejeita, com erro ancorado por nó, cada uma das violações: sem trigger, nó inalcançável, caminho sem end, classe sem aresta, classify sem `no_reply`/`always`, grace < 15min, ação ai_message pós-24h sem fallback, ciclo sem wait ≥ 5min, wait fora de [5min, 90d]. Prova: `npm run test:unit -- flow-graph` verde com os ~12 casos.

### Task 2.1: Tipos + Zod do grafo

**Files:** Create: `lib/followup/graph-schema.ts`; Test: `lib/followup/graph-schema.test.ts`.

**Produces (contrato para todas as ondas seguintes):**

```ts
export const NODE_TYPES = ['trigger','wait','condition','ai_classify','action','end'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const waitConfigSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('fixed'), duration_ms: z.number().int().min(300_000).max(7_776_000_000) }),
  z.strictObject({ mode: z.literal('smart'), min_ms: z.number().int().min(300_000), max_ms: z.number().int().max(7_776_000_000), guidance: z.string().max(500).optional() }).refine(c => c.min_ms <= c.max_ms),
]);
export const aiClassifyConfigSchema = z.strictObject({
  classes: z.array(z.string().min(1).max(40)).min(1).max(8),
  grace_timeout_ms: z.number().int().min(900_000),
  target: z.enum(['last_reply','summary']).default('last_reply'),
  hint: z.string().max(500).optional(),
});
export const actionConfigSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('ai_message'), prompt_hint: z.string().min(1).max(1000), fallback_template_id: z.string().uuid().optional() }),
  z.strictObject({ mode: z.literal('template'), template_id: z.string().uuid() }),
]);
export const conditionConfigSchema = z.strictObject({
  combinator: z.enum(['and','or']).default('and'),
  checks: z.array(z.strictObject({ field: z.enum(['lead_stage','tag','steps_taken','last_outcome']), op: z.enum(['eq','neq','gte','lte','contains']), value: z.union([z.string(), z.number()]) })).min(1).max(10),
});
export const endConfigSchema = z.strictObject({ outcome: z.enum(['converted','exhausted','custom']), note: z.string().max(200).optional() });

export const flowNodeSchema = /* discriminatedUnion por type com {id, type, label, position:{x,y}, config} */;
export const flowEdgeSchema = z.strictObject({
  id: z.string(), source: z.string(), target: z.string(), priority: z.number().int().default(0),
  condition: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('always') }),
    z.strictObject({ type: z.literal('class_match'), value: z.string() }),   // inclui 'no_reply'
    z.strictObject({ type: z.literal('cond_result'), value: z.boolean() }),
  ]),
});
export const flowGraphSchema = z.strictObject({ nodes: z.array(flowNodeSchema).min(2).max(60), edges: z.array(flowEdgeSchema).max(120) });
export type FlowGraph = z.infer<typeof flowGraphSchema>;
```

- [ ] TDD: teste de cada config inválida (extra key → rejeita por strict; duration < 5min; classes vazias; grace < 15min) → implementar → verde → commit.

### Task 2.2: Validador estrutural de publish

**Files:** Create: `lib/followup/validate-publish.ts`; Test: `lib/followup/validate-publish.test.ts`.

**Produces:** `validateFlowForPublish(graph: FlowGraph): { ok: true } | { ok: false; errors: { node_id: string | null; code: string; message: string }[] }` com codes: `no_trigger|multiple_triggers|unreachable_node|no_end_path|missing_class_edge|missing_no_reply_edge|missing_always_fallback|grace_too_short|long_wait_needs_template|cycle_without_wait|max_steps_exceeded`.

Regras (da spec §6): BFS de alcançabilidade a partir do trigger; DFS de caminho até end; soma de `max` das esperas no caminho até cada `action` `ai_message` (≥24h ⇒ exige `fallback_template_id`; ciclos contam 1 iteração); detecção de ciclo sem `wait ≥ 5min`.

- [ ] TDD por regra (1 fixture mínima por code, +1 fixture válida completa com os 6 nós) → implementar → verde → commit.

---

## Onda 3 — API de fluxos (CRUD + publish/disable/rollback)

**Critérios de aceite (curl, org de teste):** `POST /followup-flows` cria draft → `PATCH` salva `draft_graph` → `POST :id/publish` de grafo inválido retorna **422 com erros por nó** → publish de grafo válido retorna 200, cria versão, pointer `active` → `POST :id/rollback` volta versão → `POST :id/disable` desativa. Toda mutação gera linha em `api_audit_log`. Prova: transcript curl + `select action from api_audit_log order by created_at desc limit 6`.

### Task 3.1: Rotas

**Files:** Create: `app/api/v1/ai/followup-flows/route.ts` (GET lista/POST cria), `app/api/v1/ai/followup-flows/[id]/route.ts` (GET/PATCH), `app/api/v1/ai/followup-flows/[id]/publish/route.ts`, `.../disable/route.ts`, `.../rollback/route.ts`; Test: `tests/api/followup-flows.test.ts` (padrão dos testes de rota existentes).

**Interfaces:** Consome `validateFlowForPublish` (Task 2.2), `requireAuth` de `lib/auth/server.ts` (manager+ p/ mutação), `ok/fail`, `audit`. Publish: transação — insert em `followup_flow_versions` com `draft_graph` validado + update do pointer (`active_version_id`, `status='active'`).

- [ ] TDD rota a rota (draft CRUD → publish inválido 422 → publish válido → rollback → disable) → verde → commit por rota ou por par coeso.
- [ ] **Prova visível:** sequência curl real contra `npm run dev` local colada no HANDOFF.

---

## Onda 4 — Motor: worker + nós determinísticos (wait fixed / condition / end)

**Critérios de aceite:** com um fluxo publicado `trigger → wait(fixed 5min) → condition → end`, um enrollment seedado com `next_eval_at=now()` avança 1 nó por tick: tick 1 processa trigger→wait (agenda `next_eval_at=+5min`); manipulando o relógio (update SQL do `next_eval_at`), tick 2 avalia condition e roteia à aresta correta; tick 3 completa com outcome. Cada transição vira evento em `followup_enrollment_events`. **Durabilidade:** enrollment com wait de 30 dias: reiniciar o processo (novo `npm run dev`) não perde nada; vencido dispara 1× (sem burst). **Falha:** nó que lança erro → backoff `[30s,1m,5m,15m,1h]` por `attempts`; 6ª falha → `status='dead'` + item em `agent_inbox_items` kind `followup_dead`. Prova: outputs vitest.db + transcript curl do tick + selects de eventos.

### Task 4.1: Engine core

**Files:** Create: `lib/followup/engine.ts`, `lib/followup/node-handlers.ts`; Test: `lib/followup/engine.test.ts` (unit, handlers puros) + `tests/db/followup-engine.test.ts` (tick contra Postgres efêmero).

**Produces:**

```ts
// engine.ts
export interface TickDeps { db: AdminClient; clock: () => Date; enqueueJob: (job: FollowupJobRequest) => Promise<void>; }
export interface TickSummary { claimed: number; advanced: number; scheduled: number; failed: number; dead: number; }
export async function runFollowupTick(deps: TickDeps, opts?: { limit?: number }): Promise<TickSummary>;

// node-handlers.ts — puros, testáveis sem DB
export type NodeResult =
  | { kind: 'advance'; next_node_id: string; next_eval_at: Date }
  | { kind: 'wait'; next_eval_at: Date }                       // permanece no nó
  | { kind: 'enqueue_turn'; purpose: 'send_message'|'classify'|'decide_timing'; wake_status: 'active'|'waiting_reply' }
  | { kind: 'complete'; outcome: EnrollmentOutcome }
  | { kind: 'fail'; error: string };
export function processNode(input: { node: FlowNode; edges: FlowEdge[]; enrollment: EnrollmentRow; lead: LeadFacts; clock: () => Date }): NodeResult;
export const BACKOFF_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000] as const;
export function selectEdge(edges: FlowEdge[], from: string, match: EdgeMatch): FlowEdge | null; // priority desc, always como fallback
```

Semântica do tick: claim via `fn_claim_due_followup_enrollments(limit, lease=120s)` → para cada row: carrega graph pinado (`version_id`), fatos do lead, `processNode`; persiste transição + evento (`idempotency_key = `${node_id}:${steps_taken}``) na mesma transação; `steps_taken+1`; `steps_taken > 30` ⇒ fail definitivo `max_steps`. Erro → `attempts+1`, `next_eval_at = now + BACKOFF_MS[attempts-1]`; `attempts > max_attempts` ⇒ `dead` + inbox item.

- [ ] TDD handlers puros (wait fixed agenda; condition avalia cada op; end completa; selectEdge por priority/fallback) → verde.
- [ ] TDD tick DB-real (avanço 1 nó/tick; evento idempotente; backoff; dead+inbox) → verde.
- [ ] Commit por par teste+impl.

### Task 4.2: Cron route + enrollment por gatilho manual

**Files:** Create: `app/api/v1/cron/followup-flow-worker/route.ts` (clone do padrão routing-worker, chama `runFollowupTick`), `app/api/v1/ai/followups/enrollments/route.ts` (POST cria enrollment manual: valida pointer ativo, contato, respeita unique; GET N/A aqui).

- [ ] Implementar + teste de auth fail-closed (sem secret → 403) + smoke do tick via curl.
- [ ] **Prova visível:** transcript curl do cenário completo dos critérios de aceite (criar fluxo → publicar → enrollar → 3 ticks com relógio manipulado → eventos) no HANDOFF.
- [ ] Commit.

---

## Onda 5 — Nós de IA (action / ai_classify / wait smart) via job_queue

**Critérios de aceite:** (1) enrollment em nó `action ai_message` enfileira `followup_turn` com payload `{followup_enrollment_id, node_id, purpose:'send_message', prompt_hint}` e fica aguardando; conclusão do turno (simulada em teste com o handler real e LLM fake) grava evento `action_sent` (idempotente) e o worker avança; (2) `ai_classify` põe enrollment em `waiting_reply` com `next_eval_at = now + grace_timeout_ms`; timeout vence sem inbound ⇒ classe `no_reply`; (3) `wait smart` recebe proposta da IA e **clampa** em `[min_ms, max_ms]` (teste com proposta fora dos dois lados); (4) janela 24h fechada + sem template ⇒ falha explícita do nó (backoff), NUNCA hold infinito. Prova: vitest + vitest.db verdes; transcript de um turno real com `scripts/smoke-llm.ts` adaptado OU LLM fake documentado.

### Task 5.1: Ponte engine ⇄ job_queue

**Files:** Modify: `lib/agent-engine/agent/followup-turn.ts` (aceitar payload de enrollment: novos campos opcionais `followup_enrollment_id`, `followup_node_id`, `purpose`; ao finalizar, gravar evento no enrollment via callback injetado — mudança mínima atrás de guard `if (payload.followup_enrollment_id)`); Create: `lib/followup/turn-bridge.ts` (constrói payload do job; recebe resultado e traduz em `NodeResult`); Tests: ampliar `tests/db/followup-engine.test.ts` + unit do bridge.

**Interfaces:** Consome `processNode` retornando `enqueue_turn`; produce `completeTurnForEnrollment(db, enrollmentId, result: { kind:'sent'|'classified'|'timing'; class?: string; proposed_at?: string })`.

- [ ] TDD: bridge unit (payload correto por purpose; clamp do decide_timing; classify grava classe) → impl → verde.
- [ ] TDD DB: ciclo action completo com turno fake → verde. Commit.

### Task 5.2: Reatividade de resposta (inbound acorda classify)

**Files:** Create: `lib/followup/reactivity.ts` — consumidor no próprio tick: busca `event_log` novos (cursor em `watchdog_cursors`, padrão existente) de tipos inbound/STOP/handoff; Modify: `lib/followup/engine.ts` (chama reactivity antes do claim).

Semântica: inbound de contato com enrollment `waiting_reply` ⇒ `next_eval_at=now()` (classifica na hora com a resposta); com `cancel_on_reply` no trigger_config ⇒ cancela `outcome='replied'`. STOP ⇒ cancela tudo do contato `opted_out`. Handoff aberto ⇒ política do pointer (`pause` ⇒ `paused_handoff`, `next_eval_at=null`). Handoff fechado ⇒ `paused_handoff` → `active`, `next_eval_at = now + 30min`.

- [ ] TDD DB por cenário (4 casos acima; em especial: **pausa por handoff retoma quando o evento de fechamento chega** — o anti-Tomik) → verde → commit.
- [ ] **Prova visível:** transcript SQL/curl no HANDOFF.

---

## Onda 6 — UI Builder (React Flow)

**Critérios de aceite (Playwright, `tests/e2e/followup-builder.spec.ts`):** logado como manager: (1) `/app/ai/followups` → clicar "Novo fluxo" → nome → canvas abre; (2) arrastar da paleta: trigger + wait + action + end; conectar arestas; configurar wait 10min e action com prompt_hint no painel lateral; (3) clicar "Publicar" com grafo incompleto (sem end conectado) → erros aparecem ancorados no nó ofensor; (4) corrigir → "Publicar" → badge "Ativo" + toast; (5) recarregar página → grafo persiste idêntico (posições incluídas); (6) "Rollback" desabilitado com 1 versão. Screenshots de cada passo salvos por Playwright. Bundle: rota do builder com dynamic import; `npm run build` + build-and-size sem regressão relevante (registrar delta no HANDOFF).

### Task 6.1: Página + lista de fluxos

**Files:** Create: `app/app/ai/followups/page.tsx` (server component: fetch pointers), `app/app/ai/followups/_components/FlowsList.tsx`, `app/app/ai/followups/_components/NewFlowDialog.tsx`; hooks `hooks/followup/useFollowupFlows.ts` (padrão `hooks/ai/useAgent.ts` + `apiClient`).

- [ ] Implementar lista (nome, status badge, versão, contagem de enrollments vivos — endpoint GET já existe) + criação. Estética Sage.
- [ ] Playwright: caso (1) dos critérios. Commit.

### Task 6.2: Canvas do builder

**Files:** Create: `app/app/ai/followups/[id]/page.tsx`, `_components/FlowBuilder.tsx` (React Flow com `nodeTypes` custom), `_components/nodes/{TriggerNode,WaitNode,ConditionNode,ClassifyNode,ActionNode,EndNode}.tsx`, `_components/NodeConfigPanel.tsx` (forms Zod-driven por tipo), `_components/PublishBar.tsx` (draft dirty state, salvar, publicar, desativar, rollback, handoff policy select).

**Interfaces:** grafo React Flow ⇄ `FlowGraph` (Task 2.1) via mapeadores `toFlowGraph`/`fromFlowGraph` em `lib/followup/graph-mappers.ts` (Create; unit test de ida-e-volta). Save = `PATCH draft_graph`; Publish = `POST publish`, erros 422 mapeados a `node_id` → highlight vermelho + tooltip no nó.

- [ ] Implementar em incrementos com Playwright acompanhando: paleta+drop → conexões → painel de config → save/reload → publish com erro → publish ok.
- [ ] **Prova visível:** rodar spec inteira headed uma vez, screenshots no HANDOFF. Commit por incremento.

---

## Onda 7 — UI Fila + seletor no agente

**Critérios de aceite (Playwright `tests/e2e/followup-queue.spec.ts`):** (1) aba "Fila" lista enrollment real criado via API no setup do teste: contato, fluxo, nó atual, próximo disparo (relativo + absoluto), badge de status; (2) filtro por status/fluxo funciona; (3) botão "Cancelar" pede confirmação e o enrollment some do filtro "ativos" (e evento `cancelled` existe via API); (4) promessa criada via `schedule_followup` (seed direto em `cron_jobs`) aparece na mesma fila com reason/promise; (5) no `AgentEditor`, seção "Follow-up": vincular o fluxo publicado + salvar → GET do agente retorna `followup.flow_pointer_ids` com o id.

### Task 7.1: Endpoint fila + página

**Files:** Create: `app/api/v1/ai/followups/queue/route.ts` (GET: união enrollments + cron_jobs kind at/followup_turn, cursor, filtros `status|pointer_id|q`), `app/app/ai/followups/_components/QueueTab.tsx`, `POST enrollments/[id]/cancel` route.

- [ ] TDD rota (formato união, cursor, filtros) → UI → Playwright casos 1-4. Commit.

### Task 7.2: Seletor no agente

**Files:** Modify: `lib/ai/guardrails-schema.ts` ou schema de config do agente (campo `followup: { enabled: boolean; flow_pointer_ids: string[] }` — verificar onde a config versionada valida, `lib/ai/agents/validation.ts`), `app/app/ai/agents/[id]/_components/AgentForm.tsx` (seção nova), dispatcher (`lib/ai/dispatcher/index.ts`): gatilhos automáticos (silence/stage) só enrollam se algum agente publicado tem o pointer habilitado.

- [ ] TDD validação de config → UI → Playwright caso 5. Commit.

---

## Onda 8 — Gatilhos automáticos + flywheel + E2E jornada completa

**Critérios de aceite finais (o teste que prova o sistema):** `tests/e2e/followup-journey.spec.ts` — jornada única: criar fluxo no builder (trigger silêncio 1min p/ teste, wait 1min, action ai_message com LLM fake/Core, classify com grace curto, end) → publicar → vincular ao agente → simular inbound de lead (fixture WAHA existente) → silêncio vence (tick manual do cron via request autenticada) → mensagem sai (verificar em `messages` + na UI da conversa) → simular resposta → classify roteia → fila mostrou cada estado ao longo do caminho → end com outcome `replied`/`converted` → outcome visível. Rodar `npm run typecheck && npm run lint && npm run test:unit && npm run test:invariants && npm run test:e2e` TUDO verde e colar no HANDOFF. Baseline validado fresh+update de novo.

### Task 8.1: Gatilho de silêncio

**Files:** Modify: `lib/followup/reactivity.ts` (varre conversas sem inbound há `threshold_minutes` cujo pointer com trigger silence está vinculado a agente ativo → cria enrollment respeitando unique; cursor incremental). Test: vitest.db.

- [ ] TDD → impl → verde → commit.

### Task 8.2: Outcomes → flywheel

**Files:** Modify: job `flywheel` existente (agregação por pointer/version dos outcomes de `followup_enrollments`) — mudança mínima: incluir contadores no material que judge/distiller já leem. Test: unit do agregador.

- [ ] TDD → impl → verde → commit.

### Task 8.3: E2E jornada + DoD

- [ ] Escrever e rodar `followup-journey.spec.ts`; screenshots.
- [ ] Checklist DoD do CLAUDE.md item a item (audit, rate-limit onde público, env novas em `.env.example`+`lib/env.ts` se houver, MANIFEST, baseline, sem console.log).
- [ ] Atualizar `docs/prd/05-prd-ai-rag-handoff.md` (ou PRD pertinente) com o contrato novo.
- [ ] HANDOFF final + commit.

---

## Auto-review do plano (feito)

- Cobertura da spec: §3→Onda 1; §5-6→Onda 2; §7→Ondas 3/7; §4→Ondas 4/5/6(reatividade na 5.2); §8→Ondas 6/7; §9→Ondas 7.2/8.2 (LGPD: cancel por anonimização entra na reactivity STOP-like — coberto em 5.2 com evento `lgpd`); §10→distribuído + 8.3.
- Tipos consistentes entre tasks (NodeResult/FlowGraph/TickDeps definidos uma vez, consumidos por referência).
- Sem placeholders funcionais: código load-bearing (SQL, contratos TS) está inline; UI tem contratos + critérios verificáveis por Playwright.
