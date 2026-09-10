-- F4 Ryze: permitir arquivamento forense na rota neutra sem alterar provedores legados.
-- A sanitização do corpo ocorre antes de abrir o arquivo; esta migration apenas
-- alinha a constraint ao provider já registrado em channel_sessions.

alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;

alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check check (provider in (
    'waha', 'nuvemshop', 'generic', 'meta_cloud', 'zernio', 'ryze'
  ));
