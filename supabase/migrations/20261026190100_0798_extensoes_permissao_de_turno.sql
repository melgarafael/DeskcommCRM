-- manifest: **A permissão NOMEADA do turno e o ACEITE explícito da organização (#3076).** `turn.send` e `turn.handoff` entram no conjunto fechado de `fn_extensions_permissoes_validas` (8 → 11 nomes), espelhando `lib/extensions/capacidades.ts`; `organization_extensions` ganha `accepted_permissions text[] not null default '{}'` com CHECK que aceita o vazio e exige o mesmo vocabulário quando há conteúdo — a coluna nasce VAZIA de propósito, porque nenhuma instalação anterior aceitou permissão de turno (backfill transformaria instalação em autorização, que é o que o #3456 recusou). `fn_extensions_configure` ganha `p_accepted_permissions` (nulo = não concede nada agora, preservando o aceite vigente), recusa `extension_invalid_input` para nome fora do manifesto e `extension_permission_not_accepted` na ATIVAÇÃO de fluxo sem cobertura, derivada do DESFECHO (`turn.send` para encerrar, `turn.send`+`turn.handoff` para passar a humano). Desativar nunca é bloqueado. Idempotente; apêndice espelhado no `baseline.sql` (coluna, CHECK e as duas funções); `MANIFEST.md` é histórico e não recebe linha.

-- 0767 — A permissão NOMEADA do turno e o ACEITE da organização (issue #3076)
--
-- O defeito que esta migration ajuda a fechar foi medido e recusado no PR #3456: o manifesto
-- passou a aceitar `contributions.turn_flow` sem permissão nova, e a ativação genérica de uma
-- extensão (a mesma que abre uma tela no menu) autorizava a extensão a RESPONDER AO CLIENTE e a
-- ENTREGAR A CONVERSA a uma pessoa. A doutrina de extensões (item 3) é literal: **instalar não é
-- autorizar**; e (item 6-bis) o efeito tem de ter concessão explícita, não herdada da ativação.
--
-- Três mudanças, todas conservadoras:
--
-- 1. `turn.send` e `turn.handoff` entram no CONJUNTO FECHADO de permissões
--    (`fn_extensions_permissoes_validas`), espelhando `lib/extensions/capacidades.ts` — a mesma
--    lista dos dois lados é um invariante (`tests/invariants/…`, e `consentimento.test.ts`).
--    `turn.handoff` é o efeito mais largo: quem passa a conversa a uma pessoa precisa também de
--    `turn.send`, porque o aviso ao contato sai pelo mesmo turno. A derivação está no TypeScript
--    (`permissoesDoFluxo`), e o banco exige a COBERTURA na ativação — nenhum dos dois lados
--    aceita "só handoff".
--
-- 2. `organization_extensions.accepted_permissions` — o ACEITE do dono da organização, coluna
--    própria, default `{}`. Ela nasce VAZIA de propósito: nenhuma instalação anterior aceitou
--    permissão de turno, porque nenhuma podia pedir (o vocabulário não existia). Fazer backfill
--    com o que o manifesto declara seria transformar instalação em autorização — exatamente o que
--    o mantenedor recusou. As permissões de navegação/tema/dados continuam cobertas pelo ato de
--    instalar/ativar; só as de EFEITO pedem este aceite.
--
-- 3. `fn_extensions_configure` ganha `p_accepted_permissions` e passa a recusar a ATIVAÇÃO de um
--    fluxo cujas permissões não estejam aceitas (`extension_permission_not_accepted`). É a mesma
--    regra do runtime (`lib/extensions/consentimento.ts`), escrita duas vezes de propósito: o app
--    não é a última linha de defesa de um efeito que fala com o cliente. Desativar NUNCA é
--    bloqueado — a reversão é o que garante que a organização pode voltar atrás sem aceitar nada.
--
-- Sem backfill, sem coluna em `extension_artifacts` (o manifesto continua sendo a fonte do que o
-- pacote PEDE; a coluna guarda o que a organização ACEITOU), sem mudança de `kind` em
-- `extension_operations` (o aceite viaja no mesmo recibo `configure`).
--
-- Idempotente: `create or replace`, `drop function if exists` da assinatura antiga, `add column if
-- not exists` e `drop/add constraint if exists`.

-- Adaptação forward-aware da fonte #3474: este arquivo é proposta não aplicada na
-- main. O nome opcional `turn.context` precisa estar aqui ANTES de recriar o CHECK:
-- re-aplicar o baseline sobre aceite já gravado pela 0800 deve passar também com
-- ON_ERROR_STOP=1. Admitir o nome não concede leitura; nenhum aceite é preenchido.
-- A fonte original 0767 permanece no commit 0d93c5489d, com crédito a @webtecnica.
-- ── 1. O conjunto fechado cresce de 8 para 11 nomes ────────────────────────────────────────────
create or replace function public.fn_extensions_permissoes_validas(p_permissions jsonb)
returns boolean language sql immutable set search_path = public, pg_temp as $$
  select p_permissions is not null
    and jsonb_typeof(p_permissions) = 'array'
    and jsonb_array_length(p_permissions) between 1 and 11
    and not exists (
      select 1 from jsonb_array_elements(p_permissions) e
      where jsonb_typeof(e.value) <> 'string'
         or e.value #>> '{}' not in (
              'navigation.tasks', 'navigation.inbox', 'navigation.kanban',
              'navigation.contacts', 'navigation.agenda', 'navigation.radar',
              'theme.apply', 'dados.proprios',
              'turn.send', 'turn.handoff', 'turn.context')
    )
    and (select count(distinct e.value) from jsonb_array_elements(p_permissions) e)
        = jsonb_array_length(p_permissions);
$$;

revoke execute on function public.fn_extensions_permissoes_validas(jsonb) from public, anon;
revoke execute on function public.fn_extensions_permissoes_validas(jsonb) from authenticated;
grant execute on function public.fn_extensions_permissoes_validas(jsonb) to service_role;

-- ── 2. O aceite é uma coluna da ORGANIZAÇÃO, não do pacote ────────────────────────────────────
alter table public.organization_extensions
  add column if not exists accepted_permissions text[] not null default '{}';

-- O CHECK aceita o vazio (nada aceito ainda) e, quando há conteúdo, exige o MESMO conjunto
-- fechado do manifesto — inclusive unicidade. Sem isso, uma linha gravada por outro caminho
-- (SQL manual, RPC futura) poderia carregar um nome inventado e o runtime o trataria como
-- concessão.
alter table public.organization_extensions
  drop constraint if exists organization_extensions_accepted_permissions_check;
alter table public.organization_extensions
  add constraint organization_extensions_accepted_permissions_check
  check (
    cardinality(accepted_permissions) = 0
    or public.fn_extensions_permissoes_validas(to_jsonb(accepted_permissions))
  );

comment on column public.organization_extensions.accepted_permissions is
  'Permissões de EFEITO (turn.send/turn.handoff) que o dono da organização aceitou explicitamente. Vazio = nenhuma. A ativação não preenche esta coluna (#3076).';

-- ── 3. O gravador da configuração passa a exigir COBERTURA para ativar um fluxo ────────────────
drop function if exists public.fn_extensions_configure(uuid,uuid,uuid,uuid,integer,boolean,jsonb);

create or replace function public.fn_extensions_configure(
  p_actor uuid, p_organization uuid, p_installation uuid, p_operation uuid,
  p_expected_revision integer, p_enabled boolean, p_configuration jsonb,
  p_accepted_permissions jsonb default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_request jsonb := jsonb_build_object('kind','configure','actor',p_actor,'organization',p_organization,
    'installation',p_installation,'expected_revision',p_expected_revision,'enabled',p_enabled,
    'configuration',p_configuration,'accepted_permissions',p_accepted_permissions);
  v_op public.extension_operations; v_link public.organization_extensions; v_config jsonb; v_manifest jsonb;
  v_removed_at timestamptz;
  v_accepted text[];
  v_required text[];
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

  -- O aceite vigente. `p_accepted_permissions` nulo = "não estou aceitando nada agora";
  -- o que já estava aceito permanece (uma troca de densidade não revoga concessão).
  v_accepted := coalesce(v_link.accepted_permissions, '{}'::text[]);
  if p_accepted_permissions is not null then
    -- Só se aceita o que o PACOTE pede e o vocabulário conhece. Aceitar um nome que o manifesto
    -- não declara seria conceder autoridade para um efeito que a versão vigente não tem — e o
    -- contrário (aceitar sem o pacote pedir) é a "ativação genérica" que o #3456 recusou.
    if jsonb_typeof(p_accepted_permissions) <> 'array'
      or jsonb_array_length(p_accepted_permissions) = 0
      or not public.fn_extensions_permissoes_validas(p_accepted_permissions)
      or exists (
        select 1 from jsonb_array_elements_text(p_accepted_permissions) e
        where not (coalesce(v_manifest->'permissions','[]'::jsonb) ? e)
      ) then
      raise exception using errcode='P0001',message='extension_invalid_input';
    end if;
    v_accepted := array(select jsonb_array_elements_text(p_accepted_permissions));
  end if;

  -- A COBERTURA, derivada do DESFECHO do fluxo (nunca de um campo paralelo): encerrar a coleta
  -- pede `turn.send`; passar para humano pede `turn.send` + `turn.handoff`. Ativar sem cobertura
  -- é o caso do #3456, e aqui ele morre antes de qualquer turno acontecer.
  if v_manifest->'contributions'->'turn_flow' is not null then
    v_required := case
      when v_manifest->'contributions'->'turn_flow'->'desfecho'->>'tipo' = 'passar_para_humano'
        then array['turn.send','turn.handoff']
      else array['turn.send']
    end;
    if p_enabled and not (v_required <@ v_accepted) then
      raise exception using errcode='P0001',message='extension_permission_not_accepted';
    end if;
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
  insert into public.organization_extensions(organization_id,installation_id,enabled,configuration,accepted_permissions,revision,updated_by)
    values(p_organization,p_installation,p_enabled,v_config,v_accepted,p_expected_revision+1,p_actor)
    on conflict (organization_id,installation_id) do update set enabled=excluded.enabled,configuration=excluded.configuration,
      accepted_permissions=excluded.accepted_permissions,
      revision=excluded.revision,updated_by=excluded.updated_by,updated_at=now(),
      -- Ativar apaga a marca da remoção; desativar ou mudar a densidade a preserva.
      deactivated_by_removal_at=case when excluded.enabled then null else organization_extensions.deactivated_by_removal_at end
    returning * into v_link;
  insert into public.extension_operations(id,kind,status,actor_id,organization_id,installation_id,request,request_fingerprint,result)
    values(p_operation,'configure','completed',p_actor,p_organization,p_installation,v_request,
      public.fn_extensions_fingerprint(v_request),jsonb_build_object('organization_extension',to_jsonb(v_link))) returning * into v_op;
  return to_jsonb(v_op) || jsonb_build_object('applied_now', true);
end $$;

revoke execute on function public.fn_extensions_configure(uuid,uuid,uuid,uuid,integer,boolean,jsonb,jsonb) from public, anon;
revoke execute on function public.fn_extensions_configure(uuid,uuid,uuid,uuid,integer,boolean,jsonb,jsonb) from authenticated;
grant execute on function public.fn_extensions_configure(uuid,uuid,uuid,uuid,integer,boolean,jsonb,jsonb) to service_role;

-- ── 4. A view/link que o app lê precisa enxergar o aceite ─────────────────────────────────────
-- `organization_extensions` já é lida com `select *` no app; a política de RLS não muda (o aceite
-- é dado da própria organização). Nenhum grant novo: a coluna entra no mesmo SELECT que a tela de
-- gestão já faz.
