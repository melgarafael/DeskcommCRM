# RUN.md — como disparar o gov-loop

O loop é o mesmo em qualquer modo: uma sessão descartável executa `loop/LOOP.md`
do zero, guiada só pelo estado em disco. O que muda é quem aperta o botão.

**Onde o loop RODA: no checkout principal — `/Users/rafaelmelgaco/DeskcommCRM`
(`loop/loop.config.json → main_checkout`) — DEPOIS que a branch `gov/setup` for
mergeada em `main`.** O worktree `DeskcommCRM-gov` existe só para montar a
maquinaria sem tocar o checkout principal; ele não é a casa do loop.

## Pré-requisitos (uma vez, no checkout principal pós-merge)

- Repo com `main` já contendo `gov/setup`; `nvm use && pnpm install`; `jq`
  instalado (os hooks e o placar dependem dele); Node ≥ 22.18 no PATH
  (`node loop/update-feature.ts` usa type-stripping nativo); docker (a suíte
  `tests/invariants` usa Postgres descartável).
- **Hooks determinísticos** (a parte do protocolo que não é prosa):
  ```bash
  bash loop/setup-hooks.sh
  ```
  Isso arma via `core.hooksPath`: `pre-commit` (imutabilidade do features.json —
  só `passes`/`verification` mudam fora de sessão humana com
  `DESKCOMM_GOV_PLAN_EDIT=1`; tripla de migration com NNNN validado contra todas
  as branches locais; freeze de `tests/invariants/**`) e `pre-push` (push só com
  `DESKCOMM_GOV_PHASE_MERGE=1`, exportada só pelo ritual de virada).
- **Guard PreToolUse do Claude Code** (merge ADITIVO no `.claude/settings.json`
  local — preserva hooks já existentes, ex.: do Lina Space):
  ```bash
  node loop/setup-claude-guard.mjs
  ```
  Arma o bloqueio de Edit/Write em `plan/features.json` (mutação só via
  `node loop/update-feature.ts`), de Edit/Write em invariante existente e de
  comandos Bash que deletem testes.
- **`.gitignore` do loop** (estado operacional fica fora do git — senão a resposta
  do humano na inbox e a linha `started` do sessions.log sujariam o working tree e
  a guarda de chão limpo as stasharia): o bloco já está no `.gitignore` do repo
  (`loop/inbox.items.md`, `loop/sessions.log`, `loop/logs/`, `loop/locks/`).
  **`loop/checkpoints/evidence/` NÃO é ignorado** — screenshot de checkpoint é
  evidência versionada.
- `plan/features.json` populado (26 features G1-01..G6-04); `plan/progress.md`
  existe; `loop/loop.config.json`:
  ```json
  {
    "max_sessions_per_day": 12,
    "main_checkout": "/Users/rafaelmelgaco/DeskcommCRM",
    "parallel_ui_lane": false,
    "smoke": "pnpm typecheck && pnpm lint && pnpm test:unit"
  }
  ```
  ("hoje" do teto diário é no fuso America/Sao_Paulo.)
- Slash command (modo interativo): `.claude/commands/deskcomm-gov-loop.md`.
  **`/deskcomm-gov-loop`, não `/loop`** — `/loop` colide com a skill built-in
  `loop` e com o plugin `ralph-loop` instalados na máquina do dono; disparar o
  mecanismo errado é risco real.
- **G1-06 é `human_input`** (as 5 decisões de produto do dono): a fase G1 pode
  travar nela — a inbox vai te pedir. As demais features de G1 não dependem dela.

## Modo interativo (você olhando)

```bash
cd /Users/rafaelmelgaco/DeskcommCRM && claude
> /deskcomm-gov-loop
```
Uma sessão = uma feature. Quer outra feature, abra OUTRA sessão (`claude` de novo
ou `/clear` antes de `/deskcomm-gov-loop`). Nunca encadeie duas features na mesma
conversa — contexto acumulado é exatamente o estado-fora-do-disco que o loop proíbe.

Bom para: as primeiras ~5 sessões de cada fase (calibrar acceptance e briefings
observando), sessões de resposta à inbox, destravamento pós-recusa de checkpoint
(que é interativo por natureza) e depuração do próprio loop.

## Modo headless (agendado na máquina do dono)

Salve como `loop/run-session.sh` (não versionado por default — crie quando for
agendar) e agende com cadência ≥2h:

```bash
#!/usr/bin/env bash
set -u
REPO="/Users/rafaelmelgaco/DeskcommCRM"; cd "$REPO" || exit 1

[ -f loop/STOP ] && exit 0
# gate barato em bash: checkpoint pendente ou recusado => nem invoca o modelo
for r in loop/checkpoints/*-report.md; do
  [ -e "$r" ] || continue
  [ -f "${r%-report.md}.approved" ] || exit 0
done
for rej in loop/checkpoints/*.rejected; do
  [ -e "$rej" ] && exit 0   # fase recusada: destravamento é humano/interativo
done

# lock portátil: flock NÃO existe no macOS stock. mkdir é atômico em POSIX;
# o trap devolve o lock na saída (não usar exec).
LOCKDIR="/tmp/deskcomm-gov-loop.lock.d"
mkdir "$LOCKDIR" 2>/dev/null || exit 0
trap 'rmdir "$LOCKDIR"' EXIT

mkdir -p loop/logs
claude -p "Leia loop/LOOP.md e execute o protocolo à risca." \
  --permission-mode acceptEdits \
  --allowedTools "Read,Edit,Write,Bash,Grep,Glob,Task" \
  >> "loop/logs/$(date +%Y%m%d-%H%M%S)-core.log" 2>&1
```

**launchd (macOS — a máquina do dono)** — mesmo padrão do vendaval-loop:
`~/Library/LaunchAgents/com.deskcomm.gov-loop.plist` com `ProgramArguments`
`/bin/bash -lc '/Users/rafaelmelgaco/DeskcommCRM/loop/run-session.sh'` e
`StartCalendarInterval` de 2 em 2 horas na janela 7h-23h. Em Linux/VPS, cron
(`CRON_TZ=America/Sao_Paulo` + `0 7-23/2 * * *`) ou systemd timer.

Cadência ≥2h de propósito: o teto diário (`max_sessions_per_day: 12`) é o gasto
máximo; o intervalo dá tempo de UMA sessão terminar antes da próxima (o lock de
/tmp e o lock de lane no repo seguram sobreposição de qualquer forma — defesa em
profundidade).

## Regras de segurança do loop (invioláveis — e ENFORÇADAS, não só escritas)

1. **Nunca `git push` sem checkpoint aprovado — enforcement físico**: o hook
   `loop/hooks/pre-push` recusa qualquer push sem `DESKCOMM_GOV_PHASE_MERGE=1`, e
   essa variável só é exportada pelo ritual de virada de fase (CHECKPOINT.md), que
   só dispara com `.approved` do dono. Nada sai da máquina sem gate humano — por
   construção, não por obediência. (Alternativa do dono: abrir PR — CHECKPOINT.md.)
2. **Branch por fase** (`gov/G1`, `gov/G2`...): `main` só recebe merge de fase
   aprovada — main é sempre o último estado abençoado pelo dono. Nunca namespace
   `vendaval/*` nem `feat/EPIC-*`.
3. **Teto de sessões/dia** (`max_sessions_per_day: 12`) checado pela própria sessão
   via linhas `started` de hoje (America/Sao_Paulo) em `loop/sessions.log` — a
   linha é escrita na ABERTURA, então sessão que morre no meio conta no orçamento.
4. **Kill switch**: `touch loop/STOP` para o loop na próxima sessão (e o script nem
   invoca o modelo). `rm loop/STOP` religa.
5. **Imutabilidade do plano — enforcement físico**: o pre-commit
   (`loop/hooks/validate-features.sh`) rejeita commit que altere qualquer campo de
   `plan/features.json` além de `passes`/`verification` — a menos que
   `DESKCOMM_GOV_PLAN_EDIT=1` (sessão humana). E a mutação legítima é SÓ via
   `node loop/update-feature.ts` (o PreToolUse barra Edit/Write direto).
6. **`tests/invariants/**` semi-congelado — enforcement físico**: PreToolUse
   bloqueia Edit/Write em arquivo existente; pre-commit (`freeze-invariants.sh`)
   bloqueia M/D sem `DESKCOMM_GOV_INVARIANTS_EDIT=1`. Adição (A) passa livre —
   é assim que a suíte cresce. O flip test.fails→normal é a exceção documentada.
7. **Migration em tripla — enforcement físico**: `check-migration-triple.sh` exige
   baseline.sql + MANIFEST.md no mesmo commit da migration nova e NNNN inédito em
   todas as branches locais (a cadeia `vendaval/F2-*` tem migrations não mergeadas).
8. **Permissões mínimas no headless**: `--permission-mode acceptEdits` +
   `--allowedTools` explícito (nada de `--dangerously-skip-permissions` numa
   máquina com credenciais reais).
9. **Sem segredo em artefato**: `.env*` fora do git; inbox/progress/report nunca
   contêm chave ou PII (LGPD — feedbacks de usuários entraram no backlog já
   abstraídos por tema, zero PII neste repo).
10. **Verifier é inegociável em qualquer modo** — inclusive interativo "só uma
    featurezinha". `passes:true` sem PASS registrado é corrupção do estado do loop.
    E o veredito só vale com o hash-check do orquestrador conferido (LOOP.md §3).

## Observando o loop (sem interromper)
- `tail -f loop/logs/<mais recente>` — a sessão corrente.
- `git log --oneline gov/G1` — o que já entrou.
- `plan/progress.md` — o diário. `loop/inbox.items.md` — o que precisa de você.
- `loop/sessions.log` — aberturas e resultados (started sem par = sessão que morreu).
- `jq '[.features[] | select(.passes)] | length' plan/features.json` — placar (de 26).
