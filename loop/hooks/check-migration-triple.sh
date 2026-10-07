#!/usr/bin/env bash
# check-migration-triple.sh — a tripla de migration é indivisível (doutrina do repo).
# Commit que ADICIONA arquivo em supabase/migrations/*.sql precisa, no MESMO commit:
#   1. mudança em supabase/baseline.sql (apêndice idempotente)
#   2. descrição: uma linha `-- manifest: <o quê e por quê>` no próprio .sql
#      (desde 02/10/2026; o MANIFEST.md parou de receber linha nova porque era
#      o arquivo que TODO PR com migration tocava, e o GitHub ignora merge=union).
#      Linha no MANIFEST.md staged ainda passa, para PR aberto antes da mudança.
# E o NNNN do nome novo não pode existir em NENHUMA branch local — a cadeia
# vendaval/F2-* tem migrations não mergeadas; colisão de sequência é bug real.
# Bypass (correção orientada pelo dono): DESKCOMM_GOV_MIGRATION_EDIT=1.
set -euo pipefail

[ "${DESKCOMM_GOV_MIGRATION_EDIT:-0}" = "1" ] && exit 0

top="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# Migrations novas (status A) neste commit
new_migrations=$(git diff --cached --name-status \
  | awk '$1 == "A" && $2 ~ /^supabase\/migrations\/.*\.sql$/ { print $2 }')

# ── O que JÁ ESTÁ na `main` não é novidade deste commit ───────────────────
#
# Um `git merge origin/main` encena as migrations da main como status `A`
# relativo à branch, e o guard as tratava como se o autor as tivesse criado.
# O efeito medido em 18/09/2026: o merge da main foi BLOQUEADO acusando 0267,
# 0268 e 0277 — as três já na `main` — como colisão com outra branch, que as
# tinha pelo mesmo motivo (também mergeou a main).
#
# E a orientação do guard era impossível de seguir: "escolha outro NNNN e
# troque o timestamp" aplicado a uma migration que já está na `main` significa
# renumerar arquivo que todo mundo já tem. Não havia resposta certa dentro do
# que ele oferecia — só a válvula de escape, aberta por rotina, que é como uma
# guarda deixa de proteger.
#
# A guarda REAL — colisão de NNNN entre duas branches de trabalho — continua
# inteira: só sai da conta o que é alcançável por `origin/main`.
#
# Sem `origin/main` (clone raso do CI, repositório novo) o filtro é no-op e o
# comportamento antigo vale, em vez de o guard emudecer.
if git rev-parse --verify --quiet origin/main >/dev/null; then
  new_migrations=$(while IFS= read -r p; do
    [ -z "$p" ] && continue
    git cat-file -e "origin/main:$p" 2>/dev/null || printf '%s\n' "$p"
  done <<<"$new_migrations")
fi

[ -z "$new_migrations" ] && exit 0

staged=$(git diff --cached --name-only)

if ! grep -qx 'supabase/baseline.sql' <<<"$staged"; then
  echo "pre-commit BLOQUEADO: migration nova sem apêndice em supabase/baseline.sql no MESMO commit." >&2
  echo "A tripla é indivisível (CLAUDE.md §Migrations): migrations/*.sql + baseline.sql + linha \`-- manifest:\` no .sql." >&2
  echo "Sem o baseline, self-hosters nunca recebem a mudança. Correção orientada pelo dono: DESKCOMM_GOV_MIGRATION_EDIT=1." >&2
  exit 1
fi

# Sem `grep -q`: com `pipefail`, o -q fecha o cano cedo, o `git show` morre de
# SIGPIPE e um .sql COM descrição seria lido como sem.
if ! grep -qx 'supabase/migrations/MANIFEST.md' <<<"$staged"; then
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    if ! git show ":$p" 2>/dev/null | grep -E '^-- manifest:[[:space:]]*[^[:space:]]' >/dev/null; then
      echo "pre-commit BLOQUEADO: '$p' sem descrição — ponha uma linha \`-- manifest: <o quê e por quê>\` no cabeçalho do .sql." >&2
      echo "NÃO acrescente linha no supabase/migrations/MANIFEST.md: ele é histórico, e era o arquivo que fazia todo PR com migration conflitar." >&2
      echo "Correção orientada pelo dono: DESKCOMM_GOV_MIGRATION_EDIT=1." >&2
      exit 1
    fi
  done <<<"$new_migrations"
