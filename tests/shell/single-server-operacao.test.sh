#!/usr/bin/env bash
# Prova de COMPORTAMENTO do modo single-server (install-single-server.sh): o que
# o kit faz com o Supabase que ele mesmo instala — nomes que não colidem, dono
# do projeto, backup/restore dos anexos, SMTP do GoTrue e atualização da versão
# pinada. E a outra metade, que vale mais: quem já instalou no modo comum não
# muda de comportamento.
#
#   bash tests/shell/single-server-operacao.test.sh
#
# Nada aqui toca a máquina de quem roda: `docker` é um dublê que registra o que
# recebeu. Só o bloco de `docker compose config` usa o Compose de verdade (não
# precisa do daemon) e é pulado, dizendo, onde ele não existe.
set -uo pipefail
unset COMPOSE_PROJECT_NAME SINGLE_SERVER PSQL_DOCKER_NETWORK REVERSE_PROXY \
  SMTP_HOST SMTP_PORT SMTP_USERNAME SMTP_PASSWORD SMTP_FROM_EMAIL SMTP_FROM_NAME

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KIT_DIR="$ROOT/hostgator-setup-kit"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
DOCKER_REAL="$(command -v docker || true)"

FAILS=0
check() {  # check <descrição> <comando...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}
igual() { [ "$1" = "$2" ] || { printf '    esperado [%s], veio [%s]\n' "$2" "$1"; return 1; }; }
contem() { grep -qF -- "$2" "$1" || { printf '    [%s] não está em %s\n' "$2" "$1"; return 1; }; }
nao_contem() { ! grep -qF -- "$2" "$1" || { printf '    [%s] apareceu em %s\n' "$2" "$1"; return 1; }; }

# ── Dublê de docker ──────────────────────────────────────────────────────────
# O caminho do log e as bandeiras de falha vão ESCRITOS no dublê, não no
# ambiente: o kit chama o compose do Supabase com `env -i`, e é justamente isso
# que parte destes casos prova.
LOG="$WORK/docker.log"
FLAGS="$WORK/flags"
mkdir -p "$WORK/bin" "$FLAGS"
{
  printf '#!/usr/bin/env bash\nDUBLE_LOG=%q\nFLAGS=%q\n' "$LOG" "$FLAGS"
  cat <<'STUB'
printf '%s\n' "$*" >> "$DUBLE_LOG"
case " $* " in
  *" compose "*)
    printf 'COMPOSE pwd=%s projeto=%s smtp_host=%s\n' "$PWD" \
      "${COMPOSE_PROJECT_NAME-<ausente>}" "${SMTP_HOST-<ausente>}" >> "$DUBLE_LOG"
    [ -f "$FLAGS/compose-falha" ] && exit 1
    exit 0 ;;
  *" ps "*"com.docker.compose.service"*)
    case " $* " in *"label=com.docker.compose.project=${ESPERA_PROJETO:-}"*) printf '%b' "${PS_SERVICOS:-}";; esac ;;
  *" ps "*"working_dir"*) printf '%s\n' ${DONOS:-} ;;
  *" ps "*) printf '%b' "${PS_NOMES:-}" ;;
  *" run "*)
    # Só o psql do restore lê a entrada (o dump); com -c ou -f ninguém lê.
    case " $* " in *" -c "*|*" -f "*) ;; *" -i "*) cat >/dev/null ;; esac
    case " $* " in
      *platform_smtp_settings*) printf '%b' "${PSQL_SMTP:-}" ;;
      *" pg_dump "*) echo "-- dump" ;;
      *" tar czf /out/"*)
        [ "${STORAGE_FALHA:-0}" = "1" ] && case " $* " in *storage-*) exit 1;; esac
        out=""; prev=""
        for a in "$@"; do
          case "$prev" in -v) case "$a" in *:/out) out="${a%:/out}";; esac;; esac
          prev="$a"
        done
        alvo="$(printf '%s\n' "$*" | grep -oE '/out/[^ ]+' | head -1)"
        [ -n "$out" ] && : > "$out/${alvo#/out/}" ;;
    esac ;;
esac
exit 0
STUB
} > "$WORK/bin/docker"
chmod +x "$WORK/bin/docker"
PATH="$WORK/bin:$PATH"

