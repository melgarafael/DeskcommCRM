# #3436 — previsão escrita ANTES de qualquer código (PASSO 0 + sabotagem)

Base: `main` 40db347080, worktree `/root/workspace/wt-3436`, branch `fix/3436-on342`.
Este arquivo foi escrito antes de tocar em `route.ts` ou em qualquer teste. As previsões
abaixo NÃO são reescritas depois; se o medido divergir, a divergência é reportada aqui.

## PASSO 0 — o que o código diz, medido por leitura (antes de rodar)

O briefing da tarefa fala em "vazamento entre organizações". A leitura do código não
sustenta isso:

- `lib/escalacao/retomada.ts:132-139` — a leitura da conversa filtra `id` **e**
  `organization_id` (a org vem de `activeOrg.orgId`, nunca do input).
- `lib/escalacao/retomada.ts:151-156, 168-175` — contato lido/escrito com
  `organization_id` explícito; `:227-241` o UPDATE da conversa idem; `:206-213` a RPC
  `fn_conversation_assign` recebe `p_organization_id`; `:290-301` o `emit_event` idem.
- `app/api/v1/conversations/[id]/reactivate-bot/route.ts:43-58` — a rota passa
  `organizationId: activeOrg.orgId` e nada mais.

Conclusão prevista: **não há vazamento cross-org nesta rota** — chamar com uma conversa
de outro tenant já cai em `conversation_not_found` → 404, sem escrita. O defeito real da
issue 3436 é intra-org e cross-ATENDENTE: a rota não olha
`conversations.assigned_to_user_id` contra o usuário da sessão, então qualquer `agent`
solta o dono da conversa de um colega.

## Previsão — rodada 1 (código intacto, testes novos já escritos)

| arquivo | caso | previsto |
|---|---|---|
| `route.dono.test.ts` | agent na conversa de OUTRO atendente → 403 | **VERMELHO** (`expected 200 to be 403`, e `devolverAtendimentoAoAgente` chamado 1x) |
| `route.dono.test.ts` | agent na conversa sem dono → 200 | verde |
| `route.dono.test.ts` | agent na PRÓPRIA conversa → 200 | verde |
| `route.dono.test.ts` | manager na conversa do colega → 200 | verde |
| `route.isolamento.test.ts` | agent do tenant B na conversa do tenant A → 404 e linha do A intacta | **verde** (o filtro de org já existe em `retomada.ts:136`) |
| `route.isolamento.test.ts` | CONTROLE: agent do tenant A na própria conversa → 200 e `assignee_kind='ai'` | verde |
| `route.test.ts` (existente) | casos de #2379 | verde (o mock de `createClient` é `{}` e, antes do conserto, a rota não toca no client) |

Rodapé previsto da rodada 1: `Test Files 1 failed | 2 passed (3)`, `Tests 1 failed | N passed`.

## Previsão — sabotagem (depois do conserto, tudo verde)

**S1 (a obrigatória): apagar o filtro de organização da leitura da conversa** —
remover a linha `.eq("organization_id", organizationId)` de `retomada.ts:136`.

Previsto:
- `route.isolamento.test.ts` caso do tenant B → **VERMELHO**: a função acha a conversa do
  tenant A (o dublê só devolve a linha quando TODOS os filtros batem), segue o fluxo,
  solta o dono do A pela RPC e responde **200** onde o teste exige 404; as asserções de
  linha intacta também acusam (`assigned_to_user_id` do A vira `null`, `assignee_kind`
  vira `'ai'`).
- `route.dono.test.ts` → verde (a função é mockada ali; é o teste da REGRA, não do SQL).
- `route.test.ts` → verde.

Rodapé previsto da S1: `Test Files 1 failed | 2 passed (3)`, `Tests 1 failed | N-1 passed`.

**S2: apagar o ramo de recusa da rota** (o `if (dono && … roleAtLeast …)` novo) —
previsto `route.dono.test.ts` caso do colega **VERMELHO** (200 em vez de 403), resto verde.
S2 não é a sabotagem exigida; entra como segunda prova de que o teste da regra mede o
código novo e não o acaso.

## O que estes testes NÃO medem

- Não há Postgres na bancada: a RLS e a atomicidade de `fn_conversation_assign` não são
  exercidas; o dublê devolve linha quando os filtros batem, o que prova o **filtro**,
  não a policy.
- A janela entre a leitura do dono (na rota) e o `release` (na função) continua aberta —
  `p_enforce_expected: false` segue como está. Este conserto não a fecha.
- O caminho do cron `handoff-devolucao` (chama a função sem sessão) não é afetado.

## ADENDO — escrito ANTES da rodada 1, depois de acrescentar um 4º caso

Ao escrever `route.isolamento.test.ts` entrou um caso que não estava na tabela acima
(escrito depois dela, previsto aqui antes de rodar):

| arquivo | caso | previsto |
|---|---|---|
| `route.isolamento.test.ts` | "agent do tenant A na conversa do COLEGA (mesma org) também não devolve" | **VERMELHO** sem o conserto (200 em vez de 403), **verde** com ele |

Razão de existir: prova que o isolamento por organização (que já funciona) e a recusa
por dono (que falta) são invariantes distintos que convivem no mesmo caminho real.
Rodapé da rodada 1 revisado para: `Test Files 2 failed | 1 passed (3)`,
`Tests 2 failed | N passed`.

---

# MEDIDO (previsões acima NÃO foram reescritas)

## PASSO 0 — rodada 1, código intacto

`pnpm vitest run` nos três arquivos da pasta → **rc=1**, `Test Files 2 failed | 1 passed (3)`,
`Tests 2 failed | 9 passed (11)`.

- `route.dono.test.ts > agent na conversa de OUTRO atendente` → `AssertionError: expected 200 to be 403`.
  O endpoint devolve 200 e devolve o comando ao agente na conversa do colega: **defeito confirmado**.
- `route.isolamento.test.ts > tenant B na conversa do tenant A` → **passou (404)**: o filtro de
  `organization_id` de `retomada.ts` já barra o cross-tenant. **A premissa "vazamento entre
  organizações" do briefing não se confirma** — o defeito da issue 3436 é intra-org, cross-atendente.
- Divergência com a previsão: o 4º caso do `route.isolamento` (colega da mesma org) também ficou
  vermelho (`200` em vez de `403`), como o adendo previu. Contagem 2 vs. 2 previstos no adendo.

## S1 — `.eq("organization_id", …)` removido da leitura da conversa (retomada.ts)

→ **rc=1**, `Test Files 1 failed | 2 passed (3)`, `Tests 2 failed | 9 passed (11)`, os dois casos
cross-tenant de `route.isolamento.test.ts` vermelhos com `expected 409 to be 404`.

**Previsto x medido — onde eu errei:** previ 1 falha e status **200 com a linha do tenant A
mutada**. Medido: **2 falhas** e status **409** (`state_conflict`). Motivo: o filtro de org não é
o único — o UPDATE da conversa, a RPC `fn_conversation_assign` e o `emit_event` também recebem
`organization_id`, então a escrita não vaza; o que vaza é o **código de resposta**: o tenant B
recebe "Alguém assumiu esta conversa agora" (409) para uma conversa que, para ele, não existe.
O dublê reproduz o contrato da RPC (`id AND organization_id`, sem linha → vazio sem erro), o que
explica o 409 em vez do 200 que eu previ. O que a previsão acertou: o teste novo fica vermelho
quando o filtro de org sai. O que ela errou: o número de falhas e a forma da falha.

## S2 — ramo de recusa da rota neutralizado (`if (false && …)`)

→ **rc=1**, `Test Files 2 failed | 1 passed (3)`, `Tests 2 failed | 9 passed (11)`:
`route.dono.test.ts > OUTRO atendente` e `route.isolamento.test.ts > COLEGA (mesma org)`,
ambos `expected 200 to be 403`. **Previsto = medido.**

## Restauração e medição final

- `lib/escalacao/retomada.ts` restaurado por `cp` do backup; `sha256` idêntico ao original
  (`f6517eaa…8437`) e `git diff` vazio para o arquivo.
- `route.ts` restaurado por `cp`; `sha256` idêntico (`816c42d7…3f23`).
- Vitest final (6 arquivos: os 3 da pasta + `tests/unit/escalacao-retomada.test.ts` +
  `conversations/bulk` + `conversations/[id]/transfer`): **rc=0**, `Test Files 6 passed (6)`,
  `Tests 60 passed (60)`.
- `NODE_OPTIONS=--max-old-space-size=6200 pnpm typecheck`: **rc=0**.
- `pnpm lint:role-rank`: **rc=0** (`ok (nenhum ROLE_RANK[ fora de lib/auth/ em app/api)`).
