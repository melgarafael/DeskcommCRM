# Consultas prontas — agregadas, sem dado pessoal, com a régua declarada

Parâmetros: `:org` (uuid da organização), `:de` e `:ate` (timestamptz; janela `[de, ate)`).
Rode com `psql "$URL" -v org="'…'" -v de="'2026-08-01'" -v ate="'2026-09-01'"` trocando `:org`
por `:'org'` etc., ou substitua no texto. Colunas conferidas no `supabase/baseline.sql` da
v1.17.0. Toda consulta filtra `organization_id` porque a string do app enxerga todas as
organizações.

## Panorama

**P1 — Quem fala e quando: mensagens recebidas por dia da semana × hora (fuso da organização)**
```sql
select extract(isodow from (m.sent_at at time zone o.timezone))::int as dow,
       extract(hour   from (m.sent_at at time zone o.timezone))::int as hora,
       count(*) as recebidas, count(distinct m.conversation_id) as conversas
  from public.messages m
  join public.conversations c on c.id = m.conversation_id and c.organization_id = m.organization_id
  join public.organizations o on o.id = m.organization_id
 where m.organization_id = :org and m.direction = 'inbound' and c.is_group = false
   and m.sent_at >= :de and m.sent_at < :ate
 group by 1,2 order by 1,2;
```

**P2 — Quem responde: envios por semana e por origem (IA, pessoa, celular, automação)**
```sql
select date_trunc('week', m.sent_at at time zone o.timezone)::date as semana,
       m.sent_via, count(*) as envios, count(distinct m.conversation_id) as conversas,
       count(*) filter (where m.status = 'failed') as falhas
  from public.messages m join public.organizations o on o.id = m.organization_id
 where m.organization_id = :org and m.direction = 'outbound'
   and m.sent_at >= :de and m.sent_at < :ate
 group by 1,2 order by 1,2;
```

**P3 — Funil por origem: leads, ganhos, perdidos, taxa sobre fechados, dias até ganhar, receita**
```sql
select l.source, count(*) as leads,
       count(*) filter (where l.status='won')  as ganhos,
       count(*) filter (where l.status='lost') as perdidos,
       count(*) filter (where l.status='open') as abertos,
       round(count(*) filter (where l.status='won')::numeric
             / nullif(count(*) filter (where l.status in ('won','lost')),0), 4) as taxa_ganho_sobre_fechados,
       percentile_cont(0.5) within group (order by extract(epoch from (l.closed_at - l.created_at))/86400)
         filter (where l.status='won') as dias_ate_ganho_p50,
       sum(l.value_cents) filter (where l.status='won') as receita_ganha_cents
  from public.crm_leads l
 where l.organization_id = :org and l.created_at >= :de and l.created_at < :ate
 group by 1 order by 2 desc;
```
Régua: leads **criados** na janela; `source` é texto livre (`manual`, `whatsapp`, `meta_ads`…).

**P4 — Onde o funil trava: estagnação por etapa (foto de agora)**
```sql
select p.name as funil, s.name as etapa, s.position, count(*) as abertos,
       percentile_cont(0.5) within group (order by extract(epoch from (now() - l.stage_changed_at))/3600) as horas_na_etapa_p50,
       count(*) filter (where now() - l.stage_changed_at
                        > make_interval(hours => coalesce(s.expected_duration_hours,24)::int)) as acima_do_esperado,
       count(*) filter (where r.bucket in ('em_risco','critico')) as em_risco_ou_critico,
       count(*) filter (where l.owner_kind = 'ai') as com_dono_agente
  from public.crm_leads l
  join public.crm_stages s on s.id = l.stage_id
  join public.crm_pipelines p on p.id = l.pipeline_id
  left join public.crm_lead_risk_states r on r.lead_id = l.id and r.organization_id = l.organization_id
 where l.organization_id = :org and l.status = 'open' and s.is_archived = false
 group by 1,2,3 order by 1,3;
```

