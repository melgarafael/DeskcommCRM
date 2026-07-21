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

- **Onda:** 1 — Task 1.1 ✅ (review Approved). Próxima: Task 1.2 (testes de invariante RLS/unique/claim).
- **Migration seguinte livre:** 0055.
- **Pendências deliberadas:** aplicar 0054 no dev DB remoto + regenerar `lib/database.types.ts` → fazer na preparação da Onda 3 (controller faz; subagents sem MCP Supabase). Minors do review 1.1 p/ triagem final: (1) idiom `duplicate_object` nas policies difere da convenção `drop policy if exists` do repo; (2) sem índice org-only em `followup_flow_versions`/`followup_enrollment_events`.

## Decisões tomadas

- 2026-07-21: UM motor/UM relógio (`followup_enrollments.next_eval_at`); nós de IA via `job_queue`; envio at-most-once; validação de janela 24h no PUBLISH; grace obrigatório no classify; `paused_handoff` com retomada por evento. (Spec §2.)
- 2026-07-21: `@xyflow/react` aprovado pelo Rafael para o canvas (dynamic import, medir bundle).

## Log de avanços (mais recente primeiro)

- 2026-07-21: **Task 1.1 ✅** (commit 9363db9, review Approved). Migration 0054 (4 tabelas + RLS + `fn_claim_due_followup_enrollments` SKIP LOCKED) + apêndice baseline + MANIFEST. **PROVA:** fresh install `ON_ERROR_STOP=1` + update re-apply verdes em `pgvector/pgvector:pg17` descartável; `\dt followup*` = 4 tabelas nas duas passadas; suite completa de invariantes 34/34 arquivos, 192 testes verdes. Detalhe no report `.superpowers/sdd/task-1.1-report.md`. Bug operacional: Docker daemon estava parado → controller iniciou Docker Desktop e retomou o implementer.

- 2026-07-21: Onda 0 iniciada. HANDOFF antigo (webhooks) arquivado em `docs/superpowers/handoffs/`. Worktree + branch criados. Spec, plano e mineração commitados na base (b1202ca, 790546f).

## Bugs encontrados / corrigidos

_(nenhum ainda)_

## Provas registradas

_(nenhuma ainda — a primeira será o test:invariants da Onda 1)_
