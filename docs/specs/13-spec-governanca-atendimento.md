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

## 3. Modelo de dados alvo (G1-05)

DDL **rascunho** — vira migration real (tripla: `migrations/` + `baseline.sql` +
MANIFEST + `database.types.ts`) nas fases indicadas, **não agora**. Cada estrutura
justifica DIRC (Derive? Infer? Reuse? Create?) contra o baseline atual; a doutrina
do repo (Duplicar/Integrar/Referenciar/Calcular do CLAUDE.md) é a mesma pergunta
por outro ângulo. Convenções seguidas: `type` é `text` + CHECK (não enum),
`tags text[]` + GIN, config declarativa em `settings jsonb` com Zod.

### 3.1 `conversation_assignment_events` (G3-01)

Auditoria estruturada de TODA mudança de dono de conversa — a "história de
atendimento" que o sistema-modelo nunca teve (eixo 3).

```sql
-- RASCUNHO (migration real em G3-01)
create table if not exists conversation_assignment_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  from_user_id    uuid references auth.users(id) on delete set null, -- null = sem dono / com a IA
  to_user_id      uuid references auth.users(id) on delete set null, -- null = liberada (volta à fila/IA)
  changed_by      uuid references auth.users(id) on delete set null, -- null = sistema (worker de routing / agente IA)
  reason          text not null
                  check (reason in ('claim','transfer','release','routing','handoff')),
  created_at      timestamptz not null default now()
);

create index if not exists idx_cae_conversation
  on conversation_assignment_events (conversation_id, created_at desc);

-- RLS: tenant org via fn_user_org_ids() (SELECT + INSERT).
-- Append-only: sem policy de UPDATE/DELETE (mesma família de api_audit_log).
```

**DIRC** — *Derive?* Não: `conversations` só guarda o dono ATUAL
(`assigned_to_user_id`); a história não é derivável do estado. *Reuse?*
`api_audit_log` é genérico (payload jsonb, retenção própria, select admin-only) —
sem `from/to/reason` tipados nem consulta eficiente por conversa;
`crm_lead_activities` é timeline de LEAD, não de conversa. → **Create**.

### 3.2 `conversations.assignee_kind` (G3-02)

Decisão de design: **quem atende é `'user'` OU `'ai'`, nunca ambíguo** — unifica
o status `ai_handling` (baseline.sql:1407) com o assignment. Handoff IA→humano
vira reassignment auditado (`reason='handoff'` em 3.1). Conversa `kind='user'` ⇒
pipeline do bot vetado deterministicamente (mesma família de guard de
`force_human`/`bot_silenced_until`).

```sql
-- Migration real: 0032_conversation_assignee_kind (G3-02)
alter table conversations
  add column if not exists assignee_kind text
  check (assignee_kind in ('user','ai'));

-- Coerência com assigned_to_user_id em FORMA DE IMPLICAÇÃO (acceptance G3-02):
-- kind='user' ⇒ dono humano; kind='ai' ⇒ sem dono; kind null é livre — escritas
-- legadas que não conhecem a coluna (ex.: PATCH de status) continuam válidas e
-- a semântica forte chega pelos caminhos canônicos (fn_conversation_assign).
alter table conversations
  add constraint conversations_assignee_kind_coherence check (
    (assignee_kind = 'user' and assigned_to_user_id is not null) or
    (assignee_kind = 'ai'   and assigned_to_user_id is null)     or
    (assignee_kind is null)
  );

-- Backfill (na migration, ANTES da constraint — doutrina de migrations §8):
-- update conversations set assignee_kind = 'user' where assigned_to_user_id is not null;
-- update conversations set assignee_kind = 'ai'
--   where status = 'ai_handling' and assigned_to_user_id is null;
```

**DIRC** — *Reuse + Derive*: reusa as colunas existentes
(`assigned_to_user_id`, `status`) e desambigua a semântica dupla de
`ai_handling`; nenhuma tabela nova. Coluna mínima em vez de tabela `assignees`
polimórfica (anti-pattern 8 do CLAUDE.md) — só existem 2 kinds e o humano já tem
FK própria. → **Create (coluna)**, não tabela.

### 3.3 `conversations.tags text[]` (G3-05)

```sql
-- RASCUNHO (migration real em G3-05)
alter table conversations
  add column if not exists tags text[] not null default '{}';

create index if not exists idx_conversations_tags_gin
  on conversations using gin (tags);
```

