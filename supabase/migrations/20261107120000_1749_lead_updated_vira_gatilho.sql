-- manifest: **O `lead.updated` vira gatilho de automação de verdade (issue #1749).** O evento já era emitido por `updateLeadHandler` com `payload: { fields }` — os NOMES das colunas que a edição mudou —, mas estava na lista de REGISTRO da `fn_event_log_e_registro` (0239, redefinida na 0417 e na 9212): a linha nascia `done`, o dreno nunca a selecionava e nenhuma regra podia reagir a "o valor foi preenchido", "a data prevista mudou", "o campo personalizado recebeu aprovado". Com o gatilho em `ENTIDADE_ESPERADA_POR_GATILHO` e o handler de automação assinando-o, o tipo ganha consumidor; esta migration é o conserto do outro lado, o mesmo da 0417 com `message.failed`: redefinição ADITIVA que tira `lead.updated` da lista (0239/0417/9212 intocadas), com a linha do baseline espelhada. Sem backfill: as linhas antigas nasceram `done` como registro e continuam legíveis assim — voltá-las a `pending` faria o motor reprocessar edição velha com o estado de hoje do negócio.

-- ---- lead.updated vira gatilho (migration 1749, issue #1749) ----
--
-- O DEFEITO
--
-- `lead.updated` nasce de `updateLeadHandler` (PATCH /api/v1/leads/[id]) com
-- `p_payload = { fields }`, onde `fields` são os NOMES das colunas que a edição
-- realmente mudou (`lib/leads/campos-alterados.ts`) — nunca os valores (§9:
-- nenhuma PII nova em log, evento ou webhook). O evento existe desde a wave 6.
--
-- O que faltava era consumidor: a 0239 colocou o tipo na lista de REGISTRO, e o
-- trigger BEFORE INSERT daquela migration troca `pending` por `done` para todo
-- tipo dessa lista. Com a linha `done` no nascimento, o dreno
-- (`status='pending'` E `event_type in (handlers)`) nunca a lê — e a estratégia
-- de automação "quando o negócio for alterado" era impossível de montar.
--
-- O CONSERTO (o mesmo da 0417 com `message.failed`)
--
--   `fn_event_log_e_registro` é `create or replace`, então a definição vigente
--   é a ÚLTIMA escrita em ordem de aplicação. Esta migration reescreve a lista
--   SEM `lead.updated`; a 0239, a 0417 e a 9212 ficam como estão (já rodaram em
--   toda instalação existente, e reescrever migration aplicada é proibido).
--
-- Nada mais muda: a lista continua idêntica à da 9212, com este tipo só.
-- `tests/unit/evento-de-fato-nao-fica-pendente.test.ts` é quem cobra o par
-- (tipo com consumidor NÃO pode estar na lista) e a igualdade com o baseline;
-- `tests/invariants/lead-updated-dispara-automacao.test.ts` prova o caminho
-- inteiro contra Postgres: a edição emite, a linha NASCE `pending`, o dreno a
-- consome e a regra dispara — e que a alteração de OUTRO campo não dispara.
--
-- POR QUE A CONDIÇÃO POR CAMPO NÃO PEDE VALOR NO PAYLOAD
--
-- "Dispara só quando `expected_close_date` mudou" é respondido pela lista de
-- NOMES (`event.fields`) pelo operador `campo_alterado`
-- (`lib/automation/conditions.ts`). Assim o evento continua sem antes-e-depois:
-- quem quer decidir pelo valor ATUAL usa as condições de sempre sobre o lead
-- hidratado (`lead.custom_fields.status eq aprovado`), que o motor já monta.
--
-- BACKFILL? NENHUM, e de propósito — mesma decisão da 0417: as linhas antigas
-- de `lead.updated` já nasceram `done` como registro e continuam legíveis como
-- estão. Voltar uma delas para `pending` faria o motor reprocessar uma edição
-- de semanas atrás com o estado do negócio de hoje, e uma automação que manda
-- mensagem ao cliente dispararia por um fato que já passou.
--
-- CUSTO POR EVENTO: toda edição de negócio passa a acordar o motor (uma
-- consulta de regras por evento). O volume real numa instalação grande NÃO foi
-- medido nesta fatia; a query é a mesma dos outros gatilhos de lead e só roda
-- quando existe pelo menos uma regra ativa do tipo.
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
    'conversation.closed',
    'conversation.transferred',
    'whatsapp.chat_id_not_recognized',
    'whatsapp.conversation_mark_failed',
    -- contato, lead, organização e plataforma
    -- ('lead.reopened' saiu na 0534 e 'lead.updated' sai aqui na 1749: ganharam consumidor)
    'contact.anonymized',
    'contact.created',
    'contact.deleted',
    'contact.updated',
    'crm.activity_write_failed',
    'incident.resolved',
    'lead.bulk_assigned',
    'lead.bulk_deleted',
    'lead.bulk_tagged',
    'lead.risk_backlog_seeded',
    'org.updated',
    'tenant.onboarded',
    'tenant.reactivated',
    'tenant.suspended',
    'user.profile_updated',
    -- mensagem ('message.failed' saiu aqui na 0417: ele ganhou consumidor)
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
