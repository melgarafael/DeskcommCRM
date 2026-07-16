# CHECKPOINT.md — protocolo de checkpoint por fase (gov-loop)

O loop roda autônomo DENTRO de uma fase; a passagem de fase é decisão humana.
O checkpoint é o único ponto onde o humano entra no caminho feliz — e por isso o
relatório tem que dar ao dono tudo que ele precisa pra decidir em 10 minutos.

## Quando o relatório é emitido

Pela própria sessão do loop (LOOP.md §5), quando:
- **Fase completa**: toda feature da fase com `passes:true`; ou
- **Fase travada**: nenhuma feature elegível — só restam congeladas na inbox ou
  `human_input` pendente → relatório marcado `INCOMPLETO — bloqueado` no título.

Arquivo: `loop/checkpoints/<FASE>-report.md` (ex.: `G1-report.md`), commitado na
branch da fase (`gov/G1`).

## O que o relatório contém (template obrigatório)

```markdown
# Checkpoint <FASE> — <nome da fase> — <data>
Status: COMPLETO | INCOMPLETO — bloqueado

## 1. Entregue nesta fase
| Feature | Título | Commit | Verificação |
|---|---|---|---|
| G1-01 | gate de CI consolidado | abc1234 | gov-verifier PASS 2026-07-20 |

## 2. Evidências (prova, não afirmação)
Por feature de peso: o comando/cenário rodado e a saída observada, colável.
Feature com superfície de UI: screenshots em loop/checkpoints/evidence/<FASE>/
referenciados aqui.
+ Gate específico da fase (ver tabela abaixo) com número/evidência.

## 3. Pendências
Itens abertos da inbox COPIADOS aqui (id, feature, o que precisa do humano) +
features adiadas. (A inbox é operacional e fora do git — a cópia no relatório é o
registro auditável.)

## 4. Riscos observados na construção
O que o loop viu que a spec 13 não previa (dívida assumida, gap novo, acceptance
frouxo). Máx 5 bullets, sem drama.

## 5. O que a PRÓXIMA fase precisa
Pré-requisitos: inputs humanos, decisões pendentes, infra.
(Ex.: G1→G2 precisa das decisões de produto do G1-06 respondidas.)

## 6. Custo da fase
Nº de sessões (sessions.log, linhas started da fase), duração, estimativa de
tokens se disponível.
```

### Gates específicos por fase (de `plan/phases.md` — o relatório DEVE evidenciá-los)

| Fase | O relatório só é aprovável se provar... |
|---|---|
| G1 | CI verde consolidado (local + GitHub Actions) rodando typecheck+lint+test:unit; Postgres descartável valida `baseline.sql` nos modos install e update; suíte de invariantes cobre os 7 eixos, verde com `test.fails` explícito nos gaps; auditoria spec-04/05 vs código real registrada (tabela feito/não-feito com arquivo:linha); modelo de dados alvo detalhado na spec 13 (DDL rascunho + matriz role×recurso); decisões de produto do dono colhidas (G1-06). |
| G2 | Matriz role×endpoint aplicada server-side em `/api/v1` (não só RLS, não só UI); papel de membro editável pós-convite, com audit; invariantes de RBAC de G1 todos verdes (flip dos `test.fails`); E2E de papéis passa (agent não acessa settings/billing/tokens; viewer read-only). |
| G3 | Toda mudança de dono de conversa (claim/transfer/handoff) gera evento auditável; IA é assignee de 1ª classe (`assignee_kind`) — handoff = reassignment auditado; Kanban/lista mostram dono do lead, filtro por dono, atribuição em massa; tags de conversa com filtro. |
| G4 | `visibility_mode` por org aplicado em RLS (conversas/mensagens deixam de ser flat para role `agent`), com teste 2-tenants + 2-atendentes; Inbox/Kanban respeitam escopo, manager+ vê tudo; métricas com filtro por responsável + performance individual. |
| G5 | Config de roteamento por org (modo, capacidade) + disponibilidade/horário por atendente; worker de distribuição via `event_log` (trigger nunca faz HTTP); fila visível com posição; painel admin de gestão de atendentes operante. |
| G6 | MCP tools de governança (assign/tags/queue) + `crm_request_human_handoff` ciente de fila/horário; `ai_dispatch_mode` respeitado pelo dispatcher; tools de leitura expõem assignee/tags/stage/queue; spec 14 publicada com refs `arquivo:linha` verificadas. **O `.approved` desta fase é o gatilho da fase FG do Vendaval.** |