kit() {  # kit <código bash> — roda com o _common.sh carregado, numa subshell
  bash -c 'KIT_DIR="$1"; . "$KIT_DIR/_common.sh"; shift; eval "$1"' _ "$KIT_DIR" "$@"
}

# Uma instalação single-server falsa, com o que o install-single-server.sh deixa.
PROJ="$WORK/root/DeskcommCRM"
SB="$PROJ/.runtime/supabase"
mkdir -p "$SB/volumes/storage" "$PROJ/backups"
touch "$PROJ/docker-compose.prod.yml" "$SB/docker-compose.yml"
env_sb_inicial() {
  printf '%s\n' 'COMPOSE_FILE=docker-compose.yml:docker-compose.deskcomm.yml' \
    'SMTP_HOST=supabase-mail' 'SMTP_PORT=2500' 'SMTP_PASS=fake_mail_password' > "$SB/.env"
}
env_sb_inicial
printf '%s\n' 'SINGLE_SERVER="1"' 'SUPABASE_DB_URL="postgresql://postgres:x@supabase-db:5432/postgres"' \
  'PSQL_DOCKER_NETWORK="deskcommcrm_supabase"' 'NEXT_PUBLIC_SUPABASE_URL="https://crm.exemplo.com"' > "$PROJ/.env"

# ════════════════════════════════════════════════════════════════════════════
echo "quem já instalou (modo comum) não muda:"
: > "$LOG"
kit 'pg_container postgres:17-alpine psql x -c "select 1"' >/dev/null
check "pg_container sem rede privada é o docker run --rm de antes" \
  igual "$(head -1 "$LOG")" 'run --rm postgres:17-alpine psql x -c select 1'
for proxy in caddy traefik npm; do
  arqs="$(REVERSE_PROXY="$proxy" kit 'dc_files')"
  case "$proxy" in
    caddy) esperado='-f docker-compose.prod.yml' ;;
    traefik) esperado='-f docker-compose.prod.yml -f docker-compose.traefik.yml' ;;
    npm) esperado='-f docker-compose.prod.yml -f docker-compose.npm.yml' ;;
  esac
  check "dc_files com proxy $proxy não ganhou o override do single-server" igual "$arqs" "$esperado"
done
check "pausa do banco segue achando o Supabase próprio pelos nomes de sempre" \
  igual "$(PS_NOMES='supabase-rest\nsupabase-db\nrealtime-dev.supabase-realtime\nsupabase-studio\noutro\n' \
    kit 'supabase_local_containers' | tr '\n' ' ')" 'supabase-rest realtime-dev.supabase-realtime supabase-studio '

APROJ="$WORK/root/comum/DeskcommCRM"
mkdir -p "$APROJ"; touch "$APROJ/docker-compose.prod.yml"
printf '%s\n' 'SUPABASE_DB_URL="postgresql://postgres:x@db.exemplo.supabase.co:5432/postgres"' \
  'NEXT_PUBLIC_SUPABASE_URL="https://exemplo.supabase.co"' > "$APROJ/.env"
: > "$LOG"
(cd "$APROJ" && bash "$KIT_DIR/backup.sh") >/dev/null 2>&1; rc=$?
check "backup.sh comum termina bem" test "$rc" -eq 0
check "backup.sh comum não procura Storage local" nao_contem "$LOG" 'volumes/storage'
check "backup.sh diz que conferiu o dump" \
  bash -c "cd '$APROJ' && bash '$KIT_DIR/backup.sh' 2>&1 | grep -qF '(conferido)'"

# Backup que ninguém consegue ler não é backup: um dump truncado (disco cheio,
# processo morto no meio) tem de reprovar o backup e sumir, e não sair verde.
# O `gzip` de mentira grava lixo; o `gzip -t` que confere é o de verdade.
GZIP_REAL="$(command -v gzip)"
mkdir -p "$WORK/gzip-quebrado"
{
  printf '#!/usr/bin/env bash
GZIP_REAL=%q
' "$GZIP_REAL"
  cat <<'G'
case " $* " in *" -t "*) exec "$GZIP_REAL" "$@" ;; esac
cat >/dev/null; printf 'nao-e-gzip'
G
} > "$WORK/gzip-quebrado/gzip"
chmod +x "$WORK/gzip-quebrado/gzip"
rm -f "$APROJ"/backups/db-*.sql.gz
(cd "$APROJ" && PATH="$WORK/gzip-quebrado:$PATH" bash "$KIT_DIR/backup.sh") > "$WORK/bk-corrompido.out" 2>&1; rc=$?
check "dump corrompido reprova o backup" test "$rc" -ne 0
check "e diz que o dump saiu corrompido" contem "$WORK/bk-corrompido.out" "saiu corrompido"
check "e não deixa o arquivo corrompido para ninguém confiar nele" \
  bash -c "! ls '$APROJ'/backups/db-*.sql.gz >/dev/null 2>&1"

