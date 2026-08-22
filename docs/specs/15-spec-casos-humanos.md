# Spec 15 — Casos Humanos (loop assíncrono IA↔humano)

> **Status:** design aprovado (brainstorming 2026-07-23). Pré-implementação.
> **Épico alvo:** `feat/inbox-multimodal` (ou épico próprio "human-cases").
> **Runtime:** `lib/agent-engine/` (harness 24/7). **NÃO** o runtime nativo `lib/ai/runtime/`.

---

## 1. Problema e enquadramento

O lead traz um problema que a IA **não consegue resolver sozinha** (liberar acesso, corrigir algo num sistema externo, uma decisão que exige uma pessoa). Hoje o único caminho é o **handoff**: o humano assume a conversa inteira e o bot silencia pra sempre (`conversations.bot_silenced_until='infinity'`). Isso tira a IA de cena.

O **Caso Humano** é um conceito **novo e paralelo** ao handoff:

- **Handoff (existente, intocado):** humano **assume a conversa**; bot silencia. Via de mão única. `lib/ai/handoff/` + `bot_silenced_until`.
- **Caso Humano (esta spec):** a IA **continua dona da conversa com o lead** e **delega uma _tarefa_ a um humano de retaguarda**. O humano **não fala com o lead** — fala **com a IA**. A IA recebe a resposta do humano e repassa/continua com o lead. Loop assíncrono bidirecional, IA como front-end, humano como recurso de back-office.

### Requisito crítico (o que mais importa)
O risco central não é a mecânica — é **a IA não usar a ferramenta quando devia**: esquecer, alucinar que "vai chamar um humano" e não chamar, ou prometer ao lead algo que exige humano sem abrir o caso. A spec trata isso como requisito de primeira classe (§6), não como detalhe.

---

## 2. Princípio de reuso (não inventar maquinaria)

O loop humano↔IA é o **loop de follow-up de cabeça pra baixo**: em vez do *tempo* reinjetar um turno (`followup_turn`), é o *humano* que reinjeta (`case_reply_turn`). Mesma `job_queue`, mesma técnica de re-entrada temporal (`buildTemporalBlock`), mesmo cron pro follow-up com o lead.

| Peça existente | Papel no Caso Humano |
|---|---|
| `job_queue` (kinds `inbound_turn`/`followup_turn`) — `lib/agent-engine/agent/*`, migration 0050 | + novo kind `case_reply_turn` |
| `followup-turn.ts` / `buildTemporalBlock` | molde do handler de re-entrada do humano |
| `schedule_followup` + cron (`cron/scheduler.ts`, `cron_jobs`) | follow-up com o lead quando o caso está `awaiting_lead` |
| `cancelPendingCronsForLead` (`scheduler.ts:123`) | cancelar follow-ups ao resolver/escalar/opt-out |
| `guardrails/promise/` | guardrail anti-alucinação no outbound (§6) |
| Padrão das 7 tools nativas (`inbound-turn.ts` `AGENT_TOOL_DEFS`/`rawTools`) | as 2 tools novas seguem o mesmo padrão (description-ensina + erro-como-ensino) |
| `ai_agent_versions.tool_ids[]` / flags + tela `app/app/ai/agents/[id]` | ativação por agente (§5) |
| `app/app/ai/inbox/` (shell de UI do assistente) | superfície pra listar casos (seção própria, sem misturar com handoff) |

**Código realmente novo:** 2 tools + 1 handler de turno + 1 guardrail de promessa + 2 tabelas + UI do caso.

---

## 3. Máquina de estados

```
                    ┌───────────────────────────────────────────────┐
   IA não resolve   ▼                                                │
  ──────────────► awaiting_human ──[humano: CONCLUÍDO + txt]──► resolved
   (open_human_case)   │                                             ▲
                       │                                             │
   [humano: PRECISO_INFO_CLIENTE + txt]                              │
                       ▼                                             │
                 awaiting_lead ──[IA colheu X do lead]───────────────┘
                  │   ▲          (provide_case_update → volta p/ humano)
      follow-up ──┘   │  lead responde (via inbound_turn normal)
   (lead não respondeu, N tentativas)
                       │
   [humano: NAO_CONSIGO_ESCALAR] ──► escalated ──► dispara HANDOFF canônico do engine
   [lead opt-out / conversa fechada] ──► cancelled (cancela follow-ups do caso)
```

### Estados (`agent_cases.status`, `text` + CHECK — nunca enum)
- `awaiting_human` — caso aberto pela IA, esperando ação do humano. **Aparece no inbox humano.**
- `awaiting_lead` — humano pediu info do cliente; IA repassou e espera o lead. **Follow-up armado aqui.**
- `resolved` — concluído; IA já informou o lead.
- `escalated` — humano não conseguiu resolver; disparou o handoff canônico. Terminal.
- `cancelled` — lead opt-out / conversa encerrada. Terminal. Cancela follow-ups.

### Transições e efeitos
| De | Gatilho | Para | Efeito |
|---|---|---|---|
| — | IA chama `open_human_case` | `awaiting_human` | cria `agent_cases` + event `opened`; broadcast realtime pro inbox; a conversa com o lead **continua** |
| `awaiting_human` | humano: **CONCLUÍDO** + txt | `resolved` | enfileira `case_reply_turn(action=resolved)` → IA repassa conclusão ao lead |
| `awaiting_human` | humano: **PRECISO_INFO_CLIENTE** + txt | `awaiting_lead` | enfileira `case_reply_turn(action=need_lead_info)` → IA pergunta ao lead; **arma follow-up** |
| `awaiting_lead` | lead responde (inbound normal) + IA colhe info | `awaiting_human` | IA chama `provide_case_update` → event `lead_provided`; re-notifica humano; **cancela follow-up pendente** |
| `awaiting_lead` | follow-up: lead não respondeu (N=2) | `awaiting_lead` (flag) | event `lead_unresponsive`; sinaliza no inbox humano; humano decide |
| `awaiting_human` | humano: **NAO_CONSIGO_ESCALAR** + txt | `escalated` | dispara handoff canônico do engine (§7); event `escalated` |
| qualquer aberto | lead opt-out / conversa fechada | `cancelled` | `cancelPendingCronsForLead`; event `cancelled` |

**Idempotência / dedup:** não há unique constraint dura (um lead pode ter 2 problemas distintos). Mas o **fail-safe do guardrail (§6) só auto-abre se NÃO existir caso aberto** (`awaiting_human`/`awaiting_lead`) pro lead — evita enxurrada de casos duplicados. A tool `open_human_case` pode abrir múltiplos deliberadamente.

---

## 4. Tools nativas do engine

Ambas seguem o padrão das 7 existentes em `inbound-turn.ts` (`AGENT_TOOL_DEFS` para description+schema, `rawTools` para `execute`). São **nativas do engine**, não catálogo MCP puro — igual `request_human_handoff`/`send_message`, ficam atrás dos guardrails e não fazem round-trip HTTP. Só existem quando `cases_enabled` (§5).

### 4.1 `open_human_case`
> **description (ensina comportamento):** "Abra um caso para um humano de retaguarda quando você NÃO conseguir resolver o pedido do lead sozinho (ex.: liberar acesso, corrigir algo num sistema, uma decisão que exige uma pessoa). Você CONTINUA conversando com o lead normalmente — não silencia. Use SEMPRE que for prometer ao lead que alguém vai verificar/resolver: prometer sem abrir o caso é proibido."

Input (Zod `.strict()`, guard prototype-pollution como `schedule-followup.ts`):
```ts
{
  title: string,        // curto: "Liberar acesso ao painel"
  summary: string,      // o que o lead precisa, em pt-br
  blocker: string,      // por que a IA não consegue resolver sozinha
  // context_snapshot é montado pelo runtime a partir da conversa REAL — nunca do modelo
}
```
Efeito: `INSERT agent_cases(status='awaiting_human', ...)` + event `opened` + broadcast realtime `case_pending` no canal `org:<org>:queue`. Retorno `{ok:true, case_id}` ou `{ok:false, error:{message}}` (erro-como-ensino).

