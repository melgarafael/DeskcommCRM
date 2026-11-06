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
# sobre o índice INTEIRO do merge (casos 4/5 da issue #1161).
#
# O que está sob prova, hook por hook:
#
#   guard-invariants.sh — o congelamento de `tests/invariants/**` foi APOSENTADO; o que
#        ficou é a proteção de DELEÇÃO. A régua é a da MAIN: apagar — ou renomear, que é
#        apagar disfarçado — o invariante que `origin/main` TEM é recusado, e o que ela
#        não tem passa livre (o rascunho que a branch criou; a deleção que a main fez e o
#        merge trouxe). MODIFICAR não é mais assunto deste hook: desde o fim do épico,
#        editar invariante é manutenção normal de teste, e o caso M mede isso pelo
#        caminho de PRODUÇÃO, com a válvula AUSENTE do ambiente.
#     · M, A — modificar invariante existente e adicionar invariante novo passam sem
#       `DESKCOMM_GOV_INVARIANTS_EDIT`.
#     · D, R, D-ACENTO — a deleção do que a main tem segue barrada, e a mensagem nomeia
#       o arquivo. É o caso que fica vermelho se o hook virar `exit 0`.
#     · D-VÁLVULA — a saída declarada continua existindo.
#     · D-PRÓPRIO, D-VEIO-DO-MERGE — os dois falsos positivos que a deleção poderia
#       criar (o rascunho da própria branch e o `D` que veio da main) passam.
#     · D-SEM-REF — sem `origin/main` não há régua: falha FECHADA. E um commit sem
#       deleção nenhuma sai antes de consultar ref alguma, para o caminho comum não pagar.
#     · PRETOOLUSE — o guard irmão (`guard-protected-paths.sh`, PreToolUse do Claude Code)
#       andou junto: Edit/Write em invariante existente passa, `rm` de teste segue barrado.
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
#   check-migration-triple.sh
#     8. o NNNN e o timestamp já COMMITADOS na própria branch contam (MIG-PROPRIA), e a
#        guarda contra a main e contra outra branch segue de pé (MIG-CONTROLE).
#     9. e o critério de aceite da #374 nas DUAS metades, pelo caminho de produção:
#        um `git merge origin/main` de verdade que traz migration da main passa
#        (MIG-MERGE) e, NO MESMO ARQUIVO, criar a migration com número já usado segue
#        bloqueado (MIG-CRIA). Sem a segunda, a primeira se provaria desligando o guard.
#
# Controle de vivacidade: as asserções POSITIVAS são D, R, D-ACENTO, D-SEM-REF, D-VÁLVULA,
# PRETOOLUSE (o `rm`), F-A, F-B+, F-CRIA-PRÓPRIA e F-BIG+. Um hook substituído por `exit 0`
# as deixa vermelhas — é o que prova que este arquivo mede algo. As de M/A/D-PRÓPRIO/
# D-VEIO-DO-MERGE medem o outro lado (a aposentadoria do congelamento) e ficam verdes por
# construção: elas existem para que ninguém "conserte" o hook religando a barreira antiga.
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


# a main ANDA: edita o invariante e o features.json (só campo proibido, como um ato humano)
inv "" "" "$MARCA_MAIN" > "$principal/$INV"
inv "" "" "$MARCA_MAIN" > "$principal/$INV_ACENTO"
printf '{\n  "epico": "G6",\n  "features": [\n    { "id": "F1", "title": "titulo original", "passes": false },\n    { "id": "F2", "title": "feature que a MAIN criou", "passes": false }\n  ]\n}\n' > "$principal/$FEAT"
# o README anda junto de propósito: é o que faz os merges dos casos F-* terem conteúdo
# além do plano, e é o que dava o conflito do caso E2E (o merge conflitado é o único
# caminho em que o `git commit` de uma resolução chama o pre-commit).
printf '# leia\nlinha que a MAIN acrescentou\n' > "$principal/README.md"
commitar "$principal" "a main anda: invariante, plano e README"

# e um commit só-de-plano, para o caminho de CRIAÇÃO (a main cria o arquivo depois)
principal2="$TMP/principal2"; mkdir -p "$principal2/plan"
git -C "$principal2" init -q -b main
printf '# leia\n' > "$principal2/README.md"; commitar "$principal2" "base sem plano"
BASE_SEM_PLANO=$(git -C "$principal2" rev-parse HEAD)
printf '{\n  "epico": "G6",\n  "features": [ { "id": "F1", "title": "criado pela main", "passes": false } ]\n}\n' > "$principal2/$FEAT"
commitar "$principal2" "a main CRIA o plano"

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

