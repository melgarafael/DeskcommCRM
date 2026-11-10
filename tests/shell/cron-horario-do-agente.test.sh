#!/usr/bin/env bash
# Prova que o HORÁRIO do cron do agente de atualização é configurável por
# ambiente (`AGENT_CRON_SCHEDULE`) sem perder o padrão de hoje — issue #4334.
#
#   bash tests/shell/cron-horario-do-agente.test.sh
#
# ── O defeito que ele guarda ─────────────────────────────────────────────────
#
# O horário vivia fixo em `*/5 * * * *` dentro de `setup_update_agent_cron`
# (`hostgator-setup-kit/_common.sh`), e o `update.sh` chama essa função em TODA
# atualização (bloco 0, antes de decidir a versão). Editar a linha no crontab à
# mão não se sustenta: a atualização seguinte apaga a linha `:agent` e grava a
# fixa de novo. O efeito medido pelo autor (@angelusbr): quem opera em horário
# comercial só atualiza com a instalação ~5 min em manutenção no meio do
# expediente (clique 09:01, início 09:05, fim 09:10).
#
# ── Por que mede o crontab RESULTANTE, e não o texto da função ──────────────
#
# Uma asserção sobre o código (`grep AGENT_CRON_SCHEDULE _common.sh`) passaria
# com a variável lida no lugar errado, com o horário ainda fixo na linha, ou
# com a validação aceitando lixo. Aqui o `_common.sh` REAL é carregado num bash
# filho com o MESMO `set -euo pipefail` do instalador, o `crontab` é um dublê
# em PATH (como em `cron-sem-crontab-previo.test.sh`) e o que se mede é o
# crontab que sobra depois de `setup_update_agent_cron` — exatamente o arquivo
# que o cron do host vai ler.
#
# ── Os cinco casos do contrato ──────────────────────────────────────────────
#
#   (a) sem a variável: a linha sai idêntica à de hoje (`*/5 * * * *`)
#   (b) com `*/5 2-5 * * *`: a linha sai com esse horário e o comando igual
#   (c) valor inválido (3 campos, shell injetado, quebra de linha): recusa,
#       padrão mantido, aviso emitido e NENHUMA linha nova no crontab
#   (d) re-setup (o que o `update.sh` faz) preserva o horário e não duplica
#   (e) nenhuma outra linha do crontab muda (o drain e a linha alheia)
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() {
  if "${@:2}"; then printf '  ✓ %s\n' "$1"
  else printf '  ✗ ASSERTION FALHOU: %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}

# ── Fixture: o crontab como o `update.sh` o encontra numa instalação real ────
# Três linhas: uma alheia (outra tarefa do host), o drain desta instalação e o
# agente desta instalação, com os marcadores que o kit usa.
PROJ="$WORK/projeto"
mkdir -p "$PROJ"
TAG_DRAIN="# deskcomm:${PROJ}:drain"
TAG_AGENT="# deskcomm:${PROJ}:agent"
URL_DRAIN="https://crm.exemplo.com.br/api/v1/cron/event-log-drain"
CRU="$WORK/crontab"
LOG="$WORK/saida.txt"

LINHA_ALHEIA='0 8 * * * /root/trend-radar/run_full_vps.sh'
LINHA_DRAIN="* * * * * curl -fsS -H @\"${PROJ}/.env.cron-drain\" \"${URL_DRAIN}\" >/dev/null 2>&1 ${TAG_DRAIN}"
COMANDO_AGENTE="cd ${PROJ} && bash hostgator-setup-kit/agent.sh >/dev/null 2>&1 ${TAG_AGENT}"
LINHA_AGENTE_HOJE="*/5 * * * * ${COMANDO_AGENTE}"

crontab_de_hoje() {
  {
    printf '%s\n' "$LINHA_ALHEIA"
    printf '%s\n' "$LINHA_DRAIN"
    printf '%s\n' "$LINHA_AGENTE_HOJE"
  } > "$CRU"
}

# ── Dublê de `crontab` em PATH: lê e grava um arquivo, nunca o do host ──────
# (`-l` sai 1 quando o arquivo não existe, como o cron numa VPS nova.)
mkdir -p "$WORK/bin"
cat > "$WORK/bin/crontab" <<'DUBLE'
#!/usr/bin/env bash
case "${1:-}" in
  -l) [ -f "${CRONTAB_ARQUIVO:?}" ] || { echo "no crontab for root" >&2; exit 1; }
      cat "$CRONTAB_ARQUIVO" ;;
  -)  cat > "${CRONTAB_ARQUIVO}.novo" && mv "${CRONTAB_ARQUIVO}.novo" "$CRONTAB_ARQUIVO" ;;
  *)  exit 2 ;;
