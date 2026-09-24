-- 0242_whatsapp_campaign_uncertain_resolution
--
-- Resolução explícita de send_uncertain + assumed_sent.
-- Impede requeue genérico send_uncertain → pending sem resolução registrada.

-- ---------------------------------------------------------------------------
-- 1. Colunas de resolução no recipient + status assumed_sent
-- ---------------------------------------------------------------------------
alter table public.whatsapp_campaign_recipients
  add column if not exists uncertainty_resolution text
    check (
      uncertainty_resolution is null
      or uncertainty_resolution in ('assume_sent', 'retry_anyway', 'provider_ack')
    );

alter table public.whatsapp_campaign_recipients
  add column if not exists uncertainty_resolved_at timestamptz;

alter table public.whatsapp_campaign_recipients
  add column if not exists uncertainty_resolved_by uuid
    references auth.users(id) on delete set null;

alter table public.whatsapp_campaign_recipients
  add column if not exists uncertainty_resolution_note text;

alter table public.whatsapp_campaign_recipients
  drop constraint if exists whatsapp_campaign_recipients_status_check;

alter table public.whatsapp_campaign_recipients
  add constraint whatsapp_campaign_recipients_status_check
  check (status in (
    'pending','scheduled','processing','sent','delivered','read','replied',
    'failed','skipped','cancelled','send_uncertain','assumed_sent'
  ));

-- ---------------------------------------------------------------------------
-- 2. Histórico append-only de resoluções
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_campaign_uncertainty_resolutions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid not null references public.whatsapp_campaigns(id) on delete cascade,
  recipient_id uuid not null references public.whatsapp_campaign_recipients(id) on delete cascade,
  attempt_number integer,
  resolution text not null
    check (resolution in ('assume_sent', 'retry_anyway', 'provider_ack')),
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz not null default now(),
  note text,
  previous_outbound_message_id uuid,
  new_outbound_message_id uuid,
  previous_message_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_wa_uncertainty_res_org_campaign
  on public.whatsapp_campaign_uncertainty_resolutions (organization_id, campaign_id);

create index if not exists idx_wa_uncertainty_res_recipient
  on public.whatsapp_campaign_uncertainty_resolutions (recipient_id);

alter table public.whatsapp_campaign_uncertainty_resolutions enable row level security;

drop policy if exists tenant_isolation_whatsapp_campaign_uncertainty_resolutions_all
  on public.whatsapp_campaign_uncertainty_resolutions;
create policy tenant_isolation_whatsapp_campaign_uncertainty_resolutions_all
  on public.whatsapp_campaign_uncertainty_resolutions
  for all
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

revoke all on table public.whatsapp_campaign_uncertainty_resolutions from anon;
grant select, insert on table public.whatsapp_campaign_uncertainty_resolutions to authenticated;
grant all on table public.whatsapp_campaign_uncertainty_resolutions to service_role;

create or replace function public.fn_whatsapp_campaign_uncertainty_resolutions_same_org()
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
  if v_rec_org is null or v_rec_org <> new.organization_id then
    raise exception 'whatsapp_campaign_uncertainty_resolutions: recipient de outra organization';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_whatsapp_campaign_uncertainty_resolutions_same_org()
  from public, anon;
drop trigger if exists trg_wa_uncertainty_res_same_org
  on public.whatsapp_campaign_uncertainty_resolutions;
create trigger trg_wa_uncertainty_res_same_org
  before insert or update on public.whatsapp_campaign_uncertainty_resolutions
  for each row execute function public.fn_whatsapp_campaign_uncertainty_resolutions_same_org();

-- ---------------------------------------------------------------------------
-- 3. Guarda: send_uncertain → pending/processing/failed/scheduled exige resolução
-- ---------------------------------------------------------------------------
create or replace function public.fn_whatsapp_campaign_recipients_guard_uncertain()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and old.status = 'send_uncertain'
     and new.status is distinct from old.status then
    -- Saídas permitidas sem resolução humana:
    --   * confirmed pelo provider (sent/delivered/read/replied) via sync ACK
    --   * cancelled
    --   * assumed_sent / pending com uncertainty_resolution preenchida
    if new.status in ('pending', 'scheduled', 'processing', 'failed') then
      if new.uncertainty_resolution is null
         or new.uncertainty_resolution not in ('retry_anyway') then
        raise exception
          'whatsapp_campaign_recipients: send_uncertain não pode ir para % sem resolution=retry_anyway',
          new.status;
      end if;
    elsif new.status = 'assumed_sent' then
      if new.uncertainty_resolution is distinct from 'assume_sent' then
        raise exception
          'whatsapp_campaign_recipients: assumed_sent exige uncertainty_resolution=assume_sent';
      end if;
    elsif new.status in ('sent', 'delivered', 'read', 'replied') then
      -- provider_ack: sync descobriu external_id — OK
      null;
    elsif new.status = 'cancelled' then
      null;
    elsif new.status = 'skipped' then
      null;
    elsif new.status = 'send_uncertain' then
      null;
    else
      raise exception
        'whatsapp_campaign_recipients: transição send_uncertain → % não permitida',
        new.status;
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_whatsapp_campaign_recipients_guard_uncertain()
  from public, anon;

drop trigger if exists trg_wa_recipients_guard_uncertain
  on public.whatsapp_campaign_recipients;
create trigger trg_wa_recipients_guard_uncertain
  before update of status on public.whatsapp_campaign_recipients
  for each row execute function public.fn_whatsapp_campaign_recipients_guard_uncertain();

-- ---------------------------------------------------------------------------
-- 4. Stale recovery: NUNCA toca send_uncertain (só processing)
-- ---------------------------------------------------------------------------
create or replace function public.fn_recover_stale_whatsapp_campaign_claims(
  p_stale_seconds integer default 180
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer := 0;
  v_cutoff timestamptz := now() - make_interval(secs => greatest(coalesce(p_stale_seconds, 180), 60));
begin
  delete from public.whatsapp_campaign_session_leases
   where leased_until < now();

  with freed as (
    update public.whatsapp_campaign_recipients r
       set status = 'pending',
           claimed_at = null,
           claimed_by = null,
           attempt_count = greatest(attempt_count - 1, 0),
           next_attempt_at = now(),
           updated_at = now()
     where r.status = 'processing'  -- nunca send_uncertain
       and (
         r.claimed_at is null
         or r.claimed_at < v_cutoff
         or not exists (
           select 1
             from public.whatsapp_campaign_session_leases l
            where l.channel_session_id = r.channel_session_id
              and l.leased_until >= now()
              and (l.recipient_id is null or l.recipient_id = r.id)
         )
       )
    returning r.id
  )
  select count(*)::int into v_n from freed;
  return coalesce(v_n, 0);
end;
$$;

revoke execute on function public.fn_recover_stale_whatsapp_campaign_claims(integer)
  from public, anon, authenticated;
grant execute on function public.fn_recover_stale_whatsapp_campaign_claims(integer)
  to service_role;
