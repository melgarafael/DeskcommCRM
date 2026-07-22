# HANDOFF — Sistema de Follow-up Inteligente

> ⚠️ **INSTRUÇÃO PERMANENTE (não remover):** Este documento DEVE ser lido no
> INÍCIO de toda sessão que trabalhe nesta feature, e ATUALIZADO + COMMITADO ao
> final de CADA avanço (task concluída, decisão tomada, bug encontrado, bug
> corrigido, teste rodado). Regra do Rafael: progresso só conta com PROVA
> VISÍVEL (output de teste real, curl real, screenshot Playwright). Nada de
> "implementado" sem evidência registrada aqui. Medidas de front-end são
> verificadas por ferramenta (Playwright getBoundingClientRect/getComputedStyle),
> nunca a olho. COMMITAR este arquivo a cada atualização — mudança só no
> working tree se perde quando um subagent limpa a árvore (já aconteceu 1x).

## Contexto fixo

- **Feature:** sistema de follow-up inteligente — grafo versionado + enrollment + relógio único; builder visual React Flow; fila UI; seletor no agente.
- **Spec:** `docs/superpowers/specs/2026-07-21-followup-system-design.md` (aprovada pelo Rafael 2026-07-21).
- **Plano:** `docs/superpowers/plans/2026-07-21-followup-system.md` — 8 ondas, critérios de aceite por onda. NENHUMA onda avança sem a anterior provada.
- **Pesquisa (Fase 0):** `docs/research/followup-reference-mining.md` — padrões de odysseus/hermes/openclaw + autópsia do TomikCRM (as 3 causas-raiz: janela 24h ignorada no agendamento; ai_classify sem grace; pausas sem consumidor de retomada).
- **Onde:** worktree `.claude/worktrees/followup`, branch `feat/followup-flows` (base `feat/operacao-visivel` @ 4408958). Checkout principal NÃO tocar.
- **Método:** subagent-driven (implementer + reviewer por task), ledger em `.superpowers/sdd/progress.md`. Após CADA task: prova + atualizar+commitar este arquivo.
- **Ambiente:** `.env.local` e `.e2e-creds.json` copiados do checkout principal. Testes de invariante: Postgres 17 efêmero do `baseline.sql` (`npm run test:invariants`). E2E: `npm run test:e2e` (creds do seed).
- **Fundações que JÁ EXISTEM (não recriar):** `cron_jobs` + `job_queue` (kind `followup_turn`) da migration 0050; tool `schedule_followup` (`lib/agent-engine/agent/schedule-followup.ts`); handler `followup_turn` com re-entrada temporal (`lib/agent-engine/agent/followup-turn.ts`); before-send guardrails/pacing/STOP/`send_ledger`; `agent_inbox_items`; flywheel. O sistema novo ORQUESTRA essas peças.

## Estado atual

- **Onda:** 4 ✅ COMPLETA. Onda 5 EM ANDAMENTO: Task 5.1 ✅ (ponte engine ⇄ job_queue). Próxima: Task 5.2 (reatividade — inbound acorda classify; ver nota de interplay abaixo).
- **Dev DB:** migrations 0054 e 0056 APLICADAS no projeto rrydmwnporysaiysiztn via Management API (token do CLI no keychain, entrada "Supabase CLI"/"access-token", formato go-keyring-base64). `database.types.ts` regenerado (public,storage,graphql_public). **0057 (Task 4.1, kind `followup_dead`) ainda NÃO aplicada no dev DB remoto** — não bloqueou a prova ao vivo da Task 4.2 porque o cenário provado (trigger→wait→condition→end) nunca passa pelo caminho `markDead`/`agent_inbox_items.kind='followup_dead'`; aplicar antes de qualquer prova futura que precise do caminho dead-letter.
- **Migration seguinte livre:** 0058.
- **Pendências deliberadas:** aplicar 0054 no dev DB remoto + regenerar `lib/database.types.ts` → fazer na preparação da Onda 3 (controller faz; subagents sem MCP Supabase). Minors do review 1.1 p/ triagem final: (1) idiom `duplicate_object` nas policies difere da convenção `drop policy if exists` do repo; (2) sem índice org-only em `followup_flow_versions`/`followup_enrollment_events`.

