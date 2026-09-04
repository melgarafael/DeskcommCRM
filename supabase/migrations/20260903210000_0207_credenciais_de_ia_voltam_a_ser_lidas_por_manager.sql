-- 0207 — as credenciais de IA voltam a ser LIDAS por quem não é admin
--
-- A migration 0150 removeu a policy de SELECT por tenancy e criou só
-- `tenant_isolation_ai_provider_credentials_write` como `FOR ALL`. Em Postgres,
-- `FOR ALL` cobre também a leitura — então a ÚNICA policy aplicável ao SELECT
-- passou a exigir `fn_role_at_least(organization_id, 'admin')`.
--
-- A view `ai_provider_credentials_safe` é `security_invoker = true` de propósito
-- (para que a RLS da base valha para quem consulta). Consequência: um `manager`
-- ou `viewer` passa na autorização da aplicação e é filtrado para ZERO LINHAS na
-- tabela base. A tela `/app/ai/credentials`, que não é admin-gated e só calcula
-- `canWrite` para admin, responde 200 com `[]` — e a pessoa conclui que não há
-- credencial cadastrada, quando há.
--
-- Isto restaura o PAR que o cabeçalho da própria 0150 promete: escrita de admin,
-- leitura por tenancy. O segredo continua protegido pelo GRANT POR COLUNA, que é
-- quem realmente esconde `api_key_encrypted/iv/tag` — não a RLS. Reabrir o
-- SELECT da tabela não reabre o segredo; o controle positivo em
-- `tests/invariants/` mede exatamente isso.
--
-- issue #292

-- `drop` antes do `create` porque o dump da baseline cria uma policy de MESMO
-- NOME sob guarda de existência, e o apêndice é re-aplicado pelo `update.sh` sem
-- `ON_ERROR_STOP`: sem o drop, o create falharia em silêncio num clone.
drop policy if exists tenant_isolation_ai_provider_credentials_select on public.ai_provider_credentials;
create policy tenant_isolation_ai_provider_credentials_select on public.ai_provider_credentials
  for select using (organization_id in (select public.fn_user_org_ids()));

-- O PostgREST guarda o schema em cache; sem isto a policy nova só vale no
-- próximo reload dele.
notify pgrst, 'reload schema';
