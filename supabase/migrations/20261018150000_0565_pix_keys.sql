-- 0565: chaves Pix por organização (envio no inbox + cobrança estática EMV).
-- Mesmo modelo de acesso de message_templates: owner_user_id null = todos da org;
-- preenchido = somente o dono. agent+ no pessoal; manager+ no compartilhado.

create table if not exists public.pix_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  owner_user_id uuid references auth.users(id) on delete cascade,
  name text not null,
  key_type text not null
    check (key_type in ('cpf', 'cnpj', 'email', 'random', 'phone')),
  key_value text not null,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pix_keys_name_len check (char_length(name) between 1 and 80),
  constraint pix_keys_value_len check (char_length(key_value) between 1 and 200)
);

create index if not exists idx_pix_keys_org on public.pix_keys (organization_id);

comment on table public.pix_keys is
  'Chaves Pix cadastradas para envio no composer (chave pura ou cobrança EMV estática).';

alter table public.pix_keys enable row level security;

drop policy if exists "pix_keys_select" on public.pix_keys;
create policy "pix_keys_select" on public.pix_keys
  for select using (
    (
      organization_id in (select public.fn_user_org_ids())
      and (owner_user_id is null or owner_user_id = auth.uid())
    )
    or public.fn_is_platform_admin()
  );

drop policy if exists "pix_keys_write" on public.pix_keys;
create policy "pix_keys_write" on public.pix_keys
  for all using (
    organization_id in (select public.fn_user_org_ids())
    and (
      (owner_user_id = auth.uid() and public.fn_role_at_least(organization_id, 'agent'))
      or (owner_user_id is null and public.fn_role_at_least(organization_id, 'manager'))
    )
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    and (
      (owner_user_id = auth.uid() and public.fn_role_at_least(organization_id, 'agent'))
      or (owner_user_id is null and public.fn_role_at_least(organization_id, 'manager'))
    )
  );
