-- 0240_whatsapp_campaigns
--
-- Fase 2 CRM B2B: campanhas WhatsApp com fila em whatsapp_campaign_recipients
-- (FOR UPDATE SKIP LOCKED), attempts, lease por channel_session.
-- Aditivo. Não altera contacts/conversations/messages uniques nem WAHA RPCs.

-- ---------------------------------------------------------------------------
-- 1. whatsapp_campaigns
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'draft'
    check (status in ('draft','scheduled','running','paused','completed','cancelled','failed')),
  message_text text not null,
  channel_session_id uuid not null references public.channel_sessions(id) on delete restrict,
  min_interval_seconds integer not null default 20
    check (min_interval_seconds >= 5),
  max_interval_seconds integer not null default 45
    check (max_interval_seconds >= 5),
  send_window_start time,
  send_window_end time,
  timezone text not null default 'America/Sao_Paulo',
  daily_limit integer check (daily_limit is null or daily_limit > 0),
  next_send_at timestamptz,
  scheduled_at timestamptz,
  started_at timestamptz,
  paused_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  session_problem text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_campaigns_interval_order
    check (max_interval_seconds >= min_interval_seconds),
  constraint whatsapp_campaigns_name_nao_vazio
    check (length(btrim(name)) > 0),
  constraint whatsapp_campaigns_message_nao_vazio
    check (length(btrim(message_text)) > 0)
);

create index if not exists idx_wa_campaigns_org_status
  on public.whatsapp_campaigns (organization_id, status);

create index if not exists idx_wa_campaigns_running_next
  on public.whatsapp_campaigns (status, next_send_at)
  where status = 'running';

alter table public.whatsapp_campaigns enable row level security;

drop policy if exists tenant_isolation_whatsapp_campaigns_all on public.whatsapp_campaigns;
create policy tenant_isolation_whatsapp_campaigns_all on public.whatsapp_campaigns
  for all
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

revoke all on table public.whatsapp_campaigns from anon;
grant select, insert, update, delete on table public.whatsapp_campaigns to authenticated;
grant all on table public.whatsapp_campaigns to service_role;

drop trigger if exists trg_whatsapp_campaigns_set_updated_at on public.whatsapp_campaigns;
create trigger trg_whatsapp_campaigns_set_updated_at
  before update on public.whatsapp_campaigns
  for each row execute function public.fn_set_updated_at();

-- same-org: channel_session
create or replace function public.fn_whatsapp_campaigns_same_org()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_sess_org uuid;
begin
  select organization_id into v_sess_org
    from public.channel_sessions where id = new.channel_session_id;
  if v_sess_org is null then
    raise exception 'whatsapp_campaigns: channel_session inexistente';
  end if;
  if new.organization_id is distinct from v_sess_org then
    raise exception 'whatsapp_campaigns: channel_session de outra organization';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_whatsapp_campaigns_same_org() from public, anon;

drop trigger if exists trg_whatsapp_campaigns_same_org on public.whatsapp_campaigns;
create trigger trg_whatsapp_campaigns_same_org
  before insert or update of channel_session_id, organization_id on public.whatsapp_campaigns
  for each row execute function public.fn_whatsapp_campaigns_same_org();

-- ---------------------------------------------------------------------------
-- 2. whatsapp_campaign_recipients (fila persistente)
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid not null references public.whatsapp_campaigns(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete restrict,
  person_id uuid references public.people(id) on delete set null,
  company_id uuid references public.companies(id) on delete set null,
  channel_session_id uuid not null references public.channel_sessions(id) on delete restrict,
  phone_number_snapshot text not null,
  contact_name_snapshot text,
  person_name_snapshot text,
  company_name_snapshot text,
  message_rendered text,
  status text not null default 'pending'
    check (status in (
      'pending','scheduled','processing','sent','delivered','read','replied',
      'failed','skipped','cancelled'
    )),
  next_attempt_at timestamptz,
  claimed_at timestamptz,
  claimed_by text,
  outbound_message_id uuid,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  replied_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,
  skipped_reason text,
  message_id uuid references public.messages(id) on delete set null,
  external_message_id text,
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_campaign_recipients_campaign_contact_uidx unique (campaign_id, contact_id)
);

