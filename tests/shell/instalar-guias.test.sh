#!/usr/bin/env bash
# Prova do scripts/instalar-guias.sh num HOME descartável e com um "repositório" local no
# lugar do GitHub — nada aqui toca as pastas de skills de quem roda o teste.
#
#   bash tests/shell/instalar-guias.test.sh
#
# O que está sob prova:
#   1. Instala: cada guia deskcomm-* vira link nas três pastas globais que os CLIs leem
#      (~/.claude/skills, ~/.agents/skills, ~/.gemini/config/skills), e só os deskcomm-*.
#      A cópia é esparsa (só .agents/skills), e a saída diz que nada se atualiza sozinho
#      e como chamar o guia em cada CLI.
#   2. Não sobrescreve skill da pessoa com o mesmo nome — avisa e pula.
#   3. Atualiza: uma mudança no repositório chega pelo link depois de rodar de novo.
#   4. --fonte DIR aponta para um clone local.
#   5. --remover apaga só o que o script criou; a skill da pessoa fica.
#   6. Opção inválida.
#   7. Guia renomeado na fonte sai das três pastas (não fica link quebrado).
#   8. Sem link simbólico (Windows): copia, marca, atualiza e remove as cópias.
#   9. Execução interrompida entre o clone e o sparse-checkout se cura na seguinte.
#  10. sparse-checkout que falha num clone novo não deixa a cópia pela metade.
#  11. "nenhum guia" diz como sair dali.
#  12. Edição à mão pela pasta global não trava a atualização.
#  13. DESKCOMM_GUIAS_HOME: pasta alheia é recusada intacta; caminho relativo vira absoluto.
#  14. --help imprime o cabeçalho INTEIRO — também pelo pipe que o README ensina —, e ele não
#      promete o que --fonte não cumpre.
#  15. --fonte com link segue a árvore viva do clone (é a exceção que o cabeçalho declara).
#  16. Cópia feita por uma versão anterior (sem a marca) é adotada, não recusada.
#  17. A adoção não passa por um clone de trabalho — um caso por sinal que a segura.
#  18. --remover apaga o que este script ligou e poupa o link que a pessoa fez à mão.
#  19. O comando de desfazer que o README e a nota da versão ensinam roda de verdade.
#  20. Trocar de fonte (cópia → --fonte, e o inverso) não deixa guia da fonte anterior ligado,
#      nem para a varredura nem para o --remover — e o link feito à mão segue intacto.
#  21. Uma troca de fonte interrompida no meio não tira do --remover o que ela já ligou.
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
REAL_GIT="$(command -v git)"; export REAL_GIT
REAL_LN="$(command -v ln)"; export REAL_LN

# ── um "DeskcommCRM" mínimo: dois guias e uma skill que não é guia ────────────
montar_repo() {  # montar_repo <pasta>
  local r="$1" n
  mkdir -p "$r"
  git -C "$r" init -q -b main
  git -C "$r" config user.email t@t; git -C "$r" config user.name t
  for n in deskcomm-instalar deskcomm-prompt sistema-vivo; do
    mkdir -p "$r/.agents/skills/$n"
    printf -- "---\nname: %s\ndescription: 'guia %s'\n---\n\nversão 1\n" "$n" "$n" > "$r/.agents/skills/$n/SKILL.md"
  done
  mkdir -p "$r/app"; echo x > "$r/app/fora-do-sparse.ts"
  git -C "$r" add -A && git -C "$r" commit -q -m base
}

# Cada caso de 7 em diante começa do zero: HOME e repositório próprios.
cenario() {  # cenario <nome> → HOME, DESKCOMM_REPO_URL e $repo novos
  export HOME="$TMP/$1/home"; mkdir -p "$HOME"
  repo="$TMP/$1/repo"; montar_repo "$repo"
  export DESKCOMM_REPO_URL="file://$repo"
}

