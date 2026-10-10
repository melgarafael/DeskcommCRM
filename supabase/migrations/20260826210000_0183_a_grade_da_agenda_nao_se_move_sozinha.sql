-- ============================================================================
-- 0183 — A GRADE NÃO ATUALIZA SOZINHA, E O DIAGNÓSTICO VAI PARA O LUGAR ERRADO
--
-- `publication supabase_realtime` é um array fechado, e `calendar_appointments`
-- não estava nele. O `.channel()` sobe, o `subscribe` devolve SUBSCRIBED,
-- nenhum erro em lugar nenhum — e nenhum evento chega nunca. Duas pessoas com a
-- agenda aberta não veem o que a outra marcou até alguém recarregar, e a tela
-- parada é indistinguível de "ninguém marcou nada".
--
-- ⚠️ E o agravante é de diagnóstico: nesta base o canal já morre calado por
-- OUTRO motivo quando o token não chega ao socket. Quem for investigar vai
-- direto para o `setAuth`, que é onde o defeito esteve antes — e não para a
-- publicação, que é onde ele está agora. Dois defeitos com o MESMO sintoma
-- (SUBSCRIBED e silêncio) fazem o segundo custar o dobro.
--
-- ─── Por que SÓ `calendar_appointments`, e não as seis ───────────────────
-- A doutrina desta publicação julga tabela a tabela, com as palavras do próprio
-- schema: `crm_lead_scores` ficou FORA porque "recálculo é telemetria e não deve
-- pintar card"; `crm_lead_risk_states` entrou porque "risco é mudança de estado".
--
--   calendar_appointments   ENTRA. Alguém marcou, remarcou ou cancelou às 14h de
--                           quinta — é mudança de estado, e é o que a grade
--                           mostra.
--   calendar_external_events FICA FORA. É espelho reescrito em lote pelo sync do
--                           Google; o próprio `comment on table` diz que não é
--                           compromisso nosso. Um sync que traz 200 eventos
--                           publicaria 200 pulsos seguidos — é o "pulso que
--                           mente" da 0075 em forma de calendário. Se um dia
--                           entrar, a contrapartida vive no ESCRITOR: só escrever
--                           quando horário ou status mudarem de fato, nunca
--                           `delete + insert` da janela inteira.
--   calendar_connections     FICA FORA. Guarda token OAuth e tem RLS com gate de
--                           papel; publicar mudança dela é superfície sem
--                           consumidor.
--   event_types, exceptions, connection_calendars  FICAM FORA. São configuração:
--                           mudam quando alguém edita, e quem edita já está na
--                           tela que recarrega.
--
-- ─── O QUE ESTA MIGRATION NÃO RESOLVE, e quem for assinar precisa saber ──
-- `replica identity` tem ZERO ocorrência neste schema — nem no baseline, nem nas
-- migrations. Com o default (PK), o payload de DELETE traz SÓ o `id`.
--
-- Consequência concreta para esta tela: um canal que assine com
-- `filter: owner_user_id=eq.<uuid>` NÃO recebe o DELETE, porque o payload não
-- tem `owner_user_id` para casar o filtro — e o card do compromisso apagado fica
-- na tela até o F5. As tabelas que já estão na publicação convivem com isso
-- porque seus consumidores invalidam a query inteira no `onChange`, em vez de
-- aplicar o payload.
--
-- NÃO ponho `replica identity full` aqui, e a razão é medida: hoje não existe
-- assinante — `app/app/agenda/_client.tsx` tem zero ocorrência de realtime.
-- Ligar `full` aumenta o WAL de toda escrita da tabela para servir um consumidor
-- que ainda não existe, e a decisão de COMO a tela lida com o DELETE (invalidar
-- a janela ou aplicar o payload) é de quem escrever o hook. Fica declarado aqui
-- para não ser descoberto em produção.
--
-- Aditiva e idempotente: só acrescenta uma tabela à publicação, com a guarda de
-- `pg_publication_tables` que o próprio baseline usa.
-- ============================================================================

do $$
begin
  if not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    create publication supabase_realtime;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'calendar_appointments'
  ) then
    execute 'alter publication supabase_realtime add table public.calendar_appointments';
  end if;
end $$;

comment on table public.calendar_appointments is
  'O compromisso COMBINADO: hora marcada, com alguém, ocupando a agenda de um atendente. Distinto do RETORNO agendado (cron_jobs kind=at, job_kind=followup_turn), que é decisão interna do sistema, não ocupa agenda de ninguém e o cliente não sabe. ESTÁ na publicação supabase_realtime (migration 0183) porque marcar e cancelar é mudança de estado, não telemetria — mas o DELETE só traz o id, então um canal com filter por owner_user_id não o recebe.';

notify pgrst, 'reload schema';
