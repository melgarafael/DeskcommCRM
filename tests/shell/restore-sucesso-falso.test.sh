#!/usr/bin/env bash
# Prova do #2381: um dump que NÃO restaurou nunca termina em "✓ banco
# restaurado" e exit 0.
#
#   bash tests/shell/restore-sucesso-falso.test.sh
#
# O defeito medido na issue: o psql roda SEM ON_ERROR_STOP, então ele devolve
# rc=0 mesmo com 2.887 linhas `permission denied` — no single-server a
# conexão era a do `postgres`, que não é dono de auth/storage/realtime —, e o
# `&&` de antes só via o rc do pipe. Resultado: banco vazio, script verde.
#
# Três provas, e elas são o par do `restore-falha-alto.test.sh`:
#
#  1. erro de PERMISSÃO (o caso da issue) → rc ≠ 0, sem ✓, e a mensagem
#     aponta a conexão do dono (SUPABASE_DB_ADMIN_URL);
#  2. erro qualquer que não seja dos benignos medidos, ou psql que sai ≠0 →
#     idem: nunca verde;
#  3. single-server → a conexão do restore é a de `supabase_admin`, montada
#     com a senha do `.env` do Supabase (a causa raiz do item 1) — e os erros
#     benignos de banco vazio AINDA terminam em ✓, para o restore real não
#     virar falso negativo.
#
# Nada aqui toca a máquina de quem roda: `docker` é um dublê que registra o
# que recebe, e o dump é um .sql.gz de mentira com um CREATE TABLE dentro.
set -uo pipefail
unset COMPOSE_PROJECT_NAME PSQL_DOCKER_NETWORK REVERSE_PROXY

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
# O comportamento do psql do restore é escolhido por DUBLE_PSQL_*:
#   permissao → o log da issue (permission denied, rc 0 — é assim que o psql
#               sem ON_ERROR_STOP se comporta);
#   erro      → erro qualquer fora da lista de benignos (syntax error);
#   rc        → psql fatal (conexão/disco), sai ≠0;
#   (default) → os erros benignos reais de banco VAZIO (#2120), rc 0.
export DUBLE_LOG="$WORK/docker.log"
mkdir -p "$WORK/bin"
{
  printf '#!/usr/bin/env bash\nDUBLE_LOG=%q\n' "$DUBLE_LOG"
  cat <<'STUB'
printf '%s\n' "$*" >> "$DUBLE_LOG"
case " $* " in *" psql "*) ;; *) exit 0 ;; esac

for a in "$@"; do
  case "$a" in
    *pg_tables*)
      printf '0\n'; exit 0 ;;
  esac
done

# psql do restore: o stdin é o dump — lê tudo para o gunzip do outro lado do
# pipe não morrer com SIGPIPE.
cat > /dev/null
case "${DUBLE_PSQL:-benignos}" in
  permissao)
    printf 'ERROR:  permission denied for schema auth\n' >&2
    printf 'ERROR:  permission denied for schema storage\n' >&2
    printf 'ERROR:  must be owner of table users\n' >&2
    exit 0 ;;
  erro)
    printf 'ERROR:  syntax error at or near "INSERTT"\n' >&2
    exit 0 ;;
  rc)
    printf 'ERROR:  could not connect to server: Connection refused\n' >&2
    exit 3 ;;
  *)
    printf 'ERROR:  schema "auth" already exists\n' >&2
    printf 'ERROR:  extension "pg_net" is not available\n' >&2
    exit 0 ;;
esac
STUB
} > "$WORK/bin/docker"
chmod +x "$WORK/bin/docker"
PATH="$WORK/bin:$PATH"

# ── Projeto single-server falso, com o que o restore.sh exige ────────────────
PROJ="$WORK/projeto"
mkdir -p "$PROJ/.runtime/supabase" "$PROJ/backups"
: > "$PROJ/docker-compose.prod.yml"
# A senha traz caracteres reservados de propósito: url_do_restore tem de
# percent-encode-á-la, ou a connection string montada vira host errado.
printf '%s\n' 'SINGLE_SERVER="1"' \
  'SUPABASE_DB_URL="postgresql://postgres:***@supabase-db:5432/postgres"' \
  'PSQL_DOCKER_NETWORK="deskcommcrm_supabase"' \
  'NEXT_PUBLIC_SUPABASE_URL="https://crm.exemplo.com"' > "$PROJ/.env"
printf '%s\n' 'POSTGRES_PASSWORD=s3nh:@/a' > "$PROJ/.runtime/supabase/.env"
{ printf '%s\n' '-- dump do backup.sh (sem --clean)' \
  'CREATE TABLE public.contacts (' '  id uuid NOT NULL PRIMARY KEY' ');'; } \
  | gzip > "$PROJ/backups/db-20261004-030000.sql.gz"

