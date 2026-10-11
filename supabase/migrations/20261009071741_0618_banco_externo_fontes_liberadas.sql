-- manifest: Fontes liberadas do banco externo — o administrador marca quais tabelas/views (e colunas) o assistente e a grade podem ler (source_mode + sources); conexões que já existem ficam em 'all' (nada muda) e as novas nascem em 'list'.
--
-- ─── O que isto resolve ─────────────────────────────────────────────────────
-- O conector deixava o assistente ler QUALQUER tabela que o usuário do banco
-- externo enxerga (Spec 20, D6). Isso custa token (a lista inteira volta ao
-- modelo) e expõe o que não devia estar à vista (num WordPress, `wp_users` e
-- `wp_options`). Esta migration guarda, por conexão, a lista do que PODE ser
-- lido. O resto desaparece para o assistente, para o MCP externo e para a grade.
--
-- ─── Por que COLUNAS e não tabela nova ──────────────────────────────────────
-- Tabela nova entraria no baseline de TODA instalação (ADR-0002, D9) e pediria
-- RLS, FK e entrada no teste de isolamento. As colunas herdam a RLS da tabela
-- (select = membro, escrita = admin), somem junto com a conexão e são trocadas
-- de uma vez só por um UPDATE atômico. O risco do jsonb (anti-padrão 6 do
-- CLAUDE.md) é contido por UM esquema central em lib/external-db/fontes.ts.
--
-- ─── Compatibilidade ────────────────────────────────────────────────────────
-- Linhas existentes ficam 'all' (comportamento de hoje). Quem cria conexão
-- DEPOIS desta migration recebe 'list' pela API (POST grava source_mode='list').

alter table public.external_db_connections
  add column if not exists source_mode text not null default 'all',
  add column if not exists sources jsonb not null default '[]'::jsonb;

alter table public.external_db_connections
  drop constraint if exists external_db_connections_source_mode_valido,
  drop constraint if exists external_db_connections_sources_valido;

alter table public.external_db_connections
  add constraint external_db_connections_source_mode_valido
    check (source_mode in ('all', 'list')),
  -- Medida DETERMINÍSTICA do conteúdo: `pg_column_size` mediria o valor como
  -- está armazenado (com ou sem compressão), e o mesmo dado poderia passar na
  -- gravação e falhar depois num restore ou no update.sh.
  add constraint external_db_connections_sources_valido
    check (jsonb_typeof(sources) = 'array' and octet_length(sources::text) <= 262144);

comment on column public.external_db_connections.source_mode is
  'all = o assistente lê tudo que o usuário do banco externo enxerga (comportamento anterior); list = só o que está em sources.';
comment on column public.external_db_connections.sources is
  'Fontes liberadas: [{schema, tabela, colunas: string[]|null, descricao}]. Formato validado em lib/external-db/fontes.ts. Só vale com source_mode = list.';

-- A view ganha as duas colunas no FIM da lista. O array NÃO é exposto (a lista e
-- a tela não carregam o conteúdo inteiro): só o modo e a contagem.
drop view if exists public.external_db_connections_safe;
create view public.external_db_connections_safe
  with (security_invoker = true)
  as
  select id, organization_id, label, host, port, database_name, username,
         ssl_mode, enabled, max_rows, max_filters, max_response_bytes,
         customer_key_column, customer_key_kind,
         last_tested_at, last_test_ok, last_test_error,
         created_by, created_at, updated_at,
         source_mode, jsonb_array_length(sources) as sources_count
  from public.external_db_connections;

revoke all on public.external_db_connections_safe from anon;
grant select on public.external_db_connections_safe to authenticated;
