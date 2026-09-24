#!/usr/bin/env bash
# Prova as duas garantias do instalador local: ele não apaga o ambiente de
# quem já usa o clone, e a senha do dono não nasce publicada.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
INSTALADOR="$ROOT_DIR/ubuntu-local-installer.sh"
STACK="$ROOT_DIR/scripts/local-stack.sh"
SUPA="$ROOT_DIR/scripts/local-supabase.sh"
ENVGEN="$ROOT_DIR/scripts/local-env.sh"
COMPOSE="$ROOT_DIR/docker-compose.local.yml"
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

echo "stack local — instalador e scripts"

for arquivo in "$INSTALADOR" "$STACK" "$SUPA" "$ENVGEN"; do
  check "sintaxe Bash válida: ${arquivo#"$ROOT_DIR"/}" bash -n "$arquivo"
done

# ── A senha do dono ────────────────────────────────────────────────────────
#
# O instalador publica as credenciais na tela no fim. Se a senha for literal
# no arquivo, ela está publicada NO REPOSITÓRIO — e o `.env.local` que este
# mesmo script gera aponta a aplicação para o IP da VM na rede, não para
# 127.0.0.1. Qualquer máquina da rede alcançaria o CRM com a senha do GitHub.
check "a senha do dono não é literal no script" bash -c '
  ! grep -qE "^export OWNER_PASSWORD=\"[^$]" "$1"' _ "$INSTALADOR"
check "a senha do dono nasce aleatória" bash -c '
  grep -q "openssl rand" <<<"$(grep "^export OWNER_PASSWORD=" "$1")"' _ "$INSTALADOR"
check "quem quiser escolher a senha consegue (OWNER_PASSWORD respeitado)" bash -c '
  grep -q "OWNER_PASSWORD:-" "$1"' _ "$INSTALADOR"

# ── A chave da API do WAHA ─────────────────────────────────────────────────
#
# Ela comanda a sessão de WhatsApp. Literal no arquivo = publicada NESTE
# repositório — o mesmo argumento da senha do dono, e pior, porque o painel do
# WAHA fica de pé. As duas checagens abaixo EXECUTAM as linhas em vez de as
# lerem: além do literal, elas pegam o erro irmão de derivar a chave e o hash
# de dois `openssl rand` diferentes, que passa em qualquer grep e rende 401.
#
# `sha512sum` é do GNU e não existe no macOS, onde este teste roda antes de
# chegar ao Ubuntu do CI; o stub abaixo o troca por um marcador visível, porque
# o que se prova aqui é a PROCEDÊNCIA do hash, não o algoritmo.
check "instalador: o hash do WAHA deriva da chave, e a chave nasce aleatória" bash -c '
  sha512sum() { sed "s/^/marca:/"; }
  eval "$(grep -E "^WAHA_KEY(_HASH)?=" "$1")"
  [[ "${WAHA_KEY:-}" =~ ^[0-9a-f]{48}$ ]] || exit 1
  [[ "${WAHA_KEY_HASH:-}" == "marca:$WAHA_KEY" ]]
' _ "$INSTALADOR"

check "gerador de .env.local: o hash do WAHA deriva da MESMA chave" bash -c '
  sha512sum() { sed "s/^/marca:/"; }
  waha_key="canario-0123456789"
  eval "$(grep -E "^WAHA_API_KEY(_SHA512)?=" "$1")"
  [[ "${WAHA_API_KEY:-}" == "canario-0123456789" ]] || exit 1
  [[ "${WAHA_API_KEY_SHA512:-}" == "marca:canario-0123456789" ]]
' _ "$ENVGEN"

check "gerador de .env.local: a chave do WAHA nasce aleatória" bash -c '
  grep -qF "waha_key=\"\$(openssl rand" "$1"' _ "$ENVGEN"

