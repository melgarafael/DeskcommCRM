#!/usr/bin/env bash
#
# Gera o `.env.e2e` — o ambiente da suíte Playwright, apontado para o Supabase
# LOCAL.
#
# ═══ POR QUE ESTE ARQUIVO EXISTE ═══
#
# O `.env.local` de um checkout de trabalho aponta para o Supabase de PRODUÇÃO
# (é com ele que se desenvolve). O `playwright.config.ts` sobe o app com
# `next start`, que carrega `.env.local`. Resultado, medido em 2026-08-06:
# `pnpm test:e2e` escrevia organizações, usuários e agentes de teste **no banco
# real** — o teste passava, e o estrago era invisível.
#
# A saída não é "lembrar de trocar o .env.local antes de testar": é exatamente o
# tipo de disciplina que falha uma vez e ninguém percebe.
#
# ⚠️ ISTO SOZINHO NÃO BASTA. Os scripts de seed liam `.env.local` DIRETO do
# disco, ignorando `process.env` — então nem o env do webServer os alcançava.
# O conserto do outro lado é `scripts/lib/env-de-teste.ts`, que faz `process.env`
# vencer. Os dois juntos é que fecham o caminho.
#
# Uso:
#   pnpm e2e:env                      # (re)cria o .env.e2e
#   pnpm e2e:build && pnpm test:e2e   # build embute NEXT_PUBLIC_*, ver e2e-build.sh
set -uo pipefail
set -e
CHAVE_CPF=""; CHAVE_WAHA=""; CHAVE_AI=""

cd "$(dirname "$0")/.."

# `supabase` do PATH quando existe (é o que o CI instala, via supabase/setup-cli),
# `npx supabase` como plano B para a máquina do dev. Insistir no `npx` custaria um
# download do registry a cada uma das três chamadas abaixo — a CLI não é
# dependência deste projeto.
SUPABASE="supabase"
command -v supabase >/dev/null 2>&1 || SUPABASE="npx supabase"

if ! $SUPABASE status >/dev/null 2>&1; then
  echo "==> O Supabase local não está de pé. Rode 'npx supabase start' antes." >&2
  exit 1
fi

# Chaves de cifra de 32 bytes. Reaproveita as do .env.e2e atual quando ele já
# existe: regenerá-las a cada chamada tornaria ilegível toda credencial que o
# banco de teste já guardou.
if [ -f .env.e2e ]; then
  CHAVE_CPF="$(grep -E '^CPF_ENCRYPTION_KEY=' .env.e2e | cut -d= -f2-)"
  CHAVE_WAHA="$(grep -E '^WAHA_BYO_ENCRYPTION_KEY=' .env.e2e | cut -d= -f2-)"
  CHAVE_AI="$(grep -E '^AI_CRED_AES_KEY=' .env.e2e | cut -d= -f2-)"
fi
[ "${#CHAVE_CPF}" -ge 44 ] || CHAVE_CPF="$(openssl rand -base64 32)"
[ "${#CHAVE_WAHA}" -ge 44 ] || CHAVE_WAHA="$(openssl rand -base64 32)"
[ "${#CHAVE_AI}" -ge 44 ] || CHAVE_AI="$(openssl rand -base64 32)"

ENVOUT="$($SUPABASE status -o env 2>/dev/null)"
ler() { printf '%s\n' "$ENVOUT" | grep "^$1=" | cut -d= -f2- | tr -d '"'; }

API_URL="$(ler API_URL)"
ANON="$(ler ANON_KEY)"
SERVICE="$(ler SERVICE_ROLE_KEY)"

if [ -z "$API_URL" ] || [ -z "$ANON" ] || [ -z "$SERVICE" ]; then
  echo "==> Não consegui ler as chaves do stack local (API_URL/ANON_KEY/SERVICE_ROLE_KEY)." >&2
  exit 1
fi

# Guarda contra o erro que este arquivo existe para impedir. Se o `supabase
# status` devolver um host remoto (config apontada para um projeto linkado, por
# exemplo), falhar aqui é melhor do que gerar um `.env.e2e` que manda a suíte
# para a nuvem — o modo de falha silencioso é o caro.
case "$API_URL" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *)
    echo "==> RECUSADO: o stack local respondeu com uma URL que não é local: $API_URL" >&2
    exit 1
    ;;
esac

cat > .env.e2e <<EOF
# ── Ambiente do E2E — LOCAL, nunca a nuvem ──────────────────────────────────
# GERADO por 'pnpm e2e:env'. Não versionado (.gitignore cobre '.env*').
# Antes de rodar a suíte: pnpm e2e:build && pnpm test:e2e
NEXT_PUBLIC_SUPABASE_URL=$API_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON
SUPABASE_SERVICE_ROLE_KEY=$SERVICE
SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres

# Placeholders: 'next start' roda em NODE_ENV=production, e lib/env.ts exige
# estas vars em produção. As specs não exercitam os serviços por trás delas.
# Local e CI falham pelos mesmos motivos porque leem ESTE arquivo: o workflow
# publica o `.env.e2e` no ambiente do job em vez de redigitar os valores. A
# versão anterior desta linha prometia "valores iguais aos do CI" e eles não
# eram iguais (`e2e-placeholder…` aqui, `ci-placeholder…` lá) — a promessa por
# coincidência durou até a primeira divergência, que custou 8 specs em 401.
INTERNAL_SECRET=e2e-placeholder-nao-e-segredo
# As três abaixo são chaves de CIFRA de verdade: o app exige 32 bytes e recusa
# um rótulo. Medido — com o placeholder, criar credencial de IA devolvia 500
# ("AI_CRED_AES_KEY deve ter exatamente 32 bytes (lido: 21)") e todo run do
# agente morria em \`credential_decrypt_failed\`, o que aparecia como "o modelo
# não respondeu". Geradas na hora: são de teste, não precisam sobreviver.
CPF_ENCRYPTION_KEY=$CHAVE_CPF
WAHA_BYO_ENCRYPTION_KEY=$CHAVE_WAHA
AI_CRED_AES_KEY=$CHAVE_AI
WAHA_API_BASE_URL=http://127.0.0.1:3999
WAHA_API_KEY=e2e-placeholder-nao-e-segredo
WAHA_WEBHOOK_BASE_URL=http://127.0.0.1:3001
UPSTASH_REDIS_REST_URL=http://127.0.0.1:3998
UPSTASH_REDIS_REST_TOKEN=e2e-placeholder-nao-e-segredo
NEXT_TELEMETRY_DISABLED=1
EOF

echo "==> .env.e2e gerado, apontando para $API_URL"
echo "==> Próximo: pnpm e2e:build && pnpm test:e2e"