### 4.2 `provide_case_update`
> **description:** "Quando um caso está esperando informação do cliente e você já colheu essa informação na conversa, use esta tool para devolver a informação ao humano responsável pelo caso. Não invente — só o que o lead realmente disse."

Input:
```ts
{ case_id: string, info: string }  // info colhida do lead
```
Efeito: valida que o caso está `awaiting_lead` e pertence ao lead/org do turno (nunca confia no payload pra org/lead — resolve da conversa real, como `followup-turn.ts:171`). `status → awaiting_human` + event `lead_provided` + cancela follow-up pendente do caso + re-notifica humano.

### 4.3 Re-entrada do humano — `case_reply_turn`
Quando o humano age na UI, um job `case_reply_turn` entra na `job_queue`. Handler `createCaseReplyTurnHandler` (molde: `followup-turn.ts`):
- Resolve ids de envio da **conversa real** (nunca do payload).
- Reusa `runAgentTurn` injetando um **bloco de re-entrada determinístico** (a intenção veio do botão, não da interpretação do modelo):
  - `resolved`: *"O responsável interno concluiu o caso #<id> com a nota: '<txt>'. Repasse essa conclusão ao lead de forma natural e encerre o assunto."*
  - `need_lead_info`: *"Para resolver o caso #<id>, o responsável interno precisa que você obtenha do cliente: '<txt>'. Pergunte ao lead. Quando tiver a resposta, chame provide_case_update."*
  - `escalate`: não gera turno de IA — dispara handoff (§7).
- Envio continua sendo **sempre** via `send_message` (texto direto é descartado, como hoje).

`job_queue.kind` CHECK precisa ganhar `'case_reply_turn'` (§8, altera CHECK da migration 0050).

---

## 5. Ativação por agente + "contexto MCP bem carregado"

### 5.1 Flag
`ai_agent_versions.cases_enabled boolean not null default false`. Editável na tela `app/app/ai/agents/[id]` (mesma família de `handoff_tool_enabled`, `multimodal_input`, `split_messages`). Resolvida por turno via ponteiro publicado (`loadPublishedAgentConfig`, zero cache — publicar já vale no próximo turno).

### 5.2 Quando ligado
1. Injeta as tools `open_human_case` + `provide_case_update` no turno.
2. **Injeta um bloco de sistema dedicado** — é o "contexto MCP bem carregado quando ativo" que o requisito pede. Fica no **prefixo cacheável** (system+tools), sempre residente, **não some no meio da conversa mesmo com contexto longo**. Conteúdo: quando abrir caso, o que capturar, a regra "prometer humano ⇒ abrir caso", e que a conversa não silencia. Camada análoga ao índice de skills (`inbound-turn.ts:555`).
3. Liga o guardrail de promessa (§6).

### 5.3 Quando desligado
Nada disso existe: tools ausentes, bloco ausente, guardrail off. A tela mostra o toggle desligado.

---

## 6. Anti-alucinação (requisito crítico) — "Bloqueia + auto-abre (fail-safe)"

Três camadas; a 3ª é a garantia dura.

