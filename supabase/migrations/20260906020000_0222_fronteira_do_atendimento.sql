-- 0222 — conversa encerra atendimento; demanda exige desfecho explícito.
-- Mutex: advisory(org, contato) -> conversa NO KEY UPDATE -> demanda.
-- NO KEY UPDATE é deliberado: INSERT messages já detém KEY SHARE pela FK.
-- Jamais adquirir FOR UPDATE aqui: dois INSERTs podem deter KEY SHARE juntos.
alter table public.conversations add column if not exists service_revision bigint not null default 1;
alter table public.conversations add column if not exists service_closed_at timestamptz;
alter table public.conversations add column if not exists service_started_at timestamptz;
alter table public.conversations add column if not exists current_demanda_id uuid references public.demandas(id) on delete set null;
alter table public.demandas add column if not exists revision bigint not null default 1;
alter table public.demandas add column if not exists encerrada_por uuid references auth.users(id) on delete set null;
alter table public.demanda_conversas add column if not exists service_revision bigint;
alter table public.messages add column if not exists service_revision bigint;
alter table public.messages add column if not exists demanda_id uuid references public.demandas(id) on delete set null;
alter table public.messages add column if not exists demanda_revision bigint;
alter table public.lead_checkpoints add column if not exists conversation_id uuid references public.conversations(id) on delete set null;
alter table public.lead_checkpoints add column if not exists service_revision bigint;
alter table public.lead_checkpoints add column if not exists demanda_id uuid references public.demandas(id) on delete set null;
alter table public.lead_checkpoints add column if not exists demanda_revision bigint;
-- Só carimbos observados: não inventar assunto/provenance para trabalho legado.
update public.conversations set service_closed_at = status_changed_at
 where status in ('closed','resolved','archived') and service_closed_at is null;

drop trigger if exists trg_demanda_fecha_com_conversa on public.conversations;

create or replace function public.fn_service_lock(p_org uuid, p_contact uuid)
returns void language sql set search_path = public as $$
 select pg_advisory_xact_lock(hashtextextended(p_org::text || ':' || p_contact::text, 222));
$$;
revoke execute on function public.fn_service_lock(uuid,uuid) from public, anon, authenticated;
grant execute on function public.fn_service_lock(uuid,uuid) to service_role;

-- Canônica: só recebe ID de mensagem persistida. Tenant/FKs são reconferidos.
create or replace function public.fn_service_inbound(p_message uuid)
returns void language plpgsql security definer set search_path = public as $$
declare m public.messages; c public.conversations; d public.demandas; reopened boolean; pre_contact uuid;
begin
 select * into m from public.messages where id = p_message;
 if not found or m.direction <> 'inbound' or m.service_revision is not null then return; end if;
 select * into c from public.conversations where id = m.conversation_id;
 if not found or c.organization_id is distinct from m.organization_id
    or c.channel_session_id is distinct from m.channel_session_id
    or not exists(select 1 from public.channel_sessions where id=m.channel_session_id and organization_id=m.organization_id)
 then raise exception 'service_scope_mismatch' using errcode='23503'; end if;
 if c.is_group or coalesce(c.group_chat_id,'') like '%@g.us' then return; end if;
 if c.contact_id is distinct from m.contact_id
    or not exists(select 1 from public.contacts where id=m.contact_id and organization_id=m.organization_id)
 then raise exception 'service_scope_mismatch' using errcode='23503'; end if;
 pre_contact:=c.contact_id;
 perform public.fn_service_lock(c.organization_id,c.contact_id);
 select * into c from public.conversations where id=m.conversation_id and organization_id=m.organization_id for no key update;
 if c.contact_id is distinct from pre_contact then raise exception 'service_contact_changed' using errcode='40001'; end if;
 if m.sent_at <= c.service_closed_at then return; end if;
 reopened := c.status in ('closed','resolved','archived');
 if not reopened then
   select x.* into d from public.demandas x join public.demanda_conversas dc on dc.demanda_id=x.id
    where x.id=c.current_demanda_id and x.organization_id=c.organization_id and x.contact_id=c.contact_id
      and dc.organization_id=c.organization_id and dc.conversation_id=c.id
      and dc.service_revision=c.service_revision and x.fechada_em is null;
 end if;
 if d.id is null then
   insert into public.demandas(organization_id,contact_id,aberta_em,origem,estado,dono_kind,proximo_passo)
    values(c.organization_id,c.contact_id,m.sent_at,'inbound','aberta','ia','Responder à nova mensagem do cliente') returning * into d;
 end if;
 if reopened then
   update public.conversations set status='open', status_changed_at=clock_timestamp(),
     service_revision=service_revision+1,service_started_at=m.sent_at,
     assigned_to_user_id=null,assigned_at=null,assignee_kind=null,active_ai_agent_id=null,
     current_demanda_id=d.id where id=c.id and organization_id=c.organization_id returning * into c;

 else
   update public.conversations set
     service_revision=service_revision+case when current_demanda_id is not null and current_demanda_id<>d.id then 1 else 0 end,
     service_started_at=case when current_demanda_id is not null and current_demanda_id<>d.id then m.sent_at else coalesce(service_started_at,m.sent_at) end,
     current_demanda_id=d.id
    where id=c.id and organization_id=c.organization_id returning * into c;
 end if;
 insert into public.demanda_conversas(organization_id,demanda_id,conversation_id,service_revision)
  values(c.organization_id,d.id,c.id,c.service_revision) on conflict(demanda_id,conversation_id)
  do update set service_revision=excluded.service_revision;
 update public.messages set service_revision=c.service_revision,demanda_id=d.id,demanda_revision=d.revision
  where id=m.id and organization_id=c.organization_id;
