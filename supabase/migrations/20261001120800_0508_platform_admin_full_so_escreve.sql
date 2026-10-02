-- Migration 0508 — fix(rls): platform admin `support_readonly` não escreve (#2000)
--
-- Contexto: `orgs_write_platform_admin` (baseline, dump) usava `fn_is_platform_admin()`,
-- que ignora o scope do JWT. Um platform admin com `scope = 'support_readonly'`
-- alterava colunas de exibição e `settings` de organizations pelo PostgREST.
--
-- Conserto: `fn_is_platform_admin_full()` exige `scope = 'full'`. As policies de
-- ESCRITA que usavam `fn_is_platform_admin()` passam a usar a versão `_full`; a
-- leitura (FOR SELECT) CONTINUA com `fn_is_platform_admin()`, então `support_readonly`
-- segue lendo — só não escreve. Para as tabelas cuja única policy era `FOR ALL`,
-- o par é subdividido em `_read` (FOR SELECT, sem `_full`) + `_write` (`_full`).
--
-- Idempotente; este arquivo é o mesmo corpo que o apêndice do baseline.sql (0508).

create or replace function public.fn_is_platform_admin_full()
returns boolean
language sql stable security definer
set search_path = public
as $f$
  select exists (
    select 1 from public.platform_admins
    where user_id = auth.uid() and revoked_at is null and scope = 'full'
  );
$f$;

revoke execute on function public.fn_is_platform_admin_full() from public, anon;
grant execute on function public.fn_is_platform_admin_full() to authenticated, service_role;

-- ---- organizations: a mais sensível da issue ----
drop policy if exists orgs_write_platform_admin on public.organizations;
create policy orgs_write_platform_admin on public.organizations
  for all using (public.fn_is_platform_admin_full())
  with check (public.fn_is_platform_admin_full());

-- ---- api_tokens: única policy FOR ALL virou par ----
drop policy if exists api_tokens_admin_only on public.api_tokens;
drop policy if exists api_tokens_tenant_read on public.api_tokens;
create policy api_tokens_tenant_read on public.api_tokens
  for select using (public.fn_role_at_least(organization_id, 'admin') or public.fn_is_platform_admin());
drop policy if exists api_tokens_admin_write on public.api_tokens;
create policy api_tokens_admin_write on public.api_tokens
  for all using (public.fn_role_at_least(organization_id, 'admin') or public.fn_is_platform_admin_full())
  with check (public.fn_role_at_least(organization_id, 'admin') or public.fn_is_platform_admin_full());

-- ---- nuvemshop_products: única policy FOR ALL virou par ----
drop policy if exists nuvemshop_products_tenant on public.nuvemshop_products;
drop policy if exists nuvemshop_products_read on public.nuvemshop_products;
create policy nuvemshop_products_read on public.nuvemshop_products
  for select using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());
drop policy if exists nuvemshop_products_tenant_write on public.nuvemshop_products;
create policy nuvemshop_products_tenant_write on public.nuvemshop_products
  for all using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin_full())
  with check (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin_full());

-- ---- incidents: única policy FOR ALL virou par ----
drop policy if exists platform_admin_only_incidents on public.incidents;
drop policy if exists incidents_tenant_read on public.incidents;
create policy incidents_tenant_read on public.incidents
  for select using (public.fn_is_platform_admin());
drop policy if exists incidents_admin_write on public.incidents;
create policy incidents_admin_write on public.incidents
  for all using (public.fn_is_platform_admin_full())
  with check (public.fn_is_platform_admin_full());

-- ---- ai_invocations / contacts / channel_session_warmup: tenant_isolation virou par ----
drop policy if exists tenant_isolation_ai_invocations_all on public.ai_invocations;
drop policy if exists tenant_isolation_ai_invocations_read on public.ai_invocations;
create policy tenant_isolation_ai_invocations_read on public.ai_invocations
  for select using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());
drop policy if exists tenant_isolation_ai_invocations_write on public.ai_invocations;
create policy tenant_isolation_ai_invocations_write on public.ai_invocations
  for all using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin_full())
  with check (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin_full());

drop policy if exists tenant_isolation_contacts_all on public.contacts;
drop policy if exists tenant_isolation_contacts_read on public.contacts;
create policy tenant_isolation_contacts_read on public.contacts
  for select using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());
drop policy if exists tenant_isolation_contacts_write on public.contacts;
create policy tenant_isolation_contacts_write on public.contacts
  for all using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin_full())
  with check (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin_full());

drop policy if exists warmup_tenant_isolation_all on public.channel_session_warmup;
drop policy if exists warmup_tenant_isolation_read on public.channel_session_warmup;
create policy warmup_tenant_isolation_read on public.channel_session_warmup
  for select using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());
drop policy if exists warmup_tenant_isolation_write on public.channel_session_warmup;
create policy warmup_tenant_isolation_write on public.channel_session_warmup
  for all using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin_full())
  with check (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin_full());

-- ---- policies que já tinham SELECT separada: só a escrita vira _full ----
drop policy if exists audit_log_insert_tenant_member on public.api_audit_log;
create policy audit_log_insert_tenant_member on public.api_audit_log
  for insert to authenticated
  with check ((organization_id is null) or (organization_id in (select public.fn_user_org_ids()))
              or public.fn_is_platform_admin_full());

drop policy if exists lgpd_requests_admin_write on public.lgpd_requests;
create policy lgpd_requests_admin_write on public.lgpd_requests
  for all using (public.fn_is_platform_admin_full()
                 or (organization_id in (select public.fn_user_org_ids())
                     and public.fn_role_at_least(organization_id, 'admin')))
  with check (public.fn_is_platform_admin_full()
              or (organization_id in (select public.fn_user_org_ids())
                  and public.fn_role_at_least(organization_id, 'admin')));

drop policy if exists merge_queue_manager_write on public.merge_queue;
create policy merge_queue_manager_write on public.merge_queue
  for all using (public.fn_is_platform_admin_full()
                 or (organization_id in (select public.fn_user_org_ids())
                     and public.fn_role_at_least(organization_id, 'manager')))
  with check (public.fn_is_platform_admin_full()
              or (organization_id in (select public.fn_user_org_ids())
                  and public.fn_role_at_least(organization_id, 'manager')));

drop policy if exists orders_tenant_write on public.orders;
create policy orders_tenant_write on public.orders
  for all using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin_full())
  with check (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin_full());

drop policy if exists tenant_integrations_admin_write on public.tenant_integrations;
create policy tenant_integrations_admin_write on public.tenant_integrations
  for all using (public.fn_is_platform_admin_full()
                 or (organization_id in (select public.fn_user_org_ids())
                     and public.fn_role_at_least(organization_id, 'manager')))
  with check (public.fn_is_platform_admin_full()
              or (organization_id in (select public.fn_user_org_ids())
                  and public.fn_role_at_least(organization_id, 'manager')));

drop policy if exists user_orgs_delete on public.user_organizations;
create policy user_orgs_delete on public.user_organizations
  for delete using (public.fn_role_at_least(organization_id, 'admin') or public.fn_is_platform_admin_full());

drop policy if exists user_orgs_insert on public.user_organizations;
create policy user_orgs_insert on public.user_organizations
  for insert with check (public.fn_role_at_least(organization_id, 'admin') or public.fn_is_platform_admin_full());

drop policy if exists user_orgs_update on public.user_organizations;
create policy user_orgs_update on public.user_organizations
  for update using (public.fn_role_at_least(organization_id, 'admin') or public.fn_is_platform_admin_full());
