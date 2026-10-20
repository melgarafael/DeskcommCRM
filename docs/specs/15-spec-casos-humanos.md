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

O loop humano↔IA é o **loop de follow-up de cabeça pra baixo**: em vez do _tempo_ reinjetar um turno (`followup_turn`), é o _humano_ que reinjeta (`case_reply_turn`). Mesma `job_queue`, mesma técnica de re-entrada temporal (`buildTemporalBlock`), mesmo cron pro follow-up com o lead.

| Peça existente                                                                                  | Papel no Caso Humano                                                           |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `job_queue` (kinds `inbound_turn`/`followup_turn`) — `lib/agent-engine/agent/*`, migration 0050 | + novo kind `case_reply_turn`                                                  |
| `followup-turn.ts` / `buildTemporalBlock`                                                       | molde do handler de re-entrada do humano                                       |
| `schedule_followup` + cron (`cron/scheduler.ts`, `cron_jobs`)                                   | follow-up com o lead quando o caso está `awaiting_lead`                        |
| `cancelPendingCronsForLead` (`scheduler.ts:123`)                                                | cancelar follow-ups ao resolver/escalar/opt-out                                |
| `guardrails/promise/`                                                                           | guardrail anti-alucinação no outbound (§6)                                     |
| Padrão das 7 tools nativas (`inbound-turn.ts` `AGENT_TOOL_DEFS`/`rawTools`)                     | as 2 tools novas seguem o mesmo padrão (description-ensina + erro-como-ensino) |
| `ai_agent_versions.tool_ids[]` / flags + tela `app/app/ai/agents/[id]`                          | ativação por agente (§5)                                                       |
| `app/app/ai/inbox/` (shell de UI do assistente)                                                 | superfície pra listar casos (seção própria, sem misturar com handoff)          |

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
- `resolved` — decisão humana concluída; comunicação ao lead é estado separado e deve ser conferida.
- `escalated` — humano não conseguiu resolver; disparou o handoff canônico. Terminal.
- `cancelled` — lead opt-out / conversa encerrada. Terminal. Cancela follow-ups.

### Transições e efeitos

| De               | Gatilho                                        | Para                   | Efeito                                                                                                     |
| ---------------- | ---------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| —                | IA chama `open_human_case`                     | `awaiting_human`       | cria `agent_cases` + event `opened`; broadcast realtime pro inbox; a conversa com o lead **continua**      |
| `awaiting_human` | humano: **CONCLUÍDO** + txt                    | `resolved`             | enfileira `case_reply_turn(action=resolved)` → IA repassa conclusão ao lead                                |
| `awaiting_human` | humano: **PRECISO_INFO_CLIENTE** + txt         | `awaiting_lead`        | enfileira `case_reply_turn(action=need_lead_info)` → IA pergunta ao lead; **arma follow-up**               |
| `awaiting_lead`  | lead responde (inbound normal) + IA colhe info | `awaiting_human`       | IA chama `provide_case_update` → event `lead_provided`; re-notifica humano; **cancela follow-up pendente** |
| `awaiting_lead`  | follow-up: lead não respondeu (N=2)            | `awaiting_lead` (flag) | event `lead_unresponsive`; sinaliza no inbox humano; humano decide                                         |
| `awaiting_human` | humano: **NAO_CONSIGO_ESCALAR** + txt          | `escalated`            | dispara handoff canônico do engine (§7); event `escalated`                                                 |
| qualquer aberto  | lead opt-out / conversa fechada                | `cancelled`            | `cancelPendingCronsForLead`; event `cancelled`                                                             |

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

Efeito: `INSERT agent_cases(status='awaiting_human', ...)` + event `opened` + `emit_event('ai.case_opened')`.

> ⚠️ **Correção de estado (2026-09-18).** Este parágrafo prometia um _broadcast realtime `case_pending` no canal `org:<org>:queue`_ — ele **nunca existiu**: `grep -rn "case_pending" lib app hooks workers` sai vazio. Quem avisa é o `event_log`: `ai.case_opened` (reservado pela migration 0279) tem hoje dois consumidores — o gatilho de follow-up e o aviso ao suporte no WhatsApp (migration 0292). A tela de casos continua em consulta periódica, como o próprio §9 descreve.

