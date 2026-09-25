#!/usr/bin/env bash
# Contrato estrutural do instalador de uma pergunta, sem tocar no Docker real.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
INSTALLER="$ROOT_DIR/hostgator-setup-kit/install-single-server.sh"
CANONICAL="$ROOT_DIR/hostgator-setup-kit/install.sh"
COMMON="$ROOT_DIR/hostgator-setup-kit/_common.sh"
OVERRIDE="$ROOT_DIR/hostgator-setup-kit/supabase-single-server.override.yml"
FAILS=0

check() {
  local descricao="$1"
  shift
  if "$@"; then
    printf '  ✓ %s\n' "$descricao"
  else
    printf '  ✗ %s\n' "$descricao"
    FAILS=$((FAILS + 1))
  fi
}

echo "instalador single-server"
check "sintaxe Bash valida" bash -n "$INSTALLER"
check "Supabase self-hosted esta pinado num lugar so (_common.sh)" grep -qx 'SUPABASE_REF="self-hosted/v0.8.1"' "$COMMON"
check "instalador nao repete a versao do Supabase" bash -c '! grep -q "self-hosted/v[0-9]" "$1"' _ "$INSTALLER"
check "download oficial tem SHA-256 fixo" grep -q 'SUPABASE_SETUP_SHA256=' "$INSTALLER"
check "rede privada e POR INSTALACAO (nome do projeto)" grep -qF 'SINGLE_SERVER_NETWORK="$(nome_do_projeto_atual)_supabase"' "$INSTALLER"
check "Postgres do app usa DNS privado" grep -q '@supabase-db:5432/postgres' "$INSTALLER"
check "gateway interno nao depende do DNS publico" grep -qF 'SUPABASE_INTERNAL_URL "http://127.0.0.1:${gw_port:-8000}"' "$INSTALLER"
check "validador usa o gateway interno antes do Caddy" grep -q 'SUPABASE_INTERNAL_URL' "$CANONICAL"
check "catálogo OpenRouter é preenchido no primeiro deploy" grep -q 'api/v1/cron/sync-model-catalog' "$CANONICAL"
check "administrador recebe senha aleatoria" grep -q 'openssl rand -hex 16' "$INSTALLER"
check "re-rodar nao apaga chave de IA posta depois" bash -c '! grep -qE "(ANTHROPIC|OPENROUTER|OPENAI)_API_KEY \"\"" "$1"' _ "$INSTALLER"
check "nao grava tag movel de imagem" bash -c '! grep -qE "_IMAGE .*:latest|_PULL_POLICY always" "$1"' _ "$INSTALLER"
check "--yes herda imagem por numero de versao" grep -qF 'IMAGEM_APP_DEFAULT="${IMG_APP}:${VERSAO_ALVO}"' "$CANONICAL"
check "confirmacao de e-mail do Supabase fica ligada" grep -q 'ENABLE_EMAIL_AUTOCONFIRM false' "$INSTALLER"
check "Caddy publica somente rotas Supabase necessarias" grep -q '@supabase path /auth/v1' "$ROOT_DIR/Caddyfile.single-server"
check "Studio nao e publicado pelo Caddy" bash -c '! grep -q "/studio" "$1"' _ "$ROOT_DIR/Caddyfile.single-server"
check "Compose conecta Caddy a rede privada" grep -q 'supabase_private' "$ROOT_DIR/docker-compose.single-server.yml"
check "dominio resolve internamente para o Caddy" grep -q -- '- ${DOMAIN}' "$ROOT_DIR/docker-compose.single-server.yml"
check "gateway Supabase escuta apenas em loopback" grep -q '127.0.0.1:${API_GW_HTTP_PORT' "$ROOT_DIR/hostgator-setup-kit/supabase-single-server.override.yml"
check "Postgres Supabase nao publica porta no host" bash -c '! grep -q "POSTGRES_PORT" "$1"' _ "$OVERRIDE"

# (a) Nomes. Os 11 servicos do docker-compose.yml de self-hosted/v0.8.1; um
# bump do SUPABASE_REF que traga servico novo tem de entrar aqui e no override.
for svc in studio api-gw auth rest realtime storage imgproxy meta functions db supavisor; do
  check "override tira o container_name fixo de $svc" \
    bash -c 'awk -v s="  $2:" '"'"'$0==s{d=1;next} d&&/^  [a-z]/{exit} d&&/container_name: !reset null/{f=1} END{exit !f}'"'"' "$1"' _ "$OVERRIDE" "$svc"
done
check "realtime segue alcancavel pelo host que o Envoy chama" grep -q 'aliases: \[realtime-dev.supabase-realtime\]' "$OVERRIDE"
check "projeto do Supabase vai para o .env dele" grep -qF 'COMPOSE_PROJECT_NAME "$(projeto_do_supabase)"' "$INSTALLER"
check "instalador nao usa o run.sh (ambiente do CRM vazaria)" bash -c '! grep -q "run.sh" "$1"' _ "$INSTALLER"
guardas="$(grep -n 'recusar_projeto_de_outra_arvore ||\|recusar_supabase_de_outra_arvore ||' "$INSTALLER" | cut -d: -f1 | tail -1)"
primeiro_efeito="$(grep -n 'mkdir -p "$RUNTIME_DIR"' "$INSTALLER" | cut -d: -f1)"
check "guardas de dono (CRM e Supabase) antes de criar qualquer coisa" \
  test "${guardas:-999}" -lt "${primeiro_efeito:-0}"

