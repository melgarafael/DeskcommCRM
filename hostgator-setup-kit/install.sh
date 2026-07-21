#!/usr/bin/env bash
#
# DeskcommCRM — instalador self-host para VPS (HostGator).
#
# Idempotente: pode rodar de novo sem estragar nada. Dependências no host:
# só docker, docker compose, git, openssl, curl. psql/bootstrap rodam via Docker.
#
# Uso:
#   bash install.sh            # interativo (pergunta o que falta)
#   bash install.sh --yes      # não-interativo (usa .env já preenchido)
#
set -euo pipefail

# Diretório onde este script (e _common.sh, seu irmão) vivem — capturado ANTES
# de qualquer 'cd' (step 2 pode entrar num repo clonado à parte).
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

REPO_URL="${REPO_URL:-https://github.com/melgarafael/DeskcommCRM.git}"
REPO_DIR="${REPO_DIR:-deskcommcrm}"
COMPOSE="docker-compose.prod.yml"
NONINTERACTIVE=0
[ "${1:-}" = "--yes" ] && NONINTERACTIVE=1

c_red() { printf '\033[31m%s\033[0m\n' "$*"; }
c_grn() { printf '\033[32m%s\033[0m\n' "$*"; }
c_ylw() { printf '\033[33m%s\033[0m\n' "$*"; }
die()   { c_red "✖ $*"; exit 1; }
step()  { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }

# Pergunta com default. Em modo --yes, exige que já venha do ambiente/.env.
ask() {
  local var="$1" prompt="$2" default="${3:-}" secret="${4:-}"
  local cur="${!var:-}"
  if [ -n "$cur" ]; then return 0; fi
  if [ "$NONINTERACTIVE" = 1 ]; then
    [ -n "$default" ] && { printf -v "$var" '%s' "$default"; return 0; }
    die "Falta $var (modo --yes exige .env preenchido)."
  fi
  local input
  if [ "$secret" = "secret" ]; then
    read -r -s -p "$prompt${default:+ [$default]}: " input; echo
  else
    read -r -p "$prompt${default:+ [$default]}: " input
  fi
  printf -v "$var" '%s' "${input:-$default}"
}

# ── 1. Preflight ────────────────────────────────────────────────────────────
step "Verificando dependências"
for bin in docker git openssl curl; do
  command -v "$bin" >/dev/null 2>&1 || die "'$bin' não encontrado. Instale antes de continuar."
done
docker compose version >/dev/null 2>&1 || die "'docker compose' (v2) não encontrado."
docker info >/dev/null 2>&1 || die "O daemon do Docker não está rodando (ou seu usuário não tem permissão)."
c_grn "✓ docker, git, openssl, curl ok"

# RAM: a imagem é pré-buildada (não builda no VPS), então 2GB rodam. Avisa se <1.5GB.
if [ -r /proc/meminfo ]; then
  mem_kb=$(awk '/MemTotal/{print $2}' /proc/meminfo)
  if [ "$mem_kb" -lt 1500000 ]; then
    c_ylw "⚠ RAM total ~$((mem_kb/1024))MB. Recomendado >=2GB. Adicione swap se ficar apertado."
  fi
fi

# ── 2. Repositório ──────────────────────────────────────────────────────────
step "Localizando o projeto"
if [ -f "$COMPOSE" ]; then
  c_grn "✓ rodando dentro do repositório"
elif [ -f "$REPO_DIR/$COMPOSE" ]; then
  cd "$REPO_DIR"; c_grn "✓ repositório em ./$REPO_DIR"
else
  c_ylw "Clonando $REPO_URL ..."
  git clone --depth 1 "$REPO_URL" "$REPO_DIR"
  cd "$REPO_DIR"
fi
PROJECT_DIR="$(pwd)"
source "$KIT_DIR/_common.sh"

# ── 3. Coleta de config ─────────────────────────────────────────────────────
step "Configuração"
# Se já existe .env, carrega pra não repetir perguntas (idempotência).
if [ -f .env ]; then set -a; . ./.env; set +a; c_grn "✓ .env existente carregado"; fi

