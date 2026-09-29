#!/usr/bin/env bash
# conferir-isolamento-do-kit.sh — roda a conferência de regras de isolamento do
# `hostgator-setup-kit/update.sh` contra um banco que acabou de receber o
# `supabase/baseline.sql` deste checkout (issue #1909).
#
#   bash scripts/conferir-isolamento-do-kit.sh <container> <banco>
#
# Chamado por `scripts/test-db.sh` (job obrigatório `invariants`), depois das
# passadas de install e update.
#
# ## O incidente
#
# O #1578 escreveu `create policy` dentro do corpo de `fn_honorarios_provisionar()`.
# A conferência do `update.sh` lê as regras esperadas do TEXTO do baseline e passou
# a cobrar 8 regras de tabelas que só existem com o módulo instalado: da v1.61.0 à
# v1.63.0 a atualização de quase toda instalação parava com o CRM atrás da página de
# manutenção (#1893, #1897, #1899). Os cinco checks obrigatórios estavam verdes: o
# `test:db` aplicava o baseline, mas ninguém rodava a conferência do kit contra ele.
#
# ## As versões conferidas, e por que não só a deste checkout
#
# 1. a do `update.sh` DESTE checkout — pega conferência nova com defeito;
# 2. a do `update.sh` da ÚLTIMA RELEASE PUBLICADA — pega baseline novo que o script
#    antigo não entende. É ela que roda na VPS: o `update.sh` em execução é o do
#    disco, lido antes do `git checkout` da versão nova;
# 3. fixa, a da v1.63.0: a última cuja conferência cobra toda regra escrita no
#    texto, sem perguntar se a tabela existe. Medido tag a tag: de v1.39.0 a
#    v1.63.0 o awk que monta as regras esperadas é o mesmo (só o `LC_ALL=C` do sort
#    muda, na v1.58.1); a v1.63.1 trouxe o filtro por tabela existente (#1906).
#    Ela representa toda instalação que ainda roda um desses scripts — e a última
#    release sozinha NÃO pegaria o próprio incidente: ela já tem o filtro.
#
# ## Como: o trecho REAL do script, nunca uma cópia
#
# A conferência não é função chamável — é código corrido dentro do passo do banco.
# Copiá-la para cá envelheceria na primeira mudança dela. O trecho é recortado do
# próprio `update.sh` entre dois marcadores que existem em TODA versão que tem a
# conferência (v1.39.0 em diante, medido tag a tag): o cabeçalho
# `E AS REGRAS DE ISOLAMENTO SÃO CONFERIDAS` e a PRIMEIRA atribuição de `faltando`.
#
# O recorte para na primeira comparação de propósito: o que vem depois é a
# RECRIAÇÃO das regras que faltam, e ela curaria em silêncio um banco recém-
# instalado com regra ausente. Aqui o banco acabou de receber o baseline inteiro —
# qualquer ausência na primeira comparação é defeito, do baseline ou do script.
#
# O acesso ao banco é a única peça trocada: `pg_container` (no kit, `docker run
# postgres:17-alpine psql <url> …`) vira `docker exec` no container do test:db,
# com os MESMOS argumentos de psql que o trecho passou.
#
# ## Qual é a última release
#
# `CONFERENCIA_KIT_RELEASE=vX.Y.Z` escolhe à mão (é o botão para provar contra uma
# release anterior). Sem ele: `gh release view` quando há `GH_TOKEN` (o CI — a API
# anônima tem teto de 60 consultas/hora por IP, e o executor próprio é um IP só);
# senão `ultima_release_estavel` do próprio kit (`/releases/latest`). Nunca a maior
# tag: tag não é release publicada (ver o cabeçalho dessa função em _common.sh).
# Sem resposta, REPROVA — gate que pula em silêncio não é gate.
set -euo pipefail

CONTAINER="${1:?uso: $0 <container> <banco>}"
BANCO="${2:?uso: $0 <container> <banco>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KIT="$ROOT/hostgator-setup-kit"

release="${CONFERENCIA_KIT_RELEASE:-}"
if [ -z "$release" ] && [ -n "${GH_TOKEN:-}" ] && command -v gh >/dev/null 2>&1; then
  release="$(cd "$ROOT" && gh release view --json tagName -q .tagName 2>/dev/null || true)"
fi
if [ -z "$release" ]; then
  release="$(cd "$ROOT" && bash -c 'source "$1/_common.sh" >/dev/null 2>&1; ultima_release_estavel' _ "$KIT" || true)"
