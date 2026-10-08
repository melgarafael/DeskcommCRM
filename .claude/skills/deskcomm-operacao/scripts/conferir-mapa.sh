#!/usr/bin/env bash
# conferir-mapa.sh — avisa quando uma tela do menu ficou fora do mapa da skill.
#
# Compara cada href de NAV_CATALOG (lib/navigation/catalogo.ts) com o que o
# references/mapa-da-interface.md da skill cita entre crases, e se o mapa ainda
# a chama pelo nome que o menu usa hoje. Só AVISA, nunca
# reprova: quem decidir transformar em bloqueio é o dono do produto.
#
# Uso: bash scripts/conferir-mapa.sh [--ci] [--estrito]
#   --ci       cada falta sai como anotação ::warning do GitHub
#   --estrito  sai com 1 se houver falta (padrão: sempre 0 quando mede)
#
# POSIX + bash 3.2 (macOS, Linux, Git Bash): só grep, sed, awk, sort.
# set -u; sem set -e. LF. Nunca escreve nada.

set -u

MODO_CI=0
ESTRITO=0

for arg in "$@"; do
  case "$arg" in
    --ci) MODO_CI=1 ;;
    --estrito) ESTRITO=1 ;;
    --ajuda|-h)
      echo "Uso: bash scripts/conferir-mapa.sh [--ci] [--estrito]"
      exit 0 ;;
    *)
      echo "Opção desconhecida: $arg" >&2
      exit 2 ;;
  esac
done

REPO=""
if [ -n "${DESKCOMM_REPO:-}" ] && [ -f "$DESKCOMM_REPO/lib/navigation/catalogo.ts" ]; then
  REPO="$DESKCOMM_REPO"
fi
if [ -z "$REPO" ]; then
  TOPO="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$TOPO" ] && [ -f "$TOPO/lib/navigation/catalogo.ts" ]; then
    REPO="$TOPO"
  fi
fi
if [ -z "$REPO" ]; then
  echo "NÃO MEDIDO — não achei o repositório (rode dentro do clone ou defina DESKCOMM_REPO)"
  exit 2
fi

CATALOGO="$REPO/lib/navigation/catalogo.ts"
MAPA="$REPO/.agents/skills/deskcomm-operacao/references/mapa-da-interface.md"

if [ ! -f "$MAPA" ]; then
  echo "NÃO MEDIDO — mapa da skill não existe ainda: $MAPA"
  exit 2
fi

# href (4 espaços; os hub: { href de NAV_GROUPS não contam) + label da entrada
ENTRADAS="$(awk '
  /^    href: "\/app/ { href = $0; sub(/^[^"]*"/, "", href); sub(/".*$/, "", href); tela = "" }
  /^    label: "/ && href != "" && tela == "" { tela = $0; sub(/^[^"]*"/, "", tela); sub(/".*$/, "", tela) }
  /^  \}/ && href != "" { print href "|" tela; href = "" }
' "$CATALOGO")"

TOTAL=0
FALTAS=0
SAIDA=""
OLD_IFS="$IFS"
IFS="
"
for linha in $ENTRADAS; do
  [ -z "$linha" ] && continue
  TOTAL=$((TOTAL + 1))
  href="${linha%%|*}"
  tela="${linha#*|}"
  if ! grep -q -F "\`$href\`" "$MAPA"; then
    FALTAS=$((FALTAS + 1))
    if [ "$MODO_CI" -eq 1 ]; then
      SAIDA="$SAIDA::warning file=.agents/skills/deskcomm-operacao/references/mapa-da-interface.md::tela fora do mapa da skill de operação: $tela ($href)
"
    else
      SAIDA="$SAIDA⚠ tela fora do mapa da skill de operação: $tela ($href)
"
    fi
  else
    # A tela está no mapa; confere se o mapa ainda a chama pelo nome do menu
    # (a 1.78.0 trocou "Billing" por "Plano e cobrança" e o endereço não mudou).
    linha_do_mapa="$(grep -F "\`$href\`" "$MAPA" | head -1)"
    case "$linha_do_mapa" in
      "| $tela |"*) ;;
      *)
        FALTAS=$((FALTAS + 1))
        if [ "$MODO_CI" -eq 1 ]; then
          SAIDA="$SAIDA::warning file=.agents/skills/deskcomm-operacao/references/mapa-da-interface.md::tela renomeada no menu e não no mapa da skill de operação: $tela ($href)
"
        else
          SAIDA="$SAIDA⚠ tela renomeada no menu e não no mapa da skill de operação: $tela ($href)
"
        fi
        ;;
    esac
  fi
done
IFS="$OLD_IFS"

if [ "$FALTAS" -eq 0 ]; then
  echo "✓ mapa da skill cobre as $TOTAL telas do menu"
else
  printf '%s' "$SAIDA"
  echo "mapa da skill: $TOTAL telas no menu, $FALTAS fora do mapa ou com nome antigo"
  echo "→ acrescente a tela em .agents/skills/deskcomm-operacao/references/mapa-da-interface.md (e, se o fragmento descreve uma funcionalidade nova, em references/funcionalidades/<área>.md); depois rode pnpm skills:sync"
fi

if [ "$ESTRITO" -eq 1 ] && [ "$FALTAS" -gt 0 ]; then
  exit 1
fi
exit 0
