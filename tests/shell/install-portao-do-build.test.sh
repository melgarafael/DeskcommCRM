#!/usr/bin/env bash
# ── install.sh: o portão de memória da #1955 decide ANTES de construir (#2631) ─
#
# O DEFEITO: os dois scripts do kit decidiam diferente na MESMA falha. Quando o
# `docker compose up -d` morre porque a imagem do `app` não veio (registro fora
# do ar, tag ainda publicando, arquitetura da VPS diferente da das imagens
# publicadas), o `update.sh` consultava `build_local_permitido` — o portão da
# #1955 — e RECUSAVA construir sem resposta do registro; o `install.sh` chamava
# `construir_aqui_e_subir` direto, sem o portão, e uma instalação nova gastava
# a memória da VPS no `next-build` (OOM) com o registro fora. A assimetria foi
# registrada na triagem do #2517.
#
# O QUE ESTE ARQUIVO PROVA — o install.sh de ponta a ponta, com docker, curl,
# crontab e uname substituídos por dublês (nenhum contêiner sobe, nenhum arquivo
# fora do sandbox):
#
#   1. PORTÃO FECHADO: a sonda do registro não responde E o `up -d` falhou →
#      o install NÃO constrói. Morre (RC 1) com a mensagem própria da
#      instalação, que diz o que não respondeu, o que fazer em seguida e como
#      construir de propósito — e o `docker-compose.build.yml` nunca é tocado.
#   2. PORTÃO ABERTO: o registro responde E o `up -d` falhou → constrói aqui.
#      É a recuperação de arquitetura do #1060/#1143 e ela não pode sumir.
#   3. O ESCAPE DE PROPÓSITO: registro fora + DESKCOMM_BUILD_LOCAL=1 → o pedido
#      humano abre o portão e o install constrói.
#   4. A ESPERA é a mesma do update.sh: a sonda que o portão faz é a função
#      compartilhada `veredito_das_imagens_da_release`, e ela corre sob
#      `com_prazo 20` por imagem — um resolver travado não prende a instalação.
#
# Os dois lados são o espelho do que o update.sh já tem (tests/shell/
# atualizacao-preflight-e-rollback.test.sh e update-guard.test.sh exercitam o
# mesmo portão no outro script).
#
# NÃO prova nada sobre uma VPS de verdade: nenhum contêiner sobe.
#
#   bash tests/shell/install-portao-do-build.test.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
WORK="$(mktemp -d)"
if [ -z "$WORK" ] || [ ! -d "$WORK" ] || [ "$WORK" = / ]; then
  echo "abortado: mktemp -d não devolveu um sandbox (WORK='$WORK')" >&2
  exit 1
fi
trap '[ "${DK_KEEP:-0}" = 1 ] || rm -rf "$WORK"' EXIT

FAILS=0
check() {  # check <descrição> <comando de verificação...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}

# ── Dublês ───────────────────────────────────────────────────────────────────
REAL_UNAME="$(command -v uname)"
mkdir -p "$WORK/bin"
# docker: registra TODA chamada.
#   REGISTRO_FORA=1  → a sonda `buildx imagetools inspect` falha (registro fora);
#   UP_D_FORA=1      → o `up -d` do passo 9 falha (imagem do app ausente);
#   o overlay `docker-compose.build.yml` SEMPRE responde: é o que o
#   `construir_aqui_e_subir` chama, e ele só é alcançado com o portão aberto.
# O gatilho é a VARIÁVEL, nunca o texto do erro — é o mesmo critério do kit.
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
# A sonda do portão: build_local_permitido → veredito_das_imagens_da_release →
# `docker buildx imagetools inspect`, UMA por imagem, sob `com_prazo 20`.
case "$*" in
  *"buildx imagetools inspect"*)
    [ "${REGISTRO_FORA:-0}" = 1 ] && exit 1
    exit 0 ;;
  *baseline.sql*) exit 0 ;;
  *psql*) exit 0 ;;
esac
case "${1:-}" in
  compose)
    case "$*" in
      *"docker-compose.build.yml"*) exit 0 ;;
      *"up -d"*)
        [ "${UP_D_FORA:-0}" = 1 ] && exit 1
        exit 0 ;;
      *" exec "*) printf 'healthy\n{"data":{"status":"healthy"}}\n'; exit 0 ;;
    esac ;;
