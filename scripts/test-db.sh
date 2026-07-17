#!/usr/bin/env bash
# gov-loop G1-02 — baseline install+update gate + RLS isolation invariants.
#
# Sobe um Postgres efêmero (pgvector/pgvector:pg17), aplica supabase/baseline.sql
# em modo install (ON_ERROR_STOP=1 — qualquer statement falhando derruba o run),
# re-aplica em modo update (sem a flag — idempotência) e roda a suíte vitest de
# invariantes (tests/invariants/**) conectada ao container via `docker exec psql`.
# O container é SEMPRE derrubado no EXIT (sucesso ou falha).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASELINE="$ROOT/supabase/baseline.sql"
PORT="${TEST_DB_PORT:-54329}"
CONTAINER="deskcomm-test-db-$$"
IMAGE="pgvector/pgvector:pg17"

[ -f "$BASELINE" ] || { echo "FATAL: $BASELINE não encontrado" >&2; exit 1; }

cleanup() {
  echo "==> teardown: removendo container $CONTAINER"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> subindo $IMAGE como $CONTAINER (porta local $PORT)"
docker run -d --rm --name "$CONTAINER" \
  -p "127.0.0.1:${PORT}:5432" \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=postgres \
  "$IMAGE" >/dev/null

# Espera o servidor DEFINITIVO (o initdb sobe um temporário só em socket;
# testar via TCP 127.0.0.1 evita o falso-ready da fase de init).
ready=0
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" psql -h 127.0.0.1 -U postgres -d postgres -c "select 1" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "FATAL: postgres não ficou pronto em 60s" >&2; exit 1; }

psql_install() {
  docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f - "$@"
}

echo "==> prelude: stubs mínimos do Supabase (roles, auth.uid(), extensions)"
# Um Postgres cru não tem os roles/schemas do Supabase que o baseline (pg_dump) supõe.
# Criamos os stubs mínimos AQUI — nunca editar o baseline.sql pra isso.
psql_install <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

create schema if not exists auth;
create schema if not exists extensions;

-- O baseline referencia extensions.uuid_generate_v4/gen_random_bytes e os tipos
-- public.vector/public.citext + gin_trgm_ops, mas não cria as extensões (pg_dump).
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema public;
create extension if not exists citext with schema public;
create extension if not exists pg_trgm with schema public;

-- Stubs de storage (o apêndice do baseline cria buckets + policies em storage.objects).
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz not null default now()
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  metadata jsonb,
  created_at timestamptz not null default now()
);

-- Stub de auth.users (FKs do baseline apontam pra cá).
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  created_at timestamptz not null default now()
);

-- Stub de auth.uid() lendo o claim `sub` de request.jwt.claims (mesmo contrato
-- do Supabase; os testes simulam o JWT via set_config).
create or replace function auth.uid() returns uuid
  language sql stable
  as $fn$
    select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
  $fn$;

grant usage on schema auth, extensions, storage to anon, authenticated, service_role;
grant select on auth.users to anon, authenticated, service_role;
SQL

echo "==> modo INSTALL: aplicando baseline.sql com ON_ERROR_STOP=1"
psql_install < "$BASELINE"
echo "    ✓ install ok"

echo "==> modo UPDATE: re-aplicando baseline.sql sem ON_ERROR_STOP (idempotência)"
docker exec -i "$CONTAINER" psql -U postgres -d postgres -q -f - < "$BASELINE" >/dev/null
echo "    ✓ update ok (re-apply terminou; erros tolerados por contrato)"

echo "==> invariantes: vitest (tests/invariants)"
TEST_DB_CONTAINER="$CONTAINER" vitest run --config vitest.db.config.ts

echo "==> test:db verde"
