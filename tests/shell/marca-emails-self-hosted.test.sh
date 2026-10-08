#!/usr/bin/env bash
# O aviso de token do Supabase CLOUD numa instalação com o Supabase na própria VPS.
#
# O QUE ESTÁ SOB PROVA: o `marca-emails.sh`, chamado pelo install.sh numa
# instalação single-server, NÃO manda o leigo buscar um `SUPABASE_ACCESS_TOKEN`
# (`sbp_...`) em supabase.com. Esse token é da Management API da NUVEM; o
# Supabase desta VPS não tem Management API, e os moldes de e-mail já foram
# gravados direto no GoTrue pelo install-single-server.sh / update.sh
# (gravar_modelos_do_gotrue, _common.sh — #2109).
#
# Medido numa instalação single-server real (PR 4, 2026-10-07): o terminal
# mostrou "⚠ sem SUPABASE_ACCESS_TOKEN — não dá para configurar os e-mails de
# acesso sozinho." e a receita do `export SUPABASE_ACCESS_TOKEN=sbp_...`. A
# causa é ORDEM: a checagem do token rodava antes de qualquer pergunta sobre a
# topologia.
#
# Controles: no Supabase da NUVEM (e com a URL vazia, em que não dá para saber
# a topologia) o aviso do token continua — lá ele é o passo certo.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRIPT="$ROOT_DIR/hostgator-setup-kit/marca-emails.sh"
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

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Uma árvore de projeto falsa: o `.env` do CRM, os moldes que o script
# renderiza e, opcionalmente, o `.env` do Supabase da VPS.
montar() {  # montar <nome> <linhas do .env do CRM>  [<linhas do .env do Supabase>]
  local raiz="$WORK/$1"
  mkdir -p "$raiz/supabase/templates"
  cp "$ROOT_DIR/supabase/templates/confirmation.html" "$ROOT_DIR/supabase/templates/recovery.html" \
    "$raiz/supabase/templates/"
  printf '%s\n' "$2" > "$raiz/.env"
  if [ -n "${3:-}" ]; then
    mkdir -p "$raiz/.runtime/supabase"
    printf '%s\n' "$3" > "$raiz/.runtime/supabase/.env"
  fi
}

# Roda como o install.sh roda: sem token, com o arquivo de pendência pedido.
# `env -u` porque um token ou URL no ambiente de quem roda o teste mudaria o caso.
rodar() {  # rodar <nome>  → $WORK/<nome>.out, $WORK/<nome>.pend, $WORK/<nome>.rc
  : > "$WORK/$1.pend"
  env -u SUPABASE_ACCESS_TOKEN -u NEXT_PUBLIC_SUPABASE_URL -u SINGLE_SERVER -u NEXT_PUBLIC_APP_URL \
    PENDENCIA_ARQUIVO="$WORK/$1.pend" \
    bash "$SCRIPT" --projeto "$WORK/$1" > "$WORK/$1.out" 2>&1
  echo $? > "$WORK/$1.rc"
}

saiu_zero()  { [ "$(cat "$WORK/$1.rc")" = 0 ]; }
diz()        { grep -qF -- "$2" "$WORK/$1.out"; }
nao_diz()    { ! grep -qF -- "$2" "$WORK/$1.out"; }
sem_pend()   { [ ! -s "$WORK/$1.pend" ]; }
com_pend()   { [ -s "$WORK/$1.pend" ]; }

CRM_SINGLE='SINGLE_SERVER=1
NEXT_PUBLIC_SUPABASE_URL=https://crm.exemplo.com.br
NEXT_PUBLIC_APP_URL=https://crm.exemplo.com.br'
SB_COM_MOLDES='SITE_URL=https://crm.exemplo.com.br
GOTRUE_MAILER_TEMPLATES_CONFIRMATION=https://crm.exemplo.com.br/email-templates/confirmation
GOTRUE_MAILER_TEMPLATES_RECOVERY=https://crm.exemplo.com.br/email-templates/recovery'

echo "marca-emails.sh com o Supabase na própria VPS"

# (1) O caso medido: single-server recém-instalado, moldes já no GoTrue.
montar single "$CRM_SINGLE" "$SB_COM_MOLDES"
rodar single
check "single-server: sai 0 (a instalação continua)" saiu_zero single
check "single-server: não pede SUPABASE_ACCESS_TOKEN" nao_diz single 'SUPABASE_ACCESS_TOKEN'
check "single-server: não manda buscar token sbp_ de outra conta" nao_diz single 'sbp_'
check "single-server: não manda ao painel da nuvem" nao_diz single 'supabase.com/dashboard'
check "single-server: diz que os moldes já estão no GoTrue desta VPS" diz single 'GoTrue'
check "single-server: não deixa pendência para a tela final" sem_pend single

# (2) Single-server sem os moldes gravados (instalação anterior ao #2109 que
#     ainda não atualizou): o passo que vale é o update.sh, não um token.
montar single-sem-moldes "$CRM_SINGLE" 'SITE_URL=https://crm.exemplo.com.br'
rodar single-sem-moldes
check "single-server sem moldes: sai 0" saiu_zero single-sem-moldes
check "single-server sem moldes: não manda buscar token sbp_" nao_diz single-sem-moldes 'sbp_'
check "single-server sem moldes: aponta o update.sh" diz single-sem-moldes 'update.sh'
check "single-server sem moldes: anota a pendência para a tela final" com_pend single-sem-moldes