create index if not exists idx_wa_recipients_org_campaign
  on public.whatsapp_campaign_recipients (organization_id, campaign_id);

create index if not exists idx_wa_recipients_claim
  on public.whatsapp_campaign_recipients (status, next_attempt_at, channel_session_id)
  where status in ('pending','scheduled','failed');

create index if not exists idx_wa_recipients_session_processing
  on public.whatsapp_campaign_recipients (channel_session_id, status)
  where status = 'processing';

create index if not exists idx_wa_recipients_message
  on public.whatsapp_campaign_recipients (message_id)
  where message_id is not null;

create index if not exists idx_wa_recipients_contact_person
  on public.whatsapp_campaign_recipients (organization_id, person_id)
  where person_id is not null;

alter table public.whatsapp_campaign_recipients enable row level security;

drop policy if exists tenant_isolation_whatsapp_campaign_recipients_all on public.whatsapp_campaign_recipients;
create policy tenant_isolation_whatsapp_campaign_recipients_all on public.whatsapp_campaign_recipients
  for all
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

revoke all on table public.whatsapp_campaign_recipients from anon;
grant select, insert, update, delete on table public.whatsapp_campaign_recipients to authenticated;
grant all on table public.whatsapp_campaign_recipients to service_role;

drop trigger if exists trg_whatsapp_campaign_recipients_set_updated_at on public.whatsapp_campaign_recipients;
create trigger trg_whatsapp_campaign_recipients_set_updated_at
  before update on public.whatsapp_campaign_recipients
  for each row execute function public.fn_set_updated_at();

create or replace function public.fn_whatsapp_campaign_recipients_same_org()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_camp_org uuid;
  v_contact_org uuid;
begin
  select organization_id into v_camp_org from public.whatsapp_campaigns where id = new.campaign_id;
  select organization_id into v_contact_org from public.contacts where id = new.contact_id;
  if v_camp_org is null then raise exception 'recipient: campaign inexistente'; end if;
  if v_contact_org is null then raise exception 'recipient: contact inexistente'; end if;
  if new.organization_id is distinct from v_camp_org
     or new.organization_id is distinct from v_contact_org then
    raise exception 'recipient: organization_id deve coincidir com campaign e contact';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_whatsapp_campaign_recipients_same_org() from public, anon;

drop trigger if exists trg_whatsapp_campaign_recipients_same_org on public.whatsapp_campaign_recipients;
create trigger trg_whatsapp_campaign_recipients_same_org
  before insert or update on public.whatsapp_campaign_recipients
  for each row execute function public.fn_whatsapp_campaign_recipients_same_org();

-- ---------------------------------------------------------------------------
-- 3. whatsapp_campaign_attempts
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_campaign_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid not null references public.whatsapp_campaigns(id) on delete cascade,
  recipient_id uuid not null references public.whatsapp_campaign_recipients(id) on delete cascade,
  attempt_number integer not null,
  channel_session_id uuid not null references public.channel_sessions(id) on delete restrict,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null
    check (status in ('started','sent','failed','skipped','retry')),
  message_id uuid references public.messages(id) on delete set null,
  external_message_id text,
  provider_status text,
  error_code text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint whatsapp_campaign_attempts_recipient_num_uidx unique (recipient_id, attempt_number)
);

create index if not exists idx_wa_attempts_org_campaign
  on public.whatsapp_campaign_attempts (organization_id, campaign_id);

alter table public.whatsapp_campaign_attempts enable row level security;

drop policy if exists tenant_isolation_whatsapp_campaign_attempts_all on public.whatsapp_campaign_attempts;
create policy tenant_isolation_whatsapp_campaign_attempts_all on public.whatsapp_campaign_attempts
  for all
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

revoke all on table public.whatsapp_campaign_attempts from anon;
grant select, insert, update, delete on table public.whatsapp_campaign_attempts to authenticated;
grant all on table public.whatsapp_campaign_attempts to service_role;

