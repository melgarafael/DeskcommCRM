#!/usr/bin/env bash
# Prova de `veredito_das_imagens_da_release` em `_common.sh`: a sonda das QUATRO
# imagens só esconde a release quando a ausência é PROVADA — falha de sonda
# (timeout, 429, rede) não pode virar "não há atualização".
#
#   bash tests/shell/sonda-das-quatro-nao-esconde-a-release.test.sh
#
# ── O defeito que ele guarda ────────────────────────────────────────────────
#
# Caso real (2026-11-12): a `v1.109.0` saiu, as QUATRO imagens estavam no GHCR e
# o `agent.sh` zerou a tag no batimento — o campo que libera o botão
# (`latest_version`) chegou vazio na tela, com `compare_failed=false`. Como nada
# era registrado, não havia como saber que o motivo era a sonda.
#
# `com_prazo 20` transforma timeout em "esta imagem não existe"; sem o controle
# pela tag instalada, UMA falha entre QUATRO escondia a release por 5 minutos —
# e, se o registro estivesse fora, para sempre.
#
# Nada aqui toca a rede: `docker` é um shim local que responde a uma lista.
set -uo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../hostgator-setup-kit" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() {  # check <descrição> <comando...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}

# ── O shim: `docker buildx imagetools inspect <img:tag>` ────────────────────
# Sai 0 só para as referências listadas em $EXISTEM; qualquer outra sai 1, que é
# o mesmo que o `imagetools` faz para tag inexistente E para registro fora.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/docker" <<'SHIM'
#!/usr/bin/env bash
ref="${!#}"   # o alvo é sempre o último argumento
for r in $EXISTEM; do
  [ "$r" = "$ref" ] && exit 0
done
exit 1
SHIM
chmod +x "$WORK/bin/docker"

# O namespace vem de `_common.sh` (fonte única): escrevê-lo à mão aqui deixaria a
# catraca de `tests/unit/namespace-das-imagens.test.ts` vermelha — e, pior, um
# namespace errado ficaria verde nos dois lugares.
NS="$(bash -c 'source "$0/_common.sh" >/dev/null 2>&1; printf "%s" "$IMG_NS"' "$KIT_DIR")"
APP="$NS/deskcommcrm"; WORKER="$NS/deskcomm-worker"; SCHED="$NS/deskcomm-scheduler"; VOZ="$NS/deskcomm-voice-agent"

veredito() {  # veredito <referências que existem> <alvo> [instalada]
  PATH="$WORK/bin:$PATH" EXISTEM="$1" bash -c '
    source "$0/_common.sh" >/dev/null 2>&1
    veredito_das_imagens_da_release "$1" "${2:-}"
    printf "|%s" "${IMAGENS_SEM_RESPOSTA# }"
  ' "$KIT_DIR" "$2" "${3:-}"
}

echo '── 1. As quatro publicadas: a release é oferecida'
R="$(veredito "$APP:1.109.0 $WORKER:1.109.0 $SCHED:1.109.0 $VOZ:1.109.0" 1.109.0 1.108.0)"
check 'veredito é "prontas"' test "${R%%|*}" = "prontas"
check 'nada é listado como sem resposta' test -z "${R#*|}"

echo '── 2. Uma imagem realmente ausente (a instalada responde): esconde e diz qual'
R="$(veredito "$APP:1.109.0 $SCHED:1.109.0 $VOZ:1.109.0 $WORKER:1.108.0" 1.109.0 1.108.0)"
check 'veredito é "incompleta"' test "${R%%|*}" = "incompleta"
check 'o log sabe qual imagem faltou' grep -qF 'deskcomm-worker:ausente' <<<"$R"

echo '── 3. Registro fora (nem a instalada responde): NÃO esconde a release'
R="$(veredito "" 1.109.0 1.108.0)"
check 'veredito é "indisponivel" (anuncia), não "incompleta"' test "${R%%|*}" = "indisponivel"
check 'nada é chamado de ausente sem prova' bash -c '! grep -qF ":ausente" <<<"$1"' _ "$R"
check 'e o motivo registrado é "indeterminado"' grep -qF 'deskcommcrm:indeterminado' <<<"$R"

echo '── 4. Uma provada ausente e outra sem resposta: esconde, e diz as duas'
R="$(veredito "$APP:1.109.0 $SCHED:1.109.0 $WORKER:1.108.0" 1.109.0 1.108.0)"
check 'veredito é "incompleta"' test "${R%%|*}" = "incompleta"
check 'lista a ausente' grep -qF 'deskcomm-worker:ausente' <<<"$R"
check 'lista a indeterminada' grep -qF 'deskcomm-voice-agent:indeterminado' <<<"$R"

echo '── 5. Sem versão instalada não há controle: anuncia (comportamento de sempre)'
R="$(veredito "$APP:1.109.0" 1.109.0)"
check 'veredito é "indisponivel"' test "${R%%|*}" = "indisponivel"

echo
if [ "$FAILS" -gt 0 ]; then
  printf '✗ %s verificação(ões) falharam\n' "$FAILS"
  exit 1
fi
echo '✓ a sonda das quatro só esconde a release quando a ausência é provada'
