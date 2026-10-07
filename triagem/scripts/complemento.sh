#!/usr/bin/env bash
# Mecaniza o passe 4 do TRIAGEM.md — o complemento do CI, PR a PR.
# Uso: complemento.sh <numero-do-pr>
# Saída: linhas "CHAVE<TAB>VALOR". Toda linha é medição, nenhuma é veredito.
set -uo pipefail
N="$1"
COMPL_TOP="$(git rev-parse --show-toplevel)"
cd "$COMPL_TOP"

DIFF=$(gh pr diff "$N" 2>/dev/null)
FILES=$(gh pr view "$N" --json files --jq '.files[].path' 2>/dev/null)

# A cabeça do PR é a do `gh` (headRefOid), e a cópia local `refs/tri/N` só entra
# quando é a MESMA. A versão anterior preferia a cópia e só caía no `gh` quando
# ela não existia — e `git rev-parse` sem `--verify` escreve o próprio argumento
# na saída antes de falhar, então o `SHA` saía com duas linhas e a prévia do
# merge respondia "NAO MEDIDO" mesmo com o `gh` tendo devolvido a cabeça (medido
# no #1180). Pior: uma `refs/tri/N` VELHA media a cabeça antiga sem avisar — em
# 19/09/2026 eram quatro PRs abertos assim (#1268, #1265, #1162, #983).
# `--verify` cala o eco do argumento, e a comparação é o que separa as duas.
# (issue #1273)
SHA_GH=$(gh pr view "$N" --json headRefOid --jq .headRefOid 2>/dev/null | head -1)
SHA_TRI=$(git rev-parse -q --verify "refs/tri/${N}^{commit}" 2>/dev/null || true)
SHA="$SHA_GH"   # a cabeça ATUAL vence sempre uma refs/tri/N divergente
if [ -z "$SHA" ] && [ -n "$SHA_TRI" ]; then
  SHA="$SHA_TRI"
  echo "sha_velho	refs/tri/${N}=${SHA_TRI:0:9} (o gh NÃO devolveu a cabeça atual; meça contra esta cópia, que pode estar atrasada)"
fi

p(){ printf '%s\t%s\n' "$1" "$2"; }

# Toda sonda lê o diff por HERE-STRING, nunca por `echo "$DIFF" | grep -q`. Com `pipefail`,
# o `grep -q` fecha o pipe no primeiro acerto, o `echo` morre com SIGPIPE (141) e a linha
# devolve FALSO justamente quando achou — em diff grande, onde o echo ainda não terminou.
# Medido no #865 (lote 8, 15/set): `rls_enable AUSENTE — bloqueador` com
# `enable row level security` duas vezes no diff. Sem pipe não há SIGPIPE.
d(){ grep "$@" <<<"$DIFF"; }
f(){ grep "$@" <<<"$FILES"; }
# Sondas SEMÂNTICAS (constraint, tabela, RLS, definer, workflow, falha-em-verde) leem só
# linhas ACRESCENTADAS em arquivo de CÓDIGO, sem comentário. Medido no #861: o diff não
# criava função nenhuma, e `definer_revoke SEM revoke` casou na prosa
# `+-- \`security definer\` nova ⇒ o item 9 ... não é acionado`.
CODIGO=$(awk '/^\+\+\+ /{a=substr($0,7); next} /^\+/ && a ~ /\.(sql|ts|tsx|js|mjs|cjs|ya?ml|sh)$/ {print}' <<<"$DIFF" \
  | grep -vE '^\+[[:space:]]*(--|\*|/\*|//|#)')
c(){ grep "$@" <<<"$CODIGO"; }

p pr "$N"
p sha "$SHA"

# --- prévia do merge (passe 3): gates rodam no merge, não na branch ---
# E é aqui que a cópia VELHA se denuncia: com a `refs/tri/N` desatualizada, a
# prévia media o commit antigo calado. A linha abaixo diz qual das duas cabeças
# foi usada, e por quê (#1273).
[ -n "$SHA_TRI" ] && [ -n "$SHA_GH" ] && [ "$SHA_TRI" != "$SHA_GH" ] && \
  echo "sha_velho	refs/tri/${N}=${SHA_TRI:0:9} gh=${SHA_GH:0:9} — a prévia abaixo mede a CABEÇA ATUAL (a do gh), não a cópia local"