ask DOMAIN            "Domínio do CRM (ex: crm.suaempresa.com.br)"
ask ACME_EMAIL        "Seu e-mail (avisos de SSL)"
ask APP_IMAGE         "Imagem Docker do app" "ghcr.io/melgarafael/deskcommcrm:latest"
ask NEXT_PUBLIC_SUPABASE_URL   "Supabase Project URL (Settings > API)"
ask NEXT_PUBLIC_SUPABASE_ANON_KEY "Supabase anon key"
ask SUPABASE_SERVICE_ROLE_KEY  "Supabase service_role key" "" secret
ask SUPABASE_DB_URL   "Supabase DB connection string (Settings > Database)" "" secret
ask ANTHROPIC_API_KEY "Chave da Anthropic (IA)" "" secret
ask OWNER_EMAIL       "E-mail do primeiro admin (dono)"
ask OWNER_PASSWORD    "Senha do primeiro admin" "" secret

# Derivados
NEXT_PUBLIC_APP_URL="https://${DOMAIN}"
NEXT_PUBLIC_ADMIN_URL="https://${DOMAIN}"

# ── 4. Geração de segredos (idempotente: só gera o que falta) ────────────────
step "Gerando segredos"
gen_hex() { openssl rand -hex 32; }
gen_b64() { openssl rand -base64 32; }
: "${INTERNAL_SECRET:=$(gen_hex)}"
: "${INTERNAL_CRON_SECRET:=$(gen_hex)}"
: "${NUVEMSHOP_OAUTH_ENCRYPTION_KEY:=$(gen_hex)}"
: "${CPF_ENCRYPTION_KEY:=$(gen_b64)}"
: "${AI_CRED_AES_KEY:=$(gen_b64)}"
: "${WAHA_BYO_ENCRYPTION_KEY:=$(gen_b64)}"
: "${IMPERSONATE_COOKIE_SECRET:=$(gen_hex)}"
: "${LGPD_SIGNING_KEY:=$(gen_hex)}"
: "${WAHA_HMAC_SECRET:=$(gen_hex)}"
: "${SRH_TOKEN:=$(gen_hex)}"
: "${WAHA_API_KEY:=$(gen_hex)}"
# O container WAHA espera o HASH SHA512 hex; o app envia o plaintext no X-Api-Key.
WAHA_API_KEY_SHA512="$(printf '%s' "$WAHA_API_KEY" | openssl dgst -sha512 -hex | awk '{print $NF}')"
UPSTASH_REDIS_REST_TOKEN="$SRH_TOKEN"
c_grn "✓ segredos prontos"

# ── 5. Escreve .env (600) ───────────────────────────────────────────────────
step "Escrevendo .env"
umask 077
cat > .env <<ENV
# Gerado por install.sh — NÃO comitar. Contém segredos.
APP_IMAGE=${APP_IMAGE}
APP_PULL_POLICY=always
DOMAIN=${DOMAIN}
ACME_EMAIL=${ACME_EMAIL}
NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}
NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY}
SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}
SUPABASE_DB_URL=${SUPABASE_DB_URL}
NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}
NEXT_PUBLIC_ADMIN_URL=${NEXT_PUBLIC_ADMIN_URL}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
AI_GATEWAY_API_KEY=${AI_GATEWAY_API_KEY:-}
INTERNAL_SECRET=${INTERNAL_SECRET}
INTERNAL_CRON_SECRET=${INTERNAL_CRON_SECRET}
NUVEMSHOP_OAUTH_ENCRYPTION_KEY=${NUVEMSHOP_OAUTH_ENCRYPTION_KEY}
CPF_ENCRYPTION_KEY=${CPF_ENCRYPTION_KEY}
AI_CRED_AES_KEY=${AI_CRED_AES_KEY}
WAHA_BYO_ENCRYPTION_KEY=${WAHA_BYO_ENCRYPTION_KEY}
IMPERSONATE_COOKIE_SECRET=${IMPERSONATE_COOKIE_SECRET}
LGPD_SIGNING_KEY=${LGPD_SIGNING_KEY}
WAHA_API_BASE_URL=http://waha:3000
WAHA_WEBHOOK_BASE_URL=http://app:3000
WAHA_API_KEY=${WAHA_API_KEY}
WAHA_API_KEY_SHA512=${WAHA_API_KEY_SHA512}
WAHA_HMAC_SECRET=${WAHA_HMAC_SECRET}
WAHA_IMAGE=${WAHA_IMAGE:-devlikeapro/waha}
WAHA_DEFAULT_ENGINE=${WAHA_DEFAULT_ENGINE:-NOWEB}
UPSTASH_REDIS_REST_URL=http://srh:80
UPSTASH_REDIS_REST_TOKEN=${UPSTASH_REDIS_REST_TOKEN}
SRH_TOKEN=${SRH_TOKEN}
NODE_ENV=production
NUVEMSHOP_ENABLED=false
INTERNAL_AGENT_RUN_STUB=false
OWNER_EMAIL=${OWNER_EMAIL}
OWNER_PASSWORD=${OWNER_PASSWORD}
ENV
chmod 600 .env
c_grn "✓ .env escrito (permissão 600)"

