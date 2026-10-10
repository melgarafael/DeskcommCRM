-- 0118 — Índice de Atrito, Fase 3: repetição da mesma pergunta + espera não
-- comunicada (spec 17 §5.1 e §3.4).
--
-- ## Por que SQL puro, e não embedding
--
-- A spec propunha comparação semântica com a infra de embedding existente.
-- Medido antes de decidir, e as duas medições mudaram o desenho:
--
--   1. `lib/ai/embed.ts` depende de `AI_GATEWAY_API_KEY` ou de credencial
--      OpenAI — env OPCIONAL. Numa instalação self-host sem essa chave, a
--      métrica ficaria em ZERO em silêncio, e zero aqui leria como "o cliente
--      nunca precisou repetir". É o zero lisonjeiro na sua pior forma: a
--      ausência de instrumento vestida de boa notícia.
--   2. `supabase/baseline.sql` cria APENAS `pgcrypto`. `pg_trgm` existe no
--      Supabase local mas NÃO é garantida em quem aplica só o baseline — que é
--      exatamente o que o kit self-host faz.
--
-- Portanto: Jaccard de tokens em SQL nativo. Roda em qualquer Postgres, sem
-- extensão, sem chave, sem custo por mensagem. É a mesma técnica que o gate de
-- spinning (F2-12) já usa neste repo para detectar template quase-idêntico —
-- não é invenção nova, é a ferramenta que a casa já confia.
--
-- ## Calibração do limiar — medida, não chutada
--
-- Bateria de 15 pares reais em pt-br, em três classes: REPERGUNTA (a pessoa
-- pergunta de novo), MESMO_TEMA (pergunta DIFERENTE sobre o mesmo assunto) e
-- NOVA (assunto sem relação). O resultado:
--
--   limiar 0.5 → 6/7 reperguntas | 3 FALSOS POSITIVOS
--   limiar 0.6 → 5/7 reperguntas | 2 FALSOS POSITIVOS
--   limiar 0.7 → 3/7 reperguntas | 0 falsos positivos   ← escolhido
--   limiar 0.8 → 2/7 reperguntas | 0 falsos positivos
--   limiar 0.9 → 0/7 reperguntas | 0 falsos positivos
--
-- As faixas de REPERGUNTA (0.33–0.80) e MESMO_TEMA (0.17–0.67) SE SOBREPÕEM:
-- "horário aos sábados" × "horário aos domingos" dá 0.67, mais que várias
-- reperguntas legítimas. Não existe limiar que separe as duas classes com
-- Jaccard puro — e essa é a limitação honesta desta camada.
--
-- 0.7 foi escolhido porque é onde o falso positivo zera. A assimetria de custo
-- justifica: um falso positivo levaria alguém a "consertar" um agente que está
-- certo; um falso negativo apenas subconta. Portanto o número é um **PISO** —
-- reperguntas quase literais — e a TELA o rotula como piso, nunca como total.
--
-- Refinamento semântico fica DECLARADO como dívida da Fase 4: reformulação com
-- outro vocabulário ("qual o prazo" → "quanto tempo demora") mede 0.00 aqui e
-- escapa. Quando houver embedding disponível sem env opcional, esta camada vira
-- o filtro barato da frente e o vetor decide o resto.

/**
 * Jaccard de tokens entre dois textos. Tokens com 3+ caracteres (artigos e
 * preposições curtas só somam ruído), sem acento-folding: reformulação real
 * varia palavra, não acento.
 */
create or replace function public.fn_atrito_jaccard(a text, b text)
returns float8
language sql
immutable
set search_path = public
as $$
  with
  ta as (
    select distinct token from unnest(
      string_to_array(lower(regexp_replace(coalesce(a, ''), '[^[:alnum:][:space:]]', ' ', 'g')), ' ')
    ) as token
    where length(token) >= 3
  ),
  tb as (
    select distinct token from unnest(
      string_to_array(lower(regexp_replace(coalesce(b, ''), '[^[:alnum:][:space:]]', ' ', 'g')), ' ')
    ) as token
    where length(token) >= 3
  )
  select case
    when (select count(*) from ta) = 0 or (select count(*) from tb) = 0 then 0::float8
    else (select count(*) from (select token from ta intersect select token from tb) i)::float8
       / nullif((select count(*) from (select token from ta union select token from tb) u), 0)::float8
  end;
