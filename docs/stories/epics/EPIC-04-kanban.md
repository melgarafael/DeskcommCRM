---
epic_id: EPIC-04-kanban
epic_name: Pipeline Kanban
priority: P0
estimated_waves: 10
estimated_total_points: 34
depends_on: [EPIC-00, EPIC-01]
exposes_contracts:
  - "api.POST /api/v1/leads/[id]/move"
  - "api.POST /api/v1/leads/[id]/win"
  - "api.POST /api/v1/leads/[id]/lose"
  - "api.POST /api/v1/leads/bulk"
  - "realtime.kanban-{pipeline_id}"
  - "hook.useBoard"
  - "hook.useMoveCard"
  - "hook.useUpdateLead"
  - "hook.useBulkAction"
  - "ui.<KanbanBoard>"
  - "ui.<KanbanCard>"
  - "event.lead.stage_changed"
  - "event.lead.won"
  - "event.lead.lost"
status: completed
created_at: 2026-04-28
owner: Songhai, Lda
---

# EPIC-04 — Pipeline Kanban

> **Para o epic-executor**: leia este arquivo inteiro antes de qualquer wave. Stories em ordem de dependência. Cada story = 1 wave. `Deps:` é lei. Drag-drop usa Pattern B (Spec 09 §7.2): optimistic + 409 rollback. Fractional indexing é P-05. Auto won/lost via stage flags é P-02 (DB trigger, NÃO no client).

## 1. Objetivo

Entregar a tela `/app/pipelines/[id]` com Kanban funcional: drag-drop entre stages com fractional indexing, win/lose explícito com `lost_reason`, bulk actions (≤50), filtros (owner/status/tag/search/value/overdue), realtime cross-user e fallback de reposicionamento global quando precisão decimal degrada. Tudo respeitando P-01..P-08, AT-06 e Pattern B.

## 2. Resultado esperado (Definition of Done do Epic)

- [ ] Atendente abre `/app/pipelines/[id]` e vê StageColumns ordenadas com KanbanCards posicionados por `position_in_stage`
- [ ] Drag de card entre stages persiste via `POST /leads/:id/move` com `position = midpoint(prev, next)` (P-05)
- [ ] Conflito 409 (`lead_stage_changed_concurrent`) faz rollback do optimistic e reinvalida `['board', pipelineId]`
- [ ] Tentar mover lead pra stage de outro pipeline retorna 422 `pipeline_immutable_use_clone` (P-01)
- [ ] Card movido pra stage com `is_won=true` fecha como won via trigger DB (P-02), UI reflete via realtime
- [ ] `POST /leads/:id/lose` sem `lost_reason` retorna 422 `lost_reason_required` (P-03)
- [ ] Bulk action com 51 cards retorna 422 `bulk_too_large` (AT-06)
- [ ] Realtime `kanban-{pipeline_id}` propaga moves de outros usuários sem refresh
- [ ] Filtros (owner/status/tag/search ILIKE/value range/overdue) operam no client com query reativa
- [ ] Multi-select Cmd+click + barra de bulk actions (move/assign/tag/delete) funcional
- [ ] Manager+ pode disparar reposicionamento global quando >20 níveis decimais (regression em P-05)
- [ ] Vocabulary do pipeline rege rótulos via `usePipelineVocabulary` (P-07) — sem strings hardcoded
- [ ] Regression suite cumulativo passa (vide §6)

## 3. Pré-requisitos

- Epics anteriores completos: `EPIC-00`, `EPIC-01`
- Migrations aplicadas: 0001-0007 (incluindo `crm_pipelines`, `crm_stages`, `crm_leads`, triggers `fn_crm_lead_close_on_stage`, `fn_crm_lead_lost_reason_check`, `fn_crm_lead_pipeline_immutable`)
- Variáveis de env: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- Dev server rodando em `localhost:3001`
- Playwright MCP conectado pra QA
- `@hello-pangea/dnd` ^16.6.0 instalado
- `usePipelineVocabulary` hook disponível (criado em EPIC-02 ou stub aqui se ausente)

## 4. Architecture Contracts

### 4.1 Contracts consumidos (de epics anteriores)

| Contract ID | Tipo | Origem | Como usar |
|---|---|---|---|
| `auth.user-session` | session | EPIC-01 | Via `useAuth()` hook |
| `hook.useApiClient` | http | EPIC-00 | Wrapper com Idempotency-Key |
| `hook.useRealtimeChannel` | realtime | EPIC-00 | Primitive p/ canal `kanban-{pipeline_id}` |
| `infra.tanstack-query` | cache | EPIC-00 | Provider configurado |
| `lib.toast` | feedback | EPIC-00 | sonner pra erros 409/422 |
| `db.crm_pipelines` | db_table | migration 0006 | RLS via `fn_user_org_ids()` |
| `db.crm_stages` | db_table | migration 0006 | flags `is_won`, `is_lost`, `order_index` |
| `db.crm_leads` | db_table | migration 0006 | `position_in_stage numeric`, `status`, `lost_reason` |
| `trigger.fn_crm_lead_close_on_stage` | db_trigger | migration 0007 | Auto won/lost via stage flags (P-02) |

### 4.2 Contracts expostos (consumíveis por epics futuros)

