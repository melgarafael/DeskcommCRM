# Bancada de eventos: captura, entrega e efeito incerto

Este documento cobre a prova de mecanismo da tarefa 3 do PROG-019. O código vive em
`experiments/extensoes/events/`; ele não implementa extensões no runtime do CRM.

## Pergunta e fronteira

**CONFIRMADO na fonte:** a migration
`supabase/migrations/20260912200000_0239_registro_nao_fica_pendente.sql` faz
`contact.updated`, entre outros fatos, nascer `done`. O comando
`message.send_requested` permanece `pending`. Capturar apenas a fila pendente perde
esses fatos. O PROG-017 propõe uma caixa de saída curta no INSERT, seguida de
desdobramento assíncrono por destino.

**Reaproveitamento literal:** o probe extrai a declaração inteira de `event_log`
do baseline, preservando colunas, defaults e checks; acrescenta a chave primária
de `id`. Também lê a migration 0239 desde a primeira função, preservando as duas
funções, lista de tipos, trigger BEFORE INSERT e backfill. As transformações são
somente `public` → schema exclusivo no qual o experimento roda, ajuste correspondente
de `search_path` e remoção das linhas `revoke`/`grant`/`notify`, que dependem dos
papéis Supabase ou PostgREST. O JSON registra os hashes SHA-256 das duas fontes e
salva o SQL transformado como evidência. Alterações futuras na fonte são percebidas
na próxima execução; a bancada não mantém uma cópia divergente da lista de fatos.

**Fixture experimental:** `fixture.sql` acrescenta assinaturas fixas na revisão 1,
caixa de saída, recibos por destino e dois livros de efeitos sintéticos. Não são
migrations publicáveis. Não aplica o baseline completo, índices adicionais,
FK para organizações, RLS/Auth, `emit_event` atual, dreno real ou domínio de contatos.
O fato é inserido por SQL com payload explícito `{"synthetic":true}`. A semântica
de nascimento da 0239 é real; a emissão pela tela, autorização e integração ao CRM
seguem pendentes de ambiente completo.

Cada execução cria `bench_events_<uuid>` e o conserva para inspeção. Não há DROP,
TRUNCATE, alteração de `public`, reinício de Docker ou leitura de `.env`. O DSN
precisa corresponder ao cluster dedicado criado pela bancada. Antes de criar qualquer
schema, `connectBenchDatabase` verifica o DSN contra o marcador da worktree e atesta
o próprio cliente conectado, que será usado pelo ensaio. Não há uma conexão de
checagem separada seguida por outra não atestada. `connectEventsDatabase` aplica
`search_path` e timeout somente depois desse retorno; origem, consumidores, observador,
receiver e subprocessos usam esse caminho. A fábrica comum fixa os parâmetros de
conexão, sem fallback para credenciais do ambiente. Loopback sozinho não basta para
autorizar a execução. Subprocessos recebem apenas ambiente mínimo e o contexto
sintético completo por IPC, sem herdar credenciais do shell.

## Desenho anterior à medição

Os parâmetros estão em `PLAN` no probe e são gravados no relatório antes de medir:

| Ensaio | Amostra e limite experimental |
|---|---|
| Captura, rollback, ordem de commits, concorrência e reinício | 3 repetições |
| Receiver lento e efeito com resposta perdida | 3 repetições, HTTP real em porta efêmera |
| INSERT com/sem captura | 20 aquecimentos por braço; 5 lotes de 100 por braço; ordem alternada |
| Recuperação local | Lease de 200 ms; subprocesso SIGKILL após claim e antes de efeito |
| HTTP | Limite de 1.000 ms por chamada |
| Lock da caixa de saída | 3 repetições; observar até 2.000 ms; depois manter por mais 100 ms |
| SQL | `statement_timeout` de 5.000 ms |

Os números limitam o experimento e **não** são SLA ou orçamento aprovado do produto.
Os INSERTs usam autocommit, a mesma conexão, tabela e payload nos dois braços.
A alteração do trigger e o aquecimento ficam fora das amostras. O trigger 0239
permanece ligado em ambos. A medição inclui Node, round-trip loopback e commit;
não isola CPU do trigger nem mede contenção de uma VPS em produção. O JSON contém
as amostras individuais, média, p50, p95, máximo e diferença de médias.

## O que cada verificação demonstra

- `done_capture`: AFTER INSERT captura fato `done` e comando `pending` sem mudar
  o significado de nenhum dos dois estados.
- `rollback_*`: evento, caixa e recibos criados na transação desaparecem juntos
  no rollback. Não há recibo fantasma.
- `commit_order`: transação A cria antes e confirma depois de B; a caixa conserva
  ambas. Um cursor só por `created_at` teria uma fronteira insegura nesse caso.
- `concurrency_fanout_duplicate_*`: duas conexões desdobram o mesmo fato; existem
  três recibos, um por destino/assinatura/revisão, com versão exata. Dois consumidores
  disputam o mesmo destino com `FOR UPDATE SKIP LOCKED`; só um obtém o claim.
  Um destino distinto avança independentemente. Repetir a conclusão não duplica
  o efeito local, que compartilha transação com a troca de estado.
- `lease_restart_*`: subprocesso real sofre `SIGKILL` depois do claim; outro
  processo recupera após expiração. A conclusão pelo token antigo é recusada.
  Esse caso não simula um POST que já saiu antes de o processo morrer.
- `core_untouched_*`: os registros usados preservam status, `attempts` e
  `consumed_by` após entregar. O dreno real não roda na bancada; não se conclui
  compatibilidade completa com seus handlers.
