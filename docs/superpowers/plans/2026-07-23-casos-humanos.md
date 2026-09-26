# Casos Humanos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Um sistema de casos/tickets onde a IA delega uma _tarefa_ a um humano de retaguarda e continua dona da conversa com o lead, num loop assíncrono bidirecional IA↔humano, com garantia dura contra a IA "prometer humano e não abrir caso".

**Architecture:** Reusa a maquinaria do `agent-engine` — o loop humano↔IA é o loop de follow-up invertido: em vez do tempo reinjetar um turno (`followup_turn`), o humano reinjeta (`case_reply_turn`) na mesma `job_queue`. Estado em `agent_cases`/`agent_case_events`; ativação por `ai_agent_versions.cases_enabled`; anti-alucinação por um gate novo na cadeia `before-send`. Spec fonte: `docs/specs/15-spec-casos-humanos.md`.

**Tech Stack:** TypeScript estrito, Next.js 16 App Router, Postgres (Supabase, migration 0064 + baseline), `pg.Pool` (engine), AI SDK v7 (`ai` ^7), Zod ^3, Vitest, Playwright, react-query, shadcn/ui.

## Global Constraints

- **Runtime alvo:** `lib/agent-engine/` (harness). NUNCA `lib/ai/runtime/`. (Wave 0 CONFIRMOU: `AGENT_DISPATCH_CONSUMER` default = `'engine'` → agent-engine é produção.)
- **Multi-tenancy:** toda tabela nova tem `organization_id uuid not null references organizations(id) on delete cascade` + RLS `tenant_isolation_<tabela>_all` via `fn_user_org_ids()`. Ids de tenant/lead/conversa **sempre** da row do job/conversa real — NUNCA do payload do modelo.
- **`status`/`kind` são `text` + CHECK — nunca enum.**
- **Migrations open-source:** arquivo versionado em `supabase/migrations/` (0064) **+** apêndice idempotente no `supabase/baseline.sql` **+** linha no `supabase/migrations/MANIFEST.md`. Idempotente e auto-curativo (`add column if not exists`, dedup antes de constraint). Validar baseline em Postgres descartável (install fresh + update).
- **Erro-como-ensino:** tools retornam `{ok:false, error:{code, message}}` (pt-br instrutivo) em vez de exceção; `catch` chama `noteRunError` e devolve `internal_error`.
- **Envio ao lead é SEMPRE via `send_message`** (texto direto é descartado).
- **API:** wrappers `ok()`/`fail()` (`lib/api/wrappers.ts`), `requireRole("agent", …)`, `X-Request-Id`, `audit(...)`. Rota de casos é autenticada (staff) → **sem rate-limit**. Sem `console.log` (usar logger/Sentry).
- **CADÊNCIA DE EXECUÇÃO (não negociável, spec §11.4):** cada wave termina com **prova imediata** — back = teste rodado (unit/integração), front = **Playwright clicando de verdade** + avaliação de **experiência/clareza** (está completa? o usuário entende?), front+back = teste integrado. Quebrou → **arruma antes de avançar**. `HANDOFF-casos-humanos.md` (raiz do worktree) **alimentado a cada wave**: progresso, testes rodados+resultado, bugs achados/corrigidos, o que ficou pra trás, estado atual. Zero progresso invisível.
- **DoD:** `npm run typecheck` + `npm run lint` zerados; golden adversariais passando; isolamento RLS (gate CI); `lib/database.types.ts` regenerado se mexeu em contrato.

---

## Mapa de arquivos

**Criar:**
- `supabase/migrations/20260724000000_0064_human_cases.sql` — schema
- `lib/agent-engine/agent/human-cases.ts` — tools `open_human_case`/`provide_case_update` + repositório (`openCase`, `provideCaseUpdate`, `resolveCase`, `escalateCase`, `hasOpenCaseForContact`, `buildCaseSummary`)
- `lib/agent-engine/agent/case-reply-turn.ts` — handler `createCaseReplyTurnHandler` (molde `followup-turn.ts`)
- `lib/agent-engine/guardrails/human-promise.ts` — `detectHumanPromise(body): boolean` (regex PT-BR)
- `app/api/v1/ai/cases/route.ts` — `GET` lista
- `app/api/v1/ai/cases/[id]/route.ts` — `GET` detalhe + timeline
- `app/api/v1/ai/cases/[id]/reply/route.ts` — `POST` resposta do humano
- `app/app/ai/cases/page.tsx` + `_components/CaseList.tsx` + `_components/CaseDetail.tsx` + `_components/CaseReplyPanel.tsx`
- `hooks/ai/useCases.ts` — `useCases`, `useCase`, `useReplyCase`
- Testes: `tests/unit/human-cases.test.ts`, `tests/unit/human-promise-detector.test.ts`, `tests/unit/case-reply-turn.test.ts`, `tests/invariants/case-guardrail.test.ts`, `tests/e2e/human-cases.spec.ts`, e goldens em `lib/agent-engine/golden-candidates/case-*.json`