| Contract ID | Tipo | Wave que expõe | Descrição pra consumidores |
|---|---|---|---|
| `api.POST /api/v1/leads/[id]/move` | api_route | S-04.01 | Body `{stage_id, position_in_stage, expected_updated_at}`, 200 → `Lead`, 409 → `lead_stage_changed_concurrent`, 422 → `pipeline_immutable_use_clone` |
| `api.POST /api/v1/leads/[id]/win` | api_route | S-04.02 | Body `{}` (idempotent), 200 → `Lead` com `status=won` |
| `api.POST /api/v1/leads/[id]/lose` | api_route | S-04.02 | Body `{lost_reason: string}`, 200 → `Lead`, 422 → `lost_reason_required` |
| `api.POST /api/v1/leads/bulk` | api_route | S-04.03 | Body `{lead_ids: string[], action: 'move'\|'assign'\|'tag'\|'delete', params: {...}}`, 422 → `bulk_too_large` se `lead_ids.length > 50` |
| `realtime.kanban-{pipeline_id}` | realtime_channel | S-04.04 | Subscribe pra `crm_leads` filtrado por `pipeline_id=eq.{id}`, eventos `INSERT`/`UPDATE`/`DELETE` |
| `hook.useBoard` | react_hook | S-04.04 | `useBoard(pipelineId): { data: Lead[], stages: Stage[], isLoading, error }` + auto-realtime |
| `hook.useMoveCard` | react_hook | S-04.05 | `useMoveCard(pipelineId): UseMutationResult` Pattern B (optimistic + rollback 409) |
| `hook.useUpdateLead` | react_hook | S-04.05 | `useUpdateLead(): mutate({id, patch})` p/ win/lose/edit |
| `hook.useBulkAction` | react_hook | S-04.09 | `useBulkAction(pipelineId): mutate({ids, action, params})` |
| `ui.<KanbanBoard>` | react_component | S-04.06 | Props `{pipelineId: string}`, renderiza DragDropContext + StageColumns |
| `ui.<KanbanCard>` | react_component | S-04.07 | Props `{lead: Lead, isSelected: boolean, onSelect: (e) => void}` |
| `event.lead.stage_changed` | domain_event | S-04.01 | `event_log` com `payload: {lead_id, from_stage_id, to_stage_id, position_in_stage, by_user_id}` |
| `event.lead.won` | domain_event | S-04.02 | `payload: {lead_id, value_cents, closed_by_user_id}` |
| `event.lead.lost` | domain_event | S-04.02 | `payload: {lead_id, lost_reason, closed_by_user_id}` |

## 5. Stories (em ordem de dependência)

---

### S-04.01 — API `POST /api/v1/leads/[id]/move` com fractional indexing + P-01 + emit event

**Points**: 4 | **Priority**: P0 | **Deps**: (none) | **FR refs**: Spec 02 §2.4 §3, Spec 04 §6, Spec 09 §7.2, Regras P-01, P-05, P-08

#### Contexto

Endpoint canônico de drag-drop. Recebe `stage_id` destino + `position_in_stage` já calculado pelo client (midpoint). Server valida: (a) stage destino pertence ao mesmo `pipeline_id` do lead — se não, 422 `pipeline_immutable_use_clone` (P-01); (b) `expected_updated_at` casa com row atual — se não, 409 `lead_stage_changed_concurrent`. Emite `event.lead.stage_changed` em `event_log`. Trigger `fn_crm_lead_close_on_stage` (DB) cuida do auto won/lost — endpoint NÃO seta `status` manualmente.

#### Files to create
- `app/api/v1/leads/[id]/move/route.ts` — handler POST
- `lib/schemas/leads.ts` — `moveLeadSchema` (Zod) — se já não existir adicionar `MoveLeadInput`
- `lib/api/leads.ts` — `moveLead(id, input)` server-side helper

#### Files to modify
- `lib/types/leads.ts` — adicionar `Lead` shape canônico se ausente

#### Implementation steps (sequential)
1. Definir `moveLeadSchema = z.object({ stage_id: z.string().uuid(), position_in_stage: z.number(), expected_updated_at: z.string().datetime() })`
2. Handler valida JWT (Supabase server client), valida body com Zod (422 se falhar)
3. SELECT `crm_leads` por id + RLS — 404 se não encontrado
4. SELECT stage destino, comparar `pipeline_id` com `lead.pipeline_id` — 422 `pipeline_immutable_use_clone` se diferente
5. UPDATE `crm_leads SET stage_id=$1, position_in_stage=$2, updated_at=now() WHERE id=$3 AND updated_at=$expected_updated_at` — 0 rows → 409 `lead_stage_changed_concurrent` com `details.current_updated_at`
6. INSERT em `event_log` com `event_type='lead.stage_changed'`, payload completo
7. Retornar lead atualizado (após trigger ter rodado, então re-SELECT)

#### Acceptance Criteria

```gherkin
Given lead L1 está em stage S1 (pipeline P1)
When POST /api/v1/leads/L1/move com stage_id=S2 (pipeline P1), position=1500, expected_updated_at correto
Then 200 com lead.stage_id=S2, lead.position_in_stage=1500
And event_log tem 1 row event_type='lead.stage_changed'
```

```gherkin
Given lead L1 em pipeline P1
When POST /move com stage_id pertencente a P2
Then 422 com error.code='pipeline_immutable_use_clone'
```

```gherkin
Given lead L1 com updated_at=T0
When POST /move com expected_updated_at=T-1s (stale)
Then 409 com error.code='lead_stage_changed_concurrent' e details.current_updated_at presente
```

