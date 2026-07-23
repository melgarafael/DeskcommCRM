-- 0063: notas internas de conversa (Onda 5.2). Visíveis só ao time, nunca vão
-- ao cliente. Tabela separada de messages (não são trocas com o cliente).
create table if not exists conversation_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  body text not null,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists idx_conversation_notes_conversation
  on conversation_notes (conversation_id, created_at);

alter table conversation_notes enable row level security;

drop policy if exists "conversation_notes_select" on conversation_notes;
create policy "conversation_notes_select" on conversation_notes
  for select using (
    organization_id in (select fn_user_org_ids()) or fn_is_platform_admin()
  );

drop policy if exists "conversation_notes_write" on conversation_notes;
create policy "conversation_notes_write" on conversation_notes
  for all using (
    organization_id in (select fn_user_org_ids()) and fn_role_at_least(organization_id, 'agent')
  )
  with check (
    organization_id in (select fn_user_org_ids()) and fn_role_at_least(organization_id, 'agent')
  );
