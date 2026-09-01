# Spec 14 — Contrato de Governança para Agentes Externos (MCP)

> **Verificado em 2026-07-18 contra `gov/G6` @ `ddcc511`.** Toda referência
> `arquivo:linha` abaixo foi aberta e conferida nesta data/commit. Se o código
> mudar, a linha muda — reverifique antes de confiar.
>
> **Autocontido.** Um agente externo (o **Vendaval** — runtime de agentes de IA
> 1:N, fora deste repo) lê SÓ este documento para saber como falar com o
> SonghaiCRM via MCP: quais tools existem, o input/output exato de cada uma, a
> semântica de governança que ele precisa respeitar e o que ele **nunca** pode
> fazer. Estilo edge-contract: refs reais, proibições explícitas, zero remissão
> obrigatória a outro doc.
>
> Complementa a `13-spec-governanca-atendimento.md` (a doutrina de governança) e
> a `11-spec-mcp-server-internal.md` (o servidor MCP). Doutrina soberana:
> `CLAUDE.md` do repo (multi-tenancy, RLS, RBAC, LGPD, audit, migrations).

---

## 0. Modelo mental (leia primeiro)

O SonghaiCRM expõe um **servidor MCP org-scoped**. O agente externo se autentica
com um bearer token que carrega **uma organização** e **um conjunto de scopes**
(`mcp:read` / `mcp:write`) + um **role** (`viewer`<`agent`<`manager`<`admin`). A
partir daí:

- **`organization_id` vem SEMPRE do contexto de autenticação (`ctx.organizationId`),
  NUNCA do input da tool.** As tools de governança carimbam isto explicitamente no
  cabeçalho do módulo (`lib/mcp/tools/governance.ts:9`). O agente externo não
  consegue "escolher" a org por parâmetro — ela é fixada pelo token.
- **Toda leitura passa pela RLS org-scoped + visibilidade** (§4). Service role
  bypassa RLS, por isso cada handler ainda filtra `organization_id` manualmente
  como defesa em profundidade (ex.: `lib/mcp/tools/governance.ts:72-74`).
- **Toda escrita relevante gera audit** (`api_audit_log`, fire-and-forget) — o
  agente externo é auditado como ator não-humano (`actor_type` no metadata,
  `lib/mcp/tools/governance.ts:21-34`).
- **Idempotência** é responsabilidade do contrato: comandos de atribuição são
  idempotentes sob replay e corrida (§3.1); envio aceita `idempotency_key`.

Quando o agente externo assume o dispatch de uma org (§5, `ai_dispatch_mode='external'`),
o dispatcher **nativo** deste repo **para de tocar** os eventos daquela org — o
Vendaval os consome. O resto do contrato (tools, RLS, proibições) continua valendo
igual.

---

## 1. Catálogo de tools (fonte única: `lib/mcp/tools/catalog.ts`)

O catálogo estático `TOOL_CATALOG` (`lib/mcp/tools/catalog.ts:19-39`) é a lista
canônica. Um **sanity check em runtime** (`lib/mcp/tools/index.ts:62-75`) falha o
boot em dev se um handler existir sem entrada no catálogo — ou vice-versa —,
garantindo **1:1 entre handler e catálogo**. Nenhuma tool citada aqui existe sem
handler; nenhuma tool de governança do catálogo ficou de fora deste contrato.