printf '\nguard-invariants.sh — o congelamento saiu, a deleção ficou\n'

# ── M · MODIFICAR é livre, sem variável de escape ───────────────────────────────────
# A aposentadoria do congelamento pelo caminho de PRODUÇÃO (`git commit`, dispatcher
# armado): trocar a ASSERÇÃO de um invariante que a main tem é exatamente a operação que
# o hook existia para barrar. Ela passa — e a premissa medida é que a env de escape NÃO
# está no ambiente, senão o caso se provaria pela válvula em vez de pela regra.
m1="$TMP/m1"; preparar "$m1" "$principal" "$BASE_DA_BRANCH"
printf 'import { it } from "vitest";\nit("MARCADOR-REESCRITO", () => {});\n' > "$m1/$INV"
git -C "$m1" add "$INV"
if [ -z "${DESKCOMM_GOV_INVARIANTS_EDIT:-}" ]; then ok "M: a válvula NÃO está no ambiente (a premissa)"
else falha "M: a válvula NÃO está no ambiente" "DESKCOMM_GOV_INVARIANTS_EDIT=${DESKCOMM_GOV_INVARIANTS_EDIT}"; fi
r=$(commitar_pelo_dispatcher "$m1" "ajusta a asserção do invariante")
assert_exit "$(exit_de "$r")" 0 "M: editar invariante que a main tem PASSA sem DESKCOMM_GOV_INVARIANTS_EDIT"
assert_contains "$(git -C "$m1" show "HEAD:$INV")" "MARCADOR-REESCRITO" "M: e a edição está no HEAD (não foi um commit vazio)"

# ── A · ADICIONAR invariante novo segue livre (o controle que impede bloqueio cego) ──
add="$TMP/add-novo"; preparar "$add" "$principal" "$BASE_DA_BRANCH"
inv > "$add/tests/invariants/novo-da-branch.test.ts"
git -C "$add" add -A
r=$(commitar_pelo_dispatcher "$add" "invariante novo")
assert_exit "$(exit_de "$r")" 0 "A: invariante NOVO segue passando"

# ── D · DELETAR invariante que a main TEM: barrado, e a mensagem nomeia o arquivo ────
# A regra que sobrou, e a consequência medida junto com o exit: o HEAD não anda e o
# invariante segue no lugar. Um hook que sai 1 depois de já ter deixado o commit entrar
# estaria medindo outra coisa.
d="$TMP/d"; preparar "$d" "$principal" "$BASE_DA_BRANCH"
git -C "$d" rm -q "$INV"
sha_antes=$(git -C "$d" rev-parse HEAD)
r=$(commitar_pelo_dispatcher "$d" "apaga o invariante")
assert_exit "$(exit_de "$r")" 1 "D: apagar invariante que a main tem é RECUSADO"
assert_contains "$(saida_de "$r")" "$INV" "D: e a mensagem nomeia o invariante"
assert_contains "$(saida_de "$r")" "MODIFICAR invariante é livre" "D: e ensina que modificar não é o caso barrado (a válvula de ontem virou regra de hoje)"
if [ "$(git -C "$d" rev-parse HEAD)" = "$sha_antes" ] && [ -n "$(git -C "$d" rev-parse -q --verify "HEAD:$INV")" ]; then ok "D: e o HEAD ficou PARADO, com o invariante no lugar"
else falha "D: o HEAD ficou parado com o invariante no lugar" "HEAD=$(git -C "$d" rev-parse HEAD) sha_antes=$sha_antes"; fi

# ── D-VÁLVULA · a deleção deliberada continua com a saída declarada ─────────────────
dv="$TMP/dv"; preparar "$dv" "$principal" "$BASE_DA_BRANCH"
git -C "$dv" rm -q "$INV"
saida=$( cd "$dv" && DESKCOMM_GOV_INVARIANTS_EDIT=1 git commit -q -m "apaga invariante duplicado" 2>&1 ); rc=$?
assert_exit "$rc" 0 "D-VÁLVULA: com DESKCOMM_GOV_INVARIANTS_EDIT=1 a deleção passa"
if [ -z "$(git -C "$dv" rev-parse -q --verify "HEAD:$INV")" ]; then ok "D-VÁLVULA: e o invariante saiu do HEAD de fato"
else falha "D-VÁLVULA: o invariante saiu do HEAD" "segue lá"; fi