**Modificar (pontos de inserção exatos das extrações):**
- `lib/agent-engine/queue/queue.ts:19` — `JobKind` += `'case_reply_turn'`
- `lib/agent-engine/agent/inbound-turn.ts` — `AGENT_TOOL_DEFS` (antes de `:197`), bind em `rawTools` condicional (após `:1041`)
- `lib/agent-engine/guardrails/before-send.ts` — `GateContext` (`:59`), novo `casePromiseGate` (clona `:217`), array `BEFORE_SEND_GATES` (`:313`), bump `BEFORE_SEND_CHAIN_VERSION` (`:298`)
- `lib/agent-engine/agent/inbound-turn.ts:788-832` — orquestração fail-safe no `execute` do `send_message` (carregar `hasOpenCase` no `GateContext`, contador de veto, auto-open na 2ª)
- `workers/agent-worker/main.ts:418` — `handlers.set('case_reply_turn', …)` + import `:27`
- `lib/agent-engine/agent/agent-config.ts` — `casesEnabled` (`:33`, `:57`, `:83`, `:117`)
- `app/app/ai/agents/[id]/_components/AgentForm.tsx` — Switch `cases_enabled` (`:96`, `:138`, `:157`, clone `:632`) + `_actions.ts`
- `supabase/baseline.sql` + `supabase/migrations/MANIFEST.md`

---

## Wave 0 — Confirmar runtime + abrir HANDOFF doc

**Files:** Create `HANDOFF-casos-humanos.md`.

- [ ] **Step 1: Confirmar o runtime em produção.**
Run: `grep -rn "AGENT_DISPATCH_CONSUMER" . --include=*.ts --include=*.sh --include=*.yml --include=*.env* -l` e ler o wiring de deploy (`workers/agent-worker/main.ts:186-202`, docker/compose, `.env.example`).
Expected: confirmar que o agent-engine é o consumer ativo. Se NÃO for, **parar e reportar ao Rafael** — a spec assume o engine (risco §10.3).

- [ ] **Step 2: Criar `HANDOFF-casos-humanos.md`** com o cabeçalho que se auto-instrui:
```markdown
# HANDOFF — Casos Humanos
> LEIA no início de cada avanço. ALIMENTE ao fim de cada wave: progresso, testes rodados+resultado, bugs achados/corrigidos, o que ficou pra trás, estado atual.

Spec: docs/specs/15-spec-casos-humanos.md · Plano: docs/superpowers/plans/2026-07-23-casos-humanos.md

## Estado atual
Wave 0: runtime confirmado = <agent-engine|OUTRO>. Próximo: Wave 1 (schema).

## Log
- <data> Wave 0: <resultado>
```

- [ ] **Step 3: Commit.** `git add HANDOFF-casos-humanos.md && git commit -m "chore(casos-humanos): handoff doc + runtime confirmado [wave 0]"`

---

## Wave 1 — Schema (migration 0064 + baseline + MANIFEST)

**Files:**
- Create: `supabase/migrations/20260724000000_0064_human_cases.sql`
- Modify: `supabase/baseline.sql`, `supabase/migrations/MANIFEST.md`
- Test: Postgres descartável (`pgvector/pgvector:pg17`)

**Interfaces — Produces:** tabelas `agent_cases`, `agent_case_events`; coluna `ai_agent_versions.cases_enabled`; CHECKs estendidos de `job_queue.kind`/`job_queue` coerência/`cron_jobs.job_kind` incluindo `case_reply_turn`.

