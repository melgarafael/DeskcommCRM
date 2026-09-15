#!/usr/bin/env bash
# Prova do scripts/instalar-guias.sh num HOME descartável e com um "repositório" local no
# lugar do GitHub — nada aqui toca as pastas de skills de quem roda o teste.
#
#   bash tests/shell/instalar-guias.test.sh
#
# O que está sob prova:
#   1. Instala: cada guia deskcomm-* vira link nas três pastas globais que os CLIs leem
#      (~/.claude/skills, ~/.agents/skills, ~/.gemini/config/skills), e só os deskcomm-*.
#   2. Não sobrescreve skill da pessoa com o mesmo nome — avisa e pula.
#   3. Atualiza: uma mudança no repositório chega pelo link depois de rodar de novo.
#   4. --fonte DIR aponta para um clone local.
#   5. --remover apaga só o que o script criou; a skill da pessoa fica.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$RAIZ/scripts/instalar-guias.sh"
falhas=0; casos=0
ok()   { casos=$((casos+1)); printf '  ✓ %s\n' "$1"; }
falha(){ casos=$((casos+1)); falhas=$((falhas+1)); printf '  ✗ %s\n     %s\n' "$1" "${2:-}"; }
checa(){ if eval "$1"; then ok "$2"; else falha "$2" "condição: $1"; fi; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export HOME="$TMP/home"; mkdir -p "$HOME"

# ── um "DeskcommCRM" mínimo: dois guias e uma skill que não é guia ────────────
repo="$TMP/repo"; mkdir -p "$repo"
git -C "$repo" init -q -b main
git -C "$repo" config user.email t@t; git -C "$repo" config user.name t
for n in deskcomm-instalar deskcomm-prompt sistema-vivo; do
  mkdir -p "$repo/.agents/skills/$n"
  printf -- "---\nname: %s\ndescription: 'guia %s'\n---\n\nversão 1\n" "$n" "$n" > "$repo/.agents/skills/$n/SKILL.md"
done
mkdir -p "$repo/app"; echo x > "$repo/app/fora-do-sparse.ts"
git -C "$repo" add -A && git -C "$repo" commit -q -m base
export DESKCOMM_REPO_URL="file://$repo"

echo "1. instalar a partir do repositório"
saida="$(bash "$SCRIPT" 2>&1)"; code=$?
checa "[ $code = 0 ]" "sai com 0"
for dest in .claude/skills .agents/skills .gemini/config/skills; do
  checa "[ -L \"\$HOME/$dest/deskcomm-instalar\" ] && [ -f \"\$HOME/$dest/deskcomm-instalar/SKILL.md\" ]" "deskcomm-instalar ligado em ~/$dest"
  checa "[ -L \"\$HOME/$dest/deskcomm-prompt\" ]" "deskcomm-prompt ligado em ~/$dest"
  checa "[ ! -e \"\$HOME/$dest/sistema-vivo\" ]" "sistema-vivo (não é guia deskcomm-*) fica de fora de ~/$dest"
done
checa "grep -q 'deskcomm-instalar' <<<\"\$saida\"" "a saída lista os guias"
checa "grep -q 'sessão NOVA' <<<\"\$saida\"" "a saída avisa para abrir sessão nova"

echo "2. não sobrescreve skill da pessoa"
rm -f "$HOME/.claude/skills/deskcomm-prompt"; mkdir -p "$HOME/.claude/skills/deskcomm-prompt"
echo "minha versão" > "$HOME/.claude/skills/deskcomm-prompt/SKILL.md"
saida="$(bash "$SCRIPT" 2>&1)"
checa "grep -q 'pulei .*deskcomm-prompt' <<<\"\$saida\"" "avisa que pulou"
checa "grep -q 'minha versão' \"\$HOME/.claude/skills/deskcomm-prompt/SKILL.md\"" "a skill da pessoa ficou intacta"

echo "3. atualizar"
sed -i.bak 's/versão 1/versão 2/' "$repo/.agents/skills/deskcomm-instalar/SKILL.md" && rm -f "$repo/.agents/skills/deskcomm-instalar/SKILL.md.bak"
git -C "$repo" commit -qam "v2"
bash "$SCRIPT" >/dev/null 2>&1
checa "grep -q 'versão 2' \"\$HOME/.agents/skills/deskcomm-instalar/SKILL.md\"" "a versão nova chega pelo link"

echo "4. --fonte DIR"
clone="$TMP/clone"; git clone -q "$repo" "$clone"
sed -i.bak 's/versão 2/versão local/' "$clone/.agents/skills/deskcomm-instalar/SKILL.md" && rm -f "$clone/.agents/skills/deskcomm-instalar/SKILL.md.bak"
bash "$SCRIPT" --fonte "$clone" >/dev/null 2>&1
checa "grep -q 'versão local' \"\$HOME/.claude/skills/deskcomm-instalar/SKILL.md\"" "o link passa a apontar para o clone local"

echo "5. --remover"
saida="$(bash "$SCRIPT" --remover 2>&1)"; code=$?
checa "[ $code = 0 ]" "sai com 0"
checa "[ ! -e \"\$HOME/.agents/skills/deskcomm-instalar\" ] && [ ! -L \"\$HOME/.agents/skills/deskcomm-instalar\" ]" "remove o link"
checa "[ -f \"\$HOME/.claude/skills/deskcomm-prompt/SKILL.md\" ]" "não remove a skill da pessoa"

echo "6. opção inválida"
bash "$SCRIPT" --nao-existe >/dev/null 2>&1; code=$?
checa "[ $code = 2 ]" "opção desconhecida sai com 2"

echo
if [ "$falhas" = 0 ]; then echo "instalar-guias: $casos casos, todos verdes"; exit 0
else echo "instalar-guias: $falhas de $casos casos vermelhos"; exit 1; fi
