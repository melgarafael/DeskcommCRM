-- manifest: **O app da Meta da instalação passa a guardar o App ID e o Configuration ID do Embedded Signup (#4074).** Duas colunas de texto em `platform_meta_app` (0257), sem cifra porque não são segredo: o App ID vai ao `FB.init` e o Configuration ID ao `FB.login` no navegador. Com os dois preenchidos (e o App Secret, que troca o código pelo token), Conexões › API Oficial ganha o botão «Conectar com o Facebook» — a janela da Meta devolve número, conta e código, e a rota `/api/v1/channels/official/embedded-signup` troca o código pelo token da empresa e grava o canal pelo MESMO caminho do token colado à mão, com a origem `embedded_signup`. Acesso herdado da 0257 (só `service_role`). Baseline INSTALL/UPDATE idempotente.
-- 9463 — Embedded Signup com o app da Meta da instalação (#4074).
--
-- O app da Meta da instalação (0257) passa a guardar o App ID e o Configuration
-- ID do Embedded Signup, ao lado do App Secret. Os dois NÃO são segredo: o App ID
-- vai ao navegador no FB.init e o Configuration ID no FB.login. Por isso ficam em
-- texto, sem cifra.
--
-- A tabela continua só do `service_role` (RLS ligada, zero policies, grants
-- revogados de anon/authenticated na 0257): coluna nova herda o mesmo acesso.

alter table public.platform_meta_app
  add column if not exists app_id text,
  add column if not exists config_id text;

comment on column public.platform_meta_app.app_id is
  'App ID da Meta usado no Embedded Signup (público: vai ao FB.init no navegador).';
comment on column public.platform_meta_app.config_id is
  'Configuration ID do Embedded Signup (Facebook Login for Business). Público.';
