-- 0163 — escrita nas tabelas de conhecimento/RAG passa a exigir manager+.
--
-- Achado ao comparar com o changelog do upstream (DeskcommCRM 1.8.0): "qualquer
-- role de usuário escrevia nas 4 tabelas do acervo de conhecimento". No
-- SonghaiCRM as 4 policies (`tenant_isolation_ai_chunks_all`,
-- `tenant_isolation_ai_faq_items_all`, `tenant_isolation_ai_kbv_all`,
-- `tenant_isolation_ai_knowledge_sources_all`) têm o MESMO defeito: `USING`/
-- `WITH CHECK` checam só `organization_id IN (fn_user_org_ids())`, sem role.
-- A defesa hoje mora só na API (`requireRole("manager", ...)` nas 4 rotas
-- oficiais de `app/api/v1/ai/knowledge/...`) — qualquer caminho que bypasse
-- essas rotas (client Supabase autenticado direto, RPC futuro, endpoint novo
-- que esqueça o requireRole) escreveria sem barreira nenhuma.
--
-- Fix: cada `FOR ALL` vira duas policies — leitura continua aberta a qualquer
-- membro da org (nenhuma tela hoje depende de viewer/agent não lerem FAQ/
-- catálogo, e restringir SELECT sem necessidade seria mudança de escopo maior
-- que o achado pede); escrita (INSERT/UPDATE/DELETE) passa a exigir
-- `fn_role_at_least(organization_id, 'manager')`, o mesmo padrão já usado em
-- `merge_queue_manager_write`/`tenant_integrations_admin_write`. `SELECT`
-- continua coberta pela policy de leitura (permissiva, OR com a de escrita).
--
-- Idempotente: `drop policy if exists` + `create policy` recriável em qualquer
-- ordem de re-execução do update.sh.

drop policy if exists tenant_isolation_ai_chunks_all on public.ai_chunks;
create policy ai_chunks_select on public.ai_chunks
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );
drop policy if exists ai_chunks_write on public.ai_chunks;
create policy ai_chunks_write on public.ai_chunks
  for all using (
    ((organization_id in (select public.fn_user_org_ids())) and public.fn_role_at_least(organization_id, 'manager'))
    or public.fn_is_platform_admin()
  )
  with check (
    ((organization_id in (select public.fn_user_org_ids())) and public.fn_role_at_least(organization_id, 'manager'))
    or public.fn_is_platform_admin()
  );

drop policy if exists tenant_isolation_ai_faq_items_all on public.ai_faq_items;
create policy ai_faq_items_select on public.ai_faq_items
  for select using (organization_id in (select public.fn_user_org_ids()));
drop policy if exists ai_faq_items_write on public.ai_faq_items;
create policy ai_faq_items_write on public.ai_faq_items
  for all using (
    (organization_id in (select public.fn_user_org_ids())) and public.fn_role_at_least(organization_id, 'manager')
  )
  with check (
    (organization_id in (select public.fn_user_org_ids())) and public.fn_role_at_least(organization_id, 'manager')
  );

drop policy if exists tenant_isolation_ai_kbv_all on public.ai_knowledge_versions;
create policy ai_kbv_select on public.ai_knowledge_versions
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );
drop policy if exists ai_kbv_write on public.ai_knowledge_versions;
create policy ai_kbv_write on public.ai_knowledge_versions
  for all using (
    ((organization_id in (select public.fn_user_org_ids())) and public.fn_role_at_least(organization_id, 'manager'))
    or public.fn_is_platform_admin()
  )
  with check (
    ((organization_id in (select public.fn_user_org_ids())) and public.fn_role_at_least(organization_id, 'manager'))
    or public.fn_is_platform_admin()
  );

drop policy if exists tenant_isolation_ai_knowledge_sources_all on public.ai_knowledge_sources;
create policy ai_knowledge_sources_select on public.ai_knowledge_sources
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );
drop policy if exists ai_knowledge_sources_write on public.ai_knowledge_sources;
create policy ai_knowledge_sources_write on public.ai_knowledge_sources
  for all using (
    ((organization_id in (select public.fn_user_org_ids())) and public.fn_role_at_least(organization_id, 'manager'))
    or public.fn_is_platform_admin()
  )
  with check (
    ((organization_id in (select public.fn_user_org_ids())) and public.fn_role_at_least(organization_id, 'manager'))
    or public.fn_is_platform_admin()
  );
