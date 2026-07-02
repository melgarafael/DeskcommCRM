#!/usr/bin/env bash
# Helpers compartilhados pelos scripts do kit. Sourced, não executado direto.
set -euo pipefail

COMPOSE="docker-compose.prod.yml"

c_red() { printf '\033[31m%s\033[0m\n' "$*"; }
c_grn() { printf '\033[32m%s\033[0m\n' "$*"; }
c_ylw() { printf '\033[33m%s\033[0m\n' "$*"; }
die()   { c_red "✖ $*"; exit 1; }
step()  { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }

# Vai pro diretório do projeto (onde está o compose) e carrega o .env.
enter_project() {
  if [ -f "$COMPOSE" ]; then :;
  elif [ -f "deskcommcrm/$COMPOSE" ]; then cd deskcommcrm;
  else die "Não achei $COMPOSE. Rode a partir da pasta do projeto."; fi
  [ -f .env ] || die "Falta o .env (rode install.sh primeiro)."
  set -a; . ./.env; set +a
  PROJECT_DIR="$(pwd)"
}

# psql efêmero via container (não exige psql no host).
psql_run() { docker run --rm -i postgres:17-alpine psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 "$@"; }

# Resolve o UUID de um usuário pelo e-mail (admin API do Supabase).
owner_id_by_email() {
  local email="$1"
  curl -fsS "${NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users?filter=email.eq.${email}" \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" 2>/dev/null \
    | grep -o '"id":"[0-9a-f-]\{36\}"' | head -1 | sed 's/.*:"//;s/"//'
}
