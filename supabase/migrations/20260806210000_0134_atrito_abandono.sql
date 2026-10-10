-- 0117 — Índice de Atrito, Fase 2: abandono (spec 17 §5.2).
--
-- ABANDONO é o desfecho que ninguém reclama: a última palavra foi do sistema,
-- a pessoa não voltou, e a demanda nunca foi encerrada. Não gera ticket, não
-- gera nota baixa, não aparece em lugar nenhum — e é a perda mais comum.
--
-- A RÉGUA é parâmetro, não constante: em WhatsApp, 72h de silêncio significa
-- outra coisa que em e-mail. `p_abandono_horas` default 72. Quem chama lê o
-- valor da org (organizations.settings->'atrito'->>'abandono_horas') e o
-- exibe NA TELA junto do número — regra 4 do cap. 3.4 da doutrina: índice cuja
-- definição muda sem aviso destrói a única coisa que ele tinha, que é
-- comparabilidade no tempo.
--
-- Drop + create porque a assinatura muda (3 → 4 parâmetros). Sem o drop, o
-- Postgres criaria um OVERLOAD e passariam a existir duas funções com o mesmo
-- nome — a antiga continuaria respondendo às chamadas de 3 args, em silêncio,
-- para sempre.

drop function if exists public.fn_atrito_metrics(uuid, timestamptz, timestamptz);

-- Predicado do abandono: última outbound > última inbound (a última palavra foi
-- nossa) + silêncio maior que a janela + sem desfecho. O índice parcial cobre a
-- varredura por janela.
create index if not exists idx_conversations_org_silencio
  on public.conversations (organization_id, last_outbound_at)
  where last_outbound_at is not null;