# Um git que se comporta como o de verdade, menos no sparse-checkout.
git_falso() {  # git_falso <pasta> <corpo-do-desvio>
  mkdir -p "$1"
  # shellcheck disable=SC2016  # o "$@" e o "$REAL_GIT" são do script gerado, não daqui
  printf '#!/usr/bin/env bash\nfor a in "$@"; do [ "$a" = sparse-checkout ] && { %s; }; done\nexec "$REAL_GIT" "$@"\n' "$2" > "$1/git"
  chmod +x "$1/git"
}

repo="$TMP/repo"; montar_repo "$repo"
export DESKCOMM_REPO_URL="file://$repo"

echo "1. instalar a partir do repositório"
saida="$(bash "$SCRIPT" 2>&1)"; code=$?
checa "[ $code = 0 ]" "sai com 0"
for dest in .claude/skills .agents/skills .gemini/config/skills; do
  checa "[ -L \"\$HOME/$dest/deskcomm-instalar\" ] && [ -f \"\$HOME/$dest/deskcomm-instalar/SKILL.md\" ]" "deskcomm-instalar ligado em ~/$dest"
  checa "[ -L \"\$HOME/$dest/deskcomm-prompt\" ]" "deskcomm-prompt ligado em ~/$dest"
  checa "[ ! -e \"\$HOME/$dest/sistema-vivo\" ]" "sistema-vivo (não é guia deskcomm-*) fica de fora de ~/$dest"
done
checa "grep -qE '^  deskcomm-instalar\$' <<<\"\$saida\" && ! grep -qE '^ +/deskcomm-' <<<\"\$saida\"" "a saída lista os guias pelo NOME, sem a barra que o Codex e o OpenCode não entendem"
checa "grep -q 'sessão NOVA' <<<\"\$saida\"" "a saída avisa para abrir sessão nova"
checa "[ -d \"\$HOME/.deskcomm/guias/.agents/skills\" ] && [ ! -e \"\$HOME/.deskcomm/guias/app\" ]" "a cópia é esparsa: traz .agents/skills e não traz app/"
checa "grep -q 'NÃO se atualizam sozinhos' <<<\"\$saida\"" "a saída diz que os guias não se atualizam sozinhos"
checa "grep -q 'Claude Code, um guia instalado aqui vale mais' <<<\"\$saida\"" "a saída diz que no Claude Code o guia global vence o do clone"
checa "grep -qF '\$deskcomm-instalar no Codex' <<<\"\$saida\" && ! grep -q 'digite /deskcomm-' <<<\"\$saida\"" "a saída ensina \$ no Codex, sem mandar digitar / em todos"

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

echo "7. guia renomeado na fonte"
cenario renomeado
bash "$SCRIPT" >/dev/null 2>&1
mkdir -p "$HOME/.claude/skills/deskcomm-meu"; echo "meu" > "$HOME/.claude/skills/deskcomm-meu/SKILL.md"
# A variante que importa é o LINK: a pasta da pessoa não tem a marca e nunca passou por "nosso",
# mas um link para o `deskcomm-*` de OUTRO repositório passava — e a varredura o apagava.
outro="$TMP/renomeado/outro-repo/.agents/skills/deskcomm-meu-fork"
mkdir -p "$outro"; echo "fork" > "$outro/SKILL.md"
ln -s "$outro" "$HOME/.claude/skills/deskcomm-meu-fork"
git -C "$repo" mv .agents/skills/deskcomm-prompt .agents/skills/deskcomm-prompt-agente && git -C "$repo" commit -qm renomeia
bash "$SCRIPT" >/dev/null 2>&1
for dest in .claude/skills .agents/skills .gemini/config/skills; do
  checa "[ ! -e \"\$HOME/$dest/deskcomm-prompt\" ] && [ ! -L \"\$HOME/$dest/deskcomm-prompt\" ] && [ -f \"\$HOME/$dest/deskcomm-prompt-agente/SKILL.md\" ]" "em ~/$dest, o nome antigo sai e o novo entra"
