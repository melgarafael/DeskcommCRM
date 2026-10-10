-- 0131 — vocabulário do terceiro canal (BSP intermediário) em channel_sessions.
--
-- O VOCABULÁRIO antes do transporte, de propósito: o tipo TypeScript, a matriz
-- de capabilities e a coluna de ref nascem juntos, e o adapter chega depois
-- encontrando o schema pronto. O caminho inverso — adapter primeiro, coluna
-- depois — obriga a uma migration de correção em cima de dados que já
-- existem, e é onde clone quebra.
--
-- Por que uma coluna NOVA e não reusar `meta_phone_number_id`: o identificador
-- deste canal é o `accountId` que o intermediário devolve ao conectar a WABA —
-- id DELE, não o `phone_number_id` da Meta. São espaços de identificadores
-- diferentes; reusar a coluna faria os dois canais compartilharem um nome que
-- mente sobre metade das linhas, e o dia em que alguém debugar um envio pelo
-- id errado a mensagem já não saiu.
--
-- Idempotente e auto-curativa (doutrina de migrations): a coluna nasce
-- nullable, então nenhuma linha existente a viola; os dois CHECKs são
-- RECRIADOS (drop + add) em vez de criados com `exception when duplicate_object`,
-- porque aqui eles precisam MUDAR — um clone que já tem a versão de dois
-- providers ficaria com a constraint antiga e recusaria a sessão nova em
-- silêncio, que é o pior desfecho possível: o `update.sh` passa verde e o
-- canal não conecta.
--
-- Nenhum dado a deduplicar antes das constraints: toda linha pré-existente tem
-- provider 'waha' ou 'meta_cloud' e já satisfaz o ramo correspondente.

alter table public.channel_sessions
  add column if not exists zernio_account_id text;

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  check (provider = any (array['waha'::text, 'meta_cloud'::text, 'zernio'::text]));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha'       and waha_session_name    is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    (provider = 'zernio'     and zernio_account_id    is not null)
  );

comment on column public.channel_sessions.zernio_account_id is
  'Identificador da conta conectada NO INTERMEDIÁRIO (accountId), não o phone_number_id da Meta. É o que endereça envio e webhook. Espelhado em lib/channels/session-ref.ts.';
