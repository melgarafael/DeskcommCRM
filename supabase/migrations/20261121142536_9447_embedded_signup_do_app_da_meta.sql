-- 9447 — Embedded Signup com o app da Meta da instalação (#4074).
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
