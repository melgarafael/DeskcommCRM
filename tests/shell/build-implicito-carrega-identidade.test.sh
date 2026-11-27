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
#      mais — a queda transitória deixa de virar imagem construída aqui;
#   5. a revisão só é carimbada com a árvore LIMPA (`revisao_da_arvore_limpa`,
#      executada num repositório descartável com o `.gitignore` real): remendo
#      ou arquivo novo deixam o label vazio, e as marcas do kit não sujam;
#   6. o `diagnostico.sh` segue chamando de "construída aqui" a imagem que tem
#      `revision` mas não o `version` do CI (executado com um `docker` dublê).
#
# NÃO prova nada sobre uma VPS de verdade: nenhum contêiner sobe, nenhum pull
# acontece. A falha de CDN real e o efeito na tela não foram medidos aqui.
#
#   bash tests/shell/build-implicito-carrega-identidade.test.sh
set -uo pipefail
# Dentro de um hook do git estas variáveis apontam para o repositório de quem
# chamou, e o repositório descartável do passo 5 as herdaria.
unset $(git rev-parse --local-env-vars)

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
COMPOSE="$REPO_ROOT/docker-compose.prod.yml"
UPDATE="$REPO_ROOT/hostgator-setup-kit/update.sh"
KIT="$REPO_ROOT/hostgator-setup-kit"
WORK="$(mktemp -d)" || exit 1
trap 'rm -rf "$WORK"' EXIT

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
echo "── 5. A revisão só é carimbada com a árvore limpa"
check "o update.sh tira APP_REVISION de revisao_da_arvore_limpa (e não do ambiente)" \
  grep -qE '^export APP_REVISION="\$\(revisao_da_arvore_limpa "\$PROJECT_DIR"\)"$' "$UPDATE"
# Um repositório descartável com o `.gitignore` REAL: é ele que decide se as
# marcas que o kit grava na pasta do projeto sujam a árvore ou não.
ARV="$WORK/arvore"
git_iso() { GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -C "$ARV" "$@"; }
mkdir -p "$ARV"
cp "$REPO_ROOT/.gitignore" "$ARV/.gitignore"
printf 'codigo\n' > "$ARV/Dockerfile.worker"
git_iso init -q
git_iso add -A
git_iso -c user.email=t@t -c user.name=t commit -qm base
HEAD_ARV="$(git_iso rev-parse HEAD)"
revisao() { GIT_CEILING_DIRECTORIES="$WORK" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 bash -c ". '$KIT/_common.sh'; revisao_da_arvore_limpa '$1'" 2>/dev/null; }
check "árvore limpa: a revisão é o commit do disco" test "$(revisao "$ARV")" = "$HEAD_ARV"
# As marcas que o update.sh grava ANTES do export (a origem da ida é escrita
# logo depois do `git checkout`): se sujassem, a revisão sairia vazia em toda
# atualização para frente, e o carimbo do #5196 nunca aconteceria.
mkdir -p "$ARV/backups"
for m in .update-de-onde-vim .update.lock .update.log .deskcomm-update-diagnostico.log \
         .deskcomm-env-antes-do-update .deskcomm-site-url-avisado .env backups/banco.sql.gz; do
  : > "$ARV/$m"
done
check "as marcas do kit não sujam a árvore: a revisão continua" test "$(revisao "$ARV")" = "$HEAD_ARV"
printf 'remendo\n' >> "$ARV/Dockerfile.worker"
check "remendo num arquivo versionado: a revisão sai vazia" test -z "$(revisao "$ARV")"
git_iso checkout -q -- Dockerfile.worker
printf 'novo\n' > "$ARV/arquivo-novo.ts"
check "arquivo novo fora do .gitignore: a revisão sai vazia" test -z "$(revisao "$ARV")"
rm -f "$ARV/arquivo-novo.ts"
check "controle: limpa de novo, a revisão volta" test "$(revisao "$ARV")" = "$HEAD_ARV"
mkdir -p "$WORK/sem-git"
check "pasta sem git: a revisão sai vazia" test -z "$(revisao "$WORK/sem-git")"

echo
echo "── 6. diagnostico.sh: revision sem o version do CI é imagem construída aqui"
# Dublê do docker: responde o que o diagnóstico pergunta, com os labels do
# cenário em L_SOURCE/L_REVISION/L_VERSION (vazio = label ausente).
mkdir -p "$WORK/bin" "$WORK/proj"
cat > "$WORK/bin/docker" <<'DUBLE'
#!/usr/bin/env bash
rotulo() { if [ -n "$1" ]; then printf '%s\n' "$1"; else printf '<no value>\n'; fi; }
case "$1" in
  info) exit 0 ;;
  compose) printf 'worker|ghcr.io/x/deskcomm-worker:1.0.0\napp|ghcr.io/x/deskcommcrm:1.0.0\n' ;;
  image)
    fmt="${!#}"
    case "$fmt" in
      *image.source*)   rotulo "${L_SOURCE:-}" ;;
      *image.revision*) rotulo "${L_REVISION:-}" ;;
      *image.version*)  rotulo "${L_VERSION:-}" ;;
      *Created*)        printf '2026-11-01T00:00:00Z\n' ;;
    esac ;;
  *) exit 1 ;;
esac
DUBLE
chmod +x "$WORK/bin/docker"
: > "$WORK/proj/docker-compose.prod.yml"
printf 'WORKER_IMAGE=ghcr.io/x/deskcomm-worker:1.0.0\n' > "$WORK/proj/.env"
SHA_FALSO="$(printf '%040d' 0 | tr 0 a)"
diag() {  # diag <source> <revision> <version> → exit do diagnóstico
  ( cd "$WORK/proj" && L_SOURCE="$1" L_REVISION="$2" L_VERSION="$3" PATH="$WORK/bin:$PATH" \
      bash "$KIT/diagnostico.sh" >/dev/null 2>&1 )
}
diag_e() { diag "$1" "$2" "$3"; [ "$?" -eq "$4" ]; }
SRC=https://github.com/melgarafael/DeskcommCRM
check "imagem do CI (source+revision+version): NÃO afetada, exit 0" diag_e "$SRC" "$SHA_FALSO" 1.0.0 0
check "construída aqui pelo up -d, com revision e sem version: afetada, exit 1" diag_e "$SRC" "$SHA_FALSO" "" 1
check "construída aqui sem label nenhum (legado): afetada, exit 1" diag_e "" "" "" 1
check "construída aqui com o label de revisão VAZIO: afetada, exit 1" diag_e "$SRC" "" "" 1

echo
if [ "$FAILS" -eq 0 ]; then
  echo "OK — o build implícito carrega versão e revisão, e o pull é retentado."
else
  echo "FALHOU — $FAILS prova(s)."
fi
exit $((FAILS > 0))
