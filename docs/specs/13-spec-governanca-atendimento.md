# Spec 13 — Governança de Atendimento (fechamento de lacunas)

> Status: esqueleto aprovado — §3/§4/§5 detalhados pelas features G1-04/G1-05/G1-06;
> apêndices A/B preenchidos por G1-03/G1-04.
> Construída pelo **gov-loop** (`plan/features.json`, fases em `plan/phases.md`).
> Complementa — **não duplica** — a `04-spec-pipeline-attendance.md` (claim atômico
> AT-02, fila/round-robin AT-03, supervisor read-only AT-04, status/heartbeat AT-08,
> ReassignDialog, bulk-assign §6.5) e a `05-spec-ai-rag-handoff.md` (handoff IA).
> Doutrina soberana: `CLAUDE.md` do repo (multi-tenancy, migrations em tripla,
> idempotência, RBAC, LGPD, anti-patterns).

## 1. Problema e origem

Governança de atendimento é o conjunto: **quem pode ver o quê** (RBAC + escopo),
**quem atende quem** (atribuição), **como muda de mão** (transferência/assumir,
auditado), **como chega a uma mão** (roteamento + fila + horário), **como se
categoriza** (tags), e **como um agente de IA participa disso** (assignee de
1ª classe + contrato externo).

O backlog nasce de 7 eixos de dor extraídos de feedbacks reais de usuários do
sistema-modelo (TomikCRM), **abstraídos por tema — zero PII neste repo**:

| Eixo | Dor observada no sistema-modelo | Fase que fecha |
|---|---|---|
| 1. RBAC | Atendente com privilégios de owner; nível de acesso não-editável pós-atribuição; enforcement só no frontend | G2 |
| 2. Atribuição | Lead/conversa sem registro de quem atende; card sem responsável; sem campo na importação em massa | G3 |
| 3. Transferência | Assumir/transferir com erro, sem auditoria | G3 |
| 4. Roteamento | Sem fila, sem horário por atendente, sem modo configurável, sem painel | G5 |
| 5. Escopo | "Select sem where": atendente vê tudo; métricas sem filtro por responsável | G4 |
| 6. Handoff IA | IA não sabe direcionar para humano disponível/fila | G6 (+ fase FG do Vendaval) |
| 7. Tags | Origem/categoria/etiquetas ausentes ou não-filtráveis | G3 |

**Anti-padrões declarados** (lições do sistema-modelo — proibidos aqui):
1. UI de atribuição antes do modelo de dados normalizado.
2. Enforcement de RBAC atrás de feature-flag default-off (matriz vira decoração).
3. Escopo só no frontend (a RLS é a fronteira; a matriz na rota é a segunda linha).

## 2. O que já existe (não reimplementar)

Do baseline (`supabase/baseline.sql`) e das specs 04/05 — inventário completo com
evidência `arquivo:linha` no **Apêndice B** (G1-04):

- `user_organizations.role` CHECK `viewer|agent|manager|admin` + helpers
  `fn_user_org_ids()` / `fn_user_role_in_org()` / `fn_role_at_least()`.
- `conversations.assigned_to_user_id`, `assigned_at`, `unread_count_for_assignee`,
  status (`claimed`, `ai_handling`…), `bot_silenced_until`, `last_handoff_*`.
- `contacts.is_blocked` / `force_human` / `tags text[]`; `crm_leads.owner_user_id`
  + `tags text[]`; `crm_stages.requires_human`.
- Claim atômico (spec 04 §9: UPDATE condicional + 409), fila de não-atribuídas
  (§8.3), status do atendente (§8.1-8.2), supervisor read-only (§10).
- 13 MCP tools org-scoped incl. `crm_request_human_handoff`, `crm_move_lead_stage`.
- `event_log` + padrão worker com claim transacional (trigger nunca faz HTTP).
- `api_audit_log` append-only.

## 3. Modelo de dados alvo (rascunho — G1-05 detalha com DIRC)

Estruturas novas previstas (DDL rascunho + justificativa DIRC por tabela em G1-05):

- **`conversation_assignment_events`** — auditoria de toda mudança de dono:
  `(org_id, conversation_id, from_user_id?, to_user_id?, changed_by, reason
  claim|transfer|release|routing|handoff, created_at)`. Fonte da história de
  atendimento; RLS org.