# (3) Supabase próprio FORA do kit (não é single-server, nem nuvem): o caminho
#     é a env do GoTrue — também não há token da nuvem a buscar.
montar proprio 'NEXT_PUBLIC_SUPABASE_URL=https://supabase.meucliente.com.br'
rodar proprio
check "Supabase próprio: sai 0" saiu_zero proprio
check "Supabase próprio: não manda buscar token sbp_" nao_diz proprio 'sbp_'
check "Supabase próprio: ensina o caminho do GoTrue" diz proprio 'GOTRUE_MAILER_TEMPLATES'

# (4) CONTROLE: na nuvem o aviso do token é o passo certo, e continua.
montar nuvem 'NEXT_PUBLIC_SUPABASE_URL=https://abcdefghijklmnop.supabase.co'
rodar nuvem
check "nuvem (controle): sai 0" saiu_zero nuvem
check "nuvem (controle): continua pedindo o SUPABASE_ACCESS_TOKEN sbp_" diz nuvem 'sbp_'
check "nuvem (controle): anota a pendência" com_pend nuvem

# (5) CONTROLE: URL vazia — não dá para saber a topologia; fica o aviso de antes.
montar vazia 'APP_NAME=Loja'
rodar vazia
check "URL vazia (controle): continua nomeando SUPABASE_ACCESS_TOKEN" diz vazia 'SUPABASE_ACCESS_TOKEN'

# ── O MESMO defeito no update.sh ────────────────────────────────────────────
# No primeiro `update.sh` SEM token, o aviso "CONFIRA UMA COISA, UMA VEZ SÓ"
# saía em toda topologia (o install.sh nunca cria o marcador
# `.deskcomm-site-url-avisado`) e mandava ao "painel do Supabase" e a
# `export SUPABASE_ACCESS_TOKEN=sbp_...`. No single-server o Site URL é do kit
# (install-single-server.sh grava SITE_URL e ADDITIONAL_REDIRECT_URLS desde o
# nascimento); num Supabase próprio a conferência é no .env dele, não num painel
# da nuvem. O texto mora em `aviso_do_site_url` (_common.sh), que o update.sh
# relê depois do checkout.
echo
echo "update.sh: o aviso do Site URL, por topologia"

aviso() {  # aviso <nome> <SINGLE_SERVER> <NEXT_PUBLIC_SUPABASE_URL>
  env -u SUPABASE_ACCESS_TOKEN SINGLE_SERVER="$2" NEXT_PUBLIC_SUPABASE_URL="$3" NO_COLOR=1 \
    bash -c '. "$1/hostgator-setup-kit/_common.sh"; set +e; aviso_do_site_url https://crm.exemplo.com.br' \
    _ "$ROOT_DIR" > "$WORK/$1.out" 2>&1
  echo $? > "$WORK/$1.rc"
}

aviso up-single 1 https://crm.exemplo.com.br
# Sem a função, o "não diz" abaixo passaria por ausência de saída: o rc prende.
check "update.sh single-server: a função existe e sai 0" saiu_zero up-single
check "update.sh single-server: não pede SUPABASE_ACCESS_TOKEN" nao_diz up-single 'SUPABASE_ACCESS_TOKEN'
check "update.sh single-server: não manda ao painel do Supabase" nao_diz up-single 'painel do Supabase'
check "update.sh single-server: não imprime o aviso (o Site URL é do kit)" nao_diz up-single 'CONFIRA UMA COISA'

aviso up-proprio 0 https://supabase.meucliente.com.br
check "update.sh Supabase próprio: não manda buscar token sbp_" nao_diz up-proprio 'sbp_'
check "update.sh Supabase próprio: não manda ao painel do Supabase" nao_diz up-proprio 'painel do Supabase'
check "update.sh Supabase próprio: confere o SITE_URL no .env do Supabase dele" diz up-proprio 'SITE_URL=https://crm.exemplo.com.br'
check "update.sh Supabase próprio: e o ADDITIONAL_REDIRECT_URLS" diz up-proprio 'ADDITIONAL_REDIRECT_URLS=https://crm.exemplo.com.br/auth/confirm'

aviso up-nuvem 0 https://abcdefghijklmnop.supabase.co
check "update.sh nuvem (controle): imprime o aviso" diz up-nuvem 'CONFIRA UMA COISA'
check "update.sh nuvem (controle): aponta o painel do Supabase" diz up-nuvem 'painel do Supabase'
check "update.sh nuvem (controle): receita o token sbp_" diz up-nuvem 'SUPABASE_ACCESS_TOKEN=sbp_'

aviso up-vazia 0 ''
check "update.sh URL vazia (controle): segue com o aviso da nuvem" diz up-vazia 'SUPABASE_ACCESS_TOKEN=sbp_'

# A fiação: o update.sh imprime o aviso pela função, e não mais por um texto
# próprio que ignora a topologia.
UP="$ROOT_DIR/hostgator-setup-kit/update.sh"
# Ancorada na CHAMADA: o comentário que aponta a função também tem o nome.
check "update.sh chama aviso_do_site_url" grep -qE '^ *aviso_do_site_url ' "$UP"
check "update.sh não receita o token sbp_ fora da função" bash -c '! grep -qF "SUPABASE_ACCESS_TOKEN=sbp_" "$1"' _ "$UP"

if [[ "$FAILS" -ne 0 ]]; then
  printf '\n%d teste(s) falharam.\n' "$FAILS"
  for n in single single-sem-moldes proprio up-single up-proprio; do
    printf -- '--- saída: %s ---\n' "$n"; cat "$WORK/$n.out"
  done
  exit 1
fi

printf '\nTodos os testes do aviso de token no Supabase próprio passaram.\n'
