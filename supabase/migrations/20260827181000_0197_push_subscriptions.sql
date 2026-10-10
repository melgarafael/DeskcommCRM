-- 0168 — inscrição Web Push (bandeja do SO com a aba fechada).
--
-- Endpoint + chaves p256dh/auth por navegador. Sem isto o servidor não tem
-- para quem mandar o protocolo Web Push. RLS: a linha é do PRÓPRIO usuário
-- na org; o envio usa service role.

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_subscriptions_org_idx
  on public.push_subscriptions (organization_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists push_subscriptions_own on public.push_subscriptions;
create policy push_subscriptions_own on public.push_subscriptions
  for all
  using (
    organization_id in (select public.fn_user_org_ids())
    and user_id = auth.uid()
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    and user_id = auth.uid()
  );

revoke all on public.push_subscriptions from anon, public;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

comment on table public.push_subscriptions is
  'Inscrição Web Push por navegador. Envio é service role; a sessão só vê a própria linha.';
