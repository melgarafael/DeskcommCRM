-- manifest: **A taxa de cache da tela Uso de IA conta só as chamadas ELEGÍVEIS a cache (#4362, segunda porta do aviso consertado no #4383).** `fn_uso_de_ia` devolvia só os totais de todas as `llm_calls`, então a taxa dividia o cache lido pelos tokens de entrada de chamadas que o provedor NUNCA guarda (entrada abaixo de 1.024 tokens: classificadores, conferência de campo, extrações curtas) — elas entravam no denominador sem chance de entrar no numerador. A função passa a devolver também `chamadas_cacheaveis`, `input_tokens_cacheaveis` e `cache_read_tokens_cacheaveis` (filtro `input_tokens >= 1024`), e a tela divide por eles; os totais de custo, tokens e latência não mudam de definição. O corte é o mesmo do aviso, escrito uma vez em `lib/ai/cache-de-prompt.ts`. Gate: `tests/unit/uso-de-ia-tela-honesta.test.ts`.
--
-- 9365 — a taxa de cache da tela "Uso de IA" só conta as chamadas que podem cachear.
--
-- A tela mostrava `cache_read / input` somando TODAS as `llm_calls` do período.
-- Chamada com menos de 1.024 tokens de ENTRADA nunca vai para cache (é o caso dos
-- classificadores, da conferência de campo e das extrações curtas), então ela
-- entrava no denominador sem chance de entrar no numerador: o mesmo defeito que
-- afundava o aviso "cache hit de prompt abaixo do alvo" (#4362, consertado no aviso
-- pelo #4383) continuava de pé na tela, puxando o número do período inteiro para
-- baixo com chamadas que não dizem nada sobre o prefixo do prompt.
--
-- Esta migration acrescenta ao agregado três contagens do recorte CACHEÁVEL:
--   chamadas_cacheaveis, input_tokens_cacheaveis, cache_read_tokens_cacheaveis.
-- Os totais de sempre (`chamadas`, `input_tokens`, `cache_read_tokens`) continuam
-- sendo de todas as chamadas — custo e volume não mudam de definição. Quem monta a
-- taxa (lib/ai/usage/aggregate.ts) passa a dividir o cache lido pelos tokens de
-- entrada SÓ das cacheáveis, com o mesmo corte do aviso
-- (lib/ai/cache-de-prompt.ts, MIN_TOKENS_DE_ENTRADA_PARA_CACHE = 1024).
--
-- O resto do corpo é o da 9097 (que contava o follow-up como turno), inteiro: só a
-- CTE `agregado` ganha as três colunas, e o jsonb as carrega sozinho porque monta
-- cada bucket com `to_jsonb(a)`.
--
-- Se um provedor mudar o piso do cache, o número muda em DOIS lugares — aqui e na
-- régua em TypeScript — e tests/unit/uso-de-ia-tela-honesta.test.ts reprova a
-- divergência lendo este arquivo.
--
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
           -- A régua do cache elegível (#4362). O mesmo corte da razão do run e
           -- do aviso (`lib/ai/cache-de-prompt.ts`, MIN_TOKENS_DE_ENTRADA_PARA_CACHE):
           -- o provedor não guarda prefixo abaixo de 1.024 tokens de entrada, então
           -- essas chamadas não podem entrar no denominador da taxa.
           count(*) filter (where input_tokens >= 1024) as chamadas_cacheaveis,
           coalesce(sum(input_tokens) filter (where input_tokens >= 1024), 0) as input_tokens_cacheaveis,
           coalesce(sum(cache_read_tokens) filter (where input_tokens >= 1024), 0) as cache_read_tokens_cacheaveis,
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
  'Uso de IA da organização num período, agregado no banco para a tela Uso de IA (/api/v1/ai/usage): totais, por dia (UTC) e por purpose de llm_calls — custo, tokens, cache (com o recorte CACHEÁVEL: chamadas_cacheaveis, input_tokens_cacheaveis e cache_read_tokens_cacheaveis, entrada >= 1.024 tokens — a régua do #4362, única com lib/ai/cache-de-prompt.ts), p50/p95 de latência de UMA chamada, turnos do agente (jobs distintos com agent_turn ou followup_turn ok, sem os filtros de agente/purpose sobre o custo do job) e o custo desses turnos, só nos totais — mais inbounds e ai.handoff_triggered por dia. Devolve jsonb para não passar pelo max_rows do PostgREST. security invoker: a RLS isola; p_org é defesa em profundidade. Não é a régua do teto mensal (fn_gasto_de_ia_do_mes).';

revoke execute on function public.fn_uso_de_ia(uuid, timestamptz, timestamptz, uuid, text)
  from public, anon;
grant  execute on function public.fn_uso_de_ia(uuid, timestamptz, timestamptz, uuid, text)
  to authenticated, service_role;