esac
DUBLE
chmod +x "$WORK/bin/crontab"

# ── O roteiro roda num bash filho, como o instalador roda ───────────────────
# Estático, e lendo tudo do ambiente: assim o caso (a) consegue NÃO definir
# `AGENT_CRON_SCHEDULE` (em vez de defini-la vazia, que é outro caminho).
cat > "$WORK/roteiro.sh" <<'ROTEIRO'
set -euo pipefail
export PATH="$WORK/bin:$PATH"
psql_run() { return 0; }
step() { :; }
source "$RAIZ/hostgator-setup-kit/_common.sh" >/dev/null 2>&1
setup_update_agent_cron > "$LOG" 2>&1
ROTEIRO

export WORK RAIZ LOG
export CRONTAB_ARQUIVO="$CRU"
export PROJECT_DIR="$PROJ"
export INTERNAL_SECRET="segredo-de-teste"
export NEXT_PUBLIC_APP_URL="https://crm.exemplo.com.br"

resetar() { crontab_de_hoje; : > "$LOG"; }

# rodar <valor|__AUSENTE__> — uma execução de `setup_update_agent_cron` sobre o
# crontab que já estiver lá (é o que o re-setup do update.sh faz).
rodar() {
  if [ "$1" = "__AUSENTE__" ]; then
    ( unset AGENT_CRON_SCHEDULE; bash "$WORK/roteiro.sh" )
  else
    ( export AGENT_CRON_SCHEDULE="$1"; bash "$WORK/roteiro.sh" )
  fi
}

# ── réguas de asserção ─────────────────────────────────────────────────────
linha_do_agente() { grep -F 'bash hostgator-setup-kit/agent.sh' "$CRU"; }
n_agente() { local n; n="$(grep -cF 'bash hostgator-setup-kit/agent.sh' "$CRU" || true)"; printf '%s' "${n:-0}"; }
n_linhas() { local n; n="$(grep -c . "$CRU" || true)"; printf '%s' "${n:-0}"; }
padrao_mantido() { grep -qxF -- "$LINHA_AGENTE_HOJE" "$CRU"; }
nao_tem() { ! grep -qF -- "$1" "$CRU"; }
# nao_agendou_com <valor> — o valor recusado não virou o horário da linha do
# agente (a outra ponta: "não está em lugar nenhum" é fácil demais de passar).
nao_agendou_com() { ! grep -qxF -- "$1 ${COMANDO_AGENTE}" "$CRU"; }
avisou() { grep -qF 'AGENT_CRON_SCHEDULE' "$LOG"; }
# comando_preservado <horário> — tira o horário da linha gravada e compara o
# resto BYTE A BYTE com o comando de hoje. Sem isto, "o horário mudou" poderia
# passar junto com um comando diferente (caminho, redirecionamento, marcador).
comando_preservado() {
  local horario="$1" linha
  linha="$(linha_do_agente)"
  [ "${linha#"$horario "}" = "$COMANDO_AGENTE" ]
}

echo "horário do cron do agente (AGENT_CRON_SCHEDULE):"

