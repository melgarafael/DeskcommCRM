-- manifest: **Servidores MCP externos POR AGENTE, com OAuth 2.1 + PKCE delegado pelo CONTATO.** Três tabelas server-side only (RLS ligada sem policy, privilégio nenhum para `anon`/`authenticated`, como `map_provider_credentials`): `ai_agent_mcp_servers` (até 5 servidores por agente; modo `nenhuma` | `chave_estatica` | `oauth_por_contato`; chave e `client_secret` cifrados em AES-256-GCM pela chave de instalação; cache da descoberta RFC 9728/8414 em `oauth_metadados`), `mcp_oauth_pedidos` (o pedido de autorização de USO ÚNICO cujo `id` é o `state`; amarrado ao contato e à conversa do turno; `code_verifier` cifrado; expira em 10 min) e `contato_mcp_credenciais` (um token por servidor × contato, cifrado; `versao` para a renovação concorrente; `revogar_apos` agendado pelo encerramento da conversa). O gatilho `fn_mcp_agenda_revogacao_no_encerramento` só GRAVA o prazo (nunca faz HTTP); quem chama o `revocation_endpoint` (RFC 7009) é o cron `mcp-oauth-revogacao`. O servidor da organização (`organizations.settings.mcp_externo`) continua como está — servidor compartilhado legado, sem migração de dados. Funções novas revogadas de `public, anon` (as duas origens). Apêndice espelhado no fim do `baseline.sql`.

-- 9095 — servidores MCP por agente e OAuth por contato.
--
-- ── Por que as três tabelas são server-side only ─────────────────────────────
--
-- Todas guardam segredo de terceiro (chave Bearer, `client_secret`, access e
-- refresh token do CONTATO, `code_verifier`). A tela do agente lê o cadastro
-- por server action com papel `admin` conferido no servidor e devolve só o
-- `last4` — nunca a linha crua. Uma policy de RLS por organização deixaria o
-- ciphertext legível por todo membro (o defeito que a 0580 registra para
-- `organizations`); sem policy e sem GRANT, o PostgREST responde
-- `permission denied` antes de olhar linha. O isolamento entre organizações é
-- então o filtro MANUAL por `organization_id` em todo acesso do service role,
-- resolvido de fonte confiável (sessão, run, `state` do banco), nunca do corpo.
--
-- ── Por que o vínculo é com o AGENTE e não com a versão ─────────────────────
--
-- `ai_agent_versions` é imutável depois de publicada, e credencial não pode ser
-- versionada: trocar a chave não pode exigir publicar o agente, e despublicar
-- uma versão não pode ressuscitar uma chave revogada. A ESCOLHA das
-- ferramentas continua versionada em `tool_ids`, agora com o id do servidor no
-- prefixo (`mcp_externo:<servidor_id>:<leitura|escrita>:<nome>`).

create table if not exists public.ai_agent_mcp_servers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_id uuid not null references public.ai_agents(id) on delete cascade,
  nome text not null,
  -- Prefixo do nome que o MODELO vê (`<slug>__<ferramenta>`): curto, estável e
  -- dentro de `^[A-Za-z0-9_-]{1,64}$` depois de concatenado.
  slug text not null,
  endpoint text not null,
  modo_autenticacao text not null default 'chave_estatica',
  chave_encrypted bytea,
  chave_iv bytea,
  chave_tag bytea,
  chave_last4 text,
  oauth_client_id text,
  oauth_client_secret_encrypted bytea,
  oauth_client_secret_iv bytea,
  oauth_client_secret_tag bytea,
  -- Cache da descoberta (RFC 9728 + 8414) e do registro dinâmico (RFC 7591).
  -- Metadado público do authorization server — nada de segredo aqui.
  oauth_metadados jsonb not null default '{}'::jsonb,
  escopos_pedidos text[] not null default '{}'::text[],
  escrita_delegada boolean not null default false,
  retencao_apos_encerramento_horas integer not null default 0,
  ativo boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_agent_mcp_servers_modo_check
    check (modo_autenticacao in ('nenhuma', 'chave_estatica', 'oauth_por_contato')),
  constraint ai_agent_mcp_servers_nome_check
    check (char_length(btrim(nome)) between 1 and 80),
  constraint ai_agent_mcp_servers_slug_check
    check (slug ~ '^[a-z0-9]{1,16}$'),
  constraint ai_agent_mcp_servers_endpoint_check
    check (endpoint ~ '^https?://' and position('?' in endpoint) = 0 and position('#' in endpoint) = 0),
  constraint ai_agent_mcp_servers_retencao_check
    check (retencao_apos_encerramento_horas between 0 and 720),
  constraint ai_agent_mcp_servers_oauth_metadados_check
    check (jsonb_typeof(oauth_metadados) = 'object'),
  -- Escrita delegada só faz sentido com a credencial do PRÓPRIO contato.
  constraint ai_agent_mcp_servers_escrita_delegada_check
    check (not escrita_delegada or modo_autenticacao = 'oauth_por_contato')
);

create unique index if not exists ai_agent_mcp_servers_agente_slug_uk
  on public.ai_agent_mcp_servers (agent_id, slug);
create index if not exists ai_agent_mcp_servers_org_agente_idx
  on public.ai_agent_mcp_servers (organization_id, agent_id);

comment on table public.ai_agent_mcp_servers is
  'Servidores MCP externos de UM agente (até 5). Server-side only: RLS ligada sem policy e nenhum privilégio para anon/authenticated. Chave e client_secret cifrados com AES-256-GCM (AI_CRED_AES_KEY); a tela vê só chave_last4.';
comment on column public.ai_agent_mcp_servers.modo_autenticacao is
  'nenhuma | chave_estatica (Bearer fixo, com X-Deskcomm-* opcionais) | oauth_por_contato (cada contato autoriza com o login dele; um token por servidor × contato em contato_mcp_credenciais).';
comment on column public.ai_agent_mcp_servers.escrita_delegada is
  'Desligada por padrão. Ligada, uma ferramenta marcada como escrita pelo admin pode ser chamada durante a conversa COM A CREDENCIAL DO CONTATO do turno — dentro do que ele mesmo autorizou.';

create table if not exists public.mcp_oauth_pedidos (
  -- O `state` do OAuth: 256 bits aleatórios em base64url, gerados no servidor.
  id text primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  servidor_id uuid not null references public.ai_agent_mcp_servers(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  code_verifier_encrypted bytea not null,
  code_verifier_iv bytea not null,
  code_verifier_tag bytea not null,
  escopos text[] not null default '{}'::text[],
  expira_em timestamptz not null,
  usado_em timestamptz,
  created_at timestamptz not null default now(),
  constraint mcp_oauth_pedidos_id_check check (id ~ '^[A-Za-z0-9_-]{43}$')
);

create index if not exists mcp_oauth_pedidos_expira_idx
  on public.mcp_oauth_pedidos (expira_em);
create index if not exists mcp_oauth_pedidos_servidor_contato_idx
  on public.mcp_oauth_pedidos (servidor_id, contact_id);

comment on table public.mcp_oauth_pedidos is
  'Pedido de autorização OAuth de USO ÚNICO (o id é o state). Amarrado ao contato e à conversa do turno que o gerou; expira em 10 min; marcado usado_em ANTES da troca do code. Server-side only.';

create table if not exists public.contato_mcp_credenciais (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  servidor_id uuid not null references public.ai_agent_mcp_servers(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  -- NULL depois da revogação: o token deixa de existir, a linha fica como
  -- registro de que houve acesso (sem conteúdo nenhum do terceiro).
  access_token_encrypted bytea,
  access_token_iv bytea,
  access_token_tag bytea,
  refresh_token_encrypted bytea,
  refresh_token_iv bytea,
  refresh_token_tag bytea,
  expira_em timestamptz,
  escopos text[] not null default '{}'::text[],
  -- Trava otimista da renovação: quem renova grava `versao = versao + 1 where
  -- versao = <a que leu>`; o perdedor da corrida relê a credencial vencedora.
  versao integer not null default 1,
  revogar_apos timestamptz,
  revogado_em timestamptz,
  ultimo_uso_em timestamptz,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint contato_mcp_credenciais_token_check
    check (revogado_em is not null or access_token_encrypted is not null)
);

create unique index if not exists contato_mcp_credenciais_servidor_contato_uk
  on public.contato_mcp_credenciais (servidor_id, contact_id);
create index if not exists contato_mcp_credenciais_org_contato_idx
  on public.contato_mcp_credenciais (organization_id, contact_id);
create index if not exists contato_mcp_credenciais_revogar_idx
  on public.contato_mcp_credenciais (revogar_apos)
  where revogado_em is null and revogar_apos is not null;

comment on table public.contato_mcp_credenciais is
  'Token OAuth de UM contato para UM servidor MCP externo, cifrado (AES-256-GCM). Nunca sai para o modelo, log, auditoria ou event_log. Server-side only.';

alter table public.ai_agent_mcp_servers enable row level security;
alter table public.mcp_oauth_pedidos enable row level security;
alter table public.contato_mcp_credenciais enable row level security;

revoke all on public.ai_agent_mcp_servers from anon, authenticated;
revoke all on public.mcp_oauth_pedidos from anon, authenticated;
revoke all on public.contato_mcp_credenciais from anon, authenticated;
grant select, insert, update, delete on public.ai_agent_mcp_servers to service_role;
grant select, insert, update, delete on public.mcp_oauth_pedidos to service_role;
grant select, insert, update, delete on public.contato_mcp_credenciais to service_role;

drop trigger if exists trg_ai_agent_mcp_servers_updated_at on public.ai_agent_mcp_servers;
create trigger trg_ai_agent_mcp_servers_updated_at
  before update on public.ai_agent_mcp_servers
  for each row execute function public.fn_set_updated_at();

-- ── O encerramento da conversa AGENDA a revogação; nunca a executa ──────────
--
-- Trigger não faz HTTP (doutrina). Ele só grava `revogar_apos` = agora + a
-- retenção do servidor (padrão 0 = revogar no encerramento). Quem chama o
-- `revocation_endpoint` do terceiro e apaga o token é o cron
-- `app/api/v1/cron/mcp-oauth-revogacao`. Vale para todo caminho que encerra
-- conversa (tela, lote, automação), porque mora na linha e não na rota.
create or replace function public.fn_mcp_agenda_revogacao_no_encerramento()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('closed', 'resolved', 'archived')
     and old.status is distinct from new.status
     and new.contact_id is not null then
    update public.contato_mcp_credenciais c
       set revogar_apos = now() + make_interval(hours => s.retencao_apos_encerramento_horas),
           atualizado_em = now()
      from public.ai_agent_mcp_servers s
     where s.id = c.servidor_id
       and c.organization_id = new.organization_id
       and c.contact_id = new.contact_id
       and c.revogado_em is null
       and c.revogar_apos is null;
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_mcp_agenda_revogacao_no_encerramento() from public, anon, authenticated;

drop trigger if exists trg_conversations_mcp_revogacao on public.conversations;
create trigger trg_conversations_mcp_revogacao
  after update of status on public.conversations
  for each row execute function public.fn_mcp_agenda_revogacao_no_encerramento();

-- ── LGPD: anonimizar o contato revoga e APAGA os acessos dele ──────────────
--
-- Excluir o contato: a rota de exclusão revoga no terceiro ANTES (o token
-- some na cascata, e sem ele não há RFC 7009) e a FK em cascata apaga o resto.
-- Anonimizar mantém a linha do contato, então aqui: os pedidos de autorização
-- pendentes somem na hora; a credencial JÁ revogada (sem token, só o registro
-- de que houve acesso) também, porque o cron só escolhe as vivas; e as vivas
-- ficam com revogação IMEDIATA agendada — o cron revoga no terceiro (precisa
-- do token para isso) e, por o contato estar anonimizado, apaga a linha
-- inteira em vez de só esvaziá-la.
create or replace function public.fn_mcp_contato_anonimizado_revoga_acessos()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.mcp_oauth_pedidos p
   where p.organization_id = new.organization_id
     and p.contact_id = new.id;
  delete from public.contato_mcp_credenciais c
   where c.organization_id = new.organization_id
     and c.contact_id = new.id
     and c.revogado_em is not null;
  update public.contato_mcp_credenciais c
     set revogar_apos = now(),
         atualizado_em = now()
   where c.organization_id = new.organization_id
     and c.contact_id = new.id
     and (c.revogar_apos is null or c.revogar_apos > now());
  return new;
end;
$$;

revoke execute on function public.fn_mcp_contato_anonimizado_revoga_acessos() from public, anon, authenticated;

drop trigger if exists trg_contato_anonimizado_revoga_acessos_mcp on public.contacts;
create trigger trg_contato_anonimizado_revoga_acessos_mcp
  after update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized is true and old.is_anonymized is distinct from true)
  execute function public.fn_mcp_contato_anonimizado_revoga_acessos();

notify pgrst, 'reload schema';
