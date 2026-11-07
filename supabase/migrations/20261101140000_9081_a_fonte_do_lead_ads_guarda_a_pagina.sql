-- manifest: webhook_sources ganha a PÁGINA da Meta que a fonte representa (roteamento por page_id), o token de página CIFRADO com o mesmo fn_encrypt_oauth do secret da fonte, e a opção de buscar as respostas na Graph API — DESLIGADA por padrão, como o critério da doc 235 (núcleo, opt-in de quem administra).

-- ═══ POR QUE ESTAS TRÊS COLUNAS EXISTEM (issue #3768) ═══════════════════════
--
-- O aviso de formulário preenchido da Meta chega SEM as respostas: traz o
-- `leadgen_id` e os ids de página/formulário/anúncio, e o resto (nome, telefone,
-- e-mail, respostas) só existe atrás de uma chamada autenticada à Graph API, com
-- um token de PÁGINA que tem a permissão de leitura de leads. Sem token, nenhum
-- lead real entra — o aviso vira um registro de "chegou sem as respostas".
--
-- O token é da PÁGINA, não da instalação: um App da Meta serve N páginas de N
-- organizações, e a página é a unidade que a fonte de captação representa (ela
-- já é a dona do funil e da etapa de destino). Por isso ele mora na FONTE, e não
-- em `platform_meta_app` — que guarda o App Secret, esse sim da instalação
-- inteira. Guardar o token da página a nível de instalação faria a segunda
-- organização a conectar sobrescrever o token da primeira.
--
-- ═══ O TOKEN É CIFRADO COM O MECANISMO QUE JÁ EXISTE ════════════════════════
--
-- `fn_encrypt_oauth` (pgp_sym_encrypt/AES-256 com a chave da GUC
-- `app.nuvemshop_oauth_key`), a MESMA RPC de `webhook_sources.secret_encrypted`
-- (migration 0041) e de `platform_meta_app` (0257). Não há criptografia própria:
-- quem cifra é `encryptWebhookSecret` (`lib/webhooks/secrets.ts`), e sem a chave
-- mestra o save RECUSA em vez de degradar para texto claro. Escrever é só pela
-- rota que exige `admin` da organização; a LEITURA nunca devolve o valor — a
-- tela recebe `has_meta_page_token`, como já recebe `has_secret`.
--
-- ═══ POR QUE A BUSCA NASCE DESLIGADA ════════════════════════════════════════
--
-- Critério da doc 235 (o mesmo das avaliações do Google neste produto): a
-- capacidade entra no NÚCLEO, desligada por padrão, e quem administra liga. Ela
-- só aparece quando funciona de ponta a ponta, e ligar exige o token colado —
-- uma fonte sem token com a busca ligada recusa nomeando o motivo, em vez de
-- pedir credencial que ninguém cadastrou.
--
-- ═══ SEM TABELA NOVA ════════════════════════════════════════════════════════
--
-- A página pertence à fonte de captação, exatamente como o funil e a etapa de
-- destino; uma tabela de páginas criaria um segundo lugar para responder "de
-- quem é esta página" e duas verdades sobre o destino do lead.
--
-- `uniq_webhook_sources_meta_page` é o que impede a ambiguidade no roteamento:
-- ids de página são globais, e uma página pertence a UM negócio, então duas
-- fontes (de qualquer organização) reivindicando a mesma página é erro de
-- configuração. Com o índice único, o roteamento por `entry[].id` nunca tem de
-- escolher entre duas fontes — escolher seria escrever na empresa errada.

alter table public.webhook_sources
  add column if not exists meta_page_id text;

alter table public.webhook_sources
  add column if not exists meta_page_token_encrypted bytea;

alter table public.webhook_sources
  add column if not exists meta_lead_retrieval boolean not null default false;

comment on column public.webhook_sources.meta_page_id is
  'A página da Meta que esta fonte representa (issue #3768). É a chave de ROTEAMENTO: o aviso do formulário traz entry[].id e o App tem uma URL de destino só para o objeto page, então a mesma URL recebe leads de todas as páginas — quem é o dono do lead é esta coluna, não o path_token da URL. NULL = a fonte não reivindica página nenhuma e recebe o que chegar na própria URL (configuração de uma página só).';

comment on column public.webhook_sources.meta_page_token_encrypted is
  'Token de PÁGINA com permissão de leitura de leads, cifrado por fn_encrypt_oauth (o mesmo mecanismo de secret_encrypted e de platform_meta_app). Write-only: nenhuma leitura da API o devolve — a tela recebe has_meta_page_token. Sem a chave mestra de cifra o save RECUSA; nunca é gravado em claro.';

comment on column public.webhook_sources.meta_lead_retrieval is
  'Opção da fonte (issue #3768), DESLIGADA por padrão: quando o aviso chega sem as respostas (que é o que a Meta manda), a rota busca as respostas na Graph API com o token da página antes de desistir do lead. Critério da doc 235: no núcleo, desligado por padrão, quem administra liga. Desligada, o aviso sem respostas continua sendo registrado como ignorado, com motivo nomeado.';

-- Roteamento sem ambiguidade. Parcial: fonte sem página fica de fora do índice
-- (NULL não colide com NULL), então a configuração de uma página só — a de quem
-- nunca preencheu a coluna — não é afetada.
create unique index if not exists uniq_webhook_sources_meta_page
  on public.webhook_sources (meta_page_id)
  where meta_page_id is not null;

notify pgrst, 'reload schema';
