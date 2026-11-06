-- manifest: **Índice parcial das fotos guardadas sem descrição por falta de leitor (`MEDIA_VISION_WITHOUT_READER=defer`).** Com o knob em `defer`, o `media-persist-worker` guarda a foto de uma empresa sem NENHUMA IA nem integração como `skipped` com `metadata.derivacao_adiada`, e o cron `media-leitura-adiada` (5 em 5 min) e o dreno do turno a reabrem quando aparece quem a leia. `messages` não tem índice por organização e data, então sem este índice a varredura do cron leria a tabela inteira a cada rodada. O índice só contém o que é reabrível: sai dele a foto reaberta, a anonimizada (`metadata` `{}` e path nulo) e a podada pela retenção (path nulo). Só índice: sem dado, constraint nem função. Idempotente; apêndice espelhado no `baseline.sql`.

-- 9106 — a busca das fotos adiadas não varre `messages`.
--
-- O nome da chave (`derivacao_adiada`) está em `CHAVE_ADIADA`
-- (lib/messaging/media/leitura-adiada.ts): renomear lá exige trocar o
-- predicado aqui, numa migration nova.
create index if not exists idx_messages_derivacao_adiada
  on public.messages (organization_id, conversation_id, created_at desc)
  where (metadata ? 'derivacao_adiada') and media_storage_path is not null;
