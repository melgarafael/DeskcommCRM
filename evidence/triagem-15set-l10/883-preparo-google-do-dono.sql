-- Preparo da jornada #883 — o Google Agenda da DONA, sem Google real.
-- Aplicado com psql no Postgres do stack local qa-l10 (127.0.0.1:60322), como
-- superusuário, depois do baseline.sql. As três tabelas são as que a coleta lê:
--   fn_agenda_ocupacao_google_do_dono → calendar_selected_external_events
--     (view sobre calendar_external_events, filtrada por
--      fn_google_counts_for_conflicts, que consulta calendar_connection_calendars)
--     junta calendar_connections (user_id = dona, status);
--   fn_agenda_conexoes_google_do_dono → calendar_connections (status, last_sync_at);
--   fn_google_coverage → calendar_connection_calendars (sync_coverage, last_sync_at,
--     access_role, available) — preenchido para a cobertura ficar COMPLETA e o
--     aviso "Ocupação do Google ainda não verificada" não entrar na conta.
-- O título do evento é sensível DE PROPÓSITO: é ele que não pode aparecer na tela.
with dona as (
  select u.id as user_id, uo.organization_id
    from auth.users u join public.user_organizations uo on uo.user_id = u.id
   where u.email = 'dona.l10@qa.local' and uo.role = 'admin'
), conexao as (
  insert into public.calendar_connections
    (organization_id, user_id, provider, account_email, status, last_sync_at, scopes)
  select organization_id, user_id, 'google_calendar', 'dona.pessoal@gmail.test',
         'healthy', now(), array['https://www.googleapis.com/auth/calendar']
    from dona
  returning id, organization_id
), agenda as (
  insert into public.calendar_connection_calendars
    (organization_id, connection_id, external_calendar_id, name, is_primary,
     counts_for_conflicts, is_destination, access_role, available, time_zone,
     last_sync_at, sync_error, sync_coverage)
  select organization_id, id, 'dona.pessoal@gmail.test', 'Pessoal', true,
         true, false, 'owner', true, 'America/Sao_Paulo',
         now(), null,
         jsonb_build_object('window_start', '2026-09-01T00:00:00Z', 'window_end', '2026-12-31T00:00:00Z')
    from conexao
  returning organization_id, connection_id, external_calendar_id
)
insert into public.calendar_external_events
  (organization_id, connection_id, external_calendar_id, external_event_id, title,
   starts_at, ends_at, is_all_day, status, transparency)
select organization_id, connection_id, external_calendar_id, 'evt-qa-l10-cardio',
       'Cardiologista particular - exame de esforco',
       '2026-09-21T10:00:00-03:00', '2026-09-21T11:00:00-03:00', false, 'confirmed', 'opaque'
  from agenda;
