# CRM Automações — Fluxos visuais — Tasks

**Design:** `.specs/features/crm-automacao-fluxos/design.md`
**Status:** Draft

---

## Execution Plan

### Phase 1: Compile (P1 backend)

```
T1 → T2 → T3
```

### Phase 2: Canvas P1 (UI)

```
T3 ──→ T4 ──→ T5 ──→ T6
```

### Phase 3: Grafo no banco + walk (P2)

```
T6 → T7 → T8 → T9 → T10 → T11
```

### Phase 4: Linguagem + E2E P2

```
T11 → T12 → T13
```

---

## Task Breakdown

### T1: Schema Zod do grafo de automação

**What:** Tipos + `validateAutomationGraph` para DAG linear (1 trigger, conditions em série, actions em série, 1 end).
**Where:** `lib/automation/graph-schema.ts`, `lib/automation/graph-schema.test.ts`
**Depends on:** None
**Reuses:** `TRIGGER_EVENTS`, `actionSchema` em `lib/schemas/webhooks.ts`
**Requirement:** AUTOFLUXO-01, AUTOFLUXO-09

**Tools:** filesystem · Skill: escreve.ai

**Done when:**

- [ ] União de nós `trigger | condition | action | end` exportada
- [ ] Validador rejeita 0/2 triggers, ciclo, action type fora do registry
- [ ] Gate: `pnpm exec vitest run lib/automation/graph-schema.test.ts`
- [ ] Test count: ≥8 testes (não apagar os existentes do pacote)

**Tests:** unit
**Gate:** quick

**Commit:** `feat(automation): schema zod do grafo de fluxo`

---

### T2: compileLinear / decompileLinear

**What:** Funções puras grafo ⇄ `{ trigger_event, conditions, actions }`.
**Where:** `lib/automation/compile-graph.ts`, `lib/automation/compile-graph.test.ts`
**Depends on:** T1
**Reuses:** T1, `conditionSchema`
**Requirement:** AUTOFLUXO-02, AUTOFLUXO-03

**Tools:** filesystem

**Done when:**

- [ ] Round-trip: decompile(compile(g)) equivalente em trigger/conditions/actions
- [ ] Grafo com 2 saídas num condition retorna fail (não-linear)
- [ ] Gate: `pnpm exec vitest run lib/automation/compile-graph.test.ts`
- [ ] Test count: ≥6

**Tests:** unit
**Gate:** quick

**Commit:** `feat(automation): compile/decompile grafo linear`

---

### T3: Revalidar compile na API

**What:** POST/PATCH de regra: se body trouxer `graph`, compile no server; senão fluxo atual.
**Where:** `app/api/v1/automation-rules/route.ts`, `app/api/v1/automation-rules/[id]/route.ts`, `lib/schemas/webhooks.ts`
**Depends on:** T2
**Reuses:** `ok()`/`fail()`, `requireRole`, `audit`
**Requirement:** AUTOFLUXO-02, AUTOFLUXO-04

**Tools:** filesystem

**Done when:**

- [ ] `graph` linear aceito; persiste colunas compiladas
- [ ] `graph` inválido → 422, sem insert
- [ ] Sem `graph` → contrato v1 intacto
- [ ] Teste de schema/handler existente atualizado
- [ ] Gate: `pnpm exec vitest run lib/schemas/webhooks.test.ts` (e teste de rota se houver)
- [ ] `pnpm typecheck` limpo nesta superfície

**Tests:** unit
**Gate:** quick

**Commit:** `feat(automation): PATCH/POST aceita graph linear`

---

### T4: Nós React Flow da automação

**What:** Componentes visuais trigger/condition/action/end + paleta, pasta `flow/`.
**Where:** `app/app/webhooks/_components/flow/`
**Depends on:** T1
**Reuses:** tokens/handles do follow-up **sem** importar `lib/followup/graph-schema`; `labels.ts`
**Requirement:** AUTOFLUXO-01, AUTOFLUXO-11

**Tools:** filesystem

**Done when:**

