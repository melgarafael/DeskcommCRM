-- Compatibilidade para instalações que ainda guardam skill_versions.pointer_id.
--
-- Nesse formato anterior, apagar o ponteiro apagava em cascata todas as
-- versões imutáveis. O contrato atual conserva as versões para auditoria e
-- rollback, portanto o vínculo legado precisa apenas ser limpo.
-- O gatilho genérico de imutabilidade permite exclusivamente o SET NULL
-- provocado por esta FK, sem liberar alteração de conteúdo ou metadados.
create or replace function public.fn_agent_versions_immutable() returns trigger
language plpgsql as $fn$
begin
  if tg_table_name = 'skill_versions'
     and (to_jsonb(old) ->> 'pointer_id') is not null
     and (to_jsonb(new) ->> 'pointer_id') is null
     and (to_jsonb(old) - 'pointer_id') is not distinct from (to_jsonb(new) - 'pointer_id') then
    return new;
  end if;

  raise exception '% é imutável: mudança = versão nova; rollback = mover o ponteiro (%)',
    tg_table_name, replace(tg_table_name, '_versions', '_pointers');
end;
$fn$;

-- É função exclusiva de trigger. Revogar EXECUTE não impede o gatilho já
-- criado de rodar e evita expor uma RPC sem função de negócio.
revoke execute on function public.fn_agent_versions_immutable()
  from public, anon, authenticated, service_role;

do $skill_versions_legadas$
begin
  if to_regclass('public.skill_versions') is null
     or not exists (
       select 1
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'skill_versions'
          and column_name = 'pointer_id'
     ) then
    return;
  end if;

  alter table public.skill_versions
    alter column pointer_id drop not null;

  alter table public.skill_versions
    drop constraint if exists skill_versions_pointer_id_fkey;

  alter table public.skill_versions
    add constraint skill_versions_pointer_id_fkey
    foreign key (pointer_id)
    references public.skill_pointers(id)
    on delete set null;
end
$skill_versions_legadas$;