# ── D-PRÓPRIO · apagar o invariante que a PRÓPRIA branch criou: passa ───────────────
# A régua é a da main. O que nunca esteve lá não é guarda perdida, é rascunho da branch —
# e exigir a válvula para apagar o próprio rascunho é como a válvula vira rotina.
dp="$TMP/dp"; preparar "$dp" "$principal" "$BASE_DA_BRANCH"
inv > "$dp/tests/invariants/rascunho-da-branch.test.ts"
git -C "$dp" add -A && git -C "$dp" commit -q --no-verify -m "rascunho da branch"
git -C "$dp" rm -q tests/invariants/rascunho-da-branch.test.ts
r=$(commitar_pelo_dispatcher "$dp" "apaga o rascunho")
assert_exit "$(exit_de "$r")" 0 "D-PRÓPRIO: apagar invariante que a branch criou PASSA"

# ── D-VEIO-DO-MERGE · a deleção que a MAIN fez, trazida pelo merge: passa ────────────
# É o falso positivo do #1161 pela porta da deleção: a main apaga um invariante, a branch
# mescla, e o índice fica com um `D` que NÃO é autoria de quem mergeia. A régua
# (`origin/main:$p`) já não tem o arquivo → passa. E é o caminho de PRODUÇÃO: o merge
# auto-commita e o git chama `pre-merge-commit` → dispatcher, não uma chamada ao .sh.
principal_apaga="$TMP/principal_apaga"; mkdir -p "$principal_apaga/tests/invariants"
git -C "$principal_apaga" init -q -b main
inv > "$principal_apaga/$INV"
printf '# leia\n' > "$principal_apaga/README.md"
commitar "$principal_apaga" "base com o invariante"
BASE_APAGA=$(git -C "$principal_apaga" rev-parse HEAD)
git -C "$principal_apaga" rm -q "$INV"
printf '# leia\nlinha que a MAIN acrescentou\n' > "$principal_apaga/README.md"
commitar "$principal_apaga" "a main APAGA o invariante"
ap="$TMP/ap"; preparar "$ap" "$principal_apaga" "$BASE_APAGA"
if [ -n "$(git -C "$ap" rev-parse -q --verify "HEAD:$INV")" ]; then ok "D-VEIO-DO-MERGE: a branch ainda tem o invariante no HEAD (a premissa)"
else falha "D-VEIO-DO-MERGE: a branch ainda tem o invariante no HEAD" "não tem"; fi
saida=$( cd "$ap" && git merge --no-edit origin/main 2>&1 ); rc=$?
assert_exit "$rc" 0 "D-VEIO-DO-MERGE: o merge que só traz a DELEÇÃO da main PASSA"
if [ -z "$(git -C "$ap" rev-parse -q --verify "HEAD:$INV")" ]; then ok "D-VEIO-DO-MERGE: e a deleção da main chegou ao HEAD (o merge foi feito)"
else falha "D-VEIO-DO-MERGE: e a deleção da main chegou ao HEAD" "o arquivo ressuscitou: $(saida_de "$saida")"; fi

# ── R · renomear é deleção disfarçada: barrado pelo path VELHO ───────────────────────
# O git emite `R100<TAB>velho<TAB>novo`, e o que se perde é o caminho VELHO. Julgar só o
# destino deixaria o invariante antigo ser apagado em silêncio (era o caso R-VELHO).
rr="$TMP/rr"; preparar "$rr" "$principal" "$BASE_DA_BRANCH"
git -C "$rr" mv "$INV" tests/invariants/exemplo-renomeado.test.ts
if git -C "$rr" diff --cached --name-status | grep -q '^R'; then ok "R: o git formou a linha R (a premissa do caso)"
else falha "R: o git formou a linha R" "name-status: $(git -C "$rr" diff --cached --name-status | tr '\n' ' ')"; fi
r=$(commitar_pelo_dispatcher "$rr" "renomeia o invariante")
assert_exit "$(exit_de "$r")" 1 "R: renomear invariante da main é RECUSADO"
assert_contains "$(saida_de "$r")" "$INV" "R: e a mensagem nomeia o path VELHO"

# ── D-ACENTO · o furo do `core.quotepath` segue fechado ──────────────────────────────
# Medido em 18/09/2026 nas duas versões anteriores: com `core.quotepath` no padrão (true)
# o caminho sai citado em octal, a âncora `^tests/invariants/` não casa e o invariante
# ficava invisível à guarda — num projeto em português. `-c core.quotepath=false` no hook
# é o que fecha isso.
ac="$TMP/ac"; preparar "$ac" "$principal" "$BASE_DA_BRANCH"
git -C "$ac" rm -q "$INV_ACENTO"
r=$(commitar_pelo_dispatcher "$ac" "apaga o invariante acentuado")
assert_exit "$(exit_de "$r")" 1 "D-ACENTO: apagar invariante de nome acentuado é RECUSADO"
assert_contains "$(saida_de "$r")" "$INV_ACENTO" "D-ACENTO: e a mensagem nomeia o arquivo com acento"

# ── D-SEM-REF · sem `origin/main` não há régua: falha FECHADA, com o conserto na cara ─
sr="$TMP/sr"; preparar "$sr" "$principal" "$BASE_DA_BRANCH"
git -C "$sr" remote remove origin
git -C "$sr" rm -q "$INV"
r=$(commitar_pelo_dispatcher "$sr" "apaga sem a ref")
assert_exit "$(exit_de "$r")" 1 "D-SEM-REF: sem origin/main a deleção é RECUSADA (falha fechada)"
assert_contains "$(saida_de "$r")" "não há 'origin/main' para dizer" "D-SEM-REF: e a mensagem diz o que falta"

# ── PRETOOLUSE · o outro guard da cadeia andou junto ─────────────────────────────────
# `guard-protected-paths.sh` (PreToolUse do Claude Code) é um arquivo SEPARADO: se ele
# ficar para trás, a aposentadoria não chega em quem edita pelo agente, e o hook de
# commit sozinho não denuncia isso. As duas metades: Edit passa, `rm` segue barrado.
saida=$( cd "$RAIZ" && printf '{"tool_name":"Edit","tool_input":{"file_path":"%s"}}' "$RAIZ/$INV" | bash loop/hooks/guard-protected-paths.sh 2>&1 ); rc=$?
assert_exit "$rc" 0 "PRETOOLUSE: Edit em invariante existente PASSA (exit 0)"
if [ -z "$(saida_de "$saida"__EXIT__0)" ]; then ok "PRETOOLUSE: e o guard não escreve nada (não virou aviso de rotina)"
else falha "PRETOOLUSE: o guard não escreve nada" "saída: $(head -c 200 <<<"$saida")"; fi
printf '{"tool_name":"Bash","tool_input":{"command":"git rm %s"}}' "$INV" | bash loop/hooks/guard-protected-paths.sh >/dev/null 2>&1; rc=$?
assert_exit "$rc" 2 "PRETOOLUSE: e o rm de invariante segue BARRADO (exit 2)"

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

