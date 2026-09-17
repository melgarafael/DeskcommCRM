-- Índices em chaves estrangeiras de mensagens e execuções de agentes de IA.
--
-- Motivação (Auditoria de Banco / Supabase Best Practices):
-- Chaves estrangeiras sem índice em tabelas de alto volume geram varreduras
-- sequenciais (sequential scan) inteiras na tabela filha durante deleções ou
-- updates em cascata na tabela pai (ex: exclusão de contatos, encerramento de
-- sessões de canal, rotação ou expurgo de conversas/mensagens via LGPD).
--
-- Além disso, consultas de histórico por contato ou sessão em messages e
-- ai_agent_runs passam a se beneficiar de index scans btree com filtros parciais.
--
-- Idempotente: `if not exists` em cada índice.

-- 1. Tabela messages
create index if not exists idx_messages_contact_id
  on public.messages (contact_id)
  where contact_id is not null;

create index if not exists idx_messages_channel_session_id
  on public.messages (channel_session_id)
  where channel_session_id is not null;

-- 2. Tabela ai_agent_runs
create index if not exists idx_ai_agent_runs_contact_id
  on public.ai_agent_runs (contact_id)
  where contact_id is not null;

create index if not exists idx_ai_agent_runs_channel_session_id
  on public.ai_agent_runs (channel_session_id)
  where channel_session_id is not null;

create index if not exists idx_ai_agent_runs_conversation_id
  on public.ai_agent_runs (conversation_id)
  where conversation_id is not null;

create index if not exists idx_ai_agent_runs_inbound_message_id
  on public.ai_agent_runs (inbound_message_id)
  where inbound_message_id is not null;

create index if not exists idx_ai_agent_runs_outbound_message_id
  on public.ai_agent_runs (outbound_message_id)
  where outbound_message_id is not null;
