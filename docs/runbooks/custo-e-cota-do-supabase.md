# Runbook — “meu Supabase estourou a cota”

Para quem roda o DeskcommCRM numa VPS com Supabase (em especial o **plano free**,
cuja cota de egress é de 5 GB/mês e a de log ingerido, 1 GB por ciclo — §5) e
recebeu aviso de consumo, throttling ou cobrança. Também serve para quem só quer
saber **quanto o sistema parado custa**.

## Antes de rodar — a pasta e o `psql`

Tudo abaixo roda **na VPS, por SSH**, de dentro da pasta da instalação, e o
`psql` é o do contêiner: a VPS instalada pelo kit não traz cliente de Postgres
no host. Rode este bloco uma vez na sessão e os comandos seguintes funcionam
copiando e colando. O porquê de cada linha está em
[`rodar-sql-na-vps.md`](./rodar-sql-na-vps.md).

```bash
P="$(find /root /opt /home /var/www -maxdepth 4 -name docker-compose.prod.yml 2>/dev/null | head -1)"
if [ -n "$P" ]; then cd "$(dirname "$P")" && pwd; else echo "instalação não encontrada"; fi
psql_vps() { bash -c 'source hostgator-setup-kit/_common.sh && load_env .env && psql_run "$@"' _ "$@"; }
psql_vps -c 'select 1'   # tem de responder 1
```

## 1. Meça antes de mexer

Nenhum número deste runbook substitui a medição da sua instalação — a sua rede, o
seu volume e os seus ajustes mudam a conta. Rode isto, não confie na memória:

```bash
# O que o worker está usando AGORA (os dois intervalos que governam o custo):
docker compose -f docker-compose.prod.yml logs worker | grep 'agent-engine pronto' | tail -1

# Quem mais fala com o banco, ordenado por número de chamadas:
psql_vps -c \
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

## 2. Os três intervalos que governam o custo do worker

Todos vivem no `.env`, são opcionais, e o worker imprime os valores em vigor na
linha `agent-engine pronto` do log.

| chave | default | o que faz |
|---|---|---|
| `QUEUE_POLL_INTERVAL_MS` | `2000` | **Piso da espera ociosa.** Com a fila vazia, é quanto o worker dorme entre uma consulta e a próxima; com o recuo ligado (abaixo), o valor dobra a cada rodada ociosa até o teto. Com job agendado, ele acorda no vencimento e este valor só limita a soneca. |
| `QUEUE_IDLE_MAX_INTERVAL_MS` | vazio (desligado) | **Teto do recuo com a fila vazia.** Desligado, a instalação parada consulta o banco a cada piso — 3.880 consultas em 2h19 (~28/min) medidas na issue #3688. Com `60000`, cai para ~1/min. Mensagem de cliente acorda a fila na hora; a resposta da equipe a um caso da IA e os disparos agendados pelo cron podem esperar até o teto. |
| `QUEUE_CLAIM_RETRY_INTERVAL_MS` | `250` | Ritmo do *“havia trabalho e eu não peguei”* — todas as vagas de `QUEUE_MAX_CONCURRENCY` ocupadas, ou outro turno rodando para o mesmo contato. |

**Não passe `QUEUE_POLL_INTERVAL_MS` de 10000.** A conexão ociosa do pool expira
em 10 s; acima disso cada rodada volta a pagar TCP+TLS+startup, e o intervalo
maior passa a gastar **mais** do que economiza. O worker avisa no boot se você
cruzar essa linha. Ele também não deve chegar perto de `INBOUND_DEBOUNCE_MS`
(8000), senão o laço dorme através da janela de coalescência.

O teto do recuo (`QUEUE_IDLE_MAX_INTERVAL_MS`) fica **acima** dos 10 s de
propósito e não cai na mesma regra: depois de um sono longo a rodada reconecta
(499 B medidos contra 66 B), mas 1 rodada/min a 499 B continua ~4× mais barata
que 30 rodadas/min a 66 B. O que não vale é encurtar o **piso**.

**Valor inválido não derruba o worker.** Um `.env` com `QUEUE_IDLE_MAX_INTERVAL_MS=60s`
(ou o piso com typo) cai no comportamento de hoje — teto desligado / piso 2000 —
e escreve uma linha `[env] ... inválida (...)` no log do worker, em vez de
recusar o boot: uma instalação que não sobe por causa de um knob de ritmo fica
sem atendimento, que é pior que o ritmo antigo. Teto abaixo do piso é grampeado
no piso, com aviso na linha `agent-engine pronto` — recuo espaça consulta, nunca
acelera a fila.

A conta do recuo é uma função pura e testada (`lib/agent-engine/queue/recuo.ts`):
com a fila vazia a espera **dobra** por passada (2 s, 4 s, 8 s, 16 s, 32 s, teto)
e volta ao piso **na primeira passada com trabalho** — o piso é o atraso máximo
que um job novo paga, e é o que `tests/unit/fila-recuo-simulado.test.ts` prova
com relógio dublado.

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

O plano free também limita o **banco** (500 MB), e `job_queue`, `api_audit_log`
e as tabelas que a IA grava a cada turno (§4.2) crescem sem ninguém escrever
nelas de propósito. Se o seu aperto for de espaço e não de tráfego, comece
medindo — o ranking abaixo diz qual delas (se alguma) é o seu problema:

```bash
psql_vps -c \
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
psql_vps -c \
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