- **`conversations.assignee_kind`** (`'user'|'ai'`) — unifica `ai_handling` com
  assignment: quem atende é humano OU a IA, nunca ambíguo. Handoff = reassignment
  auditado (`reason=handoff`). Conversa `kind='user'` ⇒ bot vetado
  (determinístico, mesma família de `force_human`).
- **`conversations.tags text[]`** — mesmo padrão de contacts/leads (Reuse).
- **`attendant_availability`** — `(org_id, user_id, is_available, capacity,
  schedule jsonb tz-aware)`; persiste o status/heartbeat da spec 04 §8.
- **`organizations.settings.routing`** — `{mode: manual|round_robin|load, knobs…}`;
  knobs nunca constantes hardcoded.
- **`organizations.settings.visibility_mode`** — `'all'|'own_and_unassigned'|'own'`
  para o role `agent` (default: decisão G1-06a).

## 4. Matriz role×recurso (G1-05 preenche; G1-06 fecha os PENDENTEs)

Formato: célula = `{none|own|org}` × `{read|write}`.

| Recurso | viewer | agent | manager | admin |
|---|---|---|---|---|
| conversations/messages | org:read (PENDENTE G1-06a) | own*:read+write | org:read+write | org:read+write |
| contacts | … | … | … | … |
| crm_leads | … | own (PENDENTE) | org | org |
| pipelines (config) | none | none | org:write | org:write |
| settings/api_tokens/billing | none | none | PENDENTE | org:write |
| team (papéis) | none | none | none | org:write |
| audit | none | none | org:read | org:read |
| métricas individuais | none | own (PENDENTE G1-06e) | org | org |

Enforcement em **duas camadas obrigatórias**: RLS (fronteira) + helper único de
rota (`require-role`) — nunca só UI (anti-padrão 3).

## 5. Roteamento (G1-06b/G5 fecham)

- Modos: `manual` (só claim/atribuição humana), `round_robin` (rodízio entre
  elegíveis), `load` (menor carga). Elegível = disponível ∧ dentro do horário ∧
  abaixo da capacidade.
- Mecânica: evento `conversation.routing_requested` no `event_log`; worker
  consome com claim + dedup (at-least-once seguro: conversa que já tem dono nunca
  é reatribuída pelo replay).
- Sem elegível ⇒ fila (visível, com posição) + re-agenda com backoff.

## 6. Métricas por responsável (G4-04 define antes do código)

Definições escritas aqui ANTES da implementação: leads ganhos/perdidos por owner,
conversas atendidas por assignee, tempo até 1ª resposta. Filtro por responsável
em todo funil; visão individual para manager+.

## 7. Contrato para agentes externos (G6 → spec 14)

A superfície que o Vendaval (e qualquer agente externo) consome nasce na fase G6
e é documentada em `docs/specs/14-contrato-governanca-agentes-externos.md`
(estilo edge-contract: autocontido, refs `arquivo:linha`, proibições explícitas).
Aprovação do checkpoint G6 é o gatilho da fase FG do Vendaval.

---

## Apêndice A — Invariantes de governança (G1-03)

Suíte executável em `tests/invariants/gov-*.test.ts` (1 arquivo por eixo),
rodada por `pnpm test:invariants` (mesmo harness Postgres descartável do
`pnpm test:db` — `scripts/test-db.sh`). Gap conhecido = `it.fails` com
comentário `GAP(Gx)`: passa enquanto o gap existe; quando a fase corrigir, o
`it.fails` quebra e obriga o flip para teste normal (catraca). Isolamento RLS
entre orgs (pré-requisito de tudo) já é coberto por
`tests/invariants/rls-isolation.test.ts` (G1-02).