Retorno `{ok:true, case_id}` ou `{ok:false, error:{message}}` (erro-como-ensino).

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
  - `resolved`: _"O responsável interno concluiu o caso #<id> com a nota: '<txt>'. Repasse essa conclusão ao lead de forma natural e encerre o assunto."_
  - `need_lead_info`: _"Para resolver o caso #<id>, o responsável interno precisa que você obtenha do cliente: '<txt>'. Pergunte ao lead. Quando tiver a resposta, chame provide_case_update."_
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
3. **Gate novo na cadeia `before-send`** (`lib/agent-engine/guardrails/before-send.ts` — `BEFORE_SEND_GATES`, array declarativo de gates que roda dentro do `execute` do `send_message`, antes do envio de fato). A exigência de Caso para retorno futuro depende de `cases_enabled`; a proteção da conclusão humana e a revalidação de fonte existente permanecem mesmo com Casos desligado. Mecânica exata:
   - **Detecção de compromisso operacional:** `detectHumanPromise(body)` (regex PT-BR conservadora) compõe em OU com `classifyPromise(...).prometeuRetornoHumano`. Ver os consumidores atuais em `casePromiseGate`, `lib/agent-engine/guardrails/before-send.ts`. A instrução semântica separa compromisso comercial de compromisso de retaguarda: "vou verificar com a equipe" e "já registrei sua solicitação para análise" assumem operação, mas não são, por si só, oferta comercial indevida. A evidência de política autoriza o serviço; não comprova que uma operação específica já ocorreu.
   - **Não-compromissos:** descrever avaliação durante o serviço, citar autores, convidar para oferta aprovada, pedir ao cliente que avise quando concluir um formulário ou perguntar se ele deseja transferência não assume abertura de pendência. O detector isenta somente a frase de consentimento; outra frase que diga "já acionei a equipe" continua sendo avaliada. "Posso transferir agora?" pede consentimento; "estou transferindo" afirma execução.
   - **Diagnóstico opcional da revisão:** `humanReturnPhrase` deve ser trecho literal da candidata e `humanReturnCategory` deve ser `internal_action`, `human_contact` ou `assistant_followup`. Campos ausentes/inválidos são descartados, sem desligar o boolean nem seu fallback léxico. São dados transitórios da classificação; nenhum trecho de conversa é incluído em log geral.
   - **Segunda opinião opcional:** quando há `prometeuRetornoHumano=true` ou conclusão humana reconhecida e existe binding habilitado de `human_return_confirmation` na mesma organização. O operador escolhe o modelo em IA > Provedores > Proteger a operação > Confirmar compromisso de retorno humano. Sem escolha explícita, permanece uma revisão. A segunda opinião recebe a mesma candidata inteira, evidências e histórico e só pode confirmar/rejeitar o sinal humano; `isPromise` e `suspectPhrase` permanecem os da primeira revisão. Falha de configuração, fornecedor, orçamento ou JSON conserva a marcação inicial de retorno; na revisão de conclusão humana, impede fidelidade positiva. A composição em OU com o detector léxico não muda. A memoização abrange as duas leituras; nenhum fornecedor é obrigatório, e não se altera agente, caso ou transferência neste passo.
   - **Sinal no `GateContext`** (carregado sob o advisory lock, como os outros): `hasOpenCase` = existe caso `awaiting_human`/`awaiting_lead` pro contato.
   - **Novo gate `casePromiseGate`** (clona `semanticPromiseGate`, before-send.ts:217): `pass:false, code:'case_promise_without_case'` quando `detectHumanPromise(body) && !hasOpenCase && !openedCaseThisTurn`. **Bumpar `BEFORE_SEND_CHAIN_VERSION`** (before-send.ts:298).
   - **Ação fail-safe (orquestrada no `execute` do `send_message`, inbound-turn.ts:788-832):** o veto `case_promise_without_case` volta como erro-de-ensino ao modelo. Um contador por-turno rastreia as tentativas:
     1. **1ª vez:** retorna o erro instrutivo ("Você prometeu envolver um humano mas não abriu caso — chame `open_human_case` OU reformule sem prometer humano.") → o modelo re-tenta.
     2. **2ª vez (persistiu):** o sistema **auto-abre** um caso mínimo (`open_human_case` com `source='guardrail_autofallback'`, `title`/`summary`/`blocker` derivados do contexto), event `opened(source=guardrail_autofallback)`, e **libera o envio** (agora `hasOpenCase` é verdade).
   - **Invariante garantida:** _o lead nunca recebe uma promessa de humano sem que exista um caso aberto correspondente._

