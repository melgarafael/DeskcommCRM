-- ---- message.failed vira gatilho de verdade (migration 0417, issue #1614) ----
--
-- O gatilho `message.failed` nasce do banco (fn_emit_message_event, AFTER
-- INSERT) e do cron recover-stuck-messages, mas a migration 0239 o colocou na
-- lista de REGISTRO: um tipo que ninguém consome, cuja linha nasce `done` para
-- não parecer fila entupida (issue #753).
--
-- Com a #1614 ele passa a ter consumidor: `automationRulesHandler` o assina
-- porque ele entrou em `ENTIDADE_ESPERADA_POR_GATILHO`, e a rota do webhook da
-- Meta + o `catch` do envio passam a emiti-lo quando a linha vira `failed`.
--
-- E aí a 0239 virou um ARMADILHA, e é esta função que desarma:
--
--   `fn_event_log_marca_registro` roda BEFORE INSERT e troca `pending` por
--   `done` para todo tipo da lista. Um `message.failed` emitido hoje nasceria
--   `done`, o drain (`status='pending'` AND `event_type in (handlers)`) nunca o
--   selecionaria e o handler registrado nunca rodaria — silenciosamente, que é
--   exatamente o modo de falha que a 0239 e a #1614 estão no mesmo combate:
--   "a regra aparece na tela, o operador salva, o evento acontece e nada roda".
--
-- Nada mais muda: a lista continua idêntica à da 0239, com este tipo só.
-- `tests/unit/evento-de-fato-nao-fica-pendente.test.ts` é quem cobra o par
-- (tipo com consumidor NÃO pode estar na lista), e ele lê a ÚLTIMA definição —
-- esta — porque é ela que o banco usa.
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
    -- mensagem ('message.failed' SAIU aqui na 0417: ele tem consumidor)
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

-- Mesma ACL da 0239 (create or replace preserva os grants; repetir não custa
-- nada e deixa o arquivo autocontido para quem lê só esta migration).
revoke all on function public.fn_event_log_e_registro(text) from public, anon;
grant execute on function public.fn_event_log_e_registro(text) to authenticated, service_role;

-- Backfill? NENHUM, e de propósito: as linhas antigas de `message.failed` já
-- nasceram `done` como registro e continuam legíveis como estão. Voltar uma
-- delas para `pending` faria o motor reprocessar evento velho — regra rodando
-- hoje por falha de entrega de semanas atrás, com o estado do contato de hoje.
