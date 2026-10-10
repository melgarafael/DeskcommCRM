-- 0030_config_rls_role_policies — G2-03: RLS por role nas tabelas de config
-- (defesa em profundidade da matriz spec 13 §4; padrão fn_role_at_least já
-- usado em api_tokens/lgpd_requests/merge_queue).
--
-- Alvos (auditoria em docs/specs/13-spec-governanca-atendimento.md §4.1):
--   * crm_pipelines / crm_stages — "pipelines (config)": read org-flat,
--     WRITE manager+ (era org-flat: qualquer membro escrevia config).
--   * conversations — viewer é read-only: WRITE agent+. SELECT permanece
--     org-flat intocado (escopo own/unassigned é G4-01, não aqui).
--
-- Idempotente e auto-curativo: drop policy if exists + create. Sem dados a
-- corrigir (policies não invalidam linhas existentes). Sem BEGIN/COMMIT
-- (runner envolve em transação). Portável em psql puro.

-- crm_pipelines: split da policy ALL org-flat em SELECT org + WRITE manager+
drop policy if exists "tenant_isolation_crm_pipelines_all" on public.crm_pipelines;
drop policy if exists "crm_pipelines_select" on public.crm_pipelines;
drop policy if exists "crm_pipelines_manager_write" on public.crm_pipelines;

create policy "crm_pipelines_select" on public.crm_pipelines
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

create policy "crm_pipelines_manager_write" on public.crm_pipelines
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

-- crm_stages: mesma regra (stages são config de pipeline — spec 13 §4 nota 4)
drop policy if exists "tenant_isolation_crm_stages_all" on public.crm_stages;
drop policy if exists "crm_stages_select" on public.crm_stages;
drop policy if exists "crm_stages_manager_write" on public.crm_stages;

create policy "crm_stages_select" on public.crm_stages
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

create policy "crm_stages_manager_write" on public.crm_stages
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

-- conversations: viewer read-only (spec 13 §4 nota 1). SELECT continua
-- org-flat com a MESMA expressão da policy ALL antiga; write vira agent+.
drop policy if exists "conversations_tenant_isolation_all" on public.conversations;
drop policy if exists "conversations_select" on public.conversations;
drop policy if exists "conversations_agent_write" on public.conversations;

create policy "conversations_select" on public.conversations
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

create policy "conversations_agent_write" on public.conversations
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );
