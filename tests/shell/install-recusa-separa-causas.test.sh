#!/usr/bin/env bash
# ── install.sh: a recusa de construir SEPARA as causas (#2648) ───────────────
#
# O DEFEITO: o portão `build_local_permitido` lê o veredito 'indisponivel', e
# ele JUNTA causas com diagnósticos OPPOSTOS — VPS sem o plugin buildx (o
# Docker instalado pelo apt), registro fora do ar, tag ainda publicando e sonda
# estourada no `com_prazo 20` caem todos no mesmo veredito. O update.sh já
# separava isso no preflight (`preflight_atualizacao`); o install.sh citava
# "o registro de imagens não respondeu" para tudo, e o dono de uma VPS cuja
# rede está boa ia mexer na rede à toa enquanto o que faltava era o pacote
# docker-buildx-plugin. Origem: triagem do #2644.
#
# O QUE ESTE ARQUIVO PROVA — o install.sh de ponta a ponta, com docker, curl,
# crontab e uname substituídos por dublês (nenhum contêiner sobe, nenhum arquivo
# fora do sandbox):
#
#   1. VPS SEM BUILDX: TODOS os subcomandos buildx falham e o `up -d` falhou →
#      a recusa cita o buildx e o pacote docker-buildx-plugin — e NÃO culpa o
#      registro (é o defeito da #2648: o veredito único punha os dois no mesmo
#      balde).
#   2. REGISTRO FORA (com buildx instalado): a recusa cita o registro — e NÃO
#      culpa o buildx. O mesmo portão, causa diferente, diagnóstico diferente.
#   3. PROIBIÇÃO EXPLÍCITA (DESKCOMM_BUILD_LOCAL=0): a recusa diz que quem
#      opera proibiu — tampouco é culpa do registro.
#   4. O ESCAPE DE PROPÓSITO continua acima de tudo: sem buildx + registro fora
#      + DESKCOMM_BUILD_LOCAL=1 → o pedido humano abre o portão e constrói.
#   5. A ordem no arquivo: o portão decide, e o motivo é consultado DENTRO do
#      bloco dele, antes do `construir_aqui_e_subir`.
#
# A separação é a MESMA que o preflight do update.sh já fazia (checar o plugin
# antes de atribuir a falha ao registro). O que não se separa de fora —
# registro fora × tag sem imagens × prazo estourado — é o MESMO código de
# saída, e o kit nunca adivinha pelo TEXTO do erro; por isso o caso 2 cobre o
# balde resto com a frase honesta.
#
# NÃO prova nada sobre uma VPS de verdade: nenhum contêiner sobe.
#
#   bash tests/shell/install-recusa-separa-causas.test.sh
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
#   SEM_BUILDX=1     → o plugin não existe: TODO subcomando buildx falha, como
#                      numa VPS com o Docker do apt (é o caso que o veredito
#                      único confundia com "registro fora");
#   REGISTRO_FORA=1  → a sonda `buildx imagetools inspect` falha (registro fora);
#   UP_D_FORA=1      → o `up -d` do passo 9 falha (imagem do app ausente);
#   o overlay `docker-compose.build.yml` SEMPRE responde: é o que o
#   `construir_aqui_e_subir` chama, e ele só é alcançado com o portão aberto.
# O gatilho é a VARIÁVEL, nunca o texto do erro — é o mesmo critério do kit.
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
# SEM_BUILDX antes de tudo: sem o plugin NEM a inspeção existe, e o veredito
# sai 'indisponivel' — o mesmo de registro fora, que é o defeito da #2648.
# O gabarito casa o PRIMEIRO argumento (docker buildx …), nunca o caminho no
# volume: o nome do diretório do caso podia conter "buildx" e derrubava até o
# `psql` do baseline (medido — este teste nasceu com esse falso-vermelho).
case "${1:-}" in
  buildx) [ "${SEM_BUILDX:-0}" = 1 ] && exit 1 ;;
esac
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

echo "── 1. SEM BUILDX: a recusa cita o buildx — e NÃO culpa o registro"
rodar sem_buildx SEM_BUILDX=1 UP_D_FORA=1
check "saiu com 1 (a instalação para e o autômato sabe que não terminou)" [ "$RC" -eq 1 ]
check "cita o diagnóstico certo: 'plugin buildx do Docker não está instalado'" \
  grep -q 'plugin buildx do Docker não está instalado' "$OUT"
