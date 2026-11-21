#!/usr/bin/env bash
# Prova que a JANELA DE MANUTENÇÃO da atualização é configurável por ambiente
# (`SYSTEM_UPDATE_WINDOW`) e que ela segura SÓ a execução do pedido — issue
# #4334, no desenho que o mantenedor pediu em 11/11.
#
#   bash tests/shell/cron-horario-do-agente.test.sh
#
# ── O defeito que ele guarda ─────────────────────────────────────────────────
#
# O pedido da #4334 (@angelusbr): quem opera em horário comercial não quer a
# instalação ~5 minutos em manutenção no meio do expediente (clique 09:01,
# início 09:05, fim 09:10).
#
# O PR começou com outra solução — `AGENT_CRON_SCHEDULE` trocando o HORÁRIO DA
# LINHA do cron — e o mantenedor recusou, medindo o motivo no `agent.sh` da
# `main`: a MESMA rodada do agente manda o heartbeat ao painel e vigia a volta
# depois de uma atualização (seção 3, #2757). Mudando o horário da linha, as
# duas param fora da janela: com `*/5 2-5 * * *`, uma atualização às 5h55 só é
# vigiada até as 5h59, e um app que cai às 6h05 fica fora do ar sem a volta
# automática até a madrugada seguinte — o oposto do que a #4334 pede.
#
# O desenho daqui: o cron continua `*/5 * * * *`, e a janela segura apenas a
# EXECUÇÃO do pedido, dentro do `agent.sh` (seção 4). Batimento e vigília
# rodam sempre.
#
# ── Por que mede o crontab E o agente rodando de verdade ────────────────────
#
# Uma asserção sobre o texto (`grep SYSTEM_UPDATE_WINDOW agent.sh`) passaria com
# a guarda no lugar errado — antes do heartbeat, por exemplo, que é exatamente o
# defeito reprovado. Aqui:
#
#   * o `_common.sh` REAL é carregado num bash filho, com o MESMO
#     `set -euo pipefail` do instalador, e o `crontab` é um dublê em PATH: o que
#     se mede é a linha que o cron do host vai ler;
#   * o `agent.sh` REAL roda de ponta a ponta numa VPS descartável, com
#     `docker`, `crontab`, `flock`, `curl` e `update.sh` dublês — nenhum
#     contêiner sobe e nada toca a máquina de quem roda.
#
# ── Os casos ────────────────────────────────────────────────────────────────
#
#   (a) sem a variável: a linha do cron sai idêntica à de hoje (`*/5 * * * *`)
#   (b) com a janela definida: a linha CONTINUA `*/5 * * * *` — é o coração do
#       desenho novo; se alguém voltar a mexer no passo, este caso cai
#   (c) a expressão da janela: quem entra, quem fica de fora, e o que é recusado
#   (d) re-setup (o que o `update.sh` faz) não duplica e não mexe no resto
#   (e) valor inválido: avisa e EXECUTA (o de hoje — digitação errada não pode
#       deixar a instalação sem atualizar para sempre)
#   (f) FORA da janela: anuncia (heartbeat), vigia, e NÃO executa
#   (g) DENTRO da janela: executa
#   (h) FORA da janela, mas a vigília da volta dispara: a volta acontece — a
#       janela não segura a vigília, que é o motivo da reprovação do desenho
#       anterior
set -uo pipefail
# O idioma canônico do próprio git: `git rev-parse --local-env-vars` lista as
# variáveis que fazem o git resolver OUTRO repositório, e o `unset` as tira
# antes de qualquer `git init` descartável abaixo. A linha é exatamente a dos
# irmãos (`atualizacao-*`, `colisao-de-migration`) porque a cerca
# `testes-de-shell-nao-vazam-identidade` a reconhece pela forma.
unset $(git rev-parse --local-env-vars)
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t.t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t.t

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NS="$(sed -n 's/^IMG_NS="\(.*\)"$/\1/p' "$RAIZ/hostgator-setup-kit/_common.sh" | head -1)"
[ -n "$NS" ] || { echo "não consegui ler IMG_NS de _common.sh"; exit 1; }
REAL_UNAME="$(command -v uname)"

