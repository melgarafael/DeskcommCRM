# Runbook — “meu Supabase estourou a cota”

Para quem roda o escreve.ai numa VPS com Supabase (em especial o **plano free**,
cuja cota de egress é de 5 GB/mês) e recebeu aviso de consumo, throttling ou
cobrança. Também serve para quem só quer saber **quanto o sistema parado custa**.

## 1. Meça antes de mexer

Nenhum número deste runbook substitui a medição da sua instalação — a sua rede, o
seu volume e os seus ajustes mudam a conta. Rode isto, não confie na memória:

```bash
# O que o worker está usando AGORA (os dois intervalos que governam o custo):
docker compose -f docker-compose.prod.yml logs worker | grep 'agent-engine pronto' | tail -1

# Quem mais fala com o banco, ordenado por número de chamadas:
psql "$SUPABASE_DB_URL" -c \
  "select calls, rows, left(query, 70) as consulta
     from pg_stat_statements order by calls desc limit 10;"

# Egress real do contêiner, em duas leituras espaçadas (a coluna 2 é bytes recebidos):
docker exec $(docker compose -f docker-compose.prod.yml ps -q worker) cat /proc/net/dev | grep eth0
sleep 120
docker exec $(docker compose -f docker-compose.prod.yml ps -q worker) cat /proc/net/dev | grep eth0
```

No painel do Supabase o número oficial está em **Settings → Usage**. É ele que
vale para cobrança; `/proc/net/dev` mede o contêiner e serve para atribuir a
origem.

## 2. Os dois intervalos que governam o custo do worker

Ambos vivem no `.env`, são opcionais, e o worker imprime os valores em vigor na
linha `agent-engine pronto` do log.

| chave | default | o que faz |
|---|---|---|
| `QUEUE_POLL_INTERVAL_MS` | `2000` | **Teto de espera.** Com a fila vazia, é quanto o worker dorme entre uma consulta e a próxima. Com job agendado, ele acorda no vencimento e este valor só limita a soneca. |
| `QUEUE_CLAIM_RETRY_INTERVAL_MS` | `250` | Ritmo do *“havia trabalho e eu não peguei”* — todas as vagas de `QUEUE_MAX_CONCURRENCY` ocupadas, ou outro turno rodando para o mesmo contato. |

**Não passe `QUEUE_POLL_INTERVAL_MS` de 10000.** A conexão ociosa do pool expira
em 10 s; acima disso cada rodada volta a pagar TCP+TLS+startup, e o intervalo
maior passa a gastar **mais** do que economiza. O worker avisa no boot se você
cruzar essa linha. Ele também não deve chegar perto de `INBOUND_DEBOUNCE_MS`
(8000), senão o laço dorme através da janela de coalescência.

Depois de editar o `.env`:

```bash
docker compose -f docker-compose.prod.yml --env-file .env up -d worker
```

(Numa VPS com proxy reverso próprio, o `up -d` do serviço `app` leva os **dois**
arquivos de compose — ver `docs/runbooks/deploy.md`. Para o `worker` não há
labels de roteamento, então esta linha basta.)

## 3. O que o worker ocioso custa hoje

Uma instalação sem nenhum atendimento consulta a fila com **um** `select` por
rodada — não com a transação de claim inteira. Medido no protocolo do Postgres,
com a fila vazia: a consulta do relógio custa **54 B** de egress contra **638 B**
da rodada de claim que existia antes da issue #258, e é servida pelo índice
parcial `idx_job_queue_claim` (Index Only Scan, 1 buffer, 0,010 ms com 50 mil
linhas na tabela — não degrada com o histórico).

O worker **não é a única origem** de consumo. O contêiner `scheduler` dispara os
crons HTTP do app, e cada um deles fala com o PostgREST; numa instalação parada
isso costuma ser a maior parte do que sobra. Se o seu número não fechar depois de
ajustar os intervalos, meça o `app` separadamente antes de mexer em mais nada.

## 4. Espaço em disco é outra cota (e ela não se resolve com intervalo)

O plano free também limita o **banco** (500 MB), e `job_queue` e `api_audit_log`
são as duas tabelas que crescem sem ninguém escrever nelas de propósito. Se o
seu aperto for de espaço e não de tráfego, comece medindo — o ranking abaixo diz
qual das duas (se alguma) é o seu problema:

```bash
psql "$SUPABASE_DB_URL" -c \
  "select relname, pg_size_pretty(pg_total_relation_size(c.oid)) as tamanho
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by pg_total_relation_size(c.oid) desc limit 10;"
```

### 4.1. Quem poda, e quando

O cron **`data-retention`** roda uma vez por dia (04h40, `docker/scheduler/entrypoint.sh`)
e apaga **em lotes** — nunca num DELETE só, que travaria a tabela pelo tempo
inteiro da varredura. O que ele apagou na última rodada:

```bash
psql "$SUPABASE_DB_URL" -c \
  "select created_at, metadata from api_audit_log
    where action = 'retention.sweep_run' order by created_at desc limit 5;"
```

Linha nenhuma quer dizer uma de duas coisas, e elas são diferentes: ou não havia
nada vencido para apagar (o normal), ou o cron não está rodando. Para separar:

```bash
docker compose -f docker-compose.prod.yml exec scheduler crontab -l | grep data-retention
docker compose -f docker-compose.prod.yml exec app \
  curl -fsS -H "Authorization: Bearer $INTERNAL_SECRET" \
  http://localhost:3000/api/v1/cron/data-retention
```

A resposta do `curl` traz `fila_tem_resto` / `auditoria_tem_resto`. **`true`
significa que o teto por invocação foi atingido e sobrou trabalho para a rodada
seguinte** — normal na primeira poda de uma instalação antiga, e nada a fazer
além de esperar (ou disparar o `curl` acima algumas vezes).

### 4.2. As duas alavancas, e o que cada uma custa

Ambas são opcionais e vivem no `.env`; os defaults funcionam sem editar nada.

| chave | default | o que faz |
|---|---|---|
| `JOB_QUEUE_RETENTION_DAYS` | `90` | Idade a partir da qual um job **terminal** (`done`/`failed`/`dead`) é apagado. Piso de **7** dias. |
| `AUDIT_LOG_RETENTION_DAYS` | `1825` (5 anos) | Idade a partir da qual uma linha de auditoria é expurgada. Piso de **90** dias. |

O que a poda da fila **nunca** toca: job `pending` (trabalho que ainda vai sair)
e `running` (com um worker agora), qualquer que seja a idade; e job `dead` cujo
aviso na Central ainda está **aberto** — esse tem dono, que é a pessoa que ainda
não olhou. Apagar um job leva junto, por FK, as linhas de `send_ledger` e
`before_send_traces` daquele run: um lead que não é contatado há mais que a
retenção volta a receber o aviso de "sou um assistente virtual", e o gate LGPD
volta a exigir base legal no primeiro toque de prospecção — os dois erram para o
lado de proteger a mais.

O piso do audit não é sugestão de estilo: ele mora **dentro** de
`fn_expurgar_auditoria_vencida`, então nem quem tem a chave de serviço apaga
rastro com menos de 90 dias por esse caminho. A função não aceita organização,
ator, ação nem id — só idade.

Depois de mudar qualquer uma das duas:

```bash
docker compose -f docker-compose.prod.yml --env-file .env up -d app scheduler
```

### 4.3. Apagou e o banco não encolheu

Esperado. `DELETE` devolve o espaço para **reuso do Postgres**, não para o
sistema de arquivos — o painel do Supabase segue mostrando o tamanho antigo até
as linhas novas ocuparem os buracos. O cron **não** roda `VACUUM FULL` de
propósito: ele trava a tabela e exige o dobro do tamanho em disco livre, e fazer
isso sozinho de madrugada num banco de cliente é pior que a cota apertada. Se
você precisa do espaço de volta AGORA e aceita a janela de indisponibilidade
daquela tabela:

```bash
psql "$SUPABASE_DB_URL" -c "vacuum (full, analyze) public.job_queue;"
psql "$SUPABASE_DB_URL" -c "vacuum (full, analyze) public.api_audit_log;"
```

Quanto está morto e ainda não foi reaproveitado, antes de decidir:

```bash
psql "$SUPABASE_DB_URL" -c \
  "select relname, n_live_tup, n_dead_tup, last_autovacuum
     from pg_stat_user_tables
    where relname in ('job_queue','api_audit_log','send_ledger','before_send_traces');"
```

## 5. Se ainda não fechar

Abra uma issue com: a saída dos três comandos da seção 1, a janela de tempo que
elas cobrem, e o painel **Usage** do Supabase no mesmo período. Medição sem a
janela declarada não compara — foi a única lacuna que a issue #258 deixou em
aberto.
