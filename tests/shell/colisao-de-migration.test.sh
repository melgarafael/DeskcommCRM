#!/usr/bin/env bash
# Prova do gate de colisão de número de migration (scripts/checar-colisao-de-migration.sh)
# em repositórios git DESCARTÁVEIS e sem rede: cada caso monta um "principal" local fazendo
# o papel da origin/main. Nada aqui toca o clone de quem roda.
#
#   bash tests/shell/colisao-de-migration.test.sh
#
# O que está sob prova:
#   1. o instrumento está VIVO — o controle positivo é ele reprovar uma colisão real. A
#      TRIAGEM.md:937-939 exige esse registro: vazio num diff limpo prova vacuidade, não
#      que a sonda enxerga.
#   2. NNNN tomado na base reprova, e a mensagem nomeia o número E os dois arquivos.
#   3. timestamp tomado na base reprova.
#   4. os casos legítimos NÃO reprovam: editar/reordenar migration existente, `git mv` de
#      slug, merge da própria main, e duplicata que já existia na base (linha de base).
#   5. o caso do #804 reprova: os dois PRs não conflitam, o merge da main entra limpo e só
#      então a árvore mostra o número disputado (é o defeito da issue #285).
#   6. dois arquivos do MESMO PR com o mesmo NNNN reprovam (sonda de árvore restrita às
#      adições do PR — o pre-commit não vê isso).
#   7. nome fora de <14 dígitos>_<NNNN>_<slug>.sql reprova: sem NNNN não há o que medir.
#   8. sem ref da base, o gate busca a base sozinho (o clone raso do CI); e quando não
#      consegue medir, REPROVA (exit 2) declarando o NÃO MEDIDO — nunca verde silencioso.
#   9. outra ref do clone (branch local de resgate) levanta o teto do conselho: o número
#      salta e a saída nomeia QUEM tem (issue #1155).
#  10. clone sem outras refs (o raso do CI) declara na própria saída que NÃO as mediu.
#  11. ref que resolve para o próprio HEAD não vira "quem tem" — o alvo não mede a si
#      mesmo (a armadilha da #1155).
#
# Casos 16 em diante — os PRs ABERTOS, inclusive de fork (19/09/2026). Os números abaixo
# SÃO os dos casos no corpo:
#  16. a cabeça de um PR aberto de FORK entra no universo (fork não mora em refs/remotes).
#      Medido: o #677 (fork) tinha o 0333 e o gate, que só via refs/heads + refs/remotes,
#      diria "livre" ao dono do #1176. É o controle positivo da POPULAÇÃO.
#  17. cabeça de PR FECHADO não entra: refs/pull/*/head persiste depois do fechamento
#      (965 cabeças contra 43 PRs abertos, medido) e empurraria o "próximo livre".
#  18. PR listado cuja cabeça não pôde ser buscada vira "NÃO MEDIDO: #N" — nunca pulado.
#  19. sem gh utilizável, os PRs abertos são declarados NÃO MEDIDO (como o clone raso).
#  20. número de 4 dígitos no SLUG não vira NNNN (`_0277_relatorio_2024_` não dá 2025).
#  21. a cabeça do PR de quem roda (ancestral do HEAD) não acusa o próprio número.
#  22. rodadas simultâneas não se atropelam, e a sobra de rodada MORTA é varrida.
#  23. a main é MEMBRO da população; só o que um PR ACRESCENTA à main é dele.
#  24. zero PRs abertos é medição (0 listado), não falha.
#  25. gh que sai 0 sem número nenhum é NÃO MEDIDO, não "zero PRs".
#  26. colisão de TIMESTAMP com PR aberto também avisa no arquivo.
#  27. origin = FORK (clone de contribuidor): os PRs são do repositório PAI, e as cabeças
#      vêm de lá — senão o gate consulta o fork, acha zero e chama isso de medição.
#  28. o próprio PR depois de AMEND não se acusa (nem pelo nome idêntico do arquivo, nem
#      pela cabeça publicada com o número antigo).
#  29. cópia de PR em refs/remotes/*/pr/N (fetch de triagem) não traz fantasma de volta.
#  30. mais de 30 PRs abertos: o gate pede --limit, senão o gh corta calado em 30.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE_ORIGEM="$RAIZ/scripts/checar-colisao-de-migration.sh"

falhas=0; casos=0
ok()   { casos=$((casos+1)); printf '  ✓ %s\n' "$1"; }
falha(){ casos=$((casos+1)); falhas=$((falhas+1)); printf '  ✗ %s\n     %s\n' "$1" "${2:-}"; }
assert_exit() { if [ "$1" = "$2" ]; then ok "$3"; else falha "$3" "exit esperado $2, veio $1"; fi; }
assert_contains() { if grep -qF -- "$2" <<<"$1"; then ok "$3"; else falha "$3" "esperava conter '$2'; saída: $(head -c 500 <<<"$1")"; fi; }
assert_not_contains() { if grep -qF -- "$2" <<<"$1"; then falha "$3" "não esperava '$2'; saída: $(head -c 500 <<<"$1")"; else ok "$3"; fi; }

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

