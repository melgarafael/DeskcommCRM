# Runbook — quanto a IA custa e quanto ela demora

Para quem opera uma VPS e quer **número**, não impressão: quanto cada parte da IA
gasta, quantos atendimentos ela fez, e quanto o cliente espera entre mandar a
mensagem e receber a primeira resposta — com as esperas deliberadas separadas da
lentidão de verdade.

Tudo aqui é **só leitura**. Rode com o `psql` contra o banco da instalação:

```bash
psql "$SUPABASE_DB_URL"
```

e, dentro dele, escolha a organização uma vez (o id está em
`select id, name from organizations;`):

```sql
\set org '00000000-0000-0000-0000-000000000000'
```

Todas as consultas abaixo filtram por `:'org'`. Valores em dinheiro saem de
`llm_calls.cost_cents`, que é **centavo de dólar** calculado pela tabela de
preços do código (`lib/agent-engine/edge/llm/pricing.ts`). `cost_cents` vazio
quer dizer **preço desconhecido** — não "grátis". Por isso as consultas contam
as linhas sem preço à parte, em vez de somá-las como zero.

---

## 1. Custo e tokens por ponto da IA (últimos 7 dias)

Cada linha de `llm_calls` é uma chamada a um modelo, e `purpose` diz qual ponto
fez a chamada (o mesmo nome da tela **Agente de IA → Execuções**).

```sql
select purpose,
       count(*)                                            as chamadas,
       count(*) filter (where status = 'erro')             as com_erro,
       sum(input_tokens)                                   as tokens_entrada,
       sum(output_tokens)                                  as tokens_saida,
       sum(cache_read_tokens)                              as lidos_do_cache,
       sum(cache_write_tokens)                             as gravados_no_cache,
       round(100.0 * sum(cache_read_tokens) / nullif(sum(input_tokens), 0), 1)
                                                           as taxa_de_cache_pct,
       round(sum(cost_cents) / 100.0, 4)                   as custo_usd,
       count(*) filter (where cost_cents is null and status = 'ok')
                                                           as chamadas_sem_preco
  from llm_calls
 where organization_id = :'org'
   and created_at >= now() - interval '7 days'
 group by purpose
 order by sum(cost_cents) desc nulls last;
```

Como ler:

- **`taxa_de_cache_pct`** é a fração da entrada que veio do cache do provedor
  (`input_tokens` já inclui os tokens lidos do cache). Cache lido custa uma
  fração da entrada normal; um ponto com muita entrada e taxa perto de zero é
  candidato a investigação.
- **`chamadas_sem_preco`** maior que zero quer dizer que `custo_usd` está
  **abaixo** do real. Acontece com modelo que a tabela de preços não conhece, e
  sempre com a transcrição de áudio feita pelo serviço de transcrição (abaixo). A linha de erro fica de fora: ela
  também tem custo vazio, mas o provedor recusou e não cobrou token.
- **`visao_de_imagem`** e **`transcricao_de_audio`** são as chamadas do worker
  de mídia (descrição de foto, áudio e os quadros de vídeo). Elas só aparecem
  a partir da versão que trouxe este runbook — antes, esse gasto não deixava
  linha nenhuma. A transcrição depende de quem ouviu o áudio, gravado em
  `origem_da_escolha`: com `modelo_da_organizacao` foi o modelo de conversa,
  cobrado por token — a linha tem tokens e custo e **conta para o teto**, como a
  visão. Com `servico_da_instalacao` ou `padrao_openai_compativel` foi o serviço
  de transcrição, que tem preço próprio, desconhecido do sistema, e não devolve
  tokens: a linha tem a contagem e a latência, com o custo vazio — e por isso
  **não conta para o teto de orçamento**.
  Chamada de mídia que falhou no provedor também grava linha, com
  `status = 'erro'`.

## 2. Atendimentos por dia e custo médio de cada um

Um **turno** é um job do agente: o cliente escreveu, o agente leu e respondeu
(ou decidiu não responder). Todo turno tem uma chamada `agent_turn`, e as
chamadas auxiliares do mesmo turno (classificadores, checkpoint) carregam o
mesmo `job_id`.

```sql
with turnos as (
  select distinct job_id
    from llm_calls
   where organization_id = :'org'
     and purpose = 'agent_turn'
     and job_id is not null
     and created_at >= now() - interval '7 days'
)
select date_trunc('day', c.created_at)::date                     as dia,
       count(distinct c.job_id)                                  as turnos,
       count(*)                                                  as chamadas,
       round(count(*)::numeric / nullif(count(distinct c.job_id), 0), 1)
                                                                 as chamadas_por_turno,
       round(sum(c.cost_cents) / 100.0, 4)                       as custo_usd,
       round(sum(c.cost_cents) / 100.0 / nullif(count(distinct c.job_id), 0), 5)
                                                                 as custo_medio_por_turno_usd,
       count(*) filter (where c.cost_cents is null)              as chamadas_sem_preco
  from llm_calls c
  join turnos t on t.job_id = c.job_id
 where c.organization_id = :'org'
   and c.created_at >= now() - interval '8 days'
 group by 1
 order by 1;
```

E qual ponto pesa dentro do turno:

```sql
with turnos as (
  select distinct job_id from llm_calls
   where organization_id = :'org' and purpose = 'agent_turn'
     and job_id is not null and created_at >= now() - interval '7 days'
)
select c.purpose,
       count(*)                                                       as chamadas,
       round(100.0 * sum(c.cost_cents) / nullif(sum(sum(c.cost_cents)) over (), 0), 1)
                                                                      as pct_do_custo_dos_turnos
  from llm_calls c
  join turnos t on t.job_id = c.job_id
 where c.organization_id = :'org'
 group by c.purpose
 order by 3 desc nulls last;
```

A mídia (`visao_de_imagem`, `transcricao_de_audio`) não tem `job_id` — roda
antes do turno, num worker próprio — e por isso fica fora destas duas consultas.
O custo dela está na consulta da seção 1.

## 3. Quanto o cliente espera pela primeira resposta da IA

A régua: da **primeira** mensagem do cliente que ficou sem resposta até a
**primeira** mensagem que a IA registrou para envio (`sent_via = 'ai'`) na
mesma conversa. Rajada de mensagens conta a partir da primeira. Ficam de fora
as conversas em que uma pessoa respondeu antes da IA.

```sql
with m as (
  select id, conversation_id, direction, created_at,
         lag(direction) over (partition by conversation_id order by created_at) as anterior
    from messages
   where organization_id = :'org'
     and created_at >= now() - interval '7 days'
),
inicio_da_espera as (
  select id, conversation_id, created_at
    from m
   where direction = 'inbound' and anterior is distinct from 'inbound'
),
primeira_saida as (
  select i.id, i.created_at as cliente_escreveu,
         s.created_at as saiu_em, s.sent_via
    from inicio_da_espera i
    cross join lateral (
      select o.created_at, o.sent_via
        from messages o
       where o.organization_id = :'org'
         and o.conversation_id = i.conversation_id
         and o.direction = 'outbound'
         and o.status <> 'failed'
         and o.created_at > i.created_at
       order by o.created_at
       limit 1
    ) s
)
select count(*)                                                     as respostas,
       round(percentile_cont(0.5) within group (order by extract(epoch from saiu_em - cliente_escreveu))::numeric, 1)
                                                                    as p50_segundos,
       round(percentile_cont(0.95) within group (order by extract(epoch from saiu_em - cliente_escreveu))::numeric, 1)
                                                                    as p95_segundos
  from primeira_saida
 where sent_via = 'ai';
```

**Este número NÃO é "lentidão".** Ele soma, de propósito, duas esperas que o
produto faz para proteger o seu número e para não responder pela metade:

- a **janela de coalescência** (debounce): o agente espera o cliente terminar
  de escrever antes de responder (`INBOUND_DEBOUNCE_MS`, com teto);
- o **atraso humano** antes da primeira bolha, que imita o tempo de digitação.

Ele também carrega o adiamento: mensagem que chegou fora da janela de envio
ou do horário do agente só é respondida quando a janela abre, e essas horas
entram aqui. A seção 4 as deixa de fora.

Reduzir qualquer uma das duas esperas é decisão de anti-banimento, não conserto de
desempenho. Para saber quanto de cada parcela é espera deliberada e quanto é
trabalho, use a seção 4.

## 4. As etapas, separadas

Cada etapa abaixo tem a sua régua escrita. Leia-as lado a lado, nunca somadas.

```sql
with despacho as (
  select e.id as evento_id,
         (e.payload->>'inbound_message_id')::uuid as mensagem_id,
         e.created_at as despachado_em
    from event_log e
   where e.organization_id = :'org'
     and e.event_type = 'ai_agent.dispatch_requested'
     and e.created_at >= now() - interval '7 days'
),
etapas as (
  select extract(epoch from d.despachado_em - msg.created_at) * 1000  as webhook_ms,
         extract(epoch from j.created_at - d.despachado_em) * 1000    as espera_do_dreno_ms,
         extract(epoch from j.run_after - j.created_at) * 1000        as debounce_ms,
         w.value - extract(epoch from j.run_after - j.created_at) * 1000 as fila_ms,
         t.value                                                      as turno_ms
    from despacho d
    join messages msg on msg.id = d.mensagem_id and msg.organization_id = :'org'
    join job_queue j  on j.source_event_id = d.evento_id and j.organization_id = :'org'
    left join metrics w on w.organization_id = :'org' and w.name = 'run_queue_wait_ms'
                       and w.created_at >= now() - interval '8 days'
                       and w.labels->>'job_id' = j.id::text
    left join metrics t on t.organization_id = :'org' and t.name = 'run_wall_ms'
                       and t.created_at >= now() - interval '8 days'
                       and t.labels->>'job_id' = j.id::text
   -- só job que nunca voltou para a fila: o retry soma tentativa (attempts > 1);
   -- o adiamento (janela anti-ban, horário do agente, teto de envio, espera de
   -- saldo, agenda, envio que a sessão pôs em espera) devolve a tentativa e
   -- reescreve run_after, mas grava last_error, que ninguém limpa depois. O hold de sessão NÃO é excluído
   -- aqui: ao liberar, o watchdog devolve o run_after original e apaga a marca.
   where j.attempts = 1
     and j.last_error is null
     and not (j.payload ? 'held_run_after')
)
select 'webhook (mensagem → despacho)'       as etapa, count(webhook_ms) as n,
       round(percentile_cont(0.5)  within group (order by webhook_ms)::numeric) as p50_ms,
       round(percentile_cont(0.95) within group (order by webhook_ms)::numeric) as p95_ms from etapas
union all
select 'espera do dreno (despacho → job)', count(espera_do_dreno_ms),
       round(percentile_cont(0.5)  within group (order by espera_do_dreno_ms)::numeric),
       round(percentile_cont(0.95) within group (order by espera_do_dreno_ms)::numeric) from etapas
union all
select 'debounce — espera DELIBERADA',       count(debounce_ms),
       round(percentile_cont(0.5)  within group (order by debounce_ms)::numeric),
       round(percentile_cont(0.95) within group (order by debounce_ms)::numeric) from etapas
union all
select 'fila (vencido → worker pegou)',      count(fila_ms),
       round(percentile_cont(0.5)  within group (order by fila_ms)::numeric),
       round(percentile_cont(0.95) within group (order by fila_ms)::numeric) from etapas
union all
select 'turno (worker pegou → terminou)',    count(turno_ms),
       round(percentile_cont(0.5)  within group (order by turno_ms)::numeric),
       round(percentile_cont(0.95) within group (order by turno_ms)::numeric) from etapas;
```