esac
exit 0
STUB
# curl: o pré-voo das imagens publicadas (ghcr_status) responde 200 — o caso
# fechado é do REGISTRO, e ele é simulado pela sonda do portão acima, que é
# quem decide construir.
cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *ghcr.io/token*) printf '{"token":"duble"}' ;;
  *ghcr.io/v2/*)   printf 200 ;;
  */auth/v1/verify*) printf '{"msg":"Verify requires a verification type"}\n400' ;;
  *)               printf 200 ;;
esac
STUB
# crontab: nunca o da máquina de quem roda.
cat > "$WORK/bin/crontab" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in
  -l) [ -f "$FAKE_CRONTAB" ] && cat "$FAKE_CRONTAB"; exit 0 ;;
  -)  cat > "$FAKE_CRONTAB" ;;
esac
exit 0
STUB
cat > "$WORK/bin/uname" <<STUB
#!/usr/bin/env bash
[ "\$*" = "-m" ] && { printf 'x86_64\n'; exit 0; }
exec "$REAL_UNAME" "\$@"
STUB
chmod +x "$WORK/bin/"*

mkjwt() {
  local payload; payload="$(printf '{"iss":"supabase","ref":"%s","role":"%s"}' "$2" "$1" \
    | base64 | tr -d '\n' | tr '+/' '-_' | tr -d '=')"
  printf 'eyJhbG...NiJ9.%s.assinatura' "$payload"
}

# rodar <nome do caso> [VAR=valor do docker...] → OUT, DOCKERLOG, RC
rodar() {
  local caso="$1"; shift
  local raiz="$WORK/$caso" proj="$WORK/$caso/crm"
  mkdir -p "$proj/supabase" "$raiz"
  cp -R "$REPO_ROOT/hostgator-setup-kit" "$proj/"
  : > "$proj/supabase/baseline.sql"
  : > "$proj/docker-compose.prod.yml"
  cat > "$proj/.env" <<ENV
DOMAIN='crm.exemplo.com.br'
ACME_EMAIL='eu@exemplo.com.br'
NEXT_PUBLIC_SUPABASE_URL='https://abcdefghijklmnop.supabase.co'
NEXT_PUBLIC_SUPABASE_ANON_KEY='$(mkjwt anon abcdefghijklmnop)'
SUPABASE_SERVICE_ROLE_KEY='$(mkjwt service_role abcdefghijklmnop)'
SUPABASE_DB_URL='postgresql://postgres.abcdefghijklmnop:***@aws-1-sa-east-1.pooler.supabase.com:5432/postgres'
ANTHROPIC_API_KEY='sk-ant-teste'
OWNER_EMAIL='eu@exemplo.com.br'
OWNER_PASSWORD='senha12345'
ENV
  OUT="$raiz/saida.txt"; DOCKERLOG="$raiz/docker.log"; RC=0
  ( cd "$proj" && env PATH="$WORK/bin:$PATH" \
      DOCKER_LOG="$raiz/docker.log" FAKE_CRONTAB="$raiz/crontab.txt" \
      SUPABASE_ACCESS_TOKEN= "$@" \
      bash hostgator-setup-kit/install.sh --yes
  ) 2>&1 < /dev/null | sed -E 's/\x1b\[[0-9;]*m//g' > "$OUT" || RC=$?
}
# O overlay do build local entrou no log? (é a prova de que CONSTRUIU)
construiu() { grep -q 'docker-compose.build.yml' "$DOCKERLOG"; }
# O portão foi CONSULTADO? (a sonda do registro aparece no log do docker)
sondou_o_registro() { grep -q 'buildx imagetools inspect' "$DOCKERLOG"; }

echo "── 1. PORTÃO FECHADO: o registro não responde → o install.sh NÃO constrói"
rodar fechado REGISTRO_FORA=1 UP_D_FORA=1
check "saiu com 1 (a instalação para e o autômato sabe que não terminou)" [ "$RC" -eq 1 ]
check "o portão foi consultado antes de decidir (a sonda do registro rodou)" sondou_o_registro
check "NÃO constrói: o overlay docker-compose.build.yml nunca é chamado" \
  eval '! construiu'
check "e o aviso de construção do construir_aqui_e_subir nem aparece" \
  bash -c "! grep -q 'Vou construir as três imagens aqui' '$OUT'"
check "a mensagem é a da INSTALAÇÃO e diz que foi o registro que não respondeu" \
  grep -q 'o registro de imagens não respondeu' "$OUT"