- [ ] **Step 1: Escrever a migration** (idempotente; estende CHECKs dropando e recriando). Conteúdo completo:
```sql
-- 0064 human cases: loop assíncrono IA↔humano (spec 15)
create table if not exists agent_cases (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  lead_id uuid references crm_leads(id) on delete set null,
  agent_id uuid references ai_agents(id) on delete set null,
  status text not null default 'awaiting_human'
    check (status in ('awaiting_human','awaiting_lead','resolved','escalated','cancelled')),
  title text not null,
  summary text not null,
  blocker text not null,
  context_snapshot jsonb not null default '{}'::jsonb,
  source text not null default 'agent' check (source in ('agent','guardrail_autofallback')),
  followup_attempts smallint not null default 0,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists agent_cases_open_idx
  on agent_cases (organization_id, status) where status in ('awaiting_human','awaiting_lead');
create index if not exists agent_cases_lead_idx on agent_cases (organization_id, lead_id);
create index if not exists agent_cases_conv_idx on agent_cases (organization_id, conversation_id);

create table if not exists agent_case_events (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  case_id uuid not null references agent_cases(id) on delete cascade,
  kind text not null check (kind in
    ('opened','human_replied','lead_asked','lead_provided','lead_unresponsive','resolved','escalated','cancelled')),
  actor_kind text not null check (actor_kind in ('agent','human','system','lead')),
  actor_user_id uuid references auth.users(id) on delete set null,
  human_action text check (human_action in ('resolved','need_lead_info','escalate')),
  body text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists agent_case_events_case_idx on agent_case_events (case_id, created_at);

alter table ai_agent_versions add column if not exists cases_enabled boolean not null default false;

-- RLS
alter table agent_cases enable row level security;
alter table agent_case_events enable row level security;
drop policy if exists tenant_isolation_agent_cases_all on agent_cases;
create policy tenant_isolation_agent_cases_all on agent_cases
  for all using (organization_id in (select fn_user_org_ids())) with check (organization_id in (select fn_user_org_ids()));
-- eventos: append-only (select+insert; sem update/delete via RLS)
drop policy if exists tenant_isolation_agent_case_events_select on agent_case_events;
create policy tenant_isolation_agent_case_events_select on agent_case_events
  for select using (organization_id in (select fn_user_org_ids()));
drop policy if exists tenant_isolation_agent_case_events_insert on agent_case_events;
create policy tenant_isolation_agent_case_events_insert on agent_case_events
  for insert with check (organization_id in (select fn_user_org_ids()));

-- estender CHECKs de job_queue (kind + coerência kind⇔contato) p/ case_reply_turn
alter table job_queue drop constraint if exists job_queue_kind_check;
alter table job_queue add constraint job_queue_kind_check
  check (kind in ('inbound_turn','followup_turn','watchdog','flywheel','case_reply_turn'));
-- a constraint de coerência é anônima; recriar nomeada de forma idempotente:
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'job_queue'::regclass and contype='c'
     and pg_get_constraintdef(oid) like '%contact_id is not null%';
  if c is not null then execute format('alter table job_queue drop constraint %I', c); end if;
end $$;
alter table job_queue add constraint job_queue_turn_needs_contact
  check ((kind in ('inbound_turn','followup_turn','case_reply_turn')) = (contact_id is not null));

alter table cron_jobs drop constraint if exists cron_jobs_job_kind_check;
alter table cron_jobs add constraint cron_jobs_job_kind_check
  check (job_kind in ('inbound_turn','followup_turn','watchdog','flywheel','case_reply_turn'));
```

- [ ] **Step 2: Aplicar a migration** e provar. Run: `npm run supabase:migrate` (ou `mcp__plugin_supabase_supabase__apply_migration`). Expected: sem erro; `\d agent_cases` e `\d agent_case_events` existem; `select cases_enabled from ai_agent_versions limit 1` funciona.

- [ ] **Step 3: Refletir no `baseline.sql`** — apêndice idempotente rotulado `-- ---- human cases (migration 0064) ----` com o MESMO conteúdo do Step 1 (todo `if not exists`/`drop..if exists`+create). E linha no `MANIFEST.md` (tabela Applied): `0064 | human_cases | agent_cases + agent_case_events + ai_agent_versions.cases_enabled + CHECKs case_reply_turn`.

- [ ] **Step 4: Provar o baseline num Postgres descartável.**
Run: subir `pgvector/pgvector:pg17`, aplicar `install` (fresh, `ON_ERROR_STOP=1`) e depois re-aplicar `update` (sem a flag). Expected: ambos passam; re-aplicação não duplica constraint (idempotente).

- [ ] **Step 5: Regenerar types.** Run: `npm run db:types` (regenera `lib/database.types.ts`). Expected: `agent_cases`/`agent_case_events`/`cases_enabled` presentes.

- [ ] **Step 6: GATE + HANDOFF + Commit.** `npm run typecheck` zerado. Alimentar HANDOFF (schema pronto, baseline provado). `git commit -m "feat(casos-humanos): schema agent_cases + eventos + cases_enabled [wave 1]"`

---

## Wave 2 — Repositório + tools do engine (backend puro)

