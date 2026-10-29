#!/usr/bin/env bash
# O restore não pode descobrir um arquivo corrompido depois de escrever o banco
# ou apagar a sessão/anexos anteriores. gzip e tar são REAIS; só o Docker/psql
# é um dublê, e as montagens são pastas descartáveis deste teste.
set -uo pipefail
unset COMPOSE_PROJECT_NAME PSQL_DOCKER_NETWORK REVERSE_PROXY SINGLE_SERVER

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KIT_DIR="$ROOT/hostgator-setup-kit"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export DUBLE_ROOT="$WORK" DUBLE_LOG="$WORK/docker.log"
PROJ="$WORK/projeto"
DUMP="$PROJ/backups/db-20261026-030000.sql.gz"
WAHA="$PROJ/backups/waha-20261026-030000.tgz"
STORAGE="$PROJ/backups/storage-20261026-030000.tgz"
FAILS=0
check() {
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}
igual() { [ "$1" = "$2" ] || { printf '    esperado [%s], veio [%s]\n' "$2" "$1"; return 1; }; }
contem() { grep -qF -- "$2" "$1"; }
nao_contem() { ! grep -qF -- "$2" "$1"; }

mkdir -p "$WORK/bin" "$WORK/fixture"
printf 'sessão do backup\n' > "$WORK/fixture/sessao"
printf 'anexo do backup\n' > "$WORK/fixture/anexo"
tar czf "$WORK/valido.tgz" -C "$WORK/fixture" .

cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$DUBLE_LOG"
case " $* " in
  *"/*conf-tabelas*/"*) printf 'public.contacts\n'; exit 0 ;;
  *"/*conf-linhas*/"*) printf 'public.contacts|1\n'; exit 0 ;;
  *"pg_tables"*) printf '0\n'; exit 0 ;;
  *" psql "*) cat > /dev/null; touch "$DUBLE_ROOT/banco-escrito"; exit 0 ;;
  *" ps -a -q waha "*) printf 'waha-duble\n'; exit 0 ;;
  *" inspect "*) printf 'bind||%s/sessoes\n' "$DUBLE_ROOT"; exit 0 ;;
esac

# Leia as montagens pedidas pelo script e execute o MESMO sh -c, com /data e
# /in mapeados para o scratch. Assim o teste observa o apagamento/extração,
# não apenas a presença de um comando no log.
dados=""; entrada=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -v)
      shift
      case "$1" in
        *:/data) dados="${1%:/data}" ;;
        *:/in:ro) entrada="${1%:/in:ro}" ;;
      esac ;;
    sh)
      shift
      [ "${1:-}" = '-c' ] || exit 91
      shift
      comando="$1"; shift
      # Nunca execute limpeza fora das duas pastas que este teste criou.
      case "$dados" in
        "$DUBLE_ROOT/sessoes") tipo=waha ;;
        "$DUBLE_ROOT/projeto/.runtime/supabase/volumes/storage") tipo=storage ;;
        *) exit 92 ;;
      esac
      [ "$entrada" = "$DUBLE_ROOT/projeto/backups" ] || exit 93
      if [ "${DUBLE_FALHA:-}" = "$tipo" ]; then
        printf 'tar: falha de escrita simulada\n' >&2
        exit 2
      fi
      comando="${comando//\/data/$dados}"
      comando="${comando//\/in/$entrada}"
      exec bash -c "$comando" "$@" ;;
  esac
  shift
done
exit 0
STUB
chmod +x "$WORK/bin/docker"
PATH="$WORK/bin:$PATH"

preparar() {
  rm -rf "$PROJ" "$WORK/sessoes"
  rm -f "$WORK/banco-escrito"
  mkdir -p "$PROJ/backups" "$PROJ/.runtime/supabase/volumes/storage" "$WORK/sessoes"
  : > "$PROJ/docker-compose.prod.yml"
  printf '%s\n' 'SINGLE_SERVER="1"' \
    'SUPABASE_DB_URL="postgresql://postgres@db.exemplo:5432/postgres"' \
    'NEXT_PUBLIC_SUPABASE_URL="https://exemplo.supabase.co"' > "$PROJ/.env"
  printf 'sessão anterior\n' > "$WORK/sessoes/anterior"
  printf 'anexo anterior\n' > "$PROJ/.runtime/supabase/volumes/storage/anterior"
  printf '%s\n' 'COPY public.contacts (id) FROM stdin;' \
    '11111111-1111-1111-1111-111111111111' '\.' | gzip > "$DUMP"
  cp "$WORK/valido.tgz" "$WAHA"
  cp "$WORK/valido.tgz" "$STORAGE"
  : > "$DUBLE_LOG"
}

rodar() {
  RC=0
  ( cd "$PROJ" && printf 'RESTAURAR\n' \
      | DUBLE_FALHA="${1:-}" bash "$KIT_DIR/restore.sh" backups/db-20261026-030000.sql.gz \
    ) > "$WORK/saida" 2>&1 || RC=$?
}

corromper_crc() {
  local tamanho pos byte
  tamanho="$(wc -c < "$1")"
  pos=$((tamanho - 8))
  byte="$(od -An -tu1 -j "$pos" -N1 "$1")"
  printf "\\$(printf '%03o' "$((byte ^ 255))")" \
    | dd of="$1" bs=1 seek="$pos" conv=notrunc 2>/dev/null
}