if ! git cat-file -e "${SHA}^{commit}" 2>/dev/null; then
  p previa_merge "NAO MEDIDO — objeto $SHA ausente no clone (rode: git fetch origin pull/$N/head)"
else
  MT=$(git merge-tree --write-tree origin/main "$SHA" 2>&1); MTRC=$?
  if [ $MTRC -eq 0 ]; then p previa_merge "LIMPA tree=$(echo "$MT" | head -1)"
  else
    p previa_merge "CONFLITO rc=$MTRC"
    echo "$MT" | grep -oE '^(CONFLICT[^)]*\)|[0-9]+ [0-9a-f]+ [123]\t.*)' | head -10 | sed 's/^/\tconflito\t/'
  fi
fi

# --- 1. tripla de migration ---
MIG=$(f -c '^supabase/migrations/[0-9].*\.sql$')
if [ "$MIG" -gt 0 ]; then
  BL=$(f -c '^supabase/baseline.sql$')
  MF=$(f -c '^supabase/migrations/MANIFEST.md$')
  # Desde o #2149 a descrição pode morar no cabeçalho `-- manifest:` do próprio
  # .sql em vez de numa linha do MANIFEST.md; contar só o MANIFEST dava
  # "INCOMPLETA" falso em toda migration do formato novo (#2259, #2260, #2263).
  # Conta ARQUIVOS de migration (não linhas do diff inteiro) cujo conteúdo
  # adicionado traz o cabeçalho — linha `-- manifest:` em teste/doc, ou duas num
  # mesmo .sql, não podem cobrir outra migration que não o tem.
  HM=$(awk '/^\+\+\+ b\//{f=substr($0,7); next} f ~ /^supabase\/migrations\/[0-9][^\/]*\.sql$/ && /^\+-- manifest:/ {seen[f]=1} END{n=0; for(k in seen) n++; print n}' <<<"$DIFF")
  [ "$HM" -ge "$MIG" ] && MF=$((MF + HM))
  p migration_tripla "migrations=$MIG baseline=$BL manifest=$MF (cabecalho=$HM) $([ "$BL" -ge 1 ] && [ "$MF" -ge 1 ] && echo COMPLETA || echo INCOMPLETA)"
  # A população é a da pergunta (#1273): a main do PRODUTO mais as outras refs do
  # clone, com a âncora do nome canônico. A versão anterior media `git ls-tree
  # origin/main` e contava com `grep -c "_${NUM}_"` — a main de um fork em vez da
  # do produto, e o número do SLUG contando como coluna (um `_0269_` no slug
  # contava como colisão que não existe). A árvore de trabalho (o PR) entra
  # também: o arquivo que o PR acrescenta É o que ocupa o número.
  if [ -r "$COMPL_TOP/scripts/migration-populacao.sh" ]; then
    # shellcheck source=/dev/null
    . "$COMPL_TOP/scripts/migration-populacao.sh" || true
  fi
  if declare -F pop_migrations >/dev/null 2>&1; then
    COMPL_BASE=""
    COMPL_BASE="$(pop_main_do_produto 2>/dev/null || true)"
    if [ -n "$COMPL_BASE" ] && ! git rev-parse -q --verify "${COMPL_BASE}^{commit}" >/dev/null 2>&1; then
      COMPL_BASE=""
    fi
    if [ -z "$COMPL_BASE" ]; then
      COMPL_BASE="origin/main"
      git rev-parse -q --verify "${COMPL_BASE}^{commit}" >/dev/null 2>&1 || COMPL_BASE=""
    fi
    COMPL_REFS="$(pop_refs_de_outrem "$COMPL_BASE" 2>/dev/null || true)"
    [ -n "${COMPL_REFS// /}" ] || COMPL_REFS="HEAD"
    # A cabeça do PR entra SEMPRE, e sem ela a duplicata DENTRO do próprio PR
    # sumia da conta — nenhum dos dois arquivos acusava o outro. É o `$SHA` (a
    # cabeça que o gh devolveu), e não o HEAD: a triagem roda este script do
    # PRÓPRIO clone, sem checkout do PR (TRIAGEM.md §4), e lá o HEAD é a branch
    # de quem tria. O HEAD só entra quando o gh não devolveu cabeça. O `grep -vE`
    # que tira o próprio arquivo continua abaixo, e o irmão não é ele.
    COMPL_POP="$(pop_migrations $COMPL_REFS "${SHA:-HEAD}" 2>/dev/null || true)"
  else
    COMPL_BASE="origin/main"; COMPL_POP=""
  fi
  for m in $(f '^supabase/migrations/[0-9].*\.sql$'); do
    NOME=$(basename "$m")
    NUM=$(pop_nnnn_de <<<"$NOME" 2>/dev/null || true)
    [ -n "$NUM" ] || NUM=$(sed -nE 's/^[0-9]{14}_([0-9]{4})_.+\.sql$/\1/p' <<<"$NOME")
    # O próprio arquivo do PR não é colisão dele: a lista de `pop_migrations` é a
    # das outras refs, e a linha deste arquivo é o que o PR acrescenta.
    COLIDE=NAO_MEDIDO
    if [ -n "$COMPL_POP" ]; then
      COLIDE=$(grep -E " [0-9]{14}_${NUM}_.+\.sql$" <<<"$COMPL_POP" | grep -vE " ${NOME}\$" | awk '{print $1}' | sort -u | paste -sd, - || true)
      [ -n "$COLIDE" ] || COLIDE=0
    fi
    p migration_num "$NUM arquivo=$NOME colide_em=${COLIDE} (base='${COMPL_BASE:-nenhuma}'; PRs abertos fora daqui — use pnpm checar:colisao-de-migration)"
  done
  # constraint sem dedup prévio
  c -qiE '(add constraint|unique \(|check \()' && p migration_constraint "SIM — confira dedup ANTES da constraint"
  c -qiE '(create table|add column)' && \
    { c -qiE 'if not exists' && p migration_idempotente "tem 'if not exists'" || p migration_idempotente "SEM 'if not exists' — reprova update.sh"; }
