-- manifest: **O histórico importado vira perfil e oportunidade sem falar com o cliente — com confirmação, teto por rodada e respeito a quem recusou IA (PR #4152, de @bestbill; decisão 315, alternativa A).** Acrescenta `history_analysis` à fila durável, sempre com contato, e uma chave única por importação+contato para que clique duplo/retry não crie duas análises. `fn_historico_analise_motivo_para_pular` é a régua ÚNICA de quem a análise não lê: contato que recusou IA (`ai_opt_out`, bloqueado, pessoal, anonimizado, fundido, ou recusa registrada de `automated_service`/`profiling` em `consent`, nos dois formatos) e contato cujo `lead_state` ou último checkpoint é MAIS NOVO que a última mensagem importada (a análise de conversa velha nunca grava por cima). `fn_historico_analise_candidatos` lista os contatos da importação com o motivo; `fn_previa_historico_analise` devolve a contagem da rodada, o que fica para a próxima, os pulados e a estimativa de custo contra o orçamento mensal que já existe (`fn_gasto_de_ia_do_mes`, `ai_budgets`); `fn_enqueue_historico_analise` enfileira no máximo `p_limite` contatos (o teto confirmado pelo administrador). `fn_resumo_historico_analise` devolve contagens por estado e o gasto real das análises desta importação, sem texto de conversa. Todas `security invoker`, EXECUTE só para service_role. Nenhuma tabela nova, nenhum gatilho e nenhum envio. Reaplicável; espelho idempotente no `supabase/baseline.sql`. Gates: `tests/invariants/historico-analise-fila.test.ts` e unitários do handler/rota.

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

-- A RÉGUA ÚNICA de quem a análise do histórico não lê. A prévia, o enfileirar e
-- o handler (duas vezes: antes da chamada de IA e dentro da transação de
-- escrita) perguntam a ESTA função — uma régua por chamador seria duas réguas.
--
-- 'recusou_ia': os mesmos sinais que calam o agente e o follow-up
-- (`readStopFlags`, `isLeadInHandoff`): `ai_opt_out`, `is_blocked`,
-- `is_personal`; mais a LGPD (`is_anonymized`, ficha fundida) e a recusa
-- REGISTRADA de `consent.automated_service` (o atendimento por IA) ou
-- `consent.profiling` (perfilamento, que é o que esta análise faz), nos dois
-- formatos de `lib/lgpd/recusa-registrada.ts` — `declined_at` da captação e
-- `granted: false` da ficha. Ausência de consentimento NÃO é recusa.
-- `force_human` fica fora de propósito: é a conversa com a equipe (#3310), não
-- um pedido do contato, e a análise não fala com ninguém.
--
-- 'estado_mais_novo': o contato já tem `lead_state` ou checkpoint gravado
-- DEPOIS da última mensagem desta importação. A análise lê conversa antiga; o
-- que foi escrito depois dela é mais novo e não pode ser coberto.
--
-- As quatro funções desta migration são PL/pgSQL, não SQL, de propósito: o
-- baseline as cria ANTES da VARREDURA anon, e `contacts.ai_opt_out` e
-- `importacoes_de_historico.origem` só nascem no apêndice DEPOIS dela. Função
-- SQL valida o corpo ao ser criada e quebraria o install; PL/pgSQL adia.
create or replace function public.fn_historico_analise_motivo_para_pular(
  p_org uuid,
  p_contato uuid,
  p_importacao uuid
) returns text
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  return (
  select case
    when c.id is null then 'sem_contato'
    when c.ai_opt_out or c.is_blocked or c.is_personal or c.is_anonymized
      or c.is_merged_into is not null
      or nullif(c.consent #>> '{automated_service,declined_at}', '') is not null
      or c.consent #> '{automated_service,granted}' = 'false'::jsonb
      or nullif(c.consent #>> '{profiling,declined_at}', '') is not null
      or c.consent #> '{profiling,granted}' = 'false'::jsonb
      then 'recusou_ia'
    when greatest(
      (select s.updated_at from public.lead_state s
        where s.organization_id = p_org and s.contact_id = p_contato),
      (select max(k.created_at) from public.lead_checkpoints k
        where k.organization_id = p_org and k.contact_id = p_contato)
    ) > (
      select max(m.sent_at) from public.messages m
       where m.organization_id = p_org
         and m.contact_id = p_contato
         and m.metadata ->> 'importacao_id' = p_importacao::text
    ) then 'estado_mais_novo'
    else null
  end
  from (select 1) as um
  left join public.contacts c on c.organization_id = p_org and c.id = p_contato
  );
end;
$$;

revoke all on function public.fn_historico_analise_motivo_para_pular(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.fn_historico_analise_motivo_para_pular(uuid, uuid, uuid)
  to service_role;

-- Os contatos da importação manual concluída, um por linha: a conversa mais
-- recente, a última mensagem, quanto texto há para ler (cortado no mesmo teto
-- de caracteres do handler, `MAX_CARACTERES_DA_ANALISE`), o motivo para pular
-- e o estado do job que já exista. Uma leitura só de `messages`. As colunas de
-- saída viram variáveis em PL/pgSQL: `use_column` e tudo qualificado.
create or replace function public.fn_historico_analise_candidatos(
  p_org uuid,
  p_importacao uuid
) returns table (
  contact_id uuid,
  conversation_id uuid,
  ultima_mensagem_em timestamptz,
  caracteres integer,
  motivo text,
  job_status text
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  return query
  with importacao as (
    select i.id
      from public.importacoes_de_historico i
     where i.id = p_importacao
       and i.organization_id = p_org
       and i.origem = 'manual'
       and i.status = 'concluida'
  ), por_contato as (
    select m.contact_id,
           (array_agg(m.conversation_id order by m.sent_at desc, m.id desc))[1] as conversation_id,
           max(m.sent_at) as ultima_mensagem_em,
           least(
             coalesce(sum(length(m.body)) filter (where m.type not in ('reaction', 'system')), 0),
             48000
           )::integer as caracteres
      from public.messages m
      join importacao i on m.metadata ->> 'importacao_id' = i.id::text
     where m.organization_id = p_org
       and m.contact_id is not null
     group by m.contact_id
  )
  select p.contact_id,
         p.conversation_id,
         p.ultima_mensagem_em,
         p.caracteres,
         public.fn_historico_analise_motivo_para_pular(p_org, p.contact_id, p_importacao),
         (select j.status
            from public.job_queue j
           where j.organization_id = p_org
             and j.contact_id = p.contact_id
             and j.kind = 'history_analysis'
             and j.payload ->> 'importacao_id' = p_importacao::text)
    from por_contato p;
end;
$$;

revoke all on function public.fn_historico_analise_candidatos(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.fn_historico_analise_candidatos(uuid, uuid)
  to service_role;

-- O que o administrador vê ANTES de confirmar: quantos clientes entram nesta
-- rodada (no máximo `p_limite`), quantos ficam para a próxima, quantos são
-- pulados e por quê, e a estimativa de custo contra o orçamento que já existe.
--
-- A estimativa é centavos-por-token das chamadas `checkpoint` da organização
-- nos últimos 30 dias (o purpose da análise, logo o mesmo modelo pelo
-- `ai_purpose_bindings`) vezes os tokens da rodada: texto/4 de entrada mais
-- 4000 por contato (instruções e o teto de saída de 3000). É teto, não média.
-- Sem chamada com preço nesse período, `null`: sem base, o número não é inventado.
create or replace function public.fn_previa_historico_analise(
  p_org uuid,
  p_importacao uuid,
  p_limite integer
) returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  return (
  with c as (
    select * from public.fn_historico_analise_candidatos(p_org, p_importacao)
  ), pendentes as (
    select * from c
     where c.motivo is null
       and (c.job_status is null or c.job_status in ('failed', 'dead'))
  ), rodada as (
    select * from pendentes
     order by ultima_mensagem_em desc, contact_id
     limit greatest(coalesce(p_limite, 0), 0)
  ), taxa as (
    select sum(l.cost_cents) / nullif(sum(l.input_tokens + l.output_tokens), 0) as cents_por_token
      from public.llm_calls l
     where l.organization_id = p_org
       and l.purpose = 'checkpoint'
       and l.cost_cents is not null
       and l.created_at >= now() - interval '30 days'
  )
  select jsonb_build_object(
    'nesta_rodada', (select count(*) from rodada),
    'restantes', (select count(*) from pendentes) - (select count(*) from rodada),
    'pulados_recusa', (select count(*) from c
                        where c.motivo = 'recusou_ia' and c.job_status is distinct from 'done'),
    'pulados_mais_novos', (select count(*) from c
                            where c.motivo = 'estado_mais_novo' and c.job_status is distinct from 'done'),
    'em_andamento', (select count(*) from c where c.job_status in ('pending', 'running')),
    'teto_da_rodada', p_limite,
    'estimativa_cents', (
      select round(t.cents_por_token * (
               (select coalesce(sum(r.caracteres), 0) from rodada r) / 4.0
               + (select count(*) from rodada) * 4000
             ), 2)
        from taxa t
    ),
    'gasto_do_mes_cents', public.fn_gasto_de_ia_do_mes(p_org),
    'teto_mensal_cents', (select case when b.enforcement_mode <> 'off' then b.monthly_limit_cents end
                            from public.ai_budgets b where b.organization_id = p_org)
  )
  );
end;
$$;

revoke all on function public.fn_previa_historico_analise(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.fn_previa_historico_analise(uuid, uuid, integer)
  to service_role;

-- Enfileira NO MÁXIMO `p_limite` contatos — o número que o administrador
-- confirmou na tela, nunca acima do teto da rodada (a rota corta). A ordem é a
-- da prévia (conversa mais recente primeiro), então a rodada confirmada é a
-- rodada enfileirada. Falha terminal volta a `pending` e conta no teto.
create or replace function public.fn_enqueue_historico_analise(
  p_org uuid,
  p_importacao uuid,
  p_limite integer
) returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_total integer;
begin
  if coalesce(p_limite, 0) < 1 then
    return 0;
  end if;

  with rodada as (
    select c.contact_id, c.conversation_id
      from public.fn_historico_analise_candidatos(p_org, p_importacao) c
     where c.motivo is null
       and (c.job_status is null or c.job_status in ('failed', 'dead'))
     order by c.ultima_mensagem_em desc, c.contact_id
     limit p_limite
  ), reativados as (
    update public.job_queue j
       set status = 'pending',
           attempts = 0,
           run_after = now(),
           last_error = null,
           locked_by = null,
           locked_at = null
      from rodada c
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
      from rodada c
    on conflict do nothing
    returning 1
  )
  select ((select count(*) from reativados) + (select count(*) from inseridos))::integer
    into v_total;

  return v_total;
end;
$$;

revoke all on function public.fn_enqueue_historico_analise(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.fn_enqueue_historico_analise(uuid, uuid, integer)
  to service_role;

-- Contagens por estado e o gasto REAL das análises desta importação (soma de
-- `llm_calls.cost_cents` pelos jobs dela — gasto por job, não a régua mensal,
-- que continua sendo `fn_gasto_de_ia_do_mes`). Nenhum texto de conversa.
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
    'dead', count(*) filter (where status = 'dead'),
    'gasto_cents', (
      select coalesce(sum(l.cost_cents), 0)
        from public.llm_calls l
        join public.job_queue j on j.id = l.job_id
       where l.organization_id = p_org
         and j.organization_id = p_org
         and j.kind = 'history_analysis'
         and j.payload ->> 'importacao_id' = p_importacao::text
    )
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
