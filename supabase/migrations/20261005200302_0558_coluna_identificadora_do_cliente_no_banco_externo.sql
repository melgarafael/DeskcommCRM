-- manifest: **A conexão de banco externo diz qual coluna identifica o cliente (PR #2280).** Colunas `external_db_connections.customer_key_column` e `customer_key_kind` (`phone`|`email`), nulas por padrão e sempre juntas (CHECK). Durante a conversa, `crm_query_external_data` filtra a consulta por essa coluna com o telefone/e-mail do contato do turno, lido do CRM pelo servidor; sem a coluna configurada, a consulta segue como antes e a tela avisa. Fora da conversa nada muda. A view `external_db_connections_safe` passa a expor as duas colunas (configuração, não segredo).
--
-- 0558 · a conexão de banco externo diz qual coluna identifica o cliente.
--
-- Por que colunas tipadas, e não jsonb: a conexão não tem jsonb de
-- configuração, e a 0373 já escolheu colunas com CHECK para o que é
-- propriedade da conexão. Nulas por padrão e sem backfill: nenhuma conexão
-- existente ganha um filtro que ninguém escolheu.
--
-- Idempotente: `add column if not exists`, constraints com drop+add (nenhuma
-- linha existente as viola: as colunas nascem nulas), view com drop+create e
-- grants refeitos. Nenhuma função nova.

alter table public.external_db_connections
  add column if not exists customer_key_column text,
  add column if not exists customer_key_kind text;

alter table public.external_db_connections
  drop constraint if exists external_db_connections_customer_key_kind_conhecido,
  drop constraint if exists external_db_connections_customer_key_par;

alter table public.external_db_connections
  add constraint external_db_connections_customer_key_kind_conhecido
    check (customer_key_kind is null or customer_key_kind in ('phone', 'email')),
  add constraint external_db_connections_customer_key_par
    check (
      (customer_key_column is null and customer_key_kind is null)
      or (customer_key_column is not null and customer_key_kind is not null
          and length(btrim(customer_key_column)) between 1 and 128)
    );

comment on column public.external_db_connections.customer_key_column is
  'Coluna das tabelas externas que guarda o telefone ou o e-mail do cliente. Na conversa, a consulta do agente é filtrada por ela com o dado do contato do turno. NULL = não configurada: a consulta segue sem esse filtro, e a tela avisa.';
comment on column public.external_db_connections.customer_key_kind is
  'O que customer_key_column guarda: phone (contacts.phone_number) ou email (contacts.email). Anda junto com customer_key_column.';

drop view if exists public.external_db_connections_safe;
create view public.external_db_connections_safe
  with (security_invoker = true)
  as
  select id, organization_id, label, host, port, database_name, username,
         ssl_mode, enabled, max_rows, max_filters, max_response_bytes,
         customer_key_column, customer_key_kind,
         last_tested_at, last_test_ok, last_test_error,
         created_by, created_at, updated_at
  from public.external_db_connections;

revoke all on public.external_db_connections_safe from anon;
grant select on public.external_db_connections_safe to authenticated;
