-- Organization-scoped drafts, research and references. External actions stay server-side.
create table if not exists public.instagram_studio_items (
 id uuid primary key,
 organization_id uuid not null references public.organizations(id) on delete cascade,
 kind text not null check (kind in ('post','research','reference')),
 status text not null check (status in ('generating','ready','failed')),
 input jsonb not null,
 caption text not null default '',
 answer text not null default '',
 sources jsonb not null default '[]'::jsonb,
 asset_path text,
 error text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists instagram_studio_items_org_created on public.instagram_studio_items(organization_id,created_at desc);
alter table public.instagram_studio_items enable row level security;
drop policy if exists tenant_isolation_instagram_studio_items_all on public.instagram_studio_items;
create policy tenant_isolation_instagram_studio_items_all on public.instagram_studio_items for select to authenticated using (organization_id in (select public.fn_user_org_ids()));
revoke all on public.instagram_studio_items from public,anon,authenticated;
grant select on public.instagram_studio_items to authenticated;
grant select,insert,update,delete on public.instagram_studio_items to service_role;
