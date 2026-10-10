-- 0132 — o que falta para o terceiro canal ENVIAR.
--
-- Duas colunas, uma em cada tabela, por dois motivos distintos.
--
-- ─── conversations.provider_conversation_id ─────────────────────────────────
--
-- Os dois canais existentes DERIVAM o destinatário do contato: WAHA monta o
-- chatId a partir do telefone, o oficial usa o E.164 em dígitos. Este canal
-- não: quem endereça é um id de 24 hex que o INTERMEDIÁRIO inventa e devolve
-- pelo webhook (`message.received`) — medido contra a API real, não lido da doc:
--
--   6a76a2dc4b8fe115e5f6c300  ← participante 595981233187
--
-- Sem guardar esse id não há como responder DENTRO da janela de 24h: o endpoint
-- que aceita telefone exige template e devolve TEMPLATE_REQUIRED, que é
-- justamente o caminho errado para uma resposta de atendimento.
--
-- Nome GENÉRICO e não `zernio_conversation_id`: é o mesmo conceito para
-- qualquer provider que enderece por thread próprio ("o id que ELES dão a esta
-- conversa"). `channel_sessions` usa colunas por provider porque lá o FORMATO
-- difere e o CHECK precisa saber qual exigir; aqui o conceito é um só, e
-- carimbar um nome de provider numa tabela que hoje não tem nenhum seria
-- dívida gratuita.
--
-- NULLABLE de propósito, e sem CHECK amarrando ao provider: a conversa nasce
-- do webhook (que traz o id) OU do envio de template (que o devolve), e entre a
-- criação e o primeiro contato ela existe legitimamente sem id. Um `not null`
-- transformaria "ainda não sei" em erro de escrita.
--
-- ─── channel_sessions.zernio_token_encrypted ────────────────────────────────
--
-- A credencial é POR SESSÃO, não por instalação — mesma decisão da 0087 para o
-- canal oficial, e pelo mesmo motivo: duas organizações com contas diferentes
-- na mesma instalação é o multi-tenant que o CLAUDE.md estabelece desde o dia 1.
-- Cifrada pelas MESMAS RPCs do resto do repo (`fn_encrypt_oauth`/
-- `fn_decrypt_oauth`); um terceiro caminho de cifra seria mais um lugar por
-- onde a chave vaza.
--
-- Idempotente e aditiva: as duas colunas nascem nullable, nenhuma linha
-- existente as viola, e não há constraint nova a satisfazer.

alter table public.conversations
  add column if not exists provider_conversation_id text;

comment on column public.conversations.provider_conversation_id is
  'Id que o PROVIDER dá a esta thread, quando ele endereça por thread própria em vez de por telefone. Chega pelo webhook de mensagem recebida. NULL = provider endereça por telefone (WAHA, oficial) ou ainda não houve primeiro contato.';

-- Índice parcial: a busca é sempre "achar a conversa deste id do provider" na
-- entrada do webhook — caminho quente e sempre com valor. Linha sem id (a
-- maioria, dos outros dois canais) não entra no índice e não paga por ele.
create index if not exists idx_conversations_provider_conversation_id
  on public.conversations (organization_id, provider_conversation_id)
  where provider_conversation_id is not null;

alter table public.channel_sessions
  add column if not exists zernio_token_encrypted bytea;

comment on column public.channel_sessions.zernio_token_encrypted is
  'API key do intermediário, cifrada por fn_encrypt_oauth. Por SESSÃO (não por instalação) — mesma decisão da 0087 para o canal oficial.';
