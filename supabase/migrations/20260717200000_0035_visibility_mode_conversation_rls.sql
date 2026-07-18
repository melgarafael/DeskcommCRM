-- 0035_visibility_mode_conversation_rls — G4-01: escopo de visualização por
-- atendente (eixo 5, spec 13 §3.5 + §4). organizations.settings.visibility_mode
-- ('all'|'own_and_unassigned'|'own', default 'own_and_unassigned' — decisão
-- G1-06a) restringe o SELECT de conversations/messages APENAS para o role agent;
-- viewer/manager/admin seguem org-wide read.
--
-- fn_can_view_conversation(p_org, p_assigned_to_user_id): lógica pura de
-- visibilidade, ESTÁVEL e testável isoladamente. Recebe os campos da ROW (a
-- policy de conversations passa organization_id + assigned_to_user_id) — evita
-- lookup/recursão por-row na própria conversations. SECURITY DEFINER + search_path
-- blindado (lê organizations.settings e resolve role via auth.uid()); EXECUTE
-- revogado de anon/public (lição G4-00) — só authenticated/service_role.
--
-- Trap coberta: a policy de escrita 0030 (conversations_agent_write) é FOR ALL,
-- e o USING de um FOR ALL permissivo TAMBÉM governa o SELECT (policies OR-adas) —
-- deixá-la como está faria o agent enxergar tudo pelo ramo de escrita, anulando o
-- visibility. Por isso a escrita é re-expressa por-comando (INSERT/UPDATE/DELETE),
-- MESMO agent+/org (quem escreve não muda), removendo só o grant implícito de
-- SELECT. Idem messages (era FOR ALL org-flat).
--
-- Idempotente (create or replace / drop if exists + create), portável em psql
-- puro (sem BEGIN/COMMIT, sem temp tables). Escrita NÃO restringida por
-- visibility; ingestão/outbound via service_role bypassa RLS.

create or replace function public.fn_can_view_conversation(
  p_org uuid,
  p_assigned_to_user_id uuid
) returns boolean
language sql stable security definer
set search_path = public
as $$
  select case
    when public.fn_is_platform_admin() then true
    when public.fn_user_role_in_org(p_org) is null then false        -- não é membro
    when public.fn_user_role_in_org(p_org) in ('viewer','manager','admin') then true  -- org-wide read
    -- role = 'agent': aplica visibility_mode sobre assigned_to
    when p_assigned_to_user_id = auth.uid() then true                 -- as suas
    else case coalesce(
           (select settings->>'visibility_mode' from public.organizations where id = p_org),
           'own_and_unassigned')                                      -- default G1-06a
         when 'all' then true
         when 'own_and_unassigned' then p_assigned_to_user_id is null -- + fila não-atribuída
         else false                                                   -- 'own': só as suas
       end
  end;
$$;

revoke all on function public.fn_can_view_conversation(uuid, uuid) from public;
revoke execute on function public.fn_can_view_conversation(uuid, uuid) from anon;
grant execute on function public.fn_can_view_conversation(uuid, uuid)
  to authenticated, service_role;

-- conversations: SELECT visibility-aware (role + visibility_mode + assigned_to).
drop policy if exists "conversations_select" on public.conversations;
create policy "conversations_select" on public.conversations
  for select using (
    public.fn_can_view_conversation(organization_id, assigned_to_user_id)
  );

-- escrita agent+ org-wide preservada, mas por-comando (sem governar SELECT).
drop policy if exists "conversations_agent_write" on public.conversations;
drop policy if exists "conversations_agent_insert" on public.conversations;
drop policy if exists "conversations_agent_update" on public.conversations;
drop policy if exists "conversations_agent_delete" on public.conversations;

create policy "conversations_agent_insert" on public.conversations
  for insert with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );
create policy "conversations_agent_update" on public.conversations
  for update using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  ) with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );
create policy "conversations_agent_delete" on public.conversations
  for delete using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

-- messages: SELECT herda o escopo da conversa-mãe (mensagem visível sse a
-- conversa é visível). exists() aplica a RLS de conversations (que usa
-- fn_can_view_conversation) — conversa oculta ⇒ 0 rows ⇒ mensagem oculta.
-- (NÃO usar scalar subquery de assigned_to: RLS a devolveria NULL e o modo
-- own_and_unassigned trataria como fila → vazamento.)
drop policy if exists "messages_tenant_isolation_all" on public.messages;
drop policy if exists "messages_select" on public.messages;
drop policy if exists "messages_insert" on public.messages;
drop policy if exists "messages_update" on public.messages;
drop policy if exists "messages_delete" on public.messages;

create policy "messages_select" on public.messages
  for select using (
    public.fn_is_platform_admin()
    or exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id
    )
  );

-- escrita de mensagem NÃO restringida por visibility — comportamento org atual
-- preservado (ingestão/outbound via service_role bypassa RLS de qualquer forma).
create policy "messages_insert" on public.messages
  for insert with check (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );
create policy "messages_update" on public.messages
  for update using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  ) with check (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );
create policy "messages_delete" on public.messages
  for delete using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

-- Forward-fix necessário do G4-01: fn_conversation_assign (0031/0032) era SECURITY
-- INVOKER. Com o SELECT de conversations agora visibility-aware, o `update ...
-- returning *` re-aplica a policy de SELECT à NOVA linha — numa transferência o
-- dono passa a ser outro atendente, que o autor não enxerga mais, e o RETURNING
-- falha ("new row violates row-level security policy"). DEFINER bypassa a RLS na
-- escrita interna; a autorização do CALLER, antes garantida pela RLS INVOKER, é
-- re-afirmada DENTRO da função: membro ativo agent+ da MESMA org (service_role/MCP
-- tem auth.uid() null e é dispensado — call site já confiável). Corpo idêntico ao
-- 0032 fora o guard + security definer. Idempotente (create or replace).
create or replace function public.fn_conversation_assign(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_to_user_id uuid,
  p_reason text,
  p_expected_assignee uuid default null,
  p_enforce_expected boolean default false
) returns setof public.conversations
language plpgsql security definer
set search_path = public
as $$
declare
  v_from uuid;
  v_conv public.conversations%rowtype;
begin
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'agent') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'caller must be an active agent+ member of the organization';
  end if;

  if p_to_user_id is not null then
    if coalesce(public.fn_member_role_in_org(p_to_user_id, p_organization_id), 'none')
         not in ('agent','manager','admin') then
      raise exception 'assignee_not_eligible_member'
        using hint = 'target must be an active agent+ member of the organization';
    end if;
  end if;

  select assigned_to_user_id into v_from
    from public.conversations
   where id = p_conversation_id
     and organization_id = p_organization_id
   for update;

  if not found then
    return;
  end if;

  if p_enforce_expected and v_from is distinct from p_expected_assignee then
    return;
  end if;

  update public.conversations
     set assigned_to_user_id = p_to_user_id,
         assigned_at = case when p_to_user_id is null then null else now() end,
         assignee_kind = case when p_to_user_id is null then null else 'user' end,
         status = case when p_to_user_id is null then 'open' else 'claimed' end,
         status_changed_at = now(),
         unread_count_for_assignee = 0,
         updated_at = now()
   where id = p_conversation_id
   returning * into v_conv;

  insert into public.conversation_assignment_events
    (organization_id, conversation_id, from_user_id, to_user_id, changed_by, reason)
  values
    (p_organization_id, p_conversation_id, v_from, p_to_user_id, auth.uid(), p_reason);

  return next v_conv;
end;
$$;

revoke all on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean) from public;
revoke execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean) from anon;
grant execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean)
  to authenticated, service_role;
