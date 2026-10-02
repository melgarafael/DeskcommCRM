#!/usr/bin/env bash
# check-migration-triple.sh (contribuidor) — a tripla de migration é indivisível.
#
# Commit que ADICIONA supabase/migrations/*.sql precisa, no MESMO commit:
#   1. mudança em supabase/baseline.sql (apêndice idempotente — é o que o kit
#      self-host aplica; migration que não chega lá não chega em quem instalou)
#   2. linha em supabase/migrations/MANIFEST.md
# E o NNNN e o TIMESTAMP do nome novo não podem existir na POPULAÇÃO que os
# mediu: a main do PRODUTO (o remoto que aponta para melgarafael/DeskcommCRM, com
# qualquer nome) mais as outras refs do clone. Colisão é o defeito nº 1 da
# triagem (renumerada 11 vezes desde agosto de 2026), e quem cria migration
# copiando outra copia os dois. A população — e o que ela DEIXA de fora — é a
# mesma dos outros sete lugares (#1273), em `scripts/migration-populacao.sh`.
#
# Diferença para o hook do mantenedor (loop/hooks): este não conhece a dívida
# de timestamp da main, que é assunto do mantenedor.
# Bypass explícito (correção orientada pelo mantenedor): DESKCOMM_MIGRATION_EDIT=1
set -euo pipefail

[ "${DESKCOMM_MIGRATION_EDIT:-0}" = "1" ] && exit 0

top="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

novas="$(git diff --cached --name-status | awk '$1 == "A" && $2 ~ /^supabase\/migrations\/.*\.sql$/ { print $2 }')"
# ── A POPULAÇÃO da unicidade (issue #1273) ──────────────────────────────────────
#
# A pergunta deste hook é "esse número já foi usado ou reservado?", e a resposta
# honesta é sobre a main do PRODUTO (o remoto que aponta para
# melgarafael/DeskcommCRM, com QUALQUER nome) mais as outras refs do clone. A
# versão anterior media `origin/main` + `git branch` — e essas duas são o
# recorte que a issue mediu como errado: num clone de fork, a `origin/main` é a
# main DO FORK (que pode estar atrás da do principal, e o hook saía com 0
# dizendo que o número estava livre), e `git branch` só via branches LOCAIS.
# A cabeça de um PR aberto de fork vive em `refs/pull/N/head` no repositório
# pai, e no clone do mantenedor o 0269 do #965 aparecia só como cópia em
# `refs/remotes/origin/pr/965` — nenhuma das 188 branches locais tinha esse
# número. A cópia em `refs/remotes/*/pr/N` fica de fora de propósito: é cópia
# de cabeça, não PR aberto, e sobrevive ao fechamento (965 cópias contra 43 PRs
# abertos, medido em 19/09/2026) — os PRs abertos entram pela LISTA do `gh`, no
# `pnpm checar:colisao-de-migration`.
#
# `pop_tem_nnnn`/`pop_ts_em_uso` casam o NNNN e o timestamp na POSIÇÃO do nome
# canônico, e não em qualquer "_NNNN_": é a âncora do #1269, e a variante
# gulosa pegava o número do SLUG (`…_0326_relatorio_2024_anual.sql` virava
# 2024) e perdia a duplicata real de 0326.
#
# A POPULAÇÃO é a mesma dos outros sete lugares, com a regra de degradação
# declarada: a base é a main do PRODUTO quando algum remoto é o principal; sem
# ele, é a `origin/main` que houver — e a saída DIZ qual das duas foi. As
# branches LOCAIS e REMOTAS entram sempre (a de antes era só a local). O 0269 do
# #965 continua FORA desta conta: ele morava só na cópia `pr/965`, que fica
# excluída de propósito; quem o pega é o `pnpm checar:colisao-de-migration`.
BIBLIOTECA="$top/scripts/migration-populacao.sh"
if [ -r "$BIBLIOTECA" ]; then
  # shellcheck source=/dev/null
  . "$BIBLIOTECA" || true
fi
aviso_fork=0
base=""
if declare -F pop_main_do_produto >/dev/null 2>&1; then
  base="$(pop_main_do_produto || true)"
  [ -n "$base" ] || base=""
  if [ -n "$base" ] && ! git rev-parse -q --verify "${base}^{commit}" >/dev/null 2>&1; then
    base=""
  fi
fi
if [ -z "$base" ]; then
  # Sem o principal no clone (fork sem `upstream`, ou biblioteca ausente): a
  # base cai para a `origin/main`, e o hook sai DIZENDO que a população não é a
  # da pergunta completa. Encolher o universo em silêncio é o defeito da #1273.
  # Só avisa quando HÁ remoto de GitHub (um fork): fixture sem remoto nenhum só
  # tem o que tem. Sem a biblioteca, o aviso de ausência mais abaixo já diz.
  if declare -F pop_tem_remoto_de_github >/dev/null 2>&1 && pop_tem_remoto_de_github; then
    aviso_fork=1
  fi
  base="origin/main"
  git rev-parse -q --verify "${base}^{commit}" >/dev/null 2>&1 || base=""
