-- manifest: views pol_vw_warroom_dashboard, pol_vw_radar_territorial, pol_vw_projecao_eleitoral, pol_vw_ranking_cidades, pol_vw_ranking_liderancas, pol_vw_mapa_oportunidades, pol_vw_mapa_prioridade, pol_vw_funil_kpis, pol_vw_call_queue_status, pol_vw_call_supervisor — dashboards e painéis analíticos do War Room 2.0 sobre as 34 tabelas pol_* das Fases 1-3

-- ══════════════════════════════════════════════════════════════════
-- FASE 4 — Views de Dashboards
--
-- Todas as views incluem organization_id para compatibilidade com
-- RLS (o Supabase filtra views pela policy da tabela base).
-- Usa CREATE OR REPLACE VIEW para idempotência.
-- ══════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════
-- 1. pol_vw_warroom_dashboard — KPIs principais do War Room
--
-- Painel central: totais de leads por nível de apoio, temperatura,
-- contadores de eventos, alertas ativos, pesquisas ativas e posts
-- sociais recentes.
-- ══════════════════════════════════════════════════════════════════

create or replace view public.pol_vw_warroom_dashboard as
select
  l.organization_id,

  -- Leads por nível de apoio
  count(*)                                                            as total_leads,
  count(*) filter (where l.support_level = 'voto_certo')              as votos_certos,
  count(*) filter (where l.support_level = 'militante')               as militantes,
  count(*) filter (where l.support_level = 'apoiador')                as apoiadores,
  count(*) filter (where l.support_level = 'simpatizante')            as simpatizantes,
  count(*) filter (where l.support_level = 'novo_cadastro')           as novos_cadastros,

  -- Leads por temperatura
  count(*) filter (where l.temperature = 'quente')                    as leads_quentes,
  count(*) filter (where l.temperature = 'morno')                     as leads_mornos,
  count(*) filter (where l.temperature = 'frio')                      as leads_frios,

  -- Potenciais líderes
  count(*) filter (where l.leader_potential = true)                   as lideres_potenciais,

  -- Eventos (subquery)
  coalesce(ev.total_eventos, 0)                                       as total_eventos,
  coalesce(ev.eventos_proximos, 0)                                    as eventos_proximos,

  -- Alertas ativos (subquery)
  coalesce(al.alertas_ativos, 0)                                      as alertas_ativos,
  coalesce(al.alertas_criticos, 0)                                    as alertas_criticos,

  -- Pesquisas ativas (subquery)
  coalesce(sv.pesquisas_ativas, 0)                                    as pesquisas_ativas,

  -- Perfis sociais monitorados (subquery)
  coalesce(sp.perfis_monitorados, 0)                                  as perfis_monitorados,

  -- Adversários ativos (subquery)
  coalesce(op.adversarios_ativos, 0)                                  as adversarios_ativos,

  -- Fila de ligações pendentes (subquery)
  coalesce(cq.ligacoes_pendentes, 0)                                  as ligacoes_pendentes

from public.pol_leads l

left join lateral (
  select
    count(*)                                                          as total_eventos,
    count(*) filter (where e.event_date >= now()
                       and e.status in ('scheduled', 'confirmed'))    as eventos_proximos
  from public.pol_events e
  where e.organization_id = l.organization_id
) ev on true

left join lateral (
  select
    count(*) filter (where a.status = 'active')                       as alertas_ativos,
    count(*) filter (where a.status = 'active'
                       and a.severity = 'critical')                   as alertas_criticos
  from public.pol_alerts a
  where a.organization_id = l.organization_id
) al on true

left join lateral (
  select count(*) as pesquisas_ativas
  from public.pol_surveys s
  where s.organization_id = l.organization_id
    and s.status = 'active'
) sv on true

left join lateral (
  select count(*) as perfis_monitorados
  from public.pol_social_profiles sp
  where sp.organization_id = l.organization_id
    and sp.active = true
) sp on true

left join lateral (
  select count(*) as adversarios_ativos
  from public.pol_opponents o
  where o.organization_id = l.organization_id
    and o.active = true
) op on true

left join lateral (
  select count(*) as ligacoes_pendentes
  from public.pol_call_queue cq
  where cq.organization_id = l.organization_id
    and cq.call_status in ('pending', 'callback')
) cq on true

