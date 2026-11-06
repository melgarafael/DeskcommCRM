#!/usr/bin/env bash
# merge-auto-commit-passa-pelos-guards — prova do #1225.
#
# merge-auto-commit-passa-pelos-guards — prova do #1225, depois da aposentadoria do
# congelamento de `tests/invariants/**`.
#
# O QUE ESTE ARQUIVO MEDE
# `loop/hooks/pre-commit` só roda quando existe um `git commit`. Um merge que resolve
# SOZINHO não passa por `git commit`: o git cria o commit de merge e pronto. Sem a rota
# `pre-merge-commit` o dispatcher dos guards (validate-features, check-migration-triple,
# guard-invariants) nunca era consultado — e o defeito medido no #1225 era um
# `git merge -X theirs origin/main` que descartava, em SILÊNCIO, o fortalecimento que a
# branch tinha feito num invariante.
#
# O que mudou, e por que este arquivo não sumiu junto: com o fim do épico o congelamento
# foi aposentado (`M` é manutenção de teste — ver `loop/hooks/guard-invariants.sh`), então
# aquele descarte deixou de ser dano. O que continua sendo dano é a DELEÇÃO: apagar o
# invariante que a `main` tem tira o teste do gate sem ninguém decidir nada. A rota do
# #1225 e a regra que sobrou são medidas aqui, pelo CAMINHO DE PRODUÇÃO (`git merge` de
# verdade, com o hook que o git consulta e `core.hooksPath` armado), nunca chamando um
# `.sh` na mão: chamar o arquivo mede a FUNÇÃO; o que decide é o SISTEMA.
#
# CASOS
#   ROTA-PREMISSA  sonda de causa: no `pre-merge-commit` o git NÃO escreveu MERGE_HEAD e o
#       commit de merge foi feito por ela — é o hook que o git chama, não um `.sh` na mão.
#   M1   o merge que só traz a REESCRITA da main PASSA (era o dano do #1225; hoje `M` é
#       livre, e o caso garante que ninguém "conserta" o hook religando a barreira).
#   M2   CONTROLE NEGATIVO: um merge que não encosta em nada guardado segue passando. É o
#       que separa "barramento" de "bloqueio de todo merge".
#   M-DEL  a DELEÇÃO introduzida na RESOLUÇÃO do merge (o invariante que a main mantém
#       apagado de carona no commit da resolução) é RECUSADA, e o HEAD fica parado — o
#       caminho realista de um invariante incômodo sair do gate.
#   M-VÁLVULA  a mesma deleção, com `DESKCOMM_GOV_INVARIANTS_EDIT=1`: passa.
#   M4   o sinal do outro lado é FORJÁVEL (`GITHEAD_*` é variável de ambiente e MERGE_HEAD
#       se escreve à mão): um commit COMUM que apaga o invariante com o sinal apontado para
#       a main continua RECUSADO — sinal nenhum lava uma deleção.
#
# Controle de vivacidade: M-DEL e M4 ficam VERDES (a recusa some) com `main_tem` desligado
# no hook; M-DEL também fica verde com o `loop/hooks/pre-merge-commit` fora do caminho.
# M2 continua verde sempre: mede o outro lado, que o hook não barra.
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
# branch nem toca (M1). principal_limpo: a main só mexe em README/src — é o que permite ao
# CONTROLE NEGATIVO (M2) medir um merge que não encosta em invariante nenhum.
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

printf '\nmerge-auto-commit-passa-pelos-guards — #1225 (congelamento aposentado)\n'

# ── ROTA-PREMISSA · o git NÃO escreve MERGE_HEAD quando chama pre-merge-commit ───────
# Sonda de causa, e não prosa: o hook que o git chama no auto-commit é este, e ele enxerga
# o estado SEM o MERGE_HEAD — o que importa para qualquer guard que um dia volte a julgar
# procedência. Se um dia o git passar a escrevê-lo, esta premissa cai e quem a ler sabe.
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
assert_exit "$(exit_de "$r")" 0 "ROTA-PREMISSA: a sonda deixa o merge seguir (mede o estado, não barra)"
assert_contains "$(cat "$SONDA_SAIDA" 2>/dev/null)" "MERGE_HEAD=AUSENTE" "ROTA-PREMISSA: no pre-merge-commit o git NÃO escreveu MERGE_HEAD"
assert_contains "$(cat "$SONDA_SAIDA" 2>/dev/null)" "ORIG_HEAD=" "ROTA-PREMISSA: a sonda rodou mesmo (ORIG_HEAD presente)"
assert_igual "$(pais_de "$m3p")" "2" "ROTA-PREMISSA: e o commit de merge foi feito por ela"

# ── M1 · o merge que só traz a REESCRITA da main PASSA ───────────────────────────────
# Era o dano do #1225 (o `-X theirs` descartava o fortalecimento da branch). Com o
# congelamento aposentado isso não é dano: `M` saiu do hook. O caso existe para que a
# aposentadoria não seja desfeita por engano — e mede pelo caminho de produção, com a rota
# armada, o merge feito de fato e a versão da main no HEAD.
m="$TMP/m"; armar "$m" "$principal" "$BASE"
printf 'só trabalho meu\n' > "$m/meu-trabalho.txt"
commitar "$m" "commit próprio, sem encostar no invariante"
r=$(merge_auto "$m" "" -X theirs origin/main)
assert_exit "$(exit_de "$r")" 0 "M1: merge que só traz a reescrita do invariante da main PASSA"
assert_igual "$(pais_de "$m")" "2" "M1: e o commit resultante é um MERGE de verdade (2 pais)"
assert_contains "$(git -C "$m" show "HEAD:$INV")" "MARCADOR-MAIN" "M1: e a versão da main está no HEAD"

