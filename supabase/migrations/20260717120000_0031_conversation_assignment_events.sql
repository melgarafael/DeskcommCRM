-- 0031_conversation_assignment_events
-- G3-01 (gov-loop): auditoria estruturada de TODA mudança de dono de conversa
-- (spec 13 §3.1) + função atômica fn_conversation_assign usada pelas rotas de
-- claim/transfer/release (spec 04 §9: UPDATE condicional; 0 rows → 409).
--
-- Por que função SQL (e não trigger): trigger em conversations não tem acesso
-- ao `reason` (claim|transfer|release|routing|handoff) nem distingue ator de
-- sistema; a função recebe o reason como parâmetro, resolve changed_by via
-- auth.uid() (null = worker/sistema via service role — não confia em input do
-- caller) e faz UPDATE + INSERT do evento na MESMA transação. Trigger nunca
-- faz HTTP (doutrina) — aqui nem trigger há.
--
-- Idempotente, portável em psql puro (sem BEGIN/COMMIT, sem temp tables).

-- A. Tabela de eventos (append-only, família api_audit_log)
create table if not exists public.conversation_assignment_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  from_user_id    uuid references auth.users(id) on delete set null, -- null = sem dono / com a IA
  to_user_id      uuid references auth.users(id) on delete set null, -- null = liberada (volta à fila/IA)
  changed_by      uuid references auth.users(id) on delete set null, -- null = sistema (worker de routing / agente IA)
  reason          text not null
                  check (reason in ('claim','transfer','release','routing','handoff')),
  created_at      timestamptz not null default now()
);

create index if not exists idx_cae_conversation
  on public.conversation_assignment_events (conversation_id, created_at desc);

alter table public.conversation_assignment_events enable row level security;

-- RLS: tenant org via fn_user_org_ids() — SELECT + INSERT apenas.
-- Append-only: SEM policy de UPDATE/DELETE (mesma família de api_audit_log).
drop policy if exists cae_select on public.conversation_assignment_events;
create policy cae_select on public.conversation_assignment_events
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

drop policy if exists cae_insert on public.conversation_assignment_events;
create policy cae_insert on public.conversation_assignment_events
  for insert with check (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

revoke all on public.conversation_assignment_events from anon;

-- B. Mudança de dono atômica: UPDATE condicional + evento na MESMA transação.
-- SECURITY INVOKER de propósito: a RLS de conversations (write agent+, org via
-- fn_user_org_ids — migration 0030) continua valendo dentro da função; o
-- SELECT ... FOR UPDATE exige passar também a policy de UPDATE (agent+).
-- Retorna 0 rows quando o optimistic lock perde → rota devolve 409.
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