**P5 — Handoffs por agente (proxy) e por mensagem recebida — soma os dois runtimes**
```sql
with h as (
  select i.created_at,
         case i.ref_kind
           when 'conversation' then (select c.active_ai_agent_id from public.conversations c
                                      where c.id = i.ref_id and c.organization_id = i.organization_id)
           when 'contact'      then (select c.active_ai_agent_id from public.conversations c
                                      where c.contact_id = i.ref_id and c.organization_id = i.organization_id
                                      order by c.last_message_at desc nulls last limit 1)
         end as agent_id
    from public.agent_inbox_items i
   where i.organization_id = :org and i.kind = 'handoff'
     and i.created_at >= :de and i.created_at < :ate
  union all
  select e.created_at, null::uuid from public.event_log e
   where e.organization_id = :org and e.event_type = 'ai.handoff_triggered'
     and e.created_at >= :de and e.created_at < :ate),
inb as (select count(*) as n from public.messages
         where organization_id = :org and direction = 'inbound' and sent_at >= :de and sent_at < :ate)
select coalesce(a.name, '(sem agente atribuído / runtime legado)') as agente, count(*) as handoffs,
       round(count(*)::numeric / nullif((select n from inb), 0), 4) as handoffs_por_msg_recebida
  from h left join public.ai_agents a on a.id = h.agent_id and a.organization_id = :org
 group by 1 order by 2 desc;
```
Régua: agente **atual** da conversa, não o do momento do handoff.

**P6 — Custo de IA por propósito, provedor e modelo — com o furo de preço declarado**
```sql
select c.purpose, c.provider, c.model, count(*) as chamadas,
       count(*) filter (where c.status='erro') as erros,
       sum(c.input_tokens) as tokens_in, sum(c.output_tokens) as tokens_out, sum(c.cache_read_tokens) as tokens_cache,
       sum(c.cost_cents) as custo_usd_cents, count(*) filter (where c.cost_cents is null) as chamadas_sem_preco,
       percentile_cont(0.5)  within group (order by c.latency_ms) as latencia_p50_ms,
       percentile_cont(0.95) within group (order by c.latency_ms) as latencia_p95_ms
  from public.llm_calls c
 where c.organization_id = :org and c.created_at >= :de and c.created_at < :ate
 group by 1,2,3 order by custo_usd_cents desc nulls last;
```

**P7 — Follow-ups que convertem: desfecho por fluxo e versão**
```sql
select p.name as fluxo, e.version_id, count(*) as inscricoes,
       count(*) filter (where e.outcome='converted') as convertidos,
       count(*) filter (where e.outcome='replied')   as responderam,
       count(*) filter (where e.outcome='exhausted') as esgotados,
       count(*) filter (where e.outcome='opted_out') as opt_out,
       count(*) filter (where e.outcome='handoff')   as handoff,
       count(*) filter (where e.status in ('active','waiting_reply','paused_handoff','paused_manual')) as em_voo,
       count(*) filter (where e.status = 'dead') as mortos_por_infra,
       round(count(*) filter (where e.outcome='converted')::numeric
             / nullif(count(*) filter (where e.status in ('completed','cancelled')),0), 4) as taxa_conversao,
       percentile_cont(0.5) within group (order by e.steps_taken) as passos_p50
  from public.followup_enrollments e
  join public.followup_flow_pointers p on p.id = e.pointer_id
 where e.organization_id = :org and e.started_at >= :de and e.started_at < :ate
 group by 1,2 order by 1,2;
```

**P8 — Quem está esperando agora: conversas com a última palavra do cliente**
```sql
select c.status, coalesce(c.assignee_kind,'(ninguém)') as quem_atende, count(*) as conversas,
       count(*) filter (where now() - c.last_inbound_at > interval '4 hours')  as caladas_4h,
       count(*) filter (where now() - c.last_inbound_at > interval '24 hours') as caladas_24h,
       percentile_cont(0.9) within group (order by extract(epoch from (now() - c.last_inbound_at))/3600) as horas_esperando_p90
  from public.conversations c
 where c.organization_id = :org and c.is_group = false
   and c.status not in ('resolved','closed','archived') and c.last_inbound_at is not null
   and (c.last_outbound_at is null or c.last_inbound_at > c.last_outbound_at)
 group by 1,2 order by 3 desc;
```

## Aprofundar

