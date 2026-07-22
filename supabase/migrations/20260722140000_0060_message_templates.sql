-- 0060: templates de script do vendedor (Onda 5). owner_user_id preenchido =
-- pessoal do vendedor; null = compartilhado da org. RLS: todo membro LÊ
-- (compartilhados + próprios); escreve o próprio (agent+) ou compartilhado (manager+).
create table if not exists message_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  owner_user_id uuid references auth.users(id) on delete cascade,
  title text not null,
  body text not null,
  shortcut text,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_message_templates_org on message_templates (organization_id);

alter table message_templates enable row level security;

-- Helpers canônicos do repo (confirmados no baseline): fn_user_org_ids() SETOF uuid,
-- fn_role_at_least(org uuid, min text) boolean, fn_is_platform_admin() boolean.
drop policy if exists "message_templates_select" on message_templates;
create policy "message_templates_select" on message_templates
  for select using (
    (
      organization_id in (select fn_user_org_ids())
      and (owner_user_id is null or owner_user_id = auth.uid())
    )
    or fn_is_platform_admin()
  );

drop policy if exists "message_templates_write" on message_templates;
create policy "message_templates_write" on message_templates
  for all using (
    organization_id in (select fn_user_org_ids())
    and (
      (owner_user_id = auth.uid() and fn_role_at_least(organization_id, 'agent'))
      or (owner_user_id is null and fn_role_at_least(organization_id, 'manager'))
    )
  )
  with check (
    organization_id in (select fn_user_org_ids())
    and (
      (owner_user_id = auth.uid() and fn_role_at_least(organization_id, 'agent'))
      or (owner_user_id is null and fn_role_at_least(organization_id, 'manager'))
    )
  );
