-- A simulação de papel numa conexão SQL privilegiada também deve falhar fechada.
create or replace function public.fn_historical_import_allowed(p_org uuid) returns boolean
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_batch text:=current_setting('crm.historical_import_batch',true);
begin
 if current_setting('role',true) is distinct from 'none'
  and p_org not in(select public.fn_user_org_ids()) then return false; end if;
 if current_setting('role',true) is distinct from 'none'
  or not exists(select 1 from pg_catalog.pg_roles where rolname=session_user and rolsuper)
  or v_batch is null or v_batch !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
 return exists(select 1 from public.data_import_batches where id=v_batch::uuid and organization_id=p_org and status='loading');
end; $$;
revoke execute on function public.fn_historical_import_allowed(uuid) from public,anon;
grant execute on function public.fn_historical_import_allowed(uuid) to authenticated,service_role;

create unique index if not exists contacts_import_org_id_unique on public.contacts(organization_id,id);
create unique index if not exists conversations_import_org_id_unique on public.conversations(organization_id,id);
create unique index if not exists data_import_records_org_id_unique on public.data_import_records(organization_id,id);
alter table public.data_import_records drop constraint if exists data_import_records_contact_tenant_fk;
alter table public.data_import_records add constraint data_import_records_contact_tenant_fk
 foreign key(organization_id,contact_id) references public.contacts(organization_id,id);
alter table public.data_import_records drop constraint if exists data_import_records_conversation_tenant_fk;
alter table public.data_import_records add constraint data_import_records_conversation_tenant_fk
 foreign key(organization_id,conversation_id) references public.conversations(organization_id,id);

-- Um evento pode conter mais de um contato. Arestas explícitas para consulta e LGPD.
create table if not exists public.data_import_record_contacts (
 organization_id uuid not null references public.organizations(id),
 record_id uuid not null,
 contact_id uuid not null,
 primary key(organization_id,record_id,contact_id),
 foreign key(organization_id,record_id) references public.data_import_records(organization_id,id) on delete cascade,
 foreign key(organization_id,contact_id) references public.contacts(organization_id,id)
);
create index if not exists data_import_record_contacts_lookup on public.data_import_record_contacts(organization_id,contact_id);
alter table public.data_import_record_contacts enable row level security;
drop policy if exists tenant_isolation_data_import_record_contacts_all on public.data_import_record_contacts;
create policy tenant_isolation_data_import_record_contacts_all on public.data_import_record_contacts
 for select to authenticated using(organization_id in(select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id,'manager'));
revoke all on public.data_import_record_contacts from public,anon,authenticated,service_role;
grant select on public.data_import_record_contacts to authenticated,service_role;

create or replace function public.fn_redact_imported_history() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into public.storage_redaction_queue(organization_id,bucket,object_path)
 select new.organization_id,'whatsapp-media',a.storage_path
 from public.message_attachments a join public.messages m on m.id=a.message_id and m.organization_id=a.organization_id
 where a.organization_id=new.organization_id and m.contact_id=new.id and a.storage_path is not null
 on conflict(bucket,object_path) do nothing;
 delete from public.message_attachments a using public.messages m
 where a.organization_id=new.organization_id and m.organization_id=new.organization_id
 and a.message_id=m.id and m.contact_id=new.id;
 update public.data_import_records r set source_data='{"redacted":true}'::jsonb
 where r.organization_id=new.organization_id and (r.contact_id=new.id or exists(
  select 1 from public.data_import_record_contacts c where c.organization_id=new.organization_id and c.record_id=r.id and c.contact_id=new.id
 ));
 return new;
end; $$;
revoke execute on function public.fn_redact_imported_history() from public,anon,authenticated;
grant execute on function public.fn_redact_imported_history() to service_role;
