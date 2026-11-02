-- manifest: Habilita a caixa Hostinger como canal conversacional do CRM. A
-- sessão reutiliza `waha_session_name` como referência interna opaca; não há
-- transporte WAHA associado a ela.

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  check (provider = any (array[
    'waha'::text,
    'meta_cloud'::text,
    'zernio'::text,
    'wacalls'::text,
    'zernio_social'::text,
    'datafy'::text,
    'hostinger_email'::text
  ]));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha' and waha_session_name is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    (provider in ('zernio', 'zernio_social') and zernio_account_id is not null) or
    (provider = 'wacalls' and wacalls_session_id is not null) or
    (provider = 'datafy' and datafy_phone_number_id is not null) or
    (provider = 'hostinger_email' and waha_session_name is not null)
  );

alter table public.conversations
  drop constraint if exists conversations_channel_check;

alter table public.conversations
  add constraint conversations_channel_check
  check (channel in ('whatsapp', 'email', 'instagram', 'facebook'));

notify pgrst, 'reload schema';