fi

# O que já está na main do PRODUTO não é novidade deste commit. Um `git merge
# upstream/main` encena as migrations da main como `A` relativo à branch, e a
# população alargada (refs/remotes/*) tem branches do principal com OUTRO
# arquivo de mesmo NNNN (17 NNNN da main em 31 branches do upstream, medido em
# 27/09/2026): sem este filtro o merge da main era BLOQUEADO mandando renumerar
# arquivo que todo mundo já tem — a orientação impossível que o loop/hooks
# registrou (18/09/2026). É o mesmo filtro dele, sobre a base do PRODUTO.
if [ -n "$base" ]; then
  novas="$(while IFS= read -r p; do
    [ -z "$p" ] && continue
    git cat-file -e "$base:$p" 2>/dev/null || printf '%s\n' "$p"
  done <<<"$novas")"
fi

[ -z "$novas" ] && exit 0

if [ "$aviso_fork" = 1 ]; then
  echo "pre-commit AVISO: NNNN/timestamp NÃO MEDIDOS contra a main do PRODUTO: nenhum remoto aponta para melgarafael/DeskcommCRM (a base é a origin/main do seu fork, que pode estar atrás). Corrija com: git remote add upstream https://github.com/melgarafael/DeskcommCRM.git && git fetch upstream (#1273)" >&2
fi

staged="$(git diff --cached --name-only)"
falhou=0

if ! grep -qx 'supabase/baseline.sql' <<<"$staged"; then
  echo "pre-commit BLOQUEADO: migration nova sem apêndice em supabase/baseline.sql no MESMO commit." >&2
  echo "  O kit self-host aplica SÓ o baseline: sem o apêndice, a mudança não chega em quem instalou numa VPS." >&2
  falhou=1
fi
if ! grep -qx 'supabase/migrations/MANIFEST.md' <<<"$staged"; then
  echo "pre-commit BLOQUEADO: migration nova sem linha em supabase/migrations/MANIFEST.md no MESMO commit." >&2
  falhou=1
fi

if declare -F pop_refs_de_outrem >/dev/null 2>&1; then
  refs="$(pop_refs_de_outrem "$base" 2>/dev/null || true)"
else
  refs="origin/main $(git for-each-ref --format='%(refname)' refs/heads refs/remotes 2>/dev/null || true)"
fi
# A lista que entrou é a POPULAÇÃO que o grep vai casar. Ela NUNCA pode ficar
# vazia por acidente: um `pop_migrations` que sai vazio (biblioteca ausente,
# clone sem nenhuma migration, `git` fora do repositório) transformaria o
# `grep` de baixo em "não há colisão" e o hook LIBERARIA o commit — um guard
# que encolhe o universo em silêncio é exatamente o defeito que a #1273 corrige.
# A degradação declarada é a de antes (medir a `origin/main` e as refs que houver)
# com um aviso, nunca a população zerada.
# `populacao=` ANTES do `if`: o hook roda com `set -u`, e uma variável nunca
# atribuída aborta o script inteiro — o hook saía com 1 SEM mensagem nenhuma,
# que é o pior formato de falha possível num guard.
# A população vai para um ARQUIVO, nunca para uma variável: no clone do mantenedor
# (29/09/2026) ela tinha ~1,29 M linhas (~112 MB), e o teste de vazio que havia aqui,
# `${populacao// /}`, é uma substituição de padrão do bash — quadrática no tamanho da
# string. O hook não terminava em 45 min. O grep lê o arquivo direto.
populacao="$(mktemp)" || { echo "pre-commit BLOQUEADO: mktemp falhou — a população de migrations não pôde ser medida. Correção orientada pelo dono: DESKCOMM_GOV_MIGRATION_EDIT=1." >&2; exit 1; }
trap 'rm -f "$populacao"' EXIT
if declare -F pop_migrations >/dev/null 2>&1; then
  # O HEAD entra SEMPRE: `pop_refs_de_outrem` tira a ref cujo SHA é o do HEAD (a
  # #1155), e sem devolvê-lo aqui a migration que a PRÓPRIA branch já commitou
  # sumia da conta — a segunda 0411 e o carimbo repetido passavam calados, e a
  # dica de próximo livre apontava para o número da branch. O próprio arquivo
  # encenado não é acusado: o `grep -vE " <nome>$"` abaixo o tira.
  { pop_migrations $refs HEAD 2>/dev/null || true; } >"$populacao" || { echo "pre-commit BLOQUEADO: não foi possível gravar a população de migrations em $populacao. Correção orientada pelo dono: DESKCOMM_GOV_MIGRATION_EDIT=1." >&2; exit 1; }
