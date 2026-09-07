-- Task9: publication is configuration; pause/mode are operation. Reply revisions
-- guard ABA without changing ServiceBoundary. Row-local triggers never acquire
-- the service advisory after a row lock. Draft snapshots precede model work.
alter table public.ai_agents add column if not exists operation_mode text not null default 'automatic';
alter table public.ai_agents add column if not exists paused_at timestamptz;
alter table public.ai_agents add column if not exists operation_revision bigint not null default 1;
alter table public.conversations add column if not exists reply_context_revision bigint not null default 1;
alter table public.ai_agents drop constraint if exists ai_agents_operation_mode_check;
alter table public.ai_agents add constraint ai_agents_operation_mode_check check(operation_mode in ('automatic','assisted'));

create or replace function public.fn_reply_agent_revision() returns trigger language plpgsql set search_path=public as $$
begin
 new.operation_revision:=old.operation_revision+case when row(new.operation_mode,new.paused_at,new.published_version_id,new.archived_at,new.config,new.active_kb_version_id)
  is distinct from row(old.operation_mode,old.paused_at,old.published_version_id,old.archived_at,old.config,old.active_kb_version_id) then 1 else 0 end;
 return new;
end;$$;
revoke all on function public.fn_reply_agent_revision() from public,anon,authenticated;
drop trigger if exists trg_reply_agent_revision on public.ai_agents;
create trigger trg_reply_agent_revision before update on public.ai_agents for each row execute function public.fn_reply_agent_revision();
-- A unique persisted inbound changes the response context, independent of its
-- provider timestamp. Duplicate deliveries never INSERT, hence never increment.
-- This observer does not dispatch a turn: historical import is not live inbound.
create or replace function public.fn_reply_inbound_revision() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.direction='inbound' then
  update public.conversations set reply_context_revision=reply_context_revision+1 where organization_id=new.organization_id and id=new.conversation_id and contact_id=new.contact_id;
 end if;
 return new;
end;$$;
revoke all on function public.fn_reply_inbound_revision() from public,anon,authenticated;
-- Preserve explicit increments from the inbound observer; ordinary callers
-- cannot manufacture validity because snapshots originate in the command below.
create or replace function public.fn_reply_conversation_revision() returns trigger language plpgsql set search_path=public as $$
begin
 new.reply_context_revision:=greatest(old.reply_context_revision,new.reply_context_revision)+case when row(new.assigned_to_user_id,new.assignee_kind,new.active_ai_agent_id,new.channel_session_id,new.bot_silenced_until,new.status,new.service_revision,new.current_demanda_id)
 is distinct from row(old.assigned_to_user_id,old.assignee_kind,old.active_ai_agent_id,old.channel_session_id,old.bot_silenced_until,old.status,old.service_revision,old.current_demanda_id) then 1 else 0 end;
 return new;
end;$$;
revoke all on function public.fn_reply_conversation_revision() from public,anon,authenticated;
drop trigger if exists trg_reply_conversation_revision on public.conversations;
create trigger trg_reply_conversation_revision before update on public.conversations for each row execute function public.fn_reply_conversation_revision();
drop trigger if exists trg_reply_inbound_revision on public.messages;
create trigger trg_reply_inbound_revision after insert on public.messages for each row execute function public.fn_reply_inbound_revision();

create or replace function public.fn_reply_channel_revision() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if row(new.status,new.archived_at,new.metadata,new.provider,new.daily_message_limit) is distinct from row(old.status,old.archived_at,old.metadata,old.provider,old.daily_message_limit) then
 update public.conversations set reply_context_revision=reply_context_revision+1 where organization_id=new.organization_id and channel_session_id=new.id;
 end if;return new;
end;$$;
revoke all on function public.fn_reply_channel_revision() from public,anon,authenticated;
drop trigger if exists trg_reply_channel_revision on public.channel_sessions;
create trigger trg_reply_channel_revision after update on public.channel_sessions for each row execute function public.fn_reply_channel_revision();

