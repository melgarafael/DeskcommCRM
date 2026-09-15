-- 0260 — o título do evento pessoal do Google sai do alcance do membro
--
-- ─── O que estava aberto, e foi medido ──────────────────────────────────────
--
-- `public.calendar_external_events` é o espelho da agenda PESSOAL de quem
-- atende: o compromisso que a pessoa sincronizou só para bloquear o próprio
-- horário — "Consulta médica", "Terapia", "entrevista de emprego". Numa clínica,
-- é o terapeuta que sincroniza a agenda pessoal e tem o texto legível pela
-- recepção inteira.
--
-- O papel `authenticated` tinha SELECT de TABELA nesta tabela, e a view
-- `calendar_selected_external_events` era `select e.*` — com o `title` dentro.
-- Num banco instalado do zero (`baseline.sql` da v1.26.0), um membro de OUTRO
-- papel, inclusive Somente leitura, lia o compromisso particular do colega:
--
--     select title from public.calendar_external_events …   → "Terapia sigilosa"
--
-- tanto direto na tabela quanto pela view; e
-- `has_column_privilege('authenticated','calendar_external_events','title','SELECT')`
-- respondia `true`.
--
-- ─── Por que o conserto é no PRIVILÉGIO, e não na policy ────────────────────
--
-- A policy de leitura é da ORGANIZAÇÃO de propósito: a grade da equipe mostra a
-- ocupação do colega, e é isso que a agenda existe para fazer. Restringir a
-- policy ao dono da conexão apagaria a ocupação de todo mundo — consertaria a
-- privacidade quebrando a agenda. O que o CRM usa de um evento de colega é
-- ocupado/livre (`starts_at`, `ends_at`, `transparency`, `status`); o `title`
-- não tem consumidor nenhum, e há gate disso em
-- `tests/unit/ocupacao-do-google-nao-expoe-titulo.test.ts` (a tela da Agenda e a
-- rota de agendamentos não pedem a coluna).
--
-- Então o SELECT de `authenticated` sai da TABELA e volta COLUNA A COLUNA, sem o
-- `title`. Revogar a coluna sem revogar a tabela não faria nada: privilégio de
-- tabela cobre todas as colunas, e o `GRANT` enumerado do dump só ACRESCENTA.
--
-- ─── A view precisa ser recriada, não substituída no lugar ──────────────────
--
-- `calendar_selected_external_events` era `select e.*`. Com `security_invoker`,
-- o Postgres confere privilégio de coluna EM NOME DO INVOCADOR para toda coluna
-- referenciada na definição — inclusive as de um `e.*` já expandido quando a
-- view nasceu. Deixá-la assim faria TODA leitura de ocupação por membro falhar
-- com `permission denied` no `title`. E `create or replace view` não aceita
-- tirar coluna do meio (o Postgres recusa: "cannot drop columns from view"):
-- daí o `drop` + `create` com lista explícita. A lista explícita é o conserto de
-- fundo — `e.*` era a forma de a próxima coluna nascer exposta.
--
-- ─── Onde o dono continua lendo o próprio título ────────────────────────────
--
-- No espelho: `service_role`, que esta migration não toca, segue gravando e
-- lendo o `title` (é o worker e são as `fn_google_*`). Nenhuma tela mostra o
-- título de um evento externo — o gate de tela citado acima é quem garante
-- isso —, então não há leitura de titular a preservar nos papéis do PostgREST;
-- se um dia houver uma tela do titular, ela nasce com função `security definer`
-- própria e o invariante muda junto, de propósito.
--
-- ─── O que esta migration NÃO faz, de propósito ─────────────────────────────
--
-- * Não apaga os títulos já gravados. O dado do dono continua no espelho; o que
--   se fecha é a LEITURA por outro membro. Apagar histórico é decisão do dono e
--   sai em migration própria, não de carona num conserto de permissão.
-- * Não concede nada a `anon`, que segue sem SELECT desde a 0108.
--
-- ─── Forma ──────────────────────────────────────────────────────────────────
--
-- `revoke`, `grant`, `drop view if exists` são idempotentes: o `update.sh` de um
-- clone reaplica à vontade. O apêndice rotulado do `baseline.sql` traz o mesmo
-- bloco para quem instala do zero. Vigiado por
-- `tests/invariants/titulo-do-evento-pessoal-fora-do-alcance.test.ts`.

revoke select on public.calendar_external_events from authenticated;

grant select (
  id, organization_id, connection_id, external_calendar_id, external_event_id,
  starts_at, ends_at, is_all_day, status, transparency, external_updated_at,
  created_at, updated_at, ical_uid, seen_generation, recurring_event_id,
  original_start_time
) on public.calendar_external_events to authenticated;

drop view if exists public.calendar_selected_external_events;

create view public.calendar_selected_external_events
with (security_invoker = true) as
select
  e.id, e.organization_id, e.connection_id, e.external_calendar_id,
  e.external_event_id, e.starts_at, e.ends_at, e.is_all_day, e.status,
  e.transparency, e.external_updated_at, e.created_at, e.updated_at,
  e.ical_uid, e.seen_generation, e.recurring_event_id, e.original_start_time
from public.calendar_external_events e
where e.status <> 'cancelled'
  and public.fn_google_counts_for_conflicts(e.organization_id, e.connection_id, e.external_calendar_id);

revoke all on public.calendar_selected_external_events from public, anon;

grant select on public.calendar_selected_external_events to authenticated, service_role;

notify pgrst, 'reload schema';
