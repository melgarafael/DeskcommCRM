-- manifest: channel_sessions — a regra de escrita `channel_sessions_tenant_write` (for all) vira insert/update/delete com as MESMAS expressões, para não rodar em toda LEITURA. Ela chama fn_role_at_least → fn_user_role_in_org → fn_support_context (~4 ms por linha) e o embed `channel_sessions` da lista da Inbox a reavaliava por conversa: 7–10 s / statement timeout com ~570 conversas, ~100 ms depois (#3202). Quem lê segue sendo `channel_sessions_tenant_select`; quem escreve segue precisando ser admin da organização ou platform admin full. Mesmo movimento de `conversations_agent_write`.
--
-- Medido numa cópia restaurada de instalação real (v1.80.0 e v1.86.0, 576 conversas, 3 conexões):
--   antes:  Seq Scan on channel_sessions (actual time=4.069..12.108 rows=3 loops=573) · Execution Time: 7054 ms
--   depois: Seq Scan on channel_sessions (actual time=0.005..0.006 rows=3 loops=573) · Execution Time: 94 ms

drop policy if exists channel_sessions_tenant_write on public.channel_sessions;
drop policy if exists channel_sessions_tenant_insert on public.channel_sessions;
drop policy if exists channel_sessions_tenant_update on public.channel_sessions;
drop policy if exists channel_sessions_tenant_delete on public.channel_sessions;

create policy channel_sessions_tenant_insert on public.channel_sessions
  for insert with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin_full()
  );
create policy channel_sessions_tenant_update on public.channel_sessions
  for update using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin_full()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin_full()
  );
create policy channel_sessions_tenant_delete on public.channel_sessions
  for delete using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin_full()
  );
