-- manifest: Permite agendar uma mensagem de texto no Inbox com horário, autor, estado e cancelamento; o cron faz o envio pela porta normal de mensagens e mantém a tentativa para auditoria.
create table if not exists public.scheduled_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  created_by_user_id uuid references auth.users(id) on delete set null,
  body text not null check (length(btrim(body)) between 1 and 4000),
  scheduled_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'dispatched', 'failed', 'cancelled')),
  message_id uuid references public.messages(id) on delete set null,
  error_code text,
  claimed_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists scheduled_messages_due_idx
  on public.scheduled_messages (scheduled_at, id) where status = 'pending';
create index if not exists scheduled_messages_conversation_idx
  on public.scheduled_messages (organization_id, conversation_id, created_at desc);

alter table public.scheduled_messages enable row level security;
drop policy if exists scheduled_messages_visible on public.scheduled_messages;
create policy scheduled_messages_visible on public.scheduled_messages for select
  using (
    organization_id in (select public.fn_user_org_ids())
    and exists (
      select 1 from public.conversations c
      where c.id = scheduled_messages.conversation_id
        and c.organization_id = scheduled_messages.organization_id
        and public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id)
    )
  );
revoke all on public.scheduled_messages from public, anon, authenticated;
grant select on public.scheduled_messages to authenticated;
grant all on public.scheduled_messages to service_role;
