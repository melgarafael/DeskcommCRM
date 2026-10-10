-- manifest: **Platform admin `support_readonly` deixa de escrever nas 11 policies da prioridade 1–4 do #2115.** Continuação da 0508, que trocou `fn_is_platform_admin()` por `fn_is_platform_admin_full()` só no trecho do dump do `baseline.sql`; as policies de escrita criadas nos apêndices ficaram com a função pura. Reli as definições vivas na `main@47c03e678` (última por tabela.nome) e a lista do issue está exata: 47. Esta fatia cobre `team_invites_write`, os três de `messages`, os três de `crm_leads`, `channel_sessions_tenant_write` e os três de `conversations` — 11 trocas diretas, sem partir `FOR ALL` (cada uma dessas tabelas já tem policy `SELECT` própria com `fn_is_platform_admin()`, então `support_readonly` segue lendo). A única das 47 cuja escrita é também a única leitura é `recurring_entries`; fica para a fatia seguinte. Gate: `tests/invariants/platform-admin-full-so-escreve.test.ts` estendido.

-- 0529: fatia 1 da #2115 — prioridades 1 a 4 do issue.
--
-- A 0508 consertou o trecho do DUMP: `orgs_write_platform_admin` e mais 14
-- policies. As criadas nos APÊNDICES do `baseline.sql` não passaram por lá, e
-- um platform admin com `scope = 'support_readonly'` continua escrevendo nelas
-- pelo PostgREST — `fn_is_platform_admin()` ignora o scope do JWT.
--
-- Esta fatia é a ordem que o próprio issue define:
--   1. team_invites_write
--   2. messages_insert / messages_update / messages_delete
--   3. crm_leads_insert / crm_leads_update / crm_leads_delete
--   4. channel_sessions_tenant_write
--      conversations_agent_insert / _update / _delete
--
-- Forma do conserto: troca direta da função nas policies de ESCRITA. Não há par
-- `_read`/`_write` a criar aqui: as cinco tabelas já têm policy `SELECT` própria
-- com `fn_is_platform_admin()` (`team_invites_select`, `messages_select`,
-- `channel_sessions_tenant_select`; `crm_leads_select` e `conversations_select`
-- via `fn_can_view_lead`/`fn_can_view_conversation`), então a leitura do
-- `support_readonly` não depende da policy de escrita que este arquivo toca.
-- Das 47, a única cuja escrita é também a única leitura é `recurring_entries` —
-- essa sim precisa do par, e fica para a fatia seguinte.
--
-- Idempotente: `drop policy if exists` antes de cada `create`, o desenho da
-- 0508 — é o que o apêndice do `baseline.sql` reaplica a cada `update.sh`.
--
-- Medido em banco pelo invariante estendido
-- (`tests/invariants/platform-admin-full-so-escreve.test.ts`): como
-- `support_readonly`, 0 linhas em cada escrita; como `full`, as mesmas escritas
-- seguem passando; e a leitura segue de pé.

-- ---- 1. team_invites (prioridade 1) ----
drop policy if exists team_invites_write on public.team_invites;
create policy team_invites_write on public.team_invites
  using (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'admin'))
  )
  with check (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'admin'))
  );

-- ---- 2. messages (prioridade 2) ----
drop policy if exists "messages_insert" on public.messages;
create policy "messages_insert" on public.messages
  for insert with check (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin_full()
  );

drop policy if exists "messages_update" on public.messages;
create policy "messages_update" on public.messages
  for update using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin_full()
  ) with check (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin_full()
  );

drop policy if exists "messages_delete" on public.messages;
create policy "messages_delete" on public.messages
  for delete using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin_full()
  );

-- ---- 3. crm_leads (prioridade 3) ----
drop policy if exists "crm_leads_insert" on public.crm_leads;
create policy "crm_leads_insert" on public.crm_leads
  for insert with check (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent')
        and (public.fn_role_at_least(organization_id, 'manager')
             or public.fn_can_view_lead(organization_id, owner_user_id)))
  );

drop policy if exists "crm_leads_update" on public.crm_leads;
create policy "crm_leads_update" on public.crm_leads
  for update using (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent')
        and (public.fn_role_at_least(organization_id, 'manager')
             or public.fn_can_view_lead(organization_id, owner_user_id)))
  ) with check (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent')
        and (public.fn_role_at_least(organization_id, 'manager')
             or public.fn_can_view_lead(organization_id, owner_user_id)))
  );

drop policy if exists "crm_leads_delete" on public.crm_leads;
create policy "crm_leads_delete" on public.crm_leads
  for delete using (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent')
        and (public.fn_role_at_least(organization_id, 'manager')
             or public.fn_can_view_lead(organization_id, owner_user_id)))
  );

-- ---- 4. channel_sessions e conversations (prioridade 4) ----
drop policy if exists channel_sessions_tenant_write on public.channel_sessions;
create policy channel_sessions_tenant_write on public.channel_sessions
  for all using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin_full()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin_full()
  );

drop policy if exists "conversations_agent_insert" on public.conversations;
create policy "conversations_agent_insert" on public.conversations
  for insert with check (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

drop policy if exists "conversations_agent_update" on public.conversations;
create policy "conversations_agent_update" on public.conversations
  for update using (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  ) with check (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

drop policy if exists "conversations_agent_delete" on public.conversations;
create policy "conversations_agent_delete" on public.conversations
  for delete using (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );
