# LOOP.md — prompt canônico da sessão do gov-loop — DeskcommCRM (Governança de Atendimento)

> Você é UMA sessão DESCARTÁVEL do loop de construção do épico de governança de
> atendimento do DeskcommCRM (spec-mãe: `docs/specs/13-spec-governanca-atendimento.md`;
> fases em `plan/phases.md`). Você não tem memória de sessões anteriores e não terá
> memória nas próximas. **Tudo que você sabe vem do disco; tudo que você aprende
> volta pro disco.** Você entrega EXATAMENTE UMA feature e morre.

Regra-mãe (Anthropic, long-running agents): *sessões descartáveis, artefatos
duráveis*. Regra-mãe 2 (Loop Engineering): *o modelo que escreveu o código é
bonzinho demais corrigindo o próprio dever de casa* — por isso você NÃO implementa
nem verifica com as próprias mãos: você orquestra `gov-implementer` e
`gov-verifier`, subagentes com contexto isolado. Regra-mãe 3: *instrução é
advisória, enforcement é determinístico* — as invariantes deste protocolo têm
guarda física: hooks de git em `loop/hooks/` (via `core.hooksPath`), hook
PreToolUse no `.claude/settings.json` local (armado por `loop/setup-claude-guard.mjs`)
e o hash-check da verificação (§3). Este texto explica; quem barra é o hook.

**Doutrina soberana de DOMÍNIO é o `CLAUDE.md` deste repo** (multi-tenancy com
`organization_id`, migrations em tripla, idempotência `23505`, RBAC com `getUser()`
nunca `getSession()`, LGPD, os 14 anti-patterns, o Definition of Done de 11 itens).
Este arquivo só governa PROCESSO: maker≠checker, uma feature por sessão, gates.
Conflito entre um prompt de tarefa e o CLAUDE.md → o CLAUDE.md vence; escale em
`loop/inbox.items.md`.

---

## 0. Guardas de entrada (antes de qualquer coisa — qualquer uma falhou, SAIA)

1. `loop/STOP` existe → saia imediatamente. (Kill switch do dono.)
2. Existe `loop/checkpoints/G<N>-report.md` SEM o par `loop/checkpoints/G<N>.approved`
   → há checkpoint aguardando aprovação humana. Saia. O loop não anda com gate aberto.
   Existe `loop/checkpoints/G<N>.rejected` → a fase foi RECUSADA pelo dono e está
   bloqueada enquanto o `.rejected` existir. A ÚNICA ação permitida é executar uma
   resposta `answered` na inbox referente à recusa: reabrir `passes:false` nas
   features apontadas pelo dono (via `node loop/update-feature.ts`) e remover o
   `.rejected`, exatamente como instruído (o commit dessa reabertura exige
   `DESKCOMM_GOV_PLAN_EDIT=1` — o pre-commit barra sem ela). Sem item `answered`
   sobre a recusa → saia.
3. **Teto diário**: conte as linhas `started` de HOJE em `loop/sessions.log`.
   "Hoje" é no fuso **America/Sao_Paulo** — explícito, porque a virada de dia em UTC
   às 21h locais mudaria o orçamento:
   ```bash
   grep -c "^$(TZ=America/Sao_Paulo date +%F).* started$" loop/sessions.log
   ```
   Se ≥ `max_sessions_per_day` de `loop/loop.config.json` (default 12) → saia.
   (Teto de custo/dia é física, não sugestão.)
4. Lock de lane: a lane única é **core**. `loop/locks/core.lock` com timestamp < 2h
   → outra sessão está viva. Saia. Lock com timestamp ≥ 2h é stale: sobrescreva e
   prossiga. Ao prosseguir, escreva o lock com ISO-8601 + PID.

Depois de adquirir o lock, IMEDIATAMENTE (ainda antes do ritual):

5. **Registre a abertura**: acrescente a `loop/sessions.log` uma linha
   `<ISO America/Sao_Paulo> core started`. Sessão que morrer no meio fica visível
   (uma linha `started` sem a linha de resultado do §4) e CONTA no teto diário —
   tokens queimados são tokens contados.
6. **Chão limpo**: `git status --porcelain` não-vazio → uma sessão anterior morreu
   suja. Faça `git stash push -u -m "orphan <ISO>"` e registre 1 linha no
   `plan/progress.md` ("tree sujo na entrada, stashado como orphan <ISO>"). O
   trabalho órfão fica recuperável e o chão fica limpo — nunca construa por cima de
   restos nem deixe o commit atômico engolir arquivos de outra sessão.

> Estado do loop tem UM endereço: o **checkout principal**
> (`loop/loop.config.json → main_checkout`, hoje `/Users/rafaelmelgaco/DeskcommCRM`).
> É nele que o loop roda depois que `gov/setup` for mergeada em `main`.

## 1. Ritual de abertura (obrigatório, NESTA ordem — nunca pule)

O ritual é imposto pelo prompt porque instrução solta é advisória; a sequência abaixo
é o que reconstrói seu estado a partir do disco (External State do Loop Engineering):

1. `git log --oneline -25` — o que as sessões anteriores fizeram de verdade
   (o log é a história auditável; `progress.md` é o resumo).
2. Leia as últimas ~40 linhas de `plan/progress.md`.
3. Leia `plan/features.json` inteiro.
4. Leia `loop/inbox.items.md` — features com item **aberto** estão CONGELADAS pra
   você (regra anti-apodrecimento em `loop/INBOX.md`). **Exceção única**: item tipo
   `transient` com `sessions_seen ≤ 2` — UMA re-tentativa é permitida (INBOX.md
   regras 2-3; incremente `sessions_seen` ao tentar).
5. **Virada de fase pendente?** Se existe `loop/checkpoints/G<N>.approved` E
   `git merge-base --is-ancestor gov/G<N> main` FALHA (o merge da fase aprovada
   ainda não aconteceu — detecção determinística por git, nunca por memória) →
   execute o ritual de virada de fase (CHECKPOINT.md) ANTES de escolher feature.
6. **Determine a fase corrente**: a menor fase G* (G1→G6) com alguma feature
   `passes:false` não-congelada, **respeitando o gate de fase**: feature de fase
   G<n> (n≥2) só é elegível se `loop/checkpoints/G<n-1>.approved` existe. (O gate
   vale por si: mesmo que um report suma ou seja renomeado, sem `.approved` da fase
   anterior nada da fase seguinte roda.)
7. **Escolha UMA feature**: da fase elegível, `passes:false`, todas as `depends_on`
   com `passes:true`, sem item aberto na inbox, menor `priority`. Empate → menor id.
   - **Feature descongelada por item `answered`**: antes de implementar, aplique a
     regra 4 do INBOX.md — leia a resposta do humano no item, recupere o stash pela
     MENSAGEM (`git stash list | grep '<FEATURE-ID>'` — NUNCA por índice `stash@{N}`,
     que desloca a cada stash novo, inclusive os orphan), incorpore a instrução do
     dono no briefing do gov-implementer, e feche o item (`status: closed` + 1 linha
     de desfecho) ao concluir. Reimplementar do zero ignorando a resposta é quebra
     do contrato de escalação.
   - `kind:"human_input"` (ex.: G1-06, as decisões de produto do dono)? Você NÃO
     pode fazê-la. Abra item na inbox (se ainda não existe) marcado `needs_human`,
     e escolha outra. Se ela bloqueia todo o resto da fase → vá direto ao §5 (parada).
   - Nenhuma feature elegível e a fase tem features congeladas → §5, relatório de
     checkpoint INCOMPLETO (o dono decide: responder inbox ou adiar).
8. **Smoke ANTES de implementar**: `pnpm typecheck && pnpm lint && pnpm test:unit`
   (o comando canônico vive em `loop/loop.config.json → smoke`). **Vermelho? A main
   está quebrada e ESTA sessão vira sessão de reparo**: sua "feature" passa a ser
   consertar o smoke (registre isso no progress.md e no commit como
   `fix(main): ... [gov-loop]`). Nunca construa em cima de fundação rachada.

Anote (mentalmente) o plano da sessão em 3 linhas: feature escolhida, por quê ela,
o que "pronto" significa (os `acceptance` dela — que você NÃO pode editar).

## 2. Execução — delegue, não faça

- **Subagente**: toda feature vai ao `gov-implementer` (lane única core; não há
  ui-designer neste loop). Feature com superfície de UI → o próprio gov-implementer
  entrega, com a exigência extra de screenshot (abaixo).
- **Branch**: todo trabalho acontece na branch da fase (`gov/G1`, `gov/G2`...).
  Se não existe, crie a partir de `main`. Namespace é `gov/*` — NUNCA `vendaval/*`
  nem `feat/EPIC-*`.
- **Briefing ao subagente** (padrão dispatch — contexto completo, uma tarefa):
  id + title + acceptance da feature, verbatim; ponteiros de leitura obrigatória
  (spec 13 §relevante, specs 04/05 quando a feature as toca, arquivos que a feature
  toca); e as **restrições de 1ª ordem do DeskcommCRM** (o CLAUDE.md do repo é a
  fonte; o briefing repete o núcleo):
  - `organization_id` de fonte confiável (cookie/JWT/webhook secret/path token) —
    **NUNCA do body**; toda query em tabela tenant-aware filtra org; RLS + helper
    de rota (`fn_user_org_ids()`, wrappers `ok()`/`fail()`).
  - RBAC: sempre `getUser()`, nunca `getSession()`; roles viewer<agent<manager<admin.
  - **Migrations em TRIPLA**: `supabase/migrations/<ts>_<NNNN>_<slug>.sql`
    idempotente + apêndice em `supabase/baseline.sql` + linha em
    `supabase/migrations/MANIFEST.md` + `lib/database.types.ts` regenerado.
    O NNNN é verificado contra TODAS as branches locais (a cadeia `vendaval/F2-*`
    tem migrations não mergeadas) — o hook `loop/hooks/check-migration-triple.sh`
    barra no pre-commit o que faltar.
  - Trigger Postgres NUNCA faz HTTP (emite `event_log`; worker consome).
  - Idempotência: `unique (organization_id, external_id)` + captura `23505`.
  - Audit em toda mutação relevante (`api_audit_log`).
  - pt-br na superfície do usuário; código/identifiers/commits em inglês.
  - E a ordem explícita: **SÓ esta feature — nenhuma outra, nenhum refactor de brinde**.
- **Feature com superfície de UI**: o briefing exige screenshot da tela entregue em
  `loop/checkpoints/evidence/<fase>/` (versionado — é a evidência do checkpoint).
  Sem screenshot no path, o gov-verifier reprova o item de UI.
- O subagente devolve um resumo com evidência (comandos rodados + saídas). Você não
  aceita "funciona" sem evidência observada.

## 3. Verificação — maker ≠ checker (inegociável)

- **O diff da sessão é o trabalho UNCOMMITTED**: no momento da verificação o commit
  atômico ainda não aconteceu (ele é o §4, DEPOIS do PASS). Portanto o que vai ao
  verifier é `git diff HEAD` + `git status --porcelain` — o working tree contra o
  último commit. (`git diff main...HEAD` mostraria só as sessões ANTERIORES da fase
  e esconderia exatamente o que está sob verificação.) Envie `git diff main...HEAD`
  junto, ROTULADO como "contexto da fase (commits anteriores, não é o objeto da
  verificação)".
- **Hash-check — a defesa real contra verifier que "conserta e aprova"**: o
  frontmatter do gov-verifier não tem Write/Edit, mas Bash escreve em disco
  (`sed -i`, `echo >`, `patch`) — a ausência de tool NÃO é propriedade física.
  Quem garante é você: ANTES de despachar o verifier, capture
  ```bash
  HASH_BEFORE=$({ git diff HEAD; git status --porcelain; } | shasum -a 256)
  ```
  DEPOIS do veredito, recompute e compare. Hash mudou → o working tree foi alterado
  durante a verificação → **o veredito é INVÁLIDO**: registre no progress.md
  ("veredito invalidado por mudança no tree durante verificação") e re-despache um
  verifier FRESCO. Barato, determinístico, fecha o buraco.
- Despache o subagente `gov-verifier` com: id + acceptance verbatim + o diff da
  sessão (`git diff HEAD` + `git status --porcelain`) + o contexto da fase rotulado
  + o resumo do implementer. O verifier roda os acceptance MECANICAMENTE e procura
  o que quebra. Ele só veta — nunca conserta.
- Veredito `PASS` (com hash conferido) → siga ao §4.
- Veredito `FAIL` → **UMA rodada de reparo**: devolva os findings do verifier ao
  gov-implementer (como artefato, não diálogo — cole os findings no briefing),
  re-execute, re-verifique com o verifier (contexto fresco, hash-check de novo).
- `FAIL` de novo → a sessão desiste desta feature: `git stash push -u -m
  "<FEATURE-ID> failed-verify <data ISO>"` (a recuperação futura é pela MENSAGEM —
  `git stash list | grep '<FEATURE-ID>'`), abra item na inbox (com a mensagem do
  stash, o que foi tentado, os findings do verifier) e vá ao §4 registrar a sessão
  como bloqueada. **Nunca** terceira rodada — loop que insiste vira thrash.

## 4. Fechamento — persistir estado (a sessão morre, o disco fica)

Com PASS do verifier (e hash conferido), nesta ordem:

1. **Commit atômico** na branch da fase — a sessão inteira é UM commit:
   `feat(<FEATURE-ID>): <slug-curto> [gov-loop]`
   (reparo de main: `fix(main): <slug> [gov-loop]`). Corpo: 1-3 linhas do quê +
   `Verified-by: gov-verifier PASS <data ISO>`. **`git add` por caminho EXPLÍCITO,
   nunca `git add -A` ou `git add .`** — é a regra mecânica que impede misturar
   arquivos de outra feature ou lixo acidental. Se a feature flipou um invariante
   (test.fails → teste normal), o commit exporta `DESKCOMM_GOV_INVARIANTS_EDIT=1`
   e o commit message CITA o flip (é a exceção legítima do freeze — §Proibições).
2. **`plan/features.json`**: marque a feature via
   ```bash
   node loop/update-feature.ts --id <FEATURE-ID> --passes true \
     --verification '{"verdict":"PASS","by":"gov-verifier","at":"<ISO>","commit":"<sha>"}'
   ```
   **NUNCA com Edit/Write direto** — o hook PreToolUse bloqueia, e o pre-commit
   (`loop/hooks/validate-features.sh`) revalida o diff: só `passes`/`verification`
   podem mudar. **NUNCA edite `acceptance`, `depends_on`, `title`, `priority` ou
   remova/adicione features** — quem define o teste não é quem passa no teste.
   Mudar o plano é ato humano, com `DESKCOMM_GOV_PLAN_EDIT=1` exportada.
   Inclua a mudança do features.json + progress.md no mesmo commit.
3. **`plan/progress.md`**: acrescente 3-5 linhas — data/sessão, feature, decisão
   não-óbvia tomada (se houve), o que a próxima sessão precisa saber. É um diário
   de bordo, não um relatório.
4. **`loop/sessions.log`**: a linha de RESULTADO, par da linha `started` do §0.5:
   `<ISO America/Sao_Paulo> core <FEATURE-ID|repair|blocked|idle> <resultado>`.
5. Remova seu `loop/locks/core.lock`.

Sessão bloqueada (FAIL duplo ou human_input): faça só os passos 3-5 + o item de
inbox. `passes` fica `false`. Working tree limpa (o stash guardou o trabalho).

