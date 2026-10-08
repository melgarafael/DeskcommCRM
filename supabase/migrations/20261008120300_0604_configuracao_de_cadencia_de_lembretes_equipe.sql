-- manifest: Torna configurável a cadência de lembretes da Central e dos reforços WhatsApp, preservando recibos e catch-up sem rajada.

-- A função pura valida também a forma do array: somente uma dimensão, índice inicial 1,
-- 1–10 valores, estritamente crescentes, sem nulos, dentro de 1..1440.
create or replace function public.fn_minutos_lembrete_equipe_validos(p_minutos smallint[])
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_minuto smallint;
  v_anterior smallint := 0;
begin
  if p_minutos is null
    or coalesce(array_ndims(p_minutos), 0) <> 1
    or array_lower(p_minutos, 1) <> 1
    or cardinality(p_minutos) not between 1 and 10 then
    return false;
  end if;

  foreach v_minuto in array p_minutos loop
    if v_minuto is null or v_minuto < 1 or v_minuto > 1440 or v_minuto <= v_anterior then
      return false;
    end if;
    v_anterior := v_minuto;
  end loop;

  return true;
end;
$$;
revoke all on function public.fn_minutos_lembrete_equipe_validos(smallint[]) from public, anon, authenticated;
grant execute on function public.fn_minutos_lembrete_equipe_validos(smallint[]) to service_role;

alter table public.config_aviso_de_caso
  add column if not exists repetir_lembretes_whatsapp boolean not null default false;
alter table public.config_aviso_de_caso
  add column if not exists minutos_lembrete_equipe smallint[] not null default array[3,6,9]::smallint[];
alter table public.config_aviso_de_caso
  alter column minutos_lembrete_equipe set default array[3,6,9]::smallint[],
  alter column minutos_lembrete_equipe set not null;
alter table public.config_aviso_de_caso
  drop constraint if exists config_aviso_de_caso_minutos_lembrete_equipe_check;
alter table public.config_aviso_de_caso
  add constraint config_aviso_de_caso_minutos_lembrete_equipe_check
  check (public.fn_minutos_lembrete_equipe_validos(minutos_lembrete_equipe));

-- Sem conexão, o opt-in de WhatsApp fica desligado. A cadência continua válida
-- para a Central e não depende de uma conexão ativa.
create or replace function public.fn_aviso_de_caso_coerente()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.channel_session_id is null then
    new.ligado := false;
    new.repetir_lembretes_whatsapp := false;
  end if;
  return new;
end;
$$;
revoke all on function public.fn_aviso_de_caso_coerente() from public, anon, authenticated;

-- Identidade durável do evento de WhatsApp, sem FK para o barramento: recibos
-- sobrevivem a uma eventual política futura de retenção do event_log.
alter table public.case_task_reminders
  add column if not exists whatsapp_event_id uuid;
create unique index if not exists case_task_reminders_whatsapp_event_unique
  on public.case_task_reminders (whatsapp_event_id)
  where whatsapp_event_id is not null;
alter table public.case_task_reminders
  drop constraint if exists case_task_reminders_minute_check;
alter table public.case_task_reminders
  drop constraint if exists case_task_reminders_minute_range_check;
alter table public.case_task_reminders
  add constraint case_task_reminders_minute_range_check
  check (minute between 1 and 1440);

-- O aviso inicial mantém sua chave anterior. Reforços passam a usar
-- org/caso/geração/minuto/destino; recibos já existentes são preservados.
alter table public.entregas_de_aviso_de_caso
  add column if not exists wait_generation bigint,
  add column if not exists reminder_minute smallint;
alter table public.entregas_de_aviso_de_caso
  drop constraint if exists entregas_de_aviso_de_caso_reminder_key_check;
alter table public.entregas_de_aviso_de_caso
  add constraint entregas_de_aviso_de_caso_reminder_key_check
  check (
    (wait_generation is null and reminder_minute is null)
    or (
      wait_generation is not null
      and reminder_minute is not null
      and reminder_minute between 1 and 1440
    )
  );