A resposta do `curl` traz um campo `*_tem_resto` por tabela podada
(`fila_tem_resto`, `auditoria_tem_resto`, `telemetria_de_ia_tem_resto`,
`ritmo_de_envio_tem_resto`, `copias_enviadas_tem_resto`, `checkpoints_tem_resto`
e os demais). **`true` em qualquer um significa que o teto por invocação foi atingido e sobrou trabalho para a rodada
seguinte** — normal na primeira poda de uma instalação antiga, e nada a fazer
além de esperar (ou disparar o `curl` acima algumas vezes).

### 4.2. As alavancas, e o que cada uma custa

Todas são opcionais e vivem no `.env`; os defaults funcionam sem editar nada.

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

As tabelas que a IA grava a cada turno (migration 0587) têm alavanca própria, no
mesmo cron e com o piso também dentro do banco:

| chave | default | o que faz |
|---|---|---|
| `AI_TELEMETRY_RETENTION_DAYS` | `400` | `llm_calls`, `metrics`, `skill_activations`, `ai_router_decisions` e o traço do turno (`agent_turn_traces`, 9021). Piso de **100** dias. |
| `PACING_LEDGER_RETENTION_DAYS` | `2` | `pacing_ledger`. Piso de **2**; o último envio de cada número nunca sai. |
| `OUTBOUND_COPIES_RETENTION_DAYS` | `30` | `outbound_copies`. Piso de **7**; as últimas que o anti-repetição compara nunca saem. |
| `LEAD_CHECKPOINT_RETENTION_DAYS` | `180` | `lead_checkpoints` já superados. Piso de **30**; o vigente de cada atendimento nunca sai. |

O traço do turno tem um [leitor técnico pela API](../specs/leitor-tecnico-do-traco-do-turno.md), restrito a gerentes da organização. Ele explicita o limite consultável e projeta recibos sem mensagens livres de erro. É uma entrega parcial: a tela permanece na issue #3201; uma lista vazia não prova que houve expurgo.

`event_log` não tem poda, de propósito: é o livro-razão que impede os gatilhos
de tempo de reenviarem WhatsApp.

O piso do audit não é sugestão de estilo: ele mora **dentro** de
`fn_expurgar_auditoria_vencida`, então nem quem tem a chave de serviço apaga
rastro com menos de 90 dias por esse caminho. A função não aceita organização,
ator, ação nem id — só idade.

Depois de mudar qualquer uma delas:

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
daquela tabela, rode para cada tabela que o ranking de §4 apontou (por exemplo
`job_queue`, `api_audit_log`, `llm_calls`, `metrics`, `pacing_ledger`), uma de
cada vez:

```bash
psql_vps -c "vacuum (full, analyze) public.<tabela>;"
```

Quanto está morto e ainda não foi reaproveitado, antes de decidir:

```bash
psql_vps -c \
  "select relname, n_live_tup, n_dead_tup, last_autovacuum
     from pg_stat_user_tables
    where relname in ('job_queue','api_audit_log','send_ledger','before_send_traces');"
```

## 5. Log ingestion é outra cota — o aviso “Log Ingestion Exceeded”

Se o aviso que chegou no e-mail de cobrança ou no banner do painel diz **“Log
Ingestion Exceeded”**, o aperto não é egress (§3) nem disco (§4): é o **volume de
log** que o Supabase ingeriu no ciclo. É a cota que estoura com o sistema
parado — e a que quase ninguém procura, porque o texto do aviso não aparece em
lugar nenhum do sistema.

### 5.1. O que a cota é

