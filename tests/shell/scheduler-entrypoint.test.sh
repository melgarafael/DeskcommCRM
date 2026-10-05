#!/usr/bin/env bash
# Gate do docker/scheduler/entrypoint.sh — o único artefato executável novo da
# doutrina de packaging, e o que ficou sem cobertura na primeira versão dela.
#
# O que ele guarda, e por que cada coisa:
#
# 1. O SEGREDO SOBREVIVE INTEIRO E LITERAL. O crond executa cada linha do crontab
#    por `/bin/sh -c`, então o valor é REAVALIADO na hora de disparar. A versão
#    anterior interpolava o INTERNAL_SECRET dentro de aspas duplas: um `$` no
#    valor virava expansão de variável (header truncado → todo cron respondendo
#    401 em silêncio) e uma crase virava substituição de comando — execução
#    arbitrária a cada minuto. Aqui o teste monta o header com um `sh` DE VERDADE,
#    como o crond faria, e compara byte a byte.
#
# 2. NENHUMA ROTA SE PERDE. O crontab saiu do `command:` inline do compose e veio
#    para cá; a contagem tem de bater com app/api/v1/cron. (A cerca principal é
#    tests/unit/cron-routes-scheduled.test.ts; esta aqui pega o caso em que o
#    arquivo GERADO diverge da lista escrita, que aquele teste não vê.)
#
# 3. FALHA FECHADA SEM SEGREDO. Sem INTERNAL_SECRET os crons responderiam 401 e
#    nada aconteceria — sem erro, sem log, sem sintoma. O script recusa subir.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

ENTRYPOINT="docker/scheduler/entrypoint.sh"
fail=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

check() {
  local nome="$1"; shift
  if "$@" >/dev/null 2>&1; then printf '  ✓ %s\n' "$nome"
  else printf '  ✗ %s\n' "$nome"; fail=1; fi
}

# `crond` dublado: o entrypoint termina em `exec crond`, que não existe no macOS
# nem no runner. Sem o dublê o script morreria DEPOIS de escrever o crontab — o
# arquivo estaria certo e o teste falharia por motivo errado.
mkdir -p "$TMP/bin"
printf '#!/bin/sh\nexit 0\n' > "$TMP/bin/crond"
chmod +x "$TMP/bin/crond"

rodar() { # $1 = valor de INTERNAL_SECRET ("" = ausente)
  local out="$TMP/crontab"
  : > "$out"
  if [ -z "$1" ]; then
    env -u INTERNAL_SECRET PATH="$TMP/bin:$PATH" CRONTAB_PATH="$out" \
      sh "$ENTRYPOINT" >"$TMP/saida" 2>&1
  else
    env INTERNAL_SECRET="$1" PATH="$TMP/bin:$PATH" CRONTAB_PATH="$out" \
      sh "$ENTRYPOINT" >"$TMP/saida" 2>&1
  fi
  echo $?
}

echo "scheduler: o crontab é gerado com todas as rotas"
RC="$(rodar 'segredo-simples')"
check "o entrypoint termina com sucesso" test "$RC" -eq 0
ROTAS_CODIGO="$(find app/api/v1/cron -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
ROTAS_CRONTAB="$(grep -oE 'api/v1/cron/[a-z0-9-]+' "$TMP/crontab" | sort -u | wc -l | tr -d ' ')"
check "as $ROTAS_CODIGO rotas do código estão no crontab (achei $ROTAS_CRONTAB)" \
  test "$ROTAS_CODIGO" -eq "$ROTAS_CRONTAB"
check "uma linha por cron, nenhuma vazia" \
  test "$(grep -c . "$TMP/crontab")" -eq "$(wc -l < "$TMP/crontab" | tr -d ' ')"

echo "scheduler: o segredo atravessa o sh do crond intacto"
# Os três caracteres que quebram interpolação ingênua, de uma vez só.
HOSTIL='seg`whoami`redo$HOME-com'\''aspa-e-"aspas"'
RC="$(rodar "$HOSTIL")"
check "gerou o crontab mesmo com segredo cheio de metacaractere" test "$RC" -eq 0

