#!/usr/bin/env bash
# O cabeçalho é o texto do --help, logo abaixo, e não um comentário: pelo pipe que o README ensina
# (`curl ... | bash`; a ajuda é `curl ... | bash -s -- --help`) o script chega pela entrada padrão,
# `$0` vale `bash` e não há arquivo de onde reler um comentário — o --help saía vazio, com exit 0.
ajuda() {
  cat <<'AJUDA'
instalar-guias.sh — deixa os guias do assistente (deskcomm-instalar, deskcomm-cliente-novo,
deskcomm-metricas, deskcomm-prompt, deskcomm-contribuir, deskcomm-doutrina) disponíveis
em QUALQUER pasta, não só dentro de um clone do DeskcommCRM.

── Por que existe ────────────────────────────────────────────────────────────

Os guias vivem em `.agents/skills/` (espelho em `.claude/skills/`) e todo CLI de IA os
carrega — mas só com a sessão aberta DENTRO de um clone atualizado. Três pessoas ficavam de
fora: quem ainda não clonou (justamente o leigo que quer instalar), quem trabalha num
clone/branch antigo, e quem opera vários clientes a partir de outra pasta. Medido em
2026-09-15: numa cópia da main o Claude Code lista os sete guias; numa branch atrasada, zero.

── O que faz ─────────────────────────────────────────────────────────────────

1. Mantém uma cópia rasa só de `.agents/skills` em ~/.deskcomm/guias (clone esparso da main,
   atualizado a cada execução — e SÓ nela). Com --fonte DIR, usa o `.agents/skills` de um
   clone seu.
2. Liga cada guia `deskcomm-*` nas pastas GLOBAIS que os CLIs leem — medidas, não supostas:
     ~/.claude/skills       Claude Code (e Cursor e OpenCode, por compatibilidade)
     ~/.agents/skills       Codex, Cursor e OpenCode (padrão aberto Agent Skills)
     ~/.gemini/config/skills  Antigravity
   Por link simbólico: rodar de novo atualiza a cópia e as três pastas enxergam a versão nova
   sem recopiar. Onde o sistema não cria link (Windows sem modo desenvolvedor), copia e marca
   a pasta com `.deskcomm-guia`. Nada se atualiza sem rodar o script de novo — a exceção é
   `--fonte` com link, que segue a árvore viva do clone (é para isso que ele serve).
   Guia que saiu da fonte (renomeado ou removido) sai também das três pastas — e, ao trocar
   de fonte (da cópia para `--fonte` ou o inverso), sai também o que só a fonte anterior tinha.

Nunca sobrescreve uma skill sua com o mesmo nome: se a pasta existe e não foi este script
que a criou, avisa e pula. `--remover` só apaga o que este script criou: ele anota em cada
pasta global, num `.deskcomm-fonte`, de onde saíram as ligações daquela pasta, e por isso não
toca no link que você mesmo fez para o `deskcomm-*` de outro clone.

── Uso ───────────────────────────────────────────────────────────────────────

  curl -fsSL https://raw.githubusercontent.com/melgarafael/DeskcommCRM/main/scripts/instalar-guias.sh | bash
  curl -fsSL https://raw.githubusercontent.com/melgarafael/DeskcommCRM/main/scripts/instalar-guias.sh | bash -s -- --remover
  bash scripts/instalar-guias.sh                 # instala ou atualiza (cópia da main)
  bash scripts/instalar-guias.sh --fonte .       # aponta para ESTE clone (quem edita os guias)
  bash scripts/instalar-guias.sh --remover       # desfaz

Depois de instalar, abra uma sessão NOVA do seu CLI: skills são lidas quando a sessão começa.

⚠️ Claude Code: uma skill global com o mesmo nome VENCE a do projeto. Quem edita um guia numa
branch e quer testá-lo deve rodar com `--fonte .` naquele clone (ou `--remover`).
AJUDA
}

set -euo pipefail

