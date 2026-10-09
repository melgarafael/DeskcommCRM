
-- ---- lead.reopened vira gatilho de verdade (migration 0534, PR #2211 / issue #1528) ----
--
-- O mesmo desarme da 0417, para outro tipo. `lead.reopened` nasce do trigger
-- `fn_emit_event_on_lead_change` e a 0239 o pôs na lista de REGISTRO: sem
-- consumidor, a linha nascia `done` para não parecer fila entupida (#753).
--
-- Com o PR #2211 ele vira gatilho de automação e de webhook de saída:
-- `automationRulesHandler` o assina porque ele entrou em
-- `ENTIDADE_ESPERADA_POR_GATILHO`. Sem esta redefinição, `fn_event_log_marca_registro`
-- (BEFORE INSERT) trocaria `pending` por `done`, o drain
-- (`status='pending'` AND `event_type in (handlers)`) nunca o selecionaria, e a
-- regra "quando um lead encerrado for reaberto" seria salva e nunca rodaria.
--
-- Os outros três gatilhos do PR (`lead.won`, `lead.lost`, `lead.assigned`)
-- nunca estiveram na lista: já tinham consumidor. Nada mais muda: a lista é a
-- da 0417 sem este tipo.
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
    -- contato, lead, organização e plataforma ('lead.reopened' saiu na 0534)
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

-- Mesma ACL da 0239 e da 0417 (create or replace preserva os grants; repetir não custa
-- nada e deixa o arquivo autocontido para quem lê só esta migration).
revoke all on function public.fn_event_log_e_registro(text) from public, anon;
grant execute on function public.fn_event_log_e_registro(text) to authenticated, service_role;

-- Backfill? NENHUM, pelo mesmo motivo da 0417: as linhas antigas de
-- `lead.reopened` nasceram `done` como registro. Voltá-las para `pending` faria
-- a regra rodar hoje por uma reabertura de semanas atrás.
