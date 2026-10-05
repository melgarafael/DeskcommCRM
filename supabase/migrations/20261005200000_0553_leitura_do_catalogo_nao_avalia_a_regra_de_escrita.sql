-- manifest: **A leitura do catálogo deixa de pagar a regra de ESCRITA linha a linha.** `catalog_products_write` era `for all`, então também valia para SELECT: o Postgres juntava as duas permissivas por OR e avaliava `fn_is_platform_admin_full()` + `fn_role_at_least(organization_id,'manager')` (duas `security definer`) em CADA linha da organização, antes do filtro da busca. Medido em pg15 com 579 produtos, como `authenticated`: 1.204 ms a contagem e 1.110 ms a página — ~2 ms por produto; a tela faz as duas, e o redirect da página além do fim faz uma terceira. Com ~4.000 produtos a tela estoura o `statement_timeout` de 8 s e mostra "Algo deu errado"; no e2e (#2138) estourava com 580 num runner lento. A escrita vira três policies com a MESMA expressão (`catalog_products_insert`, `catalog_products_write` agora só `for update`, e `catalog_products_delete`), e as chamadas sem coluna viram `(select …)` (initPlan, uma vez por consulta). Depois: 10 ms e 1,4 ms.
-- 0553: a leitura do catálogo não avalia a regra de escrita
--
-- ─── O defeito ───────────────────────────────────────────────────────────────
--
-- Policy sem `for` é `for all`, e `for all` inclui SELECT. Com duas permissivas
-- valendo para a leitura, o Postgres as junta por OR, e o plano medido punha o
-- braço da ESCRITA primeiro:
--
--   Filter: ((fn_is_platform_admin_full() OR ((hashed SubPlan 1) AND
--             fn_role_at_least(organization_id, 'manager'))) OR (hashed SubPlan 2)
--             OR fn_is_platform_admin()) AND (nome ~~* ... OR codigo ~~* ...)
--
-- As duas funções são `security definer` (não se expandem na consulta) e
-- `fn_role_at_least` depende da coluna, então rodam UMA VEZ POR LINHA da
-- organização — e antes do `ilike`, que não é leakproof e por isso fica depois
-- da RLS. A tela de Produtos pede `count=exact` (varre tudo) e a página.
--
-- ─── O conserto ──────────────────────────────────────────────────────────────
--
-- A regra de escrita continua IDÊNTICA (mesma expressão, mesmos papéis, o
-- `_full` da 0533), só deixa de valer para a leitura. As chamadas que não
-- dependem da linha viram `(select …)`: o planner as executa uma vez.
--
-- Idempotente: `drop policy if exists` antes de cada `create policy`.

drop policy if exists catalog_products_select on public.catalog_products;
create policy catalog_products_select on public.catalog_products
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or (select public.fn_is_platform_admin())
  );

drop policy if exists catalog_products_write on public.catalog_products;

drop policy if exists catalog_products_insert on public.catalog_products;
create policy catalog_products_insert on public.catalog_products
  for insert with check (
    (select public.fn_is_platform_admin_full())
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

-- O nome `_write` fica com o UPDATE: é por ele que a 0533 e o invariante
-- `platform-admin-full-so-escreve` conferem a expressão da escrita.
create policy catalog_products_write on public.catalog_products
  for update using (
    (select public.fn_is_platform_admin_full())
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    (select public.fn_is_platform_admin_full())
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists catalog_products_delete on public.catalog_products;
create policy catalog_products_delete on public.catalog_products
  for delete using (
    (select public.fn_is_platform_admin_full())
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );
