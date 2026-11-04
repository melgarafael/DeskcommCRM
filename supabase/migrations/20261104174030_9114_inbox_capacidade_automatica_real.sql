-- manifest: Expõe campo calculado adicional para prontidão do automático, sem alterar o comando nativo nem autorizar atendimento.
CREATE OR REPLACE FUNCTION public.fn_inbox_gate_autorizado(p_metadata jsonb, p_phone text, p_authorized_at timestamp with time zone, p_now timestamp with time zone, p_ttl_ms double precision)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
declare item jsonb; tester text;
begin
  if (p_metadata->>'ai_gate') is distinct from 'allowlist' then return true; end if;
  if p_metadata->>'ai_gate_mode' = 'pre_go_live' then
    if jsonb_typeof(p_metadata->'ai_test_phone_numbers') is distinct from 'array' then
      return false;
    end if;
    for item in select value from jsonb_array_elements(p_metadata->'ai_test_phone_numbers') loop
      if jsonb_typeof(item) <> 'string' then continue; end if;
      tester := btrim(item #>> '{}');
      if tester !~ '^\+[1-9][0-9 ()-]*$'
         or length(regexp_replace(tester, '[^0-9]', '', 'g')) not between 8 and 15 then
        continue;
      end if;
      if public.fn_inbox_variantes_telefone(p_phone) && public.fn_inbox_variantes_telefone(tester) then
        return true;
      end if;
    end loop;
    return false;
  end if;
  -- A fronteira é inclusiva, como agora - autorizadoEm <= ttlMs no motor.
  return p_authorized_at is not null and isfinite(p_authorized_at)
    and extract(epoch from p_now - p_authorized_at) * 1000 <= p_ttl_ms;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_inbox_ttl_ms()
 RETURNS double precision
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare raw text; ttl double precision;
begin
  raw := nullif(current_setting('request.headers', true), '')::jsonb
    ->> 'x-deskcomm-ai-allowlist-ttl-ms';
  if raw ~ '^[0-9]+([.][0-9]+)?([eE][+]?[0-9]+)?$' then
    ttl := raw::double precision;
    if ttl > 0 and ttl < 'Infinity'::double precision then return ttl; end if;
  end if;
  return 1814400000; -- default nativo: 21 dias; callers SQL sem header.
exception when invalid_text_representation or numeric_value_out_of_range then
  return 1814400000;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_inbox_variantes_telefone(p_phone text)
 RETURNS text[]
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
declare d text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
begin
  if d = '' then return array[]::text[]; end if;
  if d ~ '^55[1-9][0-9][6-9][0-9]{7}$' then
    return array['+' || d, '+' || left(d, 4) || '9' || substring(d from 5)];
  elsif d ~ '^55[1-9][0-9]9[6-9][0-9]{7}$' then
    return array['+' || d, '+' || left(d, 4) || substring(d from 6)];
  end if;
  return array['+' || d];
end;
$function$
;

CREATE OR REPLACE FUNCTION public.comando_operacional_da_conversa(conversations)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
declare
  ct record; metadata jsonb; base text; agent record; router record;
  campaign_agent uuid; available boolean;
begin
  if $1.assigned_to_user_id is not null then return 'humano'; end if;
  if $1.status in ('closed', 'archived', 'resolved') then return 'encerrada'; end if;
  base := public.fn_comando_da_conversa($1.status, $1.assigned_to_user_id,
    $1.bot_silenced_until, $1.contato_trava_humano, false, now(), coalesce($1.is_group, false));
  if base <> 'automatico' then return base; end if;
  select c.ai_authorized_at, c.phone_number into ct from public.contacts c
    where c.id = $1.contact_id and c.organization_id = $1.organization_id;
  if not found then return 'aguardando'; end if;
  if $1.assignee_kind = 'user' then return 'aguardando'; end if;
  select s.metadata into metadata from public.channel_sessions s
    where s.id = $1.channel_session_id and s.organization_id = $1.organization_id
      and s.archived_at is null;
  if not found then return 'aguardando'; end if;
  if not public.fn_inbox_gate_autorizado(metadata, ct.phone_number,
    ct.ai_authorized_at, now(), public.fn_inbox_ttl_ms()) then return 'aguardando'; end if;

  -- Campanha que criou esta conversa precede o roteador no resolvedor nativo.
  select c.agent_id into campaign_agent from public.campaign_recipients r
    join public.campaigns c on c.id = r.campaign_id and c.organization_id = r.organization_id
    where r.organization_id = $1.organization_id and r.conversation_id = $1.id
      and c.agent_id is not null order by r.sent_at desc nulls last limit 1;
  if campaign_agent is not null then
    select a.operation_mode, a.paused_at into agent from public.ai_agents a
      join public.ai_agent_versions v on v.id = a.published_version_id
        and v.organization_id = a.organization_id
      where a.id = campaign_agent and a.organization_id = $1.organization_id
        and a.archived_at is null and v.status = 'published';
    if found then
      return case when agent.paused_at is null and agent.operation_mode = 'automatic'
        then 'automatico' else 'aguardando' end;
    end if;
  end if;

  select r.id, r.fallback_agent_id, r.config into router from public.ai_routers r
    where r.organization_id = $1.organization_id
      and r.channel_session_id = $1.channel_session_id and r.is_active;
  if found then
    -- Sticky válido já resolvido: não prometer outro agente por agregado da org.
    if (router.config->'sticky') is distinct from 'false'::jsonb then
      select a.operation_mode, a.paused_at into agent from public.ai_router_members m
        join public.ai_agents a on a.id = m.agent_id and a.organization_id = m.organization_id
        join public.ai_agent_versions v on v.id = a.published_version_id
          and v.organization_id = a.organization_id
        where m.router_id = router.id and m.organization_id = $1.organization_id
          and a.id = $1.active_ai_agent_id and a.archived_at is null and v.status = 'published'
        limit 1;
      if found then
        return case when agent.paused_at is null and agent.operation_mode = 'automatic'
          then 'automatico' else 'aguardando' end;
      end if;
    end if;
    -- Sem agente resolvido: capacidade publicada do roteador, não turno LLM em execução.
    select exists (
      select 1 from public.ai_agents a
        join public.ai_agent_versions v on v.id = a.published_version_id
          and v.organization_id = a.organization_id
        where a.organization_id = $1.organization_id and a.archived_at is null
          and a.paused_at is null and a.operation_mode = 'automatic' and v.status = 'published'
          and (a.id = router.fallback_agent_id or exists (
            select 1 from public.ai_router_members m where m.router_id = router.id
              and m.organization_id = $1.organization_id and m.agent_id = a.id))
    ) into available;
    if available then return 'automatico'; end if;
  end if;

  -- Prioridade do resolvedor: um agente pausado não cede a um agente inferior.
  select a.operation_mode, a.paused_at into agent from public.ai_agents a
    join public.ai_agent_versions v on v.id = a.published_version_id
      and v.organization_id = a.organization_id
    where a.organization_id = $1.organization_id and a.archived_at is null
      and v.status = 'published' and v.channel_session_id = $1.channel_session_id
    order by a.priority desc, a.created_at asc limit 1;
  if found and agent.paused_at is null and agent.operation_mode = 'automatic' then
    return 'automatico';
  end if;
  return 'aguardando';
end;
$function$
;

revoke execute on function public.fn_inbox_variantes_telefone(text) from public, anon;
revoke execute on function public.fn_inbox_ttl_ms() from public, anon;
revoke execute on function public.fn_inbox_gate_autorizado(jsonb,text,timestamptz,timestamptz,double precision) from public, anon;
grant execute on function public.fn_inbox_variantes_telefone(text), public.fn_inbox_ttl_ms(), public.fn_inbox_gate_autorizado(jsonb,text,timestamptz,timestamptz,double precision) to authenticated, service_role;
revoke execute on function public.comando_operacional_da_conversa(public.conversations) from public, anon;
grant execute on function public.comando_operacional_da_conversa(public.conversations) to authenticated, service_role;
notify pgrst, 'reload schema';

