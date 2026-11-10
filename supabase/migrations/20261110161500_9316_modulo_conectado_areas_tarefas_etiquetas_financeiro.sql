-- manifest: **Módulo conectado, 3 áreas novas: `tarefas`, `etiquetas` e `financeiro` (spec 33).** O vocabulário de áreas passa de 9 para 12 (cada uma com leitura e escrita, 18 → 24 permissões `area.<área>.<leitura|escrita>`; com as 8 de hoje, 26 → 32). `fn_extensions_permissoes_validas` aceita as 6 permissões novas e o teto `between 1 and 26` vira `between 1 and 32`; o CHECK `organization_extensions_consented_areas_check` é refeito com as 24; `fn_extensions_set_consent` passa a exigir `admin`/`owner` também para `area.financeiro.*` (o regex `'^area\.(configuracao|agentes_ia)\.'` vira `'^area\.(configuracao|agentes_ia|financeiro)\.'`: dinheiro é área sensível, como configuração e agentes de IA). Só `create or replace` das duas funções (corpos copiados das ÚLTIMAS definições do baseline, a 9115 e a 9119) e `drop constraint if exists` + `add constraint`; ACL das funções preservada; sem tabela nova; sem dado a corrigir (as áreas já consentidas, as 18 antigas, continuam dentro do CHECK novo). Espelho idempotente no apêndice do `supabase/baseline.sql`. Prova em `tests/invariants/extensoes-consentimento.test.ts` e `tests/invariants/extensoes-conectado.test.ts`.
-- ============================================================================
-- 9316 — MÓDULO CONECTADO: as áreas `tarefas`, `etiquetas` e `financeiro`.
--
-- Spec: docs/specs/33-spec-modulo-conectado.md (seção F3, lista de áreas). Racional completo no cabeçalho
-- das migrations 9115 (vocabulário de permissões) e 9119 (consentimento). As duas funções abaixo são
-- reescritas INTEIRAS a partir da última definição vigente no baseline (a última, não a primeira
-- ocorrência), com a alteração mínima. `create or replace` mantém os grants existentes; os revokes e o
-- grant são repetidos de propósito (idempotentes) para a ACL ficar explícita nesta migration: função em
-- `public` nasce exposta (ALTER DEFAULT PRIVILEGES do baseline dá EXECUTE a `anon`, e o Postgres dá a
-- PUBLIC). Idempotente.
-- ============================================================================

create or replace function public.fn_extensions_permissoes_validas(p_permissions jsonb)
returns boolean language sql immutable set search_path = public, pg_temp as $$
  select p_permissions is not null
    and jsonb_typeof(p_permissions) = 'array'
    and jsonb_array_length(p_permissions) between 1 and 32
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
              'area.analise.leitura', 'area.analise.escrita',
              'area.tarefas.leitura', 'area.tarefas.escrita',
              'area.etiquetas.leitura', 'area.etiquetas.escrita',
              'area.financeiro.leitura', 'area.financeiro.escrita')
    )
    and (select count(distinct e.value) from jsonb_array_elements(p_permissions) e)
        = jsonb_array_length(p_permissions);
$$;

revoke execute on function public.fn_extensions_permissoes_validas(jsonb) from public, anon;
revoke execute on function public.fn_extensions_permissoes_validas(jsonb) from authenticated;
grant execute on function public.fn_extensions_permissoes_validas(jsonb) to service_role;

alter table public.organization_extensions drop constraint if exists organization_extensions_consented_areas_check;
alter table public.organization_extensions add constraint organization_extensions_consented_areas_check
  check (consented_areas <@ array[
    'area.contatos.leitura','area.contatos.escrita',
    'area.negocios.leitura','area.negocios.escrita',
    'area.conversas.leitura','area.conversas.escrita',
    'area.agenda.leitura','area.agenda.escrita',
    'area.funis.leitura','area.funis.escrita',
    'area.agentes_ia.leitura','area.agentes_ia.escrita',
    'area.catalogo.leitura','area.catalogo.escrita',
    'area.configuracao.leitura','area.configuracao.escrita',
    'area.analise.leitura','area.analise.escrita',
    'area.tarefas.leitura','area.tarefas.escrita',
    'area.etiquetas.leitura','area.etiquetas.escrita',
    'area.financeiro.leitura','area.financeiro.escrita'
  ]::text[]);

create or replace function public.fn_extensions_set_consent(p_actor uuid, p_organization uuid, p_installation uuid,
  p_expected_revision integer, p_areas text[])
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_manifest jsonb; v_removed_at timestamptz; v_declaradas text[]; v_link public.organization_extensions; v_role text;
begin
  if p_organization is null or p_installation is null or p_expected_revision is null or p_expected_revision < 0
    or p_areas is null or array_position(p_areas, null) is not null
    or cardinality(p_areas) <> (select count(distinct a) from unnest(p_areas) a) then
    raise exception using errcode='P0001',message='extension_invalid_input';
  end if;
  perform public.fn_extensions_assert_actor(p_actor,p_organization);
  -- A organização é travada como em `fn_extensions_configure`: consentir e ativar/desativar/remover não se cruzam.
  perform 1 from public.organizations where id=p_organization for update;
  perform public.fn_extensions_assert_actor(p_actor,p_organization);
  select i.removed_at, a.manifest into v_removed_at, v_manifest
    from public.extension_installations i join public.extension_artifacts a on a.id=i.artifact_id
    where i.id=p_installation for share of i;
  if not found then raise exception using errcode='P0001',message='extension_installation_not_found'; end if;
  if v_removed_at is not null then raise exception using errcode='P0001',message='extension_removed'; end if;
  -- O perfil vem do ARTEFATO admitido. Só o `connected` tem áreas.
  if v_manifest->>'profile' is distinct from 'connected' then
    raise exception using errcode='P0001',message='extension_consent_not_applicable';
  end if;
  select * into v_link from public.organization_extensions
    where organization_id=p_organization and installation_id=p_installation for update;
  if not found then raise exception using errcode='P0001',message='extension_not_activated'; end if;
  if v_link.revision <> p_expected_revision then
    raise exception using errcode='P0001',message='extension_revision_conflict';
  end if;
  -- "Declarado" = as permissões `area.*` do manifesto do artefato desta instalação.
  select coalesce(array_agg(distinct p), array[]::text[]) into v_declaradas
    from jsonb_array_elements_text(coalesce(v_manifest->'permissions','[]'::jsonb)) p where p like 'area.%';
  if exists (select 1 from unnest(p_areas) a where a <> all (v_declaradas)) then
    raise exception using errcode='PT409',message='extension_area_not_declared';
  end if;
  -- Decisão 5 da spec 33: configuração, agentes de IA e financeiro só por quem administra a organização.
  if exists (select 1 from unnest(p_areas) a where a ~ '^area\.(configuracao|agentes_ia|financeiro)\.') then
    select u.role into v_role from public.user_organizations u
      where u.user_id=p_actor and u.organization_id=p_organization and u.revoked_at is null and u.accepted_at is not null;
    if v_role is distinct from 'admin' and v_role is distinct from 'owner' then
      raise exception using errcode='PT409',message='extension_area_requires_admin';
    end if;
  end if;
  update public.organization_extensions
    set consented_areas=(select coalesce(array_agg(a order by a), array[]::text[]) from unnest(p_areas) a),
        revision=revision+1, updated_by=p_actor, updated_at=now()
    where organization_id=p_organization and installation_id=p_installation
    returning * into v_link;
  return jsonb_build_object('organization_extension', to_jsonb(v_link));
end $$;

revoke execute on function public.fn_extensions_set_consent(uuid,uuid,uuid,integer,text[]) from public, anon, authenticated;
grant execute on function public.fn_extensions_set_consent(uuid,uuid,uuid,integer,text[]) to service_role;

notify pgrst, 'reload schema';