```gherkin
Given stage S_won tem is_won=true
When POST /move move lead L1 pra S_won
Then trigger fn_crm_lead_close_on_stage seta status='won', closed_at=now()
And response retorna lead com status='won'
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | Move válido retorna 200 | curl POST com body válido |
| t2 | api | Cross-pipeline retorna 422 | curl com stage de outro pipeline |
| t3 | api | OCC stale retorna 409 | duas requests concorrentes; 2ª é 409 |
| t4 | db | event_log row criada | SELECT count(*) FROM event_log WHERE event_type='lead.stage_changed' |
| t5 | db | Trigger auto-won funciona | move pra stage is_won=true → SELECT status FROM crm_leads = 'won' |
| t6 | rls | User org A não move lead de org B | request com user A em lead org B → 404 |

#### Architecture contracts emitted

```yaml
exposes:
  - type: api_route
    id: "POST /api/v1/leads/[id]/move"
    request_schema: "{ stage_id: uuid, position_in_stage: number, expected_updated_at: ISO8601 }"
    response_schema: "{ data: Lead }"
    error_codes: [validation_error, resource_not_found, pipeline_immutable_use_clone, lead_stage_changed_concurrent, forbidden_role]
  - type: domain_event
    id: "lead.stage_changed"
    payload_schema: "{ lead_id, from_stage_id, to_stage_id, position_in_stage, by_user_id }"
```

#### Decisões a registrar
- `expected_updated_at` é o mecanismo OCC canônico em mutations Pattern B — replicar em `useUpdateLead`
- Trigger é fonte única de verdade pra status; endpoints NUNCA setam `status='won'/'lost'` direto

#### Definition of Done
- [ ] ACs passam (Playwright + curl)
- [ ] `pnpm typecheck` zero erros novos
- [ ] `pnpm lint` zero erros novos
- [ ] Sem warnings no console
- [ ] Commit `feat(EPIC-04): leads move endpoint with OCC and event emit [wave 1]`
- [ ] Architecture contracts registrados no state file
- [ ] Regression: nada anterior quebra

---

### S-04.02 — API `POST /api/v1/leads/[id]/win` + `/lose` com P-03

**Points**: 3 | **Priority**: P0 | **Deps**: S-04.01 | **FR refs**: Spec 02 §3, Regra P-03

#### Contexto

Win/lose explícitos (botões dedicados na UI) movem o lead pra stage com `is_won=true` ou `is_lost=true` da pipeline. Lose **exige** `lost_reason` (P-03). Win é idempotente. Emite `event.lead.won`/`event.lead.lost`.

#### Files to create
- `app/api/v1/leads/[id]/win/route.ts`
- `app/api/v1/leads/[id]/lose/route.ts`
- `lib/schemas/leads.ts` — adicionar `loseLeadSchema = z.object({ lost_reason: z.string().min(1) })`

#### Implementation steps (sequential)
1. `/win`: SELECT stage com `is_won=true` da pipeline do lead → UPDATE lead com `stage_id`, `position_in_stage = max+1000` daquela stage
2. `/lose`: validar body com `loseLeadSchema` — 422 `lost_reason_required` se vazio; UPDATE lead seta `lost_reason`, depois move pra stage `is_lost=true`
3. Trigger DB completa `status` e `closed_at`
4. INSERT em `event_log` com event apropriado

#### Acceptance Criteria

```gherkin
Given lead L1 em stage open
When POST /api/v1/leads/L1/win
Then 200, lead.status='won', lead.closed_at preenchido
And event_log tem event_type='lead.won'
```

```gherkin
Given lead L1
When POST /lose com body {} (sem lost_reason)
Then 422 com error.code='lost_reason_required'
```

```gherkin
Given lead L1
When POST /lose com {lost_reason:'preço'}
Then 200, lead.status='lost', lead.lost_reason='preço'
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | Win retorna 200 + status='won' | curl |
| t2 | api | Lose sem reason → 422 | curl |
| t3 | api | Lose com reason → 200 + status='lost' | curl |
| t4 | db | event_log emit | SELECT |

#### Architecture contracts emitted

```yaml
exposes:
  - type: api_route
    id: "POST /api/v1/leads/[id]/win"
    request_schema: "{}"
    response_schema: "{ data: Lead }"
  - type: api_route
    id: "POST /api/v1/leads/[id]/lose"
    request_schema: "{ lost_reason: string (min 1) }"
    error_codes: [lost_reason_required, resource_not_found]
```

#### Definition of Done
- [ ] ACs passam
- [ ] Typecheck/lint clean
- [ ] Commit `feat(EPIC-04): win/lose endpoints with P-03 enforcement [wave 2]`

---

### S-04.03 — API `POST /api/v1/leads/bulk` com AT-06

**Points**: 3 | **Priority**: P0 | **Deps**: S-04.01 | **FR refs**: Spec 04 §6, Regra AT-06

#### Contexto

Bulk action server-side. `action` em `move|assign|tag|delete`. `lead_ids.length > 50` retorna 422 `bulk_too_large`. Operação é transacional: ou todos ou nenhum (BEGIN/COMMIT). Emite N events `lead.stage_changed`/`lead.assigned`/etc.

#### Files to create
- `app/api/v1/leads/bulk/route.ts`
- `lib/schemas/leads.ts` — `bulkActionSchema`

#### Implementation steps (sequential)
1. `bulkActionSchema = z.object({ lead_ids: z.array(z.string().uuid()).max(50), action: z.enum(['move','assign','tag','delete']), params: z.record(z.unknown()) }).refine(...)`
2. Se `lead_ids.length > 50` → 422 `bulk_too_large`
3. Switch por action: `move` exige `params.stage_id`; `assign` exige `params.owner_user_id`; `tag` exige `params.tags[]` + `params.mode: 'add'|'replace'|'remove'`; `delete` é hard delete (RLS protege cross-tenant)
4. Transação: BEGIN; UPDATE/DELETE; INSERT N events; COMMIT
5. Retornar `{ updated_count, failed: [{ id, reason }] }`

#### Acceptance Criteria

