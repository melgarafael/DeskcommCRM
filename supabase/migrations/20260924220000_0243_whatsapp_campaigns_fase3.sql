-- 0243_whatsapp_campaigns_fase3
--
-- Fase 3: reply_stop_mode, create_lead_on_reply, multi-session (N:N),
-- round-robin no claim, pacing por sessão.
-- Aditivo. Não altera WAHA ingest / conversations uniques.

-- ---------------------------------------------------------------------------
-- 1. Colunas comerciais na campanha
-- ---------------------------------------------------------------------------
alter table public.whatsapp_campaigns
  add column if not exists reply_stop_mode text not null default 'person';

alter table public.whatsapp_campaigns
  drop constraint if exists whatsapp_campaigns_reply_stop_mode_check;

alter table public.whatsapp_campaigns
  add constraint whatsapp_campaigns_reply_stop_mode_check
  check (reply_stop_mode in ('none', 'person', 'company'));

alter table public.whatsapp_campaigns
  add column if not exists create_lead_on_reply boolean not null default false;

alter table public.whatsapp_campaigns
  add column if not exists session_rr_index integer not null default 0;

-- ---------------------------------------------------------------------------
-- 2. whatsapp_campaign_sessions (N:N campanha ↔ channel_session)
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_campaign_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid not null references public.whatsapp_campaigns(id) on delete cascade,
  channel_session_id uuid not null references public.channel_sessions(id) on delete restrict,
  enabled boolean not null default true,
  weight integer not null default 1 check (weight >= 1 and weight <= 100),
  next_send_at timestamptz,
  created_at timestamptz not null default now(),
  unique (campaign_id, channel_session_id)
);

create index if not exists idx_wa_campaign_sessions_org_campaign
  on public.whatsapp_campaign_sessions (organization_id, campaign_id);

create index if not exists idx_wa_campaign_sessions_next
  on public.whatsapp_campaign_sessions (channel_session_id, next_send_at)
  where enabled;

alter table public.whatsapp_campaign_sessions enable row level security;

drop policy if exists tenant_isolation_whatsapp_campaign_sessions_all
  on public.whatsapp_campaign_sessions;
create policy tenant_isolation_whatsapp_campaign_sessions_all
  on public.whatsapp_campaign_sessions
  for all
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

revoke all on table public.whatsapp_campaign_sessions from anon;
grant select, insert, update, delete on table public.whatsapp_campaign_sessions to authenticated;
grant all on table public.whatsapp_campaign_sessions to service_role;

create or replace function public.fn_whatsapp_campaign_sessions_same_org()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_camp_org uuid;
  v_sess_org uuid;
begin
  select organization_id into v_camp_org
    from public.whatsapp_campaigns where id = new.campaign_id;
  if v_camp_org is null or v_camp_org is distinct from new.organization_id then
    raise exception 'whatsapp_campaign_sessions: campaign de outra organization';
  end if;
  select organization_id into v_sess_org
    from public.channel_sessions where id = new.channel_session_id;
  if v_sess_org is null or v_sess_org is distinct from new.organization_id then
    raise exception 'whatsapp_campaign_sessions: channel_session de outra organization';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_whatsapp_campaign_sessions_same_org()
  from public, anon;

drop trigger if exists trg_whatsapp_campaign_sessions_same_org
  on public.whatsapp_campaign_sessions;
create trigger trg_whatsapp_campaign_sessions_same_org
  before insert or update of campaign_id, channel_session_id, organization_id
  on public.whatsapp_campaign_sessions
  for each row execute function public.fn_whatsapp_campaign_sessions_same_org();

-- Backfill: 1 linha por campanha existente (canal primário legado)
insert into public.whatsapp_campaign_sessions
  (organization_id, campaign_id, channel_session_id, enabled, next_send_at)
select c.organization_id, c.id, c.channel_session_id, true, c.next_send_at
  from public.whatsapp_campaigns c
 where not exists (
   select 1 from public.whatsapp_campaign_sessions s
    where s.campaign_id = c.id and s.channel_session_id = c.channel_session_id
 )
