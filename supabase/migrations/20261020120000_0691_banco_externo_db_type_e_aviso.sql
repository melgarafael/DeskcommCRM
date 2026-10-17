-- manifest: Banco externo — o motor da conexão (db_type: postgres | mysql) e o aviso de privilégio do último teste (last_test_aviso); conexões que já existem ficam 'postgres' e sem aviso, nada muda para quem já usa.
--
-- ─── O que isto resolve ─────────────────────────────────────────────────────
-- O conector só falava PostgreSQL. Para o MySQL (Spec 23, D3) a conexão precisa
-- dizer qual motor a lê (`db_type`) e o teste precisa poder dizer algo que não é
-- erro (`last_test_aviso`: "este usuário pode escrever; crie um usuário só de
-- leitura"). Aviso não é erro: o teste passou, e a tela o mostra em amarelo.
--
-- ─── Compatibilidade ────────────────────────────────────────────────────────
-- `add column if not exists` + defaults: toda conexão existente vira 'postgres'
-- e fica sem aviso. A view `_safe` é recriada com as duas colunas NOVAS no FIM da
-- lista (as anteriores ficam onde estão) e `revoke`/`grant` reemitidos.

alter table public.external_db_connections
  add column if not exists db_type text not null default 'postgres',
  add column if not exists last_test_aviso text;

alter table public.external_db_connections
  drop constraint if exists external_db_connections_db_type_valido,
  drop constraint if exists external_db_connections_last_test_aviso_valido;

alter table public.external_db_connections
  add constraint external_db_connections_db_type_valido
    check (db_type in ('postgres', 'mysql')),
  add constraint external_db_connections_last_test_aviso_valido
    check (last_test_aviso is null or char_length(last_test_aviso) <= 500);

comment on column public.external_db_connections.db_type is
  'Motor do banco externo: postgres | mysql. Imutável depois de criada (trocar de motor = apagar e criar). Vocabulário espelhado em TipoBanco (lib/external-db/types.ts).';
comment on column public.external_db_connections.last_test_aviso is
  'Aviso (não erro) do último teste bem-sucedido, por exemplo privilégio de escrita no usuário do MySQL. Nulo = nada a avisar.';

drop view if exists public.external_db_connections_safe;
create view public.external_db_connections_safe
  with (security_invoker = true)
  as
  select id, organization_id, label, host, port, database_name, username,
         ssl_mode, enabled, max_rows, max_filters, max_response_bytes,
         customer_key_column, customer_key_kind,
         last_tested_at, last_test_ok, last_test_error,
         created_by, created_at, updated_at,
         source_mode, jsonb_array_length(sources) as sources_count,
         db_type, last_test_aviso
  from public.external_db_connections;

revoke all on public.external_db_connections_safe from anon;
grant select on public.external_db_connections_safe to authenticated;
