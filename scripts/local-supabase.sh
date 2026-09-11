#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

cli() { npx --yes supabase "$@"; }

json_value() {
  local key="$1"
  node -e 'let s=""; process.stdin.on("data", c => s += c).on("end", () => {
    const v = JSON.parse(s)[process.argv[1]];
    process.stdout.write(v == null ? "" : String(v));
  })' "$key"
}

start_without_legacy_migrations() {
  local backup
  backup="$(mktemp -d "${TMPDIR:-/tmp}/deskcomm-migrations.XXXXXX")"
  restore() {
    if [[ -d "$backup/migrations" ]]; then
      rm -rf supabase/migrations
      mv "$backup/migrations" supabase/migrations
    fi
    rmdir "$backup" 2>/dev/null || true
  }
  trap restore EXIT

  # A cadeia histórica contém migrations fora de ordem e dependências que só
  # existiam no Supabase Cloud. O baseline é o artefato de instalação fresca.
  mv supabase/migrations "$backup/migrations"
  mkdir supabase/migrations
  cli start "$@"
  restore
  trap - EXIT
}

status_json() { cli status -o json; }

apply_baseline() {
  local db_url
  db_url="$(status_json | json_value DB_URL)"
  [[ -n "$db_url" && "$db_url" != "null" ]] || {
    printf 'Supabase não retornou DB_URL.\n' >&2
    return 1
  }
  docker run --rm --network host postgres:15-alpine \
    psql "$db_url" -v ON_ERROR_STOP=1 -c \
    'create extension if not exists "uuid-ossp";
     create extension if not exists pgcrypto;
     create extension if not exists vector;
     create extension if not exists citext;
     create extension if not exists pg_trgm;'
  docker run --rm --network host \
    -v "$ROOT_DIR/supabase/baseline.sql:/tmp/deskcomm-baseline.sql:ro" \
    postgres:15-alpine \
    psql "$db_url" -v ON_ERROR_STOP=1 -f /tmp/deskcomm-baseline.sql
}

case "${1:-}" in
  start)
    start_without_legacy_migrations
    apply_baseline
    ;;
  status)
    status_json
    ;;
  apply-baseline)
    apply_baseline
    ;;
  stop)
    cli stop
    ;;
  *)
    printf 'Uso: %s {start|status|apply-baseline|stop}\n' "$0"
    exit 2
    ;;
esac
