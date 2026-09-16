-- 0264 · `instagram_pending_posts` nasceu com policy de escrita SEM gate de papel
-- (issue #150, forward-fix).
--
-- ─── O que isto fecha ────────────────────────────────────────────────────────
-- A migration 0268 deu à tabela `for all using (organization_id in
-- fn_user_org_ids()) with check (mesma coisa)` — isolamento de TENANT, sem
-- isolamento de PAPEL. Depois da 0150 (que fechou a mesma lacuna em
-- `channel_sessions`/`ai_agents`/etc.), `tests/invariants/rbac-config-ia-canais.test.ts`
-- ganhou a varredura "nenhuma tabela NOVA entra com policy ALL só-tenancy", e
-- ela reprova exatamente este caso: qualquer membro da organização — inclusive
-- `viewer` — pode hoje criar, editar ou apagar um rascunho de post que está
-- prestes a publicar no Instagram de um lead em nome da empresa. É a mesma
-- classe de defeito que a 0150 documenta no cabeçalho: o `requireRole()` das
-- rotas Next não é a única porta, o PostgREST é exposto ao browser por
-- construção, e um `viewer` autenticado fala com ele direto.
--
-- `manager`, não `admin`: publicar em nome de um lead é uma ação operacional
-- consequente (mesmo nível de `channel_sessions`/`tenant_integrations`), não
-- uma decisão estrutural da organização (`user_organizations`/`lgpd_requests`,
-- que pedem `admin`). A LEITURA continua sem gate de papel — o comentário
-- original da 0268 já dizia "quem administra a organização deve poder VER o
-- que está prestes a ser publicado", e nada aqui muda isso: só a ESCRITA some
-- do alcance do `viewer`.
--
-- Idempotente: `drop policy if exists` + `create policy`, sem DDL de tabela.

drop policy if exists tenant_isolation_instagram_pending_posts_modify on public.instagram_pending_posts;
create policy tenant_isolation_instagram_pending_posts_modify on public.instagram_pending_posts
  for all
  using (
    organization_id in (select * from public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  )
  with check (
    organization_id in (select * from public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  );
