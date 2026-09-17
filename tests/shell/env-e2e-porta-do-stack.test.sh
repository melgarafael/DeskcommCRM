#!/usr/bin/env bash
# O `.env.e2e` aponta para o Postgres do stack QUE ESTÁ DE PÉ — a prova da porta.
#
#   bash tests/shell/env-e2e-porta-do-stack.test.sh
#
# ── POR QUE ESTE ARQUIVO EXISTE ──────────────────────────────────────────────
# `scripts/gerar-env-e2e.sh` gravava `SUPABASE_DB_URL=…@127.0.0.1:54322/postgres`
# com a porta padrão LITERAL. Com dois stacks locais no mesmo host (cada checkout
# tem o próprio `project_id`, e portanto a própria faixa de portas — a #1091
# reproduz com o banco em 55312), o `.env.e2e` de uma sessão mandava os seeds que
# abrem conexão DIRETA para o banco da outra. Não dá erro nenhum: a conexão é
# válida, o schema é o mesmo, a suíte fica verde, e o dado de teste de uma sessão
# aparece na outra. É a mesma família do `.env.local` de produção que o gerador
# existe para impedir.
#
# ── O QUE ESTÁ SOB PROVA ────────────────────────────────────────────────────
#   1. CONTROLE POSITIVO (o pedido da issue): com um stack fora das portas
#      padrão, o `SUPABASE_DB_URL` gravado acompanha a porta que o
#      `supabase status -o env` respondeu;
#   2. CONTROLE DA VOLTA DO LITERAL: o mesmo run não pode deixar a porta padrão
#      aparecer no arquivo — se alguém reintroduzir o literal, 1 e 2 ficam
#      vermelhos;
#   3. stack nas portas padrão continua funcionando: o valor vem do status, e
#      não de um "qualquer coisa menos a porta padrão";
#   4. sem `DB_URL` na resposta do stack, o gerador RECUSA (exit 1) em vez de
#      chutar a porta padrão — o modo de falha silencioso é o caro.
#
# Não precisa de Docker, de Supabase de verdade nem de rede: o `supabase` do PATH
# é um dublê que só responde `status` e `status -o env`, e o gerador roda num
# diretório temporário (ele faz `cd "$(dirname "$0")/.."`).
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GERADOR_REAL="$RAIZ/scripts/gerar-env-e2e.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

falhas=0
casos=0

ok()   { printf '  ok     %s\n' "$1"; }
falha(){ printf '  FALHA  %s\n' "$1"; falhas=$((falhas + 1)); }

# Monta o diretório do caso com o gerador REAL e um `supabase` de dublê.
# uso: preparar <caso> <linha…>   (as linhas são a resposta de `status -o env`)
preparar() {
  local caso="$1"; shift
  mkdir -p "$TMP/$caso/bin" "$TMP/$caso/scripts"
  cp "$GERADOR_REAL" "$TMP/$caso/scripts/gerar-env-e2e.sh"
  {
    echo '#!/usr/bin/env bash'
    echo 'set -eu'
    echo 'if [ "$*" = "status" ]; then exit 0; fi'
    echo 'if [ "$*" = "status -o env" ]; then'
    echo "cat <<'FIM'"
    local linha
    for linha in "$@"; do printf '%s\n' "$linha"; done
    echo 'FIM'
    echo 'exit 0'
    echo 'fi'
    echo 'exit 2'
  } > "$TMP/$caso/bin/supabase"
  chmod +x "$TMP/$caso/bin/supabase"
  # Chaves de cifra já prontas: o gerador só as regenera quando faltam, então a
  # prova não depende de `openssl`.
  local chave="chave-de-teste-com-mais-de-44-caracteres-000000000000"
  printf 'CPF_ENCRYPTION_KEY=%s\nWAHA_BYO_ENCRYPTION_KEY=%s\nAI_CRED_AES_KEY=%s\n' \
    "$chave" "$chave" "$chave" > "$TMP/$caso/.env.e2e"
}

# uso: rodar <caso>  → SAIDA recebe stdout+stderr e RC o código de saída
rodar() {
  SAIDA="$(cd "$TMP/$1" && PATH="$TMP/$1/bin:$PATH" bash scripts/gerar-env-e2e.sh 2>&1)"
  RC=$?
}

contem()     { grep -qF -- "$2" "$1"; }
nao_contem() { ! grep -qF -- "$2" "$1"; }

