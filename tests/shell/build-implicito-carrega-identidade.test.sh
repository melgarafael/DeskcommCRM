#!/usr/bin/env bash
# ── #5196: o build IMPLÍCITO do `up -d` carrega a identidade da release ─────
#
# O DEFEITO: quando o `dc pull` do `update.sh` falha (queda transitória de CDN
# do GHCR, `read: connection reset by peer`), o preflight já confirmou que as
# imagens da release existem. O `up -d` então constrói `worker`, `scheduler` e
# `voice-agent` pelo bloco `build:` inline do `docker-compose.prod.yml` e grava
# essas imagens SOB A TAG OFICIAL da release (medido no compose: `image:` +
# `build:` juntos → constrói em qualquer falha de pull).
#
# O que saía errado desses três blocos: nenhum `args: APP_VERSION` e nenhum
# label `org.opencontainers.image.revision`. A imagem ficava com
# `APP_VERSION=dev` (o default do Dockerfile) e sem revisão, e o `_runtime.sh`
# — que lê exatamente esse label — gravava `source_verified: false` e
# `RUNTIME_CONFIRMED=false` para sempre, porque a tag já existia no disco e o
# `*_PULL_POLICY=missing` nunca mais puxava a oficial.
#
# O QUE ESTE ARQUIVO PROVA (lendo os arquivos, sem docker nenhum):
#
#   1. os TRÊS blocos `build:` de produção passam `APP_VERSION` como argumento
#      e o label de revisão;
#   2. o `app` CONTINUA sem `build:` (invariante #1060 — é a falta dele que faz
#      o `up -d` falhar e entrega a decisão ao portão `build_local_permitido`);
#   3. o `update.sh` exporta `APP_VERSION` (e a revisão, quando conhecida)
#      ANTES de `subir_o_parque`, que é o `up -d` que constrói;
#   4. antes de aceitar o build local, o `update.sh` tenta o `dc pull` UMA vez
#      mais — a queda transitória deixa de virar imagem construída aqui.
#
# NÃO prova nada sobre uma VPS de verdade: nenhum contêiner sobe, nenhum pull
# acontece. A falha de CDN real e o efeito na tela não foram medidos aqui.
#
#   bash tests/shell/build-implicito-carrega-identidade.test.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
COMPOSE="$REPO_ROOT/docker-compose.prod.yml"
UPDATE="$REPO_ROOT/hostgator-setup-kit/update.sh"

FAILS=0
check() {  # check <descrição> <comando de verificação...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}

# O bloco `build:` do serviço, e só ele: o `image:`/`pull_policy:` do mesmo
# serviço ficam de fora, e o `build:` de outro serviço também. Bloco = o que
# vem depois de `    build:` até a próxima chave de 4 espaços (as chaves do
# serviço moram nesse nível; o que é do build mora em 6).
bloco_build() {  # bloco_build <serviço> → imprime as linhas do build:
  awk -v svc="$1" '
    /^  [A-Za-z0-9_.-]+:$/ { dentro = ($0 == "  " svc ":") ; dentro_build = 0 ; next }
    dentro && /^    build:$/ { dentro_build = 1 ; next }
    dentro_build && /^    [^ ]/ { dentro_build = 0 }
    dentro_build { print }
  ' "$COMPOSE"
}

# A linha do `build:` do serviço existe? (prova de que o extrator não devolve
# vazio por acidente de formatação — sem isto, "não tem APP_VERSION" passaria
# vacuamente num bloco que o awk nem achou)
tem_bloco_build() { [ -n "$(bloco_build "$1")" ]; }
servico_tem_build() {  # servico_tem_build <serviço> → 0 se o serviço TEM bloco build:
  awk -v svc="$1" '
    /^  [A-Za-z0-9_.-]+:$/ { dentro = ($0 == "  " svc ":") ; next }
    dentro && /^    build:$/ { achou = 1 }
    END { exit(achou ? 0 : 1) }
  ' "$COMPOSE"
}

echo "── 1. Os três blocos build: de produção carregam a identidade da release"
for svc in worker scheduler voice-agent; do
  check "$svc: o bloco build: existe no docker-compose.prod.yml" tem_bloco_build "$svc"
  check "$svc: passa APP_VERSION como argumento de build (não fica o 'dev' do Dockerfile)" \
    grep -qE '^[[:space:]]+APP_VERSION:[[:space:]]*\$\{APP_VERSION:-dev\}' <(bloco_build "$svc")
  check "$svc: carimba org.opencontainers.image.revision (é o que o _runtime.sh lê)" \
    grep -qE '^[[:space:]]+org\.opencontainers\.image\.revision:[[:space:]]*\$\{APP_REVISION:-\}' <(bloco_build "$svc")
done

echo
echo "── 2. O app continua SEM build: (invariante #1060)"
check "app: não há 'build:' no serviço app" eval '! servico_tem_build app'
check "o portão build_local_permitido segue no update.sh (não foi mexido)" \
  grep -q 'if ! build_local_permitido "\$VERSAO_ALVO"' "$UPDATE"

echo
echo "── 3. update.sh: o export da versão vem ANTES do up -d que constrói"
linha_subir="$(grep -nE '^if ! subir_o_parque; then' "$UPDATE" | head -1 | cut -d: -f1)"
linha_version="$(grep -nE '^export APP_VERSION=' "$UPDATE" | head -1 | cut -d: -f1)"
linha_revision="$(grep -nE '^export APP_REVISION=' "$UPDATE" | head -1 | cut -d: -f1)"
export_antes_do_up() {
  [ -n "$linha_subir" ] && [ -n "$linha_version" ] && [ "$linha_version" -lt "$linha_subir" ]
}
revision_antes_do_up() {
  [ -n "$linha_subir" ] && [ -n "$linha_revision" ] && [ "$linha_revision" -lt "$linha_subir" ]
}
check "'if ! subir_o_parque; then' existe (é o up -d do fallback)" test -n "$linha_subir"
check "export APP_VERSION= existe" test -n "$linha_version"
check "export APP_REVISION= existe" test -n "$linha_revision"
check "APP_VERSION é exportado ANTES de subir_o_parque" export_antes_do_up
check "APP_REVISION é exportado ANTES de subir_o_parque" revision_antes_do_up
check "a versão exportada é a da release alvo (\$VERSAO_ALVO)" \
  grep -qE '^export APP_VERSION="\$VERSAO_ALVO"' "$UPDATE"

echo
echo "── 4. update.sh: retry único do dc pull antes de cair no build local"
# Duas chamadas de pull: a de sempre e a retentativa dentro do bloco de falha.
pull_chamadas="$(grep -cE '^[[:space:]]*(if )?!?[[:space:]]*dc pull;' "$UPDATE")"
check "há 2 chamadas de 'dc pull' (a primeira e a retentativa), medidas: ${pull_chamadas}" \
  test "$pull_chamadas" -ge 2
check "a mensagem diz que houve retry antes do build local" \
  grep -qi 'tentar.*uma vez mais\|segunda tentativa' "$UPDATE"

echo
if [ "$FAILS" -eq 0 ]; then
  echo "OK — o build implícito carrega versão e revisão, e o pull é retentado."
else
  echo "FALHOU — $FAILS prova(s)."
fi
exit $((FAILS > 0))