on conflict (campaign_id, channel_session_id) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Stats por sessão (métricas operacionais)
-- ---------------------------------------------------------------------------
create or replace function public.fn_whatsapp_campaign_session_stats(
  p_organization_id uuid,
  p_campaign_id uuid
)
returns table (
  channel_session_id uuid,
  sent bigint,
  failed bigint,
  replied bigint,
  last_sent_at timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    r.channel_session_id,
    count(*) filter (
      where r.status in ('sent','delivered','read','replied','assumed_sent')
    )::bigint as sent,
    count(*) filter (where r.status = 'failed')::bigint as failed,
    count(*) filter (where r.status = 'replied')::bigint as replied,
    max(r.sent_at) as last_sent_at
  from public.whatsapp_campaign_recipients r
  where r.organization_id = p_organization_id
    and r.campaign_id = p_campaign_id
  group by r.channel_session_id;
$$;

revoke execute on function public.fn_whatsapp_campaign_session_stats(uuid, uuid)
  from public, anon;
grant execute on function public.fn_whatsapp_campaign_session_stats(uuid, uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Claim multi-session + round-robin
-- ---------------------------------------------------------------------------
create or replace function public.fn_claim_whatsapp_campaign_recipient(
  p_worker_id text,
  p_lease_seconds integer default 120
)
returns table (
  recipient_id uuid,
  organization_id uuid,
  campaign_id uuid,
  contact_id uuid,
  channel_session_id uuid,
  outbound_message_id uuid,
  message_rendered text,
  attempt_count integer,
  phone_number_snapshot text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_camp public.whatsapp_campaigns%rowtype;
  v_rec public.whatsapp_campaign_recipients%rowtype;
  v_lease_until timestamptz := now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 120), 30));
  v_msg_id uuid;
  v_got_lease boolean := false;
  v_session_id uuid;
  v_sess_count integer;
  v_try integer := 0;
  v_start integer;
