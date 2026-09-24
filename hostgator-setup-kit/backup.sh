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
# Pela conexão de SCHEMA (url_do_schema), não pela do app: `pg_dump` só despeja
# o que a role enxerga, e com uma role menor — a que recomendamos no `.env` de
# quem usa Supabase próprio — o backup sai PARCIAL e sai verde. Falha silenciosa
# de backup é a pior das falhas: só aparece na hora de restaurar.
pg_container postgres:17-alpine pg_dump "$(url_do_schema)" --no-owner --no-privileges \
  | gzip > "$BACKUP_DIR/db-$ts.sql.gz"
c_grn "✓ banco: $(du -h "$BACKUP_DIR/db-$ts.sql.gz" | awk '{print $1}')"

step "Snapshot das sessões do WhatsApp → $BACKUP_DIR/waha-$ts.tgz"
vol="$(volume_waha_data)"
docker run --rm -v "${vol}:/data:ro" -v "$BACKUP_DIR:/out" alpine:3.20 \
  tar czf "/out/waha-$ts.tgz" -C /data . 2>/dev/null \
  && c_grn "✓ sessões WhatsApp salvas" \
  || c_ylw "⚠ não achei o volume waha-data (nome pode variar). Ajuste manualmente se necessário."

# Single-server: os ANEXOS (fotos, documentos) moram no disco desta VPS, no
# Storage do Supabase (STORAGE_BACKEND=file) — o dump acima leva só as linhas
# que apontam para eles. Sem este passo o backup dizia "concluído" e a
# restauração devolvia anexos quebrados. Por isso aqui falha é FALHA.
if [ "${SINGLE_SERVER:-0}" = "1" ]; then
  step "Arquivos anexados (Storage) → $BACKUP_DIR/storage-$ts.tgz"
  docker run --rm -v "$(dir_do_supabase)/volumes/storage:/data:ro" -v "$BACKUP_DIR:/out" alpine:3.20 \
    tar czf "/out/storage-$ts.tgz" -C /data . \
    || die "Não consegui salvar os arquivos anexados: este backup NÃO está completo."
  c_grn "✓ anexos: $(du -h "$BACKUP_DIR/storage-$ts.tgz" | awk '{print $1}')"
fi

# Retenção: mantém os 14 mais recentes de cada tipo.
step "Limpando backups antigos (mantém 14)"
(ls -1t "$BACKUP_DIR"/db-*.sql.gz 2>/dev/null || true) | tail -n +15 | xargs -r rm -f 2>/dev/null || true
(ls -1t "$BACKUP_DIR"/waha-*.tgz 2>/dev/null || true) | tail -n +15 | xargs -r rm -f 2>/dev/null || true
(ls -1t "$BACKUP_DIR"/storage-*.tgz 2>/dev/null || true) | tail -n +15 | xargs -r rm -f 2>/dev/null || true
c_grn "✓ backup concluído em $BACKUP_DIR"
