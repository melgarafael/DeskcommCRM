# Perfil reproduzível de comparação com contêiner

**Estado em 2026-09-14: rodada real de quinze contêineres aprovada e cinco provas
dirigidas de enforcement aprovadas, no perfil Linux arm64.** O bloqueio inicial
foi resolvido pelo principal após autorização do usuário para recuperar Docker.
A imagem fixa foi baixada e conferida; os recursos próprios foram removidos e sua
ausência reconsultada na API. Estes resultados substituem a condição inicial de
comparação não executada. O resultado Wasmtime do [relatório 04](04-bancada-executor.md)
continua separado: diferenças de workload, supervisão e VM impedem escolher
executor pela comparação direta desses tempos. Nenhuma escolha de produto foi feita.

## O que será comparado

O perfil mede uma fixture Node 22 em contêiner Linux, usando a mesma operação
funcional sintética da bancada Wasm: registro 1 pertence à organização A e devolve
41; registro 2 pertence à B e é recusado; concessão ausente também é recusada.
Organização e ator são constantes da fixture, não campos de entrada do registro.

**A equivalência é funcional, não de fronteira de segurança.** No Wasm, o módulo
importa uma função do broker Python externo ao guest. Aqui, uma closure Node simula
essa leitura no mesmo processo da fixture revisada. Ela não protege a autoridade
de um broker real contra uma extensão JavaScript hostil. A prova de autorização
do CRM permanece pendente nos dois perfis.

