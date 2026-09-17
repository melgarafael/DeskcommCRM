-- Histórico importado é dado, não entrada nova de cliente. O lote só pode ser
-- aberto pelo operador SQL; um JWT/RPC não ganha permissão para silenciar eventos.
create table if not exists public.data_import_batches (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 source text not null,
 source_workspace_id text not null,
 source_cutoff timestamptz not null,
 status text not null default 'loading' check(status in('loading','review','completed','failed')),
 manifest jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(),
 completed_at timestamptz,
 unique(organization_id,id)
);
alter table public.data_import_batches enable row level security;
drop policy if exists tenant_isolation_data_import_batches_all on public.data_import_batches;
create policy tenant_isolation_data_import_batches_all on public.data_import_batches
 for select to authenticated using(organization_id in(select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id,'manager'));
revoke all on public.data_import_batches from public,anon,authenticated,service_role;
grant select on public.data_import_batches to authenticated,service_role;

create table if not exists public.data_import_records (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 batch_id uuid not null,
 source_table text not null,
 source_id text not null,
 source_data jsonb not null,
 target_table text,
 target_id uuid,
 contact_id uuid references public.contacts(id),
 conversation_id uuid references public.conversations(id),
 occurred_at timestamptz,
 unique(organization_id,batch_id,source_table,source_id),
 foreign key(organization_id,batch_id) references public.data_import_batches(organization_id,id)
);
create index if not exists data_import_records_lookup on public.data_import_records(organization_id,batch_id,source_table,source_id);
create index if not exists data_import_records_contact on public.data_import_records(organization_id,contact_id,occurred_at desc);
alter table public.data_import_records enable row level security;
drop policy if exists tenant_isolation_data_import_records_all on public.data_import_records;
create policy tenant_isolation_data_import_records_all on public.data_import_records
 for select to authenticated using(organization_id in(select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id,'manager'));
revoke all on public.data_import_records from public,anon,authenticated,service_role;
grant select on public.data_import_records to authenticated,service_role;

create or replace function public.fn_historical_import_allowed(p_org uuid) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_batch text:=current_setting('crm.historical_import_batch',true);
begin
 if not exists(select 1 from pg_catalog.pg_roles where rolname=session_user and rolsuper)
  or v_batch is null or v_batch !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
 return exists(select 1 from public.data_import_batches where id=v_batch::uuid and organization_id=p_org and status='loading');
end; $$;
revoke execute on function public.fn_historical_import_allowed(uuid) from public,anon;
grant execute on function public.fn_historical_import_allowed(uuid) to authenticated,service_role;

-- Preserva implementações atuais dos triggers e todas as FKs/RLS. O guard fica
-- no corpo, escopado ao lote/org e à conexão SQL privilegiada; nunca desliga triggers.
do $migration$
declare v_name text; v_oid oid; v_definition text; v_new text;
begin
 foreach v_name in array array[
  'fn_emit_message_event','fn_demanda_abre_no_inbound','fn_message_service_lock',
  'fn_reply_inbound_revision','fn_emit_conversation_routing',
  'fn_appointment_stamp','fn_carimbar_ida_ao_google','fn_google_projection_stamp',
  'fn_meet_delivery_enqueue','fn_meet_stamp','fn_stamp_stage_changed_at'
 ] loop
  v_oid:=to_regprocedure('public.'||v_name||'()');
  if v_oid is null then raise exception 'historical_import_trigger_missing: %',v_name; end if;
  v_definition:=pg_get_functiondef(v_oid);
  if position('fn_historical_import_allowed' in v_definition)=0 then
   v_new:=regexp_replace(v_definition,'(^|\n)([ \t]*begin)\M',E'\\1\\2\n if public.fn_historical_import_allowed(new.organization_id) then return new; end if;', 'i');
   if v_new=v_definition then raise exception 'historical_import_guard_missing: %',v_name; end if;
   execute v_new;
  end if;
 end loop;
end; $migration$;

-- Não representa 300 mensagens outbound legadas como enviadas ou como fila nova.
alter table public.messages drop constraint if exists messages_status_check;
alter table public.messages add constraint messages_status_check check(status in('queued','received','sending','sent','delivered','read','failed','unknown'));

-- Canal histórico não é uma conexão de um provedor ativo e nunca recebe segredo.
alter table public.channel_sessions drop constraint if exists channel_sessions_provider_check;
alter table public.channel_sessions add constraint channel_sessions_provider_check check(provider in('waha','meta_cloud','zernio','wacalls','socios_hub','historical'));
alter table public.channel_sessions drop constraint if exists channel_sessions_provider_ref_check;
alter table public.channel_sessions add constraint channel_sessions_provider_ref_check check(
 (provider='waha' and waha_session_name is not null) or
 (provider='meta_cloud' and meta_phone_number_id is not null) or
 (provider='zernio' and zernio_account_id is not null) or
 (provider='wacalls' and wacalls_session_id is not null) or
 (provider='socios_hub' and social_channel_id is not null and social_connection_id is not null and social_network in('instagram','messenger')) or
 (provider='historical' and status='STOPPED')
);

alter table public.conversation_notes add column if not exists visibility_scope text not null default 'workspace_internal';
alter table public.conversation_notes drop constraint if exists conversation_notes_visibility_scope_check;
alter table public.conversation_notes add constraint conversation_notes_visibility_scope_check check(visibility_scope in('workspace_internal','managers_only'));
drop policy if exists conversation_notes_visibility on public.conversation_notes;
create policy conversation_notes_visibility on public.conversation_notes as restrictive for all to authenticated
 using(visibility_scope='workspace_internal' or public.fn_role_at_least(organization_id,'manager'))
 with check(visibility_scope='workspace_internal' or public.fn_role_at_least(organization_id,'manager'));

-- Um anexo adicional não vira uma mensagem fictícia. Aresta explícita e Storage privado.
create unique index if not exists messages_org_id_unique on public.messages(organization_id,id);
create table if not exists public.message_attachments (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 message_id uuid not null,
 position integer not null check(position>=0),
 file_name text,
 mime_type text,
 size_bytes bigint check(size_bytes>=0),
 storage_path text,
 availability text not null check(availability in('available','unavailable')),
 created_at timestamptz not null default now(),
 unique(organization_id,message_id,position),
 foreign key(organization_id,message_id) references public.messages(organization_id,id) on delete cascade,
 check((availability='available' and storage_path is not null) or (availability='unavailable' and storage_path is null))
);
alter table public.message_attachments enable row level security;
drop policy if exists tenant_isolation_message_attachments_all on public.message_attachments;
create policy tenant_isolation_message_attachments_all on public.message_attachments
 for select to authenticated using(organization_id in(select public.fn_user_org_ids()));
revoke all on public.message_attachments from public,anon,authenticated,service_role;
grant select on public.message_attachments to authenticated;
grant select,insert,update,delete on public.message_attachments to service_role;

-- Anonimização é também sobre os anexos importados: referências somem junto do histórico.
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
 update public.data_import_records set source_data='{"redacted":true}'::jsonb
 where organization_id=new.organization_id and contact_id=new.id;
 return new;
end; $$;
revoke execute on function public.fn_redact_imported_history() from public,anon,authenticated;
grant execute on function public.fn_redact_imported_history() to service_role;
drop trigger if exists trg_redact_imported_history on public.contacts;
create trigger trg_redact_imported_history after update of is_anonymized on public.contacts
 for each row when(new.is_anonymized and not old.is_anonymized) execute function public.fn_redact_imported_history();