$$;

revoke all     on function public.fn_atrito_jaccard(text, text) from public;
revoke execute on function public.fn_atrito_jaccard(text, text) from anon;
grant  execute on function public.fn_atrito_jaccard(text, text) to authenticated, service_role;

-- Assinatura muda de 4 para 6 parâmetros — drop antes do create, senão vira
-- overload e a versão de 4 args responde para sempre, em silêncio.
drop function if exists public.fn_atrito_metrics(uuid, timestamptz, timestamptz, int);

create or replace function public.fn_atrito_metrics(
  p_org uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_abandono_horas int default 72,
  -- Limiar CALIBRADO, não chutado (ver bloco "calibração" no cabeçalho): 0.7.
  p_repeticao_min float8 default 0.7,
  -- Acima disto, a espera do cliente conta como não comunicada.
  p_espera_horas int default 4
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
    select e.case_id, count(*) as intervencoes, min(e.created_at) as primeiro_toque
      from public.agent_case_events e
      join demandas d on d.id = e.case_id
     where e.organization_id = p_org and e.actor_kind = 'human'
     group by e.case_id
  ),
  espera_fila as (
    select extract(epoch from (h.primeiro_toque - d.opened_at)) as segundos
      from demandas d join humano h on h.case_id = d.id
     where h.primeiro_toque > d.opened_at
  ),
  retrabalho as (
    select count(distinct e.case_id) as n
      from public.agent_case_events e
      join demandas d on d.id = e.case_id
     where e.organization_id = p_org
       and (e.kind = 'escalated' or e.human_action = 'escalate')
  ),
  abandono as (
    select
      count(*) filter (
        where cv.last_outbound_at >= p_from and cv.last_outbound_at < p_to
          and (cv.last_inbound_at is null or cv.last_outbound_at > cv.last_inbound_at)
          and cv.last_outbound_at < now() - make_interval(hours => p_abandono_horas)
          and cv.status not in ('resolved', 'closed')
      ) as abandonadas,
      count(*) filter (
        where cv.last_outbound_at >= p_from and cv.last_outbound_at < p_to
      ) as com_fala_nossa
      from public.conversations cv
     where cv.organization_id = p_org and cv.last_outbound_at is not null
  ),
  -- FASE 3 — cada mensagem do cliente ao lado da ANTERIOR dele na mesma
  -- conversa. `lag` mantém isto O(n): comparar todas com todas seria O(n²) e o
  -- painel morreria numa org com volume real.
  inbounds as (
    select
      m.conversation_id,
      m.sent_at,
      m.body,
      lag(m.body)    over (partition by m.conversation_id order by m.sent_at) as body_anterior,
      lag(m.sent_at) over (partition by m.conversation_id order by m.sent_at) as sent_at_anterior
      from public.messages m
     where m.organization_id = p_org
       and m.direction = 'inbound'
       and m.body is not null
       and m.sent_at >= p_from
       and m.sent_at <  p_to
  ),
  repeticao as (
    select
      count(*) filter (
        where i.body_anterior is not null
          -- Só conta como REPERGUNTA se nós respondemos no meio. Sem esta
          -- condição, as três mensagens seguidas que a pessoa manda de uma vez
          -- (que são complementares, não repetidas) inflariam o número.
          and exists (
            select 1 from public.messages o
             where o.organization_id = p_org
               and o.conversation_id = i.conversation_id
               and o.direction = 'outbound'
               and o.sent_at > i.sent_at_anterior
               and o.sent_at < i.sent_at
          )
          and public.fn_atrito_jaccard(i.body, i.body_anterior) >= p_repeticao_min
      ) as repetidas,
      -- Denominador: perguntas que TIVERAM resposta nossa antes — as únicas em
      -- que reperguntar é possível.
      count(*) filter (
        where i.body_anterior is not null
          and exists (
            select 1 from public.messages o
             where o.organization_id = p_org
               and o.conversation_id = i.conversation_id
               and o.direction = 'outbound'
               and o.sent_at > i.sent_at_anterior
               and o.sent_at < i.sent_at
          )
      ) as com_resposta_no_meio
      from inbounds i
  ),
  -- ESPERA NÃO COMUNICADA: a pessoa falou e ficou sem NENHUMA palavra nossa por
  -- mais que a régua. Não depende de prazo prometido (que o sistema ainda não
  -- conhece — cap. 6.6) e mede o que dói: o silêncio, não o atraso.
  espera_calada as (
    select
      count(*) filter (where prox.espera_s > p_espera_horas * 3600) as caladas,
      count(*)                                                       as com_resposta,
      percentile_cont(0.9) within group (order by prox.espera_s)     as p90_s
      from (
        select extract(epoch from (
                 (select min(o.sent_at) from public.messages o
                   where o.organization_id = p_org
                     and o.conversation_id = m.conversation_id
                     and o.direction = 'outbound'
                     and o.sent_at > m.sent_at)
                 - m.sent_at)) as espera_s
          from public.messages m
         where m.organization_id = p_org
           and m.direction = 'inbound'
           and m.sent_at >= p_from
           and m.sent_at <  p_to
      ) prox
     where prox.espera_s is not null
  ),
  envios as (
    select
      count(*) filter (where m.sent_via = 'ai')              as por_ia,
      count(*) filter (where m.sent_via = 'user')            as por_humano_no_sistema,
      count(*) filter (where m.sent_via = 'external_device') as por_humano_fora
      from public.messages m
     where m.organization_id = p_org and m.direction = 'outbound'
       and m.sent_at >= p_from and m.sent_at < p_to
  ),
  vetos as (
    select count(*) filter (where t.vetoed_gate is not null) as vetados,
           count(distinct t.job_id)                          as execucoes
      from public.before_send_traces t
     where t.organization_id = p_org
       and t.created_at >= p_from and t.created_at < p_to
  ),
  descadastros as (
    select count(*) as n from public.contacts c
     where c.organization_id = p_org and c.blocked_at is not null
       and c.blocked_at >= p_from and c.blocked_at < p_to
  ),
  pedidos_humano as (
    select count(*) as n from public.crm_lead_activities a
     where a.organization_id = p_org and a.type = 'handoff_triggered'
       and a.performed_at >= p_from and a.performed_at < p_to
  ),
  eficiencia as (
    select count(*) filter (where status = 'won')  as ganhos,
           count(*) filter (where status = 'lost') as perdidos
      from public.crm_leads
     where organization_id = p_org and status in ('won', 'lost')
       and closed_at >= p_from and closed_at < p_to
  )
  select jsonb_build_object(
    'escopo', jsonb_build_object(
      'demandas', (select count(*) from demandas),
      'de',  p_from,
      'ate', p_to,
      'abandono_horas',  p_abandono_horas,
      'repeticao_min',   p_repeticao_min,
      'espera_horas',    p_espera_horas
    ),
    'cliente', jsonb_build_object(
      'turnos_p50',        (select percentile_cont(0.5) within group (order by n) from turnos),
      'turnos_p90',        (select percentile_cont(0.9) within group (order by n) from turnos),
      'insistencia_media', (select avg(followup_attempts)::float8 from demandas),
      'insistencia_max',   (select max(followup_attempts) from demandas),
      'pedidos_de_humano', (select n from pedidos_humano),
      'descadastros',      (select n from descadastros),
      'abandonos',         (select abandonadas   from abandono),
      'conversas_com_fala_nossa', (select com_fala_nossa from abandono),
      'reperguntas',              (select repetidas            from repeticao),
      'perguntas_com_resposta',   (select com_resposta_no_meio from repeticao),
      'esperas_caladas',          (select caladas      from espera_calada),
      'esperas_medidas',          (select com_resposta from espera_calada),
      'espera_resposta_p90_s',    (select p90_s        from espera_calada)
    ),
    'empresa', jsonb_build_object(
      'intervencoes_por_demanda', (select avg(coalesce(h.intervencoes, 0))::float8
                                     from demandas d left join humano h on h.case_id = d.id),
      'espera_humana_p50_s',      (select percentile_cont(0.5) within group (order by segundos) from espera_fila),
      'espera_humana_p90_s',      (select percentile_cont(0.9) within group (order by segundos) from espera_fila),
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

revoke all     on function public.fn_atrito_metrics(uuid, timestamptz, timestamptz, int, float8, int) from public;
revoke execute on function public.fn_atrito_metrics(uuid, timestamptz, timestamptz, int, float8, int) from anon;
grant  execute on function public.fn_atrito_metrics(uuid, timestamptz, timestamptz, int, float8, int)
  to authenticated, service_role;
