#!/usr/bin/env bash
# Prova que DOIS backup.sh no MESMO segundo e na MESMA pasta não se atropelam.
#
#   bash tests/shell/backup-concorrente.test.sh
#
# O defeito (#4222): o `.parcial` tinha nome FIXO por segundo e o `mv` preserva
# o inode. Duas execuções no mesmo segundo — o cron diário e o backup de
# segurança do update.sh — abriam o MESMO arquivo; o perdedor da corrida
# continuava escrevendo no inode que o vencedor já tinha publicado, e o dump
# podia deixar de passar no `gzip -t` DEPOIS de aprovado.
#
# Aqui `date` é dublê (os dois rodam no mesmo segundo, de propósito) e `docker`
# é dublê (o dump A e o dump B são distinguíveis; o snapshot do WhatsApp segura
# a primeira execução viva enquanto a segunda começa). Nada toca o docker real,
# o banco ou o stack do CRM.
#
# Três provas:
#   (a) o arquivo publicado SEMPRE passa no `gzip -t`, inclusive no meio da
#       segunda execução;
#   (b) a segunda execução não escreve no arquivo que a primeira publicou
#       (sha e inode intactos enquanto ela roda — o lock a segura na porta);
#   (c) falha simulada no meio do dump: rc≠0, definitivo anterior intacto,
#       temporário limpo e lock liberado (a execução seguinte roda normal).
set -uo pipefail
unset COMPOSE_PROJECT_NAME SINGLE_SERVER PSQL_DOCKER_NETWORK \
  BACKUP_LOCK_FILE BACKUP_LOCK_WAIT BACKUP_DIR

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KIT_DIR="$ROOT/hostgator-setup-kit"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
TMPDIR="$WORK/tmp"
export TMPDIR
mkdir -p "$TMPDIR"
P1=""; P2=""
trap 'for p in $P1 $P2; do kill "$p" 2>/dev/null; done; rm -rf "$WORK"' EXIT

FAILS=0
check() {  # check <descrição> <comando...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}
sha() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }
modo() { stat -c '%i' "$1" 2>/dev/null || stat -f '%i' "$1"; }
um_dump() {  # um_dump <arquivo> — 3000 linhas de UM dump só (A ou B, sem mistura)
  gzip -dc "$1" 2>/dev/null \
    | awk '/^DUMP-/{n++; v=substr($0,6,1); seen[v]=1} END{exit !(n==3000 && length(seen)==1)}'
}

REAL_DATE="$(command -v date)"
REAL_TAR="$(command -v tar)"

# ── Dublês ───────────────────────────────────────────────────────────────────
FLAGS="$WORK/flags"
mkdir -p "$FLAGS" "$WORK/bin"
TSFILE="$WORK/ts"
printf '20260101-000000\n' > "$TSFILE"

# date: só o formato do carimbo do backup é fixo; o resto vai para o date real.
{
  printf '#!/usr/bin/env bash\nREAL_DATE=%q\nTSFILE=%q\n' "$REAL_DATE" "$TSFILE"
  cat <<'STUB'
case "$*" in
  "+%Y%m%d-%H%M%S") cat "$TSFILE" ;;
  *) exec "$REAL_DATE" "$@" ;;
esac
STUB
} > "$WORK/bin/date"
chmod +x "$WORK/bin/date"

# O tgz "de sessão" que o dublê do docker devolve: um tar de verdade, com um
# arquivo dentro (o `tar_tem_sessao` reprova um tar vazio).
mkdir -p "$WORK/sessoes/noweb"
head -c 2048 /dev/urandom > "$WORK/sessoes/noweb/waha.sqlite3"
"$REAL_TAR" czf "$WORK/waha.tgz" -C "$WORK/sessoes" .

{
  printf '#!/usr/bin/env bash\nFLAGS=%q\nWAHA_TGZ=%q\n' "$FLAGS" "$WORK/waha.tgz"
  cat <<'STUB'
set -uo pipefail
case " $* " in
  *" pg_dump "*)
    printf '%s\n' "$*" >> "$FLAGS/dump-calls"
    [ -f "$FLAGS/dump-fail" ] && { printf 'cortado-no-meio'; exit 1; }
    cat "$FLAGS/dump-corpo"
    exit 0 ;;
  *" tar czf - "*)
    # Segura a PRIMEIRA execução viva (já publicou o dump) enquanto a segunda
    # começa: as duas ficam concorrentes no mesmo segundo.
    if [ -f "$FLAGS/waha-gate" ]; then
      n=0
      while [ -f "$FLAGS/waha-gate" ] && [ "$n" -lt 600 ]; do sleep 0.05; n=$((n + 1)); done
    fi
    cat "$WAHA_TGZ"; exit 0 ;;
esac
exit 0
STUB
} > "$WORK/bin/docker"
chmod +x "$WORK/bin/docker"
PATH="$WORK/bin:$PATH"
export PATH

# ── Instalação falsa ─────────────────────────────────────────────────────────
PROJ="$WORK/Projeto"
mkdir -p "$PROJ"
: > "$PROJ/docker-compose.prod.yml"
printf '%s\n' 'SUPABASE_DB_URL="postgresql://postgres:***@supabase-db:5432/postgres"' > "$PROJ/.env"
mkdir -p "$PROJ/backups"

# Dois conteúdos de dump distinguíveis, grandes o bastante para uma escrita
# truncada não passar no `gzip -t`.
{
  i=1
  while [ "$i" -le 3000 ]; do printf 'DUMP-A linha %05d de enchimento\n' "$i"; i=$((i + 1)); done
} > "$FLAGS/dump-a"
{
  i=1
  while [ "$i" -le 3000 ]; do printf 'DUMP-B linha %05d de enchimento\n' "$i"; i=$((i + 1)); done
} > "$FLAGS/dump-b"
cp "$FLAGS/dump-a" "$FLAGS/dump-corpo"