# E quando uma etapa do pipe FALHA (o `gzip` sai ≠0, como no disco cheio): o
# `set -e` encerrava o script antes do `gzip -t`, e o arquivo cortado ficava na
# pasta — com o nome definitivo, dentro da retenção e ao alcance do restore.
mkdir -p "$WORK/gzip-falha"
{
  printf '#!/usr/bin/env bash
GZIP_REAL=%q
' "$GZIP_REAL"
  cat <<'G'
case " $* " in *" -t "*) exec "$GZIP_REAL" "$@" ;; esac
cat >/dev/null; printf 'nao-e-gzip'; exit 1
G
} > "$WORK/gzip-falha/gzip"
chmod +x "$WORK/gzip-falha/gzip"
(cd "$APROJ" && PATH="$WORK/gzip-falha:$PATH" bash "$KIT_DIR/backup.sh") > "$WORK/bk-pipe-falhou.out" 2>&1; rc=$?
check "pipe do dump que falha reprova o backup" test "$rc" -ne 0
check "e diz que o dump falhou no meio" contem "$WORK/bk-pipe-falhou.out" "falhou no meio"
check "e não deixa o arquivo cortado (nem o .parcial) na pasta" \
  bash -c "! ls '$APROJ'/backups/db-*.sql.gz >/dev/null 2>&1 && ! ls '$APROJ'/backups/.db-*.parcial >/dev/null 2>&1"
printf 'x' | gzip > "$APROJ/backups/db-20260922-030000.sql.gz"
: > "$LOG"
(cd "$APROJ" && printf 'RESTAURAR\n' | bash "$KIT_DIR/restore.sh" backups/db-20260922-030000.sql.gz) > "$WORK/rs-comum.out" 2>&1; rc=$?
check "restore.sh comum termina bem" test "$rc" -eq 0
[ "$rc" -eq 0 ] || sed 's/^/    | /' "$WORK/rs-comum.out"
check "restore.sh comum não mexe em Storage local" nao_contem "$LOG" 'volumes/storage'

# ════════════════════════════════════════════════════════════════════════════
echo "(a) nome do projeto e dono:"
check "o Supabase leva o nome do projeto do CRM" \
  igual "$(PROJECT_DIR="$PROJ" kit 'projeto_do_supabase')" 'deskcommcrm-supabase'
check "COMPOSE_PROJECT_NAME do CRM chega ao Supabase" \
  igual "$(COMPOSE_PROJECT_NAME=deskcomm-prod PROJECT_DIR="$PROJ" kit 'projeto_do_supabase')" 'deskcomm-prod-supabase'

IRMA="$WORK/root/apagar6/DeskcommCRM"
mkdir -p "$IRMA/.runtime/supabase"; touch "$IRMA/.runtime/supabase/docker-compose.yml"
guarda_sb() { DONOS="$*" PROJECT_DIR="$PROJ" kit 'recusar_supabase_de_outra_arvore' 2>&1; }
guarda_sb >/dev/null; rc=$?
check "sem Supabase no ar, a instalação assume" test "$rc" -eq 0
guarda_sb "$SB" >/dev/null; rc=$?
check "Supabase criado por ESTA árvore segue" test "$rc" -eq 0
saida="$(guarda_sb "$IRMA/.runtime/supabase")"; rc=$?
check "Supabase de OUTRA árvore viva é recusado" test "$rc" -ne 0
check "a recusa nomeia o projeto do Supabase" grep -q "deskcommcrm-supabase" <<<"$saida"
guarda_sb "$WORK/root/sumiu/.runtime/supabase" >/dev/null; rc=$?
check "árvore que já não está no disco não conta como rival" test "$rc" -eq 0

