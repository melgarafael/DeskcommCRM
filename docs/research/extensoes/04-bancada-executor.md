# Bancada do executor de extensões

Medido em 2026-09-14, sobre a bancada isolada de `experiments/extensoes/runtime/`.
**CONFIRMADO:** os 14 controles do ensaio passaram em Wasmtime 48.0.0, macOS ARM64,
Python 3.14.6 e Node 22.22.3. Na primeira rodada, a comparação com contêiner ficou
**bloqueada**: o daemon não respondeu ao `/_ping` em dois segundos nos dois sockets
locais testados. Após a recuperação autorizada, o perfil separado foi executado;
resultados e limites estão no [relatório 07](07-perfil-comparacao-executor.md).
Isso não prova a integração ao CRM nem conclui a escolha de implantação na VPS.

## Pergunta e fronteira testada

O ensaio pergunta se um módulo Wasm core consegue executar uma capacidade sintética,
sem escolher a organização ou o ator do host, e se falhas de execução ficam contidas.
O guest recebe somente um ID inteiro de registro. O broker mantém organização,
ator e concessões num objeto imutável do lado Python e confere o registro antes da
leitura. Dois registros sintéticos pertencem a organizações diferentes; nenhum
banco do CRM participa deste ensaio.

Não há configuração WASI, diretório preaberto, socket, variável de ambiente ou
credencial entregue ao guest. O processo Python confiável lê as fixtures locais e
a biblioteca Wasmtime. O supervisor Node inicia esse processo com ambiente constante
contendo apenas `PATH`, `LANG` e `PYTHONIOENCODING`, e Python em modo isolado `-I`.
O parâmetro `databaseUrl` do contrato comum é ignorado por esta frente.

## Reprodução

Com o ambiente virtual da bancada já preparado com `wasmtime==48.0.0` e
executável Python regular (`python -m venv --copies` na criação):

```bash
node experiments/extensoes/runtime/verify.mjs
pnpm exec eslint experiments/extensoes/runtime/*.mjs
node --test experiments/extensoes/runtime/workspace.test.mjs
```

O primeiro comando executa Wasmtime de fato, valida o contrato e grava todas as
amostras em `.superpowers/evidence/extensoes-bancada/runtime-report.json`.
O verificador **não aceita argumento de diretório alternativo**. Raiz e evidências
precisam corresponder à worktree do próprio módulo e à sua área marcada
`.superpowers/evidence/extensoes-bancada`. O Python é procurado somente em
`<evidenceDir>/venv/bin/python`. O teste de propriedade usa áreas sintéticas para
verificar que venv ausente produz `blocked` apenas dentro de uma área própria;
contexto externo ou simbólico é recusado antes de executar ou escrever.

A integração usa `runProbe({ repoRoot, evidenceDir, databaseUrl })` exportado em
`experiments/extensoes/runtime/probe.mjs`. Erros inesperados produzem `failed`.
`passed` cobre os controles executados; o objeto separado
`measurements.container_comparison.status` informa `not_run`: este comando não roda
o perfil Docker. `daemon_status` informa separadamente `ready` ou `blocked`. Os
relatórios históricos anteriores a essa separação usavam `blocked` nesse campo;
uma resposta ao ping não comprova execução nem valida os limites do contêiner.

## Correção da fronteira de evidências — revisão F5

**CONFIRMADO em 2026-09-14:** treze testes focados passaram, sem repetir os quatorze
controles Wasmtime já aceitos pela revisão. A raiz confiável deriva da localização
de `workspace.mjs`; nenhum parâmetro permite trocá-la. O caminho informado deve ser
exatamente a área canônica, com propriedade conferida por `ensureOwnedWorkspace`.
Os caminhos existentes são inspecionados antes que essa política crie diretórios
ou marcador. Os diretórios até o venv, seu executável Python, o script do probe,
o marcador e o relatório não podem ser links simbólicos. Cada novo subprocesso
repete o preflight; venv ausente é diferente de venv desviado.

O relatório é escrito em temporário exclusivo de nome aleatório, aberto com
`O_EXCL | O_NOFOLLOW`, sincronizado e renomeado. O destino é inspecionado antes da
escrita e novamente antes da substituição. O teste confirmou troca do inode do
arquivo próprio, modo `0600`, JSON completo e ausência de temporário restante.

