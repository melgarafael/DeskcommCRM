-- Tipo de evento que ninguém consome não é fila: é registro — e registro nasce `done`.
--
-- O DEFEITO (issue #753)
--
-- `event_log.status` tem `DEFAULT 'pending'` e `emit_event`/`fn_log_event` não
-- escolhem status. Só que quem DRENA filtra por tipo: `lib/event-log/drain.ts`
-- seleciona `status='pending'` **E** `event_type in (tipos com handler
-- registrado)`, e o drain do agent-engine
-- (`lib/agent-engine/edge/crm/drain.ts`) filtra
-- `event_type='ai_agent.dispatch_requested'`. Um evento-fato — que por
-- definição não precisa de consumidor (é o que o cabeçalho de
-- `tests/unit/evento-comando-tem-consumidor.test.ts` já diz) — não é
-- selecionado por nenhum dos dois: a linha nasce `pending` e morre `pending`.
--
-- Medido numa instalação real (a da issue): 626 linhas `pending`, 8 tipos,
-- `consumed_by` vazio em todas. Indistinguíveis de fila entupida para quem olha
-- o painel, e invisíveis para quem deveria limpá-las.
--
-- O QUE ESTA MIGRATION FAZ
--
--   1. `fn_event_log_e_registro(tipo)` — a lista dos tipos que são REGISTRO,
--      em UM lugar (a lista tem de ser exaustiva, então o lugar importa);
--   2. trigger `BEFORE INSERT` que fecha o registro no nascimento
--      (`pending` → `done`, sem tocar em mais nada);
--   3. backfill das linhas que já acumularam.
--
-- A lista mora no BANCO porque é o banco que escreve o status: quem emitir um
-- tipo novo sem consumidor no futuro cai em
-- `tests/unit/evento-de-fato-nao-fica-pendente.test.ts`, que lê esta lista e a
-- cobra exaustiva em relação ao que o código emite.
--
-- O QUE ELA NÃO FAZ (de propósito)
--
--   - Não toca em `*_requested` (comando). Sem consumidor, o pedido NÃO foi
--     atendido: essa linha tem de ficar na fila, visível. `message.send_requested`
--     segue como dívida declarada na issue #129 — fechar aqui seria esconder
--     entrega que não aconteceu.
--   - Não inclui tipo que TEM consumidor. O dispatcher seleciona por
--     `status='pending'` e `event_type in (handlers)`: um tipo consumido que
--     nascesse `done` deixaria o handler registrado sem NUNCA rodar
--     (`lead.created`, `message.received`, `contact.tag_added`, …). É por isso
--     que a lista não pode ser a convenção do nome — tem de ser enumerada.
--   - Não apaga, não arquiva e não mexe em `consumed_by`: ninguém consumiu, e é
--     exatamente isso que a coluna vazia informa. `done` preserva histórico,
--     realtime e auditoria.
--
-- PRECEDENTE NO PRÓPRIO REPO
--
-- Duas vezes, e as duas com a mesma frase: `lib/agent-engine/agent/operator-turn.ts`
-- insere `agent.operator_turn` com `status='done'` no nascimento (e
-- `app/api/v1/ai/operator-metrics/route.ts` lê esse tipo por agregação), e
-- `lib/wacalls/events-bridge.ts` faz o mesmo com `voice_call.ended`,
-- comentando que a linha nascia `pending` e "ficava pendurada para sempre com
-- cara de trabalho na fila". Ou seja: quando já se sabe que ninguém consome,
-- este repo fecha o fato na ORIGEM. Esta migration generaliza isso para quem
-- insere pelo caminho padrão (`emit_event`), que não tinha como escolher.
--
-- DÍVIDA DECLARADA (fora do alcance de uma lista fixa)
--
-- Dois emissores escolhem o tipo em runtime, então nenhum `array[...]` os
-- alcança: `app/api/v1/webhooks/nuvemshop/[event]/route.ts`
-- (`nuvemshop.${evento}`) e as regras de automação
-- (`lib/automation/actions/add-tag.ts`, `p_event_type: target.event`). As linhas
-- deles continuam `pending` até alguém decidir o vocabulário — declarado em
-- `NAMESPACE_ABERTO`, no teste, para não virar esquecimento silencioso.
--
-- DIAGNÓSTICO (o que a issue mediu, agora com registro e fila separados)
--
--   select event_type,
--          count(*) filter (where status = 'pending') as na_fila,
--          count(*) filter (where status = 'done'
--                             and coalesce(array_length(consumed_by, 1), 0) = 0) as registros
--     from public.event_log
--    group by 1
--    order by na_fila desc;
--
-- `consumed_by` vazio continua sendo a marca de "ninguém consumiu": um tipo
-- consumido de verdade tem o `consumer_key` do handler na coluna, e aí `done`
-- significa "handler rodou".
--
-- Idempotente: `create or replace` nas duas funções, `drop trigger if exists`
-- antes do trigger, e o backfill por igualdade de status (reaplicar casa 0 linhas).

-- ---- Registro não nasce `pending` (migration 0239) ----
--
-- Racional completo no cabeçalho desta migration. Em uma linha: tipo de evento
-- que ninguém consome não é fila — é registro, e a linha nasce `done`.
create or replace function public.fn_event_log_e_registro(p_event_type text)
returns boolean
language sql
immutable
set search_path to 'public', 'pg_temp'
as $$
  select p_event_type = any (array[
    -- IA e agente
    'ai.responded',
    'ai_agent.created',
    'ai_agent.published',
    'ai_agent.run_completed',
    'ai_agent.run_failed',
    'ai_agent.run_started',
    -- agente (harness) — o motor registra quando não há negócio para pendurar
    'agent.activity_unrouted',
    -- canal e conversa
    'channel_session.status_changed',
    'conversation.claimed',
    'conversation.transferred',
    'whatsapp.chat_id_not_recognized',
    'whatsapp.conversation_mark_failed',
    -- contato, lead, organização e plataforma
    'contact.anonymized',
    'contact.created',
    'contact.deleted',
    'contact.updated',
    'crm.activity_write_failed',
    'incident.resolved',
    'lead.bulk_assigned',
    'lead.bulk_deleted',
    'lead.bulk_tagged',
    'lead.reopened',
    'lead.risk_backlog_seeded',
    'lead.updated',
    'org.updated',
    'tenant.onboarded',
    'tenant.reactivated',
    'tenant.suspended',
    'user.profile_updated',
    -- mensagem
    'message.failed',
    'message.outbound',
    'message.sending',
    'message.sent',
    -- LGPD
    'lgpd.export_delivered',
    'lgpd.export_generated',
    'lgpd.redact_applied',
    'lgpd.redact_failed'
  ]::text[]);
$$;

-- Mesma ACL de `fn_log_event` (migration 0034): função pura de leitura, útil no
-- SQL editor de uma instalação, e nunca alcançável pela anon key.
revoke all on function public.fn_event_log_e_registro(text) from public, anon;
grant execute on function public.fn_event_log_e_registro(text) to authenticated, service_role;

create or replace function public.fn_event_log_marca_registro()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  -- Só o que nasce `pending`: quem escolhe status na origem não é reescrito
  -- (o agent-engine insere `ai_agent.dispatch_requested` e
  -- `agent.operator_turn` com o status que quer).
  if new.status = 'pending' and public.fn_event_log_e_registro(new.event_type) then
    new.status := 'done';
  end if;
  return new;
end;
$$;

revoke all on function public.fn_event_log_marca_registro() from public, anon;
grant execute on function public.fn_event_log_marca_registro() to service_role;

drop trigger if exists trg_event_log_marca_registro on public.event_log;
create trigger trg_event_log_marca_registro
  before insert on public.event_log
  for each row
  execute function public.fn_event_log_marca_registro();

-- Backfill do estoque: só os tipos da lista, e só `pending` — `processing`
-- (claim perdido, dono é o reaper do drain) e `dead` (erro de consumidor) são
-- outra história, com outro dono.
update public.event_log
   set status = 'done'
 where status = 'pending'
   and public.fn_event_log_e_registro(event_type);

notify pgrst, 'reload schema';