# ── gh FALSO, para TODOS os casos: sem rede e sem depender do gh de quem roda ──────────
# Ele HONRA o contrato da chamada real — se ignorasse os argumentos, trocar `--state open`
# por `--state all` ou esquecer o `--limit` passaria verde (achado da revisão de 19/09):
#   pr list  --state open|closed|merged|all  (PRs de FAKE_GH_PRS são abertos; os de
#            FAKE_GH_PRS_FECHADOS, fechados) · --limit N (padrão do gh: 30, e corta calado)
#            · --json com `number` · --repo: com FAKE_GH_PAI, SÓ o pai tem PRs (o fork
#            responde lista vazia, como o GitHub). Entrada "N" é PR de fork; "N:ramo" é PR
#            deste repositório, na branch "ramo". Saída: "N <isCrossRepository> <ramo>".
#   repo view <host/slug>  → o slug do PAI se o consultado é um fork; vazio se não é.
# Com FAKE_GH_PRS AUSENTE, finge gh indisponível: é o estado do CI, que não exporta
# GH_TOKEN para o passo do gate. FAKE_GH_SEM_NUMERO=1: sai 0 sem número nenhum.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'GH'
#!/usr/bin/env bash
[ -n "${FAKE_GH_PRS+x}" ] || { echo "gh falso: indisponível neste teste" >&2; exit 1; }
case "${1:-} ${2:-}" in
  "repo view")
    if [ -n "${FAKE_GH_PAI:-}" ] && [ "${3:-}" != "github.com/$FAKE_GH_PAI" ]; then echo "$FAKE_GH_PAI"; fi
    exit 0 ;;
  "pr list")
    shift 2; estado=""; limite=30; repo=""; json=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --state) estado="$2"; shift 2 ;; --limit) limite="$2"; shift 2 ;;
        --repo) repo="$2"; shift 2 ;;    --json) json="$2"; shift 2 ;;
        --jq) shift 2 ;; *) echo "gh falso: argumento fora do contrato: $1" >&2; exit 1 ;;
      esac
    done
    case "$json" in *number*) ;; *) echo "gh falso: --json sem number" >&2; exit 1 ;; esac
    [ "${FAKE_GH_SEM_NUMERO:-}" = 1 ] && { echo "aviso: há uma versão nova do gh"; exit 0; }
    if [ -n "${FAKE_GH_PAI:-}" ] && [ "$repo" != "github.com/$FAKE_GH_PAI" ]; then exit 0; fi
    case "$estado" in
      open) lista="$FAKE_GH_PRS" ;; closed|merged) lista="${FAKE_GH_PRS_FECHADOS:-}" ;;
      all) lista="$FAKE_GH_PRS ${FAKE_GH_PRS_FECHADOS:-}" ;;
      *) echo "gh falso: --state '$estado' fora do contrato" >&2; exit 1 ;;
    esac
    n=0
    for e in $lista; do
      n=$((n + 1)); [ "$n" -gt "$limite" ] && break
      if [ "${e#*:}" = "$e" ]; then echo "$e true -"; else echo "${e%%:*} false ${e#*:}"; fi
    done
    exit 0 ;;
esac
echo "gh falso: comando fora do contrato: $*" >&2; exit 1
GH
chmod +x "$TMP/bin/gh"
export PATH="$TMP/bin:$PATH"
unset FAKE_GH_PRS FAKE_GH_PRS_FECHADOS FAKE_GH_PAI FAKE_GH_SEM_NUMERO

# ── um "repositório principal" mínimo, com duas migrations já aplicadas ──────────────
principal="$TMP/principal"; mkdir -p "$principal/supabase/migrations"
git -C "$principal" init -q -b main
printf 'select 1;\n' > "$principal/supabase/migrations/20260101120000_0262_existente.sql"
printf 'select 2;\n' > "$principal/supabase/migrations/20260102090000_0261_anterior.sql"
printf '# leia\n' > "$principal/README.md"
git -C "$principal" add -A && git -C "$principal" commit -q -m "base"

# ── clone local com retry: a falha medida NÃO é do gate, é do runner ────────────────
# Achado #1403: o job verify-parte(2) do PR #1394 reprovou com
#   fatal: failed to copy file to '.../c26/.git/objects/pack/tmp_rev_XXXXXXXX': No such
#   file or directory
#   fatal: not a git repository (or any of the parent directories): .git
# — no `git clone -q "$principal" "$c"` do caso 26, dentro DESTE arquivo de teste, não no
# gate sob prova. A issue supunha rede (gh/PRs abertos); é o oposto: o cabeçalho deste
# arquivo já diz "sem rede", e o clone é 100% local. É I/O do runner lendo `$principal`
# — o único repositório que a suíte inteira compartilha e para o qual `pr_no_principal()`
# empurra `git push` entre um `clonar()` e outro. Não reproduzido localmente (falha rara:
# 1 run em várias); a defesa é a mesma que `scripts/checar-colisao-de-migration.sh` já usa
# para outra falha transiente (fetch de cabeça de PR): repetir antes de desistir, e nomear
# o desfecho se as tentativas se esgotarem — nunca seguir com um clone pela metade.
# O retry ESTREITA a janela — não a encerra, e não prova a causa: ele só protege o clone
# que passa por AQUI. Um `git clone` cru em qualquer caso reabre o flake um caso adiante
# (medido: injetando a falha do log só no clone do caso 27, a suíte ia a 3 de 102 casos
# vermelhos). Quem vigia isso é o caso 32, no fim do arquivo: ele reprova todo `git clone`
# em posição de comando fora de clonar_com_retry(). (Um `grep -n 'git clone'` cru NÃO serve
# de sonda: conta os comentários e a mensagem de erro, que citam o comando sem rodá-lo.)
# Uma causa candidata JÁ foi descartada por medição: o `gc --auto` que o receive-pack
# dispara no `git push` de pr_no_principal() não roda neste fixture — o push deixa 6
# objetos SOLTOS e ZERO packs (`git count-objects -v`) contra `gc.auto=6700`, e nenhum
# `run_command: ... gc` aparece sob `GIT_TRACE=1`. `git -c gc.auto=0 push` seria inerte.
clonar_com_retry() { # $1 = origem, $2 = destino, $3 = flag extra opcional (ex.: --bare)
  local tentativas=3 i rc
  for i in $(seq 1 "$tentativas"); do
    rm -rf "$2"
    # a tentativa FINAL deixa o stderr passar: se as 3 falharem, a causa tem de aparecer
    # no log de quem roda — erro engolido é o anti-pattern nº 14 do CLAUDE.md.
    if [ "$i" -lt "$tentativas" ]; then
      git clone -q ${3:+"$3"} "$1" "$2" 2>/dev/null; rc=$?
    else
      git clone -q ${3:+"$3"} "$1" "$2"; rc=$?
    fi
    # O exit do clone é o critério; o rev-parse sozinho NÃO basta: um clone que sai 128 na
    # fase de checkout ("Clone succeeded, but checkout failed") deixa o `.git` no disco, e o
    # rev-parse responderia 0 com a árvore pela metade (caso 33).
    # `--git-dir` responde para clone comum E para `--bare` (lá não há work tree, e
    # `--is-inside-work-tree` imprimiria `false` saindo 0 — passaria por acidente).
    [ "$rc" -eq 0 ] && git -C "$2" rev-parse --git-dir >/dev/null 2>&1 && return 0
    [ "$i" -lt "$tentativas" ] && sleep 0.2
  done
  return 1
}