group by
  l.organization_id,
  ev.total_eventos, ev.eventos_proximos,
  al.alertas_ativos, al.alertas_criticos,
  sv.pesquisas_ativas,
  sp.perfis_monitorados,
  op.adversarios_ativos,
  cq.ligacoes_pendentes;

comment on view public.pol_vw_warroom_dashboard is
  'Dashboard principal do War Room — KPIs agregados: leads por nível/temperatura, eventos, alertas, pesquisas, perfis sociais, adversários e fila de ligações.';


-- ══════════════════════════════════════════════════════════════════
-- 2. pol_vw_radar_territorial — radar territorial com métricas
--
-- Uma linha por território com a métrica mais recente, contagem
-- de leads e flags ativas.
-- ══════════════════════════════════════════════════════════════════

create or replace view public.pol_vw_radar_territorial as
select
  t.id                    as territory_id,
  t.organization_id,
  t.name,
  t.type,
  t.parent_id,
  t.ibge_code,
  t.state_code,
  t.latitude,
  t.longitude,
  t.population,
  t.electorate,

  -- Contagem de leads por território
  coalesce(lc.total_leads, 0)            as total_leads,
  coalesce(lc.votos_certos, 0)           as votos_certos,
  coalesce(lc.militantes, 0)             as militantes,
  coalesce(lc.apoiadores, 0)             as apoiadores,

  -- Métrica mais recente
  m.period                               as last_metric_period,
  coalesce(m.supporters, 0)              as supporters,
  coalesce(m.militants, 0)               as metric_militants,
  coalesce(m.influence_score, 0)         as influence_score,
  coalesce(m.growth_rate, 0)             as growth_rate,
  coalesce(m.dominance_score, 0)         as dominance_score,
  coalesce(m.strategic_status, 'normal') as strategic_status,

  -- Flags ativas
  coalesce(f.flags_ativas, 0)            as flags_ativas

from public.pol_territories t

left join lateral (
  select
    count(*)                                                       as total_leads,
    count(*) filter (where pl.support_level = 'voto_certo')        as votos_certos,
    count(*) filter (where pl.support_level = 'militante')         as militantes,
    count(*) filter (where pl.support_level = 'apoiador')          as apoiadores
  from public.pol_leads pl
  where pl.territory_id = t.id
    and pl.organization_id = t.organization_id
) lc on true

left join lateral (
  select tm.*
  from public.pol_territory_metrics tm
  where tm.territory_id = t.id
    and tm.organization_id = t.organization_id
  order by tm.period desc
  limit 1
) m on true

left join lateral (
  select count(*) as flags_ativas
  from public.pol_territory_flags tf
  where tf.territory_id = t.id
    and tf.organization_id = t.organization_id
    and tf.resolved_at is null
) f on true;

comment on view public.pol_vw_radar_territorial is
  'Radar territorial — cada território com métricas mais recentes, contagem de leads por nível e flags ativas.';


-- ══════════════════════════════════════════════════════════════════
-- 3. pol_vw_projecao_eleitoral — projeção eleitoral por território
--
-- Cruza dados do TSE (votação histórica) com leads atuais
-- para estimar potencial de voto por território.
-- ══════════════════════════════════════════════════════════════════

create or replace view public.pol_vw_projecao_eleitoral as
select
  t.id                    as territory_id,
  t.organization_id,
  t.name                  as territory_name,
  t.type                  as territory_type,
  t.state_code,
  t.population,
  t.electorate,

  -- Dados TSE mais recentes
  tse.election_year,
  tse.cargo,
  tse.total_voters,
  tse.valid_votes,
  tse.candidate_votes,
  tse.turnout_rate,

  -- Leads atuais neste território
  coalesce(lc.total_leads, 0)          as total_leads,
  coalesce(lc.votos_certos, 0)         as votos_certos,
  coalesce(lc.militantes, 0)           as militantes,

  -- Projeção: votos_certos + militantes como base segura
  coalesce(lc.votos_certos, 0) + coalesce(lc.militantes, 0) as base_segura,

  -- Projeção otimista: base_segura + apoiadores
  coalesce(lc.votos_certos, 0) + coalesce(lc.militantes, 0)
    + coalesce(lc.apoiadores, 0)                             as projecao_otimista,

  -- Taxa de conversão potencial (leads / eleitorado)
  case
    when t.electorate > 0
    then round(
      (coalesce(lc.total_leads, 0)::numeric / t.electorate) * 100, 2
    )
    else 0
  end                                                        as penetracao_pct

