-- 0032_conversation_assignee_kind
-- G3-02 (gov-loop): IA como assignee de 1ª classe (spec 13 §3.2) + forward-fix
-- INB-06a na fn_conversation_assign (migration 0031).
--
-- 1. conversations.assignee_kind ('user'|'ai') desambigua quem atende: humano
--    (assigned_to_user_id) ou o bot (status legado 'ai_handling'). CHECK de
--    coerência em forma de implicação (acceptance G3-02):
--      kind='user' ⇒ assigned_to_user_id not null;
--      kind='ai'   ⇒ assigned_to_user_id null;
--      kind null   ⇒ sem exigência (escritas legadas que não conhecem a coluna
--      continuam válidas — a semântica forte chega pelos caminhos canônicos).
--    Backfill ANTES da constraint (doutrina de migrations §8).
-- 2. fn_member_role_in_org(p_user, p_org): helper SECURITY DEFINER (família de
--    fn_user_role_in_org) — a RLS de user_organizations só mostra o próprio
--    membership a um agent, então a validação de destino DENTRO da função
--    invoker precisa deste bypass controlado. Executável APENAS por
--    authenticated (responde só quando o caller é membro ativo da org) e
--    service_role (worker/handoff, auth.uid() null). anon tem EXECUTE
--    revogado EXPLICITAMENTE: o ALTER DEFAULT PRIVILEGES do Supabase concede
--    EXECUTE a anon em toda função nova de public, e o JWT anon também tem
--    auth.uid() null — sem o revoke, o PostgREST exporia a função como RPC
--    pública e qualquer um enumeraria membership/role cross-org.
-- 3. fn_conversation_assign v2 (INB-06a): destino usuário DEVE ser membro
--    ativo agent+ da MESMA org — validado DENTRO da função (probe H8 do
--    verifier: rpc direto atribuía a viewer/usuário de outra org). Também
--    passa a manter assignee_kind coerente ('user' quando ganha dono, null
--    quando volta à fila) em claim/transfer/release/handoff.
--
-- Idempotente, portável em psql puro (sem BEGIN/COMMIT, sem temp tables).

-- A. Coluna
alter table public.conversations
  add column if not exists assignee_kind text
  check (assignee_kind in ('user','ai'));

-- B. Backfill (ANTES da constraint — corrige qualquer banco de clone):
--    dono humano ⇒ 'user'; 'user' órfão (sem dono) ⇒ null; ai_handling sem
--    dono ⇒ 'ai'.
update public.conversations
   set assignee_kind = 'user'
 where assigned_to_user_id is not null
   and assignee_kind is distinct from 'user';

update public.conversations
   set assignee_kind = null
 where assigned_to_user_id is null
   and assignee_kind = 'user';

update public.conversations
   set assignee_kind = 'ai'
 where status = 'ai_handling'
   and assigned_to_user_id is null
   and assignee_kind is distinct from 'ai';

-- C. Constraint de coerência (drop+add — re-aplicável)
alter table public.conversations
  drop constraint if exists conversations_assignee_kind_coherence;
alter table public.conversations
  add constraint conversations_assignee_kind_coherence check (
    (assignee_kind = 'user' and assigned_to_user_id is not null) or
    (assignee_kind = 'ai'   and assigned_to_user_id is null)     or
    (assignee_kind is null)
  );

-- D. Helper: role de QUALQUER membro da org (SECURITY DEFINER). Caller
--    authenticated precisa ser membro ativo da org; auth.uid() null é o path
--    do sistema (service_role) — e SÓ dele, porque anon (que também tem uid
--    null) tem EXECUTE revogado explicitamente abaixo.
create or replace function public.fn_member_role_in_org(p_user uuid, p_org uuid)
returns text
language sql stable security definer
set search_path = public
as $$
  select uo.role
    from public.user_organizations uo
   where uo.user_id = p_user
     and uo.organization_id = p_org
     and uo.revoked_at is null
     and (
       auth.uid() is null
       or exists (
         select 1 from public.user_organizations me
          where me.user_id = auth.uid()
            and me.organization_id = p_org
            and me.revoked_at is null
       )
     )
   limit 1;
$$;

revoke all on function public.fn_member_role_in_org(uuid, uuid) from public;
-- O revoke from public NÃO cobre o grant DIRETO que anon carrega via
-- ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon (padrão
-- Supabase). Sem esta linha, o PostgREST expõe a função como RPC pública
-- (anon key vai pro browser) e o ramo auth.uid() null responde a request
-- anônimo — enumeração de membership/role de qualquer tenant.
revoke execute on function public.fn_member_role_in_org(uuid, uuid) from anon;
grant execute on function public.fn_member_role_in_org(uuid, uuid)
  to authenticated, service_role;

-- E. fn_conversation_assign v2 — guard INB-06a + manutenção de assignee_kind.
create or replace function public.fn_conversation_assign(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_to_user_id uuid,          -- null = release (volta à fila)
  p_reason text,              -- claim|transfer|release|routing|handoff (CHECK da tabela)
  p_expected_assignee uuid default null,
  p_enforce_expected boolean default false
) returns setof public.conversations
language plpgsql
set search_path = public
as $$
declare
  v_from uuid;
  v_conv public.conversations%rowtype;
begin
  -- INB-06a: destino usuário DEVE ser membro ativo agent+ da mesma org —
  -- validado aqui (não só na rota); rpc direto não atribui a viewer/estranho.
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
    return; -- inexistente / fora do escopo RLS → 0 rows
  end if;

  if p_enforce_expected and v_from is distinct from p_expected_assignee then
    return; -- optimistic lock perdeu (spec 04 §9.2) → rota devolve 409
  end if;

  update public.conversations
     set assigned_to_user_id = p_to_user_id,
         assigned_at = case when p_to_user_id is null then null else now() end,
         -- G3-02: quem atende é 'user' ou volta à fila (null); 'ai' nunca sai daqui.
         assignee_kind = case when p_to_user_id is null then null else 'user' end,
         status = case when p_to_user_id is null then 'open' else 'claimed' end,
         status_changed_at = now(),
         unread_count_for_assignee = 0, -- G3-01 acceptance 5: re-zera pro novo dono
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
grant execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean)
  to authenticated, service_role;