# Todo clone da suíte passa por aqui: origem, destino e o desfecho nomeado se as três
# tentativas se esgotarem — nunca seguir com um clone pela metade.
clonar_ou_falhar() { # $1 = origem, $2 = destino, $3 = flag extra opcional
  clonar_com_retry "$@" \
    || { echo "clonar: 'git clone $1 $2' falhou 3x — provável I/O transiente do runner, não do gate" >&2; exit 90; }
}

clonar() { # $1 = destino (traz o gate SOB PROVA, a versão da árvore de trabalho)
  clonar_ou_falhar "$principal" "$1"
  mkdir -p "$1/scripts"; cp "$GATE_ORIGEM" "$1/scripts/checar-colisao-de-migration.sh"
}
gate() { ( cd "$1" && bash scripts/checar-colisao-de-migration.sh "${2:-origin/main}" 2>&1 ); }
migrar() { printf 'select 9;\n' > "$1/supabase/migrations/$2"; }
commit() { git -C "$1" add -A >/dev/null && git -C "$1" commit -q -m "$2"; }

echo "1. o instrumento está vivo: colisão real de NNNN reprova nomeando número e arquivos"
c="$TMP/c1"; clonar "$c"; git -C "$c" switch -q -c fix/colide
migrar "$c" "20260916120000_0262_colide.sql"; commit "$c" "migration com NNNN tomado"
saida="$(gate "$c")"; code=$?
assert_exit "$code" 1 "NNNN já tomado na base reprova"
assert_contains "$saida" "NNNN=0262" "acusa QUAL número"
assert_contains "$saida" "20260916120000_0262_colide.sql" "acusa QUAL arquivo do PR"
assert_contains "$saida" "20260101120000_0262_existente.sql" "acusa QUAL arquivo da base já ocupava o número"
assert_contains "$saida" "::error file=supabase/migrations/20260916120000_0262_colide.sql::" "anota no arquivo do PR, inline no diff"

echo "2. NNNN livre passa"
c="$TMP/c2"; clonar "$c"; git -C "$c" switch -q -c fix/livre
migrar "$c" "20260916130000_0263_livre.sql"; commit "$c" "migration com NNNN livre"
saida="$(gate "$c")"; code=$?
assert_exit "$code" 0 "NNNN livre passa"
assert_contains "$saida" "OK" "diz que mediu"

echo "3. timestamp tomado na base reprova (o NNNN é outro)"
c="$TMP/c3"; clonar "$c"; git -C "$c" switch -q -c fix/ts
migrar "$c" "20260101120000_0264_ts_tomado.sql"; commit "$c" "migration com timestamp tomado"
saida="$(gate "$c")"; code=$?
assert_exit "$code" 1 "timestamp já usado na base reprova"
assert_contains "$saida" "timestamp 20260101120000" "acusa QUAL timestamp"
assert_contains "$saida" "20260101120000_0262_existente.sql" "acusa QUAL arquivo da base usa o timestamp"

echo "4. editar/reordenar migration existente passa (não acrescenta arquivo)"
c="$TMP/c4"; clonar "$c"; git -C "$c" switch -q -c fix/edita
printf '\n-- ajuste de comentário\n' >> "$c/supabase/migrations/20260101120000_0262_existente.sql"
commit "$c" "edita migration existente"
saida="$(gate "$c")"; code=$?
assert_exit "$code" 0 "edição de migration existente passa"
assert_not_contains "$saida" "CI REPROVADO" "não inventa colisão onde houve edição"

echo "5. git mv (renomear slug) passa"
c="$TMP/c5"; clonar "$c"; git -C "$c" switch -q -c fix/renomeia
git -C "$c" mv supabase/migrations/20260101120000_0262_existente.sql \
              supabase/migrations/20260101120000_0262_renomeada.sql
commit "$c" "renomeia slug da migration"
saida="$(gate "$c")"; code=$?
assert_exit "$code" 0 "renome passa (limite declarado, igual ao do hook: TRIAGEM.md:906)"

echo "6. merge da própria main passa (a main anda e entra na branch)"
c="$TMP/c6"; clonar "$c"; git -C "$c" switch -q -c fix/merge-main
migrar "$c" "20260916140000_0265_do_pr.sql"; commit "$c" "migration do PR"
migrar "$principal" "20260916150000_0266_da_main.sql"
git -C "$principal" add -A; git -C "$principal" commit -q -m "main anda"
git -C "$c" fetch -q origin main && git -C "$c" merge -q --no-edit FETCH_HEAD
saida="$(gate "$c")"; code=$?
assert_exit "$code" 0 "merge da própria main passa (a migration que veio da main não é adição do PR)"
assert_not_contains "$saida" "0266_da_main.sql" "não culpa o PR pela migration que a main trouxe"

echo "7. o caso do #804/#0161: número disputado que entra pela base"
c="$TMP/c7"; clonar "$c"; git -C "$c" switch -q -c fix/disputa
migrar "$c" "20260916160000_0268_lembrete.sql"; commit "$c" "PR A: 0268"
# outro PR mergeia o MESMO 0268 na main, com slug diferente: não há conflito textual
migrar "$principal" "20260916170000_0268_rascunho.sql"
git -C "$principal" add -A; git -C "$principal" commit -q -m "PR B: 0268 na main"
# (a) branch atrás da base: o `-M` pareia os dois arquivos (medido: R100), então o gate
#     não pode dar verde silencioso — ele declara a divergência
saida="$(gate "$c")"; code=$?
assert_exit "$code" 0 "branch atrás da base não vira acusação falsa"
assert_contains "$saida" "::warning::" "e não dá verde silencioso: declara o limite"
assert_contains "$saida" "andou depois do fork" "diz o que houve"
# (b) a árvore que o CI mede: base mergeada, como no merge ref do pull_request
git -C "$c" fetch -q origin main && git -C "$c" merge -q --no-edit FETCH_HEAD
saida="$(gate "$c")"; code=$?
assert_exit "$code" 1 "número disputado reprova na árvore do merge (o defeito da issue #285)"
assert_contains "$saida" "NNNN=0268" "acusa o número disputado"
assert_contains "$saida" "0268_lembrete.sql" "acusa o arquivo do PR"
assert_contains "$saida" "0268_rascunho.sql" "acusa o arquivo que entrou pela main"

