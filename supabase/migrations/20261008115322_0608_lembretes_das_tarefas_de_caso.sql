-- manifest: Recibos e Central atômicos para espera humana de pagamento aos 3/6/9 minutos.
-- A cadência é interna: nenhum HTTP ou envio para a cliente sai desta função.
create unique index if not exists agent_cases_id_org_task_idx on public.agent_cases(id, organization_id);
create table if not exists public.case_task_reminders (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  case_id uuid not null,
  wait_generation bigint not null,
  minute smallint not null check (minute in (3,6,9)),
  result text not null check (result in ('notified','superseded')),
  recorded_at timestamptz not null default now(),
  inbox_id uuid references public.agent_inbox_items(id) on delete set null,
  primary key (organization_id, case_id, wait_generation, minute),
  foreign key (case_id, organization_id) references public.agent_cases(id, organization_id) on delete cascade
);
alter table public.case_task_reminders enable row level security;
drop policy if exists tenant_isolation_case_task_reminders_all on public.case_task_reminders;
create policy tenant_isolation_case_task_reminders_all on public.case_task_reminders
  for select to authenticated using (organization_id in (select public.fn_user_org_ids()));
revoke all on public.case_task_reminders from public, anon, authenticated;
grant select on public.case_task_reminders to authenticated;
grant all on public.case_task_reminders to service_role;

create or replace function public.fn_processar_lembretes_tarefa(p_limite integer default 200)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.agent_cases%rowtype;
  instante timestamptz := clock_timestamp();
  patamar smallint;
  aviso uuid;
  quantidade integer := 0;
  tarefa text;
begin
  for c in
    select ac.* from public.agent_cases ac
    where ac.task_kind in ('payment_details','payment_review')
      and public.fn_org_operante(ac.organization_id)
      and ac.task_state in ('awaiting_human','send_failed')
      and ac.status in ('awaiting_human','awaiting_lead')
      and ac.wait_started_at <= instante - interval '3 minutes'
      and not exists (
        select 1 from public.case_task_reminders r
        where r.organization_id=ac.organization_id and r.case_id=ac.id and r.wait_generation=ac.wait_generation
          and r.minute = case when ac.wait_started_at <= instante-interval '9 minutes' then 9
            when ac.wait_started_at <= instante-interval '6 minutes' then 6 else 3 end
      )
    order by ac.wait_started_at
    limit greatest(1, least(coalesce(p_limite,200),500))
    for update of ac skip locked
  loop
    -- O lock faz a resolução humana e a cobrança terem ordem total. Os critérios
    -- do SELECT são reavaliados pelo PostgreSQL ao adquirir a linha atualizada.
    patamar := case when c.wait_started_at <= instante-interval '9 minutes' then 9
      when c.wait_started_at <= instante-interval '6 minutes' then 6 else 3 end;
    select r.inbox_id into aviso from public.case_task_reminders r
      where r.organization_id=c.organization_id and r.case_id=c.id and r.wait_generation=c.wait_generation
        and r.inbox_id is not null order by r.minute desc limit 1;
    tarefa := case when c.task_state='send_failed' then 'Revisar envio que falhou'
      when c.task_kind='payment_details' then 'Liberar dados de pagamento' else 'Conferir recebimento do pagamento' end;
    if aviso is null then
      insert into public.agent_inbox_items(organization_id,kind,severity,title,body,ref_kind,ref_id)
        values(c.organization_id,'case_stale','warn',tarefa || ' — ' || patamar || ' minutos',
          'A tarefa aguarda a equipe desde ' || c.wait_started_at::text || '. Abra o caso para resolver.' ||
          case when patamar=9 then ' Atrasada: permanece pendente até resolução.' else '' end,
          'agent_case',c.id) returning id into aviso;
    else
      update public.agent_inbox_items set status='open',resolved_at=null,
        title=tarefa || ' — ' || patamar || ' minutos',
        body='A tarefa aguarda a equipe desde ' || c.wait_started_at::text || '. Abra o caso para resolver.' ||
          case when patamar=9 then ' Atrasada: permanece pendente até resolução.' else '' end
        where id=aviso and organization_id=c.organization_id;
    end if;
    insert into public.case_task_reminders(organization_id,case_id,wait_generation,minute,result,inbox_id)
      select c.organization_id,c.id,c.wait_generation,m,
        case when m=patamar then 'notified' else 'superseded' end, aviso
      from unnest(array[3,6,9]::smallint[]) m where m<=patamar
      on conflict (organization_id,case_id,wait_generation,minute) do nothing;
    quantidade := quantidade+1;
  end loop;
  return quantidade;
end $$;
revoke execute on function public.fn_processar_lembretes_tarefa(integer) from public,anon,authenticated;
grant execute on function public.fn_processar_lembretes_tarefa(integer) to service_role;

create or replace function public.fn_encerrar_lembrete_tarefa()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.wait_generation is distinct from old.wait_generation
    or new.task_state not in ('awaiting_human','send_failed')
    or new.task_kind is null or new.status not in ('awaiting_human','awaiting_lead') then
    update public.agent_inbox_items i set status='resolved',resolved_at=clock_timestamp()
      where i.organization_id=old.organization_id and i.status='open'
        and exists (select 1 from public.case_task_reminders r
          where r.organization_id=old.organization_id and r.case_id=old.id
            and r.wait_generation=old.wait_generation and r.inbox_id=i.id);
  end if;
  return new;
end $$;
revoke execute on function public.fn_encerrar_lembrete_tarefa() from public,anon,authenticated;
grant execute on function public.fn_encerrar_lembrete_tarefa() to service_role;
drop trigger if exists trg_encerrar_lembrete_tarefa on public.agent_cases;
create trigger trg_encerrar_lembrete_tarefa after update of task_state,task_kind,status,wait_generation
  on public.agent_cases for each row execute function public.fn_encerrar_lembrete_tarefa();
notify pgrst, 'reload schema';