| Eixo | Invariante (arquivo → teste) | Status |
|---|---|---|
| 1. RBAC | `gov-1-rbac.test.ts` → "fn_role_at_least ordena viewer < agent < manager < admin" | passa |
| 1. RBAC | `gov-1-rbac.test.ts` → "fn_user_role_in mapeia viewer→1, agent→2, manager→3, admin→4" | passa |
| 1. RBAC | `gov-1-rbac.test.ts` → "RLS impede agent de se auto-promover (user_orgs_update é admin-only)" | passa |
| 1. RBAC | `gov-1-rbac.test.ts` → "role de membro é editável via API — PATCH /api/v1/team/[user_id]/role existe" (gap do plano JÁ fechado pelo EPIC-09) | passa |
| 1. RBAC | `gov-1-rbac.test.ts` → "agent NÃO escreve config de pipeline (spec 13 §4: manager+)" | GAP G2 |
| 1. RBAC | `gov-1-rbac.test.ts` → "viewer NÃO escreve em conversations (spec 13 §4: viewer é read-only)" | GAP G2 |
| 2. Atribuição | `gov-2-assignment.test.ts` → "conversations tem assigned_to_user_id + assigned_at, com FK para auth.users" | passa |
| 2. Atribuição | `gov-2-assignment.test.ts` → "crm_leads tem owner_user_id" | passa |
| 2. Atribuição | `gov-2-assignment.test.ts` → "mudança de owner em crm_leads emite lead.assigned no event_log" | passa |
| 3. Transferência | `gov-3-transfer.test.ts` → "claim atômico: UPDATE condicional atribui 1x; segundo claim concorrente perde" | passa |
| 3. Transferência | `gov-3-transfer.test.ts` → "transferência é auditada: tabela conversation_assignment_events existe" | GAP G3 |
| 4. Roteamento/fila | `gov-4-routing.test.ts` → "índice parcial idx_conversations_open_unassigned existe (base da fila)" | passa |
| 4. Roteamento/fila | `gov-4-routing.test.ts` → "disponibilidade por atendente: tabela attendant_availability existe" | GAP G5 |
| 5. Escopo | `gov-5-visibility-scope.test.ts` → "agent vê conversa atribuída a si mesmo (controle positivo)" | passa |
| 5. Escopo | `gov-5-visibility-scope.test.ts` → "agent NÃO vê conversa atribuída a outro agent (spec 13 §4: own*)" | GAP G4 |
| 6. Handoff IA | `gov-6-ai-handoff.test.ts` → "colunas de handoff do estado atual existem (bot_silenced_until, last_handoff_*, force_human)" | passa |
| 6. Handoff IA | `gov-6-ai-handoff.test.ts` → "status 'ai_handling' é aceito pelo check de conversations.status" | passa |
| 6. Handoff IA | `gov-6-ai-handoff.test.ts` → "conversations.assignee_kind ('user'\|'ai') existe" | GAP G6 |
| 7. Tags | `gov-7-tags.test.ts` → "contacts.tags e crm_leads.tags existem com índice GIN" | passa |
| 7. Tags | `gov-7-tags.test.ts` → "conversations.tags text[] existe" | GAP G3 |

## Apêndice B — Auditoria spec 04/05 vs código (G1-04)

Auditoria mecânica em `gov/G1` (2026-07-16). Status: **implementado** = funciona
de ponta a ponta; **parcial** = existe mas incompleto (a evidência diz o que
falta); **ausente** = só spec. Itens parcial/ausente apontam a feature G* que os
cobre (`plan/features.json`); gap sem feature → proposta na inbox do loop.
Conferido também nas branches `vendaval/F2-19..22` (`git grep`): nenhum artefato
de governança implementado lá além das próprias specs — nada a anotar.

### B.1 — Spec 04 (Pipeline + Atendimento)