**Backstop determinístico:** diferente do handoff G1 (gatilhado pelo lead), abrir caso é gatilhado pela _incapacidade da IA_ — o backstop real é este gate de outbound (o `detectHumanPromise`), não um sentinela de keyword no inbound.

---

## 7. Ponte de escalação (Caso → Handoff)

Quando o humano clica **"Não consigo → escalar"**, o caso vira `escalated` e dispara o **handoff canônico do engine** — a IA sai de cena e um humano assume a conversa (fluxo existente). O texto do humano vira o `reason` do handoff.

**Resolvido (era risco §10.1):** o caminho canônico do engine é **`performHumanHandoff`** (`lib/agent-engine/agent/human-handoff.ts`) — já é o que a tool inline `request_human_handoff` delega internamente, e o que a detecção determinística e o opt-out chamam. Não criamos um 3º caminho.

A ferramenta nativa `request_human_handoff` aceita `motivo_codigo` opcional:
`requested_human` para pedido de atendente e `critical_stage` quando a etapa exige
finalização pela equipe (por exemplo, concluir um agendamento com os dados já
coletados). Ausente, preserva `requested_human`; mencionar agendamento por si só
não é razão para encaminhar. O código classifica o briefing, a passagem e o aviso
da Central, sem escolher destino nem alterar as condições do handoff. `por_que`
continua sendo a justificativa em texto, com `reason` como sinônimo legado.
Outros códigos são recusados pelo runtime com erro de ensino; os motivos de
orçamento, opt-out e casos escalados continuam nos seus emissores próprios.

O que a escalação do caso passa a ele mudou com a migration 0291/0293: além do `reason` (o texto do humano), ela monta o **briefing da passagem** (`lib/escalacao/briefing-da-passagem.ts`) com o caso **mais o checkpoint durável da conversa**, e declara `passagem: { origem: 'caso_escalado', motivoCodigo: 'caso_escalado', casoId }`. Esta seção mandava usar `buildHandoffSummary(previous)` e o código nunca o fez — quem recebia a passagem de um caso escalado via o título, o resumo e o bloqueio do caso, e nada da conversa.

Para ver a chamada em vigor sem acreditar nesta prosa (comando não envelhece):

```bash
grep -n "performHumanHandoff" -B 20 'app/api/v1/ai/cases/[id]/reply/route.ts'
```

Efeitos (idempotentes): `contacts.force_human=true`, `conversations.status ai_handling→pending` + `bot_silenced_until='infinity'`, `cancelPendingCronsForLead`, INSERT em `passagens_de_atendimento`, e o item de `agent_inbox_items(kind='handoff', ref_kind='conversation')` — que é **inserido ou acrescentado**, nunca descartado.

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

Append-only, sem RLS de UPDATE/DELETE (como `api_audit_log`). **RLS de SELECT por org — e só
ela, desde a migration 0279**: a policy de INSERT saiu junto com o GRANT de escrita de
`authenticated`, aqui e em `agent_cases`. Quem escreve caso é o motor (`pg.Pool` em
`lib/agent-engine/agent/human-cases.ts`) e o cron (service role); nenhum caminho do produto
escrevia por login de usuário, e enquanto a porta existiu um `viewer` reescrevia pelo PostgREST
o texto que a equipe lê para decidir. Para ver o que está em vigor sem confiar nesta linha:
`grep -nEi 'policy .*(agent_cases|agent_case_events)' supabase/baseline.sql`. Vigiado por
`tests/invariants/caso-so-nasce-do-motor.test.ts`.

### 8.3 Alterações em tabelas existentes

- `ai_agent_versions add column if not exists cases_enabled boolean not null default false;`
- `job_queue` — estender o CHECK de `kind` pra incluir `'case_reply_turn'` (migration 0050). Como não dá pra `ALTER ... ADD` valor num CHECK, a migration **dropa e recria** o CHECK idempotentemente (drop constraint if exists → add). Mesmo tratamento no apêndice do baseline.

---

## 9. UI

Reusa o shell `app/app/ai/inbox/` (assistente), **seção/tab própria "Casos"** — separada do inbox de handoff (modelo "novo e paralelo").

