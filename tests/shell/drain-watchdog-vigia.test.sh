#!/usr/bin/env bash
# ── O DRENO DE EVENTOS: UM DRENO, UM VIGIA (#2235) ───────────────────────────
#
#   bash tests/shell/drain-watchdog-vigia.test.sh
#
# O que este teste mede, e por quê:
#
# 1. A linha do crontab do host deixou de ser um SEGUNDO DRENO. No kit, o
#    contêiner `scheduler` já bate em `/api/v1/cron/event-log-drain` a cada
#    minuto (`docker/scheduler/entrypoint.sh`). A linha do host era a mesma
#    chamada no mesmo minuto, e a issue #2235 mediu o custo disso: ~62% das
#    chamadas `service_role` ao PostgREST na `event_log`, com ninguém usando o
#    sistema. Agora ela roda de 15 em 15 minutos e só dispara o dreno quando o
#    `scheduler` não está de pé.
#
# 2. A FUNÇÃO NÃO SE PERDE. Se o `scheduler` cair, o dreno continua chegando
#    pelo host — com atraso, mas chega. E se o próprio `docker` não responder
#    (socket sem permissão, binário ausente), a regra é ABERTA: o vigia roda o
#    dreno, porque "não sei" não pode virar "não dreno" em silêncio.
#
# 3. Re-rodar install/update não empilha linhas (o `cron_merge` continua
#    idempotente com o marcador e com a assinatura legada da URL).
#
# O arquivo REAL é carregado (`_common.sh` e `drain-watchdog.sh`), com dublês de
# `crontab`, `docker` e `curl`: um teste que só procurasse `*/15` no texto
# passaria com a linha no lugar errado.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() { if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi; }

mkdir -p "$WORK/bin" "$WORK/instalacao/hostgator-setup-kit"

# ── Dublê de `crontab`: guarda o que foi escrito, como o cron de verdade ─────
cat > "$WORK/bin/crontab" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = "-l" ]; then
  [ -f "$CRONTAB_ESCRITO" ] || { echo "no crontab for root" >&2; exit 1; }
  cat "$CRONTAB_ESCRITO"
  exit 0
fi
cat > "$CRONTAB_ESCRITO"
exit 0
STUB
chmod +x "$WORK/bin/crontab"

# ── Dublê de `docker`: só responde ao `ps -q` do filtro do scheduler ─────────
# `DOCKER_SAIDA` é o que ele imprime; vazio = nenhum scheduler rodando.
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
[ "${DOCKER_FALHA:-0}" = "1" ] && exit 1
printf '%s' "${DOCKER_SAIDA:-}"
exit 0
STUB
chmod +x "$WORK/bin/docker"

# ── Dublê de `curl`: registra a chamada em vez de falar com a rede ───────────
cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CURL_CHAMADAS"
exit 0
STUB
chmod +x "$WORK/bin/curl"

export CRONTAB_ESCRITO="$WORK/crontab.txt"
export CURL_CHAMADAS="$WORK/curl.txt"
export PATH="$WORK/bin:$PATH"

# ── 1. O que o instalador grava ──────────────────────────────────────────────
gravar_cron() {
  cat > "$WORK/roteiro.sh" <<ROTEIRO
set -euo pipefail
export PATH="$WORK/bin:\$PATH"
export CRONTAB_ESCRITO="$CRONTAB_ESCRITO"
export INTERNAL_SECRET="segredo-de-teste"
export NEXT_PUBLIC_APP_URL="https://exemplo.invalido"
export PROJECT_DIR="$WORK/instalacao"
psql_run() { return 0; }
step() { :; }
source "$RAIZ/hostgator-setup-kit/_common.sh" >/dev/null 2>&1
setup_event_log_drain_cron >/dev/null 2>&1
ROTEIRO
  bash "$WORK/roteiro.sh" 2>/dev/null
}

