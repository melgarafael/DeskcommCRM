-- ============================================================================
-- 0229 — TAREFAS E ATIVIDADES (a rotina do vendedor externo)
--
-- Duas tabelas, sem inventar CRM novo:
-- 1. `commercial_tasks`: o que foi AGENDADO (visita, ligação, retorno) com
--    responsável, data e check-in (lugar + hora). Distância até o cliente NÃO
--    é calculada: contatos não têm coordenadas, e distância sem coordenada
--    seria número decorativo.
-- 2. `commercial_activities`: o que foi FEITO (resultado da visita, motivo de
--    cancelamento, observação) — o "Relatório de Atendimentos" do Mercos.
--
-- RLS molde 0204: leitura org, escrita agent+ (vendedor registra o próprio
-- campo); manager+ não é exigido porque travaria a rotina de quem vende.
-- ============================================================================

create table if not exists public.commercial_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  titulo text not null check (char_length(trim(titulo)) > 0),
  descricao text,
  tipo text not null default 'visita' check (tipo in ('visita', 'ligacao', 'retorno', 'outro')),
  status text not null default 'pendente' check (status in ('pendente', 'concluida', 'cancelada')),
  contact_id uuid references public.contacts(id) on delete set null,
  responsavel_user_id uuid,
  agendada_para date,
  checkin_em timestamptz,
  checkin_lat numeric(9, 6),
  checkin_lng numeric(9, 6),
  concluida_em timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists commercial_tasks_org_status_idx
  on public.commercial_tasks (organization_id, status, agendada_para);

create index if not exists commercial_tasks_contact_idx
  on public.commercial_tasks (organization_id, contact_id);

create table if not exists public.commercial_activities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  tipo text not null default 'visita' check (tipo in ('visita', 'ligacao', 'whatsapp', 'email', 'outro')),
  resultado text,
  observacao text,
  user_id uuid,
  ocorrida_em timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists commercial_activities_org_data_idx
  on public.commercial_activities (organization_id, ocorrida_em desc);

create index if not exists commercial_activities_contact_idx
  on public.commercial_activities (organization_id, contact_id);

drop trigger if exists trg_commercial_tasks_updated_at on public.commercial_tasks;
create trigger trg_commercial_tasks_updated_at
  before update on public.commercial_tasks
  for each row execute function public.fn_set_updated_at();

alter table public.commercial_tasks enable row level security;
alter table public.commercial_activities enable row level security;

drop policy if exists commercial_tasks_select on public.commercial_tasks;
create policy commercial_tasks_select on public.commercial_tasks
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists commercial_tasks_write on public.commercial_tasks;
create policy commercial_tasks_write on public.commercial_tasks
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

drop policy if exists commercial_activities_select on public.commercial_activities;
create policy commercial_activities_select on public.commercial_activities
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists commercial_activities_write on public.commercial_activities;
create policy commercial_activities_write on public.commercial_activities
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

revoke all on public.commercial_tasks from anon;
grant select, insert, update, delete on public.commercial_tasks to authenticated;
grant all on public.commercial_tasks to service_role;

revoke all on public.commercial_activities from anon;
grant select, insert, update, delete on public.commercial_activities to authenticated;
grant all on public.commercial_activities to service_role;

comment on table public.commercial_tasks is
  'Tarefas do vendedor externo (visita, ligação, retorno) com check-in de lugar + hora.';

comment on table public.commercial_activities is
  'Atividades realizadas (o que aconteceu no contato) — base do relatório de atendimentos.';
