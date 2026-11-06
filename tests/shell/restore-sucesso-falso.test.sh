#!/usr/bin/env bash
# Prova do #2381, na reescrita pedida pelo mantenedor em 16/10: quem decide o
# restore é a CONFERÊNCIA DO RESULTADO, não a lista de erros tolerados.
#
#   bash tests/shell/restore-sucesso-falso.test.sh
#
# O defeito original da issue: o psql roda SEM ON_ERROR_STOP, então ele devolve
# rc=0 mesmo com 2.887 linhas `permission denied` — no single-server a conexão
# da atualização (`postgres`) não é dona de auth/storage/realtime, e as linhas
# do dump para esses schemas internos são recusadas até num restore que
# funcionou —, e o `&&` de antes só via o rc do pipe. Resultado: banco vazio,
# script verde.
#
# O que o mantenedor mediu em 16/10, e que derrubou a PRIMEIRA correção (a
# lista de erros tolerados): os erros INOFENSIVOS mudam com o papel e com a
# versão do Postgres. No mesmo restore que voltou com as 189 tabelas de public,
# o usuário em auth.users, a organização e a FK (07/10, `supabase/postgres`
# 15.8 e 17.6, pela role supabase_admin), o psql imprime também
# `multiple primary keys for table ... are not allowed` e `duplicate key value
# violates unique constraint "schema_migrations_pkey"`. Com a lista decidindo,
# aquele restore que FUNCIONOU terminava em die: falso negativo.
#
# Prova-se o desenho novo em cinco tempos:
#
#  1. erro de PERMISSÃO (o caso da issue) → rc ≠ 0, sem ✓, e o que a
#     conferência acusa é o RESULTADO (tabela faltando), não o texto do erro;
#  2. erro qualquer fora do que o dump explica, ou psql que sai ≠0 → idem;
#  3. single-server → a conexão do restore é a MESMA da atualização
#     (`url_do_restore` → `url_do_schema`: a string de `SUPABASE_DB_URL`, a
#     conta `postgres`), e NÃO mais a de `supabase_admin` que esta suíte exigia
#     antes. É o ajuste pedido pelo mantenedor em 22/10: o dump volta sem dono
#     (`--no-owner`) e, restaurando pela conta errada, as tabelas e funções de
#     `public` ficavam com o dono errado — a atualização seguinte não reaplicava
#     o banco (2.714 `must be owner`, todos em objetos admin_*); pela conta da
#     atualização, 0;
#  4. o FALSO NEGATIVO: o dublê imprime a saída do supabase_admin 17.6 (a
#     fixture `tests/shell/fixtures/restore-supabase-admin-17.6.txt`) e a
#     conferência fecha → rc 0 e ✓. É este caso que cai se alguém voltar a
#     decidir pelos erros tolerados;
#  5. e o outro lado do item 4: a MESMA saída benigna, com a conferência
#     acusando tabela faltando ou contagem menor → rc ≠ 0, sem ✓, com a
#     tabela, o esperado e o obtido nomeados.
#
# A fixture do item 4 foi escrita pelo formato que o mantenedor descreveu no
# comentário do PR, a partir dos dois erros que ele mediu. A saída LITERAL do
# psql dele (supabase_admin, 17.6) substitui a fixture linha a linha quando ele
# mandar — é só trocar o conteúdo do arquivo.
#
# Nada aqui toca a máquina de quem roda: `docker` é um dublê que registra o
# que recebe, e o dump é um .sql.gz de mentira com tabelas e blocos COPY.
set -uo pipefail
unset COMPOSE_PROJECT_NAME PSQL_DOCKER_NETWORK REVERSE_PROXY SINGLE_SERVER

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KIT_DIR="$ROOT/hostgator-setup-kit"
FIXTURE="$ROOT/tests/shell/fixtures/restore-supabase-admin-17.6.txt"
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
# O comportamento do psql do restore é escolhido por DUBLE_PSQL:
#   permissao      → o log da issue (permission denied, rc 0 — é assim que o
#                    psql sem ON_ERROR_STOP se comporta);
#   erro           → erro qualquer que o dump não explica (syntax error);
#   rc             → psql fatal (conexão/disco), sai ≠0;
#   supabase_admin → a saída real de 17.6 pela role dona (a fixture);
#   (default)      → os erros benignos reais de banco VAZIO (#2120), rc 0.
#
# A CONFERÊNCIA do resultado tem as duas consultas identificadas pelos
# marcadores que o restore.sh põe no próprio SQL. É o dublê que responde por
# elas: `benignos` e `supabase_admin` respondem um banco que TEM o que o dump
# declara (a conferência fecha); os outros modos respondem um banco vazio (a
# conferência acusa tudo faltando). DUBLE_CONF_TABELAS e DUBLE_CONF_LINHAS
# trocam essas respostas — é o que mede a tabela faltando e a contagem menor.
export DUBLE_LOG="$WORK/docker.log"
export DUBLE_FIXTURE="$FIXTURE"
mkdir -p "$WORK/bin"
{
  printf '#!/usr/bin/env bash\nDUBLE_LOG=%q\nDUBLE_FIXTURE=%q\n' "$DUBLE_LOG" "$DUBLE_FIXTURE"
  cat <<'STUB'
printf '%s\n' "$*" >> "$DUBLE_LOG"
case " $* " in *" psql "*) ;; *) exit 0 ;; esac

