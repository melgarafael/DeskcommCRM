-- Continuidade durável das DMs e vínculos entre organizações cercados no banco.
alter table public.social_connections add column if not exists webhook_setup_token uuid;
alter table public.social_connections add column if not exists webhook_setup_until timestamptz;
alter table public.social_connections add column if not exists last_test_at timestamptz;

create unique index if not exists social_connections_id_org_unique on public.social_connections(id,organization_id);
alter table public.channel_sessions drop constraint if exists channel_sessions_social_tenant_fk;
alter table public.channel_sessions add constraint channel_sessions_social_tenant_fk foreign key(social_connection_id,organization_id) references public.social_connections(id,organization_id);
drop policy if exists tenant_isolation_social_connections_all on public.social_connections;
create policy tenant_isolation_social_connections_all on public.social_connections
 using(organization_id in(select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id,'admin'))
 with check(organization_id in(select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id,'admin'));
drop policy if exists tenant_isolation_social_webhook_receipts_all on public.social_webhook_receipts;
create policy tenant_isolation_social_webhook_receipts_all on public.social_webhook_receipts
 using(organization_id in(select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id,'admin'))
 with check(organization_id in(select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id,'admin'));
create or replace function public.fn_ingest_social_dm(p_org uuid,p_session uuid,p_message jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.channel_sessions; c public.conversations; cid uuid; mid uuid; stamp timestamptz; existing_message uuid;
begin
 select * into s from public.channel_sessions where id=p_session and organization_id=p_org and provider='socios_hub' and archived_at is null;
 if s.id is null or s.social_channel_id<>p_message->>'channel_id' or s.social_network<>p_message->>'channel' then raise exception 'social_channel_mismatch'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_session::text||':'||(p_message->>'conversation_id'),0));
 select * into c from public.conversations where organization_id=p_org and channel_session_id=p_session and provider_conversation_id=p_message->>'conversation_id';
 if c.id is null then
   insert into public.contacts(organization_id,name,display_name,source) values(p_org,p_message->>'name',p_message->>'name',s.social_network) returning id into cid;
   insert into public.conversations(organization_id,contact_id,channel_session_id,channel,provider_conversation_id,provider_recipient_id)
   values(p_org,cid,p_session,s.social_network,p_message->>'conversation_id',p_message->>'recipient_id') returning * into c;
 elsif c.provider_recipient_id is distinct from p_message->>'recipient_id' then raise exception 'social_identity_mismatch';
 end if;
 select id into existing_message from public.messages where organization_id=p_org and external_id=p_message->>'external_id';
 if existing_message is not null and not exists(select 1 from public.messages where id=existing_message and conversation_id=c.id and organization_id=p_org) then raise exception 'social_identity_mismatch'; end if;
 if existing_message is not null then return jsonb_build_object('message_id',existing_message,'conversation_id',c.id,'contact_id',c.contact_id,'duplicate',true); end if;
 stamp:=least(to_timestamp((p_message->>'timestamp')::double precision/1000),now());
 insert into public.messages(organization_id,conversation_id,channel_session_id,contact_id,external_id,type,direction,status,body,media_url,sent_at)
 values(p_org,c.id,p_session,c.contact_id,p_message->>'external_id',p_message->>'type','inbound','received',p_message->>'body',p_message->>'media_url',stamp) returning id into mid;
 update public.conversations set last_inbound_at=greatest(last_inbound_at,stamp),last_message_at=greatest(last_message_at,stamp),
 last_message_preview=case when last_message_at is null or last_message_at<=stamp then left(p_message->>'body',160) else last_message_preview end
 where id=c.id and organization_id=p_org;
 perform public.emit_event('social.dm_received','message',mid,jsonb_build_object('message_id',mid),'{}'::jsonb,p_org);
 if p_message->>'media_url' is not null then
 perform public.emit_event('media.persist_requested','message',mid,jsonb_build_object('message_id',mid,'conversation_id',c.id),'{}'::jsonb,p_org);
 end if;
 return jsonb_build_object('message_id',mid,'conversation_id',c.id,'contact_id',c.contact_id,'duplicate',false);
end; $$;
revoke execute on function public.fn_ingest_social_dm(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.fn_ingest_social_dm(uuid,uuid,jsonb) to service_role;

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
 update public.messages set status=case when status in('delivered','read','failed') then status when exists(select 1 from public.channel_sessions s where s.id=m.channel_session_id and s.organization_id=p_org and s.provider='socios_hub') then 'sending' else 'sent' end,external_id=p_external,ack=0 where organization_id=p_org and id=p_message returning * into m;
 update public.send_ledger set status='accepted',crm_message_id=p_message,updated_at=now(),last_error=null where organization_id=p_org and job_id=p_job and seq=1 and id::text=m.metadata->>'idempotency_key';
 update public.conversations set last_outbound_at=now(),last_message_at=now(),last_message_preview=left(d.approved_body,280),unread_count_for_assignee=0 where organization_id=p_org and id=d.conversation_id;
 update public.contacts set last_activity_at=now() where organization_id=p_org and id=contact;
 return to_jsonb(m);
end;$$;
revoke all on function public.fn_reply_record_receipt(uuid,uuid,text,timestamptz,uuid,text,text[]) from public,anon,authenticated;
grant execute on function public.fn_reply_record_receipt(uuid,uuid,text,timestamptz,uuid,text,text[]) to service_role;
