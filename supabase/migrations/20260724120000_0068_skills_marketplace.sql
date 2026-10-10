-- 0068: Skills instaláveis + marketplace (Fase 2 do épico harness — spec 2026-07-23).
-- Manifest de arquivos na versão de skill + telemetria de ativação + bucket de
-- assets + leitura do catálogo de plataforma por clientes user-scoped.

alter table skill_versions add column if not exists manifest jsonb not null default '[]'::jsonb;
alter table skill_versions add column if not exists forked_from_version_id uuid references skill_versions(id) on delete set null;

create table if not exists skill_activations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  skill_name text not null,
  skill_version_id uuid references skill_versions(id) on delete set null,
  trigger text not null check (trigger in ('hard', 'probe')),
  job_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists idx_skill_activations_org_created
  on skill_activations (organization_id, created_at);
create index if not exists idx_skill_activations_skill
  on skill_activations (organization_id, skill_name, created_at);

-- RLS das tabelas org-scoped novas (skill_activations). skill_versions/pointers já
-- estão no loop tenant_isolation do baseline; a leitura de catálogo é policy extra abaixo.
do $$
declare t text;
begin
  foreach t in array array['skill_activations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists tenant_isolation_%s_all on public.%I', t, t);
    execute format(
      'create policy tenant_isolation_%s_all on public.%I for all
         using (organization_id in (select * from public.fn_user_org_ids()))
         with check (organization_id in (select * from public.fn_user_org_ids()))',
      t, t
    );
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- Catálogo do marketplace: qualquer usuário autenticado LÊ as skills de plataforma
-- (organization_id null). Só SELECT; escrita de plataforma continua service-role.
drop policy if exists catalog_read_skill_versions on skill_versions;
create policy catalog_read_skill_versions on skill_versions for select
  to authenticated using (organization_id is null);
drop policy if exists catalog_read_skill_pointers on skill_pointers;
create policy catalog_read_skill_pointers on skill_pointers for select
  to authenticated using (organization_id is null);