**Files:**
- Create: `lib/agent-engine/agent/human-cases.ts`, `tests/unit/human-cases.test.ts`
- Modify: `lib/agent-engine/queue/queue.ts:19`

**Interfaces — Produces:**
```ts
// human-cases.ts
export interface CaseIds { tenantId: string; leadId: string; conversationId: string; agentId?: string | null; }
export async function hasOpenCaseForContact(db: Queryable, tenantId: string, conversationId: string): Promise<boolean>;
export async function openCase(db: pg.Pool, ids: CaseIds, input: { title: string; summary: string; blocker: string; contextSnapshot?: Record<string,unknown>; source?: 'agent'|'guardrail_autofallback' }): Promise<{ ok: true; caseId: string } | { ok: false; error: { code: string; message: string } }>;
export async function provideCaseUpdate(db: pg.Pool, ids: CaseIds, input: { caseId: string; info: string }): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }>;
export async function resolveCaseFromHuman(db: Queryable, tenantId: string, caseId: string, actorUserId: string, note: string): Promise<void>;   // awaiting_human→resolved (efeito é o case_reply_turn enviar ao lead)
export async function markAwaitingLead(db: Queryable, tenantId: string, caseId: string, actorUserId: string, ask: string): Promise<void>;        // awaiting_human→awaiting_lead
export async function escalateCase(db: Queryable, tenantId: string, caseId: string, actorUserId: string, reason: string): Promise<void>;         // →escalated (o handoff em si é chamado na rota, Wave 5)
export const openHumanCaseInputSchema: z.ZodType;   // strict
export const provideCaseUpdateInputSchema: z.ZodType;
export function buildCaseSummary(previous: unknown): string;
```
Whitelist Zod `.strict()` + guard `findForbiddenKey` (importar de `./lead-state`, como `schedule-followup.ts:19`).

- [ ] **Step 1: Estender `JobKind`.** `lib/agent-engine/queue/queue.ts:19` → `export type JobKind = 'inbound_turn' | 'followup_turn' | 'watchdog' | 'flywheel' | 'case_reply_turn';`

- [ ] **Step 2: Teste falhando do repositório** (`tests/unit/human-cases.test.ts`) — usa o pool de teste do engine (mesmo setup de `tests/unit/*` que tocam `job_queue`; ver `vitest.db` config). Casos: `openCase` insere `agent_cases(status='awaiting_human')` + event `opened`; `hasOpenCaseForContact` true depois; `provideCaseUpdate` só transiciona de `awaiting_lead` (senão `{ok:false}`); dedup — `hasOpenCaseForContact` reflete estados abertos. Assertivas concretas de status/eventos.
Run: `npm run test:unit -- human-cases` → Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar `human-cases.ts`** seguindo o padrão de `schedule-followup.ts` (schema strict + guard + `applyX` → `{ok}`) e de `human-handoff.ts` (transições `status` via `CASE` que nunca pisa em terminal; INSERT de evento na mesma transação; ids do closure). `openCase` faz INSERT `agent_cases` + INSERT `agent_case_events(kind='opened', actor_kind=source==='agent'?'agent':'system')`. `context_snapshot` montado pelo runtime, nunca do modelo.

- [ ] **Step 4: Teste passa.** Run: `npm run test:unit -- human-cases` → Expected: PASS.

- [ ] **Step 5: GATE + HANDOFF + Commit.** `npm run typecheck`/`lint` zerados. HANDOFF: repositório + tools de dados provados por unit. `git commit -m "feat(casos-humanos): repositório de casos + JobKind case_reply_turn [wave 2]"`

---

## Wave 3 — Registrar as tools no turno + handler `case_reply_turn`

**Files:**
- Modify: `lib/agent-engine/agent/inbound-turn.ts` (`AGENT_TOOL_DEFS` antes de `:197`; bind condicional após `:1041`), `workers/agent-worker/main.ts` (`:27`, `:418`)
- Create: `lib/agent-engine/agent/case-reply-turn.ts`, `tests/unit/case-reply-turn.test.ts`

**Interfaces — Consumes:** `openCase`/`provideCaseUpdate` (Wave 2), `runAgentTurn`/`buildTemporalBlock`/`ritualBlocks` (inbound-turn.ts). **Produces:** `createCaseReplyTurnHandler(deps: InboundTurnDeps)`.

