-- manifest: **Módulo conectado, F2 — as funções do token do módulo (spec 33, decisões 1 e 3).** Três funções novas, `security definer`, `search_path` vazio, EXECUTE só para `service_role`: `fn_extensions_module_token_reserve` (a ativação reserva a vaga viva em `api_tokens`, hash de preimagem desconhecida e validade de 100 anos para contar no teto de 50; a exceção PT409 do gatilho desfaz a ativação inteira), `fn_extensions_module_token_rotate` (a busca troca o hash da vaga; recusa PT409 com ativação desativada, instalação desligada ou removida; reconfere o teto quando a linha estava expirada) e `fn_extensions_module_token_revoke`. Três funções redefinidas com a mesma assinatura e as mesmas respostas: `fn_extensions_configure` (ativar `connected` reserva, desativar revoga; `declarative` não cria token), `fn_extensions_remove_installation` e `fn_extensions_set_switch` (remover e desligar revogam os tokens da instalação em todas as organizações). Nenhuma tabela nova. Espelho idempotente no apêndice do `supabase/baseline.sql`, depois da 9117 e antes da VARREDURA anon (0116). Prova em `tests/invariants/extensoes-token-modulo-funcoes.test.ts`.
-- ============================================================================
-- 9118 — MÓDULO CONECTADO, F2: as funções do token do módulo.
--
-- Plano: docs/superpowers/plans/2026-11-05-modulo-conectado-p7-f2-token-do-modulo.md, Tarefa 2.
-- O schema (colunas, índice único do par, segredo e nonce) é da 9117. Aqui entram as três funções
-- que a ativação, a busca e a revogação usam, e as três funções existentes que passam a chamá-las
-- (a ÚLTIMA definição de cada uma no baseline é a base; só o trecho de token é novo).
--
-- Só o perfil `connected` tem token (o perfil vem do manifesto do artefato). Escopos do token de
-- módulo: `mcp:read`, `role:viewer` e `actor:module:<publisher>/<name>`.
-- Prefixo: o mesmo formato dos tokens da tela (`dsk_` + 8 hex), único por organização.
-- ============================================================================

