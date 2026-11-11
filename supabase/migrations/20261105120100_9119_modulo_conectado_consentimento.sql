-- manifest: **Módulo conectado, F3 — o consentimento por área (spec 33, decisão 5).** `organization_extensions` ganha `consented_areas text[] not null default '{}'` com CHECK `organization_extensions_consented_areas_check` (`consented_areas <@` as 18 permissões `area.<área>.<leitura|escrita>` do vocabulário de `lib/extensions/areas.ts`; `configuration` NÃO muda, o CHECK dela segue fechado). `fn_extensions_set_consent(p_actor, p_organization, p_installation, p_expected_revision, p_areas)` grava as áreas que a organização aceitou: o ator precisa administrar a organização (`fn_extensions_assert_actor`); a instalação precisa ser `connected` e não removida; a ativação precisa existir; revisão otimista como `fn_extensions_configure` (`extension_revision_conflict`) e `revision + 1`; `p_areas` sem duplicata e contido nas `area.*` DECLARADAS no manifesto do artefato (PT409 `extension_area_not_declared`); `area.configuracao.*` e `area.agentes_ia.*` só com ator `admin`/`owner` da organização (PT409 `extension_area_requires_admin`). Retirar uma área vale na hora. Devolve `{organization_extension: ...}`. EXECUTE só para `service_role`. Nenhum consumidor ainda (a aplicação em `resolveAuthDual` é a Tarefa 3). Espelho idempotente no apêndice do `supabase/baseline.sql`, depois da 9118 e antes da VARREDURA anon (0116). Prova em `tests/invariants/extensoes-consentimento.test.ts`.
-- ============================================================================
-- 9119 — MÓDULO CONECTADO, F3: o consentimento por área.
--
-- Plano: docs/superpowers/plans/2026-11-05-modulo-conectado-p8-f3-autoridade-por-area.md, Tarefa 1.
-- Um token de módulo só alcança, em cada organização, as áreas que o pacote DECLAROU e a organização
-- CONSENTIU. O consentimento mora em coluna própria (não em `configuration`, que é fechada por CHECK).
-- Função nova em `public` nasce exposta (ALTER DEFAULT PRIVILEGES do baseline dá EXECUTE a `anon`, e o
-- Postgres dá a PUBLIC): as origens são revogadas abaixo. Idempotente.
-- ============================================================================
alter table public.organization_extensions
  add column if not exists consented_areas text[] not null default '{}';
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
    'area.analise.leitura','area.analise.escrita'
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
  -- Decisão 5 da spec 33: configuração e agentes de IA só por quem administra a organização.
  if exists (select 1 from unnest(p_areas) a where a ~ '^area\.(configuracao|agentes_ia)\.') then
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