1. **Descrição-ensina** (nas tools, §4) + **erro-como-ensino** (retorno `{ok:false,error}` em vez de exceção).
2. **Bloco de sistema residente** (§5.2) no prefixo cacheável.
3. **Gate novo na cadeia `before-send`** (`lib/agent-engine/guardrails/before-send.ts` — `BEFORE_SEND_GATES`, array declarativo de gates que roda dentro do `execute` do `send_message`, antes do envio de fato). Só ativo quando `cases_enabled`. Mecânica exata:
   - **Detector determinístico** `detectHumanPromise(body): boolean` (novo, molde `guardrails/promise/engine.ts`): regex PT-BR de promessa de retaguarda humana — "vou verificar com a equipe/o responsável", "nosso time vai resolver", "assim que liberarem/resolverem eu te aviso", "vou acionar/passar pro/encaminhar pro responsável". Conservador (baixo falso-positivo). Opcionalmente compõe com a camada semântica existente (`classifyPromise`) num 2º momento.
   - **Sinal no `GateContext`** (carregado sob o advisory lock, como os outros): `hasOpenCase` = existe caso `awaiting_human`/`awaiting_lead` pro contato.
   - **Novo gate `casePromiseGate`** (clona `semanticPromiseGate`, before-send.ts:217): `pass:false, code:'case_promise_without_case'` quando `detectHumanPromise(body) && !hasOpenCase && !openedCaseThisTurn`. **Bumpar `BEFORE_SEND_CHAIN_VERSION`** (before-send.ts:298).
   - **Ação fail-safe (orquestrada no `execute` do `send_message`, inbound-turn.ts:788-832):** o veto `case_promise_without_case` volta como erro-de-ensino ao modelo. Um contador por-turno rastreia as tentativas:
     1. **1ª vez:** retorna o erro instrutivo ("Você prometeu envolver um humano mas não abriu caso — chame `open_human_case` OU reformule sem prometer humano.") → o modelo re-tenta.
     2. **2ª vez (persistiu):** o sistema **auto-abre** um caso mínimo (`open_human_case` com `source='guardrail_autofallback'`, `title`/`summary`/`blocker` derivados do contexto), event `opened(source=guardrail_autofallback)`, e **libera o envio** (agora `hasOpenCase` é verdade).
   - **Invariante garantida:** *o lead nunca recebe uma promessa de humano sem que exista um caso aberto correspondente.*

**Backstop determinístico:** diferente do handoff G1 (gatilhado pelo lead), abrir caso é gatilhado pela *incapacidade da IA* — o backstop real é este gate de outbound (o `detectHumanPromise`), não um sentinela de keyword no inbound.

---

## 7. Ponte de escalação (Caso → Handoff)

Quando o humano clica **"Não consigo → escalar"**, o caso vira `escalated` e dispara o **handoff canônico do engine** — a IA sai de cena e um humano assume a conversa (fluxo existente). O texto do humano vira o `reason` do handoff.

**Resolvido (era risco §10.1):** o caminho canônico do engine é **`performHumanHandoff`** (`lib/agent-engine/agent/human-handoff.ts:149`) — já é o que a tool inline `request_human_handoff` delega internamente, e o que a detecção determinística e o opt-out chamam. A escalação do caso chama:
```ts
await performHumanHandoff(pool, { tenantId, leadId, conversationId },
  { reason: <texto do humano>, conversationSummary: buildHandoffSummary(previous), log });
```
Efeitos (idempotentes): `contacts.force_human=true`, `conversations.status ai_handling→pending` + `bot_silenced_until='infinity'`, `cancelPendingCronsForLead`, INSERT `agent_inbox_items(kind='handoff')`. Não criamos um 3º caminho.

---

## 8. Schema (migration 0064 + baseline + MANIFEST)

Doutrina do repo: migration versionada **+** apêndice idempotente no `baseline.sql` **+** linha no `MANIFEST.md`. Toda tabela tenant-aware: `organization_id uuid not null references organizations(id) on delete cascade` + RLS `tenant_isolation_*` via `fn_user_org_ids()`. `status` = `text` + CHECK. Timestamps `timestamptz`.

### 8.1 `agent_cases`
```sql
create table if not exists agent_cases (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  lead_id uuid references crm_leads(id) on delete set null,   -- lead 1ª classe (ver memória agent-harness)
  agent_id uuid references ai_agents(id) on delete set null,
  status text not null default 'awaiting_human'
    check (status in ('awaiting_human','awaiting_lead','resolved','escalated','cancelled')),
  title text not null,
  summary text not null,
  blocker text not null,
  context_snapshot jsonb not null default '{}'::jsonb,
  source text not null default 'agent'
    check (source in ('agent','guardrail_autofallback')),
  followup_attempts smallint not null default 0,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,               -- setado em resolved/escalated/cancelled
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- inbox: casos abertos por org
create index if not exists agent_cases_open_idx
  on agent_cases (organization_id, status) where status in ('awaiting_human','awaiting_lead');
create index if not exists agent_cases_lead_idx on agent_cases (organization_id, lead_id);
```

