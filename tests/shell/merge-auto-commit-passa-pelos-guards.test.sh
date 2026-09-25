#!/usr/bin/env bash
# merge-auto-commit-passa-pelos-guards — prova do #1225.
#
# O QUE ESTE ARQUIVO MEDE
# `loop/hooks/pre-commit` só roda quando existe um `git commit`. Um merge que resolve
# SOZINHO não passa por `git commit`: o git cria o commit de merge e pronto. Sem a rota
# `pre-merge-commit` o dispatcher dos guards (validate-features, check-migration-triple,
# freeze-invariants) nunca era consultado — e um `git merge -X theirs origin/main` fazia
# o fortalecimento que a branch tinha feito no invariante desaparecer com exit 0, sem
# válvula e sem aviso.
#
# Aqui isso é medido pelo CAMINHO DE PRODUÇÃO (`git merge` de verdade, com o hook que o git
# consulta e `core.hooksPath` armado), nunca chamando um `.sh` na mão: chamar o arquivo mede
# a FUNÇÃO; o que decide é o SISTEMA.
#
# CASOS
#   M1  o merge que ENFRAQUECE aborta (é o defeito do #1225) — e, sem o hook, a mesma
#       montagem perde em SILÊNCIO (a metade que dá sentido à asserção).
#   M2  CONTROLE NEGATIVO: um merge que não encosta em arquivo congelado segue passando.
#       É o que separa "barramento" de "bloqueio de todo merge".
#   M3  O LADO QUE A ROTA NÃO DECIDE: no `pre-merge-commit` o git NÃO escreve MERGE_HEAD
#       (sondado por hook-sonda, caso M3-PREMISSA), então a procedência que o #1161 usa para
#       inocentar o que VEIO DA MAIN não é decidível aqui — a rota falha FECHADO e a saída é
#       a válvula declarada, medida nas duas metades (sem válvula barra, com válvula passa).
#
# Controle de vivacidade: M1 (o aborto) e M3-sem-válvula ficam VERMELHOS com o
# `loop/hooks/pre-merge-commit` removido — é o que prova que este arquivo mede o hook e não
# a si mesmo. M2 e M3-com-válvula continuam verdes: medem o outro lado (que o hook não barra
# o que não deve e que há saída declarada).
#
# ⚠️ Nenhum número de casos escrito aqui, de propósito: contagem em prosa envelhece a cada
# caso novo e ninguém a revisa. Quem precisa do número RODA o arquivo — o rodapé o imprime.
#
# Nada aqui escreve no seu clone: todo repositório nasce em "$TMP" (mktemp) e some no trap.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOKS_ORIGEM="$RAIZ/loop/hooks"

