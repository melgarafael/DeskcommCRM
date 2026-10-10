-- 0067: Memória Geral da Org (Fase 1 do épico harness — spec 2026-07-23).
-- Doc-mãe versionado (padrão versões-imutáveis+ponteiro do playbook 0004/0050)
-- + entradas de aprendizado individuais (manual | flywheel com aprovação humana).

create table if not exists org_memory_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  version_number int not null,
  content text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, version_number)
);

drop trigger if exists trg_org_memory_versions_immutable on org_memory_versions;
create trigger trg_org_memory_versions_immutable
  before update on org_memory_versions
  for each row execute function fn_agent_versions_immutable();

create table if not exists org_memory_pointers (
  organization_id uuid not null unique references organizations(id) on delete cascade,
  version_id uuid not null references org_memory_versions(id),
  updated_at timestamptz not null default now()
);

create table if not exists org_memory_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  title text not null check (length(title) > 0),
  body text not null check (length(body) > 0),
  source text not null check (source in ('manual', 'flywheel')),
  status text not null default 'active' check (status in ('proposed', 'active', 'archived')),
  proposal_id uuid references flywheel_distiller_proposals(id) on delete set null,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_org_memory_entries_org_status
  on org_memory_entries (organization_id, status, created_at);

-- Flywheel: novo destino de proposta (entry de memória da org).
alter table flywheel_distiller_proposals drop constraint if exists flywheel_distiller_proposals_type_check;
alter table flywheel_distiller_proposals add constraint flywheel_distiller_proposals_type_check
  check (type in ('playbook_bullet', 'golden_case', 'reentry_trigger', 'org_memory_entry'));

-- RLS (mesmo shape do loop tenant_isolation_* do baseline).
do $$
declare t text;
begin
  foreach t in array array['org_memory_versions', 'org_memory_pointers', 'org_memory_entries'] loop
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