- **Lista de casos abertos** (`agent_cases` where status in awaiting_*), via **polling react-query (60s)** — molde exato de `hooks/ai/useAgentInbox.ts` (`refetchInterval: 60_000`), que é como o inbox do assistente já funciona hoje. Badge de `lead_unresponsive`. _(Realtime push fica como enhancement futuro via `useRealtimeChannel` — YAGNI no MVP, o humano não fica olhando a tela sub-60s.)_
- **Detalhe do caso** (mock aprovado no brainstorming): cabeçalho (cliente + pedido), o que a IA abriu (`title`/`summary`/`blocker`), timeline (`agent_case_events`), e o painel de resposta com **3 ações estruturadas** + textarea:
  - `[ Concluí ✓ ]` → `human_action=resolved`
  - `[ Preciso de info do cliente ]` → `human_action=need_lead_info`
  - `[ Não consigo → escalar ]` → `human_action=escalate`
  - `[ Enviar p/ IA ]` → POST cria event `human_replied` + enfileira `case_reply_turn` (ou dispara handoff se `escalate`).
- **Clareza (requisito):** o estado do caso é sempre visível (esperando você / esperando cliente / resolvido / escalado). A UI não deixa ambíguo de quem é a bola.
- **Quem é avisado fora da tela, e quando** _(migration 0292, tela `/app/ai/cases/avisos`)_:
  - **existe**: uma mensagem no WhatsApp de um número da equipe, **na ABERTURA do caso**, uma vez por caso. É opt-in de quem administra (`config_aviso_de_caso.ligado`), sai fora do horário comercial de propósito (a janela protege o cliente, e a equipe é interna) e o registro de cada tentativa fica em `entregas_de_aviso_de_caso`;
  - **existe**: o vigia `case-stale-watcher`, que cobra até três vezes **na Central** o caso que ninguém abriu;
  - **NÃO existe**: re-notificação quando o cliente responde e o caso volta de `awaiting_lead` para `awaiting_human`. O aviso não se repete, e a tela do aviso diz isso com essas palavras. Quem quiser acompanhar a volta usa a Central.

- Rota API: `POST /api/v1/ai/cases/[id]/reply` — molde `app/api/v1/leads/[id]/win/route.ts`: `requireRole("agent", {requestId, resource})` (valida JWT via `getUser()`, org do cookie validado — nunca do body), Zod no body, `audit(...)`, `ok()`/`fail()`, `X-Request-Id`. **Sem rate-limit** (rota autenticada de staff, não pública — doutrina: rate-limit só em rota pública). `GET /api/v1/ai/cases` e `GET /api/v1/ai/cases/[id]` (detalhe + timeline) seguem o molde de `app/api/v1/ai/inbox/route.ts`.

---

## 10. Riscos e questões abertas

1. ~~Qual handoff é o canônico do engine~~ — **RESOLVIDO (§7):** `performHumanHandoff` (`human-handoff.ts:149`).
2. **Detector `detectHumanPromise`** (§6) — calibração pra baixo falso-positivo/negativo é o ponto mais sensível; os golden adversariais (§11.1) são o gate. Bumpar `BEFORE_SEND_CHAIN_VERSION`.
3. ~~Confirmar runtime em produção~~ — **RESOLVIDO (Wave 0):** `AGENT_DISPATCH_CONSUMER` faz default para `'engine'` (`lib/env.ts:85`, `lib/agent-engine/env.ts:46`) e `.env.example`/`.env.hostgator.example` setam `engine` → agent-engine é o runtime de produção.
4. **N de follow-up** default = 2 tentativas antes de `lead_unresponsive` — número a validar em uso.

---

## 11. Testes (requisito explícito)

### 11.1 Golden adversariais (o gate anti-alucinação) — formato `lib/agent-engine/golden-candidates/*.json`

- **Deve-abrir:** lead pede algo que a IA não resolve → asserta `open_human_case` chamado, caso criado `awaiting_human`.
- **Tentação (crítico):** cenário que induz a IA a dizer "vou verificar com a equipe" **sem** abrir caso → asserta que o **guardrail bloqueia**, re-prompta, e (se persistir) **auto-abre** o caso. Invariante: nenhuma mensagem-promessa sai sem caso aberto.
- **Não-abrir (falso-positivo):** fala genérica que _parece_ promessa mas não é → asserta que o guardrail **não** bloqueia indevidamente.

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

## 13. Proveniência da resposta humana e contexto de revisão