done
checa "[ -f \"\$HOME/.claude/skills/deskcomm-meu/SKILL.md\" ]" "a varredura não toca skill deskcomm-* da pessoa"
checa "[ -L \"\$HOME/.claude/skills/deskcomm-meu-fork\" ] && [ -f \"\$outro/SKILL.md\" ]" "a varredura não toca LINK que a pessoa fez para o deskcomm-* de outro repositório"

echo "8. sem link simbólico: cópia marcada"
cenario copia
mkdir -p "$TMP/ln-falso"; printf '#!/bin/sh\nexit 1\n' > "$TMP/ln-falso/ln"; chmod +x "$TMP/ln-falso/ln"
saida="$(PATH="$TMP/ln-falso:$PATH" bash "$SCRIPT" 2>&1)"; code=$?
checa "[ $code = 0 ] && grep -q '0 ligados, 6 copiados' <<<\"\$saida\"" "sem ln, copia os 6 e sai com 0"
checa "[ ! -L \"\$HOME/.agents/skills/deskcomm-instalar\" ] && [ -f \"\$HOME/.agents/skills/deskcomm-instalar/.deskcomm-guia\" ]" "a cópia leva a marca .deskcomm-guia"
sed -i.bak 's/versão 1/versão 2/' "$repo/.agents/skills/deskcomm-instalar/SKILL.md" && rm -f "$repo/.agents/skills/deskcomm-instalar/SKILL.md.bak"
git -C "$repo" mv .agents/skills/deskcomm-prompt .agents/skills/deskcomm-prompt-agente
git -C "$repo" commit -qam "v2 e renomeia"
saida="$(PATH="$TMP/ln-falso:$PATH" bash "$SCRIPT" 2>&1)"
checa "grep -q 'versão 2' \"\$HOME/.agents/skills/deskcomm-instalar/SKILL.md\" && ! grep -q pulei <<<\"\$saida\"" "a segunda execução atualiza a cópia (não pula)"
checa "[ ! -e \"\$HOME/.claude/skills/deskcomm-prompt\" ]" "a cópia do guia renomeado sai"
saida="$(bash "$SCRIPT" --remover 2>&1)"
checa "grep -q 'ok: 6 ligação' <<<\"\$saida\" && [ ! -e \"\$HOME/.agents/skills/deskcomm-instalar\" ]" "--remover apaga as 6 cópias"

echo "9. execução interrompida no sparse-checkout"
cenario interrompido
# shellcheck disable=SC2016  # o $PPID é o do git falso: o script que o chamou
git_falso "$TMP/git-mata" 'kill -KILL "$PPID"; exit 130'
{ PATH="$TMP/git-mata:$PATH" bash "$SCRIPT" >/dev/null 2>&1; } 2>/dev/null; code=$?   # o aviso "Killed" é do bash de fora
checa "[ $code != 0 ]" "(pré-condição) a primeira execução morre no meio"
saida="$(bash "$SCRIPT" 2>&1)"; code=$?
checa "[ $code = 0 ] && [ -f \"\$HOME/.claude/skills/deskcomm-instalar/SKILL.md\" ]" "a execução seguinte se cura e liga os guias"

echo "10. sparse-checkout que falha num clone novo"
cenario sparse-falha
git_falso "$TMP/git-falha" 'echo "fatal: could not fetch from promisor remote" >&2; exit 128'
saida="$(PATH="$TMP/git-falha:$PATH" bash "$SCRIPT" 2>&1)"; code=$?
checa "[ $code != 0 ] && [ ! -e \"\$HOME/.deskcomm/guias\" ]" "sai com erro e não deixa a cópia pela metade"