O que cada etapa mede, e o que ela não mede:

| etapa | régua | observação |
|---|---|---|
| webhook | `event_log.created_at` do despacho − `messages.created_at` da mensagem | trabalho síncrono do recebimento |
| espera do dreno | `job_queue.created_at` − despacho | quanto o despacho esperou o worker o ler. **Em mensagem de áudio, foto ou vídeo inclui a espera pela transcrição ou descrição** (teto de cerca de 120 s): o job só nasce quando a mídia mais recente terminou de ser lida |
| **debounce** | `job_queue.run_after` − `job_queue.created_at` | **espera deliberada**: o cliente pode estar digitando |
| fila | `run_queue_wait_ms` − debounce | o job já podia rodar e não havia vaga, ou outro turno do mesmo contato estava rodando — **ou a sessão do WhatsApp estava fora** (ver abaixo) |
| turno | `run_wall_ms` | do worker pegar o job até fechá-lo: leituras, chamadas de modelo, envio das bolhas **e o atraso humano** |

Limites honestos desta medição:

- Só a **primeira mensagem de cada rajada** cria job. As seguintes entram de
  carona no job já agendado e não aparecem nesta consulta.
- O **atraso humano** não fica gravado no banco; ele está dentro de
  `turno`. O valor de cada turno sai no log do worker:

  ```bash
  docker compose -f docker-compose.prod.yml logs worker \
    | grep 'atraso humano antes da 1ª bolha' | tail -20
  ```

  (`atraso_ms` é o que o agente esperou de propósito naquele turno; quando o
  modelo já demorou mais que o alvo, ele é zero.)
- O tempo em que o job ficou **segurado porque a sessão do WhatsApp estava
  fora** aparece dentro de `fila`. Ao liberar o job, o watchdog de sessão
  devolve o horário original e apaga a marca de que segurou, então depois não
  há como separar as duas esperas. Uma `fila` de minutos ou horas num dia em
  que o WhatsApp caiu é a sessão, não falta de vaga no worker.
- Turno adiado (fora da janela de envio, fora do horário do agente, teto de
  envio, espera de saldo) fica **fora** da consulta: o tempo dele é agenda, não
  demora.
- `job_queue.locked_at` não serve de marca de tempo: ele volta a vazio quando
  o job termina. É por isso que `run_queue_wait_ms` e `run_wall_ms` existem.

## 5. As métricas de tempo do job, direto

`run_queue_wait_ms` e `run_wall_ms` são gravadas na tabela `metrics` ao fim de
todo job do agente que termina com sucesso — inclusive o que não chamou modelo
nenhum. Ficam de fora o job que falhou e as entregas transacionais (lembrete e
resposta aprovada), que fecham por outro caminho. Os rótulos levam só ids (`job_id`, `contact_id`, `kind`).

```sql
select name,
       labels->>'kind'                                                     as tipo_de_job,
       count(*)                                                            as jobs,
       round(percentile_cont(0.5)  within group (order by value)::numeric) as p50_ms,
       round(percentile_cont(0.95) within group (order by value)::numeric) as p95_ms,
       round(max(value)::numeric)                                          as max_ms
  from metrics
 where organization_id = :'org'
   and name in ('run_queue_wait_ms', 'run_wall_ms')
   and created_at >= now() - interval '7 days'
 group by 1, 2
 order by 1, 2;
```

- `run_queue_wait_ms` = do job criado até o worker pegá-lo. **Inclui o
  debounce** e qualquer adiamento (espera de saldo, nova tentativa depois de
  erro, job criado com hora marcada para depois). Um valor de horas aqui pode
  ser a agenda, não atraso. Para isolar a fila, use a seção 4.
- `run_wall_ms` = do worker pegar o job até fechá-lo, contado no relógio do
  banco nas duas pontas.

As duas só existem para jobs que rodaram depois da versão que trouxe este
runbook.
