#!/usr/bin/env bash
# Restaura uma cópia gerada por backup.sh. Requer confirmação explícita.
# Automação/ensaio: RESTORE_CONFIRM=RESTAURAR bash restore.sh backups/backup-...
source "$(dirname "$0")/_common.sh"
enter_project

BACKUP="${1:-}"
[ -n "$BACKUP" ] && [ -d "$BACKUP" ] || die "Uso: restore.sh <diretório backup-...>"
bash "$(dirname "$0")/backup.sh" --verify "$BACKUP"

validar_tar() {
  if tar tzf "$1" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
    die "Arquivo inseguro no backup: $1"
  fi
}

if [ "${RESTORE_CONFIRM:-}" != "RESTAURAR" ]; then
  c_ylw "⚠ Isto vai SOBRESCREVER o banco em $NEXT_PUBLIC_SUPABASE_URL e os volumes do compose."
  read -r -p "Digite 'RESTAURAR' para confirmar: " a
  [ "$a" = "RESTAURAR" ] || die "Cancelado."
fi

step "Restaurando banco"
gunzip -c "$BACKUP/database.sql.gz" | docker run --rm -i postgres:17-alpine psql -v ON_ERROR_STOP=1 "$(url_do_schema)" \
  || die "Falha na restauração do banco."

for archive in "$BACKUP"/volumes/*.tgz; do
  [ -e "$archive" ] || continue
  validar_tar "$archive"
  volume="$(basename "$archive" .tgz)"
  docker volume create "$volume" >/dev/null
  docker run --rm -v "${volume}:/data" -v "$BACKUP/volumes:/in:ro" alpine:3.20 \
    sh -c "rm -rf /data/* /data/.[!.]* /data/..?*; tar xzf /in/$(basename "$archive") -C /data" \
    || die "Falha ao restaurar o volume $volume."
done

if [ -f "$BACKUP/storage-objects.tgz" ]; then
  validar_tar "$BACKUP/storage-objects.tgz"
  [ -n "${STORAGE_BACKUP_DIR:-}" ] && [ -d "$STORAGE_BACKUP_DIR" ] \
    || die "Este backup contém objetos Storage: defina STORAGE_BACKUP_DIR antes de restaurar."
  find "$STORAGE_BACKUP_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  tar xzf "$BACKUP/storage-objects.tgz" -C "$STORAGE_BACKUP_DIR"
fi

c_grn "✓ restauração concluída. Reinicie: docker compose $(dc_files) restart"