| Tool | Categoria | catalog.ts | handler | Governança de atendimento? | Neste contrato |
|---|---|---|---|---|---|
| `crm_search_contacts` | read | L21 | `contacts.ts` | não (busca genérica) | fora do escopo |
| `crm_get_contact` | read | L22 | `contacts.ts` | não (leitura genérica) | fora do escopo |
| `crm_list_conversations` | read | L23 | `conversations.ts:31` | **sim** (assignee_kind, tags, queue_position) | §3.5 |
| `crm_get_conversation` | read | L24 | `conversations.ts:94` | **sim** | §3.5 |
| `crm_get_conversation_history` | read | L25 | `conversations.ts:148` | adjacente (contexto de mensagens) | §3.5 (menção) |
| `crm_get_queue_status` | read | L26 | `governance.ts:236` | **sim** (fila) | §3.3 |
| `crm_list_leads` | read | L27 | `leads.ts:82` | **sim** (owner, stage, tags) | §3.6 |
| `crm_get_lead` | read | L28 | `leads.ts:124` | **sim** | §3.6 |
| `crm_list_pipelines` | read | L29 | `pipelines.ts` | não (metadados de pipeline) | fora do escopo |
| `crm_create_lead` | write | L31 | `leads.ts:173` | não (CRUD de lead) | fora do escopo |
| `crm_update_lead` | write | L32 | `leads.ts:227` | não (CRUD de lead) | fora do escopo |
| `crm_move_lead_stage` | write | L33 | `leads.ts:263` | não (CRUD de lead) | fora do escopo |
| `crm_send_whatsapp_message` | write | L34 | `messages.ts:38` | não (envio) — mas tocado pelas proibições (`is_blocked`) | §6.2 |
| `crm_assign_conversation` | write | L35 | `governance.ts:54` | **sim** | §3.1 |
| `crm_manage_tags` | write | L36 | `governance.ts:174` | **sim** | §3.2 |
| `crm_request_human_handoff` | handoff | L38 | `handoff.ts:38` | **sim** | §3.4 |

**As 8 tools de governança que o Vendaval consome** (todas documentadas em §3):
`crm_assign_conversation`, `crm_manage_tags`, `crm_get_queue_status`,
`crm_request_human_handoff`, `crm_get_conversation`, `crm_list_conversations`,
`crm_get_lead`, `crm_list_leads`.

As tools **fora do escopo** deste contrato de governança são leitura/CRUD genérico
(contatos, pipelines, CRUD de lead) e não expõem nem alteram estado de governança de
atendimento. `crm_send_whatsapp_message` não é de governança, mas as proibições
§6.2 a tocam (guard `is_blocked`), então está documentada lá.

---

## 2. Convenções de todas as tools

- **Role/scope** por tool são checados no server core antes do handler. As tools de
  governança exigem `role>=agent` + o scope da categoria (`mcp:read` para read,
  `mcp:write` para write/handoff) — ver `requiresRole`/`requiresScope` em cada
  definição (ex.: `governance.ts:63-64`). As tools de CRUD de lead exigem
  `role>=manager` (`leads.ts:179-180`).
- **Input** é validado por Zod no handler; violação lança erro (o agente recebe a
  mensagem de erro da tool). Campos com `.default(...)` são opcionais.
- **`organization_id` nunca é input.** Não existe em nenhum `inputShape` de
  governança — é injetado do ctx.
- **Erros** são strings de código (ex.: `conversation_not_found`,
  `assignment_conflict`, `target_not_found`) — sem PII (LGPD).

---

## 3. As tools de governança (input/output exatos)

### 3.1 `crm_assign_conversation` — atribuir / transferir / liberar

Handler: `lib/mcp/tools/governance.ts:54`. Categoria `write`, `role>=agent`,
scope `mcp:write`.

**Input** (`governance.ts:40-45`):

| Campo | Tipo | Default | Regra |
|---|---|---|---|
| `conversation_id` | uuid | — | obrigatório |
| `to_user_id` | uuid \| null | `null` | `null` = release (volta à fila) |
| `reason` | `"transfer"` \| `"release"` | `"transfer"` | cross-field abaixo |

Cross-field (`governance.ts:48-52`): `release ⇔ to_user_id null`;
`transfer ⇔ to_user_id preenchido`. Violar isso rejeita antes de qualquer efeito.

**Output** — sempre um objeto (`governance.ts:141-147` / `84-90` / `118-124`):

```json
{ "assigned": true, "conversation_id": "<uuid>", "assigned_to_user_id": "<uuid|null>",
  "reason": "transfer|release", "idempotent": true|false }
```

