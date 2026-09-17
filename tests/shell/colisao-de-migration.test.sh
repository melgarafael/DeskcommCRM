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

# ── um "repositório principal" mínimo, com duas migrations já aplicadas ──────────────
principal="$TMP/principal"; mkdir -p "$principal/supabase/migrations"
git -C "$principal" init -q -b main
git -C "$principal" config user.email "mantenedor@exemplo.com"; git -C "$principal" config user.name "Mantenedor"
printf 'select 1;\n' > "$principal/supabase/migrations/20260101120000_0262_existente.sql"
printf 'select 2;\n' > "$principal/supabase/migrations/20260102090000_0261_anterior.sql"
printf '# leia\n' > "$principal/README.md"
git -C "$principal" add -A && git -C "$principal" commit -q -m "base"

clonar() { # $1 = destino (traz o gate SOB PROVA, a versão da árvore de trabalho)
  rm -rf "$1"; git clone -q "$principal" "$1"
  git -C "$1" config user.email "alguem@fork.dev"; git -C "$1" config user.name "Pessoa"
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
git -C "$principal2" config user.email "mantenedor@exemplo.com"; git -C "$principal2" config user.name "Mantenedor"
printf 'select 1;\n' > "$principal2/supabase/migrations/20260101120000_0270_um.sql"
printf 'select 2;\n' > "$principal2/supabase/migrations/20260102090000_0270_dois.sql"
git -C "$principal2" add -A && git -C "$principal2" commit -q -m "base com divida herdada"
c="$TMP/c8"; rm -rf "$c"; git clone -q "$principal2" "$c"
git -C "$c" config user.email "alguem@fork.dev"; git -C "$c" config user.name "Pessoa"
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

echo
if [ "$falhas" = 0 ]; then echo "colisao-de-migration: $casos casos, todos verdes"; exit 0
else echo "colisao-de-migration: $falhas de $casos casos vermelhos"; exit 1; fi