from public.pol_territories t

left join lateral (
  select tse2.*
  from public.pol_tse_data tse2
  where tse2.territory_id = t.id
    and tse2.organization_id = t.organization_id
  order by tse2.election_year desc
  limit 1
) tse on true

left join lateral (
  select
    count(*)                                                    as total_leads,
    count(*) filter (where pl.support_level = 'voto_certo')     as votos_certos,
    count(*) filter (where pl.support_level = 'militante')      as militantes,
    count(*) filter (where pl.support_level = 'apoiador')       as apoiadores
  from public.pol_leads pl
  where pl.territory_id = t.id
    and pl.organization_id = t.organization_id
) lc on true;

comment on view public.pol_vw_projecao_eleitoral is
  'Projeção eleitoral — dados TSE históricos cruzados com leads atuais por território para estimativa de base segura e projeção otimista.';


-- ══════════════════════════════════════════════════════════════════
-- 4. pol_vw_ranking_cidades — ranking de cidades por desempenho
--
-- Agrega métricas por territórios do tipo 'cidade', ranqueando
-- por total de leads, penetração e crescimento.
-- ══════════════════════════════════════════════════════════════════

create or replace view public.pol_vw_ranking_cidades as
select
  t.id                    as territory_id,
  t.organization_id,
  t.name                  as cidade,
  t.state_code,
  t.population,
  t.electorate,

  -- Leads
  coalesce(lc.total_leads, 0)          as total_leads,
  coalesce(lc.votos_certos, 0)         as votos_certos,
  coalesce(lc.militantes, 0)           as militantes,
  coalesce(lc.apoiadores, 0)           as apoiadores,
  coalesce(lc.leads_quentes, 0)        as leads_quentes,

  -- Penetração
  case
    when t.electorate > 0
    then round(
      (coalesce(lc.total_leads, 0)::numeric / t.electorate) * 100, 2
    )
    else 0
  end                                  as penetracao_pct,

  -- Métrica mais recente
  coalesce(m.influence_score, 0)       as influence_score,
  coalesce(m.growth_rate, 0)           as growth_rate,
  coalesce(m.dominance_score, 0)       as dominance_score,
  coalesce(m.strategic_status, 'normal') as strategic_status,

  -- Eventos realizados nesta cidade
  coalesce(ev.total_eventos, 0)        as total_eventos

from public.pol_territories t

left join lateral (
  select
    count(*)                                                    as total_leads,
    count(*) filter (where pl.support_level = 'voto_certo')     as votos_certos,
    count(*) filter (where pl.support_level = 'militante')      as militantes,
    count(*) filter (where pl.support_level = 'apoiador')       as apoiadores,
    count(*) filter (where pl.temperature = 'quente')           as leads_quentes
  from public.pol_leads pl
  where pl.territory_id = t.id
    and pl.organization_id = t.organization_id
) lc on true

left join lateral (
  select tm.*
  from public.pol_territory_metrics tm
  where tm.territory_id = t.id
    and tm.organization_id = t.organization_id
  order by tm.period desc
  limit 1
) m on true

left join lateral (
  select count(*) as total_eventos
  from public.pol_events e
  where e.organization_id = t.organization_id
    and e.city = t.name
) ev on true

where t.type = 'cidade';

comment on view public.pol_vw_ranking_cidades is
  'Ranking de cidades — territórios tipo cidade com leads, penetração, métricas de influência/crescimento e eventos.';


-- ══════════════════════════════════════════════════════════════════
-- 5. pol_vw_ranking_liderancas — ranking de líderes e mobilizadores
--
-- Contatos marcados como líder potencial ou que mobilizam outros,
-- ranqueados por número de mobilizados e score político.
-- ══════════════════════════════════════════════════════════════════

create or replace view public.pol_vw_ranking_liderancas as
select
  pl.id                   as lead_id,
  pl.organization_id,
  pl.contact_id,
  c.name                  as contact_name,
  c.phone                 as contact_phone,
  pl.support_level,
  pl.political_score,
  pl.temperature,
  pl.leader_potential,
  pl.community_role,
  t.name                  as territory_name,

  -- Quantidade de leads mobilizados por esta liderança
  coalesce(mob.mobilizados, 0) as mobilizados