## Decisões tomadas

- 2026-07-21: UM motor/UM relógio (`followup_enrollments.next_eval_at`); nós de IA via `job_queue`; envio at-most-once; validação de janela 24h no PUBLISH; grace obrigatório no classify; `paused_handoff` com retomada por evento. (Spec §2.)
- 2026-07-21: `@xyflow/react` aprovado pelo Rafael para o canvas (dynamic import, medir bundle).
- 2026-07-21 (Task 4.1): **`AdminClient` do engine NÃO é `SupabaseClient`** — é uma interface própria e estreita (poucos métodos nomeados: claim/loadGraph/loadLeadFacts/loadEvents/insertEvent/updateEnrollment/loadPointerName/insertDeadInbox). Motivo: `tests/invariants/**` roda contra Postgres cru (`pg.Pool`, sem PostgREST — `NEXT_PUBLIC_SUPABASE_URL` aponta pra porta inalcançável de propósito no `vitest.db.config.ts`), então um `AdminClient=SupabaseClient` real seria intestável ali. `lib/followup/engine.ts` exporta `createSupabaseAdminClient(admin)` pra produção (ainda sem consumidor — a rota de cron é task futura) e o teste DB implementa o adapter `pg`-puro inline. **Próximas tasks que precisarem de uma rota real usando o engine devem usar `createSupabaseAdminClient`, não reinventar.**

## Log de avanços (mais recente primeiro)

