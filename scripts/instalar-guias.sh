#!/usr/bin/env bash
# instalar-guias.sh — deixa os guias do assistente (/deskcomm-instalar, /deskcomm-cliente-novo,
# /deskcomm-metricas, /deskcomm-prompt, /deskcomm-contribuir, /deskcomm-doutrina) disponíveis
# em QUALQUER pasta, não só dentro de um clone do DeskcommCRM.
#
# ── Por que existe ────────────────────────────────────────────────────────────
#
# Os guias vivem em `.agents/skills/` (espelho em `.claude/skills/`) e todo CLI de IA os
# carrega — mas só com a sessão aberta DENTRO de um clone atualizado. Três pessoas ficavam de
# fora: quem ainda não clonou (justamente o leigo que quer instalar), quem trabalha num
# clone/branch antigo, e quem opera vários clientes a partir de outra pasta. Medido em
# 2026-09-15: numa cópia da main o Claude Code lista os sete guias; numa branch atrasada, zero.
#
# ── O que faz ─────────────────────────────────────────────────────────────────
#
# 1. Mantém uma cópia rasa só de `.agents/skills` em ~/.deskcomm/guias (clone esparso da main,
#    atualizado a cada execução). Com --fonte DIR, usa o `.agents/skills` de um clone seu.
# 2. Liga cada guia `deskcomm-*` nas pastas GLOBAIS que os CLIs leem — medidas, não supostas:
#      ~/.claude/skills       Claude Code (e Cursor e OpenCode, por compatibilidade)
#      ~/.agents/skills       Codex, Cursor e OpenCode (padrão aberto Agent Skills)
#      ~/.gemini/config/skills  Antigravity
#    Por link simbólico, para a atualização da cópia chegar sozinha; onde o sistema não cria
#    link (Windows sem modo desenvolvedor), copia e marca a pasta com `.deskcomm-guia`.
#
# Nunca sobrescreve uma skill sua com o mesmo nome: se a pasta existe e não foi este script
# que a criou, avisa e pula. `--remover` só apaga o que este script criou.
#
# ── Uso ───────────────────────────────────────────────────────────────────────
#
#   curl -fsSL https://raw.githubusercontent.com/melgarafael/DeskcommCRM/main/scripts/instalar-guias.sh | bash
#   bash scripts/instalar-guias.sh                 # instala ou atualiza (cópia da main)
#   bash scripts/instalar-guias.sh --fonte .       # aponta para ESTE clone (quem edita os guias)
#   bash scripts/instalar-guias.sh --remover       # desfaz
#
# Depois de instalar, abra uma sessão NOVA do seu CLI: skills são lidas quando a sessão começa.
#
# ⚠️ Claude Code: uma skill global com o mesmo nome VENCE a do projeto. Quem edita um guia numa
# branch e quer testá-lo deve rodar com `--fonte .` naquele clone (ou `--remover`).
set -euo pipefail

REPO_URL="${DESKCOMM_REPO_URL:-https://github.com/melgarafael/DeskcommCRM.git}"
CACHE="${DESKCOMM_GUIAS_HOME:-$HOME/.deskcomm/guias}"
DESTINOS=("$HOME/.claude/skills" "$HOME/.agents/skills" "$HOME/.gemini/config/skills")
MARCA=".deskcomm-guia"

acao="instalar"; fonte=""
while [ $# -gt 0 ]; do
  case "$1" in
    --remover) acao="remover" ;;
    --fonte) shift; fonte="${1:-}"; [ -n "$fonte" ] || { echo "--fonte precisa de uma pasta" >&2; exit 2; } ;;
    -h|--help) sed -n '2,40p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "opção desconhecida: $1 (use --fonte DIR, --remover ou --help)" >&2; exit 2 ;;
  esac
  shift
done