- [ ] **Step 1: Adicionar defs em `AGENT_TOOL_DEFS`** (antes de `} as const;` na linha 197):
```ts
  open_human_case: {
    description:
      'Abra um caso para um humano de retaguarda quando você NÃO conseguir resolver o pedido do lead ' +
      'sozinho (liberar acesso, corrigir algo num sistema, uma decisão que exige uma pessoa). Você CONTINUA ' +
      'conversando com o lead normalmente — não silencia. Use SEMPRE que for prometer ao lead que alguém vai ' +
      'verificar/resolver: prometer sem abrir o caso é proibido.',
    inputSchema: z.object({
      title: z.string().describe('título curto, ex.: "Liberar acesso ao painel"'),
      summary: z.string().describe('o que o lead precisa, em pt-br'),
      blocker: z.string().describe('por que você não consegue resolver sozinho'),
    }).passthrough(),
  },
  provide_case_update: {
    description:
      'Quando um caso está esperando informação do cliente e você já colheu essa informação na conversa, ' +
      'use esta tool para devolver a informação ao humano responsável. Não invente — só o que o lead disse.',
    inputSchema: z.object({
      case_id: z.string().describe('id do caso aberto'),
      info: z.string().describe('a informação colhida do lead'),
    }).passthrough(),
  },
```

- [ ] **Step 2: Bind condicional em `rawTools`** (após a linha 1041, espelhando `schedule_followup`; gated por `agentConfig?.casesEnabled`):
```ts
  if (agentConfig !== null && agentConfig.casesEnabled) {
    rawTools.open_human_case = tool({
      ...AGENT_TOOL_DEFS.open_human_case,
      execute: async (raw) => {
        try {
          const res = await openCase(pool, { tenantId, leadId, conversationId: input.conversationId, agentId: agentConfig.agentId },
            { title: String((raw as any).title ?? ''), summary: String((raw as any).summary ?? ''), blocker: String((raw as any).blocker ?? ''),
              contextSnapshot: buildCaseContextSnapshot(previous, openingContext) });
          if (!res.ok) return res;
          openedCaseThisTurn = true;   // sinal p/ o gate fail-safe (Wave 4)
          return { ok: true, case_id: res.caseId, message: 'caso aberto; continue a conversa com o lead normalmente.' };
        } catch (err) {
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return { ok: false, error: { code: 'internal_error', message: 'erro interno ao abrir o caso — encerre o turno.' } };
        }
      },
    });
    rawTools.provide_case_update = tool({
      ...AGENT_TOOL_DEFS.provide_case_update,
      execute: async (raw) => {
        try {
          const res = await provideCaseUpdate(pool, { tenantId, leadId, conversationId: input.conversationId },
            { caseId: String((raw as any).case_id ?? ''), info: String((raw as any).info ?? '') });
          if (!res.ok) return res;
          return { ok: true, message: 'informação enviada ao responsável; aguarde o retorno pelo caso.' };
        } catch (err) {
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return { ok: false, error: { code: 'internal_error', message: 'erro interno ao atualizar o caso — encerre o turno.' } };
        }
      },
    });
  }
```
(Declarar `let openedCaseThisTurn = false;` junto dos sinais de turno, ex. perto de `outOfTablePromiseAttempted`. Imports de `./human-cases` no topo. `buildCaseContextSnapshot` é um helper local pequeno que serializa contato+últimas N msgs do `openingContext` — nunca do payload.)

- [ ] **Step 3: Teste falhando do handler** (`tests/unit/case-reply-turn.test.ts`): dado um `job` kind `case_reply_turn` com payload `{case_id, action:'resolved', note}`, o handler resolve ids da conversa real e chama `runAgentTurn` com um `buildOpening` que injeta o bloco determinístico (mock de `runAgentTurn` verificando o texto do opening por ação). Cobrir as 3 ações: `resolved`, `need_lead_info`, e que `escalate` NÃO gera turno de IA.
Run: `npm run test:unit -- case-reply-turn` → Expected: FAIL.

- [ ] **Step 4: Implementar `case-reply-turn.ts`** (molde `followup-turn.ts:159-211`): resolve `conversations` real do contato, `caseReplyTurnPayloadSchema` (`.passthrough()`, campos `case_id`, `action`, `note/ask`), e por ação monta o opening:
  - `resolved`: *"O responsável interno concluiu o caso #<id> com a nota: '<note>'. Repasse essa conclusão ao lead de forma natural e encerre o assunto."*
  - `need_lead_info`: *"Para resolver o caso #<id>, o responsável precisa que você obtenha do cliente: '<ask>'. Pergunte ao lead. Quando tiver, chame provide_case_update."*
  - reusa `ritualBlocks(previous, leadState, context, notesIndexBlock)` no sufixo; envio sempre via `send_message`.

