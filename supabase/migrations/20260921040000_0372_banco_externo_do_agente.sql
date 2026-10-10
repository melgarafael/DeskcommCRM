-- 0372 · O agente não enxergava os dados que moram no banco do outro sistema.
--
-- Recorte do PR #1130, de @vgamkt. Na branch dele este arquivo é o 0233; 0233 e
-- 0234 já foram para outra coisa na `main`, então a numeração foi realocada no
-- momento do recorte — o conteúdo é o dele, sem uma linha alterada.
--
-- ─── O buraco que isto fecha ────────────────────────────────────────────────
-- O DeskcommCRM fala com o banco dele, e só. Quando o dono tem um SEGUNDO CRM
-- (ou qualquer sistema) que escreve num PostgreSQL à parte, esses dados eram
-- invisíveis para o agente que atende no WhatsApp — e é justamente ali que mora
-- o que o cliente pergunta (pedido, assinatura, matrícula, saldo).
--
-- Esta tabela é o CADASTRO da conexão. A leitura do banco externo é feita por
-- `lib/external-db/` (pool somente-leitura, introspecção ao vivo) e exposta como
-- ferramenta MCP do agente. O schema do banco externo NÃO é espelhado aqui de
-- propósito: ele muda com frequência, e cópia de schema envelhece.
--
-- ─── Por que ORGANIZAÇÃO, e não instalação ──────────────────────────────────
-- O mesmo desenho de `ad_platform_connections` (0213) e pelo mesmo motivo: duas
-- empresas hospedadas na mesma VPS têm bancos externos diferentes. Um singleton
-- faria o agente de um cliente responder com dado de outro.
--
-- ─── Por que a senha usa AES-GCM do APP, e não `fn_encrypt_oauth` ───────────
-- `ad_platform_connections` cifra com pgcrypto (`fn_encrypt_oauth`) porque quem
-- usa o token é o próprio Postgres. Aqui NÃO: quem abre a conexão é o Node via
-- `pg`, então a chave tem de estar no processo, e a cifra acompanha
-- `ai_provider_credentials` (0023) — AES-256-GCM com `AI_CRED_AES_KEY`, em
-- `lib/crypto/aes_gcm.ts`. Cifrar com pgcrypto exigiria mandar a senha em claro
-- ao banco só para decifrá-la depois, o que não fecha.
--
-- ─── Por que a metadata é legível pela organização, e a senha não ───────────
-- Diferente das tabelas server-only acima, aqui a LISTA de conexões é visível a
-- qualquer membro (decisão do dono): saber que existe uma fonte de dados não é
-- segredo. O que nunca sai do servidor é o segredo em si — a `_safe` view omite
-- as três colunas cifradas, e a senha só é decifrada dentro da rota que consulta
-- o banco externo.
--
-- Nenhuma função nova em `public` ⇒ nenhuma superfície `security definer` nova ⇒
-- o item 9 da doutrina de migrations não é acionado por este arquivo.

-- ─────────────────────────────────────────────────────────────────────────────
-- external_db_connections — o cadastro da fonte externa
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.external_db_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Nome humano da conexão. É por ele que a tela e o agente a chamam.
  label text not null,
  host text not null,
  port integer not null default 5432,
  database_name text not null,
  username text not null,
  -- AES-256-GCM (AI_CRED_AES_KEY), três colunas como em `ai_provider_credentials`:
  -- ciphertext, IV de 12 bytes e tag de 16 bytes. Nunca há coluna em claro.
  password_encrypted bytea not null,
  password_iv bytea not null,
  password_tag bytea not null,
  -- `disable|prefer|require|verify-ca|verify-full`. O default é `require` porque
  -- um Postgres/Supabase remoto sem TLS manda credencial e dado em claro pela
  -- rede; `disable` fica disponível para quem conecta em rede local confiável.
  ssl_mode text not null default 'require',
  -- Desligar sem apagar. Apagar é outro botão: pausar não deve custar reapontar
  -- host, porta e credencial.
  enabled boolean not null default true,
  last_tested_at timestamptz,
  last_test_ok boolean,
  -- Mensagem do último teste. NÃO guarda a senha: o erro do `pg` é truncado antes
  -- de gravar. É a superfície que a tela lê para dizer por que a conexão falhou.
  last_test_error text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Dois cadastros com o mesmo nome deixariam a tela e o agente ambíguos — o
  -- mesmo modo de falha que a #236 mediu em `channel_sessions`.
  constraint external_db_connections_label_uk unique (organization_id, label),
  constraint external_db_connections_port_valido check (port between 1 and 65535),
  constraint external_db_connections_ssl_conhecido
    check (ssl_mode in ('disable', 'prefer', 'require', 'verify-ca', 'verify-full'))
);

