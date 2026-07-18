-- 0036_visibility_mode_lead_rls — G4-03: escopo de visualização/escrita por
-- atendente no kanban/leads (eixo 5, spec 13 §4 linha 220). Espelha a G4-01
-- (conversations, migration 0035) para crm_leads: o "dono" do lead é
-- crm_leads.owner_user_id (NÃO assigned_to — isso é conversa). REUSE do mesmo
-- knob organizations.settings.visibility_mode ('all'|'own_and_unassigned'|'own',
-- default 'own_and_unassigned' — decisão G1-06a): a matriz §4 diz "mesmo escopo
-- da G1-06a", logo é o mesmo botão, não um novo.
--
-- fn_can_view_lead(p_org, p_owner_user_id): lógica pura de visibilidade,
-- ESTÁVEL e testável isoladamente. Recebe os campos da ROW (a policy passa
-- organization_id + owner_user_id) — sem lookup/recursão por-row. SECURITY
-- DEFINER + search_path blindado (lê organizations.settings, resolve role via
-- auth.uid()); EXECUTE revogado de anon/public (lição G4-00) — só
-- authenticated/service_role. Só o role `agent` é restrito por visibility_mode;
-- viewer/manager/admin seguem org-wide read; platform_admin tudo.
--
-- Trap coberta (mesma da G4-01): a write-policy atual `tenant_isolation_crm_leads_all`
-- é FOR ALL org-flat, e o USING de um FOR ALL permissivo TAMBÉM governa o SELECT
-- (policies OR-adas) — deixá-la faria o agent enxergar TODO o board pelo ramo de
-- escrita, anulando o visibility. Por isso ela é dropada e re-expressa por-comando:
--   * SELECT   → fn_can_view_lead (agent = own+visibility; viewer/mgr/admin = org).
--   * ESCRITA  → agent = own-scope (mesma fn), manager+ = org-wide, viewer = none.
-- O drag-and-drop do kanban (UPDATE de stage_id/position de um lead PRÓPRIO do
-- agent, sem mudar owner) passa: owner=uid ⇒ fn_can_view_lead true ⇒ USING e
-- WITH CHECK ok. Mover lead de OUTRO agent é bloqueado (own:write). Bulk assign
-- (G3-04) é ≥manager ⇒ org-wide ⇒ intacto.
--
-- Idempotente (create or replace / drop if exists + create), portável em psql
-- puro (sem BEGIN/COMMIT, sem temp tables). Ingestão/import via service_role
-- bypassa RLS.

create or replace function public.fn_can_view_lead(
  p_org uuid,
  p_owner_user_id uuid
) returns boolean
language sql stable security definer
set search_path = public
as $$
  select case
    when public.fn_is_platform_admin() then true
    when public.fn_user_role_in_org(p_org) is null then false        -- não é membro
    when public.fn_user_role_in_org(p_org) in ('viewer','manager','admin') then true  -- org-wide read
    -- role = 'agent': aplica visibility_mode sobre owner_user_id
    when p_owner_user_id = auth.uid() then true                       -- os seus
    else case coalesce(
           (select settings->>'visibility_mode' from public.organizations where id = p_org),
           'own_and_unassigned')                                      -- default G1-06a
         when 'all' then true
         when 'own_and_unassigned' then p_owner_user_id is null       -- + os sem dono
         else false                                                   -- 'own': só os seus
       end
  end;
$$;

revoke all on function public.fn_can_view_lead(uuid, uuid) from public;
revoke execute on function public.fn_can_view_lead(uuid, uuid) from anon;
grant execute on function public.fn_can_view_lead(uuid, uuid)
  to authenticated, service_role;

-- Drop da FOR ALL org-flat (governava SELECT e escrita juntos).
drop policy if exists "tenant_isolation_crm_leads_all" on public.crm_leads;
drop policy if exists "crm_leads_select" on public.crm_leads;
drop policy if exists "crm_leads_insert" on public.crm_leads;
drop policy if exists "crm_leads_update" on public.crm_leads;
drop policy if exists "crm_leads_delete" on public.crm_leads;

-- SELECT visibility-aware (role + visibility_mode + owner_user_id).
create policy "crm_leads_select" on public.crm_leads
  for select using (
    public.fn_can_view_lead(organization_id, owner_user_id)
  );

-- Escrita por-role: agent = own-scope (mesma fn — "mesmo escopo" da matriz §4),
-- manager+ = org-wide, viewer = none (fn_role_at_least 'agent' exclui viewer).
-- fn_can_view_lead sozinha deixaria viewer escrever (org-wide read) — o piso
-- 'agent' fecha isso; o piso 'manager' abre org-wide sem depender de owner.
create policy "crm_leads_insert" on public.crm_leads
  for insert with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent')
        and (public.fn_role_at_least(organization_id, 'manager')
             or public.fn_can_view_lead(organization_id, owner_user_id)))
  );
create policy "crm_leads_update" on public.crm_leads
  for update using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent')
        and (public.fn_role_at_least(organization_id, 'manager')
             or public.fn_can_view_lead(organization_id, owner_user_id)))
  ) with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent')
        and (public.fn_role_at_least(organization_id, 'manager')
             or public.fn_can_view_lead(organization_id, owner_user_id)))
  );
create policy "crm_leads_delete" on public.crm_leads
  for delete using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent')
        and (public.fn_role_at_least(organization_id, 'manager')
             or public.fn_can_view_lead(organization_id, owner_user_id)))
  );
