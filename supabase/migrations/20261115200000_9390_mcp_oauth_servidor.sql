-- manifest: **O MCP do CRM aceita OAuth 2.1, para clientes que não deixam colar chave (ChatGPT).** Três tabelas server-side only (RLS ligada, nenhuma policy, nenhum privilégio para `anon`/`authenticated`): `mcp_oauth_clientes` (registro dinâmico, RFC 7591, da instalação — sem organização, sem dado de cliente; segredo só como SHA-256), `mcp_oauth_codigos` (código de autorização de uso único, 5 min, amarrado a organização, pessoa, cliente, redirect_uri e desafio PKCE S256; só o hash) e `mcp_oauth_concessoes` (a conexão: um `api_tokens` por concessão, o refresh token só como hash). O access token É um `dsk_` de `api_tokens` — o mesmo ator, papel, escopos (`mcp:read`, `mcp:write`, `role:admin`), auditoria e isolamento dos tokens de servidor, mais `aud:mcp`: o token só vale no `/api/mcp`, nunca no `/api/v1`; revogar na tela de Tokens de API desliga a conexão. Funções `security definer` só para `service_role`: `fn_mcp_oauth_trocar_codigo` (PKCE conferido no banco, código queimado mesmo na recusa, reuso revoga a concessão emitida), `fn_mcp_oauth_renovar` (rotação do refresh: cada refresh vale uma vez, e reapresentar um já rotacionado desliga a conexão; re-confere que a pessoa segue admin da organização e que o token não foi revogado na tela), `fn_mcp_oauth_revogar` (RFC 7009, só concessões do próprio cliente) `fn_mcp_oauth_registrar_cliente` (teto de 100 clientes nunca autorizados, que nunca recusa: o registro novo despeja o pendente mais antigo, poupando só quem tem código de autorização vivo — sob advisory lock) e `fn_mcp_oauth_podar` (chamada pelo cron diário `data-retention`: códigos vencidos, cliente registrado e nunca autorizado depois de 24 h, cliente parado há 180 dias, concessões mortas há 30 dias). Idempotente; espelho no apêndice do `baseline.sql`, antes da cascata da 9243 (e portanto antes da varredura de `anon`). Prova em `tests/invariants/mcp-oauth-servidor.test.ts`.

-- O CRM COMO SERVIDOR DE AUTORIZAÇÃO DO PRÓPRIO MCP
--
-- O `/api/mcp` só aceitava `Authorization: Bearer dsk_…`. O ChatGPT (e outros
-- clientes de MCP) não oferece campo de cabeçalho: só OAuth ou "sem
-- autenticação". Chave na URL é proibida (anti-pattern 12). Então o CRM passa a
-- ser o servidor de autorização do próprio recurso, seguindo a especificação de
-- autorização do MCP: metadados (RFC 9728 / RFC 8414), registro dinâmico
-- (RFC 7591), código de autorização com PKCE S256 e rotação de refresh token.
--
-- A decisão que segura o resto: o access token NÃO é uma credencial nova. É uma
-- linha de `api_tokens`, no formato `dsk_…`, com hash SHA-256. O `/api/mcp`
-- valida exatamente como antes — mesmo ator (`api_token`), mesmos escopos,
-- mesma auditoria (`actor_api_token_id`), mesmo teto de falhas, mesma recusa de
-- organização suspensa. A renovação troca o hash NA MESMA LINHA: uma conexão é
-- uma linha só, e a tela de Tokens de API mostra e revoga a conexão.
--
-- Nada aqui é alcançável pela REST com a anon key: as tabelas não têm
-- privilégio para `anon`/`authenticated` e as funções são só de `service_role`.

