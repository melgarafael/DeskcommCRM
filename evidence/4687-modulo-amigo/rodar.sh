#!/usr/bin/env bash
# A prova de tela do #4687 numa instalação fresca estilo VPS. Roda na raiz do repo:
#   bash evidence/4687-modulo-amigo/rodar.sh
#
# - Supabase local PRÓPRIO: `project_id` e portas (55xxx) fora dos do CI, que divide
#   a máquina e sobe o stack padrão (543xx) nos runners.
# - Banco = supabase/baseline.sql com ON_ERROR_STOP=1 (o que o install.sh aplica),
#   a chave de cifra dos segredos (o que o install.sh semeia) e scripts/bootstrap-owner.ts.
# - App = e2e:build + next start (produção), sem envs opcionais além do .env.e2e.
# - Receptor de mentira do Amigo em 127.0.0.1:4687 (AMIGO_API_ORIGIN_LOCAL).
# - Playwright no contêiner oficial (a VPS é AlmaLinux; o navegador não instala nela).
# O onboarding da organização é marcado como concluído no banco: instalar módulo é
# passo de quem já usa o produto, e o onboarding tem prova própria.
set -euo pipefail
cd "$(dirname "$0")/../.."
RAIZ=$PWD
E=evidence/4687-modulo-amigo
SB=${SB:-/srv/deskcomm/prova-4687}
PORTA_APP=3687
PORTA_RECEPTOR=4687
CLI_VERSAO=2.117.0

mkdir -p "$SB/supabase/migrations" "$SB/bin"
# Os modelos de e-mail do config.toml são caminhos relativos ao diretório de trabalho.
cp -r supabase/templates "$SB/supabase/"
sed -E -e 's/^project_id = .*/project_id = "prova-4687"/' \
  -e 's/^((shadow_)?port = )54([0-9]{3})/\155\3/' \
  -e 's#http://127.0.0.1:54321#http://127.0.0.1:55321#' \
  supabase/config.toml > "$SB/supabase/config.toml"
# `supabase` no PATH = a CLI fixa, sempre contra o diretório da prova.
cat > "$SB/bin/supabase" <<SHIM
#!/usr/bin/env bash
exec npx --yes supabase@$CLI_VERSAO --workdir "$SB" "\$@"
SHIM
chmod +x "$SB/bin/supabase"
export PATH="$SB/bin:$PATH"

echo "==> Supabase local (prova-4687)"
supabase start -x studio,postgres-meta,edge-runtime,logflare,vector,imgproxy >/tmp/prova-4687-sb.log 2>&1 \
  || { tail -30 /tmp/prova-4687-sb.log; exit 1; }
DB_URL="postgresql://postgres:postgres@127.0.0.1:55322/postgres"
psqlc() { docker run --rm -i --network host postgres:15-alpine psql "$DB_URL" -v ON_ERROR_STOP=1 -q "$@"; }
psqlc <<'SQL'
create schema if not exists extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema public;
create extension if not exists citext with schema public;
create extension if not exists pg_trgm with schema public;
SQL
echo "==> baseline.sql com ON_ERROR_STOP=1"
psqlc -f - < supabase/baseline.sql >/tmp/prova-4687-baseline.log 2>&1 || { tail -20 /tmp/prova-4687-baseline.log; exit 1; }
psqlc -c "insert into private.app_secrets (name, value) values ('nuvemshop_oauth_key', '$(openssl rand -hex 32)') on conflict (name) do nothing;"

echo "==> .env.e2e + dono da instalação"
E2E_PORT=$PORTA_APP bash scripts/gerar-env-e2e.sh
set -a; . ./.env.e2e; set +a
pnpm exec tsx scripts/bootstrap-owner.ts
psqlc -c "update public.organizations set onboarded_at = coalesce(onboarded_at, now());"

echo "==> build de produção"
pnpm e2e:build >/tmp/prova-4687-build.log 2>&1 || { tail -40 /tmp/prova-4687-build.log; exit 1; }

export AMIGO_TOKEN_FICTICIO="tok-ficticio-$(openssl rand -hex 12)"
rm -f "$E/recebido.jsonl"
PORTA=$PORTA_RECEPTOR RECEBIDO="$E/recebido.jsonl" node "$E/receptor.mjs" >/tmp/prova-4687-receptor.log 2>&1 &
RECEPTOR=$!
AMIGO_API_ORIGIN_LOCAL="http://127.0.0.1:$PORTA_RECEPTOR" pnpm exec next start --port $PORTA_APP >/tmp/prova-4687-app.log 2>&1 &
APP=$!
trap 'kill $APP $RECEPTOR 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -fsS -o /dev/null "http://127.0.0.1:$PORTA_APP/login" && break; sleep 2; done

echo "==> Playwright"
PW=$(node -p "require('@playwright/test/package.json').version")
set +e
docker run --rm --network host --ipc host -v "$RAIZ:/repo" -w /repo \
  -e AMIGO_TOKEN_FICTICIO -e OWNER_EMAIL -e OWNER_PASSWORD \
  -e BASE_URL="http://localhost:$PORTA_APP" -e DB_URL="$DB_URL" \
  "mcr.microsoft.com/playwright:v$PW-noble" \
  npx playwright test -c "$E/playwright.config.ts"
STATUS=$?
set -e
echo "==> o que o receptor recebeu"
cat "$E/recebido.jsonl" 2>/dev/null || echo "(nada)"
exit $STATUS
