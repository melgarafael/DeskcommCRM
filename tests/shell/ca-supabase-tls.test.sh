#!/usr/bin/env bash
# Prova o caminho DECLARADO da CA do Supabase (#829): uma variável só
# (`SUPABASE_SSL_ROOT_CERT`, no .env) alimenta os três consumidores que a issue
# lista — o runtime (app/worker/scheduler), os clientes Postgres efêmeros do kit
# (`docker run postgres:17-alpine psql`) e o diagnóstico, que tem de DIZER o que
# falta em vez de devolver só `SELF_SIGNED_CERT_IN_CHAIN`.
#
#   bash tests/shell/ca-supabase-tls.test.sh
#
# Nada aqui encosta na máquina: `docker` é um dublê que só registra os argumentos
# que recebeu (é por eles que se lê o que o kit MANDARIA fazer) e devolve 0. Sem
# container, sem rede, sem arquivo fora do diretório temporário.
#
# O que está sob prova:
#   1. Sem CA declarada, `pg_container` continua como sempre foi (sem mount,
#      sem PGSSLROOTCERT) — a instalação existente não muda de comportamento.
#   2. Com a CA declarada, TODO cliente efêmero do kit recebe o arquivo montado
#      somente-leitura + PGSSLROOTCERT (libpq), com caminho absoluto.
#   3. Idempotência: duas execuções montam uma vez; a senha da connection
#      string nunca aparece no que o kit manda ao docker (sem secret em log).
#   4. CA declarada com arquivo INEXISTENTE não vira mount quebrado: a helper
#      recusa e a mensagem cita SUPABASE_SSL_ROOT_CERT e o caminho.
#   5. O diagnóstico (healthcheck.sh) sem CA explica exatamente a variável que
#      falta — é o critério da issue.
#   6. Com CA, o teste TLS do kit passa: o psql sai com sslmode=verify-full e
#      sslrootcert apontando para o arquivo montado (verificação de cadeia e de
#      hostname ligadas, não desligadas).
#   7. `dc()`/`dc_files()` levam o overlay de runtime SÓ quando a CA está pronta
#      — e a mensagem que ensina o comando bate com o que o kit roda.
#   8. O overlay entrega NODE_EXTRA_CA_CERTS + volume :ro em app, worker e
#      scheduler; o install.sh (gêmeo, roda antes do clone) anda junto.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KIT="$REPO_ROOT/hostgator-setup-kit"
FAILS=0

