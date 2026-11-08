-- manifest: **O histórico importado vira perfil e oportunidade sem falar com o cliente.** Acrescenta `history_analysis` à fila durável, sempre com contato, e uma chave única por importação+contato para que clique duplo/retry não crie duas análises. `fn_enqueue_historico_analise` (security invoker; EXECUTE só service_role) aceita apenas importação manual concluída da mesma organização e enfileira um job por contato que realmente tem mensagem marcada com aquele `importacao_id`; o payload carrega só ponteiros. `fn_resumo_historico_analise` devolve contagens por estado para a tela, sem texto de conversa. Nenhuma tabela nova, nenhum gatilho e nenhum envio. Reaplicável; espelho idempotente no `supabase/baseline.sql`. Gates: `tests/invariants/historico-analise-fila.test.ts` e unitários do handler/rota.

alter table public.job_queue drop constraint if exists job_queue_kind_check;
alter table public.job_queue add constraint job_queue_kind_check
  check (kind in (
    'inbound_turn','followup_turn','watchdog','flywheel','case_reply_turn',
    'operator_turn','transactional_delivery','approved_reply','history_analysis'
  ));

alter table public.job_queue drop constraint if exists job_queue_turn_needs_contact;
alter table public.job_queue add constraint job_queue_turn_needs_contact
  check ((kind in (
    'inbound_turn','followup_turn','case_reply_turn','operator_turn',
    'transactional_delivery','approved_reply','history_analysis'
  )) = (contact_id is not null));

create unique index if not exists job_queue_historico_analise_unica_idx
  on public.job_queue (
    organization_id,
    contact_id,
    ((payload ->> 'importacao_id'))
  )
  where kind = 'history_analysis';

create or replace function public.fn_enqueue_historico_analise(
  p_org uuid,
  p_importacao uuid
) returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_total integer;
begin
  with importacao as (
    select i.id
      from public.importacoes_de_historico i
     where i.id = p_importacao
       and i.organization_id = p_org
       and i.origem = 'manual'
       and i.status = 'concluida'
  ), conversas as (
    select distinct on (m.contact_id)
           m.contact_id,
           m.conversation_id
      from public.messages m
      join importacao i
        on m.metadata ->> 'importacao_id' = i.id::text
     where m.organization_id = p_org
       and m.contact_id is not null
     order by m.contact_id, m.sent_at desc, m.id desc
  ), reativados as (
    update public.job_queue j
       set status = 'pending',
           attempts = 0,
           run_after = now(),
           last_error = null,
           locked_by = null,
           locked_at = null
      from conversas c
     where j.organization_id = p_org
       and j.contact_id = c.contact_id
       and j.kind = 'history_analysis'
       and j.payload ->> 'importacao_id' = p_importacao::text
       and j.status in ('failed', 'dead')
    returning 1
  ), inseridos as (
    insert into public.job_queue (
      organization_id,
      contact_id,
      kind,
      payload,
      priority,
      max_attempts
    )
    select p_org,
           c.contact_id,
           'history_analysis',
           jsonb_build_object(
             'importacao_id', p_importacao,
             'conversation_id', c.conversation_id
           ),
           140,
           3
      from conversas c
    on conflict do nothing
    returning 1
  )
  select ((select count(*) from reativados) + (select count(*) from inseridos))::integer
    into v_total;

  return v_total;
end;
$$;

revoke all on function public.fn_enqueue_historico_analise(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.fn_enqueue_historico_analise(uuid, uuid)
  to service_role;

create or replace function public.fn_resumo_historico_analise(
  p_org uuid,
  p_importacao uuid
) returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  return (
  select jsonb_build_object(
    'total', count(*),
    'pending', count(*) filter (where status = 'pending'),
    'running', count(*) filter (where status = 'running'),
    'done', count(*) filter (where status = 'done'),
    'failed', count(*) filter (where status = 'failed'),
    'dead', count(*) filter (where status = 'dead')
  )
    from public.job_queue
   where organization_id = p_org
     and kind = 'history_analysis'
     and payload ->> 'importacao_id' = p_importacao::text
  );
end;
$$;

revoke all on function public.fn_resumo_historico_analise(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.fn_resumo_historico_analise(uuid, uuid)
  to service_role;
