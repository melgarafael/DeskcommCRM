-- 0042_lead_children_visibility_rls — G6-00 (INB-10): fecha o vazamento de LEITURA
-- da timeline/vínculos de lead. Pré-condição da exposição MCP (G6-03).
--
-- PROBLEMA: crm_lead_activities e crm_lead_links seguiam org-flat no SELECT — um
-- agent em modo 'own' NÃO via o lead (G4-03/0036 fecha crm_leads), mas lia as
-- activities/links dele por query direta (herança não fechada). As tabelas-filhas
-- devem ESPELHAR a visibilidade do lead-pai.
--
-- FIX: SELECT passa a exigir a visibilidade do lead-pai via a MESMA fn_can_view_lead
-- da G4-03 (migration 0036), por HERANÇA — a activity/link é visível SSE o lead-pai
-- é visível. Via EXISTS no lead_id (servido por idx_lead_activities_org_lead_perf /
-- idx_crm_lead_links_lead):
--   exists (select 1 from crm_leads l
--             where l.id = <tabela>.lead_id
--               and fn_can_view_lead(l.organization_id, l.owner_user_id))
-- CUIDADO (lição G4-01): NÃO usar scalar-subquery de owner. Sob RLS um scalar de
-- owner devolveria NULL pro lead oculto e o modo own_and_unassigned trataria NULL
-- como "fila" ⇒ VAZAMENTO. O EXISTS não tem esse furo (linha oculta ⇒ 0 rows ⇒ false).
--
-- WRITE (matriz §4 — defesa em profundidade, NÃO o vetor do INB-10, que é de LEITURA):
-- mantém-se org-scope IDÊNTICO ao de hoje. Todo escritor real de timeline/vínculo
-- (MCP handoff, rota LGPD, código de rota) usa SERVICE ROLE (admin client) e BYPASSA
-- RLS; activities é append-only (sem policy de update/delete). Restringir o WRITE por
-- visibilidade arriscaria o emissor polimórfico da timeline sem fechar nada de novo —
-- o SELECT é o que fecha o INB-10. Por isso o WITH CHECK/USING de escrita é preservado
-- byte-a-byte (org-membership OR platform_admin).
--
-- crm_lead_links era `tenant_isolation_crm_lead_links_all` FOR ALL: a ARMADILHA da
-- G4-01 — o USING de uma FOR ALL permissiva TAMBÉM governa o SELECT (policies OR-adas),
-- anulando o fechamento. Por isso é dropada e re-expressa POR-COMANDO (sem FOR ALL).
--
-- Idempotente (drop policy if exists + create), portável em psql puro (sem BEGIN/COMMIT,
-- sem temp tables). fn_can_view_lead já existe (0036) — REUSE, não recria.

-- ---- crm_lead_activities: SELECT visibility-aware; INSERT org-scope (inalterado) ----
drop policy if exists "tenant_isolation_crm_lead_activities_select" on public.crm_lead_activities;
drop policy if exists "tenant_isolation_crm_lead_activities_insert" on public.crm_lead_activities;
drop policy if exists "crm_lead_activities_select" on public.crm_lead_activities;
drop policy if exists "crm_lead_activities_insert" on public.crm_lead_activities;

create policy "crm_lead_activities_select" on public.crm_lead_activities
  for select using (
    exists (
      select 1 from public.crm_leads l
      where l.id = crm_lead_activities.lead_id
        and public.fn_can_view_lead(l.organization_id, l.owner_user_id)
    )
  );

create policy "crm_lead_activities_insert" on public.crm_lead_activities
  for insert with check (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

-- ---- crm_lead_links: drop FOR ALL; SELECT visibility-aware; write org-scope ----
drop policy if exists "tenant_isolation_crm_lead_links_all" on public.crm_lead_links;
drop policy if exists "crm_lead_links_select" on public.crm_lead_links;
drop policy if exists "crm_lead_links_insert" on public.crm_lead_links;
drop policy if exists "crm_lead_links_update" on public.crm_lead_links;
drop policy if exists "crm_lead_links_delete" on public.crm_lead_links;

create policy "crm_lead_links_select" on public.crm_lead_links
  for select using (
    exists (
      select 1 from public.crm_leads l
      where l.id = crm_lead_links.lead_id
        and public.fn_can_view_lead(l.organization_id, l.owner_user_id)
    )
  );

create policy "crm_lead_links_insert" on public.crm_lead_links
  for insert with check (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );
create policy "crm_lead_links_update" on public.crm_lead_links
  for update using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  ) with check (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );
create policy "crm_lead_links_delete" on public.crm_lead_links
  for delete using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );
