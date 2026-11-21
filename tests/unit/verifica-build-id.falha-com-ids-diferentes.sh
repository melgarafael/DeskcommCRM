#!/usr/bin/env bash
# Teste de `scripts/verifica-build-id.sh` (#4967) — os DOIS sentidos.
#
#   bate            → rc 0
#   diverge         → rc 1, e a mensagem NOMEIA os dois ids
#   não dá para medir (ausente/ambíguo) → rc 2, nunca confundido com "bateu"
#
# Fixtures em diretório temporário, no layout que o `next build` produz:
#   <raiz>/.next/BUILD_ID
#   <raiz>/.next/static/<BUILD_ID>/{_buildManifest.js,_ssgManifest.js}
#   <raiz>/.next/static/{chunks,media}/        (não são build id)
#
# Sem pipe no comando do gate: `bash tests/unit/verifica-build-id.falha-com-ids-diferentes.sh`
set -uo pipefail

AQUI=$(cd "$(dirname "$0")/../.." && pwd)
SCRIPT="$AQUI/scripts/verifica-build-id.sh"
[ -f "$SCRIPT" ] || { echo "FALHOU: $SCRIPT não existe"; exit 1; }

BASE=$(mktemp -d "${TMPDIR:-/tmp}/verifica-build-id.XXXXXX")
trap 'rm -rf "$BASE"' EXIT

falhas=0
total=0

# monta <dir> <id-do-servidor> <id-dos-estaticos>
monta() {
  local raiz="$1" servidor="$2" estatico="$3"
  mkdir -p "$raiz/.next/static/$estatico" "$raiz/.next/static/chunks" "$raiz/.next/static/media"
  printf '%s' "$servidor" > "$raiz/.next/BUILD_ID"
  printf 'self.__BUILD_MANIFEST = {};\n' > "$raiz/.next/static/$estatico/_buildManifest.js"
  printf 'self.__SSG_MANIFEST = new Set([]);\n' > "$raiz/.next/static/$estatico/_ssgManifest.js"
  printf 'console.log(1);\n' > "$raiz/.next/static/chunks/0-abc.js"
}

# confere <descrição> <rc-esperado> <rc-obtido> [trecho-esperado-na-saída] [saída]
confere() {
  local desc="$1" esperado="$2" obtido="$3" trecho="${4:-}" saida="${5:-}"
  total=$((total + 1))
  if [ "$obtido" -ne "$esperado" ]; then
    echo "FALHOU: $desc — rc=$obtido, esperado $esperado"
    printf '%s\n' "$saida" | sed 's/^/    /'
    falhas=$((falhas + 1))
    return
  fi
  if [ -n "$trecho" ] && ! printf '%s' "$saida" | grep -qF -- "$trecho"; then
    echo "FALHOU: $desc — a saída não menciona '$trecho'"
    printf '%s\n' "$saida" | sed 's/^/    /'
    falhas=$((falhas + 1))
    return
  fi
  echo "ok: $desc"
}

# --- 1) ids iguais: passa -------------------------------------------------
raiz="$BASE/iguais"
monta "$raiz" "DuE-f-hGyIm5kw44YlC-q" "DuE-f-hGyIm5kw44YlC-q"
saida=$(bash "$SCRIPT" --dir "$raiz" 2>&1); rc=$?
confere "ids iguais passam (rc 0)" 0 "$rc" "batem: DuE-f-hGyIm5kw44YlC-q" "$saida"

# --- 2) ids diferentes: falha e nomeia os dois ----------------------------
# Os MESMOS dois ids da imagem publicada 1.118.0, que é o caso real da issue.
raiz="$BASE/divergentes"
monta "$raiz" "L0Ae8OxIf-v2KzwJoCU0E" "K2qYwFMofIRXoOdBpIUbx"
saida=$(bash "$SCRIPT" --dir "$raiz" 2>&1); rc=$?
confere "ids diferentes falham (rc 1)" 1 "$rc" "DIVERGEM" "$saida"
confere "a falha nomeia o id do SERVIDOR" 0 "$(printf '%s' "$saida" | grep -qF 'L0Ae8OxIf-v2KzwJoCU0E' && echo 0 || echo 9)" "" "$saida"
confere "a falha nomeia o id do STATIC" 0 "$(printf '%s' "$saida" | grep -qF 'K2qYwFMofIRXoOdBpIUbx' && echo 0 || echo 9)" "" "$saida"

# --- 3) sem BUILD_ID do servidor: NÃO pode passar -------------------------
raiz="$BASE/sem-build-id"
monta "$raiz" "qualquer" "qualquer"
rm -f "$raiz/.next/BUILD_ID"
saida=$(bash "$SCRIPT" --dir "$raiz" 2>&1); rc=$?
confere "BUILD_ID do servidor ausente reprova (rc 2)" 2 "$rc" "não deu para medir" "$saida"

# --- 4) dois diretórios de build id: ambíguo, NÃO pode passar -------------
raiz="$BASE/dois-ids"
monta "$raiz" "AAAA" "AAAA"
mkdir -p "$raiz/.next/static/BBBB"
printf 'self.__BUILD_MANIFEST = {};\n' > "$raiz/.next/static/BBBB/_buildManifest.js"
saida=$(bash "$SCRIPT" --dir "$raiz" 2>&1); rc=$?
confere "dois build ids em .next/static reprovam (rc 2)" 2 "$rc" "não deu para medir" "$saida"

# --- 5) sem `.next/static`: NÃO pode passar ------------------------------
raiz="$BASE/sem-static"
monta "$raiz" "AAAA" "AAAA"
rm -rf "$raiz/.next/static"
saida=$(bash "$SCRIPT" --dir "$raiz" 2>&1); rc=$?
confere ".next/static ausente reprova (rc 2)" 2 "$rc" "não deu para medir" "$saida"

# --- 6) diretório inexistente: NÃO pode passar ---------------------------
saida=$(bash "$SCRIPT" --dir "$BASE/nao-existe" 2>&1); rc=$?
confere "diretório inexistente reprova (rc 2)" 2 "$rc" "não deu para medir" "$saida"

echo ""
if [ "$falhas" -ne 0 ]; then
  echo "FALHOU: $falhas de $total casos"
  exit 1
fi
echo "ok: $total casos"
exit 0
