-- manifest: Guarda autorizações de relatórios do Google Ads por organização e conta anunciante para consultar várias contas sem mudar o destino das conversões.

create table if not exists public.google_ads_reporting_accounts (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  customer_id text not null check (customer_id ~ '^[0-9]{10}$'),
  login_customer_id text check (login_customer_id ~ '^[0-9]{10}$'),
  label text not null check (char_length(btrim(label)) between 1 and 80),
  refresh_token_encrypted bytea not null,
  primary key (organization_id, customer_id)
);

-- O servidor verifica a organização e só entrega os metadados da conta à UI.
alter table public.google_ads_reporting_accounts enable row level security;
revoke all privileges on table public.google_ads_reporting_accounts from public, anon, authenticated;
grant select, insert, update, delete on table public.google_ads_reporting_accounts to service_role;

-- O retorno do Google não traz o cookie SameSite=Strict do CRM. Revalida no
-- banco a sessão e o poder de quem iniciou antes de substituir sua credencial.
create or replace function public.fn_google_ads_admin_do_relatorio(
  p_org uuid, p_actor uuid, p_session uuid, p_suporte uuid
) returns boolean language sql stable security definer set search_path = '' as $$
  select public.fn_org_operante(p_org)
    and exists (select 1 from auth.sessions s where s.id = p_session and s.user_id = p_actor
      and (s.not_after is null or s.not_after > now()))
    and case when p_suporte is not null then
      public.fn_support_callback_write_allowed(p_org, p_actor, p_session)
      and (exists (select 1 from public.platform_support_sessions s where s.id = p_suporte
             and s.organization_id = p_org and s.actor_user_id = p_actor and s.auth_session_id = p_session
             and s.ended_at is null and s.access_mode = 'full' and s.expires_at > now())
        or exists (select 1 from public.agencia_sessoes s where s.id = p_suporte
             and s.organization_id = p_org and s.actor_user_id = p_actor and s.auth_session_id = p_session
             and s.ended_at is null and s.expires_at > now()))
    else
      exists (select 1 from public.user_organizations u where u.organization_id = p_org
        and u.user_id = p_actor and u.role = 'admin' and u.accepted_at is not null and u.revoked_at is null)
      or exists (select 1 from public.platform_admins a where a.user_id = p_actor
        and a.revoked_at is null and a.scope = 'full')
    end;
$$;
revoke all on function public.fn_google_ads_admin_do_relatorio(uuid,uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.fn_google_ads_admin_do_relatorio(uuid,uuid,uuid,uuid) to service_role;

notify pgrst, 'reload schema';