backup() {  # backup <log> — roda backup.sh como o cron/update.sh rodam
  ( cd "$PROJ" && BACKUP_LOCK_WAIT=20 bash "$KIT_DIR/backup.sh" ) > "$1" 2>&1
}

# ── (a)+(b) duas execuções concorrentes no mesmo segundo ─────────────────────
echo "duas execuções no mesmo segundo (carimbo 20260101-000000):"
: > "$FLAGS/waha-gate"          # a primeira para DEPOIS de publicar o dump
backup "$WORK/p1.log" & P1=$!
publicado="$PROJ/backups/db-20260101-000000.sql.gz"
n=0
while [ ! -f "$publicado" ] && [ "$n" -lt 600 ]; do sleep 0.05; n=$((n + 1)); done
check "a primeira execução publicou db-20260101-000000.sql.gz" test -f "$publicado"
check "e o publicado passa no gzip -t" gzip -t "$publicado"
sha_antes="$(sha "$publicado")"
ino_antes="$(modo "$publicado")"

cp "$FLAGS/dump-b" "$FLAGS/dump-corpo"
backup "$WORK/p2.log" & P2=$!

# Espera a segunda chegar ao ponto de perigo: ou ela já publicou por cima
# (código antigo, sem lock), ou ela anunciou que está esperando o lock (novo).
n=0
while [ "$n" -lt 600 ]; do
  [ "$(sha "$publicado")" != "$sha_antes" ] && break
  grep -q 'outro backup está rodando' "$WORK/p2.log" 2>/dev/null && break
  sleep 0.05; n=$((n + 1))
done

# As duas ainda estão vivas (a segunda publica o dump e para no passo seguinte);
# o publicado tem de continuar sendo, byte a byte, o da primeira.
check "no meio da segunda, o arquivo do primeiro não foi tocado (sha)" \
  test "$(sha "$publicado")" = "$sha_antes"
check "no meio da segunda, o inode do primeiro não foi reaberto" \
  test "$(modo "$publicado")" = "$ino_antes"
check "a segunda disse que espera o lock (política declarada)" \
  grep -q 'outro backup está rodando' "$WORK/p2.log"

# Libera as duas: a primeira termina, a segunda (que esperava) segue.
rm -f "$FLAGS/waha-gate"
wait "$P1"; rc1=$?
wait "$P2"; rc2=$?
P1=""; P2=""
check "a primeira termina bem (rc=0)" test "$rc1" -eq 0
check "a segunda termina bem (rc=0)" test "$rc2" -eq 0
check "as duas usaram o MESMO segundo (mesmo nome final)" \
  bash -c 'grep -q "db-20260101-000000.sql.gz" "$1" && grep -q "db-20260101-000000.sql.gz" "$2"' \
  _ "$WORK/p1.log" "$WORK/p2.log"
[ "$rc1" -eq 0 ] || sed 's/^/    | /' "$WORK/p1.log"
[ "$rc2" -eq 0 ] || sed 's/^/    | /' "$WORK/p2.log"

check "no fim, o publicado passa no gzip -t" gzip -t "$publicado"
check "o publicado é UMA execução inteira (sem mistura de dumps)" um_dump "$publicado"
check "e é o conteúdo da segunda (B), não um resto da primeira" \
  bash -c 'gzip -dc "$1" | grep -q "^DUMP-B"' _ "$publicado"
check "nenhum temporário fica na pasta de dumps" \
  bash -c '! find "$1" -maxdepth 1 -name ".db-*" -print -quit | grep -q .' _ "$PROJ/backups"

# ── (c) falha simulada: definitivo anterior intacto, temporário limpo ────────
echo "falha simulada no meio do dump (carimbo 20260102-030000):"
printf '20260102-030000\n' > "$TSFILE"
sha_antigo="$(sha "$publicado")"
: > "$FLAGS/dump-fail"
cp "$FLAGS/dump-a" "$FLAGS/dump-corpo"
backup "$WORK/p3.log"; rc3=$?
check "a execução que falha sai rc≠0" test "$rc3" -ne 0
check "o erro diz que o arquivo incompleto foi removido" \
  grep -q 'removi o arquivo incompleto' "$WORK/p3.log"
check "o dump anterior continua intacto (sha)" test "$(sha "$publicado")" = "$sha_antigo"
check "o dump anterior continua passando no gzip -t" gzip -t "$publicado"
check "o dump da execução que falhou não existe" \
  test ! -e "$PROJ/backups/db-20260102-030000.sql.gz"
check "o temporário da execução que falhou foi removido" \
  bash -c '! find "$1" -maxdepth 1 -name ".db-*" -print -quit | grep -q .' _ "$PROJ/backups"

# O lock morre com o processo: a execução seguinte não herda trava nenhuma.
echo "execução seguinte, depois da falha (carimbo 20260102-040000):"
printf '20260102-040000\n' > "$TSFILE"
rm -f "$FLAGS/dump-fail"
backup "$WORK/p4.log"; rc4=$?
check "o lock não ficou preso: a execução seguinte termina bem" test "$rc4" -eq 0
[ "$rc4" -eq 0 ] || sed 's/^/    | /' "$WORK/p4.log"
check "e publica o dump dela, conferido" gzip -t "$PROJ/backups/db-20260102-040000.sql.gz"

[ "$FAILS" -eq 0 ] || { echo "✖ $FAILS falha(s)" >&2; exit 1; }
echo 'ok: dois backup.sh no mesmo segundo não se atropelam — lock serializa, temporário é único e o publicado só muda por mv de arquivo conferido'
