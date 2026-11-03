-- manifest: **Número oficial conectado com um clique, pela conta do provedor da instalação.** `channel_sessions` ganha `zernio_profile_id` (o perfil que a instalação criou no provedor para esta organização), `zernio_webhook_id` (a assinatura de webhook que entrega os eventos da conta: na conexão por um clique, o webhook ÚNICO da instalação; na chave própria, o do número) e `zernio_credencial_da_instalacao` (a sessão usa a chave da INSTALAÇÃO, lida na hora, em vez de guardar cópia). O CHECK `channel_sessions_zernio_credencial_unica` impede as duas credenciais ao mesmo tempo.
--
-- ═══ O que o cliente da instalação não conseguia ═══
--
-- Conectar o número pelo provedor parceiro pedia a chave de API e o id da
-- conta no painel do provedor, e depois colar a URL e o segredo do webhook lá.
-- Quem revende a instalação tem a conta do provedor; o cliente dele não tem
-- acesso a ela. Agora a instalação cria um perfil por organização, abre a
-- página de cadastro da Meta do próprio provedor e, na volta, põe o perfil no
-- webhook da instalação — sem nada para colar.
--
-- ═══ Por que um ponteiro e não uma cópia da chave ═══
--
-- Copiar a chave da instalação cifrada em cada sessão faria N cópias do mesmo
-- segredo, e trocar a chave deixaria todas as conexões falando com a antiga.
-- Com o ponteiro, a credencial é resolvida na hora (`lib/channels/zernio/
-- credentials.ts`): trocar a chave da instalação vale para todas, e apagar a
-- organização não deixa cópia para trás.
--
-- ═══ Por que o webhook da conexão por um clique é ÚNICO ═══
--
-- O provedor limita as assinaturas de webhook por conta e recomenda um
-- endpoint para todos os clientes. As conexões por um clique entram por um
-- webhook só da instalação (id e segredo em `platform_config`, filtrado aos
-- perfis das conexões ativas), e `zernio_webhook_id` guarda o id dessa
-- assinatura compartilhada — que a remoção do canal NÃO apaga: só tira o
-- perfil do filtro. Na chave própria, a coluna é a assinatura do número,
-- apagada na remoção.
--
-- ═══ Por que colunas e não o `metadata` ═══
--
-- O `metadata` da sessão é do ingest e do roteamento; um `update` de lá
-- apagaria o perfil e o webhook daqui. É a mesma razão da 0311.
--
-- Idempotente: `add column if not exists` e constraint recriada por nome. Toda
-- linha existente nasce com `false` e satisfaz o CHECK: não há dado a corrigir.
-- Nenhuma função nova.

alter table public.channel_sessions
  add column if not exists zernio_profile_id text,
  add column if not exists zernio_webhook_id text,
  add column if not exists zernio_credencial_da_instalacao boolean not null default false;

alter table public.channel_sessions
  drop constraint if exists channel_sessions_zernio_credencial_unica;
alter table public.channel_sessions
  add constraint channel_sessions_zernio_credencial_unica
  check (not (zernio_credencial_da_instalacao and zernio_token_encrypted is not null));

comment on column public.channel_sessions.zernio_profile_id is
  'Perfil do provedor parceiro em que a conta foi conectada. Só a conexão por um clique o grava: é por ele que a volta confere que a conta conectada é desta organização, e é ele que entra no filtro do webhook da instalação. Migration 9093.';
comment on column public.channel_sessions.zernio_webhook_id is
  'Assinatura de webhook que entrega os eventos desta conta, registrada pela INSTALAÇÃO. Na conexão por um clique é o webhook ÚNICO da instalação (compartilhado, filtrado aos perfis das conexões ativas; id em platform_config): a remoção do canal tira o perfil do filtro e NÃO apaga a assinatura. Na chave própria é a assinatura do número (filtrada à conta), apagada na remoção. Nulo quando o operador configurou o webhook à mão. Migration 9093.';
comment on column public.channel_sessions.zernio_credencial_da_instalacao is
  'true = a sessão fala com o provedor pela chave da INSTALAÇÃO (platform_config), resolvida na hora; zernio_token_encrypted fica nulo. false = chave própria da organização, cifrada em zernio_token_encrypted. Migration 9093.';