else p migration_tripla "n/a"; fi

# --- 2. RLS de tabela tenant-aware nova ---
NOVAS=$(c -iE '^\+\s*create table' | sed -E 's/.*create table[^a-z_]*(if not exists )?//I' | awk '{print $1}' | tr -d '(' | sort -u)
if [ -n "$NOVAS" ]; then
  p tabela_nova "$(echo "$NOVAS" | tr '\n' ' ')"
  c -qi 'enable row level security' && p rls_enable "SIM" || p rls_enable "AUSENTE — bloqueador"
  c -qi 'tenant_isolation_' && p rls_policy "SIM" || p rls_policy "AUSENTE"
  f -q '^tests/invariants/rls-isolation.test.ts$' && p rls_lista_fixa "tabela acrescentada ao TABLES" || p rls_lista_fixa "NAO acrescentada ao TABLES de rls-isolation.test.ts"
else p tabela_nova "n/a"; fi

# --- security definer exposta ---
if c -qi 'security definer'; then
  c -qiE 'revoke (execute|all( privileges)?) on function.*from.*(public|anon)' && p definer_revoke "tem revoke" || p definer_revoke "security definer SEM revoke — as DUAS origens"
fi

# --- 4. console.log (no-console é warn, o CI não reprova) ---
CL=$(c -cE 'console\.log')
p console_log "$CL $([ "$CL" -gt 0 ] && echo '— DoD 8, nenhum gate reprova' || echo)"

# --- 5. env var nova ---
if f -qE '^(lib/env.ts|\.env\.example)$'; then
  E1=$(f -c '^lib/env.ts$'); E2=$(f -c '^\.env\.example$')
  p env_var "env.ts=$E1 .env.example=$E2 $([ "$E1" = "$E2" ] && echo 'os dois' || echo 'SÓ UM — o outro falta')"
  c -E 'z\.string\(\)' | grep -v 'optional\|default' | head -3 | sed 's/^/\tenv_required\t/'
fi

# --- 6. kit self-host ---
f -qE '^(hostgator-setup-kit/|docker-compose|Dockerfile|scripts/.*\.sh)' \
  && p kit_selfhost "SIM — exige install fresh + update idempotente + GET externo" || p kit_selfhost "n/a"