create table if not exists public.ai_reply_drafts(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id) on delete cascade,
 conversation_id uuid not null references public.conversations(id) on delete cascade,
 contact_id uuid not null references public.contacts(id) on delete cascade,
 agent_id uuid not null references public.ai_agents(id) on delete cascade,
 agent_version_id uuid not null references public.ai_agent_versions(id),
 channel_session_id uuid not null references public.channel_sessions(id),
 service_boundary jsonb not null,context_revision bigint not null,operation_revision bigint not null,
 generation_token uuid not null default gen_random_uuid(),revision bigint not null default 1,status text not null default 'generating' check(status in('generating','pending','approved','sending','sent','dismissed','stale','failed')),
 original_body text,edited_body text,approved_body text,proposals jsonb not null default '[]',trace jsonb not null default '[]',feedback jsonb,
 approved_by uuid references auth.users(id),approved_at timestamptz,approved_support_session_id uuid references public.platform_support_sessions(id),send_job_id uuid unique references public.job_queue(id),message_id uuid references public.messages(id),
 error_code text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(organization_id,conversation_id,agent_id,context_revision,operation_revision)
);
alter table public.ai_reply_drafts enable row level security;
revoke all on public.ai_reply_drafts from anon,authenticated;
grant select on public.ai_reply_drafts to authenticated;
grant all on public.ai_reply_drafts to service_role;
drop policy if exists tenant_isolation_ai_reply_drafts_all on public.ai_reply_drafts;
create policy tenant_isolation_ai_reply_drafts_all on public.ai_reply_drafts for select to authenticated
 using(organization_id in(select public.fn_user_org_ids()) and exists(select 1 from public.conversations c where c.organization_id=ai_reply_drafts.organization_id and c.id=conversation_id and public.fn_can_view_conversation(c.organization_id,c.assigned_to_user_id)));
create index if not exists ai_reply_drafts_conversation on public.ai_reply_drafts(organization_id,conversation_id,created_at desc);

create or replace function public.fn_reply_begin(p_org uuid,p_conversation uuid,p_agent uuid,p_version uuid,p_token uuid)
returns public.ai_reply_drafts language plpgsql security definer set search_path=public as $$
declare c public.conversations;a public.ai_agents;d public.ai_reply_drafts;contact uuid;b jsonb;
begin
 select contact_id into contact from public.conversations where organization_id=p_org and id=p_conversation;
 if contact is null then raise exception 'reply_context_unavailable' using errcode='42501';end if;
 perform public.fn_service_lock(p_org,contact);
 select * into a from public.ai_agents where organization_id=p_org and id=p_agent and archived_at is null for share;
 if not found or a.published_version_id is distinct from p_version then raise exception 'reply_agent_stale' using errcode='40001';end if;
 select * into c from public.conversations where organization_id=p_org and id=p_conversation and contact_id=contact for no key update;
 if c.active_ai_agent_id is not null and c.active_ai_agent_id<>p_agent then raise exception 'reply_agent_stale' using errcode='40001';end if;
 b:=public.fn_service_boundary(p_org,p_conversation)-'status'-'demanda_fechada_em'-'service_started_at';
 if not public.fn_meet_boundary_current(b) or exists(select 1 from public.contacts where organization_id=p_org and id=contact and (is_blocked or is_anonymized)) then raise exception 'reply_context_unavailable' using errcode='42501';end if;
 insert into public.ai_reply_drafts(organization_id,conversation_id,contact_id,agent_id,agent_version_id,channel_session_id,service_boundary,context_revision,operation_revision,generation_token)
 values(p_org,p_conversation,contact,p_agent,p_version,c.channel_session_id,b,c.reply_context_revision,a.operation_revision,p_token)
 on conflict(organization_id,conversation_id,agent_id,context_revision,operation_revision) do update set
 generation_token=case when (ai_reply_drafts.status='failed' or (ai_reply_drafts.status='generating' and ai_reply_drafts.updated_at<now()-interval '10 minutes')) then p_token else ai_reply_drafts.generation_token end,
 status=case when (ai_reply_drafts.status='failed' or (ai_reply_drafts.status='generating' and ai_reply_drafts.updated_at<now()-interval '10 minutes')) then 'generating' else ai_reply_drafts.status end,
 revision=ai_reply_drafts.revision+case when (ai_reply_drafts.status='failed' or (ai_reply_drafts.status='generating' and ai_reply_drafts.updated_at<now()-interval '10 minutes')) then 1 else 0 end,updated_at=now()
 returning * into d;return d;
