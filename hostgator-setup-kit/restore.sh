#!/usr/bin/env bash
# Restaura o banco a partir de um dump gerado pelo backup.sh.
# CUIDADO: sobrescreve o schema/dados atuais do banco.
#
#   bash hostgator-setup-kit/restore.sh backups/db-20260702-030000.sql.gz
source "$(dirname "$0")/_common.sh"
enter_project

DUMP="${1:-}"
[ -n "$DUMP" ] && [ -f "$DUMP" ] || die "Uso: restore.sh <arquivo-db-*.sql.gz>"

c_ylw "⚠ Isto vai SOBRESCREVER o banco em $NEXT_PUBLIC_SUPABASE_URL."
read -r -p "Digite 'RESTAURAR' para confirmar: " a
[ "$a" = "RESTAURAR" ] || die "Cancelado."

step "Restaurando $DUMP"
gunzip -c "$DUMP" | pg_container -i postgres:17-alpine psql "$(url_do_schema)" \
  && c_grn "✓ banco restaurado" || die "Falha na restauração — veja o log acima."

# Restaura o estado das sessões do WhatsApp (WAHA) se o snapshot emparelhado existir
WAHA_TAR="${DUMP/db-/waha-}"
WAHA_TAR="${WAHA_TAR%.sql.gz}.tgz"
if [ -f "$WAHA_TAR" ]; then
  step "Restaurando sessões do WhatsApp de $WAHA_TAR"
  vol="$(volume_waha_data)"
  WAHA_DIR="$(cd "$(dirname "$WAHA_TAR")" && pwd)"
  WAHA_FILE="$(basename "$WAHA_TAR")"
  docker run --rm -v "${vol}:/data" -v "${WAHA_DIR}:/in:ro" alpine:3.20 \
    sh -c "rm -rf /data/* && tar xzf /in/${WAHA_FILE} -C /data" \
    && c_grn "✓ sessões do WhatsApp restauradas" || c_ylw "⚠ Falha ao restaurar sessões do WhatsApp"
fi

# Single-server: os anexos voltam junto com o banco (ver backup.sh).
if [ "${SINGLE_SERVER:-0}" = "1" ]; then
  STORAGE_TAR="$(dirname "$DUMP")/storage-$(basename "$DUMP" .sql.gz | sed 's/^db-//').tgz"
  if [ -f "$STORAGE_TAR" ]; then
    step "Restaurando os arquivos anexados de $STORAGE_TAR"
    docker run --rm -v "$(dir_do_supabase)/volumes/storage:/data" \
      -v "$(cd "$(dirname "$STORAGE_TAR")" && pwd):/in:ro" alpine:3.20 \
      sh -c "find /data -mindepth 1 -delete && tar xzf /in/$(basename "$STORAGE_TAR") -C /data" \
      && c_grn "✓ anexos restaurados" \
      || die "Falha ao restaurar os anexos. O banco JÁ foi restaurado: repita o restore."
  else
    c_ylw "⚠ Não achei $(basename "$STORAGE_TAR") ao lado do dump: o banco voltou, os ANEXOS não."
  fi
fi

c_ylw "Reinicie o app: docker compose $(dc_files) restart app"
