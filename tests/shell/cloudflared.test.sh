#!/usr/bin/env bash
# Cloudflare Tunnel (instalação atrás de NAT): REVERSE_PROXY=cloudflared.
#
#   bash tests/shell/cloudflared.test.sh
#
# Cobre o que o kit tem de saber e não pode envelhecer em silêncio:
#   1. dc()/dc_files() entram o docker-compose.cloudflared.yml SÓ nesse modo;
#   2. garantir_rede_do_proxy não exige rede externa (o cloudflared sobe na rede
#      interna do compose);
#   3. o install.sh exige o token, grava CLOUDFLARE_TUNNEL_TOKEN e recusa o
#      single-server; o install-single-server.sh recusa; o update.sh não recria
#      o Caddy.
#
# Nada aqui toca a máquina de quem roda: o `docker` é um dublê que só registra o
# comando, e as guardas são verificadas no TEXTO dos scripts (é wiring, não
# comportamento — o comportamento de dc() é exercitado de verdade).
set -uo pipefail
unset COMPOSE_PROJECT_NAME SINGLE_SERVER REVERSE_PROXY CLOUDFLARE_TUNNEL_TOKEN

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KIT_DIR="$ROOT/hostgator-setup-kit"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() {  # check <descrição> <comando...>
  local d="$1"; shift
  if "$@"; then printf '  ✓ %s\n' "$d"; else printf '  ✗ %s\n' "$d"; FAILS=$((FAILS + 1)); fi
}
igual() { [ "$1" = "$2" ] || { printf '    esperado [%s], veio [%s]\n' "$2" "$1"; return 1; }; }
tem() { case "$1" in *"$2"*) return 0 ;; *) printf '    [%s] não está em [%s]\n' "$2" "$1"; return 1 ;; esac; }
nao_tem() { case "$1" in *"$2"*) printf '    [%s] NÃO deveria estar em [%s]\n' "$2" "$1"; return 1 ;; *) return 0 ;; esac; }

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
# (1) O que dc()/dc_files() MONTAM no modo comum
# ════════════════════════════════════════════════════════════════════════════
dc_de() {  # dc_de <proxy> <dc|dc_files> → o comando/lista
  local proxy="$1" fn="$2" vars=()
  [ "$proxy" = ausente ] || vars+=("REVERSE_PROXY=$proxy")
  : > "$DUBLE_LOG"
  if [ "$fn" = dc ]; then
    env "${vars[@]}" bash -c '. "$1"; dc up -d' _ "$KIT_DIR/_common.sh" >/dev/null 2>&1 || true
    head -1 "$DUBLE_LOG"
  else
    env "${vars[@]}" bash -c '. "$1"; dc_files' _ "$KIT_DIR/_common.sh" 2>/dev/null || true
  fi
}

echo "dc()/dc_files(): o override do Cloudflare entra só no modo cloudflared"
check "dc cloudflared aplica o docker-compose.cloudflared.yml" \
  tem "$(dc_de cloudflared dc)" '-f docker-compose.cloudflared.yml'
check "dc_files cloudflared lista o docker-compose.cloudflared.yml" \
  tem "$(dc_de cloudflared dc_files)" '-f docker-compose.cloudflared.yml'
check "controle: dc caddy (default) NÃO aplica o override do Cloudflare" \
  nao_tem "$(dc_de caddy dc)" '-f docker-compose.cloudflared.yml'
check "controle: dc_files caddy NÃO lista o override do Cloudflare" \
  nao_tem "$(dc_de caddy dc_files)" '-f docker-compose.cloudflared.yml'
check "controle: dc traefik não confunde os overlays" \
  nao_tem "$(dc_de traefik dc_files)" '-f docker-compose.cloudflared.yml'

