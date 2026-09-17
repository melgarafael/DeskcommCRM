-- 0271 — Documentos declarativos locais; nenhuma execução de pacote ou DDL dinâmico.
-- A autoridade de publicação é um recibo preparing, sem TTL. Cancelamento e
-- admissão nova removem essa autoridade sob a mesma trava da conclusão.
-- A trava de atualização cobre system_update_runs (app), não o kit manual externo.
-- Atualizar, desfazer a última troca e remover: ponteiro de artefato com histórico de UM passo,
-- precondição pela revisão da instalação e remoção lógica (nenhuma linha é apagada).

create table if not exists public.extension_catalogs (
  id uuid primary key default gen_random_uuid(),
  origin text not null unique,
  revision integer not null check (revision > 0),
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  admitted_by uuid references auth.users(id) on delete set null,
  admitted_at timestamptz not null default now()
);
create table if not exists public.extension_artifacts (
  id uuid primary key default gen_random_uuid(),
  sha256 text not null unique check (sha256 ~ '^[a-f0-9]{64}$'),
  byte_length integer not null check (byte_length between 1 and 65536),
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  document text not null check (octet_length(document) between 1 and 65536),
  created_at timestamptz not null default now()
);
create table if not exists public.extension_installations (
  id uuid primary key default gen_random_uuid(),
  catalog_id uuid not null references public.extension_catalogs(id),
  artifact_id uuid not null references public.extension_artifacts(id),
  publisher text not null check (publisher ~ '^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$'),
  name text not null check (name ~ '^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$'),
  version text not null check (version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  installed_by uuid references auth.users(id) on delete set null,
  installed_at timestamptz not null default now(),
  unique (catalog_id, publisher, name)
);
create table if not exists public.organization_extensions (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  installation_id uuid not null references public.extension_installations(id),
  enabled boolean not null,
  configuration jsonb not null check (
    jsonb_typeof(configuration) = 'object'
    and configuration ?& array['density','show_description']
    and configuration - array['density','show_description'] = '{}'::jsonb
    and configuration->>'density' is not null
    and configuration->>'density' in ('comfortable','compact')
    and jsonb_typeof(configuration->'show_description') = 'boolean'
  ),
  revision integer not null check (revision > 0),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (organization_id, installation_id)
);
create table if not exists public.extension_operations (
  id uuid primary key,
  kind text not null,
  status text not null,
  actor_id uuid references auth.users(id) on delete set null,
  organization_id uuid references public.organizations(id) on delete cascade,
  catalog_id uuid references public.extension_catalogs(id),
  installation_id uuid references public.extension_installations(id),
  publisher text, name text, version text,
  request_fingerprint text not null check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  request jsonb not null,
  admission_revision integer,
  admission_digest text,
  entry jsonb,
  result jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint extension_operations_scope check ((kind = 'configure') = (organization_id is not null))
);
create index if not exists extension_operations_preparing on public.extension_operations(catalog_id) where status = 'preparing';
create index if not exists extension_operations_org on public.extension_operations(organization_id, created_at desc);
create index if not exists organization_extensions_installation on public.organization_extensions(installation_id);

-- Atualizar, desfazer e remover. Nada disto mora dentro de `create table if not exists`, que num
-- banco com a tabela não executa: colunas por `add column if not exists`, e as três CHECKs de
-- vocabulário com o NOME que o Postgres gerou para as inline antigas — o drop acha a velha e a
-- nova entra no lugar. Com outro nome as duas conviveriam e todo `update` daria 23514.
alter table public.extension_installations
  add column if not exists previous_artifact_id uuid references public.extension_artifacts(id),
  add column if not exists revision integer not null default 1 check (revision > 0),
  add column if not exists removed_at timestamptz,
  add column if not exists removed_by uuid references auth.users(id) on delete set null;
alter table public.extension_installations drop constraint if exists extension_installations_removed_by_requires_removed_at;
alter table public.extension_installations add constraint extension_installations_removed_by_requires_removed_at
  check (removed_by is null or removed_at is not null);
alter table public.organization_extensions add column if not exists deactivated_by_removal_at timestamptz;
alter table public.extension_operations drop constraint if exists extension_operations_kind_check;
alter table public.extension_operations add constraint extension_operations_kind_check
  check (kind in ('catalog_admission','install','update','revert','removal','configure'));
alter table public.extension_operations drop constraint if exists extension_operations_status_check;
alter table public.extension_operations add constraint extension_operations_status_check
  check (status in ('preparing','completed','failed','cancelled'));
alter table public.extension_operations drop constraint if exists extension_operations_preparing;
alter table public.extension_operations add constraint extension_operations_preparing
  check (status <> 'preparing' or kind in ('install','update'));

alter table public.extension_catalogs enable row level security;
alter table public.extension_artifacts enable row level security;
alter table public.extension_installations enable row level security;
alter table public.organization_extensions enable row level security;
alter table public.extension_operations enable row level security;
revoke all on public.extension_catalogs, public.extension_artifacts, public.extension_installations,
  public.organization_extensions, public.extension_operations from public, anon, authenticated, service_role;
grant select on public.extension_catalogs, public.extension_artifacts, public.extension_installations,
  public.organization_extensions, public.extension_operations to service_role;
grant select on public.organization_extensions to authenticated;
drop policy if exists tenant_isolation_organization_extensions_select on public.organization_extensions;
-- fn_user_org_ids() inclui convite ainda não aceito e sessão de suporte ativa. O
-- vínculo exige convite aceito de quem é membro e, sem exigir linha de membership,
-- aceita a sessão de suporte ativa na organização atendida: sem isso, quem dá suporte
-- via todas as extensões como "desativadas" enquanto o cliente as via ativas.
create policy tenant_isolation_organization_extensions_select on public.organization_extensions
  for select to authenticated using (
    organization_id in (select public.fn_user_org_ids())
    and (
      exists (select 1 from public.user_organizations u where u.organization_id = organization_extensions.organization_id
        and u.user_id = auth.uid() and u.accepted_at is not null and u.revoked_at is null)
      or exists (select 1 from (select public.fn_support_context() s) c
        where c.s->>'status' = 'active' and (c.s->>'organization_id')::uuid = organization_extensions.organization_id)
    )
  );

-- Helpers privados: EXECUTE fechado também porque o baseline concede defaults a anon.
create or replace function public.fn_extensions_assert_actor(p_actor uuid, p_organization uuid default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_actor is null or not exists (select 1 from auth.users where id = p_actor) then
    raise exception using errcode = 'P0001', message = 'extension_forbidden';
  end if;
  if p_organization is null then
    if not exists (select 1 from public.platform_admins where user_id = p_actor and revoked_at is null and scope = 'full') then
      raise exception using errcode = 'P0001', message = 'extension_forbidden';
    end if;
  elsif not exists (select 1 from public.user_organizations where user_id = p_actor and organization_id = p_organization
    and revoked_at is null and accepted_at is not null and role = 'admin') then
    raise exception using errcode = 'P0001', message = 'extension_forbidden';
  end if;
end $$;

create or replace function public.fn_extensions_fingerprint(p_request jsonb)
returns text language sql immutable set search_path = public, extensions, pg_temp as $$
  select encode(digest(convert_to(p_request::text, 'UTF8'), 'sha256'), 'hex');
$$;

create or replace function public.fn_extensions_admit_catalog(p_actor uuid, p_operation uuid, p_snapshot jsonb, p_digest text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_request jsonb := jsonb_build_object('kind','catalog_admission','actor',p_actor,'snapshot',p_snapshot,'digest',p_digest);
  v_op public.extension_operations; v_catalog public.extension_catalogs; v_entry jsonb; v_revision integer;
begin
  perform public.fn_extensions_assert_actor(p_actor);
  if p_operation is null then raise exception using errcode='P0001', message='extension_invalid_input'; end if;
  perform pg_advisory_xact_lock(255,1);
  perform public.fn_extensions_assert_actor(p_actor);
  perform pg_advisory_xact_lock(hashtextextended(p_operation::text,255));
  perform public.fn_extensions_assert_actor(p_actor);
  select * into v_op from public.extension_operations where id=p_operation;
  if found then
    if v_op.request_fingerprint <> public.fn_extensions_fingerprint(v_request) then
      raise exception using errcode='P0001', message='extension_idempotency_conflict';
    end if;
    return to_jsonb(v_op) || jsonb_build_object('applied_now', false);
  end if;
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object'
    or not (p_snapshot ?& array['format_version','origin','revision','entries'])
    or p_snapshot - array['format_version','origin','revision','entries'] <> '{}'::jsonb
    or p_snapshot->'format_version' is distinct from '1'::jsonb
    or jsonb_typeof(p_snapshot->'origin') is distinct from 'string'
    or p_snapshot->>'origin' !~ '^https?://[^/@?#[:space:]]+$'
    or jsonb_typeof(p_snapshot->'revision') is distinct from 'number'
    or p_snapshot->>'revision' !~ '^[1-9][0-9]{0,8}$'
    or jsonb_typeof(p_snapshot->'entries') is distinct from 'array'
    or p_digest is null or p_digest !~ '^[a-f0-9]{64}$' then
    raise exception using errcode='P0001', message='extension_invalid_input';
  end if;
  if jsonb_array_length(p_snapshot->'entries') > 128 then
    raise exception using errcode='P0001', message='extension_invalid_input';
  end if;
  for v_entry in select value from jsonb_array_elements(p_snapshot->'entries') loop
    if jsonb_typeof(v_entry) <> 'object' or not (v_entry ?& array['publisher','name','version','license','host_api','display','permissions','sha256','byte_length'])
      or v_entry - array['publisher','name','version','license','host_api','display','permissions','sha256','byte_length'] <> '{}'::jsonb
      or exists (select 1 from jsonb_each(v_entry) e where e.value='null'::jsonb)
      or jsonb_typeof(v_entry->'byte_length') is distinct from 'number'
      or jsonb_typeof(v_entry->'host_api') is distinct from 'object'
      or jsonb_typeof(v_entry->'display') is distinct from 'object'
      or v_entry->>'publisher' !~ '^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$'
      or v_entry->>'name' !~ '^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$'
      or v_entry->>'version' !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
      or v_entry->>'sha256' !~ '^[a-f0-9]{64}$'
      or v_entry->>'byte_length' !~ '^[1-9][0-9]{0,4}$'
      or v_entry->>'license' <> 'MIT' or v_entry->'permissions' <> '["navigation.tasks"]'::jsonb then
      raise exception using errcode='P0001', message='extension_invalid_input';
    end if;
    if (v_entry->>'byte_length')::integer > 65536 then
      raise exception using errcode='P0001', message='extension_invalid_input';
    end if;
  end loop;
  if exists (select 1 from jsonb_array_elements(p_snapshot->'entries') e
    group by e->>'publisher', e->>'name', e->>'version' having count(*) > 1) then
    raise exception using errcode='P0001', message='extension_invalid_input';
  end if;
  v_revision := (p_snapshot->>'revision')::integer;
  select * into v_catalog from public.extension_catalogs where origin=p_snapshot->>'origin';
  if found and (v_revision < v_catalog.revision or (v_revision = v_catalog.revision
      and (p_digest <> v_catalog.digest or p_snapshot <> v_catalog.snapshot))) then
    raise exception using errcode='P0001', message='extension_catalog_revision_conflict';
  end if;
  if v_catalog.id is null then
    if (select count(*) from public.extension_catalogs) >= 8 then
      raise exception using errcode='P0001',message='extension_catalog_limit';
    end if;
    insert into public.extension_catalogs(origin,revision,digest,snapshot,admitted_by)
      values(p_snapshot->>'origin',v_revision,p_digest,p_snapshot,p_actor) returning * into v_catalog;
  elsif v_revision > v_catalog.revision then
    update public.extension_catalogs set revision=v_revision,digest=p_digest,snapshot=p_snapshot,
      admitted_by=p_actor,admitted_at=now() where id=v_catalog.id returning * into v_catalog;
    update public.extension_operations set status='cancelled',error_code='extension_catalog_stale',updated_at=now()
      where catalog_id=v_catalog.id and kind in ('install','update') and status='preparing';
  end if;
  insert into public.extension_operations(id,kind,status,actor_id,catalog_id,request,request_fingerprint,result)
    values(p_operation,'catalog_admission','completed',p_actor,v_catalog.id,v_request,
      public.fn_extensions_fingerprint(v_request),jsonb_build_object('catalog',to_jsonb(v_catalog))) returning * into v_op;
  return to_jsonb(v_op) || jsonb_build_object('applied_now', true);
end $$;

-- Publicar espera a atualização do core; um `dispatched` com mais de 15 minutos é, para o
-- próprio app, desfecho desconhecido (RUN_STALE_AFTER_MS em lib/system/update-run.ts) e não
-- bloqueia. Sem prazo, um agente morto travava toda publicação para sempre.
create or replace function public.fn_extensions_core_update_in_progress()
returns boolean language sql stable set search_path = public, pg_temp as $$
  select exists (select 1 from public.system_update_runs
    where status='dispatched' and dispatched_at > now() - interval '15 minutes');
$$;

-- Instalar, atualizar, trocar para versão menor e reinstalar passam por aqui. A precondição é a
-- revisão da instalação que a tela exibiu (null = a tela não viu linha): sem ela, uma aba antiga
-- rebaixaria a versão ou desfaria uma remoção em silêncio.
drop function if exists public.fn_extensions_prepare_install(uuid,uuid,uuid,text,text,text);
create or replace function public.fn_extensions_prepare_install(p_actor uuid, p_operation uuid, p_catalog uuid,
  p_publisher text, p_name text, p_version text, p_expected_installation_revision integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_request jsonb := jsonb_build_object('kind','install','actor',p_actor,'catalog',p_catalog,'publisher',p_publisher,
    'name',p_name,'version',p_version,'expected_installation_revision',p_expected_installation_revision);
  v_op public.extension_operations; v_catalog public.extension_catalogs; v_entry jsonb;
  v_install public.extension_installations; v_current public.extension_artifacts; v_previous public.extension_artifacts;
  v_kind text; v_from jsonb := jsonb_build_object('from_revision', null);
begin
  perform public.fn_extensions_assert_actor(p_actor);
  if p_operation is null or p_catalog is null or p_publisher is null or p_name is null or p_version is null
    or p_expected_installation_revision < 1 then
    raise exception using errcode='P0001',message='extension_invalid_input';
  end if;
  perform pg_advisory_xact_lock(255,1);
  perform public.fn_extensions_assert_actor(p_actor);
  perform pg_advisory_xact_lock(hashtextextended(p_operation::text,255));
  perform public.fn_extensions_assert_actor(p_actor);
  select * into v_op from public.extension_operations where id=p_operation;
  if found then
    if v_op.request_fingerprint <> public.fn_extensions_fingerprint(v_request) then
      raise exception using errcode='P0001',message='extension_idempotency_conflict';
    end if;
    return to_jsonb(v_op) || jsonb_build_object('applied_now', false);
  end if;
  if public.fn_extensions_core_update_in_progress() then
    raise exception using errcode='P0001',message='extension_core_update_in_progress';
  end if;
  select * into v_catalog from public.extension_catalogs where id=p_catalog;
  if not found then raise exception using errcode='P0001',message='extension_catalog_not_found'; end if;
  select value into v_entry from jsonb_array_elements(v_catalog.snapshot->'entries')
    where value->>'publisher'=p_publisher and value->>'name'=p_name and value->>'version'=p_version;
  if not found then raise exception using errcode='P0001',message='extension_entry_not_found'; end if;
  select * into v_install from public.extension_installations
    where catalog_id=p_catalog and publisher=p_publisher and name=p_name;
  if v_install.revision is distinct from p_expected_installation_revision then
    raise exception using errcode='P0001',message='extension_version_changed';
  end if;
  if exists (select 1 from public.extension_operations where kind in ('install','update') and status='preparing'
    and catalog_id=p_catalog and publisher=p_publisher and name=p_name) then
    raise exception using errcode='P0001',message='extension_preparation_in_progress';
  end if;
  if v_install.id is not null then
    select * into v_current from public.extension_artifacts where id=v_install.artifact_id;
    select * into v_previous from public.extension_artifacts where id=v_install.previous_artifact_id;
    -- A mesma versão com outro digest é conflito contra o vigente, o anterior e a linha removida.
    if (v_install.version = p_version and v_current.sha256 <> v_entry->>'sha256')
      or (v_previous.id is not null and v_previous.manifest->>'version' = p_version
        and v_previous.sha256 <> v_entry->>'sha256') then
      raise exception using errcode='P0001',message='extension_version_conflict';
    end if;
    v_from := jsonb_build_object('from_revision',v_install.revision,'from_artifact_id',v_install.artifact_id,
      'from_version',v_install.version);
    if v_install.removed_at is null and v_install.version = p_version then
      insert into public.extension_operations(id,kind,status,actor_id,catalog_id,installation_id,publisher,name,version,
        request,request_fingerprint,admission_revision,admission_digest,entry,result)
        values(p_operation,'install','completed',p_actor,p_catalog,v_install.id,p_publisher,p_name,p_version,v_request,
          public.fn_extensions_fingerprint(v_request),v_catalog.revision,v_catalog.digest,v_entry,
          jsonb_build_object('installation',to_jsonb(v_install),'to_artifact_id',v_install.artifact_id))
        returning * into v_op;
      return to_jsonb(v_op) || jsonb_build_object('applied_now', false);
    end if;
  end if;
  if v_install.id is not null and v_install.removed_at is null then
    v_kind := 'update';
  else
    v_kind := 'install';
    -- A preparação de update não conta: ela não cria identidade.
    if (select count(*) from public.extension_installations where removed_at is null) +
      (select count(*) from public.extension_operations where kind='install' and status='preparing') >= 128 then
      raise exception using errcode='P0001',message='extension_installation_limit';
    end if;
  end if;
  insert into public.extension_operations(id,kind,status,actor_id,catalog_id,installation_id,publisher,name,version,
    request,request_fingerprint,admission_revision,admission_digest,entry,result)
    values(p_operation,v_kind,'preparing',p_actor,p_catalog,v_install.id,p_publisher,p_name,p_version,v_request,
      public.fn_extensions_fingerprint(v_request),v_catalog.revision,v_catalog.digest,v_entry,v_from)
    returning * into v_op;
  return to_jsonb(v_op) || jsonb_build_object('applied_now', true);
end $$;

create or replace function public.fn_extensions_finish_install(p_actor uuid, p_operation uuid, p_manifest jsonb, p_sha256 text, p_byte_length integer, p_document text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_op public.extension_operations; v_catalog public.extension_catalogs;
  v_artifact public.extension_artifacts; v_install public.extension_installations; v_current public.extension_artifacts;
  v_previous public.extension_artifacts; v_document_json jsonb; v_active integer := 0;
begin
  perform public.fn_extensions_assert_actor(p_actor);
  perform pg_advisory_xact_lock(255,1);
  perform public.fn_extensions_assert_actor(p_actor);
  select * into v_op from public.extension_operations where id=p_operation for update;
  if not found then raise exception using errcode='P0001',message='extension_operation_not_found'; end if;
  if v_op.kind not in ('install','update') or v_op.actor_id is distinct from p_actor then
    raise exception using errcode='P0001',message='extension_operation_conflict';
  end if;
  -- Sem autoridade após cancel/fail. Resposta perdida de completed segue verificando payload.
  if v_op.status in ('cancelled','failed') then return to_jsonb(v_op) || jsonb_build_object('applied_now', false); end if;
  if p_document is null or octet_length(p_document) not between 1 and 65536
    or octet_length(p_document) is distinct from p_byte_length
    or encode(sha256(convert_to(p_document,'UTF8')),'hex') is distinct from p_sha256 then
    raise exception using errcode='P0001',message='extension_artifact_mismatch';
  end if;
  begin
    v_document_json := p_document::jsonb;
  exception when invalid_text_representation or untranslatable_character or program_limit_exceeded then
    raise exception using errcode='P0001',message='extension_artifact_mismatch';
  end;
  if v_document_json is distinct from p_manifest then
    raise exception using errcode='P0001',message='extension_artifact_mismatch';
  end if;
  if p_sha256 is distinct from v_op.entry->>'sha256' or p_byte_length is distinct from (v_op.entry->>'byte_length')::integer
    or p_manifest is null or jsonb_typeof(p_manifest) <> 'object'
    or not (p_manifest ?& array['format_version','profile','publisher','name','version','license','host_api','permissions','dependencies','data','display','configuration','contributions'])
    or p_manifest - array['format_version','profile','publisher','name','version','license','host_api','permissions','dependencies','data','display','configuration','contributions'] <> '{}'::jsonb
    or exists (select 1 from jsonb_each(p_manifest) e where e.value='null'::jsonb)
    or p_manifest->'format_version' is distinct from '1'::jsonb or p_manifest->>'profile' is distinct from 'declarative'
    or jsonb_typeof(p_manifest->'configuration') is distinct from 'object'
    or jsonb_typeof(p_manifest->'contributions') is distinct from 'object'
    or p_manifest->>'publisher' is distinct from v_op.publisher or p_manifest->>'name' is distinct from v_op.name
    or p_manifest->>'version' is distinct from v_op.version
    or p_manifest->'dependencies' <> '[]'::jsonb or p_manifest->'data' <> '{"mode":"none"}'::jsonb
    or (p_manifest - array['format_version','profile','dependencies','data','configuration','contributions'])
      is distinct from (v_op.entry - array['sha256','byte_length']) then
    raise exception using errcode='P0001',message='extension_artifact_mismatch';
  end if;
  if v_op.status='completed' then
    -- Compara com o artefato que ESTA conclusão publicou, não com o ponteiro de agora: um
    -- "desfazer" posterior não pode fazer a repetição acusar pacote adulterado.
    select * into v_artifact from public.extension_artifacts
      where id=coalesce(v_op.result->>'to_artifact_id', v_op.result->'installation'->>'artifact_id')::uuid;
    if not found or v_artifact.manifest is distinct from p_manifest or v_artifact.document is distinct from p_document then
      raise exception using errcode='P0001',message='extension_artifact_mismatch';
    end if;
    return to_jsonb(v_op) || jsonb_build_object('applied_now', false);
  end if;
  if public.fn_extensions_core_update_in_progress() then
    raise exception using errcode='P0001',message='extension_core_update_in_progress';
  end if;
  select * into v_catalog from public.extension_catalogs where id=v_op.catalog_id;
  if v_catalog.revision is distinct from v_op.admission_revision or v_catalog.digest is distinct from v_op.admission_digest then
    raise exception using errcode='P0001',message='extension_catalog_stale';
  end if;
  select * into v_install from public.extension_installations
    where catalog_id=v_op.catalog_id and publisher=v_op.publisher and name=v_op.name for update;
  -- Defesa estrutural: a linha tem de estar na revisão que a preparação viu.
  if v_install.revision is distinct from (v_op.result->>'from_revision')::integer
    or (v_op.kind='update' and v_install.removed_at is not null)
    or (v_op.kind='install' and v_install.id is not null and v_install.removed_at is null) then
    raise exception using errcode='P0001',message='extension_version_changed';
  end if;
  if v_install.id is not null then
    select * into v_current from public.extension_artifacts where id=v_install.artifact_id;
    select * into v_previous from public.extension_artifacts where id=v_install.previous_artifact_id;
    if (v_install.version = v_op.version and v_current.sha256 <> p_sha256)
      or (v_previous.id is not null and v_previous.manifest->>'version' = v_op.version and v_previous.sha256 <> p_sha256) then
      raise exception using errcode='P0001',message='extension_version_conflict';
    end if;
  end if;
  select * into v_artifact from public.extension_artifacts where sha256=p_sha256;
  if found then
    if v_artifact.manifest is distinct from p_manifest or v_artifact.document is distinct from p_document or v_artifact.byte_length <> p_byte_length then
      raise exception using errcode='P0001',message='extension_artifact_mismatch';
    end if;
  else
    insert into public.extension_artifacts(sha256,byte_length,manifest,document) values(p_sha256,p_byte_length,p_manifest,p_document) returning * into v_artifact;
  end if;
  if v_install.id is null then
    insert into public.extension_installations(catalog_id,artifact_id,publisher,name,version,installed_by)
      values(v_op.catalog_id,v_artifact.id,v_op.publisher,v_op.name,v_op.version,p_actor) returning * into v_install;
  elsif v_op.kind='install' then
    -- Reinstalação de uma linha removida: os vínculos NÃO voltam ativos; cada organização decide.
    update public.extension_installations set artifact_id=v_artifact.id, version=v_op.version, previous_artifact_id=null,
      removed_at=null, removed_by=null, installed_by=p_actor, installed_at=now(), revision=revision+1
      where id=v_install.id returning * into v_install;
  else
    update public.extension_installations set previous_artifact_id=artifact_id, artifact_id=v_artifact.id,
      version=v_op.version, revision=revision+1 where id=v_install.id returning * into v_install;
    select count(*)::integer into v_active from public.organization_extensions where installation_id=v_install.id and enabled;
  end if;
  update public.extension_operations set status='completed',installation_id=v_install.id,
    result=coalesce(v_op.result,'{}'::jsonb) || jsonb_build_object('installation',to_jsonb(v_install),
      'to_artifact_id',v_artifact.id,'to_version',v_op.version,'organizations_active',v_active),
    updated_at=now() where id=p_operation returning * into v_op;
  return to_jsonb(v_op) || jsonb_build_object('applied_now', true);
end $$;

create or replace function public.fn_extensions_fail_install(p_actor uuid, p_operation uuid, p_error_code text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_op public.extension_operations; v_applied boolean := false;
begin
  perform public.fn_extensions_assert_actor(p_actor);
  if p_error_code is null or p_error_code not in ('extension_invalid_package','extension_incompatible','extension_download_failed',
      'extension_unsafe_origin','extension_digest_mismatch','extension_payload_too_large','extension_storage_failed') then
    raise exception using errcode='P0001',message='extension_invalid_input';
  end if;
  perform pg_advisory_xact_lock(255,1);
  perform public.fn_extensions_assert_actor(p_actor);
  select * into v_op from public.extension_operations where id=p_operation for update;
  if not found then raise exception using errcode='P0001',message='extension_operation_not_found'; end if;
  if v_op.kind not in ('install','update') or v_op.actor_id is distinct from p_actor then
    raise exception using errcode='P0001',message='extension_operation_conflict';
  end if;
  if v_op.status='preparing' then
    update public.extension_operations set status='failed',error_code=p_error_code,updated_at=now()
      where id=p_operation returning * into v_op;
    v_applied := true;
  elsif v_op.status='failed' and v_op.error_code is distinct from p_error_code then
    raise exception using errcode='P0001',message='extension_idempotency_conflict';
  end if;
  return to_jsonb(v_op) || jsonb_build_object('applied_now', v_applied);
end $$;

create or replace function public.fn_extensions_cancel_install(p_actor uuid, p_operation uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_op public.extension_operations; v_applied boolean := false;
begin
  perform public.fn_extensions_assert_actor(p_actor);
  perform pg_advisory_xact_lock(255,1);
  perform public.fn_extensions_assert_actor(p_actor);
  select * into v_op from public.extension_operations where id=p_operation for update;
  if not found then raise exception using errcode='P0001',message='extension_operation_not_found'; end if;
  if v_op.kind not in ('install','update') then raise exception using errcode='P0001',message='extension_operation_conflict'; end if;
  -- Outro administrador atual pode recuperar uma preparação cujo ator foi removido.
  if v_op.status='preparing' then
    update public.extension_operations set status='cancelled',updated_at=now() where id=p_operation returning * into v_op;
    v_applied := true;
  end if;
  return to_jsonb(v_op) || jsonb_build_object('applied_now', v_applied);
end $$;

create or replace function public.fn_extensions_configure(p_actor uuid, p_organization uuid, p_installation uuid, p_operation uuid,
  p_expected_revision integer, p_enabled boolean, p_configuration jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_request jsonb := jsonb_build_object('kind','configure','actor',p_actor,'organization',p_organization,
    'installation',p_installation,'expected_revision',p_expected_revision,'enabled',p_enabled,'configuration',p_configuration);
  v_op public.extension_operations; v_link public.organization_extensions; v_config jsonb; v_manifest jsonb;
  v_removed_at timestamptz;
begin
  if p_organization is null or p_operation is null or p_installation is null or p_expected_revision is null
    or p_expected_revision < 0 or p_enabled is null then
    raise exception using errcode='P0001',message='extension_invalid_input';
  end if;
  perform public.fn_extensions_assert_actor(p_actor,p_organization);
  perform pg_advisory_xact_lock(hashtextextended(p_operation::text,255));
  perform public.fn_extensions_assert_actor(p_actor,p_organization);
  select * into v_op from public.extension_operations where id=p_operation;
  if found then
    if v_op.request_fingerprint <> public.fn_extensions_fingerprint(v_request) then
      raise exception using errcode='P0001',message='extension_idempotency_conflict';
    end if;
    return to_jsonb(v_op) || jsonb_build_object('applied_now', false);
  end if;
  perform 1 from public.organizations where id=p_organization for update;
  perform public.fn_extensions_assert_actor(p_actor,p_organization);
  -- FOR SHARE na instalação serializa a ativação com toda troca de ponteiro e com a remoção
  -- (que faz UPDATE na instalação antes dos vínculos). Sem isso, configurar e remover ao mesmo
  -- tempo deixava um vínculo ativo numa extensão removida, que nenhuma tela desativava.
  select i.removed_at, a.manifest into v_removed_at, v_manifest
    from public.extension_installations i join public.extension_artifacts a on a.id=i.artifact_id
    where i.id=p_installation for share of i;
  if not found then raise exception using errcode='P0001',message='extension_installation_not_found'; end if;
  if v_removed_at is not null then raise exception using errcode='P0001',message='extension_removed'; end if;
  select * into v_link from public.organization_extensions where organization_id=p_organization and installation_id=p_installation;
  if coalesce(v_link.revision,0) <> p_expected_revision then
    raise exception using errcode='P0001',message='extension_revision_conflict';
  end if;
  v_config := coalesce(p_configuration,v_link.configuration,v_manifest->'configuration');
  if v_config is null or jsonb_typeof(v_config) <> 'object'
    or not (v_config ?& array['density','show_description']) or v_config - array['density','show_description'] <> '{}'::jsonb
    or v_config->>'density' is null or v_config->>'density' not in ('comfortable','compact')
    or jsonb_typeof(v_config->'show_description') is distinct from 'boolean' then
    raise exception using errcode='P0001',message='extension_invalid_input';
  end if;
  if p_enabled and not coalesce(v_link.enabled,false) and
    (select count(*) from public.organization_extensions where organization_id=p_organization and enabled) >= 8 then
    raise exception using errcode='P0001',message='extension_active_limit';
  end if;
  insert into public.organization_extensions(organization_id,installation_id,enabled,configuration,revision,updated_by)
    values(p_organization,p_installation,p_enabled,v_config,p_expected_revision+1,p_actor)
    on conflict (organization_id,installation_id) do update set enabled=excluded.enabled,configuration=excluded.configuration,
      revision=excluded.revision,updated_by=excluded.updated_by,updated_at=now(),
      -- Ativar apaga a marca da remoção; desativar ou mudar a densidade a preserva.
      deactivated_by_removal_at=case when excluded.enabled then null else organization_extensions.deactivated_by_removal_at end
    returning * into v_link;
  insert into public.extension_operations(id,kind,status,actor_id,organization_id,installation_id,request,request_fingerprint,result)
    values(p_operation,'configure','completed',p_actor,p_organization,p_installation,v_request,
      public.fn_extensions_fingerprint(v_request),jsonb_build_object('organization_extension',to_jsonb(v_link))) returning * into v_op;
  return to_jsonb(v_op) || jsonb_build_object('applied_now', true);
end $$;

-- Desfazer a última troca: o anterior vira vigente e o vigente vira anterior (é a própria
-- inversa). Não baixa nada, então funciona com o catálogo desligado. Histórico de UM passo.
create or replace function public.fn_extensions_revert_install(p_actor uuid, p_operation uuid, p_installation uuid,
  p_expected_installation_revision integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_request jsonb := jsonb_build_object('kind','revert','actor',p_actor,'installation',p_installation,
    'expected_installation_revision',p_expected_installation_revision);
  v_op public.extension_operations; v_install public.extension_installations; v_from public.extension_installations;
  v_target public.extension_artifacts; v_active integer;
begin
  perform public.fn_extensions_assert_actor(p_actor);
  if p_operation is null or p_installation is null or p_expected_installation_revision is null
    or p_expected_installation_revision < 1 then
    raise exception using errcode='P0001',message='extension_invalid_input';
  end if;
  perform pg_advisory_xact_lock(255,1);
  perform public.fn_extensions_assert_actor(p_actor);
  perform pg_advisory_xact_lock(hashtextextended(p_operation::text,255));
  perform public.fn_extensions_assert_actor(p_actor);
  select * into v_op from public.extension_operations where id=p_operation;
  if found then
    if v_op.request_fingerprint <> public.fn_extensions_fingerprint(v_request) then
      raise exception using errcode='P0001',message='extension_idempotency_conflict';
    end if;
    return to_jsonb(v_op) || jsonb_build_object('applied_now', false);
  end if;
  if public.fn_extensions_core_update_in_progress() then
    raise exception using errcode='P0001',message='extension_core_update_in_progress';
  end if;
  select * into v_install from public.extension_installations where id=p_installation for update;
  if not found then raise exception using errcode='P0001',message='extension_installation_not_found'; end if;
  if v_install.removed_at is not null then raise exception using errcode='P0001',message='extension_removed'; end if;
  if exists (select 1 from public.extension_operations where kind in ('install','update') and status='preparing'
    and catalog_id=v_install.catalog_id and publisher=v_install.publisher and name=v_install.name) then
    raise exception using errcode='P0001',message='extension_preparation_in_progress';
  end if;
  if v_install.revision <> p_expected_installation_revision then
    raise exception using errcode='P0001',message='extension_version_changed';
  end if;
  if v_install.previous_artifact_id is null then
    raise exception using errcode='P0001',message='extension_no_previous_version';
  end if;
  select * into v_target from public.extension_artifacts where id=v_install.previous_artifact_id;
  v_from := v_install;
  update public.extension_installations set artifact_id=previous_artifact_id, previous_artifact_id=artifact_id,
    version=v_target.manifest->>'version', revision=revision+1 where id=p_installation returning * into v_install;
  select count(*)::integer into v_active from public.organization_extensions where installation_id=p_installation and enabled;
  insert into public.extension_operations(id,kind,status,actor_id,catalog_id,installation_id,publisher,name,version,
    request,request_fingerprint,result)
    values(p_operation,'revert','completed',p_actor,v_install.catalog_id,v_install.id,v_install.publisher,v_install.name,
      v_install.version,v_request,public.fn_extensions_fingerprint(v_request),
      jsonb_build_object('installation',to_jsonb(v_install),'from_revision',v_from.revision,'from_artifact_id',v_from.artifact_id,
        'from_version',v_from.version,'to_artifact_id',v_install.artifact_id,'to_version',v_install.version,
        'organizations_active',v_active))
    returning * into v_op;
  return to_jsonb(v_op) || jsonb_build_object('applied_now', true);
end $$;

-- Remover da instalação: nenhuma linha é apagada. A instalação sai do hub e do guia; todo
-- vínculo ATIVO, em todas as organizações, é desligado com a marca da remoção e a configuração
-- preservada. Tirar não espera a atualização do core: só reduz o que está ativo.
create or replace function public.fn_extensions_remove_installation(p_actor uuid, p_operation uuid, p_installation uuid,
  p_expected_installation_revision integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_request jsonb := jsonb_build_object('kind','removal','actor',p_actor,'installation',p_installation,
    'expected_installation_revision',p_expected_installation_revision);
  v_op public.extension_operations; v_install public.extension_installations; v_from public.extension_installations;
  v_orgs uuid[];
begin
  perform public.fn_extensions_assert_actor(p_actor);
  if p_operation is null or p_installation is null or p_expected_installation_revision is null
    or p_expected_installation_revision < 1 then
    raise exception using errcode='P0001',message='extension_invalid_input';
  end if;
  perform pg_advisory_xact_lock(255,1);
  perform public.fn_extensions_assert_actor(p_actor);
  perform pg_advisory_xact_lock(hashtextextended(p_operation::text,255));
  perform public.fn_extensions_assert_actor(p_actor);
  select * into v_op from public.extension_operations where id=p_operation;
  if found then
    if v_op.request_fingerprint <> public.fn_extensions_fingerprint(v_request) then
      raise exception using errcode='P0001',message='extension_idempotency_conflict';
    end if;
    return to_jsonb(v_op) || jsonb_build_object('applied_now', false);
  end if;
  select * into v_install from public.extension_installations where id=p_installation for update;
  if not found then raise exception using errcode='P0001',message='extension_installation_not_found'; end if;
  if v_install.removed_at is not null then raise exception using errcode='P0001',message='extension_removed'; end if;
  if exists (select 1 from public.extension_operations where kind in ('install','update') and status='preparing'
    and catalog_id=v_install.catalog_id and publisher=v_install.publisher and name=v_install.name) then
    raise exception using errcode='P0001',message='extension_preparation_in_progress';
  end if;
  if v_install.revision <> p_expected_installation_revision then
    raise exception using errcode='P0001',message='extension_version_changed';
  end if;
  v_from := v_install;
  -- A instalação ANTES dos vínculos: na ordem inversa, a corrida com a configuração dá impasse.
  update public.extension_installations set removed_at=now(), removed_by=p_actor, revision=revision+1
    where id=p_installation returning * into v_install;
  with desligados as (
    update public.organization_extensions set enabled=false, revision=revision+1, updated_by=p_actor, updated_at=now(),
      deactivated_by_removal_at=now()
    where installation_id=p_installation and enabled
    returning organization_id)
  select coalesce(array_agg(organization_id order by organization_id), array[]::uuid[]) into v_orgs from desligados;
  insert into public.extension_operations(id,kind,status,actor_id,catalog_id,installation_id,publisher,name,version,
    request,request_fingerprint,result)
    values(p_operation,'removal','completed',p_actor,v_install.catalog_id,v_install.id,v_install.publisher,v_install.name,
      v_from.version,v_request,public.fn_extensions_fingerprint(v_request),
      jsonb_build_object('installation',to_jsonb(v_install),'from_revision',v_from.revision,'from_artifact_id',v_from.artifact_id,
        'from_version',v_from.version,'organizations_disabled',to_jsonb(v_orgs),
        'organizations_disabled_count',coalesce(array_length(v_orgs,1),0)))
    returning * into v_op;
  return to_jsonb(v_op) || jsonb_build_object('applied_now', true);
end $$;

-- Contagem entre organizações para quem administra a instalação: só números, nunca ids. É a
-- única leitura de organization_extensions que atravessa organizações, e a spec a declara. Confere
-- o ator no banco, como as funções que escrevem: a barreira não depende só de quem a chama.
drop function if exists public.fn_extensions_installation_counts();
create or replace function public.fn_extensions_installation_counts(p_actor uuid)
returns table(installation_id uuid, active_organizations integer, awaiting_reactivation integer)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.fn_extensions_assert_actor(p_actor);
  return query
    select e.installation_id,
      (count(*) filter (where e.enabled))::integer,
      (count(*) filter (where not e.enabled and e.deactivated_by_removal_at is not null))::integer
    from public.organization_extensions e
    group by e.installation_id;
end $$;

create or replace function public.fn_extensions_guard_core_update()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status='dispatched' then
    perform pg_advisory_xact_lock(255,1);
    if exists (select 1 from public.extension_operations where kind in ('install','update') and status='preparing') then
      raise exception using errcode='P0001',message='extension_preparation_in_progress';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists extensions_guard_core_update on public.system_update_runs;
create trigger extensions_guard_core_update before insert or update of status on public.system_update_runs
  for each row execute function public.fn_extensions_guard_core_update();

revoke execute on function public.fn_extensions_assert_actor(uuid,uuid) from public,anon,authenticated,service_role;
revoke execute on function public.fn_extensions_fingerprint(jsonb) from public,anon,authenticated,service_role;
revoke execute on function public.fn_extensions_guard_core_update() from public,anon,authenticated,service_role;
revoke execute on function public.fn_extensions_core_update_in_progress() from public,anon,authenticated,service_role;
revoke execute on function public.fn_extensions_admit_catalog(uuid,uuid,jsonb,text) from public,anon,authenticated;
revoke execute on function public.fn_extensions_prepare_install(uuid,uuid,uuid,text,text,text,integer) from public,anon,authenticated;
revoke execute on function public.fn_extensions_finish_install(uuid,uuid,jsonb,text,integer,text) from public,anon,authenticated;
revoke execute on function public.fn_extensions_fail_install(uuid,uuid,text) from public,anon,authenticated;
revoke execute on function public.fn_extensions_cancel_install(uuid,uuid) from public,anon,authenticated;
revoke execute on function public.fn_extensions_configure(uuid,uuid,uuid,uuid,integer,boolean,jsonb) from public,anon,authenticated;
revoke execute on function public.fn_extensions_revert_install(uuid,uuid,uuid,integer) from public,anon,authenticated;
revoke execute on function public.fn_extensions_remove_installation(uuid,uuid,uuid,integer) from public,anon,authenticated;
revoke execute on function public.fn_extensions_installation_counts(uuid) from public,anon,authenticated;
grant execute on function public.fn_extensions_admit_catalog(uuid,uuid,jsonb,text) to service_role;
grant execute on function public.fn_extensions_prepare_install(uuid,uuid,uuid,text,text,text,integer) to service_role;
grant execute on function public.fn_extensions_finish_install(uuid,uuid,jsonb,text,integer,text) to service_role;
grant execute on function public.fn_extensions_fail_install(uuid,uuid,text) to service_role;
grant execute on function public.fn_extensions_cancel_install(uuid,uuid) to service_role;
grant execute on function public.fn_extensions_configure(uuid,uuid,uuid,uuid,integer,boolean,jsonb) to service_role;
grant execute on function public.fn_extensions_revert_install(uuid,uuid,uuid,integer) to service_role;
grant execute on function public.fn_extensions_remove_installation(uuid,uuid,uuid,integer) to service_role;
grant execute on function public.fn_extensions_installation_counts(uuid) to service_role;