No plano free a cota incluída é de **1 GB de log ingerido por ciclo**, e o
excedente **não é cobrado**: a linha do free na tabela de preços é “Not billed”, e
o caminho para quem passa do teto é a restrição do §5.2, não a fatura
([*Manage Logs Ingest usage*](https://supabase.com/docs/guides/platform/manage-your-usage/logs-ingest),
lida em 06/11/2026).

O que conta é o que o Supabase **ingere** de todos os serviços do projeto —
Postgres, API gateway, Auth, Storage, Realtime, Edge Functions —, medido por byte.
Não é o que o seu contêiner escreve no `docker logs`. O número oficial está em
**Settings → Usage**, na linha “Logs Ingest”.

**A cobrança deste item ainda não começou.** A mesma página avisa que há uma
carência até o início de 2027 antes de a fatura valer, e o painel de uma
instalação no free mostra o mesmo texto (“Billing starts after the grace period
ends in early 2027”). Ou seja: a cota existe e é ela que dispara o aviso, mas o
excedente hoje não vira dinheiro — e isso muda sozinho. Confira a data na página
antes de contar com a carência.

### 5.2. O que o aviso significa, e por que a segunda vez é pior

O aviso não corta nada na hora. O caminho tem ordem, e a ordem é a informação:

| passo | o que acontece |
|---|---|
| 1. aviso | notificação no e-mail de cobrança da organização; o consumo acima da cota aparece no painel de uso |
| 2. carência | período antes de qualquer restrição — é a janela para corrigir sem queda |
| 3. Fair Use Policy | passada a carência, a restrição vem por serviço: **projeto pausado**, **banco em somente leitura**, novos projetos bloqueados e **402** para toda requisição à API. Vale para todos os projetos da organização |

**O segundo estouro não tem carência.** Depois que a carência termina, o painel
continua mostrando o aviso mesmo se o consumo voltar para baixo — é o registro de
que a organização já estourou. Estourando de novo, a restrição entra **sem** nova
carência; o aviso só some depois de vários ciclos abaixo do teto. A restrição por
cota cai sozinha quando a cota se renova no início do ciclo seguinte (com um
atraso curto depois da virada) ou na hora, se a organização passa para um plano
pago. ([*Billing FAQ — Fair Use Policy*](https://supabase.com/docs/guides/platform/billing-faq#fair-use-policy),
lida em 06/11/2026)

### 5.3. O que consome

O log cresce com o **número de chamadas**, não com o tamanho da resposta: cada
requisição que chega ao PostgREST, ao Auth e ao Realtime vira linha ingerida.
Duas medições do projeto, em instalações diferentes:

- **#2235** — um ciclo fechou com **99 GB contra o 1 GB do free**: pico de
  ~15 GB/dia entre 12 e 17/09 e, depois, **~0,3–0,5 GB/dia** em regime, sem
  ninguém mexer no sistema.
- **#4103** (relato da comunidade, 01–05/11) — **0,74 GB de 1 GB em cinco dias**,
  entre ~100 e ~164 MB por dia, numa instalação do kit com pouco volume de
  atendimento.

O que produz essas chamadas, na ordem em que costuma aparecer:

- **A fila ociosa.** Com `QUEUE_IDLE_MAX_INTERVAL_MS` desligado — o default da
  §2 —, a instalação parada consulta o banco a cada piso: 3.880 consultas em 2h19
  (~28/min), medido na **#3688**. Com `60000`, cai para ~1/min.
- **Cron duplicado.** O `event-log-drain` era chamado pelo contêiner `scheduler`
  (de minuto em minuto) **e** pelo crontab do host que o kit provisiona; na
  **#2235**, ~62% das chamadas `service_role` ao PostgREST eram da `event_log`.
  Desde a #2235 a linha do host é **vigia**: roda de 15 em 15 minutos e só
  dispara o dreno quando o contêiner `scheduler` desta instalação não está de pé
  (`hostgator-setup-kit/drain-watchdog.sh`). Instalação saudável: ~4 chamadas por
  hora em vez de 60, e a redundância continua existindo para o dia em que o
  scheduler cair. Se o seu número não caiu, confira as DUAS entradas antes de
  acusar o worker:

  ```bash
  docker compose -f docker-compose.prod.yml exec scheduler crontab -l | grep event-log-drain   # a linha de 1 min
  crontab -l | grep event-log-drain                                                             # a do host
  ```

  Uma linha de minuto no crontab do **host** é instalação anterior a este
  conserto: rode o `update.sh` (ele regrava a linha como vigia) ou troque a
  cadência à mão para `*/15`.
- **Painel aberto.** Telas com refetch de 5 s (painel de atualização, detalhe do
  compromisso, revisão de resposta) chamam PostgREST e `getUser` em laço: na
  **#2235**, ~264 req/min com abas abertas contra ~85–91/min com todas fechadas.
  Aba esquecida é chamada que continua com ninguém usando o sistema.

### 5.4. O que fazer — e o que não resolve

Meça antes (§1) e ataque a origem que a medição apontar:

- Ligue o recuo da fila: `QUEUE_IDLE_MAX_INTERVAL_MS=60000` no `.env` e
  `up -d worker` (§2).
- Confira o `event-log-drain` no contêiner e no crontab do host (§5.3).
- Feche as abas do painel que ficam abertas o dia inteiro — o intervalo de refetch
  é do produto, não do `.env`.
- Espere **um ou dois dias** e olhe a tendência no painel de uso e no Logs
  Explorer antes de concluir: o volume varia de dia para dia, e uma leitura
  isolada engana (é o mesmo conselho da doc oficial).

**O que não resolve:** ajustar a retenção ou rodar `VACUUM` (§4) não muda uma
linha de log ingerido — é outra cota, e nenhuma tabela encolhe por causa dela.
Também não basta pausar o projeto para “limpar” o consumo: pausar ou apagar para
de acumular, mas o que já foi ingerido no ciclo continua contando até a virada.

## 6. Quando o compute Nano do plano grátis não basta

O sintoma não é lentidão, é indisponibilidade: o projeto fica fora do ar **sem ninguém usando**, toda chamada a
`/rest/v1` responde `522` ou `503 PGRST002`, e o `/api/v1/health` diz `supabase: down` com
`reason: projeto_indisponivel`.

**O que foi medido, e em quantas instalações.** Uma instalação, em 29/10, no compute Nano (0,5 GB): ~6 h fora do ar,
que só voltou com *Restart project*. O schema tinha 213 tabelas, 584 funções, 684 policies, 759 índices e 222
triggers; a introspecção do schema cache do PostgREST leva ~722 ms com o banco saudável, contra o `statement_timeout`
de 8 s do papel `authenticator`. Naquela instalação, a Nano entrou em swap, esgotou o *Disk IO Budget*, e essa
consulta passou do teto: o cache se perdeu e o PostgREST ficou em laço. **Não está medido** se a Nano falha assim
em toda instalação: o plano grátis continua sendo o caminho documentado de instalação.

**Se acontecer com você:** *Restart project* devolve o serviço. Se voltar a cair parado, subir o compute para
**Micro (1 GB)** é o próximo passo a testar: dá o dobro de memória à introspecção. **Não está medido que resolva:**
na instalação medida (29/10), quem devolveu o serviço foi o *Restart project*. Antes de trocar, confirme que é este ramo e não o
replay do gateway: `postgrest-replay-do-gateway.md` (seção "Outro ramo: falta de memória/IO") e
`supabase-compute-insuficiente-free.md`.

**Micro só existe em plano pago, e assinar não troca o compute.** O plano grátis roda o Nano e o Micro é dos planos
pagos, então este passo são dois atos: assinar um plano pago e depois trocar o compute do projeto. O projeto que veio
do grátis pode continuar no Nano (0,5 GB) dentro do plano pago, cobrado pelo preço do Micro, até você trocar. O
Supabase não troca sozinho porque a troca causa uma queda, em geral de menos de 2 minutos segundo a doc
([*Compute and Disk*](https://supabase.com/docs/guides/platform/compute-and-disk)).

O plano e os US$ 10/mês em créditos de compute são da organização, não de cada projeto: o crédito cobre um projeto no
Micro, e cada projeto a mais soma o compute dele. **Exemplo lido na doc oficial em 05/11/2026**, não orçamento: Pro
US$ 25/mês + Micro US$ 0,01344/h (~US$ 10/mês) − US$ 10 de crédito ≈ **US$ 25/mês** com um projeto; com dois projetos
no Micro, ≈ **US$ 35/mês**. Preço e crédito mudam; confira os valores e o que o crédito cobre em
<https://supabase.com/docs/guides/platform/manage-your-usage/compute> antes de trocar o compute.

## 7. Se ainda não fechar

Abra uma issue com: a saída dos três comandos da seção 1, a janela de tempo que
elas cobrem, e o painel **Usage** do Supabase no mesmo período. Medição sem a
janela declarada não compara — foi a única lacuna que a issue #258 deixou em
aberto.