WORK="$(mktemp -d)"
if [ -z "$WORK" ] || [ ! -d "$WORK" ] || [ "$WORK" = / ]; then
  echo "abortado: mktemp -d não devolveu um sandbox (WORK='$WORK')" >&2
  exit 1
fi
trap '[ "${KEEP_WORK:-0}" = 1 ] && echo "sandbox: $WORK" || rm -rf "$WORK"' EXIT

FAILS=0
check() {
  if "${@:2}"; then printf '  ✓ %s\n' "$1"
  else printf '  ✗ ASSERTION FALHOU: %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}
# igual() — mostra o que veio quando falha; `check` sozinho não diz o motivo.
igual() { [ "$1" = "$2" ] && return 0; printf '     esperava: %s\n     veio:     %s\n' "$2" "$1" >&2; return 1; }

# ════════════════════════════════════════════════════════════════════════════
# PARTE 1 — a EXPRESSÃO da janela (função pura: valida e casa, sem relógio)
# ════════════════════════════════════════════════════════════════════════════
mkdir -p "$WORK/bin"
# O roteiro roda num bash filho, como o instalador: `_common.sh` é lido de
# verdade, e o que for chamado depois ("$@") enxerga as funções dele.
cat > "$WORK/consulta.sh" <<'ROTEIRO'
set -euo pipefail
psql_run() { return 0; }
step() { :; }
source "$RAIZ/hostgator-setup-kit/_common.sh" >/dev/null 2>&1
"$@"
ROTEIRO
export WORK RAIZ LOG
consulta() { bash "$WORK/consulta.sh" "$@" 2>/dev/null; }
# casa/nao_casa — silenciosos: `check` roda o comando e herda a stdout, e o
# valor normalizado impresso no meio da lista de ✓ só confunde quem lê.
casa() { consulta janela_contem "$@" >/dev/null 2>&1; }
nao_casa() { ! casa "$@"; }

echo "janela de manutenção da atualização (SYSTEM_UPDATE_WINDOW):"

# ── a normalização e o casamento ───────────────────────────────────────────
check "(c) '*/5 2-5 * * *' é aceita e sai normalizada igual" \
  igual "$(consulta janela_normalizada '*/5 2-5 * * *')" '*/5 2-5 * * *'
check "(c) e às 2h05 está DENTRO" casa '*/5 2-5 * * *' 5 2
check "(c) às 2h06 está FORA (minuto 6 não é */5)" nao_casa '*/5 2-5 * * *' 6 2
check "(c) às 6h00 está FORA (hora 6 não está em 2-5)" nao_casa '*/5 2-5 * * *' 0 6
check "(c) às 5h55 está DENTRO (o fim da janela é inclusivo)" \
  casa '*/5 2-5 * * *' 55 5
check "(c) '0 8 * * *' casa às 8h00 (o '08' do date e o '8' da expressão)" \
  casa "$(consulta janela_normalizada '0 8 * * *')" 0 08
check "(c) listas: '0,30 1,3 * * *' casa 30/3h" casa '0,30 1,3 * * *' 30 3
check "(c) listas: '0,30 1,3 * * *' NÃO casa 15/3h" nao_casa '0,30 1,3 * * *' 15 3
check "(c) passo com faixa: '10-50/20 * * * *' casa 30 e não 35" \
  bash -c 'bash "$WORK/consulta.sh" janela_contem "10-50/20 * * * *" 30 4 >/dev/null &&
           ! bash "$WORK/consulta.sh" janela_contem "10-50/20 * * * *" 35 4 >/dev/null'

# ── as recusas: devolvem 1 e NÃO imprimem nada ─────────────────────────────
# O "não imprimir nada" é o contrato: quem chama nunca usa o valor recusado.
recusada() {  # recusada <valor>
  local saida rc=0
  saida="$(consulta janela_normalizada "$1")" || rc=$?
  [ "$rc" -ne 0 ] && [ -z "$saida" ]
}
for valor in \
  '*/5 2-5 *' \
  '*/5 2-5 * * * ; rm -rf /' \
  $'*/5 2-5 * * *\n* * * * * touch /tmp/injecao-753' \
  '*/5 25 * * *' \
  '60 2 * * *' \
  '*/5 2-5 * * 1' \
  '*/0 2 * * *' \
  '70-80 2 * * *' \
  '5-3 2 * * *' \
  '*/5 2-5 * *' \
  '*/5 08 * * *e'; do
  rotulo="$(printf '%s' "$valor" | tr '\n' '|')"
  if recusada "$valor"; then
    printf '  ✓ (c) recusa %-45s sem imprimir nada\n' "'$rotulo'"
  else
    printf '  ✗ ASSERTION FALHOU: (c) deveria recusar %s\n' "'$rotulo'"
    FAILS=$((FAILS + 1))
  fi
done

# ════════════════════════════════════════════════════════════════════════════
# PARTE 2 — a LINHA do cron: `*/5 * * * *`, com ou sem janela
# ════════════════════════════════════════════════════════════════════════════
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

# Dublê de `crontab` em PATH: lê e grava um arquivo, nunca o do host.
# (`-l` sai 1 quando o arquivo não existe, como o cron numa VPS nova.)
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

cat > "$WORK/roteiro.sh" <<'ROTEIRO'
set -euo pipefail
export PATH="$WORK/bin:$PATH"
psql_run() { return 0; }
step() { :; }
source "$RAIZ/hostgator-setup-kit/_common.sh" >/dev/null 2>&1
setup_update_agent_cron > "$LOG" 2>&1
ROTEIRO

export CRONTAB_ARQUIVO="$CRU"
export PROJECT_DIR="$PROJ"
export INTERNAL_SECRET="segredo-de-teste"
export NEXT_PUBLIC_APP_URL="https://crm.exemplo.com.br"
export CRU

resetar() { crontab_de_hoje; : > "$LOG"; }
LINHA_DO_AGENTE() { grep -F 'bash hostgator-setup-kit/agent.sh' "$CRU"; }
N_AGENTE() { local n; n="$(grep -cF 'bash hostgator-setup-kit/agent.sh' "$CRU" || true)"; printf '%s' "${n:-0}"; }
N_LINHAS() { local n; n="$(grep -c . "$CRU" || true)"; printf '%s' "${n:-0}"; }
padrao_mantido() { grep -qxF -- "$LINHA_AGENTE_HOJE" "$CRU"; }
comando_preservado() {
  local horario="$1" linha
  linha="$(LINHA_DO_AGENTE)"
  [ "${linha#"$horario "}" = "$COMANDO_AGENTE" ]
}
setup_rodou() { grep -qF 'atualização pela tela ativa' "$LOG"; }

# CONTROLE POSITIVO: sem isto, um roteiro que nem chega à função deixaria o
# crontab na fixture (que já tem a linha de hoje) e o caso (a) passaria por
# vacuidade — já aconteceu na primeira escrita deste arquivo.
resetar; ( unset SYSTEM_UPDATE_WINDOW; bash "$WORK/roteiro.sh" )
check "controle: o setup rodou e falou (a mensagem de sucesso saiu)" setup_rodou

# ── (a) sem a variável: comportamento IDÊNTICO ao de hoje ──────────────────
resetar; ( unset SYSTEM_UPDATE_WINDOW; bash "$WORK/roteiro.sh" )
check "(a) sem SYSTEM_UPDATE_WINDOW a linha sai igual à de hoje (*/5 * * * *)" padrao_mantido
check "(a) e o comando do agente continua o mesmo" comando_preservado '*/5 * * * *'
check "(a) uma única linha do agente" [ "$(N_AGENTE)" = 1 ]

# ── (b) com a janela definida, a LINHA não muda ────────────────────────────
# É o coração do desenho novo: a janela decide a execução, dentro do agente —
# nunca o passo do cron. Quem voltar a mexer no horário da linha cai aqui.
resetar; ( export SYSTEM_UPDATE_WINDOW='*/5 2-5 * * *'; bash "$WORK/roteiro.sh" )
check "(b) com a janela definida a linha CONTINUA */5 * * * *" padrao_mantido
check "(b) e o comando do agente não mudou" comando_preservado '*/5 * * * *'
check "(b) e a janela não virou uma segunda linha no crontab" [ "$(N_LINHAS)" = 3 ]

# ── (c) valor inválido não muda a linha nem inventa tarefa ─────────────────
for valor in '*/5 2-5 *' $'*/5 2-5 * * *\n*/1 * * * * touch /tmp/injecao-753'; do
  rotulo="$(printf '%s' "$valor" | tr '\n' '|')"
  resetar; ( export SYSTEM_UPDATE_WINDOW="$valor"; bash "$WORK/roteiro.sh" )
  check "(c) janela inválida '$rotulo' mantém a linha de hoje" padrao_mantido
  check "(c) janela inválida '$rotulo' não injeta segunda linha (seguem 3)" \
    [ "$(N_LINHAS)" = 3 ]
done
check "(c) nada de 'injecao-753' no crontab" bash -c '! grep -qF injecao-753 "$CRU"'

# ── (d) o re-setup do update.sh não duplica nem mexe no resto ──────────────
resetar
( export SYSTEM_UPDATE_WINDOW='*/5 2-5 * * *'; bash "$WORK/roteiro.sh" )
( export SYSTEM_UPDATE_WINDOW='*/5 2-5 * * *'; bash "$WORK/roteiro.sh" )
check "(d) o re-setup preserva a linha de hoje" padrao_mantido
check "(d) e não duplica a linha :agent (segue uma)" [ "$(N_AGENTE)" = 1 ]
check "(d) e continua com exatamente 3 linhas no crontab" [ "$(N_LINHAS)" = 3 ]
check "(d) a linha alheia do host segue intacta" grep -qxF -- "$LINHA_ALHEIA" "$CRU"
check "(d) a linha do event-log-drain segue intacta" grep -qxF -- "$LINHA_DRAIN" "$CRU"

# ════════════════════════════════════════════════════════════════════════════
# PARTE 3 — o AGENTE rodando: fora da janela anuncia e não executa; dentro,
# executa. A vigília (seção 3) e o heartbeat rodam nos dois casos.
# ════════════════════════════════════════════════════════════════════════════
mkdir -p "$WORK/dub"
export DUB="$WORK/dub"
export DOCKER_LOG="$WORK/docker.log"
export POSTS_LOG="$WORK/posts-agent.log"
export CHAMADAS_LOG="$WORK/chamadas-update.log"
export FAKE_CRONTAB="$WORK/crontab-do-agente.txt"

cat > "$WORK/bin/docker" <<'DUBLE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "${1:-}" in
  info|image|inspect|images|run|network|start|rm|volume|logs|ps) exit 0 ;;
  buildx) exit 0 ;;