echo "8. duplicata que JÁ existia na base não é do PR (linha de base, TRIAGEM.md:934)"
principal2="$TMP/principal2"; mkdir -p "$principal2/supabase/migrations"
git -C "$principal2" init -q -b main
printf 'select 1;\n' > "$principal2/supabase/migrations/20260101120000_0270_um.sql"
printf 'select 2;\n' > "$principal2/supabase/migrations/20260102090000_0270_dois.sql"
git -C "$principal2" add -A && git -C "$principal2" commit -q -m "base com divida herdada"
c="$TMP/c8"; clonar_ou_falhar "$principal2" "$c"
mkdir -p "$c/scripts"; cp "$GATE_ORIGEM" "$c/scripts/checar-colisao-de-migration.sh"
git -C "$c" switch -q -c fix/livre
migrar "$c" "20260916180000_0271_livre.sql"; commit "$c" "migration livre com dívida antiga na base"
saida="$(gate "$c")"; code=$?
assert_exit "$code" 0 "dívida herdada da base não reprova o PR"
assert_not_contains "$saida" "NNNN=0270" "não culpa o PR pela duplicata antiga"

echo "9. dois arquivos do MESMO PR com o mesmo NNNN reprovam (sonda de árvore nas adições)"
c="$TMP/c9"; clonar "$c"; git -C "$c" switch -q -c fix/gemeas
migrar "$c" "20260916190000_0272_um.sql"; migrar "$c" "20260916200000_0272_dois.sql"
commit "$c" "dois arquivos com o mesmo NNNN"
saida="$(gate "$c")"; code=$?
assert_exit "$code" 1 "NNNN repetido entre adições do mesmo PR reprova"
assert_contains "$saida" "NNNN=0272 aparece em 2 arquivos deste PR" "diz QUANTOS e quais"
assert_contains "$saida" "0272_um.sql" "nomeia o primeiro arquivo"
assert_contains "$saida" "0272_dois.sql" "nomeia o segundo arquivo"

echo "10. migration fora do padrão <14 dígitos>_<NNNN>_<slug>.sql reprova"
c="$TMP/c10"; clonar "$c"; git -C "$c" switch -q -c fix/nome
migrar "$c" "ajuste_de_agenda.sql"; commit "$c" "migration fora do padrão"
saida="$(gate "$c")"; code=$?
assert_exit "$code" 1 "nome sem NNNN reprova (sem número não há o que medir)"
assert_contains "$saida" "ajuste_de_agenda.sql" "acusa QUAL arquivo"

echo "11. sem ref da base, o gate busca a base sozinho (o clone do CI é --depth=1)"
c="$TMP/c11"; clonar "$c"; git -C "$c" switch -q -c fix/sem-base
migrar "$c" "20260916210000_0273_livre.sql"; commit "$c" "migration livre"
git -C "$c" update-ref -d refs/remotes/origin/main
if git -C "$c" rev-parse -q --verify origin/main >/dev/null 2>&1; then
  falha "o caso exige origem sem ref origin/main" "origin/main ainda resolve"
else
  ok "cenário montado: ref origin/main AUSENTE no clone"
fi
saida="$(gate "$c")"; code=$?
assert_exit "$code" 0 "sem origin/main, o gate busca a base e mede (verde legítimo)"
if git -C "$c" rev-parse -q --verify origin/main >/dev/null 2>&1; then
  ok "o gate reconstruiu refs/remotes/origin/main sozinho"
else
  falha "o gate reconstruiu refs/remotes/origin/main sozinho" "ref continua ausente"
fi

echo "12. não conseguir medir REPROVA declarando o NÃO MEDIDO (nunca verde silencioso)"
c="$TMP/c12"; clonar "$c"; git -C "$c" switch -q -c fix/nao-medido
migrar "$c" "20260916220000_0274_livre.sql"; commit "$c" "migration livre"
saida="$(gate "$c" "origin/nao-existe")"; code=$?
assert_exit "$code" 2 "base imensurável reprova com exit 2 (distinto de colisão)"
assert_contains "$saida" "NÃO MEDIDO" "declara o não medido em vez de passar em silêncio"
assert_contains "$saida" "git fetch origin origin/nao-existe" "diz o comando do conserto"

# O commit() varre o gate copiado para dentro da árvore; o switch de branch seguinte o
# remove (ficou tracked na branch que ficou para trás). Re-arma a cópia antes de medir.
rearmar_gate() { rm -rf "$1/scripts"; mkdir -p "$1/scripts"; cp "$GATE_ORIGEM" "$1/scripts/"; }

echo "13. outra ref do clone levanta o teto: o conselho salta e nomeia QUEM tem"
c="$TMP/c13"; clonar "$c"
git -C "$c" switch -q -c outra/resgate
migrar "$c" "20260916230000_0275_resgate.sql"; commit "$c" "branch local de resgate com 0275"
git -C "$c" switch -q -c fix/do-pr origin/main
migrar "$c" "20260916233000_0274_do_pr.sql"; commit "$c" "PR com 0274"
rearmar_gate "$c"
saida="$(gate "$c")"; code=$?
assert_exit "$code" 0 "outra ref não reprova o PR — empurra o próximo livre"
assert_contains "$saida" "NNNN=0276" "o conselho pula o número que a outra ref tomou"
assert_contains "$saida" "refs/heads/outra/resgate" "nomeia QUEM tem o número que forçou o salto"
assert_contains "$saida" "1 outra(s) ref(s)" "declara a régua ampliada na própria saída"

