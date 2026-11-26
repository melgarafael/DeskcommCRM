-- manifest: Registra as etapas comprovadas do envio no dossiê do follow-up (#4913).
-- A trilha registra fatos, inclusive depois de uma pausa/cancelamento. Ela
-- não concede permissão de envio nem participa da progressão do motor.

create table if not exists public.followup_delivery_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  enrollment_id uuid not null references public.followup_enrollments(id) on delete cascade,
  node_id text not null,
  event_type text not null,
  payload jsonb not null,
  idempotency_key text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (enrollment_id, idempotency_key)
);

alter table public.followup_delivery_events enable row level security;
revoke all on public.followup_delivery_events from public, anon, authenticated;
grant select on public.followup_delivery_events to authenticated;
grant select, insert on public.followup_delivery_events to service_role;

drop policy if exists followup_delivery_events_select on public.followup_delivery_events;
create policy followup_delivery_events_select on public.followup_delivery_events for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));

create index if not exists idx_followup_delivery_events_timeline
  on public.followup_delivery_events (enrollment_id, created_at, id);
create index if not exists idx_followup_historico_mensagem
  on public.followup_delivery_events (organization_id, (payload->>'message_id'))
  where event_type in ('followup_message_queued', 'followup_message_failed', 'followup_message_sent');
create index if not exists idx_followup_historico_rascunho
  on public.followup_delivery_events (organization_id, (payload->>'draft_id'))
  where event_type = 'followup_draft_generated';

create or replace function public.fn_followup_origem_do_envio(p_org uuid, p_job uuid)
returns table (enrollment_id uuid, node_id text, source_step_key text)
language plpgsql stable set search_path = public, pg_catalog as $$
begin
  return query
  select e.id, origem.node_id, origem.idempotency_key
  from public.job_queue j
  join public.followup_enrollments e
    on e.organization_id = j.organization_id and e.contact_id = j.contact_id
    and e.id::text = j.payload->>'followup_enrollment_id'
  join public.followup_enrollment_events origem
    on origem.organization_id = e.organization_id and origem.enrollment_id = e.id
    and origem.node_id = j.payload->>'node_id'
    and origem.idempotency_key = j.payload->>'source_step_key'
    and origem.event_type = 'turn_enqueued'
  where j.id = p_job and j.organization_id = p_org and j.kind = 'followup_turn'
    and j.payload->>'purpose' = 'send_message'
  union all
  select e.id, r.node_id, r.payload->>'source_step_key'
  from public.job_queue j
  join public.followup_delivery_events r
    on r.organization_id = j.organization_id and r.event_type = 'followup_draft_generated'
    and r.payload->>'draft_id' = j.payload->>'draft_id'
  join public.followup_enrollments e
    on e.organization_id = r.organization_id and e.id = r.enrollment_id and e.contact_id = j.contact_id
  join public.ai_reply_drafts d
    on d.organization_id = j.organization_id and d.send_job_id = j.id
    and d.id::text = j.payload->>'draft_id' and d.conversation_id = e.conversation_id
  where j.id = p_job and j.organization_id = p_org and j.kind = 'approved_reply';
end;
$$;
revoke execute on function public.fn_followup_origem_do_envio(uuid,uuid) from public, anon, authenticated;
grant execute on function public.fn_followup_origem_do_envio(uuid,uuid) to service_role;

create or replace function public.fn_followup_registrar_envio(
  p_org uuid, p_job uuid, p_tipo text, p_chave text, p_detalhe jsonb
)
returns void language plpgsql set search_path = public, pg_catalog as $$
begin
  insert into public.followup_delivery_events
    (organization_id, enrollment_id, node_id, event_type, payload, idempotency_key)
  select p_org, o.enrollment_id, o.node_id, p_tipo,
    p_detalhe || jsonb_build_object('job_id', p_job, 'source_step_key', o.source_step_key),
    'historico_envio:' || p_chave || ':' || p_tipo
  from public.fn_followup_origem_do_envio(p_org, p_job) o
  on conflict (enrollment_id, idempotency_key) do nothing;
exception when others then
  raise log 'histórico de envio do follow-up indisponível (%, SQLSTATE %)', p_tipo, sqlstate;
