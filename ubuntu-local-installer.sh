#!/usr/bin/env bash
# DeskcommCRM - Instalador Automático (Local Ubuntu VM)
# Este script prepara a VM, sobe o Supabase local (PostgreSQL + Auth +
# PostgREST + Storage + Realtime), inicializa os serviços da aplicação e cria
# o usuário Admin.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

paint() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
step()  { printf '\n'; paint 32 "▶ $1"; }
error() { printf '\n'; paint 31 "✖ $1"; exit 1; }

step "Verificando dependências do sistema..."
if ! sudo apt-get update; then
  # Um repositório de terceiro quebrado não deve impedir a instalação quando
  # os índices dos repositórios necessários já estão disponíveis localmente.
  # Não usamos AllowInsecureRepositories nem ignoramos assinatura GPG.
  paint 33 "⚠ Um repositório APT externo falhou; vou tentar instalar usando os índices válidos já disponíveis."
fi
sudo apt-get install -y curl git jq openssl iproute2

if ! command -v docker >/dev/null 2>&1; then
  step "Instalando Docker..."
  curl -fsSL https://get.docker.com | sudo sh
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
if [[ "${NODE_MAJOR:-0}" != "22" ]]; then
  step "Instalando Node.js (necessário para CLI do Supabase e scripts locais)..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# Se não estivermos na raiz do projeto, clona e entra nele.
if [ ! -f "package.json" ]; then
  step "Clonando o repositório DeskcommCRM..."
  git clone https://github.com/melgarafael/DeskcommCRM.git
  cd DeskcommCRM
fi

if ! command -v pnpm >/dev/null 2>&1; then
  step "Instalando pnpm 9.15.9..."
  sudo npm install --global pnpm@9.15.9
fi

step "Instalando dependências do projeto..."
pnpm install --frozen-lockfile

step "Inicializando Supabase Local (PostgreSQL e serviços oficiais)..."
# O helper inicia a infraestrutura sem a cadeia histórica quebrada e aplica o
# baseline, que é a fonte de verdade para uma instalação nova.
./scripts/local-supabase.sh start

step "Coletando credenciais do Supabase..."
# Pega as chaves da API geradas dinamicamente
SUPA_STATUS=$(./scripts/local-supabase.sh status)
ANON_KEY=$(printf '%s' "$SUPA_STATUS" | node -e 'let s=""; process.stdin.on("data", c => s += c).on("end", () => process.stdout.write(JSON.parse(s).ANON_KEY || ""))')
SERVICE_ROLE_KEY=$(printf '%s' "$SUPA_STATUS" | node -e 'let s=""; process.stdin.on("data", c => s += c).on("end", () => process.stdout.write(JSON.parse(s).SERVICE_ROLE_KEY || ""))')
DB_URL=$(printf '%s' "$SUPA_STATUS" | node -e 'let s=""; process.stdin.on("data", c => s += c).on("end", () => process.stdout.write(JSON.parse(s).DB_URL || ""))')

[[ -n "$ANON_KEY" && "$ANON_KEY" != "null" ]] || error "Supabase não retornou ANON_KEY"
[[ -n "$SERVICE_ROLE_KEY" && "$SERVICE_ROLE_KEY" != "null" ]] || error "Supabase não retornou SERVICE_ROLE_KEY"
[[ -n "$DB_URL" && "$DB_URL" != "null" ]] || error "Supabase não retornou DB_URL"

# Obtendo o IP local da máquina (VM)
VM_IP=$(hostname -I | awk '{print $1}')
if [ -z "$VM_IP" ]; then
  VM_IP="127.0.0.1"
fi

# O CLI informa 127.0.0.1 porque é a perspectiva do host. Os contêineres da
# aplicação precisam alcançar a porta publicada pelo host usando o IP da VM.
DB_URL="${DB_URL/127.0.0.1/$VM_IP}"