: > "$LOG"
SMTP_HOST=smtp.do-crm.com PROJECT_DIR="$PROJ" kit 'dc_supabase up -d --wait' >/dev/null
check "dc_supabase roda na pasta do Supabase" contem "$LOG" "COMPOSE pwd=$SB "
check "dc_supabase passa o projeto próprio" contem "$LOG" 'projeto=deskcommcrm-supabase'
check "dc_supabase não vaza o .env do CRM (SMTP_HOST)" contem "$LOG" 'smtp_host=<ausente>'

check "pausa do banco acha as 3 peças pelo PROJETO, nunca as de outro Supabase" \
  igual "$(SINGLE_SERVER=1 PROJECT_DIR="$PROJ" ESPERA_PROJETO=deskcommcrm-supabase \
    PS_SERVICOS='deskcommcrm-supabase-rest-1 rest\ndeskcommcrm-supabase-db-1 db\ndeskcommcrm-supabase-studio-1 studio\ndeskcommcrm-supabase-realtime-1 realtime\n' \
    PS_NOMES='supabase-rest\n' kit 'supabase_local_containers' | tr '\n' ' ')" \
  'deskcommcrm-supabase-rest-1 deskcommcrm-supabase-studio-1 deskcommcrm-supabase-realtime-1 '

if [ -n "$DOCKER_REAL" ] && "$DOCKER_REAL" compose version >/dev/null 2>&1; then
  # O compose oficial, reduzido ao que importa: `name:` fixo, container_name
  # fixo nos 11 serviços e as portas do supavisor.
  CFG="$WORK/cfg"; mkdir -p "$CFG"
  {
    printf 'name: supabase\nservices:\n'
    for s in studio api-gw auth rest realtime storage imgproxy meta functions db supavisor; do
      printf '  %s:\n    image: alpine:3.20\n    container_name: supabase-%s\n' "$s" "$s"
    done
    printf '    ports:\n      - 5432:5432\n      - 6543:6543\n'   # do supavisor, o último
  } > "$CFG/docker-compose.yml"
  cp "$KIT_DIR/supabase-single-server.override.yml" "$CFG/docker-compose.deskcomm.yml"
  printf '%s\n' 'COMPOSE_FILE=docker-compose.yml:docker-compose.deskcomm.yml' \
    'COMPOSE_PROJECT_NAME=deskcommcrm-supabase' 'SINGLE_SERVER_NETWORK=deskcommcrm_supabase' > "$CFG/.env"
  resolvido="$(cd "$CFG" && env -i PATH="$PATH" HOME="$HOME" "$DOCKER_REAL" compose config 2>&1)"; rc=$?
  check "compose aceita o override (docker compose config)" test "$rc" -eq 0
  check "o projeto é o nosso, não 'supabase'" grep -qx 'name: deskcommcrm-supabase' <<<"$resolvido"
  check "nenhum container_name fixo sobra" bash -c '! grep -q container_name <<<"$1"' _ "$resolvido"
  check "a única porta no host é a do gateway, em loopback" \
    test "$(grep -c 'published:' <<<"$resolvido")" -eq 1 -a "$(grep -c 'host_ip: 127.0.0.1' <<<"$resolvido")" -eq 1
  check "a rede privada é a desta instalação" grep -q 'name: deskcommcrm_supabase' <<<"$resolvido"
else
  echo "  - pulado: docker compose ausente (a prova do override roda onde ele existe)"
fi

echo "o CRM alcança o banco do Supabase (supabase-db):"
if [ -n "$DOCKER_REAL" ] && "$DOCKER_REAL" compose version >/dev/null 2>&1; then
  # `supabase-db` só existe como apelido na rede supabase_private. Todo serviço
  # do CRM que recebe SUPABASE_DB_URL apontando para ele precisa estar nela; do
  # contrário o nome não resolve e o serviço (o worker, motor do agente de IA)
  # reinicia em loop. O .env é o que o install-single-server.sh grava.
  CRM="$WORK/crm"; mkdir -p "$CRM"
  cp "$ROOT/docker-compose.prod.yml" "$ROOT/docker-compose.single-server.yml" "$CRM/"
  printf '%s\n' 'SUPABASE_DB_URL=postgresql://postgres:x@supabase-db:5432/postgres' \
    'DOMAIN=crm.exemplo.com' 'SINGLE_SERVER_NETWORK=deskcommcrm_supabase' > "$CRM/.env"
  sem_rede="$(cd "$CRM" && env -i PATH="$PATH" HOME="$HOME" "$DOCKER_REAL" compose \
      -f docker-compose.prod.yml -f docker-compose.single-server.yml --profile '*' config --format json 2>/dev/null \
    | python3 -c '