fi

# Um arquivo pode colidir no NNNN E no timestamp ao mesmo tempo — e colide, na
# maioria das vezes: quem cria migration copiando outra copia os dois. Sair no
# primeiro achado faria o autor renumerar o NNNN, commitar de novo e SÓ ENTÃO
# descobrir o instante. Duas rodadas, e a segunda depende de ele ter lido o
# aviso. Por isso os guards abaixo ACUMULAM: reportam tudo e saem uma vez só.
houve_conflito=0

# ── A POPULAÇÃO da unicidade (issue #1273) ──────────────────────────────────────
#
# A régua que este hook ensina é "o próximo NNNN livre", e ela media `git branch`
# — as branches LOCAIS. A população agora é a main do PRODUTO (o remoto que
# aponta para melgarafael/DeskcommCRM, com qualquer nome) mais `refs/heads` E
# `refs/remotes` — e o que ela NÃO cobre (os PRs abertos pela lista do `gh`) sai
# declarado na própria mensagem. Caso medido que CONTINUA fora: o 0269 do PR
# aberto #965 (de fork) vivia só na cópia `refs/remotes/origin/pr/965`, e as
# cópias `pr/N` ficam excluídas de propósito (sobrevivem ao fechamento do PR);
# quem o pega é o `pnpm checar:colisao-de-migration`, pela lista de abertos. `scripts/migration-populacao.sh` é a mesma
# regra que o `pnpm checar:colisao-de-migration` (o #1269) usa.
BIBLIOTECA="$top/scripts/migration-populacao.sh"
if [ -r "$BIBLIOTECA" ]; then
  # shellcheck source=/dev/null
  . "$BIBLIOTECA" || true
fi
base=""
if declare -F pop_main_do_produto >/dev/null 2>&1; then
  base="$(pop_main_do_produto || true)"
  if [ -n "$base" ] && ! git rev-parse -q --verify "${base}^{commit}" >/dev/null 2>&1; then
    base=""
  fi
fi
if [ -z "$base" ]; then
  base="origin/main"
  git rev-parse -q --verify "${base}^{commit}" >/dev/null 2>&1 || base=""
fi
if declare -F pop_refs_de_outrem >/dev/null 2>&1; then
  refs="$(pop_refs_de_outrem "$base" 2>/dev/null || true)"
else
  refs="origin/main $(git for-each-ref --format='%(refname)' refs/heads refs/remotes 2>/dev/null || true)"
fi
# A lista que entrou é a POPULAÇÃO que o grep vai casar, e ela NUNCA pode ficar
# vazia por acidente: um `pop_migrations` que sai vazio (biblioteca ausente, ou
# clone em que nenhuma rev resolveu) transformaria o `grep` de baixo em "não há
# colisão" e o hook LIBERARIA o commit. Um guard que encolhe o universo em
# silêncio é o defeito que a #1273 corrige. A degradação é a de antes (medir as
# refs que houver) com um aviso, nunca a população zerada.
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
    echo "pre-commit AVISO: scripts/migration-populacao.sh AUSENTE — NNNN medido sobre ${refs//$'\n'/ }. Quem mede a população inteira (main do produto ∪ PRs abertos): pnpm checar:colisao-de-migration (#1273)" >&2
  elif [ -z "$base" ]; then
    echo "pre-commit AVISO: nenhuma migration resolvida na população ($base e as refs do clone) — a unicidade de NNNN NÃO foi medida (#1273). Rode: pnpm checar:colisao-de-migration" >&2
  fi
fi