end;
$$;
revoke execute on function public.fn_followup_registrar_envio(uuid,uuid,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.fn_followup_registrar_envio(uuid,uuid,text,text,jsonb) to service_role;

create or replace function public.fn_followup_historico_job()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  perform public.fn_followup_registrar_envio(
    new.organization_id, new.id, 'followup_job_queued', new.id::text, '{}'::jsonb
  );
  return new;
end;
$$;
revoke execute on function public.fn_followup_historico_job() from public, anon, authenticated;

drop trigger if exists trg_followup_historico_job on public.job_queue;
create trigger trg_followup_historico_job
  after insert on public.job_queue for each row
  when (new.kind = 'followup_turn' and new.status = 'pending' and new.payload->>'purpose' = 'send_message')
  execute function public.fn_followup_historico_job();

create or replace function public.fn_followup_historico_ledger()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  tipo text := case new.status
    when 'queued' then 'followup_message_queued'
    when 'accepted' then 'followup_message_sent'
    when 'failed' then 'followup_message_failed'
  end;
begin
  if auth.uid() is not null then return new; end if;
  perform public.fn_followup_registrar_envio(
    new.organization_id, new.job_id, tipo, new.crm_message_id::text,
    jsonb_build_object('message_id', new.crm_message_id, 'seq', new.seq)
  );
  return new;
end;
$$;
revoke execute on function public.fn_followup_historico_ledger() from public, anon, authenticated;

drop trigger if exists trg_followup_historico_ledger on public.send_ledger;
create trigger trg_followup_historico_ledger
  after update of status on public.send_ledger for each row
  when (new.status in ('queued', 'accepted', 'failed') and new.crm_message_id is not null
    and old.status is distinct from new.status)
  execute function public.fn_followup_historico_ledger();

create or replace function public.fn_followup_historico_recibo()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  tipo text := case when new.status = 'failed' then 'followup_message_failed'
    else 'followup_message_sent' end;
  pendencia record;
  envio record;
begin
  -- Mesma regra do ledger: a trilha é escrita só pelo sistema.
  if auth.uid() is not null then return new; end if;
  -- A trilha conserva o vínculo quando o job já foi expurgado ou o
  -- ledger rotacionou para outra tentativa. O id é o da mensagem física.
  for pendencia in
    select distinct on (h.enrollment_id) h.enrollment_id, h.node_id, h.payload
    from public.followup_delivery_events h
    join public.followup_enrollments e on e.id = h.enrollment_id
      and e.organization_id = h.organization_id and e.contact_id = new.contact_id
    where h.organization_id = new.organization_id
      and h.event_type in ('followup_message_queued', 'followup_message_failed', 'followup_message_sent')
      and h.payload->>'message_id' = new.id::text
    order by h.enrollment_id, h.created_at
  loop
    insert into public.followup_delivery_events
      (organization_id, enrollment_id, node_id, event_type, payload, idempotency_key)
    values (new.organization_id, pendencia.enrollment_id, pendencia.node_id, tipo,
      pendencia.payload, 'historico_envio:' || new.id::text || ':' || tipo)
    on conflict (enrollment_id, idempotency_key) do nothing;
  end loop;
  if found then return new; end if;

  -- O handler cria a mensagem com a chave da intenção. Assim, também
  -- registramos o recibo quando o worker cai antes de atualizar o ledger.
  select l.job_id, l.seq into envio
    from public.send_ledger l
    where l.id = new.id and l.organization_id = new.organization_id and l.contact_id = new.contact_id;
  if found then
    perform public.fn_followup_registrar_envio(
      new.organization_id, envio.job_id, tipo, new.id::text,
      jsonb_build_object('message_id', new.id, 'seq', envio.seq)
    );
  end if;
  return new;
exception when others then
  raise log 'histórico de recibo do follow-up indisponível (SQLSTATE %)', sqlstate;
  return new;
end;
$$;
revoke execute on function public.fn_followup_historico_recibo() from public, anon, authenticated;

drop trigger if exists trg_followup_historico_recibo on public.messages;
create trigger trg_followup_historico_recibo
  after update of status on public.messages for each row
  when (new.direction = 'outbound' and new.status in ('sent', 'delivered', 'read', 'failed')
    and (old.status not in ('sent', 'delivered', 'read', 'failed')
      or (new.status = 'failed') <> (old.status = 'failed')))
  execute function public.fn_followup_historico_recibo();

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1 from pg_publication_tables where pubname = 'supabase_realtime'
        and schemaname = 'public' and tablename = 'followup_delivery_events'
    )
  then
    alter publication supabase_realtime add table public.followup_delivery_events;
  end if;
end;
$$;
