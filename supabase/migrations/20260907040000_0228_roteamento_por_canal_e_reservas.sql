-- 0228 — responsáveis por canal, claim automático serializado e conexão recuperável.
-- Independente da 0227: assignment dispara os triggers vigentes, nunca escreve drafts.
-- Ordem: mutex de serviço org+contato -> slot org+candidato -> canal SHARE -> conversa NO KEY UPDATE.
-- Escrita humana de policy ocorre somente pela RPC (RBAC + MFA + suporte), evitando
-- que DML direto burle a transação de substituição/locks. Leitura segue RLS por org.
create unique index if not exists channel_sessions_org_id_unique on public.channel_sessions(organization_id,id);
create table if not exists public.channel_routing_policies (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 channel_session_id uuid not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(organization_id,channel_session_id), unique(organization_id,id),
 foreign key(organization_id,channel_session_id) references public.channel_sessions(organization_id,id) on delete cascade
);
create table if not exists public.channel_routing_responsibles (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 policy_id uuid not null,
 user_id uuid not null,
 created_at timestamptz not null default now(),
 primary key(policy_id,user_id),
 foreign key(organization_id,policy_id) references public.channel_routing_policies(organization_id,id) on delete cascade,
 foreign key(organization_id,user_id) references public.user_organizations(organization_id,user_id) on delete cascade
);
create index if not exists channel_routing_responsibles_org_user on public.channel_routing_responsibles(organization_id,user_id);
alter table public.channel_routing_policies enable row level security;
alter table public.channel_routing_responsibles enable row level security;
revoke all on public.channel_routing_policies,public.channel_routing_responsibles from public,anon,authenticated,service_role;
grant select on public.channel_routing_policies,public.channel_routing_responsibles to authenticated,service_role;
drop policy if exists tenant_isolation_channel_routing_policies_select on public.channel_routing_policies;
create policy tenant_isolation_channel_routing_policies_select on public.channel_routing_policies for select to authenticated
 using(organization_id in(select public.fn_user_org_ids()) or public.fn_is_platform_admin());
drop policy if exists tenant_isolation_channel_routing_responsibles_select on public.channel_routing_responsibles;
create policy tenant_isolation_channel_routing_responsibles_select on public.channel_routing_responsibles for select to authenticated
 using(organization_id in(select public.fn_user_org_ids()) or public.fn_is_platform_admin());

-- Preserva história: apenas o evento pendente duplicado deixa de disputar consumo.
with ranked as (
 select id,row_number() over(partition by organization_id,entity_id order by created_at,id) n
 from public.event_log where event_type='conversation.routing_requested' and status in('pending','processing') and entity_id is not null
)
update public.event_log e set status='done',metadata=e.metadata||'{"routing_duplicate_recovered":true}'::jsonb
 from ranked r where e.id=r.id and r.n>1;
create unique index if not exists event_log_routing_active_unique on public.event_log(organization_id,entity_id)
 where event_type='conversation.routing_requested' and status in('pending','processing');

create or replace function public.fn_request_channel_routing(p_org uuid,p_conversation uuid)
returns void language plpgsql security definer set search_path=public as $$
declare c public.conversations;
begin
 select * into c from public.conversations where organization_id=p_org and id=p_conversation;
 if not found or c.assigned_to_user_id is not null or c.status not in('open','pending','claimed','ai_handling') then return;end if;
 insert into public.event_log(organization_id,event_type,entity_kind,entity_id,payload)
 values(p_org,'conversation.routing_requested','conversation',c.id,
  jsonb_build_object('organization_id',p_org,'conversation_id',c.id,'channel_session_id',c.channel_session_id))
 on conflict(organization_id,entity_id) where event_type='conversation.routing_requested' and status in('pending','processing')
 do update set next_attempt_at=case when event_log.status='pending' then now() else event_log.next_attempt_at end;