case " $* " in
  *"/*conf-tabelas*/"*)
    if [ -n "${DUBLE_CONF_TABELAS+x}" ]; then printf '%s\n' "$DUBLE_CONF_TABELAS"; exit 0; fi
    case "${DUBLE_PSQL:-benignos}" in
      benignos|supabase_admin) printf '%s\n' 'public.contacts' 'auth.users' ;;
    esac
    exit 0 ;;
  *"/*conf-linhas*/"*)
    if [ -n "${DUBLE_CONF_LINHAS+x}" ]; then printf '%s\n' "$DUBLE_CONF_LINHAS"; exit 0; fi
    # Coerência com a lista de tabelas acima: o banco só devolve contagem do
    # que EXISTE nele — é assim que a tabela ausente aparece na conferência.
    if [ -n "${DUBLE_CONF_TABELAS+x}" ]; then
      for t in $DUBLE_CONF_TABELAS; do
        case "$t" in
          public.contacts) printf 'public.contacts|2\n' ;;
          auth.users)      printf 'auth.users|1\n' ;;
        esac
      done
      exit 0
    fi
    case "${DUBLE_PSQL:-benignos}" in
      benignos|supabase_admin) printf '%s\n' 'public.contacts|2' 'auth.users|1' ;;
    esac
    exit 0 ;;
esac

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
  supabase_admin)
    # A saída real do restore pelas mãos do dono (17.6): erros dos schemas
    # internos que NÃO custam uma linha de public — é a fixture que o
    # mantenedor ofereceu para virar prova.
    cat "$DUBLE_FIXTURE" >&2
    exit 0 ;;
  *)
    printf 'ERROR:  schema "auth" already exists\n' >&2
    printf 'ERROR:  extension "pg_net" is not available\n' >&2
    exit 0 ;;
esac
STUB
} > "$WORK/bin/docker"
chmod +x "$WORK/bin/docker"
PATH="$WORK/bin:$PATH"

# ── Os projetos falsos, com o que o restore.sh exige ─────────────────────────
# O dump declara duas tabelas: public.contacts com 2 linhas e auth.users com 1.
# É contra as contagens destes COPY que a conferência mede.
dump() {
  { printf '%s\n' '-- dump do backup.sh (sem --clean)' \
    'CREATE TABLE public.contacts (' '  id uuid NOT NULL PRIMARY KEY' ');' \
    'COPY public.contacts (id) FROM stdin;' \
    '11111111-1111-1111-1111-111111111111' \
    '22222222-2222-2222-2222-222222222222' \
    '\.' \
    'COPY auth.users (id) FROM stdin;' \
    '33333333-3333-3333-3333-333333333333' \
    '\.'; } | gzip > "$1"
}

# Single-server: a conta do restore passa a ser a MESMA da atualização
# (`url_do_schema` → a string de `SUPABASE_DB_URL`), então o antigo caminho que
# lia a senha do `.env` do Supabase e montava um `supabase_admin` não existe
# mais — a senha crua do `.env` do Supabase não deve aparecer em URL nenhuma.
PROJ="$WORK/projeto"
mkdir -p "$PROJ/.runtime/supabase" "$PROJ/backups"
: > "$PROJ/docker-compose.prod.yml"
printf '%s\n' 'SINGLE_SERVER="1"' \
  'SUPABASE_DB_URL="postgresql://postgres:***@supabase-db:5432/postgres"' \
  'PSQL_DOCKER_NETWORK="deskcommcrm_supabase"' \
  'NEXT_PUBLIC_SUPABASE_URL="https://crm.exemplo.com"' > "$PROJ/.env"
printf '%s\n' 'POSTGRES_PASSWORD=s3nh:@/a' > "$PROJ/.runtime/supabase/.env"
dump "$PROJ/backups/db-20261004-030000.sql.gz"

