#!/usr/bin/env bash
# Mecaniza o passe 4 do TRIAGEM.md — o complemento do CI, PR a PR.
# Uso: complemento.sh <numero-do-pr>
# Saída: linhas "CHAVE<TAB>VALOR". Toda linha é medição, nenhuma é veredito.
set -uo pipefail
N="$1"
cd "$(git rev-parse --show-toplevel)"

DIFF=$(gh pr diff "$N" 2>/dev/null)
FILES=$(gh pr view "$N" --json files --jq '.files[].path' 2>/dev/null)
SHA=$(git rev-parse "refs/tri/$N" 2>/dev/null || gh pr view "$N" --json headRefOid --jq .headRefOid 2>/dev/null)

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
  p migration_tripla "migrations=$MIG baseline=$BL manifest=$MF $([ "$BL" -ge 1 ] && [ "$MF" -ge 1 ] && echo COMPLETA || echo INCOMPLETA)"
  for m in $(f '^supabase/migrations/[0-9].*\.sql$'); do
    NUM=$(basename "$m" | sed -E 's/^[0-9]+_([0-9]{4})_.*/\1/')
    COLIDE=$(git ls-tree --name-only origin/main supabase/migrations/ | grep -c "_${NUM}_")
    p migration_num "$NUM arquivo=$(basename "$m") colide_na_main=$COLIDE"
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
  c -qiE 'revoke execute on function.*from.*(public|anon)' && p definer_revoke "tem revoke" || p definer_revoke "security definer SEM revoke — as DUAS origens"
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