rodar_restore() {  # rodar_restore <saída> [DUBLE_PSQL] [ADMIN_URL] → rc
  local saida="$1" modo="${2:-benignos}" admin="${3:-}" rc=0
  ( cd "$PROJ" && printf 'RESTAURAR\n' \
      | DUBLE_PSQL="$modo" SUPABASE_DB_ADMIN_URL="$admin" \
        bash "$KIT_DIR/restore.sh" backups/db-20261004-030000.sql.gz \
    ) > "$saida" 2>&1 || rc=$?
  printf '%s' "$rc"
}

echo "single-server: a conexão do restore é a de supabase_admin (a causa raiz, #2381):"
: > "$DUBLE_LOG"
RC_DONO="$(rodar_restore "$WORK/dono.txt" benignos)"
check "sai com rc 0 (só erros benignos de banco vazio)" igual "$RC_DONO" 0
check "imprime '✓ banco restaurado'" contem "$WORK/dono.txt" "✓ banco restaurado"
check "a contagem e o restore usam supabase_admin, não postgres" \
  igual "$(grep -c 'postgresql://supabase_admin:s3nh%3A%40%2Fa@supabase-db:5432/postgres' "$DUBLE_LOG")" 2
check "a senha do .env do Supabase foi percent-encoded (não vazou cru na URL)" \
  nao_contem "$DUBLE_LOG" 'supabase_admin:s3nh:@/a@'
check "não restou nenhum psql pela conexão antiga do postgres" \
  igual "$(grep -c 'postgresql://postgres:' "$DUBLE_LOG")" 0

echo "o log da issue: permission denied com psql saindo 0 → NUNCA verde:"
: > "$DUBLE_LOG"
RC_PERM="$(rodar_restore "$WORK/perm.txt" permissao)"
check "sai com rc diferente de 0" diferente "$RC_PERM" 0
check "não imprime '✓ banco restaurado'" nao_contem "$WORK/perm.txt" "✓ banco restaurado"
check "diz que o dump NÃO restaurou" contem "$WORK/perm.txt" "O dump NÃO restaurou"
check "diz que nada foi considerado restaurado" contem "$WORK/perm.txt" "NADA foi considerado restaurado"
check "a mensagem aponta SUPABASE_DB_ADMIN_URL" contem "$WORK/perm.txt" "SUPABASE_DB_ADMIN_URL"
check "a mensagem cita supabase_admin como dono" contem "$WORK/perm.txt" "supabase_admin"
check "mostra o erro de permissão na tela" contem "$WORK/perm.txt" "permission denied for schema auth"
check "a senha não aparece na mensagem de erro" nao_contem "$WORK/perm.txt" 's3nh:@/a'
check "o WAHA/anexos nem são tentados depois do banco falho" \
  nao_contem "$DUBLE_LOG" "tar xzf"

echo "erro fora da lista de benignos (dump cortado, syntax error) → rc ≠ 0, sem ✓:"
RC_ERRO="$(rodar_restore "$WORK/erro.txt" erro)"
check "sai com rc diferente de 0" diferente "$RC_ERRO" 0
check "não imprime '✓ banco restaurado'" nao_contem "$WORK/erro.txt" "✓ banco restaurado"
check "diz que o dump NÃO restaurou" contem "$WORK/erro.txt" "O dump NÃO restaurou"
check "mostra o erro na tela" contem "$WORK/erro.txt" 'syntax error at or near'

echo "psql que sai ≠0 (conexão/disco) → rc ≠ 0, sem ✓, e o código de saída na mensagem:"
RC_FATAL="$(rodar_restore "$WORK/fatal.txt" rc)"
check "sai com rc diferente de 0" diferente "$RC_FATAL" 0
check "não imprime '✓ banco restaurado'" nao_contem "$WORK/fatal.txt" "✓ banco restaurado"
check "diz que o psql saiu com 3" contem "$WORK/fatal.txt" "psql saiu com 3"
check "não anuncia dump não restaurado como sem erro" nao_contem "$WORK/fatal.txt" "NADA foi considerado restaurado."

echo "SUPABASE_DB_ADMIN_URL declarada vence o single-server (quem já declarou não muda):"
: > "$DUBLE_LOG"
RC_DECL="$(rodar_restore "$WORK/decl.txt" benignos 'postgresql://supabase_admin:***@db.proprio:5432/postgres')"
check "sai com rc 0" igual "$RC_DECL" 0
check "o psql foi chamado com a string declarada" \
  contem "$DUBLE_LOG" 'postgresql://supabase_admin:***@db.proprio:5432/postgres'
check "e não com a montada do .env local" nao_contem "$DUBLE_LOG" 's3nh%3A%40%2Fa'

[ "$FAILS" -eq 0 ] || { echo "✖ $FAILS falha(s)" >&2; exit 1; }
echo "ok: restore.sh nunca anuncia sucesso para um dump que não restaurou (#2381)"
