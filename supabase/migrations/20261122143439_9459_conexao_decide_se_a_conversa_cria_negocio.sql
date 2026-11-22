-- 9459_conexao_decide_se_a_conversa_cria_negocio — #4670: a chave é POR CONEXÃO.
--
-- manifest: **A conexão decide se a conversa nova abre negócio no funil (#4670).** Coluna `channel_sessions.conversa_nova_cria_negocio`, `boolean not null default true`: o DEFAULT é o comportamento de TODA instalação de hoje — conversa nova cria card —, então quem só atualiza não muda de operação, e nenhuma organização precisa desligar nada para continuar como está. A recusa entra em UM lugar só, `garantirLeadDaConversa` (`lib/leads/nascimento-do-lead.ts`), logo depois do "já existe", com motivo próprio (`conexao_nao_cria_negocio`) — o ponto único já cobre a pós-entrada (`abrirDemanda`), a mensagem enviada pelo celular (`nascerLeadDaConversaPeloCelular`), a ligação do voice-agent e a conversa que o CRM abre, e cobre qualquer chamador futuro. Desligada, a pessoa não desaparece: o contato nasce, a conversa aparece no Inbox, o agente de IA atende e o card só não nasce. A criação à mão (painel da conversa, ficha do contato, `crm_create_lead`) continua idêntica: não passa por este ponto. A leitura usa a organização no filtro junto com a conversa; falha de leitura NÃO cria o card naquela mensagem (a próxima tenta de novo — o nascimento já é idempotente por contato). Sem RLS nova: a coluna anda com as policies que `channel_sessions` já tem, e a escrita auditada sai de rota de admin com o cliente de serviço. Gate: `tests/unit/conexao-decide-se-a-conversa-cria-negocio.test.ts`.
--
-- ---- a CONEXÃO decide se a conversa nova cria negócio (issue #4670) ----
--
-- O caso de uso está na issue: uma empresa com vários números usa só alguns para
-- vender, e os outros (suporte, pós-venda, o celular de um vendedor) enchem o
-- funil de cards que alguém precisa perder à mão. A chave que existia,
-- `organizations.settings.crm.entrada_automatica_no_funil`, é da organização
-- inteira e vale só para a conversa que o CRM abre — não serve para isto.
--
-- ⚠️ `default true` NÃO É DETALHE: é o que faz a atualização ser invisível. Toda
-- linha existente nasce ligada (no Postgres 11+ um default não-volátil não
-- reescreve a tabela), e a instalação antiga que nunca abrir a tela continua
-- criando card em todo número, exatamente como antes.
--
-- Por que COLUNA e não `metadata`: a chave é lida no caminho quente da ingestão,
-- uma vez por card que nasce. `metadata` é jsonb sem CHECK possível e sem
-- default — a leitura teria de adivinhar ausência (e a ausência, aqui, significa
-- LIGADO, o oposto do `guardar_historico` da #999). Coluna booleana com default
-- diz a mesma coisa sem depender de nenhum leitor lembrar da regra.

alter table public.channel_sessions
  add column if not exists conversa_nova_cria_negocio boolean not null default true;

comment on column public.channel_sessions.conversa_nova_cria_negocio is
  'Issue #4670: a conversa nova que chega por esta conexão abre negócio no funil padrão? true (DEFAULT, e o estado de toda instalação de antes) = sim, como sempre foi. false = a conversa e o contato nascem, o Inbox e a IA seguem, e só o card não nasce; criar à mão (crm_create_lead, painel da conversa, ficha do contato) continua igual.';