# Supabase GERENCIADO (nuvem): o operador não tem — e não pode ter — uma
# conexão de supabase_admin.
NUVEM="$WORK/nuvem"
mkdir -p "$NUVEM/backups"
: > "$NUVEM/docker-compose.prod.yml"
printf '%s\n' 'SUPABASE_DB_URL="postgresql://postgres:***@db.projeto.supabase.co:5432/postgres"' \
  'NEXT_PUBLIC_SUPABASE_URL="https://projeto.supabase.co"' > "$NUVEM/.env"
dump "$NUVEM/backups/db-20261004-030000.sql.gz"

rodar_restore() {  # rodar_restore <saída> [DUBLE_PSQL] [ADMIN_URL] [PROJETO] → rc
  local saida="$1" modo="${2:-benignos}" admin="${3:-}" proj="${4:-$PROJ}" rc=0
  ( cd "$proj" && printf 'RESTAURAR\n' \
      | DUBLE_PSQL="$modo" SUPABASE_DB_ADMIN_URL="$admin" \
        bash "$KIT_DIR/restore.sh" backups/db-20261004-030000.sql.gz \
    ) > "$saida" 2>&1 || rc=$?
  printf '%s' "$rc"
}

echo "single-server: a conexão do restore é a MESMA da atualização (o dono), não supabase_admin:"
: > "$DUBLE_LOG"
RC_DONO="$(rodar_restore "$WORK/dono.txt" benignos)"
check "sai com rc 0 (só erros benignos de banco vazio)" igual "$RC_DONO" 0
check "imprime '✓ banco restaurado'" contem "$WORK/dono.txt" "✓ banco restaurado"
check "anuncia a conferência do resultado, com as tabelas e as linhas medidas" \
  contem "$WORK/dono.txt" "2 tabela(s) de public/auth.users conferidas contra os COPY do dump (3 linha(s))"
# 4 chamadas com a MESMA conexão: a checagem de banco vazio, o restore e as
# duas consultas da conferência. A conta é a de `url_do_schema` — a MESMA que o
# update.sh passa ao psql do baseline. Restaurar por outra conta (o
# `supabase_admin` de antes) devolvia as tabelas e funções de `public` com outro
# dono, e a atualização seguinte não reaplicava o banco (2.714 `must be owner`).
check "a checagem, o restore e a conferência usam a conta da atualização (postgres)" \
  igual "$(grep -c 'psql postgresql://postgres:' "$DUBLE_LOG")" 4
check "nenhum psql pela conexão de supabase_admin (o dono errado que a suíte prendia)" \
  igual "$(grep -c 'supabase_admin' "$DUBLE_LOG")" 0
check "a conta usada é a mesma que o update.sh passa ao psql do baseline" \
  contem "$KIT_DIR/update.sh" 'psql "$(url_do_schema)"'
check "a senha crua do .env do Supabase nem é lida (não vaza em URL nenhuma)" \
  nao_contem "$DUBLE_LOG" 's3nh'

echo "o log da issue: permission denied com psql saindo 0 → NUNCA verde:"
: > "$DUBLE_LOG"
RC_PERM="$(rodar_restore "$WORK/perm.txt" permissao)"
check "sai com rc diferente de 0" diferente "$RC_PERM" 0
check "não imprime '✓ banco restaurado'" nao_contem "$WORK/perm.txt" "✓ banco restaurado"
check "diz que o dump NÃO restaurou" contem "$WORK/perm.txt" "O dump NÃO restaurou"
check "diz que nada foi considerado restaurado" contem "$WORK/perm.txt" "NADA foi considerado restaurado"
check "o veredito é a conferência: acusa a tabela que não voltou" \
  contem "$WORK/perm.txt" "FALTA public.contacts"
check "com esperado e obtido no relatório" contem "$WORK/perm.txt" "(esperado 2 linha(s)"
check "a mensagem aponta SUPABASE_DB_ADMIN_URL (o Supabase PRÓPRIO tem essa credencial)" \
  contem "$WORK/perm.txt" "SUPABASE_DB_ADMIN_URL"
check "a mensagem cita supabase_admin como dono" contem "$WORK/perm.txt" "supabase_admin"
check "mostra o erro de permissão na tela" contem "$WORK/perm.txt" "permission denied for schema auth"
check "a senha não aparece na mensagem de erro" nao_contem "$WORK/perm.txt" 's3nh:@/a'
check "o WAHA/anexos nem são tentados depois do banco falho" \
  nao_contem "$DUBLE_LOG" "tar xzf"

