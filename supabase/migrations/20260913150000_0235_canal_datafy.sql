-- 0235 · Canal de WhatsApp Datafy — parceiro que espelha a Meta Cloud API.
--
-- ─── O que entra ────────────────────────────────────────────────────────────
-- Um quarto provedor de canal, ao lado de `waha`, `meta_cloud` e `zernio`. O
-- Datafy é parceiro homologado pela Meta e expõe a MESMA Cloud API (mesmos
-- caminhos/payloads), mudando TRANSPORTE (host `cloud.datafyapi.com.br/v1`,
-- token `sk_live_…`) — por isso a coluna de referência é o `phone_number_id`,
-- como no canal oficial, mas em coluna PRÓPRIA: os dois provedores podem
-- conviver na mesma instalação e endereçam servidores diferentes.
--
-- ─── Por que recriar os DOIS CHECKs no fim ──────────────────────────────────
-- O `channel_sessions_provider_ref_check` exige a coluna do provider da vez NOT
-- NULL. Um provider novo sem o ramo dele seria recusado por um CHECK que não o
-- conhece; e o `channel_sessions_provider_check` é o vocabulário fechado.
-- Recriar com drop+add (nunca `exception when duplicate_object`) é o que a 0131
-- estabeleceu e o `tests/unit/baseline-constraint-reconstruida` vigia.
--
-- ─── Índice único entre ativos ──────────────────────────────────────────────
-- Mesmo desenho da 0165: `datafy_phone_number_id` é identificador do PROVIDER e
-- duas organizações podiam ter o mesmo por configuração legítima; a dedup com
-- sufixo `-conflito-<id>` torna a primeira passada idempotente.

alter table public.channel_sessions
  add column if not exists datafy_phone_number_id text,
  add column if not exists datafy_waba_id text,
  add column if not exists datafy_token_encrypted bytea;

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
    check (provider = any (array['waha', 'meta_cloud', 'zernio', 'datafy']));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha' and waha_session_name is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    (provider = 'zernio' and zernio_account_id is not null) or
    (provider = 'datafy' and datafy_phone_number_id is not null)
  );

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