check() {  # check <descrição> <comando...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── Dublê de `docker`: só registra os argumentos ──────────────────────────────
mkdir -p "$WORK/bin"
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
exit 0
STUB
chmod +x "$WORK/bin/docker"
export PATH="$WORK/bin:$PATH"
DOCKER_LOG="$WORK/docker.log"
export DOCKER_LOG

# Caminho absoluto ANTES de qualquer cd — `${BASH_SOURCE[0]}` é relativo ao cwd
# de quem invocou (mesma armadilha do update-guard.test.sh).
KIT_REAL="$(cd "$KIT" && pwd)"

# Roda uma função do kit com o dublê de docker no PATH e o ambiente controlado.
# O `. _common.sh` traz `set -euo pipefail` junto: é o kit de verdade, e é ele
# quem está sob prova.
roda_kit() {  # roda_kit <variáveis NOME=valor...> -- <comando...>
  local -a vars=()
  while [ "$1" != "--" ]; do vars+=("$1"); shift; done
  shift
  : > "$DOCKER_LOG"
  ( cd "$PROJ" && env -i PATH="$PATH" HOME="$HOME" DOCKER_LOG="$DOCKER_LOG" \
      ${vars[@]+"${vars[@]}"} bash -c ". '$KIT_REAL/_common.sh'; $*" ) 2>&1
}

# ── Instalação de mentira: compose + .env + CA ───────────────────────────────
PROJ="$WORK/projeto"
mkdir -p "$PROJ"
# shellcheck disable=SC2016  # ${APP_IMAGE} é literal DENTRO do compose
printf 'services:\n  app:\n    image: ${APP_IMAGE:-x}\n  worker:\n    image: ${WORKER_IMAGE:-x}\n  scheduler:\n    image: ${SCHEDULER_IMAGE:-x}\n' \
  > "$PROJ/docker-compose.prod.yml"
cat > "$PROJ/.env" <<'ENV'
APP_IMAGE=exemplo/deskcommcrm:1.0.0
SUPABASE_DB_URL=postgresql://postgres.ref:SENHA-SUPER-SECRETA@aws-0.sa-east-1.pooler.supabase.com:5432/postgres
NEXT_PUBLIC_SUPABASE_URL=https://ref.supabase.co
ENV
chmod 600 "$PROJ/.env"
# O projeto real tem o overlay no MESMO checkout que o kit (dc() confere isso);
# o fixture cria um placeholder — o arquivo de verdade é inspecionado no caso 6.
printf 'services: {}\n' > "$PROJ/docker-compose.supabase-ca.yml"

CERTS="$WORK/certs"
mkdir -p "$CERTS"
CA="$CERTS/prod-ca-2021.crt"
printf -- '-----BEGIN CERTIFICATE-----\nMIIFakeFixtureNaoEumaCAdeVerdade\n-----END CERTIFICATE-----\n' > "$CA"

# ── 1. Sem CA declarada: nada muda ────────────────────────────────────────────
echo "── 1. Sem SUPABASE_SSL_ROOT_CERT o kit continua como sempre foi"
saida="$(roda_kit SUPABASE_SSL_ROOT_CERT= -- "pg_container postgres:17-alpine psql 'postgresql://u:***@h:5432/pg' -tAc 'select 1'")"
check "o psql efêmero sai normalmente" grep -q "run --rm postgres:17-alpine psql" "$DOCKER_LOG"
check "sem mount nenhum" bash -c "! grep -q -- ':ro' '$DOCKER_LOG'"
check "sem PGSSLROOTCERT" bash -c "! grep -q 'PGSSLROOTCERT' '$DOCKER_LOG'"
# A prova de verdade da mensagem: helper nova, ainda inexistente — é ela que
# segura o vermelho desta suíte até o fix existir.
msg="$(roda_kit SUPABASE_SSL_ROOT_CERT= -- "ca_do_supabase" 2>&1 || true)"
check "ca_do_supabase sem variável explica o que falta, com o nome da variável" \
  bash -c 'printf "%s" "$1" | grep -q SUPABASE_SSL_ROOT_CERT' _ "$msg"

# ── 2. Com CA declarada: mount :ro + PGSSLROOTCERT em TODO psql efêmero ──────
echo "── 2. Com a CA declarada, o cliente efêmero recebe o arquivo"
saida="$(roda_kit SUPABASE_SSL_ROOT_CERT="$CA" -- "pg_container postgres:17-alpine psql 'postgresql://u:***@h:5432/pg' -tAc 'select 1'")"
check "monta a CA somente-leitura no caminho fixo do contêiner" \
  grep -q -- "-v $CA:/etc/deskcomm/ca/supabase-ca.crt:ro" "$DOCKER_LOG"
check "passa PGSSLROOTCERT para o libpq" \
  grep -q -- "-e PGSSLROOTCERT=/etc/deskcomm/ca/supabase-ca.crt" "$DOCKER_LOG"
check "a ordem dos argumentos preserva o comando (psql por último)" \
  bash -c "grep -q 'psql postgresql://u:\*\*\*@h:5432/pg -tAc select 1' '$DOCKER_LOG'"
check "a senha da connection string NÃO aparece no que foi para o docker" \
  bash -c "! grep -q 'SENHA-SUPER-SECRETA' '$DOCKER_LOG'"

# Idempotência: uma segunda chamada monta UMA vez (não acumula flags).
roda_kit SUPABASE_SSL_ROOT_CERT="$CA" -- "pg_container postgres:17-alpine psql u -tAc 'select 1'" >/dev/null
check "duas execuções => um mount por execução (sem duplicação)" \
  test "$(grep -c -- ":ro" "$DOCKER_LOG")" -eq 1

# ── 3. Caminho relativo é resolvido para absoluto (o docker exige) ───────────
echo "── 3. Caminho relativo vira absoluto"
saida="$( (cd "$CERTS" && env -i PATH="$PATH" HOME="$HOME" DOCKER_LOG="$DOCKER_LOG" \
  SUPABASE_SSL_ROOT_CERT=prod-ca-2021.crt bash -c ". '$KIT_REAL/_common.sh'; ca_do_supabase" 2>&1) )"
# `env -i` descarta o PWD, e o bash recalcula o caminho FÍSICO: no macOS o
# mktemp devolve /var/..., que é symlink de /private/var/... A comparação é com
# o físico, que é o que a helper (corretamente absoluta) devolve nos dois SOs.
check "a helper devolve o caminho absoluto" test "$saida" = "$(cd "$CERTS" && pwd -P)/prod-ca-2021.crt"

# ── 4. CA declarada mas arquivo INEXISTENTE: recusa com o nome da variável ────
echo "── 4. Arquivo inexistente não vira mount quebrado"
msg="$(roda_kit SUPABASE_SSL_ROOT_CERT="$CERTS/sumiu.crt" -- "ca_do_supabase" 2>&1 || true)"
check "a recusa cita SUPABASE_SSL_ROOT_CERT" \
  bash -c 'printf "%s" "$1" | grep -q SUPABASE_SSL_ROOT_CERT' _ "$msg"
check "e cita o caminho que não existe" \
  bash -c 'printf "%s" "$1" | grep -q sumiu.crt' _ "$msg"
saida="$(roda_kit SUPABASE_SSL_ROOT_CERT="$CERTS/sumiu.crt" -- "pg_container postgres:17-alpine psql u")"
check "e o psql sai SEM mount apontando para arquivo inexistente" \
  bash -c "! grep -q 'sumiu.crt' '$DOCKER_LOG'"

# ── 5. dc()/dc_files(): o overlay de runtime entra SÓ com a CA pronta ────────
echo "── 5. Overlay de runtime (app/worker/scheduler)"
roda_kit SUPABASE_SSL_ROOT_CERT= -- "dc ps" >/dev/null
check "sem CA: docker compose não recebe o overlay" \
  bash -c "! grep -q 'docker-compose.supabase-ca.yml' '$DOCKER_LOG'"
roda_kit SUPABASE_SSL_ROOT_CERT="$CA" -- "dc ps" >/dev/null
check "com CA: docker compose recebe -f docker-compose.supabase-ca.yml" \
  grep -q -- "-f docker-compose.supabase-ca.yml" "$DOCKER_LOG"
roda_kit SUPABASE_SSL_ROOT_CERT="$CERTS/sumiu.crt" -- "dc ps" >/dev/null
check "CA quebrada: o overlay NÃO entra (o compose recusaria o bind)" \
  bash -c "! grep -q 'docker-compose.supabase-ca.yml' '$DOCKER_LOG'"
dfiles="$(roda_kit SUPABASE_SSL_ROOT_CERT="$CA" -- "dc_files")"
check "dc_files ensina o MESMO comando que dc roda" \
  bash -c 'printf "%s" "$1" | grep -q -- "-f docker-compose.supabase-ca.yml"' _ "$dfiles"
dfiles="$(roda_kit SUPABASE_SSL_ROOT_CERT= -- "dc_files")"
check "dc_files sem CA não inventa o overlay" \
  bash -c '! printf "%s" "$1" | grep -q "docker-compose.supabase-ca.yml"' _ "$dfiles"

# ── 6. O overlay existe e entrega o runtime ──────────────────────────────────
echo "── 6. docker-compose.supabase-ca.yml"
OVERLAY="$REPO_ROOT/docker-compose.supabase-ca.yml"
check "o arquivo existe na raiz (ao lado dos demais overlays)" test -f "$OVERLAY"
for svc in app worker scheduler; do
  check "declara o serviço $svc" grep -q "^  $svc:" "$OVERLAY"
done
check "NODE_EXTRA_CA_CERTS aponta para o caminho fixo dentro do contêiner" \
  grep -q "NODE_EXTRA_CA_CERTS: /etc/deskcomm/ca/supabase-ca.crt" "$OVERLAY"
check "o volume é somente-leitura" grep -q "read_only: true" "$OVERLAY"
check "a fonte do bind vem da MESMA variável declarada" \
  grep -q 'source: ${SUPABASE_SSL_ROOT_CERT}' "$OVERLAY"
check "o compose interpolate a variável do .env (sem default que esconda erro)" \
  bash -c "! grep -q 'SUPABASE_SSL_ROOT_CERT:-' '$OVERLAY'"

# ── 7. healthcheck: o diagnóstico irmão ──────────────────────────────────────
echo "── 7. healthcheck.sh (diagnóstico)"
roda_healthcheck() {  # roda_healthcheck → stdout+stderr
  : > "$DOCKER_LOG"
  ( cd "$PROJ" && env -i PATH="$PATH" HOME="$HOME" DOCKER_LOG="$DOCKER_LOG" "$@" \
      bash "$KIT_REAL/healthcheck.sh" ) 2>&1
}
# Sem CA no .env: é o cenário da issue — o diagnóstico tem de apontar a variável.
saida="$(roda_healthcheck)"
check "sem CA, o diagnóstico cita SUPABASE_SSL_ROOT_CERT" \
  bash -c 'printf "%s" "$1" | grep -q SUPABASE_SSL_ROOT_CERT' _ "$saida"
# A chave é OPCIONAL: sem ela, o passo informa e NÃO manda baixar CA nenhuma,
# nem em amarelo — senão toda instalação existente leria um aviso de algo de
# que não precisa. Só o trecho do passo TLS conta (os outros passos têm amarelo
# próprio, de outros motivos).
secao_tls() { printf '%s' "$1" | awk '/TLS do banco/{p=1} p'; }
saida="$(roda_healthcheck FORCE_COLOR=1)"
check "sem CA, o passo TLS não manda baixar a CA (a chave é opcional)" \
  bash -c '! printf "%s" "$1" | grep -qiE "curl|prod-ca-2021"' _ "$(secao_tls "$saida")"
check "sem CA, o passo TLS não sai em amarelo (é informação, não aviso)" \
  bash -c '! printf "%s" "$1" | grep -qF "$(printf "\033[33m")"' _ "$(secao_tls "$saida")"

# Com CA declarada NO .env (o caminho documentado): o teste TLS passa.
printf 'SUPABASE_SSL_ROOT_CERT=%s\n' "$CA" >> "$PROJ/.env"
saida="$(roda_healthcheck)"
check "com CA, o teste TLS do kit roda com sslmode=verify-full" \
  grep -q "sslmode=verify-full" "$DOCKER_LOG"
check "com sslrootcert apontando para o arquivo montado" \
  grep -q "sslrootcert=/etc/deskcomm/ca/supabase-ca.crt" "$DOCKER_LOG"
check "e a tela diz que o TLS foi verificado" \
  bash -c 'printf "%s" "$1" | grep -q "TLS do banco verificado"' _ "$saida"
check "sem ecoar a senha do banco na tela do diagnóstico" \
  bash -c '! printf "%s" "$1" | grep -q SENHA-SUPER-SECRETA' _ "$saida"
# Segundo `up`/healthcheck: mesmo argv, sem acumular mount (idempotência do overlay).
roda_healthcheck >/dev/null
check "repetir não duplica o mount" \
  test "$(grep -c -- ':ro' "$DOCKER_LOG")" -le 1
# Single-server: o banco é o Postgres local, e a CA da nuvem não se aplica —
# mesmo com a chave no .env, o passo não roda verify-full contra ele.
saida="$(roda_healthcheck SINGLE_SERVER=1)"
check "single-server: o passo TLS não testa o Postgres local com a CA da nuvem" \
  bash -c "! grep -q 'sslmode=verify-full' '$DOCKER_LOG'"
check "single-server: e diz que não se aplica" \
  bash -c 'printf "%s" "$1" | grep -q "não se aplica"' _ "$(secao_tls "$saida")"

# ── 8. install.sh (gêmeo, roda antes do clone) ───────────────────────────────
echo "── 8. install.sh acompanha _common.sh"
check "install.sh tem a helper gêmea ca_do_supabase" \
  grep -q "^ca_do_supabase()" "$KIT/install.sh"
check "a gêmea também cita SUPABASE_SSL_ROOT_CERT na recusa" \
  bash -c 'awk "/^ca_do_supabase\(\) \{/,/^\}/" "$1" | grep -q SUPABASE_SSL_ROOT_CERT' _ "$KIT/install.sh"
check "a gêmea de pg_container monta a CA como a de _common.sh" \
  bash -c 'awk "/^pg_container\(\) \{/,/^\}/" "$1" | grep -q PGSSLROOTCERT' _ "$KIT/install.sh"
check "v_db_url explica a CA quando o Postgres recusa o certificado" \
  bash -c 'awk "/^v_db_url\(\) \{/,/^\}/" "$1" | grep -q SUPABASE_SSL_ROOT_CERT' _ "$KIT/install.sh"
check "a explicação fica no ramo do erro de certificado, não em qualquer falha" \
  bash -c 'awk "/^v_db_url\(\) \{/,/^\}/" "$1" | grep -q "\[Cc\]ertificate\|\[Cc\]ertificado"' _ "$KIT/install.sh"

# O ramo de certificado do v_db_url pelo COMPORTAMENTO, não pelo texto: a
# função de verdade (extraída do install.sh) com o psql trocado por um dublê
# que devolve a saída dada. Um padrão largo como *SSL* sequestrava o
# diagnóstico de senha errada e o de queda de rede.
classifica_db_url() {  # classifica_db_url <saída do psql> → a linha 👉 escolhida
  SAIDA_PG="$1" bash -c '
    t() { printf "%s" "$1"; }
    pg_container() { printf "%s" "$SAIDA_PG"; return 1; }
    ca_do_supabase() { return 1; }
    eval "$(awk "/^v_db_url\(\) \{/,/^\}/" "$1")"
    v_db_url "postgresql://postgres.ref:x@aws-0-sa-east-1.pooler.supabase.com:5432/postgres"
  ' _ "$KIT/install.sh" | grep "👉"
}
r="$(classifica_db_url 'connection to server failed: SSL error: certificate verify failed')"
check "v_db_url: falha de verificação de certificado cai no ramo da CA" \
  bash -c 'printf "%s" "$1" | grep -q "certificado TLS"' _ "$r"
r="$(classifica_db_url 'connection to server failed: FATAL:  password authentication failed for user "postgres"
connection to server failed: FATAL:  SSL connection is required')"
check "v_db_url: senha errada citando SSL continua no ramo da SENHA" \
  bash -c 'printf "%s" "$1" | grep -q "Senha do banco errada"' _ "$r"
r="$(classifica_db_url 'connection to server failed: SSL SYSCALL error: Connection reset by peer')"
check "v_db_url: SSL SYSCALL (rede) não vira falha de certificado" \
  bash -c '! printf "%s" "$1" | grep -q "certificado TLS"' _ "$r"

# ── 9. Documentação da chave ─────────────────────────────────────────────────
echo "── 9. Documentação"
check ".env.example documenta SUPABASE_SSL_ROOT_CERT" \
  grep -q "^SUPABASE_SSL_ROOT_CERT=" "$REPO_ROOT/.env.example"
check "o doc do kit explica o caminho (README.md)" \
  grep -q "SUPABASE_SSL_ROOT_CERT" "$KIT/README.md"

echo
if [ "$FAILS" -eq 0 ]; then echo "OK — todas as provas passaram."; else echo "FALHOU — $FAILS prova(s)."; fi
exit $((FAILS > 0))