# ── 6. Checagem de DNS ──────────────────────────────────────────────────────
step "Conferindo DNS de ${DOMAIN}"
public_ip="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || echo '')"
resolved="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || echo '')"
if [ -n "$public_ip" ] && [ -n "$resolved" ] && [ "$public_ip" = "$resolved" ]; then
  c_grn "✓ ${DOMAIN} → ${public_ip} (aponta pra este VPS)"
else
  c_ylw "⚠ ${DOMAIN} resolve para '${resolved:-nada}' e o IP deste VPS é '${public_ip:-desconhecido}'."
  c_ylw "  O SSL (Let's Encrypt) só será emitido quando o A-record apontar pra cá."
  [ "$NONINTERACTIVE" = 0 ] && { read -r -p "  Continuar mesmo assim? (s/N) " a; [ "${a:-N}" = "s" ] || die "Ajuste o DNS e rode de novo."; }
fi

# ── 7. Aplica o schema (baseline) no Supabase — via container postgres ───────
step "Aplicando o schema no Supabase (baseline.sql)"
if [ -f supabase/baseline.sql ]; then
  # O baseline é um pg_dump: referencia public.vector, public.citext e gin_trgm_ops
  # (pg_trgm) mas NÃO cria as extensões. Supabase não as habilita no schema public por
  # padrão — criamos aqui, senão o schema quebra no meio (ex.: "type public.vector does
  # not exist"). Idempotente (if not exists).
  docker run --rm postgres:17-alpine psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -c \
    "create extension if not exists vector with schema public; create extension if not exists citext with schema public; create extension if not exists pg_trgm with schema public;" \
    >/dev/null 2>&1 \
    && c_grn "✓ extensões (vector, citext, pg_trgm) habilitadas no public" \
    || c_ylw "⚠ não consegui habilitar as extensões — o schema pode falhar abaixo."
  SCHEMA_LOG="$PROJECT_DIR/baseline-apply.log"
  # Banco novo ou re-execução? Re-aplicar com ON_ERROR_STOP pararia no primeiro
  # "já existe" (ex.: multiple primary keys) e PULARIA o resto do arquivo —
  # inclusive o apêndice com as migrations novas. Banco existente = modo update
  # (mesmo contrato do update.sh); banco novo = ON_ERROR_STOP e falha é FATAL
  # (schema pela metade = app sem RLS).
  has_schema="$(docker run --rm postgres:17-alpine psql "$SUPABASE_DB_URL" -tAc \
    "select 1 from information_schema.tables where table_schema='public' and table_name='organizations' limit 1" 2>/dev/null | tr -d '[:space:]')"

  if [ "$has_schema" = "1" ]; then
    c_ylw "• schema já existe — re-aplicando em modo update (erros 'já existe' são esperados e ficam no log)"
    raw="$(docker run --rm -i -v "$PROJECT_DIR/supabase/baseline.sql:/baseline.sql:ro" \
          postgres:17-alpine psql "$SUPABASE_DB_URL" -q -f /baseline.sql 2>&1 || true)"
    printf '%s\n' "$raw" > "$SCHEMA_LOG"
    benign='already exists|multiple primary keys|multiple default values|is already a member|already a partition'
    unexpected="$(printf '%s\n' "$raw" | grep -iE 'ERROR|FATAL' | grep -viE "$benign" || true)"
    if [ -n "$unexpected" ]; then
      c_ylw "⚠ Erros no banco que NÃO são os esperados (log completo: $SCHEMA_LOG):"
      printf '%s\n' "$unexpected" | head -20
    else
      c_grn "✓ schema re-aplicado (apêndice de migrations incluído)"
    fi
  else
    if docker run --rm -i -v "$PROJECT_DIR/supabase/baseline.sql:/baseline.sql:ro" \
        postgres:17-alpine psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f /baseline.sql \
        > "$SCHEMA_LOG" 2>&1; then
      c_grn "✓ schema aplicado (log: $SCHEMA_LOG)"
    else
      tail -5 "$SCHEMA_LOG"
      die "baseline falhou num banco NOVO — o schema ficaria incompleto (sem RLS). Log completo: $SCHEMA_LOG"
    fi
  fi

  # Verificação real, não wishful thinking: o app precisa das tabelas core.
  n_tables="$(docker run --rm postgres:17-alpine psql "$SUPABASE_DB_URL" -tAc \
    "select count(*) from information_schema.tables where table_schema='public'" 2>/dev/null | tr -d '[:space:]')"
  if [ "${n_tables:-0}" -ge 30 ]; then
    c_grn "✓ verificação: ${n_tables} tabelas no schema public"
  else
    c_ylw "⚠ verificação: só ${n_tables:-0} tabelas no schema public — confira $SCHEMA_LOG"
  fi