- `subscription_scope`: assinatura da organização A não gera entrega para B.
  É prova do filtro da fixture, não substitui teste de RLS.
- `slow_receiver_*`: o receiver segura a resposta; enquanto ela está pendente,
  outro INSERT e um efeito local concluem. Nenhum HTTP acontece dentro do trigger
  ou da transação de origem.
- `uncertain_effect`: receiver confirma efeito no banco por conexão independente
  e destrói o socket antes de responder. O envio fica `uncertain`; mesmo após
  vencer o lease, o claim automático não o seleciona. O livro do receiver prova
  uma ocorrência. O worker não lê esse livro para fingir sucesso: o próximo passo
  declarado é reconciliação por identidade ou tarefa humana.
- `outbox_blocks_origin_*`: outra transação segura `ACCESS EXCLUSIVE` na caixa.
  `pg_stat_activity` e `pg_blocking_pids` mostram que o INSERT está esperando lock;
  após liberar a caixa, a origem conclui. A prova mede a dependência causal,
  independentemente da velocidade da máquina.

## Executar e auditar

Com o cluster exclusivo já preparado, na raiz da worktree:

```sh
node experiments/extensoes/events/probe.mjs
```

O console chama a mesma interface exportada:

```js
const report = await runProbe({ databaseUrl, repoRoot, evidenceDir });
```

Saídas: `events-report.json` e `events-applied-0239.sql`. Ausência do DSN retorna
`blocked`; erro inesperado retorna `failed`, nunca sucesso. `passed` exige todas as
verificações executadas verdes e continua limitado ao escopo de mecanismo descrito.

A integração da fábrica de conexões tem verificação dirigida independente:

```sh
node --test experiments/extensoes/events/connection.test.mjs
```

Ela abre os quatro clientes físicos, confere suas identidades e schemas, executa
um worker real com contexto válido, recusa contexto divergente em outro subprocesso
e grava um efeito via receiver HTTP real, consultado pelo observador independente.
Não repete o benchmark nem reclassifica suas medições históricas.

Na integração F1/F4, essa verificação passou (1 teste, 0 falhas); evidência em
`.superpowers/evidence/extensoes-bancada/events-connection-test.tap`. A revisão anterior
do mecanismo e a fotografia das 29 verificações continuam com suas datas e escopos.

## Consequência arquitetural

O desenho a validar conserva uma entrada curta por fato e faz fan-out fora da
transação original. Unicidade no banco e conclusão local atômica são necessárias
para lidar com repetição; lease sozinho não impede duplicação de efeito externo.
Depois do ponto de envio, resultado incerto deve bloquear repetição automática.

Uma caixa transacional inevitavelmente participa da gravação da origem. A decisão
de adotar esse mecanismo precisa aceitar e observar essa dependência, inclusive
retenção, locks, capacidade e recuperação. Engolir falha do trigger faria a gravação
parecer saudável enquanto perde a garantia de entrega.

## Resultado medido

**CONFIRMADO em 2026-09-14, 21:20:32–21:20:35 UTC:** 29 verificações passaram em
Node 22.22.3, macOS ARM64 e PostgreSQL 16.10 (Homebrew). A execução usou o schema
`bench_events_8b79b7af6dc54c5abd3d38d5cbfa4539` do cluster exclusivo. A fotografia
auditada fica em `.superpowers/evidence/extensoes-bancada/events-reviewed-report.json`;
`events-report.json` representa a execução mais recente e pode mudar quando o console
rodar novamente. Não houve alteração do banco do produto.

| INSERT, 500 amostras por braço | Média | p50 | p95 | Máximo |
|---|---:|---:|---:|---:|
| Sem captura experimental | 0,2165 ms | 0,1810 ms | 0,3566 ms | 1,3281 ms |
| Com captura experimental | 0,2180 ms | 0,1980 ms | 0,3119 ms | 0,6724 ms |

A diferença de médias foi +0,0015 ms nesta execução. Ela é pequena diante da
dispersão da amostra, sem intervalo de confiança ou isolamento da carga do host;
**não demonstra um custo garantido nem permite fixar orçamento do produto**.
O achado causal é mais forte: os três bloqueios reais na caixa produziram espera
`Lock/relation` no INSERT, com conclusão após aproximadamente 103,6 / 101,9 / 102,4 ms
(incluindo os 100 ms deliberados do ensaio).

As três rodadas de rollback deixaram zero eventos, caixas e recibos fantasmas.
As três confirmações fora da ordem preservaram ambos os eventos. Cada fan-out
concorrente conservou três recibos, e as duas disputas pelo mesmo destino tiveram
um vencedor; os dois destinos locais produziram dois efeitos no total. Três
subprocessos mortos por `SIGKILL` foram retomados com tentativa 2. O token anterior
foi recusado enquanto o novo dono ainda estava `processing`, antes da conclusão,
provando a guarda do token além da guarda de estado.

Os três receivers com resposta perdida consumaram um efeito cada, enquanto o
host registrou `uncertain`, uma tentativa e nenhuma elegibilidade automática após
o lease. A confirmação permaneceu pendente: esta bancada não implementa um protocolo
de reconciliação de um provedor real. O receiver lento permitiu outras gravações e
outro destino avançarem antes de liberar sua resposta.

**Decisão técnica sustentada pelo ensaio:** manter a caixa curta transacional como
candidata viável para a próxima prova no CRM, com fan-out durável e independente.
A prova não elimina seu custo nem autoriza prometer exatamente uma vez externo.
Permanecem fora desta bancada: integração ao CRM pela tela, baseline completo no
piso pg15, atualização de assinaturas, autorização de execução, expurgo/anonimização,
backpressure e consumo sob carga prolongada.
