#!/usr/bin/env bash
# checar-colisao-de-migration.sh — o número que o PR acrescenta não pode já estar tomado.
#
# ## A classe de defeito (issue #285)
#
# Dois PRs com migrations de NOMES DIFERENTES não conflitam textualmente: o merge sai
# limpo, o commit nasce sem `pre-commit`, e o número duplicado entra calado. Medido em
# 14/09: o #804 entrou assim com o `0241` que o #770 já ocupava desde o lote 2, e nenhuma
# guarda viu (TRIAGEM.md:913-924). O `0161` foi disputado por cinco PRs. A régua por
# número existia só em hook local — `core.hooksPath` é configuração local, NÃO versionada:
# um fork nunca a executa, e nenhum job do `ci.yml` a invocava
# (`triagem/references/complemento-do-ci.md`, §1).
#
# ## A régua é a que o repo já pratica — a mesma, contra o REMOTO
#
# Espelha a parte de NNNN/timestamp de
# `.agents/skills/deskcomm-contribuir/scripts/hooks/check-migration-triple.sh`, trocando o
# index pelo diff do PR (o CI não tem nada staged). O que a régua decide:
#
#   * só o arquivo que o PR ACRESCENTA entra na conta (`--diff-filter=A`): editar ou
#     reordenar migration existente não acrescenta arquivo nenhum, e passa;
#   * com `-M`, renome entra como `R` e passa. LIMITE DECLARADO, igual ao do hook: ele
#     "não é rede para renumeração" (TRIAGEM.md:906) — fechar isso é a sonda de árvore do
#     mantenedor, não este passo;
#   * dois arquivos DESTE PR com o mesmo NNNN (ou o mesmo timestamp) reprovam: é a sonda
#     de árvore da TRIAGEM.md:926 (`uniq -d`) restrita às adições do PR;
#   * duplicata que JÁ existe na base não é do PR (TRIAGEM.md:934: com linha de base, "se
#     ela também devolver a duplicata, o número é antigo e não do lote");
#   * o merge da própria main não acrescenta nada: no `pull_request` o HEAD é o merge ref,
#     que já contém a base.
#
# ## Por que o fetch da base mora aqui
#
# Medido no run 35091061120: o checkout do job `verify` é `--depth=1` do merge ref e NÃO
# tem ref `origin/main` algum. O diff de duas ÁRVORES precisa das duas árvores, não de
# merge-base — que é justamente o que um clone raso não tem, e o que torna
# `origin/main...HEAD` impossível ali. Então a base é resolvida aqui, com fetch raso
# quando o clone é raso.
#
# `origin/<branch>` é ATUALIZADO antes de medir, sempre: ref remoto velho dá falso verde
# exatamente no caso desta issue — outro PR mergeou o número primeiro e a branch ainda
# aponta para o fork point. Se o fetch falhar e houver cópia local, mede-se contra ela
# **declarando** num `::warning` — reprovar por rede é a classe de vermelho que treina a
# ignorar vermelho (razão no cabeçalho de tests/unit/preambulo-do-ci-nao-come-o-relogio.test.ts).
#
# ## O limite medido: branch atrás da base
#
# O diff de duas árvores só tem o sentido do merge quando o HEAD CONTÉM a base — que é o
# caso do `pull_request`, onde o HEAD é o merge ref (base + PR; medido no run
# 35091061120). Numa branch que ficou atrás, a migration que só existe na base entra como
# REMOÇÃO e o `-M` a pareia com a migration nova do PR: medido, `git diff --name-status -M
# origin/main HEAD -- supabase/migrations/` devolveu
# `R100 ..._0268_rascunho.sql -> ..._0268_lembrete.sql` — e a adição desaparece do
# `--diff-filter=A`. Verde silencioso é o que este passo não pode dar, então a divergência
# é DECLARADA num `::warning`; no CI ela não aparece (a base é pai do merge ref, e o clone
# raso nem history tem para julgar).
#
# ## Não medir não é passar
#
# Sem base resolvida, este passo REPROVA (exit 2) declarando o NÃO MEDIDO e o comando do
# conserto. Gate que volta verde sem ter comparado nada é a falha-em-verde que a própria
# triagem chama de mais cara num produto self-host (complemento-do-ci.md, §7).
#
# Exit: 0 medido e livre · 1 colisão · 2 não medido.
#
# Uso: bash scripts/checar-colisao-de-migration.sh [base]      (padrão: origin/main)
set -uo pipefail