echo "11. nenhum guia na fonte"
cenario sem-guias
git -C "$repo" rm -rq .agents/skills/deskcomm-instalar .agents/skills/deskcomm-prompt && git -C "$repo" commit -qm "sem guias"
saida="$(bash "$SCRIPT" 2>&1)"; code=$?
checa "[ $code = 1 ] && grep -qF \"rm -rf \\\"\$HOME/.deskcomm/guias\\\"\" <<<\"\$saida\"" "sai com 1 e diz como apagar a cópia"

echo "12. edição à mão pela pasta global"
cenario editado
bash "$SCRIPT" >/dev/null 2>&1
echo "anotação local" >> "$HOME/.claude/skills/deskcomm-instalar/SKILL.md"
echo "anotação local" >> "$HOME/.claude/skills/deskcomm-prompt/SKILL.md"
sed -i.bak 's/versão 1/versão 2/' "$repo/.agents/skills/deskcomm-instalar/SKILL.md" && rm -f "$repo/.agents/skills/deskcomm-instalar/SKILL.md.bak"
git -C "$repo" commit -qam v2
saida="$(bash "$SCRIPT" 2>&1)"; code=$?
checa "[ $code = 0 ]" "a atualização não trava (sai com 0)"
checa "grep -q 'versão 2' \"\$HOME/.claude/skills/deskcomm-instalar/SKILL.md\" && ! grep -q 'anotação' \"\$HOME/.claude/skills/deskcomm-instalar/SKILL.md\"" "o guia editado E mudado na main chega na versão nova"
checa "! grep -q 'anotação' \"\$HOME/.claude/skills/deskcomm-prompt/SKILL.md\"" "a edição que não conflita também não sobrevive calada"
checa "grep -q 'descartad' <<<\"\$saida\"" "avisa que descartou a alteração"

echo "13. DESKCOMM_GUIAS_HOME"
cenario pasta-alheia
mkdir -p "$TMP/pasta-alheia/minha"; echo nota > "$TMP/pasta-alheia/minha/nota.txt"
saida="$(DESKCOMM_GUIAS_HOME="$TMP/pasta-alheia/minha" bash "$SCRIPT" 2>&1)"; code=$?
checa "[ $code != 0 ] && [ -f \"\$TMP/pasta-alheia/minha/nota.txt\" ] && grep -q 'não mexo' <<<\"\$saida\"" "pasta com arquivo e sem .git: recusa e a nota fica"
alheio="$TMP/pasta-alheia/clone-alheio"; git clone -q "$repo" "$alheio"; echo "trabalho" >> "$alheio/.agents/skills/deskcomm-instalar/SKILL.md"
DESKCOMM_GUIAS_HOME="$alheio" bash "$SCRIPT" >/dev/null 2>&1; code=$?
checa "[ $code != 0 ] && grep -q 'trabalho' \"\$alheio/.agents/skills/deskcomm-instalar/SKILL.md\"" "clone que não é a cópia do script: recusa e o trabalho não commitado fica"
mkdir -p "$TMP/pasta-alheia/vazia"
PATH="$TMP/git-falha:$PATH" DESKCOMM_GUIAS_HOME="$TMP/pasta-alheia/vazia" bash "$SCRIPT" >/dev/null 2>&1
checa "[ -d \"\$TMP/pasta-alheia/vazia\" ]" "pasta vazia que já existia: uma falha não a apaga"
DESKCOMM_GUIAS_HOME="$TMP/pasta-alheia/vazia" bash "$SCRIPT" >/dev/null 2>&1; code=$?
checa "[ $code = 0 ] && [ -f \"\$HOME/.agents/skills/deskcomm-instalar/SKILL.md\" ]" "pasta vazia que já existia: é aceita"
cenario relativo
mkdir -p "$TMP/relativo/cwd"
(cd "$TMP/relativo/cwd" && DESKCOMM_GUIAS_HOME=cache-rel bash "$SCRIPT" >/dev/null 2>&1)
checa "[ -f \"\$HOME/.claude/skills/deskcomm-instalar/SKILL.md\" ]" "caminho relativo: o link resolve (vira absoluto)"