end; $$;
revoke execute on function public.fn_service_inbound(uuid) from public,anon,authenticated;
grant execute on function public.fn_service_inbound(uuid) to service_role;

create or replace function public.fn_demanda_abre_no_inbound()
returns trigger language plpgsql security definer set search_path=public as $$
begin perform public.fn_service_inbound(new.id); return new; end; $$;
revoke execute on function public.fn_demanda_abre_no_inbound() from public,anon,authenticated;

-- Comando de status compartilhado pelas duas portas API. Só service_role; o
-- handler verifica RBAC/escopo antes da chamada. CAS nunca regrava um desfecho.
create or replace function public.fn_service_status(p_org uuid,p_conversation uuid,p_status text,p_expected bigint default null)
returns public.conversations language plpgsql security definer set search_path=public as $$
declare c public.conversations; terminal boolean; pre_contact uuid;
begin
 if p_status not in ('closed','resolved','archived','open','pending','ai_handling','claimed') then
  raise exception 'invalid_status' using errcode='22023'; end if;
 select * into c from public.conversations where id=p_conversation and organization_id=p_org;
 if not found then raise exception 'service_not_found' using errcode='P0002'; end if;
 pre_contact:=c.contact_id;
 perform public.fn_service_lock(p_org,c.contact_id);
 select * into c from public.conversations where id=p_conversation and organization_id=p_org for no key update;
 if c.contact_id is distinct from pre_contact then raise exception 'service_contact_changed' using errcode='40001'; end if;
 if p_expected is not null and c.service_revision<>p_expected then raise exception 'service_stale' using errcode='40001'; end if;
 if c.status=p_status then return c; end if;
 terminal := p_status in ('closed','resolved','archived');
 update public.conversations set status=p_status,status_changed_at=clock_timestamp(),
   service_revision=service_revision+case when terminal or c.status in ('closed','resolved','archived') then 1 else 0 end,
   service_closed_at=case when terminal then clock_timestamp() else service_closed_at end,
   service_started_at=case when c.status in ('closed','resolved','archived') and not terminal then clock_timestamp() else service_started_at end,
   bot_silenced_until=case when terminal and last_handoff_at is null then null else bot_silenced_until end,
   current_demanda_id=case when c.status in ('closed','resolved','archived') and not terminal then null else current_demanda_id end
  where id=c.id and organization_id=p_org returning * into c;
 if terminal then
   update public.demandas set proximo_passo=coalesce(proximo_passo,'Revisar atendimento e registrar o desfecho da demanda')
    where organization_id=p_org and id=c.current_demanda_id and fechada_em is null;
 end if;
 return c;