- [ ] Dynamic import possível (canvas não no bundle da aba Fontes)
- [ ] Rótulos PT da paleta (sem trigger_event cru)
- [ ] Gate: `pnpm typecheck` (arquivos novos)

**Tests:** unit (smoke do mapper se extraído; senão typecheck)
**Gate:** quick

**Commit:** `feat(automation): nós do canvas de fluxo`

---

### T5: Canvas no lugar do RuleEditor

**What:** Criar/editar regra no canvas; save chama compile + mutation existente.
**Where:** `RuleEditor.tsx` ou sucessor `FlowEditor.tsx`; `RulesTab.tsx`
**Depends on:** T3, T4
**Reuses:** `ActionConfigForm`, hooks `useCreateAutomationRule` / `useUpdateAutomationRule`
**Requirement:** AUTOFLUXO-01, AUTOFLUXO-03, AUTOFLUXO-05

**Tools:** filesystem

**Done when:**

- [ ] Abrir regra antiga decompileia no canvas
- [ ] Agent continua sem a rota (inalterado)
- [ ] Empty state da lista (AUTOFLUXO-12 pode ficar T12 se T5 só o editor)
- [ ] Gate: `pnpm lint` nos arquivos tocados

**Tests:** unit do mapper UI se houver (`*.test.tsx`)
**Gate:** quick

**Commit:** `feat(automation): editor de fluxo no lugar do sheet`

---

### T6: E2E P1 do canvas

**What:** Ajustar `tests/e2e/webhooks.spec.ts` para o canvas (criar fluxo linear + drain + Atividade).
**Where:** `tests/e2e/webhooks.spec.ts`
**Depends on:** T5
**Reuses:** helpers de credenciais do spec atual
**Requirement:** AUTOFLUXO-01, AUTOFLUXO-04

**Tools:** filesystem · Playwright

**Done when:**

- [ ] Spec verde contra app + banco semeado
- [ ] Screenshot do canvas + Atividade (evidência)
- [ ] Gate: spec Playwright deste arquivo

**Tests:** e2e
**Gate:** full

**Commit:** `test(e2e): webhooks usa canvas de automação`

---

### T7: Coluna `graph` + baseline + MANIFEST

**What:** Migration idempotente, apêndice `baseline.sql`, linha MANIFEST. Sem editar migrations antigas.
**Where:** `supabase/migrations/YYYYMMDDHHMMSS_0xxx_automation_graph.sql`, `supabase/baseline.sql`, `supabase/migrations/MANIFEST.md`
**Depends on:** T6 (P1 shippable sem isto; P2 bloqueia)
**Reuses:** padrão 0038 RLS já na tabela
**Requirement:** AUTOFLUXO-06

**Tools:** filesystem

**Done when:**

- [ ] `add column if not exists graph jsonb`
- [ ] Três artefatos juntos
- [ ] Gate: `pnpm test:db` (install+update do baseline)

**Tests:** integration (invariants harness)
**Gate:** full

**Commit:** `feat(db): automation_rules.graph`

---

### T8: walkGraph + testes unitários

**What:** Percorre DAG, um caminho, fail-closed sem aresta.
**Where:** `lib/automation/walk-graph.ts`, `lib/automation/walk-graph.test.ts`
**Depends on:** T1, T7
**Reuses:** `evaluateConditions`, `getAction` (mock executors no teste)
**Requirement:** AUTOFLUXO-06, AUTOFLUXO-07, AUTOFLUXO-10

**Tools:** filesystem

**Done when:**

- [ ] Ramo true executa só ações true
- [ ] Sem aresta → results failed, zero execute no outro ramo
- [ ] `caused_by_rule` não é responsabilidade daqui (engine)
- [ ] Gate: `pnpm exec vitest run lib/automation/walk-graph.test.ts`
- [ ] Test count: ≥5

**Tests:** unit
**Gate:** quick

**Commit:** `feat(automation): walk do grafo ramificado`

---

### T9: Engine escolhe walk vs loop linear

