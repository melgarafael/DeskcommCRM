#!/usr/bin/env bash
# #2109 — a recuperação de senha num install-single-server.sh.
#
# O QUE ESTÁ SOB PROVA: o instalador, rodando com um domínio de exemplo, grava
# no `.env` do Supabase as duas chaves que fazem o GoTrue buscar o molde NO APP
# (GOTRUE_MAILER_TEMPLATES_RECOVERY e ..._CONFIRMATION) — e o override do
# compose entrega essas chaves ao contêiner `auth`. Sem elas o GoTrue sobe no
# modelo padrão, o link vai para `/auth/v1/verify` e devolve a sessão no
# FRAGMENTO da URL; fragmento nunca chega ao servidor, `app/auth/confirm` não
# acha `code` nem `token_hash` e manda o clique para `/login?error=link_invalido`.
# Ninguém consegue trocar a própria senha.
#
# O CAMINHO é o instalador INTEIRO, com dublê de `docker` no PATH e
# `install.sh` trocado por um registrador: nada sobe, nada é baixado, nenhum
# contêiner é tocado, e o `.env` que sai é o do instalador de verdade.
#
# Caso de controle: um molde que o operador já apontou não é sobrescrito.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
KIT="$ROOT_DIR/hostgator-setup-kit"
OVERRIDE="$KIT/supabase-single-server.override.yml"
INSTALADOR="$KIT/install-single-server.sh"
DOMINIO="crm.exemplo.com.br"
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

# ── Dublês ──────────────────────────────────────────────────────────────────
# `docker`: sem ele o instalador morre na porta de entrada, e com ele ele não
# toca em contêiner nenhum. Toda chamada sai 0 e vazia — não há outra árvore
# dona dos contêineres (as guardas passam), não há linha no banco (o SMTP não
# sincroniza) e o `up -d` do Supabase não sobe nada.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/docker" <<'DUBLO'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${DOCKER_LOG:-/dev/null}"
exit 0
DUBLO
chmod +x "$WORK/bin/docker"

# `install.sh`: o passo canônico (imagens, compose do CRM, bootstrap) é outro
# teste. Aqui ele só prova que foi chamado — o que está sob prova é o que o
# instalador de single-server grava ao redor dele.
instalador_canonico_dublo() {  # instalador_canonico_dublo <árvore>
  cat > "$1/hostgator-setup-kit/install.sh" <<'DUBLO'
#!/usr/bin/env bash
printf 'chamado\n' >> "${INSTALL_SH_LOG:-/dev/null}"
exit 0
DUBLO
  chmod +x "$1/hostgator-setup-kit/install.sh"
}

