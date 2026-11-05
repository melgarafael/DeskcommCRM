-- manifest: fn_uso_de_ia conta o job de follow-up (`followup_turn`) como turno do agente, para o cartão "Turnos do agente" e o custo médio por turno não perderem o follow-up quando ele ganha ponto de IA próprio (#3897).
--
-- O #3897 deu ao follow-up o ponto de IA `followup_turn`: a chamada principal de
-- todo job `followup_turn` passa a gravar `purpose = 'followup_turn'` em
-- `llm_calls`, com ou sem modelo escolhido no painel. A 0586 contava turno como
-- "job distinto com chamada `agent_turn` ok" — então, sem esta migration, o
-- follow-up sumiria em silêncio do cartão "Turnos do agente" e do custo médio por
-- turno da tela Uso de IA (numa instalação real, ~31% do gasto era follow-up).
--
-- Decisão: preservar o número de hoje. O follow-up É o agente escrevendo — mesmo
-- turno, mesma versão publicada, mesmas ferramentas — e sempre contou como turno.
-- Só muda a CTE `jobs_de_turno`: `c.purpose in ('agent_turn', 'followup_turn')`.
-- O resto do corpo é o da 0586, inteiro. O custo POR PONTO continua separado no
-- agrupamento por `purpose` — é isso que o ponto próprio compra.
--
-- Corpo, comment e grants iguais ao apêndice do baseline (`apendice-do-baseline-
-- nao-diverge-da-cadeia`). Invoker: a VARREDURA anon nem a alcançaria; o
-- `revoke ... from public, anon` abaixo é a proteção, como na 0586.
--
-- "Turnos do agente" = jobs distintos com chamada `agent_turn` ou `followup_turn`
-- de status 'ok'. A chamada que falhou grava o mesmo purpose na mesma tabela
-- (status 'erro', custo null): contar o job dela como turno inventaria respostas
-- que nunca saíram e puxaria o custo médio por turno para baixo.
--
-- O custo do turno é o do JOB inteiro (checkpoint, classificador de etapa,
-- compactação), e essas chamadas gravam `agent_id` null. Por isso os turnos NÃO
-- passam pelos filtros de `p_agent_id`/`p_purpose` das outras somas: o agente
-- escolhe quais jobs entram (pela chamada de turno dele), e o custo de cada
-- job é sempre inteiro. Filtrar antes faria o mesmo cartão mostrar um custo por
-- turno menor com o filtro ligado, e "sem turnos" ao filtrar por outro tipo.
--
-- `llm_calls.job_id` é `on delete set null`, então um turno cujo job a poda da
-- fila já apagou (`JOB_QUEUE_RETENTION_DAYS`, padrão 90) deixa de ser contado —
-- e o custo dele sai junto do custo por turno, para a média não ficar inflada.
create or replace function public.fn_uso_de_ia(
  p_org uuid,
  p_desde timestamptz,
  p_ate timestamptz,
  p_agent_id uuid default null,
  p_purpose text default null
)
returns jsonb
  language sql
  stable
  security invoker
  set search_path to 'public', 'pg_temp'
as $$
  with chamadas as (
    select (c.created_at at time zone 'UTC')::date as dia,
           c.purpose,
           c.cost_cents,
           c.input_tokens,
           c.output_tokens,
           c.cache_read_tokens,
           c.cache_write_tokens,
           c.latency_ms
      from public.llm_calls c
     where c.organization_id = p_org
       and c.created_at >= p_desde
       and c.created_at <= p_ate
       and (p_agent_id is null or c.agent_id = p_agent_id)
       and (p_purpose is null or c.purpose = p_purpose)
  ),
  jobs_de_turno as (
    select distinct c.job_id
      from public.llm_calls c
     where c.organization_id = p_org
       and c.created_at >= p_desde
       and c.created_at <= p_ate
       and c.purpose in ('agent_turn', 'followup_turn')
       and c.status = 'ok'
       and c.job_id is not null
       and (p_agent_id is null or c.agent_id = p_agent_id)
  ),
  turnos as (
    select (select count(*) from jobs_de_turno) as turnos,
           coalesce(sum(c.cost_cents), 0) as custo_dos_turnos_cents
      from public.llm_calls c
      join jobs_de_turno t on t.job_id = c.job_id
     where c.organization_id = p_org
       and c.created_at >= p_desde
       and c.created_at <= p_ate
  ),
  agregado as (
    select grouping(dia) as sem_dia,
           grouping(purpose) as sem_purpose,
           dia,
           purpose,
           count(*) as chamadas,
           coalesce(sum(cost_cents), 0) as custo_cents,
           coalesce(sum(input_tokens), 0) as input_tokens,
           coalesce(sum(output_tokens), 0) as output_tokens,
           coalesce(sum(cache_read_tokens), 0) as cache_read_tokens,
           coalesce(sum(cache_write_tokens), 0) as cache_write_tokens,
           coalesce(percentile_disc(0.5) within group (order by latency_ms) filter (where latency_ms > 0), 0) as p50_latency_ms,
           coalesce(percentile_disc(0.95) within group (order by latency_ms) filter (where latency_ms > 0), 0) as p95_latency_ms
      from chamadas
     group by grouping sets ((dia), (purpose), ())
  ),
  inbounds as (
    select (m.created_at at time zone 'UTC')::date as dia, count(*) as n
      from public.messages m
     where m.organization_id = p_org
       and m.direction = 'inbound'
       and m.created_at >= p_desde
       and m.created_at <= p_ate
     group by 1
  ),
  handoffs as (
    select (e.created_at at time zone 'UTC')::date as dia, count(*) as n
      from public.event_log e
     where e.organization_id = p_org
       and e.event_type = 'ai.handoff_triggered'
       and e.created_at >= p_desde
       and e.created_at <= p_ate
     group by 1
  )
  select jsonb_build_object(
    'totais', (select (to_jsonb(a) - 'sem_dia' - 'sem_purpose' - 'dia' - 'purpose') || to_jsonb(tr)
                 from agregado a, turnos tr where a.sem_dia = 1 and a.sem_purpose = 1),
    'dias', coalesce((select jsonb_agg(to_jsonb(a) - 'sem_dia' - 'sem_purpose' - 'purpose' order by a.dia)
                        from agregado a where a.sem_dia = 0), '[]'::jsonb),
    'purposes', coalesce((select jsonb_agg(to_jsonb(a) - 'sem_dia' - 'sem_purpose' - 'dia' order by a.purpose)
                            from agregado a where a.sem_dia = 1 and a.sem_purpose = 0), '[]'::jsonb),
    'inbounds', coalesce((select jsonb_object_agg(i.dia::text, i.n) from inbounds i), '{}'::jsonb),
    'handoffs', coalesce((select jsonb_object_agg(h.dia::text, h.n) from handoffs h), '{}'::jsonb)
  );
$$;

comment on function public.fn_uso_de_ia(uuid, timestamptz, timestamptz, uuid, text) is
  'Uso de IA da organização num período, agregado no banco para a tela Uso de IA (/api/v1/ai/usage): totais, por dia (UTC) e por purpose de llm_calls — custo, tokens, cache, p50/p95 de latência de UMA chamada, turnos do agente (jobs distintos com agent_turn ou followup_turn ok, sem os filtros de agente/purpose sobre o custo do job) e o custo desses turnos, só nos totais — mais inbounds e ai.handoff_triggered por dia. Devolve jsonb para não passar pelo max_rows do PostgREST. security invoker: a RLS isola; p_org é defesa em profundidade. Não é a régua do teto mensal (fn_gasto_de_ia_do_mes).';

revoke execute on function public.fn_uso_de_ia(uuid, timestamptz, timestamptz, uuid, text)
  from public, anon;
grant  execute on function public.fn_uso_de_ia(uuid, timestamptz, timestamptz, uuid, text)
  to authenticated, service_role;
