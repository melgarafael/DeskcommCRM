#!/usr/bin/env bash
# Dois `backup.sh` no MESMO segundo, na MESMA pasta: um publica o dump que acabou
# de validar e o outro, que ainda tem o mesmo `.parcial` aberto para escrita,
# escreve por cima dele — o arquivo publicado deixa de passar no `gzip -t`
# (#4222).
#
#   bash tests/shell/backup-concorrente-nao-corrompe.test.sh
#
# O defeito: o timestamp vem do host com precisão de segundo
# (`date +%Y%m%d-%H%M%S`) e o nome do arquivo em construção sai dele. O cron
# diário e o backup de segurança do `update.sh` são DOIS caminhos para este
# script; no mesmo segundo os dois abrem `.db-<ts>.sql.gz.parcial`, e o `mv` de
# um conserva o inode que o outro já abriu para escrita.
#
# O dublê de `gzip` segura o processo B parado DEPOIS de o shell abrir o destino
# (o redirecionamento acontece antes de o gzip existir) e ANTES de escrever —
# a intercalação medida na issue. O conserto é um `flock` sobre arquivo de lock
# NO diretório de destino, com o lock cobrindo validação + `mv`.
#
# Nada aqui toca docker, gzip do dump real nem a pasta de backups de produção:
# tudo acontece num projeto descartável dentro de `mktemp -d`.
set -uo pipefail
unset COMPOSE_PROJECT_NAME

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KIT_DIR="$ROOT/hostgator-setup-kit"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() {  # check <descrição> <comando...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}
nao_tem() { ! grep -q "$2" "$1"; }
parciais() { find "$1/backups" -maxdepth 1 -name '*.parcial' -print -quit 2>/dev/null; }

REAL_DATE="$(command -v date)"
REAL_GZIP="$(command -v gzip)"
REAL_TAR="$(command -v tar)"
REAL_AWK="$(command -v awk)"

# ── Dublês ───────────────────────────────────────────────────────────────────
export PROVA_DIR="$WORK"
export PROVA_WAHA="$WORK/waha"
mkdir -p "$WORK/bin" "$WORK/waha"
printf 'sessão sintética\n' > "$WORK/waha/sessao.txt"

# Timestamp fixo: é o "mesmo segundo" do defeito, sem depender do relógio.
cat > "$WORK/bin/date" <<STUB
#!/usr/bin/env bash
[ "\${1:-}" = '+%Y%m%d-%H%M%S' ] && { printf '%s\n' "\${PROVA_TIMESTAMP:?}"; exit 0; }
exec "$REAL_DATE" "\$@"
STUB

# Segura B na janela entre "o shell abriu o destino" e "o gzip escreveu".
cat > "$WORK/bin/gzip" <<STUB
#!/usr/bin/env bash
if [ "\$#" -eq 0 ] && [ "\${PROVA_EXECUCAO:-}" = B ]; then
  : > "\$PROVA_DIR/b-abriu-o-parcial"
  while [ ! -f "\$PROVA_DIR/libera-b" ]; do sleep 0.05; done
fi
exec "$REAL_GZIP" "\$@"
STUB

cat > "$WORK/bin/docker" <<STUB
#!/usr/bin/env bash
set -uo pipefail
case " \$* " in
  *" pg_dump "*)
    [ "\${PROVA_FALHA:-0}" = 1 ] && { printf '%s\n' '-- dump interrompido'; exit 1; }
    if [ "\${PROVA_EXECUCAO:-A}" = A ]; then
      "$REAL_AWK" 'BEGIN { for (i = 1; i <= 4000; i++) printf "INSERT INTO exemplo VALUES (%d);\n", i }'
    else
      printf '%s\n' '-- dump curto'
    fi
    exit 0 ;;
  *" tar czf - "*)
    exec "$REAL_TAR" czf - -C "$PROVA_WAHA" . ;;
esac
exit 0
STUB
chmod +x "$WORK/bin/date" "$WORK/bin/gzip" "$WORK/bin/docker"
export PATH="$WORK/bin:$PATH"

# ── Fixture: uma instalação descartável por caso ─────────────────────────────
projeto() {  # projeto <nome> → imprime o caminho
  local p="$WORK/$1"
  mkdir -p "$p"
  : > "$p/docker-compose.prod.yml"
  printf '%s\n' \
    'SINGLE_SERVER="0"' \
    'SUPABASE_DB_URL="postgresql://postgres@banco.example/postgres"' > "$p/.env"
  printf '%s\n' "$p"
}

backup() {  # backup <projeto> <log> [VAR=valor...]
  local p="$1" log="$2"
  shift 2
  ( cd "$p" && env "$@" bash "$KIT_DIR/backup.sh" ) > "$log" 2>&1
}

espera_marcador() {  # espera_marcador <pid> <arquivo>
  local i=0
  while [ ! -f "$2" ]; do
    kill -0 "$1" 2>/dev/null || return 1
    sleep 0.05
    i=$((i + 1))
    [ "$i" -gt 600 ] && return 1
  done
  return 0
}

