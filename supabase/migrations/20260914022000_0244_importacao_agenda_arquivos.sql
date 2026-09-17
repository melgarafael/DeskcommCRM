-- A origem do vínculo continua explícita nas telas operacionais e no arquivo.
alter table public.crm_tasks add column if not exists conversation_id uuid;
alter table public.crm_tasks drop constraint if exists crm_tasks_conversation_tenant_fk;
alter table public.crm_tasks add constraint crm_tasks_conversation_tenant_fk
 foreign key(organization_id,conversation_id) references public.conversations(organization_id,id);
alter table public.calendar_appointments drop constraint if exists calendar_appointments_source_check;
alter table public.calendar_appointments add constraint calendar_appointments_source_check
 check(source in('ui','mcp','google_sync','public_page','import'));

alter table public.data_import_records
 add column if not exists storage_path text,
 add column if not exists file_name text,
 add column if not exists file_availability text;
alter table public.data_import_records drop constraint if exists data_import_records_file_check;
alter table public.data_import_records add constraint data_import_records_file_check check(
 (file_availability is null and storage_path is null) or
 (file_availability='available' and storage_path is not null and storage_path like organization_id::text||'/%') or
 (file_availability='unavailable' and storage_path is null)
);

create or replace function public.fn_redact_imported_history() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into public.storage_redaction_queue(organization_id,bucket,object_path)
 select new.organization_id,'whatsapp-media',a.storage_path
 from public.message_attachments a join public.messages m on m.id=a.message_id and m.organization_id=a.organization_id
 where a.organization_id=new.organization_id and m.contact_id=new.id and a.storage_path is not null
 on conflict(bucket,object_path) do nothing;
 delete from public.message_attachments a using public.messages m
 where a.organization_id=new.organization_id and m.organization_id=new.organization_id and a.message_id=m.id and m.contact_id=new.id;
 insert into public.storage_redaction_queue(organization_id,bucket,object_path)
 select new.organization_id,'whatsapp-media',r.storage_path from public.data_import_records r
 where r.organization_id=new.organization_id and r.storage_path is not null and (r.contact_id=new.id or exists(
  select 1 from public.data_import_record_contacts c where c.organization_id=new.organization_id and c.record_id=r.id and c.contact_id=new.id
 )) on conflict(bucket,object_path) do nothing;
 update public.data_import_records r set source_data='{"redacted":true}'::jsonb,storage_path=null,file_name=null,file_availability=null
 where r.organization_id=new.organization_id and (r.contact_id=new.id or exists(
  select 1 from public.data_import_record_contacts c where c.organization_id=new.organization_id and c.record_id=r.id and c.contact_id=new.id
 ));
 return new;
end; $$;
revoke execute on function public.fn_redact_imported_history() from public,anon,authenticated;
grant execute on function public.fn_redact_imported_history() to service_role;