echo "dreno de eventos: um dreno, um vigia:"
rm -f "$CRONTAB_ESCRITO"
gravar_cron
LINHA="$(cat "$CRONTAB_ESCRITO" 2>/dev/null || true)"

linha_e_vigia() { printf '%s' "$LINHA" | grep -q 'drain-watchdog\.sh'; }
linha_cada_15() { printf '%s' "$LINHA" | grep -q '^\*/15 \* \* \* \* '; }
nao_e_cada_minuto() { ! printf '%s' "$LINHA" | grep -q '^\* \* \* \* \* .*event-log-drain'; }
leva_projeto() { printf '%s' "$LINHA" | grep -q "$WORK/instalacao"; }
uma_linha_so() { [ "$(printf '%s\n' "$LINHA" | grep -c 'event-log-drain')" = "1" ]; }

check "a linha do host aponta para o vigia" linha_e_vigia
check "a cadência é de 15 em 15 minutos" linha_cada_15
check "não existe mais um segundo dreno de minuto a minuto" nao_e_cada_minuto
check "o vigia recebe o diretório da instalação" leva_projeto
check "há exatamente UMA linha do dreno no crontab" uma_linha_so

# Re-rodar (install/update) não empilha.
gravar_cron
LINHA="$(cat "$CRONTAB_ESCRITO" 2>/dev/null || true)"
check "re-rodar o instalador não empilha a linha" uma_linha_so

# ── 2. O que o vigia faz ─────────────────────────────────────────────────────
VIGIA="$RAIZ/hostgator-setup-kit/drain-watchdog.sh"
URL="https://exemplo.invalido/api/v1/cron/event-log-drain"
CABECALHO="$WORK/header"
printf 'Authorization: Bearer segredo\n' > "$CABECALHO"

rodar_vigia() {  # rodar_vigia <comando...> — o vigia com os argumentos desta instalação
  rm -f "$CURL_CHAMADAS"
  ( "$@" >/dev/null 2>&1 )
}

curl_chamado() { [ -f "$CURL_CHAMADAS" ] && grep -q 'event-log-drain' "$CURL_CHAMADAS"; }
curl_silencioso() { [ ! -s "$CURL_CHAMADAS" ]; }
curl_com_segredo() { grep -q "@$CABECALHO" "$CURL_CHAMADAS"; }

rodar_vigia env DOCKER_SAIDA="abc123" "$VIGIA" "$URL" "$CABECALHO" "deskcommcrm"
check "scheduler de pé: o vigia NÃO dispara o dreno" curl_silencioso

rodar_vigia env DOCKER_SAIDA="" "$VIGIA" "$URL" "$CABECALHO" "deskcommcrm"
check "scheduler fora do ar: o vigia dispara o dreno" curl_chamado
check "o dreno vai com o cabeçalho do segredo (@arquivo)" curl_com_segredo

rodar_vigia env DOCKER_FALHA=1 "$VIGIA" "$URL" "$CABECALHO" "deskcommcrm"
check "docker que falha: a regra é ABERTA, o dreno roda" curl_chamado

# Sem nome de projeto (instalação anterior a este formato): o filtro por rótulo
# não tem como ser aplicado, e o vigia cai na regra ABERTA — roda o dreno.
rodar_vigia env DOCKER_SAIDA="abc123" "$VIGIA" "$URL" "$CABECALHO" ""
check "sem nome de projeto: a regra é ABERTA, o dreno roda" curl_chamado

# Sem URL/segredo, ele recusa — não dispara um dreno sem autenticação.
rm -f "$CURL_CHAMADAS"
( "$VIGIA" "" "$CABECALHO" "deskcommcrm" >/dev/null 2>&1 )
check "sem URL: o vigia recusa (rc≠0) em vez de vetar em silêncio" [ "$?" -ne 0 ]

if [ "$FAILS" -gt 0 ]; then printf '\n%d falha(s)\n' "$FAILS"; exit 1; fi
printf '\ntudo verde\n'
