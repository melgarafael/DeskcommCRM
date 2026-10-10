-- 0202 · O nome de quem atende custava uma chamada HTTP por atendente único da página.
--
-- ─── O sintoma ───────────────────────────────────────────────────────────────
-- Toda chamada a GET /api/v1/conversations (a listagem do Inbox) resolve o nome
-- do atendente de cada linha com `comNomeDoAtendente()` → `nomesDosAtendentes()`
-- (lib/users/nome-do-atendente.ts), que dispara UMA REQUISIÇÃO HTTP ao GoTrue
-- Admin API (`admin.auth.admin.getUserById`) por ID ÚNICO de atendente na
-- página — mesmo dedupado, mesmo quando a tela não vai mostrar o nome (o badge
-- só aparece quando há mais de um dono distinto na página). O próprio arquivo já
-- media o custo no cabeçalho: ~60ms para 1 atendente único, ~350ms para 10,
-- ~1,2s para 50 — e já apontava o conserto: desnormalizar o nome na linha, como
-- o repo já faz em `conversation_notes.created_by_name`.
--
-- ─── Por que a escrita entra em fn_conversation_assign, e não em 4 arquivos TS ──
-- Toda atribuição de conversa passa por ESTA função SECURITY DEFINER — claim,
-- release, transfer (app/api/v1/conversations/[id]/{claim,release,transfer}/route.ts)
-- e o worker de roteamento automático (lib/routing/worker.ts) chamam todos
-- `fn_conversation_assign` via RPC, e não existe UPDATE direto de
-- `assigned_to_user_id` em lugar nenhum do repo fora dela. Gravar o nome aqui,
-- uma vez, é a superfície mínima — replicar a resolução do nome em 4 call sites
-- TS criaria 4 chances de um deles ficar para trás.
--
-- ─── O que muda ──────────────────────────────────────────────────────────────
-- 1. `conversations.assigned_to_user_name` (nullable): a cópia do nome, escrita
--    no MESMO update que grava `assigned_to_user_id` — e zerada junto quando a
--    atribuição é removida (release: `p_to_user_id is null`).
-- 2. Backfill das linhas já atribuídas, lendo `auth.users.raw_user_meta_data
--    ->> 'full_name'` — o MESMO path que `app/api/v1/admin/users/route.ts` e
--    `app/api/v1/admin/platform-admins/route.ts` já leem para o mesmo campo.
-- 3. `fn_conversation_assign` (CREATE OR REPLACE, assinatura IDÊNTICA — mesma
--    razão da 0173: parâmetro novo criaria OVERLOAD e as chamadas por nome
--    passariam a falhar com `is not unique`) passa a resolver o nome por
--    subquery contra `auth.users` no mesmo UPDATE que grava o id.
--
-- O lado do app (`lib/users/com-nome-do-atendente.ts`) passa a ler a coluna já
-- presente na linha em vez de chamar `nomesDosAtendentes()` para toda a página —
-- mudança companion no TypeScript, fora desta migration (mesmo commit).
-- `nomesDosAtendentes()` continua existindo, agora só como fallback para o caso
-- raro de `assigned_to_user_id` preenchido sem `assigned_to_user_name` (linha
-- atribuída antes desta migration, se o backfill abaixo não alcançar por algum
-- motivo — ex. clone que aplica esta migration fora de ordem).
--
-- Aditiva e idempotente: coluna nullable com `add column if not exists`,
-- `create or replace function` de assinatura idêntica, backfill guardado por
-- `where assigned_to_user_name is null` (nunca sobrescreve nome já preenchido
-- numa reaplicação).

alter table public.conversations
  add column if not exists assigned_to_user_name text;

comment on column public.conversations.assigned_to_user_name is
  'Cópia do nome de quem atende (auth.users.raw_user_meta_data->>''full_name''), escrita por fn_conversation_assign no mesmo UPDATE que grava assigned_to_user_id, e zerada junto quando a atribuição é removida. Existe para evitar 1 chamada HTTP ao GoTrue Admin API por atendente único na listagem do Inbox — ver lib/users/nome-do-atendente.ts. NULL quando a conversa não está atribuída, ou quando o atendente não tem full_name em user_metadata.';

-- Backfill: só linhas já atribuídas, e só quando o nome ainda não está
-- presente — não sobrescreve dado que uma reaplicação já preencheu.
update public.conversations c
   set assigned_to_user_name = u.raw_user_meta_data ->> 'full_name'
  from auth.users u
 where c.assigned_to_user_id = u.id
   and c.assigned_to_user_name is null;

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
         -- Desnormalizado JUNTO com o dono, na mesma transação: nunca existe uma
         -- janela em que id e nome discordam. NULL junto com o id quando a
         -- atribuição é removida (release) — nunca sobra um nome órfão de dono
         -- nenhum. Lido de auth.users porque quem chama esta função (RPC) não
         -- necessariamente tem acesso ao Admin API — a definer resolve por dentro.
         assigned_to_user_name = case
           when p_to_user_id is null then null
           else (select raw_user_meta_data ->> 'full_name' from auth.users where id = p_to_user_id)
         end,
         assigned_at = case when p_to_user_id is null then null else now() end,
         assignee_kind = case when p_to_user_id is null then null else 'user' end,
         status = case when p_to_user_id is null then 'open' else 'claimed' end,
         status_changed_at = now(),
         unread_count_for_assignee = 0,
         -- A trava só é solta por quem a pôs. `last_handoff_at` é o discriminador
         -- que já existe: uma ESCALAÇÃO o carimba, um humano ASSUMINDO não.
         bot_silenced_until = case
           when p_reason = 'routing'  then bot_silenced_until
           when p_to_user_id is null  then (case when last_handoff_at is null
                                                 then null
                                                 else bot_silenced_until end)
           else 'infinity'::timestamptz
         end,
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

-- As DUAS origens de EXECUTE (doutrina, item 9), reafirmadas: `revoke from
-- public` não remove o grant direto que `anon` carrega via ALTER DEFAULT
-- PRIVILEGES, e `revoke from anon` não remove o grant a PUBLIC dado na criação.
revoke all     on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean) from public;
revoke execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean) from anon;
grant  execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean)
  to authenticated, service_role;