# ── A árvore falsa: o que o instalador encontra numa VPS recém-criada ──────
# O `.env` do Supabase é o que o setup.sh oficial DEIXA antes do instalador
# mexer nele — por isso o bloco de download do próprio instalador é pulado.
montar_arvore() {  # montar_arvore <árvore> [<chave>=<valor> ...] (extras no .env do Supabase)
  local raiz="$1"; shift
  mkdir -p "$raiz/hostgator-setup-kit" "$raiz/.runtime/supabase"
  cp "$KIT"/*.sh "$raiz/hostgator-setup-kit/"
  cp "$OVERRIDE" "$raiz/hostgator-setup-kit/"
  instalador_canonico_dublo "$raiz"
  {
    printf 'ANON_KEY=anon_de_teste\n'
    printf 'SERVICE_ROLE_KEY=service_de_teste\n'
    printf 'POSTGRES_PASSWORD=senha_de_teste\n'
    printf 'API_GW_HTTP_PORT=8000\n'
    printf 'DISABLE_SIGNUP=false\n'
    for linha in "$@"; do printf '%s\n' "$linha"; done
  } > "$raiz/.runtime/supabase/.env"
  chmod 600 "$raiz/.runtime/supabase/.env"
}

rodar_instalador() {  # rodar_instalador <árvore> [<CHAVE>=<valor> ...] (exportadas)
  local raiz="$1"; shift
  PATH="$WORK/bin:$PATH" SINGLE_SERVER_ALLOW_LOW_MEMORY=1 DOCKER_LOG="$WORK/docker.log" \
    INSTALL_SH_LOG="$WORK/install-sh.log" "$@" \
    bash "$raiz/hostgator-setup-kit/install-single-server.sh" --domain "$DOMINIO" \
    > "$WORK/saida.log" 2>&1
}

# Duas árvores: uma para o caso comum, outra para o caso de controle. O
# instalador morre cedo em erro de guarda/dublê, e um caso não pode deixar
# resto para o outro.
ARVORE="$WORK/fresca"
montar_arvore "$ARVORE"
CONTROLE="$WORK/controle"
montar_arvore "$CONTROLE" \
  'GOTRUE_MAILER_TEMPLATES_RECOVERY=https://molde.do.operador.br/recupera'

echo "modelos de recuperação do GoTrue (#2109)"

check "instalador roda até o fim com o domínio de exemplo" rodar_instalador "$ARVORE"
check "o install.sh canônico foi chamado (o instalador não morreu antes dele)" \
  test -s "$WORK/install-sh.log"
check "o dublê do docker foi o que o instalador usou (nada subiu de verdade)" \
  test -s "$WORK/docker.log"

ENV_SB="$ARVORE/.runtime/supabase/.env"
RECOVERY="GOTRUE_MAILER_TEMPLATES_RECOVERY=https://$DOMINIO/email-templates/recovery"
CONFIRMACAO="GOTRUE_MAILER_TEMPLATES_CONFIRMATION=https://$DOMINIO/email-templates/confirmation"

# (1) As duas linhas, com o DOMÍNIO que o instalador pediu — não um placeholder.
check "grava o molde de recuperação de senha apontando para o app" \
  grep -qxF "$RECOVERY" "$ENV_SB"
check "grava o molde de confirmação de cadastro apontando para o app" \
  grep -qxF "$CONFIRMACAO" "$ENV_SB"

# (2) Uma linha por chave: `set_env_var` apaga a chave antes de escrever, e uma
#     cópia sobrando deixaria o compose interpolando o último valor — invisível
#     para quem lê o arquivo.
conta() { grep -c "^$1=" "$ENV_SB" || true; }
check "cada chave aparece exatamente uma vez no .env do Supabase" \
  test "$(conta GOTRUE_MAILER_TEMPLATES_RECOVERY)" = 1 -a \
       "$(conta GOTRUE_MAILER_TEMPLATES_CONFIRMATION)" = 1

# (3) A gravação é ANTES do `dc_supabase up -d --wait`: no primeiro boot o auth
#     já nasce configurado, e numa re-execução o compose recria o contêiner cujo
#     ambiente mudou. Se gravasse depois, a instalação terminaria com o GoTrue
#     no modelo padrão até alguém reiniciar o serviço à mão.
linha_gravacao="$(grep -n '^[[:space:]]*gravar_modelos_do_gotrue ' "$INSTALADOR" | head -1 | cut -d: -f1)"
linha_boot="$(grep -nE '^[[:space:]]*dc_supabase up -d --wait' "$INSTALADOR" | head -1 | cut -d: -f1)"
gravacao_antes_do_boot() {
  [ -n "$linha_gravacao" ] && [ -n "$linha_boot" ] && [ "$linha_gravacao" -lt "$linha_boot" ]
}
check "modelos gravados antes de o Supabase subir" gravacao_antes_do_boot

# (4) Re-execução (o instalador ensinado a rodar de novo) não duplica nem troca.
check "segunda execução termina sem erro" rodar_instalador "$ARVORE"
check "segunda execução é idempotente: as mesmas duas linhas, ainda uma por chave" \
  bash -c 'grep -qxF "$1" "$2" && grep -qxF "$3" "$2" && [ "$(grep -c "^GOTRUE_MAILER_TEMPLATES_RECOVERY=" "$2")" = 1 ] && [ "$(grep -c "^GOTRUE_MAILER_TEMPLATES_CONFIRMATION=" "$2")" = 1 ]' \
  _ "$RECOVERY" "$ENV_SB" "$CONFIRMACAO"

# (5) CASO DE CONTROLE: o operador já apontou um molde próprio. O instalador
#     preserva o que existe e completa só o que falta.
check "controle: instalador roda sobre um .env que já tem um molde" \
  rodar_instalador "$CONTROLE"
ENV_C="$CONTROLE/.runtime/supabase/.env"
check "controle: molde de recuperação já posto pelo operador não é sobrescrito" \
  grep -qxF 'GOTRUE_MAILER_TEMPLATES_RECOVERY=https://molde.do.operador.br/recupera' "$ENV_C"
check "controle: a chave que faltava é gravada ao lado da pré-existente" \
  grep -qxF "$CONFIRMACAO" "$ENV_C"

# (6) O `.env` só muda o contêiner se o compose mapear a chave: o compose
#     oficial não mapeia GOTRUE_MAILER_TEMPLATES_*, então o override é parte
#     da correção — e o default vazio preserva o molde padrão do GoTrue.
check "override entrega o molde de confirmação ao serviço auth (default vazio)" \
  grep -qxF '      GOTRUE_MAILER_TEMPLATES_CONFIRMATION: "${GOTRUE_MAILER_TEMPLATES_CONFIRMATION:-}"' "$OVERRIDE"
check "override entrega o molde de recuperação ao serviço auth (default vazio)" \
  grep -qxF '      GOTRUE_MAILER_TEMPLATES_RECOVERY: "${GOTRUE_MAILER_TEMPLATES_RECOVERY:-}"' "$OVERRIDE"

# (7) QUEM JÁ INSTALOU: o update.sh chama `atualizar_supabase_single_server`
#     (_common.sh), e é no CORPO dela que a gravação tem de acontecer — numa
#     atualização quem executa é o update.sh ANTIGO, que relê o _common.sh
#     novo (#1653). O .env de partida é o de uma instalação anterior a este
#     conserto: tem o SITE_URL que o instalador gravou e nenhuma das chaves.
#     A ref já é a pinada, então o update.sh oficial do Supabase não é chamado.
ANTIGA="$WORK/antiga"
SB_A="$ANTIGA/.runtime/supabase"
mkdir -p "$SB_A"
ref_pinada="$(bash -c 'KIT_DIR="$1"; . "$KIT_DIR/_common.sh"; printf %s "$SUPABASE_REF"' _ "$KIT")"
printf 'ref=%s\n' "$ref_pinada" > "$SB_A/.supabase-version"
instalacao_antiga() {  # instalacao_antiga [<linha extra do .env>]
  { printf 'SITE_URL=https://%s\n' "$DOMINIO"; printf 'DISABLE_SIGNUP=false\n'
    [ $# -gt 0 ] && printf '%s\n' "$1"; } > "$SB_A/.env"
}
# O compose do Supabase roda sob `env -i` (dc_supabase): o caminho do log vai
# ESCRITO no dublê, porque DOCKER_LOG não sobrevive até ele.
mkdir -p "$WORK/bin-update"
{ printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> %q\nexit 0\n' "$WORK/docker-update.log"; } \
  > "$WORK/bin-update/docker"
chmod +x "$WORK/bin-update/docker"
atualizar_antiga() {
  PATH="$WORK/bin-update:$PATH" PROJECT_DIR="$ANTIGA" \
    bash -c 'KIT_DIR="$1"; . "$KIT_DIR/_common.sh"; atualizar_supabase_single_server' _ "$KIT" \
    > "$WORK/update.log" 2>&1
}
instalacao_antiga
check "update: atualizar_supabase_single_server termina bem numa instalação antiga" atualizar_antiga
check "update: quem já instalou recebe o molde de recuperação" grep -qxF "$RECOVERY" "$SB_A/.env"
check "update: quem já instalou recebe o molde de confirmação" grep -qxF "$CONFIRMACAO" "$SB_A/.env"
check "update: o Supabase sobe depois da gravação (o compose recria o auth)" \
  grep -qF 'compose up -d --wait' "$WORK/docker-update.log"
instalacao_antiga 'GOTRUE_MAILER_TEMPLATES_RECOVERY=https://molde.do.operador.br/recupera'
atualizar_antiga
check "update: molde que o operador já apontou não é sobrescrito" \
  grep -qxF 'GOTRUE_MAILER_TEMPLATES_RECOVERY=https://molde.do.operador.br/recupera' "$SB_A/.env"
check "update: e a chave que faltava é completada" grep -qxF "$CONFIRMACAO" "$SB_A/.env"
printf 'DISABLE_SIGNUP=false\n' > "$SB_A/.env"
atualizar_antiga
check "update: sem SITE_URL https, não inventa molde" \
  bash -c '! grep -q "^GOTRUE_MAILER_TEMPLATES_" "$1"' _ "$SB_A/.env"

if [[ "$FAILS" -ne 0 ]]; then
  printf '\n%d teste(s) falharam.\n' "$FAILS"
  printf -- '--- saída do instalador (últimas 20 linhas) ---\n'
  tail -20 "$WORK/saida.log" 2>/dev/null || true
  exit 1
fi

printf '\nTodos os testes dos modelos de recuperação passaram.\n'
