#!/usr/bin/env bash
# Prova a rede do Supabase self-hosted no mesmo host (SUPABASE_DOCKER_NETWORK).
#
#   bash tests/shell/rede-supabase-self-hosted.test.sh
#
# Problema: com o Supabase em outro compose no mesmo servidor, o SUPABASE_DB_URL
# aponta para `supabase-db`, nome que só resolve dentro da rede desse compose.
# `docker network connect` feito à mão some a cada `up -d` que recria o contêiner
# — inclusive o da atualização pela tela, que vê o worker cair e faz rollback.
#
# O que está sob prova:
#   1. Sem a variável, dc()/dc_files() não mudam (instalação existente intacta).
#   2. Com a variável e a rede existindo, dc() leva o overlay e dc_files() ensina
#      o mesmo comando.
#   3. Com a variável mas a rede inexistente, o overlay NÃO entra (uma rede
#      `external` ausente derrubaria o `up` inteiro).
#   4. O install.sh (gêmeo, roda antes do clone) anda junto com o _common.sh.
#   5. O overlay liga app, worker, scheduler e voice-agent a uma rede externa.
#   6. pg_container (psql/pg_dump do kit) usa a mesma rede quando
#      PSQL_DOCKER_NETWORK está vazia — e PSQL_DOCKER_NETWORK, quando existe, vence.
#   7. Chave declarada com a rede ausente avisa; sem a chave, silêncio.
#
# `docker` é um dublê: registra os argumentos e só reconhece a rede em REDES_OK.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KIT="$REPO_ROOT/hostgator-setup-kit"
FAILS=0

check() {  # check <descrição> <comando...>
  if "${@:2}"; then printf "  ✓ %s\n" "$1"; else printf "  ✗ %s\n" "$1"; FAILS=$((FAILS + 1)); fi
}

WORK="$(mktemp -d)"
trap "rm -rf \"$WORK\"" EXIT
mkdir -p "$WORK/bin"
cat > "$WORK/bin/docker" <<"STUB"
#!/usr/bin/env bash
printf "%s\n" "$*" >> "$DOCKER_LOG"
if [ "${1:-}" = "network" ] && [ "${2:-}" = "inspect" ]; then
  case " ${REDES_OK:-} " in *" ${3:-} "*) exit 0 ;; *) exit 1 ;; esac
fi
exit 0
STUB
chmod +x "$WORK/bin/docker"
DOCKER_LOG="$WORK/docker.log"

roda_kit() {  # roda_kit <ENV=valor...> -- <comando>   (a partir da raiz do repositório)
  local -a envs=()
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done
  shift
  : > "$DOCKER_LOG"
  ( cd "$REPO_ROOT" && env -i PATH="$WORK/bin:$PATH" HOME="$HOME" DOCKER_LOG="$DOCKER_LOG" \
      ${envs[@]+"${envs[@]}"} bash -c ". \"$KIT/_common.sh\"; $1" ) 2>&1
}

echo "── 1. Sem a variável: nada muda"
roda_kit -- "dc ps" >/dev/null
check "dc não recebe o overlay da rede" bash -c "! grep -q docker-compose.supabase-rede.yml \"$DOCKER_LOG\""
check "e nem consulta a rede" bash -c "! grep -q \"network inspect\" \"$DOCKER_LOG\""
check "dc_files não inventa o overlay" \
  bash -c "! printf %s \"\$1\" | grep -q supabase-rede" _ "$(roda_kit -- dc_files)"

echo "── 2. Variável + rede existente: o overlay entra"
roda_kit SUPABASE_DOCKER_NETWORK=supabase_default REDES_OK=supabase_default -- "dc ps" >/dev/null
check "dc recebe -f docker-compose.supabase-rede.yml" grep -q -- "-f docker-compose.supabase-rede.yml" "$DOCKER_LOG"
check "consulta a rede pelo nome declarado" grep -q "network inspect supabase_default" "$DOCKER_LOG"
check "dc_files ensina o MESMO comando que dc roda" \
  bash -c "printf %s \"\$1\" | grep -q -- \"-f docker-compose.supabase-rede.yml\"" _ \
  "$(roda_kit SUPABASE_DOCKER_NETWORK=supabase_default REDES_OK=supabase_default -- dc_files)"

