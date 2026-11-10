#!/bin/bash
# Roda um pedaço do `pnpm test:shell`: SÓ um arquivo dele, ou tudo MENOS esse
# arquivo. As duas metades somam o script inteiro por construção. É o que o
# `verify-parte` do ci.yml chama, uma metade por parte (o porquê e a medida
# estão no cabeçalho do job). Localmente o comando continua `pnpm test:shell`.
#
# O `package.json` segue sendo a única lista: teste novo entra no `test:shell`
# e cai no lado `menos` sozinho, sem ninguém editar o CI. Que as metades somam
# o todo, sem repetir, é cobrado por
# tests/unit/test-shell-roda-os-validadores-do-kit.test.ts com LISTAR=1, que só
# imprime o pedaço.
#
# Uso: bash scripts/test-shell-parte.sh <so|menos> <arquivo>
set -euo pipefail
[ $# -eq 2 ] || { echo "uso: $0 <so|menos> <arquivo>" >&2; exit 2; }

# Falha fechada em três casos: modo desconhecido; arquivo que não está no
# script (renomeado: o `so` rodaria nada e o `menos` rodaria tudo, em silêncio);
# e elo que não é `bash <arquivo>` — um `cd x && bash y` cortado ao meio
# rodaria o `bash y` no diretório errado.
pedaco=$(node -e '
const [modo, arq] = process.argv.slice(1);
if (modo !== "so" && modo !== "menos") { console.error(`modo inválido: ${modo} (use so ou menos)`); process.exit(2); }
const cmds = require("./package.json").scripts["test:shell"].split(" && ");
const ruins = cmds.filter((c) => !/^bash [\w./-]+$/.test(c));
if (ruins.length) { console.error("test:shell tem elo que não é `bash <arquivo>`: " + ruins.join(" | ")); process.exit(2); }
const alvo = `bash ${arq}`;
if (cmds.filter((c) => c === alvo).length !== 1) { console.error(`${arq} não aparece exatamente uma vez no test:shell`); process.exit(2); }
console.log(cmds.filter((c) => (c === alvo) === (modo === "so")).join(" && "));
' "$1" "$2")

if [ "${LISTAR:-}" = 1 ]; then
  printf '%s\n' "$pedaco"
  exit 0
fi
# `pnpm exec` dá o mesmo PATH (node_modules/.bin) que o `pnpm test:shell` daria.
exec pnpm exec bash -c "$pedaco"
