-- 0150: a RLS isolava a organização, mas não aplicava o PAPEL
--
-- Segundo achado do relatório de segurança da comunidade, e o mais consistente
-- dele. Medido no baseline da main: das 82 policies `ALL` de `public`, **71**
-- não citam `fn_role_at_least` — só tenancy, via `fn_user_org_ids()`, que
-- devolve organizações e nada mais. `authenticated` tem
-- SELECT/INSERT/UPDATE/DELETE nessas tabelas.
--
-- Isso importa porque o `requireRole()` das rotas Next NÃO é a única porta: o
-- PostgREST do Supabase é exposto ao browser por construção (a `anon key` e a
-- URL vão no bundle), e um usuário logado fala com ele DIRETO, com o próprio
-- JWT. Provado num pg17 com este baseline, membro papel `viewer`, rodando como
-- role `authenticated` com o `sub` dele: derrubou `channel_sessions` (o canal de
-- WhatsApp), reescreveu `ai_agents.system_prompt` (o texto que o bot fala com
-- cliente real), subiu `ai_budgets.monthly_limit_cents` de 5.000 para
-- 99.999.999 e DELETOU a linha de `ai_provider_credentials` (mata a IA da org).
-- Controle no mesmo probe: o viewer NÃO alcança a organização vizinha — a
-- tenancy vale, o que falta é o papel.
--
-- ESCOPO DELIBERADO: só as tabelas de CONFIGURAÇÃO de IA e canais, onde o dano
-- é inequívoco e onde a rota Next já exige `admin` hoje (channel-sessions
-- route.ts:61, ai/agents route.ts:67, ai/budget route.ts:46) — a policy passa a
-- espelhar a API, em vez de ficar três níveis mais frouxa que ela. As outras ~63
-- ficam para depois, de propósito: `job_queue`, `llm_calls`, `send_ledger`,
-- `metrics` e afins são escritas pelo motor, e apertá-las no mesmo fôlego
-- trocaria um furo de segurança por uma parada de produção. O gate que impede a
-- lista de crescer vem em `tests/invariants/rbac-config-ia-canais.test.ts`.
--
-- FORMA: cada tabela vira PAR — SELECT só-tenancy (todo membro continua LENDO,
-- inclusive o viewer, senão a tela quebra) + escrita com `fn_role_at_least`.
-- Onde a policy atual tem `or fn_is_platform_admin()`, o par PRESERVA os dois
-- lados: sem isso o super-admin de plataforma perde acesso e o suporte cega.
--
-- O worker não entra nesta conta: usa `service_role`, que é `bypassrls`.

-- ---- canais ----
drop policy if exists channel_sessions_tenant_isolation_all on public.channel_sessions;

drop policy if exists channel_sessions_tenant_select on public.channel_sessions;
create policy channel_sessions_tenant_select on public.channel_sessions
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );

drop policy if exists channel_sessions_tenant_write on public.channel_sessions;
create policy channel_sessions_tenant_write on public.channel_sessions
  for all using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin()
  );

-- ---- agentes de IA ----
drop policy if exists tenant_isolation_ai_agents_all on public.ai_agents;

drop policy if exists tenant_isolation_ai_agents_select on public.ai_agents;
create policy tenant_isolation_ai_agents_select on public.ai_agents
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );

drop policy if exists tenant_isolation_ai_agents_write on public.ai_agents;
create policy tenant_isolation_ai_agents_write on public.ai_agents
  for all using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin()
  );

-- ---- versões de agente ----
drop policy if exists tenant_isolation_ai_agent_versions_all on public.ai_agent_versions;

drop policy if exists tenant_isolation_ai_agent_versions_select on public.ai_agent_versions;
create policy tenant_isolation_ai_agent_versions_select on public.ai_agent_versions
  for select using (organization_id in (select public.fn_user_org_ids()));

drop policy if exists tenant_isolation_ai_agent_versions_write on public.ai_agent_versions;
create policy tenant_isolation_ai_agent_versions_write on public.ai_agent_versions
  for all using (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  ) with check (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  );

-- ---- orçamento de IA ----
drop policy if exists tenant_isolation_ai_budgets_all on public.ai_budgets;

drop policy if exists tenant_isolation_ai_budgets_select on public.ai_budgets;
create policy tenant_isolation_ai_budgets_select on public.ai_budgets
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );

drop policy if exists tenant_isolation_ai_budgets_write on public.ai_budgets;
create policy tenant_isolation_ai_budgets_write on public.ai_budgets
  for all using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin()
  );