REPO_URL="${DESKCOMM_REPO_URL:-https://github.com/melgarafael/DeskcommCRM.git}"
CACHE_PADRAO="$HOME/.deskcomm/guias"
CACHE="${DESKCOMM_GUIAS_HOME:-$CACHE_PADRAO}"
# Absoluto, como o --fonte: o link guarda o caminho LITERAL, e um relativo
# (`DESKCOMM_GUIAS_HOME=cache`) nascia quebrado e ainda era contado como "ligado".
case "$CACHE" in /*) ;; *) CACHE="$PWD/$CACHE" ;; esac
DESTINOS=("$HOME/.claude/skills" "$HOME/.agents/skills" "$HOME/.gemini/config/skills")
MARCA=".deskcomm-guia"
REGISTRO=".deskcomm-fonte"

acao="instalar"; fonte=""
while [ $# -gt 0 ]; do
  case "$1" in
    --remover) acao="remover" ;;
    --fonte) shift; fonte="${1:-}"; [ -n "$fonte" ] || { echo "--fonte precisa de uma pasta" >&2; exit 2; } ;;
    -h|--help) ajuda; exit 0 ;;
    *) echo "opção desconhecida: $1 (use --fonte DIR, --remover ou --help)" >&2; exit 2 ;;
  esac
  shift
done

# Um guia instalado por este script: link que aponta para uma pasta `.agents/skills/deskcomm-*`,
# ou cópia marcada. Tudo o mais é da pessoa e não se toca.
#
# Com fontes, só conta o link que aponta para UMA delas, e quem APAGA sempre passa as fontes do
# registro: a varredura de obsoletos e o `--remover`. Sem esse aperto os dois apagavam também o
# link que a pessoa fez à mão para o `deskcomm-*` de outro repositório, porque no teste largo
# qualquer link para um guia responde "sou seu". Só o laço que INSTALA segue no largo — religar
# um guia de mesmo nome é justamente o que `--fonte` (e voltar dele) faz, e ali o alvo é
# substituído pela ligação nova, não perdido.
eh_nosso() {  # eh_nosso <alvo> [fonte...]
  local alvo="$1" destino f; shift
  if [ -L "$alvo" ]; then
    destino="$(readlink "$alvo")"
    if [ $# -gt 0 ]; then
      # Padrão entre aspas: comparação LITERAL, não glob — um caminho com `[` ou `*` não vira regra.
      for f in "$@"; do case "$destino" in "$f/$(basename "$alvo")") return 0 ;; esac; done
      return 1
    fi
    case "$destino" in */.agents/skills/deskcomm-*) return 0 ;; esac
    return 1
  fi
  [ -f "$alvo/$MARCA" ]
}

