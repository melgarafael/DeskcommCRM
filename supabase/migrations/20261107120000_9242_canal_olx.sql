-- manifest: **Canal OLX (#2927) — o chat dos anúncios entra como canal de mensagem, com contrato e entrada, sem credencial de terceiro.** Duas colunas próprias em `channel_sessions` (`olx_account_id`, o sessionRef de uma conta de anunciante, e `olx_token_encrypted`, o access token do OAuth com escopo `chat`, cifrado por `fn_encrypt_oauth`), o vocábulo `olx` nos três CHECKs que fecham o conjunto (`channel_sessions_provider_check`, `channel_sessions_provider_ref_check` e `webhook_events_log_provider_check`, 0151 — sem ele a rota genérica de canal não arquiva o corpo cru que a OLX manda) e índice único parcial entre ativos com dedup `-conflito-<id>` antes dele (desenho da 0165). Alargamento puro: nenhum CHECK que aceita mais valores é violado por linha que já passava pelo antigo, então não há backfill. Sem tabela nova, sem função nova, sem mudança nas colunas de nenhum canal existente.
--
-- ─── Por que este canal precisa de migration e o Datafy também precisou ─────
--
-- `channel_sessions_provider_check` é vocabulário FECHADO e
-- `channel_sessions_provider_ref_check` exige a coluna do provider da vez NOT
-- NULL: um provider novo sem o seu ramo leva 23514 no INSERT da sessão. E o
-- invariante `tests/invariants/vocabulario-banco-x-typescript.test.ts` compara
-- este CHECK com o union `ChannelProvider` (lib/channels/types.ts) — entrar em
-- só um dos dois lados reprova. Os dois andam no mesmo commit, de propósito.
--
-- ─── Por que coluna PRÓPRIA e não a de outro canal ─────────────────────────
--
-- `olx_account_id` NÃO é telefone, WABA nem `zernio_account_id`: é a conta de
-- anunciante cujo webhook de chat a instalação registrou
-- (`POST https://apps.olx.com.br/autoservice/v1/chat` com `{"webhook": "<url>"}`,
-- autenticado por Bearer — doc `developers.olx.com.br/chat/receive_message.html`).
-- Duas contas OLX na mesma instalação endereçam contas diferentes, e reusar a
-- coluna de outro provider faria `maybeSingle()` devolver PGRST116 (issue #236).
--
-- ─── O canal nasce DESLIGADO, e isso não está no schema ────────────────────
--
-- A OLX exige cadastro de integrador e autorização OAuth do anunciante
-- (`suporteintegrador@olxbr.com`) para emitir `client_id`, e nenhuma instalação
-- tem isso hoje. As colunas nascem nullable e vazias; o desligamento é do
-- CÓDIGO (`send` desiste com `olx_not_configured`), como no Datafy — o schema
-- não deve impedir uma instalação de ligar o canal quando tiver a credencial.
--
-- Fonte de cada endpoint e limite: `docs/` e o PR desta fatia.

alter table public.channel_sessions
  add column if not exists olx_account_id text,
  add column if not exists olx_token_encrypted bytea;

comment on column public.channel_sessions.olx_account_id is
  'Conta de anunciante da OLX (canal #2927). É o sessionRef deste canal — NÃO é telefone nem WABA. Espelhado em lib/channels/session-ref.ts.';
comment on column public.channel_sessions.olx_token_encrypted is
  'Access token da OLX com escopo chat, cifrado por fn_encrypt_oauth. Autentica os três endpoints do canal (webhook, send, delete). Nunca volta à tela depois de gravado.';

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
    (provider = 'olx' and olx_account_id is not null)
  );

alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;

alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check check (provider in (
    'waha', 'nuvemshop', 'generic', 'meta_cloud', 'zernio', 'datafy',
    'stripe', 'asaas',
    'olx'
  ));

with ativos as (
  select id,
         row_number() over (
           partition by olx_account_id
           order by created_at desc nulls last, id desc
         ) as posicao
    from public.channel_sessions
   where archived_at is null
     and olx_account_id is not null
)
update public.channel_sessions s
   set olx_account_id = s.olx_account_id || '-conflito-' || s.id::text
  from ativos a
 where a.id = s.id
   and a.posicao > 1;

create unique index if not exists channel_sessions_olx_account_id_ativo_unique
  on public.channel_sessions (olx_account_id)
  where archived_at is null and olx_account_id is not null;

notify pgrst, 'reload schema';
