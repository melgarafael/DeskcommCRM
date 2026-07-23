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

- **Onda:** 5 ✅. Onda 6 ✅. Onda 7 ✅. Onda 8 EM ANDAMENTO: **Task 8.1 ✅ — gatilho de silêncio (varredura TIME-DRIVEN no cron `followup-flow-worker`) + primeiro consumidor do gate.** Ver Log de avanços. Falta na Onda 8: `stage_change` (não pedido nesta task — brief 8.1 focou só em `silence`), flywheel, E2E de jornada completa.
- **Task 7.1 ✅ — endpoint fila + aba + cancelar.** `GET /api/v1/ai/followups/queue` (viewer+): UNION app-side de `followup_enrollments` + `cron_jobs` (kind='at'+job_kind='followup_turn'), ordenado `(next_fire_at asc nulls last, id asc)`, cursor seek `{next_fire_at,id}` aplicado às 2 fontes, janela `limit+1` por fonte + merge (k-way lookahead — sem pular/duplicar entre páginas). `status`/`pointer_id` pulam a fonte de promessas (não têm esses campos); `q` resolve pra `contact_id`s primeiro, aplicado nas 2 fontes. `POST /api/v1/ai/followups/enrollments/:id/cancel` (manager+): 409 `already_terminal` se já encerrado, senão cancela + evento `cancelled_manual` + audit `followup_enrollment.cancelled` (ação nova). `app/app/ai/followups/page.tsx` virou `Tabs` (Fluxos/Fila) — o gate de página que exigia manager+ pra ver QUALQUER coisa foi relaxado pra só exigir org ativa (Fila é viewer+; Fluxos manteve seu próprio `canWrite`). `QueueTab.tsx` + `useFollowupQueue.ts` (useInfiniteQuery, mesmo padrão de `useAdminIncidents`) — filtros status/fluxo/busca (debounce 250ms), relativo+absoluto via `date-fns`/`ptBR` (reuso, sem dep nova), `AlertDialog` de cancelar.
  **PROVA AO VIVO (`tests/e2e/followup-queue.spec.ts`, 2/2 verde, `E2E_PORT=3010`):** setup 100% via API real (fluxo publicado, contato, enrollment) + `scripts/seed-e2e-followup-promise.ts` novo (mesmo padrão de `seed-e2e-queue.ts`, service role — não existe rota pública pra criar `cron_jobs`, só a tool do agente em runtime). Os 4 casos de aceite cobertos SEM DEFERIR NENHUM: (1) linha do enrollment com contato/fluxo/nó/próximo-disparo/status; (2) filtro status esconde e filtro por fluxo estreita pra exatamente 1 linha; (3) cancelar via dialog → some do filtro Ativo + toast + prova via API (`GET queue?status=cancelled` contém o id cancelado) + RBAC extra verificada ad-hoc (viewer faz POST direto em `/cancel` → 403 `forbidden_role` server-side, não só botão escondido); (4) busca por nome da promessa seedada estreita a fila INTEIRA da org pra exatamente 1 linha (`flow_name="Promessa"`, motivo, "Agendada", "em 3 dias", sem botão Cancelar). Screenshots em `test-results/followup-7.1-0{1..6}-*.png` — a 01 mostra dado 100% real incluindo 3 promessas de uso genuíno da IA já existentes no dev DB ("Prova Multimodal"). `npm run typecheck` 0, `npm run lint` 0 novo (2 erros pré-existentes intocados da Task 2.1), `npm run test:unit` 547/547 sem regressão. **Sem migration** (só leitura de tabelas já existentes; `cancelled_manual` é `event_type text` livre, sem CHECK a alterar). Detalhe completo em `.superpowers/sdd/task-7.1-report.md`.
