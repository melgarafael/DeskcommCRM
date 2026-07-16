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

_Preenchido por G1-03: tabela eixo → invariante → status (passa | GAP Gx)._

## Apêndice B — Auditoria spec 04/05 vs código (G1-04)

_Preenchido por G1-04: item da spec → {implementado|parcial|ausente} → evidência
`arquivo:linha` → feature G* que cobre._