from public.pol_leads pl
inner join public.contacts c on c.id = pl.contact_id
left join public.pol_territories t on t.id = pl.territory_id
left join lateral (
  select count(*) as mobilizados
  from public.pol_leads sub
  where sub.mobilizer_id = pl.contact_id
    and sub.organization_id = pl.organization_id
) mob on true

where pl.leader_potential = true
   or pl.community_role is not null;

comment on view public.pol_vw_ranking_liderancas is
  'Ranking de lideranças — contatos com potencial de liderança ou papel comunitário, com contagem de mobilizados e score político.';


-- ══════════════════════════════════════════════════════════════════
-- 6. pol_vw_mapa_oportunidades — mapa de oportunidades territoriais
--
-- Territórios com alta proporção de novos cadastros / simpatizantes
-- (oportunidade de conversão) e baixa penetração.
-- ══════════════════════════════════════════════════════════════════

create or replace view public.pol_vw_mapa_oportunidades as
select
  t.id                    as territory_id,
  t.organization_id,
  t.name,
  t.type,
  t.state_code,
  t.latitude,
  t.longitude,
  t.population,
  t.electorate,

  -- Leads por nível
  coalesce(lc.total_leads, 0)          as total_leads,
  coalesce(lc.novos_cadastros, 0)      as novos_cadastros,
  coalesce(lc.simpatizantes, 0)        as simpatizantes,
  coalesce(lc.apoiadores, 0)           as apoiadores,

  -- Potencial de conversão: simpatizantes + novos que podem subir no funil
  coalesce(lc.novos_cadastros, 0) + coalesce(lc.simpatizantes, 0) as potencial_conversao,

  -- Penetração
  case
    when t.electorate > 0
    then round(
      (coalesce(lc.total_leads, 0)::numeric / t.electorate) * 100, 2
    )
    else 0
  end                                  as penetracao_pct,

  -- Classificação: alta oportunidade se baixa penetração + muitos novos/simpatizantes
  case
    when t.electorate > 0
     and (coalesce(lc.total_leads, 0)::numeric / t.electorate) < 0.05
     and (coalesce(lc.novos_cadastros, 0) + coalesce(lc.simpatizantes, 0)) > 0
    then 'alta_oportunidade'
    when t.electorate > 0
     and (coalesce(lc.total_leads, 0)::numeric / t.electorate) < 0.15
    then 'oportunidade'
    else 'consolidado'
  end                                  as classificacao

from public.pol_territories t

left join lateral (
  select
    count(*)                                                         as total_leads,
    count(*) filter (where pl.support_level = 'novo_cadastro')       as novos_cadastros,
    count(*) filter (where pl.support_level = 'simpatizante')        as simpatizantes,
    count(*) filter (where pl.support_level = 'apoiador')            as apoiadores
  from public.pol_leads pl
  where pl.territory_id = t.id
    and pl.organization_id = t.organization_id
) lc on true

where t.latitude is not null
  and t.longitude is not null;

comment on view public.pol_vw_mapa_oportunidades is
  'Mapa de oportunidades — territórios geo-localizados com potencial de conversão e classificação de oportunidade baseada em penetração.';


-- ══════════════════════════════════════════════════════════════════
-- 7. pol_vw_mapa_prioridade — mapa de prioridade territorial
--
-- Combina flags ativas, alertas do território e status estratégico
-- para gerar um score de prioridade.
-- ══════════════════════════════════════════════════════════════════

create or replace view public.pol_vw_mapa_prioridade as
select
  t.id                    as territory_id,
  t.organization_id,
  t.name,
  t.type,
  t.state_code,
  t.latitude,
  t.longitude,
  t.electorate,

  -- Status estratégico mais recente
  coalesce(m.strategic_status, 'normal') as strategic_status,
  coalesce(m.influence_score, 0)         as influence_score,

  -- Flags ativas
  coalesce(f.flags_ativas, 0)            as flags_ativas,
  coalesce(f.flags_criticas, 0)          as flags_criticas,

  -- Score de prioridade composto
  -- (flags_criticas * 10 + flags_ativas * 3 + bônus por status crítico/prioritário)
  (
    coalesce(f.flags_criticas, 0) * 10
    + coalesce(f.flags_ativas, 0) * 3
    + case coalesce(m.strategic_status, 'normal')
        when 'critico' then 20
        when 'prioritario' then 10
        when 'oportunidade' then 5
        else 0
      end
  )                                      as priority_score