fi
if ! grep -q . "$populacao"; then
  # A biblioteca não está (clone antigo, cópia da skill de versão anterior) ou
  # não achou migration nenhuma. Mede o que a versão anterior media e DIZ.
  if ! declare -F pop_migrations >/dev/null 2>&1; then
    fallback=""
    for ref in $refs HEAD; do
      [ -n "$ref" ] || continue
      arquivos="$(git ls-tree -r --name-only "$ref" -- supabase/migrations 2>/dev/null \
        | sed 's#^supabase/migrations/##' || true)"
      # Prefixa CADA linha com a ref: o grep de baixo casa "<ref> <nome>", e
      # prefixar só a 1ª deixava passar colisão com qualquer arquivo que não
      # fosse o primeiro da ref.
      [ -n "$arquivos" ] && fallback="${fallback}$(awk -v r="$ref" '{ print r, $0 }' <<<"$arquivos")"$'\n'
    done
    printf '%s' "$fallback" >"$populacao"
    echo "pre-commit AVISO: scripts/migration-populacao.sh AUSENTE — unicidade de NNNN medida sobre ${refs//$'\n'/ } (a população da pergunta: main do produto ∪ PRs abertos). Quem mede a inteira: pnpm checar:colisao-de-migration (#1273)" >&2
  elif [ -z "${base}" ]; then
    echo "pre-commit AVISO: Nenhuma migration resolvida na população ($base e as refs do clone) — a unicidade de NNNN NÃO foi medida (#1273). Rode: pnpm checar:colisao-de-migration" >&2
  fi
fi

while IFS= read -r caminho; do
  nome="$(basename "$caminho")"
  ts="$(sed -nE 's/^([0-9]{14})_[0-9]{4}_.+\.sql$/\1/p' <<<"$nome")"
  nnnn="$(sed -nE 's/^[0-9]{14}_([0-9]{4})_.+\.sql$/\1/p' <<<"$nome")"
  if [ -z "$nnnn" ] || [ -z "$ts" ]; then
    echo "pre-commit BLOQUEADO: '$nome' não segue <timestamp de 14 dígitos>_<NNNN>_<slug>.sql." >&2
    falhou=1
    continue
  fi
  # O MESMO arquivo nesta população é o PR de quem roda (o índice ainda o
  # mostra como `A`): ele não é colisão, e acusar o autor de colidir com a
  # própria branch é a armadilha que a #1155 registrou.
  # A âncora é a do NOME CANÔNICO e o `grep` roda sobre a LINHA INTEIRA ("<ref>
  # <nome>"), para o dono poder ser nomeado: "já existe em <ref>" sem o ref é
  # "tomada" apontando para o nada, que é a armadilha da #1155.
  donos_n="$(grep -E "^[A-Za-z0-9_./-]+ [0-9]{14}_${nnnn}_.+\.sql$" "$populacao" | grep -vE " ${nome}\$" || true)"
  donos_t="$(grep -E "^[A-Za-z0-9_./-]+ ${ts}_[0-9]{4}_.+\.sql$" "$populacao" | grep -vE " ${nome}\$" || true)"
  if [ -n "$donos_n" ]; then
    onde="$(awk '{printf "%s(%s) ", $1, $2}' <<<"$donos_n" | sed 's/ $//')"
    echo "pre-commit BLOQUEADO: NNNN=$nnnn de '$nome' já existe em: $onde" >&2
    if declare -F pop_dica_proximo_livre >/dev/null 2>&1; then
      pop_dica_proximo_livre "$nnnn" "$base" "$(cut -d' ' -f2- "$populacao" | LC_ALL=C sort -u)" >&2
    else
      echo "  Para o próximo número livre (main do produto ∪ PRs abertos): pnpm checar:colisao-de-migration" >&2
    fi
    echo "  Troque o TIMESTAMP junto (date -u +%Y%m%d%H%M%S) — renumerar só o NNNN é o que fabrica colisão de timestamp." >&2
    falhou=1
  fi
  if [ -n "$donos_t" ]; then
    onde="$(awk '{printf "%s(%s) ", $1, $2}' <<<"$donos_t" | sed 's/ $//')"
    echo "pre-commit BLOQUEADO: timestamp $ts de '$nome' já existe em: $onde" >&2
    echo "  O Supabase usa o timestamp como identidade da migration; dois iguais quebram db push/reset." >&2
    falhou=1
  fi
done <<<"$novas"

if [ "$falhou" = 1 ]; then
  echo "Correção orientada pelo mantenedor: DESKCOMM_MIGRATION_EDIT=1 git commit …" >&2
  exit 1
fi
exit 0
