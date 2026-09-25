#!/usr/bin/env bash
# Prova de que os guards de commit do gov-loop (loop/hooks/) não acusam o AUTOR por
# trabalho que chegou de um MERGE DA MAIN — e de que a guarda real continua de pé.
#
#   bash tests/shell/hooks-nao-acusam-a-main.test.sh
#
# Cada caso monta um repositório git DESCARTÁVEIS e sem rede: um "principal" local faz o
# papel da main e o `git clone` dá um `origin/main` de verdade (é isso que torna o teste
# independente do checkout raso do CI, onde a ref do repo não existe). Nada aqui toca o
# clone de quem roda.
#
# A CLASSE sob prova: um hook que julga `git diff --cached` sem excluir o que já é
# alcançável por `origin/main` acusa o autor pelo que veio da main. Um merge LIMPO não
# chama hook nenhum; um merge com CONFLITO passa por `git commit`, e aí o pre-commit roda
# sobre o índice INTEIRO do merge. Medido em 18/09/2026 em três guards irmãos:
# check-migration-triple.sh (PR #1179), freeze-invariants.sh e validate-features.sh
# (casos 4/5 da issue #1161).
#
# O que está sob prova, hook por hook:
#
#   freeze-invariants.sh — o eixo é PROCEDÊNCIA, e ela exige CINCO referências: o índice
#        (`:<p>`), `HEAD:<p>`, `MERGE_HEAD:<p>`, `merge-base:<p>` e `origin/main:<p>` (a
#        PONTA da main — não qualquer ancestral dela). Um caminho sai da lista só quando as
#        SEIS condições valem — (1) há merge de um lado só, (2) o outro lado é alcançável
#        por `origin/main`, (3) `HEAD:<p>` == `base:<p>`, (4) `:<p>` == `MERGE_HEAD:<p>`,
#        (5) `MERGE_HEAD:<p>` != `base:<p>` e (6) `:<p>` == `origin/main:<p>` — e CADA uma
#        tem aqui o caso que fica vermelho quando ela é removida (medido, uma sabotagem por
#        condição):
#          2 → FURO-B, COLEGA-DEL, SEM-REF     4 → B+
#          3 → FURO-A, FURO-A-MH               5 → MODO
#          6 → ANCESTRAL-SUPERADO
#        (a 1 não tem caso: octopus não está coberto — ver o comentário do caso FURO-B.)
#     1. o FALSO POSITIVO morreu: invariante que o merge trouxe não é acusado — nem quando
#        o merge o MODIFICA (caso B), nem quando ele o RENOMEIA (caso REN-LEGIT), nem
#        quando o caminho tem ACENTO (caso ACENTO-LEGIT).
#     2. a GUARDA REAL continua inteira, e este é o ponto: editar invariante com conteúdo
#        PRÓPRIO segue bloqueado — inclusive escondido DENTRO do merge da main, que é o
#        disfarce mais fácil depois de relaxar o hook.
#     3. DELETE segue acusado, ADIÇÃO segue liberada (é a regra declarada no cabeçalho do
#        hook) e a válvula segue funcionando.
#     4. e os eixos mais SIMPLES furam, cada um com o seu caso aqui:
#        · existência de CAMINHO (`git cat-file -e origin/main:$p`, a forma do guard de
#          migration): o invariante existe na main tanto quando a main o trouxe quanto
#          quando a branch o reescreveu → caso B+.
#        · ALCANÇABILIDADE por `origin/main` (`git merge-base --is-ancestor`, também a forma
#          do guard de migration): aceita QUALQUER ancestral, e o commit que a main absorveu
#          e depois SUPEROU é alcançável — o conserto da main voltava para a branch, em
#          silêncio → caso ANCESTRAL-SUPERADO (o defeito da #1227). Quem mede a ponta é a 6.
#        · identidade de CONTEÚDO contra `origin/main`, SOZINHA: também é verdade quando a
#          sessão REVERTE o invariante para a versão da main, que é autoria → casos R1 e
#          R1-LIMPO e, DENTRO do merge, CONTEUDO-REVERTIDO — que é o motivo de a 6 ser
#          CONJUNTA com a 3, e não a condição única. E ela julgava só o `$3` da linha `R`,
#          deixando o path VELHO ser apagado em silêncio → caso R-VELHO.
#        · julgar só o índice, `MERGE_HEAD` e a base, SEM ler `HEAD` (a versão anterior):
#          as condições 4 e 5 valem quando a sessão DESCARTA a versão da própria branch
#          dentro do merge → casos FURO-A e FURO-A-MH.
#        · aceitar QUALQUER `MERGE_HEAD` (idem): a ref é fabricável pela própria sessão
#          (`git stash`) e um colega não revisado não é trabalho aceito → FURO-B,
#          COLEGA-DEL.
#     5. falha FECHADA onde a procedência não é decidível: sem MERGE_HEAD (R1), sem
#        ancestral comum (FECHADO-SEM-BASE) e sem a ref `origin/main` (SEM-REF, cuja
#        expectativa VOLTOU a 1 — mudança declarada, ver o comentário do caso).
#     6. e a lista de entrada não falha mais ABERTA em caminho que o git CITA (acento com
#        `core.quotepath`, aspas, barra invertida): a âncora `^tests/invariants/` não
#        casava e o invariante era invisível à guarda → casos CITADO/ACENTO.
#
#   validate-features.sh
#     5. o FALSO POSITIVO morreu nos dois caminhos: a main EDITANDO e a main CRIANDO
#        plan/features.json depois do ponto da branch.
#     6. a guarda real continua: reescrever `title` segue bloqueado, fora e DENTRO do
#        merge; mexer só em `passes`/`verification` segue liberado.
#     7. a sonda da linha de entrada não falha mais ABERTA em merge grande. Sem pathspec,
#        `git diff --cached --name-only | grep -q` fecha o pipe no meio, o git morre de
#        SIGPIPE, o `pipefail` propaga 141 e o `|| exit 0` engole — o hook saía 0 sem
#        validar NADA. Este caso é o que impede o conserto de trocar um defeito por outro.
#
# Controle de vivacidade: os casos 2, 3, 4, 5, 6 e 7 são as asserções POSITIVAS (A, B+, D,
# D2, R1, R1-LIMPO, R-VELHO, FECHADO-SEM-BASE, FURO-A, FURO-A-MH, FURO-B, COLEGA-DEL, MODO,
# CITADO, SEM-REF, F-A, F-B+, F-CRIA-PRÓPRIA, F-BIG+). Um hook substituído por `exit 0` os
# deixa vermelhos — é o que prova que este arquivo mede algo.
#
# ⚠️ Nenhum número de casos escrito aqui, de propósito: contagem em prosa envelhece a cada
# caso novo e ninguém a revisa. Quem precisa do número RODA o arquivo — o rodapé o imprime.
# Para medir a vivacidade contra uma versão antiga do hook, sem tocar no seu clone:
#
#   t=$(mktemp -d); mkdir -p "$t/loop/hooks" "$t/tests/shell"
#   for f in $(git ls-tree --name-only <SHA> loop/hooks/); do
#     git show "<SHA>:$f" > "$t/loop/hooks/$(basename "$f")"; done
#   chmod +x "$t"/loop/hooks/*
#   cp tests/shell/hooks-nao-acusam-a-main.test.sh "$t/tests/shell/"
#   bash "$t/tests/shell/hooks-nao-acusam-a-main.test.sh"; echo "exit=$?"
#
# (exit SEM pipe; um `| tail` devolve o código do tail e imprime sucesso sobre uma recusa.)
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOKS_ORIGEM="$RAIZ/loop/hooks"