# ── M-DEL · a DELEÇÃO introduzida na RESOLUÇÃO do merge: RECUSADA, HEAD parado ───────
# A montagem é a forma realista: a branch conflita no README, a main reescreveu o invariante
# e NÃO o apagou, e quem resolve apaga o invariante de carona no commit da resolução. É o
# caminho em que um invariante incômodo sai do gate sem ninguém decidir nada — e o único
# tipo de dano que sobrou nesta família de guardas.
md="$TMP/md"; armar "$md" "$principal" "$BASE"
printf 'ponta da BRANCH\n' > "$md/README.md"; commitar "$md" "a branch reescreve o README"
git -C "$md" merge --no-edit origin/main >/dev/null 2>&1 || true
if [ -n "$(git -C "$md" rev-parse -q --verify MERGE_HEAD)" ]; then ok "M-DEL: o merge conflitou de verdade (MERGE_HEAD presente)"
else falha "M-DEL: o merge conflitou de verdade" "sem MERGE_HEAD: o caso não mede resolução"; fi
SHA_MD=$(git -C "$md" rev-parse HEAD)
printf 'resolvido\n' > "$md/README.md"; git -C "$md" add README.md
# `-f` porque o lado da main deixou o arquivo MODIFICADO no índice do merge.
git -C "$md" rm -qf "$INV"
if git -C "$md" diff --cached --name-status | grep -q "^D	$INV$"; then ok "M-DEL: a resolução deixa um D no índice (a premissa do caso)"
else falha "M-DEL: a resolução deixa um D no índice" "name-status: $(git -C "$md" diff --cached --name-status | tr '\n' ' ')"; fi
saida=$( cd "$md" && git commit --no-edit 2>&1 ); rc=$?
assert_recusa "$rc" "M-DEL: resolver o merge apagando invariante que a main tem é RECUSADO"
assert_contains "$saida" "$INV" "M-DEL: e a mensagem nomeia o invariante"
assert_igual "$(git -C "$md" rev-parse HEAD)" "$SHA_MD" "M-DEL: e o HEAD ficou PARADO (o merge não foi concluído)"
if [ -n "$(git -C "$md" rev-parse -q --verify "HEAD:$INV")" ]; then ok "M-DEL: e o invariante continua no HEAD (a consequência, não só o exit)"
else falha "M-DEL: o invariante continua no HEAD" "sumiu do HEAD"; fi

# ── M-VÁLVULA · a mesma deleção, com a saída declarada ───────────────────────────────
mv="$TMP/mv"; armar "$mv" "$principal" "$BASE"
printf 'ponta da BRANCH\n' > "$mv/README.md"; commitar "$mv" "a branch reescreve o README"
git -C "$mv" merge --no-edit origin/main >/dev/null 2>&1 || true
printf 'resolvido\n' > "$mv/README.md"; git -C "$mv" add README.md
git -C "$mv" rm -qf "$INV"
saida=$( cd "$mv" && DESKCOMM_GOV_INVARIANTS_EDIT=1 git commit --no-edit 2>&1 ); rc=$?
assert_exit "$rc" 0 "M-VÁLVULA: com DESKCOMM_GOV_INVARIANTS_EDIT=1 a mesma resolução passa"
assert_igual "$(pais_de "$mv")" "2" "M-VÁLVULA: e o merge foi concluído (2 pais)"
if [ -z "$(git -C "$mv" rev-parse -q --verify "HEAD:$INV")" ]; then ok "M-VÁLVULA: e o invariante saiu do HEAD, como pedido"
else falha "M-VÁLVULA: o invariante saiu do HEAD" "segue lá"; fi

# ── M4 · o sinal do outro lado não LAVA uma deleção ─────────────────────────────────
# `GITHEAD_<sha>` é variável de ambiente: quem commita a escreve. Um `git commit` COMUM
# (sem merge) que apaga o invariante com o sinal apontando para a main tem de ser recusado
# como qualquer deleção — a régua é o que a main TEM, não o sinal que a sessão apresenta.
m4="$TMP/m4"; armar "$m4" "$principal" "$BASE"
git -C "$m4" rm -q "$INV"
SHA_M4=$(git -C "$m4" rev-parse HEAD)
saida=$( cd "$m4" && env "GITHEAD_$PONTA_MAIN=origin/main" git commit -m "apaga com o sinal forjado" 2>&1 ); rc=$?
assert_recusa "$rc" "M4: commit comum com GITHEAD_<ponta> forjado que APAGA o invariante é RECUSADO"
assert_contains "$saida" "$INV" "M4: e a mensagem nomeia o invariante"
assert_igual "$(git -C "$m4" rev-parse HEAD)" "$SHA_M4" "M4: e o HEAD ficou PARADO (nada foi commitado)"

printf '\nmerge-auto-commit-passa-pelos-guards: %s casos, %s falha(s)\n' "$casos" "$falhas"
[ "$falhas" -eq 0 ] || exit 1
