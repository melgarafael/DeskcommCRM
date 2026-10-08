-- manifest: tarefas de pagamento com compra fixa, decisão humana, envio e espera separados
alter table public.agent_cases
  add column if not exists task_kind text,
  add column if not exists task_state text,
  add column if not exists revision bigint not null default 0,
  add column if not exists wait_generation bigint not null default 0,
  add column if not exists wait_started_at timestamptz,
  add column if not exists assignee_user_id uuid references auth.users(id) on delete set null,
  add column if not exists task_payload jsonb not null default '{}'::jsonb,
  add column if not exists decision_event_id uuid references public.agent_case_events(id) on delete set null,
  add column if not exists delivery_job_id uuid references public.job_queue(id) on delete set null;
alter table public.agent_cases drop constraint if exists agent_cases_task_state_check;
alter table public.agent_cases add constraint agent_cases_task_state_check
  check (task_state is null or task_state in ('awaiting_human','awaiting_send','send_failed','awaiting_lead','completed'));
create index if not exists agent_cases_task_wait_idx on public.agent_cases(organization_id,wait_started_at)
  where task_kind is not null and task_state in ('awaiting_human','send_failed');

-- Defense in depth in addition to the existing PostgREST write revocations.
create or replace function public.fn_protect_case_task() returns trigger
language plpgsql set search_path=public as $$
begin
  if new.task_kind is not null and new.lead_id is not null and not exists(
    select 1 from public.crm_leads l join public.conversations c on c.id=new.conversation_id
    and c.organization_id=new.organization_id where l.id=new.lead_id and l.organization_id=new.organization_id and l.contact_id=c.contact_id
  ) then raise exception 'case_task_purchase_mismatch' using errcode='23514'; end if;
  if current_user in ('anon','authenticated') then
    if tg_op='INSERT' and new.task_kind is not null then
      raise exception 'case_task_requires_server' using errcode='42501';
    elsif tg_op='UPDATE' and (new.task_kind is not null or old.task_kind is not null) and
      (to_jsonb(new)-'updated_at') is distinct from (to_jsonb(old)-'updated_at') then
      raise exception 'case_task_requires_server' using errcode='42501';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.fn_protect_case_task() from public,anon,authenticated;
grant execute on function public.fn_protect_case_task() to service_role;
drop trigger if exists protect_case_task on public.agent_cases;
create trigger protect_case_task before insert or update on public.agent_cases
for each row execute function public.fn_protect_case_task();

-- Exhaustion must become an actionable human wait; an accepted send instead
-- returns to reconciliation, even if the last acquisition exhausted attempts.
create or replace function public.fn_case_task_delivery_exhausted() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_case uuid;
begin
  if new.kind='case_reply_turn' and new.payload->>'action'='task_delivery' and new.status='dead' and old.status is distinct from 'dead' then
    if exists(select 1 from public.send_ledger where organization_id=new.organization_id and job_id=new.id and seq=1 and status='accepted') then
      new.status:='pending'; new.run_after:=now()+interval '30 seconds'; return new;
    end if;
    update public.agent_cases set task_state='send_failed',revision=revision+1,
      wait_generation=wait_generation+1,wait_started_at=now(),task_payload=task_payload || jsonb_build_object('delivery_error','delivery_exhausted')
      where organization_id=new.organization_id and delivery_job_id=new.id and task_state='awaiting_send' and status in ('awaiting_human','awaiting_lead') returning id into v_case;
    if v_case is not null then
      insert into public.agent_case_events(organization_id,case_id,kind,actor_kind,body,metadata)
        values(new.organization_id,v_case,'agent_noted','system','O envio esgotou as tentativas. A decisão continua registrada; revise e tente o envio novamente.',jsonb_build_object('task_action','delivery_failed','job_id',new.id));
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.fn_case_task_delivery_exhausted() from public,anon,authenticated;
grant execute on function public.fn_case_task_delivery_exhausted() to service_role;
drop trigger if exists case_task_delivery_exhausted on public.job_queue;
create trigger case_task_delivery_exhausted before update of status on public.job_queue
for each row execute function public.fn_case_task_delivery_exhausted();

create or replace function public.fn_redigir_tarefa_caso() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if new.is_anonymized and not old.is_anonymized then
    update public.agent_cases set task_payload='{}'::jsonb
      where organization_id=new.organization_id and conversation_id in (
        select id from public.conversations where organization_id=new.organization_id and contact_id=new.id
      ) and task_kind is not null;
  end if;
  return new;
end $$;
revoke execute on function public.fn_redigir_tarefa_caso() from public,anon,authenticated;
grant execute on function public.fn_redigir_tarefa_caso() to service_role;
drop trigger if exists redigir_tarefa_caso on public.contacts;
create trigger redigir_tarefa_caso after update of is_anonymized on public.contacts
for each row execute function public.fn_redigir_tarefa_caso();
