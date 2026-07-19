#!/usr/bin/env bash
# Backup do Postgres (Supabase) do DeskcommCRM — schema public completo
# (CRM + harness do agente). Roda no host ou num cron da VPS:
#   0 3 * * * /path/repo/scripts/backup-db.sh /var/backups/deskcomm
# Requer: pg_dump no PATH (major compatível) e SUPABASE_DB_URL no .env/.env.local.
set -euo pipefail

DIR="${1:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

URL="${SUPABASE_DB_URL:-}"
if [ -z "$URL" ]; then
  for f in "$ROOT/.env.local" "$ROOT/.env"; do
    if [ -f "$f" ]; then
      URL=$(grep -E '^SUPABASE_DB_URL=' "$f" | head -1 | cut -d= -f2- || true)
      [ -n "$URL" ] && break
    fi
  done
fi
[ -n "$URL" ] || { echo "FATAL: SUPABASE_DB_URL ausente (env ou .env/.env.local)" >&2; exit 1; }

mkdir -p "$DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$DIR/deskcomm-$STAMP.dump"
pg_dump "$URL" --format=custom --schema=public --no-owner --no-privileges --file="$OUT"
echo "backup ok: $OUT ($(du -h "$OUT" | cut -f1))"

# retenção: apaga dumps mais velhos que RETENTION_DAYS
find "$DIR" -name 'deskcomm-*.dump' -mtime +"$RETENTION_DAYS" -delete
echo "retenção aplicada (${RETENTION_DAYS}d)"