# Um guia instalado por este script: link que aponta para uma pasta `.agents/skills/deskcomm-*`,
# ou cópia marcada. Tudo o mais é da pessoa e não se toca.
eh_nosso() {
  local alvo="$1"
  if [ -L "$alvo" ]; then
    case "$(readlink "$alvo")" in */.agents/skills/deskcomm-*) return 0 ;; esac
    return 1
  fi
  [ -f "$alvo/$MARCA" ]
}

if [ "$acao" = "remover" ]; then
  removidos=0
  for dest in "${DESTINOS[@]}"; do
    [ -d "$dest" ] || continue
    for alvo in "$dest"/deskcomm-*; do
      [ -e "$alvo" ] || [ -L "$alvo" ] || continue
      if eh_nosso "$alvo"; then rm -rf "$alvo"; removidos=$((removidos + 1)); fi
    done
  done
  echo "ok: $removidos ligação(ões) removida(s). A cópia em $CACHE ficou (apague à mão se quiser)."
  exit 0
fi

# ── A fonte dos guias ────────────────────────────────────────────────────────
if [ -n "$fonte" ]; then
  origem="$(cd "$fonte" && pwd)/.agents/skills"
  [ -d "$origem" ] || { echo "não achei $origem — --fonte deve ser a raiz de um clone do DeskcommCRM" >&2; exit 1; }
  echo "fonte: $origem (seu clone)"
else
  command -v git >/dev/null 2>&1 || { echo "precisa do git instalado" >&2; exit 1; }
  if [ -d "$CACHE/.git" ]; then
    git -C "$CACHE" fetch -q --depth 1 origin main
    git -C "$CACHE" checkout -q --detach FETCH_HEAD
  else
    mkdir -p "$(dirname "$CACHE")"
    if ! git clone -q --depth 1 --filter=blob:none --sparse "$REPO_URL" "$CACHE" 2>/dev/null; then
      rm -rf "$CACHE"
      git clone -q --depth 1 "$REPO_URL" "$CACHE"
    fi
    git -C "$CACHE" sparse-checkout set .agents/skills 2>/dev/null || true
  fi
  origem="$CACHE/.agents/skills"
  echo "fonte: $origem (main @ $(git -C "$CACHE" rev-parse --short HEAD))"
fi

guias=()
for d in "$origem"/deskcomm-*; do [ -f "$d/SKILL.md" ] && guias+=("$(basename "$d")"); done
[ ${#guias[@]} -gt 0 ] || { echo "nenhum guia deskcomm-* em $origem" >&2; exit 1; }

# ── Ligar em cada pasta global ───────────────────────────────────────────────
ligados=0; pulados=0; copiados=0
for dest in "${DESTINOS[@]}"; do
  mkdir -p "$dest"
  for g in "${guias[@]}"; do
    alvo="$dest/$g"
    if [ -e "$alvo" ] || [ -L "$alvo" ]; then
      if eh_nosso "$alvo"; then rm -rf "$alvo"
      else echo "  pulei $alvo — já existe uma skill sua com esse nome"; pulados=$((pulados + 1)); continue; fi
    fi
    if ln -s "$origem/$g" "$alvo" 2>/dev/null && [ -L "$alvo" ]; then
      ligados=$((ligados + 1))
    else
      rm -rf "$alvo"; cp -R "$origem/$g" "$alvo"; : > "$alvo/$MARCA"; copiados=$((copiados + 1))
    fi
  done
done

echo "ok: ${#guias[@]} guias em ${#DESTINOS[@]} pastas — $ligados ligados, $copiados copiados, $pulados pulados"
printf '  %s\n' "${guias[@]}" | sed 's/^  /  \//'
echo "Abra uma sessão NOVA do seu CLI (Claude Code, Codex, Cursor, OpenCode ou Antigravity) e digite /deskcomm-"
[ "$copiados" -gt 0 ] && echo "(cópias não se atualizam sozinhas: rode este script de novo para atualizar)"
exit 0