# A GÊMEA de install.sh — ele roda ANTES do clone, então tem cópia própria de
# dc()/dc_files(); se mexer numa sem a outra, a instalação sobe o compose errado.
# `INSTALL_SH_LIB=1` carrega só as funções (o return fica antes de qualquer efeito).
dc_install() {  # dc_install <proxy> → 1ª linha do log do dublê (o comando montado)
  : > "$DUBLE_LOG"
  PATH="$WORK/bin:$PATH" REVERSE_PROXY="$1" bash -c '
    . "$1/_common.sh"
    INSTALL_SH_LIB=1 . "$1/install.sh"
    dc up -d
  ' _ "$KIT_DIR" >/dev/null 2>&1 || true
  head -1 "$DUBLE_LOG"
}
dc_install_files() {  # dc_install_files <proxy> → a lista de -f
  PATH="$WORK/bin:$PATH" REVERSE_PROXY="$1" bash -c '
    . "$1/_common.sh"
    INSTALL_SH_LIB=1 . "$1/install.sh"
    dc_files
  ' _ "$KIT_DIR" 2>/dev/null || true
}
check "install.sh: a gêmea de dc() aplica o overlay do Cloudflare" \
  tem "$(dc_install cloudflared dc)" '-f docker-compose.cloudflared.yml'
check "install.sh: a gêmea de dc_files() lista o overlay do Cloudflare" \
  tem "$(dc_install_files cloudflared)" '-f docker-compose.cloudflared.yml'
check "install.sh: a gêmea NÃO aplica o overlay sem REVERSE_PROXY=cloudflared" \
  nao_tem "$(dc_install_files caddy)" '-f docker-compose.cloudflared.yml'

# ════════════════════════════════════════════════════════════════════════════
# (2) garantir_rede_do_proxy: cloudflared não usa rede externa
# ════════════════════════════════════════════════════════════════════════════
# Dublê que responde "rede inexistente" a qualquer inspect: se a função tentasse
# conferir uma rede externa, morreria pedindo TRAEFIK_NETWORK.
mkdir -p "$WORK/bin-eu"
cat > "$WORK/bin-eu/docker" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB
chmod +x "$WORK/bin-eu/docker"
: > "$DUBLE_LOG"
if (PATH="$WORK/bin-eu:$PATH" REVERSE_PROXY=cloudflared PROJECT_DIR="$WORK" \
      bash -c '. "$1"; garantir_rede_do_proxy' _ "$KIT_DIR/_common.sh") >/dev/null 2>&1; then
  printf '  ✓ garantir_rede_do_proxy segue sem exigir rede externa\n'
else
  printf '  ✗ garantir_rede_do_proxy morreu pedindo rede externa (cloudflared não usa nenhuma)\n'; FAILS=$((FAILS + 1))
fi

# ════════════════════════════════════════════════════════════════════════════
# (3) O wiring dos scripts: guards, token e recriação de proxy
# ════════════════════════════════════════════════════════════════════════════
echo "wiring do kit"
check "install.sh exige CLOUDFLARE_TUNNEL_TOKEN no modo cloudflared" \
  bash -c 'grep -q "REVERSE_PROXY=cloudflared exige CLOUDFLARE_TUNNEL_TOKEN" "$1"' _ "$KIT_DIR/install.sh"
check "install.sh recusa cloudflared no modo single-server" \
  bash -c 'grep -q "não é suportado no modo single-server" "$1"' _ "$KIT_DIR/install.sh"
check "install.sh grava CLOUDFLARE_TUNNEL_TOKEN no .env" \
  bash -c 'grep -qE "envq CLOUDFLARE_TUNNEL_TOKEN" "$1"' _ "$KIT_DIR/install.sh"
check "install-single-server.sh recusa cloudflared" \
  bash -c 'grep -q "não suporta REVERSE_PROXY=cloudflared" "$1"' _ "$KIT_DIR/install-single-server.sh"
check "update.sh não recria o Caddy em modo cloudflared" \
  bash -c 'grep -qE "traefik\|npm\|cloudflared\)" "$1"' _ "$KIT_DIR/update.sh"
check "_common.sh declara COMPOSE_CLOUDFLARED" \
  bash -c 'grep -q "COMPOSE_CLOUDFLARED=" "$1"' _ "$KIT_DIR/_common.sh"
check "o overlay do Cloudflare existe e desliga o Caddy por profile" \
  bash -c 'grep -q "caddy-nao-usado-com-proxy-externo" "$1"' _ "$ROOT/docker-compose.cloudflared.yml"

echo
if [[ "$FAILS" -ne 0 ]]; then
  printf '%d caso(s) reprovado(s)\n' "$FAILS"
  exit 1
fi
echo "todos os casos passaram"