```gherkin
Given 51 leads selecionados
When POST /bulk com action='move'
Then 422 com error.code='bulk_too_large'
```

```gherkin
Given 30 leads válidos
When POST /bulk action='assign' params={owner_user_id:'U1'}
Then 200, todos têm owner_user_id=U1
And 30 events lead.assigned em event_log
```

```gherkin
Given 10 leads, 1 deles em outra org
When POST /bulk com action='delete'
Then o de outra org cai em failed[]; resto deletado
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | 51 → 422 | curl |
| t2 | api | move bulk válido | curl + SELECT |
| t3 | api | assign bulk | curl |
| t4 | api | tag add/replace/remove | curl |
| t5 | rls | cross-org filtrado | request user A com leads B |

#### Architecture contracts emitted

```yaml
exposes:
  - type: api_route
    id: "POST /api/v1/leads/bulk"
    request_schema: "{ lead_ids: uuid[] (max 50), action: 'move'|'assign'|'tag'|'delete', params: object }"
    response_schema: "{ updated_count: number, failed: { id, reason }[] }"
    error_codes: [bulk_too_large, validation_error]
```

#### Definition of Done
- [ ] ACs passam
- [ ] Commit `feat(EPIC-04): bulk action endpoint with AT-06 limit [wave 3]`

---

### S-04.04 — Hook `useBoard(pipelineId)` query inicial + realtime

**Points**: 4 | **Priority**: P0 | **Deps**: S-04.01 | **FR refs**: Spec 04 §4.4, Spec 09 §6

#### Contexto

Hook que consolida `crm_pipelines` (com stages) + `crm_leads` filtrados em UMA query (Supabase com `select('*, stages:crm_stages(*), leads:crm_leads(*)')`) + subscribe ao canal `kanban-{pipeline_id}` que reflete INSERT/UPDATE/DELETE em `crm_leads`. Eventos realtime atualizam `qc.setQueryData(['board', pipelineId])` sem refetch (otimização).

#### Files to create
- `hooks/realtime/useBoard.ts`
- `lib/realtime/channels.ts` — adicionar `kanbanChannel(pipelineId)` factory se ausente

#### Files to modify
- `lib/types/leads.ts` — exportar `BoardData = { pipeline, stages: Stage[], leads: Lead[] }`

#### Implementation steps (sequential)
1. `useBoard(pipelineId)` usa `useQuery({ queryKey: ['board', pipelineId], queryFn: ... })` — fetch via Supabase browser client
2. `useEffect` registra `useRealtimeChannel({ channel: 'kanban-{pipelineId}', table: 'crm_leads', filter: 'pipeline_id=eq.{pipelineId}' })`
3. Handler INSERT: `qc.setQueryData(['board', pipelineId], (prev) => { ...prev, leads: [...prev.leads, newLead] })`
4. Handler UPDATE: substituir lead por id
5. Handler DELETE: remover lead por id
6. Cleanup: `removeChannel` no unmount

#### Acceptance Criteria

```gherkin
Given user abre /app/pipelines/P1
When useBoard('P1') executa
Then qc.getQueryData(['board','P1']) tem stages ordenadas + leads agrupados
```

```gherkin
Given user A está vendo board
When user B (mesma org) move um card via API
Then realtime UPDATE chega e UI atualiza sem refresh em <1s
```

```gherkin
Given user navega pra outra rota
When componente desmonta
Then canal kanban-{pipelineId} é removido (Supabase getChannels() não tem zumbi)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Board renderiza após query | Playwright + screenshot |
| t2 | realtime | Cross-tab update propaga | Playwright 2 contexts |
| t3 | cleanup | Sem zumbi no unmount | `supabase.getChannels().length` antes/depois |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_hook
    id: "useBoard"
    signature: "(pipelineId: string) => UseQueryResult<BoardData>"
    file: "hooks/realtime/useBoard.ts"
  - type: realtime_channel
    id: "kanban-{pipeline_id}"
    table: "crm_leads"
    filter: "pipeline_id=eq.{pipeline_id}"
```

#### Definition of Done
- [ ] ACs passam
- [ ] Commit `feat(EPIC-04): useBoard hook with realtime [wave 4]`

---

### S-04.05 — Hook `useMoveCard` + `useUpdateLead` com Pattern B

**Points**: 4 | **Priority**: P0 | **Deps**: S-04.01, S-04.04 | **FR refs**: Spec 09 §7.2

#### Contexto

Pattern B canônico (Spec 09 §7.2): `onMutate` cancela queries, snapshot, aplica optimistic; `mutationFn` chama `apiClient.post('/api/v1/leads/:id/move', ..., { idempotencyKey: 'move-{leadId}-{expected}' })`; `onError` rollback via snapshot + toast; `onSuccess` substitui pelo retorno real; em 409 `lead_stage_changed_concurrent` força rollback + invalidate. `useUpdateLead` é o irmão genérico p/ win/lose/edit.

#### Files to create
- `hooks/data/useMoveCard.ts`
- `hooks/data/useUpdateLead.ts`
- `lib/utils/fractional-index.ts` — `computeMidpoint(qc, pipelineId, stageId, toIndex): number` (regra P-05; se `prev` ausente: `next - 1`; se `next` ausente: `prev + 1`)

#### Implementation steps (sequential)
1. `computeMidpoint` lê snapshot do `['board', pipelineId]` no QC, encontra leads da stage destino ordenados por `position_in_stage`, retorna midpoint
2. `useMoveCard(pipelineId)`: `useMutation<Lead, ApiError, MoveVars, { snapshot }>` com `onMutate` que cancela queries e aplica patch otimista no array de leads
3. `onError`: se `error.code === 'lead_stage_changed_concurrent'` → restore snapshot + `qc.invalidateQueries(['board', pipelineId])` + `toast.warning("Card foi movido por outro usuário. Atualizando...")`; outros erros → snapshot restore + toast destructive
4. `onSuccess`: substitui o lead otimista pelo `data` retornado
5. `useUpdateLead`: padrão similar mas genérico (`mutate({id, patch, expectedUpdatedAt})`)

#### Acceptance Criteria

```gherkin
Given board renderizado com lead L1 em stage S1
When usuário arrasta L1 pra S2
Then UI mostra L1 em S2 ANTES da resposta (optimistic)
And depois confirma com server
```

```gherkin
Given outro user moveu L1 antes
When eu tento mover (expected_updated_at stale)
Then API retorna 409
And UI rollback: L1 volta pra posição original
And toast warning aparece
And board é invalidado
```

```gherkin
Given drag pra stage de outra pipeline (corner case via dev tools)
When mutation dispara
Then API retorna 422 pipeline_immutable_use_clone
And UI rollback + toast destructive
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Optimistic visual | Playwright drag + screenshot intermediário |
| t2 | rollback | 409 rollback | mock fetch 409, verificar DOM volta |
| t3 | midpoint | computeMidpoint correto | unit test com QC sintético |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_hook
    id: "useMoveCard"
    signature: "(pipelineId: string) => UseMutationResult<Lead, ApiError, MoveVars>"
  - type: react_hook
    id: "useUpdateLead"
    signature: "() => UseMutationResult<Lead, ApiError, { id, patch, expectedUpdatedAt }>"