check "e ensina o pacote certo (docker-buildx-plugin)" \
  grep -q 'docker-buildx-plugin' "$OUT"
check "NÃO culpa o registro (o defeito da #2648: o veredito único punha os dois no mesmo balde)" \
  bash -c "! grep -q 'o registro de imagens não respondeu' '$OUT'"
check "não constrói: o overlay docker-compose.build.yml nunca é chamado" \
  eval '! construiu'

echo
echo "── 2. REGISTRO FORA (com buildx): a recusa cita o registro — e NÃO culpa o buildx"
rodar registro_fora REGISTRO_FORA=1 UP_D_FORA=1
check "saiu com 1" [ "$RC" -eq 1 ]
check "cita o diagnóstico certo: 'o registro de imagens não respondeu'" \
  grep -q 'o registro de imagens não respondeu' "$OUT"
check "NÃO culpa o buildx (esta VPS tem o plugin)" \
  bash -c "! grep -q 'plugin buildx' '$OUT'"
check "não constrói" eval '! construiu'

echo
echo "── 3. PROIBIÇÃO EXPLÍCITA: DESKCOMM_BUILD_LOCAL=0 → a recusa diz que quem opera proibiu"
rodar proibido DESKCOMM_BUILD_LOCAL=0 UP_D_FORA=1
check "saiu com 1" [ "$RC" -eq 1 ]
check "diz que a proibição veio do ambiente, não do registro" \
  grep -q 'desligada por você mesmo' "$OUT"
check "NÃO culpa o registro (a sonda nem precisou rodar)" \
  bash -c "! grep -q 'o registro de imagens não respondeu' '$OUT'"
check "não constrói" eval '! construiu'

echo
echo "── 4. O ESCAPE DE PROPÓSITO continua acima de tudo: sem buildx, mas com DESKCOMM_BUILD_LOCAL=1"
rodar escape SEM_BUILDX=1 UP_D_FORA=1 DESKCOMM_BUILD_LOCAL=1
check "o pedido humano abre o portão: o overlay docker-compose.build.yml foi chamado" \
  grep -q 'docker-compose.build.yml' "$DOCKERLOG"
check "terminou com 0" [ "$RC" -eq 0 ]
check "e a recusa de buildx/registro nunca aparece" \
  bash -c "! grep -q 'plugin buildx\|o registro de imagens não respondeu' '$OUT'"

echo
echo "── 5. A ordem no arquivo: o portão decide e o motivo é consultado DENTRO do bloco dele"
COMMON="$REPO_ROOT/hostgator-setup-kit/_common.sh"
INSTALL="$REPO_ROOT/hostgator-setup-kit/install.sh"
check "a função motivo_da_recusa_do_build_local existe no _common.sh" \
  grep -q 'motivo_da_recusa_do_build_local()' "$COMMON"
linha_portao="$(grep -n 'if ! build_local_permitido' "$INSTALL" | head -1 | cut -d: -f1)"
linha_motivo="$(grep -n 'motivo_da_recusa_do_build_local "\$VERSAO_ALVO"' "$INSTALL" | head -1 | cut -d: -f1)"
linha_build="$(grep -n 'if construir_aqui_e_subir' "$INSTALL" | head -1 | cut -d: -f1)"
# Mesma lição do install-portao-do-build.test.sh: sem as três linhas nenhum
# `test -lt` roda — a comparação só acontece com NÚMEROS nos três lados.
ordem_da_separacao() {
  [ -n "$linha_portao" ] && [ -n "$linha_motivo" ] && [ -n "$linha_build" ] || return 1
  [ "$linha_portao" -lt "$linha_motivo" ] && [ "$linha_motivo" -lt "$linha_build" ]
}
check "o portão está DEPOIS do 'up -d' e ANTES de construir" test -n "$linha_portao"
check "o motivo é chamado DEPOIS do portão e ANTES do construir_aqui_e_subir" \
  ordem_da_separacao
check "e a sonda do registro continua sob com_prazo (um resolver travado não prende)" \
  grep -q 'com_prazo 20 docker buildx imagetools inspect' "$COMMON"

echo
if [ "$FAILS" -eq 0 ]; then
  echo "OK — a recusa de construir no install.sh separa buildx, registro e proibição."
else
  echo "FALHOU — $FAILS prova(s)."
fi
exit $((FAILS > 0))
