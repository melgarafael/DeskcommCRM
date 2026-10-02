#!/usr/bin/env bash
# Prova do `restore.sh` falhar ALTO (issue #2120): um dump do backup.sh vem sem
# `--clean`, então num banco que JÁ tem o schema o psql grita "already exists" em
# cada `CREATE` — e, sem `-v ON_ERROR_STOP=1`, ele SEGUE, sai com 0 e o script
# imprime "✓ banco restaurado" sobre um banco que não restaurou nada.
#
#   bash tests/shell/restore-falha-alto.test.sh
#
# Duas provas, e elas são o par:
#
#  1. banco que já existe → o restore tem de sair com rc ≠ 0 e sem anunciar o ✓
#     (o dublê de `docker` emula a semântica do psql: com ON_ERROR_STOP=1 ele
#     para no primeiro erro e sai 3; sem a flag ele imprime os erros, segue e
#     sai 0 — é exatamente o comportamento medido na issue).
#  2. banco vazio (caso de controle) → sai 0 e anuncia o ✓: o conserto não
#     quebra o caminho que funciona, que é restaurar num banco novo.
#
# Nada aqui toca a máquina de quem roda: `docker` é um dublê que registra o que
# recebeu, e o dump é um .sql.gz de mentira com um CREATE TABLE dentro.
set -uo pipefail
unset COMPOSE_PROJECT_NAME SINGLE_SERVER PSQL_DOCKER_NETWORK REVERSE_PROXY

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KIT_DIR="$ROOT/hostgator-setup-kit"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() {  # check <descrição> <comando...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}
igual() { [ "$1" = "$2" ] || { printf '    esperado [%s], veio [%s]\n' "$2" "$1"; return 1; }; }
diferente() { [ "$1" != "$2" ] || { printf '    esperado diferente de [%s], veio [%s]\n' "$2" "$1"; return 1; }; }
contem() { grep -qF -- "$2" "$1" || { printf '    [%s] não está em %s\n' "$2" "$1"; return 1; }; }
nao_contem() { ! grep -qF -- "$2" "$1" || { printf '    [%s] apareceu em %s\n' "$2" "$1"; return 1; }; }

# ── Dublê de docker ──────────────────────────────────────────────────────────
# Só o `run ... psql` importa aqui. O dublê emula o psql LENDO o dump (stdin):
# uma `CREATE TABLE` num banco que já a tem é um "already exists", e o que decide
# o código de saída é a flag ON_ERROR_STOP=1 — com ela, para no primeiro erro e
# sai 3; sem ela, imprime o erro, segue e sai 0. $DUBLE_BANCO_EXISTE diz se o
# banco falso já tem o schema (0 = vazio, o caso de controle).
export DUBLE_LOG="$WORK/docker.log"
mkdir -p "$WORK/bin"
{
  printf '#!/usr/bin/env bash\nDUBLE_LOG=%q\n' "$DUBLE_LOG"
  cat <<'STUB'
printf '%s\n' "$*" >> "$DUBLE_LOG"
case " $* " in *" psql "*) ;; *) exit 0 ;; esac
parar=0
for a in "$@"; do
  case "$a" in ON_ERROR_STOP=1|ON_ERROR_STOP=true) parar=1 ;; esac
done
while IFS= read -r linha || [ -n "$linha" ]; do
  case "$linha" in
    "CREATE TABLE"*)
      [ "${DUBLE_BANCO_EXISTE:-0}" = "1" ] || continue
      printf 'ERROR:  relation "public.contacts" already exists\n' >&2
      [ "$parar" = 1 ] && exit 3   # ON_ERROR_STOP: o psql para no primeiro erro
      ;;
  esac
done
exit 0
STUB
} > "$WORK/bin/docker"
chmod +x "$WORK/bin/docker"
PATH="$WORK/bin:$PATH"

# ── Projeto falso com o que o restore.sh exige ───────────────────────────────
PROJ="$WORK/projeto"
mkdir -p "$PROJ/backups"
: > "$PROJ/docker-compose.prod.yml"
printf '%s\n' 'SUPABASE_DB_URL="postgresql://postgres:***@db.exemplo.supabase.co:5432/postgres"' \
  'NEXT_PUBLIC_SUPABASE_URL="https://exemplo.supabase.co"' > "$PROJ/.env"
# O dump sem --clean: um CREATE TABLE que, num banco populado, é um "already exists".
{ printf '%s\n' '-- dump do backup.sh (sem --clean)' \
  'CREATE TABLE public.contacts (' '  id uuid NOT NULL PRIMARY KEY' ');'; } \
  | gzip > "$PROJ/backups/db-20261002-030000.sql.gz"

rodar_restore() {  # rodar_restore <arquivo-de-saída> <DUBLE_BANCO_EXISTE> → rc
  local saida="$1" existe="${2:-0}" rc=0
  ( cd "$PROJ" && printf 'RESTAURAR\n' \
      | DUBLE_BANCO_EXISTE="$existe" bash "$KIT_DIR/restore.sh" backups/db-20261002-030000.sql.gz \
    ) > "$saida" 2>&1 || rc=$?
  printf '%s' "$rc"
}

echo "banco que já existe: o restore falha alto e não anuncia o ✓ (#2120):"
: > "$DUBLE_LOG"
RC_EXISTE="$(rodar_restore "$WORK/existe.txt" 1)"
check "sai com rc diferente de 0 (o die do script)" diferente "$RC_EXISTE" 0
check "não imprime '✓ banco restaurado'" nao_contem "$WORK/existe.txt" "✓ banco restaurado"
check "diz que nada foi alterado no banco" contem "$WORK/existe.txt" "Falha na restauração"
check "o psql recebe -v ON_ERROR_STOP=1" contem "$DUBLE_LOG" "ON_ERROR_STOP=1"
check "o psql recebe --single-transaction" contem "$DUBLE_LOG" "--single-transaction"

echo "banco vazio (caso de controle): o caminho que funciona segue verde:"
: > "$DUBLE_LOG"
RC_VAZIO="$(rodar_restore "$WORK/vazio.txt" 0)"
check "sai com rc 0" igual "$RC_VAZIO" 0
check "imprime '✓ banco restaurado'" contem "$WORK/vazio.txt" "✓ banco restaurado"

[ "$FAILS" -eq 0 ] || { echo "✖ $FAILS falha(s)" >&2; exit 1; }
echo "ok: restore.sh falha alto num banco existente e restaura num banco vazio"