**Semântica de idempotência e corrida** (crítica para um runtime 1:N):
- **Replay** (comando repetido após já aplicado): a conversa já está no dono alvo ⇒
  retorna `idempotent: true` sem novo assignment event (`governance.ts:83-91`).
- **Corrida** (dois assigns idênticos concorrentes): optimistic lock via
  `p_expected_assignee` — o 1º vence com 1 evento; o 2º vê 0 rows, re-lê e, se o dono
  já é o alvo, devolve `idempotent: true`; senão `assignment_conflict`
  (`governance.ts:98-127`).
- O efeito real (UPDATE + assignment event na mesma transação) é a RPC
  `fn_conversation_assign` (migration 0031/0032). Recusa cross-org — ver §6.1.
- Sucesso não-idempotente grava audit `conversation.transferred|released`
  (`governance.ts:130-139`).

### 3.2 `crm_manage_tags` — add/remove tags

Handler: `lib/mcp/tools/governance.ts:174`. Categoria `write`, `role>=agent`,
scope `mcp:write`.

**Input** (`governance.ts:167-172`):

| Campo | Tipo | Regra |
|---|---|---|
| `target_kind` | `"conversation"` \| `"contact"` \| `"lead"` | obrigatório |
| `target_id` | uuid | obrigatório; alvo tem que ser da org (`governance.ts:196-197`) |
| `add` | string[] | opcional |
| `remove` | string[] | opcional |

Validações (mesma regra G3-05, `governance.ts:185-205`): cada tag é normalizada
(**lowercase, trim, ≤40 chars**) por `conversationTagSchema`; o conjunto final é
deduplicado e limitado a **≤20 tags** por `conversationTagsSchema` (rejeita se
estourar). É obrigatório ao menos um de `add`/`remove` (`governance.ts:187-189`).

**Output** (`governance.ts:226`):

```json
{ "target_kind": "conversation|contact|lead", "target_id": "<uuid>", "tags": ["..."] }
```

Grava audit `conversation.tags_changed|contact.tags_changed|lead.tags_changed`
(`governance.ts:214-224`).

### 3.3 `crm_get_queue_status` — snapshot da fila

Handler: `lib/mcp/tools/governance.ts:236` → `getQueueStatus`
(`lib/routing/queue.ts:27`). Categoria `read`, `role>=agent`, scope `mcp:read`.

**Input:** vazio (`governance.ts:234`).

**Output** (`lib/routing/queue.ts:21-25`, `53-57`):

```json
{ "queue_size": 0, "avg_wait_seconds": 0, "online_eligible_count": 0 }
```

- `queue_size`: conversas na fila = **sem dono ∧ `status='open'`** (`queue.ts:32-37`).
- `avg_wait_seconds`: média de `now − last_inbound_at` das conversas na fila, em
  segundos, arredondada; 0 se fila vazia (`queue.ts:42-49`).
- `online_eligible_count`: atendentes elegíveis AGORA (disponível ∧ horário ∧ com
  folga de capacidade) — quem pode puxar da fila (`queue.ts:51`).

### 3.4 `crm_request_human_handoff` (v2) — bot → humano

Handler: `lib/mcp/tools/handoff.ts:38`. Categoria `handoff`, `role>=agent`,
scope `mcp:write`.

**Input** (`handoff.ts:29-36`):

| Campo | Tipo | Default | Nota |
|---|---|---|---|
| `conversation_id` | uuid | — | obrigatório |
| `reason` | string (1..500) | `"requested_human"` | |
| `urgency` | `"low"`\|`"normal"`\|`"high"` | `"normal"` | |
| `target_user_id` | uuid | — | **opcional**: só atribui se elegível agora; senão rodízio G5 |
| `metadata` | record | — | opcional |

**Semântica v2 — um algoritmo de destino (roteamento G5)** (`handoff.ts:94-160`):
1. Marca a conversa `pending`, **silencia o bot** (`bot_silenced_until='infinity'`),
   registra activity + `event_log` (`ai.handoff_triggered`) + audit — via
   `triggerHandoff` (`handoff.ts:76-88`, cabeçalho `handoff.ts:1-18`).