create table if not exists public.mcp_oauth_clientes (
  id uuid primary key default gen_random_uuid(),
  -- Público por natureza (vai na URL de autorização). 32 caracteres base64url.
  client_id text not null unique,
  -- SHA-256 do segredo, quando o cliente pediu autenticação por segredo.
  client_secret_hash bytea,
  nome text not null,
  redirect_uris text[] not null,
  metodo_de_autenticacao text not null default 'none',
  ultimo_uso_em timestamptz,
  created_at timestamptz not null default now(),
  constraint mcp_oauth_clientes_client_id_check check (client_id ~ '^dcc_[A-Za-z0-9_-]{32}$'),
  constraint mcp_oauth_clientes_nome_check check (char_length(nome) between 1 and 120),
  constraint mcp_oauth_clientes_redirects_check check (cardinality(redirect_uris) between 1 and 10),
  constraint mcp_oauth_clientes_metodo_check
    check (metodo_de_autenticacao in ('none', 'client_secret_post', 'client_secret_basic')),
  constraint mcp_oauth_clientes_segredo_check
    check ((metodo_de_autenticacao = 'none') = (client_secret_hash is null))
);

create table if not exists public.mcp_oauth_concessoes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  cliente_id uuid not null references public.mcp_oauth_clientes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- O access token vivo da conexão. Uma concessão = uma linha de api_tokens.
  api_token_id uuid not null unique references public.api_tokens(id) on delete cascade,
  refresh_hash bytea not null unique,
  -- Os refresh já rotacionados desta conexão, o mais novo primeiro (até 100).
  -- Cada refresh vale UMA vez: reapresentar qualquer um daqui desliga a
  -- conexão inteira (OAuth 2.1 §4.3.1). Duas partes com o mesmo refresh — o
  -- cliente e quem o copiou — não convivem: a segunda a usá-lo derruba as duas,
  -- e a pessoa reconecta. O custo assumido: resposta de renovação perdida na
  -- rede também desconecta.
  refresh_hashes_rotacionados bytea[] not null default '{}',
  refresh_expira_em timestamptz not null,
  escopos text[] not null,
  renovada_em timestamptz,
  revogada_em timestamptz,
  created_at timestamptz not null default now(),
  constraint mcp_oauth_concessoes_escopos_check
    check (cardinality(escopos) >= 1 and escopos <@ array['mcp:read', 'mcp:write']::text[])
);

create table if not exists public.mcp_oauth_codigos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  cliente_id uuid not null references public.mcp_oauth_clientes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  codigo_hash bytea not null unique,
  code_challenge text not null,
  redirect_uri text not null,
  escopos text[] not null,
  recurso text not null,
  expira_em timestamptz not null,
  usado_em timestamptz,
  -- Preenchido na troca: reuso do código revoga o que ele emitiu (OAuth 2.1 §4.1.3).
  concessao_id uuid references public.mcp_oauth_concessoes(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint mcp_oauth_codigos_challenge_check check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  constraint mcp_oauth_codigos_escopos_check
    check (cardinality(escopos) >= 1 and escopos <@ array['mcp:read', 'mcp:write']::text[])
);

create index if not exists mcp_oauth_codigos_expira_idx on public.mcp_oauth_codigos (expira_em);
-- Os nunca autorizados: o registro os conta e despeja, a poda diária os apaga.
create index if not exists mcp_oauth_clientes_pendentes_idx on public.mcp_oauth_clientes (created_at)
  where ultimo_uso_em is null;
create index if not exists mcp_oauth_concessoes_org_idx on public.mcp_oauth_concessoes (organization_id);
create index if not exists mcp_oauth_concessoes_cliente_idx on public.mcp_oauth_concessoes (cliente_id);

comment on table public.mcp_oauth_clientes is
  'Clientes OAuth do MCP do CRM (registro dinâmico, RFC 7591). Da INSTALAÇÃO, não de uma organização: não guarda dado de cliente nenhum. Segredo só como SHA-256. Server-side only.';
comment on table public.mcp_oauth_codigos is
  'Código de autorização de uso único (5 min) do OAuth do MCP. Só o hash; PKCE S256 obrigatório. Amarrado a organização, pessoa, cliente e redirect_uri. Server-side only.';
comment on table public.mcp_oauth_concessoes is
  'Uma conexão OAuth ao MCP (ex.: ChatGPT): o access token é a linha de api_tokens apontada, o refresh token só como hash, rotacionado a cada uso. Revogar o token na tela de Tokens de API desliga a conexão. Server-side only.';

alter table public.mcp_oauth_clientes enable row level security;
alter table public.mcp_oauth_codigos enable row level security;
alter table public.mcp_oauth_concessoes enable row level security;

