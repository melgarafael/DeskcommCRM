# Spec — Sistema de Follow-up Inteligente (fluxos + fila + seletor no agente)

> Aprovado por Rafael em 2026-07-21. Insumo: `docs/research/followup-reference-mining.md` (mineração odysseus / hermes / openclaw / tomikcrm).
> Status: pronto para plano de implementação.

## 1. Objetivo

Follow-up é onde a venda acontece (2º, 3º, 4º contato). A v1 (TomikCRM) falhou de dois jeitos: follow-up por silêncio robótico (timing fixo, template) e follow-up por demanda frágil em prazos longos (jobs órfãos, janela 24h ignorada, estados presos). A v2 no Deskcomm entrega:

1. **Builder visual de fluxos** de follow-up (estilo n8n) com nós AI-first.
2. **Fila de follow-ups** (UI) com contexto de cada agendamento.
3. **Seletor de fluxos no agente de IA** + política de handoff.
4. Motor durável único por cima das primitivas existentes do agent harness.

**Não-objetivos (MVP):** sub-fluxos, A/B split, webhooks como nós, editor de template WhatsApp oficial (HSM), multi-canal além do WhatsApp.

## 2. Tese arquitetural

**UM grafo, UM enrollment, UM relógio.** Silêncio, demanda ("me chama em X dias") e campanha são gatilhos do mesmo motor — nunca motores paralelos (anti-padrão-raiz do Tomik). O motor promove o único padrão robusto da v1 (estado em linha + `next_eval_at` absoluto + polling por cron) e corrige as 3 causas-raiz:

| Causa-raiz v1 | Regra estrutural v2 |
|---|---|
| Janela 24h ignorada no agendamento → retry infinito | Validação no **publish**: espera que pode cruzar 24h exige fallback declarado; retry com teto + dead-letter + inbox |
| IA Classifica no instante zero | Grace period embutido no nó (resposta OU timeout) |
| Pausa por handoff sem retomada | Todo estado pausado tem consumidor de retomada via `event_log` |

Reuso do harness (migration 0050): `job_queue` (kind `followup_turn`), `cron_jobs`, `runAgentTurn` + before-send guardrails + pacing + `send_ledger`, tool `schedule_followup`, `agent_inbox_items`, flywheel.

## 3. Modelo de dados (migrations 0054+; baseline; MANIFEST)

Padrão versionado do harness: `*_versions` append-only + `*_pointers`.

### `followup_flow_versions` (imutável)
- `id uuid pk`, `organization_id` (FK, RLS), `graph jsonb not null`, `created_by`, `created_at`.
- `graph` = `{ nodes: FlowNode[], edges: FlowEdge[] }`, validado por Zod **no publish** (ver §6). Nunca text livre.

### `followup_flow_pointers` (identidade do fluxo)
- `id uuid pk`, `organization_id`, `name text not null`, `status text check (draft|active|disabled)`,
- `active_version_id` FK → versions (null enquanto draft),
- `draft_graph jsonb` (rascunho editável; publish valida e congela em versão),
- `handoff_policy text check (pause|cancel|allow) default 'pause'`,
- `trigger_config jsonb` (ver §5 Gatilho), timestamps.
- Unique `(organization_id, name)`.

### `followup_enrollments` (lead dentro do fluxo)
- `id`, `organization_id`, `pointer_id` FK, `version_id` FK (**pinada** — lead em voo fica na versão em que entrou),
- `contact_id` FK, `conversation_id` FK nullable,
- `current_node_id text` (id do nó no graph),
- `status text check (active|waiting_reply|paused_handoff|completed|cancelled|dead)`,
- `next_eval_at timestamptz` (**o único relógio**; null somente em estados terminais/pausados-com-consumidor),
- `attempts smallint default 0`, `max_attempts smallint default 5`, `last_error text` (sem PII),
- `outcome text check (converted|replied|exhausted|opted_out|handoff|null)`, `cancel_reason text`,
- timestamps. Índices: `(status, next_eval_at) where status in ('active','waiting_reply')` para o worker; **unique parcial `(pointer_id, contact_id) where status in ('active','waiting_reply','paused_handoff')`** — 1 enrollment vivo por lead/fluxo.

### `followup_enrollment_events` (append-only)
- `id`, `organization_id`, `enrollment_id` FK, `node_id`, `event_type text`, `payload jsonb`, `idempotency_key text`, `created_at`.
- **Unique `(enrollment_id, idempotency_key)`** — idempotência de ação por constraint, não por SELECT.

### Ligação agente ⇄ fluxo
- Config do agente (estrutura versionada existente do agente) ganha `followup: { flow_pointer_ids: uuid[], enabled: boolean }`. Sem tabela nova.

RLS `tenant_isolation_*_all` via `fn_user_org_ids()` em todas. Service role nos workers filtra `organization_id` manualmente.