# 3000 é o padrão, mas não deve impedir a instalação quando outra aplicação já
# a utiliza na VM. O operador pode fixar APP_PORT antes de chamar o script.
APP_PORT="${APP_PORT:-3000}"
if command -v ss >/dev/null 2>&1; then
  while ss -ltn | awk '{print $4}' | grep -Eq "(^|:)${APP_PORT}$"; do
    APP_PORT=$((APP_PORT + 1))
  done
fi

# Reescrevendo as URLs para apontar para o IP local (para comunicação Host -> Container)
API_URL="http://$VM_IP:54321"
APP_URL="http://$VM_IP:$APP_PORT"

step "Gerando chaves de segurança..."
CHAVE_CPF=$(openssl rand -base64 32)
CHAVE_WAHA=$(openssl rand -base64 32)
CHAVE_AI=$(openssl rand -base64 32)
INTERNAL_SEC=$(openssl rand -hex 32)
IMPERSONATE_SEC=$(openssl rand -base64 32)
WAHA_HMAC=$(openssl rand -hex 32)
WAHA_KEY="deskcomm-local-key"
WAHA_KEY_HASH=$(echo -n "$WAHA_KEY" | sha512sum | awk '{print $1}')

step "Configurando .env.local (credenciais locais, não versionadas)..."
umask 077
cat <<EOF > .env.local
NODE_ENV=production
NEXT_PUBLIC_SUPABASE_URL=$API_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
SUPABASE_DB_URL=$DB_URL
SUPABASE_DB_ADMIN_URL=$DB_URL

NEXT_PUBLIC_APP_URL=$APP_URL
NEXT_PUBLIC_ADMIN_URL=$APP_URL
WAHA_WEBHOOK_BASE_URL=$APP_URL

INTERNAL_SECRET=$INTERNAL_SEC
IMPERSONATE_COOKIE_SECRET=$IMPERSONATE_SEC
CPF_ENCRYPTION_KEY=$CHAVE_CPF
WAHA_BYO_ENCRYPTION_KEY=$CHAVE_WAHA
AI_CRED_AES_KEY=$CHAVE_AI

WAHA_API_BASE_URL=http://waha:3000
WAHA_API_KEY=$WAHA_KEY
WAHA_API_KEY_SHA512=$WAHA_KEY_HASH
WAHA_HMAC_SECRET=$WAHA_HMAC
WAHA_WEBHOOK_REQUIRE_SIGNATURE=false
WHATSAPP_RESTART_ALL_SESSIONS=True

UPSTASH_REDIS_REST_URL=http://srh:80
UPSTASH_REDIS_REST_TOKEN=deskcomm-local-redis
SRH_TOKEN=deskcomm-local-redis
INTERNAL_CRON_SECRET=$INTERNAL_SEC
LGPD_SIGNING_KEY=$INTERNAL_SEC
APP_PORT=$APP_PORT

SENTRY_DSN=
EOF

step "Subindo os serviços do DeskcommCRM (App, Worker, WAHA, Redis)..."
./scripts/local-stack.sh up

step "Criando usuário Administrador..."
export NEXT_PUBLIC_SUPABASE_URL="$API_URL"
export SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
export OWNER_EMAIL="admin@admin.com"
export OWNER_PASSWORD="AdminPassword123!"
export OWNER_ORG_NAME="Deskcomm Local"
export APP_LOCALE="pt-BR"

# Instala a dependência para rodar o bootstrap e executa
pnpm exec tsx scripts/bootstrap-owner.ts

printf '\n\n\033[32m================================================================\033[0m\n'
paint 32 "✅ Instalação concluída com sucesso!"
echo ""
echo "🌐 Acesse o sistema em: $APP_URL"
echo "🧭 Status: ./scripts/local-stack.sh status"
echo "🛑 Parar:  ./scripts/local-stack.sh down"
echo ""
echo "🔑 Credenciais do Administrador:"
echo "   E-mail: $OWNER_EMAIL"
echo "   Senha:  $OWNER_PASSWORD"
printf '\033[32m================================================================\033[0m\n'