# A medição que importa: pegar a PRIMEIRA linha, tirar o prefixo de agendamento,
# e mandar um `sh` de verdade avaliá-la — exatamente o que o crond faz. O `curl`
# é dublado por um script que imprime o header que recebeu.
printf '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = "-H" ] && { printf "%%s" "$2"; exit 0; }; shift; done\nexit 1\n' > "$TMP/bin/curl"
chmod +x "$TMP/bin/curl"
LINHA="$(head -1 "$TMP/crontab")"
COMANDO="${LINHA#* * * * * }"                 # tira o agendamento de 5 campos
COMANDO="${COMANDO%% >/dev/null*}"            # tira a redireção
RECEBIDO="$(PATH="$TMP/bin:$PATH" sh -c "$COMANDO")"
ESPERADO="Authorization: Bearer ${HOSTIL}"
if [ "$RECEBIDO" = "$ESPERADO" ]; then
  printf '  ✓ o header chega ao curl byte a byte igual ao segredo do .env\n'
else
  printf '  ✗ o segredo foi corrompido pelo sh do crond\n'
  printf '     esperado: %s\n' "$ESPERADO"
  printf '     recebido: %s\n' "$RECEBIDO"
  fail=1
fi
# Controle negativo do próprio instrumento: se a crase tivesse sido executada, o
# crontab conteria a saída de `whoami` no lugar dela, não o texto literal.
check "a crase NÃO foi executada (está literal no arquivo)" \
  grep -q 'whoami' "$TMP/crontab"

echo "scheduler: sem INTERNAL_SECRET, recusa em vez de subir mudo"
RC="$(rodar '')"
check "sai com código 1" test "$RC" -eq 1
check "explica o motivo na saída" grep -q "INTERNAL_SECRET" "$TMP/saida"
check "não deixou crontab pela metade" test ! -s "$TMP/crontab"

echo "scheduler: uma falha de cron não some em silêncio (#1109)"
# Reexecuta o entrypoint (o bloco acima deixou o crontab vazio) e troca o
# `curl` por um dublê que FALHA como um 401 de verdade: `-f` sai 22 e `-S`
# imprime o status para o STDERR.
RC="$(rodar 'segredo-simples')"
check "gerou o crontab de novo" test "$RC" -eq 0
printf '#!/bin/sh\necho "curl: (22) The requested URL returned error: 401" >&2\nexit 22\n' > "$TMP/bin/curl"
chmod +x "$TMP/bin/curl"
LINHA_FALHA="$(grep -m1 'sync-model-catalog' "$TMP/crontab")"
# Roda a linha INTEIRA, exatamente como o `sh -c` do crond roda — sem cortar o
# `||` que é o objeto deste bloco.
if [ -n "$LINHA_FALHA" ]; then
  PATH="$TMP/bin:$PATH" sh -c "${LINHA_FALHA#* * * * * }" >"$TMP/falha.out" 2>"$TMP/falha.err"
else
  printf 'sem linha de sync-model-catalog no crontab\n' >"$TMP/falha.err"
fi
check "o STDOUT continua descartado (o corpo da resposta não vaza pro log)" \
  test ! -s "$TMP/falha.out"
check "o status do 401 chega ao STDERR (era isto que o 2>&1 engolia)" \
  grep -q 'returned error: 401' "$TMP/falha.err"
check "a mensagem nomeia a rota que falhou" \
  grep -q 'sync-model-catalog' "$TMP/falha.err"
check "a mensagem diz o que o operador deve conferir" \
  grep -q 'INTERNAL_SECRET' "$TMP/falha.err"

if [ "$fail" -eq 0 ]; then
  echo "OK — todas as provas passaram."
else
  echo "FALHOU."
fi
exit "$fail"