echo "14. --help"
# Pelo pipe o script chega pela entrada padrão e `$0` vale `bash`: um --help que relê o próprio
# arquivo saía vazio, com exit 0, justamente no caminho que o README ensina.
for modo in arquivo pipe; do
  if [ "$modo" = arquivo ]; then saida="$(bash "$SCRIPT" --help 2>&1)"; code=$?
  # Pela entrada padrão, sem `cat |`: com pipefail, o `cat` leva SIGPIPE quando o bash sai do --help
  # antes de ler tudo, e o 141 dele mascarava o exit do script (medido num contêiner com pipe de 8 KB).
  else saida="$(bash -s -- --help < "$SCRIPT" 2>&1)"; code=$?; fi
  checa "[ $code = 0 ]" "($modo) sai com 0"
  checa "grep -qF 'instalar-guias.sh — deixa os guias' <<<\"\$saida\"" "($modo) imprime a primeira linha do cabeçalho"
  # O recorte por número de linha já comeu o fim do cabeçalho uma vez: o aviso do Claude Code é a
  # ÚLTIMA linha, e é ele que diz a quem edita um guia para usar --fonte.
  checa "grep -qF 'deve rodar com \`--fonte .\` naquele clone' <<<\"\$saida\"" "($modo) imprime a ÚLTIMA linha do cabeçalho (o aviso do Claude Code)"
  checa "! grep -qF 'set -euo pipefail' <<<\"\$saida\"" "($modo) para no fim do cabeçalho, não despeja o código"
  checa "grep -qF 'a exceção é' <<<\"\$saida\"" "($modo) o cabeçalho declara a exceção de --fonte em vez de prometer que nada se atualiza"
done

echo "15. --fonte com link segue a árvore viva do clone"
cenario fonte-viva
clone_vivo="$TMP/fonte-viva/clone"; git clone -q "$repo" "$clone_vivo"
bash "$SCRIPT" --fonte "$clone_vivo" >/dev/null 2>&1
sed -i.bak 's/versão 1/versão editada sem rodar de novo/' "$clone_vivo/.agents/skills/deskcomm-instalar/SKILL.md"
rm -f "$clone_vivo/.agents/skills/deskcomm-instalar/SKILL.md.bak"
checa "grep -q 'versão editada sem rodar de novo' \"\$HOME/.claude/skills/deskcomm-instalar/SKILL.md\"" "a edição no clone chega pela pasta global SEM rodar o script de novo"

echo "16. cópia de uma versão anterior do script"
cenario copia-sem-marca
bash "$SCRIPT" >/dev/null 2>&1
# O que a versão anterior deixava: o mesmo clone raso e esparso, só que sem a marca — ela ainda
# não a gravava. Tirar a marca reproduz esse estado sem prender o teste a um SHA.
git -C "$HOME/.deskcomm/guias" config --unset deskcomm.guias
antes="$(git -C "$HOME/.deskcomm/guias" rev-parse HEAD)"
sed -i.bak 's/versão 1/versão 2/' "$repo/.agents/skills/deskcomm-instalar/SKILL.md"
rm -f "$repo/.agents/skills/deskcomm-instalar/SKILL.md.bak"; git -C "$repo" commit -qam v2
saida="$(bash "$SCRIPT" 2>&1)"; code=$?
checa "[ $code = 0 ] && ! grep -q 'não mexo nela' <<<\"\$saida\"" "a cópia sem a marca é adotada, não recusada"
checa "grep -q 'versão 2' \"\$HOME/.claude/skills/deskcomm-instalar/SKILL.md\" && [ \"\$(git -C \"\$HOME/.deskcomm/guias\" rev-parse HEAD)\" != \"\$antes\" ]" "e a versão nova chega (os guias não congelam no dia da instalação)"
checa "[ \"\$(git -C \"\$HOME/.deskcomm/guias\" config --get deskcomm.guias)\" = true ]" "a marca fica gravada, e a execução seguinte não reprecisa adotar"

