-- 0241_whatsapp_campaigns_hardening
--
-- Robustez Fase 2: send_uncertain, stale claim recovery, stats agregadas.
-- Aditivo. Não altera messages/WAHA.

-- ---------------------------------------------------------------------------
-- 1. Status send_uncertain (timeout/ambíguo — sem retry automático)
-- ---------------------------------------------------------------------------
alter table public.whatsapp_campaign_recipients
  drop constraint if exists whatsapp_campaign_recipients_status_check;

alter table public.whatsapp_campaign_recipients
  add constraint whatsapp_campaign_recipients_status_check
  check (status in (
    'pending','scheduled','processing','sent','delivered','read','replied',
    'failed','skipped','cancelled','send_uncertain'
  ));

create index if not exists idx_wa_recipients_stale_processing
  on public.whatsapp_campaign_recipients (claimed_at)
  where status = 'processing';

-- ---------------------------------------------------------------------------
-- 2. Recuperação de processing preso (lease expirado ou claim velho)
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
  -- Leases vencidos: liberam a sessão para outro worker
  delete from public.whatsapp_campaign_session_leases
   where leased_until < now();

  -- Recipients em processing sem lease viva OU claim antigo
  with freed as (
    update public.whatsapp_campaign_recipients r
       set status = 'pending',
           claimed_at = null,
           claimed_by = null,
           -- Devolve a tentativa consumida pelo claim morto (não punir crash)
           attempt_count = greatest(attempt_count - 1, 0),
           next_attempt_at = now(),
           updated_at = now()
     where r.status = 'processing'
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

-- ---------------------------------------------------------------------------
-- 3. Contagens agregadas (lista/stats sem N+1 / sem scan TSV)
-- ---------------------------------------------------------------------------
create or replace function public.fn_whatsapp_campaign_status_counts(
  p_organization_id uuid,
  p_campaign_ids uuid[] default null
)
returns table (campaign_id uuid, status text, n bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select r.campaign_id, r.status, count(*)::bigint as n
    from public.whatsapp_campaign_recipients r
   where r.organization_id = p_organization_id
     and (p_campaign_ids is null or r.campaign_id = any (p_campaign_ids))
   group by r.campaign_id, r.status;
$$;

revoke execute on function public.fn_whatsapp_campaign_status_counts(uuid, uuid[])
  from public, anon;
grant execute on function public.fn_whatsapp_campaign_status_counts(uuid, uuid[])
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Claim: não pega send_uncertain; recupera stale antes
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

  perform public.fn_recover_stale_whatsapp_campaign_claims(180);

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

  -- Reusa outbound_message_id só se ainda não houver messages.id correspondente
  -- em estado terminal sent/* — senão o claim TS reconcilia. Se a message ligada
  -- estiver failed, GERA novo id (23505 em failed bloquearia retry WAHA).
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

revoke execute on function public.fn_claim_whatsapp_campaign_recipient(text, integer)
  from public, anon, authenticated;
grant execute on function public.fn_claim_whatsapp_campaign_recipient(text, integer)
  to service_role;