# (e) Piso de RAM: o mesmo do install.sh (uma VPS de "4 GB" reporta ~3.735.000 KB).
piso_ss="$(sed -n 's/^readonly RAM_MINIMA_KB=\([0-9]*\)$/\1/p' "$INSTALLER")"
piso_canon="$(sed -n 's/^RAM_MINIMA_KB=\([0-9]*\)$/\1/p' "$CANONICAL")"
check "piso de RAM igual ao do install.sh ($piso_canon)" test -n "$piso_ss" -a "$piso_ss" = "$piso_canon"
check "VPS de 4 GB decimais (~3.735.000 KB) passa no piso" test 3735000 -ge "${piso_ss:-99999999}"
check "o gate de RAM usa o piso, nao um numero solto" grep -qF '"${mem_kb:-0}" -lt "$RAM_MINIMA_KB"' "$INSTALLER"
check "8 GB seguem recomendados na mensagem" grep -q 'recomenda 8 GB' "$INSTALLER"

# (c) E-mail de acesso: o GoTrue recebe o SMTP do CRM, e sem SMTP o dono le o aviso.
check "instalador entrega o SMTP do CRM ao GoTrue" grep -q 'sincronizar_smtp_do_gotrue' "$INSTALLER"
check "sem SMTP, o fim da instalacao avisa" grep -q "sem SMTP, 'esqueci a senha'" "$INSTALLER"

# (c3) #1653 — o `signup_mode` da instalação fecha e reabre o caminho DIRETO do
# GoTrue (`POST /auth/v1/signup` com a anon key). O que se prova aqui é o
# comportamento da função no kit, com `psql_run` e `dir_do_supabase` dublados:
# sem este passo, `so_convite` só fecha o CRM e o GoTrue segue criando conta.
sync_signup_mode() {  # sync_signup_mode <modo no banco | __falha__> <DISABLE_SIGNUP no .env | vazio> [SIGNUP_MODE do .env do CRM]
  local tmp modo="$1" atual="$2" piso="${3:-}" saida valor
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/app"
  printf 'COMPOSE_PROJECT_NAME=projeto\n' > "$tmp/.env"
  if [ -n "$atual" ]; then printf 'DISABLE_SIGNUP=%s\n' "$atual" >> "$tmp/.env"; fi
  printf 'APP_NAME=x\n' > "$tmp/app/.env"
  if [ -n "$piso" ]; then printf 'SIGNUP_MODE=%s\n' "$piso" >> "$tmp/app/.env"; fi
  saida="$(MODE_DB="$modo" SB_DIR="$tmp" PROJECT_DIR="$tmp/app" bash -c '
    set -euo pipefail
    . "$1/_common.sh"
    dir_do_supabase() { printf %s "$SB_DIR"; }
    psql_run() { [ "$MODE_DB" = __falha__ ] && return 1; printf %s "$MODE_DB"; }
    c_ylw() { :; }
    if sincronizar_signup_mode_do_gotrue; then printf MUDOU; else printf IGUAL; fi
  ' _ "$ROOT_DIR/hostgator-setup-kit" "$tmp" 2>&1)" || saida="ERRO:$saida"
  valor="$(grep -E '^DISABLE_SIGNUP=' "$tmp/.env" | cut -d= -f2- || true)"
  if grep -q '^GOTRUE_DISABLE_SIGNUP=' "$tmp/.env"; then valor="$valor+sombra"; fi
  rm -rf "$tmp"
  printf '%s|%s' "$saida" "${valor:-vazio}"
}
check "so_convite escreve DISABLE_SIGNUP=true (chave oficial do Supabase)" \
  test "$(sync_signup_mode so_convite false)" = 'MUDOU|true'
check "ja no valor do modo nao mexe no .env (idempotente, sem reiniciar o auth)" \
  test "$(sync_signup_mode so_convite true)" = 'IGUAL|true'
check "voltar para aberto reabre o caminho direto" \
  test "$(sync_signup_mode aberto true)" = 'MUDOU|false'
check ".env novo do Supabase em modo aberto: nada muda, nada reinicia" \
  test "$(sync_signup_mode aberto false)" = 'IGUAL|false'
check "sem linha no banco, o piso SIGNUP_MODE=so_convite do CRM fecha" \
  test "$(sync_signup_mode '' false so_convite)" = 'MUDOU|true'
check "sem linha e sem piso vale aberto" \
  test "$(sync_signup_mode '' false)" = 'IGUAL|false'
check "piso irreconhecivel vale aberto (nao fecha por erro de digitacao)" \
  test "$(sync_signup_mode '' false so_convit)" = 'IGUAL|false'
check "banco fora ou sem a coluna: nao mexe em nada, nem cai no piso" \
  test "$(sync_signup_mode __falha__ false so_convite)" = 'IGUAL|false'
# O efeito na atualização (o update.sh ANTIGO chamando a função do kit NOVO) é
# provado em tests/shell/single-server-operacao.test.sh, bloco (d).
check "instalador entrega a sincronizacao ao Supabase" \
  grep -q 'sincronizar_signup_mode_do_gotrue' "$INSTALLER"
check "override leva a chave oficial DISABLE_SIGNUP ao container auth" \
  grep -qF 'GOTRUE_DISABLE_SIGNUP: "${DISABLE_SIGNUP:-false}"' "$OVERRIDE"

if [[ "$FAILS" -ne 0 ]]; then
  printf '\n%d teste(s) falharam.\n' "$FAILS"
  exit 1
fi

printf '\nTodos os testes do modo single-server passaram.\n'
