# Diagnóstico — os sinais que apontam a causa, e como lê-los sem ler as conversas

Acesso e limites: os mesmos do guia `deskcomm-metricas` (`SUPABASE_DB_URL` de dentro da VPS ou papel
só-leitura criado pela pessoa; sempre `organization_id`; agregados). `:org`, `:agente`, `:de`,
`:ate` como parâmetros. Descubra a versão publicada e a data primeiro:

```sql
select a.name, a.published_version_id, v.version_number, v.provider, v.model, v.created_at as publicada_em,
       length(v.system_prompt) as tamanho_do_prompt, cardinality(v.pipeline_ids) as funis,
       cardinality(v.knowledge_source_ids) as materiais, cardinality(v.tool_ids) as capacidades,
       v.trigger_config->'filters'->'business_hours' as horario
  from public.ai_agents a join public.ai_agent_versions v on v.id = a.published_version_id
 where a.organization_id = :org and a.id = :agente;
```

## 1. Vetos por portão — a origem mais comum de "responde estranho"

```sql
select t.vetoed_gate, t.vetoed_code, count(*) as vetos, count(distinct t.job_id) as turnos
  from public.before_send_traces t
  join public.llm_calls c on c.job_id = t.job_id and c.organization_id = t.organization_id
 where t.organization_id = :org and c.agent_id = :agente and t.vetoed_gate is not null
   and t.created_at >= :de and t.created_at < :ate
 group by 1,2 order by 3 desc;
```
`internal_vocabulary` → o prompt (ou a memória) ensina jargão. `promise`/`semantic_promise` → o
prompt permite o que a tabela não permite. `case_promise` → promete pessoa sem abrir caso.
`agenda_stall` → falou de horário sem usar a agenda (quase sempre o "encaminhe ao gerente").
`disclosure` → cortou a apresentação. Chamadas antigas podem ter `agent_id` nulo — se o filtro
zerar, tire `c.agent_id` e olhe a organização inteira, declarando.

## 2. Passa demais (ou de menos) para pessoa

```sql
select count(*) filter (where kind='handoff') as handoffs,
       count(*) filter (where kind='budget_exceeded') as teto_estourado,
       count(*) filter (where kind='capabilities_missing') as capacidade_faltando
  from public.agent_inbox_items
 where organization_id = :org and created_at >= :de and created_at < :ate;

select status, source, count(*) as casos, percentile_cont(0.5) within group (order by followup_attempts) as retornos_p50
  from public.agent_cases where organization_id = :org and agent_id = :agente
   and opened_at >= :de and opened_at < :ate group by 1,2;
```
Muitos handoffs com poucos casos: o prompt manda "chamar alguém" cedo demais. Poucos handoffs e
muitos vetos: o agente insiste onde devia passar.

## 3. A base responde?

```sql
select count(*) as consultas, count(*) filter (where hits > 0) as com_acerto,
       count(*) filter (where hits = 0 and top_score >= threshold - 0.1) as quase_no_limiar,
       count(*) filter (where hits = 0 and top_score <  threshold - 0.1) as material_nao_cobre,
       round(avg(threshold)::numeric,2) as limiar
  from public.knowledge_searches
 where organization_id = :org and agent_id = :agente and created_at >= :de and created_at < :ate;
```
Zero consultas com materiais ligados: o prompt não manda consultar (ou manda "já saber"). Quase no
limiar: ajuste técnico do limiar (não é prompt). Material não cobre: conhecimento, não prompt.

## 4. O roteador está mandando para o agente certo?

```sql
select intent_name, outcome, count(*) from public.ai_router_decisions
 where organization_id = :org and created_at >= :de and created_at < :ate group by 1,2 order by 3 desc;
```
`no_match`/`classifier_failed` altos: intenções mal descritas ou sem exemplos — é o roteador.

## 5. Custo e tamanho do turno

```sql
select purpose, count(*) as chamadas, round(avg(input_tokens)) as tokens_in_medio,
       round(avg(output_tokens)) as tokens_out_medio, round(avg(cache_read_tokens)) as cache_medio,
       sum(cost_cents) as custo_cents, count(*) filter (where cost_cents is null) as sem_preco,
       percentile_cont(0.5) within group (order by latency_ms) as p50_ms
  from public.llm_calls where organization_id = :org and agent_id = :agente
   and created_at >= :de and created_at < :ate group by 1 order by custo_cents desc nulls last;
```
`tokens_in_medio` alto com cache baixo: o sistema não está estável entre turnos (prompt ou memória
mudando) — ou o prompt é simplesmente grande. Corte o que o motor já faz.

## 6. Fora da janela

```sql
select extract(hour from (m.sent_at at time zone o.timezone))::int as hora, count(*) as recebidas
  from public.messages m join public.organizations o on o.id = m.organization_id
 where m.organization_id = :org and m.direction='inbound' and m.sent_at >= :de and m.sent_at < :ate
 group by 1 order by 1;
```
Compare com `business_hours` da versão: mensagens fora da janela são adiadas — o cliente das 22h
recebe resposta de manhã, e isso não é prompt.

## 7. Se for indispensável olhar conversas

Só com a pessoa ciente, só na instalação, só o trecho, e o mínimo: as N conversas mais recentes
em que houve veto ou handoff, lendo `direction`, `sent_via`, `sent_at` e o corpo **apenas** das
mensagens do agente (`sent_via = 'ai'`) — não as do cliente — para ver **como** ele fala, não
sobre quem. Nunca copie para fora da sessão.

```sql
select m.conversation_id, m.sent_at, m.body
  from public.messages m
 where m.organization_id = :org and m.direction = 'outbound' and m.sent_via = 'ai'
   and m.conversation_id in (
     select c.id from public.conversations c where c.organization_id = :org
        and c.last_handoff_at >= :de order by c.last_handoff_at desc limit 5)
 order by m.conversation_id, m.sent_at;
```

## Antes/depois (a tabela que vai no relatório)

| mensagem de teste | versão publicada: texto / ações / portões | versão nova: texto / ações / portões | melhorou? |
|---|---|---|---|

Depois de publicada, em 7-14 dias: vetos, handoffs, consultas à base com acerto, custo por turno e
conversão — comparados **pela data da publicação**, com o guia `deskcomm-metricas`.