# As fontes de onde este script ligou guias em <dest>, uma por linha no `.deskcomm-fonte`, vão
# para `fontes_registradas`. É lista, e não uma linha só, porque uma instalação registra a fonte
# nova ao lado das anteriores ANTES de ligar (ver o laço de ligar). Sem registro (instalação de
# uma versão anterior a ele), a única fonte que este script pode ter usado sem ninguém lhe dizer
# é a cópia.
ler_fontes() {  # ler_fontes <dest>
  local linha
  fontes_registradas=()
  if [ -f "$1/$REGISTRO" ]; then
    while IFS= read -r linha || [ -n "$linha" ]; do
      [ -z "$linha" ] || fontes_registradas+=("$linha")
    done < "$1/$REGISTRO"
  fi
  [ ${#fontes_registradas[@]} -gt 0 ] || fontes_registradas=("$CACHE/.agents/skills")
}

# A cópia é deste script quando ele a marcou ao clonar. Sem a marca, um clone qualquer apontado
# por DESKCOMM_GUIAS_HOME passaria pelo checkout --force da atualização e perderia o trabalho
# não commitado de quem o apontou.
eh_a_copia() {
  [ -d "$CACHE/.git" ] && [ "$(git -C "$CACHE" config --get deskcomm.guias || true)" = true ]
}

# Cópia feita por uma versão ANTERIOR deste script: ela não tem a marca, então `eh_a_copia` a
# nega e a recusa abaixo a bloquearia em toda execução — os guias de quem já instalou ficariam
# congelados na versão do dia até um `rm -rf` à mão.
#
# Adotar não é um detalhe de contabilidade: é passar a fazer `checkout --force` dentro daquela
# pasta. Por isso só entra na conversa a pasta que ESTE script escolhe sozinho — o padrão. Uma
# pasta apontada à mão por DESKCOMM_GUIAS_HOME é de quem a apontou, e um clone de trabalho raso
# e limpo NAQUELE instante tem exatamente a cara da cópia: era adotado, saía da branch da pessoa,
# ficava marcado para sempre e descartava o não commitado dela na execução seguinte.
#
# Mesmo no padrão, exige os três sinais do clone que este script faz: o remoto é o repositório
# do produto, o clone é raso (`--depth 1`) e nada foi alterado nem acrescentado à mão.
eh_copia_de_versao_anterior() {
  [ "$CACHE" = "$CACHE_PADRAO" ] || return 1
  [ -d "$CACHE/.git" ] || return 1
  [ "$(git -C "$CACHE" remote get-url origin 2>/dev/null || true)" = "$REPO_URL" ] || return 1
  [ "$(git -C "$CACHE" rev-parse --is-shallow-repository 2>/dev/null || true)" = true ] || return 1
  [ -z "$(git -C "$CACHE" status --porcelain 2>/dev/null)" ]
}

# Desfaz um clone que não terminou, apagando só o que ESTA execução criou: a pasta inteira se
# ela nasceu agora, ou só o conteúdo se ela já existia (vazia — pasta cheia é recusada antes).
descartar_tentativa() {
  if [ "$cache_nasceu" = 1 ]; then rm -rf "$CACHE"
  else find "$CACHE" -mindepth 1 -maxdepth 1 -exec rm -rf {} +; fi
}

if [ "$acao" = "remover" ]; then
  removidos=0
  for dest in "${DESTINOS[@]}"; do
    [ -d "$dest" ] || continue
    # De onde este script ligou, que é o que o `--remover` desfaz. Sem esse registro o teste era
    # o largo — "o alvo parece um guia?" —, e a ligação que a PESSOA fez à mão para o
    # `deskcomm-*` de outro clone responde que sim: ela era apagada, o contrário do que o
    # cabeçalho promete.
    ler_fontes "$dest"
    for alvo in "$dest"/deskcomm-*; do
      [ -e "$alvo" ] || [ -L "$alvo" ] || continue
      if eh_nosso "$alvo" "${fontes_registradas[@]}"; then rm -rf "$alvo"; removidos=$((removidos + 1)); fi
    done
    rm -f "$dest/$REGISTRO"
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
  if ! eh_a_copia && eh_copia_de_versao_anterior; then git -C "$CACHE" config deskcomm.guias true; fi
  if eh_a_copia; then
    # A cópia é do script, e as pastas globais apontam para DENTRO dela: uma edição feita por
    # ~/.claude/skills/deskcomm-*/ travava toda atualização seguinte com o erro cru do git
    # ("Your local changes would be overwritten") — ou, sem conflito, sobrevivia calada.
    sujo="$(git -C "$CACHE" status --porcelain --untracked-files=no)"
    git -C "$CACHE" fetch -q --depth 1 origin main
    git -C "$CACHE" checkout -q --force --detach FETCH_HEAD
    [ -z "$sujo" ] || echo "  aviso: alterações feitas à mão em $CACHE foram descartadas (para editar um guia, use --fonte num clone)"
    # Reaplicado a cada execução (é idempotente): uma primeira execução interrompida entre o
    # clone e este passo deixava a cópia só com os arquivos da raiz, e toda execução seguinte
    # saía com "nenhum guia", para sempre.
    if [ "$(git -C "$CACHE" config --get core.sparseCheckout || true)" = true ]; then
      git -C "$CACHE" sparse-checkout set .agents/skills
    fi
  elif { [ -e "$CACHE" ] || [ -L "$CACHE" ]; } && ! { [ -d "$CACHE" ] && [ -z "$(ls -A "$CACHE")" ]; }; then
    echo "$CACHE já existe e não é uma cópia feita por este script — não mexo nela." >&2
    echo "Aponte DESKCOMM_GUIAS_HOME para uma pasta nova (ou vazia). Se quem a criou foi uma versão anterior deste instalador, apague-a: rm -rf \"$CACHE\"" >&2
    exit 1
  else
    cache_nasceu=1; [ -d "$CACHE" ] && cache_nasceu=0
    mkdir -p "$(dirname "$CACHE")"
    if git clone -q --depth 1 --filter=blob:none --sparse "$REPO_URL" "$CACHE" 2>/dev/null; then
      # Marcada ANTES do sparse-checkout: se a execução morrer nele (Ctrl-C), a seguinte
      # reconhece a cópia e o reaplica em vez de recusá-la.
      git -C "$CACHE" config deskcomm.guias true
      # O clone esparso só traz os arquivos da raiz; sem este passo não há guia nenhum.
      if ! git -C "$CACHE" sparse-checkout set .agents/skills; then
        descartar_tentativa
        echo "não consegui baixar os guias (a conexão caiu?) — nada ficou pela metade; rode o comando de novo" >&2
        exit 1
      fi
    else
      descartar_tentativa
      git clone -q --depth 1 "$REPO_URL" "$CACHE"   # git antigo, sem --sparse: clone completo
      git -C "$CACHE" config deskcomm.guias true
      git -C "$CACHE" sparse-checkout set .agents/skills 2>/dev/null || true   # só poupa disco: os guias já vieram
    fi
  fi
  origem="$CACHE/.agents/skills"
  echo "fonte: $origem (main @ $(git -C "$CACHE" rev-parse --short HEAD))"
fi

guias=()
for d in "$origem"/deskcomm-*; do [ -f "$d/SKILL.md" ] && guias+=("$(basename "$d")"); done
if [ ${#guias[@]} -eq 0 ]; then
  echo "nenhum guia deskcomm-* em $origem" >&2
  if [ -z "$fonte" ]; then
    echo "Se a cópia ficou pela metade, apague-a e rode o comando de novo: rm -rf \"$CACHE\"" >&2
  fi
  exit 1
fi

# ── Ligar em cada pasta global ───────────────────────────────────────────────
ligados=0; pulados=0; copiados=0; obsoletos=0
for dest in "${DESTINOS[@]}"; do
  mkdir -p "$dest"
  ler_fontes "$dest"
  # A fonte nova entra no registro ANTES da primeira ligação: uma execução interrompida no meio
  # deixa ligações para ela, e um registro que ainda só nomeasse a fonte anterior as tiraria do
  # alcance do `--remover` e da varredura seguinte.
  printf '%s\n' "${fontes_registradas[@]}" "$origem" > "$dest/$REGISTRO"
  # Guia que este script instalou e que saiu da fonte (renomeado ou removido na main) sai
  # também — senão fica link quebrado, ou, no modo cópia, a versão abandonada carregando ao
  # lado da nova. "Da fonte" é de QUALQUER fonte registrada, não só da de agora: ao trocar da
  # cópia para `--fonte` (ou o inverso), o guia que só a fonte anterior tinha seguia ligado a
  # ela, e o registro reescrito no fim desta volta o tirava também do alcance do `--remover`.
  for alvo in "$dest"/deskcomm-*; do
    [ -e "$alvo" ] || [ -L "$alvo" ] || continue
    eh_nosso "$alvo" "${fontes_registradas[@]}" "$origem" || continue
    case " ${guias[*]} " in
      *" $(basename "$alvo") "*) ;;
      *) rm -rf "$alvo"; obsoletos=$((obsoletos + 1)) ;;
    esac
  done
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
  # De onde estas ligações saíram. Um link não carrega marca por dentro como a cópia carrega,
  # e é este registro que permite ao `--remover` apagar SÓ o que este script ligou. As fontes
  # anteriores já podem sair dele: o que era delas foi religado a esta fonte ou varrido acima.
  printf '%s\n' "$origem" > "$dest/$REGISTRO"
done

echo "ok: ${#guias[@]} guias em ${#DESTINOS[@]} pastas — $ligados ligados, $copiados copiados, $pulados pulados"
printf '  %s\n' "${guias[@]}"
[ "$obsoletos" = 0 ] || echo "  (removi $obsoletos instalação(ões) de guia que saiu da fonte)"
echo "Abra uma sessão NOVA do seu assistente e peça o assunto em português (ex.: \"quero instalar o CRM na minha VPS\") — o guia certo carrega sozinho em qualquer um deles."
echo "Para chamar pelo nome: /deskcomm-instalar no Claude Code, no Cursor e no Antigravity; \$deskcomm-instalar no Codex; no OpenCode, peça pelo nome (\"use o guia deskcomm-instalar\")."
if [ -z "$fonte" ] || [ "$copiados" -gt 0 ]; then
  echo "Os guias NÃO se atualizam sozinhos: rode este comando de novo para trazer a versão nova."
fi
echo "No Claude Code, um guia instalado aqui vale mais que o de um clone aberto: quem edita guias roda com --fonte no clone, ou --remover."
exit 0
