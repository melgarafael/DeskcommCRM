#!/usr/bin/env bash
# Prova de `ultima_release_estavel` em `_common.sh`: o kit instala e anuncia a
# última RELEASE PUBLICADA, nunca a maior tag.
#
#   bash tests/shell/release-publicada-nao-maior-tag.test.sh
#
# ── O defeito que ele guarda ────────────────────────────────────────────────
#
# Caso real (2026-09-13): `v1.20.0` existia como tag annotated criada À MÃO no
# repositório oficial, enquanto `/releases/latest` devolvia `v1.19.0`. O
# `update.sh` e o `agent.sh` escolhiam `git tag -l 'v*' --sort=-v:refname |
# head -1` e mandariam todo clone instalar código sem release, sem changelog e
# sem os checks obrigatórios.
#
# Nada aqui toca a rede: a "API" é um JSON local servido por `file://`, pelo
# mesmo `DESKCOMM_RELEASES_LATEST_URL` que um fork usaria.
set -uo pipefail
# Zera o ambiente git herdado (GIT_DIR de hook ou rebase --exec) e passa a
# identidade por variável: nada aqui escreve no repositório de quem roda.
unset $(git rev-parse --local-env-vars)
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t.t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t.t

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../hostgator-setup-kit" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() {  # check <descrição> <comando...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}

# Um repositório com a release publicada v1.19.0 e a tag manual v1.20.0.
REPO="$WORK/repo"
git init --quiet "$REPO"
(
  cd "$REPO"
  echo a > a; git add -A; git commit --quiet -m a; git tag v1.19.0
  echo b > b; git add -A; git commit --quiet -m b; git tag -a v1.20.0 -m "criada à mão, sem release"
)
printf '{"url":"x","tag_name":"v1.19.0","name":"v1.19.0","draft":false}\n' > "$WORK/latest.json"

rodar() {  # rodar <origin> [VAR=valor...] — devolve a resposta da função
  local origem="$1"; shift
  ( cd "$REPO" && git remote remove origin 2>/dev/null; git remote add origin "$origem"
    env "$@" bash -c 'source "$0/_common.sh" >/dev/null 2>&1; ultima_release_estavel' "$KIT_DIR" )
}

echo '── 1. Com a API respondendo, a release vence a tag manual maior'
R1="$(rodar https://github.com/exemplo/crm.git DESKCOMM_RELEASES_LATEST_URL="file://$WORK/latest.json")"
check "responde v1.19.0 (a release), não v1.20.0 (a maior tag)" test "$R1" = "v1.19.0"

echo '── 2. API fora do ar: "não sei", NUNCA a maior tag'
R2="$(rodar https://github.com/exemplo/crm.git DESKCOMM_RELEASES_LATEST_URL="file://$WORK/nao-existe.json")"
check "responde vazio" test -z "$R2"

echo '── 3. Resposta sem cara de versão é recusada, não confiada'
printf '{"message":"Not Found"}\n' > "$WORK/erro.json"
R3="$(rodar https://github.com/exemplo/crm.git DESKCOMM_RELEASES_LATEST_URL="file://$WORK/erro.json")"
check "responde vazio" test -z "$R3"

echo '── 4. Origin fora do GitHub (espelho, caminho local): sem API, vale a maior tag'
R4="$(rodar "$WORK/espelho" )"
check "responde v1.20.0 — o comportamento de antes, onde não existe release" test "$R4" = "v1.20.0"

echo '── 5. update.sh e agent.sh perguntam à função, não ao git tag'
check "update.sh escolhe o alvo por ultima_release_estavel" \
  grep -q 'TARGET_TAG="$(ultima_release_estavel)"' "$KIT_DIR/update.sh"
check "update.sh não escolhe mais pela maior tag" \
  bash -c "! grep -q \"TARGET_TAG=\\\"\\\$(git tag -l 'v\\*' --sort=-v:refname\" '$KIT_DIR/update.sh'"
check "agent.sh anuncia por ultima_release_estavel" \
  grep -q 'LATEST_TAG="$(ultima_release_estavel)"' "$KIT_DIR/agent.sh"

echo
if [ "$FAILS" -eq 0 ]; then echo "OK — release publicada, nunca a maior tag"; else echo "FALHOU: $FAILS"; exit 1; fi
