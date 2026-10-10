-- 0116 — fn_atrito_metrics: a medida do PROPÓSITO (spec 17, doutrina cap. 3).
--
-- O sistema mede hoje won/lost/conversas/1ª-resposta — atividade e conversão.
-- Nenhum número para "menor atrito para os dois lados", que é o propósito
-- declarado. Consequência concreta: um agente que insiste seis vezes converte
-- mais e queima relacionamento, e nos painéis atuais aparece como o melhor da
-- org. `agent_cases.followup_attempts` já conta a insistência e nenhuma tela lê.
--
-- SECURITY INVOKER de propósito (igual fn_attendant_metrics/0037): o escopo é a
-- própria RLS das tabelas lidas. Todas as seis têm tenant_isolation por
-- fn_user_org_ids() — agent_cases/agent_case_events/before_send_traces pelo loop
-- dinâmico do baseline, contacts/messages/crm_lead_activities por policy
-- estática. Rodar como definer aqui daria org-wide a quem a RLS restringe.
--
-- Denominador = agent_cases FECHADOS na janela. É o embrião da unidade de
-- demanda (doutrina cap. 5): tem opened_at, closed_at, status com desfecho e
-- vínculo com conversa e lead. O escopo é PARCIAL de propósito — cobre demandas
-- que passaram por caso, não o total — e a tela rotula isso. Índice com escopo
-- declarado é honesto; índice que finge cobrir tudo destrói a comparação quando
-- o escopo mudar (regra 4 do cap. 3.4: declare a régua junto do número).

-- Índices dedicados — todos os predicados da função, nenhum seq scan por janela.
create index if not exists idx_agent_cases_org_closed
  on public.agent_cases (organization_id, closed_at)
  where closed_at is not null;

create index if not exists idx_messages_org_direction_sent
  on public.messages (organization_id, direction, sent_at);

create index if not exists idx_contacts_org_blocked_at
  on public.contacts (organization_id, blocked_at)
  where blocked_at is not null;

create index if not exists idx_crm_lead_activities_org_type_performed
  on public.crm_lead_activities (organization_id, type, performed_at);

create index if not exists idx_before_send_traces_org_created
  on public.before_send_traces (organization_id, created_at);

create or replace function public.fn_atrito_metrics(
  p_org uuid,
  p_from timestamptz,
  p_to timestamptz
) returns jsonb
language sql stable
set search_path = public
as $$
  with
  -- Denominador: uma linha por demanda encerrada na janela.
  demandas as (
    select c.id, c.conversation_id, c.opened_at, c.closed_at, c.status,
           c.followup_attempts
      from public.agent_cases c
     where c.organization_id = p_org
       and c.closed_at is not null
       and c.closed_at >= p_from
       and c.closed_at <  p_to
  ),
  -- Turnos: mensagens da conversa DENTRO da vida da demanda (não a conversa
  -- inteira — a mesma conversa pode carregar mais de uma demanda ao longo do
  -- tempo, e contar tudo inflaria demandas curtas de conversas antigas).
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
  -- Toque humano por demanda: quantos e quando o primeiro.
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
  -- Espera na fila humana: abertura da demanda até o primeiro toque humano.
  espera as (
    select extract(epoch from (h.primeiro_toque - d.opened_at)) as segundos
      from demandas d
      join humano h on h.case_id = d.id
     where h.primeiro_toque > d.opened_at
  ),
  -- Retrabalho: a demanda precisou subir de nível depois de já ter dono.
  retrabalho as (
    select count(distinct e.case_id) as n
      from public.agent_case_events e
      join demandas d on d.id = e.case_id
     where e.organization_id = p_org
       and (e.kind = 'escalated' or e.human_action = 'escalate')
  ),
  -- Envios por origem. `external_device` = humano respondeu pelo CELULAR, fora
  -- do sistema: é a métrica de atrito da EMPRESA mais honesta que existe —
  -- conta quantas vezes o operador contornou a própria ferramenta.
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
  -- Vetos: quanto o sistema precisou ser contido de si mesmo. `execucoes` é o
  -- denominador honesto (runs que chegaram a produzir trace), não o total de runs.
  vetos as (
    select count(*) filter (where t.vetoed_gate is not null) as vetados,
           count(distinct t.job_id)                          as execucoes
      from public.before_send_traces t
     where t.organization_id = p_org
       and t.created_at >= p_from
       and t.created_at <  p_to
  ),
  -- Atrito máximo: a pessoa pediu para sair.
  descadastros as (
    select count(*) as n
      from public.contacts c
     where c.organization_id = p_org
       and c.blocked_at is not null
       and c.blocked_at >= p_from
       and c.blocked_at <  p_to
  ),
  -- Confiança perdida na automação.
  pedidos_humano as (
    select count(*) as n
      from public.crm_lead_activities a
     where a.organization_id = p_org
       and a.type = 'handoff_triggered'
       and a.performed_at >= p_from
       and a.performed_at <  p_to
  ),
  -- A eficiência que o dano acompanha (regra 3.3: nunca publicada sozinha).
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
      'ate', p_to
    ),
    'cliente', jsonb_build_object(
      'turnos_p50',        (select percentile_cont(0.5) within group (order by n) from turnos),
      'turnos_p90',        (select percentile_cont(0.9) within group (order by n) from turnos),
      'insistencia_media', (select avg(followup_attempts)::float8 from demandas),
      'insistencia_max',   (select max(followup_attempts) from demandas),
      'pedidos_de_humano', (select n from pedidos_humano),
      'descadastros',      (select n from descadastros)
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

-- Função nova em public nasce EXPOSTA — as DUAS origens de EXECUTE (grant a
-- anon do ALTER DEFAULT PRIVILEGES do baseline, e grant a PUBLIC que o Postgres
-- dá ao criar). Tratar só uma deixa a função alcançável pela anon key.
revoke all     on function public.fn_atrito_metrics(uuid, timestamptz, timestamptz) from public;
revoke execute on function public.fn_atrito_metrics(uuid, timestamptz, timestamptz) from anon;
grant  execute on function public.fn_atrito_metrics(uuid, timestamptz, timestamptz)
  to authenticated, service_role;
