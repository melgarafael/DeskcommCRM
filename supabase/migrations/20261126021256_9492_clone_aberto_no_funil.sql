-- manifest: A transferência reutiliza a cópia aberta do mesmo negócio no destino (#5229). Trava a origem durante a decisão e grava o clone, o vínculo e o fechamento na mesma transação. A permissão de sessão continua sendo avaliada pelas policies de crm_leads. Cópias e históricos existentes são preservados.

create index if not exists crm_leads_clone_aberto_no_funil_idx
  on public.crm_leads (organization_id, pipeline_id, (source_metadata->'clonado_de'->>'lead_id'), created_at, id)
  where status = 'open' and source_metadata ? 'clonado_de';

create or replace function public.fn_levar_negocio_para_funil(
  p_org uuid,
  p_origem uuid,
  p_destino uuid,
  p_linha jsonb,
  p_fechamento jsonb,
  p_origem_atualizada_em timestamptz,
  p_sessao jsonb
) returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_origem public.crm_leads%rowtype;
  v_clone public.crm_leads%rowtype;
  v_linha public.crm_leads%rowtype;
  v_vinculos jsonb;
  v_consulta boolean := p_linha is null and p_fechamento is null;
  v_criou boolean := false;
  v_fechou boolean := false;
  v_role text := current_setting('role');
  v_claims text := current_setting('request.jwt.claims', true);
  v_sub text := current_setting('request.jwt.claim.sub', true);
  v_jwt_role text := current_setting('request.jwt.claim.role', true);
begin
  -- A consulta inicial é só leitura. Toda decisão que escreve repete a busca
  -- depois de travar a mesma origem: a segunda transação vê o commit da primeira.
  if v_consulta then
    select * into v_origem from public.crm_leads
     where id = p_origem and organization_id = p_org;
  else
    select * into v_origem from public.crm_leads
     where id = p_origem and organization_id = p_org for no key update;
  end if;

  if v_origem.id is null or v_origem.pipeline_id = p_destino or not exists (
    select 1 from public.crm_pipelines
     where id = p_destino and organization_id = p_org and not is_archived
  ) then
    raise exception 'clone_origem_ou_destino_mudou' using errcode = 'PT409';
  end if;

  select * into v_clone from public.crm_leads
   where organization_id = p_org
     and pipeline_id = p_destino
     and status = 'open'
     and source_metadata ? 'clonado_de'
     and source_metadata->'clonado_de'->>'lead_id' = p_origem::text
   order by created_at, id
   limit 1;

  -- A leitura de negócio também esconde contatos marcados como pessoais,
  -- inclusive para um token da organização. Verifica antes de qualquer escrita.
  if exists (
    select 1 from public.contacts
     where organization_id = p_org and id in (v_origem.contact_id, v_clone.contact_id)
       and is_personal
  ) then
    raise exception 'clone_contato_pessoal' using errcode = 'PT404';
  end if;

  if v_consulta and v_clone.id is null then
    return null;
  end if;
  if v_clone.id is null and p_linha is null then
    raise exception 'clone_destino_mudou' using errcode = 'PT409';
  end if;

  -- Só a rota pode chamar esta função e passa as claims da sessão validada.
  -- O INSERT e o fecho rodam com o papel da sessão e as policies reais
  -- (inclusive sobre o dono que os gatilhos de INSERT atribuírem).
  if p_sessao is not null then
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    perform set_config('request.jwt.claims', p_sessao::text, true);
    set local role authenticated;
    if not exists (select 1 from public.crm_leads where id = p_origem and organization_id = p_org)
       or (v_clone.id is not null and not exists (
         select 1 from public.crm_leads where id = v_clone.id and organization_id = p_org
       )) then
      raise exception 'clone_fora_do_escopo' using errcode = 'PT404';
    end if;
  end if;

  if v_clone.id is null then
    if v_origem.updated_at is distinct from p_origem_atualizada_em
       or (v_origem.status = 'open') <> (p_fechamento is not null) then
      raise exception 'clone_origem_mudou' using errcode = 'PT409';
    end if;
    v_linha := jsonb_populate_record(null::public.crm_leads, p_linha);
    if not exists (
      select 1 from public.crm_stages
       where id = v_linha.stage_id and organization_id = p_org and pipeline_id = p_destino
         and not is_archived and not is_won and not is_lost
    ) then
      raise exception 'clone_etapa_mudou' using errcode = 'PT409';
    end if;

    v_vinculos := jsonb_build_object('clonado_de', jsonb_build_object(
      'lead_id', p_origem, 'pipeline_id', v_origem.pipeline_id
    ));
    if v_linha.source_metadata ? 'movido_para' then
      v_vinculos := v_vinculos || jsonb_build_object('movido_para', v_linha.source_metadata->'movido_para');
    end if;

    insert into public.crm_leads (
      organization_id, pipeline_id, stage_id, title, description, contact_id, value_cents,
      recurring_value_cents, recurring_period, recurring_months, currency, owner_user_id,
      owner_agent_id, owner_kind, assigned_at, expected_close_date, tags, source,
      source_metadata, custom_fields, retomado_de_lead_id, position_in_stage, created_by_user_id
    ) values (
      p_org, p_destino, v_linha.stage_id, v_linha.title, v_linha.description, v_linha.contact_id,
      v_linha.value_cents, v_linha.recurring_value_cents, v_linha.recurring_period,
      v_linha.recurring_months, v_linha.currency, v_linha.owner_user_id, v_linha.owner_agent_id,
      v_linha.owner_kind, v_linha.assigned_at, v_linha.expected_close_date, v_linha.tags, v_linha.source,
      v_linha.source_metadata - 'clonado_de' - 'movido_para', v_linha.custom_fields,
      v_linha.retomado_de_lead_id, v_linha.position_in_stage, v_linha.created_by_user_id
    ) returning * into v_clone;
    v_criou := true;
  end if;

  if v_origem.status = 'open' and p_fechamento is not null then
    if v_origem.updated_at is distinct from p_origem_atualizada_em then
      raise exception 'clone_origem_mudou' using errcode = 'PT409';
    end if;
    v_linha := jsonb_populate_record(null::public.crm_leads, p_fechamento);
    if not exists (
      select 1 from public.crm_stages
       where id = v_linha.stage_id and organization_id = p_org and pipeline_id = v_origem.pipeline_id
         and is_lost and not is_archived
    ) then
      raise exception 'clone_fechamento_mudou' using errcode = 'PT409';
    end if;
    update public.crm_leads
       set stage_id = v_linha.stage_id, position_in_stage = v_linha.position_in_stage,
           lost_reason = v_linha.lost_reason, updated_at = v_linha.updated_at
     where id = p_origem and organization_id = p_org
     returning * into v_origem;
    if not found then
      raise exception 'clone_fora_do_escopo' using errcode = 'PT403';
    end if;
    v_fechou := true;
  end if;

  if p_sessao is not null then
    perform set_config('role', v_role, true);
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
    perform set_config('request.jwt.claim.role', coalesce(v_jwt_role, ''), true);
  end if;

  -- As chaves reservadas são escritas pelo servidor, dentro da MESMA
  -- transação. A recusa de qualquer vínculo desfaz o INSERT e o fecho.
  if v_criou then
    update public.crm_leads
       set source_metadata = source_metadata || v_vinculos
     where id = v_clone.id and organization_id = p_org
     returning * into strict v_clone;
  end if;
  if v_criou or v_fechou then
    update public.crm_leads
       set source_metadata = source_metadata || jsonb_build_object('movido_para', jsonb_build_object(
         'lead_id', v_clone.id, 'pipeline_id', v_clone.pipeline_id, 'stage_id', v_clone.stage_id
       )), updated_at = now()
     where id = p_origem and organization_id = p_org
     returning * into strict v_origem;
  end if;

  return jsonb_build_object('clone', to_jsonb(v_clone), 'origem', to_jsonb(v_origem),
                            'criou', v_criou, 'fechou', v_fechou);
end;
$$;
revoke execute on function public.fn_levar_negocio_para_funil(uuid, uuid, uuid, jsonb, jsonb, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.fn_levar_negocio_para_funil(uuid, uuid, uuid, jsonb, jsonb, timestamptz, jsonb)
  to service_role;