Vocabulário canônico: `organizations.settings.canonical_conversation_tags`
(array jsonb, schema Zod declarativo) — **não** o
`crm_pipelines.settings.canonical_tags` (baseline.sql:1500), porque conversa não
é pipeline-scoped; vocabulário de atendimento é da org. G3-05 registra/valida.

**DIRC** — *Reuse do padrão*: mesmíssimo shape de `contacts.tags`
(baseline.sql:1356 + GIN :2372) e `crm_leads.tags` (:1476 + :2424). *Por que não
reusa `contacts.tags` direto?* Tag de contato qualifica a PESSOA (duradouro:
"vip"); tag de conversa qualifica o ATENDIMENTO (episódico: "reclamação",
"troca") — 1 contato tem N conversas de categorias distintas; inferir da mais
recente perde informação. → **Create (coluna)**, padrão reusado.

### 3.4 `attendant_availability` (G5-01)

Persiste o `<AttendantStatusToggle>`/heartbeat da spec 04 §8.1-8.2 (hoje 100%
ausente — Apêndice B).

```sql
-- RASCUNHO (migration real em G5-01)
create table if not exists attendant_availability (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  is_available      boolean not null default false,
  capacity          integer not null default 5 check (capacity > 0), -- ajustável por atendente, nunca constante no código
  schedule          jsonb not null default '{}', -- tz-aware: {"timezone":"America/Sao_Paulo","windows":[{"dow":1,"start":"08:00","end":"18:00"}]}
  last_heartbeat_at timestamptz,                 -- AT-08: auto-offline após 15min sem heartbeat (worker)
  updated_at        timestamptz not null default now(),
  unique (organization_id, user_id)
);

-- RLS: SELECT org via fn_user_org_ids();
-- WRITE: a própria linha (user_id = auth.uid()) OU fn_role_at_least(org,'manager').
```

**DIRC** — *Derive?* Presença não é derivável: é declarada (toggle) + heartbeat.
*Infer?* `last_outbound_at` das mensagens seria heurística frágil (atendente
online sem responder). *Reuse?* `user_organizations` é membership/RBAC — misturar
estado mutável de alta frequência com a tabela que a RLS consulta em todo request
é hot-path errado. → **Create** (1 linha por org×user).

### 3.5 `organizations.settings.routing` + `visibility_mode` (G5-01 / G4-01)

Config de org, não tabela — shape declarativo (Zod em `lib/schemas/`, mesmo
padrão de `crm_pipelines.settings.fields`):

```jsonc
// organizations.settings (jsonb já existente — baseline.sql:1750)
{
  "routing": {
    "mode": "manual" | "round_robin",             // MVP = manual + round_robin (decisão G1-06b); "load" pós-MVP
    // default: "manual" (derivado de G1-06b: round-robin é opt-in por org)
    "max_retries": 5, "backoff_seconds": 60       // knobs: nunca constantes hardcoded no worker
  },
  "visibility_mode": "all" | "own_and_unassigned" | "own"
  // escopo do role agent em conversations/messages; default: "own_and_unassigned" (decisão G1-06a)
}
```

**DIRC** — *Reuse*: `organizations.settings jsonb` já existe e é o lugar canônico
de config org-level de baixa cardinalidade; tabela dedicada (`routing_rules`)
seria over-modeling para 1 linha por org sem histórico. Se um dia routing tiver
N regras condicionais por org, aí promove-se a tabela. → **Reuse**.

## 4. Matriz role×recurso (G1-05; pendências fechadas pelas decisões G1-06/INB-01)

Formato: célula = `{none|own|org}` × `{read|write}`. `own` = registros cujo
`assigned_to_user_id`/`owner_user_id` é o próprio usuário (+ os sem dono, conforme
`visibility_mode` — §3.5). A fase G2 aplica esta matriz server-side; G4 aplica o
escopo `own` na RLS.

| Recurso | viewer | agent | manager | admin |
|---|---|---|---|---|
| conversations | org:read ¹ | own:read+write (default `own_and_unassigned` — decisão G1-06a: as suas + fila não-atribuída) | org:read+write ² | org:read+write |
| messages | org:read ¹ | segue conversations (own:read+write) | segue conversations ² | org:read+write |
| contacts | org:read | org:read+write ³ | org:read+write | org:read+write |
| crm_leads | org:read | own:read+write (mesmo escopo da decisão G1-06a: os seus + sem dono) | org:read+write | org:read+write |
| pipelines (config) | org:read ⁴ | org:read ⁴ | org:read+write | org:read+write |
| settings | none | none | atendimento/routing: org:read+write ⁵; demais: none ⁵ | org:read+write |
| api_tokens | none | none | none ⁶ | org:read+write |
| billing | none | none | none (admin-only; derivado: sem decisão explícita do dono, conservador) | org:read+write |
| team (membros/papéis) | none | none | org:read ⁷ | org:read+write |
| audit | none | none | org:read ⁸ | org:read |
| métricas | none | own:read (decisão G1-06e: agent só as próprias) | org:read, incl. individuais de todos os atendentes (decisão G1-06e) | org:read |

