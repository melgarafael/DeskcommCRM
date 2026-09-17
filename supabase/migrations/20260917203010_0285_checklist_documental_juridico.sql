create table if not exists public.crm_document_checklist_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  advomax_tipo_acao_codigo bigint not null,
  name text not null check (char_length(trim(name)) between 1 and 120),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, advomax_tipo_acao_codigo),
  unique (organization_id, id)
);

create table if not exists public.crm_document_checklist_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  template_id uuid not null,
  label text not null check (char_length(trim(label)) between 1 and 180),
  required boolean not null default true,
  position integer not null default 0 check (position >= 0),
  created_at timestamptz not null default now(),
  unique (template_id, label),
  unique (organization_id, id),
  foreign key (organization_id, template_id)
    references public.crm_document_checklist_templates(organization_id, id) on delete cascade
);

create table if not exists public.crm_document_checklist_completions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null,
  pessoa_codigo bigint not null,
  processo_codigo bigint not null,
  item_id uuid not null,
  completed boolean not null default false,
  completed_by uuid references auth.users(id) on delete set null,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (organization_id, processo_codigo, item_id),
  foreign key (organization_id, contact_id) references public.contacts(organization_id, id) on delete restrict,
  foreign key (organization_id, item_id) references public.crm_document_checklist_items(organization_id, id) on delete restrict
);

create index if not exists idx_crm_checklist_items_template on public.crm_document_checklist_items(template_id, position);
create index if not exists idx_crm_checklist_completions_case on public.crm_document_checklist_completions(organization_id, processo_codigo);

alter table public.crm_document_checklist_templates enable row level security;
alter table public.crm_document_checklist_items enable row level security;
alter table public.crm_document_checklist_completions enable row level security;

drop policy if exists crm_checklist_templates_select on public.crm_document_checklist_templates;
create policy crm_checklist_templates_select on public.crm_document_checklist_templates for select
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());
drop policy if exists crm_checklist_templates_write on public.crm_document_checklist_templates;
create policy crm_checklist_templates_write on public.crm_document_checklist_templates for all
  using (public.fn_role_at_least(organization_id, 'manager') or public.fn_is_platform_admin())
  with check (public.fn_role_at_least(organization_id, 'manager') or public.fn_is_platform_admin());
drop policy if exists crm_checklist_items_select on public.crm_document_checklist_items;
create policy crm_checklist_items_select on public.crm_document_checklist_items for select
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());
drop policy if exists crm_checklist_items_write on public.crm_document_checklist_items;
create policy crm_checklist_items_write on public.crm_document_checklist_items for all
  using (public.fn_role_at_least(organization_id, 'manager') or public.fn_is_platform_admin())
  with check (public.fn_role_at_least(organization_id, 'manager') or public.fn_is_platform_admin());
drop policy if exists crm_checklist_completions_select on public.crm_document_checklist_completions;
create policy crm_checklist_completions_select on public.crm_document_checklist_completions for select
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());
drop policy if exists crm_checklist_completions_write on public.crm_document_checklist_completions;
create policy crm_checklist_completions_write on public.crm_document_checklist_completions for all
  using (public.fn_role_at_least(organization_id, 'agent') or public.fn_is_platform_admin())
  with check (public.fn_role_at_least(organization_id, 'agent') or public.fn_is_platform_admin());

revoke all on public.crm_document_checklist_templates, public.crm_document_checklist_items,
  public.crm_document_checklist_completions from anon;
grant select, insert, update, delete on public.crm_document_checklist_templates,
  public.crm_document_checklist_items, public.crm_document_checklist_completions to authenticated;
grant all on public.crm_document_checklist_templates, public.crm_document_checklist_items,
  public.crm_document_checklist_completions to service_role;

create or replace function public.fn_create_checklist_template(
  p_org uuid, p_tipo_acao bigint, p_name text, p_items jsonb
) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.crm_document_checklist_templates(organization_id, advomax_tipo_acao_codigo, name, created_by)
  values (p_org, p_tipo_acao, p_name, auth.uid()) returning id into v_id;
  insert into public.crm_document_checklist_items(organization_id, template_id, label, required, position)
  select p_org, v_id, item->>'label', coalesce((item->>'required')::boolean, true), ordinality - 1
  from jsonb_array_elements(p_items) with ordinality as rows(item, ordinality);
  return v_id;
end $$;
revoke all on function public.fn_create_checklist_template(uuid,bigint,text,jsonb) from public,anon;
grant execute on function public.fn_create_checklist_template(uuid,bigint,text,jsonb) to authenticated,service_role;

create or replace function public.fn_redact_checklist_completions() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.is_anonymized and not old.is_anonymized then
    delete from public.crm_document_checklist_completions
    where organization_id = new.organization_id and contact_id = new.id;
  end if;
  return new;
end $$;
revoke all on function public.fn_redact_checklist_completions() from public,anon,authenticated;
grant execute on function public.fn_redact_checklist_completions() to service_role;
drop trigger if exists trg_redact_checklist_completions on public.contacts;
create trigger trg_redact_checklist_completions after update of is_anonymized on public.contacts
for each row execute function public.fn_redact_checklist_completions();