- 2026-07-22: **Task 5.1 ✅ (commits ff97ccc/b164560/502f9ab/51cbfb8) — ponte engine ⇄ job_queue.**
  `lib/followup/turn-bridge.ts` (novo): `completeTurnForEnrollment(db, orgId, enrollmentId,
  nodeId, result, clock?)` traduz o resultado de um turno em progressão de enrollment — 'sent'
  avança via `selectEdge('always')`, 'classified' via `class_match` (fallback 'always' embutido),
  'timing' clampa `[min_ms,max_ms]` do wait smart pinado e reagenda sem sair do nó. Idempotente
  por `${node_id}:${steps_taken}` (mesma doutrina de `applyResult`). `TurnBridgeAdminClient`
  estende o `AdminClient` do engine com `loadEnrollmentById` — extensão ISOLADA (não no
  `AdminClient` do engine.ts) pra não obrigar o adapter pg já aprovado em
  `followup-engine.test.ts` a ganhar método que não usa. `createPgAdminClient(pool)` é o adapter
  de produção real, usado tanto pela wiring (main.ts) quanto pelo teste DB-real (mesmo código,
  não duplicado).
  `lib/agent-engine/agent/followup-turn.ts` — MUDANÇA MÍNIMA guardada por
  `if (payload.followup_enrollment_id !== undefined)`: 3 `purpose` roteados (send_message roda
  `runAgentTurn` normal com `prompt_hint` anexado à abertura; classify/decide_timing NÃO rodam o
  agente inteiro — 1 chamada estruturada cada, `lib/agent-engine/agent/followup-flow-classify.ts`
  novo, mesmo padrão de `stage-classifier.ts`/`guardrails/promise/semantic.ts`). Callback
  `completeFollowupTurn` injetado via `FollowupTurnDeps` (= `InboundTurnDeps` + o callback
  opcional); wiring real em `workers/agent-worker/main.ts` (achado como o ÚNICO consumidor de
  `createFollowupTurnHandler` no repo — não existe rota Next.js pra isso, é o worker 24/7 que
  fala `pg` puro, nunca Supabase client).
  `lib/followup/node-handlers.ts` — fix de bug real do critério 2 da onda: `ai_classify` em
  re-entrada (grace elapsed, checagem `waitElapsed` reusada de `wait`) SEMPRE reenfileirava outro
  turno de classificação, mesmo depois do `grace_timeout_ms` vencer sem resposta. Agora rota
  `no_reply` via `selectEdge` sem chamar LLM.
  **Desvios documentados do esboço do plano:** `completeTurnForEnrollment` ganhou `orgId`
  (toda escrita é org-scoped) e `nodeId` (guarda de obsolescência — turno tardio contra
  enrollment que já saiu do nó vira no-op, não reaplica sobre o nó errado); o payload do
  `FollowupJobRequest` (engine.ts) ganhou `prompt_hint`/`classes`/`hint`/`guidance` opcionais
  (o plano não especificava esses campos, mas o turno precisa deles — extensão do lado followup,
  liberada pelo dispatch).
  **Decisão deliberada de escopo:** o `wait` (mode `smart`) do `node-handlers.ts` CONTINUA usando
  `max_ms` direto (não wired pra `enqueue_turn purpose:'decide_timing'` nesta task) — investiguei
  e concluí que reusar `resolveWaitPhase`/`waitElapsed` pra essa transição tem uma ambiguidade real
  (uma recheck-tick de 5min enquanto o turno de decide_timing ainda não terminou colidiria com o
  sinal "já elapsed"), e o TDD explícito do dispatch não pedia essa mudança — só pedia que
  `completeTurnForEnrollment` trate 'timing' corretamente (o que está feito e testado, unit +
  DB-real). Fica registrado pra quem for wire isso: vai precisar de um sinal PRÓPRIO (não
  `resolveWaitPhase`) pra diferenciar "aguardando o turno terminar" de "wait de verdade elapsou".
  **PROVA:** node-handlers 34/34 (3 novos), turn-bridge unit 13/13, followup-flow-classify unit
  8/8, suíte unit completa 529/529, typecheck 0, lint 0 novo (os 2 erros pré-existentes em
  `graph-schema.test.ts` da Task 2.1 continuam intocados). DB-real: 37/37 arquivos de
  invariantes, 215 passed | 1 skipped (+1 arquivo, +11 testes sobre a baseline), install+update
  do baseline.sql sem erro novo em `pgvector/pgvector:pg17` descartável. `tests/invariants/followup-turn-bridge.test.ts`
  prova contra Postgres real: ciclo action completo (enqueue→complete→advance) + dupla conclusão
  idempotente (23505 real) + classe exata→aresta + grace-sem-resposta→no_reply SEM reenfileirar
  (via `runFollowupTick` real, não só a função pura) + clamp do wait smart contra o grafo pinado.
  **Sem migration nesta task.** Detalhe completo em `.superpowers/sdd/task-5.1-report.md`.
  **Pendente pra Task 5.2:** reactivity.ts vai precisar de um sinal PRÓPRIO pra acordar
  `ai_classify` cedo (inbound chegou) sem ser confundido com "grace expirou" pelo fix desta task
  (ambos re-entram o MESMO nó via a MESMA checagem `waitElapsed` hoje).

- 2026-07-22: **Task 4.2 ✅ (commit 0571db0) — Onda 4 fechada.** `app/api/v1/cron/followup-flow-worker/route.ts` (GET/POST, clone literal do `routing-worker`: auth Bearer fail-closed, `runFollowupTick` via `createSupabaseAdminClient` — reusa o engine da 4.1, `enqueueJob` insere em `job_queue` kind=`followup_turn` já existente, audit `followup.worker_run` agregada por tick) + `app/api/v1/ai/followups/enrollments/route.ts` (POST manager+ cria enrollment manual: pointer ativo→422 `flow_not_active`, contato da org→404, resolve nó `trigger` do grafo pinado, 23505→409, audit `followup_enrollment.created`; GET member lista com filtro `?status=`). **PROVA AO VIVO (não só unit):** 18 testes novos + 505/505 suite completa + typecheck/lint zerados; contra `npm run dev` (porta 3020) + DB remoto real (0054+0056), com cookie de sessão real (Playwright login) e secret real do `.env.local`: criei fluxo → PATCH grafo `trigger→wait(5min fixo)→condition(steps_taken≥0)→end(exhausted)` → publish → criei contato real → enrollment (RBAC 403 pro agent, 409 em duplicata viva provados) → cron sem/com secret errado→403 (fail-closed provado) → **5 ticks reais** (o worker processa 1 passo por chamada, não faz loop até estabilizar — ficou visível: trigger-advance e wait-start são 2 chamadas HTTP distintas) com **sleep real de 5min+ em foreground** entre o wait começar e elapsar (nada de manipular relógio) → enrollment fechou `status=completed, outcome=exhausted`. Confirmado direto no Postgres (admin client, não o mock do teste): 7 audit rows `followup.worker_run` batendo 1:1 com as 7 chamadas cron autenticadas (as 2 fail-closed corretamente não auditam), 3 audit rows das mutações (`created`/`published`/`enrollment.created`), 5 `followup_enrollment_events` (1 por passo real do grafo). Dados de smoke limpos depois (audit ficou, append-only). Detalhe completo + transcript integral em `.superpowers/sdd/task-4.2-report.md`. **Sem migration nesta task.**

