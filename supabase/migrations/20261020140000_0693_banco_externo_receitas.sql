-- manifest: Banco externo — coluna `receitas` (jsonb) em `external_db_connections`: as instâncias das receitas prontas (Spec 25, R1: receita woocommerce + instância + tool). Cada organização guarda suas instâncias (RLS herda da tabela), default '[]', só-array, teto de 256 KiB. A coluna fica FORA da view `_safe` (precedente das `sources`); só a contagem `receitas_count` é exposta, como última coluna da view, com `revoke`/`grant` reemitidos.
--
-- ─── O que isto resolve ─────────────────────────────────────────────────────
-- A Spec 23 pôs "consulta salva por fonte" em fora de escopo; a instância gravada
-- (D3 da Spec 25) é esse item chegando, restrito a templates revisados (sem SQL
-- livre). A coluna `receitas` guarda o array de instâncias da conexão (receita
-- escolhida + parâmetros preenchidos na tela), lido pelo servidor com
-- `organization_id` no filtro — nunca pelo cliente.
--
-- ─── Compatibilidade ────────────────────────────────────────────────────────
-- `add column if not exists` + default '[]': conexões que já existem ficam com
-- o array vazio, nada muda para quem já usa. A view `_safe` é recriada com
-- `receitas_count` (`jsonb_array_length(receitas)`) como ÚLTIMA coluna e o
-- `revoke`/`grant` reemitidos. `receitas` NÃO entra na view (D3).

alter table public.external_db_connections
  add column if not exists receitas jsonb not null default '[]'::jsonb;

alter table public.external_db_connections
  drop constraint if exists external_db_connections_receitas_valido;

alter table public.external_db_connections
  add constraint external_db_connections_receitas_valido
    check (
      jsonb_typeof(receitas) = 'array'
      and octet_length(receitas::text) <= 262144
    );

comment on column public.external_db_connections.receitas is
  'Instâncias de receitas prontas desta conexão (Spec 25 R1): receita escolhida + parâmetros preenchidos na tela. JSON array; válido para mysql nesta fatia. RLS herda da tabela; lido pelo servidor com organization_id no filtro. Fora da view _safe (só receitas_count é exposta).';

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
         db_type, last_test_aviso,
         jsonb_array_length(receitas) as receitas_count
  from public.external_db_connections;

revoke all on public.external_db_connections_safe from anon;
grant select on public.external_db_connections_safe to authenticated;
