-- manifest: **Módulo conectado, F1 — o banco aceita o perfil `connected` e a origem do serviço.** `fn_extensions_permissoes_validas` passa a aceitar as 26 permissões (as 8 de hoje + 18 `area.<área>.<leitura|escrita>`, espelho de `EXTENSION_PERMISSIONS`); `fn_extensions_admit_catalog` aceita a chave `service_origin` na entrada do catálogo (origem exata, mesmo regex de `origin`); `fn_extensions_finish_install` aceita `profile='connected'` (só permissão de área, `data` none, sem `density`, sem `crm_cards` nem `theme`), recusa permissão de área nos outros dois perfis e exige `(profile='connected') = (entrada tem service_origin)`. Só `create or replace` das três funções (corpos copiados das últimas definições do baseline); grants preservados; sem tabela nova; espelho no apêndice do `supabase/baseline.sql`.
-- ============================================================================
-- 9115 — MÓDULO CONECTADO, F1: o perfil `connected` no banco.
--
-- Um módulo `connected` é um serviço externo que lê/altera ÁREAS do CRM (spec 33). O manifesto
-- continua com as treze chaves; o endereço do serviço NÃO mora no pacote (ADR-0003, D3) e sim na
-- ENTRADA do catálogo revisado, em `service_origin`. O banco passa a dizer o mesmo que
-- `lib/extensions/manifest.ts` e `lib/extensions/capacidades.ts`:
--
-- 1. 26 permissões, na mesma ordem e com os mesmos nomes de EXTENSION_PERMISSIONS.
-- 2. `service_origin` é chave opcional da entrada, com o mesmo regex da `origin` do catálogo.
-- 3. `connected` só declara permissão de área, e permissão de área nos perfis `declarative` e `data`
--    é recusada; entrada com `service_origin` só vale para pacote `connected`, e todo pacote
--    `connected` precisa dela.
--
-- As três funções são reescritas INTEIRAS a partir da última definição vigente do baseline
-- (a última, não a primeira ocorrência), com a alteração mínima. `create or replace` mantém os
-- grants existentes (revoke de public/anon/authenticated, grant só a service_role): nada muda.
-- Idempotente.

