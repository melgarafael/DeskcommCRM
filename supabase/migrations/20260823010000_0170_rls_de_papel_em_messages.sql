-- 0170: RLS de messages isolava por tenant mas não checava PAPEL
--
-- Mesma classe de falha que a 0169 já corrigiu para contacts. A auditoria
-- técnica de 2026-08-23 encontrou que `messages_insert`/`messages_update`/
-- `messages_delete` (baseline.sql, apêndice da 0169-era) checavam só
-- `organization_id in (select fn_user_org_ids())`, sem `fn_role_at_least`.
-- `messages` guarda o corpo das conversas de WhatsApp do tenant — dado tão
-- sensível quanto `contacts`. Qualquer membro do tenant, inclusive `viewer`
-- (documentado como somente-leitura em spec 13 §4), podia apagar ou alterar
-- qualquer mensagem do tenant direto pelo PostgREST, com a própria sessão,
-- sem passar por `requireRole` — que `app/api/v1/messages/route.ts:22` já
-- exige (`requireRole("agent", ...)`) no caminho da API.
--
-- FORMA: mesmo par da 0169 — `messages_select` fica como está (a leitura já
-- delega a checagem real para o RLS de `conversations` via EXISTS, então
-- todo membro do tenant com acesso à conversa continua lendo) + escrita
-- (insert/update/delete) passa a exigir `fn_role_at_least(organization_id,
-- 'agent')`, o mesmo piso que a API já impõe. A policy passa a espelhar a
-- API, em vez de ficar um nível mais frouxa que ela.
--
-- Preserva o acesso de platform admin (`fn_is_platform_admin()`), como a
-- policy anterior já garantia. O worker não entra nesta conta: usa
-- `service_role`, que é `bypassrls`.

drop policy if exists "messages_insert" on public.messages;
create policy "messages_insert" on public.messages
  for insert with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

drop policy if exists "messages_update" on public.messages;
create policy "messages_update" on public.messages
  for update using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  ) with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

drop policy if exists "messages_delete" on public.messages;
create policy "messages_delete" on public.messages
  for delete using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

-- O PostgREST guarda o schema em cache; sem isto as policies novas só valem
-- no próximo reload dele.
notify pgrst, 'reload schema';
