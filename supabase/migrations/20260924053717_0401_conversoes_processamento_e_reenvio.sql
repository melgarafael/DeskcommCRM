-- 0401: preservar conexões existentes; novos protocolos têm consulta durável.
alter table public.ad_platform_connections
  add column if not exists google_api text not null default 'google_ads';
alter table public.ad_platform_connections drop constraint if exists ad_platform_connections_google_api_check;
alter table public.ad_platform_connections add constraint ad_platform_connections_google_api_check
  check (google_api in ('google_ads', 'data_manager'));
alter table public.ad_conversion_dispatches
  add column if not exists remote_request_id text,
  add column if not exists remote_requested_at timestamptz;

-- Uma execução atrasada não pode apagar a prova de envio de outra execução.
create or replace function public.fn_preservar_conversao_enviada()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.status = 'sent' and new.status <> 'sent' then return old; end if;
  return new;
end;
$$;
revoke execute on function public.fn_preservar_conversao_enviada() from public, anon, authenticated;
grant execute on function public.fn_preservar_conversao_enviada() to service_role;
drop trigger if exists trg_preservar_conversao_enviada on public.ad_conversion_dispatches;
create trigger trg_preservar_conversao_enviada before update on public.ad_conversion_dispatches
  for each row execute function public.fn_preservar_conversao_enviada();

-- Só o backend autorizado alcança esta porta. O evento é exclusivo do consumidor
-- de conversões: reprocessar venda não dispara notificações/follow-ups de lead.won.
create or replace function public.fn_solicitar_reenvio_conversao(p_org uuid, p_lead uuid)
returns boolean language plpgsql set search_path = public as $$
declare v_linha public.ad_conversion_dispatches%rowtype;
begin
  select * into v_linha from public.ad_conversion_dispatches
    where organization_id = p_org and lead_id = p_lead and event_name = 'Purchase' for update;
  if not found or v_linha.status = 'sent' then return false; end if;
  if v_linha.remote_request_id is null and not exists (select 1 from public.crm_leads where id = p_lead and organization_id = p_org and status = 'won') then return false; end if;
  if exists (select 1 from public.event_log where organization_id = p_org and entity_id = p_lead
    and event_type = 'ad_conversion.retry_requested' and status in ('pending', 'processing')) then return false; end if;
  perform public.emit_event('ad_conversion.retry_requested', 'crm_lead', p_lead, '{}'::jsonb, '{}'::jsonb, p_org);
  update public.ad_conversion_dispatches set reason = 'reprocessamento_solicitado', attempted_at = now()
    where id = v_linha.id and organization_id = p_org;
  return true;
end;
$$;
revoke execute on function public.fn_solicitar_reenvio_conversao(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_solicitar_reenvio_conversao(uuid, uuid) to service_role;