import json, sys
servicos = json.load(sys.stdin)["services"]
usam = [n for n, s in servicos.items() if "@supabase-db:" in (s.get("environment") or {}).get("SUPABASE_DB_URL", "")]
assert "worker" in usam, usam  # a sonda não pode passar por não achar ninguém
print(" ".join(sorted(n for n in usam if "supabase_private" not in (servicos[n].get("networks") or {}))))
' 2>&1)"; rc=$?
  check "compose do CRM resolve com todos os profiles" test "$rc" -eq 0
  check "todo serviço com SUPABASE_DB_URL=@supabase-db está na rede supabase_private" igual "$sem_rede" ''
else
  echo "  - pulado: docker compose ausente (a prova do override roda onde ele existe)"
fi

# ════════════════════════════════════════════════════════════════════════════
echo "(b) backup e restore levam os anexos:"
: > "$LOG"
(cd "$PROJ" && bash "$KIT_DIR/backup.sh") > "$WORK/bk.out" 2>&1; rc=$?
check "backup.sh single-server termina bem" test "$rc" -eq 0
check "backup.sh salva o Storage do Supabase (somente leitura)" contem "$LOG" "-v $SB/volumes/storage:/data:ro"
check "o arquivo dos anexos existe ao lado do dump" \
  bash -c 'ls "$1"/backups/storage-*.tgz >/dev/null 2>&1' _ "$PROJ"
: > "$LOG"
(cd "$PROJ" && STORAGE_FALHA=1 bash "$KIT_DIR/backup.sh") > "$WORK/bk.out" 2>&1; rc=$?
check "falha nos anexos REPROVA o backup (não sai 'concluído')" test "$rc" -ne 0
check "a falha diz que o backup está incompleto" grep -q "NÃO está completo" "$WORK/bk.out"
check "e não imprime 'backup concluído'" bash -c '! grep -q "backup concluído" "$1"' _ "$WORK/bk.out"

printf 'x' | gzip > "$PROJ/backups/db-20260922-030000.sql.gz"
: > "$PROJ/backups/storage-20260922-030000.tgz"
: > "$LOG"
(cd "$PROJ" && printf 'RESTAURAR\n' | bash "$KIT_DIR/restore.sh" backups/db-20260922-030000.sql.gz) > "$WORK/rs.out" 2>&1; rc=$?
check "restore.sh single-server termina bem" test "$rc" -eq 0
check "restore.sh devolve os anexos ao Storage" contem "$LOG" "-v $SB/volumes/storage:/data "
check "restore.sh usa o arquivo PAR do dump" contem "$LOG" 'tar xzf /in/storage-20260922-030000.tgz'
rm -f "$PROJ/backups/storage-20260922-030000.tgz"
(cd "$PROJ" && printf 'RESTAURAR\n' | bash "$KIT_DIR/restore.sh" backups/db-20260922-030000.sql.gz) > "$WORK/rs.out" 2>&1
check "sem o arquivo dos anexos, o restore DIZ que eles não voltaram" grep -q "os ANEXOS não" "$WORK/rs.out"

