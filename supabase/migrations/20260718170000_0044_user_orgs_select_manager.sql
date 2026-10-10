-- 0044_user_orgs_select_manager — G6-06 (gov-loop, INB-14): SELECT de
-- user_organizations org-wide para manager+ (matriz spec 13 §4: team=org:read
-- a manager). A policy atual (user_orgs_select, baseline) só dava org-wide read
-- ao admin — manager caía no self-read e GET /api/v1/team devolvia 1 membro
-- (aba Membros quebrada). FIX cirúrgico: threshold 'admin' → 'manager' no SELECT.
--
-- Mantém self-read para TODOS (viewer/agent leem a própria linha — o auth/RBAC
-- depende disso; fn_user_org_ids/requireRole). WRITE inalterado: insert/update/
-- delete continuam fn_role_at_least(org,'admin') — não são tocados aqui.
--
-- Sem recursão: fn_role_at_least é STABLE SECURITY DEFINER (bypassa a RLS de
-- user_organizations internamente) — a policy atual já a chama no SELECT e o
-- sistema funciona; trocar o threshold mantém a propriedade. Cross-org seguro:
-- fn_role_at_least(organization_id, 'manager') é por-org (manager da org A não
-- vira manager da org B). Idempotente (drop if exists + create). Sem BEGIN/COMMIT
-- (runner envolve em transação). Sem mudança de contrato → database.types.ts intocado.

drop policy if exists "user_orgs_select" on public.user_organizations;

create policy "user_orgs_select" on public.user_organizations
  for select using (
    (user_id = auth.uid())
    or public.fn_role_at_least(organization_id, 'manager')
    or public.fn_is_platform_admin()
  );
