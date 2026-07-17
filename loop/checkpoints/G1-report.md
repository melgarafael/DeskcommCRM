# Checkpoint G1 — Provas & Fundação — 2026-07-16
Status: COMPLETO

## 1. Entregue nesta fase
| Feature | Título | Commit | Verificação |
|---|---|---|---|
| — | reparo de main: typecheck de loop/update-feature.ts | 3e344b8 | gov-verifier PASS 2026-07-16T18:50-03:00 |
| G1-01 | Gate de CI consolidado (gov:verify + ci.yml) | 98eb5e6 | gov-verifier PASS 2026-07-16T19:01-03:00 |
| G1-02 | Postgres descartável: baseline install+update + isolamento 2-tenants | 35899ea | gov-verifier PASS 2026-07-16T19:26-03:00 |
| G1-03 | Suíte de invariantes de governança (7 eixos) | f7a6b3c | gov-verifier PASS 2026-07-16T19:48-03:00 |
| G1-04 | Auditoria de gap: specs 04/05 vs código real (Apêndice B) | cedf0ad | gov-verifier PASS 2026-07-16T20:12-03:00 |
| G1-05 | Modelo de dados alvo + matriz role×recurso (spec 13 §3-§4) | 5e77e55 | gov-verifier PASS 2026-07-16T20:24-03:00 |
| G1-06 | INPUT HUMANO: decisões de produto | 20fe969 | gov-verifier PASS 2026-07-16T20:36-03:00 |

## 2. Evidências (prova, não afirmação) — gates da fase G1

- **CI verde consolidado**: `pnpm gov:verify` roda `typecheck && lint && test:unit`
  e retornou exit 0 na verificação (typecheck zerado; lint 0 erros; 12 files /
  94 tests). `.github/workflows/ci.yml` criado (pull_request + push main, pnpm 9 +
  node 20, mesmas versões de perf.yml), sintaxe validada localmente — ainda não
  rodou no GitHub porque o loop não faz push (aguarda ritual de virada).
- **Postgres descartável**: `pnpm test:db` sobe pgvector/pgvector:pg17 efêmero
  (porta 127.0.0.1:54329, --rm, trap EXIT), aplica prelude de stubs Supabase +
  baseline em modo install (`ON_ERROR_STOP=1`) e update. Verificador provou:
  baseline quebrado → exit 3 com teardown executando; SIGINT → sem container
  órfão; `docker ps` limpo após cada run.
- **Invariantes dos 7 eixos**: `pnpm test:invariants` → 8 files / 29 tests verdes
  (22 asserts de estado atual + 7 catracas `it.fails` com `GAP(Gx)`). Catraca
  provada em probe: it.fails sobre gap já corrigido deixa a suíte VERMELHA.
  Isolamento 2-tenants: 9 testes (0 rows cross-org em conversations/messages/
  contacts/crm_leads sob role authenticated + claims; UPDATE cross-org → 0 rows).
- **Auditoria spec 04/05 vs código**: Apêndice B da spec 13 com 20 itens
  (9 implementado / 5 parcial / 6 ausente), toda linha com evidência arquivo:linha
  — verifier abriu 20/20 citações e re-executou os greps de ausência.
- **Modelo de dados alvo**: spec 13 §3 com DDL rascunho das 5 estruturas
  (conversation_assignment_events, assignee_kind, conversations.tags,
  attendant_availability, settings.routing/visibility_mode), cada uma com bloco
  DIRC; §4 com matriz 11 recursos × 4 roles, 7 células PENDENTE G1-06 + 1
  PENDENTE INB-01. Verifier conferiu 8/8 referências baseline.sql:linha.
- **Decisões de produto (G1-06)**: colhidas do dono (via chat ao Maestro +
  AskUserQuestion) e transcritas na spec 13 — (a) own_and_unassigned;
  (b) manual+round-robin; (c) reusa role agent; (d) transferência imediata
  auditada; (e) manager vê métricas individuais; INB-01 supervisor §10
  descartado. Matriz §4 com 0 PENDENTEs (verifier conferiu fidelidade
  célula a célula).

## 3. Pendências (cópia auditável da inbox operacional)

- Nenhuma pendência aberta. INB-01 e INB-02 foram respondidos pelo dono em
  2026-07-16 e estão CLOSED (respostas aplicadas na spec 13 pela G1-06,
  verificadas pelo gov-verifier).

## 4. Riscos observados na construção

- O smoke da main estava vermelho na entrada do loop (o próprio update-feature.ts
  do setup); consertado como sessão de reparo — mas indica que o setup não rodou
  o smoke antes de mergear.
- `verification.commit` registrado como "self" (o sha do próprio commit atômico é
  impossível pré-commit); audite por `git log --grep '<ID>'` — convenção registrada
  no progress.md.
- Apêndice B: ponteiro impreciso na linha supervisor §10 (cita
  conversations/[id]/messages/route.ts:38; o POST real é app/api/v1/messages/
  route.ts) — conclusão correta, corrigir em 1 linha numa sessão futura.
- `create policy` do apêndice do baseline (migrations 0014/0017) não é idempotente
  ("already exists" tolerado no modo update) — melhoria possível no baseline.
- ci.yml só será provado de verdade no primeiro push/PR ao GitHub (virada de fase).

## 5. O que a PRÓXIMA fase (G2) precisa

1. ~~Respostas do dono~~ — FEITO (INB-01/02 closed, spec 13 sem PENDENTEs).
2. Aprovação: dono autorizou via chat (AskUserQuestion 2026-07-16) a criação do
   G1.approved em nome dele, com virada por merge+push direto (opção A).
3. G2-01 pode partir da matriz fechada da spec 13 §4.

## 6. Custo da fase

- 8 sessões (linhas `started` de 2026-07-16 em loop/sessions.log): 1 reparo de
  main + 6 features + 1 sessão de checkpoint. Período: 18:39 → 20:37 (~2h).
- Tokens: sem medição por sessão; implementers/verifiers somaram ~700k tokens de
  subagentes (estimativa da telemetria do orquestrador).