## 4. Motor de execução

**Worker step-per-tick** — rota cron `app/api/v1/cron/followup-flow-worker` (auth por secret, mesmo padrão das demais), tick 1/min:

1. Claim de enrollments vencidos com **`FOR UPDATE SKIP LOCKED`** (função SQL `fn_claim_due_enrollments(org?, limit)`), lote pequeno (ex.: 20).
2. Processa **um nó por enrollment por tick**; persiste `current_node_id` + `next_eval_at` na mesma transação do claim.
3. Nós que precisam de LLM **não chamam modelo no worker**: enfileiram `followup_turn` no `job_queue` com payload `{enrollment_id, node_id, purpose}`; o handler existente (`lib/agent-engine/agent/followup-turn.ts`) é estendido para, ao finalizar o turno, reportar o resultado ao enrollment (avanço de nó via evento).
4. **Envio é at-most-once**: o evento `action_sent` (com `idempotency_key = enrollment_id:node_id:attempt`) é gravado por constraint ANTES do side-effect ser confirmado como necessário; retry de turno só antes de `executionStarted` (lição openclaw). Envio passa 100% pelo pipeline existente (before-send, pacing anti-ban, janela 7h-22h, STOP, `send_ledger`).
5. **Falha**: backoff `[30s, 1m, 5m, 15m, 1h]` indexado por `attempts`; esgotou → `status='dead'` + `agent_inbox_items` (kind novo `followup_dead`). Nunca retry infinito; nunca silêncio.
6. **Boot/tick repair** (no próprio tick): enrollment `active` com claim expirado volta à fila como falha explícita (`attempts+1`); backlog vencido dispara 1× e re-ancora (collapse, sem burst).

**Cancelamento reativo** (consumer de `event_log`, no mesmo tick do worker):
- Mensagem inbound do contato → enrollments `waiting_reply` desse contato avançam pela aresta de resposta; fluxos com `cancel_on_reply` cancelam (`outcome='replied'`).
- STOP/opt-out → cancela tudo do contato (`outcome='opted_out'`).
- Handoff humano iniciado → aplica `handoff_policy` do pointer (`pause` → `paused_handoff`, sem relógio). **Handoff encerrado (evento de fechamento já emitido no `event_log`) → retoma**: `paused_handoff` volta a `active` com `next_eval_at = now() + grace` (grace configurável, default 30min). Estado órfão é impossível por construção: `paused_handoff` só existe com consumidor de retomada ativo.

**Timezone**: toda espera/janela em tz IANA explícita (herda a do canal/org); conversões server-side (date-fns-tz ou Intl, jamais delegadas ao modelo; jamais reimplementadas à mão).

## 5. Nós do MVP (contratos)

Todos com `id`, `type`, `label`, `position {x,y}`, `config` tipada por Zod. Arestas: `{source, target, condition: {type: 'always'|'class_match'|'cond_result', value?}, priority}`.

- **`trigger`** (1 por fluxo, obrigatório). `trigger_config` no pointer: `{ kind: 'manual' | 'stage_change' | 'silence' | 'conversation_end', params }`. Silêncio: `{ threshold_minutes, segments? }` — substitui o motor de silêncio como sistema separado.
- **`wait`**: `{ mode: 'fixed', duration_ms }` (min 5min, max 90d) **ou** `{ mode: 'smart', min_ms, max_ms, guidance? }` — enfileira `followup_turn` com purpose `decide_timing`; a IA propõe o instante, o motor **clampa** em `[min,max]` (padrão openclaw `next_check`).
- **`condition`**: determinística, sem LLM. `{ checks: [{field, op, value}], combinator }` sobre lead/estado/contadores do enrollment. Arestas `cond_result: true|false`.
- **`ai_classify`**: `{ classes: string[], grace_timeout_ms (obrigatório, min 15min), target: 'last_reply'|'summary', hint? }`. Semântica: entra → `status='waiting_reply'`; classifica quando (a) inbound chega ou (b) timeout vence (aí classe implícita `no_reply`). Arestas `class_match` por classe + `no_reply` + fallback `always` (exigidos no publish). Classificação via `followup_turn` purpose `classify` (structured output).
- **`action`**: `{ mode: 'ai_message', prompt_hint, fallback_template_id? } | { mode: 'template', template_id }`. `ai_message` roda o `followup_turn` completo (com bloco de re-entrada temporal: "passaram N dias, você prometeu X…"). Se janela 24h fechada e sem template fallback → falha explícita do nó (vai a backoff/dead), **nunca** descarte silencioso nem hold eterno.
- **`end`**: `{ outcome: 'converted'|'exhausted'|'custom', note? }` — encerra e grava outcome.

## 6. Publish (validação estrutural)

