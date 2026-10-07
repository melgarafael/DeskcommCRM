#!/usr/bin/env bash
# Prova do `restore.sh` em dois bancos (issue #2120, reescrito pelo pedido do
# mantenedor em 03/10):
#
#   bash tests/shell/restore-falha-alto.test.sh
#
# O dump do backup.sh vem SEM --clean e traz os schemas internos (auth,
# storage, realtime, vault) e extensões como pg_net. Por isso ele grita
# "already exists" e "extension is not available" até num banco VAZIO — o que
# era o problema medido: com `-v ON_ERROR_STOP=1 --single-transaction` o
# restore morria em Supabase novo, Postgres 17 puro e database nova (rc=3,
# 0 tabelas), e sem elas, nos dois primeiros, o mesmo dump entrou com rc=0 e
# 110 tabelas.
#
# Duas provas, e elas são o par:
#
#  1. banco que JÁ tem o schema → paramos ANTES do psql, com mensagem própria,
#     e o psql do restore nem é chamado (só a checagem da contagem).
#  2. banco vazio (o caso que as flags quebravam) → o dublê emite os erros
#     reais do dump, o psql SEGUE porque não há ON_ERROR_STOP, e o script
#     sai 0 anunciando o ✓. É esta prova que fica vermelha de volta se as
#     flags voltarem.
#
# Nada aqui toca a máquina de quem roda: `docker` é um dublê que registra o
# que recebeu, e o dump é um .sql.gz de mentira com um CREATE TABLE dentro.
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
# Duas funções distintas, e é por isso que ele reproduz a medição:
#   a) a checagem da contagem (query com pg_tables) devolve quantas tabelas o
#      banco falso tem em public — 118 se existe schema, 0 se está vazio;
#   b) o psql do restore LÊ o dump no stdin e emite os erros que o dump real
#      dá também num banco vazio (schema "auth" already exists, extension
#      "pg_net" is not available) mais o "already exists" da tabela do produto
#      quando o banco já a tem. Só aí ON_ERROR_STOP=1 decalaria rc=3 — é a
#      volta do bug, e o teste tem de pegá-la.
export DUBLE_LOG="$WORK/docker.log"
mkdir -p "$WORK/bin"
{
  printf '#!/usr/bin/env bash\nDUBLE_LOG=%q\n' "$DUBLE_LOG"
  cat <<'STUB'
printf '%s\n' "$*" >> "$DUBLE_LOG"
case " $* " in *" psql "*) ;; *) exit 0 ;; esac

for a in "$@"; do
  case "$a" in
    *"pg_tables"*)
      # DUBLE_CONTAGEM (mesmo vazio) troca a resposta: a conexão "deu certo"
      # (rc 0), mas o que voltou não é um número.
      if [ -n "${DUBLE_CONTAGEM+x}" ]; then printf '%s' "$DUBLE_CONTAGEM"; exit 0; fi
      if [ "${DUBLE_BANCO_EXISTE:-0}" = "1" ]; then printf '118\n'; else printf '0\n'; fi
      exit 0 ;;
  esac
done

parar=0
for a in "$@"; do
  case "$a" in ON_ERROR_STOP=1|ON_ERROR_STOP=true) parar=1 ;; esac
done
# erros do dump real num banco recém-criado: eles existem mesmo com public
# vazio, porque auth/storage e pg_net já vêm no Supabase novo. É exatamente
# este o erro que ON_ERROR_STOP=1 convertia em rc=3 num banco vazio.
printf 'ERROR:  schema "auth" already exists\n' >&2
printf 'ERROR:  extension "pg_net" is not available\n' >&2
[ "$parar" = 1 ] && exit 3   # ON_ERROR_STOP: o dump real aborta aqui, em banco vazio
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

echo "banco que já tem o schema: paramos ANTES do psql com a mensagem certa (#2120):"
: > "$DUBLE_LOG"
RC_EXISTE="$(rodar_restore "$WORK/existe.txt" 1)"
check "sai com rc diferente de 0 (o die do script)" diferente "$RC_EXISTE" 0
check "diz que o banco já tem as tabelas do sistema" contem "$WORK/existe.txt" "já tem as tabelas do sistema"
check "diz que nada foi alterado no banco" contem "$WORK/existe.txt" "nada foi alterado"
check "não imprime '✓ banco restaurado'" nao_contem "$WORK/existe.txt" "✓ banco restaurado"
check "o psql do restore nem é chamado (só a checagem da contagem)" igual "$(grep -c 'psql' "$DUBLE_LOG")" 1
check "o psql não recebe ON_ERROR_STOP=1" nao_contem "$DUBLE_LOG" "ON_ERROR_STOP"
check "o psql não recebe --single-transaction" nao_contem "$DUBLE_LOG" "--single-transaction"

echo "banco vazio: o dump real grita, o psql segue sem ON_ERROR_STOP e o restore entra (a medição do mantenedor):"
: > "$DUBLE_LOG"
RC_VAZIO="$(rodar_restore "$WORK/vazio.txt" 0)"
check "sai com rc 0" igual "$RC_VAZIO" 0
check "imprime '✓ banco restaurado'" contem "$WORK/vazio.txt" "✓ banco restaurado"
check "o dublê emitiu o erro de schema do dump real" contem "$WORK/vazio.txt" 'schema "auth" already exists'
check "o dublê emitiu o erro de extensão do dump real" contem "$WORK/vazio.txt" 'extension "pg_net" is not available'
check "o psql não recebe ON_ERROR_STOP=1 (sem ela ele segue e sai 0)" nao_contem "$DUBLE_LOG" "ON_ERROR_STOP"
check "o psql do restore foi chamado (2 chamadas: checagem + restore)" igual "$(grep -c 'psql' "$DUBLE_LOG")" 2

echo "contagem com rc 0 mas sem número (vazia ou lixo): falha fechada, o restore não roda:"
for resposta in "" "NOTICE:  algo no stdout"; do
  : > "$DUBLE_LOG"
  RC_LIXO="$( ( cd "$PROJ" && printf 'RESTAURAR\n' \
      | DUBLE_CONTAGEM="$resposta" bash "$KIT_DIR/restore.sh" backups/db-20261002-030000.sql.gz \
    ) > "$WORK/lixo.txt" 2>&1; printf '%s' "$?")"
  check "[$resposta]: sai com rc diferente de 0" diferente "$RC_LIXO" 0
  check "[$resposta]: diz que não conseguiu conferir" contem "$WORK/lixo.txt" "Não consegui conferir"
  check "[$resposta]: não imprime '✓ banco restaurado'" nao_contem "$WORK/lixo.txt" "✓ banco restaurado"
  check "[$resposta]: o psql do restore nem é chamado" igual "$(grep -c 'psql' "$DUBLE_LOG")" 1
done

[ "$FAILS" -eq 0 ] || { echo "✖ $FAILS falha(s)" >&2; exit 1; }
echo "ok: restore.sh para antes num banco existente e restaura num banco vazio mesmo com os erros do dump"