echo "14. clone sem outras refs declara que NÃO as mediu (o raso do CI degrada limpo)"
c="$TMP/c14"; clonar "$c"; git -C "$c" switch -q -c fix/sozinho
migrar "$c" "20260916234000_0274_livre.sql"; commit "$c" "migration livre"
saida="$(gate "$c")"; code=$?
assert_exit "$code" 0 "sem outras refs o gate segue medindo (degradação limpa)"
assert_contains "$saida" "NÃO foram medidos" "declara o limite do conselho na própria saída"
assert_contains "$saida" "confira com a triagem antes de renomear" "diz o que fazer antes de confiar no número"

echo "15. ref que resolve para o próprio HEAD não vira 'quem tem' (o alvo não mede a si mesmo)"
c="$TMP/c15"; clonar "$c"
git -C "$c" switch -q -c outra/resgate
migrar "$c" "20260916235000_0275_resgate.sql"; commit "$c" "branch local de resgate com 0275"
git -C "$c" switch -q -c fix/do-pr origin/main
migrar "$c" "20260916235500_0274_do_pr.sql"; commit "$c" "PR com 0274"
git -C "$c" branch espelho-do-head fix/do-pr
rearmar_gate "$c"
saida="$(gate "$c")"; code=$?
assert_exit "$code" 0 "espelho do HEAD não interfere na medição"
assert_not_contains "$saida" "espelho-do-head" "não nomeia ref que é o próprio HEAD"
assert_contains "$saida" "refs/heads/outra/resgate" "só o dono de verdade é nomeado"

# ── PRs abertos, inclusive de fork (refs/pull/N/head) ─────────────────────────────────
# Uma cabeça de PR no principal, como o GitHub guarda: refs/pull/N/head. `git clone` NÃO
# traz refs/pull — igual ao clone real —, então só o gate buscando é que a enxerga.
pr_no_principal() { # $1 = número do PR, $2 = nome da migration que a cabeça dele carrega
  local w="$TMP/cabeca-pr-$1"
  clonar_ou_falhar "$principal" "$w"
  printf 'select %s;\n' "$1" > "$w/supabase/migrations/$2"
  git -C "$w" add -A >/dev/null && git -C "$w" commit -q -m "PR #$1"
  # O push ALIMENTA os objetos de $principal — é o repositório que TODO clonar() lê
  # depois, então uma falha transiente aqui também não pode virar clone pela metade.
  local tentativas=3 i push_ok=0
  for i in $(seq 1 "$tentativas"); do
    git -C "$w" push -q origin "HEAD:refs/pull/$1/head" 2>/dev/null && { push_ok=1; break; }
    [ "$i" -lt "$tentativas" ] && sleep 0.2
  done
  [ "$push_ok" = 1 ] || { echo "pr_no_principal: push para refs/pull/$1/head falhou 3x" >&2; exit 90; }
}
gate_prs() { # $1 = PRs abertos que o gh falso lista, $2 = clone
  ( export FAKE_GH_PRS="$1"; cd "$2" && bash scripts/checar-colisao-de-migration.sh origin/main 2>&1 )
}
pr_no_principal 7 "20260917100000_0276_do_fork.sql"
pr_no_principal 9 "20260917120000_0400_abandonado.sql"

echo "16. PR aberto de FORK com o mesmo NNNN: o gate o enxerga e nomeia (não reprova)"
c="$TMP/c16"; clonar "$c"; git -C "$c" switch -q -c fix/pr
migrar "$c" "20260917110000_0276_meu.sql"; commit "$c" "PR com o 0276 que o fork também tem"
if git -C "$c" rev-parse -q --verify refs/pull/7/head >/dev/null 2>&1; then
  falha "o caso exige clone SEM refs/pull (como o clone real)" "refs/pull/7/head já existe no clone"
else
  ok "cenário montado: o clone não traz refs/pull, igual ao do GitHub"
fi
saida="$(gate_prs "7" "$c")"; code=$?
assert_exit "$code" 0 "número de outro PR não reprova — quem entrar primeiro fica"
# Âncora no ARQUIVO do PR: o gate velho já emite um ::warning genérico ("não foram
# medidos"), e "::warning" solto passaria sem ter visto fork nenhum. E "NNNN=0277" aqui
# também não provaria nada — o próprio PR tem 0276. Quem prova o teto vindo do fork é o 17.
assert_contains "$saida" "::warning file=supabase/migrations/20260917110000_0276_meu.sql::NNNN=0276" "avisa NO ARQUIVO que colide"
assert_contains "$saida" "PR aberto #7" "nomeia O PR que tem o mesmo número"

echo "17. cabeça de PR FECHADO não entra: a população é a lista de ABERTOS, nunca o curinga"
c="$TMP/c17"; clonar "$c"; git -C "$c" switch -q -c fix/pr
migrar "$c" "20260917130000_0263_meu.sql"; commit "$c" "PR com número livre"
# O #9 é FECHADO para o gh falso: ele só aparece se o gate pedir --state all/closed. Assim
# este caso reprova tanto o curinga refs/pull/* quanto a troca de `--state open`.
export FAKE_GH_PRS_FECHADOS="9"
saida="$(gate_prs "7" "$c")"; code=$?
unset FAKE_GH_PRS_FECHADOS
assert_exit "$code" 0 "PR com número livre passa"
assert_contains "$saida" "NNNN=0277" "o teto vem do PR ABERTO #7"
assert_not_contains "$saida" "0401" "o 0400 do PR fechado #9 não empurra o próximo livre"
assert_not_contains "$saida" "#9" "o PR fechado não aparece em lugar nenhum"

echo "18. PR listado cuja cabeça não pôde ser buscada: NÃO MEDIDO nomeado, e a soma aparece"
c="$TMP/c18"; clonar "$c"; git -C "$c" switch -q -c fix/pr
migrar "$c" "20260917140000_0263_meu.sql"; commit "$c" "PR com número livre"
saida="$(gate_prs "7 8" "$c")"; code=$?
assert_exit "$code" 0 "uma cabeça imensurável não reprova o PR (é informação, não ação)"
assert_contains "$saida" "NÃO MEDIDO: #8" "nomeia QUAL PR ficou de fora"
assert_contains "$saida" "2 listado(s), 1 medido(s)" "declara a soma: listados contra medidos"
assert_contains "$saida" "NNNN=0277" "o que foi medido continua valendo"