A rota autenticada conserva `requireSupportWrite()` e `requireRole("agent")`. Para `resolved` e `need_lead_info`, gera o ID de `human_replied`, executa a transição condicional, enfileira `case_reply_turn` e liga evento/job na mesma transação. `metadata.review_context_v1` registra versão, origem autenticada, papel verificado e job; não aceita autoridade/autor por body. Não há tabela paralela de aprovações nem permissão de escrita do Data API sobre eventos.

O handler usa o payload como ponteiro e relê evento, Caso, conversa, contato e fronteira. A nota vem do evento persistido. Outro job não pode reutilizar um evento já ligado. Legado só é correlacionado com correspondência única de Caso/ação/nota e fronteira comprovável; CAS reserva o evento para um job sem fabricar papel histórico. Ausência, empate, revogação, expiração ou atendimento obsoleto não autorizam reentrada.

`carregarContextoDeDecisaoHumana` agrupa três leituras: fronteira; decisões de Casos/pedido original; pedido atual e política de revisão. Um evento resolvido autenticado, pedido original por ponteiro e fronteira válida podem sustentar a prova interna. A semântica ainda precisa comprovar a fidelidade de toda a candidata ao mesmo objeto/beneficiário/data/condições. Notas vagas e mera autorização de tentar/executar não provam conclusão. `need_lead_info` informa a pergunta, sem receber exceção positiva.

O pacote factual comum chega ao agente, reserva, JEV autorizado e confirmador com minimização. Antes do efeito, a fotografia é relida sob transação; alteração da nota/estado fica bloqueada até terminar esse efeito. Mudança de contexto exige nova revisão, limitada a uma tentativa fora do lock. Uma reentrada já ligada ao Caso que permanece vetada registra pendência e não abre automaticamente outra cópia do mesmo Caso. O histórico de entrega e a expansão das fontes continuam pertencendo às suas próprias etapas.

Provas novas: `tests/invariants/revisor-contexto-casos.test.ts` e `lib/agent-engine/guardrails/promise/contrato-contexto.test.ts`; regressões dos Casos permanecem separadas. A instrução histórica sobre MANIFEST na seção anterior é substituída pela doutrina atual do repositório: migration nova usa `-- manifest:` e baseline idempotente, sem editar o MANIFEST histórico. Este recorte reutiliza metadata e grants existentes e não altera schema.


## Contexto factual de fontes e continuidade

Pedido/autoria/validade: `inbound_turn` usa `inbound_message_id`; `case_reply_turn` usa o evento autenticado (ou correlação legada única) e o pedido original do snapshot. A mensagem é relida na org/conversa/contato/revisão de atendimento. Abrir a primeira demanda não é atendimento novo; um pedido anterior sem demanda permanece na mesma revisão. Outra revisão não é aceita. O gatilho humano tem seu próprio instante e não simula nova fala do cliente.

Histórico outbound só inclui `sent/delivered/read`. Ator autenticado registrado informa autoria humana; sem esse registro permanece `unknown_outbound`. Instante/fuso da fonte acompanham o texto. Recortes de histórico/resumo são auxiliares e cobertura limitada não autoriza repasse fiel. A revisão relê fontes, política/bindings/aceite, produtos consultados, ponteiros de conhecimento/skills, cancelamento e fronteira. Memória/skill retirada não é ressuscitada pelo snapshot. Revalidação final vale também sem decisão de Caso elegível, com uma repetição fora da transação e pendência após nova mudança.

`contexto-do-atendimento.ts` lê fontes canônicas em uma consulta agrupada e scoped por organização, contato, conversa e job. O contato não é o negócio: campos e decisões conservam aliases por negócio e usam o resolvedor compartilhado de negócio ativo, sem adivinhar empate. Campos de formulário/cadastro e memória durável permanecem declarações/registros; não viram política comercial nem verificação clínica.

Decisões de próxima ação registram papel autenticado e sequência da proposta em `payload.review_context_v1`. Aprovação/recusa tem alcance somente sobre a proposta original; nova sequência ou decisão posterior invalida o uso atual. Legado sem papel histórico permanece explícito. Aprovação não é recibo de execução.

Propostas, agenda, callbacks e pergunta/resposta do Caso são lidos do estado persistido. Aceitação não comprova pagamento/matrícula; confirmação na agenda não comprova presença; callback da IA não comprova telefonema da equipe; resposta do cliente não é verificação. Turnos de follow-up preservam `fixed_text`, `internal_task` e `ai_reentry`, sem criar chamada LLM nos caminhos determinísticos.