revoke all on public.mcp_oauth_clientes from anon, authenticated;
revoke all on public.mcp_oauth_codigos from anon, authenticated;
revoke all on public.mcp_oauth_concessoes from anon, authenticated;
grant select, insert, update, delete on public.mcp_oauth_clientes to service_role;
grant select, insert, update, delete on public.mcp_oauth_codigos to service_role;
grant select, insert, update, delete on public.mcp_oauth_concessoes to service_role;

-- A pessoa ainda administra a organização? A mesma régua de quem emite token
-- na tela (`requireRole("admin")` em /api/v1/settings/api-tokens).
create or replace function public.fn_mcp_oauth_ainda_admin(p_user uuid, p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.user_organizations uo
     where uo.user_id = p_user and uo.organization_id = p_org
       and uo.role = 'admin' and uo.revoked_at is null
  );
$$;

revoke execute on function public.fn_mcp_oauth_ainda_admin(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_mcp_oauth_ainda_admin(uuid, uuid) to service_role;

-- Revoga uma concessão e o token dela. Interna: só as funções abaixo chamam.
create or replace function public.fn_mcp_oauth_desligar(p_concessao uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.mcp_oauth_concessoes set revogada_em = coalesce(revogada_em, now()) where id = p_concessao;
  update public.api_tokens t set revoked_at = coalesce(t.revoked_at, now())
   where t.id = (select c.api_token_id from public.mcp_oauth_concessoes c where c.id = p_concessao);
end;
$$;

revoke execute on function public.fn_mcp_oauth_desligar(uuid) from public, anon, authenticated;
grant execute on function public.fn_mcp_oauth_desligar(uuid) to service_role;

-- TROCA DO CÓDIGO (grant_type=authorization_code).
--
-- Não levanta exceção na recusa: devolve `motivo`. Levantar desfaria o
-- `usado_em` — e o código tem de ficar queimado mesmo quando a troca falha
-- (verifier errado, cliente errado), senão quem tem o código tenta de novo.
-- A única exceção que escapa é a do teto de tokens (PT409), que desfaz tudo e
-- deixa o código usável depois que alguém liberar espaço.
create or replace function public.fn_mcp_oauth_trocar_codigo(
  p_codigo_hash bytea,
  p_cliente uuid,
  p_redirect_uri text,
  p_code_verifier text,
  p_token_hash bytea,
  p_prefixo text,
  p_token_expira_em timestamptz,
  p_refresh_hash bytea,
  p_refresh_expira_em timestamptz,
  p_nome text
)
returns table (motivo text, organization_id uuid, api_token_id uuid, concessao_id uuid, escopos text[])
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_cod public.mcp_oauth_codigos%rowtype;
  v_desafio text;
  v_token uuid;
  v_concessao uuid;
  v_escopos jsonb;
begin
  select * into v_cod from public.mcp_oauth_codigos c where c.codigo_hash = p_codigo_hash for update;
  if not found then
    return query select 'invalid_grant'::text, null::uuid, null::uuid, null::uuid, null::text[];
    return;
  end if;

  if v_cod.usado_em is not null then
    -- Reuso: quem apresenta o código pela segunda vez pode ser quem o roubou.
    if v_cod.concessao_id is not null then
      perform public.fn_mcp_oauth_desligar(v_cod.concessao_id);
    end if;
    return query select 'invalid_grant'::text, null::uuid, null::uuid, null::uuid, null::text[];
    return;
  end if;

  update public.mcp_oauth_codigos set usado_em = now() where id = v_cod.id;

  if v_cod.cliente_id <> p_cliente
     or v_cod.redirect_uri <> p_redirect_uri
     or v_cod.expira_em <= now()
     or p_code_verifier is null
     or p_code_verifier !~ '^[A-Za-z0-9._~-]{43,128}$' then
    return query select 'invalid_grant'::text, null::uuid, null::uuid, null::uuid, null::text[];
    return;
  end if;

  -- PKCE S256: BASE64URL(SHA256(verifier)) sem padding.
  v_desafio := translate(rtrim(encode(sha256(convert_to(p_code_verifier, 'UTF8')), 'base64'), '='), '+/', '-_');
  if v_desafio <> v_cod.code_challenge then
    return query select 'invalid_grant'::text, null::uuid, null::uuid, null::uuid, null::text[];
    return;
  end if;

  if not public.fn_mcp_oauth_ainda_admin(v_cod.user_id, v_cod.organization_id) then
    return query select 'invalid_grant'::text, null::uuid, null::uuid, null::uuid, null::text[];
    return;
  end if;

  -- `aud:mcp` prende o token ao `/api/mcp`: `resolveApiToken` (lib/mcp/auth.ts)
  -- recusa token com essa marca em qualquer outra porta (o `/api/v1`).
  v_escopos := to_jsonb(v_cod.escopos) || '["role:admin", "aud:mcp"]'::jsonb;

  insert into public.api_tokens (organization_id, created_by, name, prefix, token_hash, scopes, expires_at)
  values (v_cod.organization_id, v_cod.user_id, left(p_nome, 120), p_prefixo, p_token_hash, v_escopos, p_token_expira_em)
  returning id into v_token;

  insert into public.mcp_oauth_concessoes
    (organization_id, cliente_id, user_id, api_token_id, refresh_hash, refresh_expira_em, escopos)
  values (v_cod.organization_id, v_cod.cliente_id, v_cod.user_id, v_token, p_refresh_hash, p_refresh_expira_em, v_cod.escopos)
  returning id into v_concessao;

  update public.mcp_oauth_codigos set concessao_id = v_concessao where id = v_cod.id;
  update public.mcp_oauth_clientes set ultimo_uso_em = now() where id = v_cod.cliente_id;

  return query select null::text, v_cod.organization_id, v_token, v_concessao, v_cod.escopos;
end;
$$;

revoke execute on function public.fn_mcp_oauth_trocar_codigo(bytea, uuid, text, text, bytea, text, timestamptz, bytea, timestamptz, text) from public, anon, authenticated;
grant execute on function public.fn_mcp_oauth_trocar_codigo(bytea, uuid, text, text, bytea, text, timestamptz, bytea, timestamptz, text) to service_role;

-- RENOVAÇÃO (grant_type=refresh_token), com rotação.
--
-- O hash do access token é trocado NA MESMA linha de api_tokens: o token
-- anterior deixa de valer na hora. O refresh usado vai para
-- `refresh_hashes_rotacionados` e nunca mais vale: reapresentá-lo desliga a
-- conexão (detecção de reuso, OAuth 2.1 §4.3.1). Antes de emitir, re-confere o que pode ter
-- mudado desde o consentimento: a concessão revogada, o token revogado na tela,
-- e a pessoa que autorizou ainda administrando a organização. Sem isso, um
-- admin removido da empresa seguiria lendo o CRM pelo ChatGPT para sempre.
create or replace function public.fn_mcp_oauth_renovar(
  p_refresh_hash bytea,
  p_cliente uuid,
  p_novo_refresh_hash bytea,
  p_token_hash bytea,
  p_prefixo text,
  p_token_expira_em timestamptz,
  p_refresh_expira_em timestamptz,
  p_escopos text[]
)
returns table (motivo text, organization_id uuid, api_token_id uuid, concessao_id uuid, escopos text[])
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_con public.mcp_oauth_concessoes%rowtype;
  v_revogado timestamptz;
  v_escopos text[];
begin
  select * into v_con from public.mcp_oauth_concessoes c
   where c.cliente_id = p_cliente
     and (c.refresh_hash = p_refresh_hash or p_refresh_hash = any (c.refresh_hashes_rotacionados))
   for update;
  if not found then
    return query select 'invalid_grant'::text, null::uuid, null::uuid, null::uuid, null::text[];
    return;
  end if;

  -- Refresh já rotacionado reapresentado: alguém além do cliente tem a
  -- conexão. Desliga e recusa — sem exceção, para o desligamento ficar.
  if v_con.refresh_hash <> p_refresh_hash then
    perform public.fn_mcp_oauth_desligar(v_con.id);
    return query select 'invalid_grant'::text, null::uuid, null::uuid, null::uuid, null::text[];
    return;
  end if;

  if v_con.revogada_em is not null or v_con.refresh_expira_em <= now() then
    return query select 'invalid_grant'::text, null::uuid, null::uuid, null::uuid, null::text[];
    return;
  end if;

  select t.revoked_at into v_revogado from public.api_tokens t where t.id = v_con.api_token_id;
  if v_revogado is not null or not public.fn_mcp_oauth_ainda_admin(v_con.user_id, v_con.organization_id) then
    perform public.fn_mcp_oauth_desligar(v_con.id);
    return query select 'invalid_grant'::text, null::uuid, null::uuid, null::uuid, null::text[];
    return;
  end if;

  -- Pedir MENOS escopo na renovação vale (RFC 6749 §6); pedir mais, não.
  v_escopos := coalesce(p_escopos, v_con.escopos);
  if cardinality(v_escopos) = 0 or not (v_escopos <@ v_con.escopos) then
    return query select 'invalid_scope'::text, null::uuid, null::uuid, null::uuid, null::text[];
    return;
  end if;

  update public.api_tokens
     set token_hash = p_token_hash,
         prefix = p_prefixo,
         expires_at = p_token_expira_em,
         scopes = to_jsonb(v_escopos) || '["role:admin", "aud:mcp"]'::jsonb
   where id = v_con.api_token_id;

  update public.mcp_oauth_concessoes
     set refresh_hash = p_novo_refresh_hash,
         -- ponytail: guarda os 100 últimos (~4 dias de renovação por hora). Um
         -- refresh mais velho que isso reapresentado só é recusado, sem desligar.
         refresh_hashes_rotacionados = (array[refresh_hash] || refresh_hashes_rotacionados)[1:100],
         renovada_em = now(),
         refresh_expira_em = p_refresh_expira_em
   where id = v_con.id;

  update public.mcp_oauth_clientes set ultimo_uso_em = now() where id = v_con.cliente_id;

  return query select null::text, v_con.organization_id, v_con.api_token_id, v_con.id, v_escopos;
end;
$$;

revoke execute on function public.fn_mcp_oauth_renovar(bytea, uuid, bytea, bytea, text, timestamptz, timestamptz, text[]) from public, anon, authenticated;
grant execute on function public.fn_mcp_oauth_renovar(bytea, uuid, bytea, bytea, text, timestamptz, timestamptz, text[]) to service_role;

-- REVOGAÇÃO (RFC 7009). Aceita o refresh token OU o access token (`dsk_`) e
-- desliga a concessão inteira — mas só a do PRÓPRIO cliente: um cliente não
-- revoga a conexão de outro. Token desconhecido não é erro (RFC 7009 §2.2).
create or replace function public.fn_mcp_oauth_revogar(p_hash bytea, p_cliente uuid)
returns table (organization_id uuid, api_token_id uuid, concessao_id uuid)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_con public.mcp_oauth_concessoes%rowtype;
begin
  select c.* into v_con from public.mcp_oauth_concessoes c
   where c.cliente_id = p_cliente
     and (c.refresh_hash = p_hash
          or c.api_token_id = (select t.id from public.api_tokens t where t.token_hash = p_hash limit 1))
   limit 1;
  if not found or v_con.revogada_em is not null then
    return;
  end if;
  perform public.fn_mcp_oauth_desligar(v_con.id);
  return query select v_con.organization_id, v_con.api_token_id, v_con.id;
end;
$$;

revoke execute on function public.fn_mcp_oauth_revogar(bytea, uuid) from public, anon, authenticated;
grant execute on function public.fn_mcp_oauth_revogar(bytea, uuid) to service_role;

-- PODA. O registro dinâmico é aberto por definição (RFC 7591): sem poda, a
-- tabela de clientes só cresce. Chamada uma vez por dia pelo cron
-- `data-retention`, fora de qualquer requisição. Cliente registrado que nenhum
-- admin autorizou em 24 h sai — é o que libera o teto de pendentes do
-- registro. Não toca em api_tokens: a linha do token fica como histórico,
-- revogada ou vencida, na tela de Tokens de API.
--
-- ponytail: sem lote. O que ela apaga é limitado pelo teto de pendentes e pelo
-- limite do consentimento; lote entra se a contagem diária passar de milhares.
create or replace function public.fn_mcp_oauth_podar()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_total integer := 0;
  v_n integer;
begin
  delete from public.mcp_oauth_codigos where expira_em < now() - interval '1 day';
  get diagnostics v_n = row_count; v_total := v_total + v_n;

  delete from public.mcp_oauth_concessoes
   where (revogada_em is not null and revogada_em < now() - interval '30 days')
      or refresh_expira_em < now() - interval '30 days';
  get diagnostics v_n = row_count; v_total := v_total + v_n;

  delete from public.mcp_oauth_clientes cl
   where ((cl.ultimo_uso_em is null and cl.created_at < now() - interval '24 hours')
          or cl.ultimo_uso_em < now() - interval '180 days')
     and not exists (select 1 from public.mcp_oauth_concessoes c where c.cliente_id = cl.id);
  get diagnostics v_n = row_count; v_total := v_total + v_n;

  return v_total;
end;
$$;

revoke execute on function public.fn_mcp_oauth_podar() from public, anon, authenticated;
grant execute on function public.fn_mcp_oauth_podar() to service_role;

-- REGISTRO DE CLIENTE, com teto de pendentes. O registro é aberto, e cada
-- cliente é uma linha. O teto NUNCA recusa: recusar entregaria a quem registra
-- sem login o poder de trancar a conexão de todo mundo. Com `p_teto` clientes
-- nunca autorizados, o registro novo despeja o pendente mais ANTIGO — menos o
-- que tem código de autorização vivo, que só nasce do POST de consentimento de
-- um admin e que quem registra sem login não consegue produzir. O custo
-- assumido: sob inundação contínua, quem está na tela de consentimento pode
-- perder o cliente antes de clicar, e o aplicativo registra de novo. O freio
-- de taxa é o limite por IP do `/register`. Contagem, despejo e insert correm
-- sob um advisory lock de chave fixa, na transação da chamada. `motivo` fica
-- sempre nulo (forma comum das funções de emissão).
--
-- ponytail: com todos os pendentes protegidos, o teto cede e o registro entra
-- assim mesmo; o código vive 5 min, então o excesso se desfaz.
create or replace function public.fn_mcp_oauth_registrar_cliente(
  p_client_id text,
  p_client_secret_hash bytea,
  p_nome text,
  p_redirect_uris text[],
  p_metodo text,
  p_teto integer
)
returns table (motivo text, id uuid, created_at timestamptz, despejados integer)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_pendentes integer;
  v_despejados integer := 0;
  v_id uuid;
  v_criado timestamptz;
begin
  perform pg_advisory_xact_lock(93900001);

  select count(*) into v_pendentes from public.mcp_oauth_clientes cl where cl.ultimo_uso_em is null;

  if v_pendentes >= p_teto then
    delete from public.mcp_oauth_clientes cl
     where cl.id in (
       select p.id from public.mcp_oauth_clientes p
        where p.ultimo_uso_em is null
          and not exists (select 1 from public.mcp_oauth_concessoes c where c.cliente_id = p.id)
          and not exists (select 1 from public.mcp_oauth_codigos k
                           where k.cliente_id = p.id and k.usado_em is null and k.expira_em > now())
        order by p.created_at, p.id
        limit v_pendentes - p_teto + 1
     );
    get diagnostics v_despejados = row_count;
  end if;

  insert into public.mcp_oauth_clientes (client_id, client_secret_hash, nome, redirect_uris, metodo_de_autenticacao)
  values (p_client_id, p_client_secret_hash, p_nome, p_redirect_uris, p_metodo)
  returning mcp_oauth_clientes.id, mcp_oauth_clientes.created_at into v_id, v_criado;

  return query select null::text, v_id, v_criado, v_despejados;
end;
$$;

revoke execute on function public.fn_mcp_oauth_registrar_cliente(text, bytea, text, text[], text, integer) from public, anon, authenticated;
grant execute on function public.fn_mcp_oauth_registrar_cliente(text, bytea, text, text[], text, integer) to service_role;
