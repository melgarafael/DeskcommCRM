-- 0727 · Canal OLX — chat de vendedor como provider de mensagem (issue #2927, fatia 1).
--
-- manifest: Canal OLX (chat de vendedor, issue #2927): alarga os três CHECKs de
-- provider para o valor `olx`, acrescenta as colunas da sessão da conta de
-- vendedor (`olx_seller_id`, `olx_token_encrypted`) e o índice único entre
-- ativos. Vocabulário puro — o round-trip real com a OLX (OAuth, webhook,
-- envio) fica para as fatias seguintes.
--
-- ─── O que entra ────────────────────────────────────────────────────────────
-- Um provedor de canal de mensagem novo, ao lado de `waha`, `meta_cloud`,
-- `zernio` e `datafy`. O chat da OLX endereça por THREAD (`chatId` que a
-- plataforma inventa e entrega pelo webhook), como o canal intermediado — e não
-- por telefone. Por isso a coluna de referência da sessão é um id de conta de
-- vendedor (`olx_seller_id`), própria do provider: duas contas de vendedor na
-- mesma instalação endereçam contas diferentes da OLX.
--
-- ─── Por que recriar os CHECKs inteiros ─────────────────────────────────────
-- `channel_sessions_provider_check` é o vocabulário fechado; o
-- `channel_sessions_provider_ref_check` exige a coluna do provider da vez NOT
-- NULL. Um provider novo sem o seu ramo seria recusado com 23514. Recriar com
-- drop+add (nunca `exception when duplicate_object`) é o que a 0131
-- estabeleceu. O vocabulário abaixo é o da 0387 mais `olx`.
--
-- `webhook_events_log_provider_check` (0151) entra junto: a rota genérica de
-- canal arquiva o corpo cru ANTES de conferir a assinatura, com o provider da
-- sessão. Sem `olx` ali, o arquivo recusaria a linha e a entrada do canal
-- ficaria sem o único registro do que o provedor mandou.
--
-- Alargamento puro nos três: um CHECK que aceita mais valores não é violado por
-- linha que já passava pelo antigo, então não há backfill antes.
--
-- ─── Índice único entre ativos ──────────────────────────────────────────────
-- Mesmo desenho da 0165/0387: `olx_seller_id` é identificador do PROVIDER, e
-- duas organizações com o mesmo id fariam `maybeSingle()` devolver `PGRST116`.
-- A dedup com sufixo `-conflito-<id>` torna a primeira passada idempotente num
-- banco que já tenha linhas repetidas.

alter table public.channel_sessions
  add column if not exists olx_seller_id text,
  add column if not exists olx_token_encrypted bytea;

comment on column public.channel_sessions.olx_seller_id is
  'id da conta de vendedor da OLX (issue #2927). É o sessionRef deste canal: a OLX endereça por thread/conta, não por telefone. Espelhado em lib/channels/session-ref.ts.';
comment on column public.channel_sessions.olx_token_encrypted is
  'Token OAuth 2.0 da OLX (scope=chat), cifrado por fn_encrypt_oauth. Nunca volta à tela depois de gravado.';

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
    check (provider in ('waha', 'meta_cloud', 'zernio', 'zernio_social', 'wacalls', 'datafy', 'olx'));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha' and waha_session_name is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    (provider in ('zernio', 'zernio_social') and zernio_account_id is not null) or
    (provider = 'wacalls' and wacalls_session_id is not null) or
    (provider = 'datafy' and datafy_phone_number_id is not null) or
    (provider = 'olx' and olx_seller_id is not null)
  );

alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;

alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check check (provider in (
    'waha', 'nuvemshop', 'generic', 'meta_cloud', 'zernio', 'datafy', 'stripe', 'asaas', 'olx'
  ));

with ativos as (
  select id,
         row_number() over (
           partition by olx_seller_id
           order by created_at desc nulls last, id desc
         ) as posicao
    from public.channel_sessions
   where archived_at is null
     and olx_seller_id is not null
)
update public.channel_sessions s
   set olx_seller_id = s.olx_seller_id || '-conflito-' || s.id::text
  from ativos a
 where a.id = s.id
   and a.posicao > 1;

create unique index if not exists channel_sessions_olx_seller_id_ativo_unique
  on public.channel_sessions (olx_seller_id)
  where archived_at is null and olx_seller_id is not null;

notify pgrst, 'reload schema';
