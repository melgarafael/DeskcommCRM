-- 0566: mensagens agendadas no inbox. O cron scheduled-messages dispara o
-- envio via sendMessageHandler quando send_at vence. Sem JobKind do agent-worker.

create table if not exists public.scheduled_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  created_by_user_id uuid references auth.users(id) on delete set null,
  send_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'sent', 'cancelled', 'failed')),
  body text,
  type text not null default 'text',
  media_url text,
  media_storage_path text,
  media_mime text,
  media_size_bytes integer,
  metadata jsonb,
  reply_to_message_id uuid,
  sent_message_id uuid,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scheduled_messages_payload check (
    body is not null
    or media_url is not null
    or media_storage_path is not null
    or (metadata is not null and (
      metadata ? 'shared_contact_id'
      or metadata ? 'shared_contact'
    ))
  )
);

create index if not exists idx_scheduled_messages_due
  on public.scheduled_messages (status, send_at)
  where status = 'pending';

create index if not exists idx_scheduled_messages_conversation
  on public.scheduled_messages (conversation_id, status);

comment on table public.scheduled_messages is
  'Fila de envio agendado do composer; o cron scheduled-messages consome pending vencidos.';

alter table public.scheduled_messages enable row level security;

drop policy if exists "scheduled_messages_select" on public.scheduled_messages;
create policy "scheduled_messages_select" on public.scheduled_messages
  for select using (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

drop policy if exists "scheduled_messages_insert" on public.scheduled_messages;
create policy "scheduled_messages_insert" on public.scheduled_messages
  for insert with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
  );

drop policy if exists "scheduled_messages_update" on public.scheduled_messages;
create policy "scheduled_messages_update" on public.scheduled_messages
  for update using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
  );

drop policy if exists "scheduled_messages_delete" on public.scheduled_messages;
create policy "scheduled_messages_delete" on public.scheduled_messages
  for delete using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
  );