O mesmo pacote factual chega à abertura do agente e à revisão. Memória da organização, skills casadas, references e notas efetivamente consultadas entram como fontes auxiliares capturadas pelo servidor, sem autoridade individual/recibo. Antecedentes só entram depois de envio efetivo. Contagens/estados de cobertura e falhas são metadados no log; corpos permanecem fora dele. Fontes não cabem? O item inteiro é excluído com motivo, sem liberar a exceção de repasse por recorte.

Living System Checklist: entrada nas tabelas/eventos e leituras autorizadas do loop; saída no agente e três consumidores da revisão; registro `review_context_sources`, atividade de próxima ação e traces existentes; telas Casos/Timeline/Execuções/Cartão JEV existentes; portas conservadas; próximo passo/revisão humana no mesmo Caso segue o fluxo existente; consentimento v2 na superfície administrativa; continuidade IA↔humano com pergunta/resposta; retorno ao erro por fonte corrigida e fotografia nova; mapa `escalacao-ciclo-humano.architecture.json` atualizado. Montador de leitura não cria novo fluxo de retry. Comunicação visível/dedup e diagnóstico privado são camada subsequente; não inferir entrega de `resolved`.

### Comunicação de conclusão e diagnóstico privado

Concluir um Caso registra uma decisão; não comprova comunicação. `comunicacao-do-caso.ts` projeta evento humano, job canônico, último trace e ledger/mensagem. Os estados são pending, queued, sent, deferred, vetoed, failed, cancelled_or_stale e unknown_legacy. Apenas estados reais sent/delivered/read confirmam envio; sent não afirma entrega ou leitura. A tela mostra motivo/próximo passo e parcialidade. Sem evento humano, não exige leitura extra. Caso/fronteira revogados ou alterados não podem ser reutilizados.

A fila conserva suas tentativas limitadas. POST `/api/v1/ai/cases/:id/communication` exige agent+, visibilidade pelo cliente de sessão, fronteira atual e evento vigente. Retry manual reutiliza job/evento quando terminal e sem intenção de envio, até três ações; não reenvia uma entrega ambígua. Retificação exige nota, preserva o evento anterior e cria outra decisão/job no MESMO Caso; nova autoridade vem da sessão. Ambas ações são auditadas sem texto, incluindo suporte. A revisão continua obrigatória. A reentrada não abre outro Caso pelo fail-safe de comunicação/afirmação clínica; problemas novos explícitos conservam o fluxo próprio.

Central recebe aviso deduplicado por Caso com referência agent_case. O handler informa a pendência ao encerrar; cron autenticado `case-communication`, a cada cinco minutos e até 200 casos por rodada, cobre morte do worker e confirmação assíncrona, sem monopolizar a varredura por pendências já avisadas. O aviso fecha somente com envio efetivo; resolução humana não basta. O detalhe já existente atualiza a cada 15 segundos; não há nova página na navegação.

Em Execuções de IA, diagnóstico privado desligado por padrão exige admin, identificação de uma execução ou contato de teste local e confirmação explícita. Limites: duas horas de coleta, 100 invocações de revisão e 10 MiB por sessão; TTL de acesso de 72 horas por registro, sem renovação em leitura/retry. RPC interna service_role scoped recebe org/ator do servidor após RBAC/impersonação; tabelas cruas negam acesso a PUBLIC/anon/authenticated/service_role, com RLS adicional. Ativação, leitura, interrupção e expurgo são auditados sem conteúdo. Falha de auditoria impede leitura. Suporte respeita seu modo/permissão e organização.

Armazena projeção sanitizada do envelope invocado e dos passos do agente/reserva/confirmador ou JSON autorizado do JEV; sem headers, credenciais, URLs assinadas ou mídia bruta. O seam solicita `include.requestBody` e `include.requestMessages` do SDK somente quando a guarda scoped está ativa; `responseBody` continua desligado. Cada append revalida autorização, expiração e quota. `entrada_sdk` distingue a entrada do seam de `passo_modelo`, cujo `request_body` é o corpo devolvido pelo provedor e `request_messages` são as mensagens retidas pelo SDK naquele passo. Os indicadores `request_body_available` e `request_messages_available` devem ser conferidos: cobertura de sanitização completa não prova que o provedor devolveu corpo, recebimento remoto ou precisão do modelo.