echo "19. sem gh utilizável, o universo de PRs abertos é declarado NÃO MEDIDO"
c="$TMP/c19"; clonar "$c"; git -C "$c" switch -q -c fix/pr
migrar "$c" "20260917150000_0263_meu.sql"; commit "$c" "PR com número livre"
saida="$(gate "$c")"; code=$?
assert_exit "$code" 0 "sem gh o gate segue medindo o resto (degradação limpa)"
assert_contains "$saida" "NÃO MEDIDO: PRs abertos" "declara que os PRs abertos ficaram de fora"

echo "20. número de 4 dígitos no SLUG não vira NNNN"
c="$TMP/c20"; clonar "$c"
git -C "$c" switch -q -c outra/relatorio
migrar "$c" "20260917160000_0277_relatorio_2024_anual.sql"; commit "$c" "slug com ano"
git -C "$c" switch -q -c fix/pr origin/main
migrar "$c" "20260917170000_0263_meu.sql"; commit "$c" "PR com número livre"
rearmar_gate "$c"
saida="$(gate "$c")"; code=$?
assert_exit "$code" 0 "PR com número livre passa"
assert_contains "$saida" "NNNN=0278" "o teto é o NNNN da outra ref (0277), não o ano do slug"
assert_not_contains "$saida" "NNNN=2025" "o 2024 do slug não é número de migration"

echo "21. a cabeça do PR de quem roda (ancestral do HEAD) não acusa o próprio número"
c="$TMP/c21"; clonar "$c"; git -C "$c" switch -q -c fix/meu
migrar "$c" "20260917180000_0263_meu.sql"; commit "$c" "PR com 0263"
git -C "$c" push -q origin "HEAD:refs/pull/5/head"
printf 'mais uma linha\n' >> "$c/README.md"; commit "$c" "commit local ainda não publicado"
saida="$(gate_prs "5" "$c")"; code=$?
assert_exit "$code" 0 "o próprio PR não reprova a si mesmo"
assert_not_contains "$saida" "PR aberto #5" "a cabeça do próprio PR não vira 'quem tem'"

echo "22. duas rodadas ao mesmo tempo não se atropelam (worktrees compartilham as refs)"
# Todo worktree de um repositório vê as MESMAS refs. Uma rodada que limpa refs/colisao-pr
# inteiro apaga as cabeças de outra rodada no meio da medição — com 20 sessões numa
# máquina, isso não é hipótese. A sobra de OUTRA rodada tem de sobreviver, e não pode
# entrar na população desta.
# Namespaces NUMÉRICOS, com a forma de uma rodada real (refs/colisao-pr/<PID>/N): um nome
# como "outra-rodada" não casaria [0-9]+, e uma limpeza "de todas as rodadas por PID" passaria
# verde (achado da revisão de 19/09). A viva é este shell ($$); a morta é um PID que acabou.
( exit 0 ) & morto=$!; wait "$morto" 2>/dev/null
c="$TMP/c22"; clonar "$c"; git -C "$c" switch -q -c fix/pr
migrar "$c" "20260917190000_0263_meu.sql"; commit "$c" "PR com número livre"
git -C "$c" fetch -q origin "+refs/pull/9/head:refs/colisao-pr/$$/9"
git -C "$c" fetch -q origin "+refs/pull/9/head:refs/colisao-pr/$morto/9"
saida="$(gate_prs "7" "$c")"; code=$?
assert_exit "$code" 0 "PR com número livre passa"
assert_not_contains "$saida" "0401" "a cabeça de OUTRA rodada (viva ou morta) não entra na população"
if git -C "$c" rev-parse -q --verify "refs/colisao-pr/$$/9" >/dev/null 2>&1; then
  ok "a ref da rodada VIVA sobreviveu a esta"
else
  falha "a ref da rodada VIVA sobreviveu a esta" "a limpeza desta rodada apagou refs/colisao-pr/$$/9"
fi
if git -C "$c" rev-parse -q --verify "refs/colisao-pr/$morto/9" >/dev/null 2>&1; then
  falha "a sobra da rodada MORTA foi varrida" "refs/colisao-pr/$morto/9 continua lá"
else
  ok "a sobra da rodada MORTA foi varrida"
fi
sobra="$(git -C "$c" for-each-ref --format='%(refname)' refs/colisao-pr | grep -v "^refs/colisao-pr/$$/" || true)"
if [ -z "$sobra" ]; then ok "esta rodada não deixou nada dela"
else falha "esta rodada não deixou nada dela" "sobrou: $sobra"; fi

echo "23. dois conjuntos para duas funções: a main é MEMBRO da população, e só o que o PR"
echo "    ACRESCENTA a ela é DELE — herdar o número da main não faz um PR ser 'quem tem'"
# Toda cabeça de PR carrega as migrations da main que herdou. Atribuir pelo conjunto inteiro
# nomearia, numa colisão com a main, todo PR aberto que já trouxe a main — como se o número
# fosse deles. O #7 aqui só herdou o 0262 (e acrescentou o 0276).
c="$TMP/c23"; clonar "$c"; git -C "$c" switch -q -c fix/colide-com-a-main
migrar "$c" "20260917200000_0262_colide.sql"; commit "$c" "PR com o 0262 que a main já tem"
saida="$(gate_prs "7" "$c")"; code=$?
assert_exit "$code" 1 "colisão com a MAIN continua reprovando"
assert_contains "$saida" "NNNN=0262 já existe em 'origin/main'" "e acusa a main, que é quem tem"
# A asserção mira a LINHA da atribuição, não o nome do PR: "PR aberto #7" solto também casa com
# o ::notice legítimo do teto (o #7 ACRESCENTA o 0276) — e foi por ele que a primeira versão
# desta asserção ficou vermelha, pelo motivo errado.
assert_not_contains "$saida" "NNNN=0262 também está em" "o PR que só HERDOU o 0262 da main não é nomeado"
assert_contains "$saida" "(o teto medido) existe em: PR aberto #7" "o que o #7 ACRESCENTOU (0276) segue atribuído a ele"
assert_contains "$saida" "NNNN=0277" "e segue empurrando o próximo livre (a main e os PRs como população)"