Node dentro do contêiner tem APIs de sistema operacional, pode ler arquivos da
imagem e dispõe de loopback. Read-only impede escrita no rootfs, não leitura.
O perfil não usa `node:vm`, Permission Model ou outra camada com alegação de
isolar código hostil dentro de Node. A operação sem rede do workload evita
transferir dados/credenciais e torna esta rodada pequena; não mede a futura porta
de capacidades via transporte real. A [documentação oficial de rede `none`](https://docs.docker.com/engine/network/drivers/none/)
explicita a presença do dispositivo loopback.

## Imagem fixa e verificável

Origem: imagem oficial `docker.io/library/node`, identificada a partir da tag
`22.22.3-bookworm-slim` em 2026-09-14. A tag serve como proveniência legível;
**o runner faz pull/create por digest do manifesto da plataforma**, nunca por tag
móvel. A manutenção upstream é apresentada na [página oficial da imagem Node](https://hub.docker.com/_/node).

| Artefato | Digest SHA-256 |
|---|---|
| Índice OCI | `e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752` |
| Linux amd64 | `16d364eebf6b62da439dc993d9b80940c78b0ca38438452f011ab9a25c752644` |
| Linux arm64/v8 | `111d09056e51bb52d1bfca06a3e73476d6022b156dc4c36c5379503cd307660b` |

```bash
node experiments/extensoes/runtime/container/verify-image.mjs
```

O comando consulta somente metadados por HTTPS no Registry oficial, com token
anônimo e escopo público de leitura que não é impresso. Confere o hash dos bytes
do índice, o cabeçalho de digest e os dois manifestos filhos. Não usa daemon,
credenciais Docker locais ou downloads de camadas. Resultado executado:
`status=verified`, `downloaded_layers=0`, `local_docker_used=false`.

Digest fixa os bytes; não é laudo de ausência de vulnerabilidades. Atualizar a
imagem é mudança explícita de perfil e invalida a comparação direta com uma
rodada anterior. A bancada não republica a imagem upstream.

## Perfil pedido e conferido antes do start

| Recurso | Configuração experimental |
|---|---|
| CPU | `NanoCpus=500000000`: 0,5 CPU |
| Memória | 134.217.728 bytes: 128 MiB |
| Memória + swap | 128 MiB, igual à memória; sem orçamento adicional de swap |
| Processos/threads | `PidsLimit=32` |
| Usuário/grupo | UID/GID `65534:65534` |
| Rootfs | Read-only |
| Escrita temporária | `/tmp` em tmpfs de 8 MiB, `noexec,nosuid,nodev`, modo 1777 |
| Rede | `none`, sem publicação de portas |
| Capacidades Linux | Remover `ALL`, nenhuma adicionada |
| Privilégios | `Privileged=false`, `no-new-privileges:true` |
| Dispositivos/bind mounts/volumes | Nenhum solicitado; inspeção recusa mounts que não sejam tmpfs |
| Entrypoint | `/usr/local/bin/node`, sem shell intermediário |
| Heap V8 | `--max-old-space-size=32`; não substitui a cota de memória do contêiner |
| Entrada de código | String estática revisada em argv; sem bind mount da worktree |
| Ambiente declarado | PATH fixo, LANG=C, HOME=/tmp, NODE_OPTIONS vazio |
| Logs no daemon | Driver `local`, um arquivo de até 1 MiB, `compress=false` |
| Resposta do workload | Até 64 KiB no receptor; frames stdout/stderr decodificados e validados |
| Reinício automático | Desligado |
| Concorrência | Dois contêineres nas oito tarefas concorrentes |

O código confere `inspect` antes do primeiro start de cada contêiner. A divergência
em quota, usuário, entrada, segurança, opções de logs ou montagem reprova o ensaio e permite limpar
somente o recurso próprio já criado. Perfis padrão do daemon, como seccomp e
namespaces não configurados pelo runner, continuam dependentes de sua versão e
ambiente; o `HostConfig` efetivo é preservado na evidência e precisa ser examinado
na execução real. O perfil não solicita modo privilegiado nem compartilha PID/IPC
ou rede do host.

As propriedades são enviadas em JSON pela
[Engine API 1.45, cuja especificação também pode ser baixada](https://docs.docker.com/reference/api/engine/version/v1.45/).
O runner exige daemon Linux que aceite essa versão da API. Usa socket Unix local
diretamente: não executa o CLI Docker, não lê `config.json`, contextos ou `.env`,
não consulta `DOCKER_HOST` e não envia credenciais do processo. O contêiner recebe
somente o ambiente declarado e defaults não secretos da imagem fixa, sem variáveis
ou arquivos do operador.

## Execução reproduzível

Os comandos abaixo são opcionais e separados. O primeiro é somente diagnóstico;
o segundo baixa a imagem fixa; o terceiro executa as amostras. O runner não
reinicia Docker nem tenta reparar o ambiente. DEC-005 permanece uma decisão
operacional separada; a recuperação desta sessão foi autorizada e feita pelo principal.

```bash
# Sempre termina com prazo; nenhum pull/create/start.
node experiments/extensoes/runtime/container/runner.mjs --check

# Somente quando o preflight estiver ready: baixar a imagem upstream fixada.
node experiments/extensoes/runtime/container/runner.mjs --pull

# Exige imagem local conferida; nunca baixa implicitamente.
node experiments/extensoes/runtime/container/runner.mjs --run

# Cinco provas sequenciais, mesmas quotas; não repete as amostras de desempenho.
node experiments/extensoes/runtime/container/quotas.mjs
```

Sem argumento, o modo é `--check`. Os dois sockets conhecidos são tentados na ordem
`/var/run/docker.sock` e `~/.docker/run/docker.sock`. Cada requisição de preflight
tem limite de dois segundos. Indisponibilidade encerra com JSON `status=blocked`,
`measurements=null` e a razão, **antes de qualquer mutação Docker**. Isso foi
executado antes da recuperação do ambiente e também testado para os modos run/pull contra API
sintética indisponível. O modo `ready` de check/pull não significa comparação aprovada.

Com API disponível, o runner escolhe a arquitetura nativa declarada pelo daemon;
não força emulação amd64 num daemon ARM. Imagem local precisa ter digest,
arquitetura e OS esperados. A versão do Node/arquitetura/UID retornada pelo workload
é conferida novamente. Imagem ausente gera `blocked` e pede o modo pull explicitamente.

## Sequência de amostras e definição dos tempos

1. Cinco contêineres novos sequenciais executam o workload válido. Cada um mede
   cinquenta chamadas quentes na mesma instância Node.
2. Um contêiner roda loop infinito. Após `LOOP_ENTERED`, a espera tem prazo de
   1.500 ms; o supervisor envia SIGKILL ao ID próprio e confirma término, exit 137
   e ausência de OOM. Isso mede encerramento do guest Node, **não** o mesmo caso de
   função host Python travada da bancada Wasm.
3. Um novo contêiner válido confirma recuperação com retorno 41.
4. Oito contêineres novos rodam com concorrência máxima dois.
5. Todo contêiner é removido pelo ID, depois de conferir propriedade. Apenas uma
   rodada com limpeza concluída pode receber `passed`.

São quinze contêineres curtos por rodada, sem serviço residente. A imagem baixada
fica no cache; o runner não apaga imagens ou volumes. A medição
`create_start_wait_ms` inclui create/start/wait, inspeções e persistência do journal;
não inclui pull e não é custo puro de inicialização do Node. A duração concorrente
inclui o ciclo completo, inclusive leitura de resultado e cleanup. Chamadas quentes
usam `performance.now()` dentro de Node; RSS/CPU vêm de `process.resourceUsage()`.
Esses valores não incluem todo o custo do daemon, dos contêineres ou da VM.

Amostras individuais são preservadas: cinco tempos de ciclo, 5 × 50 chamadas
quentes, oito resultados concorrentes, encerramento e recuperação. Falha inesperada
reprova e não publica medições como comparação concluída. Os resultados de
performance são apresentados abaixo com esses limites de interpretação.

## Execução real e medições

Ambiente: Node supervisor v22.22.3 em darwin-arm64; Docker Desktop 4.43.2
confirmado pelo principal; Engine 28.3.2, API anunciada 1.51/mínima 1.24,
kernel `6.10.14-linuxkit`, daemon arm64. O runner usou a API 1.45 compatível.
Imagem local e referência de execução:
`sha256:111d09056e51bb52d1bfca06a3e73476d6022b156dc4c36c5379503cd307660b`.
O Node dentro do contêiner confirmou v22.22.3, Linux, arm64 e UID 65534.

A rodada aprovada é `dfd2a563-5927-4a4e-bf81-c84ef57e057e`. Seu journal fica em
`.superpowers/evidence/extensoes-bancada/container-dfd2a563-5927-4a4e-bf81-c84ef57e057e.json`,
com amostras brutas, IDs dos quinze recursos, limites e HostConfig efetivo.

| Medida | Amostra | Resultado real |
|---|---:|---|
| Ciclo instrumentado create/start/wait | 5 contêineres novos | Média 2.565,994 ms; mínimo 1.472,301; máximo 3.440,025 |
| Leitura quente da closure Node | 5 × 50 chamadas | Média 0,000645 ms; mínimo 0,000292; máximo 0,010209 |
| Execução concorrente, fila de dois workers | 8 contêineres | Total 15.799,870 ms, incluindo lifecycle e cleanup |
| Encerramento do loop após confirmação de entrada | 1 | 2.030,232 ms; inclui espera configurada de 1.500 ms + inspeção/kill/wait |
| Ciclo válido após o loop | 1 | 1.825,262 ms; valor 41, duas recusas esperadas |
| Pico RSS do processo Node | 14 processos válidos | 41.320.448 a 42.958.848 bytes |
| CPU do processo Node, usuário + sistema | 14 processos válidos | 107.275 a 307.210 μs |

Os cinco ciclos, em ms: `3252.959083, 1472.301166, 2195.077708,
2469.605875, 3440.025208`. Os dados da fila concorrente e todas as chamadas quentes
ficam no journal. A medição aprovada não foi repetida depois para melhorar números.

No Wasmtime anterior, cinco processos novos tiveram média 135,476 ms e cinquenta
chamadas quentes 0,026497 ms. **Esses percursos medem coisas diferentes:** o ciclo
de contêiner inclui API, inspeções e fsync do journal, enquanto o anterior mede spawn
Python; a closure Node evita a transição Wasm/FFI/broker Python. Além disso, um roda
na VM Linux e o outro nativamente no macOS. Portanto, esses valores não sustentam
uma razão de vantagem, capacidade da VPS ou equivalência de isolamento.

### Falha real corrigida antes da rodada aprovada

Duas tentativas iniciais falharam no start do único contêiner criado e o removeram.
A causa retornada pelo Engine foi `compression cannot be enabled when max file count is 1`.
O driver local comprime por padrão; o perfil agora declara `compress=false`, mantendo
um arquivo e o teto de 1 MiB, e o gate confere essa opção em inspect. A opção é
documentada pelo [driver oficial de logs local](https://docs.docker.com/engine/logging/drivers/local/).
O teste dirigido falhou antes da correção e passou depois; nenhuma quota de isolamento
foi relaxada. O cliente passou a conservar operação/status e mensagem JSON limitada
do erro da API, em vez de apenas `HTTP 500`.

## Provas dirigidas de enforcement

Rodada `f6826250-51ec-4b71-af8e-1a496bedcb2b`, no journal
`container-f6826250-51ec-4b71-af8e-1a496bedcb2b.json`: cinco contêineres sequenciais,
mesma imagem e mesmo HostConfig da rodada aprovada. Os testes conferem essa igualdade.
São resultados de mecanismo, sem novas amostras de performance.

| Prova | Evidência real e controle positivo | O que não foi confundido com sucesso |
|---|---|---|
| Rootfs somente leitura | Gravação/leitura em `/tmp` funcionou; criação em `/var/tmp` devolveu `EROFS` | `EACCES`, falta de diretório ou falha no controle não aprovam |
| Rede `none` | Servidor e cliente TCP em loopback trocaram dado sintético; conexão a `192.0.2.1:443` retornou `ENETUNREACH` | Timeout, falta de DNS ou loopback quebrado não aprovam |
| Memória no cgroup | `memory.max=134217728`; buffers externos preenchidos acima do orçamento terminaram com `OOMKilled=true` e exit 137 | Erro do heap V8, outro sinal ou cgroup diferente não aprovam |
| Processos/threads no cgroup | 25 `/bin/sleep` iniciaram; seguinte tentativa retornou `EAGAIN` com `pids.current=pids.max=32`; cleanup dos filhos reduziu para 7 | `ENOENT`, `ENOMEM`, nenhum spawn positivo ou erro antes de atingir 32 não aprovam |
| Saída no leitor | Processo exit 0/sem OOM produziu 65.538 bytes; leitor de 65.536 recusou | Frame truncado, erro de processo ou OOM não aprovam |

A prova de memória usa `Buffer.alloc` preenchido, retido em array, fora do heap V8
de 32 MiB; ela confirma a cota agregada do cgroup, sem afirmar o byte exato da última
alocação bem-sucedida. PIDs incluem as threads do Node: 32 não significa 32 filhos.
A prova de saída é **limite do leitor após a execução**; os 65.538 bytes chegam ao
daemon antes da recusa. Não foi estressado o rollover de 1 MiB do driver de logs.
A rede prova a rota externa indicada e o controle loopback, sem generalizar para
egress concedido a um broker futuro.

CPU 0,5, tmpfs de 8 MiB, capabilities e no-new-privileges foram solicitados e
inspecionados; este ensaio não saturou CPU/tmpfs nem tentou escalada de privilégios.
Os cinco estados finais e resultados de cada controle estão preservados no journal.

### Recursos próprios depois da execução

Foi feita auditoria read-only por **cada ID exato** e listagem restrita pelas três
labels completas de cada rodada. Retornaram 404 para os 15 IDs do benchmark, os
dois IDs das tentativas de logger e os cinco IDs de quotas; as quatro consultas
filtradas retornaram zero contêineres. Evidências:
`container-<UUID>-cleanup-audit.json` no mesmo diretório exclusivo. No total,
22 recursos próprios foram criados/removidos; nenhum contêiner alheio foi removido
ou usado como alvo. A imagem fixa permanece no cache, conforme o protocolo.

## Propriedade, prazos e recuperação

Nome: `extbench-<UUID-da-rodada>-<índice>`. Labels declaram finalidade,
SHA-256 da raiz da worktree e UUID. O journal é
`.superpowers/evidence/extensoes-bancada/container-<UUID>.json`; sua raiz/propriedade
é validada pela mesma política F5. A gravação é atômica e serializada no runner.
Nome planejado é persistido antes de create, ID logo depois, seguido das fases
created/started/finished/removed ou cleanup_pending.

Cada operação de limpeza verifica **ID + nome + labels**. Colisão de nome não é
adotada. Em create com resultado incerto, só o nome aleatório desta rodada pode
ser consultado, e a mesma validação é exigida antes de agir. DELETE usa
`force=false&v=false`; um contêiner ainda em execução precisa primeiro receber
SIGKILL e confirmar término. Nenhuma listagem global, prune, reset, remoção por
substring ou interrupção de contêiner alheio faz parte do protocolo.

Prazos: preflight 2 s, requisição normal 5 s, workload válido 10 s, loop após
entrada 1,5 s, pull explícito 60 s. Se o daemon parar de responder, encerrar uma
requisição HTTP não prova que o contêiner morreu: a rodada falha e a limpeza fica
pendente no journal. Depois que o **mesmo recurso próprio** estiver novamente
alcançável, a retomada restrita é:

```bash
node experiments/extensoes/runtime/container/runner.mjs --cleanup UUID-DA-RODADA
```

O argumento só aceita UUID. O journal deve pertencer à raiz atual, e cada recurso
é reatestado antes de kill/remove. Um crash ou create aceito muito depois do timeout
pode exigir repetir a limpeza quando o daemon estabilizar; nenhum prazo HTTP torna
uma operação de infraestrutura atomicamente cancelável. Não foi simulada perda
de energia nem suspensão prolongada da VM.

**Correção C1 da revisão:** `404` de uma criação sem ID confirmado significa
ausência provisória, não remoção concluída. A entrada permanece `cleanup_pending`
com razão explícita, e cada `--cleanup UUID` volta a consultar apenas o nome
próprio. Quando o recurso aparece, o runner valida nome/labels/ID antes de agir.
Um `404` de ID previamente conhecido pode encerrar a limpeza desse ID. Journals
antigos que gravaram `removed` sem ID são reabertos como pendentes automaticamente;
entradas `removed` com ID continuam terminais. Não há prazo que converta ausência
provisória em certeza: se o create nunca se materializar, a pendência permanece
honesta até haver uma confirmação adicional, que este protocolo ainda não oferece.

## Verificação já executada

```bash
node --test experiments/extensoes/runtime/container/profile.test.mjs
node --test experiments/extensoes/runtime/container/quotas.test.mjs
pnpm exec eslint experiments/extensoes/runtime/container/*.mjs
node experiments/extensoes/runtime/container/verify-image.mjs
node experiments/extensoes/runtime/container/runner.mjs --check
```

Resultados: doze testes de perfil e sete de quotas aprovados, ESLint sem saída,
digests verificados, rodada real e quotas reais aprovadas após recuperação do Docker.
As provas de perfil cobrem montagem do perfil,
API indisponível sem mutação, ciclo sintético completo de quinze contêineres,
divergência de quota, recusa de labels alheias, colisão de nome, frames de logs e
payload inválidos. Um socket HTTP sintético pendurado comprovou o timeout real do
cliente. A fixture funcional também rodou no Node local com ambiente mínimo;
isso não comprova qualquer quota/isolamento Docker.

O teste causal de C1 falhou antes da correção (`removed` em vez de
`cleanup_pending`) e passou depois: create expira, duas inspeções devolvem 404,
o journal é serializado/reaberto, o contêiner aparece e só então sofre a limpeza
própria. Uma sentinela alheia continua em execução. Outro caso faz aparecer um
recurso de labels alheias sob o nome esperado e confirma que nenhuma mutação ocorre.
O terceiro preserva o término para ID confirmado e a retomada do journal legado.
Essas provas usaram exclusivamente API sintética, sem novo acesso ao Docker real.

## Evidência ainda necessária

- Saturar a quota de CPU e a capacidade de tmpfs; tentar escalada de privilégios
  e estressar log rotation, sem promover campos de inspect a prova desses casos.
- Testar perda real de conexão depois de create/start e retomada pelo journal sem
  tocar outro contêiner. O loop encerrado por kill foi real; criação tardia C1 foi sintética.
- Medir custo residente/ocioso, VM/daemon, concorrência entre organizações e
  interferência no CRM atendendo, com carga prolongada e perfis comparáveis.
- Repetir ambos os executores em Linux amd64 equivalente à VPS. O resultado de
  Wasmtime nativo no macOS ARM versus Node Linux na VM não autoriza extrapolação.
- Substituir a closure sintética por broker externo com autoridade confiável e
  transportes equivalentes, e depois provar integração ao CRM/pacote real.

O artefato agora tem execução empírica restrita do perfil e cinco provas de
enforcement. A comparação equivalente em VPS, o broker real e os critérios completos
de admissão de executor do PROG-017 continuam pendentes.