2. Escolhe o destino entre os **elegíveis** (`loadEligibleAttendants`): usa
   `target_user_id` se elegível agora, senão **rodízio real** `selectRoundRobin`
   (`handoff.ts:97-101`).
3. Se escolheu alguém: **reassignment auditado** kind `ai→'user'`, evento
   `reason='handoff'` na mesma transação (`fn_conversation_assign`,
   `handoff.ts:104-121`).
4. Sem ninguém elegível: **fila** — limpa `assignee_kind` (`ai→null`), insere evento
   `reason='handoff'` (from/to null), calcula posição (`handoff.ts:123-160`).

**Output estruturado** (`handoff.ts:163-176`) — um dos dois lados é populado:

```json
{ "handoff_recorded": true, "conversation_id": "<uuid>",
  "assigned_to": "<uuid|null>", "queued": false, "position": null,
  "assigned_to_user_id": "<uuid|null>", "idempotent": false,
  "next_action": "Avise o cliente ..." }
```

- Atribuído: `assigned_to` = uuid, `queued=false`, `position=null`.
- Enfileirado: `assigned_to=null`, `queued=true`, `position=<1-based>`.
- `assigned_to_user_id` é alias de compat com o contrato anterior (`handoff.ts:170-171`).
- `idempotent=true` quando o handoff foi suprimido pela janela de 5s (`handoff.ts:172`).

### 3.5 Read tools de conversa (campos de governança expostos — G6-03)

**`crm_list_conversations`** (`lib/mcp/tools/conversations.ts:31`) e
**`crm_get_conversation`** (`conversations.ts:94`). Categoria `read`, `role>=agent`,
scope `mcp:read`.

Cada conversa no payload expõe os campos de governança (`conversations.ts:66-83`
para list; `117-138` para get):

| Campo | Fonte | Semântica |
|---|---|---|
| `assignee_kind` | `conversations.assignee_kind` | `'user'` (humano atende) \| `'ai'` (IA atende) \| `null` (fila/sem dono) — §3.7 |
| `assigned_to_user_id` | coluna | uuid do dono ou null |
| `assigned_to_user_name` | resolvido | **só o nome** do atendente, sem email/telefone (LGPD, `conversations.ts:74-76`) |
| `tags` | `conversations.tags` | string[] |
| `queue_position` | `getQueuePositions` | posição **1-based** na fila do inbox; `null` quando não está na fila (`conversations.ts:19-22`, `78`) |

`crm_get_conversation_history` (`conversations.ts:148`) é adjacente (histórico de
mensagens para contexto) — não expõe campos de governança novos.

> **Como ler `assignee_kind` (uso pelo Vendaval):** antes de responder, o agente
> externo lê `assignee_kind`. `'user'` ⇒ **um humano já assumiu** — não intervir
> (§6.2). `'ai'` ⇒ a IA é a dona. `null` ⇒ fila/sem dono.

### 3.6 Read tools de lead (campos de governança expostos — G6-03)

**`crm_list_leads`** (`lib/mcp/tools/leads.ts:82`) e **`crm_get_lead`**
(`leads.ts:124`). Categoria `read`, `role>=agent`, scope `mcp:read`.

Enriquecimento aditivo (`enrichLeads`, `leads.ts:34-67`):

| Campo | Fonte | Semântica |
|---|---|---|
| `owner_user_id` | `crm_leads.owner_user_id` | uuid do dono ou null |
| `owner_user_name` | resolvido | **só o nome** do dono, sem email/telefone (LGPD, `leads.ts:62-64`) |
| `stage` | join `crm_stages` | `{ id, name }` legível (além do `stage_id` cru, `leads.ts:65`) |
| `stage_id`, `status`, `tags` | row (`select *`) | inalterados |

### 3.7 `assignee_kind` — semântica canônica

Coluna `conversations.assignee_kind` (migration
`0032_conversation_assignee_kind`, `supabase/migrations/20260717150000_0032_conversation_assignee_kind.sql:33-34`),
com constraint de coerência (`0032:57-62`):