# ════════════════════════════════════════════════════════════════════════════
echo "(c) o GoTrue manda e-mail pelo SMTP do CRM:"
smtp() { PROJECT_DIR="$PROJ" SUPABASE_DB_URL=postgresql://x@supabase-db/postgres kit 'sincronizar_smtp_do_gotrue'; }
env_sb_inicial
PSQL_SMTP='smtp.loja.com\x1f465\x1fcontato@loja.com\x1fp$ss"w\\d\x1fnao-responda@loja.com\x1fLoja X\n' smtp; rc=$?
check "com a linha da tela /admin/email, sincroniza (rc=0)" test "$rc" -eq 0
check "SMTP_HOST vem do CRM" grep -qx 'SMTP_HOST="smtp.loja.com"' "$SB/.env"
check "a porta vem do CRM" grep -qx 'SMTP_PORT=465' "$SB/.env"
check "usuário vem do CRM" grep -qx 'SMTP_USER="contato@loja.com"' "$SB/.env"
check "senha com \$, aspa e barra sai escapada para o Compose" grep -qxF 'SMTP_PASS="p\$ss\"w\\d"' "$SB/.env"
check "remetente vira SMTP_ADMIN_EMAIL" grep -qx 'SMTP_ADMIN_EMAIL="nao-responda@loja.com"' "$SB/.env"
check "nome do remetente vai junto" grep -qx 'SMTP_SENDER_NAME="Loja X"' "$SB/.env"
check "o supabase-mail de mentira saiu" bash -c '! grep -q supabase-mail "$1"' _ "$SB/.env"
if [ -n "$DOCKER_REAL" ] && "$DOCKER_REAL" compose version >/dev/null 2>&1; then
  mkdir -p "$WORK/senha"; grep '^SMTP_PASS=' "$SB/.env" > "$WORK/senha/.env"
  printf 'services:\n  auth:\n    image: alpine:3.20\n    environment:\n      GOTRUE_SMTP_PASS: ${SMTP_PASS}\n' > "$WORK/senha/docker-compose.yml"
  lida="$(cd "$WORK/senha" && env -i PATH="$PATH" HOME="$HOME" "$DOCKER_REAL" compose config --format json 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["auth"]["environment"]["GOTRUE_SMTP_PASS"].replace("$$","$"))')"
  check "o Compose entrega a senha ao GoTrue byte a byte" igual "$lida" 'p$ss"w\d'
fi

env_sb_inicial
SMTP_HOST=smtp.env.com SMTP_PORT=587 SMTP_USERNAME=u SMTP_PASSWORD=s SMTP_FROM_EMAIL=a@env.com PSQL_SMTP='' smtp; rc=$?
check "sem linha no banco, cai no .env do CRM (como lib/email/config.ts)" \
  bash -c '[ "$1" -eq 0 ] && grep -qx "SMTP_HOST=\"smtp.env.com\"" "$2"' _ "$rc" "$SB/.env"
check "sem nome de remetente, usa o nome da instalação" grep -qx 'SMTP_SENDER_NAME="DeskcommCRM"' "$SB/.env"

env_sb_inicial
SMTP_HOST=smtp.env.com SMTP_FROM_EMAIL=a@env.com PSQL_SMTP='\x1f587\x1f\x1f\x1f\x1f\n' smtp; rc=$?
check "linha da tela VAZIA prevalece sobre o .env (e-mail desligado, rc=1)" test "$rc" -ne 0
check "e o .env do Supabase fica intacto" grep -qx 'SMTP_HOST=supabase-mail' "$SB/.env"

env_sb_inicial
PSQL_SMTP='smtp.loja.com\x1f587\x1fu\x1fs\x1f\x1f\n' smtp; rc=$?
check "host sem remetente é SMTP incompleto, como no CRM (rc=1)" test "$rc" -ne 0

env_sb_inicial
PSQL_SMTP='' smtp; rc=$?
check "CRM sem SMTP nenhum: não inventa, sai 1 para quem chama avisar" test "$rc" -ne 0

# ════════════════════════════════════════════════════════════════════════════
echo "(d) o update.sh leva o Supabase à versão pinada:"
pinada="$(kit 'printf %s "$SUPABASE_REF"')"
UPSTREAM_LOG="$WORK/upstream.log"
{
  printf 'UPSTREAM_LOG=%q\nFLAGS=%q\n' "$UPSTREAM_LOG" "$FLAGS"
  cat <<'UP'
printf 'args=%s smtp_host=%s\n' "$*" "${SMTP_HOST-<ausente>}" >> "$UPSTREAM_LOG"
[ -f "$FLAGS/upstream-falha" ] && exit 1
printf 'ref=%s\n' "$2" > .supabase-version
UP
} > "$SB/update.sh"
atualiza() { PROJECT_DIR="$PROJ" kit 'atualizar_supabase_single_server' 2>&1; }

env_sb_inicial; printf 'ref=self-hosted/v0.8.0\n' > "$SB/.supabase-version"; : > "$UPSTREAM_LOG"; : > "$LOG"
rm -f "$SB/docker-compose.deskcomm.yml"
SMTP_HOST=smtp.do-crm.com atualiza >/dev/null; rc=$?
check "versão antiga: atualiza e termina bem" test "$rc" -eq 0
check "chama o update.sh oficial rumo à versão pinada, sem perguntar" contem "$UPSTREAM_LOG" "args=--to $pinada --yes"
check "o update.sh oficial roda sem o .env do CRM no ambiente" contem "$UPSTREAM_LOG" 'smtp_host=<ausente>'
check "o override do kit chega à instalação" cmp -s "$KIT_DIR/supabase-single-server.override.yml" "$SB/docker-compose.deskcomm.yml"
check "o nome do projeto fica gravado no .env do Supabase" grep -qx 'COMPOSE_PROJECT_NAME=deskcommcrm-supabase' "$SB/.env"
check "sobe o Supabase e espera ficar saudável" contem "$LOG" 'compose up -d --wait'

: > "$UPSTREAM_LOG"; : > "$LOG"
atualiza >/dev/null; rc=$?
check "já na versão pinada: não chama o update.sh oficial" test ! -s "$UPSTREAM_LOG"
check "mas sobe o Supabase do mesmo jeito (rc=0)" bash -c '[ "$1" -eq 0 ] && grep -qF "compose up -d --wait" "$2"' _ "$rc" "$LOG"

printf 'ref=self-hosted/v0.8.0\n' > "$SB/.supabase-version"; : > "$LOG"
touch "$FLAGS/upstream-falha"
saida="$(atualiza)"; rc=$?
rm -f "$FLAGS/upstream-falha"
check "update oficial falhou: o CRM segue atualizando (rc=0)" test "$rc" -eq 0
check "e diz que o Supabase ficou na versão de antes" grep -q "segue na versão self-hosted/v0.8.0" <<<"$saida"

: > "$LOG"
touch "$FLAGS/compose-falha"
atualiza >/dev/null; rc=$?
rm -f "$FLAGS/compose-falha"
check "Supabase que não sobe REPROVA (o update.sh para antes do banco)" test "$rc" -ne 0

mv "$SB/.env" "$SB/.env.bak"
atualiza >/dev/null; rc=$?
check "modo single-server sem o .env do Supabase é erro dito, não silêncio" test "$rc" -ne 0
mv "$SB/.env.bak" "$SB/.env"

echo "update.sh chama tudo isso no lugar certo:"
U="$KIT_DIR/update.sh"
l_guarda="$(grep -n 'recusar_supabase_de_outra_arvore ||' "$U" | cut -d: -f1)"
l_smtp="$(grep -n 'if sincronizar_smtp_do_gotrue' "$U" | cut -d: -f1)"
l_procura="$(grep -n 'step "Procurando atualizações"' "$U" | cut -d: -f1)"
l_resource="$(grep -n '^source "$KIT_DIR/_common.sh"' "$U" | tail -1 | cut -d: -f1)"
l_atualiza="$(grep -n 'atualizar_supabase_single_server ||' "$U" | cut -d: -f1)"
l_banco="$(grep -n '^  manutencao_sobe' "$U" | head -1 | cut -d: -f1)"
check "guarda do Supabase e SMTP antes de decidir versão (\"nada a atualizar\" também entrega o SMTP)" \
  test "${l_guarda:-999}" -lt "${l_procura:-0}" -a "${l_smtp:-999}" -lt "${l_procura:-0}"
check "Supabase atualizado com as funções do código NOVO e antes do banco" \
  test "${l_atualiza:-0}" -gt "${l_resource:-999}" -a "${l_atualiza:-999}" -lt "${l_banco:-0}"
for l in "$l_guarda" "$l_atualiza"; do
  check "a linha $l só vale no modo single-server" \
    bash -c 'awk -v l="$2" "NR<l && /^if \\[ \"\\$\\{SINGLE_SERVER:-0\\}\" = \"1\" \\]; then\$/{a=NR} NR<l && /^fi\$/{f=NR} END{exit !(a>f)}" "$1"' _ "$U" "$l"
done

[ "$FAILS" -eq 0 ] || { echo "✖ $FAILS falha(s)" >&2; exit 1; }
echo 'ok: single-server não colide, faz backup dos anexos, manda e-mail e atualiza o Supabase'
