-- Endereços que a equipe SALVA para marcar de novo.
--
-- O local do compromisso já existia (`location_details` no tipo e na linha).
-- O que faltava era uma lista da ORGANIZAÇÃO: "Sala 2" e "Unidade Centro"
-- digitados toda vez, ou perdidos se o tipo mudava o default. Esta tabela é
-- essa lista. Não é o endereço de um contato — é o lugar onde a clínica
-- atende, reutilizável no próximo horário.
--
-- Unique por (organização, endereço normalizado): "Sala 2" e "sala 2" são o
-- mesmo lugar. CHECK impede vazio. Escrita é de quem marca (`agent+`), leitura
-- de qualquer membro — o dropdown é da tela de marcar, e quem só lê a agenda
-- não grava.
--
-- Idempotente: create if not exists + drop policy if exists.

create table if not exists public.calendar_locations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  address text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint calendar_locations_endereco_tamanho
    check (char_length(btrim(address)) between 1 and 300)
);

create unique index if not exists calendar_locations_org_endereco_key
  on public.calendar_locations (organization_id, lower(btrim(address)));

comment on table public.calendar_locations is
  'Endereços da ORGANIZAÇÃO reutilizáveis ao marcar. Não é o endereço de um contato: é o lugar onde se atende (sala, unidade). Unique por org + endereço normalizado.';
comment on column public.calendar_locations.address is
  'Texto livre, 1–300 caracteres depois do trim. O mesmo teto de calendar_appointments.location_details.';

alter table public.calendar_locations enable row level security;

drop policy if exists calendar_locations_select on public.calendar_locations;
create policy calendar_locations_select on public.calendar_locations
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists calendar_locations_insert on public.calendar_locations;
create policy calendar_locations_insert on public.calendar_locations
  for insert with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

-- Default ACL do Supabase concede tabela nova a anon. Sem o revoke, a REST
-- com a anon key (que vai para o browser) enxergaria a lista da org.
revoke all on public.calendar_locations from anon;