No envelope v3 do seam, textos longos realmente enviados são redigidos ANTES de dividir, com no máximo oito segmentos de 16 mil caracteres por texto (`text_segments_v1`). Concatenar `segments` recupera somente o texto sanitizado capturado; `sha256_sanitized`, comprimentos, `complete` e `omitted_chars` permitem conferir integridade/recorte. Textos acima de oito segmentos ou com cadeia opaca sem espaços maior que 16 mil caracteres são omitidos inteiros antes de redigir, com motivo e comprimento, e tornam `diagnostic_coverage.complete=false`; eventual excedente após sanitizar também é explícito. Strings JSON são representadas por `json_string_v1.value`, sanitizado estruturalmente, sem reempacotar contexto em um campo gigante. Outros chamadores mantêm a omissão integral de texto acima de 16 mil. Envelope bruto ou sanitizado acima de 10 MiB não é coletado; permanecem 100 registros, duas horas de coleta e 72 horas de acesso. Mídia e chaves excluídas contam como omissões; sanitização não promete anonimização universal. Logs normais não guardam pacote/candidata/nota. Não há coleta retroativa, exportação automática nem reconstrução posterior de fontes omitidas. O consumidor é o visualizador privado existente; esta mudança de núcleo não altera decisões, configurações empresariais ou o envio.

Conteúdo é UNLOGGED, sem WAL/replicação, e excluído dos dumps dos dois scripts oficiais. Isso não exclui automaticamente dumps/snapshots externos: antes da promoção, conferir todos os backups da instalação e seus filtros. Metadados/auditoria duráveis podem permanecer; conteúdo não deve entrar em backups duráveis. Cron autenticado `review-capture-purge`, a cada cinco minutos, mede linhas apagadas e atraso real. Heartbeat superior a dez minutos ou falha impede nova coleta e abre aviso administrativo; execução tardia do cron não reativa sessão. Expirados não são lidos mesmo antes da remoção física; tela remove a captura/cache ao vencer, fechar, revogar ou sair. Revogação e anonimização eliminam conteúdo, sem apagar auditoria.

Living System Checklist: entrada=evento/job/envelope autorizado; saída=CaseCommunication/Central/ReviewDiagnostics; registro=api_audit_log, trace, ledger; tela=CaseDetail/ExecucoesDeIa; porta=Casos/Execuções e destinos tipados da Central; anti-morte=fila limitada e varredura/aviso persistido; configuração=opt-in explícito com estado/quota/último expurgo; continuidade=humano→IA→cliente e falha→mesmo humano/Caso; laço=reconciliar envio, retificar decisão, interromper captura sem expurgo; mapa=escalacao-ciclo-humano com duas peças e arestas de entrada/saída. Leitura pura não cria outro retry. Prova completa em tela autenticada/baseline fresco, matriz integrada e build/CI continuam obrigatórios antes da implantação.


### Fronteira da projeção compartilhada

`lib/agent-engine/guardrails/promise/projecao-atendimento.ts` contém somente a projeção factual/sanitização compartilhada. Seus tipos são importados com `import type`; ela não carrega fontes, não acessa banco e não importa o executor de atendimento. `contrato-contexto.ts` usa essa projeção nos três revisores. O coletor e sua API permanecem no executor, sem conceder ao JEV dependências de envio, handoff ou alteração de contato/conversa. A cerca `jev-nunca-cala-bloqueia-nem-responde` continua exigida, sem exceção nova.


## 17. Conclusão humana: reconhecimento e fidelidade separados

Selecionar Concluí fecha o Caso na mesma transação que registra a nota e o job; não prova envio. O coletor aceita a fonte `resolved` com evento autenticado e pedido/fronteira válidos. O job ligado à devolutiva conserva essa fonte no agente e nos três revisores, inclusive com Casos desligado posteriormente. Não é busca restrita a Casos abertos.

`afirmouConclusaoHumana` identifica o que a candidata afirma, inclusive quando muda beneficiário, data, objeto ou condição. `repasseConcluidoFiel` julga a candidata inteira frente à fonte. Conclusão reconhecida sem fidelidade/prova interna gera `human_decision_unfaithful`; Caso aberto, follow-up ou Casos desligado não liberam essa divergência. Pergunta, convite, saudação e descrição genérica não são conclusão individual. Autorização de tentar não comprova operação concluída; promessa futura adicional não herda liberação. A normalização é comum aos três revisores, preservando gates comerciais/operacionais e revalidação.

