-- 0239 — o rascunho de um agente pode existir antes de haver número de WhatsApp.
--
-- DEFEITO: `ai_agent_versions.channel_session_id` era NOT NULL, e o editor de
-- agentes exigia o número para SALVAR. Numa instalação nova não existe uma única
-- linha em `channel_sessions` — o aparelho é pareado outro dia, com o celular na
-- mão — então o seletor abria vazio e o dono que acabou de escrever o prompt do
-- atendente não conseguia guardar uma linha dele. Medido numa VPS de cliente:
-- agente criado, prompt de 4.000 caracteres na tela, zero versões no banco.
--
-- Escolher o número é requisito para ATENDER, não para rascunhar.
--
-- PUBLICAR SEM NÚMERO CONTINUA RECUSADO, e não por esta migration: quem recusa é
-- `fn_publish_ai_agent_version`, que faz `select ... where s.id =
-- v_version.channel_session_id` e levanta `channel_session_not_found` quando não
-- acha linha — um `channel_session_id` nulo não acha nenhuma. Além dela, o
-- runtime só executa o que está em `ai_agents.published_version_id`, então
-- rascunho sem número é invisível para o atendimento por construção.
--
-- Sem backfill: afrouxar NOT NULL não invalida linha existente, e nenhuma linha
-- publicada fica com nulo (publicar exige o canal, como acima).
--
-- Idempotente: `drop not null` em coluna já anulável é no-op no Postgres.
alter table public.ai_agent_versions
  alter column channel_session_id drop not null;

comment on column public.ai_agent_versions.channel_session_id is
  'Por qual número este agente atende. NULL = ainda não escolhido (rascunho legítimo de quem não pareou o WhatsApp). Publicar com NULL é recusado por fn_publish_ai_agent_version (channel_session_not_found).';