```

#### Decisões a registrar
- `idempotencyKey` em moves: `move-{leadId}-{expectedUpdatedAt}` — garante retry após timeout não duplica

#### Definition of Done
- [ ] ACs passam
- [ ] Commit `feat(EPIC-04): useMoveCard with Pattern B optimistic + rollback [wave 5]`

---

### S-04.06 — `<KanbanBoard>` com `@hello-pangea/dnd`

**Points**: 4 | **Priority**: P0 | **Deps**: S-04.04, S-04.05 | **FR refs**: Spec 04 §6, Regra P-07

#### Contexto

Componente raiz da tela `/app/pipelines/[id]`. Usa `<DragDropContext onDragEnd={...}>` do `@hello-pangea/dnd`. Renderiza N `<StageColumn>` (uma por stage do pipeline, ordenadas por `order_index`). Cada coluna tem `<Droppable droppableId={stage.id}>` e mapeia leads filtrados via `<Draggable>`. `onDragEnd` chama `useMoveCard.mutate(...)`. Vocabulary via `usePipelineVocabulary(pipelineId)` (P-07).

#### Files to create
- `app/(app)/pipelines/[pipelineId]/page.tsx` — server component que valida user + renderiza client `<KanbanBoard>`
- `components/kanban/KanbanBoard.tsx` (`"use client"`)
- `components/kanban/StageColumn.tsx`

#### Files to modify
- `app/(app)/layout.tsx` — adicionar link sidebar "Pipelines" se ausente

#### Implementation steps (sequential)
1. Server page valida `pipelineId` pertence à org do user
2. `<KanbanBoard pipelineId={...}>` chama `useBoard(pipelineId)` + `usePipelineVocabulary(pipelineId)`
3. Render skeleton enquanto isLoading; error boundary se erro
4. `<DragDropContext onDragEnd={handleDragEnd}>`
5. `handleDragEnd`: extrai `source`, `destination`; se null/igual → no-op; senão chama `moveCard.mutate({leadId: draggableId, toStageId: destination.droppableId, toIndex: destination.index, expectedUpdatedAt: lead.updated_at})`
6. `<StageColumn>` recebe `stage`, `leads` filtrados (usa filter context da S-04.08), `vocabulary`
7. Vocabulary aplicada em headers e botões: `vocabulary.lead`, `vocabulary.deal`, etc.

#### Acceptance Criteria

```gherkin
Given pipeline P1 com 4 stages e 12 leads
When user abre /app/pipelines/P1
Then vê 4 colunas + 12 cards distribuídos
And rótulo da coluna usa vocabulary.stage_name (P-07)
```

```gherkin
Given board renderizado
When user arrasta card de S1 pra S2 entre 2º e 3º card
Then card aparece na posição visual esperada
And useMoveCard.mutate é chamado com toIndex=2
```

```gherkin
Given drag cancelado (drop fora de droppable)
When solta
Then nada muda
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Renderiza colunas + cards | Playwright snapshot |
| t2 | dnd | Drag entre stages dispara mutation | Playwright drag + intercept fetch |
| t3 | a11y | DragDropContext anuncia via ARIA | axe-core scan |
| t4 | vocab | Headers usam vocabulary | Playwright text content vs DB |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_component
    id: "<KanbanBoard>"
    props: "{ pipelineId: string }"
    file: "components/kanban/KanbanBoard.tsx"
  - type: route
    id: "/app/pipelines/[pipelineId]"
```

#### Definition of Done
- [ ] ACs passam
- [ ] Commit `feat(EPIC-04): KanbanBoard with @hello-pangea/dnd [wave 6]`

---

### S-04.07 — `<KanbanCard>` com metadados completos

**Points**: 3 | **Priority**: P0 | **Deps**: S-04.06 | **FR refs**: Spec 04 §6

#### Contexto

Card visual: title (lead.title), value formatado em BRL via `formatCurrency`, owner avatar (foto + nome no tooltip), até 3 tags (resto vira `+N`), badge "atrasado" se `expected_close_date < today` e status='open', `last_activity_at` em formato relativo (`formatDistanceToNow`, locale pt-BR).

#### Files to create
- `components/kanban/KanbanCard.tsx`
- `lib/utils/format.ts` — adicionar `formatCurrency(cents, currency)`, `formatRelativeDate(date)` se ausentes

#### Implementation steps (sequential)
1. Props `{ lead: Lead, isSelected: boolean, onSelect: (e: MouseEvent) => void }`
2. Card via shadcn `<Card>` com cursor-grab
3. Layout: title (truncate 2 lines), value (right-aligned), avatar + tags + badge atrasado
4. Tags: slice(0, 3); se `tags.length > 3` mostrar `+{n}` badge
5. Badge atrasado: condicional, vermelho/destructive variant
6. `last_activity_at`: muted text, `formatDistanceToNow` pt-BR

#### Acceptance Criteria

```gherkin
Given lead com value_cents=150000, currency='BRL'
When card renderiza
Then mostra "R$ 1.500,00"
```

```gherkin
Given lead com 5 tags
When card renderiza
Then mostra 3 tags + badge "+2"
```

```gherkin
Given lead com expected_close_date ontem e status='open'
When card renderiza
Then badge "Atrasado" visível em variant destructive
```

```gherkin
Given lead com last_activity_at = 30min atrás
When card renderiza
Then mostra "há 30 minutos" (pt-BR)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Currency BR | Playwright text |
| t2 | ui | Tags overflow | render com 5 tags |
| t3 | ui | Badge atrasado condicional | render com 2 datas |
| t4 | a11y | Avatar tem alt text | axe-core |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_component
    id: "<KanbanCard>"
    props: "{ lead: Lead, isSelected: boolean, onSelect: (e) => void }"
```

#### Definition of Done
- [ ] ACs passam
- [ ] Commit `feat(EPIC-04): KanbanCard component [wave 7]`

---

### S-04.08 — Filter bar (owner, status, tag, search, value range, overdue)

**Points**: 3 | **Priority**: P1 | **Deps**: S-04.06 | **FR refs**: Spec 04 §6

#### Contexto

Barra superior do Kanban com 6 filtros que operam **client-side** sobre `useBoard.data.leads`. Search é ILIKE em title (case-insensitive substring). Filtros acumulam (AND). Estado do filtro persiste em URL search params (shareable).

#### Files to create
- `components/kanban/KanbanFilterBar.tsx`
- `hooks/kanban/useBoardFilters.ts` — sincroniza com URL via `useSearchParams`

#### Files to modify
- `components/kanban/KanbanBoard.tsx` — consumir filters, passar leads filtrados pra StageColumns

#### Implementation steps (sequential)
1. `useBoardFilters()` retorna `{ filters, setFilter, clearFilters }`, sincroniza com `searchParams`
2. Filter bar com: owner select (popover com lista de members), status (open/won/lost), tag multi-select, search input, value range (min/max), overdue toggle
3. `applyFilters(leads, filters)` pure function exportada
4. Indicator visual de filtros ativos + botão "Limpar"

#### Acceptance Criteria

```gherkin
Given board com 50 leads
When user filtra owner=U1
Then mostra apenas leads de U1
And URL contém ?owner=U1
```

```gherkin
Given filtros owner=U1 + status=open
When user limpa
Then URL volta a /app/pipelines/P1 sem params
```

```gherkin
Given user digita "café" no search
Then leads cujo title contém "café" (case-insensitive) ficam visíveis
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Filtros aplicam | Playwright + count cards |
| t2 | url | Sync URL | navegação direta com ?owner=X |
| t3 | unit | applyFilters pure | vitest |

#### Definition of Done
- [ ] ACs passam
- [ ] Commit `feat(EPIC-04): kanban filter bar with URL sync [wave 8]`

---

### S-04.09 — Bulk actions UI (multi-select Cmd+click)

**Points**: 3 | **Priority**: P1 | **Deps**: S-04.03, S-04.07 | **FR refs**: Spec 04 §6, Regra AT-06

#### Contexto

Multi-select via Cmd/Ctrl+click em `<KanbanCard>`. Estado `selectedIds: Set<string>` no `<KanbanBoard>`. Quando `size > 0`, renderiza `<BulkActionBar>` flutuante (bottom-fixed) com count + ações (move stage / assign owner / add tag / delete). Limite de 50 enforced no client (botão disabled + tooltip) **e** no server (AT-06 retorna 422).

#### Files to create
- `components/kanban/BulkActionBar.tsx`
- `hooks/data/useBulkAction.ts`

#### Files to modify
- `components/kanban/KanbanBoard.tsx` — gerenciar `selectedIds` state
- `components/kanban/KanbanCard.tsx` — aceitar `isSelected` + `onSelect`

#### Implementation steps (sequential)
1. `KanbanBoard` mantém `selectedIds: Set<string>` em `useState`
2. Card click handler: se Cmd/Ctrl, toggle no set; senão (no-op no card; click normal abre detalhes — fora do escopo aqui)
3. `<BulkActionBar selectedCount onAction />` com 4 botões + dropdown de stages/owners/tags
4. Botão "Aplicar" desabilitado se count > 50; tooltip "Selecione até 50 (AT-06)"
5. `useBulkAction(pipelineId).mutate({ids, action, params})` com optimistic invalidate de board
6. Toast com `updated_count` e `failed.length` no sucesso

#### Acceptance Criteria

```gherkin
Given board renderizado
When user Cmd+click em 3 cards
Then BulkActionBar aparece com "3 selecionados"
```

```gherkin
Given 51 cards selecionados (forçado via dev)
When user tenta aplicar bulk
Then botão "Aplicar" disabled com tooltip AT-06
```

```gherkin
Given 10 cards selecionados, action=assign user U1
When clica Aplicar
Then todos passam a owner=U1 (visual)
And toast "10 leads atribuídos"
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Cmd+click acumula | Playwright keyboard |
| t2 | ui | BulkActionBar aparece | screenshot |
| t3 | api | Server 422 em 51 | mock fetch |
| t4 | unit | Set ops corretas | vitest |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_hook
    id: "useBulkAction"
    signature: "(pipelineId: string) => UseMutationResult"
```

#### Definition of Done
- [ ] ACs passam
- [ ] Commit `feat(EPIC-04): bulk actions UI with multi-select [wave 9]`

---

### S-04.10 — Reposicionamento global manual (manager+) quando precisão decimal degrada

**Points**: 3 | **Priority**: P2 | **Deps**: S-04.01, S-04.06 | **FR refs**: Regra P-05, Spec 02 §2.4

#### Contexto

Fractional indexing degrada após ~20 níveis de bisseção (drift de precisão `numeric` em moves consecutivos no mesmo gap). Quando `max(abs(p_i - p_{i-1}))` na stage é menor que `1e-9` (ou contagem de drags consecutivos no mesmo intervalo > threshold), oferecer ao usuário com role `manager`+ um botão "Renormalizar posições" que dispara endpoint `POST /api/v1/pipelines/[id]/renormalize` que reordena todas as posições em múltiplos de 1000 numa transação.

#### Files to create
- `app/api/v1/pipelines/[id]/renormalize/route.ts` — manager+ only
- `components/kanban/RenormalizeBanner.tsx`
- `hooks/kanban/usePositionPrecisionWatch.ts` — detecta degradação

#### Files to modify
- `components/kanban/KanbanBoard.tsx` — render banner condicionalmente

#### Implementation steps (sequential)
1. API valida role >= manager via `usePermission` server-side; SELECT leads ordenados por stage_id, position; UPDATE numa transação setando `position_in_stage = 1000 * (rank - 1)` por stage; INSERT event_log `pipeline.positions_renormalized`
2. `usePositionPrecisionWatch(boardData)`: para cada stage, calcula menor diff entre posições consecutivas; se < 1e-9 → flag `needsRenormalize=true`
3. Banner amarelo no topo do board "Reposicionamento recomendado pra performance. [Renormalizar agora]" — visível apenas pra manager+
4. Click → confirm dialog → `POST /renormalize` → toast sucesso → `invalidateQueries(['board', pipelineId])`

#### Acceptance Criteria

```gherkin
Given stage com 3 leads de positions 1000.0000000001, 1000.0000000002, 1000.0000000003
When useBoard carrega
Then banner aparece pra manager+
```

```gherkin
Given banner visível
When manager clica "Renormalizar"
Then todas as positions viram múltiplos de 1000 (0, 1000, 2000, ...)
And event_log tem pipeline.positions_renormalized
```

```gherkin
Given user com role atendente (não manager)
When board carrega com precisão degradada
Then banner NÃO aparece
```

```gherkin
Given user atendente tenta POST /renormalize via curl
Then 403 forbidden_role
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | Renormalize transacional | seed degradado, POST, SELECT |
| t2 | api | Atendente → 403 | curl com token atendente |
| t3 | ui | Banner pra manager | Playwright como manager |
| t4 | ui | Banner oculto pra atendente | Playwright como atendente |
| t5 | unit | Watch detecta degradação | vitest |

#### Architecture contracts emitted

```yaml
exposes:
  - type: api_route
    id: "POST /api/v1/pipelines/[id]/renormalize"
    request_schema: "{}"
    response_schema: "{ updated_count: number }"
    error_codes: [forbidden_role]
  - type: domain_event
    id: "pipeline.positions_renormalized"