create or replace function public.fn_whatsapp_campaign_attempts_same_org()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_rec_org uuid;
begin
  select organization_id into v_rec_org
    from public.whatsapp_campaign_recipients where id = new.recipient_id;
  if v_rec_org is null then raise exception 'attempt: recipient inexistente'; end if;
  if new.organization_id is distinct from v_rec_org then
    raise exception 'attempt: organization_id deve coincidir com recipient';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_whatsapp_campaign_attempts_same_org() from public, anon;

drop trigger if exists trg_whatsapp_campaign_attempts_same_org on public.whatsapp_campaign_attempts;
create trigger trg_whatsapp_campaign_attempts_same_org
  before insert or update on public.whatsapp_campaign_attempts
  for each row execute function public.fn_whatsapp_campaign_attempts_same_org();

-- ---------------------------------------------------------------------------
-- 4. Lease por channel_session (1 envio de campanha por sessão)
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_campaign_session_leases (
  channel_session_id uuid primary key references public.channel_sessions(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid references public.whatsapp_campaigns(id) on delete set null,
  recipient_id uuid references public.whatsapp_campaign_recipients(id) on delete set null,
  worker_id text not null,
  leased_until timestamptz not null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_wa_session_leases_until
  on public.whatsapp_campaign_session_leases (leased_until);

alter table public.whatsapp_campaign_session_leases enable row level security;

drop policy if exists tenant_isolation_whatsapp_campaign_session_leases_all
  on public.whatsapp_campaign_session_leases;
create policy tenant_isolation_whatsapp_campaign_session_leases_all
  on public.whatsapp_campaign_session_leases
  for all
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

revoke all on table public.whatsapp_campaign_session_leases from anon;
grant select, insert, update, delete on table public.whatsapp_campaign_session_leases to authenticated;
grant all on table public.whatsapp_campaign_session_leases to service_role;

-- ---------------------------------------------------------------------------
-- 5. Claim atômico de recipient (SKIP LOCKED) — security definer, só service_role
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
begin
  if p_worker_id is null or length(btrim(p_worker_id)) = 0 then
    raise exception 'worker_id obrigatório';
  end if;

  select c.* into v_camp
    from public.whatsapp_campaigns c
   where c.status = 'running'
     and (c.scheduled_at is null or c.scheduled_at <= now())
     and (c.next_send_at is null or c.next_send_at <= now())
   order by c.next_send_at nulls first, c.created_at
   for update of c skip locked
   limit 1;

  if not found then
    return;
  end if;

  insert into public.whatsapp_campaign_session_leases as l
    (channel_session_id, organization_id, campaign_id, worker_id, leased_until)
  values (v_camp.channel_session_id, v_camp.organization_id, v_camp.id, p_worker_id, v_lease_until)
  on conflict (channel_session_id) do update
    set campaign_id = excluded.campaign_id,
        worker_id = excluded.worker_id,
        leased_until = excluded.leased_until,
        updated_at = now()
  where public.whatsapp_campaign_session_leases.leased_until < now()
     or public.whatsapp_campaign_session_leases.worker_id = p_worker_id;

  select exists (
    select 1 from public.whatsapp_campaign_session_leases
     where channel_session_id = v_camp.channel_session_id
       and worker_id = p_worker_id
       and leased_until >= now()
  ) into v_got_lease;

  if not v_got_lease then
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
     where channel_session_id = v_camp.channel_session_id
       and worker_id = p_worker_id;
    return;
  end if;

  v_msg_id := coalesce(v_rec.outbound_message_id, gen_random_uuid());

  update public.whatsapp_campaign_recipients
     set status = 'processing',
         claimed_at = now(),
         claimed_by = p_worker_id,
         outbound_message_id = v_msg_id,
         attempt_count = attempt_count + 1,
         updated_at = now()
   where id = v_rec.id
   returning * into v_rec;

  update public.whatsapp_campaign_session_leases
     set recipient_id = v_rec.id,
         leased_until = v_lease_until,
         updated_at = now()
   where channel_session_id = v_camp.channel_session_id;

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

revoke execute on function public.fn_claim_whatsapp_campaign_recipient(text, integer) from public, anon, authenticated;
grant execute on function public.fn_claim_whatsapp_campaign_recipient(text, integer) to service_role;