recusa_antes_de_escrever() {
  local caso="$1" arquivo="$2"
  rodar
  check "$caso: sai com erro" test "$RC" -ne 0
  check "$caso: nomeia o arquivo recusado" contem "$WORK/saida" "$arquivo"
  check "$caso: não chama Docker nem psql" test ! -s "$DUBLE_LOG"
  check "$caso: preserva as sessões anteriores" contem "$WORK/sessoes/anterior" 'sessão anterior'
  check "$caso: preserva os anexos anteriores" contem "$PROJ/.runtime/supabase/volumes/storage/anterior" 'anexo anterior'
}

echo 'arquivos presentes são conferidos antes de qualquer restauração:'
preparar
corromper_crc "$DUMP"
recusa_antes_de_escrever 'dump com CRC inválido' 'db-20261026-030000.sql.gz'

preparar
dd if="$DUMP" of="$WORK/cortado" bs=1 count=20 2>/dev/null
mv "$WORK/cortado" "$DUMP"
recusa_antes_de_escrever 'dump truncado' 'db-20261026-030000.sql.gz'

for tipo in waha storage; do
  preparar
  arquivo="$PROJ/backups/$tipo-20261026-030000.tgz"
  corromper_crc "$arquivo"
  recusa_antes_de_escrever "$tipo com CRC inválido" "$tipo-20261026-030000.tgz"

  preparar
  dd if="$arquivo" of="$WORK/cortado" bs=1 count=20 2>/dev/null
  mv "$WORK/cortado" "$arquivo"
  recusa_antes_de_escrever "$tipo truncado" "$tipo-20261026-030000.tgz"

  preparar
  printf 'gzip íntegro, mas isto não é um tar\n' | gzip > "$arquivo"
  recusa_antes_de_escrever "$tipo com gzip válido e tar inválido" "$tipo-20261026-030000.tgz"
done

echo 'controles: arquivos íntegros e snapshots opcionais ausentes:'
preparar
rodar
check 'arquivos íntegros: sai com zero' igual "$RC" 0
check 'arquivos íntegros: o banco é restaurado' test -f "$WORK/banco-escrito"
check 'arquivos íntegros: a sessão é extraída de verdade' contem "$WORK/sessoes/sessao" 'sessão do backup'
check 'arquivos íntegros: o anexo é extraído de verdade' contem "$PROJ/.runtime/supabase/volumes/storage/anexo" 'anexo do backup'
check 'arquivos íntegros: a sessão anterior é substituída' test ! -f "$WORK/sessoes/anterior"
check 'arquivos íntegros: o anexo anterior é substituído' test ! -f "$PROJ/.runtime/supabase/volumes/storage/anterior"

preparar
rm -f "$WAHA" "$STORAGE"
rodar
check 'sem snapshots opcionais: sai com zero' igual "$RC" 0
check 'sem snapshots opcionais: restaura o banco' test -f "$WORK/banco-escrito"
check 'sem snapshot Storage: mantém o aviso de anexos ausentes' contem "$WORK/saida" 'os ANEXOS não'
check 'sem snapshots opcionais: não limpa sessões' test -f "$WORK/sessoes/anterior"
check 'sem snapshots opcionais: não limpa anexos' test -f "$PROJ/.runtime/supabase/volumes/storage/anterior"

preparar
mkdir -p "$WORK/vazio"
tar czf "$STORAGE" -C "$WORK/vazio" .
rodar
check 'Storage vazio mas íntegro continua sendo restaurável' igual "$RC" 0

# Um tar sem entradas também é válido. O padding pode continuar depois do
# marcador de fim: quem lista o arquivo pode parar ali, mas a conferência não
# pode matar o gunzip com SIGPIPE e recusar um backup íntegro por causa disso.
preparar
{
  tar cf - -T /dev/null
  dd if=/dev/zero bs=1024 count=1024 2>/dev/null
} | gzip > "$STORAGE"
rodar
check 'tar sem entradas com padding longo continua sendo restaurável' igual "$RC" 0

preparar
printf 'SINGLE_SERVER="0"\n' >> "$PROJ/.env"
printf 'snapshot local alheio ao modo nuvem\n' > "$STORAGE"
rodar
check 'modo nuvem não exige o snapshot Storage local' igual "$RC" 0
check 'modo nuvem não altera o Storage local' test -f "$PROJ/.runtime/supabase/volumes/storage/anterior"

echo 'erro de extração depois do pré-voo não termina verde:'
for tipo in waha storage; do
  preparar
  rodar "$tipo"
  check "$tipo: falha de extração sai com erro" test "$RC" -ne 0
  check "$tipo: diz que o banco JÁ foi restaurado" contem "$WORK/saida" 'O banco JÁ foi restaurado'
  check "$tipo: não manda repetir o restore sobre o banco populado" contem "$WORK/saida" 'repetir este script não restaura por cima do banco'
  check "$tipo: não chega à instrução final de reiniciar o app" nao_contem "$WORK/saida" 'Reinicie o app:'
done

[ "$FAILS" -eq 0 ] || { echo "✖ $FAILS falha(s)" >&2; exit 1; }
echo 'ok: restore confere arquivos antes de escrever e falha alto na extração'