| Item da spec | Status | Evidência (arquivo:linha) | Cobre |
|---|---|---|---|
| Claim atômico §9.2 (AT-02): UPDATE condicional `assigned_to_user_id IS NULL` + 409 | implementado | `app/api/v1/conversations/[id]/claim/route.ts:59-78` (UPDATE condicional com optimistic lock `expected_assignee`), `:83-85` (0 linhas → 409 `state_conflict`); audit `conversation.claimed` `:89-96`; `emit_event` `:98-109` | — (código de erro é `state_conflict`, não `conversation_already_claimed` da spec §9.2 — desvio cosmético) |
| Claim UI §9.1/§9.3: botão "Eu cuido" + tratamento de 409 | implementado | botão "Assumir" em `components/inbox/ConversationHeader.tsx:55-68` (render se `isOpen`, `:36`); hook `hooks/inbox/useClaimConversation.ts:15-29` (409 → `showApiError` + `invalidateQueries` `:21-24`) | — (sem o Dialog de confirmação da §9.1 — claim é 1 clique; desvio de UX, não de mecânica) |
| Release (soltar conversa — par do claim, base do `reason=release` da spec 13 §3) | implementado | `app/api/v1/conversations/[id]/release/route.ts:47-53` (UPDATE limpa assignee, filtro `assigned_to_user_id = caller`), `:61` (409 se não é o dono); botão "Liberar" `components/inbox/ConversationHeader.tsx:70-78` | — |
| `<ReassignDialog>` (transferir para outro atendente — §3 estrutura de pastas, §14) | ausente | nenhum componente/endpoint de reassign: `components/kanban/`+`components/inbox/` não têm o arquivo (`ls components/inbox components/kanban`); único caminho de troca de dono é claim com `expected_assignee` (`claim/route.ts:69-76`), que é takeover pelo próprio caller, não atribuição a terceiro | **G3-01** (desc.: "habilita o ReassignDialog de verdade") |
| `<UnassignedQueueAlert>` §8.3 (alerta de contagem "N conversas sem responsável") | parcial | componente de alerta não existe; o que há: aba "Não atribuídos" no inbox `components/inbox/InboxFilters.tsx:17,92-94` mapeada para filtro `assigned_to: "unassigned", status: "open"` em `components/inbox/InboxLayout.tsx:22-23`; índice parcial da fila `supabase/baseline.sql:2380` (`idx_conversations_open_unassigned`) | **G5-03** (fila visível com posição + notificação); **G4-02** (visões minhas/fila/todas) |
| Round-robin de não-atribuídas (AT-03, §8.3 "worker server-side") | parcial | round-robin existe SÓ no caminho do handoff MCP: `lib/mcp/tools/handoff.ts:37` (`pickRoundRobinAssignee`), invocado em `:106`; não há worker de roteamento geral consumindo `event_log` (handlers registrados: `lib/event-log/register-handlers.ts:20-25` — nenhum de routing) | **G5-02** (desc.: "AT-03 de verdade") |
| `<AttendantStatusToggle>` §8.1 (online/busy/offline + pinned) | ausente | nenhum componente/hook de presença de atendente em `components/`/`hooks/` (`grep -r "AttendantStatusToggle\|useAgentStatus\|useHeartbeat"` → 0); sem tabela de disponibilidade no schema (`grep -c attendant_availability supabase/baseline.sql` → 0) | **G5-01** (desc.: "persiste o AttendantStatusToggle da spec 04 §8"); painel em **G5-04** |
| Heartbeat 60s + auto-offline 15min §8.2 (AT-08) + worker server-side 90s | ausente | mesma evidência da linha anterior — não há `hooks/presence/`, endpoint de heartbeat nem cron (`app/api/v1/cron/` tem só agent-dispatcher, lgpd-sla-watcher, kb-conversations-batch, storage-redaction) | **G5-01** (schema/API de disponibilidade) |
| Supervisor read-only §10 (AT-04): composer bloqueado p/ manager não-dono + 403 server-side + audit `conversation.observed_by_supervisor` | ausente | UI: composer só desabilita por status/bloqueio — `components/inbox/Composer.tsx:31` (`disabled \|\| blockedReason \|\| isPending`), `components/inbox/InboxLayout.tsx:130` (`disabled={status === "closed"}`) — nenhum conceito de supervisor; API: POST de mensagens não checa assignee (único 403 é `no_active_org`, `app/api/v1/conversations/[id]/messages/route.ts:38`); audit action inexistente (`grep -r observed_by_supervisor app lib` → 0) | **nenhuma feature G\*** — proposta registrada na inbox do loop (**INB-01**). Nota: a matriz §4 desta spec dá `org:read+write` a manager, o que conflita com o read-only da spec 04 §10 — decisão de produto |
| Bulk actions §6.5 (AT-06): move/assign/tag + limite 50 | parcial | API completa: `app/api/v1/leads/bulk/route.ts:21` (`MAX_BULK = 50`), `:49` (422 `bulk_too_large`), case `assign` aceita qualquer `owner_user_id` uuid `:90-104` + `lib/schemas/leads.ts:111-113`; UI: `components/kanban/BulkActionBar.tsx:55-101` (runMove/runAssign/runTagAdd/runDelete), mas "Atribuir a…" só oferece "Eu"/"Remover responsável" `:134-136` — sem seleção de outro atendente | **G3-04** (atribuição em massa de ponta a ponta — falta só o seletor de atendente na UI) |
| Dashboard lite §13 (4 cards: abertas por atendente, 1ª resposta, pendentes, resolução) | ausente | `/dashboard/atendimento` não existe; `app/app/page.tsx:3` redireciona direto pra `/app/inbox`; nenhum card de métrica de atendimento em `app/app/` | **G4-04** (métricas por responsável + performance individual) |
| Dono do lead visível no card do kanban (§6.2 `card.owner`) + filtro por dono (§6.4) | parcial | card mostra avatar com iniciais derivadas do **id** (não nome): `components/kanban/KanbanCard.tsx:31-33,96-99`; filtro por dono existe incl. "unassigned": `components/kanban/FilterBar.tsx:53,84` + `lib/kanban/filters.ts:18` | **G3-03** (nome/badge "sem responsável" + coluna na lista) |

