-- FIXTURE EXPERIMENTAL. Nunca aplicar ao CRM ou publicar como migration.
-- O runner exige cluster dedicado, trava sua frente e recria só bench_state.
create schema bench_state;
create table bench_state.identities (role_name name primary key, organization_id uuid not null);
insert into bench_state.identities values
  ('bench_state_tenant_a', '00000000-0000-4000-8000-00000000000a'),
  ('bench_state_tenant_b', '00000000-0000-4000-8000-00000000000b');
create table bench_state.installation (id int primary key check (id=1), schema_version int not null);
insert into bench_state.installation values (1,1);
create table bench_state.activation (
  organization_id uuid primary key, active boolean not null, can_write boolean not null, revision int not null default 1
);
insert into bench_state.activation (organization_id,active,can_write)
select organization_id,true,true from bench_state.identities;
create table bench_state.subjects (
  organization_id uuid not null, id text not null, display_name text,
  privacy_revision int not null default 1, erased boolean not null default false,
  primary key (organization_id,id)
);
create table bench_state.records (
  organization_id uuid not null, id text not null, subject_id text not null,
  amount_cents bigint not null check (amount_cents>=0), legacy_note text,
  primary key (organization_id,id),
  foreign key (organization_id,subject_id) references bench_state.subjects
);
create table bench_state.jobs (
  organization_id uuid not null, id text not null, subject_id text not null,
  contract_version int not null, privacy_revision int not null,
  payload jsonb not null, status text not null check (status in ('pending','done','cancelled','suspended')),
  next_step text not null, primary key (organization_id,id),
  foreign key (organization_id,subject_id) references bench_state.subjects
);
create table bench_state.copies (
  organization_id uuid not null, id text not null, subject_id text not null,
  kind text not null check (kind in ('outbox','receipt','invocation','result')),
  payload jsonb not null, primary key (organization_id,id),
  foreign key (organization_id,subject_id) references bench_state.subjects
);
create table bench_state.effects (
  organization_id uuid not null, id text not null, activation_revision int not null,
  created_at timestamptz not null default clock_timestamp(), primary key (organization_id,id)
);
create table bench_state.operations (
  organization_id uuid not null, id text not null, stage text not null,
  attempts int not null default 1, next_step text not null, primary key (organization_id,id)
);
create table bench_state.rls_canary (organization_id uuid not null, id text primary key);
insert into bench_state.rls_canary select organization_id,role_name from bench_state.identities;
create table bench_state.inventory (
  relation_name text primary key, personal_columns text[] not null, handling text not null
);
insert into bench_state.inventory values
  ('subjects',array['display_name'],'null + tombstone + increment revision'),
  ('records',array['legacy_note'],'null'),
  ('jobs',array['payload'],'replace payload + cancel pending delivery'),
  ('copies',array['payload'],'replace all outbox/receipt/invocation/result payloads');

-- O papel efetivo do host não é identidade de tenant; session_user vem da conexão.
create function bench_state.tenant_id() returns uuid language sql stable security definer
set search_path=pg_catalog,bench_state as $$
  select organization_id from bench_state.identities where role_name=session_user
$$;
revoke all on function bench_state.tenant_id() from public;
grant usage on schema bench_state to bench_state_tenant_a,bench_state_tenant_b;
grant execute on function bench_state.tenant_id() to bench_state_tenant_a,bench_state_tenant_b;
do $$ declare t text; begin
  foreach t in array array['activation','subjects','records','jobs','copies','effects','operations','rls_canary'] loop
    execute format('alter table bench_state.%I enable row level security',t);
    execute format('create policy tenant_isolation on bench_state.%I using (organization_id=bench_state.tenant_id()) with check (organization_id=bench_state.tenant_id())',t);
    execute format('grant select on bench_state.%I to bench_state_tenant_a,bench_state_tenant_b',t);
  end loop;
end $$;
grant insert,update,delete on bench_state.rls_canary to bench_state_tenant_a,bench_state_tenant_b;