# Os quatro sinais que seguram a adoção, um caso para cada um. O clone do caso 13 falha em DOIS
# ao mesmo tempo (é completo E sujo), então ele não distingue qual deles reprovou: medido em
# 2026-09-16, dava para apagar a checagem de raso, a de limpo ou a de remoto, uma de cada vez,
# e os 56 casos de então seguiam verdes nas três. Cada clone abaixo falha em UM sinal só, e é
# assim que a sabotagem de um sinal aponta para o caso dele.
echo "17. a adoção não passa por um clone de trabalho"
cenario adocao-apontada
# O sinal da d9: pasta apontada à mão nunca é adotada. Este clone tem a cara da cópia do script
# — raso, do mesmo repositório e limpo NESTE instante — e mesmo assim é de quem o apontou.
trabalho="$TMP/adocao-apontada/meu-clone"; git clone -q --depth 1 "file://$repo" "$trabalho"
git -C "$trabalho" checkout -qb minha-feature
saida="$(DESKCOMM_GUIAS_HOME="$trabalho" bash "$SCRIPT" 2>&1)"; code=$?
checa "[ $code != 0 ] && [ \"\$(git -C \"\$trabalho\" symbolic-ref --short -q HEAD)\" = minha-feature ] && [ -z \"\$(git -C \"\$trabalho\" config --get deskcomm.guias || true)\" ]" "clone raso e limpo apontado à mão: recusado, na branch dele e sem a marca"

cenario adocao-outro-remoto
outro_repo="$TMP/adocao-outro-remoto/outro"; montar_repo "$outro_repo"
mkdir -p "$HOME/.deskcomm"; git clone -q --depth 1 "file://$outro_repo" "$HOME/.deskcomm/guias"
saida="$(bash "$SCRIPT" 2>&1)"; code=$?
checa "[ $code != 0 ] && grep -q 'não mexo nela' <<<\"\$saida\" && [ -z \"\$(git -C \"\$HOME/.deskcomm/guias\" config --get deskcomm.guias || true)\" ]" "clone raso e limpo de OUTRO repositório: recusado e sem a marca"

cenario adocao-completo
mkdir -p "$HOME/.deskcomm"; git clone -q "file://$repo" "$HOME/.deskcomm/guias"
saida="$(bash "$SCRIPT" 2>&1)"; code=$?
checa "[ $code != 0 ] && grep -q 'não mexo nela' <<<\"\$saida\" && [ -z \"\$(git -C \"\$HOME/.deskcomm/guias\" config --get deskcomm.guias || true)\" ]" "clone COMPLETO e limpo do mesmo repositório: recusado e sem a marca"

cenario adocao-sujo
mkdir -p "$HOME/.deskcomm"; git clone -q --depth 1 "file://$repo" "$HOME/.deskcomm/guias"
echo "trabalho" >> "$HOME/.deskcomm/guias/.agents/skills/deskcomm-instalar/SKILL.md"
saida="$(bash "$SCRIPT" 2>&1)"; code=$?
checa "[ $code != 0 ] && grep -q 'trabalho' \"\$HOME/.deskcomm/guias/.agents/skills/deskcomm-instalar/SKILL.md\"" "clone raso do mesmo repositório com pendência: recusado e o trabalho fica"