# ── 1. O defeito da issue: B abre o `.parcial`, A começa no mesmo segundo ────
echo "dois backups no MESMO segundo (B abre o .parcial e para; A começa depois):"
P="$(projeto concorrente)"
TS="20261107-030000"
rm -f "$WORK/libera-b" "$WORK/b-abriu-o-parcial"
backup "$P" "$WORK/b.log" PROVA_EXECUCAO=B PROVA_TIMESTAMP="$TS" &
B=$!
check "B chegou a abrir o arquivo parcial (o cenário existe)" espera_marcador "$B" "$WORK/b-abriu-o-parcial"
backup "$P" "$WORK/a.log" PROVA_EXECUCAO=A PROVA_TIMESTAMP="$TS"; rc_a=$?
: > "$WORK/libera-b"
wait "$B"; rc_b=$?

check "A termina com 0 — o cron não pode falhar por causa da trava" test "$rc_a" -eq 0
check "A diz que já há backup em curso e não toca em arquivo nenhum" \
  grep -q 'outro backup em curso' "$WORK/a.log"
check "B termina com 0 e publica o dump dele" test "$rc_b" -eq 0
n="$(ls -1 "$P"/backups/db-*.sql.gz 2>/dev/null | wc -l)"
check "só UM dump foi publicado (A não criou um segundo)" test "$n" -eq 1
arq="$(ls -1 "$P"/backups/db-*.sql.gz 2>/dev/null | head -1 || true)"
if [ -n "$arq" ]; then
  check "o dump publicado continua passando no gzip -t" "$REAL_GZIP" -t "$arq"
else
  check "o dump publicado existe" false
fi
check "não sobrou arquivo .parcial na pasta" test -z "$(parciais "$P")"

# O controle do conserto: o lock é liberado quando o processo MORRE (die, disco
# cheio, kill). Um lock preso por um backup que morreu pararia o cron em
# silêncio — o oposto do que a trava existe para fazer.
echo "lock liberado depois de erro (pg_dump morre no meio):"
P2="$(projeto erro)"
backup "$P2" "$WORK/erro.log" PROVA_FALHA=1 PROVA_TIMESTAMP=20261107-030100; rc_e=$?
check "o backup que falha sai != 0 e diz por quê" grep -q 'falhou no meio' "$WORK/erro.log"
check "e sai com erro de verdade" test "$rc_e" -ne 0
backup "$P2" "$WORK/depois.log" PROVA_TIMESTAMP=20261107-030101; rc_d=$?
check "o backup seguinte roda e sai 0 (a trava não ficou presa)" test "$rc_d" -eq 0
check "o seguinte não foi barrado pela trava" nao_tem "$WORK/depois.log" 'outro backup em curso'
check "e publica um dump válido" "$REAL_GZIP" -t "$P2/backups/db-20261107-030101.sql.gz"

# Dois backups em SEQUÊNCIA continuam funcionando: a trava não é um "uma vez
# por pasta", é por execução.
echo "dois backups em sequência, na mesma pasta:"
P3="$(projeto sequencial)"
for ts in 20261107-030200 20261107-030201; do
  backup "$P3" "$WORK/seq-$ts.log" PROVA_TIMESTAMP="$ts"; rc=$?
  check "backup sequencial $ts sai 0" test "$rc" -eq 0
  check "backup sequencial $ts publica dump válido" "$REAL_GZIP" -t "$P3/backups/db-$ts.sql.gz"
done
n="$(ls -1 "$P3"/backups/db-*.sql.gz 2>/dev/null | wc -l)"
check "os dois dumps ficaram na pasta" test "$n" -eq 2

# O caminho do `update.sh`: ele exige um backup DESTE momento antes de mexer no
# banco, então espera a trava em vez de sair dizendo "alguém já está fazendo".
echo "com BACKUP_ESPERA_LOCK, o backup espera a trava e publica o dele:"
P4="$(projeto espera)"
rm -f "$WORK/libera-b" "$WORK/b-abriu-o-parcial"
backup "$P4" "$WORK/b4.log" PROVA_EXECUCAO=B PROVA_TIMESTAMP=20261107-030300 &
B4=$!
check "B4 abriu o arquivo parcial" espera_marcador "$B4" "$WORK/b-abriu-o-parcial"
backup "$P4" "$WORK/a4.log" PROVA_EXECUCAO=A BACKUP_ESPERA_LOCK=60 PROVA_TIMESTAMP=20261107-030301 &
A4=$!
sleep 0.5
: > "$WORK/libera-b"
wait "$A4"; rc_a4=$?
wait "$B4"; rc_b4=$?
check "quem esperou sai 0 e não foi barrado" test "$rc_a4" -eq 0
check "quem esperou não disse 'outro backup em curso'" nao_tem "$WORK/a4.log" 'outro backup em curso'
check "B4 sai 0" test "$rc_b4" -eq 0
check "o dump de quem esperou existe e é válido" \
  "$REAL_GZIP" -t "$P4/backups/db-20261107-030301.sql.gz"
check "o dump de B4 existe e é válido" \
  "$REAL_GZIP" -t "$P4/backups/db-20261107-030300.sql.gz"

[ "$FAILS" -eq 0 ] || { echo "✖ $FAILS falha(s)" >&2; exit 1; }
echo 'ok: dois backups simultâneos na mesma pasta não se corrompem; a trava é liberada em erro e não atrapalha backups em sequência'