- 2026-07-21: **Task 4.1 — fix de review** (1 Critical + 1 Important + 2 Minors, todos corrigidos). Critical: `markDead` gravava `status='dead'` ANTES do item de inbox — crash no meio deixava enrollment morto em silêncio. Invertido: inbox primeiro, `updateEnrollment(status='dead')` por último — pior caso agora é inbox duplicado (visível), nunca morte silenciosa; se a escrita de inbox falhar, o catch por-enrollment já existente segura e o enrollment continua claimable. Important: comentário documentando que falha transitória no `enqueueJob` pós-evento-commitado nunca reenvia (replay `23505` no retry) e converge sozinho pro horizonte normal. Minor: `applyResult` passou a receber `FlowNode` de verdade em vez de um shape solto — `grace_timeout_ms` sai da união discriminada, sem cast. Teste novo cobrindo o Critical (`pgAdminClient({failInboxTimes:1})`: 1ª falha não mata, 2ª tentativa mata + exatamente 1 inbox). **PROVA:** 31/31 unit node-handlers, 36/36 arquivos de invariantes (210/211, +1 teste novo sem regressão), typecheck 0, 487/487 unit completo. Detalhe em `.superpowers/sdd/task-4.1-report.md` (seção "Fix de review").

- 2026-07-21: **Task 4.1 ✅** (commits 5570cdd node-handlers, 53c629a migration 0057, 1eb2322 engine). `lib/followup/node-handlers.ts` (processNode/selectEdge/resolveWaitPhase, puro) + `lib/followup/engine.ts` (runFollowupTick, AdminClient próprio — ver Decisões) + migration 0057 (`agent_inbox_items.kind` ganha `followup_dead`). 2 desvios de contrato documentados no report (outcome nullable no NodeResult 'complete'; waitElapsed como campo opcional extra em processNode) — ambos aditivos, brief tinha texto contraditório entre o fence e a semântica. **PROVA:** 31/31 unit (node-handlers), 5/5 DB real (`tests/invariants/followup-engine.test.ts` — tick 1-nó-por-tick, ciclo de wait start→elapse, idempotência sob replay sem duplicar job, backoff 3 rodadas até dead+inbox, max_steps), suíte completa 487/487 unit + 209/210 invariantes (36/36 arquivos) sem regressão, typecheck 0, lint 0 nos arquivos tocados (2 erros pré-existentes em `graph-schema.test.ts` da Task 2.1, não tocado). TDD real: 1ª rodada do DB test pegou 2 bugs genuínos (seed reusando `$2` entre coluna `citext` e `text`; `markDead` não persistia o `attempts` final — backoff morria com contador errado). Detalhe completo em `.superpowers/sdd/task-4.1-report.md`. **Pendente:** nenhuma rota de cron consome `runFollowupTick` ainda; `ai_classify`/`action` só enfileiram (Task 5 resolve o nó); `wait smart` clampado em `max_ms` (`// onda 5`).