## Como o dono aprova (ou não)

O dono lê o relatório e escolhe UM dos três:

1. **Aprovar**: criar o arquivo de aprovação e commitá-lo —
   ```bash
   echo "approved $(date -Iseconds) by Rafael — <observação opcional>" > loop/checkpoints/<FASE>.approved
   git add loop/checkpoints/<FASE>.approved && git commit -m "chore(<FASE>): checkpoint aprovado"
   ```
   O arquivo `.approved` é o gate físico em DOIS sentidos: destrava a fase seguinte
   (a elegibilidade de G<n> exige G<n-1>.approved — LOOP.md §1.6) e arma o ritual
   de virada (abaixo). (Arquivo em vez de comando interativo porque funciona
   idêntico no headless, é auditável no git e não depende de nenhuma ferramenta.)
2. **Aprovar com ressalvas**: mesmo arquivo + escrever as ressalvas como respostas
   na inbox e/ou ajustar features da próxima fase (commit com `DESKCOMM_GOV_PLAN_EDIT=1`).
3. **Recusar**: NÃO criar o `.approved`. Em vez disso:
   ```bash
   echo "rejected $(date -Iseconds) by Rafael — <motivo em 1 linha>" > loop/checkpoints/<FASE>.rejected
   git mv loop/checkpoints/<FASE>-report.md loop/checkpoints/<FASE>-report.rejected-$(date +%F).md
   git add loop/checkpoints/<FASE>.rejected && git commit -m "chore(<FASE>): checkpoint recusado"
   ```
   e escrever o que falta como itens/respostas na inbox (apontando QUAIS features
   reabrir). **Enquanto o `.rejected` existir, a guarda de entrada do LOOP.md
   bloqueia a fase** — renomear o report não desarma o gate, porque o gate real é o
   par `.approved`/`.rejected` + a elegibilidade por G<n-1>.approved. Destravar =
   reabrir `passes:false` nas features apontadas (via `node loop/update-feature.ts`)
   + remover o `.rejected` — ato do HUMANO (ou de uma sessão executando a resposta
   `answered` da inbox, LOOP.md §0.2), com o commit feito sob
   `DESKCOMM_GOV_PLAN_EDIT=1`. O loop nunca reabre nem remove o `.rejected` por
   conta própria. O report renomeado (`<FASE>-report.rejected-<data>.md`) preserva
   a história; o loop reemitirá o relatório quando a fase fechar de novo.

## Ritual de virada de fase (primeira sessão pós-aprovação)

**Detecção — determinística, por git, nunca por memória** (LOOP.md §1.5): a virada
está pendente quando `loop/checkpoints/<FASE>.approved` existe E
`git merge-base --is-ancestor gov/<FASE> main` FALHA (a branch da fase ainda não
está em main).

A sessão que detectar executa, ANTES de escolher feature — **com a escolha de
publicação que o dono registrou no `.approved`** (as duas opções abaixo são
válidas; a escolha é do dono, anotada na observação do arquivo `.approved` ou na
inbox — na dúvida, opção B, que não publica nada sozinha):

**Opção A — merge + push direto:**
```bash
git checkout main
git merge --no-ff gov/<FASE>
DESKCOMM_GOV_PHASE_MERGE=1 git push origin main   # o ÚNICO push que o pre-push aceita
git branch gov/<FASE+1> main
```

**Opção B — Pull Request (o push é da branch da fase; o merge é humano no GitHub):**
```bash
DESKCOMM_GOV_PHASE_MERGE=1 git push origin gov/<FASE>
gh pr create --base main --head gov/<FASE> \
  --title "checkpoint(<FASE>): fase aprovada" \
  --body "Report: loop/checkpoints/<FASE>-report.md — aprovado em loop/checkpoints/<FASE>.approved"
# após o merge do PR: git checkout main && git pull && git branch gov/<FASE+1> main
```

Depois: registrar a virada no progress.md (2 linhas) e seguir o LOOP.md normal na
fase nova.

Racional: o merge/push pós-aprovação transforma o `.approved` num gate real de
publicação, não só de progresso — e o hook `pre-push` (que só aceita push com
`DESKCOMM_GOV_PHASE_MERGE=1`, exportada só aqui) torna isso física, não instrução.