### B.2 — Spec 05 (Handoff IA) e baseline

| Item da spec | Status | Evidência (arquivo:linha) | Cobre |
|---|---|---|---|
| Gatilhos de handoff §7.1-§7.4 (G1 pedido explícito, G2 sentiment, G3 incerteza, G4 jurídico/estágio) | implementado | predicados `lib/ai/handoff/triggers.ts:22-40` (checkG1/checkG4Legal/checkG3) e `:43-78` (checkG4Stage via `crm_stages.requires_human`); triagem síncrona pré-bot `workers/ai-response-worker.ts:96-121` (G1/G4), pós-resposta `:143-153` (G3); G2 via evento `ai.sentiment_alert` → `workers/ai-handoff-from-sentiment.handler.ts:20,97` | — |
| Ação de handoff §7.5 (`triggerHandoff`: pending + silêncio + activity + event_log + broadcast + audit) | implementado | `lib/ai/handoff/orchestrator.ts:51` (entrada), `:92-100` (UPDATE `status='pending'`, `bot_silenced_until='infinity'`, `last_handoff_*`), `:117` (activity), `:139` (emit_event `ai.handoff_triggered`), `:180` (audit); janela de idempotência 5s `:47` | — |
| Política de retomada §7.6 (bot não reassume; "Passar pra IA" limpa silêncio) | parcial | gate de silêncio respeitado pelo worker `workers/ai-response-worker.ts:291`; endpoint `app/api/v1/conversations/[id]/reactivate-bot/route.ts:52` (UPDATE `bot_silenced_until: null`, guarda role≥agent `:37`); **sem UI** — nenhum botão chama o endpoint (`grep -r reactivate-bot hooks components app/app` → 0) | **G3-02** (handoff vira reassignment `assignee_kind`; a devolução p/ IA é o reassign inverso) |
| MCP `crm_request_human_handoff` (superfície p/ agentes externos) | implementado | `lib/mcp/tools/handoff.ts:17` (usa o orchestrator central), `:37,106` (atribuição round-robin best-effort por role mínimo) | upgrade (fila/horário/atendente-alvo) em **G6-01** |
| Baseline: `conversations.assigned_to_user_id` + `assigned_at` + FK + índices | implementado | `supabase/baseline.sql:1386-1387` (colunas), `:3005` (FK `auth.users` ON DELETE SET NULL), `:2376` (`idx_conversations_assigned`), `:2380` (`idx_conversations_open_unassigned`), `:1392` (`unread_count_for_assignee`) | — |
| Baseline: status `claimed`/`ai_handling` no CHECK de `conversations.status` | implementado | `supabase/baseline.sql:1407` (CHECK aceita `open/pending/resolved/claimed/ai_handling/closed/archived`); comentário sobre dualidade legado+EPIC-03 `:1414` | consolidação semântica em **G3-02** (`assignee_kind` desambigua `ai_handling`) |
| Baseline: colunas de handoff (`bot_silenced_until`, `last_handoff_at/reason`) + índice | implementado | `supabase/baseline.sql:1398-1400` (colunas), `:2292` (`conversations_bot_silenced_idx`) | — |
| Auditoria de mudança de dono (spec 13 §3 `conversation_assignment_events`) | ausente | tabela não existe (`grep -c conversation_assignment_events supabase/baseline.sql` → 0); hoje só `api_audit_log` actions `conversation.claimed`/`.released` (`app/api/v1/conversations/[id]/claim/route.ts:89-96`, `.../release/route.ts:67`) — sem from/to/reason estruturados | **G3-01** |

### B.3 — Contagem

implementado: **9** · parcial: **5** · ausente: **6** (dos quais 1 sem feature G* → INB-01 na inbox).