from public.pol_territories t

left join lateral (
  select tm.*
  from public.pol_territory_metrics tm
  where tm.territory_id = t.id
    and tm.organization_id = t.organization_id
  order by tm.period desc
  limit 1
) m on true

left join lateral (
  select
    count(*)                                              as flags_ativas,
    count(*) filter (where tf.severity = 'critical')      as flags_criticas
  from public.pol_territory_flags tf
  where tf.territory_id = t.id
    and tf.organization_id = t.organization_id
    and tf.resolved_at is null
) f on true

where t.latitude is not null
  and t.longitude is not null;

comment on view public.pol_vw_mapa_prioridade is
  'Mapa de prioridade — territórios geo-localizados com score de prioridade composto de flags, status estratégico e severidade.';


-- ══════════════════════════════════════════════════════════════════
-- 8. pol_vw_funil_kpis — KPIs do funil político e invisível
--
-- Resumo do funil político (support_level) e do funil invisível
-- (funnel_stage) por organização.
-- ══════════════════════════════════════════════════════════════════

create or replace view public.pol_vw_funil_kpis as
select
  pl.organization_id,

  -- Funil político (support_level)
  count(*)                                                          as funil_total,
  count(*) filter (where pl.support_level = 'novo_cadastro')        as funil_novo_cadastro,
  count(*) filter (where pl.support_level = 'simpatizante')         as funil_simpatizante,
  count(*) filter (where pl.support_level = 'apoiador')             as funil_apoiador,
  count(*) filter (where pl.support_level = 'militante')            as funil_militante,
  count(*) filter (where pl.support_level = 'voto_certo')           as funil_voto_certo,

  -- Taxas de conversão entre etapas
  case
    when count(*) > 0
    then round(
      count(*) filter (where pl.support_level != 'novo_cadastro')::numeric
      / count(*) * 100, 2
    )
    else 0
  end                                                               as taxa_ativacao_pct,

  case
    when count(*) filter (where pl.support_level in ('apoiador', 'militante', 'voto_certo')) > 0
      or count(*) filter (where pl.support_level = 'simpatizante') > 0
    then round(
      count(*) filter (where pl.support_level in ('apoiador', 'militante', 'voto_certo'))::numeric
      / nullif(count(*) filter (where pl.support_level in ('simpatizante', 'apoiador', 'militante', 'voto_certo')), 0) * 100, 2
    )
    else 0
  end                                                               as taxa_conversao_pct,

  -- Funil invisível (subquery)
  coalesce(fi.total_invisivel, 0)                                   as invisivel_total,
  coalesce(fi.awareness, 0)                                         as invisivel_awareness,
  coalesce(fi.interest, 0)                                          as invisivel_interest,
  coalesce(fi.consideration, 0)                                     as invisivel_consideration,
  coalesce(fi.intent, 0)                                            as invisivel_intent,
  coalesce(fi.evaluation, 0)                                        as invisivel_evaluation,
  coalesce(fi.conversion, 0)                                        as invisivel_conversion

from public.pol_leads pl

left join lateral (
  select
    count(*)                                                         as total_invisivel,
    count(*) filter (where inf.funnel_stage = 'awareness')           as awareness,
    count(*) filter (where inf.funnel_stage = 'interest')            as interest,
    count(*) filter (where inf.funnel_stage = 'consideration')       as consideration,
    count(*) filter (where inf.funnel_stage = 'intent')              as intent,
    count(*) filter (where inf.funnel_stage = 'evaluation')          as evaluation,
    count(*) filter (where inf.funnel_stage = 'conversion')          as conversion
  from public.pol_invisible_funnel inf
  where inf.organization_id = pl.organization_id
) fi on true

group by
  pl.organization_id,
  fi.total_invisivel, fi.awareness, fi.interest,
  fi.consideration, fi.intent, fi.evaluation, fi.conversion;

comment on view public.pol_vw_funil_kpis is
  'KPIs do funil — distribuição de leads por nível de apoio (funil político) e por stage (funil invisível) com taxas de ativação e conversão.';