- `'user'` ⇔ `assigned_to_user_id is not null` (humano atende);
- `'ai'` ⇔ `assigned_to_user_id is null` (IA atende);
- `null` (fila/sem dono).

**Handoff = reassignment auditado.** IA→humano muda `assignee_kind` de `'ai'` para
`'user'` com `reason='handoff'` na RPC `fn_conversation_assign` (§3.4). A conversa
com `assignee_kind='user'` **silencia o bot nativo** deterministicamente
(`workers/ai-response-worker.ts:287` → `skip("assigned_to_human")`), na mesma
família de guard que `force_human` e `bot_silenced_until` (§6.2).

---

## 4. `visibility_mode` — o que o agente externo PODE ler

`visibility_mode` vive em `organizations.settings` (jsonb), valores
`'all'` | `'own_and_unassigned'` | `'own'`, **default `'own_and_unassigned'`**
(migration `0035`, `supabase/migrations/20260717200000_0035_visibility_mode_conversation_rls.sql:1-3`).
Restringe **apenas o role `agent`**; `viewer`/`manager`/`admin` veem toda a org.

O agente externo lê via MCP **org-scoped e sujeito à RLS**. A visibilidade é
imposta no banco, não na aplicação — o agente **não vê além do escopo**:

- **Conversas:** policy `conversations_select` usa `fn_can_view_conversation(org, assigned_to_user_id)`
  (`0035:25-57`). Para `agent`: `'all'` = tudo da org; `'own_and_unassigned'` = suas +
  fila não-atribuída; `'own'` = só as suas (`0035:36-44`). Mensagens herdam
  (conversa oculta ⇒ mensagens ocultas, `0035:91-93`).
- **Leads:** policy `crm_leads_select` usa `fn_can_view_lead(org, owner_user_id)`
  (migration `0036`, `supabase/migrations/20260717210000_0036_visibility_mode_lead_rls.sql:32-70`),
  mesma lógica sobre `owner_user_id`.
- **Filhas de lead:** `crm_lead_activities` e `crm_lead_links` só são visíveis se o
  lead-pai é visível — SELECT via EXISTS na mesma `fn_can_view_lead` (migration
  `0042`, G6-00/INB-10,
  `supabase/migrations/20260718160000_0042_lead_children_visibility_rls.sql:41-56`).
  Fecha o vazamento de herança (activities/links de lead invisível).

> **Regra para o Vendaval:** trate o que a tool retorna como o **teto** do que existe
> para aquele token. Se uma conversa/lead não veio, para aquele escopo ela **não
> existe** — não infira nem tente acessá-la por id direto (a RLS + o filtro
> manual de org no handler barram, ex.: `governance.ts:72-74`, `leads.ts:143-146`).

---

## 5. `ai_dispatch_mode` — quem despacha os eventos de IA (G6-02)

`organizations.settings.ai_dispatch_mode`, valores `'native'` | `'external'`,
**default `'native'`**, com **fail-safe** `.catch("native")` para chave
ausente/null/inválida (schema Zod `aiDispatchModeSchema`,
`lib/schemas/settings.ts:22-24`).

**Semântica** (dispatcher nativo, `lib/ai/dispatcher/index.ts`):
- O dispatcher nativo resolve o modo de todas as orgs do batch numa query
  (`loadDispatchModes`, `index.ts:352-371`), aplicando o mesmo schema Zod
  (`index.ts:368`).
- Org `'external'`: **o dispatcher nativo PULA o evento ANTES do claim** —
  `skipped_external_dispatch`, sem claim, **sem mudança de status**,
  `consumed_by` intacto (`index.ts:143-151`). O evento permanece `pending` no
  `event_log` para o Vendaval consumir.
- Org `'native'` (ou default): processa como hoje (claim + dispatch,
  `index.ts:153-171`).

