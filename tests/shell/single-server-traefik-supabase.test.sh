#!/usr/bin/env bash
# #2099, parte 3 — a rota do Supabase no Traefik PRÓPRIO, em instalação
# single-server.
#
# O QUE ESTÁ SOB PROVA: com `REVERSE_PROXY=traefik` exportado, o
# install-single-server.sh liga, NO `.env` do Supabase, a chave que faz o
# override entregar ao Envoy as etiquetas de rota do Traefik — e o override
# traz essas etiquetas, com as MESMAS seis prefixos do Caddyfile.single-server.
# Sem as duas pontas o Traefik entrega /auth/v1* ao app (404) e a fase 2 do
# install.sh morre em "NEXT_PUBLIC_SUPABASE_ANON_KEY inválido".
#
# O CAMINHO é o instalador INTEIRO, com dublê de `docker` no PATH e
# `install.sh` trocado por um registrador: nada sobe, nada é baixado, e o
# `.env` que sai é o do instalador de verdade. A interpolação do Compose é
# provada onde existe `docker compose` (DOCKER_REAL); sem ele o bloco é pulado,
# como nos outros testes do modo single-server.
#
#   bash tests/shell/single-server-traefik-supabase.test.sh

set -uo pipefail
unset COMPOSE_PROJECT_NAME SINGLE_SERVER REVERSE_PROXY PSQL_DOCKER_NETWORK \
  TRAEFIK_ENABLE TRAEFIK_HOST TRAEFIK_ENTRYPOINT TRAEFIK_CERTRESOLVER

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
KIT="$ROOT_DIR/hostgator-setup-kit"
OVERRIDE="$KIT/supabase-single-server.override.yml"
INSTALADOR="$KIT/install-single-server.sh"
CADDYFILE="$ROOT_DIR/Caddyfile.single-server"
TRAEFIK_YML="$ROOT_DIR/docker-compose.traefik.yml"
DOMINIO="crm.exemplo.com.br"
FAILS=0