create or replace function public.fn_atrito_metrics(
  p_org uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_abandono_horas int default 72
) returns jsonb
language sql stable
set search_path = public
as $$
  with
  demandas as (
    select c.id, c.conversation_id, c.opened_at, c.closed_at, c.status,
           c.followup_attempts
      from public.agent_cases c
     where c.organization_id = p_org
       and c.closed_at is not null
       and c.closed_at >= p_from
       and c.closed_at <  p_to
  ),
  turnos as (
    select d.id,
           (select count(*)
              from public.messages m
             where m.organization_id = p_org
               and m.conversation_id = d.conversation_id
               and m.sent_at >= d.opened_at
               and m.sent_at <  d.closed_at) as n
      from demandas d
  ),
  humano as (
    select e.case_id,
           count(*) as intervencoes,
           min(e.created_at) as primeiro_toque
      from public.agent_case_events e
      join demandas d on d.id = e.case_id
     where e.organization_id = p_org
       and e.actor_kind = 'human'
     group by e.case_id
  ),
  espera as (
    select extract(epoch from (h.primeiro_toque - d.opened_at)) as segundos
      from demandas d
      join humano h on h.case_id = d.id
     where h.primeiro_toque > d.opened_at
  ),
  retrabalho as (
    select count(distinct e.case_id) as n
      from public.agent_case_events e
      join demandas d on d.id = e.case_id
     where e.organization_id = p_org
       and (e.kind = 'escalated' or e.human_action = 'escalate')
  ),
  -- ABANDONO (Fase 2). Falamos por último, a pessoa não voltou dentro da
  -- janela, e a conversa segue sem desfecho. Contado por ÚLTIMA FALA nossa
  -- dentro do período — é um evento datável, não um estado de agora, senão o
  -- número não seria comparável entre períodos.
  abandono as (
    select
      count(*) filter (
        where cv.last_outbound_at >= p_from
          and cv.last_outbound_at <  p_to
          and (cv.last_inbound_at is null or cv.last_outbound_at > cv.last_inbound_at)
          and cv.last_outbound_at < now() - make_interval(hours => p_abandono_horas)
          and cv.status not in ('resolved', 'closed')
      ) as abandonadas,
      -- Denominador honesto: conversas em que O SISTEMA FALOU no período. Sem
      -- ele, "12 abandonos" não diz se é 12 de 15 ou 12 de 1200.
      count(*) filter (
        where cv.last_outbound_at >= p_from
          and cv.last_outbound_at <  p_to
      ) as com_fala_nossa
      from public.conversations cv
     where cv.organization_id = p_org
       and cv.last_outbound_at is not null
  ),
  envios as (
    select
      count(*) filter (where m.sent_via = 'ai')              as por_ia,
      count(*) filter (where m.sent_via = 'user')            as por_humano_no_sistema,
      count(*) filter (where m.sent_via = 'external_device') as por_humano_fora
      from public.messages m
     where m.organization_id = p_org
       and m.direction = 'outbound'
       and m.sent_at >= p_from
       and m.sent_at <  p_to
  ),
  vetos as (
    select count(*) filter (where t.vetoed_gate is not null) as vetados,
           count(distinct t.job_id)                          as execucoes
      from public.before_send_traces t
     where t.organization_id = p_org
       and t.created_at >= p_from
       and t.created_at <  p_to
  ),
  descadastros as (
    select count(*) as n
      from public.contacts c
     where c.organization_id = p_org
       and c.blocked_at is not null
       and c.blocked_at >= p_from
       and c.blocked_at <  p_to
  ),
  pedidos_humano as (
    select count(*) as n
      from public.crm_lead_activities a
     where a.organization_id = p_org
       and a.type = 'handoff_triggered'
       and a.performed_at >= p_from
       and a.performed_at <  p_to
  ),
  eficiencia as (
    select count(*) filter (where status = 'won')  as ganhos,
           count(*) filter (where status = 'lost') as perdidos
      from public.crm_leads
     where organization_id = p_org
       and status in ('won', 'lost')
       and closed_at >= p_from
       and closed_at <  p_to
  )
  select jsonb_build_object(
    'escopo', jsonb_build_object(
      'demandas', (select count(*) from demandas),
      'de',  p_from,
      'ate', p_to,
      -- A régua viaja COM o número (cap. 3.4, regra 4).
      'abandono_horas', p_abandono_horas
    ),
    'cliente', jsonb_build_object(
      'turnos_p50',        (select percentile_cont(0.5) within group (order by n) from turnos),
      'turnos_p90',        (select percentile_cont(0.9) within group (order by n) from turnos),
      'insistencia_media', (select avg(followup_attempts)::float8 from demandas),
      'insistencia_max',   (select max(followup_attempts) from demandas),
      'pedidos_de_humano', (select n from pedidos_humano),
      'descadastros',      (select n from descadastros),
      'abandonos',         (select abandonadas   from abandono),
      'conversas_com_fala_nossa', (select com_fala_nossa from abandono)
    ),
    'empresa', jsonb_build_object(
      'intervencoes_por_demanda', (select avg(coalesce(h.intervencoes, 0))::float8
                                     from demandas d
                                     left join humano h on h.case_id = d.id),
      'espera_humana_p50_s',      (select percentile_cont(0.5) within group (order by segundos) from espera),
      'espera_humana_p90_s',      (select percentile_cont(0.9) within group (order by segundos) from espera),
      'retrabalho',               (select n from retrabalho),
      'vetos',                    (select vetados  from vetos),
      'execucoes_medidas',        (select execucoes from vetos),
      'envios_por_ia',            (select por_ia                from envios),
      'envios_humano_no_sistema', (select por_humano_no_sistema from envios),
      'envios_humano_fora',       (select por_humano_fora       from envios)
    ),
    'eficiencia', jsonb_build_object(
      'ganhos',   (select ganhos   from eficiencia),
      'perdidos', (select perdidos from eficiencia)
    )
  );
$$;

revoke all     on function public.fn_atrito_metrics(uuid, timestamptz, timestamptz, int) from public;
revoke execute on function public.fn_atrito_metrics(uuid, timestamptz, timestamptz, int) from anon;
grant  execute on function public.fn_atrito_metrics(uuid, timestamptz, timestamptz, int)
  to authenticated, service_role;
