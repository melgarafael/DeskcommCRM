-- manifest: Especialista de roteador publica sem número próprio quando roteador e canal são da mesma organização e o canal está WORKING (#3284, de @lucivan212). Agente comum segue exigindo número.
-- ============================================================================
-- 2026-10-22 — 0749: PUBLICAR MEMBRO DE ROTEADOR SEM NÚMERO PRÓPRIO
--
-- O defeito: o editor de um especialista que é membro de um roteador de
-- intenções avisava que "o campo de número não se aplica", mas o botão
-- Publicar e esta função seguiam exigindo `channel_session_id` na versão. Sem
-- número, `fn_publish_ai_agent_version` levantava `channel_session_not_found`
-- e o especialista nunca saía do rascunho. Escolher um número para contornar
-- era pior: a versão passaria a disputar aquele número com o agente que já
-- atende nele.
--
-- O conserto, um ramo só sobre o corpo da 0592 (mesma assinatura, mesmos
-- grants, mesma conferência de credencial e de modelo, mesma troca atômica):
-- quando a versão não tem número, o canal conferido é o do ROTEADOR do qual o
-- agente é membro. Publica se:
--   - existe linha em `ai_router_members` do agente nesta organização;
--   - o roteador é da MESMA organização (`r.organization_id = p_org_id` no
--     join — `ai_router_members.router_id` é FK simples, então só este filtro
--     impede um membro de apontar para roteador de outra empresa);
--   - o canal do roteador é da mesma organização e está WORKING.
-- O roteador NÃO precisa estar ativo: os membros são publicados antes de
-- ligá-lo. Enquanto ele está inativo, o especialista não atende pelo número,
-- porque a seleção por número exige `channel_session_id` igual ao do canal
-- (`loadPublishedAgentConfig`) e o roteador só entra no turno quando ativo
-- (`loadActiveRouter` filtra `is_active`). A exceção é deliberada: campanha
-- que declare o especialista o carrega pelo id, como qualquer agente de
-- campanha.
--
-- Agente que não é membro de roteador e não tem número continua recusado com
-- `channel_session_not_found`. Com mais de um roteador, prefere o que tem
-- canal WORKING e, entre eles, o mais antigo.
--
-- `create or replace` da versão de 5 argumentos; as de 3 e 4 argumentos só
-- delegam e não mudam. O comentário da coluna `channel_session_id` (0241)
-- dizia que publicar com NULL é sempre recusado: reescrito no fim. Idempotente.
-- Gates: `tests/invariants/rascunho-de-agente-sem-numero.test.ts`,
-- `tests/invariants/membro-de-roteador-sem-numero-nao-atende.test.ts`.
-- ============================================================================

create or replace function public.fn_publish_ai_agent_version(
  p_org_id uuid,
  p_agent_id uuid,
  p_version_id uuid,
  p_platform_credential_verified boolean,
  p_expected_provenance text
)
returns table (
  agent_id uuid,
  version_id uuid,
  previous_version_id uuid,
  published_at timestamptz
)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_agent record;
  v_version record;
  v_credential record;
  v_session record;
  v_model_count integer;
  v_previous_version_id uuid;
  v_published_at timestamptz := now();
begin
  select a.id, a.organization_id, a.published_version_id, a.archived_at
    into v_agent
  from public.ai_agents a
  where a.id = p_agent_id
  for update;

  if not found then
    raise exception 'agent_not_found' using errcode = 'P0001';
  end if;
  if v_agent.organization_id <> p_org_id then
    raise exception 'agent_not_found' using errcode = 'P0001';
  end if;
  if v_agent.archived_at is not null then
    raise exception 'agent_archived' using errcode = 'P0001';
  end if;

  select v.id, v.organization_id, v.agent_id, v.status, v.provider, v.model,
         v.credential_id, v.channel_session_id, v.provisioning_origin
    into v_version
  from public.ai_agent_versions v
  where v.id = p_version_id
  for update;

  if not found then
    raise exception 'version_not_found' using errcode = 'P0001';
  end if;
  if v_version.agent_id <> p_agent_id or v_version.organization_id <> p_org_id then
    raise exception 'version_not_found' using errcode = 'P0001';
  end if;
  if p_expected_provenance is not null and (
    p_expected_provenance not in('onboarding','legacy_reconciliation') or
    v_version.provisioning_origin is distinct from p_expected_provenance or
    (select count(*) from public.ai_agent_versions own_version where own_version.organization_id=p_org_id and own_version.agent_id=p_agent_id)<>1
  ) then raise exception 'existing_version_requires_review' using errcode='P0001';end if;
  if v_version.status not in ('draft', 'superseded') then
    raise exception 'version_invalid_state' using errcode = 'P0001';
  end if;

  if v_version.credential_id is null and p_platform_credential_verified is not true then
    raise exception 'credential_missing' using errcode = 'P0001';
  end if;

  if v_version.credential_id is not null then
  select c.id, c.organization_id, c.provider, c.is_active, c.validated_at,
         c.models_available
    into v_credential
  from public.ai_provider_credentials c
  where c.id = v_version.credential_id;

  if not found or v_credential.organization_id <> p_org_id then
    raise exception 'credential_not_found' using errcode = 'P0001';
  end if;
  if not v_credential.is_active then
    raise exception 'credential_inactive' using errcode = 'P0001';
  end if;
  if v_credential.validated_at is null then
    raise exception 'credential_not_validated' using errcode = 'P0001';
  end if;
  if v_credential.provider <> v_version.provider then
    raise exception 'credential_provider_mismatch' using errcode = 'P0001';
  end if;

  end if;

  -- Especialistas de roteador não têm channel_session_id na própria versão:
  -- o roteador é dono do canal, e o runtime os carrega SOMENTE por agent_id.
  -- Não requerer roteador ATIVO: os membros precisam ser publicados ANTES de
  -- ativá-lo, sem competir com o agente publicado diretamente no canal.
  if v_version.channel_session_id is null then
    select s.id, s.organization_id, s.status
      into v_session
    from public.ai_router_members rm
    join public.ai_routers r
      on r.id = rm.router_id and r.organization_id = p_org_id
    join public.channel_sessions s
      on s.id = r.channel_session_id and s.organization_id = p_org_id
    where rm.agent_id = p_agent_id and rm.organization_id = p_org_id
    order by (s.status = 'WORKING') desc, r.created_at asc, r.id asc
    limit 1;
  else
    select s.id, s.organization_id, s.status
      into v_session
    from public.channel_sessions s
    where s.id = v_version.channel_session_id;
  end if;

  if not found or v_session.organization_id <> p_org_id then
    raise exception 'channel_session_not_found' using errcode = 'P0001';
  end if;
  if v_session.status <> 'WORKING' then
    raise exception 'channel_session_offline' using errcode = 'P0001';
  end if;

  -- `custom` e o login por assinatura consultam um catálogo autenticado ou
  -- específico da empresa; quem confirma que o modelo existe é a lista
  -- gravada na credencial já conferida acima. Não usar `ai_models`, que é
  -- global entre organizações.
  if v_version.provider in ('custom', 'openai-assinatura') then
    if v_version.credential_id is null then
      raise exception 'model_not_found' using errcode = 'P0001';
    end if;
    if not (v_version.model = any(coalesce(v_credential.models_available, '{}'::text[]))) then
      raise exception 'model_not_found' using errcode = 'P0001';
    end if;
  else
    select count(*)
      into v_model_count
    from public.ai_models m
    where m.provider = v_version.provider
      and m.model_id = v_version.model
      and m.deprecated_at is null;

    if v_model_count = 0 then
      raise exception 'model_not_found' using errcode = 'P0001';
    end if;
  end if;

  v_previous_version_id := v_agent.published_version_id;

  if v_previous_version_id is not null and v_previous_version_id <> p_version_id then
    update public.ai_agent_versions
       set status = 'superseded', superseded_at = v_published_at
     where id = v_previous_version_id;
  end if;

  update public.ai_agent_versions
     set status = 'published',
         published_at = v_published_at,
         superseded_at = null
   where id = p_version_id;

  update public.ai_agents
     set published_version_id = p_version_id,
         updated_at = v_published_at
   where id = p_agent_id;

  return query
    select p_agent_id, p_version_id, v_previous_version_id, v_published_at;
end;
$$;

revoke execute on function public.fn_publish_ai_agent_version(uuid,uuid,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.fn_publish_ai_agent_version(uuid,uuid,uuid,boolean,text) to service_role;

comment on column public.ai_agent_versions.channel_session_id is
  'Por qual número este agente atende. NULL = ainda não escolhido (rascunho), ou especialista de roteador, que atende pelo canal do roteador. Publicar com NULL só é aceito para membro de roteador da mesma organização com canal WORKING (fn_publish_ai_agent_version); fora disso, channel_session_not_found.';
