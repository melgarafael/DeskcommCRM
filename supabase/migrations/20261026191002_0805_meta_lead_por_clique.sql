-- manifest: Registra cada clique CTWA inbound em livro proprio, atomico com a mensagem, para LeadSubmitted por clique sem mudar o ledger de Purchase e etapas.
-- O ID da primeira mensagem sobrevive a exclusao da conversa; a exclusao LGPD
-- do contato ou da organizacao remove a linha por cascata.
create table if not exists public.meta_ctwa_click_dispatches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  first_message_id uuid not null,
  ctwa_clid text not null check (length(ctwa_clid) between 1 and 512),
  captured_at timestamptz not null,
  activation_at_capture timestamptz,
  status text not null default 'pending'
    check (status in ('pending','processing','sent','skipped','error')),
  reason text,
  detail text,
  event_id text not null,
  claim_token uuid,
  claimed_until timestamptz,
  attempted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, ctwa_clid),
  unique (organization_id, first_message_id),
  unique (organization_id, event_id)
);
create index if not exists meta_ctwa_click_dispatches_org_status_idx
  on public.meta_ctwa_click_dispatches (organization_id, status, captured_at desc);
create index if not exists meta_ctwa_click_dispatches_org_contact_time_idx
  on public.meta_ctwa_click_dispatches (organization_id, contact_id, captured_at desc);
alter table public.meta_ctwa_click_dispatches enable row level security;
revoke all on public.meta_ctwa_click_dispatches from public, anon, authenticated;
grant select, insert, update, delete on public.meta_ctwa_click_dispatches to service_role;
comment on table public.meta_ctwa_click_dispatches is
  'Evidencia e livro-razao de LeadSubmitted por clique CTWA. Server-only; primeiro toque do contato e demais conversoes nao sao alterados.';
comment on column public.meta_ctwa_click_dispatches.first_message_id is
  'ID historico da primeira mensagem, sem FK para preservar a prova ate a exclusao LGPD do contato.';

create or replace function public.fn_guard_meta_ctwa_click_identity() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.organization_id,new.contact_id,new.first_message_id,new.ctwa_clid,
      new.captured_at,new.activation_at_capture,new.event_id) is distinct from
     (old.organization_id,old.contact_id,old.first_message_id,old.ctwa_clid,
      old.captured_at,old.activation_at_capture,old.event_id) then
    raise exception 'meta_ctwa_click_identity_immutable';
  end if;
  return new;
end;
$$;
revoke execute on function public.fn_guard_meta_ctwa_click_identity() from public, anon, authenticated;
grant execute on function public.fn_guard_meta_ctwa_click_identity() to service_role;
drop trigger if exists trg_guard_meta_ctwa_click_identity on public.meta_ctwa_click_dispatches;
create trigger trg_guard_meta_ctwa_click_identity before update
  on public.meta_ctwa_click_dispatches for each row
  execute function public.fn_guard_meta_ctwa_click_identity();

-- O ledger anterior identifica o evento pelo lead, mas sua prova preserva o
-- ctwa_clid. Um clique ja enviado antes desta tabela nao pode ganhar outro ID.
create or replace function public.fn_meta_ctwa_click_enviado_legado(p_org uuid,p_clid text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.ad_conversion_dispatches d
    join public.crm_leads l on l.id=d.lead_id and l.organization_id=d.organization_id
    where d.organization_id=p_org and d.platform='meta_ads'
      and d.event_name='LeadSubmitted' and d.status='sent'
      and l.source_metadata->'meta_capi_lead_birth_v1'->>'platform'='meta_ads'
      and l.source_metadata->'meta_capi_lead_birth_v1'->>'source_type'='ad'
      and l.source_metadata->'meta_capi_lead_birth_v1'->>'ctwa_clid'=p_clid
  );
$$;
revoke execute on function public.fn_meta_ctwa_click_enviado_legado(uuid,text)
  from public, anon, authenticated;
grant execute on function public.fn_meta_ctwa_click_enviado_legado(uuid,text) to service_role;

create or replace function public.fn_record_meta_ctwa_click() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_clid text;
  v_activation timestamptz;
  v_at timestamptz;
  v_sent_legacy boolean;
  v_id uuid := gen_random_uuid();
begin
  if new.direction <> 'inbound'
     or new.metadata->'meta_ctwa_message_v1'->>'platform' is distinct from 'meta_ads'
     or new.metadata->'meta_ctwa_message_v1'->>'source_type' is distinct from 'ad' then
    return new;
  end if;
  v_clid := new.metadata->'meta_ctwa_message_v1'->>'ctwa_clid';
  if v_clid is null or v_clid <> btrim(v_clid) or length(v_clid) not between 1 and 512 then
    return new;
  end if;
  if not exists (select 1 from public.contacts c
      where c.id=new.contact_id and c.organization_id=new.organization_id)
     or not exists (select 1 from public.conversations c
      where c.id=new.conversation_id and c.organization_id=new.organization_id
        and c.contact_id=new.contact_id and c.channel='whatsapp') then
    -- A ancora valida exige escopo valido. Falhar reverte mensagem e evento
    -- juntos; aceitar a mensagem aqui perderia o clique silenciosamente.
    raise exception 'meta_ctwa_click_scope_mismatch';
  end if;
  -- O lock ordena captura e toggle da organizacao, ambos no relogio do banco.
  select o.meta_lead_birth_enabled_at into v_activation
    from public.organizations o where o.id=new.organization_id for share;
  v_at := clock_timestamp();
  v_sent_legacy := public.fn_meta_ctwa_click_enviado_legado(new.organization_id,v_clid);
  insert into public.meta_ctwa_click_dispatches
    (id,organization_id,contact_id,first_message_id,ctwa_clid,captured_at,
     activation_at_capture,status,reason,event_id)
  values (v_id,new.organization_id,new.contact_id,new.id,v_clid,v_at,
    v_activation,
    case when v_sent_legacy or v_activation is null or v_at<=v_activation
      then 'skipped' else 'pending' end,
    case when v_sent_legacy then 'lead_submitted_legado_enviado'
      when v_activation is null or v_at<=v_activation then 'lead_submitted_desativado'
      else null end,
    v_id::text||':LeadSubmitted')
  on conflict (organization_id,ctwa_clid) do nothing;
  return new;
