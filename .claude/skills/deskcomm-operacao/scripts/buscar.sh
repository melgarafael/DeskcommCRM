#!/usr/bin/env bash
# buscar.sh — pergunta ao menu e ao CHANGELOG na hora, sem confiar na memória.
#
# Uso (da pasta da skill, ou de qualquer lugar dentro do clone):
#   bash scripts/buscar.sh --menu
#   bash scripts/buscar.sh <palavra> [<palavra>...]
#   bash scripts/buscar.sh -n 5 <palavra>
#   bash scripts/buscar.sh --ajuda
#
# Só lê arquivos do repositório. Nunca escreve nada, nunca mostra segredo.
# POSIX + bash 3.2 (macOS, Linux, Git Bash): só grep, sed, awk, cut, sort, head.

set -u
set -f

LIMITE=15
MOSTRAR_AJUDA=0
MODO=""
PALAVRAS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --ajuda|-h)
      MOSTRAR_AJUDA=1; shift ;;
    --menu)
      MODO="menu"; shift ;;
    -n)
      LIMITE="${2:-15}"
      case "$LIMITE" in
        ''|*[!0-9]*) LIMITE=15 ;;
      esac
      shift; shift ;;
    --*)
      echo "Opção desconhecida: $1" >&2
      echo "Use: bash scripts/buscar.sh --ajuda" >&2
      exit 2 ;;
    *)
      if [ -z "$PALAVRAS" ]; then
        PALAVRAS="$1"
      else
        PALAVRAS="$PALAVRAS $1"
      fi
      shift ;;
  esac
done

if [ "$MOSTRAR_AJUDA" -eq 1 ]; then
  cat <<'AJUDA'
Uso: bash scripts/buscar.sh [OPÇÃO] [palavra...]

  --menu            lista todas as telas do menu (Grupo | Tela | /caminho | quem vê)
  <palavra> [...]   procura nas telas, no CHANGELOG e na skill (todas têm de aparecer)
  -n N              até N resultados do CHANGELOG (padrão: 15)
  --ajuda           esta tela

Exemplos:
  bash scripts/buscar.sh --menu
  bash scripts/buscar.sh pausar
  bash scripts/buscar.sh videochamada
  bash scripts/buscar.sh "planos de tarefa"

Pode digitar com ou sem acento: "prospecao" acha "Prospecção",
e "acao" acha "ação".

O comando acha o repositório sozinho (DESKCOMM_REPO, raiz do git ou
subindo pastas). Fora de um clone, defina DESKCOMM_REPO com o caminho.
AJUDA
  exit 0
fi

# ---- acha o repositório ----
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
  D="$PWD"
  while [ -n "$D" ] && [ "$D" != "/" ] && [ "$D" != "." ]; do
    if [ -f "$D/lib/navigation/catalogo.ts" ]; then
      REPO="$D"
      break
    fi
    D="$(dirname "$D")"
  done
fi
if [ -z "$REPO" ]; then
  echo "NÃO MEDIDO — não achei o repositório (rode dentro do clone ou defina DESKCOMM_REPO)"
  echo "Alternativa remota:"
  if [ -n "$PALAVRAS" ]; then
    PRIMEIRA="$(printf '%s' "$PALAVRAS" | cut -d' ' -f1)"
    echo "curl -s https://raw.githubusercontent.com/melgarafael/DeskcommCRM/main/CHANGELOG.md | grep -in \"$PRIMEIRA\""
  else
    echo "curl -s https://raw.githubusercontent.com/melgarafael/DeskcommCRM/main/CHANGELOG.md | grep -in \"<palavra>\""
  fi
  exit 2
fi

CATALOGO="$REPO/lib/navigation/catalogo.ts"
CHANGELOG="$REPO/CHANGELOG.md"