Resultado automático de agenda pode ser comunicado em primeira pessoa e no passado sem afirmar decisão humana. Na segunda opinião da reserva, o sinal inicial de conclusão só é retirado quando o confirmador nega explicitamente conclusão/repasse e retorno, atesta a candidata inteira como operacional em `conclusaoOperacionalDaAgenda` e vincula referência, ação e revisão ao resultado observado do turno. O servidor exige pedido presente, revisão de agenda positiva, recibo relido/publicação atual da mesma revisão e natureza operacional pertinente. Negativa isolada, referência errada/antiga, dados essenciais ausentes, confirmação humana exigida/atestada na criação/remarcação, pacote excluído, falha ou ambiguidade não liberam a marcação inicial. A afirmação de aprovação/execução por pessoa continua humana mesmo junto de um resultado automático verdadeiro. Comercial e demais gates não são apagados por essa conciliação; não há exceção no `casePromiseGate`, lista de frases liberadas, nova autoridade ou chamada adicional. Detalhes e limites em `jev-revisao-resposta-reserva.md`.

A rede léxica de degradação só atua se o sinal independente está ausente e existe contexto/devolutiva humana, nunca como prova de fidelidade. Os testes `conclusao-humana.test.ts`, `conclusao-humana-revisores.test.ts` e `revisor-conclusao-caso-encerrado.test.ts` guardam positivos, divergências, parse/indisponibilidade e o caminho em banco. Provas sintéticas de transporte/gates não representam acurácia dos modelos ou entrega externa.


### Alcance da pendência original de um Caso

A continuidade de um Caso aberto conserva título, resumo, bloqueio, pedido original, pergunta humana e resposta do cliente. O servidor a descreve como `pendencia_operacional_do_pedido_original`, com autoridade `nao_atesta_decisao_humana_nem_veto_global`: o nome da origem `caso_humano` identifica o fluxo, não comprova autoria humana. Uma descrição de alteração não concluída não vira proibição de toda operação de agenda. Essa distinção chega ao agente pela fonte normalizada e à proposta antes da escrita, JEV, reserva e confirmador pelo pacote comum e instrução compartilhada.

Julgar o alcance exige ação, objeto, beneficiário e condições; mudar a data não libera automaticamente outro pedido. A criação nova explícita não requer `reserva_atual`, encerramento do Caso antigo nem execução/publicação prévia. Remarcação exige a origem atual relida e escolha do novo destino, inclusive nas sucessivas. Decisões humanas autenticadas ainda pertinentes, restrições comerciais, bloqueios reais, ambiguidades e cobertura insuficiente continuam sendo considerados. Não se apaga histórico, não se promove texto livre a autoridade e não se substitui o sinal positivo estrito da revisão.

Os testes dirigidos de correspondência da agenda verificam normalização, transporte do mesmo Caso/pedido/decisão pertinente nos revisores e composição dos sinais positivos, negativos ou ausentes. Provedores controlados não comprovam a interpretação de modelos reais; essa evidência depende do piloto com captura privada e entrega correspondente ao efeito.


### Origem e destino na confirmação de remarcação

A conferência anterior à escrita devolve ao chamador nativo a origem scoped e a revisão efetivamente lidas. O escritor recebe essa revisão por CAS. A ferramenta só associa `origem_remarcacao` ao resultado da mesma reserva, revisão seguinte e destino pedido. Texto de notas ou valores sugeridos pelo modelo não são fonte dessa origem.

A observação privada do turno conserva os pontos anterior e posterior e a revisão; a projeção comum relê o destino e exige a mesma identidade, revisão, estado, instantes e fuso antes de incluir `transicao_remarcacao`. JEV, reserva e confirmador recebem a fase `depois_da_escrita`, origem/destino locais e a prova de mesma reserva, sem IDs privados. A revisão distingue origem anterior de horário atual e não une outro cancelamento pelo título/horário. Cada remarcação sucessiva substitui a transição; uma nova tentativa, falha ou cancelamento não herda a anterior.

Essa observação é do turno, inclusive sua recuperação limitada, não um histórico durável de transições. Uma nova entrada sem essa observação não inventa origem nem autoria a partir da conversa: pode confirmar somente o estado atual relido e pertinente ao pedido. Consentimento, revisão atual, publicação, condições humanas/comerciais e gates continuam necessários. Prova de transporte e composição com modelos controlados não comprova acurácia real ou entrega; o piloto deve medir efeito e confirmação entregue com captura contemporânea.
