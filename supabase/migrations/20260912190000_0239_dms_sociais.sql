-- DMs sociais: credencial de subconta por organização; identidade opaca por canal.
create table if not exists public.social_connections (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 account_id text not null unique,
 credential jsonb not null,
 webhook_token uuid not null default gen_random_uuid() unique,
 webhook_id text,
 webhook_secret jsonb,
 webhook_url text,
 last_event_at timestamptz,
 created_at timestamptz not null default now(),
 unique(organization_id)
);
alter table public.social_connections enable row level security;
drop policy if exists tenant_isolation_social_connections_all on public.social_connections;
create policy tenant_isolation_social_connections_all on public.social_connections
 using(organization_id in(select public.fn_user_org_ids()))
 with check(organization_id in(select public.fn_user_org_ids()));
-- Segredos não são consultáveis pela REST autenticada; a rota administrativa projeta só estado.
revoke all on public.social_connections from public, anon, authenticated;
grant all on public.social_connections to service_role;

alter table public.channel_sessions add column if not exists social_channel_id text;
alter table public.channel_sessions add column if not exists social_connection_id uuid references public.social_connections(id) on delete restrict;
alter table public.channel_sessions add column if not exists social_network text;
alter table public.channel_sessions drop constraint if exists channel_sessions_provider_check;
alter table public.channel_sessions add constraint channel_sessions_provider_check check(provider in('waha','meta_cloud','zernio','wacalls','socios_hub'));
alter table public.channel_sessions drop constraint if exists channel_sessions_provider_ref_check;
alter table public.channel_sessions add constraint channel_sessions_provider_ref_check check(
 (provider='waha' and waha_session_name is not null) or
 (provider='meta_cloud' and meta_phone_number_id is not null) or
 (provider='zernio' and zernio_account_id is not null) or
 (provider='wacalls' and wacalls_session_id is not null) or
 (provider='socios_hub' and social_channel_id is not null and social_connection_id is not null and social_network in('instagram','messenger'))
);
create unique index if not exists channel_sessions_social_unique on public.channel_sessions(social_channel_id) where provider='socios_hub';
alter table public.conversations add column if not exists provider_recipient_id text;
alter table public.conversations drop constraint if exists conversations_channel_check;
alter table public.conversations add constraint conversations_channel_check check(channel in('whatsapp','instagram','messenger'));

-- Um recibo por evento: só confirma ao HUB quando o processamento terminou.
create table if not exists public.social_webhook_receipts (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 event_id text not null,
 completed_at timestamptz not null default now(),
 primary key(organization_id,event_id)
);
alter table public.social_webhook_receipts enable row level security;
drop policy if exists tenant_isolation_social_webhook_receipts_all on public.social_webhook_receipts;
create policy tenant_isolation_social_webhook_receipts_all on public.social_webhook_receipts
 using(organization_id in(select public.fn_user_org_ids()))
 with check(organization_id in(select public.fn_user_org_ids()));
revoke all on public.social_webhook_receipts from public, anon, authenticated;
grant all on public.social_webhook_receipts to service_role;

-- Toda âncora vem da sessão autenticada pela assinatura. Serializa a thread,
-- sem inventar telefone e sem misturar identificadores de páginas diferentes.
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
 if existing_message is not null then return jsonb_build_object('message_id',existing_message,'conversation_id',c.id,'contact_id',c.contact_id,'duplicate',true); end if;
 stamp:=least(to_timestamp((p_message->>'timestamp')::double precision/1000),now());
 insert into public.messages(organization_id,conversation_id,channel_session_id,contact_id,external_id,type,direction,status,body,media_url,sent_at)
 values(p_org,c.id,p_session,c.contact_id,p_message->>'external_id',p_message->>'type','inbound','received',p_message->>'body',p_message->>'media_url',stamp) returning id into mid;
 update public.conversations set last_inbound_at=greatest(last_inbound_at,stamp),last_message_at=greatest(last_message_at,stamp),
 last_message_preview=case when last_message_at is null or last_message_at<=stamp then left(p_message->>'body',160) else last_message_preview end
 where id=c.id and organization_id=p_org;
 return jsonb_build_object('message_id',mid,'conversation_id',c.id,'contact_id',c.contact_id,'duplicate',false);
end; $$;
revoke execute on function public.fn_ingest_social_dm(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.fn_ingest_social_dm(uuid,uuid,jsonb) to service_role;