```

#### Definition of Done
- [ ] ACs passam
- [ ] Commit `feat(EPIC-04): position renormalization for manager+ [wave 10]`
- [ ] Architecture contracts registrados
- [ ] Regression suite cumulativo passa

---

## 6. Regression Suite Cumulativo (esperado ao final)

| Categoria | # de tests | Origem |
|---|---|---|
| UI rendering | 8 | S-04.06, S-04.07, S-04.08, S-04.09, S-04.10 |
| API contracts | 14 | S-04.01 (6), S-04.02 (4), S-04.03 (5), S-04.10 (2) |
| RLS isolation | 4 | S-04.01, S-04.03, S-04.04, S-04.10 |
| Realtime updates | 2 | S-04.04 |
| Optimistic UI rollback | 3 | S-04.05 |
| Triggers DB | 3 | S-04.01 (auto won/lost), S-04.02 |
| **Total** | **34** | |

## 7. Riscos & Mitigações específicos do epic

| Risco | Severidade | Mitigação |
|---|---|---|
| Fractional indexing precisão decimal degrada após muitos drags | Média | S-04.10 fornece renormalização manager+; watch detecta automaticamente |
| Race condition em moves concorrentes | Alta | OCC via `expected_updated_at` (S-04.01) + Pattern B rollback (S-04.05) |
| Drag-drop com leitor de tela | Média | `@hello-pangea/dnd` tem ARIA built-in; QA com axe-core obrigatório |
| Bulk action de 50 demora demais e UI trava | Média | Server processa em transação rápida; loading state + toast progressivo |
| Realtime channel zumbi após navegação | Alta | `useRealtimeChannel` cleanup canônico (EPIC-00); test de cleanup em S-04.04 |
| Vocabulary inconsistente (string hardcoded em PT) | Baixa | Linter `eslint-plugin-deskcomm/no-hardcoded-pt-in-kanban` (regra P-07) — adicionar em S-04.06 se ausente |

## 8. Decisões arquiteturais novas que este epic introduz

- **ADR-04.1**: `expected_updated_at` é o mecanismo OCC canônico em mutations Pattern B no produto inteiro (não apenas leads). Replicar em outros endpoints stateful.
- **ADR-04.2**: Triggers DB são fonte única de verdade pra `crm_leads.status`. Endpoints API NUNCA setam `status='won'/'lost'` diretamente — sempre via move pra stage com flag.
- **ADR-04.3**: Fractional indexing usa `numeric` com gap inicial de 1000; renormalização é operação manager+ explícita, não automática (evita race com moves em voo).
- **ADR-04.4**: Filtros do Kanban são client-side sobre `useBoard.data` (não server-side). Isto limita o board a ~5000 leads em memória; acima disso, paginação por stage será introduzida em epic futuro.
- **ADR-04.5**: `idempotencyKey` em moves usa formato `move-{leadId}-{expectedUpdatedAt}` — replicar padrão `{action}-{entityId}-{occToken}` em outras mutations Pattern B.

## 9. Anexos

- Screen flow refs: `docs/design-system/screen-flow/03-screen-inventory.md` rota `/app/pipelines/[id]`
- Specs refs: 02 §2.4 (crm_leads), 02 §3 (triggers), 04 §6 (Kanban), 09 §7.2 (Pattern B), 09 §6 (Realtime registry)
- Business rules: P-01, P-02, P-03, P-04, P-05, P-06, P-07, P-08, AT-06
- Reconciliation log: pendente `R-04.1` se ADR-04.1 (expected_updated_at canônico) precisar ser propagado em Spec 09

---

## ✅ Wave Completion Log

Concluído em 2026-04-28 via Mode A inline orchestration. Combo splits:
- Combo-A: API endpoints (waves 1-3)
- Combo-B: Hooks + components (waves 4-7)
- Combo-C: Filters + bulk + page + seed (waves 8-10)

| Wave | Story | Status | Commit |
|------|-------|--------|--------|
| 1 | S-04.01 leads/move endpoint (OCC + P-01 + emit) | ✅ | `69db4f5` |
| 2 | S-04.02 win/lose endpoints (P-02 + P-03) | ✅ | `69db4f5` |
| 3 | S-04.03 bulk action endpoint (AT-06) | ✅ | `69db4f5` |
| 4 | S-04.04 useBoard + realtime kanban-{pipelineId} | ✅ | `ee2d542` |
| 5 | S-04.05 useMoveCard Pattern B (optimistic + 409 rollback) | ✅ | `ee2d542` |
| 6 | S-04.06 KanbanBoard + StageColumn (@hello-pangea/dnd) | ✅ | `ee2d542` |
| 7 | S-04.07 KanbanCard + actions + LoseLeadDialog | ✅ | `ee2d542` |
| 8 | S-04.08 FilterBar + applyFilters | ✅ | `29c5ee6` |
| 9 | S-04.09 BulkActionBar + useBulkAction | ✅ | `29c5ee6` |
| 10 | S-04.10 Pipeline page + picker + seed | ✅ | `29c5ee6` |

### Seed data (org `deskcomm-admin`)
- Pipeline `Pedidos` (já existia via trigger org-init); 8 stages canônicos
- 12 leads inseridos via Supabase MCP: 10 open (varied stages) + 1 won + 1 lost
- Lost reason canônica: `cancelled_by_customer` (do enum DB trigger)

### Architecture contracts emitted
- `api.POST /api/v1/leads/[id]/move` — body `{stage_id, position_in_stage, expected_updated_at}` → 200/404/409/422
- `api.POST /api/v1/leads/[id]/win` — idempotent
- `api.POST /api/v1/leads/[id]/lose` — exige `lost_reason` ∈ enum canônico ou pipeline.settings.lost_reasons
- `api.POST /api/v1/leads/bulk` — discriminated union move|assign|tag|delete, max 50
- `realtime.kanban-{pipeline_id}` — postgres_changes em `crm_leads` filtrado por pipeline_id
- `hook.useBoard`, `useMoveCard`, `useWinLead`, `useLoseLead`, `useBulkAction`
- `ui.<KanbanBoard>`, `<StageColumn>`, `<KanbanCard>`, `<KanbanCardActions>`, `<LoseLeadDialog>`, `<FilterBar>`, `<BulkActionBar>`
- `event.lead.stage_changed`, `lead.won`, `lead.lost`, `lead.bulk_moved/assigned/tagged/deleted` (em `event_log` via `emit_event`)
- Const exportada: `CANONICAL_LOST_REASONS` em `lib/schemas/leads.ts`

### Decisões registradas
- D-04.01: `expected_updated_at` é mecanismo OCC canônico em mutations Pattern B
- D-04.02: Trigger `fn_crm_lead_close_on_stage` é fonte única pra status; endpoints NUNCA setam status='won'/'lost' direto
- D-04.03: lost_reason validado por DB trigger contra enum canônico + pipeline.settings.lost_reasons jsonb extension
- D-04.04: Selection state vive na página, não no KanbanBoard (Combo-C lifted state pra wirar BulkActionBar)
- D-04.05: NaN do midpoint silenciosamente aborta o move (rebalance global = follow-up)

### Pendências / Follow-ups
- Global rebalance quando precisão decimal degrada (>20 níveis) — placeholder em `fractional-indexing.ts`
- Owner dropdown em FilterBar lista só "Todos / Sem responsável / Eu" (precisa endpoint de membros do org — vem em EPIC-09)
- usePipelineVocabulary hook ainda não consumido em UI (StageColumn poderia usar p/ rotular won/lost)