check "ela diz o que fazer em seguida (rodar de novo em alguns minutos)" \
  grep -q 'de novo em alguns minutos' "$OUT"
check "e ensina a saída de propósito, com DESKCOMM_BUILD_LOCAL=1" \
  grep -q 'DESKCOMM_BUILD_LOCAL=1 bash hostgator-setup-kit/install.sh --yes' "$OUT"

echo
echo "── 2. PORTÃO ABERTO: o registro responde → constrói aqui (recuperação #1060/#1143)"
rodar aberto REGISTRO_FORA=0 UP_D_FORA=1
check "o portão foi consultado (a mesma sonda, agora respondendo)" sondou_o_registro
check "CONSTRÓI: o overlay docker-compose.build.yml build foi chamado" \
  grep -q 'docker-compose.build.yml' "$DOCKERLOG"
check "terminou com 0" [ "$RC" -eq 0 ]
check "chegou à tela final (controle: a instalação inteira rodou)" \
  grep -q 'Instalação concluída' "$OUT"
check "e diz em português que as imagens saíram daqui" \
  grep -q 'construídas aqui nesta VPS' "$OUT"
check "nunca passou pela recusa da #2631" \
  bash -c "! grep -q 'o registro de imagens não respondeu' '$OUT'"

echo
echo "── 3. O ESCAPE DE PROPÓSITO: registro fora, mas quem opera pediu com DESKCOMM_BUILD_LOCAL=1"
rodar proposito REGISTRO_FORA=1 UP_D_FORA=1 DESKCOMM_BUILD_LOCAL=1
check "o pedido humano abre o portão mesmo sem resposta do registro" \
  grep -q 'docker-compose.build.yml' "$DOCKERLOG"
check "terminou com 0" [ "$RC" -eq 0 ]
check "não caiu na recusa" \
  bash -c "! grep -q 'o registro de imagens não respondeu' '$OUT'"

echo
echo "── 4. A espera é a MESMA do update.sh (a sonda corre sob com_prazo 20)"
# O portão é função de _common.sh, compartilhada: quem o chama herda o prazo.
# Sem o prazo a sonda do registro prenderia a instalação num resolver saturado
# — foi o que prendeu o healthcheck no passo "▶ Containers" (#1955).
check "a sonda das quatro imagens roda sob com_prazo (o mesmo prazo do update.sh)" \
  grep -q 'com_prazo 20 docker buildx imagetools inspect' "$REPO_ROOT/hostgator-setup-kit/_common.sh"
check "e as quatro imagens foram sondadas nesta instalação recusada" \
  test "$(grep -c 'buildx imagetools inspect' "$WORK/fechado/docker.log")" -eq 4

echo
echo "── 5. A ordem no install.sh: portão ANTES de construir, dentro do bloco do up -d"
INSTALL="$REPO_ROOT/hostgator-setup-kit/install.sh"
linha_up="$(grep -n 'if ! dc up -d; then' "$INSTALL" | head -1 | cut -d: -f1)"
linha_portao="$(grep -n 'if ! build_local_permitido' "$INSTALL" | head -1 | cut -d: -f1)"
linha_build="$(grep -n 'if construir_aqui_e_subir' "$INSTALL" | head -1 | cut -d: -f1)"
# Sem o portão no arquivo `linha_portao` fica VAZIA e um `test -lt` com operando
# vazio imprime "integer expression expected" no stderr — o resultado continua ✗,
# mas é um ruído do instrumento no meio da prova, e prova que reclama do próprio
# instrumento é prova que ninguém lê. A ordem curto-circuita: só compara NÚMEROS
# quando os três existem.
ordem_do_portao() {
  [ -n "$linha_up" ] && [ -n "$linha_portao" ] && [ -n "$linha_build" ] || return 1
  [ "$linha_up" -lt "$linha_portao" ] && [ "$linha_portao" -lt "$linha_build" ]
}
check "o bloco do 'up -d' existe" test -n "$linha_up"
check "o portão está DEPOIS do 'up -d' e ANTES de construir" ordem_do_portao

echo
if [ "$FAILS" -eq 0 ]; then
  echo "OK — o install.sh consulta o portão antes de construir e recusa sem registro."
else
  echo "FALHOU — $FAILS prova(s)."
fi
exit $((FAILS > 0))