- [ ] **Step 5: Registrar o handler no worker.** `main.ts:27` import; `main.ts:418` → `handlers.set('case_reply_turn', createCaseReplyTurnHandler(turnDeps));`

- [ ] **Step 6: Teste passa + typecheck.** Run: `npm run test:unit -- case-reply-turn && npm run typecheck` → Expected: PASS/zerado.

- [ ] **Step 7: GATE + HANDOFF + Commit.** HANDOFF: tools registradas (gated), handler de re-entrada provado. `git commit -m "feat(casos-humanos): tools open/provide + handler case_reply_turn [wave 3]"`

---

## Wave 4 — Guardrail anti-alucinação (o requisito crítico)

**Files:**
- Create: `lib/agent-engine/guardrails/human-promise.ts`, `tests/unit/human-promise-detector.test.ts`, `tests/invariants/case-guardrail.test.ts`, goldens `lib/agent-engine/golden-candidates/case-*.json`
- Modify: `lib/agent-engine/guardrails/before-send.ts` (`GateContext` `:59`, novo gate clone de `:217`, array `:313`, bump `BEFORE_SEND_CHAIN_VERSION` `:298`), `lib/agent-engine/agent/inbound-turn.ts:788-832` (carregar `hasOpenCase` no ctx + contador de veto + auto-open)

**Interfaces — Consumes:** `hasOpenCaseForContact`, `openCase` (Wave 2), `openedCaseThisTurn` (Wave 3). **Produces:** `detectHumanPromise(body: string): boolean`; gate `casePromiseGate`; `GateContext.hasOpenCase`, `GateContext.openedCaseThisTurn`.

- [ ] **Step 1: Teste falhando do detector** (`human-promise-detector.test.ts`): DEVE detectar "vou verificar com a equipe", "nosso time vai resolver isso", "assim que liberarem eu te aviso", "vou acionar o responsável", "vou encaminhar pro setor". NÃO deve detectar fala genérica: "vou te enviar o link", "vou confirmar o valor", "deixa eu ver aqui rapidinho". (~12 casos true, ~12 false.)
Run: `npm run test:unit -- human-promise-detector` → Expected: FAIL.

- [ ] **Step 2: Implementar `detectHumanPromise`** (regex PT-BR conservadora, molde `guardrails/promise/engine.ts` `extractPromises`): verbo de encaminhamento/verificação + alvo humano/equipe/setor. Normalizar acento/caixa. Rodar até os 24 casos passarem (calibração é o ponto sensível — spec §10.2).
Run: `npm run test:unit -- human-promise-detector` → Expected: PASS.

- [ ] **Step 3: Adicionar o gate.** Em `before-send.ts`: `GateContext` (`:59`) ganha `hasOpenCase: boolean` e `openedCaseThisTurn: boolean`; novo gate (clona `semanticPromiseGate` `:217`):
```ts
export const casePromiseGate: Gate = {
  name: 'case_promise',
  evaluate: (ctx) => {
    if (!ctx.casesEnabled) return { pass: true };
    if (!detectHumanPromise(ctx.body)) return { pass: true };
    if (ctx.hasOpenCase || ctx.openedCaseThisTurn) return { pass: true };
    return { pass: false, code: 'case_promise_without_case',
      reason: 'Você prometeu envolver um humano mas não abriu um caso. Chame open_human_case OU reformule sem prometer humano.' };
  },
};
```
Adicionar ao `BEFORE_SEND_GATES` (`:313`) — posição 6.5, logo após `promiseGate`/`semanticPromiseGate`. **Bumpar `BEFORE_SEND_CHAIN_VERSION`** (`:298`, 3→4). `casesEnabled`/`hasOpenCase`/`openedCaseThisTurn` entram no `runBeforeSend` args a partir de `inbound-turn.ts`.

- [ ] **Step 4: Orquestração fail-safe** em `inbound-turn.ts` `send_message.execute` (`:788-832`): antes de `runBeforeSend`, carregar `hasOpenCase = await hasOpenCaseForContact(pool, tenantId, input.conversationId)` e passar `casesEnabled`/`hasOpenCase`/`openedCaseThisTurn`. Se `chain.status==='vetoed' && chain.code==='case_promise_without_case'`: incrementar `casePromiseVetoCount` (contador de turno); **1ª vez** → retorna o erro-de-ensino (modelo re-tenta); **2ª vez** → `openCase(..., { source:'guardrail_autofallback', title/summary/blocker derivados })`, setar `openedCaseThisTurn=true`, e **re-chamar `runBeforeSend`** (agora passa) para enviar.