esac
if [ "${1:-}" = compose ]; then
  args="$*"
  case "$args" in
    *" exec "*) printf 'healthy\n{"data":{"status":"healthy","version":"0.9.0","checks":{}}}\n'; exit 0 ;;
    *" images -q "*) printf 'sha-%s\n' "${APP_IMAGE##*:}"; exit 0 ;;
    *" ps "*) printf 'app running\nworker running\nscheduler running\ncaddy running\n'; exit 0 ;;
    *" up "*) exit 0 ;;
  esac
fi
exit 0
DUBLE

cat > "$WORK/bin/flock" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

# `curl` responde três coisas, por endereço: a API de tags, a rota de saúde e o
# POST do agente (que fica registrado, com o corpo, no POSTS_LOG).
cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
url=""
for a in "$@"; do case "$a" in http*) url="$a" ;; esac; done
case "$url" in
  *api.github.com*) printf '{"tag_name":"v0.9.0"}\n'; exit 0 ;;
  *api/v1/health*)
    if [ "$(cat "$DUB/saude" 2>/dev/null || echo ok)" = "down" ]; then
      printf 'no available server\n'
    else
      printf '{"data":{"status":"healthy","version":"0.9.0","checks":{}}}\n'
    fi
    exit 0 ;;
  *api/v1/system/agent*)
    printf '%s\n' "$*" >> "${POSTS_LOG:?}"
    printf '{"data":{"update_requested":true,"run_id":"00000000-0000-4000-8000-000000000753","to_version":"v0.9.0","force_requested":false}}\n200'
    exit 0 ;;