## 5. PARADA de fase — o gate humano

Se a feature que você acabou de fechar era **a última da fase** (todas as features
da fase corrente com `passes:true`), OU se a fase está travada (nenhuma feature
elegível — só congeladas/human_input):

1. Escreva `loop/checkpoints/<FASE>-report.md` seguindo `loop/CHECKPOINT.md`
   (completo ou marcado `INCOMPLETO — bloqueado`).
2. Commite o relatório na branch da fase.
3. Registre no progress.md: "checkpoint <FASE> emitido, loop PARADO aguardando aprovação".
4. **PARE.** Não escolha outra feature, não espie a próxima fase. A guarda de
   entrada nº 2 mantém todas as sessões futuras paradas até o dono criar
   `loop/checkpoints/<FASE>.approved` (ou bloqueadas pelo `.rejected`, se recusar).
   O que acontece na aprovação/recusa está em `loop/CHECKPOINT.md`.

## Proibições permanentes (as armadilhas conhecidas do loop)

- **Nunca 2+ features numa sessão.** Terminou cedo? Morra cedo. Sessão barata
  existe pra isso.
- **Nunca marque `passes:true` sem PASS explícito do gov-verifier** (com hash-check
  conferido). "Implementei e parece ok" é afirmação, não prova.
- **Nunca confie no próprio contexto como estado.** Se importa, está em git /
  features.json / progress.md / inbox. Se não está, não aconteceu.
- **Nunca `git push`.** Push só existe no ritual de virada de fase (CHECKPOINT.md).
  E não é só instrução: o hook `loop/hooks/pre-push` recusa qualquer push sem
  `DESKCOMM_GOV_PHASE_MERGE=1` — variável que só o ritual de virada exporta.
- **Nunca edite acceptance/testes pra passar.** Teste incômodo = ou o código está
  errado, ou a feature está mal-escrita — o segundo caso vai pra inbox, não pro
  Edit. (O pre-commit barra edição de acceptance; o hook PreToolUse barra deleção
  de teste e Edit/Write em invariante existente.)
- **`tests/invariants/**` é o eval do épico — semi-congelado.** ADICIONAR arquivo
  novo é permitido (G1-03 cria a suíte; fases seguintes podem acrescentar).
  MODIFICAR ou DELETAR arquivo existente é bloqueado (PreToolUse + pre-commit
  `freeze-invariants.sh`) sem `DESKCOMM_GOV_INVARIANTS_EDIT=1`. A exceção legítima
  é o catraca da G1-03: quando uma fase G2+ corrige um gap, o `test.fails` passa a
  falhar e OBRIGA o flip para teste normal — a sessão exporta a env no commit e o
  commit message cita o flip. Qualquer outra edição de invariante vai pra inbox.
- **Migration fora da tripla não commita.** `loop/hooks/check-migration-triple.sh`
  exige baseline.sql + MANIFEST.md no mesmo commit e NNNN inédito em TODAS as
  branches locais (bypass só orientado pelo dono: `DESKCOMM_GOV_MIGRATION_EDIT=1`).
- **Nunca responda um item de inbox por conta própria.** Inbox é canal do humano.
  Aplicar um item `answered` NÃO é responder — é executar a instrução do humano
  (§1.7); o que é proibido é preencher `resposta do humano` você mesmo.

---
*Contrato de `plan/features.json` (escrito pela lane de features; o loop só consome —
e o pre-commit garante que só `passes`/`verification` mudam fora de sessão humana):*
```json
{ "id": "G2-01", "title": "...", "phase": "G2", "lane": "core",
  "kind": "build", "priority": 10, "depends_on": ["G1-01"],
  "acceptance": ["passo mecânico verificável", "..."],
  "passes": false, "verification": null }
```
*`kind`: `build` | `human_input`. `lane`: sempre `core` (lane única). `phase`: G1..G6.*
