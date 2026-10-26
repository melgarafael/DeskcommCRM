-- 0773 — o bot do Telegram entra no seam de canais (issue #3440, fatia T1).
--
-- ─── O que entra ───────────────────────────────────────────────────────────
--
--   1. Duas colunas em `channel_sessions` para a conexão: o id do robô (que é o
--      `sessionRef` deste canal) e o token do @BotFather, CIFRADO pelas mesmas
--      RPCs do resto do repo (`fn_encrypt_oauth`, via `lib/webhooks/secrets.ts`).
--      O token nunca volta para a tela.
--   2. `'telegram'` no vocabulário de `channel_sessions.provider` e no ramo do
--      `channel_sessions_provider_ref_check` (esta linha exige `telegram_bot_id`).
--   3. `'telegram'` em `conversations_channel_check` — a ingestão grava o canal
--      na conversa, e sem o valor o INSERT volta 23514. Como o Telegram
--      REENTREGA o webhook que não recebe 200, isso viraria 500 eterno com a
--      conexão aparecendo ligada na tela e a conversa nunca nascendo.
--   4. Índice único do robô ativo, no molde da 0165 (número do canal oficial):
--      dois `channel_sessions` ativos não podem apontar para o MESMO bot — dois
--      webhooks disputariam o `getUpdates`/`setWebhook` e a caixa de entrada de
--      uma organização receberia as conversas da outra.
--
-- ─── Por que o bot não tem telefone ────────────────────────────────────────
--
-- `channel_sessions.phone_number` fica NULL: o Telegram não expõe o telefone de
-- quem conversa com o bot, e o contato entra por `contacts.social_identity`
-- (`telegram:<robô>:<usuário>`), no molde da 0368. É também o motivo de o
-- provider ficar FORA de `PROVIDERS_DE_TELEFONE` em `lib/channels/capabilities.ts`
-- (a lição do #3358/#3364: o lembrete por telefone saía pelo Instagram).
--
-- ─── Fora desta migration, de propósito ────────────────────────────────────
--
-- `groups` não entra: a v1 atende só conversa privada (`groups: "none"` na
-- matriz). Nada de tabela nova, nada de coluna em `contacts` — a identidade
-- social já existe desde a 0368.
--
-- ─── Reaplicação ───────────────────────────────────────────────────────────
--
-- `add column if not exists`; as três constraints trocadas dentro de um bloco
-- `do` (com o `update.sh` sem `ON_ERROR_STOP`, `drop` e `add` soltos deixariam a
-- tabela SEM guarda se o `add` falhasse); `create index if not exists`; os
-- `comment on column` dentro de `to_regclass`, porque um clone cujo
-- `channel_sessions` suma/renomeie não pode derrubar a atualização inteira por
-- causa de um comentário.

alter table public.channel_sessions
  add column if not exists telegram_bot_id text,
  add column if not exists telegram_token_encrypted bytea;

do $$
begin
  if to_regclass('public.channel_sessions') is not null then
    comment on column public.channel_sessions.telegram_bot_id is
      'Id do bot no Telegram (getMe.id). É o sessionRef deste canal e a chave da social_identity do contato.';
    comment on column public.channel_sessions.telegram_token_encrypted is
      'Token do bot (@BotFather) cifrado por fn_encrypt_oauth. Nunca volta para a tela nem para o log.';
  end if;
end
$$;

-- ─── Vocabulário do provider ───────────────────────────────────────────────
do $$
begin
  alter table public.channel_sessions drop constraint if exists channel_sessions_provider_check;
  alter table public.channel_sessions add constraint channel_sessions_provider_check
    check (provider = any (array['waha'::text, 'meta_cloud'::text, 'zernio'::text,
                                 'wacalls'::text, 'zernio_social'::text, 'datafy'::text,
                                 'telegram'::text]));

  alter table public.channel_sessions drop constraint if exists channel_sessions_provider_ref_check;
  alter table public.channel_sessions add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha'       and waha_session_name    is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    (provider in ('zernio', 'zernio_social') and zernio_account_id is not null) or
    (provider = 'wacalls'    and wacalls_session_id    is not null) or
    (provider = 'datafy'     and datafy_phone_number_id is not null) or
    (provider = 'telegram'   and telegram_bot_id      is not null)
  );
end
$$;

-- ─── Vocabulário do canal da conversa ──────────────────────────────────────
do $$
begin
  alter table public.conversations drop constraint if exists conversations_channel_check;
  alter table public.conversations add constraint conversations_channel_check
    check (channel in ('whatsapp', 'instagram', 'facebook', 'telegram'));
end
$$;

-- ─── Um bot, uma conexão ativa ─────────────────────────────────────────────
create unique index if not exists channel_sessions_telegram_bot_id_ativo_unique
  on public.channel_sessions (telegram_bot_id)
  where archived_at is null and telegram_bot_id is not null;

notify pgrst, 'reload schema';