### 8.2 `agent_case_events` (append-only, timeline)
```sql
create table if not exists agent_case_events (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  case_id uuid not null references agent_cases(id) on delete cascade,
  kind text not null check (kind in
    ('opened','human_replied','lead_asked','lead_provided','lead_unresponsive',
     'resolved','escalated','cancelled')),
  actor_kind text not null check (actor_kind in ('agent','human','system','lead')),
  actor_user_id uuid references auth.users(id) on delete set null,
  human_action text check (human_action in ('resolved','need_lead_info','escalate')),  -- só quando actor=human
  body text,                          -- texto do humano / nota
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists agent_case_events_case_idx on agent_case_events (case_id, created_at);
```
Append-only, sem RLS de UPDATE/DELETE (como `api_audit_log`). RLS select/insert por org.

### 8.3 Alterações em tabelas existentes
- `ai_agent_versions add column if not exists cases_enabled boolean not null default false;`
- `job_queue` — estender o CHECK de `kind` pra incluir `'case_reply_turn'` (migration 0050). Como não dá pra `ALTER ... ADD` valor num CHECK, a migration **dropa e recria** o CHECK idempotentemente (drop constraint if exists → add). Mesmo tratamento no apêndice do baseline.

---

## 9. UI

Reusa o shell `app/app/ai/inbox/` (assistente), **seção/tab própria "Casos"** — separada do inbox de handoff (modelo "novo e paralelo").

- **Lista de casos abertos** (`agent_cases` where status in awaiting_*), via **polling react-query (60s)** — molde exato de `hooks/ai/useAgentInbox.ts` (`refetchInterval: 60_000`), que é como o inbox do assistente já funciona hoje. Badge de `lead_unresponsive`. *(Realtime push fica como enhancement futuro via `useRealtimeChannel` — YAGNI no MVP, o humano não fica olhando a tela sub-60s.)*
- **Detalhe do caso** (mock aprovado no brainstorming): cabeçalho (cliente + pedido), o que a IA abriu (`title`/`summary`/`blocker`), timeline (`agent_case_events`), e o painel de resposta com **3 ações estruturadas** + textarea:
  - `[ Concluí ✓ ]` → `human_action=resolved`
  - `[ Preciso de info do cliente ]` → `human_action=need_lead_info`
  - `[ Não consigo → escalar ]` → `human_action=escalate`
  - `[ Enviar p/ IA ]` → POST cria event `human_replied` + enfileira `case_reply_turn` (ou dispara handoff se `escalate`).
- **Clareza (requisito):** o estado do caso é sempre visível (esperando você / esperando cliente / resolvido / escalado). A UI não deixa ambíguo de quem é a bola.
- Rota API: `POST /api/v1/ai/cases/[id]/reply` — molde `app/api/v1/leads/[id]/win/route.ts`: `requireRole("agent", {requestId, resource})` (valida JWT via `getUser()`, org do cookie validado — nunca do body), Zod no body, `audit(...)`, `ok()`/`fail()`, `X-Request-Id`. **Sem rate-limit** (rota autenticada de staff, não pública — doutrina: rate-limit só em rota pública). `GET /api/v1/ai/cases` e `GET /api/v1/ai/cases/[id]` (detalhe + timeline) seguem o molde de `app/api/v1/ai/inbox/route.ts`.

---

## 10. Riscos e questões abertas
1. ~~Qual handoff é o canônico do engine~~ — **RESOLVIDO (§7):** `performHumanHandoff` (`human-handoff.ts:149`).
2. **Detector `detectHumanPromise`** (§6) — calibração pra baixo falso-positivo/negativo é o ponto mais sensível; os golden adversariais (§11.1) são o gate. Bumpar `BEFORE_SEND_CHAIN_VERSION`.
3. ~~Confirmar runtime em produção~~ — **RESOLVIDO (Wave 0):** `AGENT_DISPATCH_CONSUMER` faz default para `'engine'` (`lib/env.ts:85`, `lib/agent-engine/env.ts:46`) e `.env.example`/`.env.selfhost.example` setam `engine` → agent-engine é o runtime de produção.
4. **N de follow-up** default = 2 tentativas antes de `lead_unresponsive` — número a validar em uso.

