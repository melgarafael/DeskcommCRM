#!/usr/bin/env bash
# Prova da guarda de `scripts/test-db.sh` que recusa quando o `vitest` não está no PATH.
#
#   bash tests/shell/test-db-recusa-sem-vitest.test.sh
#
# ## O defeito que ela mata, medido em 2026-09-20
#
# `bash scripts/test-db.sh <arquivo>` (em vez de `pnpm test:db <arquivo>`) saía com
# **exit 127** e um log que parecia sucesso: o container subia, o baseline aplicava em
# install E update, a saída enchia de ✓, e a única linha vermelha era
# `vitest: comando não encontrado`, perdida no meio. Quem procurasse `Tests N failed`
# no rodapé não achava — porque a suíte NUNCA RODOU.
#
# É a classe "instrumento quebrado devolve zero": a ausência do instrumento se parece
# com "rodou e passou". Enquanto ela existia, qualquer medição de invariante feita por
# esse caminho podia ser falsa sem sinal nenhum.
#
# ## O que está sob prova
#
#   1. sem `vitest` no PATH, o script RECUSA (exit ≠ 0) — e recusa ANTES de subir
#      container, que é o que faz a recusa custar milissegundos;
#   2. a mensagem diz o que fazer (`pnpm test:db`), não só que algo faltou;
#   3. CONTROLE POSITIVO: com um `vitest` no PATH a guarda NÃO dispara — sem este caso,
#      uma guarda que recusasse sempre passaria no caso 1 e quebraria o CI inteiro.
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$RAIZ/scripts/test-db.sh"
falhas=0

checar() {
  local nome="$1" esperado="$2" obtido="$3"
  if [ "$esperado" = "$obtido" ]; then
    echo "  ok: $nome"
  else
    echo "  FALHOU: $nome — esperado '$esperado', obtido '$obtido'" >&2
    falhas=$((falhas + 1))
  fi
}

echo "== 1/3 · sem vitest no PATH, recusa e não sobe container"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# PATH mínimo, sem `node_modules/.bin`. O `docker` também fica fora: se a guarda
# deixasse passar, o script morreria adiante por outro motivo — e o caso perderia
# a capacidade de distinguir "recusou" de "tentou e quebrou".
saida="$(env -i PATH="/usr/bin:/bin" HOME="$tmp" bash "$SCRIPT" tests/invariants/qualquer.test.ts 2>&1 || true)"
codigo="$(env -i PATH="/usr/bin:/bin" HOME="$tmp" bash "$SCRIPT" tests/invariants/qualquer.test.ts >/dev/null 2>&1; echo $?)"
checar "recusa com exit 1" "1" "$codigo"
# ⚠️ ESTE CASO JÁ FOI FRACO, e a sabotagem mostrou: procurar só a palavra
# "vitest" passava COM e SEM a guarda, porque o erro real do 127
# (`vitest: comando não encontrado`) também a contém. Um controle que não
# distingue os dois mundos não mede nada. Agora ele procura a FRASE da guarda.
case "$saida" in
  *"a suíte de invariantes não rodaria"*)
    echo "  ok: a mensagem é a da guarda, não o 127 cru";;
  *) echo "  FALHOU: não achei a frase da guarda — saída: $saida" >&2; falhas=$((falhas + 1));;
esac
case "$saida" in
  *"não está no PATH"*|*"nao esta no PATH"*) echo "  ok: a mensagem diz que é PATH, não schema";;
  *) echo "  FALHOU: a mensagem não explica a causa — saída: $saida" >&2; falhas=$((falhas + 1));;
esac
# Recusou ANTES do container: nada de `==>` do preparo apareceu.
case "$saida" in
  *"==>"*) echo "  FALHOU: chegou a executar passos do preparo antes de recusar" >&2; falhas=$((falhas + 1));;
  *) echo "  ok: recusou antes de qualquer passo do preparo";;
esac

echo "== 2/3 · a mensagem manda usar \`pnpm test:db\`"
case "$saida" in
  *"pnpm test:db"*) echo "  ok: aponta o comando certo";;
  *) echo "  FALHOU: não aponta \`pnpm test:db\` — saída: $saida" >&2; falhas=$((falhas + 1));;
esac

echo "== 3/3 · CONTROLE POSITIVO: com vitest no PATH a guarda NÃO dispara"
# Um `vitest` de mentira, só para a guarda achar. O script segue adiante e morre
# depois, no Docker ausente — e é justamente isso que se quer ver: a guarda
# deixou passar, então a recusa do caso 1 foi dela e não de outra coisa.
mkdir -p "$tmp/bin"
printf '#!/bin/sh\nexit 0\n' > "$tmp/bin/vitest"
chmod +x "$tmp/bin/vitest"
saida_ok="$(env -i PATH="$tmp/bin:/usr/bin:/bin" HOME="$tmp" bash "$SCRIPT" tests/invariants/qualquer.test.ts 2>&1 || true)"
case "$saida_ok" in
  *"não está no PATH"*|*"nao esta no PATH"*)
    echo "  FALHOU: a guarda disparou COM vitest no PATH — ela reprovaria o CI" >&2
    falhas=$((falhas + 1));;
  *) echo "  ok: passou da guarda (o que vem depois é outro assunto)";;
esac

if [ "$falhas" -ne 0 ]; then
  echo "FALHAS: $falhas" >&2
  exit 1
fi
echo "TODOS OS CASOS OK"
