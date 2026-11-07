-- manifest: Nascimento CTWA causal: ancora reservada em messages.metadata, prova imutavel no lead, lead.created atomico e claim exclusivo de LeadSubmitted. A funcao antiga de nascimento e os consumidores de Purchase/etapa permanecem intactos.
-- 0803 — Meta LeadSubmitted do nascimento de uma mensagem inbound com clique real.
-- Porte sobre a main oficial: preserva a definição atual de reenvio e acrescenta somente LeadSubmitted.

alter table public.ad_conversion_dispatches
  add column if not exists claim_token uuid,
  add column if not exists claimed_until timestamptz;

comment on column public.messages.metadata is
  'meta_ctwa_message_v1 e reservado ao ingest service_role: clique real do referral da mensagem inbound. Authenticated pode editar os demais metadados.';
comment on column public.crm_leads.source_metadata is
  'meta_capi_lead_birth_v1 e prova causal reservada, escrita somente pela RPC fn_nascer_lead_da_mensagem. Nao e first-touch.';

create or replace function public.fn_guard_meta_ctwa_message_v1()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.metadata ? 'meta_ctwa_message_v1' and
     (new.direction <> 'inbound' or new.conversation_id is null or new.contact_id is null) then
    raise exception 'meta_ctwa_message_v1_requires_inbound';
  end if;
  if current_user not in ('service_role', 'postgres') and
     (case when tg_op = 'INSERT' then new.metadata ? 'meta_ctwa_message_v1'
           else (new.metadata->'meta_ctwa_message_v1') is distinct from
                (old.metadata->'meta_ctwa_message_v1')
                or ((new.metadata ? 'meta_ctwa_message_v1' or old.metadata ? 'meta_ctwa_message_v1')
                    and (new.organization_id,new.contact_id,new.conversation_id,new.direction)
                        is distinct from
                        (old.organization_id,old.contact_id,old.conversation_id,old.direction)) end) then
    raise exception 'meta_ctwa_message_v1_reserved';
  end if;
  return new;
end;
$$;
revoke execute on function public.fn_guard_meta_ctwa_message_v1() from public, anon, authenticated;
grant execute on function public.fn_guard_meta_ctwa_message_v1() to service_role;
drop trigger if exists trg_guard_meta_ctwa_message_v1 on public.messages;
create trigger trg_guard_meta_ctwa_message_v1 before insert or update of metadata, direction, organization_id, contact_id, conversation_id
  on public.messages for each row execute function public.fn_guard_meta_ctwa_message_v1();

create or replace function public.fn_guard_meta_capi_lead_birth_v1()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (case when tg_op = 'INSERT' then new.source_metadata ? 'meta_capi_lead_birth_v1'
           else (new.source_metadata->'meta_capi_lead_birth_v1') is distinct from
                (old.source_metadata->'meta_capi_lead_birth_v1')
                or ((new.source_metadata ? 'meta_capi_lead_birth_v1' or old.source_metadata ? 'meta_capi_lead_birth_v1')
                    and (new.organization_id,new.contact_id,new.created_at) is distinct from
                        (old.organization_id,old.contact_id,old.created_at)) end) then
    if current_user <> pg_get_userbyid((select proowner from pg_catalog.pg_proc
         where oid = 'public.fn_nascer_lead_da_mensagem(uuid,uuid,uuid,uuid,text,text,jsonb,text[],uuid,uuid)'::regprocedure))
       or current_setting('deskcomm.meta_capi_birth_lead_id', true) is distinct from new.id::text then
      raise exception 'meta_capi_lead_birth_v1_reserved';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function public.fn_guard_meta_capi_lead_birth_v1() from public, anon, authenticated;
grant execute on function public.fn_guard_meta_capi_lead_birth_v1() to service_role;
drop trigger if exists trg_guard_meta_capi_lead_birth_v1 on public.crm_leads;
create trigger trg_guard_meta_capi_lead_birth_v1 before insert or update of source_metadata, organization_id, contact_id, created_at
  on public.crm_leads for each row execute function public.fn_guard_meta_capi_lead_birth_v1();

