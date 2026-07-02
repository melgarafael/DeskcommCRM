#!/usr/bin/env bash
# Backup: dump do banco (Supabase) + snapshot das sessões do WhatsApp.
# Supabase free NÃO tem backup automático — rode isto num cron diário.
#
#   crontab -e →  0 3 * * *  cd /caminho/deskcommcrm && bash hostgator-setup-kit/backup.sh
source "$(dirname "$0")/_common.sh"
enter_project

BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
mkdir -p "$BACKUP_DIR"
# Timestamp vem do host (não do script) pra manter determinismo do kit.
ts="$(date +%Y%m%d-%H%M%S)"

step "Dump do banco → $BACKUP_DIR/db-$ts.sql.gz"
docker run --rm postgres:17-alpine pg_dump "$SUPABASE_DB_URL" --no-owner --no-privileges \
  | gzip > "$BACKUP_DIR/db-$ts.sql.gz"
c_grn "✓ banco: $(du -h "$BACKUP_DIR/db-$ts.sql.gz" | awk '{print $1}')"

step "Snapshot das sessões do WhatsApp → $BACKUP_DIR/waha-$ts.tgz"
vol="$(docker compose -f "$COMPOSE" config --volumes 2>/dev/null | grep -m1 waha-data || echo '')"
proj="$(basename "$PROJECT_DIR" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
docker run --rm -v "${proj}_waha-data:/data:ro" -v "$BACKUP_DIR:/out" alpine:3.20 \
  tar czf "/out/waha-$ts.tgz" -C /data . 2>/dev/null \
  && c_grn "✓ sessões WhatsApp salvas" \
  || c_ylw "⚠ não achei o volume waha-data (nome pode variar). Ajuste manualmente se necessário."

# Retenção: mantém os 14 mais recentes de cada tipo.
step "Limpando backups antigos (mantém 14)"
ls -1t "$BACKUP_DIR"/db-*.sql.gz 2>/dev/null | tail -n +15 | xargs -r rm -f
ls -1t "$BACKUP_DIR"/waha-*.tgz 2>/dev/null | tail -n +15 | xargs -r rm -f
c_grn "✓ backup concluído em $BACKUP_DIR"