end; $$;
revoke execute on function public.fn_service_status(uuid,uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.fn_service_status(uuid,uuid,text,bigint) to service_role;

create or replace function public.fn_demanda_encerrar(p_org uuid,p_demanda uuid,p_expected bigint,p_desfecho text,p_actor uuid)
returns public.demandas language plpgsql security definer set search_path=public as $$
declare d public.demandas; pre_contact uuid;
begin
 if p_desfecho not in ('resolvida','convertida','nao_procede','encerrada_pelo_cliente','perdida','expirada_sem_resposta') then
  raise exception 'invalid_desfecho' using errcode='22023'; end if;
 select * into d from public.demandas where id=p_demanda and organization_id=p_org;
 if not found then raise exception 'demanda_not_found' using errcode='P0002'; end if;
 pre_contact:=d.contact_id;
 perform public.fn_service_lock(p_org,d.contact_id);
 select * into d from public.demandas where id=p_demanda and organization_id=p_org for no key update;
 if d.contact_id is distinct from pre_contact then raise exception 'service_contact_changed' using errcode='40001'; end if;
 if d.revision<>p_expected or d.fechada_em is not null then raise exception 'demanda_stale' using errcode='40001'; end if;
 update public.demandas set revision=revision+1,desfecho=p_desfecho,fechada_em=clock_timestamp(),
  encerrada_por=p_actor,estado=case when p_desfecho in ('resolvida','convertida') then 'resolvida' else 'encerrada' end,
  proximo_passo=null,proximo_passo_em=null,updated_at=clock_timestamp()
  where id=p_demanda and organization_id=p_org returning * into d;
 insert into public.crm_lead_activities(organization_id,lead_id,contact_id,source_module,source_id,type,payload,performed_at,performed_by_user_id)
 select p_org,l.id,d.contact_id,'crm',d.id,'demand_closed',jsonb_build_object('demanda_id',d.id,'desfecho',p_desfecho),clock_timestamp(),p_actor
 from public.crm_leads l where l.organization_id=p_org and l.contact_id=d.contact_id;
 return d;
end; $$;
revoke execute on function public.fn_demanda_encerrar(uuid,uuid,bigint,text,uuid) from public,anon,authenticated;
grant execute on function public.fn_demanda_encerrar(uuid,uuid,bigint,text,uuid) to service_role;
notify pgrst,'reload schema';

-- Só origem demonstrável. Cron legado/job antigo fica sem provenance e o
-- consumidor o encerra stale; nunca carimbar no claim com a conversa de agora.
create or replace function public.fn_job_service_boundary()
returns trigger language plpgsql security definer set search_path=public as $$
declare b jsonb;
begin
 if new.kind not in ('inbound_turn','followup_turn','case_reply_turn','operator_turn') then return new; end if;
 if new.payload ? 'inbound_message_id' then
   select jsonb_build_object('organization_id',m.organization_id,'contact_id',m.contact_id,
    'conversation_id',m.conversation_id,'service_revision',m.service_revision,
    'demanda_id',m.demanda_id,'demanda_revision',m.demanda_revision) into b
    from public.messages m where m.id::text=new.payload->>'inbound_message_id'
     and m.organization_id=new.organization_id and m.contact_id=new.contact_id and m.service_revision is not null;
 elsif new.payload ? 'origin_job_id' then
   select j.payload->'service_boundary' into b from public.job_queue j
    where j.id::text=new.payload->>'origin_job_id' and j.organization_id=new.organization_id and j.contact_id=new.contact_id;
 elsif new.payload ? 'case_id' then
   select ac.context_snapshot->'service_boundary' into b from public.agent_cases ac
    join public.conversations c on c.id=ac.conversation_id and c.organization_id=ac.organization_id
    where ac.id::text=new.payload->>'case_id' and ac.organization_id=new.organization_id and c.contact_id=new.contact_id;
 else b:=new.payload->'service_boundary'; end if;
 new.payload := (new.payload - 'service_boundary') || jsonb_build_object('service_boundary',b);
 return new;
end; $$;
revoke execute on function public.fn_job_service_boundary() from public,anon,authenticated;
drop trigger if exists trg_job_service_boundary on public.job_queue;
create trigger trg_job_service_boundary before insert on public.job_queue for each row execute function public.fn_job_service_boundary();

-- Defesa para escritores legados de status: só a linha já bloqueada, nenhum
-- advisory/lock de demanda adquirido DEPOIS dela. As APIs usam fn_service_status.
create or replace function public.fn_service_stamp_status()
returns trigger language plpgsql set search_path=public as $$
begin
 if old.status is distinct from new.status and
   (new.status in ('closed','resolved','archived') or old.status in ('closed','resolved','archived')) then
   new.service_revision:=old.service_revision+1;
   if new.status in ('closed','resolved','archived') then
     new.service_closed_at:=clock_timestamp();
     if old.last_handoff_at is null then new.bot_silenced_until:=null; end if;
   else
     if new.service_started_at is not distinct from old.service_started_at then new.service_started_at:=clock_timestamp(); end if;
     if new.current_demanda_id is not distinct from old.current_demanda_id then new.current_demanda_id:=null; end if;
     if new.status<>'claimed' then
       new.assigned_to_user_id:=null; new.assigned_to_user_name:=null; new.assigned_at:=null;
       new.assignee_kind:=null; new.active_ai_agent_id:=null;
     end if;
   end if;
 end if;
 return new;
end; $$;
revoke execute on function public.fn_service_stamp_status() from public,anon,authenticated;
drop trigger if exists trg_service_stamp_status on public.conversations;
create trigger trg_service_stamp_status before update of status on public.conversations
 for each row execute function public.fn_service_stamp_status();

-- Caso guarda sua origem no snapshot já existente. Resposta humana não cria
-- um atendimento novo nem herda a revisão que houver quando for respondido.
create or replace function public.fn_case_service_boundary()
returns trigger language plpgsql security definer set search_path=public as $$
declare b jsonb;
begin
 select jsonb_build_object('organization_id',c.organization_id,'contact_id',c.contact_id,'conversation_id',c.id,
  'service_revision',c.service_revision,'demanda_id',c.current_demanda_id,'demanda_revision',d.revision) into b
  from public.conversations c left join public.demandas d on d.id=c.current_demanda_id and d.organization_id=c.organization_id
  where c.id=new.conversation_id and c.organization_id=new.organization_id;
 new.context_snapshot:=coalesce(new.context_snapshot,'{}'::jsonb)||jsonb_build_object('service_boundary',coalesce(new.context_snapshot->'service_boundary',b));
 return new;
end; $$;
revoke execute on function public.fn_case_service_boundary() from public,anon,authenticated;
drop trigger if exists trg_case_service_boundary on public.agent_cases;
create trigger trg_case_service_boundary before insert on public.agent_cases for each row execute function public.fn_case_service_boundary();

-- Agregados não podem tornar mensagem atrasada um sinal operacional recente.
-- Mesma ordem de mutex da transição, depois conversa e contato.
create or replace function public.fn_mark_conversation_message(p_conv uuid,p_direction text,p_preview text,p_at timestamptz)
returns void language plpgsql security definer set search_path=public as $$
declare c public.conversations; pre_contact uuid;
begin
 select * into c from public.conversations where id=p_conv;
 if not found then return; end if;
 pre_contact:=c.contact_id;
 perform public.fn_service_lock(c.organization_id,c.contact_id);
 select * into c from public.conversations where id=p_conv for no key update;
 if c.contact_id is distinct from pre_contact then raise exception 'service_contact_changed' using errcode='40001'; end if;
 if p_direction='inbound' and p_at<=c.service_closed_at then return; end if;
 update public.conversations set
  last_message_at=greatest(last_message_at,p_at),
  last_message_preview=case when last_message_at is null or p_at>=last_message_at then p_preview else last_message_preview end,
  last_inbound_at=case when p_direction='inbound' then greatest(last_inbound_at,p_at) else last_inbound_at end,
  last_outbound_at=case when p_direction='outbound' then greatest(last_outbound_at,p_at) else last_outbound_at end,
  unread_count_for_assignee=case when p_direction='inbound' then unread_count_for_assignee+1 when p_direction='outbound' then 0 else unread_count_for_assignee end
 where id=p_conv and organization_id=c.organization_id;
 update public.contacts set last_activity_at=greatest(last_activity_at,p_at)
 where id=c.contact_id and organization_id=c.organization_id;
end; $$;
revoke execute on function public.fn_mark_conversation_message(uuid,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_mark_conversation_message(uuid,text,text,timestamptz) to service_role;

-- Reentrada em fila tem consumidor real em lib/routing/worker.ts. Só a
-- transição terminal->fila emite; atribuições subsequentes não produzem eco.
drop trigger if exists trg_service_reopened_routing on public.conversations;
create trigger trg_service_reopened_routing after update of status on public.conversations
 for each row when (old.status in ('closed','resolved','archived') and new.status in ('open','pending')
  and new.assigned_to_user_id is null) execute function public.fn_emit_conversation_routing();

create or replace function public.fn_demanda_revision()
returns trigger language plpgsql set search_path=public as $$
begin
 if new.revision=old.revision and (new.proximo_passo,new.proximo_passo_em,new.estado,new.desfecho,new.fechada_em)
  is distinct from (old.proximo_passo,old.proximo_passo_em,old.estado,old.desfecho,old.fechada_em) then
  new.revision:=old.revision+1;
 end if;
 return new;
end; $$;
revoke execute on function public.fn_demanda_revision() from public,anon,authenticated;
drop trigger if exists trg_demanda_revision on public.demandas;
create trigger trg_demanda_revision before update on public.demandas for each row execute function public.fn_demanda_revision();

-- Snapshot atômico usado tanto pela origem quanto pelo sink.
create or replace function public.fn_service_boundary(p_org uuid,p_conversation uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c public.conversations; d public.demandas;
begin
 select * into c from public.conversations where organization_id=p_org and id=p_conversation;
 if not found then return null; end if;
 if c.current_demanda_id is not null then
  select * into d from public.demandas where organization_id=p_org and contact_id=c.contact_id and id=c.current_demanda_id;
  if not found then raise exception 'service_scope_mismatch' using errcode='23503'; end if;
 end if;
 return jsonb_build_object('organization_id',c.organization_id,'contact_id',c.contact_id,'conversation_id',c.id,
  'service_revision',c.service_revision,'demanda_id',d.id,'demanda_revision',d.revision,
  'status',c.status,'demanda_fechada_em',d.fechada_em,'service_started_at',c.service_started_at);
end; $$;
revoke execute on function public.fn_service_boundary(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_service_boundary(uuid,uuid) to service_role;

-- Nova iniciativa autorizada (humano/MCP/regra), chamada NA ORIGEM, nunca no
-- firing. Uma conversa sem demanda é legítima; não inventa assunto do cliente.
drop function if exists public.fn_service_begin(uuid,uuid,uuid);
drop function if exists public.fn_service_begin(uuid,uuid,uuid,jsonb);
create or replace function public.fn_service_begin(p_org uuid,p_contact uuid,p_session uuid default null,p_observed jsonb default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c public.conversations; sid uuid;
begin
 perform public.fn_service_lock(p_org,p_contact);
 if not exists(select 1 from public.contacts where id=p_contact and organization_id=p_org and not is_anonymized and is_merged_into is null) then
  raise exception 'service_contact_not_found' using errcode='P0002'; end if;
 select * into c from public.conversations where organization_id=p_org and contact_id=p_contact and not is_group
  and (p_session is null or channel_session_id=p_session) order by last_message_at desc nulls last,created_at desc limit 1 for no key update;
 if p_observed is not null then
   if p_observed->>'organization_id' is distinct from p_org::text or p_observed->>'contact_id' is distinct from p_contact::text then
     raise exception 'service_scope_mismatch' using errcode='23503'; end if;
   if c.id is null then
     if p_observed->>'absent' is distinct from 'true' then raise exception 'service_stale' using errcode='40001'; end if;
   elsif public.fn_service_boundary(p_org,c.id) is distinct from p_observed then
     raise exception 'service_stale' using errcode='40001';
   end if;
 end if;
 if c.id is not null then
   if c.status in ('closed','resolved','archived') then
     c:=public.fn_service_status(p_org,c.id,'open',c.service_revision);
   end if;
   if exists(select 1 from public.demandas where id=c.current_demanda_id and organization_id=p_org and fechada_em is not null) then
     update public.conversations set service_revision=service_revision+1,current_demanda_id=null,service_started_at=clock_timestamp()
      where id=c.id and organization_id=p_org returning * into c;
   end if;
   if c.service_started_at is null then
     update public.conversations set service_revision=service_revision+1,service_started_at=clock_timestamp()
      where id=c.id and organization_id=p_org returning * into c;
   end if;
   return public.fn_service_boundary(p_org,c.id);
 end if;
 select id into sid from public.channel_sessions where organization_id=p_org and archived_at is null
  and (p_session is null or id=p_session) order by (status='WORKING') desc,created_at limit 1;
 if sid is null then raise exception 'service_channel_not_found' using errcode='P0002'; end if;
 insert into public.conversations(organization_id,contact_id,channel_session_id,status,is_group,channel,service_started_at)
  values(p_org,p_contact,sid,'open',false,'whatsapp',clock_timestamp()) returning * into c;
 return public.fn_service_boundary(p_org,c.id);
end; $$;
revoke execute on function public.fn_service_begin(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.fn_service_begin(uuid,uuid,uuid,jsonb) to service_role;

alter table public.followup_enrollments add column if not exists service_boundary jsonb;

-- BEFORE só mutex, nunca transição: precede KEY SHARE implícito das FKs do
-- INSERT. Sem isto merge poderia segurar advisory esperando contact FOR UPDATE,
-- enquanto o inbound segura contact KEY SHARE esperando o mesmo advisory.
create or replace function public.fn_message_service_lock()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.direction='inbound' and new.contact_id is not null then perform public.fn_service_lock(new.organization_id,new.contact_id); end if;
 return new;
end; $$;
revoke execute on function public.fn_message_service_lock() from public,anon,authenticated;
drop trigger if exists trg_message_service_lock on public.messages;
create trigger trg_message_service_lock before insert on public.messages for each row execute function public.fn_message_service_lock();

-- Mescla preserva autorização/support gate e adota a mesma ordem de mutex.
CREATE OR REPLACE FUNCTION public.fn_mesclar_contatos(p_organization_id uuid, p_contato_principal uuid, p_contatos_secundarios uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_principal public.contacts%rowtype;
  v_esperado integer;
  v_achado integer;
  v_alvo record;
  v_linha record;
  v_movidas integer;
  v_pulados integer;
  v_repontado jsonb := '{}'::jsonb;
  v_nao_repontado jsonb := '{}'::jsonb;
  v_nome text;
  v_apelido text;
  v_nascimento date;
  v_email text;
  v_telefone text;
  v_lid text;
  v_tags text[];
  v_leads integer := 0;
  v_service_contact uuid;
begin
  if not public.fn_support_write_allowed(p_organization_id) then raise exception 'support_readonly' using errcode='42501'; end if;
  -- 1 · Autorização. Fundir é destrutivo na prática: `manager`, o mesmo piso das
  --     policies de `merge_queue`. Sessão de service role (auth.uid() nulo) não
  --     passa por aqui — quem resolve a org nesse caminho é a rota, de fonte
  --     confiável, nunca do body.
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'manager') then
    raise exception using errcode = '42501', message = 'insufficient_role';
  end if;

  if p_contato_principal is null
     or p_contatos_secundarios is null
     or cardinality(p_contatos_secundarios) = 0
     or p_contato_principal = any(p_contatos_secundarios) then
    raise exception using errcode = '22023', message = 'selecao_de_mesclagem_invalida';
  end if;

  select count(distinct id)::integer into v_esperado
    from unnest(p_contatos_secundarios) as ids(id);
  if v_esperado <> cardinality(p_contatos_secundarios) then
    raise exception using errcode = '22023', message = 'secundario_repetido';
  end if;

  -- Mesmo mutex dos atendimentos, ANTES de qualquer row lock.
  for v_service_contact in select distinct id from unnest(array[p_contato_principal]||p_contatos_secundarios) ids(id) order by id loop
    perform public.fn_service_lock(p_organization_id,v_service_contact);
  end loop;
  perform 1 from public.conversations where organization_id=p_organization_id
    and contact_id=any(array[p_contato_principal]||p_contatos_secundarios) order by id for no key update;

  -- Conversa colidente NÃO aborta a fusão. Duas conversas no mesmo
  -- `channel_session_id` é exatamente COMO a duplicata de WhatsApp nasce (dois
  -- cadastros, dois números, o mesmo número de atendimento), então recusar aqui
  -- fecharia o caminho dominante do recurso — medido: o caso ordinário do
  -- `tests/e2e/juntar-contatos-duplicados.spec.ts` virava 409.
  -- Quem trata a colisão é o passo 5: `uniq_conversations_1to1_per_contact_session`
  -- levanta unique_violation, o repontamento cai para linha a linha, a conversa
  -- que não coube FICA na lápide e sai contada em `nao_repontado` — que a rota
  -- devolve e a tela anuncia ("N registro(s) continuaram no cadastro antigo").
  -- Mensagem não se perde: `messages.contact_id` não tem índice único por
  -- contato e passa inteira para o vencedor.

  -- 2 · O principal existe, é desta org, está vivo — e trava até o fim.
  select * into v_principal from public.contacts
   where id = p_contato_principal
     and organization_id = p_organization_id
     and is_merged_into is null
     and is_anonymized = false
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'contato_principal_indisponivel';
  end if;

  -- 3 · Os secundários também. `is_anonymized = false` não é zelo: L-04 é
  --     irreversível, e reencaixar a linha anonimizada num contato ativo a
  --     traria de volta ao atendimento pela porta dos fundos.
  perform 1 from public.contacts
   where id = any(p_contatos_secundarios)
     and organization_id = p_organization_id
     and is_merged_into is null
     and is_anonymized = false
   for update;
  get diagnostics v_achado = row_count;
  if v_achado <> v_esperado then
    raise exception using errcode = 'P0002', message = 'contato_secundario_indisponivel';
  end if;

  -- 4 · A LÁPIDE VEM ANTES de tudo. É ela que solta telefone/e-mail/CPF dos
  --     índices únicos parciais para o vencedor poder herdá-los no passo 6.
  update public.contacts
     set is_merged_into = p_contato_principal,
         merged_at = now(),
         updated_at = now()
   where organization_id = p_organization_id
     and id = any(p_contatos_secundarios);

  -- Cadeia: quem já tinha sido mesclado NUM dos secundários passa a apontar para
  -- o vencedor. Sem isto, `is_merged_into` vira uma corrente que a leitura teria
  -- de percorrer, e ninguém percorre.
  update public.contacts
     set is_merged_into = p_contato_principal
   where organization_id = p_organization_id
     and is_merged_into = any(p_contatos_secundarios);

  -- 5 · Reponta TODO ponteiro para os perdedores. A lista sai do catálogo; o
  --     polimórfico entra à mão porque catálogo nenhum o conhece.
  for v_alvo in
    select n.nspname as esquema, c.relname as tabela, a.attname as coluna, ''::text as filtro
      from pg_catalog.pg_constraint co
      join pg_catalog.pg_class c on c.oid = co.conrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_attribute a on a.attrelid = co.conrelid and a.attnum = co.conkey[1]
     where co.contype = 'f'
       and co.confrelid = 'public.contacts'::regclass
       and co.conrelid <> 'public.contacts'::regclass
       and array_length(co.conkey, 1) = 1
       and c.relkind = 'r'
       and n.nspname = 'public'
    union all
    select 'public', 'crm_lead_links', 'target_id', ' and target_kind = ''contact'''
     where to_regclass('public.crm_lead_links') is not null
    order by 2, 3
  loop
    v_pulados := 0;
    begin
      execute format(
        'update %I.%I set %I = $1 where %I = any($2)%s',
        v_alvo.esquema, v_alvo.tabela, v_alvo.coluna, v_alvo.coluna, v_alvo.filtro
      ) using p_contato_principal, p_contatos_secundarios;
      get diagnostics v_movidas = row_count;
    exception when unique_violation or exclusion_violation then
      -- Colisão REAL e esperada: `uniq_job_queue_one_running_per_contact` deixa
      -- um job 'running' por contato, e os dois lados podem ter um. Em vez de
      -- abortar a fusão inteira por causa de estado efêmero de runtime, reponta
      -- linha a linha e conta quem ficou. Quem fica NÃO vira FK órfã — continua
      -- apontando para a lápide, que existe.
      v_movidas := 0;
      for v_linha in execute format(
        'select ctid as tid from %I.%I where %I = any($1)%s',
        v_alvo.esquema, v_alvo.tabela, v_alvo.coluna, v_alvo.filtro
      ) using p_contatos_secundarios
      loop
        begin
          execute format(
            'update %I.%I set %I = $1 where ctid = $2',
            v_alvo.esquema, v_alvo.tabela, v_alvo.coluna
          ) using p_contato_principal, v_linha.tid;
          v_movidas := v_movidas + 1;
        exception when unique_violation or exclusion_violation then
          v_pulados := v_pulados + 1;
        end;
      end loop;
    end;

    if v_movidas > 0 then
      v_repontado := v_repontado
        || jsonb_build_object(v_alvo.tabela || '.' || v_alvo.coluna, v_movidas);
    end if;
    if v_pulados > 0 then
      v_nao_repontado := v_nao_repontado
        || jsonb_build_object(v_alvo.tabela || '.' || v_alvo.coluna, v_pulados);
    end if;
  end loop;

  -- 6 · O principal MANDA; o que ele não tem, vem dos perdedores. Nunca o
  --     contrário: sobrescrever o que o atendente digitou seria fusão com
  --     surpresa, e fusão não tem desfazer.
  select c.name into v_nome from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.name is not null
   order by c.created_at, c.id limit 1;
  select c.display_name into v_apelido from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.display_name is not null
   order by c.created_at, c.id limit 1;
  select c.birthdate into v_nascimento from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.birthdate is not null
   order by c.created_at, c.id limit 1;
  select c.email into v_email from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.email is not null
   order by c.created_at, c.id limit 1;
  select c.phone_number into v_telefone from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.phone_number is not null
   order by c.created_at, c.id limit 1;
  -- `wa_identity`/`wa_lid` são GERADAS: o que se herda é a origem delas. Sem
  -- isto o WhatsApp do perdedor fica órfão — `fn_upsert_wa_contact` filtra
  -- `is_merged_into is null`, não acharia mais ninguém e criaria um contato
  -- novo na mensagem seguinte, refazendo a duplicata que acabou de ser desfeita.
  select c.source_metadata->>'waha_lid' into v_lid from public.contacts c
   where c.id = any(p_contatos_secundarios)
     and c.source_metadata->>'waha_lid' is not null
   order by c.created_at, c.id limit 1;

  -- Guardas de unicidade. A lápide já tirou os perdedores dos índices parciais,
  -- então o que sobrar aqui é conflito com um TERCEIRO contato vivo — e nesse
  -- caso o vencedor simplesmente não herda o campo. Falhar a fusão inteira por
  -- causa de um e-mail seria perder o repontamento que já valeu a pena.
  if v_email is not null and exists (
    select 1 from public.contacts o
     where o.organization_id = p_organization_id and o.is_merged_into is null
       and o.id <> p_contato_principal and o.email_normalized = lower(btrim(v_email))
  ) then v_email := null; end if;
  if v_telefone is not null and exists (
    select 1 from public.contacts o
     where o.organization_id = p_organization_id and o.is_merged_into is null
       and o.id <> p_contato_principal and o.phone_number = v_telefone
  ) then v_telefone := null; end if;
  if v_lid is not null and exists (
    select 1 from public.contacts o
     where o.organization_id = p_organization_id and o.is_merged_into is null
       and o.id <> p_contato_principal and o.wa_lid = v_lid
  ) then v_lid := null; end if;

  select coalesce(array_agg(distinct t), '{}'::text[]) into v_tags
    from (
      select unnest(c.tags) as t from public.contacts c
       where c.organization_id = p_organization_id
         and (c.id = p_contato_principal or c.id = any(p_contatos_secundarios))
    ) as todas;

  -- CPF e `consent` NÃO são herdados, de propósito. CPF é um PAR
  -- (`cpf_encrypted` + `cpf_hash`) preso por check constraint e criptografado
  -- com a chave da instalação — mover metade quebra a linha. `consent` é
  -- registro legal do que AQUELA pessoa autorizou; herdar um "granted_at" de
  -- outro cadastro fabricaria consentimento. Falha fechada nos dois.
  update public.contacts set
    name = coalesce(name, v_nome),
    display_name = coalesce(display_name, v_apelido),
    birthdate = coalesce(birthdate, v_nascimento),
    email = coalesce(email, v_email),
    phone_number = coalesce(phone_number, v_telefone),
    tags = v_tags,
    last_activity_at = greatest(
      last_activity_at,
      (select max(c.last_activity_at) from public.contacts c
        where c.id = any(p_contatos_secundarios))
    ),
    source_metadata = (
      case when source_metadata->>'waha_lid' is null and v_lid is not null
        then source_metadata || jsonb_build_object('waha_lid', v_lid)
        else source_metadata end
    )
      - case when coalesce(phone_number, v_telefone) is not null
             then 'telefone_em_conflito' else '' end
      || jsonb_build_object(
           'mesclado_de',
           coalesce(source_metadata->'mesclado_de', '[]'::jsonb)
             || to_jsonb(p_contatos_secundarios),
           'mesclado_em', to_jsonb(now())
         ),
    updated_at = now()
  where id = p_contato_principal and organization_id = p_organization_id;

  -- 7 · A fusão aparece na timeline de cada negócio que o vencedor passou a ter.
  --     `crm_lead_activities.lead_id` é NOT NULL — contato sem negócio nenhum
  --     não tem onde escrever, e para esse caso quem guarda o rastro é o
  --     `api_audit_log` que a rota emite, sempre.
  insert into public.crm_lead_activities
    (organization_id, lead_id, contact_id, source_module, source_id, type,
     payload, metadata, performed_at, performed_by_user_id)
  select p_organization_id, l.id, p_contato_principal, 'crm', p_contato_principal,
         'contacts_merged',
         jsonb_build_object(
           'contatos_mesclados', to_jsonb(p_contatos_secundarios),
           'repontado', v_repontado,
           'nao_repontado', v_nao_repontado
         ),
         '{}'::jsonb, now(), auth.uid()
    from public.crm_leads l
   where l.organization_id = p_organization_id
     and l.contact_id = p_contato_principal;
  get diagnostics v_leads = row_count;

  return jsonb_build_object(
    'contato_id', p_contato_principal,
    'contatos_mesclados', to_jsonb(p_contatos_secundarios),
    'repontado', v_repontado,
    'nao_repontado', v_nao_repontado,
    'atividades_emitidas', v_leads
  );
end;
$function$;

-- Observação da porta de comando. Captura até ausência/terminal sem abrir uma
-- conversa só porque um card mudou de etapa; consumidor autorizado usa CAS.
create or replace function public.fn_service_observe(p_org uuid,p_contact uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare cid uuid;
begin
 select id into cid from public.conversations where organization_id=p_org and contact_id=p_contact and not is_group
  order by last_message_at desc nulls last,created_at desc limit 1;
 if cid is null then return jsonb_build_object('absent',true,'organization_id',p_org,'contact_id',p_contact); end if;
 return public.fn_service_boundary(p_org,cid);
end; $$;
revoke execute on function public.fn_service_observe(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_service_observe(uuid,uuid) to service_role;

-- ---- Backfill de continuidade da fronteira (migration 0222) ----
-- As colunas acima nascem NULAS, e o consumidor lê AUSÊNCIA DE CARIMBO como
-- "fronteira vencida". Numa instalação que já roda, isso não é uma degradação
-- discreta: no primeiro tick depois do `update.sh` todo acompanhamento em
-- curso é cancelado com "Atendimento encerrado ou substituído", a varredura de
-- silêncio fica cega justamente para quem não manda mensagem nova, e o próximo
-- inbound abre uma SEGUNDA demanda aberta na mesma conversa.
-- Carimbamos só o que já é OBSERVÁVEL no trabalho legado — nunca um assunto
-- novo. Idempotente: cada passo toca apenas linha ainda sem carimbo.

-- 1 · Toda conversa tem um começo. Sem ele o histórico de saída some do
--     contexto do agente (`messages.sent_at >= c.service_started_at`).
update public.conversations set service_started_at = created_at
 where service_started_at is null;

-- 2 · A demanda aberta que já estava vinculada à conversa segue sendo a
--     vigente. Sem isto `fn_service_inbound` não acha nada em
--     `x.id = c.current_demanda_id` e abre outra.
with vigente as (
  select distinct on (dc.conversation_id) dc.conversation_id, dc.demanda_id
    from public.demanda_conversas dc
    join public.demandas d
      on d.id = dc.demanda_id and d.organization_id = dc.organization_id
   where d.fechada_em is null
   order by dc.conversation_id, d.aberta_em desc, d.id
)
update public.conversations c
   set current_demanda_id = v.demanda_id
  from vigente v
 where v.conversation_id = c.id
   and c.current_demanda_id is null
   and c.status not in ('closed','resolved','archived');

-- 3 · O vínculo carrega a revisão da conversa; o reaproveitamento exige
--     `dc.service_revision = c.service_revision`.
update public.demanda_conversas dc
   set service_revision = c.service_revision
  from public.conversations c
 where c.id = dc.conversation_id
   and c.organization_id = dc.organization_id
   and dc.service_revision is null;

-- 4 · Mensagem legada pertence ao atendimento vigente da sua conversa.
--     `trg_appointment_inbound` (migration posterior) trata o carimbo como
--     EVENTO de entrada: sem pausá-lo, o backfill replicaria recuperação de
--     agenda para o histórico inteiro. É um `do` único de propósito — sob o
--     autocommit do `update.sh`, ou tudo entra e o gatilho volta, ou nada
--     entra. Se faltar privilégio para pausar, o backfill segue mesmo assim
--     (carimbar tarde é melhor que não carimbar) e o notice registra.
do $$
declare v_pausado boolean := false; v_linhas bigint := 0;
begin
  begin
    if exists (select 1 from pg_trigger
                where tgrelid = 'public.messages'::regclass
                  and tgname = 'trg_appointment_inbound'
                  and not tgisinternal) then
      execute 'alter table public.messages disable trigger trg_appointment_inbound';
      v_pausado := true;
    end if;
  exception when others then
    v_pausado := false;
    -- `warning` e não `notice`: o dump do baseline abre com
    -- `set client_min_messages = warning`, então notice NUNCA chega ao operador.
    raise warning '0222 backfill: nao foi possivel pausar trg_appointment_inbound (%)', sqlerrm;
  end;

  update public.messages m
     set service_revision = c.service_revision,
         demanda_id = c.current_demanda_id,
         demanda_revision = d.revision
    from public.conversations c
    left join public.demandas d
      on d.id = c.current_demanda_id and d.organization_id = c.organization_id
   where c.id = m.conversation_id
     and c.organization_id = m.organization_id
     and m.direction = 'inbound'
     and m.service_revision is null;

  get diagnostics v_linhas = row_count;

  if v_pausado then
    execute 'alter table public.messages enable trigger trg_appointment_inbound';
  end if;
  -- O operador precisa ver o que a atualização mexeu, e este notice é também
  -- o controle positivo de que o gatilho foi de fato pausado durante o carimbo.
  if v_linhas > 0 then
    raise warning '0222 backfill: % mensagem(ns) carimbada(s) (gatilho de agenda pausado: %)', v_linhas, v_pausado;
  end if;
end $$;

-- 5 · Acompanhamento em curso mantém a fronteira da conversa a que já
--     pertence. Linha a linha: `trg_followup_revision` pode recusar a linha de
--     recuperação de agenda cuja recibo já não vale, e uma recusa dessas não
--     pode derrubar o backfill das outras.
do $$
declare r record;
begin
  for r in
    select e.id,
           e.organization_id,
           c.id as conversation_id,
           jsonb_build_object(
             'organization_id', c.organization_id,
             'contact_id',      c.contact_id,
             'conversation_id', c.id,
             'service_revision', c.service_revision,
             'demanda_id',      c.current_demanda_id,
             'demanda_revision', d.revision) as fronteira
      from public.followup_enrollments e
      join public.conversations c
        on c.organization_id = e.organization_id
       and c.contact_id = e.contact_id
       and c.id = coalesce(e.conversation_id, (
             select c2.id from public.conversations c2
              where c2.organization_id = e.organization_id
                and c2.contact_id = e.contact_id
                and not c2.is_group
                and c2.status not in ('closed','resolved','archived')
              order by c2.last_message_at desc nulls last, c2.created_at desc
              limit 1))
      left join public.demandas d
        on d.id = c.current_demanda_id and d.organization_id = c.organization_id
     where e.service_boundary is null
       and e.status not in ('completed','cancelled','dead')
       and c.status not in ('closed','resolved','archived')
  loop
    begin
      update public.followup_enrollments
         set service_boundary = r.fronteira,
             conversation_id  = r.conversation_id
       where id = r.id
         and organization_id = r.organization_id
         and service_boundary is null;
    exception when others then
      raise warning '0222 backfill: acompanhamento % segue sem fronteira (%)', r.id, sqlerrm;
    end;
  end loop;
end $$;
