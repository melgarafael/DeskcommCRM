# Progress — gov-loop (DeskcommCRM · Governança de Atendimento)

> Diário de bordo append-only. Cada sessão do loop fecha com 3-5 linhas aqui:
> o que fez, evidência observada (output real, não intenção), o que ficou.

## 2026-07-16 — setup do loop (sessão humana, fora do loop)

- Máquina do gov-loop instalada (portada do vendaval-loop) na branch `gov/setup`
  a partir de `main`, em worktree isolado — checkout principal (cadeia
  `vendaval/F2-*`) intocado.
- Backlog criado: 27 features em 6 fases (G1 provas → G6 contrato externo),
  derivado de 7 eixos de feedbacks reais do sistema-modelo (abstraídos, zero PII)
  + recon do código real (baseline.sql, specs 04/05, MCP tools).
- Spec 13 (esqueleto) criada; apêndices A/B e §3-§5 são entregues por G1-03/04/05.
- Próximo: dono revisa `gov/setup`, mergeia em `main`, e o loop abre G1
  (`/deskcomm-gov-loop`). G1-06 é human_input — as 5 decisões de produto.

## 2026-07-16 — sessão 1 do loop (core) — REPARO DE MAIN

- Smoke de entrada vermelho: `pnpm typecheck` com 12 erros TS, todos em
  `loop/update-feature.ts` (a própria máquina do loop, do setup de ontem).
  Sessão virou reparo (§1.8): gov-implementer tipou o script (interfaces
  Feature/Plan, guard de flags, `fail(): never`) sem mudar comportamento CLI;
  zero any/@ts-ignore; anotações erasable (node 22 type-stripping segue rodando).
- gov-verifier: PASS (hash-check OK). Provou round-trip de campos desconhecidos
  do features.json na reescrita e validações falhando ANTES de escrever.
- Desvio registrado no §0.6: chão de entrada tinha 15 untracked do dono
  (screenshots, AGENTS.md etc.) + `.lina/`. Stashados como "orphan
  2026-07-16T18:43:17-0300" — EXCETO `.lina/` (estado vivo do Lina Space;
  stashar derrubaria o app do dono). `.lina/` permanece untracked no chão.
- Próxima sessão: main verde; G1-01 (gate de CI) é a elegível de menor priority.

## 2026-07-16 — sessão 2 do loop (core) — G1-01

- G1-01 (gate de CI): `gov:verify` no package.json (cadeia `&&`, exit!=0 provado
  com script análogo) + `.github/workflows/ci.yml` novo (pull_request sem filtro
  de branch — de propósito, PRs gov/* precisam do gate; push só main; pnpm 9 +
  node 20 byte-idênticos a perf.yml). Sem envs: os 3 comandos não fazem build Next.
- gov-verifier: PASS, hash-check OK (tree intacto antes/depois da verificação).
- Convenção registrada: `verification.commit="self"` = o próprio commit atômico
  da sessão (auto-referência de sha é impossível pré-commit; audite por
  `git log --grep '<ID>'`). Primeira gravação do update-feature.ts normalizou a
  formatação do features.json (reformat único previsto no header do script).
- Chão de entrada: AGENTS.md/GEMINI.md reapareceram (app externo regenera);
  stashados como "orphan 2026-07-16T18:54:42-0300". `.lina/` segue intocado no chão.
- Próxima sessão: G1-02 (Postgres descartável + isolamento 2-tenants) é a elegível.

## 2026-07-16 — sessão 3 do loop (core) — G1-02

- G1-02 (Postgres descartável + isolamento 2-tenants): `pnpm test:db` sobe
  pgvector:pg17 efêmero (porta 127.0.0.1:54329, --rm, trap EXIT), aplica prelude
  de stubs Supabase (roles, auth.uid() via request.jwt.claims, storage.*) + 
  baseline install (ON_ERROR_STOP=1) + update, e roda 9 testes RLS via
  `docker exec psql` — zero devDependency nova.
- gov-verifier: PASS com probes independentes (UPDATE cross-org → 0 rows;
  authenticated sem claims → nada vaza; SIGINT → teardown ok). Hash-check OK.
- Sessão rodada pelo watchdog (Maestro): terminal Arquiteto ficou Idle após
  G1-01 e a cooperação A2A do Espaço está pausada — continuidade assumida aqui.
- Nota pra fase futura: create policy do apêndice do baseline (0014/0017) não é
  idempotente ("already exists" tolerado no update) — melhoria possível, não bug.
- Próxima sessão: G1-03 (suíte de invariantes dos 7 eixos) ou G1-04 (auditoria
  de gap, sem deps) — G1-03 tem priority menor (30 < 40).

## 2026-07-16 — sessão 4 do loop (core) — G1-03

- G1-03 (suíte de invariantes dos 7 eixos): 8 arquivos em tests/invariants/
  (gov-helpers + gov-1..7), 29 testes no total — 22 verdes + 7 catracas it.fails
  com GAP(Gx). `pnpm test:invariants` = alias do harness test-db.
- Desvio aceito pelo verifier: gap-exemplo "role não editável via API" JÁ estava
  fechado (rota do EPIC-09 em app/api/v1/team/[user_id]/role) → virou invariante
  verde; gaps RBAC reais de G2: pipeline write por agent, conversations write
  por viewer. Catraca provada em probe (it.fails de assert válido → suíte RED).
- gov-verifier: PASS, hash-check OK. Apêndice A da spec 13 preenchido (20 linhas).
- Próxima sessão: G1-04 (auditoria de gap specs 04/05 vs código — sem deps).

## 2026-07-16 — sessão 5 do loop (core) — G1-04

- G1-04 (auditoria specs 04/05 vs código): Apêndice B da spec 13 preenchido —
  20 itens (9 implementado / 5 parcial / 6 ausente), toda linha com arquivo:linha
  conferida pelo verifier (20/20). Claim atômico e handoff §7.5 são reais;
  ReassignDialog, AttendantStatusToggle e supervisor read-only ausentes.
- INB-01 aberto na inbox (proposal): supervisor read-only §10 sem feature G* e
  conflitando com a matriz spec 13 §4 (manager org:write) — decisão do dono.
- Nota do verifier p/ sessão futura: linha "supervisor §10" cita
  conversations/[id]/messages/route.ts:38 mas o POST real é
  app/api/v1/messages/route.ts — ponteiro impreciso, conclusão correta.
- gov-verifier: PASS, hash-check OK (tree + inbox).
- Próxima sessão: G1-05 (modelo de dados alvo + matriz role×recurso, deps G1-04 ✓).