-- ---- roteadores de IA ----
drop policy if exists tenant_isolation_ai_routers_all on public.ai_routers;

drop policy if exists tenant_isolation_ai_routers_select on public.ai_routers;
create policy tenant_isolation_ai_routers_select on public.ai_routers
  for select using (organization_id in (select public.fn_user_org_ids()));

drop policy if exists tenant_isolation_ai_routers_write on public.ai_routers;
create policy tenant_isolation_ai_routers_write on public.ai_routers
  for all using (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  ) with check (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  );

drop policy if exists tenant_isolation_ai_router_members_all on public.ai_router_members;

drop policy if exists tenant_isolation_ai_router_members_select on public.ai_router_members;
create policy tenant_isolation_ai_router_members_select on public.ai_router_members
  for select using (organization_id in (select public.fn_user_org_ids()));

drop policy if exists tenant_isolation_ai_router_members_write on public.ai_router_members;
create policy tenant_isolation_ai_router_members_write on public.ai_router_members
  for all using (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  ) with check (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  );

drop policy if exists tenant_isolation_ai_purpose_bindings_all on public.ai_purpose_bindings;

drop policy if exists tenant_isolation_ai_purpose_bindings_select on public.ai_purpose_bindings;
create policy tenant_isolation_ai_purpose_bindings_select on public.ai_purpose_bindings
  for select using (organization_id in (select public.fn_user_org_ids()));

drop policy if exists tenant_isolation_ai_purpose_bindings_write on public.ai_purpose_bindings;
create policy tenant_isolation_ai_purpose_bindings_write on public.ai_purpose_bindings
  for all using (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  ) with check (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  );

-- ---- credenciais de provedor de IA: remover a superfície, não negociá-la ----
--
-- Aqui a policy não é o remédio suficiente. NENHUM caminho de browser precisa
-- desta tabela: o servidor lê as colunas cifradas com `service_role`
-- (lib/ai/credentials.ts, lib/ai/gateway-binding.ts) e a TELA já consome a view
-- `ai_provider_credentials_safe`, que existe justamente para não expor
-- `api_key_encrypted`/`iv`/`tag`. Então o SELECT de `authenticated` sai inteiro
-- em vez de continuar ali sob a promessa de que o ciphertext basta.
--
-- (O ciphertext DE FATO protege a chave — é AES com iv+tag, e um viewer leria
-- bytes inúteis. O que ele não protege é o resto: `provider`, `label`,
-- `api_key_last4`, `validation_error`. E, sobretudo, a linha continuava
-- DELETÁVEL, que é o dano real.)
drop policy if exists tenant_isolation_ai_provider_credentials_select on public.ai_provider_credentials;
drop policy if exists tenant_isolation_ai_provider_credentials_modify on public.ai_provider_credentials;

drop policy if exists tenant_isolation_ai_provider_credentials_write on public.ai_provider_credentials;
create policy tenant_isolation_ai_provider_credentials_write on public.ai_provider_credentials
  for all using (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  ) with check (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  );

-- O SELECT sai por COLUNA, não pela tabela inteira, e a razão é a view:
-- `ai_provider_credentials_safe` é `security_invoker=true` — de propósito, para
-- que a RLS da tabela base valha para o usuário que a consulta. Revogar o SELECT
-- da tabela inteira quebraria a view (o invoker não tem privilégio para ler a
-- base) e, com ela, a tela de provedores. Torná-la `security_invoker=false` para
-- contornar isso seria trocar um furo pequeno por um grande: a RLS pararia de se
-- aplicar e a view passaria a devolver linha de qualquer organização.
--
-- Com grant por coluna, as três colunas do segredo ficam inalcançáveis pelo
-- PostgREST e a view — que só lê as outras doze — continua funcionando. Medido
-- por controle positivo em tests/invariants/rbac-config-ia-canais.test.ts: a
-- primeira versão desta migration revogava a tabela toda, e foi esse controle
-- que reprovou.
revoke select on public.ai_provider_credentials from authenticated, anon;
grant select (
  id, organization_id, provider, label, api_key_last4, validated_at,
  validation_error, models_available, is_active, created_by, created_at, updated_at
) on public.ai_provider_credentials to authenticated;
grant select on public.ai_provider_credentials_safe to authenticated;

-- O PostgREST guarda o schema em cache; sem isto as policies novas só valem no
-- próximo reload dele.
notify pgrst, 'reload schema';
