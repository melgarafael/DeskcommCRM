#!/usr/bin/env bash
# O BUILD_ID do servidor bate com o de `.next/static`? (#4967)
#
# POR QUE ESTE SCRIPT EXISTE
# A imagem 1.118.0 saiu com dois builds dentro dela: `.next/BUILD_ID` dizia
# `L0Ae8OxIf-v2KzwJoCU0E` e `.next/static/` trazia `K2qYwFMofIRXoOdBpIUbx`. O Next
# embute o build id nos caminhos dos chunks que o HTML referencia, então toda rota
# que carrega chunk — `/login`, `/app/inbox`, Funis — morria com ChunkLoadError: o
# arquivo pedido não existia naquela imagem.
# (O namespace da imagem é `IMG_NS`, em `hostgator-setup-kit/_common.sh`: este
# script não repete o literal — a catraca de `tests/unit/namespace-das-imagens.test.ts`
# existe justamente para que ninguém volte a escrevê-lo à mão.)
#
# COMO OS DOIS SE SEPARAVAM
# A receita antiga copiava `.next/standalone` e `.next/static` em dois `COPY --from=`
# distintos. O BuildKit resolve CADA passo contra o snapshot que ele tiver: em
# 18/11/2026 o cache do GHA devolveu o manifesto com blobs faltando
# (`::error::blob sha256:...: not found` no log do job), o `RUN pnpm build`
# REEXECUTOU (262,7 s) e o `COPY` do standalone veio do cache antigo enquanto o do
# static veio do build novo — cada cópia de um build, a imagem com os dois.
# A receita de hoje fecha isso na origem: `.next/static` é copiado para DENTRO do
# standalone num `RUN` do estágio `build` e sai num `COPY` só. Esta sonda continua
# valendo como a medida de fora: ela não confia na receita, confere a imagem.
#
# O QUE ESTE SCRIPT MEDE
#   1. id do SERVIDOR: conteúdo de `<raiz>/.next/BUILD_ID` — é o que o `server.js`
#      do standalone lê em runtime e com que ele monta a URL de cada chunk;
#   2. id do STATIC: nome do diretório dentro de `<raiz>/.next/static/` que tem
#      `_buildManifest.js` (o Next cria `.next/static/<BUILD_ID>/_buildManifest.js`;
#      `chunks/` e `media/` não são build id).
# Iguais → rc 0. Diferentes → rc 1, dizendo qual é qual. Não conseguir medir
# (arquivo ausente, zero ou dois candidatos) → rc 2: "não sei" nunca vira "bateu".
#
# USO
#   scripts/verifica-build-id.sh <imagem>          # mede dentro da imagem
#   scripts/verifica-build-id.sh --dir <diretório> # mede um .next em disco (testes)
#
# Exit: 0 = bate, 1 = divergem, 2 = não deu para medir.
set -uo pipefail

# A sonda roda IGUAL nos dois modos: dentro do contêiner, com `sh` puro (alpine não
# tem bash), e em disco no modo --dir. Uma implementação só — se ela divergisse
# entre os modos, o teste do modo --dir não provaria nada sobre a imagem.
SONDA='
raiz=$1
if [ ! -d "$raiz/.next" ]; then
  echo "não deu para medir: $raiz/.next não existe"
  exit 2
fi
if [ ! -f "$raiz/.next/BUILD_ID" ]; then
  echo "não deu para medir: $raiz/.next/BUILD_ID não existe (o standalone não foi copiado?)"
  exit 2
fi
servidor=$(tr -d " \t\r\n" < "$raiz/.next/BUILD_ID")
if [ -z "$servidor" ]; then
  echo "não deu para medir: $raiz/.next/BUILD_ID está vazio"
  exit 2
fi
if [ ! -d "$raiz/.next/static" ]; then
  echo "não deu para medir: $raiz/.next/static não existe"
  exit 2
fi
# Cada candidato é um diretório de build id, identificado pelo manifesto que o Next
# escreve nele. Nome de diretório sozinho não serve: `chunks/` e `media/` também
# são diretórios e não são build id.
candidatos=""
for d in "$raiz/.next/static"/*/; do
  [ -d "$d" ] || continue
  if [ -f "$d/_buildManifest.js" ] || [ -f "$d/_ssgManifest.js" ]; then
    candidatos="$candidatos
$(basename "$d")"
  fi
done
candidatos=$(printf "%s\n" "$candidatos" | sed "/^$/d")
n=$(printf "%s\n" "$candidatos" | sed "/^$/d" | wc -l | tr -d " ")
if [ "$n" -eq 0 ]; then
  echo "não deu para medir: nenhum diretório em $raiz/.next/static tem _buildManifest.js/_ssgManifest.js"
  exit 2
fi
if [ "$n" -gt 1 ]; then
  echo "não deu para medir: $raiz/.next/static tem $n diretórios de build id (esperado 1):"
  printf "%s\n" "$candidatos" | sed "s/^/  - /"
  exit 2
fi
estatico=$candidatos

echo "servidor (BUILD_ID):       $servidor"
echo ".next/static (BUILD_ID):   $estatico"
if [ "$servidor" != "$estatico" ]; then
  echo ""
  echo "DIVERGEM: o HTML desta imagem referencia $servidor, e os chunks em disco são de $estatico."
  exit 1
fi
echo "batem: $servidor"
exit 0
'

modo="imagem"
alvo="${1:-}"
if [ "$alvo" = "--dir" ]; then
  modo="dir"
  alvo="${2:-}"
elif [ "$alvo" = "-h" ] || [ "$alvo" = "--help" ] || [ -z "$alvo" ]; then
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi

if [ "$modo" = "dir" ]; then
  [ -d "$alvo" ] || { echo "não deu para medir: $alvo não é diretório"; exit 2; }
  saida=$(sh -c "$SONDA" verifica-build-id "$alvo" 2>&1)
  rc=$?
else
  command -v docker >/dev/null 2>&1 || {
    echo "não deu para medir: docker não está disponível e o alvo é uma imagem ($alvo)"
    exit 2
  }
  # `--entrypoint sh`: a imagem do app tem CMD `node server.js`; sem isto a sonda
  # subiria o servidor. Raiz fixa em /app — é onde o Dockerfile deixa o standalone.
  saida=$(docker run --rm --entrypoint sh "$alvo" -c "$SONDA" verifica-build-id /app 2>&1)
  rc=$?
fi

printf '%s\n' "$saida"

if [ "$rc" -ne 0 ] && [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  # Anotação no run: o log diz o que houve sem ninguém precisar abrir a saída.
  # Só as linhas que são o VEREDITO viram anotação — as duas medições entram no
  # texto para o erro nomear os dois ids, que é o que o mantenedor precisa ver.
  medidas=$(printf '%s\n' "$saida" | grep -E '^(servidor|\.next/static) ' || true)
  veredito=$(printf '%s\n' "$saida" | grep -E '^(DIVERGEM|não deu para medir)' || true)
  [ -n "$veredito" ] || veredito="verificação do BUILD_ID reprovou (rc=$rc)"
  echo "::error::$(printf '%s' "$medidas $veredito" | tr '\n' ' ')"
fi

if [ "$rc" -eq 1 ]; then
  echo ""
  echo "O servidor Next e os estáticos vieram de builds diferentes. O Next embute o"
  echo "build id no caminho dos chunks, então o HTML pede arquivos que não existem"
  echo "nesta imagem: ChunkLoadError em /login, /app/inbox e Funis (#4967)."
  echo "Não publique esta imagem: reconstrua sem o cache que a montou."
fi

exit "$rc"
