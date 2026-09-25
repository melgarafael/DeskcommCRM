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
# O dump só recebe o nome definitivo depois de conferido — o mesmo padrão
# `.parcial` + `mv` do snapshot do WhatsApp logo abaixo. Duas guardas, dois casos:
#   1. uma etapa do pipe falha (`gzip` morre com disco cheio, `pg_dump` sai ≠0):
#      o `if !` pega o exit e apaga o arquivo cortado — sem ele, o `set -e`
#      abortava ali mesmo e o `db-*.sql.gz` cortado ficava na pasta, dentro da
#      retenção e ao alcance do restore;
#   2. o pipe sai com zero mas o arquivo não se lê: `gzip -t` percorre o arquivo
#      inteiro e confere o CRC. BACKUP QUE NINGUÉM CONSEGUE LER NÃO É BACKUP.
parcial_db="$BACKUP_DIR/.db-$ts.sql.gz.parcial"
if ! pg_container postgres:17-alpine pg_dump "$(url_do_schema)" --no-owner --no-privileges \
     | gzip > "$parcial_db"; then
  rm -f "$parcial_db"
  die "o dump do banco falhou no meio (disco cheio? pg_dump interrompido?) — removi o arquivo incompleto. Sem backup válido, não siga com atualização."
fi
if ! gzip -t "$parcial_db" 2>/dev/null; then
  rm -f "$parcial_db"
  die "o dump do banco saiu corrompido (gzip -t reprovou) — removi o arquivo para ninguém confiar nele. Sem backup válido, não siga com atualização."
fi
mv "$parcial_db" "$BACKUP_DIR/db-$ts.sql.gz"
c_grn "✓ banco: $(du -h "$BACKUP_DIR/db-$ts.sql.gz" | awk '{print $1}') (conferido)"

step "Snapshot das sessões do WhatsApp → $BACKUP_DIR/waha-$ts.tgz"
vol="$(volume_waha_data)"
# O arquivo só recebe o nome definitivo depois de PROVADO que tem sessão dentro.
# Volume errado (ou vazio) renderia um .tgz de ~87 bytes cujo `tar` sai com zero:
# o passo virava "✓ sessões WhatsApp salvas", o arquivo sem valor entrava na
# retenção dos 14 e o pareamento do WhatsApp — o que este snapshot existe para
# poupar — só se dava por perdido no dia do restore.
parcial="$BACKUP_DIR/.waha-$ts.tgz.parcial"
if ! docker run --rm -v "${vol}:/data:ro" -v "$BACKUP_DIR:/out" alpine:3.20 \
       tar czf "/out/${parcial##*/}" -C /data . 2>/dev/null; then
  rm -f "$parcial"
  c_ylw "⚠ não consegui ler o volume das sessões ('$vol'): o backup do banco está feito, mas o pareamento do WhatsApp NÃO entrou nele."
elif ! tar_tem_sessao "$parcial"; then
  rm -f "$parcial"
  c_ylw "⚠ o snapshot das sessões saiu VAZIO — a montagem /app/.sessions do contêiner waha resolveu para '$vol' e não tem sessão gravada. Este backup NÃO salva o pareamento do WhatsApp (o restore vai pedir o QR code de novo). Confira a montagem antes de considerar o backup completo."
else
  mv "$parcial" "$BACKUP_DIR/waha-$ts.tgz"
  c_grn "✓ sessões WhatsApp salvas ($(du -h "$BACKUP_DIR/waha-$ts.tgz" | awk '{print $1}'))"
fi

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