echo "── 3. Variável + rede inexistente: o overlay NÃO entra"
roda_kit SUPABASE_DOCKER_NETWORK=outra REDES_OK=supabase_default -- "dc ps" >/dev/null
check "dc não recebe o overlay (rede external ausente derrubaria o up)" \
  bash -c "! grep -q docker-compose.supabase-rede.yml \"$DOCKER_LOG\""
check "dc_files também não" \
  bash -c "! printf %s \"\$1\" | grep -q supabase-rede" _ \
  "$(roda_kit SUPABASE_DOCKER_NETWORK=outra REDES_OK=supabase_default -- dc_files)"

echo "── 4. install.sh (gêmeo) anda junto"
check "install.sh define rede_do_supabase_ok" grep -q "^rede_do_supabase_ok()" "$KIT/install.sh"
check "install.sh leva o overlay em dc()" grep -q "ca+=(-f docker-compose.supabase-rede.yml)" "$KIT/install.sh"
check "install.sh leva o overlay em dc_files()" grep -q "supabase-rede.yml\"$" "$KIT/install.sh"

echo "── 5. docker-compose.supabase-rede.yml"
OVERLAY="$REPO_ROOT/docker-compose.supabase-rede.yml"
check "o arquivo existe na raiz" test -f "$OVERLAY"
for svc in app worker scheduler voice-agent; do
  check "liga o serviço $svc" grep -q "^  $svc:" "$OVERLAY"
done
check "a rede é externa" grep -q "external: true" "$OVERLAY"
check "o nome vem da variável" grep -q "name: \${SUPABASE_DOCKER_NETWORK}" "$OVERLAY"

echo "── 6. pg_container: a rede do Supabase serve também ao psql do kit"
roda_kit SUPABASE_DOCKER_NETWORK=supabase_default REDES_OK=supabase_default -- "pg_container img true" >/dev/null
check "sem PSQL_DOCKER_NETWORK, o psql efêmero entra na rede do Supabase" \
  grep -q -- "^run --rm --network supabase_default img true" "$DOCKER_LOG"
roda_kit SUPABASE_DOCKER_NETWORK=supabase_default REDES_OK=supabase_default PSQL_DOCKER_NETWORK=outra_rede -- "pg_container img true" >/dev/null
check "PSQL_DOCKER_NETWORK declarada vence" grep -q -- "^run --rm --network outra_rede img true" "$DOCKER_LOG"
roda_kit SUPABASE_DOCKER_NETWORK=outra REDES_OK=supabase_default -- "pg_container img true" >/dev/null
check "rede ausente: o psql roda sem --network (como antes)" grep -q -- "^run --rm img true" "$DOCKER_LOG"
roda_kit -- "pg_container img true" >/dev/null
check "sem nenhuma chave: sem --network" grep -q -- "^run --rm img true" "$DOCKER_LOG"
check "install.sh (gêmeo) também cai para a rede do Supabase" \
  grep -qF 'elif rede_do_supabase_ok; then rede=(--network "$SUPABASE_DOCKER_NETWORK")' "$KIT/install.sh"

echo "── 7. Chave declarada, rede ausente: o kit avisa"
saida="$(roda_kit SUPABASE_DOCKER_NETWORK=outra REDES_OK=supabase_default -- aviso_rede_do_supabase)"
check "avisa nomeando a chave e a rede" \
  bash -c "printf %s \"\$1\" | grep -q 'SUPABASE_DOCKER_NETWORK=outra'" _ "$saida"
check "rede existente: sem aviso" test -z \
  "$(roda_kit SUPABASE_DOCKER_NETWORK=supabase_default REDES_OK=supabase_default -- aviso_rede_do_supabase)"
check "sem a chave: sem aviso" test -z "$(roda_kit -- aviso_rede_do_supabase)"
check "update.sh chama o aviso logo depois de entrar no projeto" \
  grep -qx "aviso_rede_do_supabase" "$KIT/update.sh"

echo
if [ "$FAILS" -eq 0 ]; then echo "OK — todas as provas passaram."; else echo "FALHOU — $FAILS prova(s)."; fi
exit $((FAILS > 0))
