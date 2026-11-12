-- manifest: **A fila do push do Google drena: compromisso encerrado e cancelado já convergido saem da seleção (#4448, segunda porta).** `calendar_service_google_candidates` não filtrava `status` nem data, e o ramo `google_event_id is not null and google_conflict is null` da fila admitia TODO compromisso já publicado; na issue são 8 compromissos encerrados (6 `completed`, 1 `cancelled`, 1 `no_show`) presos a um ciclo de 5 minutos. A view passa a exigir `status in ('pending','confirmed','cancelled')` — `completed`/`no_show` não empurram (lib/agenda/laco.ts) — e `ends_at` depois do INÍCIO da janela que o sync já usa (`now()-interval '1 day'`, a mesma de `window_start` em `fn_google_calendar`). O `cancelled` fica porque é ele que pede a remoção do evento no Google. `status` e `ends_at` entram no FIM da view (create or replace só aceita coluna nova no fim) e são o que `lib/agenda/google/candidates.ts` repete, para o filtro valer também antes do `limit 50`. Idempotente (`create or replace view`, ACL preservada; grants repetidos). Prova em `tests/invariants/agenda-google-fila-drena.test.ts` e `tests/invariants/agenda-google-recovery.test.ts`.
--
-- 9358 — A FILA DO PUSH DRENA (#4448, segunda porta).
--
-- ═══ O defeito, medido ═══
--
-- O cron `agenda-google-push` roda a cada 5 minutos e seleciona por
-- `lib/agenda/google/candidates.ts`, que lê esta view com três ramos em OU:
--
--   1. `needs_google_push` — há mudança local que ainda não foi ao Google;
--   2. `google_event_id is not null and google_conflict is null` — "associação
--      antiga também é relida";
--   3. `google_conflict->'resolution' is not null` — há decisão humana a aplicar.
--
-- O ramo 2 não olha NADA além de "já foi publicado". Compromisso encerrado
-- (`completed`, `no_show`) e compromisso que já convergiu continuam entrando a
-- cada ciclo para sempre: o executor relê o evento no Google e não tem o que
-- escrever, mas o lote nunca drena. É a segunda porta da issue #4448 — a
-- primeira (agenda indisponível vira estado terminal no `claim`) é o PR #4453 e
-- NÃO é tocada aqui.
--
-- ═══ O que passa a ser verdade ═══
--
-- A fila é do que ainda PODE mudar no Google:
--
--   * `status in ('pending','confirmed','cancelled')`. `completed` e `no_show`
--     saem por DOUTRINA, não por gosto: `precisaEmpurrarAoGoogle`
--     (lib/agenda/laco.ts) já diz que o desfecho não empurra — "o evento lá fora
--     já aconteceu; registrar aqui que a pessoa compareceu não muda nada no
--     calendário dela". O `cancelled` FICA: é o único status que pede escrita
--     externa (a remoção do evento).
--   * `ends_at > now()-interval '1 day'`. É o INÍCIO da janela que o próprio
--     sync usa (`window_start` da leitura completa em `fn_google_calendar`:
--     `now()-interval '1 day'` a `now()+interval '90 days'`). Não é janela nova:
--     compromisso que terminou antes do começo do espelho que o CRM mantém não
--     tem o que mudar do outro lado. O FIM da janela não entra: cortar a ida por
--     90 dias adiaria a criação de um evento marcado para daqui a cinco meses.
--
-- ⚠️ O CANCELAMENTO TARDIO de um compromisso que já saiu da janela não vai ao
-- Google. É a mesma régua que o desfecho já pratica (`no_show` nunca empurrou) e
-- o fantasma que sobra é de um evento passado; o caso que importa — cancelar o
-- que ainda vai acontecer — continua na fila.
--
-- ═══ As duas colunas novas ═══
--
-- `status` e `ends_at` entram no FIM da lista, e no fim de propósito:
-- `create or replace view` recusa coluna nova no meio (e recusa renomear), mas
-- aceita acrescentar no fim. Elas existem porque o recorte também mora em
-- `candidates.ts`, onde o filtro do PostgREST é aplicado ANTES do `limit 50` —
-- sem elas, a linha morta voltaria a ocupar o lote. O invariante
-- `agenda-google-fila-drena` compara os dois conjuntos (SQL direto na view × a
-- função de candidatos) e reprova se um lado ficar sem o recorte.
--
-- ⚠️ NO `baseline.sql` O CORPO APARECE DUAS VEZES, e tem de ser idêntico: a
-- definição original da view (logo abaixo do `fn_google_appointment`) também
-- recebeu o recorte, porque o `update.sh` aplica o baseline inteiro DE NOVO
-- sobre o schema instalado — e `create or replace view` não aceita recriar com
-- menos colunas ("cannot drop columns from view"). O bloco do apêndice é o
-- espelho desta migration; os dois textos são os mesmos.
create or replace view public.calendar_service_google_candidates with (security_invoker=true) as
 select a.id,a.organization_id,
  case when a.service_occurrence_id is null and not a.service_block then a.owner_user_id else coalesce(link.user_id,dest.user_id) end owner_user_id,
  a.needs_google_push,a.google_event_id,a.google_conflict,a.google_next_attempt_at,
  a.status,a.ends_at
 from public.calendar_appointments a
 left join public.calendar_connections link on link.organization_id=a.organization_id and link.id=a.google_connection_id
 left join public.calendar_connection_calendars k on k.organization_id=a.organization_id and k.id=a.service_destination_calendar_id
 left join public.calendar_connections dest on dest.organization_id=k.organization_id and dest.id=k.connection_id
 where ((a.service_occurrence_id is null and not a.service_block) or a.service_publication_mode<>'none')
  and not exists(select 1 from public.contacts c where c.organization_id=a.organization_id and c.id=a.contact_id and c.is_anonymized)
  and a.status in ('pending','confirmed','cancelled')
  and a.ends_at>now()-interval '1 day';
revoke all on public.calendar_service_google_candidates from public,anon,authenticated;
grant select on public.calendar_service_google_candidates to service_role;
notify pgrst,'reload schema';