end;$$;
revoke all on function public.fn_reply_begin(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_reply_begin(uuid,uuid,uuid,uuid,uuid) to service_role;

create or replace function public.fn_reply_context_current(p_org uuid,p_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.ai_reply_drafts d join public.conversations c on c.organization_id=d.organization_id and c.id=d.conversation_id and c.contact_id=d.contact_id
 join public.ai_agents a on a.organization_id=d.organization_id and a.id=d.agent_id
 join public.contacts p on p.organization_id=d.organization_id and p.id=d.contact_id
 join public.channel_sessions s on s.organization_id=d.organization_id and s.id=d.channel_session_id
 where d.organization_id=p_org and d.id=p_id and c.reply_context_revision=d.context_revision and a.operation_revision=d.operation_revision
 and a.archived_at is null and a.published_version_id=d.agent_version_id and c.channel_session_id=d.channel_session_id and s.archived_at is null
 and not p.is_blocked and not p.is_anonymized and public.fn_meet_boundary_current(d.service_boundary));
$$;
revoke all on function public.fn_reply_context_current(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_reply_context_current(uuid,uuid) to service_role;

create or replace function public.fn_reply_action(p_org uuid,p_id uuid,p_revision text,p_action text,p_body text default null,p_feedback text default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare d public.ai_reply_drafts;contact uuid;jid uuid;a uuid;
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'agent') or not public.fn_support_write_allowed(p_org) or not public.fn_session_mfa_proven() then raise exception 'reply_forbidden' using errcode='42501';end if;
 select contact_id,agent_id into contact,a from public.ai_reply_drafts where organization_id=p_org and id=p_id;
 if contact is null then raise exception 'reply_forbidden' using errcode='42501';end if;
 perform public.fn_service_lock(p_org,contact);
 perform 1 from public.ai_agents where organization_id=p_org and id=a for share;
 perform 1 from public.conversations c join public.ai_reply_drafts r on r.organization_id=c.organization_id and r.conversation_id=c.id where r.organization_id=p_org and r.id=p_id and public.fn_can_view_conversation(c.organization_id,c.assigned_to_user_id) for share of c;
 if not found then raise exception 'reply_forbidden' using errcode='42501';end if;
 select * into d from public.ai_reply_drafts where organization_id=p_org and id=p_id for update;
 if d.status in('approved','sending','sent') and p_action='approve' and d.approved_by=auth.uid() and d.approved_body=p_body then return d.send_job_id;end if;
 if d.revision::text is distinct from p_revision or d.status<>'pending' or not public.fn_reply_context_current(p_org,p_id) then raise exception 'reply_stale' using errcode='40001';end if;
 if p_action='reject' then
 update public.ai_reply_drafts set status='dismissed',feedback=jsonb_build_object('decision','rejected','reason',left(p_feedback,1000)),revision=revision+1,updated_at=now() where id=p_id and organization_id=p_org;return null;
 elsif p_action='approve' then
 if p_body is null or length(trim(p_body))=0 or length(p_body)>12000 then raise exception 'reply_body_invalid' using errcode='22023';end if;
 jid:=gen_random_uuid();
 insert into public.job_queue(id,organization_id,contact_id,kind,payload,run_after) values(jid,p_org,contact,'approved_reply',jsonb_build_object('draft_id',d.id,'service_boundary',d.service_boundary),now());
 update public.ai_reply_drafts set status='approved',edited_body=p_body,approved_body=p_body,approved_by=auth.uid(),approved_at=now(),approved_support_session_id=case when public.fn_support_context()->>'organization_id'=p_org::text then (public.fn_support_context()->>'id')::uuid else null end,send_job_id=jid,
 feedback=jsonb_build_object('decision',case when p_body is distinct from original_body then 'edited' else 'approved' end,'reason',left(p_feedback,1000),'correction',case when p_body is distinct from original_body then p_body else null end),revision=revision+1,updated_at=now()
 where id=p_id and organization_id=p_org;return jid;
 end if;
 raise exception 'reply_action_invalid' using errcode='22023';
end;$$;
revoke all on function public.fn_reply_action(uuid,uuid,text,text,text,text) from public,anon;
grant execute on function public.fn_reply_action(uuid,uuid,text,text,text,text) to authenticated;

create or replace function public.fn_reply_delivery_policy(p_org uuid,p_job uuid,p_worker text,p_acquired_at timestamptz)
returns jsonb language sql stable security definer set search_path=public as $$
 select coalesce((select jsonb_build_object('current',true,'context_current',public.fn_reply_context_current(p_org,d.id),
 'contact_id',d.contact_id,'conversation_id',d.conversation_id,'channel_session_id',d.channel_session_id,'draft_id',d.id,'body',d.approved_body,'agent_id',d.agent_id)
 from public.job_queue j join public.ai_reply_drafts d on d.organization_id=j.organization_id and d.send_job_id=j.id and d.id::text=j.payload->>'draft_id'
 join public.conversations c on c.organization_id=d.organization_id and c.id=d.conversation_id and c.contact_id=d.contact_id
 join public.contacts p on p.organization_id=d.organization_id and p.id=d.contact_id
 join public.channel_sessions s on s.organization_id=d.organization_id and s.id=d.channel_session_id
 left join public.user_organizations u on u.organization_id=d.organization_id and u.user_id=d.approved_by and u.revoked_at is null and u.role in('agent','manager','admin')
 left join public.platform_support_sessions ss on ss.id=d.approved_support_session_id and ss.organization_id=d.organization_id and ss.actor_user_id=d.approved_by and ss.access_mode='full' and ss.ended_at is null and ss.expires_at>now()
 left join public.platform_admins pa on pa.user_id=ss.actor_user_id and pa.revoked_at is null and pa.scope='full'
 left join auth.sessions au on au.id=ss.auth_session_id and au.user_id=ss.actor_user_id and (au.not_after is null or au.not_after>now())
 join public.organizations o on o.id=d.organization_id and o.status='active'
 where j.organization_id=p_org and j.id=p_job and j.kind='approved_reply' and j.status='running' and j.locked_by=p_worker and j.locked_at=p_acquired_at
 and j.contact_id=d.contact_id and d.status in('approved','sending') and d.approved_body is not null and d.service_boundary=j.payload->'service_boundary'
 and not p.is_blocked and not p.is_anonymized and s.archived_at is null and c.channel_session_id=d.channel_session_id
 and public.fn_meet_boundary_current(d.service_boundary)
 and((d.approved_support_session_id is not null and ss.id is not null and pa.user_id is not null and au.id is not null and (not(pa.mfa_required or exists(select 1 from auth.mfa_factors mf where mf.user_id=ss.actor_user_id and mf.status='verified')) or au.aal='aal2'))
 or(d.approved_support_session_id is null and u.user_id is not null and(u.role in('manager','admin') or c.assigned_to_user_id=u.user_id or o.settings->>'visibility_mode'='all' or(coalesce(o.settings->>'visibility_mode','own_and_unassigned')='own_and_unassigned' and c.assigned_to_user_id is null))))),'{"current":false}'::jsonb);
$$;
revoke all on function public.fn_reply_delivery_policy(uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_reply_delivery_policy(uuid,uuid,text,timestamptz) to service_role;

create or replace function public.fn_reply_receipt_policy(p_org uuid,p_job uuid,p_worker text,p_acquired_at timestamptz)
returns jsonb language sql stable security definer set search_path=public as $$
 select coalesce((select jsonb_build_object('current',true,'context_current',false,'contact_id',d.contact_id,'conversation_id',d.conversation_id,'channel_session_id',d.channel_session_id,'draft_id',d.id,'body',d.approved_body,'agent_id',d.agent_id)
 from public.job_queue j join public.ai_reply_drafts d on d.organization_id=j.organization_id and d.send_job_id=j.id and d.id::text=j.payload->>'draft_id'
 join public.contacts p on p.organization_id=d.organization_id and p.id=d.contact_id and not p.is_anonymized
 join public.conversations c on c.organization_id=d.organization_id and c.id=d.conversation_id and c.contact_id=d.contact_id
 where j.organization_id=p_org and j.id=p_job and j.kind='approved_reply' and j.contact_id=d.contact_id and j.status='running' and j.locked_by=p_worker and j.locked_at=p_acquired_at and d.status in('approved','sending') and d.approved_body is not null and d.service_boundary=j.payload->'service_boundary'),'{"current":false}'::jsonb);
$$;
revoke all on function public.fn_reply_receipt_policy(uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_reply_receipt_policy(uuid,uuid,text,timestamptz) to service_role;

alter table public.agent_inbox_items add column if not exists legacy_recovery_code text check(legacy_recovery_code in('sem_canal','sem_credencial','sem_modelo','modelo_ambiguo','sem_versao','migracao_falhou','pronto'));
-- Referência tipada abre o agente; causa estruturada registra a última transição.
create or replace function public.fn_agent_legacy_notice(p_org uuid,p_agent uuid,p_code text,p_title text,p_body text)
returns boolean language plpgsql security definer set search_path=public as $$
declare prior text;a public.ai_agents;
begin
 if p_code not in('sem_canal','sem_credencial','sem_modelo','modelo_ambiguo','sem_versao','migracao_falhou','pronto') then raise exception 'invalid_legacy_state';end if;
 select * into a from public.ai_agents where organization_id=p_org and id=p_agent and kind='rag_bot' for update;
 if not found or a.archived_at is not null then return false;end if;
 -- Revalidar a observação anterior do worker, dentro da mesma serialização.
 if p_code<>'pronto' and(a.published_version_id is not null or a.paused_at is not null or not a.is_active) then return false;end if;
 if p_code='pronto' and a.published_version_id is null then return false;end if;
 select legacy_recovery_code into prior from public.agent_inbox_items where organization_id=p_org and ref_id=p_agent and ref_kind='ai_agent' and legacy_recovery_code is not null order by created_at desc,id desc limit 1;
 if prior=p_code then return false;end if;
 if p_code='pronto' and prior is null then return false;end if;
 if p_code='sem_versao' and prior is not null and prior<>'pronto' then return false;end if;
 update public.agent_inbox_items set status='resolved',resolved_at=now() where organization_id=p_org and ref_id=p_agent and ref_kind='ai_agent' and legacy_recovery_code is not null and status in('open','ack');
 insert into public.agent_inbox_items(organization_id,kind,severity,title,body,ref_kind,ref_id,legacy_recovery_code,status,created_at,resolved_at)
 values(p_org,'other',case when p_code='pronto' then 'info' else 'warn' end,left(p_title,200),left(p_body,1500),'ai_agent',p_agent,p_code,case when p_code='pronto' then 'resolved' else 'open' end,clock_timestamp(),case when p_code='pronto' then now() else null end);
 return true;
end;$$;
revoke all on function public.fn_agent_legacy_notice(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.fn_agent_legacy_notice(uuid,uuid,text,text,text) to service_role;
create or replace function public.fn_agent_legacy_published() returns trigger language plpgsql security definer set search_path=public as $$
begin
 perform public.fn_agent_legacy_notice(new.organization_id,new.id,'pronto','Agente recuperado','A configuração foi recuperada. As respostas usam a versão publicada.');
 return new;
end;$$;
revoke all on function public.fn_agent_legacy_published() from public,anon,authenticated;
drop trigger if exists trg_agent_legacy_published on public.ai_agents;
create trigger trg_agent_legacy_published after update of published_version_id on public.ai_agents for each row when(new.kind='rag_bot' and new.published_version_id is not null and new.published_version_id is distinct from old.published_version_id) execute function public.fn_agent_legacy_published();

-- Reconhecimento é atômico com as escritas locais. Não exige autoridade para
-- um novo envio, mas mantém identidade, lease e redação até o commit.
create or replace function public.fn_reply_record_receipt(p_org uuid,p_job uuid,p_worker text,p_acquired_at timestamptz,p_message uuid,p_external text,p_echo_ids text[] default '{}')
returns jsonb language plpgsql security definer set search_path=public as $$
declare contact uuid;d public.ai_reply_drafts;m public.messages;
begin
 select contact_id into contact from public.job_queue where organization_id=p_org and id=p_job;
 if contact is null then return null;end if;
 perform public.fn_service_lock(p_org,contact);
 perform 1 from public.contacts where organization_id=p_org and id=contact and not is_anonymized for share;
 if not found then return null;end if;
 select * into d from public.ai_reply_drafts where organization_id=p_org and send_job_id=p_job;
 if not found then return null;end if;
 perform 1 from public.conversations where organization_id=p_org and id=d.conversation_id and contact_id=contact for no key update;
 if not found then return null;end if;
 perform 1 from public.job_queue where organization_id=p_org and id=p_job for update;
 perform 1 from public.ai_reply_drafts where organization_id=p_org and id=d.id for update;
 if public.fn_reply_receipt_policy(p_org,p_job,p_worker,p_acquired_at)->>'current'<>'true' then return null;end if;
 select * into m from public.messages where organization_id=p_org and id=p_message and conversation_id=d.conversation_id and contact_id=d.contact_id and channel_session_id=d.channel_session_id and direction='outbound' and type='text' and body=d.approved_body and exists(select 1 from public.send_ledger l where l.organization_id=p_org and l.job_id=p_job and l.seq=1 and l.id::text=messages.metadata->>'idempotency_key') for update;
 if not found then return null;end if;
 delete from public.messages where organization_id=p_org and conversation_id=d.conversation_id and sent_via='external_device' and external_id=any(p_echo_ids) and id<>p_message;
 update public.messages set status='sent',external_id=p_external,ack=0 where organization_id=p_org and id=p_message returning * into m;
 update public.send_ledger set status='accepted',crm_message_id=p_message,updated_at=now(),last_error=null where organization_id=p_org and job_id=p_job and seq=1 and id::text=m.metadata->>'idempotency_key';
 update public.conversations set last_outbound_at=now(),last_message_at=now(),last_message_preview=left(d.approved_body,280),unread_count_for_assignee=0 where organization_id=p_org and id=d.conversation_id;
 update public.contacts set last_activity_at=now() where organization_id=p_org and id=contact;
 return to_jsonb(m);
end;$$;
revoke all on function public.fn_reply_record_receipt(uuid,uuid,text,timestamptz,uuid,text,text[]) from public,anon,authenticated;
grant execute on function public.fn_reply_record_receipt(uuid,uuid,text,timestamptz,uuid,text,text[]) to service_role;

create or replace function public.fn_reply_settle(p_org uuid,p_job uuid,p_worker text,p_acquired_at timestamptz,p_state text,p_error text default null)
returns boolean language plpgsql security definer set search_path=public as $$
declare j public.job_queue;d public.ai_reply_drafts;contact uuid;pol jsonb;
begin
 select contact_id into contact from public.job_queue where organization_id=p_org and id=p_job;
 if contact is null then return false;end if;perform public.fn_service_lock(p_org,contact);
 select * into j from public.job_queue where organization_id=p_org and id=p_job for update;
 if not found or j.kind<>'approved_reply' or j.status<>'running' or j.locked_by is distinct from p_worker or j.locked_at is distinct from p_acquired_at then return false;end if;
 select * into d from public.ai_reply_drafts where organization_id=p_org and send_job_id=p_job for update;
 if not found then return false;end if;
 pol:=public.fn_reply_delivery_policy(p_org,p_job,p_worker,p_acquired_at);
 if p_state='sent' then
 if not exists(select 1 from public.send_ledger where organization_id=p_org and job_id=p_job and seq=1 and status='accepted') then p_state:='stale';end if;
 elsif p_state in('queued','retry') and (pol->>'current'<>'true' or pol->>'context_current'<>'true') then p_state:='stale';end if;
 if p_state in('queued','retry') and j.attempts<j.max_attempts then
 update public.job_queue set status='pending',locked_by=null,locked_at=null,run_after=now()+interval '1 minute',attempts=case when p_state='queued' then greatest(0,attempts-1) else attempts end where organization_id=p_org and id=p_job;
 update public.ai_reply_drafts set status='approved',error_code=p_error,updated_at=now() where organization_id=p_org and id=d.id;
 else
 if p_state not in('sent','stale','failed') then p_state:='failed';end if;
 update public.job_queue set status=case when p_state='sent' then 'done' else 'failed' end,locked_at=null,locked_by=null,last_error=p_error where organization_id=p_org and id=p_job;
 update public.ai_reply_drafts set status=p_state,error_code=p_error,message_id=(select crm_message_id from public.send_ledger where organization_id=p_org and job_id=p_job and seq=1 and status='accepted'),updated_at=now() where organization_id=p_org and id=d.id;
 end if;return true;
end;$$;
revoke all on function public.fn_reply_settle(uuid,uuid,text,timestamptz,text,text) from public,anon,authenticated;
grant execute on function public.fn_reply_settle(uuid,uuid,text,timestamptz,text,text) to service_role;

create or replace function public.fn_reply_redact() returns trigger language plpgsql security definer set search_path=public as $$
begin
 update public.ai_reply_drafts set original_body=null,edited_body=null,approved_body=null,proposals='[]',trace='[]',feedback=null,status=case when status='sent' then status else 'stale' end,error_code='redacted',updated_at=now() where organization_id=new.organization_id and contact_id=new.id;
 update public.job_queue set payload='{}',status=case when status in('pending','running') then 'failed' else status end,locked_by=null,locked_at=null,last_error='reply_redacted' where organization_id=new.organization_id and contact_id=new.id and kind='approved_reply';
 return new;
end;$$;
revoke all on function public.fn_reply_redact() from public,anon,authenticated;
drop trigger if exists trg_reply_redact on public.contacts;
create trigger trg_reply_redact after update of is_anonymized on public.contacts for each row when(new.is_anonymized and not old.is_anonymized) execute function public.fn_reply_redact();

-- Vocabulary in baseline is consolidated in its original canonical block.
alter table public.job_queue drop constraint if exists job_queue_kind_check;
alter table public.job_queue add constraint job_queue_kind_check check(kind in('inbound_turn','followup_turn','watchdog','flywheel','case_reply_turn','operator_turn','transactional_delivery','approved_reply'));
alter table public.job_queue drop constraint if exists job_queue_turn_needs_contact;
alter table public.job_queue add constraint job_queue_turn_needs_contact check((kind in('inbound_turn','followup_turn','case_reply_turn','operator_turn','transactional_delivery','approved_reply'))=(contact_id is not null));
-- Last preparation/cut: same locks as snapshots, then atomic sending CAS.
-- The following network attempt is irreversible; receipt reconciliation is not
-- another attempt. No service mutex is taken by a row-local revision trigger.
create or replace function public.fn_reply_prepare(p_org uuid,p_job uuid,p_worker text,p_acquired_at timestamptz)
returns boolean language plpgsql security definer set search_path=public as $$
declare d public.ai_reply_drafts;pol jsonb;
begin
 select * into d from public.ai_reply_drafts where organization_id=p_org and send_job_id=p_job;
 if not found then return false;end if;
 perform public.fn_service_lock(p_org,d.contact_id);
 perform 1 from public.ai_agents where organization_id=p_org and id=d.agent_id for share;
 perform 1 from public.conversations where organization_id=p_org and id=d.conversation_id for share;
 perform 1 from public.job_queue where organization_id=p_org and id=p_job for update;
 perform 1 from public.ai_reply_drafts where organization_id=p_org and id=d.id for update;
 pol:=public.fn_reply_delivery_policy(p_org,p_job,p_worker,p_acquired_at);
 if pol->>'current'<>'true' or pol->>'context_current'<>'true' then return false;end if;
 update public.ai_reply_drafts set status='sending',updated_at=now() where organization_id=p_org and id=d.id;
 return true;
end;$$;
revoke all on function public.fn_reply_prepare(uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_reply_prepare(uuid,uuid,text,timestamptz) to service_role;


alter table public.ai_agent_versions add column if not exists provisioning_origin text check(provisioning_origin in('onboarding','legacy_reconciliation'));
create or replace function public.fn_agent_provisioning_origin() returns trigger language plpgsql set search_path=public as $$
begin
 if tg_op='INSERT' then
  if current_user not in('postgres','service_role') then new.provisioning_origin:=null;end if;
 else
  new.provisioning_origin:=old.provisioning_origin;
  if(to_jsonb(new)-array['status','published_at','superseded_at','updated_at','provisioning_origin']) is distinct from(to_jsonb(old)-array['status','published_at','superseded_at','updated_at','provisioning_origin']) then new.provisioning_origin:=null;end if;
 end if;return new;
end;$$;
revoke all on function public.fn_agent_provisioning_origin() from public,anon,authenticated;
drop trigger if exists trg_agent_provisioning_origin on public.ai_agent_versions;
create trigger trg_agent_provisioning_origin before insert or update on public.ai_agent_versions for each row execute function public.fn_agent_provisioning_origin();

-- Shared atomic publication; platform keys stay server-owned.
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
  select c.id, c.organization_id, c.provider, c.is_active, c.validated_at
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

  select s.id, s.organization_id, s.status
    into v_session
  from public.channel_sessions s
  where s.id = v_version.channel_session_id;

  if not found or v_session.organization_id <> p_org_id then
    raise exception 'channel_session_not_found' using errcode = 'P0001';
  end if;
  if v_session.status <> 'WORKING' then
    raise exception 'channel_session_offline' using errcode = 'P0001';
  end if;

  select count(*)
    into v_model_count
  from public.ai_models m
  where m.provider = v_version.provider
    and m.model_id = v_version.model
    and m.deprecated_at is null;

  if v_model_count = 0 then
    raise exception 'model_not_found' using errcode = 'P0001';
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

revoke all on function public.fn_publish_ai_agent_version(uuid,uuid,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.fn_publish_ai_agent_version(uuid,uuid,uuid,boolean,text) to service_role;
create or replace function public.fn_publish_ai_agent_version(p_org_id uuid,p_agent_id uuid,p_version_id uuid,p_platform_credential_verified boolean)
returns table(agent_id uuid,version_id uuid,previous_version_id uuid,published_at timestamptz)
language sql security definer set search_path=public as $$
 select * from public.fn_publish_ai_agent_version(p_org_id,p_agent_id,p_version_id,p_platform_credential_verified,null);
$$;
revoke all on function public.fn_publish_ai_agent_version(uuid,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.fn_publish_ai_agent_version(uuid,uuid,uuid,boolean) to service_role;
create or replace function public.fn_publish_ai_agent_version(p_org_id uuid,p_agent_id uuid,p_version_id uuid)
returns table(agent_id uuid,version_id uuid,previous_version_id uuid,published_at timestamptz)
language sql security definer set search_path=public as $$
 select * from public.fn_publish_ai_agent_version(p_org_id,p_agent_id,p_version_id,false);
$$;