# --- 8. catraca de canal ---
if f -qE '\.(ts|tsx)$'; then
  KD=$(git show origin/main:scripts/lint-channels.ts 2>/dev/null | grep -oE '"[^"]+\.(ts|tsx)"' | tr -d '"' | sort -u)
  HIT=$(comm -12 <(echo "$FILES" | sort -u) <(echo "$KD" | sort -u) | tr '\n' ' ')
  [ -n "${HIT// /}" ] && p catraca_canal "toca KNOWN_DEBT: $HIT" || p catraca_canal "nao toca KNOWN_DEBT"
fi

# --- 9. workflows de fork ---
f -q '^\.github/workflows/' && p workflow_fork "SIM — leitura linha a linha obrigatoria" || p workflow_fork "n/a"
c -q 'pull_request_target' && p workflow_target "pull_request_target NO DIFF — bloqueador"

# --- 7. falha-em-verde ---
c -qiE '(healthcheck|conclu[ií]d|sucesso|success|"ok"|status.*online)' \
  && p falha_em_verde "o PR declara sucesso em algum ponto — qual sonda? mede o caminho do usuario?"

# --- passe 12: versao ---
FR=$(f -c '^\.changes/')
p fragmento ".changes=$FR $([ "$FR" -gt 0 ] && echo "$(d -oE '^\+(tipo|impacto): *[a-z_]+' | head -1)" || echo 'AUSENTE — escrever se muda comportamento')"
CH=$(d -cE '^\+## \[[0-9]+\.[0-9]+\.[0-9]+\]')
p changelog_a_mao "$CH $([ "$CH" -gt 0 ] && echo '— BLOQUEADOR' || echo '(vazio e o esperado)')"

# --- DoD 14: tela nova tem porta ---
NOVAPAG=$(f -cE '^app/.*/page\.tsx$')
if [ "$NOVAPAG" -gt 0 ]; then
  f -q 'lib/navigation/registry.ts' && p porta_navegacao "registry.ts tocado" || p porta_navegacao "$NOVAPAG page.tsx SEM tocar lib/navigation/registry.ts"
fi

# --- server action nova sem chamador (TRIAGEM, modo de falha 65) ---
# O #861 cumpria a fatia "pela tela" com a action e nenhuma tela a chamava. Uma
# action exportada que só é citada no próprio arquivo e em testes não existe para
# quem opera, e o fragmento que a anuncia é falso.
# `BASE` (padrão origin/main) existe para medir PR já mergeado contra a base dele.
if git cat-file -e "${SHA}^{commit}" 2>/dev/null; then
  for a in $(git diff --name-only --diff-filter=A "${BASE:-origin/main}...$SHA" -- 'app/actions/' 2>/dev/null | grep -E '\.ts$'); do
    for fn in $(git show "$SHA:$a" | grep -oE 'export (async )?function [A-Za-z0-9_]+' | awk '{print $NF}'); do
      n=$(git grep -l -w "$fn" "$SHA" -- app components hooks lib 2>/dev/null | sed "s#^$SHA:##" | grep -vxF "$a" | grep -vcE '\.test\.|(^|/)tests?/')
      [ "$n" -eq 0 ] && p acao_sem_chamador "$a:$fn — nenhum chamador fora do próprio arquivo e dos testes"
    done
  done
fi

# --- teste acompanha comportamento ---
# `.tsx` entra: a main tem >100 `.test.tsx` e o vitest os coleta. Medido no #860: "SEM teste"
# com `tests/unit/agenda-confirmar-pela-tela.test.tsx` no PR.
TS=$(f -cE '\.(test|spec)\.tsx?$')
SRC=$(f -cE '^(app|lib|components|hooks|workers)/.*\.(ts|tsx)$' )
p teste "arquivos_de_teste=$TS arquivos_de_fonte=$SRC $([ "$SRC" -gt 0 ] && [ "$TS" -eq 0 ] && echo '— muda fonte SEM teste' || echo)"

# ---------------------------------------------------------------------------
# Pré-requisito: o head do PR tem de existir no clone, senão TODA prévia do
# merge sai como "CONFLITO" e o número é do instrumento, não do PR.
#   git fetch origin --force $(for n in $(gh pr list --state open --limit 100 \
#     --json number --jq '.[].number'); do printf "pull/%s/head:refs/tri/%s " "$n" "$n"; done)
# Medido em 14/set: sem isso, 74 de 74 prévias sairiam vermelhas.