echo "24. zero PRs abertos é MEDIÇÃO (0 listado), não falha"
c="$TMP/c24"; clonar "$c"; git -C "$c" switch -q -c fix/pr
migrar "$c" "20260917200500_0263_meu.sql"; commit "$c" "PR com número livre"
saida="$(gate_prs "" "$c")"; code=$?
assert_exit "$code" 0 "PR com número livre passa"
assert_contains "$saida" "0 listado(s), 0 medido(s)" "declara a medição vazia com o número"
assert_not_contains "$saida" "NÃO MEDIDO: PRs abertos" "lista vazia não é gh indisponível"

echo "25. gh que sai 0 SEM número nenhum é NÃO MEDIDO — não 'zero PRs'"
c="$TMP/c25"; clonar "$c"; git -C "$c" switch -q -c fix/pr
migrar "$c" "20260917201000_0263_meu.sql"; commit "$c" "PR com número livre"
export FAKE_GH_SEM_NUMERO=1; saida="$(gate_prs "7" "$c")"; code=$?; unset FAKE_GH_SEM_NUMERO
assert_exit "$code" 0 "a resposta estranha do gh não reprova o PR"
assert_contains "$saida" "NÃO MEDIDO: PRs abertos" "saída sem número vira NÃO MEDIDO"
assert_not_contains "$saida" "0 listado(s)" "e não é apresentada como 'zero PRs'"

echo "26. colisão de TIMESTAMP com PR aberto também avisa no arquivo"
pr_no_principal 11 "20260917210000_0299_do_outro.sql"
c="$TMP/c26"; clonar "$c"; git -C "$c" switch -q -c fix/pr
migrar "$c" "20260917210000_0263_meu.sql"; commit "$c" "PR com o timestamp que o #11 usa"
saida="$(gate_prs "11" "$c")"; code=$?
assert_exit "$code" 0 "timestamp de outro PR não reprova"
assert_contains "$saida" "::warning file=supabase/migrations/20260917210000_0263_meu.sql::timestamp 20260917210000 também está em: PR aberto #11" "avisa o timestamp no arquivo, nomeando o PR"

echo "27. origin = FORK (clone de contribuidor): os PRs são do PAI, e as cabeças vêm de lá"
# O contribuidor clona o PRÓPRIO fork: origin = fork, e os PRs moram no repositório pai. Sem
# resolver o pai, o gate lista os PRs do fork (zero) e chama isso de medição. As URLs são as
# do GitHub, e o insteadOf leva cada uma para um diretório local — sem rede.
fork_repo="$TMP/fork-contrib"; clonar_ou_falhar "$principal" "$fork_repo" --bare
c="$TMP/c27"; clonar_ou_falhar "$fork_repo" "$c"
git -C "$c" config remote.origin.url "https://github.com/contrib/DeskcommCRM.git"
git -C "$c" config "url.$fork_repo.insteadOf" "https://github.com/contrib/DeskcommCRM.git"
git -C "$c" config "url.$principal.insteadOf" "https://github.com/up/DeskcommCRM.git"
mkdir -p "$c/scripts"; cp "$GATE_ORIGEM" "$c/scripts/checar-colisao-de-migration.sh"
git -C "$c" switch -q -c fix/pr
migrar "$c" "20260917220000_0276_meu.sql"; commit "$c" "PR com o 0276 que o #7 do pai também tem"
export FAKE_GH_PAI="up/DeskcommCRM"; saida="$(gate_prs "7" "$c")"; code=$?; unset FAKE_GH_PAI
assert_exit "$code" 0 "número de PR aberto do pai não reprova"
assert_contains "$saida" "PR aberto #7" "enxerga o PR do repositório PAI"
assert_contains "$saida" "em up/DeskcommCRM" "declara QUAL repositório consultou"
assert_not_contains "$saida" "0 listado(s)" "não consulta o fork e chama o zero de medição"

echo "28. o próprio PR depois de AMEND não se acusa"
# (a) amend só da mensagem: a cabeça publicada tem o MESMO arquivo, mas deixou de ser ancestral
#     do HEAD. O #5 é listado como fork, então só a regra do nome idêntico o protege aqui.
c="$TMP/c28a"; clonar "$c"; git -C "$c" switch -q -c fix/meu
migrar "$c" "20260917230000_0263_meu.sql"; commit "$c" "PR com 0263"
git -C "$c" push -q origin "+HEAD:refs/pull/5/head"   # o 21 já publicou ali: sem + é recusado calado
if [ "$(git -C "$principal" rev-parse refs/pull/5/head)" = "$(git -C "$c" rev-parse HEAD)" ]; then
  ok "cenário montado: a cabeça publicada do #5 é o commit de antes do amend"
else falha "cenário montado: a cabeça publicada do #5 é o commit de antes do amend" "o push não pousou"; fi
git -C "$c" commit -q --amend -m "PR com 0263 (mensagem nova)"
saida="$(gate_prs "5" "$c")"; code=$?
assert_exit "$code" 0 "o amend não reprova"
assert_not_contains "$saida" "também está em: PR aberto #5" "a cabeça com o MESMO arquivo não é outro dono"
# (b) renumerado por amend: a cabeça publicada tem o número ANTIGO (0290). O #5 é deste
#     repositório, na branch em que estou — só a exclusão pelo número do próprio PR o tira.
c="$TMP/c28b"; clonar "$c"; git -C "$c" switch -q -c fix/meu
migrar "$c" "20260917230500_0290_meu.sql"; commit "$c" "PR com 0290"
git -C "$c" push -q origin "+HEAD:refs/pull/5/head"
git -C "$c" mv "supabase/migrations/20260917230500_0290_meu.sql" "supabase/migrations/20260917230500_0263_meu.sql"
git -C "$c" commit -q --amend -m "PR renumerado para 0263"
saida="$(gate_prs "5:fix/meu" "$c")"; code=$?
assert_exit "$code" 0 "o renumerado passa"
assert_not_contains "$saida" "PR aberto #5" "o número antigo do próprio PR não vira 'quem tem'"
assert_not_contains "$saida" "NNNN=0291" "o 0290 antigo do próprio PR não empurra o próximo livre"
# O esperado é o teto da MAIN + 1, medido agora: a main do principal ANDA ao longo desta suíte
# (o caso do #804 mescla um 0268 nela), e um número escrito à mão aqui travaria a ordem dos casos.
teto_main="$(git -C "$principal" ls-tree -r --name-only main -- supabase/migrations \
  | sed -nE 's#^.*/[0-9]{14}_([0-9]{4})_.*$#\1#p' | sort -n | tail -1)"
