-- manifest: aplica a cadência configurável a todo caso que aguarda a equipe, sem cobrar enquanto aguarda o cliente
-- Casos gerais em espera passam a usar o mesmo relógio, recibos e opt-in já usados pelas tarefas financeiras.
drop trigger if exists trg_encerrar_lembrete_tarefa on public.agent_cases;

-- Backfill idempotente: a última resposta do cliente inicia o episódio atual;
-- sem esse evento, a abertura é o início. Nunca usamos updated_at, que muda
-- com comentários, atribuições e outras atividades sem retomada da espera.
update public.agent_cases c
   set wait_started_at = coalesce(
         (
           select max(e.created_at)
             from public.agent_case_events e
            where e.organization_id = c.organization_id
              and e.case_id = c.id
              and e.kind = 'lead_provided'
         ),
         c.opened_at,
         c.created_at,
         clock_timestamp()
       ),
       wait_generation = greatest(coalesce(c.wait_generation, 0), 1)
 where c.task_kind is null
   and c.task_state is null
   and c.status = 'awaiting_human'
   and c.wait_started_at is null;

-- O índice anterior cobria apenas tarefas especializadas. O novo atende todos os
-- casos em espera, inclusive os gerais, e continua excluindo estados terminais.
drop index if exists public.agent_cases_task_wait_idx;
create index if not exists agent_cases_task_wait_idx
  on public.agent_cases(organization_id, wait_started_at)
  where wait_started_at is not null
    and status in ('awaiting_human','awaiting_lead');

create or replace function public.fn_processar_lembretes_tarefa(p_limite integer default 200)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.agent_cases%rowtype;
  instante timestamptz := clock_timestamp();
  marcos smallint[];
  patamar smallint;
  ultimo_patamar smallint;
  aviso uuid;
  quantidade integer := 0;
  tarefa text;
  repetir_whatsapp boolean;
  evento_whatsapp uuid;
