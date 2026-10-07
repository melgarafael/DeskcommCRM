#!/usr/bin/env bash
# #2099 — instalação single-server atrás de um proxy reverso PRÓPIO (Traefik ou
# Nginx Proxy Manager) já ocupando as portas 80/443 — a topologia que o
# `unico_traefik()` do kit documenta (Traefik em `--network host`, Hostinger).
#
# Dois defeitos, dois blocos aqui:
#
#   1. install-single-server.sh gravava `REVERSE_PROXY=caddy` fixo, sobrepondo
#      o `REVERSE_PROXY=traefik` exportado no ambiente de quem chama o
#      instalador — a escolha sumia do .env gravado.
#   2. `dc()` e `dc_files()` do _common.sh retornavam ANTES do seletor de proxy
#      quando SINGLE_SERVER=1, então o `docker-compose.traefik.yml` (ou o npm)
#      nunca era aplicado: o Caddy do single-server subia e perdia o bind das
#      80/443 para o proxy da hospedagem.
#
#   bash tests/shell/single-server-traefik.test.sh
#
# Nada aqui toca a máquina de quem roda: o `docker` é um dublê que só registra
# o comando que recebeu, e a linha do instalador é executada num .env
# descartável em $WORK. Sem Docker, sem rede, sem suíte.
set -uo pipefail
unset COMPOSE_PROJECT_NAME SINGLE_SERVER REVERSE_PROXY PSQL_DOCKER_NETWORK

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KIT_DIR="$ROOT/hostgator-setup-kit"
INSTALLER="$KIT_DIR/install-single-server.sh"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() {  # check <descrição> <comando...>
  local d="$1"; shift
  if "$@"; then printf '  ✓ %s\n' "$d"; else printf '  ✗ %s\n' "$d"; FAILS=$((FAILS + 1)); fi
}
igual() { [ "$1" = "$2" ] || { printf '    esperado [%s], veio [%s]\n' "$2" "$1"; return 1; }; }
tem() { case "$1" in *"$2"*) return 0 ;; *) printf '    [%s] não está em [%s]\n' "$2" "$1"; return 1 ;; esac; }

# ── Dublê de docker: registra o comando, nunca sobe nada ─────────────────────
export DUBLE_LOG="$WORK/docker.log"
mkdir -p "$WORK/bin"
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${DUBLE_LOG:?}"
exit 0
STUB
chmod +x "$WORK/bin/docker"
PATH="$WORK/bin:$PATH"

# ════════════════════════════════════════════════════════════════════════════
# (1) O que o instalador GRAVA no .env — com a linha REAL do instalador.
# ════════════════════════════════════════════════════════════════════════════
# A linha é lida do install-single-server.sh e executada de verdade (com o
# set_env_var do _common.sh), num .env descartável: se o instalador voltar a
# gravar `caddy` fixo, os casos de proxy caem sozinhos.
linha_do_instalador="$(grep -E '^[[:space:]]*set_env_var "\$app_env" REVERSE_PROXY ' \
  "$INSTALLER" | head -1)"
cat > "$WORK/grava.sh" <<'GRAVA'
set -uo pipefail
. "$1"
app_env="$2"
eval "$3"
GRAVA

env_gravado() {  # env_gravado <traefik|npm|__ausente__> → a linha REVERSE_PROXY= do .env
  local dir="$WORK/env-$1-$RANDOM" escolha="$1"
  mkdir -p "$dir"; : > "$dir/.env"
  if [ "$escolha" = __ausente__ ]; then
    env -u REVERSE_PROXY bash "$WORK/grava.sh" \
      "$KIT_DIR/_common.sh" "$dir/.env" "$linha_do_instalador" >/dev/null 2>&1 || true
  else
    REVERSE_PROXY="$escolha" bash "$WORK/grava.sh" \
      "$KIT_DIR/_common.sh" "$dir/.env" "$linha_do_instalador" >/dev/null 2>&1 || true
  fi
  grep -E '^REVERSE_PROXY=' "$dir/.env" | tail -1 || printf 'LINHA_AUSENTE'
}

echo "install-single-server.sh: o .env gravado guarda a escolha do ambiente"
check "REVERSE_PROXY=traefik exportado termina gravado como traefik (não caddy)" \
  igual "$(env_gravado traefik)" 'REVERSE_PROXY=traefik'
check "REVERSE_PROXY=npm exportado termina gravado como npm" \
  igual "$(env_gravado npm)" 'REVERSE_PROXY=npm'
check "controle: sem REVERSE_PROXY no ambiente o padrão segue sendo caddy" \
  igual "$(env_gravado __ausente__)" 'REVERSE_PROXY=caddy'

# ════════════════════════════════════════════════════════════════════════════
# (2) O que dc()/dc_files() MONTAM em modo single-server
# ════════════════════════════════════════════════════════════════════════════
dc_de() {  # dc_de <single|comum> <traefik|npm|ausente> <dc|dc_files> → o comando/lista
  local modo="$1" proxy="$2" fn="$3" vars=()
  if [ "$modo" = single ]; then vars+=(SINGLE_SERVER=1); else vars+=(SINGLE_SERVER=0); fi
  [ "$proxy" = ausente ] || vars+=("REVERSE_PROXY=$proxy")
  : > "$DUBLE_LOG"
  if [ "$fn" = dc ]; then
    env "${vars[@]}" bash -c '. "$1"; dc up -d' _ "$KIT_DIR/_common.sh" >/dev/null 2>&1 || true
    head -1 "$DUBLE_LOG"
  else
    env "${vars[@]}" bash -c '. "$1"; dc_files' _ "$KIT_DIR/_common.sh" 2>/dev/null || true
  fi
}

echo "dc()/dc_files() com SINGLE_SERVER=1: o overlay do proxy entra"
check "dc single-server + traefik aplica o docker-compose.traefik.yml" \
  tem "$(dc_de single traefik dc)" '-f docker-compose.traefik.yml'
check "dc single-server + npm aplica o docker-compose.npm.yml" \
  tem "$(dc_de single npm dc)" '-f docker-compose.npm.yml'
check "dc_files single-server + traefik lista o docker-compose.traefik.yml" \
  tem "$(dc_de single traefik dc_files)" '-f docker-compose.traefik.yml'
check "controle: dc single-server sem REVERSE_PROXY é o comando de hoje" \
  igual "$(dc_de single ausente dc)" \
  'compose -f docker-compose.prod.yml -f docker-compose.single-server.yml up -d'
check "controle: dc_files single-server sem REVERSE_PROXY é a lista de hoje" \
  igual "$(dc_de single ausente dc_files)" \
  '-f docker-compose.prod.yml -f docker-compose.single-server.yml'
check "controle: no modo comum nada muda (traefik segue aplicado em dc)" \
  tem "$(dc_de comum traefik dc)" '-f docker-compose.traefik.yml'
check "controle: no modo comum nada muda (traefik segue listado em dc_files)" \
  igual "$(dc_de comum traefik dc_files)" \
  '-f docker-compose.prod.yml -f docker-compose.traefik.yml'

echo
if [[ "$FAILS" -ne 0 ]]; then
  printf '%d caso(s) reprovado(s)\n' "$FAILS"
  exit 1
fi
echo "todos os casos passaram"