# ── O painel do WAHA não atende a rede ─────────────────────────────────────
#
# O dashboard está LIGADO neste compose e tem autenticação própria, com o
# padrão do WAHA — a chave da API não o protege. Publicar a porta sem endereço
# de bind entrega o comando da sessão de WhatsApp a qualquer máquina da rede da
# VM. `docker-compose.prod.yml` fecha o mesmo buraco desligando o dashboard e
# não publicando porta nenhuma; aqui ele serve quem desenvolve, em 127.0.0.1.
#
# Range de awk (`/^  waha:/,/^  [a-z]/`) NÃO serve: `  waha:` casa com o próprio
# padrão de fim e o bloco colapsa em 1 linha — sonda quebrada devolve zero e
# lê exatamente como "nenhuma porta exposta". Por isso a flag `f`, e por isso a
# checagem de controle logo abaixo.
BLOCO_WAHA='awk "/^  waha:/{f=1;next} f && /^  [a-z]/{f=0} f"'
check "a sonda enxerga o bloco do WAHA no compose" bash -c '
  eval "$2" "$1" | grep -q WAHA_DASHBOARD_ENABLED' _ "$COMPOSE" "$BLOCO_WAHA"
check "nenhuma porta do WAHA é publicada sem endereço de bind" bash -c '
  ! eval "$2" "$1" | grep -qE "^ +- \"[0-9]+:[0-9]+\"$"' _ "$COMPOSE" "$BLOCO_WAHA"

# ── O .env.local de quem já usa o clone ────────────────────────────────────
#
# O instalador roda DENTRO de um clone existente (ele só clona quando não acha
# `package.json`), e 93 scripts deste repositório leem `.env.local`. Escrever
# por cima sem cópia apaga o ambiente de trabalho de quem rodar por curiosidade.
check "o instalador faz backup de um .env.local que não é local" bash -c '
  grep -q "cloud-backup" "$1"' _ "$INSTALADOR"
check "o instalador reconhece o ambiente local pela marca DESKCOMM_ENV_MODE" bash -c '
  grep -q "DESKCOMM_ENV_MODE=local" "$1"' _ "$INSTALADOR"
check "o .env.local gerado carrega a marca (senão o próximo run apaga sem backup)" bash -c '
  awk "/^cat <<EOF > .env.local\$/,/^EOF\$/" "$1" | grep -q "^DESKCOMM_ENV_MODE=local\$"' _ "$INSTALADOR"

# ── O COMPORTAMENTO, e não só o texto ──────────────────────────────────────
#
# As checagens acima leem o arquivo; esta EXECUTA o trecho da guarda contra um
# `.env.local` de mentira, que é a única forma de saber que a condição casa.
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
guarda() {
  # O mesmo bloco do instalador, extraído por marcador — se ele mudar lá, esta
  # extração falha e o teste fica vermelho em vez de medir um texto obsoleto.
  awk '/^if \[\[ -s .env.local \]\]/,/^fi$/' "$INSTALADOR"
}
[[ -n "$(guarda)" ]] || { printf '  ✗ não achei a guarda no instalador\n'; FAILS=$((FAILS + 1)); }

(
  cd "$TMP_DIR" || exit 1
  paint() { :; }
  printf 'NEXT_PUBLIC_SUPABASE_URL=https://nuvem.supabase.co\n' > .env.local
  eval "$(guarda)"
) >/dev/null 2>&1
check "ambiente da NUVEM é copiado antes de ser substituído" test -s "$TMP_DIR/.env.local.cloud-backup"

(
  cd "$TMP_DIR" || exit 1
  rm -f .env.local.cloud-backup
  paint() { :; }
  printf 'DESKCOMM_ENV_MODE=local\nNEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321\n' > .env.local
  eval "$(guarda)"
) >/dev/null 2>&1
check "ambiente JÁ local não vira backup a cada run" bash -c '! test -e "$1/.env.local.cloud-backup"' _ "$TMP_DIR"

if [[ "$FAILS" -gt 0 ]]; then
  printf '\n%s verificação(ões) falharam\n' "$FAILS"
  exit 1
fi
printf '\ntodas as verificações passaram\n'
