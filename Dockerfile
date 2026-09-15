# syntax=docker/dockerfile:1
# DeskcommCRM — imagem de produção self-host (Next.js standalone).
# Build: docker build --build-arg NEXT_PUBLIC_SUPABASE_URL=... -t deskcomm-app .

# ---- deps: instala dependências (layer cacheável) ----
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json pnpm-lock.yaml ./
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
# Sentry RUNTIME segue ativo (DSN hardcoded nas configs). Sourcemap upload é
# concern só da Vercel; aqui o ganho de tempo de build é o que importa pro leigo.
RUN pnpm build

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

# outputFileTracingIncludes (next.config.ts) copia o CONTEÚDO de @napi-rs/canvas
# e os .node soltos das variantes de plataforma, mas não os SYMLINKS que o pnpm
# cria ao lado deles — e é só por esses symlinks que um `require()` de
# especificador nu (`@napi-rs/canvas`, e o `require('@napi-rs/canvas-linux-x64-*')`
# que o próprio pacote faz por dentro para achar seu binário) resolve. Sem isto,
# os arquivos existem na imagem mas ficam inalcançáveis — medido: mesmo com o
# glob do 4e4f6612 aplicado, `require('@napi-rs/canvas')` a partir do chunk do
# pdfjs-dist ainda lança MODULE_NOT_FOUND. Recriar os dois symlinks que faltam
# resolve os dois `require` (o do chunk pdfjs e o interno do canvas por sua
# variante de plataforma), sem depender do file tracer do Next.
RUN set -e; \
    CANVAS_DIR="$(find /app/node_modules/.pnpm -maxdepth 1 -iname '@napi-rs+canvas@*' -print -quit)"; \
    if [ -n "$CANVAS_DIR" ]; then \
      mkdir -p /app/node_modules/@napi-rs; \
      ln -sf "$CANVAS_DIR/node_modules/@napi-rs/canvas" /app/node_modules/@napi-rs/canvas; \
      for plat in linux-x64-musl linux-x64-gnu; do \
        PLAT_DIR="$(find /app/node_modules/.pnpm -maxdepth 1 -iname "@napi-rs+canvas-$plat@*" -print -quit)"; \
        if [ -n "$PLAT_DIR" ]; then \
          ln -sf "$PLAT_DIR/node_modules/@napi-rs/canvas-$plat" "$CANVAS_DIR/node_modules/@napi-rs/canvas-$plat"; \
        fi; \
      done; \
      chown -R nextjs:nodejs /app/node_modules/@napi-rs "$CANVAS_DIR/node_modules/@napi-rs"; \
    fi

USER nextjs
EXPOSE 3000
# server.js é o entrypoint gerado pelo output standalone.
CMD ["node", "server.js"]