Notas:
1. `viewer` é o papel de leitura org-wide (invariante "viewer NÃO escreve" —
   Apêndice A, GAP G2). `visibility_mode` restringe apenas o role **agent**;
   viewer segue org:read — decisão do dono (INB-01): viewer é o observador
   read-only org-wide.
2. Resolvido pela decisão do dono (**INB-01**, inbox do loop, 2026-07-16): o
   modo supervisor read-only da spec 04 §10 está **descartado** — viewer já
   cobre a observação read-only; manager mantém escrita plena
   (`org:read+write`) em conversations/messages, sem audit
   `observed_by_supervisor`.
3. Contato é entidade compartilhada (1 contato × N atendimentos); escopo fino
   fica nas conversas, não na pessoa. Escrita de agent é operacional (nome, nota,
   tags de contato) — anonimização LGPD segue admin-only (spec 01).
4. Leitura da estrutura (stages, vocabulário) é necessária pra renderizar
   board/inbox; **write de config é manager+** (invariante "agent NÃO escreve
   config de pipeline" — Apêndice A, GAP G2).
5. Config de atendimento/roteamento (§3.5 `settings.routing`,
   `attendant_availability` de terceiros) é manager+ — já fixado pelos acceptances
   de G5-01/G5-04. As demais chaves de `settings` (perfil da org etc.) ficam
   admin-only (derivado: sem decisão explícita do dono, conservador — manager
   gerencia a operação de atendimento, não a configuração geral da org).
6. Baseline já aplica `api_tokens_admin_only` (baseline.sql:3289) — manter.
7. Manager lê a lista de membros para o painel de atendentes (G5-04); gestão de
   papéis (PATCH role) é admin-only (G2-02, "último admin não rebaixa").
8. Hoje o baseline restringe select de `api_audit_log` a admin
   (baseline.sql:3297); abrir `org:read` a manager é a mudança-alvo aplicada em G2.
9. Decisão **G1-06c**: o role `agent` existente É o atendente — sem role novo,
   sem rename de coluna. Decisão **G1-06d**: transferência é imediata (auditada
   via §3.1 + notificação ao destino), sem aceite — o write de transfer não tem
   etapa de aprovação.

Enforcement em **duas camadas obrigatórias**: RLS (fronteira) + helper único de
rota (`require-role`, G2-01) — nunca só UI (anti-padrão 3).

**DIRC — escopo `own` de `crm_leads` via RLS, não filtro server-side (G4-03).**
O escopo `own` do agent (linha 220 da matriz) é aplicado na **RLS** por
`fn_can_view_lead(p_org, p_owner_user_id)` (migration 0036), espelho exato de
`fn_can_view_conversation` (G4-01): mesma lógica (role via `fn_user_role_in_org`
+ `visibility_mode` + campo-dono da row), `STABLE SECURITY DEFINER`, `search_path`
blindado, `EXECUTE` só para `authenticated`/`service_role`. O "dono" do lead é
`crm_leads.owner_user_id` (não `assigned_to_user_id` — isso é conversa), e o knob
é o **mesmo** `organizations.settings.visibility_mode` (§3.5) — a matriz diz
"mesmo escopo da G1-06a", logo é reuse do botão, não um novo. *Por que RLS e não
filtro server-side*: (**D**uplicar/**I**ntegrar) o predicado de visibilidade já
vive no banco para conversations — repeti-lo em cada caller (board, MCP,
`listLeadsHandler`, bulk, move) seria N cópias a manter em sincronia, e a primeira
que alguém esquecer vira vazamento cross-atendente (anti-padrão 10: "select sem
where"). A RLS é a fronteira única que **todo** caller cookie/JWT atravessa
(defesa em profundidade no banco, consistente com o precedente G4-01) → **Reuse**
da fn-pattern na RLS. A escrita é re-expressa por-comando (a `FOR ALL` org-flat
governaria o SELECT junto, anulando o escopo): agent = own-scope pela **mesma**
fn (por isso o drag-and-drop de lead próprio e a puxada da fila não-atribuída no
modo `own_and_unassigned` continuam UPDATE-áveis pelo agent — espelho das
conversas), manager+ = org-wide (bulk assign G3-04 intacto), viewer = none.

### 4.1 Auditoria de policies RLS por role (G2-03)

Auditoria mecânica do `supabase/baseline.sql` (gov/G2, 2026-07-16): tabela →
policy de escrita → role mínimo efetivo. **Org-flat** = qualquer membro da org
(incl. viewer) escreve. Tabelas fora da matriz §4 (ai_*, channel_sessions,
contacts operacionais etc.) não são "config" e ficam fora do alvo desta fase.

| Tabela | Policy de escrita (baseline) | Role mínimo | Org-flat? | Config §4? | Ação G2-03 |
|---|---|---|---|---|---|
| api_tokens | `api_tokens_admin_only` | admin | não | sim | manter |
| lgpd_requests | `lgpd_requests_admin_write` | admin | não | — | manter |
| merge_queue | `merge_queue_manager_write` | manager | não | — | manter |
| tenant_integrations | `tenant_integrations_admin_write` | manager | não | sim (integrações) | manter |
| user_organizations (team) | `user_orgs_insert/update/delete` | admin | não | sim | manter |
| organizations (settings) | `orgs_write_platform_admin` | platform admin (tenant escreve via service role + guard de rota) | não | sim | manter |
| **crm_pipelines** | `tenant_isolation_crm_pipelines_all` (ALL) | **qualquer membro** | **sim** | **sim (pipelines config)** | **migration 0030: write manager+** |
| **crm_stages** | `tenant_isolation_crm_stages_all` (ALL) | **qualquer membro** | **sim** | **sim (config de pipeline, nota 4)** | **migration 0030: write manager+** |
| **conversations** | `conversations_tenant_isolation_all` (ALL) | **qualquer membro (incl. viewer)** | **sim** | não é config, mas viewer é read-only (nota 1) | **migration 0030: write agent+; SELECT intocado (escopo own é G4-01)** |
| messages | `messages_tenant_isolation_all` (ALL) | qualquer membro | sim | não (operacional; escopo segue conversations) | G4-01 |
| contacts | `tenant_isolation_contacts_all` (ALL) | qualquer membro | sim | não (agent tem org:write, nota 3; viewer-write fica pra G4 junto do escopo) | G4 |
| crm_leads / crm_lead_activities / crm_lead_links | `tenant_isolation_*` (ALL) | qualquer membro | sim | não (operacional; escopo own é G4-01) | G4-01 |
| channel_sessions, ai_*, orders, nuvemshop_products, idempotency_keys, warmup, storage_redaction_queue | `*_tenant_isolation_*` (ALL) | qualquer membro | sim | não classificado na matriz §4 | fora do escopo G2-03 |
| api_audit_log | `audit_log_insert_tenant_member` (insert-only, append) | qualquer membro | por design | — | manter (select manager é read, não write) |

Resultado: as tabelas de **config org-flat** são `crm_pipelines` e `crm_stages`;
a migration `20260716120000_0030_config_rls_role_policies.sql` aplica
`fn_role_at_least(organization_id, 'manager')` nas write-policies delas e
`fn_role_at_least(organization_id, 'agent')` no write de `conversations`
(viewer read-only), mantendo todos os SELECTs org-flat.

## 5. Roteamento (decisões G1-06; G5 implementa)

- **Modos no MVP** (decisão G1-06b): `manual` (só claim/atribuição humana) e
  `round_robin` (rodízio entre elegíveis). `load` (menor carga) fica pós-MVP —
  `settings.routing` é jsonb, entra sem quebrar contrato. Elegível =
  disponível ∧ dentro do horário ∧ abaixo da capacidade.
- **Default por org**: `mode = 'manual'` — round-robin é opt-in (derivado de
  G1-06b: o dono escolheu os modos, não o default; manual é o comportamento
  atual e conservador).
- **Atendente** (decisão G1-06c): é o role `agent` existente do RBAC — nenhum
  role novo.
- **Visibilidade** (decisão G1-06a): `visibility_mode` default
  `own_and_unassigned` — agent vê as suas conversas + a fila não-atribuída.
- **Transferência** (decisão G1-06d): imediata, sem aceite do destino —
  auditada em `conversation_assignment_events` (§3.1) + notificação ao novo
  atendente.
- Mecânica: evento `conversation.routing_requested` no `event_log`; worker
  consome com claim + dedup (at-least-once seguro: conversa que já tem dono nunca
  é reatribuída pelo replay).
- Sem elegível ⇒ fila (visível, com posição) + re-agenda com backoff.

> Origem das decisões deste documento (§3.5 defaults, §4 matriz, §5 roteamento):
> decisões do dono, 2026-07-16, inbox INB-01/INB-02 (`loop/inbox.items.md`).

## 6. Métricas por responsável (G4-04)

Feedback do sistema-modelo: *"não é possível filtrar por atendente nas métricas;
impossibilita visualizar performance individual"*. Esta seção define **antes do
código** cada métrica: fórmula exata, fonte (tabela/coluna), janela temporal e
como escopo/role a afetam. Implementação: `fn_attendant_metrics()` (SQL
**SECURITY INVOKER** — a RLS das tabelas se aplica) + rota
`GET /api/v1/metrics/attendants` + página `/app/metrics`.

### 6.1 Convenções transversais

- **Janela temporal**: intervalo **semiaberto** `[from, to)` (inclui `from`,
  exclui `to`), dois query params ISO-8601 UTC. Default = últimos 30 dias
  (`to = now()`, `from = now() - 30d`). Cada métrica declara sobre QUAL coluna a
  janela incide (não é a mesma para todas).
- **Escopo/role (o gate é a própria RLS, não uma checagem paralela)**: a agregação
  roda com o **client user-scoped** (cookie session) — a RLS de `crm_leads`
  (migration 0036, `fn_can_view_lead`) e `conversations` (migration 0035,
  `fn_can_view_conversation`) já filtra por atendente. Consequência:
  - **agent** agregando → a RLS colapsa os resultados aos **próprios**
    leads/conversas (own-scope, decisão G1-06a); a "visão por atendente" reduz a
    UMA linha (a dele). É assim que "agent só vê as próprias" (acceptance 1) é
    garantido SEM lógica extra — a mesma policy do kanban/inbox.
  - **manager+** agregando → RLS org-wide; a "visão por atendente" lista todos, e
    o filtro `owner_user_id`/`assigned_to_user_id` (query param) é um WHERE
    explícito. Piso de rota = `agent` (vê as próprias); a comparação entre
    atendentes é naturalmente manager+ porque a RLS impede o agent de ver outros.
- **Sem cross-tenant**: `organization_id = <org do cookie>` em TODA subquery;
  nunca do body. `fn_attendant_metrics(p_org, …)` recebe a org de fonte confiável.
- **Atribuição**: métricas de lead usam `crm_leads.owner_user_id` (o dono do
  negócio); métricas de conversa usam `conversations.assigned_to_user_id` (o
  atendente da conversa) — são responsáveis distintos por design (§3, §4).

### 6.2 Funil por owner (acceptance 1)

- **Definição**: contagem de leads **abertos** por stage, opcionalmente filtrada
  por dono. É um **snapshot atual** — NÃO usa janela temporal (o funil é o estado
  do board agora).
- **Fórmula**: para cada `crm_stages` (não-arquivado) do org,
  `count(crm_leads) where status = 'open' and stage_id = <stage>
  [and owner_user_id = p_owner]`.
- **Fonte**: `crm_leads.stage_id`, `crm_leads.status`, `crm_leads.owner_user_id`;
  `crm_stages.id/name/position/is_archived`.
- **Índice**: `idx_crm_leads_org_owner_status` (já existe, parcial
  `WHERE status='open'`) cobre org+owner+open.

### 6.3 Leads ganhos por owner (acceptance 2)

- **Definição**: leads que o dono **fechou como ganho na janela**.
- **Fórmula**: `count(crm_leads) where status = 'won' and closed_at >= from and
  closed_at < to [and owner_user_id = p_owner]`, agrupado por `owner_user_id`.
- **Janela**: incide sobre **`closed_at`** (momento em que virou ganho — o CHECK
  `crm_leads_closed_at_consistency` garante `closed_at NOT NULL` sse
  `status ∈ {won,lost}`, então a janela é sempre bem-definida para won/lost).
- **Fonte**: `crm_leads.status`, `crm_leads.closed_at`, `crm_leads.owner_user_id`.

### 6.4 Leads perdidos por owner (acceptance 2)

- Idêntico a §6.3 com `status = 'lost'`. Mesma janela (`closed_at`), mesma fonte.

### 6.5 Conversas atendidas por assignee (acceptance 2)

- **Definição**: conversas que o atendente **assumiu na janela** (foi atribuído
  a ele). "Atendida" = atribuída ao atendente no período — não depende de a
  conversa já estar fechada (uma conversa em andamento já foi atendida).
- **Fórmula**: `count(conversations) where assigned_to_user_id is not null and
  assigned_at >= from and assigned_at < to [and assigned_to_user_id = p_owner]`,
  agrupado por `assigned_to_user_id`.
- **Janela**: incide sobre **`assigned_at`** (momento da atribuição).
- **Fonte**: `conversations.assigned_to_user_id`, `conversations.assigned_at`.

### 6.6 Tempo até 1ª resposta por assignee (acceptance 2)

- **Definição**: por conversa atribuída ao atendente, o intervalo entre a
  **primeira mensagem inbound** (cliente) e a **primeira mensagem outbound de um
  atendente HUMANO** — a resposta do bot/IA **não** conta. Métrica = **média (em
  segundos)** desse intervalo sobre as conversas cuja 1ª resposta humana caiu na
  janela.
- **Coluna que distingue humano de bot**: **`messages.sent_by_user_id`** — é o
  usuário que enviou; `NOT NULL` ⇒ atendente humano. A resposta do bot/IA tem
  `sent_via = 'ai'` e `sent_by_user_id IS NULL` (CHECK `messages_sent_via_check`
  admite `'ai'`). Logo a definição filtra `direction='outbound' AND
  sent_by_user_id IS NOT NULL` — **exclui o bot explicitamente** (não há
  ambiguidade; a coluna existe e distingue). Se no futuro o bot passar a gravar
  `sent_by_user_id`, este filtro precisa de um discriminador adicional
  (`sent_via <> 'ai'`) — registrado aqui como ponto de atenção.
- **Fórmula** (por conversa `c` com `assigned_to_user_id = X`):
  `t0 = min(messages.sent_at) where conversation_id = c and direction = 'inbound'`;
  `t1 = min(messages.sent_at) where conversation_id = c and direction = 'outbound'
  and sent_by_user_id is not null`. TTFR da conversa `= t1 - t0`, **somente** se
  `t0` e `t1` existem e `t1 > t0` (respostas anteriores ao 1º inbound — conversa
  iniciada pelo atendente — são descartadas: não há "tempo de resposta"). A
  métrica é `avg(extract(epoch from (t1 - t0)))` sobre as conversas do atendente
  com `t1 ∈ [from, to)`.
- **Fonte**: `messages.direction`, `messages.sent_by_user_id`, `messages.sent_at`
  (timestamp da mensagem; `NOT NULL default now()`), `messages.conversation_id`;
  `conversations.assigned_to_user_id`. Atribuído ao `assigned_to_user_id` da
  conversa (o dono da conversa), não ao autor da mensagem.

### 6.7 Índices dedicados (acceptance 3 — migration 0037)

Os índices existentes não cobrem won/lost por owner (o parcial de `crm_leads` é
`WHERE status='open'`) nem a agregação org-wide de conversas por assignee
(`idx_conversations_assigned` lidera por `assigned_to`, não por `organization_id`).
A migration 0037 adiciona:

- `idx_crm_leads_org_status_closed_owner` = `crm_leads (organization_id, status,
  closed_at, owner_user_id) WHERE closed_at IS NOT NULL` — cobre §6.3/§6.4
  (org+status+janela de `closed_at`, filtro/grupo por owner). Parcial mantém o
  índice pequeno (só won/lost têm `closed_at`).
- `idx_conversations_org_assignee_assigned` = `conversations (organization_id,
  assigned_to_user_id, assigned_at) WHERE assigned_to_user_id IS NOT NULL` —
  cobre §6.5 e o filtro por org da §6.6.

TTFR (§6.6) reusa `idx_messages_conversation_sent (conversation_id, sent_at)` para
o `min(...)` por conversa — sem índice novo em `messages`. `EXPLAIN (ANALYZE)`
sob role `agent` E `manager` (com a RLS ativa, que muda o plano) prova ausência de
seq scan em `crm_leads`/`conversations`/`messages` — documentado no verification.

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
| 1. RBAC | `gov-1-rbac.test.ts` → "agent NÃO escreve config de pipeline (spec 13 §4: manager+)" | passa (fechado por G2-03, migration 0030) |
| 1. RBAC | `gov-1-rbac.test.ts` → "viewer NÃO escreve em conversations (spec 13 §4: viewer é read-only)" | passa (fechado por G2-03, migration 0030) |
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
