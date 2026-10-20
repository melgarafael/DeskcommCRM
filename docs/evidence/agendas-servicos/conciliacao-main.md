# Conciliação da agenda e da revisão com a main

Recorte: correção sobre a proposta integrada `e80d039`, conciliada com `main 5470425`. Esta nota descreve causas observadas nos checks oficiais e os limites da repetição dirigida. Não apresenta a suíte completa ou uma nova implantação como aprovadas.

## Schema e cadeia de atualização

A renumeração das migrations da contribuição trocou indevidamente o rótulo histórico `(migration 0659, #2818)` no baseline por `0700`. O corpo DDL da coluna `crm_tasks.demanda_id`, sua FK e o índice parcial já estavam presentes, byte a byte salvo o rótulo. A correção restaura esse rótulo; não recria nem move dados.

A nova migration pública `0698` reconstruía `agent_inbox_items_kind_check` com uma lista anterior à main, sem `task_due` e `task_overdue`. Sua lista agora preserva também esses dois valores. A migration original já distribuída não foi reescrita. As cercas de vocabulário, cadeia, espelho e vínculo de tarefa passaram no recorte dirigido.

## Falha de comunicação e truncamento

O bloco terminal da main exige silêncio sem causa legítima **e** truncamento da saída ou da correção. A agenda havia unido a esse bloco uma condição de comunicação não entregue, alterando seu significado e perdendo a guarda de prévia. O bloco oficial foi preservado; a falha de comunicação usa um ramo próprio com `!preview`, sem descarte, handoff realizado ou teto atingido. Ambos conservam a configuração `casesEnabled`, a consulta de Caso já aberto e o registro de Caso aberto neste turno. Nenhum ramo envia mensagem ou repete a operação da reserva.

As cercas oficiais existentes não foram relaxadas. Duas verificações adicionais guardam a prévia e o ramo próprio. No handler real com banco do harness, o positivo entrega a confirmação antes do formulário; o negativo persistente não entrega formulário nem cria laço. O cancelamento da revisão 4 faz uma única escrita: o positivo entrega a confirmação e não abre Caso; o negativo conserva o veto e abre um único Caso.

O provedor fictício desses invariantes ainda identificava o prompt por uma frase anterior do critério de agenda. O código atual dizia “as afirmações de agenda”, e o dublê procurava “a correspondência”; por isso devolvia o fechamento do agente em lugar do booleano de revisão. O log real do harness registrava `absent_or_invalid`, não um positivo válido vetado. O dublê agora reconhece a instrução canônica importada. As assertivas de efeitos, ferramentas permitidas, recibo, veredito e entrega foram preservadas, com a contagem de Casos acrescentada. Não houve mudança de parser ou liberação na ausência de sinal.

## Ferramentas disponíveis e diagnóstico factual

A função que monta os blocos da agenda já dava instruções sobre o alcance do recibo a quem só remarca, sem ensinar ferramentas de criar que não possui. Isso acrescentou uma combinação ao teste exaustivo. A cobertura agora mede 15 combinações e confere explicitamente o bloco de só-remarca, inclusive a ausência dos três nomes de ferramentas que não foram concedidas. A régua de “quem pode criar” não foi ampliada.

Os dois caminhos sem requisição do gate factual ganharam diagnóstico de motivo. As assertivas antigas continuam exigindo `pass: true`, `skipped: nao_conferido`, zero chamada adicional e o teto de uma chamada; agora também exigem o motivo exato `sem_frases` ou `outra_por_turno`. Não foi retirada a informação de diagnóstico para fazer um teste passar.

## Google: falha da tentativa não é falha permanente

O e2e falhava na primeira publicação, em uma resposta HTTP 503 simulada após o receptor ter criado o evento. Esse caso deve ficar `retrying`, com `google_sync_failure_kind=transient` e próxima tentativa marcada. `failed` na devolução do executor descreve a tentativa; não transforma o recibo em impedimento permanente. A assertiva agora distingue esses estados. As verificações posteriores de sincronização, mesma identidade, uma única criação, remarcação, conflito real por edição incompatível e cancelamento permanecem. A nova execução e2e é pendente dos checks oficiais do commit corrigido.

## Resultado e limites

- 195 testes em nove arquivos dirigidos passaram: cercas do schema, truncamento, ferramentas e gates factual/agenda. Há sobreposição com execuções anteriores; não são somados como cenários únicos.
- Quatro cenários de `agenda-recupera-comunicacao.test.ts` passaram no harness oficial PostgreSQL 15, com install/update do baseline e isolamento do kit. Uma primeira repetição da nova contagem de Casos usou o nome incorreto de tabela na fixture; corrigido para `agent_cases`, sem alterar a assertiva. O resultado anterior foi preservado.
- Lint dos arquivos afetados: zero erros, dois avisos herdados em `inbound-turn.ts`.
- Majors adicionais, e2e e CI integral do novo commit ainda precisam concluir. Nenhum resultado anterior é atribuído retroativamente ao novo commit.
- Provedores e canal do harness são doubles explícitos. A prova real previamente documentada é complementar e não foi repetida nesta conciliação. Não se afirma acurácia determinística dos modelos.

## Continuidade existente

Entrada: veto da cadeia before-send e estado da recuperação do turno. Saída: resposta pela mesma cadeia ou Caso único com a causa. Registro: trace de gates e `agenda_communication_unresolved`. Superfícies: Execuções de IA e Casos, já navegáveis; a equipe recebe o snapshot existente e pode responder pelo mesmo Caso. Configuração: `casesEnabled` do agente, sem knob novo. Anti-morte: uma recuperação limitada, seguida de falha explícita e continuidade humana quando configurada. O retorno ao agente conserva eventos/decisões autenticados do Caso. O mapa de `docs/architecture/agent-turn.workflow.json` e os contextos factuais existentes continuam descrevendo as mesmas arestas; a correção separa condições internas, sem criar um fluxo paralelo.
