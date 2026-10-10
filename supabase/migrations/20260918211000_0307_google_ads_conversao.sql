-- 0307 · A credencial que FALTAVA em `ad_platform_connections` para o Google
-- Ads: refresh token OAuth (não um token longo-vivo como o da Meta) mais os
-- três identificadores que dizem PARA ONDE reportar dentro da conta.
--
-- ─── Por que colunas novas na MESMA tabela, e não uma tabela própria ───────
-- `ad_platform_connections` (0213) já é o desenho "uma linha por
-- (organização, plataforma)", com RLS server-side-only e cifra por
-- `fn_encrypt_oauth`. O Google não muda NENHUMA dessas propriedades — só
-- precisa de campos que a Meta não usa. Mesmo padrão de `channel_sessions`
-- (colunas nullable específicas de provider na mesma tabela, não tabela por
-- provider), documentado na migration 0233.
--
-- ─── Por que refresh token, e não access token direto ──────────────────────
-- O access token da Meta dura meses; o do Google Ads dura ~1 hora. Guardar um
-- access token do Google seria guardar algo que expira antes da próxima
-- venda fechar. O refresh token é de longa duração (só expira se revogado), e
-- o transporte troca ele por um access token novo A CADA ENVIO —
-- `lib/plataformas-de-anuncio/google/token.ts` faz essa troca, não esta
-- migration.
--
-- ─── Os três identificadores, e por que nenhum vem do OAuth ────────────────
-- O consentimento do Google prova QUEM autorizou, não EM QUAL conta de
-- anúncios nem EM QUAL ação de conversão gravar — uma pessoa pode gerenciar
-- várias contas. `google_customer_id` (a conta), `google_login_customer_id`
-- (a conta de GERENTE/MCC, quando a conta é acessada através de uma — nullable
-- porque nem toda organização usa MCC) e `google_conversion_action_id` (qual
-- ação de conversão, dentro da conta, recebe os envios) são digitados pela
-- tela, não descobertos pelo fluxo OAuth.
--
-- Sem CHECK cruzando `platform` com estas colunas: mesma folga que
-- `dataset_id`/`access_token_encrypted` já têm para a Meta — a completude é
-- responsabilidade de `lib/plataformas-de-anuncio/credenciais.ts`, não do
-- schema, porque o que conta como "completo" varia por plataforma.

alter table public.ad_platform_connections
  add column if not exists google_refresh_token_encrypted bytea,
  add column if not exists google_customer_id text,
  add column if not exists google_login_customer_id text,
  add column if not exists google_conversion_action_id text;

comment on column public.ad_platform_connections.google_refresh_token_encrypted is
  'Refresh token OAuth do Google Ads, cifrado por fn_encrypt_oauth. Só platform=google_ads usa esta coluna — o access token derivado dele expira em ~1h e nunca é persistido.';
comment on column public.ad_platform_connections.google_customer_id is
  'A conta de anúncios do Google Ads (10 dígitos, sem hífen) para onde a organização reporta conversões.';
comment on column public.ad_platform_connections.google_login_customer_id is
  'A conta de GERENTE (MCC) através da qual google_customer_id é acessada, quando aplicável. NULL = acesso direto, sem MCC.';
comment on column public.ad_platform_connections.google_conversion_action_id is
  'Qual ação de conversão, dentro de google_customer_id, recebe os envios de venda. Formato: só o id numérico, o resource name completo é montado no transporte.';