---

## 11. Testes (requisito explícito)

### 11.1 Golden adversariais (o gate anti-alucinação) — formato `lib/agent-engine/golden-candidates/*.json`
- **Deve-abrir:** lead pede algo que a IA não resolve → asserta `open_human_case` chamado, caso criado `awaiting_human`.
- **Tentação (crítico):** cenário que induz a IA a dizer "vou verificar com a equipe" **sem** abrir caso → asserta que o **guardrail bloqueia**, re-prompta, e (se persistir) **auto-abre** o caso. Invariante: nenhuma mensagem-promessa sai sem caso aberto.
- **Não-abrir (falso-positivo):** fala genérica que *parece* promessa mas não é → asserta que o guardrail **não** bloqueia indevidamente.

### 11.2 Unit / integração
- Máquina de estados: cada transição de §3 (incl. `provide_case_update` só de `awaiting_lead`; escalate → handoff).
- Follow-up: armado ao entrar em `awaiting_lead`; cancelado ao `resolved`/`escalated`/`cancelled` (`cancelPendingCronsForLead`).
- Dedup: guardrail não auto-abre se já há caso aberto pro lead.
- Idempotência do `case_reply_turn` (re-entrega não duplica envio).
- Isolamento RLS: 2 tenants, sem vazamento em `agent_cases`/`agent_case_events` (gate obrigatório do CI).

### 11.3 E2E
- Playwright: abrir caso (simulado) → aparece no inbox → humano "Preciso de info" → IA pergunta ao lead → lead responde → `provide_case_update` → humano "Concluí" → IA informa o lead → caso `resolved`. Prova visual em cada passo.

---

## 11.4 Cadência de execução (NÃO NEGOCIÁVEL)

Testar **imediatamente a cada peça**, nunca só no fim do épico. Quebrou → **arruma na hora** antes de avançar.

- **Toda peça de front-end** é provada em **Playwright** — e avaliada em **duas dimensões**: (a) funciona? (b) **a experiência está completa, clara, o usuário entende o que é isso?** Qualquer "não" na dimensão (b) **pede correção imediata** — não é polimento pós-épico.
- **Toda peça de back-end** tem teste rodado no passo (unit/integração). Nada pode quebrar; regressão vermelha para o avanço.
- **Toda peça front+back** (ex.: `POST /api/v1/ai/cases/[id]/reply` → `case_reply_turn` → envio ao lead) é testada de ponta a ponta no passo, mesmo esquema.
- **`HANDOFF.md` vivo** (na raiz do épico): lido no início de cada avanço e **alimentado continuamente** com — progresso, testes rodados e resultado, bugs achados, bugs corrigidos, o que ficou pra trás, o que foi acrescentado, e o **estado atual** do desenvolvimento. Zero progresso invisível.

Cada wave do plano (§writing-plans) carrega esse gate embutido: build → prova (Playwright/teste) → avalia UX → corrige se preciso → alimenta HANDOFF → só então checkpoint.

## 12. Definition of Done
1. `npm run typecheck` + `npm run lint` zerados.
2. Golden adversariais (§11.1) passando — **gate anti-alucinação**.
3. Unit/integração + isolamento RLS + E2E passando.
4. Migration 0064 versionada **+** apêndice idempotente no `baseline.sql` **+** linha no `MANIFEST.md` (clones atualizam). Baseline validado em Postgres descartável (install fresh + update re-aplicado).
5. Audit log emitido nas mutações; rate limit + Zod na rota pública; sem `console.log`.
6. `cases_enabled` documentado; `lib/database.types.ts` regenerado.
7. Um staff engineer aprovaria? Se não, itera.