**What:** Se `rule.graph` ramificado, `walkGraph`; senão loop atual. Anti-loop inalterado.
**Where:** `lib/automation/engine.ts` + testes em `tests/invariants/automation-engine.test.ts` e/ou unit do engine
**Depends on:** T8
**Reuses:** `buildContext`, `AUTOMATION_CONSUMER_KEY`
**Requirement:** AUTOFLUXO-04, AUTOFLUXO-06, AUTOFLUXO-10

**Tools:** filesystem

**Done when:**

- [ ] Regra só-colunas (graph null) comportamento idêntico
- [ ] Anti-loop depth 1 permanece
- [ ] Gate: testes unitários do engine + `pnpm test:db` nos invariantes de automation

**Tests:** unit + integration
**Gate:** full

**Commit:** `feat(automation): motor executa grafo ramificado`

---

### T10: Pausar para editar grafo ativo

**What:** PATCH `graph` com `is_active=true` → 409 `rule_must_pause_to_edit_graph` salvo se o mesmo PATCH manda `is_active: false`.
**Where:** `app/api/v1/automation-rules/[id]/route.ts` + teste
**Depends on:** T7, T3
**Reuses:** `fail(code, message, status)`
**Requirement:** AUTOFLUXO-08

**Tools:** filesystem

**Done when:**

- [ ] 409 documentado no teste da rota/schema
- [ ] Ligar de novo continua PATCH `{ is_active: true }`
- [ ] Gate: vitest do handler/schema

**Tests:** unit
**Gate:** quick

**Commit:** `fix(automation): pausa obrigatória para editar grafo`

---

### T11: Invariantes P2 (ramo + isolamento)

**What:** Caso ramo true/false e RLS inalterado com coluna graph.
**Where:** `tests/invariants/automation-engine.test.ts` (estender) ou arquivo irmão
**Depends on:** T9
**Reuses:** fixtures de org A/B dos invariantes
**Requirement:** AUTOFLUXO-06, AUTOFLUXO-07

**Tools:** filesystem · Docker

**Done when:**

- [ ] Dois estágios → duas tags distintas
- [ ] Tenant B não lê graph do A
- [ ] Gate: `pnpm test:db` (subset automation se o script permitir; senão job completo)

**Tests:** integration
**Gate:** full

**Commit:** `test(db): automação ramificada e RLS do graph`

---

### T12: Empty state e jargão da paleta

**What:** Empty da aba Automações + revisão de copy (P3).
**Where:** `RulesTab.tsx`, `flow/` labels
**Depends on:** T5
**Reuses:** doutrina W4 (funil/etapa/marcador)
**Requirement:** AUTOFLUXO-11, AUTOFLUXO-12

**Tools:** filesystem

**Done when:**

- [ ] Empty explica o primeiro fluxo em PT de operação
- [ ] Sem strings de marca
- [ ] Gate: `pnpm exec vitest run tests/unit/branding.test.ts` (e jargão se a paleta MCP entrar)

**Tests:** unit
**Gate:** quick

**Commit:** `feat(automation): empty state do canvas`

---

### T13: E2E ramificação

**What:** Playwright: fluxo com condition 2 saídas, mover lead, conferir tag do ramo.
**Where:** `tests/e2e/webhooks.spec.ts` ou `tests/e2e/automation-fluxo.spec.ts`
**Depends on:** T11, T12
**Reuses:** seed E2E, drain do spec atual
**Requirement:** AUTOFLUXO-06

**Tools:** Playwright

**Done when:**

- [ ] Evidência visual: canvas ramificado + Atividade + kanban
- [ ] Gate: spec Playwright

**Tests:** e2e
**Gate:** full

**Commit:** `test(e2e): automação com ramo sim/não`

---

## Parallel Execution Map

```
Phase 1: T1 → T2 → T3
Phase 2: T4 pode começar após T1 [não P com T3 — T5 precisa dos dois]
         T4 → T5 → T6
Phase 3: T7 → T8 → T9 → T10 → T11
         T10 depende T7+T3 (T3 já feito)
Phase 4: T12 após T5; T13 após T11+T12
```

Nenhuma tarefa `[P]` com teste e2e/db: Parallel-Safe: No.