**A1 — Tempo até a 1ª resposta por hora do dia: IA × humano × ninguém**
```sql
with primeira as (
  select m.conversation_id, m.organization_id,
         min(m.sent_at) filter (where m.direction='inbound') as t_in,
         min(m.sent_at) filter (where m.direction='outbound' and m.sent_via='ai') as t_ia,
         min(m.sent_at) filter (where m.direction='outbound' and m.sent_via in ('user','external_device')) as t_hum
    from public.messages m
   where m.organization_id = :org and m.sent_at >= :de and m.sent_at < :ate
   group by 1,2)
select extract(hour from (p.t_in at time zone o.timezone))::int as hora_da_1a_msg, count(*) as conversas,
       percentile_cont(0.5) within group (order by extract(epoch from (least(p.t_ia,p.t_hum) - p.t_in)))
         filter (where least(p.t_ia,p.t_hum) > p.t_in) as p50_s_qualquer_resposta,
       percentile_cont(0.5) within group (order by extract(epoch from (p.t_ia  - p.t_in))) filter (where p.t_ia  > p.t_in) as p50_s_ia,
       percentile_cont(0.5) within group (order by extract(epoch from (p.t_hum - p.t_in))) filter (where p.t_hum > p.t_in) as p50_s_humano,
       count(*) filter (where p.t_ia is null and p.t_hum is null) as sem_resposta
  from primeira p
  join public.conversations c on c.id = p.conversation_id
  join public.organizations o on o.id = p.organization_id
 where p.t_in is not null and c.is_group = false
 group by 1 order by 1;
```
Régua: "primeira mensagem" é a primeira **dentro da janela**, não da vida da conversa.

**A2 — Motivos de perda por funil (tratar o texto livre como categoria)**
```sql
select p.name as funil, coalesce(nullif(l.lost_reason,''), '(sem motivo)') as motivo,
       count(*) as perdidos, sum(l.value_cents) as valor_cents,
       count(*) filter (where l.owner_kind = 'ai') as perdidos_com_dono_agente
  from public.crm_leads l join public.crm_pipelines p on p.id = l.pipeline_id
 where l.organization_id = :org and l.status = 'lost' and l.closed_at >= :de and l.closed_at < :ate
 group by 1,2 order by 1,3 desc;
```
Cruze `motivo` com `crm_pipelines.settings->'lost_reasons'`; o que não bate vira "outro" antes de
ir ao relatório (pode conter texto livre com dado pessoal).

**A3 — Fluxo entre etapas no período, por ator (pessoa, agente, regra)**
```sql
select coalesce(sf.name,'(desconhecida)') as de, coalesce(st.name,'(desconhecida)') as para,
       coalesce(a.actor_kind,'(sem ator)') as ator, count(*) as transicoes
  from public.crm_lead_activities a
  left join public.crm_stages sf on sf.id = nullif(a.payload->>'from_stage_id','')::uuid
  left join public.crm_stages st on st.id = nullif(a.payload->>'to_stage_id','')::uuid
 where a.organization_id = :org and a.type = 'stage_changed'
   and a.performed_at >= :de and a.performed_at < :ate
 group by 1,2,3 order by 4 desc;
```

**A4 — Custo por contato qualificado e por negócio ganho**
```sql
with custo as (
  select contact_id, sum(cost_cents) as custo_cents, count(*) as chamadas,
         count(*) filter (where cost_cents is null) as sem_preco
    from public.llm_calls
   where organization_id = :org and contact_id is not null and created_at >= :de and created_at < :ate
   group by 1),
ganho as (select distinct contact_id from public.crm_leads
           where organization_id = :org and status = 'won' and closed_at >= :de and contact_id is not null)
select count(*) as contatos_com_ia, sum(cc.custo_cents) as custo_total_cents, sum(cc.sem_preco) as chamadas_sem_preco,
       count(*) filter (where ls.stage in ('qualified','negotiating','won')) as qualificados_pelo_agente,
       count(*) filter (where g.contact_id is not null) as com_negocio_ganho,
       round(sum(cc.custo_cents) / nullif(count(*) filter (where ls.stage in ('qualified','negotiating','won')),0), 2) as custo_por_qualificado_cents,
       round(sum(cc.custo_cents) / nullif(count(*) filter (where g.contact_id is not null),0), 2) as custo_por_ganho_cents
  from custo cc
  left join public.lead_state ls on ls.organization_id = :org and ls.contact_id = cc.contact_id
  left join ganho g on g.contact_id = cc.contact_id;
```

**A5 — Promessas de retorno do agente ("volto amanhã"): cumpridas, canceladas, com resposta**
```sql
select date_trunc('week', j.next_run_at)::date as semana, count(*) as retornos_prometidos,
       count(*) filter (where j.cancelled_at is not null) as cancelados,
       count(*) filter (where j.enabled = false and j.cancelled_at is null) as disparados,
       count(*) filter (where j.enabled) as ainda_pendentes,
       count(*) filter (where exists (
         select 1 from public.messages m
          where m.organization_id = j.organization_id and m.contact_id = j.contact_id
            and m.direction = 'inbound' and m.sent_at > j.next_run_at
            and m.sent_at < j.next_run_at + interval '48 hours')) as com_resposta_em_48h
  from public.cron_jobs j
 where j.organization_id = :org and j.kind = 'at' and j.job_kind = 'followup_turn'
   and j.next_run_at >= :de and j.next_run_at < :ate
 group by 1 order by 1;
```
Régua: "resposta em 48 h" é inferência — a promessa não grava desfecho.