> **Regra para o Vendaval:** nas orgs que ele atende, setar
> `settings.ai_dispatch_mode='external'` e consumir os eventos
> `ai_agent.dispatch_requested` **pending** do `event_log` (§7). Se esquecer de
> setar, o dispatcher nativo processa o evento primeiro (default `'native'`) —
> não há dupla-execução, mas o Vendaval não recebe o evento.

---

## 6. Proibições explícitas (o que o agente externo NUNCA pode fazer)

### 6.1 NUNCA cross-org

Toda tool é **org-scoped pelo ctx** — `organization_id` vem do token, nunca do input
(`governance.ts:9`). Além disso:
- `crm_assign_conversation`: a conversa tem que ser da org (filtro manual,
  `governance.ts:72-74`) **e** o destino tem que ser membro ativo `agent+` da MESMA
  org — guard **INB-06a** dentro de `fn_conversation_assign` v2, que faz `RAISE` se o
  destino não é membro (migration `0032`,
  `supabase/migrations/20260717150000_0032_conversation_assignee_kind.sql:101-145`,
  comentário `0032:117`). O `membership`/role não é enumerável cross-org (a validação
  vive DENTRO da função, `0032:15-22`).
- `crm_manage_tags`: filtro `organization_id` explícito no fetch e no update
  (`governance.ts:196-197`, `210-211`).
- `crm_get_lead`: defesa em profundidade — 404 se a row não é da org
  (`leads.ts:143-146`).

Um agente externo **nunca** atribui, lê ou etiqueta recurso de outra org.

### 6.2 NUNCA furar `is_blocked` / `force_human` / bot silenciado

- **`contacts.is_blocked` guarda o SEND outbound.** `crm_send_whatsapp_message`
  (`messages.ts:38`) roteia por `sendMessageHandler`, que rejeita com **403
  `forbidden` "Contato bloqueou o atendimento."** se o contato está bloqueado
  (`app/api/v1/messages/_handler.ts:151-159`). O agente externo **não pode enviar a
  contato bloqueado** — a guarda é server-side, não confie em checar no seu lado.
  (O STOP inbound seta `is_blocked=true` automaticamente — CLAUDE.md §WAHA.)
- **`contacts.force_human`** e **`conversations.assignee_kind='user'`** e
  **`conversations.bot_silenced_until > now()`** são os guards de "não deixe o bot
  responder": o worker nativo pula nos três casos
  (`workers/ai-response-worker.ts:283-297`). Para o Vendaval, a regra equivalente é:
  se `assignee_kind='user'` (§3.5) um humano assumiu — **não intervenha**; e ele
  **não pode reativar** um bot silenciado (o `bot_silenced_until='infinity'` do
  handoff, `lib/ai/handoff/orchestrator.ts:96`, só o desfaz uma ação humana no CRM).

### 6.3 Outras invariantes que o código impõe

- **Audit obrigatória em escrita.** Toda mutação de governança grava
  `api_audit_log` (fire-and-forget) com o ator carimbado
  (`governance.ts:130-139`, `214-224`). O agente externo não desliga isso.
- **Idempotência sob replay/corrida** em `crm_assign_conversation` (§3.1): não conte
  com "aplicar duas vezes" — o contrato deduplica.
- **Tags normalizadas e limitadas** (§3.2): não envie tags fora do formato — são
  rejeitadas, não truncadas silenciosamente.
- **PII fora de payloads:** as read tools devolvem **só o nome** de atendente/dono,
  nunca email/telefone (`conversations.ts:74-76`, `leads.ts:62-64`) — o agente
  externo não deve tentar re-derivar PII.

---

## 7. Mudanças requeridas em consumidores (insumo do FG-01)

O que o **Vendaval** precisa fazer do seu lado para consumir este contrato:

1. **Habilitar o modo externo por org.** Setar
   `organizations.settings.ai_dispatch_mode='external'` (§5) nas orgs que o Vendaval
   atende. Sem isso, o dispatcher nativo processa os eventos (default `'native'`).