assert_contains "$saida" "NNNN=$(printf '%04d' $((10#$teto_main + 1)))" "o próximo livre é o teto da main + 1 (a main anda nesta suíte: $teto_main)"

echo "29. cópia de PR em refs/remotes/*/pr/N (fetch de triagem) não traz fantasma de volta"
c="$TMP/c29"; clonar "$c"; git -C "$c" switch -q -c fix/pr
migrar "$c" "20260917233000_0263_meu.sql"; commit "$c" "PR com número livre"
git -C "$c" fetch -q origin "+refs/pull/9/head:refs/remotes/origin/pr/9"
saida="$(gate_prs "7" "$c")"; code=$?
assert_exit "$code" 0 "PR com número livre passa"
assert_not_contains "$saida" "0401" "o 0400 do #9 fechado não volta pela cópia de triagem"
assert_contains "$saida" "NNNN=0277" "o teto segue vindo só dos PRs abertos"

echo "30. mais de 30 PRs abertos: o gate pede --limit, senão o gh corta calado em 30"
c="$TMP/c30"; clonar "$c"; git -C "$c" switch -q -c fix/pr
migrar "$c" "20260917234000_0263_meu.sql"; commit "$c" "PR com número livre"
saida="$(gate_prs "$(seq -s ' ' 101 131)" "$c")"; code=$?
assert_exit "$code" 0 "PRs imensuráveis não reprovam"
assert_contains "$saida" "31 listado(s)" "os 31 abertos foram listados, não os 30 do padrão do gh"

echo "31. branch local ANCESTRAL do HEAD, com o número de ANTES de uma renumeração, não sobe o teto"
# Isola o filtro de ancestral (`--no-merged HEAD`). A sabotagem de 19/09 mostrou que, depois da
# regra do "mesmo arquivo", NENHUM caso o isolava mais: o 21 passou a ser coberto pelas duas.
# Aqui o nome MUDOU (0290 → 0263), então a regra do mesmo arquivo não alcança — só o filtro.
c="$TMP/c31"; clonar "$c"; git -C "$c" switch -q -c fix/pr
migrar "$c" "20260917235500_0290_meu.sql"; commit "$c" "PR com 0290"
git -C "$c" branch retrato-antigo   # aponta para o commit com o 0290: ancestral do HEAD
git -C "$c" mv "supabase/migrations/20260917235500_0290_meu.sql" "supabase/migrations/20260917235500_0263_meu.sql"
commit "$c" "renumerado para 0263 (commit novo, não amend)"
saida="$(gate "$c")"; code=$?
assert_exit "$code" 0 "o renumerado passa"
assert_not_contains "$saida" "NNNN=0291" "o 0290 do retrato ANCESTRAL não sobe o próximo livre"
assert_not_contains "$saida" "refs/heads/retrato-antigo" "e o retrato ancestral não vira 'quem tem'"

echo "32. todo clone da suíte passa por clonar_com_retry(): nenhum 'git clone' cru fora dela"
# Um clone cru reabre o flake de I/O do #1403 um caso adiante — o #1413 blindou dois pontos e
# deixou três. Só conta `git clone` em POSIÇÃO DE COMANDO (início de linha ou depois de ; & |
# { ( then do): citação em comentário, crase ou mensagem de erro não é clone rodando.
crus="$(awk '/^clonar_com_retry\(\) \{/ {dentro=1}
  dentro { if (/^}/) dentro=0; next }
  /^[[:space:]]*#/ { next }
  /(^|[;&|{(]|then|do)[[:space:]]*git clone/ { print NR": "$0 }' "${BASH_SOURCE[0]}")"
if [ -z "$crus" ]; then ok "nenhum git clone fora do retry"
else falha "nenhum git clone fora do retry" "clone cru em: $crus"; fi

echo "33. clone que sai não-zero DEIXANDO o .git no disco não passa: o retry repete"
# "Clone succeeded, but checkout failed": o git sai 128 com o repositório criado e a árvore
# pela metade. Aqui a 1ª tentativa clona de verdade, apaga um arquivo rastreado e sai 128;
# as seguintes passam. Só o exit do clone separa isso de um clone inteiro.
d="$TMP/c33"; n33="$TMP/c33.tentativas"; : > "$n33"
( git() {
    if [ "$1" = clone ]; then
      echo x >> "$n33"; command git "$@" || return
      if [ "$(wc -l < "$n33")" -eq 1 ]; then rm -f "$d/supabase/migrations/"*; return 128; fi
      return 0
    fi
    command git "$@"
  }
  clonar_com_retry "$principal" "$d" )
code=$?
assert_exit "$code" 0 "a falha transiente de checkout é absorvida"
assert_exit "$(wc -l < "$n33" | tr -d ' ')" 2 "e absorvida REPETINDO o clone, não aceitando o da 1ª tentativa"
if [ -n "$(ls "$d/supabase/migrations/" 2>/dev/null)" ]; then ok "a árvore chega inteira"
else falha "a árvore chega inteira" "supabase/migrations vazio: seguiu com o clone pela metade"; fi

echo
if [ "$falhas" = 0 ]; then echo "colisao-de-migration: $casos casos, todos verdes"; exit 0
else echo "colisao-de-migration: $falhas de $casos casos vermelhos"; exit 1; fi