echo "erro fora do que o dump explica (dump cortado, syntax error) → rc ≠ 0, sem ✓:"
RC_ERRO="$(rodar_restore "$WORK/erro.txt" erro)"
check "sai com rc diferente de 0" diferente "$RC_ERRO" 0
check "não imprime '✓ banco restaurado'" nao_contem "$WORK/erro.txt" "✓ banco restaurado"
check "diz que o dump NÃO restaurou" contem "$WORK/erro.txt" "O dump NÃO restaurou"
check "mostra o erro na tela" contem "$WORK/erro.txt" 'syntax error at or near'
check "o veredito continua sendo a conferência, não o texto do erro" \
  contem "$WORK/erro.txt" "FALTA public.contacts"

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

echo "Supabase GERENCIADO recusando escrita: a mensagem não pede uma conexão que o operador não tem:"
RC_NUVEM="$(rodar_restore "$WORK/nuvem.txt" permissao "" "$NUVEM")"
check "sai com rc diferente de 0" diferente "$RC_NUVEM" 0
check "não imprime '✓ banco restaurado'" nao_contem "$WORK/nuvem.txt" "✓ banco restaurado"
check "o veredito é a conferência, com a tabela nomeada" contem "$WORK/nuvem.txt" "FALTA public.contacts"
check "diz que num Supabase gerenciado não existe conexão de supabase_admin" \
  contem "$WORK/nuvem.txt" "Num Supabase GERENCIADO não existe"
check "NÃO manda declarar SUPABASE_DB_ADMIN_URL na nuvem" \
  nao_contem "$WORK/nuvem.txt" "SUPABASE_DB_ADMIN_URL"
check "aponta para a senha de banco do projeto (a que o operador tem)" \
  contem "$WORK/nuvem.txt" "SUPABASE_DB_URL"

echo "o FALSO NEGATIVO do papel (supabase_admin, 17.6): erros internos, conferência fechando → rc 0 e ✓:"
check "a fixture da saída real do 17.6 existe" test -s "$FIXTURE"
RC_SA="$(rodar_restore "$WORK/supabase-admin.txt" supabase_admin)"
check "sai com rc 0 (a lista de erros tolerados diria NÃO)" igual "$RC_SA" 0
check "imprime '✓ banco restaurado'" contem "$WORK/supabase-admin.txt" "✓ banco restaurado"
check "a saída literal do 17.6 aparece na tela (multiple primary keys)" \
  contem "$WORK/supabase-admin.txt" 'multiple primary keys for table "users" are not allowed'
check "e o erro de schema_migrations também" \
  contem "$WORK/supabase-admin.txt" 'duplicate key value violates unique constraint "schema_migrations_pkey"'
check "e ainda assim o erro vira aviso, não veredito" \
  contem "$WORK/supabase-admin.txt" "quem decide o veredito é a conferência do resultado"
check "a conferência fecha: 2 tabelas e 3 linhas medidas" \
  contem "$WORK/supabase-admin.txt" "2 tabela(s) de public/auth.users conferidas contra os COPY do dump (3 linha(s))"

echo "o outro lado: a MESMA saída benigna com a conferência acusando problema → rc ≠ 0, sem ✓, e nomeado:"
export DUBLE_CONF_LINHAS="public.contacts|1
auth.users|1"
RC_MENOR="$(rodar_restore "$WORK/menor.txt" supabase_admin)"
unset DUBLE_CONF_LINHAS
check "contagem menor: sai com rc diferente de 0" diferente "$RC_MENOR" 0
check "contagem menor: não imprime '✓ banco restaurado'" nao_contem "$WORK/menor.txt" "✓ banco restaurado"
check "contagem menor: nomeia a tabela, o esperado e o obtido" \
  contem "$WORK/menor.txt" "DIFERENTE public.contacts (esperado 2 linha(s), obtido 1)"
check "contagem menor: o psql imprimiu o mesmo ruído benigno (a conferência é que reprovou)" \
  contem "$WORK/menor.txt" 'multiple primary keys for table "users" are not allowed'
check "contagem menor: nada foi considerado restaurado" \
  contem "$WORK/menor.txt" "NADA foi considerado restaurado"

export DUBLE_CONF_TABELAS="auth.users"
RC_FALTA="$(rodar_restore "$WORK/falta.txt" supabase_admin)"
unset DUBLE_CONF_TABELAS
check "tabela faltando: sai com rc diferente de 0" diferente "$RC_FALTA" 0
check "tabela faltando: não imprime '✓ banco restaurado'" nao_contem "$WORK/falta.txt" "✓ banco restaurado"
check "tabela faltando: nomeia a tabela, o esperado e o obtido" \
  contem "$WORK/falta.txt" "FALTA public.contacts (esperado 2 linha(s), obtido: tabela ausente no banco)"

[ "$FAILS" -eq 0 ] || { echo "✖ $FAILS falha(s)" >&2; exit 1; }
echo "ok: o veredito do restore.sh é a conferência do resultado, não a lista de erros tolerados (#2381)"
