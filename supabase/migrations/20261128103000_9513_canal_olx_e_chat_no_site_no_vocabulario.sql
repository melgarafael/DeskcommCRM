-- manifest: o `olx` (9422) volta ao vocabulário de `channel_sessions.provider`, do ramo de `channel_sessions_provider_ref_check` e de `conversations_channel_check`, que a 9471 (webchat) reconstruiu com a lista anterior ao canal da OLX — sem isso, a cadeia em ordem para de aceitar `olx` em silêncio (23514 na primeira gravação) e o clone que usa `supabase db push` diverge do baseline, que já tem os dois.
--
-- ─── Por que uma migration nova e não a 9471 editada ───────────────────────
--
-- A 9471 foi escrita na main quando `olx` não existia lá, e o merge do canal da
-- OLX (#2927) com o chat no site (Spec 36) é o encontro das duas intenções.
-- Editar migration já aplicada é proibido pela doutrina do repo
-- (`tests/unit/migrations-nao-encolhem-vocabulario.test.ts`): quem instalou pela
-- 9471 ficaria com um arquivo diferente do aplicado. Então a lista INTEIRA —
-- anterior mais os dois canais — sai aqui, forward-fix.
--
-- ─── Reaplicação ───────────────────────────────────────────────────────────
--
-- Um bloco `do` por constraint (drop + add juntos: o `update.sh` roda sem
-- `ON_ERROR_STOP` e um drop solto deixaria a tabela sem guarda). Idempotente.

do $x$
begin
  alter table public.channel_sessions drop constraint if exists channel_sessions_provider_check;
  alter table public.channel_sessions add constraint channel_sessions_provider_check
    check (provider = any (array['waha'::text, 'meta_cloud'::text, 'zernio'::text,
                                 'wacalls'::text, 'zernio_social'::text, 'datafy'::text,
                                 'telegram'::text, 'olx'::text, 'webchat'::text]));
end
$x$;

do $x$
begin
  alter table public.channel_sessions drop constraint if exists channel_sessions_provider_ref_check;
  alter table public.channel_sessions add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha'       and waha_session_name      is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id   is not null) or
    (provider in ('zernio', 'zernio_social') and zernio_account_id is not null) or
    (provider = 'wacalls'    and wacalls_session_id     is not null) or
    (provider = 'datafy'     and datafy_phone_number_id is not null) or
    (provider = 'telegram'   and telegram_bot_id        is not null) or
    (provider = 'olx'        and olx_seller_id          is not null) or
    (provider = 'webchat'    and webchat_public_key     is not null)
  );
end
$x$;

do $x$
begin
  alter table public.conversations drop constraint if exists conversations_channel_check;
  alter table public.conversations add constraint conversations_channel_check
    check (channel in ('whatsapp', 'instagram', 'facebook', 'telegram', 'olx', 'webchat'));
end
$x$;
