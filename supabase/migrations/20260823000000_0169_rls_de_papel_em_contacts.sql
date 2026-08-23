-- 0169: RLS de contacts isolava por tenant mas não checava PAPEL
--
-- Mesma classe de falha que a 0150 já corrigiu para canais/config de IA
-- (achado do relatório de segurança da comunidade; a 0150 deferiu de
-- propósito o resto do schema, "para depois"). `contacts` é o dado mais
-- crítico do produto — nome, telefone, e-mail — e sua única policy sempre
-- foi `tenant_isolation_contacts_all` (FOR ALL, só `fn_user_org_ids()`), com
-- `GRANT ALL ON TABLE public.contacts TO authenticated`. Qualquer membro do
-- tenant, inclusive `viewer` (documentado como somente-leitura em spec 13
-- §4), podia ler/gravar/apagar contato de qualquer outro contato do mesmo
-- tenant direto pelo PostgREST, com a própria sessão — sem passar por
-- `requireRole`.
--
-- FORMA: o mesmo par da 0150 — SELECT só-tenancy (todo membro continua
-- LENDO, senão a tela quebra para o viewer) + escrita (insert/update/delete)
-- com `fn_role_at_least(organization_id, 'agent')`, o mesmo piso que
-- `app/api/v1/contacts/route.ts` e `[id]/route.ts` já exigem no POST/PATCH/
-- DELETE ("spec 13 §4: escrita é agent+, viewer é read-only"). A policy
-- passa a espelhar a API, em vez de ficar um nível mais frouxa que ela.
--
-- Preserva o acesso de platform admin (`fn_is_platform_admin()`), do jeito
-- que a policy antiga também garantia via `OR fn_is_platform_admin()` — sem
-- isso o suporte de plataforma perderia acesso a contato de qualquer tenant.
--
-- O worker não entra nesta conta: usa `service_role`, que é `bypassrls`.

drop policy if exists "tenant_isolation_contacts_all" on public.contacts;

drop policy if exists "contacts_select" on public.contacts;
create policy "contacts_select" on public.contacts
  for select using (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

drop policy if exists "contacts_write" on public.contacts;
create policy "contacts_write" on public.contacts
  for all using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent'))
    or public.fn_is_platform_admin()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent'))
    or public.fn_is_platform_admin()
  );

-- O PostgREST guarda o schema em cache; sem isto as policies novas só valem
-- no próximo reload dele.
notify pgrst, 'reload schema';
