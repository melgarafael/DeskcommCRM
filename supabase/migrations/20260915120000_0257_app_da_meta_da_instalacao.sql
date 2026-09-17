-- 0257 · Conectar a API oficial exigia SSH na VPS, quatro variáveis no `.env` e
-- um número por instalação (issue #850, fatia F3).
--
-- ─── O que o usuário via ────────────────────────────────────────────────────
-- "Token de verificação: não configurado nesta instalação — defina no servidor".
-- O botão "Verificar e salvar" do painel da Meta nunca concluía, e a tela do CRM
-- não dizia o que colar. Depois de resolvido à mão, as mensagens recebidas
-- morriam em `401 invalid_signature` sem erro em lugar nenhum: o número enviava e
-- não recebia. O produto é self-host para quem NÃO programa.
--
-- ─── Por que INSTALAÇÃO, e não organização ──────────────────────────────────
-- Um App da Meta atende N WABAs de N organizações (modelo Tech Provider): o App
-- Secret é do APP e o verify token é do APP. Não há linha por tenant — o que
-- amarra um payload a uma organização é o token no PATH da rota de webhook, que
-- a issue #236 já estabeleceu. Mesmo objeto de `platform_google_oauth` (0201),
-- de `platform_branding` (0155) e do eixo de anúncios (0213/0214); este arquivo
-- é um clone declarado do molde da 0201.
--
-- ─── Por que RLS LIGADA com ZERO policies ───────────────────────────────────
-- Não é descuido, é o desenho — o mesmo de `platform_google_oauth`.
--
-- A anon key VAI PARA O BROWSER. Uma tabela servida pelo PostgREST e "protegida
-- por policy" depende de a policy estar certa; uma tabela com RLS ligada, sem
-- policy nenhuma e com os grants de `anon`/`authenticated` revogados não é
-- servida de jeito nenhum. Só o `service_role`, que vive no servidor, a alcança.
--
-- E o `supabase/baseline.sql` traz `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON
-- TABLES TO anon`/`... TO authenticated`, que valem para toda tabela criada
-- DEPOIS deles: sem o `revoke` abaixo, esta tabela nasceria concedida.
--
-- O que está em jogo: quem tem o App Secret assina uma entrega de webhook VÁLIDA
-- com dados que ele inventar — mensagem, contato e movimentação de lead no
-- funil de qualquer cliente daquela instalação.
--
-- ─── A cifra é a que já existe, e isso é decisão ────────────────────────────
-- `fn_encrypt_oauth`/`fn_decrypt_oauth` (migration 0041), a mesma que
-- `lib/webhooks/secrets.ts` usa para os segredos de canal e que a 0201 usa para
-- o segredo do Google. Nenhuma função nova em `public` ⇒ nenhuma superfície
-- `security definer` nova ⇒ o item 9 da doutrina de migrations não é acionado
-- aqui, e não há grant de função a revogar além dos dois de tabela.
--
-- ─── O que NÃO entra aqui, de propósito ─────────────────────────────────────
-- * O `app_id` da Meta: nenhum leitor o consome hoje (`META_APP_ID` não aparece
--   em `app/` nem em `lib/`), e coluna especulativa é a que ninguém preenche,
--   ninguém lê e todo mundo confunde com configuração.
-- * Migração de dados do `.env` para o banco (decisão do mantenedor na issue).
--   O `.env` continua sendo o piso de rollback: código novo sobre banco antigo
--   (clone sem esta migration) tem de funcionar igual.
-- * Índice: a leitura é `.eq("id", 1)` na chave primária, e não há listagem.

create table if not exists public.platform_meta_app (
  id smallint primary key default 1,
  app_secret_encrypted bytea,
  verify_token_encrypted bytea,
  verify_token_created_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint platform_meta_app_singleton check (id = 1)
);

comment on table public.platform_meta_app is
  'O App da Meta DESTA INSTALAÇÃO (singleton): App Secret que assina a entrega do webhook e verify token que responde ao handshake. Server-side only: RLS ligada sem policies e grants revogados de anon/authenticated — o PostgREST não a serve. Nenhum dos dois segredos volta ao browser; a tela devolve apenas se existem.';
comment on column public.platform_meta_app.app_secret_encrypted is
  'Cifrado por fn_encrypt_oauth (pgp_sym_encrypt/aes256). Nunca gravar em claro: sem a chave mestra o save recusa. Quem tem este valor assina uma entrega de webhook válida com dados inventados.';
comment on column public.platform_meta_app.verify_token_encrypted is
  'Cifrado por fn_encrypt_oauth. Gerado pelo SERVIDOR (32 bytes de CSPRNG) e exibido UMA vez: não há leitura que o devolva em claro — quem perde o valor usa a rotação da tela. Um token escolhido à mão ("deskcomm", o nome da empresa) é adivinhável, e quem o acerta passa a receber o tráfego do webhook.';
comment on column public.platform_meta_app.verify_token_created_at is
  'Quando o verify token em vigor nasceu. A tela mostra a data para quem acabou de rotacionar saber se o valor colado no painel da Meta é o novo.';

alter table public.platform_meta_app enable row level security;

revoke all on public.platform_meta_app from anon, authenticated;
grant select, insert, update on public.platform_meta_app to service_role;

drop trigger if exists trg_platform_meta_app_updated_at on public.platform_meta_app;
create trigger trg_platform_meta_app_updated_at
  before update on public.platform_meta_app
  for each row execute function public.fn_set_updated_at();
