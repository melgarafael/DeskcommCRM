-- 0176 — push_subscriptions: policy ALL sem fn_role_at_least.
--
-- A 0168 criou a tabela com RLS da própria linha (user_id = auth.uid()), mas a
-- policy era `FOR ALL` só com tenancy + dono — o gate
-- `tests/invariants/rbac-config-ia-canais.test.ts` ("nenhuma tabela NOVA entra
-- com policy ALL só-tenancy") reprova exatamente isso. A rota HTTP já exige
-- `viewer` (`requireRole("viewer")`); a policy passa a espelhar o mesmo piso
-- com `fn_role_at_least(..., 'viewer')`, sem alargar quem escreve (continua
-- só a própria linha). Forward-fix da 0168; não edita a migration aplicada.

drop policy if exists push_subscriptions_own on public.push_subscriptions;
create policy push_subscriptions_own on public.push_subscriptions
  for all
  using (
    organization_id in (select public.fn_user_org_ids())
    and user_id = auth.uid()
    and public.fn_role_at_least(organization_id, 'viewer')
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    and user_id = auth.uid()
    and public.fn_role_at_least(organization_id, 'viewer')
  );