# Sequência NNNN única contra a POPULAÇÃO inteira.
while IFS= read -r path; do
  fname=$(basename "$path")
  nnnn=$(sed -nE 's/^[0-9]{14}_([0-9]{4})_.+\.sql$/\1/p' <<<"$fname")
  if [ -z "$nnnn" ]; then
    echo "pre-commit BLOQUEADO: '$fname' não segue o padrão <timestamp de 14 dígitos>_<NNNN>_<slug>.sql do repo." >&2
    exit 1
  fi
  # O MESMO arquivo nesta população é o PR de quem roda: não é colisão.
  conflict=$(grep -E "^[A-Za-z0-9_./-]+ [0-9]{14}_${nnnn}_.+\.sql$" "$populacao" \
    | grep -vE " ${fname}\$" || true)
  if [ -n "$conflict" ]; then
    echo "pre-commit BLOQUEADO: sequência NNNN=$nnnn de '$fname' já existe em: $(awk '{printf "%s(%s) ", $1, $2}' <<<"$conflict" | sed 's/ $//')" >&2
    if declare -F pop_dica_proximo_livre >/dev/null 2>&1; then
      pop_dica_proximo_livre "$nnnn" "$base" "$(cut -d' ' -f2- "$populacao" | LC_ALL=C sort -u)" >&2
    else
      echo "Para o próximo número livre (main do produto ∪ PRs abertos): pnpm checar:colisao-de-migration" >&2
    fi
    echo "E troque o TIMESTAMP JUNTO: renumerar só o NNNN fabricou 12 das colisões de timestamp deste repo." >&2
    echo "Correção orientada pelo dono: DESKCOMM_GOV_MIGRATION_EDIT=1." >&2
    houve_conflito=1
  fi
done <<<"$new_migrations"


# ── TIMESTAMP único contra TODAS as branches locais ──────────────────────
#
# O timestamp é a PK de `supabase_migrations.schema_migrations`: repetido, o
# `db push` colide na PK e o `db reset` quebra. A issue #143 já renomeou quatro
# pares por isso — não é hipótese.
#
# ⚠️ E metade das colisões vivas foi FABRICADA POR ESTE HOOK. Ao exigir NNNN novo
# quando havia conflito entre branches, ele fazia trocar o NÚMERO e deixava o
# instante intacto. Medido em 2026-08-27, sobre 754 refs: das 25 colisões de
# timestamp, 12 eram exatamente isso. Por isso a mensagem do NNNN, acima, manda
# trocar os dois.
#
# CATRACA: os 13 instantes abaixo já são compartilhados por migrations DISTINTAS
# em branches ainda não mergeadas. Gate que nasce vermelho não entra, então ficam
# congelados — e a lista só ENCOLHE: quando aquelas branches mergearem ou
# morrerem, a entrada some daqui. Os outros 12 NÃO entram na catraca: neles a
# colisão é o mesmo arquivo renumerado, artefato e não defeito, e congelar ruído
# esconderia o sinal.
DIVIDA_DE_TIMESTAMP="
20260717190000 20260718160000 20260721120000 20260722160000 20260805120000
20260805200000 20260807160000 20260820120000 20260822190000 20260824120000
20260825120000 20260826190000 20260827010000
"

# Mesma POPULAÇÃO do NNNN, acima — a resposta à pergunta do timestamp é a mesma
# resposta sobre o mesmo conjunto. A âncora é a posição do nome canônico, e não
# `^supabase/migrations/…`: a lista de `pop_migrations` é "<ref> <nome>".
while IFS= read -r path; do
  fname=$(basename "$path")
  ts=$(sed -nE 's/^([0-9]{14})_[0-9]{4}_.+\.sql$/\1/p' <<<"$fname")
  [ -z "$ts" ] && continue
  grep -qw "$ts" <<<"$DIVIDA_DE_TIMESTAMP" && continue

  conflict=$(grep -E "^[A-Za-z0-9_./-]+ ${ts}_[0-9]{4}_.+\.sql$" "$populacao" \
    | grep -vE " ${fname}\$" || true)
  if [ -n "$conflict" ]; then
    echo "pre-commit BLOQUEADO: o TIMESTAMP $ts de '$fname' já existe em: $(awk '{printf "%s(%s) ", $1, $2}' <<<"$conflict" | sed 's/ $//')" >&2
    echo "O timestamp é a PK de supabase_migrations.schema_migrations: repetido, o db push colide na PK e o db reset quebra (issue #143)." >&2
    echo "Escolha um instante livre — e renumerar só o NNNN não resolve: os dois têm de ser únicos." >&2
    echo "Correção orientada pelo dono: DESKCOMM_GOV_MIGRATION_EDIT=1." >&2
    houve_conflito=1
  fi
done <<<"$new_migrations"

[ "$houve_conflito" = 1 ] && exit 1
exit 0