esac
exit 0
STUB

cat > "$WORK/bin/uname" <<STUB
#!/usr/bin/env bash
[ "\$*" = "-m" ] && { printf 'x86_64\n'; exit 0; }
exec "$REAL_UNAME" "\$@"
STUB
chmod +x "$WORK/bin/docker" "$WORK/bin/flock" "$WORK/bin/curl" "$WORK/bin/uname"
export PATH="$WORK/bin:$PATH"
export REAL_UNAME

# A VPS: o projeto no ar na 0.8.0, com a 0.9.0 publicada no git.
AG="$WORK/agente/projeto"
mkdir -p "$AG"
export AG
cp -RL "$RAIZ/hostgator-setup-kit" "$AG/"
# Instalação LEGADA, sem `_runtime.sh`: é a que depende deste agente para tudo
# (a confirmação de runtime veio depois). Com o arquivo, o agente confere
# imagem real do registro antes de instalar — e aqui não há registro.
rm -f "$AG/hostgator-setup-kit/_runtime.sh"
printf 'services:\n  app:\n    image: ${APP_IMAGE:-x}\n' > "$AG/docker-compose.prod.yml"
printf '0.8.0\n0.9.0\n' > "$WORK/dub/imagens-locais"
printf 'ok\n' > "$WORK/dub/saude"
(
  cd "$AG" || exit 1
  git init --quiet
  printf 'instalada 0.8.0\n' > versao.txt
  git add -A && git commit --quiet -m "v0.8.0"
  git tag v0.8.0
  printf 'publicada 0.9.0\n' > versao.txt
  git add -A && git commit --quiet -m "v0.9.0"
  git tag v0.9.0
  git checkout --quiet v0.8.0
) >/dev/null 2>&1

