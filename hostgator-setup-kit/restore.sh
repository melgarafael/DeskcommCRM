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
gunzip -c "$DUMP" | docker run --rm -i postgres:17-alpine psql "$SUPABASE_DB_URL" \
  && c_grn "✓ banco restaurado" || die "Falha na restauração — veja o log acima."

c_ylw "Reinicie o app: docker compose -f $COMPOSE restart app"