**A6 — Demandas: origem × dono × desfecho, tempo de vida, sem próximo passo**
```sql
select d.origem, d.dono_kind, coalesce(d.desfecho,'(aberta)') as desfecho, count(*) as demandas,
       percentile_cont(0.5) within group (order by extract(epoch from (coalesce(d.fechada_em, now()) - d.aberta_em))/3600) as horas_p50,
       count(*) filter (where d.fechada_em is null and d.proximo_passo is null) as abertas_sem_proximo_passo
  from public.demandas d
 where d.organization_id = :org and d.aberta_em >= :de and d.aberta_em < :ate
 group by 1,2,3 order by 4 desc;
```

**A7 — O que o sistema impediu de sair (vetos por portão) e a insistência do agente**
```sql
select t.vetoed_gate, t.vetoed_code, count(*) as vetos, count(distinct t.job_id) as execucoes
  from public.before_send_traces t
 where t.organization_id = :org and t.vetoed_gate is not null
   and t.created_at >= :de and t.created_at < :ate
 group by 1,2 order by 3 desc;

select c.status, count(*) as casos,
       percentile_cont(0.5) within group (order by c.followup_attempts) as retornos_p50, max(c.followup_attempts) as retornos_max
  from public.agent_cases c
 where c.organization_id = :org and c.opened_at >= :de and c.opened_at < :ate
 group by 1;
```

**A8 — A base de conhecimento responde? Acertos, quase-acertos e limiar**
```sql
select coalesce(a.name, '(sem agente)') as agente, count(*) as consultas,
       count(*) filter (where k.hits > 0) as com_acerto,
       count(*) filter (where k.hits = 0 and k.top_score >= k.threshold - 0.1) as quase_acerto_limiar,
       count(*) filter (where k.hits = 0 and k.top_score <  k.threshold - 0.1) as sem_material,
       round(avg(k.top_score)::numeric, 3) as score_medio, round(avg(k.threshold)::numeric, 3) as limiar_medio
  from public.knowledge_searches k
  left join public.ai_agents a on a.id = k.agent_id
 where k.organization_id = :org and k.created_at >= :de and k.created_at < :ate
 group by 1 order by 2 desc;
```

**A9 — Os índices oficiais do produto, prontos (para bater com a tela)**
```sql
select public.fn_atrito_metrics(:org, :de, :ate, 72, 0.7, 4);   -- abandono 72 h, similaridade 0,7, espera 4 h
select public.fn_attendant_metrics(:org, :de, :ate, null);        -- funil aberto + ganhos/perdidos/conversas/1ª resposta humana por atendente
```
Leia `abandono_horas` real de `organizations.settings->'atrito'->>'abandono_horas'` antes, para
bater com a tela. O gasto do mês (`fn_gasto_de_ia_do_mes`) só roda com `service_role`; recalcule
com P6 restrito ao mês.

## Inventário (o que existe montado — para o guia de cliente novo conferir)

```sql
select a.name, a.is_active, a.published_version_id is not null as publicado, a.paused_at is not null as pausado,
       v.provider, v.model, cardinality(v.pipeline_ids) as funis, cardinality(v.knowledge_source_ids) as materiais,
       (v.followup->>'enabled')::boolean as followup_ligado, cardinality(v.tool_ids) as capacidades
  from public.ai_agents a
  left join public.ai_agent_versions v on v.id = a.published_version_id
 where a.organization_id = :org and a.archived_at is null order by a.priority desc, a.name;

select r.name, r.is_active, count(m.id) as intencoes, r.fallback_agent_id is not null as tem_fallback
  from public.ai_routers r left join public.ai_router_members m on m.router_id = r.id
 where r.organization_id = :org group by 1,2,4;

select name, status, handoff_policy, trigger_config->>'kind' as gatilho from public.followup_flow_pointers where organization_id = :org;
select name, source_type, status, last_index_status, chunks_count from public.ai_knowledge_sources where organization_id = :org and status <> 'archived';
select exists(select 1 from public.org_memory_pointers where organization_id = :org) as memoria_publicada;
```