As provas criam duas worktrees **sintéticas** em diretório temporário exclusivo.
A segunda contém uma sentinela de relatório e um falso Python que deixaria um
marcador caso executado. Caminho externo, raiz alheia, marcador alheio e links
simbólicos foram recusados sem alterar a sentinela nem criar o marcador de execução.
A API instalada e o CLI também foram exercitados contra esse destino sintético.
Nenhuma pasta ou evidência real de outra sessão foi usada como alvo.

Política de venv: o interpretador dentro da bancada deve ser arquivo regular.
O venv desta worktree originalmente tinha os links normais do Python; após
conferir sua propriedade e o destino conhecido dos três links, eles foram
substituídos por cópias via `venv --copies`, preservando as dependências.
Um smoke test pelo caminho validado confirmou o pin 48.0.0 e a chamada válida
retornando 41. Essa escolha evita uma exceção de link que pudesse executar um
venv externo acidentalmente. Ela não torna o interpretador independente das
bibliotecas do Python instalado no sistema.

**Limite:** as verificações recusam caminhos já desviados e os reconferem antes
das operações, mas não são isolamento contra outro processo local malicioso com
o mesmo usuário que substitua diretórios entre `lstat` e a operação seguinte.
Não há `openat`/descritor de diretório ancorado para toda a árvore nem auditoria
recursiva dos pacotes do venv. A fronteira do guest Wasm permanece a descrita no
ensaio original; F5 trata de propriedade e desvio acidental de evidências locais.

## Parâmetros experimentais

| Recurso | Limite usado | Onde é imposto |
|---|---:|---|
| Execução do guest | 100.000 unidades de fuel | Store do Wasmtime |
| Memória linear | 131.072 bytes, uma memória | Store do Wasmtime |
| Instâncias/tabelas | Uma instância, uma tabela, 100 elementos | Store do Wasmtime |
| Saída do guest | 1.024 bytes acumulados por execução | Broker, antes da cópia |
| Protocolo stdout + stderr do processo | 131.072 bytes | Supervisor Node |
| Prazo total de processo | 10.000 ms | Supervisor Node |
| Chamada do host travada | 750 ms após entrada confirmada | Supervisor Node |
| Concorrência | Dois processos para oito tarefas | Fila local da bancada |