- 2026-07-21: **Onda 3 ✅** — Task 3.1 (dad6a7d + fix 83a9645 + minors 09073c8, Approved na re-review). 5 rotas `/api/v1/ai/followup-flows` (CRUD, publish, disable, rollback), RBAC manager+/member, audit 5 ações, Zod strict. **Review 1º round: 2 Importants** → fix com **migration 0056** (pointer_id + backfill genérico + `fn_publish_followup_flow_version` RPC atômica com FOR UPDATE; revoke anon/authenticated — NÃO copiou o furo do template `fn_publish_ai_agent_version`, que tem GRANT p/ anon: **flag de segurança pré-existente p/ Rafael**). Rollback valida linhagem + preserva status. **PROVA:** 24/24 API tests, 456/456 unit, invariantes 204/204, baseline 0056 fresh+update no pg17 descartável, transcript curl real de 13 passos com cookies de auth reais + 7 linhas de audit confirmadas no banco (detalhe no task-3.1-report.md). 0056 aplicada no dev DB (coluna+função confirmadas). Colisão de numeração 0055 pega pelo hook → renumerada 0056.

- 2026-07-21: **Onda 2 ✅** — Task 2.1 (e866497, Approved): `lib/followup/graph-schema.ts`, 80 testes unit, contrato exato dos 6 nós/arestas/grafo. Task 2.2 (9a27c2b + fix ea5a746 + 57e914e, Approved na re-review): `lib/followup/validate-publish.ts`, 17 testes. **Review pegou 2 Criticals reais no 1º round** (validador aceitava sub-ciclo sem espera dentro de SCC com espera; DFS com cap de 200k truncava silenciosamente em DAG ramificado ≤60 nós) → corrigidos com algoritmos EXATOS: remoção de nós-de-espera + Tarjan (ciclo) e condensação SCC + longest-path topológico O(V+E) (24h/max_steps). Regressões: contra-exemplo A/B/C, boundary 30/31, diamond-DAG 58 nós <1s. **PROVA:** 17/17 focados, suite unit 432/432, typecheck 0. Nota p/ Onda 6 (UI): `label` de nó ≤60 chars; grafo 2..60 nós, 120 arestas.

- 2026-07-21: **Task 1.2 ✅** (commit 298dd24, review Approved). `tests/invariants/followup-schema.test.ts` — 12 testes: RLS 2-tenants nas 4 tabelas (via JWT-scoped client real), unique enrollment vivo (23505 + libera após completed), unique idempotency_key (23505), CHECK active sem next_eval_at (23514), claim concorrente disjunto (2 conexões pg reais, união=5 interseção=0). **PROVA (1ª mão do controller):** `npm run test:invariants` → 35 arquivos, 204 passed | 1 skipped, exit 0. RED provado derrubando as 3 constraints (3/12 falham).
- 2026-07-21: **Bugs operacionais da sessão:** (1) Docker daemon caiu no meio de um run → exit 255 mascarado; reiniciado + órfãos limpos; (2) implementer stallou 3x "aguardando watcher" (não acorda sozinho) → doutrina nova: dispatch exige poll síncrono, controller vigia PID e retoma. (3) **Flake pré-existente descoberto:** gov-1b × gov-6 colidem slug `gov-inv-b` (order-dependent). `tests/invariants/**` congelado → escalado como `INBOX-001` em `loop/inbox.items.md` com fix pronto de 1 linha. AVISAR RAFAEL.

- 2026-07-21: **Task 1.1 ✅** (commit 9363db9, review Approved). Migration 0054 (4 tabelas + RLS + `fn_claim_due_followup_enrollments` SKIP LOCKED) + apêndice baseline + MANIFEST. **PROVA:** fresh install `ON_ERROR_STOP=1` + update re-apply verdes em `pgvector/pgvector:pg17` descartável; `\dt followup*` = 4 tabelas nas duas passadas; suite completa de invariantes 34/34 arquivos, 192 testes verdes. Detalhe no report `.superpowers/sdd/task-1.1-report.md`. Bug operacional: Docker daemon estava parado → controller iniciou Docker Desktop e retomou o implementer.

- 2026-07-21: Onda 0 iniciada. HANDOFF antigo (webhooks) arquivado em `docs/superpowers/handoffs/`. Worktree + branch criados. Spec, plano e mineração commitados na base (b1202ca, 790546f).

## Bugs encontrados / corrigidos

_(nenhum ainda)_

## Provas registradas

_(nenhuma ainda — a primeira será o test:invariants da Onda 1)_