-- Política única para escrita, admissão e entrega. v2 é aditivo; v3 quebra v1/v2.
create function bench_state.contract_compatible(p_contract int,p_schema int) returns boolean
language sql immutable set search_path=pg_catalog as $$
  select coalesce((p_contract=1 and p_schema in (1,2))
    or (p_contract=2 and p_schema=2) or (p_contract=3 and p_schema=3),false)
$$;

create function bench_state.write_record(p_version int,p_id text,p_subject text,p_amount bigint,p_note text,p_label text default null)
returns void language plpgsql security definer set search_path=pg_catalog,bench_state as $$
declare org uuid:=bench_state.tenant_id(); ver int;
begin
  select schema_version into ver from bench_state.installation where id=1 for share;
  if not bench_state.contract_compatible(p_version,ver) then raise exception using errcode='P0001',message='contract_incompatible'; end if;
  perform 1 from bench_state.activation where organization_id=org and active and can_write for update;
  if not found then raise exception using errcode='P0001',message='extension_inactive_or_grant_missing'; end if;
  perform 1 from bench_state.subjects where organization_id=org and id=p_subject and not erased for update;
  if not found then raise exception using errcode='P0001',message='subject_erased'; end if;
  if p_version=3 then
    execute 'insert into bench_state.records(organization_id,id,subject_id,amount_minor,legacy_note) values($1,$2,$3,$4,$5)' using org,p_id,p_subject,p_amount,p_note;
  else
    insert into bench_state.records(organization_id,id,subject_id,amount_cents,legacy_note)
      values(org,p_id,p_subject,p_amount,p_note);
  end if;
  if p_version>=2 then
    execute 'update bench_state.records set label=$1 where organization_id=$2 and id=$3' using p_label,org,p_id;
  end if;
end $$;

create function bench_state.admit_job(p_id text,p_subject text,p_version int,p_payload jsonb)
returns void language plpgsql security definer set search_path=pg_catalog,bench_state as $$
declare org uuid:=bench_state.tenant_id(); ver int; rev int;
begin
  select schema_version into ver from bench_state.installation where id=1 for share;
  if not bench_state.contract_compatible(p_version,ver) then raise exception using errcode='P0001',message='contract_incompatible'; end if;
  select privacy_revision into rev from bench_state.subjects where organization_id=org and id=p_subject and not erased for update;
  if not found then raise exception using errcode='P0001',message='subject_erased'; end if;
  insert into bench_state.jobs values(org,p_id,p_subject,p_version,rev,p_payload,'pending','execute_pinned_contract');
end $$;

-- Desativação/revogação toma o mesmo lock por organização que a escrita.
create function bench_state.apply_effect(p_id text) returns text
language plpgsql security definer set search_path=pg_catalog,bench_state as $$
declare org uuid:=bench_state.tenant_id(); rev int;
begin
  select revision into rev from bench_state.activation where organization_id=org and active and can_write for update;
  if not found then raise exception using errcode='P0001',message='extension_inactive_or_grant_missing'; end if;
  insert into bench_state.effects values(org,p_id,rev,clock_timestamp()) on conflict do nothing;
  return 'recorded';
end $$;

-- Contrato durável do host: o inventário e estas funções sobrevivem ao pacote.
create function bench_state.export_subject(p_id text) returns jsonb
language sql stable security definer set search_path=pg_catalog,bench_state as $$
  select jsonb_build_object(
    'subject',(select to_jsonb(s) from bench_state.subjects s where organization_id=bench_state.tenant_id() and id=p_id),
    'records',(select coalesce(jsonb_agg(to_jsonb(r)),'[]') from bench_state.records r where organization_id=bench_state.tenant_id() and subject_id=p_id),
    'jobs',(select coalesce(jsonb_agg(to_jsonb(j)),'[]') from bench_state.jobs j where organization_id=bench_state.tenant_id() and subject_id=p_id),
    'copies',(select coalesce(jsonb_agg(to_jsonb(c)),'[]') from bench_state.copies c where organization_id=bench_state.tenant_id() and subject_id=p_id)
  )
$$;

