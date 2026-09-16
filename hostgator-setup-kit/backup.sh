#!/usr/bin/env bash
# Backup verificável do banco Supabase e volumes persistentes deste compose.
# Uso: bash hostgator-setup-kit/backup.sh [diretório]
# Checagem sem gravar: bash hostgator-setup-kit/backup.sh --verify backups/<timestamp>
source "$(dirname "$0")/_common.sh"
enter_project

if [ "${1:-}" = "--verify" ]; then
  [ -n "${2:-}" ] && [ -d "$2" ] || die "Uso: backup.sh --verify <diretório-do-backup>"
  [ -f "$2/manifest.env" ] || die "Backup sem manifest.env."
  [ -f "$2/SHA256SUMS" ] || die "Backup sem SHA256SUMS."
  (cd "$2" && sha256sum -c SHA256SUMS && gzip -t database.sql.gz) || die "Backup inválido."
  schemas="$(sed -n 's/^schemas=//p' "$2/manifest.env")"
  volumes="$(sed -n 's/^volumes=//p' "$2/manifest.env")"
  storage_objects="$(sed -n 's/^storage_objects=//p' "$2/manifest.env")"
  [ -n "${schemas:-}" ] && [ -n "${volumes:-}" ] && [ -n "${storage_objects:-}" ] \
    || die "Manifesto de backup incompleto."
  if [ "$volumes" != nenhum ]; then
    for volume in $volumes; do [ -f "$2/volumes/$volume.tgz" ] || die "Volume listado sem snapshot: $volume"; done
  fi
  if [ "${ADVOMAX_DEPLOYMENT_MODE:-false}" = true ]; then
    [ "$schemas" = "public auth storage" ] || die "Backup comercial sem schemas auth/storage."
    [ "$storage_objects" = included ] || die "Backup comercial sem objetos Storage."
  fi
  c_grn "✓ integridade conferida: $2"
  exit 0
fi

BACKUP_DIR="${1:-${BACKUP_DIR:-$PROJECT_DIR/backups}}"
mkdir -p "$BACKUP_DIR"
ts="$(date -u +%Y%m%d-%H%M%S)"
out="$BACKUP_DIR/backup-$ts"
mkdir -p "$out/volumes"
complete=false
cleanup_partial() {
  [ "$complete" = true ] || rm -rf -- "$out"
}
trap cleanup_partial EXIT INT TERM

# Public é sempre necessário. auth/storage entram quando existem e a role do
# schema consegue vê-los (Supabase self-hosted/admin); instalações gerenciadas
# sem esses privilégios ainda produzem um backup restaurável do app.
schemas="public"
for schema in auth storage; do
  if docker run --rm postgres:17-alpine psql "$(url_do_schema)" -tAc \
    "select has_schema_privilege(current_user, '$schema', 'USAGE')" 2>/dev/null | grep -qx t; then
    schemas="$schemas $schema"
  fi
done
if [ "${ADVOMAX_DEPLOYMENT_MODE:-false}" = true ] && [ "$schemas" != "public auth storage" ]; then
  die "Modo comercial exige backup dos schemas auth e storage; a role atual não os permite."
fi
args=()
for schema in $schemas; do args+=("--schema=$schema"); done

step "Dump Supabase (${schemas})"
docker run --rm postgres:17-alpine pg_dump "$(url_do_schema)" --no-owner --no-privileges "${args[@]}" \
  | gzip > "$out/database.sql.gz"

step "Snapshot dos volumes persistentes"
volumes=""
container_ids="$(dc ps -q 2>/dev/null || true)"
if [ -n "$container_ids" ]; then
  volume_names="$(docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}' $container_ids | sort -u)"
else
  volume_names=""
fi
for volume in $volume_names; do
  docker run --rm -v "${volume}:/data:ro" -v "$out/volumes:/out" alpine:3.20 \
    tar czf "/out/${volume}.tgz" -C /data .
  volumes="${volumes}${volumes:+ }${volume}"
done

# Storage externo (S3/MinIO/Supabase gerenciado) não mora em volume Docker.
# Quem usa filesystem pode apontar o diretório de objetos para ele sem copiar
# credenciais para este script.
if [ -n "${STORAGE_BACKUP_DIR:-}" ]; then
  [ -d "$STORAGE_BACKUP_DIR" ] || die "STORAGE_BACKUP_DIR não existe: $STORAGE_BACKUP_DIR"
  tar czf "$out/storage-objects.tgz" -C "$STORAGE_BACKUP_DIR" .
elif [ "${ADVOMAX_DEPLOYMENT_MODE:-false}" = true ]; then
  die "Modo comercial exige STORAGE_BACKUP_DIR com uma exportação local dos objetos Storage."
fi

(
  printf 'schemas=%s\n' "$schemas"
  printf 'volumes=%s\n' "${volumes:-nenhum}"
  printf 'storage_objects=%s\n' "$( [ -f "$out/storage-objects.tgz" ] && echo included || echo absent )"
) > "$out/manifest.env"
(cd "$out" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
bash "$(dirname "$0")/backup.sh" --verify "$out"
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name 'backup-*' -mtime +"${RETENTION_DAYS:-14}" -exec rm -rf {} +
complete=true
trap - EXIT INT TERM
c_grn "✓ backup concluído em $out"