Os limites são parâmetros do ensaio, não SLA ou orçamento publicado do produto.
`Store.set_limits` cobre a memória linear, não o RSS inteiro do processo.
`consume_fuel` e `set_fuel` habilitam o limite de execução do guest.
Essas APIs foram conferidas na [documentação oficial do binding Python](https://bytecodealliance.github.io/wasmtime-py/).

## Resultados dos controles

| Controle | Resultado observado |
|---|---|
| Capacidade autorizada | `read_record(1)` devolveu 41; auditoria sintética preservou organização e ator do host |
| Outra organização | Registro 2 foi recusado com `capability_denied` |
| Sem concessão | Leitura do registro da própria organização foi recusada |
| Filesystem | Import `wasi_snapshot_preview1::path_open` recusado na instanciação |
| Rede | Import `wasi_snapshot_preview1::sock_accept` recusado na instanciação |
| Loop infinito | Trap por esgotamento de fuel |
| Memória inicial excessiva | Instanciação com três páginas recusada |
| Crescimento excessivo | `memory.grow(2)` retornou -1; memória continuou em uma página |
| Saída excessiva | 1.025 bytes recusados antes da cópia |
| Saída cumulativa | Duas emissões de 600 bytes recusadas ao ultrapassar a cota |
| Saída no limite | 1.024 bytes aceitos |
| Versão | Binding instalado conferido como 48.0.0 |
| Host travado | `SIGKILL`, processo ausente e nova execução retornando 41 |
| Concorrência | Oito tarefas válidas, máximo observado de dois processos ativos |

Cada um dos onze controles Python termina com uma nova instância válida retornando
41 no mesmo processo. O controle de host travado usa um processo separado e confirma
a recuperação com outro processo. A rejeição de saída cumulativa pode preservar o
prefixo de 600 bytes no buffer interno; ele não é publicado pela bancada.

O teste de rede mede resolução de imports, sem tentar egress real. Wasm só dispõe
das interfaces explicitamente ligadas pelo host; a prova não cobre uma futura
capacidade HTTP concedida, nem seus controles de destino. A fronteira é descrita
na [documentação de segurança do Wasmtime](https://docs.wasmtime.dev/security.html).

## Medições da execução registrada

| Medida | Amostra | Resultado |
|---|---:|---|
| Processo novo: Python, import, compilação WAT, instanciação e chamada | 5 | Média 135,476 ms; mínimo 127,088; máximo 151,700 |
| Engine + compilação + instanciação + chamada, após imports Python | 5 | Média 2,423 ms; mínimo 2,240; máximo 2,585 |
| Chamada quente na mesma instância, incluindo broker Python | 50 | Média 0,026497 ms; mínimo 0,023625; máximo 0,082709 |
| Oito processos novos em fila com concorrência dois | 8 | Total 779,062 ms; média por processo 193,084 ms |
| Pico RSS do processo da suíte | 1 | 40.239.104 bytes |
| Pico RSS individual dos processos concorrentes | 8 | 36.372.480 a 36.962.304 bytes |
| CPU de usuário + sistema do processo da suíte | 1 | 0,152515 s |
| Encerramento após entrada no host travado | 1 | 754,245 ms; prazo configurado 750 ms |

Amostras de processo novo, em ms: `135.214459, 129.858084, 127.088250,
133.518125, 151.700291`. As cinquenta amostras quentes e as oito concorrentes estão
preservadas no JSON da evidência. São medidas de uma máquina compartilhada:
processo novo não significa cache de disco frio. Não foram publicados percentis
nem projeções de capacidade. O pico RSS usa `getrusage`: bytes no macOS, convertido
de KiB nos sistemas Linux. Picos individuais não representam pico simultâneo total.

O supervisor começa o prazo específico quando recebe a confirmação de entrada da
função host que dorme indefinidamente. Ao vencer, envia `SIGKILL`; só resolve depois
do evento `close` e verifica `ESRCH` ao consultar o PID. Não é apenas uma promessa
abandonada por timeout. O prazo total continua protegendo a fase anterior à entrada.
O desvio de aproximadamente 4 ms observado é atraso de agendamento/encerramento,
não promessa de precisão do temporizador.

## Comparação com contêiner

Na rodada histórica deste relatório, `GET /_ping` em `/var/run/docker.sock` e `~/.docker/run/docker.sock` expirou em
2.006,889 e 2.003,011 ms, respectivamente. Nenhum contêiner foi criado, nenhum daemon
reiniciado e nenhum serviço compartilhado alterado. Perfil e medições de contêiner
ficaram `null` no relatório.

O daemon foi recuperado depois, por autorização explícita. O perfil separado usa
imagem imutável e limites inspecionados; sua rodada real e cinco provas de limites
passaram, conforme o relatório 07. Este comando Wasmtime continua apenas
diagnosticando disponibilidade do Docker. Comparação de custo em VPS e broker
equivalente seguem pendentes; os dois percursos locais não medem a mesma fronteira.

## Consequência para a arquitetura

**CONFIRMADO:** a combinação testada contém o loop infinito, as tentativas de
memória/saída excessivas e a chamada host travada. A autoridade mantida no broker
recusa acesso cruzado no conjunto sintético. O desenho de executor separado e
supervisionado tem uma prova de mecanismo reproduzível.

**INFERIDO:** reutilização controlada de módulos/engines pode amortizar a inicialização,
porque a chamada quente desta fixture é muito menor que o processo novo. A bancada
não mede o custo de um SDK JavaScript, de JSON real, do broker remoto ou de isolamento
entre sucessivas execuções reais; ainda não justifica escolher um pool de produção.

**PENDENTE:** Linux amd64 com quotas de processo, comparação equivalente com contêiner, carga
prolongada e competição entre organizações; limites de compilação de artefatos grandes;
Component Model/WIT; validação de pacote real; transporte, autenticação e RBAC do
broker do CRM; persistência transacional e cancelamento/idempotência de efeitos
remotos. Matar o processo não desfaz uma requisição já aceita por outro serviço.
O experimento não escolhe Python como linguagem de entrega nem torna extensões um
recurso pronto do produto.