`POST /api/v1/ai/followup-flows/:id/publish` roda Zod + regras de grafo; qualquer violação = 422 com lista de erros por nó:
1. Exatamente 1 `trigger`; todo nó alcançável a partir dele; todo caminho termina em `end`.
2. `ai_classify`: toda classe declarada tem aresta; `no_reply` e fallback `always` presentes; `grace_timeout_ms >= 15min`.
3. **Regra da janela 24h**: `action` `ai_message` alcançável após espera acumulada ≥ 24h exige `fallback_template_id` (análise estática do grafo somando os `max` das esperas no caminho).
4. Ciclos permitidos somente se contêm `wait` ≥ 5min (anti-loop de rajada) e o fluxo tem teto `max_steps` (default 30) por enrollment.
5. Publish congela `draft_graph` → nova linha em `followup_flow_versions` + aponta `active_version_id`. Rollback = apontar versão anterior.

## 7. API (padrão `/api/v1`, wrappers ok/fail, audit log, Zod)

- `GET/POST /api/v1/ai/followup-flows` — listar/criar pointer (draft).
- `GET/PATCH /api/v1/ai/followup-flows/:id` — ler/editar draft (`draft_graph`, nome, políticas).
- `POST .../publish`, `POST .../disable`, `POST .../rollback`.
- `GET /api/v1/ai/followups/queue` — fila unificada: enrollments (+ nó, próximo disparo, estado, erro) **e** promessas `cron_jobs` da tool `schedule_followup` (kind `at`, com reason/promise) — cursor pagination.
- `POST /api/v1/ai/followups/enrollments/:id/cancel` — cancelamento manual (audit).
- Mutação → `api_audit_log`. RBAC: manager+ edita fluxos; agent vê fila.

## 8. UI (design system Sage; React Flow `@xyflow/react`)

Rota `/app/ai/followups`, 2 abas + integração no editor do agente:
1. **Fluxos**: lista de pointers (status, versão, leads em voo) + builder em tela cheia: paleta dos 6 nós, canvas React Flow, painel de config por nó (forms Zod-driven), validação de publish inline (erros ancorados no nó), seletor de handoff policy, salvar draft / publicar / desativar / rollback. Estética Sage (nada de shadcn cru / dark-node-editor genérico).
2. **Fila**: tabela unificada (contato, fluxo/promessa, nó atual, próximo disparo relativo+absoluto, status com badge, motivo/promessa, erro) com filtros (fluxo, status, período) e ação cancelar. Realtime opcional pós-MVP; MVP = refresh por polling client-side.
3. **Seletor no agente** (`AgentEditor`): seção "Follow-up" — toggle + multi-select de fluxos ativos; persiste em `followup` na config versionada do agente. Dispatcher só inicia enrollment de gatilho automático se o agente vinculado estiver publicado com o fluxo habilitado.

## 9. Integrações

- **Tool `schedule_followup`** (demanda): inalterada; promessas aparecem na fila (fonte `cron_jobs`). Pós-MVP: opção de a promessa entrar num fluxo em vez de disparo único.
- **Flywheel**: `end`/cancel gravam `outcome` no enrollment; job `flywheel` existente passa a ler outcomes por fluxo/versão → judge/distiller propõem ajuste de copy/cadência com gate humano (aba de propostas existente).
- **LGPD**: anonimização de contato cancela enrollments (`opted_out`) e não deixa PII em `last_error`/eventos.

## 10. Testes (Definition of Done)

1. Unit (Vitest, TDD): cada tipo de nó (avanço, arestas, clamp da espera smart, grace do classify); validador de publish (todas as regras §6); backoff/dead; claim SKIP LOCKED (concorrência com 2 workers simulados).
2. Durabilidade: enrollment com `wait` de 30 dias — simular restart (novo processo de worker) e relógio avançado → dispara 1× sem burst; claim expirado vira falha explícita.
3. RLS: teste de isolamento 2-tenants nas 4 tabelas novas (gate de CI).
4. E2E (Playwright, protocolo de execução visível): criar fluxo no builder → publicar (ver erro de validação e corrigir) → lead entra por gatilho → espera vence (clock controlado) → mensagem sai (WAHA mock/Core) → resposta inbound classifica e roteia → fila mostra cada transição → handoff pausa e fechamento retoma. Screenshots como prova.
5. `typecheck`/`lint` zerados; migrations + apêndice no `baseline.sql` + MANIFEST; validação do baseline em Postgres descartável (install fresh + update).

## 11. Riscos e mitigação

- **React Flow bundle**: importar só no route do builder (dynamic import), medir com build-and-size.
- **Análise estática da regra 24h** (§6.3) em grafos com ciclo: usar soma de `max` no caminho mais curto até o `action`; ciclos contam 1 iteração (conservador; documentado na UI).
- **Extensão do `followup-turn.ts`**: mexe em código do harness portado — mudanças mínimas, atrás de purpose novo no payload, cobertas por testes existentes + novos.