create or replace function public.fn_nascer_lead_da_mensagem(
  p_org uuid, p_contact uuid, p_pipeline uuid, p_stage uuid, p_title text,
  p_source text, p_source_metadata jsonb, p_tags text[],
  p_message uuid, p_conversation uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_msg public.messages%rowtype;
  v_lead uuid;
  v_click text;
  v_channel text;
begin
  select * into v_msg from public.messages
    where id = p_message and organization_id = p_org
      and contact_id = p_contact and conversation_id = p_conversation
      and direction = 'inbound';
  if not found then
    raise exception 'causal_message_mismatch';
  end if;
  select c.channel into v_channel from public.conversations c
    where c.id = p_conversation and c.organization_id = p_org
      and c.contact_id = p_contact;
  if not found then raise exception 'causal_conversation_mismatch'; end if;
  if not exists (
    select 1 from public.crm_stages s
    where s.id=p_stage and s.organization_id=p_org and s.pipeline_id=p_pipeline
  ) then raise exception 'causal_stage_mismatch'; end if;

  -- A funcao oficial preserva advisory lock, moeda, funil, etapa, tags e NULL
  -- para demanda ja aberta. Nunca recebe prova fornecida pelo chamador.
  v_lead := public.fn_nascer_lead_da_conversa(
    p_org, p_contact, p_pipeline, p_stage, p_title, p_source,
    coalesce(p_source_metadata, '{}'::jsonb) - 'meta_capi_lead_birth_v1', p_tags);
  if v_lead is null then return null; end if;

  v_click := v_msg.metadata->'meta_ctwa_message_v1'->>'ctwa_clid';
  if v_channel = 'whatsapp'
     and v_msg.metadata->'meta_ctwa_message_v1'->>'platform' = 'meta_ads'
     and v_msg.metadata->'meta_ctwa_message_v1'->>'source_type' = 'ad'
     and nullif(btrim(v_click), '') is not null
     and length(v_click) <= 512
     and p_source is distinct from 'campanha'
     and not exists (
       select 1 from public.campaign_recipients cr
       where cr.organization_id = p_org and cr.conversation_id = p_conversation
     ) then
    -- O gatilho exige simultaneamente o owner da RPC e este ID temporário.
    -- Mesmo service_role/postgres fora deste nascimento não pode forjar a prova.
    perform set_config('deskcomm.meta_capi_birth_lead_id', v_lead::text, true);
    update public.crm_leads set source_metadata =
      coalesce(source_metadata, '{}'::jsonb) ||
      jsonb_build_object('meta_capi_lead_birth_v1',
        jsonb_build_object('platform','meta_ads','source_type','ad',
          'ctwa_clid',v_click,'message_id',p_message,
          'conversation_id',p_conversation,'captured_at',v_msg.created_at))
      where organization_id = p_org and id = v_lead;
    perform set_config('deskcomm.meta_capi_birth_lead_id', '', true);
  end if;

  perform public.emit_event('lead.created','crm_lead',v_lead,
    jsonb_build_object('pipeline_id',p_pipeline,'stage_id',p_stage,
      'conversation_id',p_conversation),
    jsonb_build_object('source','nascimento-da-conversa'),p_org);
  return v_lead;
end;
$$;
revoke execute on function public.fn_nascer_lead_da_mensagem(uuid,uuid,uuid,uuid,text,text,jsonb,text[],uuid,uuid) from public, anon, authenticated;
grant execute on function public.fn_nascer_lead_da_mensagem(uuid,uuid,uuid,uuid,text,text,jsonb,text[],uuid,uuid) to service_role;

create or replace function public.fn_claim_meta_lead_submitted(p_org uuid, p_lead uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_row public.ad_conversion_dispatches%rowtype;
  v_token uuid := gen_random_uuid();
begin
  if not exists (
    select 1 from public.crm_leads l where l.organization_id=p_org and l.id=p_lead
      and l.source_metadata->'meta_capi_lead_birth_v1'->>'platform'='meta_ads'
      and l.source_metadata->'meta_capi_lead_birth_v1'->>'source_type'='ad'
      and nullif(l.source_metadata->'meta_capi_lead_birth_v1'->>'ctwa_clid','') is not null
  ) then return jsonb_build_object('acquired',false,'status','no_proof'); end if;
  insert into public.ad_conversion_dispatches
    (organization_id,lead_id,platform,event_name,status,event_id,
     event_occurred_at,meta_event_name,claim_token,claimed_until)
    select p_org,p_lead,'meta_ads','LeadSubmitted','processing',
      p_lead::text||':LeadSubmitted',l.created_at,'LeadSubmitted',
      v_token,now()+interval '2 minutes'
    from public.crm_leads l where l.organization_id=p_org and l.id=p_lead
  on conflict (organization_id,lead_id,event_name) do nothing;
  select * into v_row from public.ad_conversion_dispatches
    where organization_id=p_org and lead_id=p_lead and event_name='LeadSubmitted'
    for update;
  if not found then return jsonb_build_object('acquired',false,'status','missing'); end if;
  if v_row.platform <> 'meta_ads'
     or v_row.event_id is distinct from p_lead::text||':LeadSubmitted'
     or v_row.meta_event_name is distinct from 'LeadSubmitted'
     or v_row.event_occurred_at is distinct from (
       select l.created_at from public.crm_leads l
       where l.organization_id=p_org and l.id=p_lead
     ) then
    return jsonb_build_object('acquired',false,'status','invalid_ledger');
  end if;
  if v_row.status='sent' then return jsonb_build_object('acquired',false,'status','sent'); end if;
  if v_row.claim_token is not null and v_row.claimed_until > now()
     and v_row.claim_token <> v_token then
    return jsonb_build_object('acquired',false,'status','busy');
  end if;
  update public.ad_conversion_dispatches set status='processing',
    claim_token=v_token,claimed_until=now()+interval '2 minutes',
    event_id=p_lead::text||':LeadSubmitted',attempted_at=now()
    where id=v_row.id and organization_id=p_org;
  return jsonb_build_object('acquired',true,'status','processing','token',v_token);
end;
$$;
revoke execute on function public.fn_claim_meta_lead_submitted(uuid,uuid) from public, anon, authenticated;
grant execute on function public.fn_claim_meta_lead_submitted(uuid,uuid) to service_role;

create or replace function public.fn_settle_meta_lead_submitted(
  p_org uuid,p_lead uuid,p_token uuid,p_status text,p_reason text,p_detail text
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('sent','skipped','error') then return false; end if;
  update public.ad_conversion_dispatches set status=p_status,reason=p_reason,
    detail=left(p_detail,400),claim_token=null,claimed_until=null,attempted_at=now()
  where organization_id=p_org and lead_id=p_lead and event_name='LeadSubmitted'
    and platform='meta_ads' and event_id=p_lead::text||':LeadSubmitted'
    and claim_token=p_token and claimed_until>now() and status='processing';
  return found;
end;
$$;
revoke execute on function public.fn_settle_meta_lead_submitted(uuid,uuid,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.fn_settle_meta_lead_submitted(uuid,uuid,uuid,text,text,text) to service_role;

-- Reenvio explicito usa o mesmo ledger e nao migra os consumidores antigos.
create or replace function public.fn_solicitar_reenvio_conversao(p_org uuid, p_lead uuid, p_event text)
returns boolean language plpgsql set search_path = public as $$
declare v_linha public.ad_conversion_dispatches%rowtype;
begin
  if p_event is null or not (
    p_event in ('Purchase', 'QualifiedLead', 'LeadSubmitted')
    or p_event ~ '^Etapa:[0-9a-f-]{36}$'
    or p_event ~ '^MetaEtapa:[0-9a-f-]{36}$'
  ) then
    return false;
  end if;
  select * into v_linha from public.ad_conversion_dispatches
    where organization_id = p_org and lead_id = p_lead and event_name = p_event for update;
  if not found or v_linha.status = 'sent' then return false; end if;
  if p_event = 'LeadSubmitted' then
    if v_linha.platform <> 'meta_ads' or v_linha.event_occurred_at is null
       or v_linha.event_id is distinct from p_lead::text || ':LeadSubmitted'
       or v_linha.meta_event_name is distinct from 'LeadSubmitted'
       or (v_linha.claim_token is not null and v_linha.claimed_until > now())
       then return false; end if;
  elsif p_event ~ '^MetaEtapa:' then
    if v_linha.event_occurred_at is null or v_linha.meta_event_name is null then return false; end if;
  elsif p_event <> 'Purchase' and (v_linha.event_occurred_at is null or v_linha.google_action_id is null) then
    return false;
  end if;
  if p_event = 'Purchase' and v_linha.remote_request_id is null and not exists (
    select 1 from public.crm_leads where id = p_lead and organization_id = p_org and status = 'won'
  ) then return false; end if;
  if exists (select 1 from public.event_log where organization_id = p_org and entity_id = p_lead
    and event_type = 'ad_conversion.retry_requested' and status in ('pending', 'processing')
    and coalesce(payload->>'event_name', 'Purchase') = p_event) then return false; end if;
  perform public.emit_event('ad_conversion.retry_requested', 'crm_lead', p_lead,
    jsonb_build_object('event_name', p_event), '{}'::jsonb, p_org);
  update public.ad_conversion_dispatches set reason = 'reprocessamento_solicitado', attempted_at = now()
    where id = v_linha.id and organization_id = p_org;
  return true;
end;
$$;
revoke execute on function public.fn_solicitar_reenvio_conversao(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_solicitar_reenvio_conversao(uuid, uuid, text) to service_role;

notify pgrst,'reload schema';
