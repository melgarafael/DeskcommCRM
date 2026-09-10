-- 0235 — grade semanal de referência; ocorrências e exceções ficam para a próxima etapa.
-- FKs compostas impedem vínculos entre empresas, inclusive com service_role.
create table if not exists public.academia_weekly_classes (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 modality_id uuid not null,
 audience_id uuid not null,
 teacher_id uuid not null,
 space_id uuid not null,
 weekday integer not null check(weekday between 1 and 7),
 start_time time not null check(start_time < time '24:00' and extract(second from start_time)=0),
 duration_minutes integer not null check(duration_minutes between 1 and 1440),
 notes text not null default '' check(length(notes)<=2000),
 active boolean not null default true,
 revision integer not null default 1,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 foreign key(organization_id,modality_id) references public.academia_modalities(organization_id,id),
 foreign key(organization_id,audience_id) references public.academia_audiences(organization_id,id),
 foreign key(organization_id,teacher_id) references public.academia_teachers(organization_id,id),
 foreign key(organization_id,space_id) references public.academia_spaces(organization_id,id)
);
-- Sem exclusão por horário: aulas simultâneas são permitidas no roadmap.
create index if not exists academia_weekly_classes_org_day on public.academia_weekly_classes(organization_id,weekday,start_time);
alter table public.academia_weekly_classes enable row level security;
revoke all on public.academia_weekly_classes from public,anon,authenticated;
grant select on public.academia_weekly_classes to authenticated;
grant insert(id,organization_id,modality_id,audience_id,teacher_id,space_id,weekday,start_time,duration_minutes,notes,active) on public.academia_weekly_classes to authenticated;
grant update(modality_id,audience_id,teacher_id,space_id,weekday,start_time,duration_minutes,notes,active) on public.academia_weekly_classes to authenticated;
grant all on public.academia_weekly_classes to service_role;
drop policy if exists tenant_isolation_academia_weekly_classes_all on public.academia_weekly_classes;
create policy tenant_isolation_academia_weekly_classes_all on public.academia_weekly_classes for select to authenticated
 using(organization_id in (select public.fn_user_org_ids()) and exists(
 select 1 from public.organizations o where o.id=organization_id and o.settings->'modules'->'academia'='true'::jsonb));
drop policy if exists academia_weekly_classes_insert on public.academia_weekly_classes;
create policy academia_weekly_classes_insert on public.academia_weekly_classes for insert to authenticated
 with check(organization_id in (select public.fn_user_org_ids()) and public.fn_academia_catalog_write_allowed(organization_id));
drop policy if exists academia_weekly_classes_update on public.academia_weekly_classes;
create policy academia_weekly_classes_update on public.academia_weekly_classes for update to authenticated
 using(organization_id in (select public.fn_user_org_ids()) and public.fn_academia_catalog_write_allowed(organization_id))
 with check(organization_id in (select public.fn_user_org_ids()) and public.fn_academia_catalog_write_allowed(organization_id));
drop trigger if exists academia_revision on public.academia_weekly_classes;
create trigger academia_revision before update on public.academia_weekly_classes for each row execute function public.fn_academia_catalog_revision();

create or replace function public.fn_academia_schedule_links() returns trigger
language plpgsql set search_path=public as $$
declare
 linked record;
 previous_id uuid;
 enabled boolean;
begin
 if auth.uid() is not null and not public.fn_academia_catalog_write_allowed(new.organization_id) then
   raise exception 'Sem permissão para editar a grade' using errcode='42501';
 end if;
 for linked in select * from (values
   ('academia_modalities','modality_id',new.modality_id),
   ('academia_audiences','audience_id',new.audience_id),
   ('academia_teachers','teacher_id',new.teacher_id),
   ('academia_spaces','space_id',new.space_id)
 ) as links(table_name,column_name,record_id) loop
   previous_id := null;
   if tg_op='UPDATE' then previous_id := (to_jsonb(old)->>linked.column_name)::uuid; end if;
   -- Preserva vínculos históricos; só vínculos novos e reativação exigem cadastros ativos.
   if tg_op='INSERT' or previous_id is distinct from linked.record_id or (new.active and not old.active) then
     execute format('select active from public.%I where organization_id=$1 and id=$2 for share',linked.table_name)
       into enabled using new.organization_id,linked.record_id;
     if enabled is distinct from true then
       raise exception 'Selecione cadastros ativos desta empresa' using errcode='23514';
     end if;
   end if;
 end loop;
 return new;
end; $$;
revoke all on function public.fn_academia_schedule_links() from public,anon,authenticated;
drop trigger if exists academia_schedule_links on public.academia_weekly_classes;
create trigger academia_schedule_links before insert or update on public.academia_weekly_classes for each row execute function public.fn_academia_schedule_links();
notify pgrst,'reload schema';
