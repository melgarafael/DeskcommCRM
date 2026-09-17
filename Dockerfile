# syntax=docker/dockerfile:1
# DeskcommCRM — imagem de produção self-host (Next.js standalone).
# Build: docker build --build-arg NEXT_PUBLIC_SUPABASE_URL=... -t deskcomm-app .

# ---- deps: instala dependências (layer cacheável) ----
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json pnpm-lock.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile

# ---- build: gera .next/standalone ----
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# IMAGEM GENÉRICA: os NEXT_PUBLIC_* recebem placeholders no build. Os valores
# REAIS do usuário são injetados em RUNTIME — no browser via <PublicEnvScript/>
# (window.__PUBLIC_ENV__) e no servidor via lib/env.ts (parseia process.env em
# runtime). Assim UMA imagem serve qualquer projeto Supabase, sem rebuild.
# (Segredos de runtime NUNCA entram no build — guarda de fase em lib/env.ts.)
ARG NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder-anon-key
ARG NEXT_PUBLIC_APP_URL=https://placeholder.invalid
ARG NEXT_PUBLIC_ADMIN_URL=https://placeholder.invalid
# O build do Next é faminto: o heap default do Node (~2GB) estoura. NODE_OPTIONS
# eleva pra 4GB. Isso é custo de QUEM BUILDA — o CI —, não de quem instala: o
# caminho normal do self-hoster é `docker compose pull`, e o install.sh não
# builda o app. Buildar na VPS é o override opcional de docker-compose.build.yml,
# e é lá que o requisito de RAM de build se aplica (docs/runbooks/deploy.md §4).
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_ADMIN_URL=$NEXT_PUBLIC_ADMIN_URL \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS=--max-old-space-size=4096

# Turbopack (`pnpm build`): ~4min vs ~34min do webpack num VPS. O bloco `webpack:`
# do Sentry (tree-shake + upload de sourcemap em build-time) é ignorado, mas o
# Sentry RUNTIME segue ativo (DSN hardcoded nas configs); aqui o ganho de tempo
# de build é o que importa pro leigo.
RUN pnpm build

# `outputFileTracingIncludes` (next.config.ts) copia o CONTEÚDO de pdfjs-dist e
# @napi-rs/canvas pro standalone, mas não os DOIS SYMLINKS que pnpm cria e que a
# resolução de módulo do Node precisa pra achar os pacotes pelo nome — o Turbopack
# não tem como emiti-los por glob (é o "Is a directory" do comentário ao lado do
# glob do canvas: ele tenta ler o symlink como arquivo pra hashear o .nft.json e
# quebra). Sem isto, medido: os 554 arquivos de pdfjs-dist chegam ao standalone e
# mesmo assim `import("pdfjs-dist/legacy/build/pdf.mjs")` falha em runtime com
# "Cannot find package 'pdfjs-dist'" — o pacote existe em disco e é inalcançável
# por nome. `cp -a` roda como shell puro, fora do tracer, e preserva os dois como
# symlink de verdade: o de topo (pra o import do PRÓPRIO app) e o interno de
# pdfjs-dist (pra o `require("@napi-rs/canvas")` que a lib faz sozinha).
#
# Isto resolve o NOME do pacote, mas não é o caminho que o servidor real usa: o
# Turbopack BUNDLA o corpo do pdfjs-dist num chunk próprio
# (`.next/server/chunks/<hash>_pdfjs-dist_legacy_build_pdf_mjs_<hash>._.js`), e
# esse bundle nunca passa pelos symlinks acima — só o `import()` cru (o que os
# testes deste PR exercitavam) passa. Medido com um PDF real de 170 páginas,
# reproduzindo o carregamento de chunk do Turbopack via `[turbopack]_runtime.js`
# (não um `import()` de mão, que mascarava o defeito): o bundle sobe, mas o
# "fake worker" do pdf.js — o fallback de quando não há Web Worker de verdade,
# que é o caso do Node — procura `pdf.worker.mjs` como ARQUIVO VIZINHO do
# próprio chunk, dentro de `.next/server/chunks/`, e não em `node_modules/`
# nenhum. Sem ele: "Setting up fake worker failed: Cannot find module
# '/app/.next/server/chunks/pdf.worker.mjs'" — um SEGUNDO arquivo ausente,
# de causa diferente dos dois symlinks, e só aparece testando o bundle real.
RUN PDFJS_DIR=$(basename node_modules/.pnpm/pdfjs-dist@*) && \
    cp -a "node_modules/pdfjs-dist" ".next/standalone/node_modules/pdfjs-dist" && \
    mkdir -p ".next/standalone/node_modules/.pnpm/$PDFJS_DIR/node_modules/@napi-rs" && \
    cp -a "node_modules/.pnpm/$PDFJS_DIR/node_modules/@napi-rs/canvas" \
          ".next/standalone/node_modules/.pnpm/$PDFJS_DIR/node_modules/@napi-rs/canvas" && \
    cp "node_modules/.pnpm/$PDFJS_DIR/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs" \
       ".next/standalone/.next/server/chunks/pdf.worker.mjs"

# ---- runner: imagem slim de produção ----
FROM node:22-alpine AS runner
WORKDIR /app

# Procedência (doutrina de packaging, invariante 2). O CI já injeta os labels
# OCI via docker/metadata-action; estes aqui são defesa em profundidade — valem
# para qualquer build, inclusive o local de docker-compose.build.yml, que não
# passa pelo metadata-action e sem isto sairia sem origem nenhuma.
LABEL org.opencontainers.image.source="https://github.com/melgarafael/DeskcommCRM" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.title="DeskcommCRM"

# A versão que /api/v1/health reporta (invariante 7). Precisa vir por ARG: a
# alternativa anterior era `process.env.npm_package_version`, que é `undefined`
# sob `CMD ["node","server.js"]` — só existe quando o processo nasce de um
# `npm`/`pnpm run`. Toda instalação do mundo reportava o fallback "0.1.0".
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    APP_VERSION=$APP_VERSION
# ffmpeg: a derivação de vídeo (Onda 3.1) roda no processo do app — o cron
# event-log-drain executa o media_derive handler, que chama `ffmpeg` via spawn
# pra extrair áudio+frames. Sem o binário, todo vídeo recebido falha a derivação.
RUN apk add --no-cache ffmpeg
# non-root
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
# O output standalone NÃO inclui public/ nem .next/static — copiar explicitamente,
# senão CSS/JS/assets retornam 404 (app "sem estilo").
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public
USER nextjs
EXPOSE 3000
# server.js é o entrypoint gerado pelo output standalone.
CMD ["node", "server.js"]
