#!/usr/bin/env bash
# Gate de release / upgrade de major do AI SDK (regra dura 16): sobe um Postgres
# efêmero (mesma receita do test-db.sh: pgvector + prelude + baseline install) e
# roda scripts/smoke-llm.ts contra o MODELO REAL. Exige ANTHROPIC_API_KEY no env.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${SMOKE_DB_PORT:-54331}"
CONTAINER="deskcomm-smoke-db-$$"
IMAGE="pgvector/pgvector:pg17"

[ -n "${ANTHROPIC_API_KEY:-}" ] || { echo "FATAL: exporte ANTHROPIC_API_KEY (o smoke usa o modelo real)" >&2; exit 1; }

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> subindo $IMAGE como $CONTAINER (porta $PORT)"
docker run -d --rm --name "$CONTAINER" \
  -p "127.0.0.1:${PORT}:5432" \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres "$IMAGE" >/dev/null

ready=0
for _ in $(seq 1 60); do
  docker exec "$CONTAINER" psql -h 127.0.0.1 -U postgres -d postgres -c "select 1" >/dev/null 2>&1 && { ready=1; break; }
  sleep 1
done
[ "$ready" = 1 ] || { echo "FATAL: postgres não ficou pronto em 60s" >&2; exit 1; }

echo "==> prelude + baseline (install, ON_ERROR_STOP=1)"
docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f - < "$ROOT/scripts/selfhost-prelude.sql"
docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f - < "$ROOT/supabase/baseline.sql"

echo "==> smoke contra o modelo real"
# lib/env (importado transitivamente por aes_gcm) valida vars do APP que o
# smoke não usa — placeholders bastam, nada disso é chamado no caminho do LLM.
SMOKE_DB_URL="postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres" \
  NEXT_PUBLIC_SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-https://placeholder.supabase.co}" \
  NEXT_PUBLIC_SUPABASE_ANON_KEY="${NEXT_PUBLIC_SUPABASE_ANON_KEY:-placeholder-anon}" \
  SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-placeholder-service}" \
  pnpm exec tsx "$ROOT/scripts/smoke-llm.ts"
