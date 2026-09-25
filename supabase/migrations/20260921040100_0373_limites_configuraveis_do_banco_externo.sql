-- 0373 · Os limites de leitura do banco externo eram um teto único para todo mundo.
--
-- Recorte do PR #1130, de @vgamkt (0234 na branch dele; renumerada aqui).
--
-- ─── O atrito que isto resolve ──────────────────────────────────────────────
-- `LIMITE_MAX` (=200 linhas) e os tetos de filtro/bytes viviam cravados no código.
-- Um processo que precisa varrer centenas de linhas ou combinar muitos filtros
-- batia no mesmo teto de quem lê vinte e nada. Agora quem administra a conexão
-- escolhe o teto DENTRO de uma faixa (as mesmas do CHECK abaixo), com defaults
-- iguais aos valores antigos — ninguém muda de comportamento sem pedir.
--
-- ─── Por que colunas, e não uma tabela de configuração ──────────────────────
-- O limite é propriedade da CONEXÃO (cada fonte tem um processo), não da
-- organização nem da instalação. Três colunas tipadas com CHECK dizem a mesma
-- coisa que um JSON sem validar nada, e o PostgREST/RLS já herdam a proteção.
--
-- `max_rows` governa a grade da tela E as tools do agente; `max_filters` e
-- `max_response_bytes` governam as tools (o teto de filtros e o tamanho da
-- resposta que entra no contexto do modelo).

alter table public.external_db_connections
  add column if not exists max_rows integer not null default 200,
  add column if not exists max_filters integer not null default 20,
  add column if not exists max_response_bytes integer not null default 30000;

alter table public.external_db_connections
  drop constraint if exists external_db_connections_max_rows_valido,
  drop constraint if exists external_db_connections_max_filters_valido,
  drop constraint if exists external_db_connections_max_response_bytes_valido;

alter table public.external_db_connections
  add constraint external_db_connections_max_rows_valido
    check (max_rows between 1 and 5000),
  add constraint external_db_connections_max_filters_valido
    check (max_filters between 0 and 100),
  add constraint external_db_connections_max_response_bytes_valido
    check (max_response_bytes between 4096 and 1048576);

comment on column public.external_db_connections.max_rows is
  'Teto de linhas por consulta (grade e agente). Faixa 1..5000; default 200 = o antigo LIMITE_MAX.';
comment on column public.external_db_connections.max_filters is
  'Teto de filtros por consulta do agente. Faixa 0..100; default 20.';
comment on column public.external_db_connections.max_response_bytes is
  'Teto de bytes da resposta devolvida ao modelo. Faixa 4096..1048576; default 30000.';

-- A view segura passa a expor os limites (são configuração, não segredo). O
-- drop/create é idempotente; os grants são refeitos logo abaixo.
drop view if exists public.external_db_connections_safe;
create view public.external_db_connections_safe
  with (security_invoker = true)
  as
  select id, organization_id, label, host, port, database_name, username,
         ssl_mode, enabled, max_rows, max_filters, max_response_bytes,
         last_tested_at, last_test_ok, last_test_error,
         created_by, created_at, updated_at
  from public.external_db_connections;

revoke all on public.external_db_connections_safe from anon;
grant select on public.external_db_connections_safe to authenticated;