# ── check-migration-triple.sh · o que a PRÓPRIA branch já commitou conta (#1776) ──
# `pop_refs_de_outrem` tira da conta a ref cujo SHA é o do HEAD, e o hook não devolvia
# o HEAD: a 0411 que a branch JÁ commitou sumia da população, e a segunda 0411 (e o
# carimbo repetido) passava calada. Na main de antes (`git branch`) ela bloqueava.
printf '\ncheck-migration-triple.sh — a própria branch está na população\n'
pmig="$TMP/pmig"; mkdir -p "$pmig/supabase/migrations"
git -C "$pmig" init -q -b main
printf 'select 1;\n' > "$pmig/supabase/migrations/20260801000000_0410_da_main.sql"
printf -- '-- baseline\n' > "$pmig/supabase/baseline.sql"
printf '| 0410 |\n' > "$pmig/supabase/migrations/MANIFEST.md"
commitar "$pmig" "0410 na main"
git -C "$pmig" checkout -q -b colega
printf 'select 1;\n' > "$pmig/supabase/migrations/20260802000000_0413_do_colega.sql"
commitar "$pmig" "0413 do colega"
git -C "$pmig" checkout -q main
m="$TMP/m-propria"; preparar "$m" "$pmig" main
mkdir -p "$m/scripts"; cp "$RAIZ/scripts/migration-populacao.sh" "$m/scripts/"
tripla() { # $1 = clone, $2 = nome em supabase/migrations/
  printf 'select 1;\n' > "$1/supabase/migrations/$2"
  printf -- '-- apêndice %s\n' "$2" >> "$1/supabase/baseline.sql"
  printf '| `%s` |\n' "$2" >> "$1/supabase/migrations/MANIFEST.md"
  git -C "$1" add -A
}
tripla "$m" 20260910000000_0411_primeira.sql
r=$(rodar "$m" check-migration-triple.sh)
assert_exit "$(exit_de "$r")" 0 "MIG-PROPRIA: a primeira 0411 da branch passa (número livre)"
commitar "$m" "0411 primeira"
tripla "$m" 20260910010000_0411_segunda.sql
r=$(rodar "$m" check-migration-triple.sh)
assert_exit "$(exit_de "$r")" 1 "MIG-PROPRIA: 0411_primeira commitada + 0411_segunda encenada: BLOQUEIA"
assert_contains "$(saida_de "$r")" "já existe em: HEAD(20260910000000_0411_primeira.sql)" "MIG-PROPRIA: e o dono nomeado é a própria branch"
git -C "$m" reset -q --hard HEAD
tripla "$m" 20260910000000_0412_mesmo_carimbo.sql
r=$(rodar "$m" check-migration-triple.sh)
assert_exit "$(exit_de "$r")" 1 "MIG-PROPRIA: carimbo da migration já commitada, repetido: BLOQUEIA"
assert_contains "$(saida_de "$r")" "TIMESTAMP 20260910000000 de '20260910000000_0412_mesmo_carimbo.sql' já existe em: HEAD" "MIG-PROPRIA: e acusa o timestamp contra a própria branch"
git -C "$m" reset -q --hard HEAD
tripla "$m" 20260910020000_0410_de_novo.sql
r=$(rodar "$m" check-migration-triple.sh)
assert_exit "$(exit_de "$r")" 1 "MIG-CONTROLE: a 0410 da main encenada de novo segue bloqueada"
git -C "$m" reset -q --hard HEAD
tripla "$m" 20260910030000_0413_meu.sql
r=$(rodar "$m" check-migration-triple.sh)
assert_exit "$(exit_de "$r")" 1 "MIG-CONTROLE: a 0413 de outra branch segue bloqueada"
assert_contains "$(saida_de "$r")" "origin/colega(20260802000000_0413_do_colega.sql)" "MIG-CONTROLE: e o dono nomeado é a branch do colega"
git -C "$m" reset -q --hard HEAD
tripla "$m" 20260910040000_0414_livre.sql
r=$(rodar "$m" check-migration-triple.sh)
assert_exit "$(exit_de "$r")" 0 "MIG-CONTROLE: e um número de fato livre passa"

# ── check-migration-triple.sh · o CRITÉRIO DE ACEITE DA #374, NAS DUAS METADES ──────
# A issue pede as duas direções JUNTAS neste arquivo: (1) um `git merge origin/main` que
# traz migration da main passa pelo dispatcher sem ser bloqueado, e (2) quem CRIA uma
# migration com número já usado continua sendo barrado. Sem a (2), o conserto seria
# "desligar o hook" e a metade (1) ficaria verde sozinha.
#
# Aqui é o CAMINHO DE PRODUÇÃO, não encenação de índice: `git merge` de verdade chama
# `pre-merge-commit`, que executa o MESMO dispatcher do commit (rota do #1225). Medido
# em 04/10/2026 sobre origin/main@711bd2705 — com os guards de ANTES da #374 os dois
# casos abaixo ficam vermelhos (sabotagem: `loop/hooks/check-migration-triple.sh` sem o
# filtro por `origin/main`, e o `freeze-invariants.sh` de antes de 5eda2d033, hoje
# `guard-invariants.sh`).
printf '\ncheck-migration-triple.sh — o merge da main, criterio da #374 (as duas metades)\n'
principal_mig="$TMP/principal_mig"; mkdir -p "$principal_mig/supabase/migrations" "$principal_mig/scripts"
git -C "$principal_mig" init -q -b main
cp "$RAIZ/scripts/migration-populacao.sh" "$principal_mig/scripts/"
printf -- '-- baseline\n' > "$principal_mig/supabase/baseline.sql"
printf '| base |\n' > "$principal_mig/supabase/migrations/MANIFEST.md"
printf 'select 1;\n' > "$principal_mig/supabase/migrations/20260801000000_0410_da_main.sql"
commitar "$principal_mig" "base com a 0410"
BASE_MIG=$(git -C "$principal_mig" rev-parse HEAD)
# uma branch de COLEGA que já tem OUTRO arquivo com o MESMO NNNN 0500 — é o cenário em
# que o filtro por `origin/main` é o que separa "veio da main" de colisão de verdade
# (sem o filtro, o merge acusa a dona; com ele, só sai da conta o que a main não tem).
git -C "$principal_mig" checkout -q -b colega
printf 'select 1;\n' > "$principal_mig/supabase/migrations/20260802000000_0500_do_colega.sql"
printf -- '-- apendice do colega\n' >> "$principal_mig/supabase/baseline.sql"
printf '| `20260802000000_0500_do_colega.sql` |\n' >> "$principal_mig/supabase/migrations/MANIFEST.md"
commitar "$principal_mig" "o colega publica outro arquivo com NNNN 0500"
git -C "$principal_mig" checkout -q main
# a main ANDA e publica a 0500 com a tripla inteira
printf 'select 1;\n' > "$principal_mig/supabase/migrations/20260803000000_0500_da_main.sql"
printf -- '-- apendice 0500\n' >> "$principal_mig/supabase/baseline.sql"
printf '| `20260803000000_0500_da_main.sql` |\n' >> "$principal_mig/supabase/migrations/MANIFEST.md"
commitar "$principal_mig" "a main publica a 0500"

