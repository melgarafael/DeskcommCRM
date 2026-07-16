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