T4 marcado sequencial após T1, paralelo **conceitual** a T2/T3 se outro agente não tocar `lib/schemas/webhooks.ts`. Na prática: T4 depois de T1, T2/T3 no backend ao mesmo tempo **só se** T4 não editar schemas — T4 é UI. Então T2+T4 `[P]` após T1.

Ajuste: T2 e T4 são `[P]` após T1.

---

## Task Granularity Check

| Task | Scope | Status |
| --- | --- | --- |
| T1 schema | 1 módulo + teste | ✅ |
| T2 compile | 1 módulo + teste | ✅ |
| T3 API graph linear | 2 rotas + schema | ⚠️ cohesivo |
| T4 nós UI | pasta flow | ⚠️ pasta, um conceito |
| T5 wire editor | 2 arquivos UI | ⚠️ |
| T6 e2e P1 | 1 spec | ✅ |
| T7 migration | 3 arquivos doutrina | ⚠️ obrigatório junto |
| T8 walk | 1 módulo | ✅ |
| T9 engine | 1 função | ✅ |
| T10 409 | 1 rota | ✅ |
| T11 invariants | 1 arquivo teste | ✅ |
| T12 copy | UI | ✅ |
| T13 e2e P2 | 1 spec | ✅ |

T3/T4/T5/T7 são 2–3 arquivos no mesmo conceito — OK.

---

## Diagram-Definition Cross-Check

| Task | Depends On (body) | Diagram | Status |
| --- | --- | --- | --- |
| T1 | None | start | ✅ |
| T2 | T1 | T1→T2 | ✅ |
| T3 | T2 | T2→T3 | ✅ |
| T4 | T1 | T1→T4 (paralelo a T2) | ✅ |
| T5 | T3, T4 | T3+T4→T5 | ✅ |
| T6 | T5 | T5→T6 | ✅ |
| T7 | T6 | T6→T7 | ✅ |
| T8 | T1, T7 | T7→T8 (T1 já) | ✅ |
| T9 | T8 | T8→T9 | ✅ |
| T10 | T7, T3 | T3 já; T7→…→T10 | ✅ |
| T11 | T9 | T9→T11 | ✅ |
| T12 | T5 | T5→T12 (pode após T6) | ✅ |
| T13 | T11, T12 | T11+T12→T13 | ✅ |

T10 no diagrama da Phase 3 está após T9; o body diz T7+T3. **Alinhar:** T10 pode ir em paralelo a T8 após T7 (não precisa do walk). Diagrama Phase 3 corrigido:

```
T7 ─┬→ T8 → T9 → T11
    └→ T10
T10 não depende de T8.
```

---

## Test Co-location Validation

| Task | Layer | Matrix | Task Tests | Status |
| --- | --- | --- | --- | --- |
| T1 | lib | unit | unit | ✅ |
| T2 | lib | unit | unit | ✅ |
| T3 | API | unit | unit | ✅ |
| T4 | UI nodes | unit/typecheck | unit | ✅ |
| T5 | UI | unit | unit | ✅ |
| T6 | UI journey | e2e | e2e | ✅ |
| T7 | schema | integration | integration | ✅ |
| T8 | lib | unit | unit | ✅ |
| T9 | engine | unit+invariants | unit+integration | ✅ |
| T10 | API | unit | unit | ✅ |
| T11 | db | integration | integration | ✅ |
| T12 | UI | unit | unit | ✅ |
| T13 | UI | e2e | e2e | ✅ |

---

## Requirement mapping

| ID | Tasks |
| --- | --- |
| AUTOFLUXO-01 | T1, T4, T5, T6 |
| AUTOFLUXO-02 | T2, T3 |
| AUTOFLUXO-03 | T2, T5 |
| AUTOFLUXO-04 | T3, T6, T9 |
| AUTOFLUXO-05 | T5 |
| AUTOFLUXO-06 | T7, T8, T9, T11, T13 |
| AUTOFLUXO-07 | T8, T11 |
| AUTOFLUXO-08 | T10 |
| AUTOFLUXO-09 | T1 |
| AUTOFLUXO-10 | T8, T9 |
| AUTOFLUXO-11 | T4, T12 |
| AUTOFLUXO-12 | T12 |

Coverage: 12/12 mapped.