- [ ] **Step 5: Teste de invariante** (`tests/invariants/case-guardrail.test.ts`): (a) promessa-de-humano sem caso → 1º `runBeforeSend` veta com `case_promise_without_case`; (b) 2ª tentativa aciona auto-open e o envio passa; (c) com caso já aberto (`hasOpenCase=true`) → passa direto; (d) fala genérica → nunca veta. Prova a **invariante dura**: nenhuma mensagem-promessa sai sem caso aberto.
Run: `npm run test:unit -- case-guardrail` → Expected: PASS.

- [ ] **Step 6: Goldens adversariais** (`golden-candidates/case-*.json`; o formato é o que `recordStageDivergenceCandidate` grava, em `lib/agent-engine/agent/stage-classifier.ts` — os candidatos automáticos não são versionados): `case-must-open` (lead pede algo irresolvível → asserta `open_human_case` chamado), `case-temptation` (induz "vou verificar com a equipe" sem abrir → asserta veto+auto-open), `case-false-positive` (fala genérica → sem veto). Rodar pelo runner de goldens do engine.
Run: (comando do runner de goldens do repo) → Expected: os 3 passam.

- [ ] **Step 7: GATE + HANDOFF + Commit.** `npm run typecheck`/`lint` zerados; todos os testes de guardrail verdes. HANDOFF: **requisito crítico provado** — invariante + goldens adversariais. `git commit -m "feat(casos-humanos): gate anti-alucinação com fail-safe auto-open [wave 4]"`

---

## Wave 5 — Ativação por agente + rotas de API + ponte de escalação

**Files:**
- Modify: `lib/agent-engine/agent/agent-config.ts` (`:33`,`:57`,`:83`,`:117`), `app/app/ai/agents/[id]/_components/AgentForm.tsx` (`:96`,`:138`,`:157`,`:632`) + `_actions.ts`
- Create: `app/api/v1/ai/cases/route.ts`, `app/api/v1/ai/cases/[id]/route.ts`, `app/api/v1/ai/cases/[id]/reply/route.ts`

**Interfaces — Consumes:** repositório Wave 2, `performHumanHandoff` (`human-handoff.ts:149`). **Produces:** `casesEnabled` em `PublishedAgentConfig`; endpoints REST.

- [ ] **Step 1: `casesEnabled` no config** (agent-config.ts): campo `casesEnabled: boolean` no type (`:33`); `cases_enabled: boolean` na `Row` (`:57`) e no `select v...` (`:83`); `casesEnabled: r.cases_enabled` no retorno (`:117`).

- [ ] **Step 2: Toggle na tela** (AgentForm.tsx): form type (`:96`) `cases_enabled: boolean`; default (`:138`) `version?.cases_enabled ?? false`; objeto salvo (`:157`); clone do `<Switch>` de `handoff_tool_enabled` (`:632`) com label *"Abrir casos para um humano (a IA delega tarefas e continua na conversa)"*; persistir em `_actions.ts` (grava `cases_enabled` em `ai_agent_versions`).

- [ ] **Step 3: Teste falhando das rotas** (`tests/e2e` ou integração de rota, molde dos testes de `ai/inbox`): `GET /api/v1/ai/cases?status=open` retorna casos da org (role≥agent, isolado por org); `POST /api/v1/ai/cases/[id]/reply` com `{action:'need_lead_info', body}` cria event `human_replied` + enfileira `case_reply_turn` + transiciona status. Rejeita viewer (403).
Run: `npm run test:unit -- cases-route` (ou e2e) → Expected: FAIL.

- [ ] **Step 4: Implementar as rotas** (molde `leads/[id]/win/route.ts` + `ai/inbox/route.ts`): `requireRole("agent", {requestId, resource:"agent_cases"})`, Zod no body (`action ∈ {resolved,need_lead_info,escalate}`, `body:string`), `ok()`/`fail()`, `audit(action:"ai.case_replied", …)`. No `reply`:
  - `resolved` → `resolveCaseFromHuman` + `enqueueJob(kind:'case_reply_turn', payload:{case_id, action:'resolved', note:body})`.
  - `need_lead_info` → `markAwaitingLead` + enqueue `case_reply_turn` `{action:'need_lead_info', ask:body}`.
  - `escalate` → `escalateCase` + `performHumanHandoff(pool, {tenantId,leadId,conversationId}, {reason:body, conversationSummary:buildCaseSummary(...), log})`. (Ids resolvidos do caso/conversa no servidor, nunca do body.)