check() {
  local descricao="$1"
  shift
  if "$@"; then
    printf '  ✓ %s\n' "$descricao"
  else
    printf '  ✗ %s\n' "$descricao"
    FAILS=$((FAILS + 1))
  fi
}
igual() { [ "$1" = "$2" ] || { printf '    esperado [%s], veio [%s]\n' "$2" "$1"; return 1; }; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── Dublês ──────────────────────────────────────────────────────────────────
# `docker`: sem ele o instalador morre na porta de entrada, e com ele ele não
# toca em contêiner nenhum.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/docker" <<'DUBLO'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${DOCKER_LOG:-/dev/null}"
exit 0
DUBLO
chmod +x "$WORK/bin/docker"

# `install.sh`: o passo canônico é outro teste. Aqui ele só prova que foi
# chamado — o que está sob prova é o que o instalador de single-server grava.
instalador_canonico_dublo() {  # instalador_canonico_dublo <árvore>
  cat > "$1/hostgator-setup-kit/install.sh" <<'DUBLO'
#!/usr/bin/env bash
printf 'chamado\n' >> "${INSTALL_SH_LOG:-/dev/null}"
exit 0
DUBLO
  chmod +x "$1/hostgator-setup-kit/install.sh"
}

# ── A árvore falsa: o que o instalador encontra numa VPS recém-criada ───────
montar_arvore() {  # montar_arvore <árvore>
  local raiz="$1"
  mkdir -p "$raiz/hostgator-setup-kit" "$raiz/.runtime/supabase"
  cp "$KIT"/*.sh "$raiz/hostgator-setup-kit/"
  cp "$OVERRIDE" "$raiz/hostgator-setup-kit/"
  instalador_canonico_dublo "$raiz"
  {
    printf 'ANON_KEY=anon_de_teste\n'
    printf 'SERVICE_ROLE_KEY=service_de_teste\n'
    printf 'POSTGRES_PASSWORD=senha_de_teste\n'
    printf 'API_GW_HTTP_PORT=8000\n'
    printf 'DISABLE_SIGNUP=false\n'
  } > "$raiz/.runtime/supabase/.env"
  chmod 600 "$raiz/.runtime/supabase/.env"
}

rodar_instalador() {  # rodar_instalador <árvore> [<CHAVE>=<valor> ...] (exportadas)
  local raiz="$1"; shift
  env PATH="$WORK/bin:$PATH" SINGLE_SERVER_ALLOW_LOW_MEMORY=1 DOCKER_LOG="$WORK/docker.log" \
    INSTALL_SH_LOG="$WORK/install-sh.log" "$@" \
    bash "$raiz/hostgator-setup-kit/install-single-server.sh" --domain "$DOMINIO" \
    > "$WORK/saida.log" 2>&1
}

ARVORE="$WORK/traefik";   montar_arvore "$ARVORE"
CONTROLE="$WORK/caddy";   montar_arvore "$CONTROLE"
OUTROS="$WORK/proprio";   montar_arvore "$OUTROS"

echo "rota do Supabase no Traefik do single-server (#2099)"

# Os blocos (1)-(3) e (5) rodam o instalador INTEIRO, que lê a RAM em
# /proc/meminfo antes de qualquer outra coisa. Onde ele não existe (macOS), os
# blocos são pulados — como o (7), sem `docker compose` —; no Linux/CI rodam.
SEM_MEMINFO_MSG='  - pulado: sem /proc/meminfo (o instalador lê a RAM de lá; roda no Linux/CI)'
if [ -r /proc/meminfo ]; then

# ════════════════════════════════════════════════════════════════════════════
# (1) O que o instalador GRAVA no .env do Supabase
# ════════════════════════════════════════════════════════════════════════════
check "instalador com REVERSE_PROXY=traefik roda até o fim" \
  rodar_instalador "$ARVORE" REVERSE_PROXY=traefik
ENV_T="$ARVORE/.runtime/supabase/.env"
check "grava a chave que liga a rota no Envoy" \
  grep -qxF 'TRAEFIK_ENABLE=true' "$ENV_T"
check "grava o Host da regra com o domínio pedido (não um placeholder)" \
  grep -qxF "TRAEFIK_HOST=$DOMINIO" "$ENV_T"
check "entrypoint e certresolver nascem nos mesmos defaults do overlay do app" \
  bash -c 'grep -qxF "TRAEFIK_ENTRYPOINT=websecure" "$1" && grep -qxF "TRAEFIK_CERTRESOLVER=letsencrypt" "$1"' _ "$ENV_T"
check "cada chave aparece exatamente uma vez" \
  bash -c '[ "$(grep -c "^TRAEFIK_ENABLE=" "$1")" = 1 ] && [ "$(grep -c "^TRAEFIK_HOST=" "$1")" = 1 ]' _ "$ENV_T"

# (2) Entrypoint/certresolver fora do padrão vêm do ambiente de quem instala
#     (o install.sh descobre os dele DEPOIS desta subida).
check "entrypoint e certresolver próprios são propagados" \
  rodar_instalador "$OUTROS" REVERSE_PROXY=traefik TRAEFIK_ENTRYPOINT=http TRAEFIK_CERTRESOLVER=meu-resolver
check "o entrypoint próprio chega ao .env do Supabase" \
  grep -qxF 'TRAEFIK_ENTRYPOINT=http' "$OUTROS/.runtime/supabase/.env"
check "o certresolver próprio chega ao .env do Supabase" \
  grep -qxF 'TRAEFIK_CERTRESOLVER=meu-resolver' "$OUTROS/.runtime/supabase/.env"

# (3) CASO DE CONTROLE: sem a variável, o padrão é o de hoje (Caddy) e a rota
#     nasce DESLIGADA — um Traefik que por acaso exista na VPS não passa a
#     publicar o Envoy de uma instalação que escolheu o Caddy.
check "instalador sem REVERSE_PROXY (padrão) roda até o fim" \
  rodar_instalador "$CONTROLE"
ENV_C="$CONTROLE/.runtime/supabase/.env"
check "controle: padrão grava TRAEFIK_ENABLE=false (rota desligada)" \
  grep -qxF 'TRAEFIK_ENABLE=false' "$ENV_C"
check "controle: no modo Caddy não nasce Host nem entrypoint de Traefik" \
  bash -c '! grep -q "^TRAEFIK_HOST=" "$1" && ! grep -q "^TRAEFIK_ENTRYPOINT=" "$1"' _ "$ENV_C"
check "controle: REVERSE_PROXY gravado no .env do CRM segue sendo caddy" \
  grep -qxF 'REVERSE_PROXY=caddy' "$CONTROLE/.env"
else
  echo "$SEM_MEMINFO_MSG"
fi

# (4) A gravação é ANTES do `dc_supabase up -d --wait`: no primeiro boot o
#     Envoy já nasce com a rota, e numa re-execução o compose o recria porque
#     o label mudou.
linha_gravacao="$(grep -n '^[[:space:]]*set_env_var "\$supabase_env" TRAEFIK_ENABLE ' "$INSTALADOR" | head -1 | cut -d: -f1)"
linha_boot="$(grep -nE '^[[:space:]]*dc_supabase up -d --wait' "$INSTALADOR" | head -1 | cut -d: -f1)"
check "chave gravada antes de o Supabase subir" \
  test -n "$linha_gravacao" -a -n "$linha_boot" -a "$linha_gravacao" -lt "$linha_boot"

# (5) Re-execução: idempotente, e uma árvore que já foi Traefik e volta para o
#     Caddy tem a rota desligada (não sobra um `true` órfão).
if [ -r /proc/meminfo ]; then
check "segunda execução em modo traefik termina sem erro" \
  rodar_instalador "$ARVORE" REVERSE_PROXY=traefik
check "segunda execução mantém uma linha por chave" \
  bash -c '[ "$(grep -c "^TRAEFIK_ENABLE=" "$1")" = 1 ] && grep -qxF TRAEFIK_ENABLE=true "$1"' _ "$ENV_T"
else
  echo "$SEM_MEMINFO_MSG"
fi

# ════════════════════════════════════════════════════════════════════════════
# (6) O override: as etiquetas, com paridade EXATA com o Caddyfile
# ════════════════════════════════════════════════════════════════════════════
echo "etiquetas do override vs Caddyfile.single-server"
check "a rota nasce desligada (chave interpolável, não um true fixo)" \
  grep -qF 'traefik.enable: "${TRAEFIK_ENABLE:-false}"' "$OVERRIDE"
check "a rede usada é a ponte privada desta instalação (o Envoy já está nela)" \
  grep -qF 'traefik.docker.network: "${SINGLE_SERVER_NETWORK:-deskcomm_single_server}"' "$OVERRIDE"
check "entrypoint/certresolver usam os mesmos defaults do docker-compose.traefik.yml" \
  bash -c 'grep -qF "traefik.http.routers.deskcomm-supabase.entrypoints: \"\${TRAEFIK_ENTRYPOINT:-websecure}\"" "$1" && grep -qF "traefik.http.routers.deskcomm-supabase.tls.certresolver: \"\${TRAEFIK_CERTRESOLVER:-letsencrypt}\"" "$1"' _ "$OVERRIDE"
check "o serviço aponta para a porta do Envoy (8000)" \
  grep -qF 'traefik.http.services.deskcomm-supabase.loadbalancer.server.port: "8000"' "$OVERRIDE"
check "prioridade 500: acima da rota geral do app e abaixo do bloqueio 1000 do WAHA" \
  bash -c 'grep -qF "deskcomm-supabase.priority: \"500\"" "$1" && grep -qF "deskcomm-waha-block.priority: \"1000\"" "$2"' _ "$OVERRIDE" "$TRAEFIK_YML"
check "gzip do Caddyfile acompanha a rota do Supabase" \
  grep -qF 'deskcomm-supabase-compress.compress: "true"' "$OVERRIDE"

# As seis prefixos do Caddyfile — a REFERÊNCIA do modo Caddy —, uma a uma.
prefixos="$(grep -E '^[[:space:]]*@supabase path ' "$CADDYFILE" | head -1 | sed 's/^[[:space:]]*@supabase path //' | tr ' ' '\n' | sed 's/\*$//' | tr '\n' ' ')"
check "o Caddyfile tem as seis prefixos para ler" igual "$(printf '%s' "$prefixos" | wc -w | tr -d ' ')" 6
for p in $prefixos; do
  check "overlay roteia $p (paridade com o Caddyfile)" grep -qF "PathPrefix(\`$p\`)" "$OVERRIDE"
done
n_rotas="$(grep -o 'PathPrefix(`' "$OVERRIDE" | wc -l | tr -d ' ')"
check "nenhuma prefixo extra no overlay (6 rotas, como o Caddyfile)" igual "$n_rotas" 6
check "a regra casa com o Host do domínio (não publica os outros tenants da VPS)" \
  grep -qF 'Host(`${TRAEFIK_HOST:-}`) &&' "$OVERRIDE"
check "o override NÃO declara rede externa nova (derrubaria a instalação em Caddy)" \
  bash -c 'test "$(sed -n "/^networks:/,\$p" "$1" | grep -cE "^  [a-z_]+:")" = 1 && grep -q "^  deskcomm_private:" "$1"' _ "$OVERRIDE"

# ════════════════════════════════════════════════════════════════════════════
# (7) Interpolação do Compose de verdade (onde existe `docker compose`)
# ════════════════════════════════════════════════════════════════════════════
DOCKER_REAL="${DOCKER_REAL:-$(command -v docker 2>/dev/null || true)}"
if [ -n "$DOCKER_REAL" ] && "$DOCKER_REAL" compose version >/dev/null 2>&1; then
  echo "compose resolve as etiquetas (docker compose config)"
  CFG="$WORK/cfg"; mkdir -p "$CFG"
  {
    printf 'name: supabase\nservices:\n'
    for s in studio api-gw auth rest realtime storage imgproxy meta functions db supavisor; do
      printf '  %s:\n    image: alpine:3.20\n    container_name: supabase-%s\n' "$s" "$s"
    done
    printf '    ports:\n      - 5432:5432\n      - 6543:6543\n'
  } > "$CFG/docker-compose.yml"
  cp "$OVERRIDE" "$CFG/docker-compose.deskcomm.yml"

  etiquetas() {  # etiquetas [<linha extra do .env>] → JSON das labels do api-gw
    printf '%s\n' 'COMPOSE_FILE=docker-compose.yml:docker-compose.deskcomm.yml' \
      'COMPOSE_PROJECT_NAME=deskcommcrm-supabase' \
      'SINGLE_SERVER_NETWORK=deskcommcrm_supabase' "$@" > "$CFG/.env"
    (cd "$CFG" && env -i PATH="$PATH" HOME="$HOME" "$DOCKER_REAL" compose config --format json 2>/dev/null) \
      | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["services"]["api-gw"]["labels"]))'
  }

  # Com a chave ligada: o que o Traefik vai ler no contêiner.
  ligadas="$(etiquetas "TRAEFIK_ENABLE=true" "TRAEFIK_HOST=$DOMINIO")"; rc=$?
  check "compose aceita o override" test "$rc" -eq 0
  check "com TRAEFIK_ENABLE=true o Traefik enxerga o Envoy" \
    igual "$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["traefik.enable"])' "$ligadas")" true
  check "a regra interpolada casa com o domínio da instalação" \
    bash -c 'python3 -c "import json,sys; print(json.loads(sys.argv[1])[\"traefik.http.routers.deskcomm-supabase.rule\"])" "$1" | grep -qF "Host(\`crm.exemplo.com.br\`)"' _ "$ligadas"
  check "as seis prefixos sobrevivem à interpolação" \
    bash -c 'python3 -c "import json,sys; print(json.loads(sys.argv[1])[\"traefik.http.routers.deskcomm-supabase.rule\"])" "$1" | grep -qF "PathPrefix(\`/graphql/v1\`)"' _ "$ligadas"
  check "a rede interpolada é a desta instalação" \
    igual "$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["traefik.docker.network"])' "$ligadas")" deskcommcrm_supabase

  # Sem a chave (instalação em Caddy): a mesma etiqueta nasce `false`.
  desligadas="$(etiquetas)" ; rc=$?
  check "sem TRAEFIK_ENABLE o compose continua aceitando o override" test "$rc" -eq 0
  check "sem TRAEFIK_ENABLE a rota nasce desligada (false, não true)" \
    igual "$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["traefik.enable"])' "$desligadas")" false
else
  echo "  - pulado: docker compose ausente (a prova da interpolação roda onde ele existe)"
fi

if [[ "$FAILS" -ne 0 ]]; then
  printf '\n%d teste(s) falharam.\n' "$FAILS"
  printf -- '--- saída do instalador (últimas 20 linhas) ---\n'
  tail -20 "$WORK/saida.log" 2>/dev/null || true
  exit 1
fi

printf '\nTodos os testes da rota do Supabase no Traefik passaram.\n'
