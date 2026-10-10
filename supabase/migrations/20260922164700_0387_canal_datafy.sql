-- 0387 · Canal de WhatsApp Datafy — parceiro homologado pela Meta que espelha a Cloud API.
--
-- Recorte do PR #1130, de @vgamkt (lá era a 0235, timestamp 20260913150000;
-- renumerada para o número que a rodada alocou, número E timestamp juntos).
--
-- ─── O que entra ────────────────────────────────────────────────────────────
-- Um provedor de canal de mensagem novo, ao lado de `waha`, `meta_cloud` e
-- `zernio`. O Datafy expõe a MESMA Cloud API (mesmos caminhos e corpos) e muda
-- o TRANSPORTE (host próprio, token `sk_live_…`) — por isso a coluna de
-- referência é o `phone_number_id`, como no canal oficial, mas em coluna
-- PRÓPRIA: os dois provedores podem conviver na mesma instalação e endereçam
-- servidores diferentes.
--
-- O canal é OPCIONAL DA INSTALAÇÃO e nasce desligado (decisão do dono, doc 54,
-- opção b). O desligamento é do código (`DATAFY_ENABLED`), não do schema: as
-- colunas nascem nullable e vazias em toda instalação, e uma instalação que
-- nunca liga o canal não grava nada nelas.
--
-- ─── Por que recriar os CHECKs inteiros ─────────────────────────────────────
-- `channel_sessions_provider_check` é o vocabulário fechado; o
-- `channel_sessions_provider_ref_check` exige a coluna do provider da vez NOT
-- NULL. Um provider novo sem o seu ramo seria recusado com 23514. Recriar com
-- drop+add (nunca `exception when duplicate_object`) é o que a 0131
-- estabeleceu. O vocabulário abaixo é o da 0368 mais `datafy`.
--
-- `webhook_events_log_provider_check` (0151) entra junto: a rota genérica de
-- canal arquiva o corpo cru ANTES de conferir a assinatura, com o provider da
-- sessão. Sem `datafy` ali, o arquivo recusaria a linha e a entrada do canal
-- ficaria sem o único registro do que o provedor mandou.
--
-- Alargamento puro nos três: um CHECK que aceita mais valores não é violado por
-- linha que já passava pelo antigo, então não há backfill antes.
--
-- ─── Índice único entre ativos ──────────────────────────────────────────────
-- Mesmo desenho da 0165: `datafy_phone_number_id` é identificador do PROVIDER, e
-- duas organizações com o mesmo número fariam `maybeSingle()` devolver
-- `PGRST116`. A dedup com sufixo `-conflito-<id>` torna a primeira passada
-- idempotente num banco que já tenha linhas repetidas.

alter table public.channel_sessions
  add column if not exists datafy_phone_number_id text,
  add column if not exists datafy_waba_id text,
  add column if not exists datafy_token_encrypted bytea;

comment on column public.channel_sessions.datafy_phone_number_id is
  'phone_number_id da WABA no canal Datafy (parceiro que espelha a Cloud API). É o sessionRef deste canal. Espelhado em lib/channels/session-ref.ts.';
comment on column public.channel_sessions.datafy_token_encrypted is
  'Token do Datafy (sk_live_…), cifrado por fn_encrypt_oauth. Nunca volta à tela depois de gravado.';

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
    check (provider in ('waha', 'meta_cloud', 'zernio', 'zernio_social', 'wacalls', 'datafy'));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha' and waha_session_name is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    (provider in ('zernio', 'zernio_social') and zernio_account_id is not null) or
    (provider = 'wacalls' and wacalls_session_id is not null) or
    (provider = 'datafy' and datafy_phone_number_id is not null)
  );

alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;

alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check check (provider in (
    'waha', 'nuvemshop', 'generic', 'meta_cloud', 'zernio', 'datafy'
  ));

with ativos as (
  select id,
         row_number() over (
           partition by datafy_phone_number_id
           order by created_at desc nulls last, id desc
         ) as posicao
    from public.channel_sessions
   where archived_at is null
     and datafy_phone_number_id is not null
)
update public.channel_sessions s
   set datafy_phone_number_id = s.datafy_phone_number_id || '-conflito-' || s.id::text
  from ativos a
 where a.id = s.id
   and a.posicao > 1;

create unique index if not exists channel_sessions_datafy_phone_number_id_ativo_unique
  on public.channel_sessions (datafy_phone_number_id)
  where archived_at is null and datafy_phone_number_id is not null;

notify pgrst, 'reload schema';
