#!/usr/bin/env bash
# Lê caminhos (um por linha) na entrada e responde `sim` se ALGUM deles pode
# mudar ou quebrar uma das três imagens (app, worker, scheduler); `nao` só
# quando TODOS estão na lista abaixo. Entrada vazia responde `sim`: não saber o
# que mudou nunca pode virar "não precisa construir".
#
# Usado pelo publish-image.yml em pull_request, para não gastar 3 builds Docker
# num PR que só mexe em documentação ou teste. A lista é de quem NÃO alcança a
# imagem, e não de quem alcança, de propósito: o `Dockerfile.worker` faz
# `COPY . .` e o `next build` do app typecheca todo `**/*.ts` do contexto
# (tsconfig.json), então praticamente qualquer arquivo de código pode quebrar
# uma imagem. Errar para o lado de "construir" custa um build; errar para o
# outro deixa passar imagem quebrada com `imagens-ok` verde.
#
# Cada entrada, e por quê:
#   - o que o `.dockerignore` exclui: nem entra no contexto de build, então
#     nenhum Dockerfile o enxerga. A lista abaixo repete o `.dockerignore`, e
#     tests/unit/pr-mexe-na-imagem.test.ts reprova se as duas divergirem.
#   - `.github/**/*.{yml,yaml,md}`, menos o próprio publish-image.yml: entra no
#     contexto (o worker o carrega inerte), mas nenhum passo de build lê YAML
#     nem markdown. `.ts` sob `.github/` NÃO está aqui — o `next build` o
#     typechecaria.
#   - `*.md` na RAIZ: inerte pela mesma razão; nenhum módulo importa markdown da
#     raiz (o CHANGELOG que a tela mostra chega do agente do host, não do disco
#     da imagem). Markdown em subdiretório fica de fora da regra: há código que
#     lê `.md` do próprio disco (lib/agent-engine/playbooks/*.md).
set -euo pipefail

algum=nao
while IFS= read -r caminho || [ -n "$caminho" ]; do
  [ -z "$caminho" ] && continue
  algum=sim
  case "$caminho" in
    .github/workflows/publish-image.yml) echo sim; exit 0 ;;
    # ↓ espelho do .dockerignore — os diretórios. Padrão de .dockerignore sem
    # barra casa só na RAIZ do contexto, e `*` de `case` atravessa `/`: por
    # isso todo padrão aqui começa pelo nome do diretório da raiz.
    evidence | .superpowers) ;;
    node_modules/* | .next/* | .git/* | test-results/* | tests/* | .lina/* \
      | docs/* | tasks/* | scratchpad/* | .vercel/* | .claude/* | .agents/* \
      | .agent/* | .codex/* | .cursor/* | .opencode/* | .specs/* | .changes/* \
      | evidence/* | .superpowers/*) ;;
    .github/*.yml | .github/*.yaml | .github/*.md) ;;
    # Daqui para baixo, só arquivo da RAIZ: qualquer outro caminho com `/` alcança.
    */*) echo sim; exit 0 ;;
    # ↓ espelho do .dockerignore — os arquivos da raiz.
    .env | .env.* | playwright.config.ts | *.png | *.log | *.tsbuildinfo) ;;
    *.md) ;;
    *) echo sim; exit 0 ;;
  esac
done

# Nenhuma linha lida: não sei o que mudou, então constrói.
if [ "$algum" = nao ]; then echo sim; else echo nao; fi