- [ ] **Step 5: Teste passa + typecheck/lint.** Run: `npm run test:unit -- cases-route && npm run typecheck && npm run lint` → Expected: PASS/zerado.

- [ ] **Step 6: GATE (front+back) + HANDOFF + Commit.** HANDOFF: ativação por agente + API + escalação provadas. `git commit -m "feat(casos-humanos): cases_enabled + rotas API + ponte de escalação [wave 5]"`

---

## Wave 6 — UI do inbox de casos + E2E do loop completo

**Files:**
- Create: `app/app/ai/cases/page.tsx`, `_components/CaseList.tsx`, `_components/CaseDetail.tsx`, `_components/CaseReplyPanel.tsx`, `hooks/ai/useCases.ts`, `tests/e2e/human-cases.spec.ts`
- Modify: nav do assistente (adicionar link "Casos")

**Interfaces — Consumes:** `GET/POST /api/v1/ai/cases*` (Wave 5).

- [ ] **Step 1: Hooks** (`useCases.ts`, molde `hooks/ai/useAgentInbox.ts`): `useCases(status)` com `refetchInterval: 60_000`; `useCase(id)`; `useReplyCase()` (mutation `POST .../reply`, `invalidateQueries(['ai-cases'])`).

- [ ] **Step 2: UI** (molde `AgentInboxList.tsx`): `page.tsx` server (auth + `canResolve = ROLE_RANK[role] >= agent`) → `CaseList`. `CaseList` = tabs Abertos/Resolvidos, badge de status (esperando você / esperando cliente / resolvido / escalado) e de `lead_unresponsive`. `CaseDetail` = cabeçalho (cliente+pedido) + o que a IA abriu (`title`/`summary`/`blocker`) + timeline (`agent_case_events`). `CaseReplyPanel` = **3 ações estruturadas** (`[Concluí ✓]`/`[Preciso de info do cliente]`/`[Não consigo → escalar]`) + textarea + `[Enviar p/ IA]` → `useReplyCase`.

- [ ] **Step 3: Teste E2E do loop completo** (`human-cases.spec.ts`, conta REAL — criar org+usuário via seed, agente com `cases_enabled`): abrir caso (via turno simulado no engine) → aparece no inbox → humano clica **"Preciso de info do cliente"** + texto → asserta `awaiting_lead` + job enfileirado → simular resposta do lead → `provide_case_update` → volta `awaiting_human` → humano clica **"Concluí"** → asserta `resolved`. **Playwright clicando os botões de verdade** (memória: API/replay não pega bug de front).
Run: `npm run test:e2e -- human-cases` → Expected: PASS.

- [ ] **Step 4: Prova visual + avaliação de EXPERIÊNCIA (spec §11.4).** Playwright screenshot de cada estado; avaliar: a UI diz claramente **de quem é a bola** (esperando você / esperando cliente)? O humano entende o que é um "caso" sem explicação? As 3 ações são inequívocas? Medir dimensões por ferramenta (`getBoundingClientRect`), não a olho. **Qualquer "não" → corrigir antes de fechar a wave.**

- [ ] **Step 5: GATE final + HANDOFF + Commit.** `npm run typecheck`/`lint`/`test:unit`/`test:e2e` verdes; isolamento RLS de `agent_cases` no CI. HANDOFF: loop ponta-a-ponta provado em conta real + UX avaliada. `git commit -m "feat(casos-humanos): UI de casos + E2E do loop completo [wave 6]"`

---

## Self-review (coberto do spec)

| Spec | Wave |
|---|---|
| §3 máquina de estados | W2 (transições) + W3 (re-entrada) + W5 (escalação) |
| §4 tools + `case_reply_turn` | W2 (repo) + W3 (registro+handler) |
| §5 `cases_enabled` + bloco de sistema | W5 (config/tela) — *bloco de sistema residente: adicionar em W3/W5 junto ao gating* |
| §6 guardrail fail-safe | W4 |
| §7 escalação `performHumanHandoff` | W5 |
| §8 schema | W1 |
| §9 UI + rotas | W5 (rotas) + W6 (UI) |
| §11 testes | embutido em cada wave + W4 goldens + W6 E2E |
| §11.4 cadência | gate ao fim de toda wave |

**Nota:** o "bloco de sistema dedicado quando `cases_enabled`" (§5.2, contexto residente) é uma inserção no system-prompt do engine (prefixo cacheável) — adicioná-lo no bind das tools (W3) ou junto ao gating (W5). Explicitar como sub-step ao implementar W3.