end;
$$;
revoke execute on function public.fn_record_meta_ctwa_click() from public, anon, authenticated;
grant execute on function public.fn_record_meta_ctwa_click() to service_role;
drop trigger if exists trg_record_meta_ctwa_click on public.messages;
create trigger trg_record_meta_ctwa_click after insert on public.messages
  for each row execute function public.fn_record_meta_ctwa_click();

create or replace function public.fn_claim_meta_ctwa_click(p_org uuid,p_click uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_row public.meta_ctwa_click_dispatches%rowtype;
  v_token uuid := gen_random_uuid();
begin
  select * into v_row from public.meta_ctwa_click_dispatches
    where organization_id=p_org and id=p_click for update;
  if not found then return jsonb_build_object('acquired',false,'status','missing'); end if;
  if v_row.status='sent' then return jsonb_build_object('acquired',false,'status','sent'); end if;
  if public.fn_meta_ctwa_click_enviado_legado(p_org,v_row.ctwa_clid) then
    update public.meta_ctwa_click_dispatches
      set status='skipped',reason='lead_submitted_legado_enviado',
          claim_token=null,claimed_until=null
      where organization_id=p_org and id=p_click;
    return jsonb_build_object('acquired',false,'status','legacy_sent');
  end if;
  if v_row.activation_at_capture is null or v_row.captured_at<=v_row.activation_at_capture then
    return jsonb_build_object('acquired',false,'status','disabled_at_capture');
  end if;
  if v_row.event_id is distinct from v_row.id::text||':LeadSubmitted' then
    return jsonb_build_object('acquired',false,'status','invalid_ledger');
  end if;
  if v_row.claim_token is not null and v_row.claimed_until>now() then
    return jsonb_build_object('acquired',false,'status','busy');
  end if;
  update public.meta_ctwa_click_dispatches
    set status='processing',claim_token=v_token,claimed_until=now()+interval '2 minutes',
        attempted_at=now(),reason=null
    where organization_id=p_org and id=p_click;
  return jsonb_build_object('acquired',true,'status','processing','token',v_token);
end;
$$;
revoke execute on function public.fn_claim_meta_ctwa_click(uuid,uuid) from public, anon, authenticated;
grant execute on function public.fn_claim_meta_ctwa_click(uuid,uuid) to service_role;

create or replace function public.fn_settle_meta_ctwa_click(
  p_org uuid,p_click uuid,p_token uuid,p_status text,p_reason text,p_detail text
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('sent','skipped','error') then return false; end if;
  update public.meta_ctwa_click_dispatches
    set status=p_status,reason=p_reason,detail=left(p_detail,400),
        claim_token=null,claimed_until=null,attempted_at=now()
  where organization_id=p_org and id=p_click and claim_token=p_token
    and claimed_until>now() and status='processing';
  return found;
end;
$$;
revoke execute on function public.fn_settle_meta_ctwa_click(uuid,uuid,uuid,text,text,text)
  from public, anon, authenticated;
grant execute on function public.fn_settle_meta_ctwa_click(uuid,uuid,uuid,text,text,text)
  to service_role;

create or replace function public.fn_solicitar_reenvio_meta_ctwa_click(p_org uuid,p_click uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_row public.meta_ctwa_click_dispatches%rowtype;
  v_enabled timestamptz;
begin
  select * into v_row from public.meta_ctwa_click_dispatches
    where organization_id=p_org and id=p_click for update;
  if not found or v_row.status='sent'
     or (v_row.claim_token is not null and v_row.claimed_until>now()) then
    return false;
  end if;
  if public.fn_meta_ctwa_click_enviado_legado(p_org,v_row.ctwa_clid) then
    return false;
  end if;
  select meta_lead_birth_enabled_at into v_enabled
    from public.organizations where id=p_org;
  if v_row.activation_at_capture is null or v_enabled is distinct from v_row.activation_at_capture
     or v_row.captured_at<=v_enabled then return false; end if;
  perform public.emit_event('ad_conversion.click_retry_requested','meta_ctwa_click',p_click,
    jsonb_build_object('click_id',p_click),'{}'::jsonb,p_org);
  update public.meta_ctwa_click_dispatches
    set reason='reprocessamento_solicitado',attempted_at=now()
    where organization_id=p_org and id=p_click;
  return true;
end;
$$;
revoke execute on function public.fn_solicitar_reenvio_meta_ctwa_click(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.fn_solicitar_reenvio_meta_ctwa_click(uuid,uuid) to service_role;
notify pgrst,'reload schema';
