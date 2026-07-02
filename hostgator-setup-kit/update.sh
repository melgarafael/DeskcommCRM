#!/usr/bin/env bash
# Atualiza o CRM: puxa código novo, aplica migrações de schema e recria os
# containers com a imagem nova. Volumes (sessões WhatsApp) são preservados.
source "$(dirname "$0")/_common.sh"
enter_project

step "Baixando atualizações do código"
git pull --ff-only || c_ylw "⚠ git pull pulado (repo com mudanças locais?)."

step "Aplicando migrações de schema (schema ANTES do app)"
if [ -f supabase/baseline.sql ]; then
  docker run --rm -i -v "$PROJECT_DIR/supabase/baseline.sql:/b.sql:ro" \
    postgres:17-alpine psql "$SUPABASE_DB_URL" -f /b.sql \
    && c_grn "✓ schema em dia" || c_ylw "⚠ verifique o log do schema acima."
fi

step "Puxando a imagem nova e recriando o app"
docker compose -f "$COMPOSE" pull
docker compose -f "$COMPOSE" up -d
c_grn "✓ atualizado. Logs: docker compose -f $COMPOSE logs -f app"
