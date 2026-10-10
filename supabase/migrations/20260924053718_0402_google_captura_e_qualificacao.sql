-- Evolução de conversões já distribuídas: nenhuma integração é ligada automaticamente.
alter table public.google_ads_click_refs alter column gclid drop not null;
alter table public.google_ads_click_refs add column if not exists gbraid text,
  add column if not exists wbraid text;
-- NOT VALID preserva eventuais linhas legadas inválidas sem inventar origem;
-- continua exigindo identificador em toda escrita nova.
alter table public.google_ads_click_refs drop constraint if exists google_click_tem_identificador;
alter table public.google_ads_click_refs add constraint google_click_tem_identificador
  check (nullif(btrim(gclid), '') is not null or nullif(btrim(gbraid), '') is not null
    or nullif(btrim(wbraid), '') is not null) not valid;

alter table public.ad_platform_connections
  add column if not exists google_qualification_stage_id uuid,
  add column if not exists google_qualification_action_id text,
  add column if not exists google_qualification_configured_at timestamptz;
alter table public.ad_platform_connections drop constraint if exists ad_qualification_stage_org_fk;
alter table public.ad_platform_connections add constraint ad_qualification_stage_org_fk
  foreign key (organization_id, google_qualification_stage_id)
  references public.crm_stages (organization_id, id)
  on delete set null (google_qualification_stage_id);

alter table public.ad_platform_connections drop constraint if exists ad_qualification_action_distinta;
alter table public.ad_platform_connections add constraint ad_qualification_action_distinta
  check (google_qualification_action_id is null or (google_qualification_action_id ~ '^[0-9]{1,32}$'
    and google_qualification_action_id is distinct from google_conversion_action_id));

-- Snapshot do primeiro envio: reprocessar não inventa data nem troca a ação.
alter table public.ad_conversion_dispatches
  add column if not exists event_occurred_at timestamptz,
  add column if not exists google_action_id text;

create or replace function public.fn_solicitar_reenvio_conversao(p_org uuid, p_lead uuid, p_event text)
returns boolean language plpgsql set search_path = public as $$
declare v_linha public.ad_conversion_dispatches%rowtype;
begin
  if p_event not in ('Purchase', 'QualifiedLead') then return false; end if;
  select * into v_linha from public.ad_conversion_dispatches
    where organization_id = p_org and lead_id = p_lead and event_name = p_event for update;
  if not found or v_linha.status = 'sent' then return false; end if;
  if p_event = 'QualifiedLead' and (v_linha.event_occurred_at is null or v_linha.google_action_id is null) then return false; end if;
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

-- Assinatura anterior segue funcionando para clientes e eventos já existentes.
create or replace function public.fn_solicitar_reenvio_conversao(p_org uuid, p_lead uuid)
returns boolean language sql set search_path = public as $$
  select public.fn_solicitar_reenvio_conversao(p_org, p_lead, 'Purchase');
$$;
revoke execute on function public.fn_solicitar_reenvio_conversao(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_solicitar_reenvio_conversao(uuid, uuid) to service_role;

-- Uma troca de regra só vale para movimentos posteriores à configuração.
create or replace function public.fn_marcar_configuracao_qualificacao()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.google_qualification_configured_at := now();
  elsif new.google_qualification_stage_id is distinct from old.google_qualification_stage_id
     or new.google_qualification_action_id is distinct from old.google_qualification_action_id then
    new.google_qualification_configured_at := now();
  else
    new.google_qualification_configured_at := old.google_qualification_configured_at;
  end if;
  return new;
end;
$$;
revoke execute on function public.fn_marcar_configuracao_qualificacao() from public, anon, authenticated;
grant execute on function public.fn_marcar_configuracao_qualificacao() to service_role;
drop trigger if exists trg_marcar_configuracao_qualificacao on public.ad_platform_connections;
create trigger trg_marcar_configuracao_qualificacao before insert or update on public.ad_platform_connections
  for each row execute function public.fn_marcar_configuracao_qualificacao();

create or replace function public.fn_preservar_conversao_enviada()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.status = 'sent' and new.status <> 'sent' then return old; end if;
  new.event_occurred_at := coalesce(old.event_occurred_at, new.event_occurred_at);
  new.google_action_id := coalesce(old.google_action_id, new.google_action_id);
  return new;
end;
$$;
revoke execute on function public.fn_preservar_conversao_enviada() from public, anon, authenticated;
grant execute on function public.fn_preservar_conversao_enviada() to service_role;