create function bench_state.erase_subject(p_id text) returns void
language plpgsql security definer set search_path=pg_catalog,bench_state as $$
declare org uuid:=bench_state.tenant_id();
begin
  perform 1 from bench_state.subjects where organization_id=org and id=p_id for update;
  if not found then raise exception using errcode='P0001',message='subject_missing'; end if;
  update bench_state.subjects set display_name=null,erased=true,privacy_revision=privacy_revision+1 where organization_id=org and id=p_id and not erased;
  update bench_state.records set legacy_note=null where organization_id=org and subject_id=p_id;
  -- O tratador durável atende v1 sem label e v2/v3 com label, mesmo sem pacote.
  if exists(select 1 from information_schema.columns where table_schema='bench_state' and table_name='records' and column_name='label') then
    execute 'update bench_state.records set label=null where organization_id=$1 and subject_id=$2' using org,p_id;
  end if;
  update bench_state.jobs set payload='{"redacted":true}',status=case when status in ('pending','suspended') then 'cancelled' else status end,
    next_step='privacy_tombstone_do_not_replay' where organization_id=org and subject_id=p_id;
  update bench_state.copies set payload='{"redacted":true}' where organization_id=org and subject_id=p_id;
end $$;

-- O efeito consome o job persistido; p_payload é só a cópia apresentada pela entrega.
-- Mesmo uma cópia antiga carregada em memória antes do erase passa por esta guarda.
create function bench_state.deliver_job(p_id text,p_payload jsonb) returns void
language plpgsql security definer set search_path=pg_catalog,bench_state as $$
declare org uuid:=bench_state.tenant_id(); job bench_state.jobs%rowtype; subject bench_state.subjects%rowtype; ver int;
begin
  select schema_version into ver from bench_state.installation where id=1 for share;
  perform 1 from bench_state.activation where organization_id=org for update;
  select * into job from bench_state.jobs where organization_id=org and id=p_id;
  if not found then raise exception using errcode='P0001',message='job_missing'; end if;
  select * into subject from bench_state.subjects where organization_id=org and id=job.subject_id for update;
  if subject.erased or subject.privacy_revision<>job.privacy_revision then raise exception using errcode='P0001',message='privacy_revision_stale'; end if;
  if not exists(select 1 from bench_state.activation where organization_id=org and active and can_write) then raise exception using errcode='P0001',message='extension_inactive_or_grant_missing'; end if;
  if not bench_state.contract_compatible(job.contract_version,ver) then raise exception using errcode='P0001',message='contract_incompatible'; end if;
  if job.status<>'pending' then raise exception using errcode='P0001',message='job_not_pending'; end if;
  if p_payload is distinct from job.payload then raise exception using errcode='P0001',message='job_payload_mismatch'; end if;
  case job.payload->>'kind'
    when 'record' then
      perform bench_state.write_record(job.contract_version,job.payload->>'record_id',job.subject_id,
        (case when job.contract_version=3 then job.payload->>'amount_minor' else job.payload->>'amount_cents' end)::bigint,
        job.payload->>'note',job.payload->>'label');
    when 'subject_name' then
      update bench_state.subjects set display_name=job.payload->>'name' where organization_id=org and id=job.subject_id;
    else raise exception using errcode='P0001',message='job_kind_unknown';
  end case;
  update bench_state.jobs set status='done',next_step='none' where organization_id=org and id=p_id;
end $$;

create function bench_state.resume_operation(p_id text) returns text
language plpgsql security definer set search_path=pg_catalog,bench_state as $$
declare org uuid:=bench_state.tenant_id(); step text;
begin
  select stage into step from bench_state.operations where organization_id=org and id=p_id for update;
  if not found then raise exception using errcode='P0001',message='operation_missing'; end if;
  if step='prepared' then
    perform bench_state.apply_effect(p_id);
    update bench_state.operations set stage='effect_committed',next_step='verify_effect_and_complete',attempts=attempts+1 where organization_id=org and id=p_id;
    return 'effect_committed';
  end if;
  if not exists(select 1 from bench_state.effects where organization_id=org and id=p_id) then raise exception using errcode='P0001',message='postcondition_missing'; end if;
  update bench_state.operations set stage='complete',next_step='none',attempts=attempts+1 where organization_id=org and id=p_id;
  return 'complete';
end $$;

revoke all on all functions in schema bench_state from public;
grant execute on all functions in schema bench_state to bench_state_tenant_a,bench_state_tenant_b;