# ── 1 e 2. Stack fora das portas padrão: é o cenário da #1091 ────────────────
casos=$((casos + 1))
printf 'caso 1: o stack está com o banco em 55312 — o .env.e2e tem que acompanhar\n'
preparar fora \
  'API_URL="http://127.0.0.1:55321"' \
  'ANON_KEY="anon-sintetico"' \
  'SERVICE_ROLE_KEY="service-sintetico"' \
  'DB_URL="postgresql://postgres:senha-do-stack@127.0.0.1:55312/postgres"'
rodar fora
if [ "$RC" -eq 0 ]; then
  ok "o gerador saiu 0"
else
  falha "esperava rc 0, veio $RC — saída: $SAIDA"
fi
if contem "$TMP/fora/.env.e2e" 'SUPABASE_DB_URL=postgresql://postgres:senha-do-stack@127.0.0.1:55312/postgres'; then
  ok "SUPABASE_DB_URL seguiu a porta do stack (55312)"
else
  falha "SUPABASE_DB_URL não acompanhou o stack — arquivo: $(grep -n '^SUPABASE_DB_URL=' "$TMP/fora/.env.e2e" || echo 'sem a linha')"
fi
if nao_contem "$TMP/fora/.env.e2e" '54322'; then
  ok "nenhuma porta padrão sobrou no arquivo (a volta do literal reprova aqui)"
else
  falha "o arquivo voltou a trazer a porta padrão: $(grep -n '54322' "$TMP/fora/.env.e2e")"
fi
case "$SAIDA" in
  *55312*) ok "o recado final diz em qual Postgres os seeds escrevem" ;;
  *)       falha "o recado final não diz onde os seeds escrevem — saída: $SAIDA" ;;
esac

# ── 3. Stack nas portas padrão continua funcionando ─────────────────────────
casos=$((casos + 1))
printf 'caso 2: o stack está nas portas padrão — o .env.e2e segue o status\n'
preparar padrao \
  'API_URL="http://127.0.0.1:54321"' \
  'ANON_KEY="anon-sintetico"' \
  'SERVICE_ROLE_KEY="service-sintetico"' \
  'DB_URL="postgresql://postgres:senha-do-stack@127.0.0.1:54322/postgres"'
rodar padrao
if [ "$RC" -eq 0 ]; then
  ok "o gerador saiu 0"
else
  falha "esperava rc 0, veio $RC — saída: $SAIDA"
fi
if contem "$TMP/padrao/.env.e2e" 'SUPABASE_DB_URL=postgresql://postgres:senha-do-stack@127.0.0.1:54322/postgres'; then
  ok "SUPABASE_DB_URL veio do status, não de um 'tudo menos a porta padrão'"
else
  falha "SUPABASE_DB_URL não bateu com o status — arquivo: $(grep -n '^SUPABASE_DB_URL=' "$TMP/padrao/.env.e2e" || echo 'sem a linha')"
fi

# ── 4. Sem DB_URL no status, recusa — nunca o chute da porta padrão ─────────
casos=$((casos + 1))
printf 'caso 3: o stack não diz a DB_URL — o gerador tem que recusar\n'
preparar sem-dburl \
  'API_URL="http://127.0.0.1:54321"' \
  'ANON_KEY="anon-sintetico"' \
  'SERVICE_ROLE_KEY="service-sintetico"'
rodar sem-dburl
if [ "$RC" -eq 1 ]; then
  ok "recusou com exit 1"
else
  falha "esperava rc 1, veio $RC — saída: $SAIDA"
fi
if nao_contem "$TMP/sem-dburl/.env.e2e" 'SUPABASE_DB_URL'; then
  ok "não gravou nenhuma DB_URL (nem a padrão)"
else
  falha "gravou uma DB_URL sem o stack informar: $(grep -n '^SUPABASE_DB_URL=' "$TMP/sem-dburl/.env.e2e")"
fi
case "$SAIDA" in
  *DB_URL*) ok "a recusa explica que faltou a DB_URL" ;;
  *)        falha "a recusa não diz o motivo — saída: $SAIDA" ;;
esac

printf '\n%s caso(s), %s falha(s)\n' "$casos" "$falhas"
if [ "$falhas" -ne 0 ]; then
  echo "==> O .env.e2e não está seguindo o stack de pé (issue #1091)."
  exit 1
fi
echo "==> O .env.e2e aponta para o Postgres do stack que está de pé."