else
  c_ylw "⚠ supabase/baseline.sql não encontrado — pulei (aplique o schema manualmente)."
fi

# ── 8. Bootstrap do 1º dono (cria no Auth + promove via psql) ───────────────
step "Criando o primeiro admin (${OWNER_EMAIL})"
# 1) Cria o usuário no Supabase Auth. Se já existe, a API responde 422 — ignoramos
#    (|| true): a re-execução é idempotente, o passo seguinte encontra o usuário.
curl -fsS -X POST "${NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${OWNER_EMAIL}\",\"password\":\"${OWNER_PASSWORD}\",\"email_confirm\":true}" \
  >/dev/null 2>&1 || true

# 2) Resolve o id direto do auth.users e cria org + membership + platform_admin.
#    Resolver o uid DENTRO do SQL evita parsing frágil de JSON e funciona tanto para
#    usuário recém-criado quanto para um que já existia (re-execução).
docker run --rm -i postgres:17-alpine psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 <<SQL \
  && c_grn "✓ dono criado e promovido a super-admin" \
  || die "Não consegui promover o admin. Confira a service_role key, a URL e a connection string do Supabase."
do \$\$
declare v_org uuid; v_uid uuid;
begin
  select id into v_uid from auth.users where email = '${OWNER_EMAIL}';
  if v_uid is null then
    raise exception 'usuário % não encontrado no auth.users (a criação no Auth falhou?)', '${OWNER_EMAIL}';
  end if;
  select id into v_org from public.organizations where slug='minha-empresa';
  if v_org is null then
    insert into public.organizations (slug, display_name, legal_name, created_by)
    values ('minha-empresa','Minha Empresa','Minha Empresa', v_uid) returning id into v_org;
  end if;
  insert into public.user_organizations (user_id, organization_id, role, accepted_at)
  values (v_uid, v_org, 'admin', now())
  on conflict (user_id, organization_id) do update set role='admin', revoked_at=null;
  if not exists (select 1 from public.platform_admins where user_id=v_uid and revoked_at is null) then
    insert into public.platform_admins (user_id, granted_by, scope, reason)
    values (v_uid, v_uid, 'full', 'Bootstrap inicial do self-host');
  end if;
end \$\$;
SQL

# ── 9. Sobe a stack ─────────────────────────────────────────────────────────
step "Puxando a imagem e subindo os serviços"
docker compose -f "$COMPOSE" pull
docker compose -f "$COMPOSE" up -d
c_grn "✓ containers no ar"

# ── 10. Healthcheck ─────────────────────────────────────────────────────────
step "Aguardando o app ficar saudável"
ok=0
for i in $(seq 1 30); do
  if docker compose -f "$COMPOSE" exec -T app node -e "require('net').connect(3000,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; then
    ok=1; break
  fi
  sleep 3
done
[ "$ok" = 1 ] && c_grn "✓ app respondendo" || c_ylw "⚠ app ainda não respondeu. Veja: docker compose -f $COMPOSE logs app"

# ── 11. Automações (cron do drain de eventos) ───────────────────────────────
step "Ativando as automações"
ensure_encryption_key .env
setup_event_log_drain_cron

# ── Final ───────────────────────────────────────────────────────────────────
cat <<DONE

$(c_grn "═══════════════════════════════════════════════════════")
$(c_grn " Instalação concluída!")
$(c_grn "═══════════════════════════════════════════════════════")

  1. Acesse:  https://${DOMAIN}
     (o SSL leva ~1min pra emitir no primeiro acesso)

  2. Faça login com:
       e-mail: ${OWNER_EMAIL}
       senha:  (a que você definiu)
     No 1º login você vai configurar o MFA (tenha o Google Authenticator/Authy à mão).

  3. Conecte o WhatsApp:
       No onboarding, escaneie o QR code com o WhatsApp do seu número.

  Comandos úteis:
    ver logs:      docker compose -f ${COMPOSE} logs -f app
    reiniciar:     docker compose -f ${COMPOSE} restart
    atualizar:     bash hostgator-setup-kit/update.sh
    backup:        bash hostgator-setup-kit/backup.sh

DONE