end;
$$;
revoke all on function public.fn_request_channel_routing(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_request_channel_routing(uuid,uuid) to service_role;

create or replace function public.fn_emit_conversation_routing()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 perform public.fn_request_channel_routing(new.organization_id,new.id);
 return null;
end;
$$;
revoke all on function public.fn_emit_conversation_routing() from public,anon,authenticated;

-- Sem lock de conversa/advisory: este helper só agenda eventos, nunca atribui.
create or replace function public.fn_wake_channel_routing(p_org uuid,p_channel uuid default null)
returns void language plpgsql security definer set search_path=public as $$
declare cid uuid;
begin
 for cid in select id from public.conversations where organization_id=p_org
  and (p_channel is null or channel_session_id=p_channel) and assigned_to_user_id is null
  and status in('open','pending','claimed','ai_handling') order by id
 loop perform public.fn_request_channel_routing(p_org,cid);end loop;
end;
$$;
revoke all on function public.fn_wake_channel_routing(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_wake_channel_routing(uuid,uuid) to service_role;

create or replace function public.fn_set_channel_routing(p_org uuid,p_channel uuid,p_users uuid[],p_reset boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_policy_id uuid; requested_count integer; found_count integer;
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'manager') or not public.fn_support_write_allowed(p_org)
 then raise exception 'routing_forbidden' using errcode='42501';end if;
 if not public.fn_session_mfa_proven() then raise exception 'routing_mfa_required' using errcode='42501';end if;
 if p_users is null or cardinality(p_users)>1000 or array_position(p_users,null) is not null then
  raise exception 'routing_invalid_members' using errcode='22023';end if;
 -- Leitores de claim usam SHARE nesta identidade, inclusive na ausência de policy.
 perform 1 from public.channel_sessions where organization_id=p_org and id=p_channel and archived_at is null for update;
 if not found then raise exception 'routing_channel_not_found' using errcode='P0002';end if;
 if p_reset then
  delete from public.channel_routing_policies where organization_id=p_org and channel_session_id=p_channel;
 else
  select count(distinct x) into requested_count from unnest(p_users) x;
  perform 1 from public.user_organizations where organization_id=p_org and user_id=any(p_users)
   and revoked_at is null and role in('agent','manager','admin') order by user_id for share;
  get diagnostics found_count=row_count;
  if found_count<>requested_count then raise exception 'routing_invalid_members' using errcode='22023';end if;
  insert into public.channel_routing_policies(organization_id,channel_session_id) values(p_org,p_channel)
   on conflict(organization_id,channel_session_id) do update set updated_at=now() returning id into v_policy_id;
  delete from public.channel_routing_responsibles where organization_id=p_org and channel_routing_responsibles.policy_id=v_policy_id;
  insert into public.channel_routing_responsibles(organization_id,policy_id,user_id)
   select p_org,v_policy_id,x from(select distinct unnest(p_users) x) users;
 end if;
 perform public.fn_wake_channel_routing(p_org,p_channel);
 return jsonb_build_object('channel_session_id',p_channel,'policy_id',v_policy_id,
  'mode',case when p_reset then 'legacy_unconfigured' when cardinality(p_users)=0 then 'restricted_empty' else 'restricted' end,
  'user_ids',case when p_reset then '[]'::jsonb else to_jsonb(p_users) end);
end;
$$;
revoke all on function public.fn_set_channel_routing(uuid,uuid,uuid[],boolean) from public,anon;
grant execute on function public.fn_set_channel_routing(uuid,uuid,uuid[],boolean) to authenticated;

-- Revogação é UPDATE, não DELETE: cascade sozinho não remove elegibilidade.
create or replace function public.fn_routing_member_revoked()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.revoked_at is not null or new.role not in('agent','manager','admin') then
  delete from public.channel_routing_responsibles where organization_id=new.organization_id and user_id=new.user_id;
 end if;
 perform public.fn_wake_channel_routing(new.organization_id);
 return new;
end;
$$;
revoke all on function public.fn_routing_member_revoked() from public,anon,authenticated;
drop trigger if exists trg_routing_member_revoked on public.user_organizations;
create trigger trg_routing_member_revoked after update of revoked_at,role on public.user_organizations
 for each row when(old.revoked_at is distinct from new.revoked_at or old.role is distinct from new.role) execute function public.fn_routing_member_revoked();

create or replace function public.fn_routing_availability_changed()
returns trigger language plpgsql security definer set search_path=public as $$
begin perform public.fn_wake_channel_routing(new.organization_id);return new;end;
$$;
revoke all on function public.fn_routing_availability_changed() from public,anon,authenticated;
drop trigger if exists trg_routing_availability_changed on public.attendant_availability;
create trigger trg_routing_availability_changed after insert or update of is_available,capacity,schedule on public.attendant_availability
 for each row execute function public.fn_routing_availability_changed();

-- Um aviso por conversa, com histórico preservado entre acknowledge e resolução.
create unique index if not exists agent_inbox_routing_unique on public.agent_inbox_items(organization_id,ref_id,kind)
 where kind='routing_unassigned';

create or replace function public.fn_routing_unassigned_notice(p_org uuid,p_conversation uuid,p_reason text)
returns void language plpgsql security definer set search_path=public as $$
begin
 if not exists(select 1 from public.conversations where organization_id=p_org and id=p_conversation and assigned_to_user_id is null
  and status in('open','pending','claimed','ai_handling')) then return;end if;
 insert into public.agent_inbox_items(organization_id,kind,severity,title,body,ref_kind,ref_id)
 values(p_org,'routing_unassigned','warn','Uma conversa aguarda um responsável',
  case when p_reason='invalid_channel' then 'Confira o canal de origem desta conversa nas Conexões.'
   else 'Confira os responsáveis do canal em Configurações → Atendimento e a disponibilidade da equipe. A distribuição continuará tentando.' end,
  'conversation',p_conversation)
 on conflict(organization_id,ref_id,kind) where kind='routing_unassigned'
 do update set status='open',body=excluded.body;
end;
$$;
revoke all on function public.fn_routing_unassigned_notice(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fn_routing_unassigned_notice(uuid,uuid,text) to service_role;

create or replace function public.fn_routing_assignment_changed()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.assigned_to_user_id is not null or new.status not in('open','pending','claimed','ai_handling') then
  update public.agent_inbox_items set status='resolved' where organization_id=new.organization_id
   and kind='routing_unassigned' and ref_id=new.id and status<>'resolved';
 elsif old.assigned_to_user_id is not null or old.status not in('open','pending','claimed','ai_handling') then
  perform public.fn_request_channel_routing(new.organization_id,new.id);
 end if;
 return new;
end;
$$;
revoke all on function public.fn_routing_assignment_changed() from public,anon,authenticated;
drop trigger if exists trg_routing_assignment_changed on public.conversations;
create trigger trg_routing_assignment_changed after update of assigned_to_user_id,status on public.conversations
 for each row execute function public.fn_routing_assignment_changed();

-- Mesma porta pública e contrato; compatível com KEY SHARE das FKs inbound.
CREATE OR REPLACE FUNCTION public.fn_conversation_assign(p_organization_id uuid, p_conversation_id uuid, p_to_user_id uuid, p_reason text, p_expected_assignee uuid DEFAULT NULL::uuid, p_enforce_expected boolean DEFAULT false)
 RETURNS SETOF conversations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_from uuid;
  v_conv public.conversations%rowtype;
begin
  if not public.fn_support_write_allowed(p_organization_id) then raise exception 'support_readonly' using errcode='42501'; end if;
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'agent') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'caller must be an active agent+ member of the organization';
  end if;

  if p_to_user_id is not null then
    if coalesce(public.fn_member_role_in_org(p_to_user_id, p_organization_id), 'none')
         not in ('agent','manager','admin') then
      raise exception 'assignee_not_eligible_member'
        using hint = 'target must be an active agent+ member of the organization';
    end if;
  end if;

  select assigned_to_user_id into v_from
    from public.conversations
   where id = p_conversation_id
     and organization_id = p_organization_id
   for no key update;

  if not found then
    return;
  end if;

  if p_enforce_expected and v_from is distinct from p_expected_assignee then
    return;
  end if;

  update public.conversations
     set assigned_to_user_id = p_to_user_id,
         -- Desnormalizado JUNTO com o dono, na mesma transação: nunca existe
         -- uma janela em que id e nome discordam. NULL junto com o id quando
         -- a atribuição é removida (release) — nunca sobra um nome órfão de
         -- dono nenhum. Lido de auth.users porque quem chama esta função
         -- (RPC) não necessariamente tem acesso ao Admin API — a definer
         -- resolve por dentro.
         assigned_to_user_name = case
           when p_to_user_id is null then null
           else (select raw_user_meta_data ->> 'full_name' from auth.users where id = p_to_user_id)
         end,
         assigned_at = case when p_to_user_id is null then null else now() end,
         assignee_kind = case when p_to_user_id is null then null else 'user' end,
         status = case when p_to_user_id is null then 'open' else 'claimed' end,
         status_changed_at = now(),
         unread_count_for_assignee = 0,
         bot_silenced_until = case
           when p_reason = 'routing'  then bot_silenced_until
           when p_to_user_id is null  then (case when last_handoff_at is null
                                                 then null
                                                 else bot_silenced_until end)
           else 'infinity'::timestamptz
         end,
         updated_at = now()
   where id = p_conversation_id
   returning * into v_conv;

  insert into public.conversation_assignment_events
    (organization_id, conversation_id, from_user_id, to_user_id, changed_by, reason)
  values
    (p_organization_id, p_conversation_id, v_from, p_to_user_id, auth.uid(), p_reason);

  return next v_conv;
end;
$function$;

create or replace function public.fn_channel_routing_claim(p_org uuid,p_conversation uuid,p_channel uuid,p_user uuid,p_schedule jsonb default null,p_reason text default 'routing')
returns text language plpgsql security definer set search_path=public as $$
declare c public.conversations; pre_contact uuid; member_id uuid; v_policy_id uuid; availability public.attendant_availability; current_load integer;
begin
 if p_reason not in('routing','handoff') then raise exception 'routing_reason_invalid' using errcode='22023';end if;
 select contact_id into pre_contact from public.conversations where organization_id=p_org and id=p_conversation;
 if not found then return 'conversation_changed';end if;
 perform public.fn_service_lock(p_org,pre_contact);
 perform pg_advisory_xact_lock(hashtextextended(p_org::text||':'||p_user::text,228));
 -- Task9: o trigger de status do canal toca conversas; ordem comum channel -> conversation.
 perform 1 from public.channel_sessions where organization_id=p_org and id=p_channel for share;
 if not found then return 'conversation_changed';end if;
 select * into c from public.conversations where organization_id=p_org and id=p_conversation for no key update;
 if not found or c.contact_id is distinct from pre_contact or c.channel_session_id is distinct from p_channel
  or c.status not in('open','pending','claimed','ai_handling') then return 'conversation_changed';end if;
 if c.assigned_to_user_id is not null then return 'already_assigned';end if;
 select id into member_id from public.user_organizations where organization_id=p_org and user_id=p_user
  and revoked_at is null and role in('agent','manager','admin') for share;
 if not found then return 'candidate_revoked';end if;
 select id into v_policy_id from public.channel_routing_policies where organization_id=p_org and channel_session_id=p_channel;
 if found and not exists(select 1 from public.channel_routing_responsibles r where r.organization_id=p_org and r.policy_id=v_policy_id and r.user_id=p_user)
 then return 'candidate_not_allowed';end if;
 select * into availability from public.attendant_availability where organization_id=p_org and user_id=p_user for share;
 if not found or not availability.is_available or (p_schedule is not null and availability.schedule is distinct from p_schedule)
 then return 'capacity_changed';end if;
 select count(*) into current_load from public.conversations where organization_id=p_org and assigned_to_user_id=p_user and status in('open','pending','claimed','ai_handling');
 if current_load>=availability.capacity then return 'capacity_changed';end if;
 perform public.fn_conversation_assign(p_org,p_conversation,p_user,p_reason,null,true);
 return 'assigned';
end;
$$;
revoke all on function public.fn_channel_routing_claim(uuid,uuid,uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.fn_channel_routing_claim(uuid,uuid,uuid,uuid,jsonb,text) to service_role;

-- Recibo privado: fatos da operação e lease; a representação do canal continua
-- em channel_sessions. TTL vale para replay concluído, nunca apaga reparo pendente.
create table if not exists public.channel_connection_requests (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 idempotency_key uuid not null,
 request_hash text not null,
 channel_session_id uuid,
 state text not null default 'processing' check(state in('processing','succeeded','failed')),
 lease_token uuid not null default gen_random_uuid(),
 lease_until timestamptz not null default now()+interval '5 minutes',
 remote_created boolean not null default false,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(organization_id,idempotency_key),
 foreign key(organization_id,channel_session_id) references public.channel_sessions(organization_id,id) on delete set null(channel_session_id)
);
alter table public.channel_connection_requests enable row level security;
revoke all on public.channel_connection_requests from public,anon,authenticated,service_role;
grant select on public.channel_connection_requests to service_role;
-- Sem policy authenticated: contém lease de execução, não é uma tabela de UI.

create or replace function public.fn_reserve_channel_connection(p_org uuid,p_key uuid,p_hash text,p_display_name text default null,p_onboarding boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare receipt public.channel_connection_requests; channel public.channel_sessions; token uuid:=gen_random_uuid();
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'admin') or not public.fn_support_write_allowed(p_org)
 then raise exception 'connection_forbidden' using errcode='42501';end if;
 if not public.fn_session_mfa_proven() then raise exception 'connection_mfa_required' using errcode='42501';end if;
 if p_key is null or p_hash is null or length(p_hash)<>64 or length(coalesce(p_display_name,''))>100 then
  raise exception 'connection_invalid_request' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_org::text,2281));
 delete from public.channel_connection_requests where organization_id=p_org and idempotency_key=p_key
  and state='succeeded' and updated_at<now()-interval '24 hours';
 select * into receipt from public.channel_connection_requests where organization_id=p_org and idempotency_key=p_key for update;
 if found then
  if receipt.request_hash<>p_hash then raise exception 'idempotency_conflict' using errcode='22023';end if;
  if receipt.state='succeeded' then
   select * into channel from public.channel_sessions where organization_id=p_org and id=receipt.channel_session_id;
   return jsonb_build_object('replay',true,'channel',to_jsonb(channel),'receipt_id',receipt.id);
  end if;
  if receipt.state='processing' and receipt.lease_until>now() then
   raise exception 'connection_in_progress' using errcode='55P03';end if;
  select * into channel from public.channel_sessions where organization_id=p_org and id=receipt.channel_session_id for update;
  if not found then raise exception 'connection_reservation_missing' using errcode='P0002';end if;
 else
  if p_onboarding then
   select * into channel from public.channel_sessions where organization_id=p_org and provider='waha'
    and (metadata->>'onboarding'='true' or waha_session_name='org_'||left(p_org::text,8))
    order by created_at limit 1 for update;
  end if;
  if channel.id is null then
   insert into public.channel_sessions(organization_id,waha_session_name,display_name,engine,webhook_path_token,
     webhook_secret_encrypted,status,last_status_change_at,consecutive_health_fails,daily_message_limit,metadata)
   values(p_org,'org_'||replace(p_org::text,'-','')||'_'||replace(gen_random_uuid()::text,'-',''),p_display_name,'NOWEB',
     replace(gen_random_uuid()::text,'-',''),'\x00'::bytea,'STARTING',now(),0,250,
     case when p_onboarding then '{"onboarding":true}'::jsonb else '{}'::jsonb end) returning * into channel;
  end if;
  if exists(select 1 from public.channel_connection_requests where organization_id=p_org and channel_session_id=channel.id
    and (state='processing' and lease_until>now())) then raise exception 'connection_in_progress' using errcode='55P03';end if;
  insert into public.channel_connection_requests(organization_id,idempotency_key,request_hash,channel_session_id)
   values(p_org,p_key,p_hash,channel.id) returning * into receipt;
 end if;
 if exists(select 1 from public.channel_connection_requests where organization_id=p_org and channel_session_id=channel.id
   and id<>receipt.id and (state='processing' and lease_until>now())) then raise exception 'connection_in_progress' using errcode='55P03';end if;
 update public.channel_connection_requests set state='processing',lease_token=token,lease_until=now()+interval '5 minutes',
  remote_created=false,updated_at=now() where organization_id=p_org and id=receipt.id;
 -- Não ressuscita antes da pós-condição remota. Arquivado permanece invisível
 -- até finish; falha conserva identidade e estado FAILED para reparo.
 update public.channel_sessions set status='STARTING',status_reason='connection_pending',last_status_change_at=now()
  where organization_id=p_org and id=channel.id returning * into channel;
 return jsonb_build_object('replay',false,'channel',to_jsonb(channel),'receipt_id',receipt.id,'lease_token',token);
end;
$$;
revoke all on function public.fn_reserve_channel_connection(uuid,uuid,text,text,boolean) from public,anon;
grant execute on function public.fn_reserve_channel_connection(uuid,uuid,text,text,boolean) to authenticated;

create or replace function public.fn_finish_channel_connection(p_org uuid,p_receipt uuid,p_lease uuid,p_status text,p_reason text default null,p_created boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare receipt public.channel_connection_requests; channel public.channel_sessions;
begin
 select * into receipt from public.channel_connection_requests where organization_id=p_org and id=p_receipt for update;
 if not found or receipt.state<>'processing' or receipt.lease_token<>p_lease
   or receipt.lease_until<=now()
 then raise exception 'connection_lease_lost' using errcode='55P03';end if;
 if p_status='remote_created' then
  update public.channel_connection_requests set remote_created=true,updated_at=now() where organization_id=p_org and id=p_receipt;
  return '{}'::jsonb;
 end if;
 if p_status not in('STARTING','SCAN_QR_CODE','WORKING','FAILED') then raise exception 'connection_invalid_status' using errcode='22023';end if;
 update public.channel_sessions set status=p_status,status_reason=left(p_reason,200),last_status_change_at=now(),
  consecutive_health_fails=case when p_status='FAILED' then consecutive_health_fails else 0 end,
  archived_at=case when p_status<>'FAILED' then null else archived_at end,
  phone_number=case when archived_at is not null and p_status<>'FAILED' then null else phone_number end
  where organization_id=p_org and id=receipt.channel_session_id returning * into channel;
 if not found then raise exception 'connection_reservation_missing' using errcode='P0002';end if;
 update public.channel_connection_requests set state=case when p_status='FAILED' then 'failed' else 'succeeded' end,
  remote_created=remote_created or p_created,updated_at=now() where organization_id=p_org and id=p_receipt;
 return to_jsonb(channel);
end;
$$;
revoke all on function public.fn_finish_channel_connection(uuid,uuid,uuid,text,text,boolean) from public,anon,authenticated;
grant execute on function public.fn_finish_channel_connection(uuid,uuid,uuid,text,text,boolean) to service_role;

-- CHECK canônico: no baseline atualizar o bloco vigente, sem duplicá-lo.
alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'appointment_outcome_required',
    'appointment_recovery_review',
    'qr_rescan',
    'routing_unassigned',
    'job_dead',
    'event_dead',
    'budget_exceeded',
    'handoff',
    'promotion_review',
    'judge_unaligned',
    'followup_dead',
    'snooze_expired',
    'next_action_ambiguous',
    'risk_backlog_seeded',
    'reactivation_expired',
    'capabilities_missing',
    -- (migration 0109, issue #129) Mensagem outbound nasce `sending` e, quando o
    -- envio nunca acontece, fica `sending` para sempre — o self-hoster vê uma
    -- mensagem eternamente "enviando", sinal de progresso para algo que não vai
    -- acontecer. O cron `recover-stuck-messages` marca `failed` e usa este kind
    -- para o defeito APARECER na Central de avisos.
    --
    -- Entra NESTA lista, e não num bloco novo no fim do arquivo: o #159 do @jmpo
    -- mostrou que reconstruir a mesma constraint em N blocos quebra o
    -- `update.sh` de todo clone que já tenha uma linha de vocabulário posterior
    -- — os blocos antigos rodam antes e falham em cadeia. Um bloco por
    -- constraint, vigiado por tests/unit/baseline-constraint-reconstruida.test.ts.
    'message_send_stuck',
    -- (migration 0129) O cliente manda foto/áudio e o agente age como se nada
    -- tivesse chegado. Acontece quando o modelo configurado não enxerga imagem,
    -- ou quando falta a chave de transcrição — e antes disto a derivação
    -- devolvia string vazia EM SILÊNCIO: nenhum erro, nenhum log, e o operador
    -- concluindo que o agente ignorou o cliente de propósito.
    'midia_nao_lida',
    'channel_template_review',
    'channel_number_alert',
    -- (migration 0111, spec 16 §3.2) O papel Operador declara promessa em aberto:
    -- o assistente prometeu algo ao cliente e o cumprimento não foi registrado.
    -- A invariante sagrada da spec é "nenhuma promessa deixa de ser cumprida", e
    -- uma promessa sem dono precisa aparecer onde o humano olha — não no log do
    -- worker. Entra NESTA lista pela mesma razão que a de cima.
    'promise_unfulfilled',
    -- (migration 0124, spec 17 §4b) Dado que o assistente ouviu na conversa e
    -- ninguém confirmou até o prazo. `info`, não `warn`: nada quebrou — uma
    -- informação não foi aproveitada, e tratar isso como falha ensinaria a
    -- ignorar os avisos que são falha de verdade. Entra NESTA lista pela mesma
    -- razão das de cima (bloco único por constraint, #159).
    'contact_proposal_expired',
    -- (migration 0159) O gasto passou do aviso que a pessoa definiu e a IA
    -- CONTINUA respondendo — `warn`, nunca `critical`, e um kind SEPARADO de
    -- `budget_exceeded`: colapsar os dois faria o alerta de "parou" perder o
    -- significado. É este kind que torna possível a condição do gate "ninguém é
    -- bloqueado sem ter sido avisado no mês" — sem ele, o salto de 79% para 101%
    -- entre duas chamadas calaria a IA sem nenhum sinal anterior.
    --
    -- Entra NESTA lista, e AQUI no fim, por duas razões distintas: bloco único
    -- por constraint (#159), e porque `tests/unit/midia-nao-lida.test.ts` procura
    -- `'midia_nao_lida'` nos primeiros 2000 caracteres a partir do `add
    -- constraint` — um valor comentado inserido ACIMA dele empurra-o para fora da
    -- janela e reprova um teste que não tem nada a ver com o kind novo (medido:
    -- offset 1532 -> 2275). Kind novo entra no fim da lista.
    'budget_warning',
    -- (migration 0181) O material que a pessoa enviou não entrou na base: falta
    -- chave de embedding, a extração do arquivo falhou, ou nenhum trecho foi
    -- gravado. Antes disto o worker devolvia `skipped` para o próprio log, o drain
    -- tratava `skipped` como sucesso, e a linha da fonte seguia dizendo `ready`.
    -- Irmão direto de `midia_nao_lida`: mesma chave, mesmo silêncio.
    'conhecimento_nao_indexado',
    'other'
  ));