-- A vaga do token: a ATIVAÇÃO do módulo `connected` numa organização cria uma linha viva em `api_tokens`
-- (dono: a instalação, `created_by` nulo) cujo hash é a sha256 de um texto aleatório descartado, ou seja,
-- ninguém conhece a preimagem e nenhum bearer a abre. A vaga existe para o teto de 50 e para a revogação
-- transacional valerem NA ATIVAÇÃO. `expires_at` de 100 anos porque o gatilho do teto só conta token sem
-- `revoked_at` E não expirado: uma vaga "vencida" não contaria. Idempotente (índice único do par).
create or replace function public.fn_extensions_module_token_reserve(p_organization uuid, p_installation uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_publisher text; v_name text; v_slug text; v_id uuid; v_prefix text; v_tentativa integer := 0;
begin
  if p_organization is null or p_installation is null then
    raise exception using errcode='P0001', message='extension_invalid_input';
  end if;
  select i.publisher, i.name into v_publisher, v_name from public.extension_installations i where i.id = p_installation;
  if not found then raise exception using errcode='P0001', message='extension_installation_not_found'; end if;
  v_slug := v_publisher || '/' || v_name;
  loop
    select t.id into v_id from public.api_tokens t
      where t.organization_id = p_organization and t.extension_installation_id = p_installation and t.revoked_at is null;
    if found then return v_id; end if;
    v_tentativa := v_tentativa + 1;
    v_prefix := 'dsk_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
    begin
      insert into public.api_tokens(organization_id, created_by, extension_installation_id, module_slug, name, prefix,
        token_hash, scopes, expires_at)
        values (p_organization, null, p_installation, v_slug, 'Módulo ' || v_slug, v_prefix,
          sha256(convert_to(gen_random_uuid()::text || clock_timestamp()::text, 'utf8')),
          jsonb_build_array('mcp:read', 'role:viewer', 'actor:module:' || v_slug),
          now() + interval '100 years')
        returning id into v_id;
      return v_id;
    exception when unique_violation then
      -- Prefixo colidido com outro token da organização, ou corrida com outra vaga do mesmo par: o laço
      -- relê o par e, se não houver vaga viva, tenta outro prefixo. O teto (PT409) NÃO é capturado aqui.
      if v_tentativa >= 8 then raise; end if;
    end;
  end loop;
end $$;

-- A busca troca o hash da vaga viva do par pelo hash do token novo (o texto nunca chega ao banco). Recusa
-- (PT409) se a ativação não existe ou está desativada, ou se a instalação foi desligada/removida. Trava a
-- instalação e o vínculo `for share` (serializa com desligar, remover e desativar, que escrevem neles).
-- O `update` não passa pelo gatilho do teto (que é só de INSERT): quando a linha do par já estava expirada,
-- a função reconfere o teto, para o token expirado de um módulo não deixar a organização passar de 50.
-- Sem vaga viva (ativação anterior a esta migration), a função INSERE a linha, e o gatilho aplica o teto.
create or replace function public.fn_extensions_module_token_rotate(p_organization uuid, p_installation uuid,
  p_prefix text, p_hash bytea, p_expires_at timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_publisher text; v_name text; v_slug text; v_removed timestamptz; v_disabled timestamptz;
  v_enabled boolean; v_id uuid; v_expira timestamptz; v_ativos integer;
begin
  if p_organization is null or p_installation is null or p_prefix is null or p_hash is null or p_expires_at is null
    or p_prefix !~ '^dsk_[0-9a-f]{8}$' or octet_length(p_hash) <> 32 or p_expires_at <= now() then
    raise exception using errcode='P0001', message='extension_invalid_input';
  end if;
  select i.publisher, i.name, i.removed_at, i.disabled_at into v_publisher, v_name, v_removed, v_disabled
    from public.extension_installations i where i.id = p_installation for share;
  if not found or v_removed is not null or v_disabled is not null then
    raise exception using errcode='PT409', message='O módulo está desligado, removido ou não existe.';
  end if;
  select e.enabled into v_enabled from public.organization_extensions e
    where e.organization_id = p_organization and e.installation_id = p_installation for share;
  if not found or v_enabled is not true then
    raise exception using errcode='PT409', message='O módulo não está ativado nesta organização.';
  end if;
  v_slug := v_publisher || '/' || v_name;
  select t.id, t.expires_at into v_id, v_expira from public.api_tokens t
    where t.organization_id = p_organization and t.extension_installation_id = p_installation and t.revoked_at is null
    for update;
  if not found then
    insert into public.api_tokens(organization_id, created_by, extension_installation_id, module_slug, name, prefix,
      token_hash, scopes, expires_at)
      values (p_organization, null, p_installation, v_slug, 'Módulo ' || v_slug, p_prefix, p_hash,
        jsonb_build_array('mcp:read', 'role:viewer', 'actor:module:' || v_slug), p_expires_at)
      returning id into v_id;
    return v_id;
  end if;
  if v_expira is not null and v_expira <= now() then
    perform pg_advisory_xact_lock(hashtextextended('api_tokens_teto:' || p_organization::text, 255));
    select count(*)::integer into v_ativos from public.api_tokens t
      where t.organization_id = p_organization and t.revoked_at is null and (t.expires_at is null or t.expires_at > now())
        and t.id <> v_id;
    if v_ativos >= 50 then
      raise exception using errcode='PT409',
        message='Teto de tokens ativos por organização atingido: ' || v_ativos || ' de 50. Revogue um token que não esteja mais em uso (Configurações → Tokens de API → Revogar) para liberar espaço.';
    end if;
  end if;
  update public.api_tokens set prefix = p_prefix, token_hash = p_hash, expires_at = p_expires_at, revoked_at = null,
      revoked_by = null
    where id = v_id;
  return v_id;
end $$;

-- Revoga o token vivo do par. Sem erro se já estiver revogado (ou se nunca existiu).
create or replace function public.fn_extensions_module_token_revoke(p_organization uuid, p_installation uuid, p_by uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.api_tokens set revoked_at = now(), revoked_by = p_by
    where organization_id = p_organization and extension_installation_id = p_installation and revoked_at is null;
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
    or not (v_config ?& array['density','show_description']) or v_config - array['density','show_description','theme'] <> '{}'::jsonb
    or v_config->>'density' is null or v_config->>'density' not in ('comfortable','compact')
    or jsonb_typeof(v_config->'show_description') is distinct from 'boolean'
    or (v_config ? 'theme' and (v_config->>'theme' is null or v_config->>'theme' not in ('sage','clay','mist','plum','olive'))) then
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
  -- Módulo conectado (spec 33, F2): só o perfil `connected` tem token. Ativar reserva a vaga (dispara o teto de
  -- 50 por organização: a exceção PT409 sobe e desfaz a ativação inteira); desativar revoga o token do par.
  if v_manifest->>'profile' = 'connected' then
    if p_enabled then
      perform public.fn_extensions_module_token_reserve(p_organization, p_installation);
    else
      perform public.fn_extensions_module_token_revoke(p_organization, p_installation, p_actor);
    end if;
  end if;
  insert into public.extension_operations(id,kind,status,actor_id,organization_id,installation_id,request,request_fingerprint,result)
    values(p_operation,'configure','completed',p_actor,p_organization,p_installation,v_request,
      public.fn_extensions_fingerprint(v_request),jsonb_build_object('organization_extension',to_jsonb(v_link))) returning * into v_op;
  return to_jsonb(v_op) || jsonb_build_object('applied_now', true);
end $$;

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
  -- Módulo conectado (spec 33, F2): remover revoga o token do módulo em TODAS as organizações. A linha da
  -- instalação não é apagada (só marcada), então a FK de `api_tokens.extension_installation_id` não atrapalha.
  update public.api_tokens set revoked_at = now(), revoked_by = p_actor
    where extension_installation_id = p_installation and revoked_at is null;
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

create or replace function public.fn_extensions_set_switch(p_actor uuid, p_operation uuid, p_installation uuid,
  p_disabled boolean, p_expected_installation_revision integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_request jsonb := jsonb_build_object('kind','switch','actor',p_actor,'installation',p_installation,
    'disabled',p_disabled,'expected_installation_revision',p_expected_installation_revision);
  v_op public.extension_operations; v_install public.extension_installations; v_from public.extension_installations;
  v_profile text;
begin
  perform public.fn_extensions_assert_actor(p_actor);
  if p_operation is null or p_installation is null or p_disabled is null or p_expected_installation_revision is null
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
  -- O perfil vem do ARTEFATO admitido (o manifesto já passou por `fn_extensions_finish_install`).
  select a.manifest->>'profile' into v_profile from public.extension_artifacts a where a.id=v_install.artifact_id;
  if v_profile is distinct from 'connected' then
    raise exception using errcode='P0001',message='extension_switch_not_applicable';
  end if;
  v_from := v_install;
  update public.extension_installations
    set disabled_at = case when p_disabled then coalesce(v_from.disabled_at, now()) else null end,
        disabled_by = case when p_disabled then coalesce(v_from.disabled_by, p_actor) else null end,
        revision = revision+1
    where id=p_installation returning * into v_install;
  -- Módulo conectado (spec 33, F2): desligar revoga o token do módulo em TODAS as organizações (também quando
  -- já estava desligado: é idempotente). Ligar não cria nada: a ativação e a busca do token cuidam disso.
  if p_disabled then
    update public.api_tokens set revoked_at = now(), revoked_by = p_actor
      where extension_installation_id = p_installation and revoked_at is null;
  end if;
  insert into public.extension_operations(id,kind,status,actor_id,catalog_id,installation_id,publisher,name,version,
    request,request_fingerprint,result)
    values(p_operation,'switch','completed',p_actor,v_install.catalog_id,v_install.id,v_install.publisher,v_install.name,
      v_install.version,v_request,public.fn_extensions_fingerprint(v_request),
      jsonb_build_object('installation',to_jsonb(v_install),'from_revision',v_from.revision,'from_version',v_from.version,
        'disabled',p_disabled))
    returning * into v_op;
  return to_jsonb(v_op) || jsonb_build_object('applied_now', true);
end $$;

revoke execute on function public.fn_extensions_module_token_reserve(uuid,uuid) from public, anon, authenticated;
revoke execute on function public.fn_extensions_module_token_rotate(uuid,uuid,text,bytea,timestamptz) from public, anon, authenticated;
revoke execute on function public.fn_extensions_module_token_revoke(uuid,uuid,uuid) from public, anon, authenticated;
revoke execute on function public.fn_extensions_configure(uuid,uuid,uuid,uuid,integer,boolean,jsonb) from public, anon, authenticated;
revoke execute on function public.fn_extensions_remove_installation(uuid,uuid,uuid,integer) from public, anon, authenticated;
revoke execute on function public.fn_extensions_set_switch(uuid,uuid,uuid,boolean,integer) from public, anon, authenticated;
grant execute on function public.fn_extensions_module_token_reserve(uuid,uuid) to service_role;
grant execute on function public.fn_extensions_module_token_rotate(uuid,uuid,text,bytea,timestamptz) to service_role;
grant execute on function public.fn_extensions_module_token_revoke(uuid,uuid,uuid) to service_role;
grant execute on function public.fn_extensions_configure(uuid,uuid,uuid,uuid,integer,boolean,jsonb) to service_role;
grant execute on function public.fn_extensions_remove_installation(uuid,uuid,uuid,integer) to service_role;
grant execute on function public.fn_extensions_set_switch(uuid,uuid,uuid,boolean,integer) to service_role;

notify pgrst, 'reload schema';