# O `update.sh` do agente é um dublê: registra a chamada e sai 0.
cat > "$AG/hostgator-setup-kit/update.sh" <<'STUB'
#!/usr/bin/env bash
printf 'chamada: %s\n' "$*" >> "${CHAMADAS_LOG:?}"
exit 0
STUB
chmod +x "$AG/hostgator-setup-kit/update.sh"

# O `.env` é de onde a variável chega em produção (`load_env` a exporta).
escrever_env() {  # escrever_env [janela]
  {
    printf 'APP_IMAGE=%s/deskcommcrm:0.8.0\n' "$NS"
    printf 'WORKER_IMAGE=%s/deskcomm-worker:0.8.0\n' "$NS"
    printf 'SCHEDULER_IMAGE=%s/deskcomm-scheduler:0.8.0\n' "$NS"
    printf 'WAHA_IMAGE=devlikeapro/waha:latest-2026.7.2\n'
    printf 'SUPABASE_DB_URL=postgresql://x/y\n'
    printf 'NEXT_PUBLIC_APP_URL=https://crm.exemplo.com.br\n'
    printf 'INTERNAL_SECRET=segredo\n'
    [ -z "${1-}" ] || printf 'SYSTEM_UPDATE_WINDOW=%s\n' "$1"
  } > "$AG/.env"
  chmod 600 "$AG/.env"
}

preparar_agente() {  # preparar_agente [janela]
  : > "$DOCKER_LOG"; : > "$POSTS_LOG"; : > "$CHAMADAS_LOG"
  rm -f "$AG/.update-vigia" "$AG/.update-vigia-falhas" "$AG/.update-agent.log"
  printf 'ok\n' > "$WORK/dub/saude"
  escrever_env "${1-}"
}

rodar_agente() {
  ( cd "$AG" && env -i PATH="$WORK/bin:$PATH" HOME="$WORK" \
      CHAMADAS_LOG="$CHAMADAS_LOG" POSTS_LOG="$POSTS_LOG" DUB="$DUB" \
      DOCKER_LOG="$DOCKER_LOG" FAKE_CRONTAB="$FAKE_CRONTAB" CRONTAB_ARQUIVO="$FAKE_CRONTAB" \
      bash hostgator-setup-kit/agent.sh ) > "$WORK/agente-saida.txt" 2>&1
  return 0
}
chamadas() { local n; n="$(grep -c '^chamada:' "$CHAMADAS_LOG" 2>/dev/null || true)"; printf '%s' "${n:-0}"; }
chamou_ate() { grep -qxF -- "chamada: --to $1" "$CHAMADAS_LOG" 2>/dev/null; }
anunciou() { grep -qF '"kind":"heartbeat"' "$POSTS_LOG" 2>/dev/null; }
log_contem() { [ -f "$AG/.update-agent.log" ] && grep -qF -- "$1" "$AG/.update-agent.log"; }
vigia_rodou() { [ ! -e "$AG/.update-vigia-falhas" ] && [ -e "$AG/.update-vigia" ]; }