- **Task 6.3 ✅ — editor de condição de aresta.** `lib/followup/edge-condition-options.ts` (novo, puro): `edgeConditionOptions(sourceNode)` — `ai_classify` → `always` + 1 `class_match` por classe declarada + `class_match:no_reply`; `condition` → `always` + `cond_result:true/false`; qualquer outro tipo → só `always`. Mais `conditionKey`/`conditionLabel` (pt-br: classe crua, `no_reply`→"Sem resposta", `true`→"Sim", `false`→"Não", `always`→"Sempre") — 9 testes unit. `app/app/ai/followups/[id]/_components/EdgeConfigPanel.tsx` (novo): painel docado (mesmo estilo do NodeConfigPanel), mostra origem→destino e um Select com as opções exatas do nó de origem. `FlowCanvas.tsx`: `onEdgeClick` seleciona a aresta (fecha o painel de nó, e vice-versa — mutuamente exclusivos), `edgesForRender` (memo) injeta `label` derivado de `data.condition` em TODA aresta pro fio mostrar "positivo"/"Sem resposta"/"Sempre"/"Sim"/"Não" (React Flow's built-in edge label, sem edge customizado — confirmado no dist instalado que `BaseEdge`/`EdgeText` já suportam `label` nos 4 tipos default). `graph-mappers.ts`: só um `export` adicionado em `toFlowNode` (já existia, não exportada) — reuso, ZERO mudança de comportamento/round-trip.
  **PROVA (Playwright, `tests/e2e/followup-builder.spec.ts`, describe "Task 6.3"):** fluxo trigger→ai_classify(2 classes: positivo/objecao)→2 ações→2 fins (2 fins são necessários, não decorativos — `addEdge` do React Flow recusa uma 2ª aresta entre o mesmo par origem/destino, então `no_reply` e o fallback `always` do classify não podem mirar o MESMO nó "fim"). **Checagem negativa primeiro:** publica o grafo com TODAS as 4 arestas de saída do classify ainda `always` (estado pré-6.3) → 422 real, `Fluxo reprovado na validação`, nó do classify com anel vermelho + mensagem `"não tem edge class_match para a classe 'positivo'"`, exatamente 1 nó com erro (screenshot `followup-6.3-02-publish-422-all-always.png`). Depois abre cada aresta de saída do classify via o painel novo, seleciona `positivo`/`objecao`/`Sem resposta` (a `always` de fallback já vem certa, confirmada explicitamente no painel) → Publicar → SUCESSO: badge "Ativo", toast "Fluxo publicado.", zero erros no nó classify, e as 4 arestas mostram seus labels no fio (screenshot `followup-6.3-04-published-branching.png`) — o MESMO grafo que falhou acima agora publica porque o editor existe. Descoberta de implementação: o grid de posição default da paleta (220px de espaçamento < 224px de largura do card) sobrepõe cards com >4 nós e gera bezier loopy que esconde o label de aresta atrás de um card vizinho — o teste reposiciona os 6 nós manualmente (drag pelo header, fora dos handles Top/Bottom) num layout de árvore de verdade antes de conectar; e `fitView` do React Flow reajusta zoom (até 2x) a cada nó recém-medido, então o teste estabiliza via zoom-out ANTES de calcular posições-alvo (mesma cautela já documentada no teste 6.2). **PROVA:** 9/9 unit novos (`edge-condition-options.test.ts`), suíte unit completa 547/547, typecheck 0, lint 0 novo (os 2 erros pré-existentes em `graph-schema.test.ts` da Task 2.1 continuam intocados), `npm run build` OK, e2e `followup-builder.spec.ts` completo 7/7 (6.1+6.2+6.3, sem regressão). Sem migration nesta task.
- **RACE do classify lento — RESOLVIDA na 5.2.** `processNode` (node-handlers.ts) ganhou `wokeEarly?: boolean`: quando `waitElapsed=true` E `wokeEarly=true`, reenfileira classify em vez de rotear `no_reply`. `engine.ts` computa `wokeEarly` checando o marker `${node}:${steps}:wake` nos eventos do enrollment — gravado por `lib/followup/reactivity.ts` quando um inbound chega durante `waiting_reply` sem `cancel_on_reply`. Distinto do idempotency_key de passo que `waitElapsed` já checava (Task 5.1), então os dois sinais nunca se confundem. Provado em `tests/invariants/followup-reactivity.test.ts` (o TESTE CRÍTICO: 1º tick enfileira classify, reactivity empurra `next_eval_at` pra agora ANTES do grace vencer, 2º tick do engine real reenfileira classify — não roteia `no_reply`).
- **Dev DB:** migrations 0054 e 0056 APLICADAS no projeto rrydmwnporysaiysiztn via Management API (token do CLI no keychain, entrada "Supabase CLI"/"access-token", formato go-keyring-base64). `database.types.ts` regenerado (public,storage,graphql_public). **0057 (Task 4.1, kind `followup_dead`) ainda NÃO aplicada no dev DB remoto** — não bloqueou a prova ao vivo da Task 4.2 porque o cenário provado (trigger→wait→condition→end) nunca passa pelo caminho `markDead`/`agent_inbox_items.kind='followup_dead'`; aplicar antes de qualquer prova futura que precise do caminho dead-letter.
- **Migration seguinte livre:** 0058.
- **Pendências deliberadas:** aplicar 0054 no dev DB remoto + regenerar `lib/database.types.ts` → fazer na preparação da Onda 3 (controller faz; subagents sem MCP Supabase). Minors do review 1.1 p/ triagem final: (1) idiom `duplicate_object` nas policies difere da convenção `drop policy if exists` do repo; (2) sem índice org-only em `followup_flow_versions`/`followup_enrollment_events`.

## Decisões tomadas

- 2026-07-21: UM motor/UM relógio (`followup_enrollments.next_eval_at`); nós de IA via `job_queue`; envio at-most-once; validação de janela 24h no PUBLISH; grace obrigatório no classify; `paused_handoff` com retomada por evento. (Spec §2.)
- 2026-07-21: `@xyflow/react` aprovado pelo Rafael para o canvas (dynamic import, medir bundle).
- 2026-07-21 (Task 4.1): **`AdminClient` do engine NÃO é `SupabaseClient`** — é uma interface própria e estreita (poucos métodos nomeados: claim/loadGraph/loadLeadFacts/loadEvents/insertEvent/updateEnrollment/loadPointerName/insertDeadInbox). Motivo: `tests/invariants/**` roda contra Postgres cru (`pg.Pool`, sem PostgREST — `NEXT_PUBLIC_SUPABASE_URL` aponta pra porta inalcançável de propósito no `vitest.db.config.ts`), então um `AdminClient=SupabaseClient` real seria intestável ali. `lib/followup/engine.ts` exporta `createSupabaseAdminClient(admin)` pra produção (ainda sem consumidor — a rota de cron é task futura) e o teste DB implementa o adapter `pg`-puro inline. **Próximas tasks que precisarem de uma rota real usando o engine devem usar `createSupabaseAdminClient`, não reinventar.**

## Log de avanços (mais recente primeiro)

- 2026-07-22: **Task 8.1 ✅ — gatilho de SILÊNCIO (varredura TIME-DRIVEN no cron) + primeiro consumidor real do gate `isPointerEnabledForAutomaticTrigger`.**
  **Decisão de arquitetura (dada, não descoberta aqui):** silêncio é
  TIME-DRIVEN (varredura periódica), NÃO event-driven — não entra em
  `lib/followup/reactivity.ts` (que reage a `event_log`). Vive no cron
  `app/api/v1/cron/followup-flow-worker/route.ts`, que já roda a cada minuto
  com admin client: `runSilenceSweep` roda DEPOIS de `runFollowupTick` (e da
  sua auditoria), num try/catch ISOLADO — sweep falhando NUNCA aborta a
  resposta do tick (só loga, sem PII).
  **`lib/followup/silence-sweep.ts` (novo)** — `runSilenceSweep(deps)`:
  acha pointers `status='active'` com `trigger_config.kind='silence'` de TODAS
  as orgs (mesmo desenho cross-org de `fn_claim_due_followup_enrollments`) →
  GATEIA cada um via `isPointerEnabledForAutomaticTrigger` (memoizado por
  `orgId:pointerId` dentro da varredura) → acha contatos silenciosos da org →
  cria enrollment nascendo no nó `trigger` do grafo pinado, `next_eval_at=now`.
  Interface `SilenceSweepDb` estreita, mesma doutrina de `AdminClient`/
  `ReactivityAdminClient`/`FollowupGateDb`; `createSupabaseSilenceSweepDb(admin)`
  é o adapter de produção.
  **"Última inbound" — achado central:** `conversations.last_inbound_at` JÁ
  EXISTIA (populado por `fn_ingest_message`, já usado por
  `workers/ai-response-worker.ts` e `lib/routing/queue.ts`) — **zero
  migration**. Ressalva real: é POR CONVERSA, o enrollment é POR CONTATO (um
  contato pode ter 2+ conversas/channel_sessions) — `loadSilentContactIds`
  busca todas as conversas da org com embed de contato (mesmo padrão 1:1 de
  `ai-response-worker.ts:255`) e reduz client-side pro `last_inbound_at` MAIS
  RECENTE por contato (Map). Decisão deliberada: NÃO criei uma function SQL
  pra fazer isso no Postgres (o `GROUP BY MAX` cabe numa reduction em memória
  pro volume do perfil PME do CLAUDE.md — evita migration+baseline+MANIFEST
  pra uma agregação pequena; troca é um refactor local se a escala pedir).
  **`segments`:** não havia NENHUMA primitiva de segmento de contato modelada
  (`enabled_segments` em `reentry-knobs.ts` é de outro sistema — Vendaval,
  valores opacos). Interpretei como overlap com `contacts.tags` (única coluna
  real, já com GIN index). Vazio/ausente = todos os contatos silenciosos —
  documentado como interpretação deferida no header do módulo.
  **Idempotência:** `insertEnrollment` é INSERT puro — 23505 (índice único
  `idx_followup_enrollments_one_live`) vira `skipped_existing`, nunca erro. Um
  contato que completou/cancelou pode re-enrollar na varredura seguinte se
  continuar silencioso — aceitável no MVP, sem cooldown table (fora de escopo
  por instrução explícita do brief).
  **`app/api/v1/cron/followup-flow-worker/route.ts`** — chama `runSilenceSweep`
  com `createSupabaseSilenceSweepDb(admin)` + `createSupabaseFollowupGateDb(admin)`
  depois do tick; audita `followup.silence_sweep_run` (nova action em
  `lib/audit/actions.ts`, union tipada) em sucesso. Response contract do tick
  (`ok(summary,...)`) INTOCADO — o sweep não polui o body de resposta, só
  audita separadamente — preserva `tests/api/followup-cron-worker.test.ts`
  sem precisar editá-lo.
  **PROVA (DB-real, `tests/invariants/followup-silence-sweep.test.ts`, 8
  testes novos):** (1) pointer silence gateado + contato silencioso > threshold
  → 1 enrollment no nó trigger; 2ª varredura não duplica (unique-live); (2)
  gate-out em 2 sabores (sem agente publicado habilitando / agente publicado
  com `enabled=false`) → 0 enrollments — prova que o gate É chamado, não só
  importado; (3) boundary — silêncio < threshold → 0 enrollments, gate passou
  (isola o que bloqueou); (4) **gate SQL integration** (reviewer Minor #2 da
  Task 7.2 — requisito explícito desta task): `isPointerEnabledForAutomaticTrigger`
  contra `ai_agent_versions` REAL via adapter pg-backed espelhando a query de
  `createSupabaseFollowupGateDb` — publicado+enabled+membro→true,
  draft→false, enabled=false→false, cross-org→false.
  **Flake achado e corrigido na 1ª rodada** (mesma classe já documentada no
  fix da Task 5.2): `loadActiveSilencePointers` é cross-org de propósito, então
  um pointer `kind='silence'` de um `it` anterior (nunca desativado)
  contaminava `pointers_scanned`/`pointers_gated_out` do `it` seguinte — fix:
  `beforeEach` deletando `followup_flow_pointers where trigger_config->>'kind'
  = 'silence'` (escopo estreito, cascade via `on delete cascade`).
  **PROVA:** typecheck 0, lint 0 novo (os 2 erros pré-existentes de
  `graph-schema.test.ts`, Task 2.1, intocados), unit 551/551 sem regressão
  (nenhum unit novo — brief só pediu invariantes pra esta task). Invariantes:
  **3 rodadas seguidas, síncronas — 3/3 limpo**: 39/39 arquivos, 234 passed |
  1 skipped em TODAS (era 226+1 antes — exatos +8, +1 arquivo, zero
  regressão). Detalhe completo em `.superpowers/sdd/task-8.1-report.md`.
  **Sem migration nesta task.**

- 2026-07-22: **Task 7.2 ✅ — seletor de fluxo no editor do agente + gate de gatilho automático. Onda 7 fechada.**
  **Achado que muda o brief:** a config versionada de agente (`ai_agent_versions`) NÃO é um jsonb único —
  é coluna real por campo (`trigger_config`/`handoff_keywords` etc., confirmado lendo `supabase/baseline.sql`
  antes de codar). A suposição do brief ("aditivo, sem migration, é tudo jsonb") não batia; o campo novo
  precisou de **migration real**: `ai_agent_versions.followup jsonb not null default
  '{"enabled":false,"flow_pointer_ids":[]}'::jsonb`. Ainda assim aditivo — versões existentes nascem com o
  default, zero regressão em agentes que nunca falaram de follow-up.
  **Colisão de numeração real (multi-worktree):** `HANDOFF` dizia "migration seguinte livre: 0058", mas o
  dev DB remoto é COMPARTILHADO entre worktrees paralelos — outro branch já tinha aplicado `0058_media_multimodal`,
  `0059_agent_split_messages`, `0060_message_templates` (`supabase migration list` + Management API confirmaram;
  `information_schema.columns` já mostrava `multimodal_input`/`split_messages` em `ai_agent_versions` que meu
  `git log`/`ls supabase/migrations/` local não conheciam). Renumerado pra **0061** antes de aplicar — a lição:
  SEMPRE conferir o número livre contra o REMOTO (`supabase migration list` ou a Management API), não só
  contra `ls supabase/migrations/` local, quando o dev DB é compartilhado entre worktrees.
  `fn_ai_agent_version_content_immutable()` (0051) re-assentada (`create or replace`, forward-fix idempotente)
  incluindo `followup` no veto de mutação de versão PUBLICADA — sem isso o campo ficaria mutável por fora do
  contrato de imutabilidade que o resto da tabela já respeita (achado ao ler a trigger antes de mexer no schema).
  **Aplicação sem MCP:** as tools `mcp__plugin_supabase_supabase__*` não estavam carregadas nesta sessão.
  `SUPABASE_DB_URL` (pooler, role `agent_worker`) não tem ownership pra DDL (`must be owner of table
  ai_agent_versions`) — aplicado via Management API (`POST /v1/projects/:ref/database/query`) com o access
  token do keychain (`security find-generic-password -s "Supabase CLI" -a "access-token" -w`, decodificado de
  `go-keyring-base64:`), mesmo mecanismo que o CLI usa. Achado extra: a API da Management exige `User-Agent`
  ou o Cloudflare WAF devolve 403 (`error code: 1010`) sem explicar — resolvido com
  `User-Agent: supabase-cli/2.95.4`. Migration re-aplicada 2x (idempotência provada) antes de seguir.
  `lib/database.types.ts`: regen completo via `supabase gen types` traria TAMBÉM as tabelas/colunas de OUTROS
  worktrees (`multimodal_input`, `split_messages`, `message_templates`...) — fora do escopo desta task e do
  meu branch. Optei por um patch cirúrgico manual (só `followup: Json` nos 3 shapes de `ai_agent_versions`),
  impacto mínimo, sem misturar schema alheio no diff.
  **Zod:** `followupConfigSchema` (`{enabled: boolean.default(false), flow_pointer_ids: uuid[].max(20).default([])}`)
  em `lib/ai/agents/validation.ts`, campo `followup` em `versionShapeSchema` — aditivo confirmado pelos 551/551
  unit (era 547/547 na Task 7.1) sem quebrar nenhum teste de agente existente.
  **UI:** `app/app/ai/agents/[id]/_components/FollowupFlowPicker.tsx` (novo) — multi-select que ESPELHA
  `ToolPicker.tsx` (fieldset+checkbox, mesmo padrão visual Sage), filtra `useFollowupFlows()` client-side pra
  `status==='active'` (a rota `GET /api/v1/ai/followup-flows` não tem `?status=` — checado, fora do escopo
  mínimo mudar a rota), empty-state linka pra `/app/ai/followups`. `AgentForm.tsx` ganha a seção "Follow-up"
  depois de "Handoff humano": `Switch` pro `followup.enabled` + o picker pro `flow_pointer_ids`. `VersionDiff.tsx`
  ganha uma seção "Follow-up" (pills de fluxo adicionado/removido + enabled A→B) — nice-to-have barato pra não
  deixar o diff de versão cego a este campo novo.
  **Gate (onda 8 ainda não existe):** `lib/followup/agent-followup-gate.ts` (novo) —
  `isPointerEnabledForAutomaticTrigger(db, orgId, pointerId)`: um gatilho AUTOMÁTICO (silence/stage_change/
  conversation_end) só pode enrollar nesse pointer se algum agente PUBLICADO da org tiver
  `followup.enabled=true` e `followup.flow_pointer_ids` incluir o pointer. Enrollment MANUAL
  (`POST /api/v1/ai/followups/enrollments`) NÃO passa por este gate (escolha explícita de humano). Confirmei
  por grep que NENHUM código cria enrollment a partir de gatilho automático ainda (silence/stage — só a Task 4.2
  tem enrollment manual; o worker de tick AVANÇA enrollments existentes, não os CRIA) — então o gate nasce
  exportado + testado (4 unit tests, `agent-followup-gate.test.ts`) SEM CONSUMIDOR. **A Task 8.1 (silence/stage
  → enrollment) DEVE chamar esta função antes de inserir a linha em `followup_enrollments` — não reinventar.**
  Interface estreita (`FollowupGateDb`) + adapter de produção (`createSupabaseFollowupGateDb`), mesma doutrina
  de `AdminClient`/`ReactivityAdminClient`.
  **PROVA AO VIVO (Playwright headed, `tests/e2e/followup-builder.spec.ts`, describe "Task 7.2", `E2E_PORT=3010`,
  2 rodadas seguidas 1/1 verde + suíte completa do arquivo+queue 10/10 verde):** setup 100% via API como
  **ADMIN** (não manager — achado ao ler `page.tsx`: manager VÊ o form mas `readOnly=true`, só admin salva;
  login com MFA TOTP real via `.e2e-creds.json → admin_totp`) — publica um fluxo mínimo trigger→end, cria um
  `mcp_agent`+v1 draft via `POST /api/v1/ai/agents` usando fixtures novas (`scripts/seed-e2e-followup-agent.ts`
  — credential+channel_session, únicas coisas que faltavam pra criar um agent via API; não existiam no repo).
  Abre `/app/ai/agents/:id`, prova o default aditivo (`version.followup === {enabled:false, flow_pointer_ids:[]}`
  na criação), habilita o toggle + marca o checkbox do fluxo publicado (locators, não screenshot-only),
  screenshot `e2e-artifacts/followup-7.2-01-flow-selected.png`, clica "Salvar rascunho", screenshot
  `e2e-artifacts/followup-7.2-02-saved.png`, e prova via **API** (`GET .../versions/:vid`) que
  `followup.enabled===true` e `flow_pointer_ids` contém o id do fluxo — persistência real, não só estado de UI.
  Cleanup arquiva o agent + desativa o fluxo.
  **Bug pré-existente encontrado e corrigido (fora do escopo do brief, mas achado rodando a suíte completa):**
  o teste RBAC da Task 6.1 (`viewer não vê o botão de criar fluxo`) ficou órfão desde o commit 6546271
  (Task 7.1, já commitado antes desta sessão) — a página `/app/ai/followups` deixou de redirecionar viewer
  pro `/403` (decisão deliberada: Fila é viewer+), mas a asserção velha (`waitForURL(/\/403/)`) nunca foi
  atualizada e falhava 100% das vezes isolado (não era flake de servidor — reproduzido 2x limpo). Corrigido
  pra refletir o RBAC atual: página carrega, botão "Novo fluxo" ausente. Regra do CLAUDE.md ("CI vermelho é
  pra ser consertado, não reportado de volta") — consertado, não só relatado.
  **PROVA (unit/typecheck/lint):** `npm run typecheck` 0, `npm run lint` 0 erros novos (os 2 pré-existentes de
  `graph-schema.test.ts` da Task 2.1 continuam intocados; +2 warnings `no-console` do novo script de seed —
  mesmo padrão tolerado de TODOS os outros `scripts/seed-e2e-*.ts`), `npm run test:unit` **551/551** (+4 sobre
  a Task 7.1: `agent-followup-gate.test.ts`). Migration 0061 aplicada no dev DB remoto + reaplicada 2x
  (idempotência provada) + `database.types.ts` atualizado (patch cirúrgico). Detalhe completo em
  `.superpowers/sdd/task-7.2-report.md`.

- 2026-07-22: **Task 6.2 ✅ (commits e06bf1e/bb928fd/fbc2415/6fdce2d/3d5d9f4) — builder visual
  completo em `/app/ai/followups/[id]`, o centerpiece da feature.** 5 incrementos, cada um
  provado por Playwright antes do próximo:
  1. `lib/followup/graph-mappers.ts` — `toReactFlow`/`fromReactFlow` puros (sem DB), round-trip
     provado (7 testes: 6 tipos de nó + 3 condições de aresta + posições não-triviais + piso de
     2 nós). `graphsEqual` (sorted-key stringify) alimenta o dirty-state do incremento 5.
  2. `page.tsx` (gate manager+, 404 fora da org) + `FlowBuilder.tsx` (shell `next/dynamic
     ssr:false` — `@xyflow/react` só carrega nesta rota) + `FlowCanvas.tsx` + `NodePalette.tsx`
     (clique OU HTML5 drag-and-drop via `screenToFlowPosition`). GET `/api/v1/ai/followup-flows/:id`
     ganhou `versions_count`/`previous_version_id` (2ª query de linhagem, sem `.limit()` de
     propósito — o fake DB de `tests/api/followup-flows.test.ts` não suporta esse método).
  3. 6 node cards (`Trigger/Wait/Condition/Classify/Action/End`Node.tsx) finos sobre
     `NodeCard.tsx` compartilhado — ícone+cor Sage distintos por tipo (trigger=accent,
     wait=info, condition=warning, ai_classify=accent sólido, action=success, end=error),
     subtítulo derivado do config via `describeNodeConfig`. `onConnect` sempre cria aresta
     `{type:'always'}` (editável só por convenção de default — sem UI de edge ainda, decisão de
     escopo: a spec de aceite não exercita `ai_classify`/`condition` com múltiplas saídas).
  4. `NodeConfigPanel.tsx` — 1 form por tipo, cada campo valida contra o schema exportado de
     `graph-schema.ts` (`safeParse`) antes de escrever no nó vivo; inválido = erro inline, nunca
     propaga estado parcial. **Achado de design importante**: a 1ª versão usava `Sheet` (Radix
     Dialog) e o overlay full-screen bloqueava clique em OUTRO nó do canvas (pointer-events da
     camada, independe de `modal={false}`) — trocado por `<aside>` comum, irmão de layout do
     canvas (padrão "docked inspector" de Figma/n8n), não modal.
  5. `PublishBar.tsx` — badge de status + "Alterações não salvas"; Salvar (PATCH draft_graph);
     Publicar SALVA primeiro (garante validar o que está no canvas, não um draft_graph
     desatualizado) depois POST publish — 422 mapeia `details.errors[].node_id` pro
     `node.data.errors` de cada nó (ring vermelho + texto inline, reservado desde o incremento 3);
     Desativar; Rollback usa `previous_version_id`, desabilitado com ≤1 versão; select de
     `handoff_policy` faz PATCH direto. `FlowCanvas.tsx` trocou o snapshot estático do SSR por
     `useFollowupFlow` (react-query, reativo às mutations).
  **PROVA — sequência mandatória completa** (Playwright headed, dev server real porta 3022 +
  DB remoto real, `tests/e2e/followup-builder.spec.ts`, 6/6 verde em 3 rodadas seguidas): monta
  trigger+wait+action+end via paleta → conecta só trigger→wait→action (SEM end) → configura
  wait=10min + action prompt_hint → Publicar com grafo incompleto → 422 com erros ANCORADOS
  (screenshot mostra 4 cards com ring vermelho + mensagem própria: trigger/wait/action por
  `no_end_path`/inalcançável, end por `unreachable_node` — não um banner genérico) → conecta
  action→end → Publicar de novo → toast "Fluxo publicado." + badge "Ativo" → RELOAD da página →
  grafo idêntico (4 nós, 3 arestas, "10 min" e o prompt_hint intactos) → Rollback desabilitado
  (1 versão, é o 1º publish). Screenshots `test-results/followup-6.2-0{1..8}-*.png`.
  **Achado de robustez do PRÓPRIO TESTE** (não bug do app, documentado no spec): comparar
  posição de nó via `getBoundingClientRect` só é estável se o `fitView` já assentou ANTES de
  medir dos DOIS lados (antes do reload e depois) — sob carga (suíte inteira, não isolado),
  uma corrida esporádica gerava ~390px de diferença; fix foi uma espera de 400ms após o clique
  em fit-view em ambos os lados da comparação (não era flake de posição real, era flake de
  QUANDO medir a posição).
  **`npm run build` (Turbopack) verde.** Bundle: chunk do `@xyflow/react`
  (`.next/static/chunks/0r6p4oj5ltmpf.js`, 192K bruto / ~60K gzip) confirmado AUSENTE de
  `rootMainFiles` (bundle compartilhado) e do `build-manifest.json` de AMBAS as páginas
  (`/app/ai/followups` e `/app/ai/followups/[id]`) — só carrega client-side via o
  `next/dynamic` do `FlowBuilder.tsx`, e só quando o usuário abre o builder.
  **typecheck 0 / lint 0 novo** (2 erros pré-existentes em `graph-schema.test.ts` da Task 2.1,
  intocado) / **unit 538/538** (+7 desta onda, sem regressão).
  **Decisão deliberada de escopo:** edição de condição de aresta (class_match/cond_result) via
  UI fica pra uma próxima iteração — a sequência de aceite mandatória só exercita arestas
  `always` (trigger→wait→action→end); `ai_classify`/`condition` com múltiplas saídas
  continuam editáveis via `NodeConfigPanel` (o NÓ), só a aresta em si nasce sempre `always`.
  Detalhe completo em `.superpowers/sdd/task-6.2-report.md`.

- 2026-07-22: **Task 6.1 ✅ (commit fcd0068) — página + lista de fluxos, 1ª tela user-visible da feature.**
  `app/app/ai/followups/page.tsx` (server component, mesmo padrão de `app/app/ai/agents/page.tsx`:
  `requireAuth`/`resolveActiveOrg`, redirect `/403` se role<manager, SELECT direto em
  `followup_flow_pointers` filtrado por `organization_id`) + `_components/FlowsList.tsx` (client,
  `useFollowupFlows` via TanStack Query) + `NewFlowDialog.tsx` (form controlado, `useCreateFollowupFlow`
  faz POST e prepend otimista na lista via `setQueryData` — sem navegar pro builder, que ainda não
  existe) + `FlowStatusBadge.tsx` (draft→`neutral`, active→`success`, disabled→`warning` — variants
  NATIVOS do `Badge` Sage, que já mapeiam pra `--color-{success,warning}-{bg,fg}` tokens; não usei
  Tailwind cru). `hooks/followup/useFollowupFlows.ts` espelha `hooks/ai/useAgent.ts` +
  `hooks/ai/useAgents.ts` (mesmo `apiClient`, mesmo padrão de query key + mutation). Nav: `Sidebar.tsx`
  ganhou item "Follow-ups" (ícone `FlowArrow`, novo no barrel `lib/ui/icons.ts` — ADR-05, import só
  daqui) reusando a permissão `ai.agents.view` (rank manager) — mesmo filtro de `NAV_ITEMS` já cobre o
  novo item porque o filtro casa por STRING de permissão, não por href.
  **Contagem de enrollments vivos por fluxo: DEFERIDA.** O GET de `/api/v1/ai/followup-flows` não expõe
  isso hoje; adicionar exigiria mudar o SELECT da rota (subquery correlacionada `count(*) from
  followup_enrollments where pointer_id=... and status not in (completed,cancelled,dead)`) — fora do
  escopo mínimo desta task (a UI de 6.1 já comunica status/versão sem o número). Fica pra quando 6.2/6.3
  precisarem mostrar fila viva.
  **PROVA (Playwright headed, `tests/e2e/followup-builder.spec.ts`, 2/2 verde):** dev server real
  (`next dev --port 3022` — 3001 estava ocupado por OUTRO worktree, `DeskcommCRM-qa`, confirmado via
  `lsof`/`cwd` antes de escolher a porta) + DB remoto real + login real do manager seed
  (`.e2e-creds.json`). Caso 1: login manager → `/app/ai/followups` → heading "Follow-ups" visível →
  screenshot lista vazia → clica "Novo fluxo" → dialog abre com foco no input (`toBeFocused` via
  locator, não visual) → digita nome com timestamp único (`E2E Follow-up <Date.now()>`, evita colisão
  entre runs — não há DELETE na API, decisão deliberada de onda anterior) → screenshot → clica "Criar
  fluxo" → dialog fecha → o card na lista contém o nome E o texto exato "Rascunho" (`getByText` escopado
  ao `<li>`, não "por perto") → screenshot final. Caso 2 (RBAC): login viewer → `/app/ai/followups` →
  redirect síncrono pro `/403` (a página nem renderiza o botão — gate é no `page.tsx`, mais forte que
  esconder o botão no client). 4 screenshots em `test-results/followup-6.1-0{1..4}-*.png` (visualmente
  inspecionados: paleta Sage, ícone `FlowArrow` ativo na sidebar, badge "Rascunho" como pill neutro —
  nada de shadcn-default). **`npm run typecheck` 0 / `npm run lint` 0 novo** (2 erros pré-existentes em
  `graph-schema.test.ts` da Task 2.1, intocado, seguem os mesmos). Draft de teste (`E2E Follow-up
  <timestamp>`) fica no dev DB — sem endpoint DELETE, sweep manual é dívida conhecida, não bloqueia.
  **Sem migration nesta task** (só leitura/escrita via a rota 3.1 já existente).



- 2026-07-22: **Task 5.2 ✅ (commits 863d625/ba22723/ebf4a72/d50fffb) — reatividade: inbound acorda classify, STOP cancela tudo, handoff pausa/retoma (o anti-Tomik).**
  `lib/followup/reactivity.ts` (novo) — `applyReactivityEvent(db, clock, row)` trata 3
  `event_type`s: `message.received` (contato `is_blocked` → cancela TUDO vivo `opted_out`;
  senão, `waiting_reply` do contato: `trigger_config.cancel_on_reply` do pointer → cancela
  `replied`, senão acorda via marker `inbound_woke` step-scoped + `next_eval_at=now`),
  `ai.handoff_triggered` (aberto — aplica `handoff_policy` do pointer: pause/cancel/allow),
  `ai.handoff_resolved` (fechado — `paused_handoff`→`active` com `next_eval_at=now+30min`).
  **DESVIO DELIBERADO do esboço do brief** (cursor próprio em `watchdog_cursors` dentro do
  tick do `followup-flow-worker`): investiguei o consumidor de `event_log` REAL em produção
  neste repo — `lib/event-log/dispatcher.ts`+`drain.ts` (roda a cada minuto via
  `app/api/v1/cron/event-log-drain`, tanto Vercel cron quanto crontab do kit self-host —
  README.md confirma) com idempotência via `consumed_by[]` já testada
  (`tests/invariants/event-log-drain.test.ts`). `watchdog_cursors` tem ZERO consumidores TS
  neste repo (grep confirmou — infra não usada). Reusar o dispatcher genérico
  (`lib/followup/reactivity.handler.ts`, key `followup-reactivity.v1`, registrado em
  `lib/event-log/register-handlers.ts`) evita inventar um 2º mecanismo de consumo E dá de
  graça o requisito "falha de reactivity não aborta o tick": são crons/rotas SEPARADOS —
  isolamento total, não um try/catch agregando summary. `runFollowupTick`/engine.ts
  continuam intocados nesse aspecto (só ganharam o `wokeEarly` — ver acima).
  **`ai.handoff_resolved` é evento NOVO** — grep confirmou que não existia NENHUM sinal de
  fechamento de handoff no repo (só `ai.handoff_triggered` na abertura, via
  `lib/ai/handoff/orchestrator.ts`); a spec §4 assumia "evento de fechamento já emitido" mas
  isso nunca foi verdade. Adicionado em `app/api/v1/conversations/[id]/reactivate-bot/route.ts`
  (rota home-grown, não código portado do WAHA — mesmo padrão `emit_event` de ~30 rotas do
  repo, ex. `conversations/[id]/claim/route.ts`). Sem isso, `paused_handoff` seria
  literalmente órfão — violaria o próprio requisito anti-Tomik da task.
  `lib/followup/api-schemas.ts` — `triggerConfigSchema` ganha `cancel_on_reply` opcional
  (sibling de `kind`, não dentro de `params`: é política de reação-à-resposta, ortogonal a
  como o fluxo foi disparado). Aditivo, sem migration (jsonb, Zod só valida na escrita).
  **Idempotência:** escritas de cancel/pause/resume usam
  `reactivity:${event_log_row_id}:${enrollment_id}:${tipo}` (redrain do MESMO row nunca
  duplica); o wake marker usa a chave step-scoped que engine.ts consome. Toda leitura/escrita
  filtra `organization_id` de `row.organization_id` (nunca do payload).
  **PROVA:** node-handlers 38/38 (+2 wokeEarly), suíte unit completa 531/531, typecheck 0,
  lint 0 novo (os 2 erros pré-existentes em `graph-schema.test.ts` da Task 2.1 continuam
  intocados). DB-real: `tests/invariants/followup-reactivity.test.ts` novo, 10/10 — STOP
  cancela tudo (3 pointers distintos — a constraint `idx_followup_enrollments_one_live` não
  permite 2 vivos no mesmo pointer) + idempotência sob re-drain; inbound wake + O TESTE
  CRÍTICO da corrida classify-lento (sequência `classify_enqueued→inbound_woke→
  classify_enqueued`, nunca sai do nó via `no_reply`); `cancel_on_reply` true/ausente;
  handoff pause/cancel/allow; **O CENTERPIECE anti-Tomik**: abre(pause, `next_eval_at=null`)
  → fecha(`ai.handoff_resolved`) → retoma(`active`, `next_eval_at=now+30min`) → o tick do
  engine REAL consegue reclamar essa linha depois (`steps_taken` incrementa) — nunca preso;
  + idempotência do fechamento. Suíte completa de invariantes: 38/38 arquivos, 225 passed |
  1 skipped (era 215+1 na Task 5.1 — exatos +10 testes, +1 arquivo, zero regressão);
  install+update do baseline.sql sem erro novo em `pgvector/pgvector:pg17` descartável.
  **Sem migration nesta task** (widening de Zod sobre jsonb existente, sem tocar schema).
  Detalhe completo em `.superpowers/sdd/task-5.2-report.md`.
  **Pendente pra Onda 6:** nenhuma. O motor de reatividade está completo e coberto; a UI
  (builder React Flow) é trabalho totalmente separado.

- 2026-07-22: **Task 5.2 — fix de review (1 Critical + 1 Important + 2 Minors, todos
  corrigidos).**
  **Critical** (`lib/followup/turn-bridge.ts`): o guard de obsolescência de
  `completeTurnForEnrollment` excluía só `completed|cancelled|dead` — faltava
  `paused_handoff`. Um job `classify`/`action`/`decide_timing` em voo quando um handoff
  pausa (current_node_id não muda no pause — só `status`) passava o guard incólume e
  reativava/avançava o enrollment por baixo do humano, ignorando `reactToHandoffClose`
  inteiramente (mensagens automáticas enquanto um humano segura a conversa). Fix: 1 linha
  — `paused_handoff` entra na exclusão, a conclusão tardia vira NO-OP (o resultado stale é
  descartado, não perdido: é exatamente o comportamento certo — foi calculado antes do
  humano intervir). Provado em `tests/invariants/followup-reactivity.test.ts` (describe
  novo "completeTurnForEnrollment (turn-bridge) — respeita paused_handoff"): classify job em
  voo → handoff abre (pausa) → o job completa tarde com resultado 'hot' →
  enrollment CONTINUA `paused_handoff`/`ac1`/sem evento `ai_classified` → handoff fecha →
  retoma normalmente pra `active` no MESMO nó (o resultado stale nunca foi aplicado).
  **Important** (`app/api/v1/conversations/[id]/reactivate-bot/route.ts`): o emit de
  `ai.handoff_resolved` era fire-and-forget (`.then()` sem await). Nas ~30 outras rotas um
  evento perdido custa um audit trail; aqui é o ÚNICO produtor do sinal de fechamento, sem
  retry — um drop órfã `paused_handoff` PRA SEMPRE. Fix: `await` no `emit_event`; falha
  agora devolve 500 (a query de update já é idempotente — reclicar reactivate-bot é seguro).
  **Minor 1**: comentário em `reactToHandoffOpen`/`reactToHandoffClose`
  (`lib/followup/reactivity.ts`) documentando o escopo deliberado por CONTATO (não por
  conversa) — `LiveEnrollmentRef` não carrega `conversation_id` de propósito.
  **Minor 2**: `task-5.2-report.md` tinha a formulação ERRADA sobre o caminho
  `force_human`/`human-handoff.ts` — dizia "pausa sem retomada". Corrigido: esse caminho
  **nunca chama `emit_event`**, então `ai.handoff_triggered` nunca dispara pra ele,
  `reactToHandoffOpen` nunca roda, e o enrollment **nunca é pausado** — ele segue tickando
  normal (`active`/`waiting_reply`), só o ENVIO da mensagem é barrado (guard independente de
  `force_human` em `before-send.ts`). É "nenhuma pausa acontece", não "pausa órfã".
  **PROVA:** node-handlers 36/36 (inalterado — este fix não mexe em node-handlers/engine),
  suíte unit completa 531/531, typecheck 0, lint 0 novo. DB-real:
  `tests/invariants/followup-reactivity.test.ts` 12/12 (+1 sobre a versão anterior — o teste
  do Critical), `followup-turn-bridge.test.ts` + `followup-engine.test.ts` sem regressão.
  1 de 3 rodadas do `npm run test:invariants` oficial teve 1 falha intermitente em
  `followup-engine.test.ts` (`claimed` 2 em vez de 1) — **DIAGNÓSTICO CORRIGIDO no fix
  seguinte** (não é INBOX-001/gov-1b×gov-6, que é uma colisão de slug não-relacionada):
  era um defeito de ISOLAMENTO no PRÓPRIO `followup-engine.test.ts` desta sessão (Task 4.1),
  resolvido no commit seguinte. Detalhe completo (seção "Fix de review") em
  `.superpowers/sdd/task-5.2-report.md`.
  **Sem migration.**

- 2026-07-22: **Task 5.2 — fix de review 2 (isolamento do due-queue global em
  `followup-engine.test.ts`).**
  Diagnóstico correto do flake intermitente acima (o coordenador identificou; a formulação
  anterior deste HANDOFF citando INBOX-001 estava ERRADA — corrigida no bloco acima):
  `fn_claim_due_followup_enrollments` é deliberadamente GLOBAL/cross-org (design de
  produção correto, SKIP LOCKED entre workers, provado na Task 1.2) — e
  `tests/invariants/**` compartilha UM Postgres não-resetado entre arquivos
  (`vitest.db.config.ts`, `fileParallelism:false`). `followup-engine.test.ts` (autorado
  nesta sessão, Task 4.1) nunca limpava a fila de enrollments devidos entre `it`s — uma
  linha residual de um teste-irmão (ex.: o wake de `followup-reactivity.test.ts`, que seta
  `next_eval_at=now()`) podia ser fisgada pelo `runFollowupTick({limit:5})` de OUTRO teste
  que esperava `claimed`/`advanced`/`jobs.length` exatos, corrompendo as contagens agregadas.
  **Fix:** `beforeEach` em `followup-engine.test.ts` fazendo
  `delete from followup_enrollments` antes de CADA `it` (cada um já semeia sua própria
  org/enrollment DEPOIS do hook — seguro). `followup_enrollment_events.enrollment_id` tem
  `on delete cascade` (migration 0054, conferido no catálogo — nenhuma outra tabela
  referencia essa FK), então deletar só `followup_enrollments` já limpa os eventos junto.
  TODAS as asserções `toBe(1)`/`toHaveLength(1)` (incluindo a de idempotência em
  `jobs.length` na linha ~378) ficaram EXATAMENTE como estavam — nenhuma foi relaxada, o
  fix resolve a causa raiz (contaminação cross-test), não o sintoma (afrouxar assert).
  **PROVA (o ponto inteiro deste fix):** `npm run test:invariants -- followup` rodado
  **3 vezes seguidas, síncrono, saída completa cada vez** — **3/3 limpo**: 38/38 arquivos,
  226 passed | 1 skipped em TODAS as 3 rodadas, zero flake. node-handlers 36/36 (inalterado),
  unit completo 531/531, typecheck 0, lint 0.
  Detalhe completo em `.superpowers/sdd/task-5.2-report.md`. **Sem migration.**

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