# (1) a branch mergeia a main: o dispatcher roda e NÃO pode acusar o que veio de lá
mm="$TMP/mm"; preparar "$mm" "$principal_mig" "$BASE_MIG"
# o `preparar` copia `*.sh` + `pre-commit`; a ROTA DO MERGE é o `pre-merge-commit`
# (#1225) e sem ele o git chama nenhum hook — o caso passaria sem medir nada.
cp "$HOOKS_ORIGEM/pre-merge-commit" "$mm/loop/hooks/" && chmod +x "$mm/loop/hooks/pre-merge-commit"
assert_exit "$(test -x "$mm/loop/hooks/pre-merge-commit" && echo 0 || echo 1)" 0 "MIG-MERGE: premissa — a rota do merge está ARMADA no fixture"
saida_merge=$( cd "$mm" && git merge --no-edit origin/main 2>&1 ); rc_merge=$?
assert_exit "$rc_merge" 0 "MIG-MERGE: git merge origin/main trazendo a 0500 da main NÃO é bloqueado"
assert_exit "$(git -C "$mm" rev-list --parents -n1 HEAD 2>/dev/null | wc -w | tr -d ' ')" 3 "MIG-MERGE: e o commit é um MERGE de verdade (2 pais)"
assert_contains "$(git -C "$mm" ls-tree -r --name-only HEAD -- supabase/migrations)" "20260803000000_0500_da_main.sql" "MIG-MERGE: e a migration da main chegou ao HEAD"
assert_contains "$saida_merge" "Merge made by" "MIG-MERGE: e a saída é a de um merge concluído (não uma recusa do hook)"

# (2) no MESMO arquivo: quem CRIA o número já usado segue barrado, pelo caminho de produção
mm2="$TMP/mm2"; preparar "$mm2" "$principal_mig" "$BASE_MIG"
tripla "$mm2" 20260804000000_0500_a_minha.sql
r=$(commitar_pelo_dispatcher "$mm2" "crio a 0500 de novo")
assert_exit "$(exit_de "$r")" 1 "MIG-CRIA: criar migration com NNNN=0500 já usado segue BLOQUEADO"
assert_contains "$(saida_de "$r")" "sequência NNNN=0500" "MIG-CRIA: e a mensagem nomeia a sequência acusada"