falhas=0; casos=0
ok()   { casos=$((casos+1)); printf '  ✓ %s\n' "$1"; }
falha(){ casos=$((casos+1)); falhas=$((falhas+1)); printf '  ✗ %s\n     %s\n' "$1" "${2:-}"; }
assert_exit() { if [ "$1" = "$2" ]; then ok "$3"; else falha "$3" "exit esperado $2, veio $1"; fi; }
# a asserção do DEFEITO: a rota tem de ser RECUSADA. Vem com a razão junto justamente para
# não virar um "!= 0" silencioso no dia em que a recusa passar a vir de outro lugar.
assert_recusa() { if [ "$1" != "0" ]; then ok "$2"; else falha "$2" "exit veio 0: a rota auto-commita e ninguém a barrou"; fi; }
assert_contains() { if grep -qF -- "$2" <<<"$1"; then ok "$3"; else falha "$3" "esperava conter '$2'; saída: $(head -c 400 <<<"$1")"; fi; }
assert_igual() { if [ "$1" = "$2" ]; then ok "$3"; else falha "$3" "$1 != $2"; fi; }
pais_de()  { git -C "$1" show -s --format=%P HEAD | wc -w | tr -d ' '; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# Isolamento de config: arquivo VAZIO de verdade, e não /dev/null — há runner em que o git
# tenta LER /dev/null como arquivo de config e morre com "bad config line 1 in file /dev/null"
# (medido: o mesmo arquivo passa no meu shell e falhava no runner do job). Arquivo vazio é
# determinístico em qualquer ambiente e é o que o CI também aceita.
CONF_VAZIO="$TMP/gitconfig-vazio"; : > "$CONF_VAZIO"
export GIT_CONFIG_GLOBAL="$CONF_VAZIO" GIT_CONFIG_SYSTEM="$CONF_VAZIO"
export HOME="$TMP/home"; mkdir -p "$HOME"
# ── isolamento do git: nada aqui escreve fora de "$TMP" ─────────────────────────────
# Mesmo tripé do irmão hooks-nao-acusam-a-main.test.sh (o .git/config do checkout de quem
# roda a suíte já foi assinado por um `git -C` que vazou): ambiente local do git zerado,
# descoberta de repositório presa em "$TMP", identidade por AMBIENTE (nenhum caso mede autor).
unset $(git rev-parse --local-env-vars)
export GIT_CEILING_DIRECTORIES="$TMP"
export GIT_AUTHOR_NAME="Teste" GIT_AUTHOR_EMAIL="teste@exemplo.invalid"
export GIT_COMMITTER_NAME="Teste" GIT_COMMITTER_EMAIL="teste@exemplo.invalid"
unset DESKCOMM_GOV_INVARIANTS_EDIT DESKCOMM_GOV_PLAN_EDIT DESKCOMM_GOV_MIGRATION_EDIT || true

INV=tests/invariants/exemplo-congelado.test.ts
commitar() { git -C "$1" add -A >/dev/null && git -C "$1" commit -q --no-verify -m "$2"; }

# O invariante tem TRÊS slots separados por linhas de contexto — premissa de MEDIÇÃO, não
# estética: é o que deixa o 3-way do git resolver o arquivo SOZINHO quando os dois lados mexem
# em slots DIFERENTES, e CONFLITAR quando mexem no MESMO slot (M1, onde o `-X theirs` descarta
# o lado da branch em silêncio). Os três parâmetros são OBRIGATÓRIOS (comparência de default
# por parâmetro vazio já confundiu esta medição uma vez: a main "mexeu" sem mexer).
SLOT_BRANCH='  // slot-branch'
SLOT_MAIN='  // slot-main'
SLOT_LIVRE='  // slot-livre'
inv() { printf 'import { it } from "vitest";\nit("MARCADOR-BASE-A", () => {});\n%s\nit("MARCADOR-BASE-B", () => {});\n%s\nit("MARCADOR-BASE-C", () => {});\n%s\n' "$1" "$2" "$3"; }
MARCA_BRANCH='it("MARCADOR-BRANCH", () => {});'
MARCA_MAIN='it("MARCADOR-MAIN", () => {});'
# sonda de CONSEQUÊNCIA: o marcador DAQUELE lado no HEAD. Nunca contagem — a versão da main
# também tem asserções, então contar prova que nada sumiu do total, não que não sumiu a DELE.
tem_marcador() { git -C "$1" show "HEAD:$2" 2>/dev/null | grep -qF "MARCADOR-$3"; }

# ── as DUAS "mains" do cenário ──────────────────────────────────────────────────────
# principal: a main REESCREVE o slot do invariante que a branch vai editar (M1) e que a
# branch nem toca (M3). principal_limpo: a main só mexe em README/src — é o que permite ao
# CONTROLE NEGATIVO (M2) medir um merge que não encosta em arquivo congelado nenhum.
principal="$TMP/principal"; mkdir -p "$principal/tests/invariants" "$principal/src"
git -C "$principal" init -q -b main
inv "$SLOT_BRANCH" "$SLOT_MAIN" "$SLOT_LIVRE" > "$principal/$INV"
printf '# leia\n' > "$principal/README.md"
commitar "$principal" "base da main"
BASE=$(git -C "$principal" rev-parse HEAD)
inv "$MARCA_MAIN" "$SLOT_MAIN" "$SLOT_LIVRE" > "$principal/$INV"
printf '# leia\nlinha que a MAIN acrescentou\n' > "$principal/README.md"
commitar "$principal" "a main reescreve o slot-branch do invariante"
PONTA_MAIN=$(git -C "$principal" rev-parse HEAD)

principal_limpo="$TMP/principal_limpo"; mkdir -p "$principal_limpo/tests/invariants" "$principal_limpo/src"
git -C "$principal_limpo" init -q -b main
inv "$SLOT_BRANCH" "$SLOT_MAIN" "$SLOT_LIVRE" > "$principal_limpo/$INV"
printf '# leia\n' > "$principal_limpo/README.md"
commitar "$principal_limpo" "base da main"
BASE_LIMPO=$(git -C "$principal_limpo" rev-parse HEAD)
printf '# leia\nlinha que a MAIN acrescentou\n' > "$principal_limpo/README.md"
printf 'export const daMain = 1;\n' > "$principal_limpo/src/da-main.ts"
commitar "$principal_limpo" "a main mexe no README e em src (nada congelado)"
PONTA_LIMPA=$(git -C "$principal_limpo" rev-parse HEAD)

# ── armar um clone com os hooks de PRODUÇÃO do diretório de origem ───────────────────
# $1 destino, $2 repo principal, $3 commit-base. Copia TUDO que existe em loop/hooks (não
# uma lista fixa): um arquivo novo que entre na rota passa a ser exercido aqui sozinho.
armar() {
  rm -rf "$1"; git clone -q "$2" "$1" >/dev/null 2>&1
  mkdir -p "$1/loop/hooks"
  for f in "$HOOKS_ORIGEM"/*; do cp "$f" "$1/loop/hooks/"; done
  chmod +x "$1"/loop/hooks/* 2>/dev/null
  git -C "$1" config core.hooksPath loop/hooks
  git -C "$1" checkout -q -B trabalho "$3"
}
# o CAMINHO DE PRODUÇÃO do merge: `git merge` de verdade, sem pipe (exit code depois de pipe
# é o do último comando do pipe, e um `| tail` imprime sucesso sobre uma recusa) e sem
# --no-verify. $1 dir, $2 env da válvula ("" = nenhuma), $3.. = argumentos do merge.
merge_auto() {
  local d=$1 val=${2:-} saida rc; shift 2
  saida=$( cd "$d" && env ${val:+$val} git merge "$@" 2>&1 ); rc=$?
  printf '%s\n__EXIT__%s\n' "$saida" "$rc"
}
exit_de()  { sed -n 's/^__EXIT__//p' <<<"$1"; }
saida_de() { sed '/^__EXIT__/d' <<<"$1"; }

printf '\nmerge-auto-commit-passa-pelos-guards — #1225\n'

# ── M1 · o merge que ENFRAQUECE ─────────────────────────────────────────────────────
# A branch tem commit PRÓPRIO no invariante (a autoria que o guard lê) e a main reescreveu o
# MESMO slot na ponta: o 3-way conflita e o `-X theirs` resolve a favor da main, descartando o
# fortalecimento da branch — que é o dano do #1225.
m="$TMP/m"; armar "$m" "$principal" "$BASE"
inv "$MARCA_BRANCH" "$SLOT_MAIN" "$SLOT_LIVRE" > "$m/$INV"
commitar "$m" "a branch fortalece o invariante dela"
SHA_BRANCH=$(git -C "$m" rev-parse HEAD)
if [ -n "$(git -C "$m" log --oneline "$BASE"..HEAD -- "$INV")" ]; then ok "M1: a branch TEM commit próprio no invariante (a autoria que o guard lê)"
else falha "M1: a branch TEM commit próprio no invariante" "log vazio — o caso não tem autoria para medir"; fi
if [ -n "$(git -C "$m" log --oneline HEAD..origin/main -- "$INV")" ]; then ok "M1: e a MAIN também tocou o invariante (é o que faz o -X theirs ter o que descartar)"
else falha "M1: e a MAIN também tocou o invariante" "a main não tocou: o caso mediria outra coisa"; fi

# M1-ANTES · a MESMA montagem sem a rota nova: o merge perde em SILÊNCIO. Sem esta metade o
# caso seria uma asserção sobre si mesmo — é ela que mostra o que o hook está barrando.
msem="$TMP/msem"; armar "$msem" "$principal" "$BASE"
rm -f "$msem/loop/hooks/pre-merge-commit"
inv "$MARCA_BRANCH" "$SLOT_MAIN" "$SLOT_LIVRE" > "$msem/$INV"
commitar "$msem" "a branch fortalece o invariante dela"
r=$(merge_auto "$msem" "" -X theirs origin/main)
assert_exit "$(exit_de "$r")" 0 "M1-ANTES: sem a rota, o merge auto-commita (exit 0) — o defeito do #1225"
assert_igual "$(pais_de "$msem")" "2" "M1-ANTES: e o commit resultante é um MERGE de verdade (2 pais)"
if tem_marcador "$msem" "$INV" BRANCH; then
  falha "M1-ANTES: e o fortalecimento da branch DESAPARECE do HEAD" "MARCADOR-BRANCH ainda está lá: a montagem não encena a perda"
else ok "M1-ANTES: e o fortalecimento da branch DESAPARECE do HEAD, em silêncio"; fi
assert_contains "$(git -C "$msem" show "HEAD:$INV")" "MARCADOR-MAIN" "M1-ANTES: quem ficou no lugar foi a versão da main"

r=$(merge_auto "$m" "" -X theirs origin/main)
assert_recusa "$(exit_de "$r")" "M1: com a rota, o MESMO merge é BARRADO"
assert_contains "$(saida_de "$r")" "Not committing merge" "M1: e a recusa vem do hook, no caminho do auto-commit (não de conflito)"
assert_contains "$(saida_de "$r")" "$INV" "M1: e a mensagem nomeia o invariante acusado"
assert_igual "$(git -C "$m" rev-parse HEAD)" "$SHA_BRANCH" "M1: e o HEAD ficou PARADO (nada foi commitado)"
if tem_marcador "$m" "$INV" BRANCH; then ok "M1: e o fortalecimento da branch continua no HEAD"
else falha "M1: e o fortalecimento da branch continua no HEAD" "o marcador sumiu do HEAD apesar do exit != 0"; fi

# ── M2 · CONTROLE NEGATIVO: merge que não encosta em arquivo congelado ──────────────
# Se este caso ficar vermelho, o hook barra todo merge — o oposto do conserto. É o par que
# impede o teste de passar por bloquear tudo.
m2="$TMP/m2"; armar "$m2" "$principal_limpo" "$BASE_LIMPO"
mkdir -p "$m2/src"
printf 'só trabalho meu\n' > "$m2/meu-trabalho.txt"
printf 'export const x = 1;\n' > "$m2/src/meu.ts"
commitar "$m2" "commit próprio, fora de qualquer arquivo congelado"
r=$(merge_auto "$m2" "" origin/main)
assert_exit "$(exit_de "$r")" 0 "M2: merge que não encosta em arquivo congelado segue PASSANDO (a rota não é bloqueio cego)"
assert_igual "$(pais_de "$m2")" "2" "M2: e o merge foi mesmo feito (2 pais)"
assert_igual "$(git -C "$m2" rev-parse HEAD^2)" "$PONTA_LIMPA" "M2: e o 2º pai é a ponta da main"
assert_contains "$(git -C "$m2" show "HEAD:README.md")" "linha que a MAIN acrescentou" "M2: e o que a main trouxe chegou ao HEAD"
if [ -f "$m2/loop/hooks/pre-merge-commit" ]; then ok "M2: com a rota ARMADA no fixture (o merge passou POR ela)"
else falha "M2: com a rota ARMADA no fixture" "loop/hooks/pre-merge-commit não existe no fixture"; fi

# ── M3-PREMISSA · o git NÃO escreve MERGE_HEAD quando chama pre-merge-commit ─────────
# Sonda de causa, e não prosa: é a AUSÊNCIA do MERGE_HEAD que impede os guards de inocentar o
# que veio da main (o #1161 decide procedência por ele). Se um dia o git passar a escrevê-lo,
# esta premissa cai e o caso M3 tem de ser reescrito — por isso ela é asserção.
m3p="$TMP/m3p"; armar "$m3p" "$principal_limpo" "$BASE_LIMPO"
cat > "$m3p/loop/hooks/pre-merge-commit" <<'SONDA'
#!/usr/bin/env bash
# sonda: registra o que ESTE hook enxerga no instante em que o git o chama
{ printf 'MERGE_HEAD=%s\n' "$(git rev-parse --verify -q MERGE_HEAD || echo AUSENTE)"
  printf 'ORIG_HEAD=%s\n' "$(git rev-parse --verify -q ORIG_HEAD || echo AUSENTE)"
  printf 'HEAD=%s\n' "$(git rev-parse HEAD)"; } >> "$SONDA_SAIDA"
exit 0
SONDA
chmod +x "$m3p/loop/hooks/pre-merge-commit"
SONDA_SAIDA="$TMP/sonda.txt"; export SONDA_SAIDA
printf 'só trabalho meu\n' > "$m3p/meu-trabalho.txt"
commitar "$m3p" "commit próprio"
r=$(merge_auto "$m3p" "" origin/main)
assert_exit "$(exit_de "$r")" 0 "M3-PREMISSA: a sonda deixa o merge seguir (mede o estado, não barra)"
assert_contains "$(cat "$SONDA_SAIDA" 2>/dev/null)" "MERGE_HEAD=AUSENTE" "M3-PREMISSA: no pre-merge-commit o git NÃO escreveu MERGE_HEAD"
assert_contains "$(cat "$SONDA_SAIDA" 2>/dev/null)" "ORIG_HEAD=" "M3-PREMISSA: a sonda rodou mesmo (ORIG_HEAD presente)"

# ── M3 · a main mexe no invariante e a branch NÃO: falha FECHADO, com saída declarada ─
# O merge não enfraquece NADA (o invariante da branch é o da base), mas a rota não tem como
# provar isso sem MERGE_HEAD. Recusar é o lado seguro (a doutrina do guard: bloquear pede
# válvula declarada; liberar perde o eval em silêncio) — desde que a válvula EXISTA. As duas
# metades correm em fixtures SEPARADOS: depois de uma recusa o índice fica encenado, e medir a
# segunda metade sobre o estado da primeira mediria a bagunça, não a válvula.
m3a="$TMP/m3a"; armar "$m3a" "$principal" "$BASE"
printf 'só trabalho meu\n' > "$m3a/meu-trabalho.txt"
commitar "$m3a" "commit próprio, sem tocar no invariante"
SHA_M3A=$(git -C "$m3a" rev-parse HEAD)
r=$(merge_auto "$m3a" "" origin/main)
assert_recusa "$(exit_de "$r")" "M3: a main muda o invariante e a branch não — a rota falha FECHADO"
assert_contains "$(saida_de "$r")" "$INV" "M3: e a mensagem nomeia o invariante (não é recusa anônima)"
assert_igual "$(git -C "$m3a" rev-parse HEAD)" "$SHA_M3A" "M3: e o HEAD ficou PARADO"

m3b="$TMP/m3b"; armar "$m3b" "$principal" "$BASE"
printf 'só trabalho meu\n' > "$m3b/meu-trabalho.txt"
commitar "$m3b" "commit próprio, sem tocar no invariante"
r=$(merge_auto "$m3b" "DESKCOMM_GOV_INVARIANTS_EDIT=1" origin/main)
assert_exit "$(exit_de "$r")" 0 "M3: com a válvula declarada o MESMO merge passa (é saída, não beco)"
assert_igual "$(pais_de "$m3b")" "2" "M3: e o merge foi mesmo feito"
assert_contains "$(git -C "$m3b" show "HEAD:$INV")" "MARCADOR-MAIN" "M3: e o invariante da main chegou ao HEAD"

printf '\nmerge-auto-commit-passa-pelos-guards: %s casos, %s falha(s)\n' "$casos" "$falhas"
[ "$falhas" -eq 0 ] || exit 1
