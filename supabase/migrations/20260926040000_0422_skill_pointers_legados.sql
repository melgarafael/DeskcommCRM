-- Reconcilia o formato antigo de skill_pointers com o contrato atual.
-- Instalações antigas usavam slug/active_version_id. A tela atual lê
-- name/version_id e uma versão nula fazia a consulta inteira falhar.

alter table public.skill_pointers
  add column if not exists name text;

alter table public.skill_pointers
  add column if not exists version_id uuid;

do $reconciliar_skill_pointers$
begin
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'skill_pointers'
       and column_name = 'slug'
  ) then
    execute $sql$
      update public.skill_pointers
         set name = slug
       where name is null
         and slug is not null
    $sql$;
  end if;

  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'skill_pointers'
       and column_name = 'active_version_id'
  ) then
    execute $sql$
      update public.skill_pointers
         set version_id = active_version_id
       where version_id is null
         and active_version_id is not null
    $sql$;
  end if;
end
$reconciliar_skill_pointers$;

do $skill_pointer_fk$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.skill_pointers'::regclass
       and conname = 'skill_pointers_version_id_fkey'
  ) then
    alter table public.skill_pointers
      add constraint skill_pointers_version_id_fkey
      foreign key (version_id)
      references public.skill_versions(id)
      not valid;
  end if;
end
$skill_pointer_fk$;

create unique index if not exists uniq_skill_pointers_org
  on public.skill_pointers (organization_id, name)
  where organization_id is not null;

create unique index if not exists uniq_skill_pointers_platform
  on public.skill_pointers (name)
  where organization_id is null;

