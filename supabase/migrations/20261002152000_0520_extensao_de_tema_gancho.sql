-- 0520 — Extensão declarativa ganha o GANCHO de tema (issue #1095)
-- manifest: **A extensão declarativa ganha o GANCHO de tema (issue #1095) — com a condição do dono fechada por teste.** O perfil v1 aceitava `contributions.crm_cards`; um pacote não tinha como oferecer um TEMA (tokens de cor), nem o banco guardaria "qual paleta" por organização. A contribuição `contributions.theme` = `{ palette, claro: {tokens}, escuro: {tokens} }`: a chave é uma allowlist (`--color-bg`/`--color-surface-elevated`, a rampa `--color-accent-50..950`, `--color-accent/fg/soft/hover`) e CADA valor passa pela MESMA régua da marca (`ehFormaDeValorPermitida` de `lib/branding/formas-de-valor.ts`, extraída de `css.ts` — #rrggbb/#rgb()/#rgba()/`var(--nome)`; cada `--nome` passa por `ehNomeDeToken`), então o texto que vira `dangerouslySetInnerHTML` é o MESMO que o produto já classifica de seguro. A permissão `theme.apply` entra no conjunto fechado (espelha `lib/extensions/capacidades.ts`, 7 nomes). Três mudanças no barco: **1) `fn_extensions_permissoes_validas`** +`theme.apply`, `between 1 and 7`; **2)** CHECK de `organization_extensions.configuration` de `{density, show_description}` para `{density, show_description, theme?}` — `theme` opcional e restrito às 5 paletas do laboratório (`sage/clay/mist/plum/olive`); **3) `fn_extensions_configure`** revalida com a mesma régua. Nenhuma coluna nova — o TEMA mora no jsonb `configuration` (o "qual paleta" da organização). A APLICAÇÃO é `cssDaExtensaoDeTema`/`temaAplicavel` em `lib/extensions/tema.ts` + o componente `EstiloDoTemaDaExtensao` injetado no `app/app/layout.tsx` AO LADO do bloco da marca: quem não escolheu tema não emite marcador `[data-tema-extensao]` nem o `<style>` — é a condição do dono, e ela é TESTADA (sabotagem medida).
--
-- O perfil declarativo v1 aceitava só cards; um pacote não tinha como oferecer
-- um TEMA. Esta migration abre o contrato do banco para a contribuição
-- `contributions.theme`, em três movimentos conservadores (a spec de evolução
-- está em docs/specs/extensoes-declarativas-v1.md:86):
--
-- 1. A permissão `theme.apply` entra no conjunto fechado de permissões
--    (`fn_extensions_permissoes_validas`), espelhando o `lib/extensions/
--    capacidades.ts`. A MESMA lista dos dois lados é um invariante
--    (`tests/invariants/vocabulario-banco-x-typescript.test.ts`).
-- 2. `organization_extensions.configuration` passa a admitir UMA chave
--    opcional `theme` = a paleta escolhida pela organização. Antes o CHECK
--    aceitava exatamente `{density, show_description}`; agora admite também
--    `theme` — e só estes três. `null`/fora das cinco paletas é recusado.
-- 3. `fn_extensions_configure` revalida a configuração com a mesma régua
--    ampliada — quem grava a paleta passa pelo MESMO filtro do CHECK da tabela.
--
-- Idempotente: `create or replace` e `drop/add constraint if exists`.
-- A coluna `theme` mora DENTRO do jsonb `configuration`; nenhuma coluna nova.

create or replace function public.fn_extensions_permissoes_validas(p_permissions jsonb)
returns boolean language sql immutable set search_path = public, pg_temp as $$
  select p_permissions is not null
    and jsonb_typeof(p_permissions) = 'array'
    and jsonb_array_length(p_permissions) between 1 and 7
    and not exists (
      select 1 from jsonb_array_elements(p_permissions) e
      where jsonb_typeof(e.value) <> 'string'
         or e.value #>> '{}' not in (
              'navigation.tasks', 'navigation.inbox', 'navigation.kanban',
              'navigation.contacts', 'navigation.agenda', 'navigation.radar',
              'theme.apply')
    )
    and (select count(distinct e.value) from jsonb_array_elements(p_permissions) e)
        = jsonb_array_length(p_permissions);
$$;

-- O CHECK da configuração: o subconjunto de chaves admitido cresce de
-- `{density, show_description}` para `{density, show_description, theme}`,
-- com `theme` opcional e restrito às paletas que o produto conhece.
-- Sem o `drop`, o nome gerado do inline original conviveria com o novo e todo
-- UPDATE daria 23514.
alter table public.organization_extensions drop constraint if exists organization_extensions_configuration_check;
alter table public.organization_extensions add constraint organization_extensions_configuration_check
  check (
    jsonb_typeof(configuration) = 'object'
    and configuration ?& array['density','show_description']
    and configuration - array['density','show_description','theme'] = '{}'::jsonb
    and configuration->>'density' is not null
    and configuration->>'density' in ('comfortable','compact')
    and jsonb_typeof(configuration->'show_description') = 'boolean'
    and (
      not (configuration ? 'theme')
      or configuration->>'theme' in ('sage','clay','mist','plum','olive')
    )
  );

-- O gravador da configuração revalida a paleta com a mesma régua do CHECK.
drop function if exists public.fn_extensions_configure(uuid,uuid,uuid,uuid,integer,boolean,jsonb);
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
  insert into public.extension_operations(id,kind,status,actor_id,organization_id,installation_id,request,request_fingerprint,result)
    values(p_operation,'configure','completed',p_actor,p_organization,p_installation,v_request,
      public.fn_extensions_fingerprint(v_request),jsonb_build_object('organization_extension',to_jsonb(v_link))) returning * into v_op;
  return to_jsonb(v_op) || jsonb_build_object('applied_now', true);
end $$;

revoke execute on function public.fn_extensions_permissoes_validas(jsonb) from public, anon;
revoke execute on function public.fn_extensions_permissoes_validas(jsonb) from authenticated;
grant execute on function public.fn_extensions_permissoes_validas(jsonb) to service_role;
revoke execute on function public.fn_extensions_configure(uuid,uuid,uuid,uuid,integer,boolean,jsonb) from public, anon;
revoke execute on function public.fn_extensions_configure(uuid,uuid,uuid,uuid,integer,boolean,jsonb) from authenticated;
grant execute on function public.fn_extensions_configure(uuid,uuid,uuid,uuid,integer,boolean,jsonb) to service_role;