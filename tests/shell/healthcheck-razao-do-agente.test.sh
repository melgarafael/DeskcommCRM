#!/usr/bin/env bash
# O healthcheck mostra a RAZÃO da última falha do agente de atualização.
#
#   bash tests/shell/healthcheck-razao-do-agente.test.sh
#
# Medido numa VPS de teste (PR #2524, U1 Passo 4): o diagnóstico imprimia
# "⚠ o agente falhou recentemente ao falar com o app:" seguido de uma linha
# EM BRANCO. O `agent.sh` grava a falha de POST como
#   `<data> [agent] POST <url> -> <corpo>` + `\n<código http>`
# e um corpo que termina em `\n` (o "no available server" do Traefik) deixa
# uma linha vazia entre o corpo e o código. O recorte `tail -2 | head -1`
# caía exatamente nela.
#
# Nada aqui encosta na máquina: `docker` e `crontab` são dublês, o projeto é
# um diretório temporário.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KIT_REAL="$(cd "$REPO_ROOT/hostgator-setup-kit" && pwd)"
FAILS=0

check() {  # check <descrição> <comando...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/bin"
printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/bin/docker"
# O agente está no cron: é o ramo que lê o .update-agent.log.
printf '#!/usr/bin/env bash\necho "*/5 * * * * cd /x && bash hostgator-setup-kit/agent.sh >/dev/null 2>&1"\n' \
  > "$WORK/bin/crontab"
chmod +x "$WORK/bin/docker" "$WORK/bin/crontab"

PROJ="$WORK/projeto"
mkdir -p "$PROJ"
printf 'services:\n  app:\n    image: x\n' > "$PROJ/docker-compose.prod.yml"
printf 'APP_IMAGE=exemplo/deskcommcrm:1.0.0\nNEXT_PUBLIC_APP_URL=https://crm.exemplo.com.br\n' > "$PROJ/.env"
LOG="$PROJ/.update-agent.log"

# A linha logo depois do aviso — é ela que carrega a razão.
razao() {
  ( cd "$PROJ" && env -i PATH="$WORK/bin:$PATH" HOME="$WORK" bash "$KIT_REAL/healthcheck.sh" ) 2>&1 \
    | awk '/o agente falhou recentemente/{getline; print; exit}'
}
contem() { printf '%s' "$1" | grep -qF -- "$2"; }

echo "── 1. falha de POST com corpo terminado em \\n (o formato medido na VPS)"
printf '%s\n' \
  '2026-10-07T14:50:00Z [agent] POST https://crm.exemplo.com.br/api/v1/system/agent -> erro antigo' \
  '' '500' \
  '2026-10-07T14:55:00Z [agent] POST https://crm.exemplo.com.br/api/v1/system/agent -> no available server' \
  '' '503' > "$LOG"
r="$(razao)"
printf '    razão mostrada: [%s]\n' "$r"
check "a razão não sai em branco" test -n "$(printf '%s' "$r" | tr -d '[:space:]')"
check "a razão é o corpo da resposta (no available server)" contem "$r" "no available server"
check "com o código HTTP junto (503)" contem "$r" "503"
check "e é a ÚLTIMA falha, não uma antiga" bash -c '! printf "%s" "$1" | grep -qF "erro antigo"' _ "$r"

echo "── 2. timeout do curl (corpo de uma linha, código 000)"
printf '%s\n' \
  '2026-10-07T15:05:23Z [agent] POST https://crm.exemplo.com.br/api/v1/system/agent -> curl: (28) Operation timed out after 20001 milliseconds with 0 bytes received' \
  '000' > "$LOG"
r="$(razao)"
printf '    razão mostrada: [%s]\n' "$r"
check "a razão é o erro do curl" contem "$r" "Operation timed out"

echo "── 3. aviso de uma linha só (log_err sem corpo)"
printf '%s\n' \
  '2026-10-07T15:10:00Z [agent] PREV_IMAGE vazio (docker compose images -q app não devolveu nada)' > "$LOG"
r="$(razao)"
printf '    razão mostrada: [%s]\n' "$r"
check "a mensagem inteira aparece" contem "$r" "PREV_IMAGE vazio"

echo "── 4. página de erro HTML grande (proxy devolvendo KBs) não inunda o terminal"
{
  echo '2026-10-07T15:20:00Z [agent] POST https://crm.exemplo.com.br/api/v1/system/agent -> <html>'
  for i in $(seq 1 80); do echo "<p>linha $i da pagina de erro do proxy, texto de enchimento</p>"; done
  echo 'FIM-DA-PAGINA </html>'
  echo '502'
} > "$LOG"
r="$(razao)"
printf '    razão mostrada (%s caracteres): [%.80s...]\n' "${#r}" "$r"
check "a razão começa pela entrada (data e POST)" contem "$r" "2026-10-07T15:20:00Z [agent] POST"
check "a razão cabe numa linha curta (≤ 310 caracteres)" test "${#r}" -le 310
check "o fim da página não é despejado" bash -c '! printf "%s" "$1" | grep -qF "FIM-DA-PAGINA"' _ "$r"

echo "── 5. cabeçalho cortado pelo tail -n 200 do log_err (o log começa no meio do corpo)"
printf '%s\n' 'resto de um corpo cujo cabeçalho saiu do log' '' '502' > "$LOG"
r="$(razao)"
printf '    razão mostrada: [%s]\n' "$r"
check "a razão aparece" contem "$r" "resto de um corpo"
check "sem espaço sobrando na frente (só o recuo de 2)" bash -c '! printf "%s" "$1" | grep -q "^   "' _ "$r"

echo
if [ "$FAILS" -eq 0 ]; then echo "ok — todas as verificações passaram"; else echo "FALHOU: $FAILS verificação(ões)"; exit 1; fi