-- ══════════════════════════════════════════════════════════════════
-- 9. pol_vw_call_queue_status — status consolidado da fila de ligações
--
-- Resumo por organização: pendentes, em andamento, completadas,
-- resultados políticos e taxa de sucesso.
-- ══════════════════════════════════════════════════════════════════

create or replace view public.pol_vw_call_queue_status as
select
  cq.organization_id,

  -- Contadores por status
  count(*)                                                              as total_chamadas,
  count(*) filter (where cq.call_status = 'pending')                    as pendentes,
  count(*) filter (where cq.call_status = 'locked')                     as em_lock,
  count(*) filter (where cq.call_status = 'calling')                    as em_chamada,
  count(*) filter (where cq.call_status = 'completed')                  as completadas,
  count(*) filter (where cq.call_status = 'no_answer')                  as sem_resposta,
  count(*) filter (where cq.call_status = 'busy')                       as ocupado,
  count(*) filter (where cq.call_status = 'callback')                   as retorno_agendado,
  count(*) filter (where cq.call_status = 'cancelled')                  as canceladas,

  -- Resultados políticos
  count(*) filter (where cq.political_result = 'apoio_confirmado')      as apoio_confirmado,
  count(*) filter (where cq.political_result = 'indeciso')              as indeciso,
  count(*) filter (where cq.political_result = 'recusa')                as recusa,
  count(*) filter (where cq.political_result = 'mudou_apoio')           as mudou_apoio,
  count(*) filter (where cq.political_result = 'agendou_visita')        as agendou_visita,

  -- Média de tentativas
  round(avg(cq.attempt_count)::numeric, 1)                              as media_tentativas,

  -- Taxa de sucesso (apoio_confirmado / completadas)
  case
    when count(*) filter (where cq.call_status = 'completed') > 0
    then round(
      count(*) filter (where cq.political_result = 'apoio_confirmado')::numeric
      / count(*) filter (where cq.call_status = 'completed') * 100, 2
    )
    else 0
  end                                                                   as taxa_sucesso_pct

from public.pol_call_queue cq
group by cq.organization_id;

comment on view public.pol_vw_call_queue_status is
  'Status da fila de ligações — contadores por status e resultado político, média de tentativas e taxa de sucesso.';


-- ══════════════════════════════════════════════════════════════════
-- 10. pol_vw_call_supervisor — visão do supervisor de ligações
--
-- Uma linha por operador com métricas de desempenho individual:
-- ligações completadas, taxa de sucesso, resultado político.
-- ══════════════════════════════════════════════════════════════════

create or replace view public.pol_vw_call_supervisor as
select
  cq.organization_id,
  cq.assigned_to                                                       as operator_id,

  -- Contadores
  count(*)                                                              as total_atribuidas,
  count(*) filter (where cq.call_status = 'completed')                  as completadas,
  count(*) filter (where cq.call_status in ('pending', 'callback'))     as pendentes,
  count(*) filter (where cq.call_status = 'no_answer')                  as sem_resposta,

  -- Resultados
  count(*) filter (where cq.political_result = 'apoio_confirmado')      as apoio_confirmado,
  count(*) filter (where cq.political_result = 'indeciso')              as indeciso,
  count(*) filter (where cq.political_result = 'recusa')                as recusa,

  -- Taxa de conclusão
  case
    when count(*) > 0
    then round(
      count(*) filter (where cq.call_status = 'completed')::numeric
      / count(*) * 100, 2
    )
    else 0
  end                                                                   as taxa_conclusao_pct,

  -- Taxa de sucesso
  case
    when count(*) filter (where cq.call_status = 'completed') > 0
    then round(
      count(*) filter (where cq.political_result = 'apoio_confirmado')::numeric
      / count(*) filter (where cq.call_status = 'completed') * 100, 2
    )
    else 0
  end                                                                   as taxa_sucesso_pct,

  -- Média de tentativas
  round(avg(cq.attempt_count)::numeric, 1)                              as media_tentativas

from public.pol_call_queue cq
where cq.assigned_to is not null
group by cq.organization_id, cq.assigned_to;

comment on view public.pol_vw_call_supervisor is
  'Visão do supervisor — métricas por operador: ligações atribuídas, completadas, resultados políticos e taxas de conclusão/sucesso.';