begin
  for c in
    select ac.*
      from public.agent_cases ac
     where public.fn_org_operante(ac.organization_id)
       and ac.wait_started_at is not null
       and (
         (
           ac.task_kind in ('payment_details','payment_review')
           and ac.task_state in ('awaiting_human','send_failed')
           and ac.status in ('awaiting_human','awaiting_lead')
         )
         or (
           ac.task_kind is null
           and ac.task_state is null
           and ac.status = 'awaiting_human'
         )
       )
       and exists (
         select 1
           from unnest(coalesce(
             (select cfg.minutos_lembrete_equipe
                from public.config_aviso_de_caso cfg
               where cfg.organization_id = ac.organization_id),
             array[3,6,9]::smallint[]
           )) as marco(minuto)
          where ac.wait_started_at <= instante - make_interval(mins => marco.minuto::integer)
       )
       and (
         not exists (
           select 1
             from public.case_task_reminders r
            where r.organization_id = ac.organization_id
              and r.case_id = ac.id
              and r.wait_generation = ac.wait_generation
              and r.minute = (
                select max(marco.minuto)
                  from unnest(coalesce(
                    (select cfg.minutos_lembrete_equipe
                       from public.config_aviso_de_caso cfg
                      where cfg.organization_id = ac.organization_id),
                    array[3,6,9]::smallint[]
                  )) as marco(minuto)
                 where ac.wait_started_at <= instante - make_interval(mins => marco.minuto::integer)
              )
         and r.result = 'notified'
         )
         or (
           exists (
             select 1
               from public.config_aviso_de_caso cfg
              where cfg.organization_id = ac.organization_id
                and cfg.repetir_lembretes_whatsapp
           )
           and exists (
             select 1
               from public.case_task_reminders r
              where r.organization_id = ac.organization_id
                and r.case_id = ac.id
                and r.wait_generation = ac.wait_generation
                and r.minute = (
                  select max(marco.minuto)
                    from unnest(coalesce(
                      (select cfg.minutos_lembrete_equipe
                         from public.config_aviso_de_caso cfg
                        where cfg.organization_id = ac.organization_id),
                      array[3,6,9]::smallint[]
                    )) as marco(minuto)
                   where ac.wait_started_at <= instante - make_interval(mins => marco.minuto::integer)
                )
                and r.result = 'notified'
                and r.whatsapp_event_id is null
           )
         )
       )
     order by ac.wait_started_at
     limit greatest(1, least(coalesce(p_limite,200),500))
     for update of ac skip locked
  loop
    marcos := array[3,6,9]::smallint[];
    select cfg.minutos_lembrete_equipe
      into marcos
      from public.config_aviso_de_caso cfg
     where cfg.organization_id = c.organization_id;
    if not found or marcos is null then
      marcos := array[3,6,9]::smallint[];
    end if;

    select max(marco.minuto)
      into patamar
      from unnest(marcos) as marco(minuto)
     where c.wait_started_at <= instante - make_interval(mins => marco.minuto::integer);
    if patamar is null then
      continue;
    end if;
    ultimo_patamar := marcos[cardinality(marcos)];
    select r.inbox_id
      into aviso
      from public.case_task_reminders r
     where r.organization_id = c.organization_id
       and r.case_id = c.id
       and r.wait_generation = c.wait_generation
       and r.inbox_id is not null
     order by r.minute desc
     limit 1;

    -- Casos gerais podem já ter um alerta aberto do vigia de 24 horas.
    -- Reutilize-o apenas quando ainda não há recibo no episódio atual.
    if aviso is null and c.task_kind is null then
      select i.id
        into aviso
        from public.agent_inbox_items i
       where i.organization_id = c.organization_id
         and i.kind = 'case_stale'
         and i.ref_kind = 'agent_case'
         and i.ref_id = c.id
         and i.status = 'open'
       order by i.created_at desc
       limit 1;
    end if;

    tarefa := case
      when c.task_kind is null then 'Caso aguardando equipe'
      when c.task_state = 'send_failed' then 'Revisar envio que falhou'
      when c.task_kind = 'payment_details' then 'Liberar dados de pagamento'
      else 'Conferir recebimento do pagamento'
    end;

    if aviso is null then
      insert into public.agent_inbox_items(organization_id,kind,severity,title,body,ref_kind,ref_id)
      values (
        c.organization_id,
        'case_stale',
        'warn',
        tarefa || ' — ' || patamar || ' minutos',
        (case when c.task_kind is null then 'O caso aguarda a equipe desde ' else 'A tarefa aguarda a equipe desde ' end)
          || c.wait_started_at::text || '. Abra o caso para resolver.'
          || case when patamar = ultimo_patamar then ' Atrasada: permanece pendente até resolução.' else '' end,
        'agent_case',
        c.id
      )
      returning id into aviso;
    else
      update public.agent_inbox_items
         set status = 'open',
             resolved_at = null,
             title = tarefa || ' — ' || patamar || ' minutos',
             body = (case when c.task_kind is null then 'O caso aguarda a equipe desde ' else 'A tarefa aguarda a equipe desde ' end)
          || c.wait_started_at::text || '. Abra o caso para resolver.'
               || case when patamar = ultimo_patamar then ' Atrasada: permanece pendente até resolução.' else '' end
       where id = aviso
         and organization_id = c.organization_id;
    end if;

    insert into public.case_task_reminders as lembrete_atual(organization_id,case_id,wait_generation,minute,result,inbox_id)
    select c.organization_id,
           c.id,
           c.wait_generation,
           marco.minuto,
           case when marco.minuto = patamar then 'notified' else 'superseded' end,
           aviso
      from unnest(marcos) as marco(minuto)
     where marco.minuto <= patamar
    on conflict (organization_id,case_id,wait_generation,minute) do update
       set result = 'notified',
           recorded_at = clock_timestamp(),
           inbox_id = coalesce(lembrete_atual.inbox_id, excluded.inbox_id)
     where lembrete_atual.result = 'superseded'
       and lembrete_atual.minute = patamar;

    select coalesce(cfg.repetir_lembretes_whatsapp, false)
      into repetir_whatsapp
      from public.config_aviso_de_caso cfg
     where cfg.organization_id = c.organization_id;
    repetir_whatsapp := coalesce(repetir_whatsapp, false);

    if repetir_whatsapp then
      select r.whatsapp_event_id
        into evento_whatsapp
        from public.case_task_reminders r
       where r.organization_id = c.organization_id
         and r.case_id = c.id
         and r.wait_generation = c.wait_generation
         and r.minute = patamar
         and r.result = 'notified';
      if evento_whatsapp is null then
        evento_whatsapp := public.emit_event(
          'ai.case_task_reminder_due',
          'agent_case',
          c.id,
          jsonb_build_object(
            'case_id', c.id,
            'wait_generation', c.wait_generation,
            'minute', patamar
          ),
          '{}'::jsonb,
          c.organization_id
        );
        update public.case_task_reminders
           set whatsapp_event_id = evento_whatsapp
         where organization_id = c.organization_id
           and case_id = c.id
           and wait_generation = c.wait_generation
           and minute = patamar
           and result = 'notified'
           and whatsapp_event_id is null;
        if not found then
          raise exception 'case_task_reminder_event_link_failed';
        end if;
      end if;
    end if;

    quantidade := quantidade + 1;
  end loop;
  return quantidade;
end
$$;
revoke execute on function public.fn_processar_lembretes_tarefa(integer) from public, anon, authenticated;
grant execute on function public.fn_processar_lembretes_tarefa(integer) to service_role;

create or replace function public.fn_encerrar_lembrete_tarefa()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.wait_generation is distinct from old.wait_generation
    or not (
      (
        new.task_kind is null
        and new.task_state is null
        and new.status = 'awaiting_human'
      )
      or (
        new.task_kind is not null
        and new.task_kind in ('payment_details','payment_review')
        and new.task_state in ('awaiting_human','send_failed')
        and new.status in ('awaiting_human','awaiting_lead')
      )
    )
  then
    update public.agent_inbox_items i
       set status = 'resolved',
           resolved_at = clock_timestamp()
     where i.organization_id = old.organization_id
       and i.status = 'open'
       and exists (
         select 1
           from public.case_task_reminders r
          where r.organization_id = old.organization_id
            and r.case_id = old.id
            and r.wait_generation = old.wait_generation
            and r.inbox_id = i.id
       );
  end if;
  return new;
end
$$;
revoke execute on function public.fn_encerrar_lembrete_tarefa() from public, anon, authenticated;
grant execute on function public.fn_encerrar_lembrete_tarefa() to service_role;

create trigger trg_encerrar_lembrete_tarefa
  after update of task_state, task_kind, status, wait_generation
  on public.agent_cases
  for each row execute function public.fn_encerrar_lembrete_tarefa();

notify pgrst, 'reload schema';