falhas=0; casos=0
ok()   { casos=$((casos+1)); printf '  ✓ %s\n' "$1"; }
falha(){ casos=$((casos+1)); falhas=$((falhas+1)); printf '  ✗ %s\n     %s\n' "$1" "${2:-}"; }
assert_exit() { if [ "$1" = "$2" ]; then ok "$3"; else falha "$3" "exit esperado $2, veio $1"; fi; }
assert_contains() { if grep -qF -- "$2" <<<"$1"; then ok "$3"; else falha "$3" "esperava conter '$2'; saída: $(head -c 400 <<<"$1")"; fi; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
# ── isolamento do git: nada aqui escreve fora de "$TMP" ─────────────────────────────
# Um `git -C "$dir" config user.*` grava onde o git RESOLVER o repositório, e não
# necessariamente em "$dir": um GIT_DIR herdado (rodar de dentro de um hook, de um
# `rebase --exec`) manda por cima do -C; "$dir" que não é repositório sobe até o pai.
# Foi assim que "Pessoa <alguem@fork.dev>" parou no .git/config do checkout de quem
# rodava a suíte e assinou 829 commits da main a partir de 10/09/2026. Três travas:
#   1. zera o ambiente local do git herdado — o idioma canônico do próprio git;
#   2. a descoberta de repositório nunca sobe para fora de "$TMP";
#   3. identidade por ambiente, não por `git config` (NENHUM teste aqui mede o autor).
unset $(git rev-parse --local-env-vars)
export GIT_CEILING_DIRECTORIES="$TMP"
export GIT_AUTHOR_NAME="Teste" GIT_AUTHOR_EMAIL="teste@exemplo.invalid"
export GIT_COMMITTER_NAME="Teste" GIT_COMMITTER_EMAIL="teste@exemplo.invalid"
unset DESKCOMM_GOV_INVARIANTS_EDIT DESKCOMM_GOV_PLAN_EDIT || true

INV=tests/invariants/exemplo-congelado.test.ts
FEAT=plan/features.json
# um invariante cujo nome o git CITA (aspas no nome). Ele existe porque a varredura de
# formas de 18/09/2026 achou aqui um furo ABERTO, não um falso positivo — ver CITADO.
INV_CITADO='tests/invariants/inv-com-"aspas".test.ts'
# e um com ACENTO, que o `core.quotepath` do git (padrão: true) também cita
INV_ACENTO='tests/invariants/inv-acentuação.test.ts'

commitar()    { git -C "$1" add -A >/dev/null && git -C "$1" commit -q --no-verify -m "$2"; }

# O invariante tem TRÊS SLOTS separados por linhas de contexto, e isso é premissa de
# MEDIÇÃO, não estética: é o que faz o 3-way do git resolver o arquivo SOZINHO quando os
# dois lados mexem nele — o estado exato do caso FURO-A. Com os slots colados o merge
# CONFLITA, e o caso passaria a medir outra coisa.
# $1 slot do colega, $2 slot da branch, $3 slot da main.
inv() {
  printf 'import { it } from "vitest";\n%s\nit("MARCADOR-BASE-A", () => {});\nit("MARCADOR-BASE-B", () => {});\nit("MARCADOR-BASE-C", () => {});\n%s\nit("MARCADOR-BASE-D", () => {});\nit("MARCADOR-BASE-E", () => {});\nit("MARCADOR-BASE-F", () => {});\n%s\n' \
    "${1:-// slot-colega}" "${2:-// slot-branch}" "${3:-// slot-main}"
}
MARCA_COLEGA='it("MARCADOR-COLEGA", () => {});'
MARCA_BRANCH='it("MARCADOR-BRANCH", () => {});'
MARCA_MAIN='it("MARCADOR-MAIN", () => {});'
# a sonda de CONSEQUÊNCIA: o MARCADOR de UM lado no HEAD depois do commit. Nunca
# contagem — a versão da main TAMBÉM tem duas asserções, então contar prova que nada
# sumiu do total, não que não sumiu a asserção DAQUELE lado.
tem_marcador() { git -C "$1" show "HEAD:$2" 2>/dev/null | grep -qF "MARCADOR-$3"; }

# ── o "principal" que faz o papel da main ───────────────────────────────────────────
principal="$TMP/principal"; mkdir -p "$principal/tests/invariants" "$principal/plan"
git -C "$principal" init -q -b main
inv > "$principal/$INV"
inv > "$principal/$INV_CITADO"
inv > "$principal/$INV_ACENTO"
printf '{\n  "epico": "G6",\n  "features": [\n    { "id": "F1", "title": "titulo original", "passes": false }\n  ]\n}\n' > "$principal/$FEAT"
printf '# leia\n' > "$principal/README.md"
commitar "$principal" "base da main"
BASE_DA_BRANCH=$(git -C "$principal" rev-parse HEAD)

# uma branch de COLEGA que FORTALECE o invariante. Ela existe por causa do caso R1-LIMPO:
# a rota que apaga o fortalecimento de outra pessoa não precisa de válvula em passo nenhum
# — merge limpo não chama hook, e o commit seguinte só reverte para a versão da main.
git -C "$principal" checkout -q -b colega
inv "$MARCA_COLEGA" > "$principal/$INV"
commitar "$principal" "o colega fortalece o invariante"
git -C "$principal" checkout -q main

# e uma branch de COLEGA que APAGA o invariante, mexendo no README para CONFLITAR. Ela
# existe pelo caso COLEGA-DEL: é a forma mundana do FURO B, sem stash nenhum.
git -C "$principal" checkout -q -b colega-del
git -C "$principal" rm -q "$INV"
printf '# leia\nlinha do COLEGA-DEL\n' > "$principal/README.md"
commitar "$principal" "o colega apaga o invariante"
git -C "$principal" checkout -q main

# a main ANDA: edita o invariante e o features.json (só campo proibido, como um ato humano)
inv "" "" "$MARCA_MAIN" > "$principal/$INV"
inv "" "" "$MARCA_MAIN" > "$principal/$INV_ACENTO"
printf '{\n  "epico": "G6",\n  "features": [\n    { "id": "F1", "title": "titulo original", "passes": false },\n    { "id": "F2", "title": "feature que a MAIN criou", "passes": false }\n  ]\n}\n' > "$principal/$FEAT"
# o README entra no mesmo commit de propósito: é o que faz o merge do caso E2E CONFLITAR,
# e sem conflito o `git commit` não acontece e o pre-commit nunca é chamado.
printf '# leia\nlinha que a MAIN acrescentou\n' > "$principal/README.md"
commitar "$principal" "a main anda: invariante, plano e README"

# e um commit só-de-plano, para o caminho de CRIAÇÃO (a main cria o arquivo depois)
principal2="$TMP/principal2"; mkdir -p "$principal2/plan"
git -C "$principal2" init -q -b main
printf '# leia\n' > "$principal2/README.md"; commitar "$principal2" "base sem plano"
BASE_SEM_PLANO=$(git -C "$principal2" rev-parse HEAD)
printf '{\n  "epico": "G6",\n  "features": [ { "id": "F1", "title": "criado pela main", "passes": false } ]\n}\n' > "$principal2/$FEAT"
commitar "$principal2" "a main CRIA o plano"

# ── dois principais só para a linha `R` (rename), que exige CORPO ─────────────────────
# A detecção de rename do git pede ≥50% de similaridade, e um invariante de UMA linha
# nunca forma par. Estes dois têm corpo de verdade de propósito; são separados do
# `$principal` para não mudar o que os casos B/D/E2E encenam.
CORPO_PAR='import { describe, it, expect } from "vitest";
describe("%s e server-side", () => {
  it("nao vaza credencial para o cliente", () => { expect(1 + 1).toBe(2); });
  it("nao aceita segredo em NEXT_PUBLIC", () => { expect(true).toBe(true); });
});
'
VELHO=tests/invariants/credencial-do-google-e-server-side.test.ts
NOVO_DA_MAIN=tests/invariants/app-da-meta-e-server-side.test.ts

# principal_par: a main ACRESCENTA um invariante parecido com o que já existe. É o par
# `R` que o git forma sozinho quando a SESSÃO apaga o velho dentro do merge (caso R-VELHO).
principal_par="$TMP/principal_par"; mkdir -p "$principal_par/tests/invariants"
git -C "$principal_par" init -q -b main
printf "$CORPO_PAR" "credencial do google" > "$principal_par/$VELHO"
printf '# leia\n' > "$principal_par/README.md"
commitar "$principal_par" "base com o invariante velho"
BASE_PAR=$(git -C "$principal_par" rev-parse HEAD)
printf "$CORPO_PAR" "app da meta" > "$principal_par/$NOVO_DA_MAIN"
printf '# leia\nlinha que a MAIN acrescentou\n' > "$principal_par/README.md"
commitar "$principal_par" "a main ACRESCENTA o invariante novo (e mexe no README)"

# principal_ren: a main RENOMEIA o invariante. Rename legítimo do outro lado do merge tem
# de PASSAR — a linha `R` inteira veio de lá (caso REN-LEGIT).
RENOMEADO=tests/invariants/app-da-meta-e-server-side.test.ts
principal_ren="$TMP/principal_ren"; mkdir -p "$principal_ren/tests/invariants"
git -C "$principal_ren" init -q -b main
printf "$CORPO_PAR" "credencial do google" > "$principal_ren/$VELHO"
printf '# leia\n' > "$principal_ren/README.md"
commitar "$principal_ren" "base com o invariante velho"
BASE_REN=$(git -C "$principal_ren" rev-parse HEAD)
git -C "$principal_ren" mv "$VELHO" "$RENOMEADO"
printf "$CORPO_PAR" "app da meta" > "$principal_ren/$RENOMEADO"
printf '# leia\nlinha que a MAIN acrescentou\n' > "$principal_ren/README.md"
commitar "$principal_ren" "a main RENOMEIA o invariante (e mexe no README)"

# ── o "principal" do #1227: a main ABSORVE um commit e DEPOIS o SUPERA ───────────────────
# É a montagem que faz da condição 2 uma garantia FALSA: o outro lado é um commit que a main
# absorveu — `--is-ancestor` dele contra `origin/main` é VERDADEIRO — e sobre o qual a main
# já andou por cima. Mede o caso ANCESTRAL-SUPERADO.
principal_ponta="$TMP/principal_ponta"; mkdir -p "$principal_ponta/tests/invariants"
git -C "$principal_ponta" init -q -b main
inv > "$principal_ponta/$INV"
printf '# leia\n' > "$principal_ponta/README.md"
commitar "$principal_ponta" "base da main"
BASE_PONTA=$(git -C "$principal_ponta" rev-parse HEAD)
git -C "$principal_ponta" checkout -q -b colega_ponta
inv "$MARCA_COLEGA" > "$principal_ponta/$INV"
commitar "$principal_ponta" "o colega fortalece o invariante"
ABSORVIDO=$(git -C "$principal_ponta" rev-parse HEAD)
git -C "$principal_ponta" checkout -q main
git -C "$principal_ponta" merge -q --no-ff colega_ponta -m "a main ABSORVE o fortalecimento do colega"
inv "" "" "$MARCA_MAIN" > "$principal_ponta/$INV"
commitar "$principal_ponta" "a main conserta o invariante que absorveu"

# ── monta uma branch de trabalho atrasada, com um commit próprio ─────────────────────
# $1 destino, $2 repo principal, $3 commit-base (o ponto em que a branch saiu)
preparar() {
  rm -rf "$1"; git clone -q "$2" "$1" >/dev/null 2>&1
  mkdir -p "$1/loop/hooks"; cp "$HOOKS_ORIGEM"/*.sh "$HOOKS_ORIGEM/pre-commit" "$1/loop/hooks/"
  chmod +x "$1"/loop/hooks/*
  # o dispatcher fica ARMADO em todo fixture: os casos novos medem pelo caminho de
  # produção (`git commit`), e o `commitar()` do setup usa --no-verify de propósito.
  git -C "$1" config core.hooksPath loop/hooks
  git -C "$1" checkout -q -B trabalho "$3"
  printf 'arquivo nao relacionado\n' > "$1/meu-trabalho.txt"
  commitar "$1" "meu commit proprio"
}
# roda UM hook direto sobre o índice, sem pipe (armadilha: exit code depois de pipe é o do
# último comando do pipe, e um `| grep` imprime sucesso sobre uma recusa)
rodar() { local d=$1 h=$2 saida rc; saida=$( cd "$d" && bash "loop/hooks/$h" 2>&1 ); rc=$?; printf '%s\n__EXIT__%s\n' "$saida" "$rc"; }
# e o CAMINHO DE PRODUÇÃO: `git commit` de verdade, pelo dispatcher `loop/hooks/pre-commit`.
# Não é preciosismo de método — a versão REFUTADA deste conserto passava quando medida
# chamando o `.sh` direto; chamar o arquivo mede a FUNÇÃO, e o que decide é o SISTEMA.
commitar_pelo_dispatcher() {
  local d=$1 msg=$2 saida rc
  saida=$( cd "$d" && git commit --no-edit -m "$msg" 2>&1 ); rc=$?
  printf '%s\n__EXIT__%s\n' "$saida" "$rc"
}
exit_de()  { sed -n 's/^__EXIT__//p' <<<"$1"; }
saida_de() { sed '/^__EXIT__/d' <<<"$1"; }

printf '\nfreeze-invariants.sh — o falso positivo do merge da main\n'

# CASO B · o invariante chega pelo merge da main, byte-a-byte igual ao dela
b="$TMP/b"; preparar "$b" "$principal" "$BASE_DA_BRANCH"
git -C "$b" merge --no-commit --no-ff origin/main >/dev/null 2>&1 || true
encenado=$(git -C "$b" rev-parse ":$INV"); na_main=$(git -C "$b" rev-parse "origin/main:$INV")
if [ "$encenado" = "$na_main" ]; then ok "o blob encenado é IDÊNTICO ao da main (a premissa do caso)"
else falha "o blob encenado é IDÊNTICO ao da main (a premissa do caso)" "$encenado != $na_main"; fi
# procedência, nos dois sentidos — o segundo é o controle que fecha
if [ -z "$(git -C "$b" log --oneline origin/main..HEAD -- "$INV")" ]; then ok "nenhum commit da branch tocou o invariante (origin/main..HEAD vazio)"
else falha "nenhum commit da branch tocou o invariante" "log não veio vazio"; fi
if [ -n "$(git -C "$b" log --oneline HEAD..origin/main -- "$INV")" ]; then ok "e a main tocou (HEAD..origin/main não-vazio) — o controle positivo da sonda"
else falha "e a main tocou (HEAD..origin/main não-vazio)" "log veio vazio: a sonda está cega"; fi
r=$(rodar "$b" freeze-invariants.sh)
assert_exit "$(exit_de "$r")" 0 "B: invariante que a main trouxe NÃO é acusado"

# CASO B+ · o MESMO merge, mas a branch edita o invariante por cima (a guarda real)
bp="$TMP/bp"; preparar "$bp" "$principal" "$BASE_DA_BRANCH"
git -C "$bp" merge --no-commit --no-ff origin/main >/dev/null 2>&1 || true
printf 'it("MARCADOR-REESCRITO-PELA-SESSAO", () => {});\n' > "$bp/$INV"
git -C "$bp" add "$INV"
r=$(rodar "$bp" freeze-invariants.sh)
assert_exit "$(exit_de "$r")" 1 "B+: edição PRÓPRIA escondida dentro do merge SEGUE bloqueada"
assert_contains "$(saida_de "$r")" "$INV" "B+: e a mensagem nomeia o invariante acusado"

# CASO ANCESTRAL-SUPERADO (#1227) · o outro lado é um commit que a main ABSORVEU e DEPOIS
# SUPEROU. `git merge-base --is-ancestor <absorvido> origin/main` é VERDADEIRO — a condição 2 o
# declara "trabalho aceito" — e o que ele traz é a versão SUPERADA: o conserto que a main fez
# depois volta para a branch, em silêncio, se a exclusão passar. `--is-ancestor` aceita QUALQUER
# ancestral; quem mede a ponta é a condição 6.
as="$TMP/as"; preparar "$as" "$principal_ponta" "$BASE_PONTA"
git -C "$as" merge --no-commit --no-ff "$ABSORVIDO" >/dev/null 2>&1 || true
if git -C "$as" merge-base --is-ancestor "$ABSORVIDO" origin/main; then
  ok "ANCESTRAL-SUPERADO: o outro lado É alcançável por origin/main (a 2 não o distingue da ponta)"
else falha "ANCESTRAL-SUPERADO: o outro lado É alcançável por origin/main" "não é ancestral: a montagem não mede o que diz medir"; fi
if [ "$(git -C "$as" rev-parse ":$INV")" != "$(git -C "$as" rev-parse "origin/main:$INV")" ]; then
  ok "ANCESTRAL-SUPERADO: e o conteúdo encenado é DIFERENTE do da ponta (é a versão superada)"
else falha "ANCESTRAL-SUPERADO: e o conteúdo encenado é DIFERENTE do da ponta" "encenado == ponta: a montagem não encena a perda"; fi
r=$(rodar "$as" freeze-invariants.sh)
assert_exit "$(exit_de "$r")" 1 "ANCESTRAL-SUPERADO: o merge do absorvido-e-superado é ACUSADO (o conserto da main não se reverte em silêncio)"
assert_contains "$(saida_de "$r")" "$INV" "ANCESTRAL-SUPERADO: e a mensagem nomeia o invariante acusado"
r=$(commitar_pelo_dispatcher "$as" "merge do absorvido (que a main superou)")
assert_exit "$(exit_de "$r")" 1 "ANCESTRAL-SUPERADO: e pelo caminho de produção o commit do merge é RECUSADO"
if [ -f "$as/.git/MERGE_HEAD" ]; then ok "ANCESTRAL-SUPERADO: e o merge continua em curso (MERGE_HEAD segue lá — bloqueio sem dano colateral)"
else falha "ANCESTRAL-SUPERADO: e o merge continua em curso" "MERGE_HEAD sumiu: o commit passou"; fi

# CASO CONTEUDO-REVERTIDO · o controle que fecha o "hook (b)" refutado e que a condição 6 SOZINHA
# reabriria: a branch TEM autoria sobre o invariante (o ato com a válvula) e a sessão o troca,
# DENTRO do merge, pela versão da main. `:<INV> == origin/main:<INV>` é VERDADE — e ainda assim
# tem de ser ACUSADO, porque a exclusão perde a 3 (NA_BRANCH != BASE): reverter o próprio
# fortalecimento dentro do merge é autoria, não "o que a main trouxe".
cr="$TMP/cr"; preparar "$cr" "$principal" "$BASE_DA_BRANCH"
inv "" "$MARCA_BRANCH" > "$cr/$INV"
commitar "$cr" "a branch FORTALECE o invariante (ato com a válvula)"
git -C "$cr" merge --no-commit --no-ff origin/main >/dev/null 2>&1 || true
git -C "$cr" checkout -q origin/main -- "$INV"; git -C "$cr" add "$INV"
if [ "$(git -C "$cr" rev-parse ":$INV")" = "$(git -C "$cr" rev-parse "origin/main:$INV")" ]; then
  ok "CONTEUDO-REVERTIDO: o encenado é IDÊNTICO à ponta (a premissa do hook (b) refutado)"
else falha "CONTEUDO-REVERTIDO: o encenado é IDÊNTICO à ponta" "blobs divergem: a montagem não encena o caso"; fi
if [ "$(git -C "$cr" rev-parse "HEAD:$INV")" != "$(git -C "$cr" rev-parse "$BASE_DA_BRANCH:$INV")" ]; then
  ok "CONTEUDO-REVERTIDO: e a branch TINHA tocado o invariante (a 3 é FALSA aqui)"
else falha "CONTEUDO-REVERTIDO: e a branch TINHA tocado o invariante" "NA_BRANCH == BASE: o controle não encena autoria"; fi
r=$(rodar "$cr" freeze-invariants.sh)
assert_exit "$(exit_de "$r")" 1 "CONTEUDO-REVERTIDO: reverter para a versão da main DENTRO do merge SEGUE acusado"
r=$(commitar_pelo_dispatcher "$cr" "merge revertendo o próprio fortalecimento")
assert_exit "$(exit_de "$r")" 1 "CONTEUDO-REVERTIDO: e pelo caminho de produção também RECUSA"
if tem_marcador "$cr" "$INV" BRANCH; then ok "CONTEUDO-REVERTIDO: e o MARCADOR-BRANCH segue no HEAD — nada foi perdido"
else falha "CONTEUDO-REVERTIDO: e o MARCADOR-BRANCH segue no HEAD" "o fortalecimento da branch se perdeu"; fi

# CASO A · edição genuína, fora de merge
a="$TMP/a"; preparar "$a" "$principal" "$BASE_DA_BRANCH"
printf 'it("MARCADOR-REESCRITO-PELA-SESSAO", () => {});\n' > "$a/$INV"; git -C "$a" add "$INV"
r=$(rodar "$a" freeze-invariants.sh)
assert_exit "$(exit_de "$r")" 1 "A: edição genuína fora de merge SEGUE bloqueada"

# CASO VÁLVULA · o mesmo estado A, com a env declarada
saida=$( cd "$a" && DESKCOMM_GOV_INVARIANTS_EDIT=1 bash loop/hooks/freeze-invariants.sh 2>&1 ); rc=$?
assert_exit "$rc" 0 "VÁLVULA: DESKCOMM_GOV_INVARIANTS_EDIT=1 segue liberando o estado A"

# ── #1324 · o `M` diz O QUE mudou, não só que mudou ─────────────────────────────────
# O eixo acima (A, VÁLVULA) mede a PERMISSÃO. Este mede o OBJETO: um `M` cujo diff,
# ignorados os comentários, é VAZIO não altera o que o invariante vigia — renumerar a
# migration citada num comentário não é edição, e passar pela válvula uma coisa dessas é
# dívida (na terceira vez ninguém lê o que ela liberou). É o caso MEDIDO no commit
# af28623d7: `rls-isolation.test.ts` (2 linhas) e `vocabulario-banco-x-typescript.test.ts`
# (1 linha) mudaram SÓ em comentário.
#
# COMENTARIO-LINHA é o caso que fica VERMELHO na versão anterior do hook; os seguintes
# fixam os LIMITES — sem eles, "ignorar comentário" viraria um removedor ingênuo, e o
# ingênuo tem furo conhecido: `http://waha:3000` DENTRO de string (a armadilha da #1322).
inv1324() {
  cat <<'TS'
import { it, expect } from "vitest";
// a migration 0012_rls_isolation foi renumerada para 0020 no vocabulário do banco
const esperado = 2;
it("MARCADOR-BASE-A", () => { expect(esperado).toBe(2); });
TS
}
# mostra quantas e QUAIS linhas o diff bruto mexe, para a premissa de cada caso não ser
# uma afirmação de fé: 2 linhas citadas, ambas começando por comentário, é o que se espera.
linhas_do_diff() { diff <(git -C "$1" show "HEAD:$2") "$1/$2" | grep '^[<>]'; }

# CASO COMENTARIO-LINHA · só o comentário mudou (é o caso da issue, na forma mínima)
cl="$TMP/comentario-linha"; preparar "$cl" "$principal" "$BASE_DA_BRANCH"
inv1324 > "$cl/$INV"; commitar "$cl" "o invariante com o comentario antigo"
sed -i 's/renumerada para 0020/renumerada para 0024/' "$cl/$INV"; git -C "$cl" add "$INV"
if [ -z "$(git -C "$cl" diff --cached --name-only)" ]; then falha 'COMENTARIO-LINHA: a premissa — a mudança está ENCENADA no índice' 'nada encenado: o caso não mede o M'
else ok "COMENTARIO-LINHA: a premissa — a mudança está ENCENADA no índice (status M)"; fi
if [ "$(linhas_do_diff "$cl" "$INV" | grep -c '^[<>] *//')" = "2" ] && [ "$(linhas_do_diff "$cl" "$INV" | wc -l)" = "2" ]; then
  ok "COMENTARIO-LINHA: a premissa — as DUAS linhas que o diff bruto mexe são de COMENTÁRIO"
else falha "COMENTARIO-LINHA: as duas linhas do diff são de comentário" "diff: $(linhas_do_diff "$cl" "$INV")"; fi
r=$(rodar "$cl" freeze-invariants.sh)
assert_exit "$(exit_de "$r")" 0 "COMENTARIO-LINHA: mudar SÓ o comentário LIBERA sem DESKCOMM_GOV_INVARIANTS_EDIT"
saida=$( cd "$cl" && git commit --no-edit -m "renumera a migration citada em comentario" 2>&1 ); rc=$?
assert_exit "$rc" 0 'COMENTARIO-LINHA: e pelo caminho de produção (git commit, dispatcher) o commit PASSA'

# CASO COMENTARIO-BLOCO · o mesmo, num comentário de BLOCO e num `--` DENTRO de template
# (o comentário da linguagem hospedada, o SQL das migrations: é onde ele de fato aparece)
cb="$TMP/comentario-bloco"; preparar "$cb" "$principal" "$BASE_DA_BRANCH"
cat > "$cb/$INV" <<'TS'
import { it } from "vitest";
/* conferido contra vocabulario-banco-x-typescript em 18/09/2026 */
const sql = `-- 0012 rls isolation
select 1 as um;`;
it("MARCADOR-BASE-A", () => {});
TS
commitar "$cb" "o invariante com os comentarios antigos"
sed -i -e 's/em 18\/09\/2026/em 19\/09\/2026/' -e 's/^-- 0012 rls/-- 0024 rls/' "$cb/$INV"; git -C "$cb" add "$INV"
if [ -n "$(git -C "$cb" diff --cached --name-only)" ]; then ok "COMENTARIO-BLOCO: a premissa — a mudança está ENCENADA (bloco + comentário de SQL)"
else falha 'COMENTARIO-BLOCO: a premissa — a mudança está encenada' 'nada encenado: o sed não pegou'; fi
r=$(rodar "$cb" freeze-invariants.sh)
assert_exit "$(exit_de "$r")" 0 'COMENTARIO-BLOCO: bloco /* */ e -- dentro de template também liberam sem válvula'

# CASO ASSERCAO-REAL · o CONTROLE NEGATIVO: mudança de asserção de verdade segue bloqueada
# (é o que prova que a exceção nova não virou "M passa"). Uma troca de número no CORPO do
# teste é exatamente o que o invariante vigia.
ar="$TMP/assercao-real"; preparar "$ar" "$principal" "$BASE_DA_BRANCH"
inv1324 > "$ar/$INV"; commitar "$ar" "o invariante intacto"
sed -i 's/esperado = 2/esperado = 3/; s/toBe(2)/toBe(3)/' "$ar/$INV"; git -C "$ar" add "$INV"
if [ "$(linhas_do_diff "$ar" "$INV" | grep -c 'toBe(3)')" -ge 1 ] && [ "$(linhas_do_diff "$ar" "$INV" | grep -c '^[<>] *//')" = "0" ] && [ -n "$(git -C "$ar" diff --cached --name-only)" ]; then
  ok "ASSERCAO-REAL: a premissa — a mudança toca o CORPO do teste (não o comentário)"
else falha "ASSERCAO-REAL: a mudança toca o corpo do teste" "diff: $(linhas_do_diff "$ar" "$INV")"; fi
r=$(rodar "$ar" freeze-invariants.sh)
assert_exit "$(exit_de "$r")" 1 "ASSERCAO-REAL: trocar o número da asserção SEGUE BLOQUEADO"
assert_contains "$(saida_de "$r")" "$INV" "ASSERCAO-REAL: e a mensagem nomeia o invariante"

# CASO STRING · a armadilha da #1322, medida: o valor está DENTRO de string, com `http://`.
# Um removedor ingênuo (`s,//.*,,`) apaga a URL NOS DOIS lados, eles ficam IGUAIS e uma
# troca de endereço — que o invariante vigia — passaria em silêncio.
st="$TMP/string-armadilha"; preparar "$st" "$principal" "$BASE_DA_BRANCH"
cat > "$st/$INV" <<'TS'
import { it, expect } from "vitest";
const baseUrl = "http://waha:3000";
it("MARCADOR-BASE-A", () => { expect(baseUrl).toBe("http://waha:3000"); });
TS
commitar "$st" "o invariante com a URL antiga"
sed -i 's/waha:3000/waha:4000/g' "$st/$INV"; git -C "$st" add "$INV"
if [ "$(git -C "$st" show "HEAD:$INV" | sed 's,//.*,,' )" = "$(sed 's,//.*,,' "$st/$INV")" ]; then
  ok 'STRING: a premissa — um removedor ingênuo de // IGUALARIA os dois lados (o falso liberado existe)'
else falha "STRING: a premissa do removedor ingênuo" "os lados já diferiam sob o filtro ingênuo: o caso não mede a armadilha"; fi
r=$(rodar "$st" freeze-invariants.sh)
assert_exit "$(exit_de "$r")" 1 'STRING: trocar o endereço DENTRO da string SEGUE BLOQUEADO (o // não é comentário aqui)'
assert_contains "$(saida_de "$r")" "$INV" "STRING: e a mensagem nomeia o invariante"

# CASO CARONA · comentário E asserção no MESMO commit: o comentário não leva carona
cr2="$TMP/carona"; preparar "$cr2" "$principal" "$BASE_DA_BRANCH"
inv1324 > "$cr2/$INV"; commitar "$cr2" "o invariante intacto"
sed -i 's/renumerada para 0020/renumerada para 0024/; s/esperado = 2/esperado = 3/' "$cr2/$INV"; git -C "$cr2" add "$INV"
r=$(rodar "$cr2" freeze-invariants.sh)
assert_exit "$(exit_de "$r")" 1 "CARONA: renumerar o comentário NÃO libera a asserção que veio junto"
assert_contains "$(saida_de "$r")" "$INV" "CARONA: e a mensagem nomeia o invariante"

# CASO FLIP-FAILS · a exceção DECLARADA segue exigindo a válvula: o flip `it.fails(` → `it(`
# é mudança de CÓDIGO (o teste deixa de ser esperado-vermelho), não comentário.
ff="$TMP/flip-fails"; preparar "$ff" "$principal" "$BASE_DA_BRANCH"
cat > "$ff/$INV" <<'TS'
import { it } from "vitest";
// catraca da G1-03: flipa quando a fase G2+ corrige o gap
it.fails("MARCADOR-BASE-A", () => {});
TS
commitar "$ff" "o invariante com o test.fails"
sed -i 's/it\.fails(/it(/' "$ff/$INV"; git -C "$ff" add "$INV"
r=$(rodar "$ff" freeze-invariants.sh)
assert_exit "$(exit_de "$r")" 1 "FLIP-FAILS: o flip documentado SEGUE BLOQUEADO sem a válvula"
saida=$( cd "$ff" && DESKCOMM_GOV_INVARIANTS_EDIT=1 bash loop/hooks/freeze-invariants.sh 2>&1 ); rc=$?
assert_exit "$rc" 0 "FLIP-FAILS: e com DESKCOMM_GOV_INVARIANTS_EDIT=1 segue liberado (a exceção declarada não se perdeu)"

# CASO COMENTARIO-MODO · o limite do LIMITE: se o MODO mudou junto, não é "só comentário".
# Os blobs ficam IDÊNTICOS num `chmod +x` (é a cegueira que a CONDIÇÃO 5 tapa no eixo do
# merge — e que reabriria aqui por outro caminho).
cm="$TMP/comentario-modo"; preparar "$cm" "$principal" "$BASE_DA_BRANCH"
inv1324 > "$cm/$INV"; commitar "$cm" "o invariante com o comentario antigo"
sed -i 's/renumerada para 0020/renumerada para 0024/' "$cm/$INV"
chmod +x "$cm/$INV"; git -C "$cm" add "$INV"
if git -C "$cm" ls-files --stage "$INV" | grep -q '^100755' \
   && [ "$(git -C "$cm" ls-tree HEAD -- "$INV" | awk '{print $1}')" = "100644" ] \
   && [ "$(linhas_do_diff "$cm" "$INV" | grep -c '^[<>] *//')" = "2" ]; then
  ok "COMENTARIO-MODO: as premissas — o modo virou 100755 e as 2 linhas que mudaram são de COMENTÁRIO"
else falha "COMENTARIO-MODO: as premissas (modo mudou, mudança de conteúdo só em comentário)" "$(git -C "$cm" ls-files --stage "$INV")"; fi
r=$(rodar "$cm" freeze-invariants.sh)
assert_exit "$(exit_de "$r")" 1 "COMENTARIO-MODO: comentário + chmod +x SEGUE BLOQUEADO (só comentário não é licença)"

# CASO D · a branch DELETA um invariante que a main tem
d="$TMP/d"; preparar "$d" "$principal" "$BASE_DA_BRANCH"
git -C "$d" rm -q "$INV"
r=$(rodar "$d" freeze-invariants.sh)
assert_exit "$(exit_de "$r")" 1 "D: deletar invariante que a main tem SEGUE bloqueado"

# CASO D2 · a branch deleta um invariante que ELA MESMA criou (a main não o tem).
# Este caso existe porque a sabotagem o exigiu: removida a condição `[ -n "$encenado" ]`
# do hook, o D acima continua vermelho (o blob da main é não-vazio, os lados diferem) e
# NADA acusa a perda. Aqui os dois lados são vazios, comparariam IGUAIS, e o caminho
# sairia da lista em silêncio — é o único caso que essa condição sustenta.
d2="$TMP/d2"; preparar "$d2" "$principal" "$BASE_DA_BRANCH"
inv "" "$MARCA_BRANCH" "" > "$d2/tests/invariants/so-da-branch.test.ts"
commitar "$d2" "a branch cria um invariante proprio"
if [ -z "$(git -C "$d2" rev-parse -q --verify 'origin/main:tests/invariants/so-da-branch.test.ts')" ]; then ok "D2: o invariante NÃO está na main (a premissa do caso)"
else falha "D2: o invariante NÃO está na main" "a main o tem: o caso não mede o que devia"; fi
git -C "$d2" rm -q tests/invariants/so-da-branch.test.ts
r=$(rodar "$d2" freeze-invariants.sh)
assert_exit "$(exit_de "$r")" 1 "D2: deletar invariante que a PRÓPRIA branch criou SEGUE bloqueado"

# CASO D2-MERGE · o MESMO delete, agora DENTRO do merge — e é ele, não o D2 acima, que
# sustenta a CONDIÇÃO 2 (`MERGE_HEAD` difere da BASE). Ausente-nos-dois satisfaz a condição
# 1, então sem a condição 2 o caminho sairia da lista e a perda passaria em silêncio. O D2
# fora de merge NÃO cobre isso: lá não há MERGE_HEAD e nada é excluído de qualquer jeito —
# sabotar a condição 2 o deixa verde. Medido: é o único caso que fica vermelho.
d2m="$TMP/d2m"; preparar "$d2m" "$principal" "$BASE_DA_BRANCH"
inv "" "$MARCA_BRANCH" "" > "$d2m/tests/invariants/so-da-branch.test.ts"
printf 'ponta da BRANCH\n' > "$d2m/README.md"
commitar "$d2m" "a branch cria invariante proprio e mexe no README"
git -C "$d2m" merge --no-edit origin/main >/dev/null 2>&1 || true
if [ -n "$(git -C "$d2m" rev-parse -q --verify MERGE_HEAD)" ]; then ok "D2-MERGE: o merge conflitou de verdade (MERGE_HEAD presente)"
else falha "D2-MERGE: o merge conflitou de verdade" "sem MERGE_HEAD: não chamaria hook"; fi
if [ -z "$(git -C "$d2m" rev-parse -q --verify "MERGE_HEAD:tests/invariants/so-da-branch.test.ts")" ] \
   && [ -z "$(git -C "$d2m" rev-parse -q --verify "$(git -C "$d2m" merge-base HEAD MERGE_HEAD):tests/invariants/so-da-branch.test.ts")" ]; then
  ok "D2-MERGE: o invariante não está em MERGE_HEAD NEM na BASE (a premissa: o outro lado não mexeu nele)"
else falha "D2-MERGE: o invariante não está em MERGE_HEAD nem na BASE" "está em um dos dois: o caso não mede a condição 2"; fi
printf 'resolvido\n' > "$d2m/README.md"; git -C "$d2m" add README.md
git -C "$d2m" rm -q tests/invariants/so-da-branch.test.ts
r=$(commitar_pelo_dispatcher "$d2m" "merge da main, apagando o invariante proprio")
assert_exit "$(exit_de "$r")" 1 "D2-MERGE: apagar DENTRO do merge o invariante que a branch criou é ACUSADO"
assert_contains "$(saida_de "$r")" "tests/invariants/so-da-branch.test.ts" "D2-MERGE: e a mensagem nomeia o invariante perdido (não passou/reprovou por outro motivo)"

# CASO ADD · invariante NOVO é permitido (regra declarada no cabeçalho do hook)
add="$TMP/add"; preparar "$add" "$principal" "$BASE_DA_BRANCH"
inv > "$add/tests/invariants/novinho.test.ts"
git -C "$add" add tests/invariants/novinho.test.ts
r=$(rodar "$add" freeze-invariants.sh)
assert_exit "$(exit_de "$r")" 0 "ADD: acrescentar invariante novo segue liberado"

# CASO R1 · a sessão FORTALECE o invariante e depois o REVERTE para a versão da main, em
# commit NORMAL. Identidade de CONTEÚDO não distingue isso de "a main chegando": nas duas
# formas `:$p` == `origin/main:$p`. Este caso EXPIRA o antigo CASO CO, que encenava o mesmo
# estado (`git checkout origin/main -- <inv>` fora de merge) esperando exit 0 — a
# expectativa era o defeito, não a medida.
#
# Medido pelo caminho de produção em 18/09/2026, no MESMO estado, com os dois hooks:
#   eixo de CONTEÚDO (6ef3cf1fa) → git commit exit 0, e `git show HEAD:<inv>` volta com
#                                  UMA asserção: a que a branch acrescentou foi apagada
#   eixo de PROCEDÊNCIA          → git commit exit 1, e o HEAD segue com as DUAS
# É por isso que o caso assere a CONSEQUÊNCIA (o conteúdo do HEAD) e não só o exit.
r1="$TMP/r1"; preparar "$r1" "$principal" "$BASE_DA_BRANCH"
inv "" "$MARCA_BRANCH" "" > "$r1/$INV"
git -C "$r1" add "$INV"
saida=$( cd "$r1" && DESKCOMM_GOV_INVARIANTS_EDIT=1 git commit --no-edit -m "fortalece o invariante (ato legitimo)" 2>&1 ); rc=$?
assert_exit "$rc" 0 "R1: fortalecer o invariante COM a válvula passa — é o ato que monta o estado"
# A sonda da consequência é pelo MARCADOR, não pela CONTAGEM — e isto foi medido, não
# escolhido: com `grep -c 'test('` o caso passava sob sabotagem, porque a versão da main
# TAMBÉM tem duas asserções. Contar prova que nada sumiu do total; só o marcador prova que
# não sumiu a asserção DESTA branch.
if tem_marcador "$r1" "$INV" BRANCH; then ok "R1: o MARCADOR-BRANCH está no HEAD antes do descarte (a premissa da consequência)"
else falha "R1: o MARCADOR-BRANCH está no HEAD antes do descarte" "não está: a sonda da consequência mediria nada"; fi
git -C "$r1" checkout origin/main -- "$INV"; git -C "$r1" add "$INV"
if [ "$(git -C "$r1" rev-parse ":$INV")" = "$(git -C "$r1" rev-parse "origin/main:$INV")" ]; then ok "R1: o encenado é IDÊNTICO ao da main (a premissa — é o que enganava o eixo de conteúdo)"
else falha "R1: o encenado é IDÊNTICO ao da main" "os blobs diferem: o caso não mede o que devia"; fi
if [ -z "$(git -C "$r1" rev-parse -q --verify MERGE_HEAD)" ]; then ok "R1: e não há merge em curso (MERGE_HEAD ausente) — a procedência que decide"
else falha "R1: e não há merge em curso" "MERGE_HEAD existe"; fi
r=$(commitar_pelo_dispatcher "$r1" "reverte o invariante para a versao da main")
assert_exit "$(exit_de "$r")" 1 "R1: reverter para a versão da main fora de merge é ACUSADO (pelo dispatcher)"
if tem_marcador "$r1" "$INV" BRANCH; then ok "R1: e o MARCADOR-BRANCH SOBREVIVEU no HEAD — a consequência, não só o exit"
else falha "R1: o MARCADOR-BRANCH sobreviveu no HEAD" "foi apagado: o commit passou"; fi

# CASO R1-LIMPO · a mesma perda, por uma rota que não pede válvula em PASSO NENHUM: mesclar
# LIMPO a branch de um colega que fortaleceu o invariante (merge limpo não chama hook) e
# reverter no commit seguinte. É o que torna o R1 rotina e não curiosidade.
r1l="$TMP/r1l"; preparar "$r1l" "$principal" "$BASE_DA_BRANCH"
git -C "$r1l" merge --no-edit origin/colega >/dev/null 2>&1; rc=$?
assert_exit "$rc" 0 "R1-LIMPO: o merge da branch do colega entra LIMPO — e nem passa por pre-commit"
if tem_marcador "$r1l" "$INV" COLEGA; then ok "R1-LIMPO: o MARCADOR-COLEGA entrou no HEAD pelo merge limpo (a premissa)"
else falha "R1-LIMPO: o MARCADOR-COLEGA entrou no HEAD" "não entrou: o caso não mede o que devia"; fi
git -C "$r1l" checkout origin/main -- "$INV"; git -C "$r1l" add "$INV"
r=$(commitar_pelo_dispatcher "$r1l" "reverte o que o colega fortaleceu")
assert_exit "$(exit_de "$r")" 1 "R1-LIMPO: apagar o fortalecimento do colega é ACUSADO"
if tem_marcador "$r1l" "$INV" COLEGA; then ok "R1-LIMPO: e o MARCADOR-COLEGA SOBREVIVEU no HEAD"
else falha "R1-LIMPO: o MARCADOR-COLEGA sobreviveu no HEAD" "foi apagado: o commit passou"; fi

# ── os DOIS FUROS que a terceira rodada fechou, e a raiz comum ──────────────────────
#
# Raiz: nenhuma das duas versões anteriores lia `HEAD:<path>` nem perguntava de ONDE vem
# o outro lado. Medido em 18/09/2026 pelo caminho de produção, com MARCADOR único por
# lado (contagem NÃO serve: a versão da main tem o mesmo número de asserções):
#
#   FURO A · as condições `:p == MERGE_HEAD:p` e `MERGE_HEAD:p != base:p` são TAMBÉM
#            verdadeiras quando a branch tinha uma versão e a sessão a DESCARTA pegando a
#            do outro lado. Fecha com `HEAD:p == base:p` (casos FURO-A e FURO-A-MH).
#   FURO B · `MERGE_HEAD` é ref que a PRÓPRIA SESSÃO fabrica — `git stash` cria commit sem
#            passar pelo pre-commit. Fecha com `is-ancestor MERGE_HEAD origin/main`, que o
#            irmão `validate-features.sh` já carregava (casos FURO-B e COLEGA-DEL).
#
# A matriz das duas, por hook: main / 6ef3cf1fa / 5899e4ac2 / hoje
#   FURO A     1 / 0 / 0 / 1        FURO B     1 / 1 / 0 / 1   ← o B era REGRESSÃO
#
# CASO FURO-A · a sessão mescla LIMPO a branch do colega (o invariante fica com o
# MARCADOR-COLEGA no HEAD, e merge limpo não chama hook), depois mescla a main com
# CONFLITO. O 3-way do git resolve o invariante SOZINHO, com as DUAS asserções no índice.
# Aí a sessão roda o comando literal do R1, agora DENTRO do merge — e essa rota não pede
# válvula em passo nenhum. Medido: hook anterior → exit 0, MARCADOR-COLEGA APAGADO.
montar_furo_a() {   # $1 destino
  preparar "$1" "$principal" "$BASE_DA_BRANCH"
  git -C "$1" merge --no-edit origin/colega >/dev/null 2>&1 \
    || falha "FURO-A: o merge do colega tinha de entrar LIMPO" "conflitou: o estado nao e o do caso"
  printf 'ponta da BRANCH\n' > "$1/README.md"; commitar "$1" "a branch reescreve o README"
  git -C "$1" merge --no-edit origin/main >/dev/null 2>&1 || true
  printf 'resolvido\n' > "$1/README.md"; git -C "$1" add README.md
}
fa="$TMP/fa-furo"; montar_furo_a "$fa"
if [ -n "$(git -C "$fa" rev-parse -q --verify MERGE_HEAD)" ]; then ok "FURO-A: o merge da main conflitou de verdade (MERGE_HEAD presente)"
else falha "FURO-A: o merge da main conflitou de verdade" "sem MERGE_HEAD: não chamaria hook"; fi
idx=$(git -C "$fa" show ":$INV")
if grep -qF MARCADOR-COLEGA <<<"$idx" && grep -qF MARCADOR-MAIN <<<"$idx"; then
  ok "FURO-A: o 3-way pôs as DUAS asserções no índice (a premissa — é o que o descarte joga fora)"
else falha "FURO-A: o 3-way pôs as duas asserções no índice" "índice: $(head -c 300 <<<"$idx")"; fi
base_fa=$(git -C "$fa" merge-base HEAD MERGE_HEAD)
if [ "$(git -C "$fa" rev-parse "HEAD:$INV")" != "$(git -C "$fa" rev-parse "${base_fa}:$INV")" ]; then
  ok "FURO-A: e HEAD difere da BASE neste invariante — a referência que as duas versões anteriores não liam"
else falha "FURO-A: HEAD difere da BASE neste invariante" "são iguais: o caso não mede a condição 3"; fi
git -C "$fa" checkout origin/main -- "$INV"; git -C "$fa" add -- "$INV"
r=$(commitar_pelo_dispatcher "$fa" "merge da main, descartando a versao da branch")
assert_exit "$(exit_de "$r")" 1 "FURO-A: descartar DENTRO do merge a versão da branch é ACUSADO"
assert_contains "$(saida_de "$r")" "$INV" "FURO-A: e quem bloqueou foi o freeze (a mensagem nomeia o invariante)"
if tem_marcador "$fa" "$INV" COLEGA; then ok "FURO-A: e o MARCADOR-COLEGA SOBREVIVEU no HEAD — a consequência, não só o exit"
else falha "FURO-A: o MARCADOR-COLEGA sobreviveu no HEAD" "foi apagado: o commit passou"; fi

# CASO FURO-A-MH · o MESMO estado, pegando a versão de `MERGE_HEAD` em vez de a de
# `origin/main`. São blobs idênticos aqui, mas a rota é outra e um leitor tentaria as duas.
fam="$TMP/fa-mh"; montar_furo_a "$fam"
git -C "$fam" checkout MERGE_HEAD -- "$INV"; git -C "$fam" add -- "$INV"
r=$(commitar_pelo_dispatcher "$fam" "merge da main, pegando a versao de MERGE_HEAD")
assert_exit "$(exit_de "$r")" 1 "FURO-A-MH: checkout de MERGE_HEAD no mesmo estado é ACUSADO"
if tem_marcador "$fam" "$INV" COLEGA; then ok "FURO-A-MH: e o MARCADOR-COLEGA SOBREVIVEU no HEAD"
else falha "FURO-A-MH: o MARCADOR-COLEGA sobreviveu no HEAD" "foi apagado: o commit passou"; fi

# CASO FURO-B · `MERGE_HEAD` fabricado por `git stash`. O stash cria um commit SEM passar
# pelo pre-commit, e mesclá-lo com `--no-ff` dá um merge cujo "outro lado" é a própria
# sessão. Medido: 5899e4ac2 → exit 0 e MARCADOR-BRANCH apagado; main e 6ef3cf1fa → 1.
# É o caso que faz a condição 2 (`is-ancestor … origin/main`) existir.
fb2="$TMP/fb-stash"; preparar "$fb2" "$principal" "$BASE_DA_BRANCH"
inv "" "$MARCA_BRANCH" "" > "$fb2/$INV"; git -C "$fb2" add "$INV"
saida=$( cd "$fb2" && DESKCOMM_GOV_INVARIANTS_EDIT=1 git commit --no-edit -m "fortalece o invariante (ato legitimo)" 2>&1 ); rc=$?
assert_exit "$rc" 0 "FURO-B: fortalecer COM a válvula passa — é o ato que monta o estado"
inv > "$fb2/$INV"                       # enfraquece no working tree (tira o MARCADOR-BRANCH)
git -C "$fb2" stash push -q -m enfraquecimento
fabricado=$(git -C "$fb2" rev-parse 'stash@{0}')
if ! git -C "$fb2" show "$fabricado:$INV" | grep -qF MARCADOR-BRANCH; then ok "FURO-B: o commit que o stash fabricou tem a versão FRACA (a premissa)"
else falha "FURO-B: o commit do stash tem a versão fraca" "tem o marcador: o caso não mede o que devia"; fi
git -C "$fb2" merge --no-commit --no-ff "$fabricado" >/dev/null 2>&1 || true
if [ -n "$(git -C "$fb2" rev-parse -q --verify MERGE_HEAD)" ]; then ok "FURO-B: e há MERGE_HEAD — a ref que a sessão fabricou para si mesma"
else falha "FURO-B: há MERGE_HEAD" "sem MERGE_HEAD: o caso não mede o que devia"; fi
if ! git -C "$fb2" merge-base --is-ancestor "$fabricado" origin/main 2>/dev/null; then ok "FURO-B: e o commit fabricado NÃO é alcançável por origin/main (o eixo da condição 2)"
else falha "FURO-B: o commit fabricado não é alcançável por origin/main" "é alcançável: o caso não mede a condição 2"; fi
git -C "$fb2" add -A
r=$(commitar_pelo_dispatcher "$fb2" "merge do stash fabricado")
assert_exit "$(exit_de "$r")" 1 "FURO-B: MERGE_HEAD fabricado por stash NÃO compra exclusão — é ACUSADO"
assert_contains "$(saida_de "$r")" "$INV" "FURO-B: e quem bloqueou foi o freeze (a mensagem nomeia o invariante)"
if tem_marcador "$fb2" "$INV" BRANCH; then ok "FURO-B: e o MARCADOR-BRANCH SOBREVIVEU no HEAD"
else falha "FURO-B: o MARCADOR-BRANCH sobreviveu no HEAD" "foi apagado: o commit passou"; fi

# CASO COLEGA-DEL · a forma MUNDANA do FURO B, sem stash: merge CONFLITADO da branch de um
# COLEGA que apagou o invariante. O outro lado é real e alheio, mas não é trabalho ACEITO —
# ninguém revisou. Medido: 5899e4ac2 → exit 0 e o invariante APAGADO do HEAD.
cdel="$TMP/colega-del"; preparar "$cdel" "$principal" "$BASE_DA_BRANCH"
printf 'ponta da BRANCH\n' > "$cdel/README.md"; commitar "$cdel" "a branch reescreve o README"
git -C "$cdel" merge --no-edit origin/colega-del >/dev/null 2>&1 || true
if [ -n "$(git -C "$cdel" rev-parse -q --verify MERGE_HEAD)" ]; then ok "COLEGA-DEL: o merge do colega conflitou de verdade (MERGE_HEAD presente)"
else falha "COLEGA-DEL: o merge do colega conflitou de verdade" "sem MERGE_HEAD: não chamaria hook"; fi
if ! git -C "$cdel" merge-base --is-ancestor MERGE_HEAD origin/main 2>/dev/null; then ok "COLEGA-DEL: e a branch do colega NÃO é alcançável por origin/main (a premissa)"
else falha "COLEGA-DEL: a branch do colega não é alcançável por origin/main" "é: o caso não mede a condição 2"; fi
printf 'resolvido\n' > "$cdel/README.md"; git -C "$cdel" add README.md
r=$(commitar_pelo_dispatcher "$cdel" "merge da branch do colega que apagou o invariante")
assert_exit "$(exit_de "$r")" 1 "COLEGA-DEL: deleção vinda de branch NÃO aceita é ACUSADA"
assert_contains "$(saida_de "$r")" "$INV" "COLEGA-DEL: e quem bloqueou foi o freeze (a mensagem nomeia o invariante)"
if [ -n "$(git -C "$cdel" rev-parse -q --verify "HEAD:$INV")" ]; then ok "COLEGA-DEL: e o invariante segue no HEAD — a consequência, não só o exit"
else falha "COLEGA-DEL: o invariante segue no HEAD" "foi apagado: o commit passou"; fi

# CASO MODO · o único caso que sustenta a CONDIÇÃO 5 depois que a 3 entrou. Estas
# comparações são de BLOB, e o `rev-parse` é CEGO PARA MODO: num `chmod +x` os quatro OIDs
# são IDÊNTICOS, então as condições 3 e 4 valem e só a 5 recusa a exclusão. O
# `$principal_par` serve porque lá a main NÃO toca o invariante velho.
# (Medido: sabotar a condição 5 deixa ESTE caso vermelho e mais nenhum — o D2-MERGE, que a
# sustentava antes, passou a ser pego pela condição 3.)
mod="$TMP/modo"; preparar "$mod" "$principal_par" "$BASE_PAR"
printf 'ponta da BRANCH\n' > "$mod/README.md"; commitar "$mod" "a branch reescreve o README"
git -C "$mod" merge --no-edit origin/main >/dev/null 2>&1 || true
if [ "$(git -C "$mod" rev-parse "MERGE_HEAD:$VELHO")" = "$(git -C "$mod" rev-parse "HEAD:$VELHO")" ]; then ok "MODO: a main NÃO tocou o invariante velho (a premissa — é o que faz a condição 5 decidir)"
else falha "MODO: a main não tocou o invariante velho" "tocou: a condição 5 seria satisfeita e o caso não mediria nada"; fi
printf 'resolvido\n' > "$mod/README.md"; git -C "$mod" add README.md
chmod +x "$mod/$VELHO"; git -C "$mod" add "$VELHO"
if git -C "$mod" ls-files --stage "$VELHO" | grep -q '^100755'; then ok "MODO: o índice registrou o bit de execução (a premissa)"
else falha "MODO: o índice registrou o bit de execução" "$(git -C "$mod" ls-files --stage "$VELHO")"; fi
r=$(commitar_pelo_dispatcher "$mod" "merge da main, e a sessao troca o modo do invariante")
assert_exit "$(exit_de "$r")" 1 "MODO: trocar o MODO do invariante dentro do merge é ACUSADO (os blobs são iguais)"
assert_contains "$(saida_de "$r")" "$VELHO" "MODO: e quem bloqueou foi o freeze (a mensagem nomeia o invariante)"
if ! git -C "$mod" ls-tree HEAD "$VELHO" | grep -q '^100755'; then ok "MODO: e o modo no HEAD segue 100644 — a consequência"
else falha "MODO: o modo no HEAD segue 100644" "virou 100755: o commit passou"; fi

# CASO CITADO · furo ABERTO, medido nesta versão e nas duas anteriores. O `--name-status`
# CITA o caminho quando ele tem byte não-ASCII (com `core.quotepath`, que é o PADRÃO do
# git) ou caracteres como aspas/barra-invertida (sempre). O campo passa a COMEÇAR com `"`,
# a âncora `^tests/invariants/` não casa, e a linha NUNCA entra na lista: `git rm` desse
# invariante saía exit 0 e o arquivo DESAPARECIA do HEAD. Fora de merge nenhum — é a
# guarda mais crua que existe. Medido nas duas formas de citação e nos dois `quotepath`.
for forma in CITADO ACENTO; do
  for qp in true false; do
    alvo=$INV_CITADO; [ "$forma" = ACENTO ] && alvo=$INV_ACENTO
    cit="$TMP/cit-$forma-$qp"; preparar "$cit" "$principal" "$BASE_DA_BRANCH"
    git -C "$cit" config core.quotepath "$qp"
    git -C "$cit" rm -q -- "$alvo"
    if [ -n "$(git -C "$cit" diff --cached --name-status -- "$alvo")" ]; then ok "$forma/$qp: o invariante entrou no diff encenado (a premissa)"
    else falha "$forma/$qp: o invariante entrou no diff encenado" "diff vazio: o caso não mede nada"; fi
    r=$(commitar_pelo_dispatcher "$cit" "apaga o invariante de nome citado")
    assert_exit "$(exit_de "$r")" 1 "$forma/quotepath=$qp: apagar invariante de caminho CITADO é ACUSADO (era exit 0 e o arquivo sumia)"
    assert_contains "$(saida_de "$r")" "congelado" "$forma/$qp: e quem bloqueou foi o freeze (a mensagem é a dele)"
    if [ -n "$(git -C "$cit" rev-parse -q --verify "HEAD:$alvo")" ]; then ok "$forma/$qp: e o invariante segue no HEAD"
    else falha "$forma/$qp: o invariante segue no HEAD" "foi apagado: o commit passou"; fi
  done
done

# CASO ACENTO-LEGIT · o outro lado da mesma moeda, e é ele que sustenta o
# `-c core.quotepath=false`: só o `"?` do regex fecharia o furo acima, mas então um
# invariante ACENTUADO que a MAIN modificou passaria a ser FALSAMENTE acusado (o caminho
# citado não resolve em `git rev-parse`, os quatro OIDs vêm vazios e a guarda falha
# fechada). Medido: com o `-c` fora, este caso fica vermelho e o CITADO segue verde.
al="$TMP/acento-legit"; preparar "$al" "$principal" "$BASE_DA_BRANCH"
git -C "$al" config core.quotepath true
printf 'ponta da BRANCH\n' > "$al/README.md"; commitar "$al" "a branch reescreve o README"
git -C "$al" merge --no-edit origin/main >/dev/null 2>&1 || true
if [ -n "$(git -C "$al" rev-parse -q --verify MERGE_HEAD)" ]; then ok "ACENTO-LEGIT: o merge conflitou de verdade (MERGE_HEAD presente)"
else falha "ACENTO-LEGIT: o merge conflitou de verdade" "sem MERGE_HEAD: não chamaria hook"; fi
if git -C "$al" diff --cached --name-status | grep -q '"tests/invariants/inv-acentua'; then ok "ACENTO-LEGIT: e o git CITOU o caminho acentuado no name-status (a premissa)"
else falha "ACENTO-LEGIT: o git citou o caminho acentuado" "não citou: o caso não mede o que devia"; fi
printf 'resolvido\n' > "$al/README.md"; git -C "$al" add README.md
r=$(commitar_pelo_dispatcher "$al" "merge da main que modifica o invariante acentuado")
assert_exit "$(exit_de "$r")" 0 "ACENTO-LEGIT: invariante ACENTUADO que a main modificou NÃO é acusado"
if tem_marcador "$al" "$INV_ACENTO" MAIN; then ok "ACENTO-LEGIT: e a versão da main entrou no HEAD"
else falha "ACENTO-LEGIT: a versão da main entrou no HEAD" "não entrou: o commit foi recusado"; fi

# CASO SEM-REF · ⚠️ MUDANÇA DE COMPORTAMENTO DECLARADA contra a versão anterior deste
# arquivo, e ela é o PREÇO da condição 2. Antes, `origin/main` tinha deixado de ser
# necessária (MERGE_HEAD e a merge-base são locais), e o falso positivo do #1161 morria de
# graça em fork e clone raso — a expectativa daqui era 0. Agora, sem a ref, o
# `is-ancestor` falha, a exclusão não se aplica e o caso volta a ser ACUSADO: exatamente o
# que a `main` faz. É o lado seguro e é a escolha certa — quem não tem a ref não tem como
# provar que o outro lado é trabalho ACEITO, e tratar "não sei" como "pode" é o que abriu o
# FURO B. A saída, nesse ambiente, é a válvula declarada.
# Medido, mesmo estado: main 1 / 6ef3cf1fa 1 / 5899e4ac2 0 / hoje 1.
semref="$TMP/semref"; preparar "$semref" "$principal" "$BASE_DA_BRANCH"
git -C "$semref" merge --no-commit --no-ff origin/main >/dev/null 2>&1 || true
git -C "$semref" remote remove origin
# ⚠️ ISOLAMENTO, não conveniência: sem `origin/main` a condição (b) do IRMÃO
# `validate-features.sh` também falha, e ele é o PRIMEIRO do dispatcher — ele bloqueava
# antes, e sabotar a condição 2 do freeze deixava este caso VERDE. Tirar o plano da frente
# (índice = HEAD ⇒ o irmão sai 0 na linha de entrada) devolve a medição ao hook certo.
git -C "$semref" checkout HEAD -- "$FEAT"; git -C "$semref" add -- "$FEAT"
if [ -z "$(git -C "$semref" diff --cached --name-only -- "$FEAT")" ]; then ok "SEM-REF: o plano saiu do diff encenado (isolamento: quem decide é o freeze, não o irmão)"
else falha "SEM-REF: o plano saiu do diff encenado" "ainda está: o caso pode passar pelo motivo errado"; fi
if [ -z "$(git -C "$semref" rev-parse -q --verify origin/main)" ]; then ok "SEM-REF: origin/main realmente não resolve mais (a premissa do caso)"
else falha "SEM-REF: origin/main realmente não resolve mais" "a ref ainda resolve"; fi
if [ -n "$(git -C "$semref" rev-parse -q --verify MERGE_HEAD)" ]; then ok "SEM-REF: e MERGE_HEAD segue de pé — é ref local, não depende de remoto"
else falha "SEM-REF: MERGE_HEAD segue de pé" "MERGE_HEAD sumiu: o caso não mede o que devia"; fi
r=$(commitar_pelo_dispatcher "$semref" "merge da main num clone sem a ref do remoto")
assert_exit "$(exit_de "$r")" 1 "SEM-REF: sem a ref origin/main nada é excluído — falha FECHADA (mudança declarada)"
assert_contains "$(saida_de "$r")" "$INV" "SEM-REF: e quem bloqueou foi o FREEZE (a mensagem nomeia o invariante), não um hook irmão"
if ! tem_marcador "$semref" "$INV" MAIN; then ok "SEM-REF: e o merge NÃO foi concluído (a versão da main não entrou no HEAD)"
else falha "SEM-REF: o merge não foi concluído" "a versão da main entrou: o commit passou"; fi

# CASO FECHADO-SEM-BASE · merge de histórias SEM ancestral comum: `git merge-base` sai 1 e
# a saída é vazia. Sem BASE não há como saber se o outro lado MEXEU no caminho, e o hook
# roda sob `set -euo pipefail` — a decisão é falhar FECHADO (bloquear pede uma válvula
# declarada; liberar perde o eval em silêncio).
fsb="$TMP/fsb"; mkdir -p "$fsb/tests/invariants" "$TMP/desconhecido/tests/invariants"
git -C "$TMP/desconhecido" init -q -b main
printf 'test("versao do OUTRO lado", () => {});\n' > "$TMP/desconhecido/$INV"
commitar "$TMP/desconhecido" "historia sem parentesco"
git -C "$fsb" init -q -b trabalho
printf 'test("versao da BRANCH", () => {});\n' > "$fsb/$INV"
commitar "$fsb" "base da branch"
mkdir -p "$fsb/loop/hooks"; cp "$HOOKS_ORIGEM"/*.sh "$HOOKS_ORIGEM/pre-commit" "$fsb/loop/hooks/"
chmod +x "$fsb"/loop/hooks/*; git -C "$fsb" config core.hooksPath loop/hooks
git -C "$fsb" remote add outro "$TMP/desconhecido"; git -C "$fsb" fetch -q outro
git -C "$fsb" merge --no-edit --allow-unrelated-histories outro/main >/dev/null 2>&1 || true
git -C "$fsb" checkout --theirs -- "$INV" >/dev/null 2>&1 || true; git -C "$fsb" add "$INV"
if ! git -C "$fsb" merge-base HEAD MERGE_HEAD >/dev/null 2>&1; then ok "FECHADO-SEM-BASE: não há ancestral comum (merge-base sai 1) — a premissa do caso"
else falha "FECHADO-SEM-BASE: não há ancestral comum" "merge-base resolveu: o caso não mede o que devia"; fi
if [ "$(git -C "$fsb" rev-parse ":$INV")" = "$(git -C "$fsb" rev-parse "MERGE_HEAD:$INV")" ]; then ok "FECHADO-SEM-BASE: e o encenado É o do outro lado — só a BASE falta (o controle que fecha)"
else falha "FECHADO-SEM-BASE: o encenado é o do outro lado" "difere: o caso mediria a condição 1, não a 2"; fi
r=$(commitar_pelo_dispatcher "$fsb" "merge de historia sem parentesco")
assert_exit "$(exit_de "$r")" 1 "FECHADO-SEM-BASE: sem merge-base nada é excluído — falha FECHADA, não aberta"

# CASO R-VELHO · a linha `R`: a main ACRESCENTA um invariante parecido, a SESSÃO apaga o
# velho dentro do merge, e o git forma o par de rename sozinho (≥50% de similaridade).
# Julgando só o `$3` da linha, a DELEÇÃO do path velho saía em silêncio — medido pelo
# dispatcher: hook de conteúdo → exit 0 e o invariante velho APAGADO no commit.
rv="$TMP/rv"; preparar "$rv" "$principal_par" "$BASE_PAR"
printf 'ponta da BRANCH\n' > "$rv/README.md"; commitar "$rv" "a branch reescreve o README"
git -C "$rv" merge --no-edit origin/main >/dev/null 2>&1 || true
if [ -n "$(git -C "$rv" rev-parse -q --verify MERGE_HEAD)" ]; then ok "R-VELHO: o merge conflitou de verdade (MERGE_HEAD presente)"
else falha "R-VELHO: o merge conflitou de verdade" "sem MERGE_HEAD: não chamaria hook"; fi
printf 'resolvido\n' > "$rv/README.md"; git -C "$rv" add README.md
git -C "$rv" rm -q "$VELHO"
if git -C "$rv" diff --cached --name-status | grep -q "^R.*$VELHO"; then ok "R-VELHO: o git formou a linha R com o path velho (a premissa do caso)"
else falha "R-VELHO: o git formou a linha R" "name-status: $(git -C "$rv" diff --cached --name-status | tr '\n' ' ')"; fi
r=$(commitar_pelo_dispatcher "$rv" "merge, e a sessao apaga o invariante velho")
assert_exit "$(exit_de "$r")" 1 "R-VELHO: apagar o invariante velho numa linha R é ACUSADO"
if [ -n "$(git -C "$rv" rev-parse -q --verify "HEAD:$VELHO")" ]; then ok "R-VELHO: e o invariante velho segue no HEAD — a consequência, não só o exit"
else falha "R-VELHO: o invariante velho segue no HEAD" "foi apagado: o commit passou"; fi

# CASO REN-LEGIT · o MERGE renomeia o invariante, e a linha `R` INTEIRA veio do outro lado:
# o path velho está ausente nos dois (deleção que o merge trouxe, e a BASE o tinha) e o
# path novo é byte-a-byte o do merge (e a BASE não o tinha). Tem de PASSAR — senão o
# conserto trocaria um falso positivo por outro.
rl="$TMP/rl"; preparar "$rl" "$principal_ren" "$BASE_REN"
printf 'ponta da BRANCH\n' > "$rl/README.md"; commitar "$rl" "a branch reescreve o README"
git -C "$rl" merge --no-edit origin/main >/dev/null 2>&1 || true
if [ -n "$(git -C "$rl" rev-parse -q --verify MERGE_HEAD)" ]; then ok "REN-LEGIT: o merge conflitou de verdade (MERGE_HEAD presente)"
else falha "REN-LEGIT: o merge conflitou de verdade" "sem MERGE_HEAD: não chamaria hook"; fi
printf 'resolvido\n' > "$rl/README.md"; git -C "$rl" add README.md
if git -C "$rl" diff --cached --name-status | grep -q "^R.*$VELHO"; then ok "REN-LEGIT: o índice do merge traz a linha R (a premissa do caso)"
else falha "REN-LEGIT: o índice do merge traz a linha R" "name-status: $(git -C "$rl" diff --cached --name-status | tr '\n' ' ')"; fi
r=$(commitar_pelo_dispatcher "$rl" "merge que renomeia o invariante")
assert_exit "$(exit_de "$r")" 0 "REN-LEGIT: rename que o MERGE trouxe não é acusado"

# CASO E2E · a operação de verdade: `git commit` de um merge CONFLITADO, pelo dispatcher
e2e="$TMP/e2e"; preparar "$e2e" "$principal" "$BASE_DA_BRANCH"
git -C "$e2e" config core.hooksPath loop/hooks
printf 'ponta da BRANCH\n' > "$e2e/README.md"; commitar "$e2e" "a branch reescreve o README"
git -C "$e2e" merge --no-edit origin/main >/dev/null 2>&1 || true
if [ -n "$(git -C "$e2e" rev-parse -q --verify MERGE_HEAD)" ]; then ok "E2E: o merge conflitou de verdade (MERGE_HEAD presente)"
else falha "E2E: o merge conflitou de verdade" "sem MERGE_HEAD: o merge entrou limpo e não chamaria hook"; fi
printf 'resolvido\n' > "$e2e/README.md"; git -C "$e2e" add README.md
saida=$( cd "$e2e" && git commit --no-edit 2>&1 ); rc=$?
assert_exit "$rc" 0 "E2E: o commit do merge conflitado PASSA pelos três guards"
if [ -z "$(git -C "$e2e" rev-parse -q --verify MERGE_HEAD)" ]; then ok "E2E: e o merge foi concluído de fato (MERGE_HEAD já não existe)"
else falha "E2E: e o merge foi concluído de fato" "MERGE_HEAD ainda resolve: o commit foi recusado"; fi

printf '\nvalidate-features.sh — o mesmo falso positivo, e a sonda que falhava aberta\n'

# CASO F-B · a main edita o plano; o merge traz o blob dela
fb="$TMP/fb"; preparar "$fb" "$principal" "$BASE_DA_BRANCH"
git -C "$fb" merge --no-commit --no-ff origin/main >/dev/null 2>&1 || true
mh=$(git -C "$fb" rev-parse MERGE_HEAD)
if [ "$(git -C "$fb" rev-parse ":$FEAT")" = "$(git -C "$fb" rev-parse "$mh:$FEAT")" ]; then ok "F-B: o blob encenado é IDÊNTICO ao do outro lado do merge (a premissa)"
else falha "F-B: o blob encenado é IDÊNTICO ao do outro lado" "difere"; fi
r=$(rodar "$fb" validate-features.sh)
assert_exit "$(exit_de "$r")" 0 "F-B: plano que a main trouxe NÃO é acusado"

# CASO F-B+ · o MESMO merge, mas eu reescrevo um title por cima (a guarda real)
fbp="$TMP/fbp"; preparar "$fbp" "$principal" "$BASE_DA_BRANCH"
git -C "$fbp" merge --no-commit --no-ff origin/main >/dev/null 2>&1 || true
python3 - "$fbp/$FEAT" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["features"][0]["title"] = "REESCRITO PELA SESSAO"
json.dump(d, open(p, "w"), indent=2)
PY
git -C "$fbp" add "$FEAT"
r=$(rodar "$fbp" validate-features.sh)
assert_exit "$(exit_de "$r")" 1 "F-B+: reescrever title DENTRO do merge SEGUE bloqueado"

# CASO F-A · reescrever title fora de merge
fa="$TMP/fa"; preparar "$fa" "$principal" "$BASE_DA_BRANCH"
python3 - "$fa/$FEAT" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["features"][0]["title"] = "REESCRITO PELA SESSAO"
json.dump(d, open(p, "w"), indent=2)
PY
git -C "$fa" add "$FEAT"
r=$(rodar "$fa" validate-features.sh)
assert_exit "$(exit_de "$r")" 1 "F-A: reescrever title fora de merge SEGUE bloqueado"

# CASO F-OK · mexer só em passes/verification segue liberado (não é bloqueio cego)
fok="$TMP/fok"; preparar "$fok" "$principal" "$BASE_DA_BRANCH"
python3 - "$fok/$FEAT" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
d["features"][0]["passes"] = True; d["features"][0]["verification"] = {"quando": "agora"}
json.dump(d, open(p, "w"), indent=2)
PY
git -C "$fok" add "$FEAT"
r=$(rodar "$fok" validate-features.sh)
assert_exit "$(exit_de "$r")" 0 "F-OK: mudar só passes/verification segue liberado"

# CASO F-CRIA · a main CRIA plan/features.json depois do ponto da branch
fc="$TMP/fc"; preparar "$fc" "$principal2" "$BASE_SEM_PLANO"
git -C "$fc" merge --no-commit --no-ff origin/main >/dev/null 2>&1 || true
r=$(rodar "$fc" validate-features.sh)
assert_exit "$(exit_de "$r")" 0 "F-CRIA: plano CRIADO pela main e trazido por merge não é acusado"

# CASO F-CRIA-PROPRIA · a branch cria o plano do próprio bolso (segue sendo ato humano)
fcp="$TMP/fcp"; preparar "$fcp" "$principal2" "$BASE_SEM_PLANO"
mkdir -p "$fcp/plan"
printf '{\n  "epico": "G6",\n  "features": [ { "id": "X", "title": "inventado pela sessao", "passes": false } ]\n}\n' > "$fcp/$FEAT"
git -C "$fcp" add "$FEAT"
r=$(rodar "$fcp" validate-features.sh)
assert_exit "$(exit_de "$r")" 1 "F-CRIA-PRÓPRIA: criar o plano na branch SEGUE exigindo sessão humana"

# CASO F-BIG+ · merge GRANDE: sem pathspec a sonda de entrada morre de SIGPIPE e o hook
# sai 0 sem validar nada. Com ela, a edição própria é pega no MESMO estado.
#
# O NOME do diretório de enchimento é parte do caso, não estética. `git diff --cached`
# imprime em ordem alfabética, e o SIGPIPE só acontece se o `grep -q` casar CEDO e
# fechar o pipe com o git ainda escrevendo. Medido: com o enchimento em `enchimento/`
# (antes de `plan/`) o match cai na posição 6002 de 6003, o grep lê o stream inteiro,
# não há SIGPIPE, e o caso passava PELO MOTIVO ERRADO — sabotar o pathspec não o
# deixava vermelho. Com `zzz-enchimento/` (depois de `plan/`) o match é o nome 1 e o
# `exit 141` aparece. É por isso que a premissa abaixo mede a POSIÇÃO, não só o volume.
fbig="$TMP/fbig"; preparar "$fbig" "$principal" "$BASE_DA_BRANCH"
git -C "$fbig" merge --no-commit --no-ff origin/main >/dev/null 2>&1 || true
mkdir -p "$fbig/zzz-enchimento"
python3 - "$fbig/zzz-enchimento" <<'PY'
import sys, pathlib
d = pathlib.Path(sys.argv[1])
for i in range(6000):
    (d / f"arquivo-de-enchimento-com-nome-longo-para-encher-o-pipe-{i:05d}.txt").write_text("x\n")
PY
python3 - "$fbig/$FEAT" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["features"][0]["title"] = "REESCRITO PELA SESSAO"
json.dump(d, open(p, "w"), indent=2)
PY
git -C "$fbig" add -A
encenados=$(git -C "$fbig" diff --cached --name-only | wc -l | tr -d ' ')
posicao=$(git -C "$fbig" diff --cached --name-only | grep -n -x "$FEAT" | cut -d: -f1)
if [ "$encenados" -gt 3000 ] && [ "${posicao:-0}" -lt 10 ]; then ok "F-BIG+: $encenados encenados e o match na posição $posicao (as DUAS premissas: volume e match cedo)"
else falha "F-BIG+: volume >3000 e match na posição <10" "encenados=$encenados posicao=${posicao:-nenhuma} — o caso não estressa o pipe"; fi
r=$(rodar "$fbig" validate-features.sh)
assert_exit "$(exit_de "$r")" 1 "F-BIG+: em merge grande o hook AINDA valida — a sonda não falha aberta"

printf '\nhooks-nao-acusam-a-main: %s casos, %s falha(s)\n' "$casos" "$falhas"
[ "$falhas" -eq 0 ] || exit 1