comment on table public.external_db_connections is
  'Conexão da organização com um PostgreSQL externo (outro CRM/sistema). A senha é cifrada com AES-GCM (AI_CRED_AES_KEY) e nunca é exposta: a tela lê external_db_connections_safe. O schema do banco externo não é espelhado — a introspecção é ao vivo.';
comment on column public.external_db_connections.password_encrypted is
  'Ciphertext AES-256-GCM. Par de password_iv (12 bytes) e password_tag (16 bytes). Sem AI_CRED_AES_KEY a leitura falha fechada.';
comment on column public.external_db_connections.ssl_mode is
  'Modo TLS da conexão pg. Default require: remoto sem TLS vaza credencial e dado.';
comment on column public.external_db_connections.last_test_error is
  'Erro do último teste de conexão, truncado e sem segredo. Superfície de falha lida pela tela.';

create index if not exists external_db_connections_org_idx
  on public.external_db_connections (organization_id)
  where enabled;

alter table public.external_db_connections enable row level security;

drop policy if exists tenant_isolation_external_db_connections_select on public.external_db_connections;
create policy tenant_isolation_external_db_connections_select on public.external_db_connections
  for select
  using (organization_id in (select * from public.fn_user_org_ids()));

-- Leitura: qualquer membro (D2). Escrita: a policy também exige `admin` — não
-- é redundância com a API, que já pede `admin`; é a mesma regra na camada que
-- sobrevive a uma rota nova. E é o que mantém a tabela fora da dívida de RBAC
-- (policy `ALL` só-tenancy): um `viewer` falando direto com o PostgREST não
-- reconfigura a credencial da fonte de dados.
drop policy if exists tenant_isolation_external_db_connections_modify on public.external_db_connections;
drop policy if exists tenant_isolation_external_db_connections_write on public.external_db_connections;
create policy tenant_isolation_external_db_connections_write on public.external_db_connections
  for all
  using (
    organization_id in (select * from public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  )
  with check (
    organization_id in (select * from public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  );

revoke all on public.external_db_connections from anon;

-- View segura: SELECT sem as colunas cifradas. `security_invoker` garante que a
-- RLS da tabela base se aplica a quem consulta (não vaza entre organizações).
drop view if exists public.external_db_connections_safe;
create view public.external_db_connections_safe
  with (security_invoker = true)
  as
  select id, organization_id, label, host, port, database_name, username,
         ssl_mode, enabled, last_tested_at, last_test_ok, last_test_error,
         created_by, created_at, updated_at
  from public.external_db_connections;

revoke all on public.external_db_connections_safe from anon;
grant select on public.external_db_connections_safe to authenticated;

drop trigger if exists trg_external_db_connections_updated_at on public.external_db_connections;
create trigger trg_external_db_connections_updated_at
  before update on public.external_db_connections
  for each row execute function public.fn_set_updated_at();

drop trigger if exists trg_external_db_connections_audit on public.external_db_connections;
create trigger trg_external_db_connections_audit
  after insert or update or delete on public.external_db_connections
  for each row execute function public.fn_audit_log_row();