begin
  if p_worker_id is null or length(btrim(p_worker_id)) = 0 then
    raise exception 'worker_id obrigatório';
  end if;

  perform public.fn_recover_stale_whatsapp_campaign_claims(180);

  -- Campanha running com destinatário pendente (lock skip)
  select c.* into v_camp
    from public.whatsapp_campaigns c
   where c.status = 'running'
     and (c.scheduled_at is null or c.scheduled_at <= now())
     and exists (
       select 1 from public.whatsapp_campaign_recipients r
        where r.campaign_id = c.id
          and r.organization_id = c.organization_id
          and r.status in ('pending', 'scheduled', 'failed')
          and (r.next_attempt_at is null or r.next_attempt_at <= now())
          and r.attempt_count < r.max_attempts
     )
   order by c.next_send_at nulls first, c.created_at
   for update of c skip locked
   limit 1;

  if not found then
    return;
  end if;

  select count(*)::int into v_sess_count
    from public.whatsapp_campaign_sessions cs
    join public.channel_sessions s
      on s.id = cs.channel_session_id
     and s.organization_id = cs.organization_id
   where cs.campaign_id = v_camp.id
     and cs.organization_id = v_camp.organization_id
     and cs.enabled
     and s.status = 'WORKING'
     and (cs.next_send_at is null or cs.next_send_at <= now());

  if coalesce(v_sess_count, 0) = 0 then
    update public.whatsapp_campaigns
       set session_problem = 'awaiting_whatsapp_session',
           next_send_at = now() + interval '5 minutes'
     where id = v_camp.id;
    return;
  end if;

  v_start := abs(coalesce(v_camp.session_rr_index, 0)) % v_sess_count;

  -- Round-robin entre sessões elegíveis; tenta as seguintes se lease ocupado
  while v_try < v_sess_count loop
    select cs.channel_session_id into v_session_id
      from (
        select cs.channel_session_id,
               row_number() over (order by cs.created_at, cs.id) - 1 as ord
          from public.whatsapp_campaign_sessions cs
          join public.channel_sessions s
            on s.id = cs.channel_session_id
           and s.organization_id = cs.organization_id
         where cs.campaign_id = v_camp.id
           and cs.organization_id = v_camp.organization_id
           and cs.enabled
           and s.status = 'WORKING'
           and (cs.next_send_at is null or cs.next_send_at <= now())
      ) cs
     where cs.ord = (v_start + v_try) % v_sess_count;

    if v_session_id is null then
      v_try := v_try + 1;
      continue;
    end if;

    insert into public.whatsapp_campaign_session_leases as l
      (channel_session_id, organization_id, campaign_id, worker_id, leased_until)
    values (v_session_id, v_camp.organization_id, v_camp.id, p_worker_id, v_lease_until)
    on conflict (channel_session_id) do update
      set campaign_id = excluded.campaign_id,
          worker_id = excluded.worker_id,
          leased_until = excluded.leased_until,
          updated_at = now()
    where public.whatsapp_campaign_session_leases.leased_until < now()
       or public.whatsapp_campaign_session_leases.worker_id = p_worker_id;

    select exists (
      select 1 from public.whatsapp_campaign_session_leases
       where channel_session_id = v_session_id
         and worker_id = p_worker_id
         and leased_until >= now()
    ) into v_got_lease;

    if v_got_lease then
      exit;
    end if;

    v_try := v_try + 1;
    v_session_id := null;
  end loop;

  if not v_got_lease or v_session_id is null then
    update public.whatsapp_campaigns
       set session_problem = 'awaiting_session_lease',
           next_send_at = now() + interval '15 seconds'
     where id = v_camp.id;
    return;
  end if;

  select r.* into v_rec
    from public.whatsapp_campaign_recipients r
   where r.campaign_id = v_camp.id
     and r.organization_id = v_camp.organization_id
     and r.status in ('pending', 'scheduled', 'failed')
     and (r.next_attempt_at is null or r.next_attempt_at <= now())
     and r.attempt_count < r.max_attempts
   order by r.next_attempt_at nulls first, r.created_at
   for update of r skip locked
   limit 1;

  if not found then
    delete from public.whatsapp_campaign_session_leases
     where channel_session_id = v_session_id
       and worker_id = p_worker_id;
    return;
  end if;

  v_msg_id := v_rec.outbound_message_id;
  if v_msg_id is not null then
    if exists (
      select 1 from public.messages m
       where m.id = v_msg_id
         and m.organization_id = v_rec.organization_id
         and m.status = 'failed'
    ) then
      v_msg_id := gen_random_uuid();
    end if;
  else
    v_msg_id := gen_random_uuid();
  end if;

  -- Sessão REAL do envio (pode diferir da planejada na materialização)
  update public.whatsapp_campaign_recipients
     set status = 'processing',
         claimed_at = now(),
         claimed_by = p_worker_id,
         outbound_message_id = v_msg_id,
         channel_session_id = v_session_id,
         attempt_count = attempt_count + 1,
         updated_at = now()
   where id = v_rec.id
   returning * into v_rec;

  update public.whatsapp_campaign_session_leases
     set recipient_id = v_rec.id,
         leased_until = v_lease_until,
         updated_at = now()
   where channel_session_id = v_session_id;

  update public.whatsapp_campaigns
     set session_rr_index = coalesce(session_rr_index, 0) + 1,
         session_problem = null
   where id = v_camp.id;

  recipient_id := v_rec.id;
  organization_id := v_rec.organization_id;
  campaign_id := v_rec.campaign_id;
  contact_id := v_rec.contact_id;
  channel_session_id := v_rec.channel_session_id;
  outbound_message_id := v_rec.outbound_message_id;
  message_rendered := v_rec.message_rendered;
  attempt_count := v_rec.attempt_count;
  phone_number_snapshot := v_rec.phone_number_snapshot;
  return next;
end;
$$;

revoke execute on function public.fn_claim_whatsapp_campaign_recipient(text, integer)
  from public, anon, authenticated;
grant execute on function public.fn_claim_whatsapp_campaign_recipient(text, integer)
  to service_role;