# CONTROLE POSITIVO — sem isto, um roteiro que nem chega à função deixaria o
# crontab na fixture (que já tem a linha de hoje) e o caso (a) passaria por
# vacuidade. Aconteceu na primeira escrita deste arquivo: `LOG` não exportado
# fez o bash filho morrer antes do setup, e só este controle acusaria.
setup_rodou() { grep -qF 'atualização pela tela ativa' "$LOG"; }
resetar; rodar __AUSENTE__
check "controle: o setup rodou e falou (a mensagem de sucesso saiu)" setup_rodou

# ── (a) sem a variável, comportamento IDENTICO ao de hoje ───────────────────
resetar; rodar __AUSENTE__
check "(a) sem AGENT_CRON_SCHEDULE a linha sai igual à de hoje (*/5 * * * *)" \
  grep -qxF -- "$LINHA_AGENTE_HOJE" "$CRU"
check "(a) e o comando do agente continua o mesmo" comando_preservado '*/5 * * * *'
check "(a) uma única linha do agente" [ "$(n_agente)" = 1 ]

# ── (b) horário configurado sai na linha, com o MESMO comando ──────────────
resetar; rodar '*/5 2-5 * * *'
check "(b) a linha do agente sai com o horário configurado" \
  grep -qxF -- "*/5 2-5 * * * ${COMANDO_AGENTE}" "$CRU"
check "(b) e o comando do agente não mudou" comando_preservado '*/5 2-5 * * *'
check "(b) uma única linha do agente" [ "$(n_agente)" = 1 ]

# ── (c) valor inválido: recusa explícita e FALHA FECHADA ───────────────────
# O terceiro valor é uma INJEÇÃO de segunda linha: sem a recusa, o crontab
# ganharia uma tarefa que o filtro por marcador não remove — ela ficaria
# agendada para sempre.
for valor in \
  '* * *' \
  '*/5 2-5 * * * ; rm -rf /' \
  $'*/5 2-5 * * *\n* * * * * touch /tmp/injecao-753'; do
  rotulo="$(printf '%s' "$valor" | tr '\n' '|')"
  resetar; rodar "$valor"
  check "(c) valor inválido '$rotulo' mantém o padrão (*/5 * * * *)" padrao_mantido
  check "(c) valor inválido '$rotulo' NÃO vira horário da linha do agente" \
    nao_agendou_com "$valor"
  check "(c) valor inválido '$rotulo' não injeta segunda linha (seguem 3 linhas)" \
    [ "$(n_linhas)" = 3 ]
  check "(c) valor inválido '$rotulo' avisa qual variável recusou" avisou
done
check "(c) nada de 'rm -rf /' no crontab" nao_tem '; rm -rf /'
check "(c) nada de 'injecao-753' no crontab" nao_tem 'injecao-753'

# ── (d) o re-setup do update.sh preserva e não duplica ─────────────────────
# Duas rodadas seguidas com a MESMA variável: é o que acontece quando o dono
# atualiza duas vezes com `0 3 * * *` no .env.
resetar; rodar '0 3 * * *'; rodar '0 3 * * *'
check "(d) o re-setup preserva o horário configurado" \
  grep -qxF -- "0 3 * * * ${COMANDO_AGENTE}" "$CRU"
check "(d) e o comando do agente não mudou" comando_preservado '0 3 * * *'
check "(d) e não duplica a linha :agent (segue uma)" [ "$(n_agente)" = 1 ]
check "(d) e continua com exatamente 3 linhas no crontab" [ "$(n_linhas)" = 3 ]

# ── (e) nenhuma outra linha do crontab é tocada ────────────────────────────
check "(e) a linha alheia do host segue intacta" grep -qxF -- "$LINHA_ALHEIA" "$CRU"
check "(e) a linha do event-log-drain segue intacta" grep -qxF -- "$LINHA_DRAIN" "$CRU"

if [ "$FAILS" -gt 0 ]; then printf '\n%d falha(s)\n' "$FAILS"; exit 1; fi
printf '\ntudo verde\n'
