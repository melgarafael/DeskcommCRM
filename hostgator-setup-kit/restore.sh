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
gunzip -c "$DUMP" | docker run --rm -i postgres:17-alpine psql "$(url_do_schema)" \
  && c_grn "✓ banco restaurado" || die "Falha na restauração — veja o log acima."

# Restaura o estado das sessões do WhatsApp (WAHA) se o snapshot emparelhado existir
WAHA_TAR="${DUMP/db-/waha-}"
WAHA_TAR="${WAHA_TAR%.sql.gz}.tgz"
if [ -f "$WAHA_TAR" ]; then
  step "Restaurando sessões do WhatsApp de $WAHA_TAR"
  vol="$(dc config --volumes 2>/dev/null | grep -m1 waha-data || echo '')"
  proj="$(basename "$PROJECT_DIR" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
  vol="${vol:-${proj}_waha-data}"
  WAHA_DIR="$(cd "$(dirname "$WAHA_TAR")" && pwd)"
  WAHA_FILE="$(basename "$WAHA_TAR")"
  docker run --rm -v "${vol}:/data" -v "${WAHA_DIR}:/in:ro" alpine:3.20 \
    sh -c "rm -rf /data/* && tar xzf /in/${WAHA_FILE} -C /data" \
    && c_grn "✓ sessões do WhatsApp restauradas" || c_ylw "⚠ Falha ao restaurar sessões do WhatsApp"
fi

c_ylw "Reinicie o app: docker compose $(dc_files) restart app"