# Horas da janela, calculadas na hora do teste: `dentro` cobre esta hora e a
# seguinte (para não quebrar se a rodada cruzar a virada da hora); `fora` é uma
# hora três passos à frente, que uma rodada de teste não alcança.
H_AGORA="$(date +%H)"
H_DENTRO=$(( (10#$H_AGORA + 1) % 24 ))
H_FORA=$(( (10#$H_AGORA + 3) % 24 ))
JANELA_DENTRO="* $((10#$H_AGORA)),${H_DENTRO} * * *"
JANELA_FORA="* ${H_FORA} * * *"

# ── (f) FORA da janela: anuncia, vigia e NÃO executa ───────────────────────
preparar_agente "$JANELA_FORA"
# Marca de vigília com UMA falha e app respondendo: se a seção 3 rodar, a
# contagem zera (é o sinal de que a vigília passou por aqui).
printf '%s\n%s\n' "$(( $(date -u +%s) - 60 ))" 'v0.8.0' > "$AG/.update-vigia"
printf '1\n' > "$AG/.update-vigia-falhas"
rodar_agente

check "(f) anuncia: o heartbeat foi ao painel" anunciou
check "(f) anuncia o pedido esperando a janela no log do host" \
  log_contem "janela de manutenção (${JANELA_FORA}) está fechada"
check "(f) vigia: a seção 3 rodou (a contagem foi zerada, a marca segue)" vigia_rodou
check "(f) NÃO executa: o update.sh não foi chamado" [ "$(chamadas)" = 0 ]
check "(f) e nenhum run_result de execução foi mandado ao painel" \
  bash -c '! grep -qF "\"kind\":\"run_result\"" "$POSTS_LOG"'

# ── (g) DENTRO da janela: executa ─────────────────────────────────────────
preparar_agente "$JANELA_DENTRO"
rodar_agente
check "(g) executa: o update.sh foi chamado UMA vez" [ "$(chamadas)" = 1 ]
check "(g) com o alvo do pedido (--to v0.9.0)" chamou_ate v0.9.0
check "(g) e o heartbeat foi junto (o caminho é o mesmo de sempre)" anunciou
check "(g) sem aviso de janela recusada no log" \
  bash -c '! grep -qF "SYSTEM_UPDATE_WINDOW recusado" "$AG/.update-agent.log"'

# ── (h) FORA da janela, mas a vigília da volta dispara: a volta acontece ───
# É o caso que motivou a reprovação do desenho anterior: a janela segura o
# PEDIDO, nunca a vigília. Aqui o app está fora do ar, a marca tem duas falhas
# seguidas e uma atualização não pedida tem de voltar — mesmo fora da janela.
preparar_agente "$JANELA_FORA"
printf '%s\n%s\n' "$(( $(date -u +%s) - 60 ))" 'v0.8.0' > "$AG/.update-vigia"
printf '1\n' > "$AG/.update-vigia-falhas"
printf 'down\n' > "$WORK/dub/saude"
rodar_agente
check "(h) a volta sozinha rodou FORA da janela (--to v0.8.0 --force)" \
  grep -qxF -- 'chamada: --to v0.8.0 --force' "$CHAMADAS_LOG"
check "(h) a vigília não foi barrada pela janela (a marca foi encerrada)" \
  [ ! -e "$AG/.update-vigia" ]

# ── (e) valor inválido: avisa em voz alta e executa (o de hoje) ────────────
preparar_agente '*/5 25 * * *'
rodar_agente
check "(e) janela inválida avisa qual variável recusou" \
  log_contem "SYSTEM_UPDATE_WINDOW recusado ('*/5 25 * * *')"
check "(e) e executa o pedido (digitação errada não para a instalação)" \
  [ "$(chamadas)" = 1 ]

if [ "$FAILS" -gt 0 ]; then printf '\n%d falha(s)\n' "$FAILS"; exit 1; fi
printf '\ntudo verde\n'