fi
case "$release" in
  v[0-9]*) ;;
  *) echo "FATAL: não consegui saber qual é a última release publicada (sem rede? API fora?)." >&2
     echo "       Diga qual com CONFERENCIA_KIT_RELEASE=vX.Y.Z e rode de novo." >&2
     exit 1 ;;
esac

# O arquivo de cada release. No CI o checkout é raso e sem tags: busca só a tag,
# rasa também. Numa árvore completa, busca sem --depth — com ele o git marcaria o
# repositório de quem roda como raso.
ANTES_DO_FILTRO="v1.63.0"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/deskcomm-update-sh.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
update_sh_da() {  # update_sh_da <tag> — caminho de uma cópia do update.sh da tag
  if ! git -C "$ROOT" rev-parse -q --verify "refs/tags/$1^{commit}" >/dev/null; then
    local profundidade=""
    [ "$(git -C "$ROOT" rev-parse --is-shallow-repository)" = true ] && profundidade="--depth=1"
    git -C "$ROOT" fetch -q --no-tags $profundidade origin "+refs/tags/$1:refs/tags/$1"
  fi
  git -C "$ROOT" show "$1:hostgator-setup-kit/update.sh" > "$TMP/$1"
  printf '%s' "$TMP/$1"
}

# conferir <rótulo> <update.sh> — 0 se nenhuma regra falta, 1 se falta.
conferir() {
  local rotulo="$1" script="$2" trecho
  trecho="$(sed -n '/E AS REGRAS DE ISOLAMENTO SÃO CONFERIDAS/,/^  faltando="\$(/p' "$script")"
  # O recorte TEM de ter achado o começo e o fim. Sem esta guarda, um marcador
  # renomeado devolveria trecho vazio e a conferência "passaria" sem ter rodado.
  if ! printf '%s\n' "$trecho" | grep -q '^ *esperadas="\$(awk' \
     || ! printf '%s\n' "$trecho" | grep -q '^  faltando="\$('; then
    echo "  ✗ $rotulo: não achei a conferência entre os marcadores em $script" >&2
    return 1
  fi
  local saida
  if ! saida="$(
    cd "$ROOT"
    # O kit roda sob `set -euo pipefail` (_common.sh), e o trecho também.
    url_do_schema() { printf 'test-db'; }
    pg_container() {
      while [ $# -gt 0 ] && [ "${1#-}" != "$1" ]; do shift; done
      [ "${2:-}" = psql ] || { echo "pg_container: chamada inesperada: $*" >&2; return 99; }
      shift 3
      docker exec -i "$CONTAINER" psql -U postgres -d "$BANCO" "$@"
    }
    eval "$trecho"
    printf 'declaradas=%s\n' "$(printf '%s\n' "$esperadas" | grep -c . || true)"
    printf '%s\n' "$faltando" | sed '/^$/d; s/^/falta=/'
  )"; then
    echo "  ✗ $rotulo: o trecho da conferência falhou ao rodar" >&2
    return 1
  fi
  local declaradas faltam
  declaradas="$(printf '%s\n' "$saida" | sed -n 's/^declaradas=//p')"
  faltam="$(printf '%s\n' "$saida" | sed -n 's/^falta=//p')"
  if [ -n "$faltam" ]; then
    echo "  ✗ $rotulo: REGRAS DE ISOLAMENTO AUSENTES — a atualização pararia com o CRM fora do ar:" >&2
    printf '%s\n' "$faltam" | sed 's/|/ na tabela /; s/^/      • /' >&2
    return 1
  fi
  # Zero declaradas é o awk que não leu nada — a conferência muda, não a verde.
  if [ "${declaradas:-0}" -eq 0 ]; then
    echo "  ✗ $rotulo: a conferência não declarou regra nenhuma — o instrumento não mediu" >&2
    return 1
  fi
  echo "    ✓ $rotulo: $declaradas regras declaradas, todas no banco"
}

falhas=0
conferir "update.sh deste checkout" "$KIT/update.sh" || falhas=$((falhas + 1))
conferir "update.sh da última release ($release)" "$(update_sh_da "$release")" || falhas=$((falhas + 1))
if [ "$release" != "$ANTES_DO_FILTRO" ]; then
  conferir "update.sh da $ANTES_DO_FILTRO (sem filtro por tabela)" "$(update_sh_da "$ANTES_DO_FILTRO")" || falhas=$((falhas + 1))
fi
[ "$falhas" -eq 0 ] || exit 1