create or replace function public.fn_extensions_permissoes_validas(p_permissions jsonb)
returns boolean language sql immutable set search_path = public, pg_temp as $$
  select p_permissions is not null
    and jsonb_typeof(p_permissions) = 'array'
    and jsonb_array_length(p_permissions) between 1 and 26
    and not exists (
      select 1 from jsonb_array_elements(p_permissions) e
      where jsonb_typeof(e.value) <> 'string'
         or e.value #>> '{}' not in (
              'navigation.tasks', 'navigation.inbox', 'navigation.kanban',
              'navigation.contacts', 'navigation.agenda', 'navigation.radar',
              'theme.apply', 'dados.proprios',
              'area.contatos.leitura', 'area.contatos.escrita',
              'area.negocios.leitura', 'area.negocios.escrita',
              'area.conversas.leitura', 'area.conversas.escrita',
              'area.agenda.leitura', 'area.agenda.escrita',
              'area.funis.leitura', 'area.funis.escrita',
              'area.agentes_ia.leitura', 'area.agentes_ia.escrita',
              'area.catalogo.leitura', 'area.catalogo.escrita',
              'area.configuracao.leitura', 'area.configuracao.escrita',
              'area.analise.leitura', 'area.analise.escrita')
    )
    and (select count(distinct e.value) from jsonb_array_elements(p_permissions) e)
        = jsonb_array_length(p_permissions);
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
      or v_entry - array['publisher','name','version','license','host_api','display','permissions','sha256','byte_length','publisher_label','homepage','repository','tags','published_at','service_origin'] <> '{}'::jsonb
      or exists (select 1 from jsonb_each(v_entry) e where e.value='null'::jsonb)
      -- 9115: a origem do serviço de um módulo `connected`, mesma forma da origem do catálogo.
      or (v_entry ? 'service_origin' and (jsonb_typeof(v_entry->'service_origin') is distinct from 'string'
        or v_entry->>'service_origin' !~ '^https?://[^/@?#[:space:]]+$'))
      or jsonb_typeof(v_entry->'byte_length') is distinct from 'number'
      or jsonb_typeof(v_entry->'host_api') is distinct from 'object'
      or jsonb_typeof(v_entry->'display') is distinct from 'object'
      or v_entry->>'publisher' !~ '^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$'
      or v_entry->>'name' !~ '^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$'
      or v_entry->>'version' !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
      or v_entry->>'sha256' !~ '^[a-f0-9]{64}$'
      or v_entry->>'byte_length' !~ '^[1-9][0-9]{0,4}$'
      or v_entry->>'license' <> 'MIT' or not public.fn_extensions_permissoes_validas(v_entry->'permissions') then
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
    or p_manifest->'format_version' is distinct from '1'::jsonb -- 0611: dois perfis. `declarative` segue igual; `data` declara objetos na chave `data`.
    or p_manifest->>'profile' not in ('declarative','data','connected')
    or jsonb_typeof(p_manifest->'configuration') is distinct from 'object'
    or jsonb_typeof(p_manifest->'contributions') is distinct from 'object'
    or p_manifest->>'publisher' is distinct from v_op.publisher or p_manifest->>'name' is distinct from v_op.name
    or p_manifest->>'version' is distinct from v_op.version
    or p_manifest->'dependencies' <> '[]'::jsonb
    or (p_manifest->>'profile' = 'declarative' and p_manifest->'data' <> '{"mode":"none"}'::jsonb)
    or (p_manifest->>'profile' = 'data' and (
         p_manifest->'data'->>'mode' is distinct from 'declarado'
         or jsonb_typeof(p_manifest->'data'->'objetos') is distinct from 'array'
         or jsonb_array_length(p_manifest->'data'->'objetos') < 1))
    -- 0511: projeta os dois lados sobre as chaves que a ENTRADA do catálogo anuncia. Comparar os
    -- complementos fazia todo campo de vitrine da 0282 (publisher_label, homepage, repository,
    -- tags, published_at) divergir, e nenhuma entrada do catálogo oficial instalava.
    or exists (
      select 1 from unnest(array['publisher','name','version','license','host_api','display','permissions']) k
      where p_manifest->k is distinct from v_op.entry->k
    ) then
    raise exception using errcode='P0001',message='extension_artifact_mismatch';
  end if;
  -- 9115 — perfil `connected` (spec 33). Segundo `if` e não mais uma linha do primeiro: aqui a forma do
  -- manifesto já foi provada (`permissions` é igual ao da entrada, que a admissão validou como array),
  -- então `jsonb_array_elements_text` não corre o risco de errar por tipo antes da recusa.
  -- As mesmas regras de `lib/extensions/manifest.ts`: `connected` só declara permissão de área, não
  -- declara dados, não tem configuração de card nem contribui card ou tema; permissão de área nos
  -- outros perfis é recusada; e a entrada do catálogo tem `service_origin` se, e somente se, o
  -- pacote é `connected` (o endereço do serviço não pode pegar carona em pacote que não é conectado).
  if (p_manifest->>'profile' = 'connected') is distinct from (v_op.entry ? 'service_origin')
    or (p_manifest->>'profile' = 'connected' and (
         exists (select 1 from jsonb_array_elements_text(p_manifest->'permissions') perm where perm not like 'area.%')
         or p_manifest->'data' is distinct from '{"mode":"none"}'::jsonb
         or p_manifest->'configuration' ? 'density'
         or p_manifest->'contributions' ? 'crm_cards'
         or p_manifest->'contributions' ? 'theme'))
    or (p_manifest->>'profile' <> 'connected'
         and exists (select 1 from jsonb_array_elements_text(p_manifest->'permissions') perm where perm like 'area.%')) then
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
    -- A recusa que a spec v1 prometeu para "quando o contrato admitir outra permissão".
    -- Sem ela, 1.0 -> 1.1 acrescentaria uma porta sem ninguém na organização rever a lista
    -- que a tela existe para mostrar: o furo entra pela porta lateral da própria propriedade
    -- que a lista de permissões garante. Mudar o conjunto de portas é outra extensão.
    if v_op.kind='update' and v_current.id is not null
      and v_current.manifest->'permissions' is distinct from p_manifest->'permissions' then
      raise exception using errcode='P0001',message='extension_permissions_changed';
    end if;
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
  -- 0611 — O EFEITO do perfil `data`, na MESMA transação do recibo.
  if p_manifest->>'profile' = 'data' then
    perform public.fn_modulo_dados_compilar(v_artifact.id);
  end if;
  update public.extension_operations set status='completed',installation_id=v_install.id,
    result=coalesce(v_op.result,'{}'::jsonb) || jsonb_build_object('installation',to_jsonb(v_install),
      'to_artifact_id',v_artifact.id,'to_version',v_op.version,'organizations_active',v_active),
    updated_at=now() where id=p_operation returning * into v_op;
  return to_jsonb(v_op) || jsonb_build_object('applied_now', true);
end $$;
