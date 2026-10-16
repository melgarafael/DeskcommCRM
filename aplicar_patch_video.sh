#!/bin/bash
set -e

echo "=== Aplicando Patch de Correção de Vídeo no DeskcommCRM ==="

# 1. Atualizar o teto do bucket whatsapp-media no Supabase DB para 1GB
echo "1. Atualizando limite do bucket whatsapp-media para 1GB no Supabase..."
docker exec -i supabase-db psql -U postgres -d postgres <<SQL
UPDATE storage.buckets 
   SET file_size_limit = 1073741824 
 WHERE id = 'whatsapp-media';
SQL

# 2. Copiar os arquivos atualizados para o container app (se estiver rodando via container)
CONTAINER_APP=$(docker ps --filter "name=app" --format "{{.ID}}" | head -n 1)

if [ -n "$CONTAINER_APP" ]; then
  echo "2. Atualizando arquivos no container app ($CONTAINER_APP)..."
  docker cp lib/messaging/media/types.ts "$CONTAINER_APP":/app/lib/messaging/media/types.ts 2>/dev/null || true
  docker cp lib/messaging/media/voice-transcode.ts "$CONTAINER_APP":/app/lib/messaging/media/voice-transcode.ts 2>/dev/null || true
  docker cp lib/messaging/media/video-transcode.ts "$CONTAINER_APP":/app/lib/messaging/media/video-transcode.ts 2>/dev/null || true
  docker cp app/api/v1/conversations/[id]/media/route.ts "$CONTAINER_APP":/app/app/api/v1/conversations/[id]/media/route.ts 2>/dev/null || true
  docker cp lib/waha/media-send.ts "$CONTAINER_APP":/app/lib/waha/media-send.ts 2>/dev/null || true
  docker cp lib/channels/adapters/waha.ts "$CONTAINER_APP":/app/lib/channels/adapters/waha.ts 2>/dev/null || true
  docker cp lib/waha/client.ts "$CONTAINER_APP":/app/lib/waha/client.ts 2>/dev/null || true
  docker cp app/api/v1/messages/_handler.ts "$CONTAINER_APP":/app/app/api/v1/messages/_handler.ts 2>/dev/null || true
  docker cp hooks/inbox/useUploadMedia.ts "$CONTAINER_APP":/app/hooks/inbox/useUploadMedia.ts 2>/dev/null || true
  docker cp components/feedback/ApiErrorToast.tsx "$CONTAINER_APP":/app/components/feedback/ApiErrorToast.tsx 2>/dev/null || true
  docker cp components/inbox/composer/AttachmentPreviewDialog.tsx "$CONTAINER_APP":/app/components/inbox/composer/AttachmentPreviewDialog.tsx 2>/dev/null || true
  
  echo "3. Reiniciando o container app para recarregar as rotas..."
  docker restart "$CONTAINER_APP"
else
  echo "Container app não encontrado diretamente por 'name=app'. Se você usa docker compose, rode: docker compose restart app"
fi

echo "=== Patch aplicado com sucesso! ==="