BASE="${1:-origin/main}"
if ! cd "$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "::error::não estou dentro de um repositório git — não há árvore para medir."
  exit 2
fi

nao_medido() {
  echo "::error::$1"
  echo "NÃO MEDIDO: não consegui comparar com '$BASE' — isto NÃO é colisão no PR."
  echo "  Conserto: git fetch origin $BASE"
  exit 2
}

# ── a base é o REMOTO (complemento-do-ci.md §1), nunca uma cópia velha ─────────────
if [ "${BASE#origin/}" != "$BASE" ]; then
  remoto="${BASE#origin/}"
  opcoes=()
  [ -f "$(git rev-parse --git-dir)/shallow" ] && opcoes+=(--depth=1)
  if ! git fetch --no-tags ${opcoes[@]+"${opcoes[@]}"} origin \
       "+refs/heads/${remoto}:refs/remotes/origin/${remoto}" >/dev/null 2>&1; then
    git rev-parse --verify -q "${BASE}^{commit}" >/dev/null 2>&1 \
      || nao_medido "não consegui buscar '$BASE' e não existe cópia local dela."
    echo "::warning::fetch de '$BASE' falhou — medindo contra a cópia LOCAL, que pode estar atrasada."
  fi
elif ! git rev-parse --verify -q "${BASE}^{commit}" >/dev/null 2>&1; then
  nao_medido "'$BASE' não resolve para commit nenhum neste clone."
fi

# ── o que este PR acrescenta ──────────────────────────────────────────────────────
# Antes de medir: se a branch está atrás da base, o diff de árvores muda de sentido (a
# migration que só existe na base vira remoção e o `-M` a pareia com a adição do PR). Não
# há history para julgar no clone raso do CI, e lá a base é pai do merge ref — o aviso é
# para quem roda isto fora do CI.
if [ ! -f "$(git rev-parse --git-dir)/shallow" ] \
   && ! git merge-base --is-ancestor "$BASE" HEAD 2>/dev/null; then
  echo "::warning::a base '$BASE' andou depois do fork — esta é a medição da BRANCH, não a do merge. Rode 'git merge $BASE' e meça de novo: migration nova pareada como renome pelo -M não aparece aqui."
fi

adicionadas="$(git diff --name-only -M --diff-filter=A "$BASE" HEAD -- supabase/migrations/ 2>/dev/null \
  | grep -E '^supabase/migrations/[^/]+\.sql$' || true)"
if [ -z "$adicionadas" ]; then
  echo "OK — nenhuma migration acrescentada por este PR (base '$BASE')."
  exit 0
fi
adicionadas_nomes="$(xargs -n1 basename <<<"$adicionadas" | sed '/^$/d')"

base_arvore="$(git ls-tree -r --name-only "$BASE" -- supabase/migrations 2>/dev/null | sed 's#^supabase/migrations/##' || true)"
head_arvore="$(git ls-tree -r --name-only HEAD -- supabase/migrations 2>/dev/null | sed 's#^supabase/migrations/##' || true)"

# Próximo livre medido nas DUAS árvores: olhar só a listagem local é o erro que a
# complemento-do-ci.md §1 aponta no hook — "compare contra o remoto".
ultimo="$(printf '%s\n%s\n' "$base_arvore" "$head_arvore" | grep -oE '_[0-9]{4}_' | tr -d _ | sort -n | tail -1)"
proximo_livre=""
[ -n "$ultimo" ] && proximo_livre="$(printf '%04d' $((10#$ultimo + 1)))"

falhou=0
while IFS= read -r nome; do
  [ -z "$nome" ] && continue
  caminho="supabase/migrations/$nome"
  ts="$(sed -nE 's/^([0-9]{14})_[0-9]{4}_.+\.sql$/\1/p' <<<"$nome")"
  nnnn="$(sed -nE 's/^[0-9]{14}_([0-9]{4})_.+\.sql$/\1/p' <<<"$nome")"

  if [ -z "$nnnn" ] || [ -z "$ts" ]; then
    echo "::error file=$caminho::migration nova fora do padrão <timestamp de 14 dígitos>_<NNNN>_<slug>.sql"
    echo "CI REPROVADO: '$nome' não segue <timestamp de 14 dígitos>_<NNNN>_<slug>.sql (doutrina de migrations). Sem NNNN no nome, a colisão de número é imensurável."
    falhou=1
    continue
  fi

  colisao_n="$(grep -E "^[0-9]{14}_${nnnn}_.+\.sql$" <<<"$base_arvore" || true)"
  colisao_t="$(grep -E "^${ts}_[0-9]{4}_.+\.sql$" <<<"$base_arvore" || true)"
  if [ -n "$colisao_n" ]; then
    lista="$(tr '\n' ' ' <<<"$colisao_n" | sed 's/ *$//')"
    echo "::error file=$caminho::NNNN=$nnnn já existe em '$BASE': $lista"
    echo "CI REPROVADO: NNNN=$nnnn de '$nome' já existe em '$BASE': $lista"
    echo "  Próximo livre medido em '$BASE' ∪ HEAD: NNNN=${proximo_livre:-?}"
    echo "  Troque o TIMESTAMP junto (date -u +%Y%m%d%H%M%S) — renumerar só o NNNN é o que fabrica colisão de timestamp."
    falhou=1
  fi
  if [ -n "$colisao_t" ]; then
    lista="$(tr '\n' ' ' <<<"$colisao_t" | sed 's/ *$//')"
    echo "::error file=$caminho::timestamp $ts já existe em '$BASE': $lista"
    echo "CI REPROVADO: timestamp $ts de '$nome' já existe em '$BASE': $lista"
    echo "  O Supabase usa o timestamp como identidade da migration; dois iguais quebram db push/reset."
    falhou=1
  fi

  # A sonda de árvore (TRIAGEM.md:926) restrita às adições: NNNN/timestamp repetidos
  # entre os arquivos DESTE PR — o hook do pre-commit não vê isso, o merge cego também não.
  gemeas_n="$(grep -cE "^[0-9]{14}_${nnnn}_.+\.sql$" <<<"$adicionadas_nomes" || true)"
  if [ "${gemeas_n:-0}" -gt 1 ]; then
    lista="$(grep -E "^[0-9]{14}_${nnnn}_.+\.sql$" <<<"$adicionadas_nomes" | tr '\n' ' ' | sed 's/ *$//')"
    echo "::error file=$caminho::NNNN=$nnnn repetido entre os arquivos deste PR: $lista"
    echo "CI REPROVADO: NNNN=$nnnn aparece em $gemeas_n arquivos deste PR: $lista"
    echo "  Próximo livre medido em '$BASE' ∪ HEAD: NNNN=${proximo_livre:-?}"
    falhou=1
  fi
  gemeas_t="$(grep -cE "^${ts}_[0-9]{4}_.+\.sql$" <<<"$adicionadas_nomes" || true)"
  if [ "${gemeas_t:-0}" -gt 1 ]; then
    lista="$(grep -E "^${ts}_[0-9]{4}_.+\.sql$" <<<"$adicionadas_nomes" | tr '\n' ' ' | sed 's/ *$//')"
    echo "::error file=$caminho::timestamp $ts repetido entre os arquivos deste PR: $lista"
    echo "CI REPROVADO: timestamp $ts aparece em $gemeas_t arquivos deste PR: $lista"
    echo "  O Supabase usa o timestamp como identidade da migration; dois iguais quebram db push/reset."
    falhou=1
  fi
done <<<"$adicionadas_nomes"

if [ "$falhou" = 1 ]; then
  echo
  echo "Correção: renumerar o arquivo do PR para um NNNN livre E trocar o TIMESTAMP junto, no mesmo commit."
  echo "  Os casos legítimos (editar, renomear, merge da main, dívida antiga da base) já passam por construção — ver o cabeçalho deste script."
  exit 1
fi
echo "OK — $(grep -c . <<<"$adicionadas_nomes") migration(ões) nova(s) com NNNN/timestamp livres contra '$BASE'."
exit 0