# ── check-migration-triple.sh · população GRANDE termina (os dois hooks) ─────────
# Medido em 29/09/2026 no clone do mantenedor: ~5.788 refs de outrem → ~1,29 M linhas
# (~112 MB) de população, e o hook não terminava em 45 min. A causa era o teste de
# vazio `${populacao// /}`: a substituição de padrão do bash é quadrática no tamanho da
# string (medido aqui: 25 mil linhas → 18 s só nessa linha; 100 mil → ~400 s o hook).
# A população agora vive num ARQUIVO e o grep lê o arquivo. O fixture tem ~300 mil
# linhas (500 migrations × 600 refs para o mesmo commit — `pop_migrations` emite uma
# linha por ref) e o LIMITE é folgado para máquina lenta: o hook de antes estoura
# qualquer limite razoável aqui, o de agora leva ~1 s. O fixture foi dimensionado para o
# antigo estourar TAMBÉM em locale C (LANG vazio), onde ele termina em ~10 s com 100 mil
# linhas e o caso passaria sem vigiar; em UTF-8 o antigo é bem mais lento. Rodam os DOIS hooks: o do
# contribuidor tinha a mesma linha.
printf '\ncheck-migration-triple.sh — população grande termina (mantenedor e contribuidor)\n'
LIMITE_S=30
rodar_com_limite() { # $1 = clone, $2 = caminho do hook relativo ao clone
  local d=$1 h=$2 pid t=0 rc out="$TMP/saida-com-limite"
  ( cd "$d" && exec bash "$h" ) >"$out" 2>&1 & pid=$!
  while kill -0 "$pid" 2>/dev/null && [ "$t" -lt "$LIMITE_S" ]; do sleep 1; t=$((t+1)); done
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
    printf 'não terminou em %ss\n__EXIT__estourou\n' "$LIMITE_S"; return
  fi
  wait "$pid"; rc=$?
  printf '%s\n__EXIT__%s\n' "$(cat "$out")" "$rc"
}
g="$TMP/mig-grande"; mkdir -p "$g/supabase/migrations" "$g/scripts" "$g/loop/hooks" "$g/contrib"
git -C "$g" init -q -b main
cp "$RAIZ/scripts/migration-populacao.sh" "$g/scripts/"
cp "$HOOKS_ORIGEM/check-migration-triple.sh" "$g/loop/hooks/"
cp "$RAIZ/.agents/skills/deskcomm-contribuir/scripts/hooks/check-migration-triple.sh" "$g/contrib/"
printf -- '-- baseline\n' > "$g/supabase/baseline.sql"
printf '| base |\n' > "$g/supabase/migrations/MANIFEST.md"
commitar "$g" "base"
git -C "$g" checkout -q -b outra
for i in $(seq 1 500); do : > "$g/supabase/migrations/$(printf '2026010100%04d_%04d_m.sql' "$i" "$i")"; done
commitar "$g" "500 migrations"
c_outra=$(git -C "$g" rev-parse HEAD)
git -C "$g" checkout -q main
seq 1 600 | awk -v c="$c_outra" '{ printf "create refs/heads/r%05d %s\n", $1, c }' | git -C "$g" update-ref --stdin
linhas=$( cd "$g" && bash -c '. scripts/migration-populacao.sh; pop_migrations $(pop_refs_de_outrem "") HEAD | wc -l' | tr -d ' ')
if [ "${linhas:-0}" -ge 300000 ]; then ok "MIG-GRANDE: a população do fixture tem $linhas linhas (premissa do volume)"
else falha "MIG-GRANDE: população >= 300000 linhas" "veio ${linhas:-nada} — o caso não estressa o hook"; fi
tripla "$g" 20990101000000_9999_livre.sql
for h in loop/hooks/check-migration-triple.sh contrib/check-migration-triple.sh; do
  r=$(rodar_com_limite "$g" "$h")
  assert_exit "$(exit_de "$r")" 0 "MIG-GRANDE ($h): número livre passa em menos de ${LIMITE_S}s"
done
git -C "$g" rm -q --cached supabase/migrations/20990101000000_9999_livre.sql
rm -f "$g/supabase/migrations/20990101000000_9999_livre.sql"
tripla "$g" 20990101000001_0001_colide.sql
for h in loop/hooks/check-migration-triple.sh contrib/check-migration-triple.sh; do
  r=$(rodar_com_limite "$g" "$h")
  assert_exit "$(exit_de "$r")" 1 "MIG-GRANDE ($h): NNNN tomado segue BLOQUEADO em menos de ${LIMITE_S}s"
  assert_contains "$(saida_de "$r")" "r00200(20260101000001_0001_m.sql)" "MIG-GRANDE ($h): e o dono é nomeado"
  assert_contains "$(saida_de "$r")" "próximo livre 0501" "MIG-GRANDE ($h): e a dica mede o teto da MESMA população"
done

printf '\nhooks-nao-acusam-a-main: %s casos, %s falha(s)\n' "$casos" "$falhas"
[ "$falhas" -eq 0 ] || exit 1