# ---- lista base: Grupo | Tela | href | quem vê | descrição ----
LISTA_BASE="$(awk '
  BEGIN { antes = 1; em_grupo = 0 }
  function valor(linha,    s) {
    s = linha
    sub(/^[^"]*"/, "", s)
    sub(/".*$/, "", s)
    return s
  }
  /NAV_CATALOG/ { antes = 0; em_grupo = 0; next }
  antes && /^[[:space:]]*\{[[:space:]]*$/ { em_grupo = 1; gl_id = ""; gl_rotulo = ""; next }
  antes && em_grupo == 1 {
    if (gl_id == "" && match($0, /id: "[^"]+"/)) gl_id = substr($0, RSTART + 5, RLENGTH - 6)
    if (gl_rotulo == "" && match($0, /label: "[^"]+"/)) gl_rotulo = substr($0, RSTART + 8, RLENGTH - 9)
    if ($0 ~ /\}/) {
      if (gl_id != "" && gl_rotulo != "") grupo[gl_id] = gl_rotulo
      em_grupo = 0
    }
    next
  }
  antes && /\{.*id: "/ {
    if (match($0, /id: "[^"]+"/)) gl_id = substr($0, RSTART + 5, RLENGTH - 6)
    if (match($0, /label: "[^"]+"/)) grupo[gl_id] = substr($0, RSTART + 8, RLENGTH - 9)
    next
  }
  /^    href: "/ { href = valor($0); tela = ""; grp = ""; papel = ""; desc = ""; pega_desc = 0; next }
  /^    label: "/ { tela = valor($0); next }
  /^    description: "/ { desc = valor($0); next }
  /^    description:$/ { pega_desc = 1; next }
  pega_desc == 1 && /^      "/ { desc = valor($0); pega_desc = 0; next }
  /^    group: "/ { grp = valor($0); next }
  /^    minRole: "/ { papel = valor($0); next }
  /^  \}/ {
    if (href != "") {
      quem = "todos"
      if (papel == "agent") quem = "atendente ou acima"
      else if (papel == "manager") quem = "gerente ou acima"
      else if (papel == "admin") quem = "administrador"
      gl = grupo[grp]
      if (gl == "") gl = grp
      print gl " | " tela " | " href " | " quem " | " desc
    }
    href = ""
    next
  }
' "$CATALOGO")"

if [ "$MODO" = "menu" ]; then
  printf '%s\n' "$LISTA_BASE" | cut -d'|' -f1-4 | sed 's/ *$//'
  TOTAL="$(printf '%s\n' "$LISTA_BASE" | grep -c ' | ' || true)"
  echo "total: $TOTAL telas"
  exit 0
fi

if [ -z "$PALAVRAS" ]; then
  echo "Diga o que procurar. Ex.: bash scripts/buscar.sh pausar" >&2
  echo "Ou use: bash scripts/buscar.sh --ajuda" >&2
  exit 2
fi

# ---- busca sem acento e sem locale: normaliza, escapa, expande ----
# Pode digitar com ou sem acento: "prospecao" acha "Prospecção".
# 1) normaliza() troca cada letra acentuada pela base (literais UTF-8,
#    funciona em qualquer locale); 2) escapa os especiais de regex que a
#    pessoa digitou; 3) expande cada base numa alternativa grep -E.
# O "c" aceita repetição ((c|ç)+) porque "Prospecção" sem acento se
# escreve "prospeccao": com um "c" só, "prospecao" nunca acharia a tela.
normaliza() {
  sed -e 's/á/a/g' -e 's/à/a/g' -e 's/â/a/g' -e 's/ã/a/g' -e 's/ä/a/g' \
      -e 's/Á/a/g' -e 's/À/a/g' -e 's/Â/a/g' -e 's/Ã/a/g' -e 's/Ä/a/g' \
      -e 's/é/e/g' -e 's/è/e/g' -e 's/ê/e/g' -e 's/ë/e/g' \
      -e 's/É/e/g' -e 's/È/e/g' -e 's/Ê/e/g' -e 's/Ë/e/g' \
      -e 's/í/i/g' -e 's/ì/i/g' -e 's/î/i/g' -e 's/ï/i/g' \
      -e 's/Í/i/g' -e 's/Ì/i/g' -e 's/Î/i/g' -e 's/Ï/i/g' \
      -e 's/ó/o/g' -e 's/ò/o/g' -e 's/ô/o/g' -e 's/õ/o/g' -e 's/ö/o/g' \
      -e 's/Ó/o/g' -e 's/Ò/o/g' -e 's/Ô/o/g' -e 's/Õ/o/g' -e 's/Ö/o/g' \
      -e 's/ú/u/g' -e 's/ù/u/g' -e 's/û/u/g' -e 's/ü/u/g' \
      -e 's/Ú/u/g' -e 's/Ù/u/g' -e 's/Û/u/g' -e 's/Ü/u/g' \
      -e 's/ç/c/g' -e 's/Ç/c/g' -e 's/ñ/n/g' -e 's/Ñ/n/g'
}
escapa() {
  sed -e 's/\\/\\\\/g' -e 's/\./\\./g' -e 's/\*/\\*/g' -e 's/\[/\\[/g' \
      -e 's/\]/\\]/g' -e 's/(/\\(/g' -e 's/)/\\)/g' -e 's/{/\\{/g' \
      -e 's/}/\\}/g' -e 's/\^/\\^/g' -e 's/\$/\\$/g' -e 's/+/\\+/g' \
      -e 's/?/\\?/g' -e 's/|/\\|/g'
}
expande() {
  sed -e 's/a/(a|á|à|â|ã|ä)/g' -e 's/e/(e|é|ê|è|ë)/g' \
      -e 's/i/(i|í|î|ì|ï)/g' -e 's/o/(o|ó|ô|ò|õ|ö)/g' \
      -e 's/u/(u|ú|û|ù|ü)/g' -e 's/c/((c|ç)+)/g' -e 's/n/(n|ñ)/g'
}
# uma palavra digitada vira um padrão grep -E
padrao() {
  printf '%s' "$1" | normaliza | escapa | expande
}
exige_todas() {
  # lê da entrada padrão, exige TODAS as palavras (um grep -iE por palavra)
  R="$(cat)"
  I=1
  for p in $PALAVRAS; do
    if [ "$I" -gt 10 ]; then
      break
    fi
    P="$(padrao "$p")"
    R="$(printf '%s\n' "$R" | grep -iE "$P" || true)"
    I=$((I + 1))
  done
  printf '%s\n' "$R"
}

echo "== Telas do menu =="
ACHOU_MENU=0
ACHOU_MENU="$(printf '%s\n' "$LISTA_BASE" | exige_todas)"
printf '%s\n' "$ACHOU_MENU" | grep ' | ' || true
QTD_MENU="$(printf '%s\n' "$ACHOU_MENU" | grep -c ' | ' || true)"
if [ "$QTD_MENU" -eq 0 ]; then
  echo "(nada no menu para: $PALAVRAS)"
fi

echo ""
echo "== O que o CHANGELOG diz =="
ITENS="$(awk '
  /^## \[/ {
    ver = $0; sub(/^## \[/, "", ver); sub(/\].*$/, "", ver)
    data = $0; sub(/^.* — /, "", data)
  }
  /^### / {
    secao = $0; sub(/^### /, "", secao)
    if (dentro) { emite(); dentro = 0 }
    next
  }
  /^- \*\*/ && (secao == "Adicionado" || secao == "Alterado") {
    if (dentro) emite()
    dentro = 1; inicio = NR; primeira = $0; texto = $0
    next
  }
  {
    if (dentro) {
      if ($0 ~ /^$/ || $0 ~ /^## \[/ || $0 ~ /^### / || $0 ~ /^- \*\*/) {
        emite(); dentro = 0
      } else {
        texto = texto " " $0
      }
    }
    next
  }
  function emite(    titulo) {
    if (secao != "Adicionado" && secao != "Alterado") return
    titulo = primeira
    if (match(titulo, /\*\*[^*]+\*\*/)) {
      titulo = substr(titulo, RSTART + 2, RLENGTH - 4)
    } else {
      sub(/^- +/, "", titulo)
      titulo = substr(titulo, 1, 160)
    }
    gsub(/\t/, " ", texto)
    print texto "\t" ver " (" data ") — [" secao "] " titulo "\t" inicio
  }
  END { if (dentro) emite() }
' "$CHANGELOG")"
ACHOU_LOG="$(printf '%s\n' "$ITENS" | exige_todas | head -n "$LIMITE" || true)"
if [ -z "$ACHOU_LOG" ]; then
  echo "(nada no CHANGELOG para: $PALAVRAS)"
else
  TAB="$(printf '\t')"
  printf '%s\n' "$ACHOU_LOG" | while IFS="$TAB" read -r _texto exib inicio; do
    printf '%s\n' "$exib"
    printf '  CHANGELOG.md:%s\n' "$inicio"
  done
fi

echo ""
echo "== O que a skill já documenta =="
SKILL_DIR="$(dirname "$0")/.."
MAPA="$SKILL_DIR/references/mapa-da-interface.md"
FUNC_DIR="$SKILL_DIR/references/funcionalidades"
filtra() {
  # lê da entrada padrão, exige todas as palavras (E lógico, com ou sem acento)
  exige_todas
}
ACHOU_SKILL=""
if [ -f "$MAPA" ]; then
  ACHOU_SKILL="$(grep -i -n . "$MAPA" 2>/dev/null | filtra | head -n 10 || true)"
  if [ -n "$ACHOU_SKILL" ]; then
    printf '%s\n' "$ACHOU_SKILL" | sed 's/^/mapa-da-interface.md:/'
  fi
fi
ACHOU_FUNC=""
if [ -d "$FUNC_DIR" ]; then
  ACHOU_FUNC="$(grep -i -n -r . "$FUNC_DIR" 2>/dev/null | filtra | head -n 10 || true)"
  if [ -n "$ACHOU_FUNC" ]; then
    printf '%s\n' "$ACHOU_FUNC"
  fi
fi
TOTAL_SKILL=0
if [ -n "$ACHOU_SKILL" ]; then
  TOTAL_SKILL="$(printf '%s\n' "$ACHOU_SKILL" | wc -l | tr -d ' ')"
fi
if [ -n "${ACHOU_FUNC:-}" ]; then
  TOTAL_SKILL=$((TOTAL_SKILL + $(printf '%s\n' "$ACHOU_FUNC" | wc -l | tr -d ' ')))
fi
if [ "$TOTAL_SKILL" -eq 0 ]; then
  echo "(nada na skill para: $PALAVRAS)"
fi

if [ "$QTD_MENU" -eq 0 ] && [ -z "$ACHOU_LOG" ] && [ "$TOTAL_SKILL" -eq 0 ]; then
  echo ""
  echo "Não achei nada para: $PALAVRAS (nem no menu, nem no CHANGELOG, nem na skill)."
fi
exit 0
