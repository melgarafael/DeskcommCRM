#!/usr/bin/env bash
# Prova da guarda de `scripts/smoke-llm.sh` que recusa quando o `tsx` não está
# instalado em `node_modules/.bin`.
#
#   bash tests/shell/smoke-llm-recusa-sem-tsx.test.sh
#
# ## O defeito que ela mata, medido em 2026-09-20
#
# O script sobe um Postgres efêmero, espera ele ficar pronto, aplica prelude e
# baseline — e só então chama `pnpm exec tsx scripts/smoke-llm.ts`. Medido com o
# instrumento fora do PATH, a primeira coisa que aparece é
# `==> subindo pgvector/pgvector:pg15 ...` e o fim é
# `<script>: line 21: docker: command not found`, com **exit 127**: o anúncio
# verde fica na tela e o que vinha depois dele não rodou. É a classe "instrumento
# ausente não se anuncia" — o `docker` é só o instrumento mais próximo da porta,
# e o `tsx` está três passos adiante dela.
#
# ## O que está sob prova
#
#   1. sem `node_modules/.bin/tsx`, o script RECUSA (exit 1) e recusa ANTES de
#      anunciar o container;
#   2. a mensagem nomeia o binário ausente e diz o que fazer (`pnpm install`);
#   3. CONTROLE POSITIVO: com um `tsx` no lugar, a guarda NÃO dispara — sem este
#      caso, uma guarda que recusasse sempre passaria no caso 1 e quebraria o CI.
#
# A cópia roda num diretório de mentira e com um `docker` de mentira que falha na
# hora: assim o teste mede a guarda sem subir container e sem falar com o modelo.
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/../.." && pwd)"
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

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/scripts"
cp "$RAIZ/scripts/smoke-llm.sh" "$tmp/scripts/"

echo "== 1/3 · sem tsx instalado, recusa antes do container"
saida="$(env -i PATH="/usr/bin:/bin" HOME="$tmp" ANTHROPIC_API_KEY=chave-de-mentira bash "$tmp/scripts/smoke-llm.sh" 2>&1 || true)"
codigo="$(env -i PATH="/usr/bin:/bin" HOME="$tmp" ANTHROPIC_API_KEY=chave-de-mentira bash "$tmp/scripts/smoke-llm.sh" >/dev/null 2>&1; echo $?)"
checar "recusa com exit 1" "1" "$codigo"
# A FRASE da guarda, não a palavra "tsx" solta: o 127 cru também citaria o nome
# do binário, então procurar só o nome não distingue os dois mundos.
case "$saida" in
  *"node_modules/.bin/tsx"*) echo "  ok: a mensagem nomeia o binário ausente";;
  *) echo "  FALHOU: a mensagem não nomeia o binário — saída: $saida" >&2; falhas=$((falhas + 1));;
esac
case "$saida" in
  *"==>"*) echo "  FALHOU: anunciou o container antes de recusar" >&2; falhas=$((falhas + 1));;
  *) echo "  ok: recusou antes de qualquer anúncio do container";;
esac

echo "== 2/3 · a mensagem manda rodar \`pnpm install\`"
case "$saida" in
  *"pnpm install"*) echo "  ok: aponta o comando certo";;
  *) echo "  FALHOU: não aponta \`pnpm install\` — saída: $saida" >&2; falhas=$((falhas + 1));;
esac

echo "== 3/3 · CONTROLE POSITIVO: com tsx no lugar, a guarda NÃO dispara"
# `docker` de mentira, à frente no PATH: numa máquina COM Docker de verdade, o
# script subiria container e chamaria o modelo — o teste não faz nem uma coisa
# nem outra.
mkdir -p "$tmp/bin" "$tmp/node_modules/.bin"
printf '#!/bin/sh\n# docker de mentira: falha na hora.\nexit 1\n' > "$tmp/bin/docker"
chmod +x "$tmp/bin/docker"
printf '#!/bin/sh\nexit 0\n' > "$tmp/node_modules/.bin/tsx"
chmod +x "$tmp/node_modules/.bin/tsx"
saida_ok="$(env -i PATH="$tmp/bin:/usr/bin:/bin" HOME="$tmp" ANTHROPIC_API_KEY=chave-de-mentira bash "$tmp/scripts/smoke-llm.sh" 2>&1 || true)"
case "$saida_ok" in
  *"node_modules/.bin/tsx"*)
    echo "  FALHOU: a guarda disparou COM o tsx no lugar — ela reprovaria o CI" >&2
    falhas=$((falhas + 1));;
  *) echo "  ok: passou da guarda";;
esac
# "Passou da guarda" só vale se o script ALCANÇOU o passo seguinte: o anúncio do
# container vem antes da chamada do `docker`, então ele aparece em qualquer mundo
# em que a guarda deixou passar.
case "$saida_ok" in
  *"==> subindo"*) echo "  ok: chegou ao passo do container (o que vem depois é outro assunto)";;
  *) echo "  FALHOU: não chegou ao passo do container — saída: $saida_ok" >&2; falhas=$((falhas + 1));;
esac

if [ "$falhas" -ne 0 ]; then
  echo "FALHAS: $falhas" >&2
  exit 1
fi
echo "TODOS OS CASOS OK"