2. **Consumir os eventos `pending` do `event_log`.** Para orgs `'external'`, o
   evento `ai_agent.dispatch_requested` permanece `pending` com `consumed_by`
   intacto (`lib/ai/dispatcher/index.ts:143-151`). O Vendaval faz o claim/consumo do
   seu lado (a mesma tabela `event_log`, filtrando `event_type` +
   `status='pending'`). Deve marcar o evento como consumido para não reprocessar.
3. **Autenticar org-scoped.** Um token MCP por org, com `role>=agent` e scopes
   `mcp:read`+`mcp:write`. `organization_id` NUNCA vai no input das tools — é o token
   que fixa a org.
4. **Ler `assignee_kind` antes de responder** (§3.5/§3.7): `'user'` ⇒ humano assumiu,
   não intervir; `'ai'`/`null` ⇒ pode agir.
5. **Usar `crm_request_human_handoff` v2 para o fallback humano** (§3.4) — deixar o
   roteamento G5 escolher o destino (passar `target_user_id` só como preferência);
   tratar os dois formatos de retorno (`assigned_to` OU `queued`+`position`).
6. **Respeitar visibilidade** (§4): tratar o retorno das read tools como o teto do
   que existe; não tentar acessar id fora do escopo.
7. **Respeitar as proibições §6:** não enviar a `is_blocked`; não intervir em
   conversa `assignee_kind='user'`; não reativar bot silenciado; nunca cross-org.
8. **Idempotência no envio:** passar `idempotency_key` em `crm_send_whatsapp_message`
   (TTL 24h, `messages.ts:26-31`) em retries.

> **Fora do escopo deste contrato (decisões do FG do Vendaval):** o modelo de claim
> do Vendaval sobre o `event_log` (visibilidade/lock do consumo externo) e o
> mapeamento de credenciais org→token. Este contrato define **a superfície do
> SonghaiCRM**; o lado do Vendaval é o FG-01.

---

## Apêndice A — Refs verificadas em 2026-07-18 @ `ddcc511`

| Ref | Confere |
|---|---|
| `lib/mcp/tools/catalog.ts:19-39` | `TOOL_CATALOG` (16 entradas) |
| `lib/mcp/tools/index.ts:62-75` | sanity handler↔catalog 1:1 |
| `lib/mcp/tools/governance.ts:9` | org do ctx, nunca do input |
| `lib/mcp/tools/governance.ts:40-52` | input `crm_assign_conversation` + cross-field |
| `lib/mcp/tools/governance.ts:83-127` | idempotência replay + corrida |
| `lib/mcp/tools/governance.ts:167-205,226` | input/validações/output `crm_manage_tags` |
| `lib/mcp/tools/governance.ts:234-248` | `crm_get_queue_status` |
| `lib/routing/queue.ts:21-57` | shape `QueueStatus` + `getQueueStatus` |
| `lib/mcp/tools/handoff.ts:29-176` | input/semântica/output `crm_request_human_handoff` v2 |
| `lib/mcp/tools/conversations.ts:66-83,117-138` | campos de governança expostos |
| `lib/mcp/tools/leads.ts:34-67` | `enrichLeads` (owner_user_name, stage) |
| `supabase/migrations/…0032…:33-62,101-145` | `assignee_kind` + guard INB-06a |
| `supabase/migrations/…0035…:1-57` | `visibility_mode` + `fn_can_view_conversation` |
| `supabase/migrations/…0036…:32-70` | `fn_can_view_lead` |
| `supabase/migrations/…0042…:41-56` | filhas de lead visibility (G6-00) |
| `lib/schemas/settings.ts:22-24` | `aiDispatchModeSchema` + `.catch("native")` |
| `lib/ai/dispatcher/index.ts:143-151,352-371` | skip antes do claim (org `external`) |
| `app/api/v1/messages/_handler.ts:151-159` | guard `is_blocked` no SEND |
| `workers/ai-response-worker.ts:283-297` | guards `is_blocked`/`force_human`/`assignee_kind`/`bot_silenced_until` |
| `lib/ai/handoff/orchestrator.ts:96` | `bot_silenced_until='infinity'` no handoff |