echo "18. --remover poupa o link que a pessoa fez à mão"
cenario remover-alheio
alheio_fork="$TMP/remover-alheio/outro-repo/.agents/skills/deskcomm-meu-fork"
mkdir -p "$alheio_fork" "$HOME/.claude/skills"; echo "fork" > "$alheio_fork/SKILL.md"
ln -s "$alheio_fork" "$HOME/.claude/skills/deskcomm-meu-fork"
saida="$(bash "$SCRIPT" --remover 2>&1)"
checa "grep -q 'ok: 0 ligação' <<<\"\$saida\" && [ -L \"\$HOME/.claude/skills/deskcomm-meu-fork\" ]" "sem instalação nenhuma, --remover não tem o que desfazer e não toca o link da pessoa"
bash "$SCRIPT" >/dev/null 2>&1
saida="$(bash "$SCRIPT" --remover 2>&1)"
checa "grep -q 'ok: 6 ligação' <<<\"\$saida\" && [ -L \"\$HOME/.claude/skills/deskcomm-meu-fork\" ] && [ ! -e \"\$HOME/.agents/skills/deskcomm-instalar\" ]" "com instalação, --remover tira as 6 ligações e o link da pessoa fica"

echo "19. o comando de desfazer que a documentação ensina"
cenario documentacao
# Não é grep de frase: o comando é EXTRAÍDO do documento e EXECUTADO, trocando só o curl pelo
# script deste repo. `| bash --remover` — o que os dois documentos diziam — faz o próprio bash
# recusar a opção, e nada do que está instalado sai.
# O fragmento some quando a release é cortada, e o mesmo texto passa a viver no CHANGELOG (o
# corte copia o corpo). Por isso a varredura é por documento QUE MENCIONA o comando, com piso
# de dois — senão, no dia do corte, o gate viraria verde por não ter mais o que ler.
documentos=0
for doc in "$RAIZ/README.md" "$RAIZ/CHANGELOG.md" "$RAIZ"/.changes/*.md; do
  [ -f "$doc" ] || continue
  # No CHANGELOG a entrada mais nova é a de cima: o primeiro casamento é o que se ensina hoje.
  desfaz="$(grep -o 'bash[^`]*--remover' "$doc" | head -1)"
  [ -n "$desfaz" ] || continue
  documentos=$((documentos + 1))
  bash "$SCRIPT" >/dev/null 2>&1
  saida="$(cat "$SCRIPT" | eval "$desfaz" 2>&1)"; code=$?
  checa "[ $code = 0 ] && [ ! -e \"\$HOME/.agents/skills/deskcomm-instalar\" ]" "o comando de $(basename "$doc") desfaz de verdade (é: $desfaz)"
done
checa "[ $documentos -ge 2 ]" "o comando foi lido de pelo menos dois documentos (guarda de vacuidade)"
# A outra metade que só vive em prosa: a forma de chamar em cada CLI e a defasagem da cópia.
checa "grep -qF '\$deskcomm-instalar' \"\$RAIZ/README.md\" && ! grep -qE 'digite .?/deskcomm-' \"\$RAIZ/README.md\"" "o README ensina a forma do Codex e não manda digitar / em todos"
checa "grep -q 'se atualizam sozinhos' \"\$RAIZ/README.md\" && grep -q 'vale mais que o do clone' \"\$RAIZ/README.md\"" "o README diz que a cópia não se atualiza sozinha e que no Claude Code ela vence o clone"

# Os deskcomm-* que sobraram nas três pastas, fora o link que a pessoa fez à mão.
# shellcheck disable=SC2329  # chamada de dentro das condições que o `checa` avalia
guias_que_sobraram() {
  local d a
  for d in .claude/skills .agents/skills .gemini/config/skills; do
    for a in "$HOME/$d"/deskcomm-*; do
      { [ -e "$a" ] || [ -L "$a" ]; } || continue
      [ "$(basename "$a")" = deskcomm-meu-fork ] || echo "$d/$(basename "$a")"
    done
  done
}
guia_extra() {  # guia_extra <clone> — um guia que só esse clone tem
  mkdir -p "$1/.agents/skills/deskcomm-extra"
  printf -- "---\nname: deskcomm-extra\ndescription: 'guia extra'\n---\n" > "$1/.agents/skills/deskcomm-extra/SKILL.md"
}

echo "20. trocar de fonte não deixa guia da fonte anterior ligado"
cenario troca-de-fonte
fork_troca="$TMP/troca-de-fonte/outro-repo/.agents/skills/deskcomm-meu-fork"
mkdir -p "$fork_troca" "$HOME/.agents/skills"; echo fork > "$fork_troca/SKILL.md"
ln -s "$fork_troca" "$HOME/.agents/skills/deskcomm-meu-fork"
bash "$SCRIPT" >/dev/null 2>&1   # a cópia: deskcomm-instalar e deskcomm-prompt
menor="$TMP/troca-de-fonte/clone-menor"; git clone -q "$repo" "$menor"
git -C "$menor" rm -rq .agents/skills/deskcomm-prompt
bash "$SCRIPT" --fonte "$menor" >/dev/null 2>&1
for dest in .claude/skills .agents/skills .gemini/config/skills; do
  checa "[ ! -e \"\$HOME/$dest/deskcomm-prompt\" ] && [ ! -L \"\$HOME/$dest/deskcomm-prompt\" ]" "cópia → --fonte sem o deskcomm-prompt: ele sai de ~/$dest na hora da troca"
done
bash "$SCRIPT" --remover >/dev/null 2>&1; code=$?
checa "[ $code = 0 ] && [ -z \"\$(guias_que_sobraram)\" ]" "e o --remover seguinte não deixa guia nenhum nas três pastas"
maior="$TMP/troca-de-fonte/clone-maior"; git clone -q "$repo" "$maior"; guia_extra "$maior"
bash "$SCRIPT" --fonte "$maior" >/dev/null 2>&1
bash "$SCRIPT" >/dev/null 2>&1   # de volta à cópia, que não tem o deskcomm-extra
for dest in .claude/skills .agents/skills .gemini/config/skills; do
  checa "[ ! -e \"\$HOME/$dest/deskcomm-extra\" ] && [ ! -L \"\$HOME/$dest/deskcomm-extra\" ]" "--fonte com o deskcomm-extra → cópia: ele sai de ~/$dest na hora da troca"
done
bash "$SCRIPT" --remover >/dev/null 2>&1; code=$?
checa "[ $code = 0 ] && [ -z \"\$(guias_que_sobraram)\" ]" "e o --remover seguinte não deixa guia nenhum nas três pastas"
checa "[ -L \"\$HOME/.agents/skills/deskcomm-meu-fork\" ] && [ -f \"\$fork_troca/SKILL.md\" ]" "o link feito à mão para outro repositório atravessa as duas trocas e os dois --remover"

echo "21. troca de fonte interrompida no meio"
cenario troca-interrompida
bash "$SCRIPT" >/dev/null 2>&1
interrompido="$TMP/troca-interrompida/clone"; git clone -q "$repo" "$interrompido"; guia_extra "$interrompido"
mkdir -p "$TMP/ln-mata"
# shellcheck disable=SC2016  # o "$@", o $REAL_LN e o $PPID são do ln falso: o script que o chamou
printf '#!/usr/bin/env bash\n"$REAL_LN" "$@"\nkill -KILL "$PPID"; exit 130\n' > "$TMP/ln-mata/ln"; chmod +x "$TMP/ln-mata/ln"
{ PATH="$TMP/ln-mata:$PATH" bash "$SCRIPT" --fonte "$interrompido" >/dev/null 2>&1; } 2>/dev/null; code=$?
checa "[ $code != 0 ] && ls -l \"\$HOME/.claude/skills\" | grep -qF \"\$interrompido/\"" "(pré-condição) a execução morre depois de ligar um guia ao clone"
bash "$SCRIPT" --remover >/dev/null 2>&1; code=$?
checa "[ $code = 0 ] && [ -z \"\$(guias_que_sobraram)\" ]" "o --remover seguinte tira também o que a execução interrompida ligou"

echo
if [ "$falhas" = 0 ]; then echo "instalar-guias: $casos casos, todos verdes"; exit 0
else echo "instalar-guias: $falhas de $casos casos vermelhos"; exit 1; fi
