-- 0311 · O webhook do NÚMERO, registrado pela própria instalação (issue #850, fatia F1).
--
-- ─── O que o usuário via ────────────────────────────────────────────────────
-- Conectar o canal oficial era metade do caminho: o canal ENVIAVA e não RECEBIA até
-- alguém entrar no painel da Meta, abrir a configuração do webhook, colar a URL de
-- callback e escolher os campos — por número. Quem não sabia disso (o produto é
-- self-host para quem NÃO programa) ficava com um canal que parece pronto e cujas
-- mensagens recebidas simplesmente não existem em lugar nenhum: nem erro, nem log.
--
-- ─── O que estas colunas guardam ────────────────────────────────────────────
-- O DESFECHO do registro automático, não a configuração: a URL que ficou registrada
-- (`meta_webhook_override_uri`), o motivo da última falha (`..._erro`) e quando foi
-- (`..._em`). São o que a tela lê para dizer "conectado, webhook pendente: <motivo>"
-- com botão de tentar de novo — em vez de dizer "conectado" e deixar a descoberta
-- para a primeira mensagem que nunca chega.
--
-- ─── Por que colunas, e não o `metadata` jsonb que já existe na tabela ──────
-- Porque a TELA consulta este estado a cada render e o desfecho tem três leitores
-- (GET do canal, POST de conexão, rota de re-registro): chave dentro de jsonb é
-- contrato que ninguém vê quebrar — o `metadata` da sessão é do ingest/roteamento, e
-- misturar os dois faz um `update` de lá apagar o desfecho daqui.
--
-- ─── Por que registrar DEPOIS de gravar a sessão ────────────────────────────
-- O GET de verificação da Meta chega no instante em que o override é registrado e
-- procura a sessão pelo `webhook_path_token`. Registrar antes de a linha existir
-- devolveria 404, e a Meta marcaria o webhook como inválido — pior que não registrar.
-- Ordem invertida = defeito, não preferência.
--
-- ─── Exposição: nenhuma nova ────────────────────────────────────────────────
-- A URL registrada contém o `webhook_path_token`, que JÁ vive nesta tabela
-- (`channel_sessions`, com `GRANT ALL` a anon/authenticated e RLS de isolamento por
-- organização desde as migrations 0106/0099). Não há coluna nova de segredo, não há
-- grant novo, não há policy nova: a coluna herda exatamente o acesso das vizinhas.
-- O que ela NÃO guarda é o token da Meta — esse continua só em
-- `meta_token_encrypted`, cifrado (fn_encrypt_oauth).
--
-- ─── O que NÃO entra aqui, de propósito ─────────────────────────────────────
-- * `message_template_status_update`: a Meta NÃO aceita override por número para este
--   tópico — ele continua indo para a URL do app (limite da plataforma, não escolha).
-- * Limpeza no arquivamento do canal e reaplicação na reconexão: é a fatia F1b, e
--   roda em cima destas mesmas colunas (`meta_webhook_override_uri` null = desfeito).
-- * Índice: as três colunas são lidas sempre pela chave primária da sessão.

alter table public.channel_sessions
  add column if not exists meta_webhook_override_uri text,
  add column if not exists meta_webhook_override_erro text,
  add column if not exists meta_webhook_override_em timestamptz;

comment on column public.channel_sessions.meta_webhook_override_uri is
  'URL de callback registrada na Meta para ESTE número (override por phone_number_id). Nulo = não registrado (ou desfeito). Contém o webhook_path_token, que já é desta tabela.';
comment on column public.channel_sessions.meta_webhook_override_erro is
  'Motivo da última falha ao registrar o webhook, como a Graph API devolveu. Não é falha da conexão: o canal envia normalmente; o que depende disto é a ENTREGA. Nulo = última tentativa deu certo.';
comment on column public.channel_sessions.meta_webhook_override_em is
  'Quando foi a última TENTATIVA de registrar (sucesso ou falha). A tela usa a data para o operador saber se o estado que ele vê é o de agora.';