drop index if exists public.entregas_de_aviso_de_caso_unica;
create unique index if not exists entregas_de_aviso_de_caso_unica
  on public.entregas_de_aviso_de_caso (organization_id, case_id, destino)
  where wait_generation is null and reminder_minute is null;
create unique index if not exists entregas_de_aviso_de_caso_lembrete_unica
  on public.entregas_de_aviso_de_caso
    (organization_id, case_id, wait_generation, reminder_minute, destino)
  where wait_generation is not null and reminder_minute is not null;

-- A cada execução, só o marco configurado mais recente que já venceu gera aviso.
-- Marcos anteriores vencidos entram como superseded, nunca como uma rajada.
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
     where ac.task_kind in ('payment_details','payment_review')
       and public.fn_org_operante(ac.organization_id)
       and ac.task_state in ('awaiting_human','send_failed')
       and ac.status in ('awaiting_human','awaiting_lead')
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

    tarefa := case
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
        'A tarefa aguarda a equipe desde ' || c.wait_started_at::text || '. Abra o caso para resolver.'
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
             body = 'A tarefa aguarda a equipe desde ' || c.wait_started_at::text || '. Abra o caso para resolver.'
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

-- Substitui a assinatura local anterior para que chamadas sem o array não
-- continuem gravando uma configuração sem os novos marcos.
drop function if exists public.fn_definir_aviso_de_caso_repeticao(uuid,uuid,text,text,boolean,boolean,boolean,boolean);
create or replace function public.fn_definir_aviso_de_caso_repeticao(
  p_org uuid,
  p_channel uuid,
  p_telefone text,
  p_rotulo text,
  p_ligado boolean,
  p_confirma_contato boolean default false,
  p_sem_link boolean default false,
  p_repetir_lembretes_whatsapp boolean default false,
  p_minutos_lembrete_equipe smallint[] default array[3,6,9]::smallint[]
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_resultado jsonb;
  v_repetir_salvo boolean;
  v_minutos_salvos smallint[];
begin
  if not public.fn_minutos_lembrete_equipe_validos(p_minutos_lembrete_equipe) then
    raise exception using
      errcode = '22023',
      message = 'minutos_lembrete_equipe_invalido';
  end if;
  v_resultado := public.fn_definir_aviso_de_caso_local(
    p_org,
    p_channel,
    p_telefone,
    p_rotulo,
    p_ligado,
    p_confirma_contato,
    p_sem_link
  );

  update public.config_aviso_de_caso
     set repetir_lembretes_whatsapp = coalesce(p_repetir_lembretes_whatsapp, false),
         minutos_lembrete_equipe = p_minutos_lembrete_equipe
   where organization_id = p_org;

  select cfg.repetir_lembretes_whatsapp, cfg.minutos_lembrete_equipe
    into v_repetir_salvo, v_minutos_salvos
    from public.config_aviso_de_caso cfg
   where cfg.organization_id = p_org;

  if not found then
    raise exception 'aviso_de_caso_configuracao_ausente';
  end if;
  if v_minutos_salvos is distinct from p_minutos_lembrete_equipe then
    raise exception 'aviso_de_caso_cadencia_nao_persistida';
  end if;
  return v_resultado || jsonb_build_object(
    'repetir_lembretes_whatsapp', v_repetir_salvo,
    'minutos_lembrete_equipe', v_minutos_salvos
  );
end;
$$;
revoke all on function public.fn_definir_aviso_de_caso_repeticao(
  uuid,uuid,text,text,boolean,boolean,boolean,boolean,smallint[]
) from public, anon, authenticated;
grant execute on function public.fn_definir_aviso_de_caso_repeticao(
  uuid,uuid,text,text,boolean,boolean,boolean,boolean,smallint[]
) to authenticated;

notify pgrst, 'reload schema';
