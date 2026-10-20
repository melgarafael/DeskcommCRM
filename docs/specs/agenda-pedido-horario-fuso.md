# Pedido, instante e confirmação de agenda

Correção do núcleo: identidade, autorização e correspondência da escrita com o pedido continuam necessárias com zero extensões. Não há tabela, migration, ambiente ou configuração empresarial nova.

`crm_find_free_slots` publica `inicio` em ISO UTC e `dia`, `horario_local`, `quando` e o fuso calculados pelo servidor. `crm_book_appointment` copia o instante; `crm_find_and_book_appointment` resolve dia/hora locais pela grade. Nenhum caminho reinterpreta todo sufixo Z como hora local. A API sem conversa conserva seu contrato ISO.

No turno autenticado, criar/remarcar exige revisor injetado pelo runtime. O servidor resolve serviço, contato e fuso pela coleta nativa, confronta uma proposta com o pedido canônico e a conversa escopada à organização/contato/conversa. Operador usa o job de origem; sua declaração não concede consentimento. O piso determinístico só veta escolha explícita divergente: igualdade de relógio nunca autoriza. Casos vagos, alternativas e outros fusos passam à revisão completa.

O sinal estrito `agendaCompativel` é independente de promessa comercial e autoria humana. Ausência, coerção ou dúvida não autorizam efeito. JEV e reserva recebem o mesmo pacote factual e proposta; contexto ampliado exige aceite v2 no JEV. O confirmador humano opcional conserva esse julgamento independente. Falhas não desativam a proteção. Nova inferência ocorre fora de transação/conexão reservada; a fotografia e a fronteira são relidas antes do escritor nativo. A revisão de serviço conferida chega ao controle atômico da criação; remarcação conserva a revisão da reserva. Escritores continuam responsáveis por disponibilidade, capacidade, bloqueios, confirmação humana e idempotência.

Na fase anterior à escrita, a reserva auxiliar recebe a pergunta de correspondência da proposta, com formato único `agendaCompativel` boolean. A candidata vazia é esperada: não há confirmação para avaliar nem recibo futuro a exigir. Um registro cancelado não comprova reserva ativa e não revoga automaticamente um novo pedido explícito. Dados omitidos continuam exigindo recusa quando necessários à decisão; pacote global excluído continua impedindo positivo. No envio, a reserva LLM faz a pergunta de agenda em chamada própria, com o mesmo binding, orçamento e pacote factual, sem misturá-la às perguntas comerciais/humanas. Isso custa uma chamada auxiliar adicional no fallback de envio; o JEV mantém sua pergunta própria já existente. Um positivo comercial não substitui sinal de agenda ausente/inválido. Encaminhar um pedido ainda não atendido não afirma que ele já foi reservado; os controles de compromisso humano e comercial continuam aplicáveis.

Os eventos `agenda_review_signal` e `agenda_review_normalized` registram fase e sinal (positivo, negativo ou ausente/inválido), sem texto do modelo ou da conversa. `agenda_request_review` distingue sinal da revisão de invalidação da fotografia do atendimento ou da decisão humana. Essa distinção permite investigar uma recusa sem repetir o atendimento ou exportar capturas amplas.

Antes do envio, agentes com agenda ou recibos de agenda exigem o mesmo sinal. A candidata precisa corresponder tanto ao pedido quanto ao recibo. Reserva salva, publicação Google e comunicação são fatos separados. Comunicação manual explicitamente autorizada por decisão humana elegível conserva seus limites; não exige integração inexistente. Saudação/pergunta/formulário não confirmam uma operação e não exigem criar Caso por rotina.

Entrada: mensagem canônica do job e proposta do MCP. Saída: recusa instrutiva sem escrita, ou escritor nativo. A auditoria MCP registra a recusa como falha, o worker emite `agenda_request_review` somente com rótulo e o `before_send` registra `agenda_request_mismatch`. O motivo factual de `nao_conferido` aparece no trace sem conteúdo da conversa. A cadeia de revisão e a resposta instrutiva alimentam a correção no mesmo turno; não há bypass do revisor nem nova reserva para contornar veto. Custo adicional: uma revisão por proposta/fotografia, memoizada no turno; proposta diferente ou contexto alterado exige novo julgamento. Fonte indisponível ou escolha ambígua exige esclarecimento; a correção não promete interpretar infalivelmente qualquer texto.

Provas dirigidas: slot local/UTC, UTC com offset preservado, veto anterior ao escritor, outra data/pessoa/serviço, passado, remarcação/cancelamento, fotografia alterada, ausência/coerção do sinal, equivalência do pacote JEV/reserva e preservação dos gates comerciais/humanos. Modelos e escritores são dublados nos testes unitários; isso não comprova precisão do modelo real nem entrega externa. Build e prova real dirigida pertencem à validação da candidata final.

## Comprovação atual antes da primeira confirmação

O recibo escopado ao atendimento conserva `inicio`, `fim` e `fuso` persistidos e acrescenta `inicio_local`, `fim_local` e `quando_local`, calculados pelo servidor com as funções de tempo existentes. Isso remove a conversão mental entre UTC e hora de parede na revisão. Instante ou fuso inválido/ausente produz `horario_local_estado=unavailable`, sem assumir outro fuso ou corrigir a reserva. A projeção não autoriza a operação: pedido, beneficiário e recibo continuam precisando corresponder.

A semântica de `natureza_confirmacao` é compartilhada entre a pergunta de agenda e a revisão humana/comercial, incluindo JEV. Confirmação humana dispensada explicitamente não exige um atestado humano ausente. A indicação de que a reserva não comprova comunicação anterior não exige uma confirmação já enviada para julgar a primeira mensagem. Isso não comprova entrega futura nem libera outro gate.

A memória geral pode ocupar a quota organizacional existente de 24 mil caracteres, incluindo os metadados das fontes, sem o antigo corte por item de 8 mil. Ela continua inteira ou excluída com cobertura explícita; notas individuais, skills e referências mantêm seus limites anteriores, assim como o teto global. A releitura atual prevalece sobre a memória retirada/alterada.

Provas de regressão: memória geral maior que 8k com múltiplas skills e indivíduo preservado; equivalência do pacote nos revisores; exclusão integral acima da quota; UTC com Z ou offset convertido ao mesmo instante local; instante divergente continua divergente; fuso/instante desconhecido não é preenchido. As provas com doubles não substituem a validação de entrega real.

Living System Checklist: entradas em `carregarContextoDoAtendimento` e registro das fontes consultadas; saídas no contexto do agente, `classifyPromise` e `revisarRespostaComJev`; diagnóstico em `review_context_sources` e `before_send_traces`, com reflexo do atendimento/Casos no Inbox. As configurações continuam nas superfícies existentes de memória/skills/agenda. A peça é leitura e projeção pura, sem novo job, mutação ou configuração; recuperação e continuidade usam a correção do turno e os Casos já existentes. O retorno que muda a decisão é a releitura da fotografia e a candidata corrigida, sem ignorar vetos. Nenhum nó/rota novo no mapa: conservam-se as arestas existentes entre contexto, revisão, ferramentas e cadeia de envio.


## Alterar e cancelar preservam a identidade do compromisso

Na remarcação, a proposta carrega `reserva_atual`, uma origem relida no servidor com horário/fuso, estado e revisão, sem UUID externo. Os campos de primeiro nível continuam sendo o destino. O pedido “de 10h para 15h” precisa corresponder a essa transição, não a duas escolhas iguais. Origem incompleta recusa antes da inferência; a revisão da reserva continua chegando ao escritor atômico e mudanças posteriores invalidam a fotografia. Serviço, beneficiário, capacidade e bloqueios não ganham exceção.

Cancelamento tem `natureza_cancelamento` separada da confirmação de reserva ativa: `cancelamento_sincronizado_no_google` exige status cancelado, carimbo de cancelamento, publicação removed e mesma revisão sem push/erro; `cancelamento_salvo_sem_remocao_comprovada` não prova remoção no Google. Nenhuma delas reativa ou confirma reserva. JEV, reserva e confirmador recebem a mesma distinção; comunicar o resultado operacional não fabrica autoria humana. O pedido canônico atual determina a intenção; um Caso antigo de remarcação não transforma cancelamento em remarcação nem fornece aprovação. Gates restantes continuam obrigatórios.

Remarcações sucessivas usam a mesma identidade e a última origem/revisão relida, nunca o primeiro horário do histórico. Cada novo destino exige revisão do pedido canônico atual; uma aprovação em cache de outra proposta/fotografia não autoriza a próxima alteração. Reentrega do mesmo pedido continua sujeita à idempotência nativa, sem cancelar/criar de novo.


## Recuperação de comunicação após veto

Um veto `agenda_request_mismatch` (ou `human_decision_unfaithful` com revisão de agenda ativa)
interrompe o lote do agente. Envios do mesmo turno são serializados, inclusive tool calls
paralelas: uma orientação não pode ultrapassar o veto ainda em processamento. Mensagens seguintes do mesmo lote não podem substituir a resposta
recusada por formulário ou orientações dependentes. Há UMA recuperação por execução, só com
`send_message`, sem ferramentas de escrita. O pacote comum a JEV/reserva/confirmador marca a
tentativa como não enviada, sem transformá-la em prova ou autorização. O mesmo sinal de agenda
exige resposta fiel ao resultado/estado do pedido atual, ou explicação honesta do impedimento;
saudação/formulário sozinho não resolve. Toda a cadeia continua ativa, inclusive exigência humana.

A recuperação só consome a pendência com recibo `sent`/`already_sent`. `queued` não libera
orientações dependentes nem reenvio. Se a revisão continuar recusando, há falha terminal visível
no trace/log e na superfície de Caso existente, quando habilitada e sem Caso já aberto; nenhum
Caso novo por espera operacional normal do Google. O roteiro também aguarda essa comunicação.
O corpo recusado nunca vai ao log; contexto de recuperação e memo são locais à execução.

Entrada: veto de envio; saída: cadeia before_send e canal; registro: traces existentes e
`agenda_communication_recovery`/`agenda_communication_unresolved`; tela/porta: Inbox e Execuções,
Casos na falha terminal habilitada. Laço: o veto alimenta uma reescrita limitada; insistência
não libera gate nem repete reserva. Sem nova configuração, tabela, rota ou peça de navegação.


## Resultado observado no mesmo turno

A ponte nativa observa a resposta estruturada de criar, remarcar ou cancelar, e
relembra somente a identidade privada e a revisão devolvidas com sucesso. Antes de
apresentá-las, relê a fotografia scoped do atendimento. `resultado_agenda_do_turno`
aponta um único recibo verificado da mesma reserva/revisão e conserva os fatos de
publicação, confirmação humana e comunicação exatamente como relidos. O retorno
da ferramenta para o agente e o pacote factual de JEV/reserva/confirmador recebem
o mesmo quadro; a recuperação também o recebe. Nenhuma identidade privada é
incluída nesse quadro externo, e o restante do histórico permanece disponível.

O quadro identifica execução, nunca consentimento nem mensagem entregue. Uma nova
tentativa invalida a anterior; erro, resposta sem sinal estrito, revisão trocada,
recibo ausente ou ambíguo não geram vínculo. Resultados de chamadas anteriores que
terminam atrasadas não substituem a tentativa mais recente. Se o limite global
excluir o contexto, o quadro também é retirado e o sinal continua fechado. Todos
os gates, o opt-in JEV v2 e a revalidação anterior ao canal permanecem aplicáveis.
A recuperação não ganha ferramentas de escrita nem mais tentativas.

### Correlação privada da conversa de teste

O diagnóstico opt-in existente também correlaciona o agente à revisão. O bucket
LLM nativo `reserva` conserva seu nome por compatibilidade; `papel`, `purpose` e
`etapa` distinguem agente, revisor, ponte nativa e controle do envio. Cada chamada
recebe `call_id` próprio e cada passo, seu número. A entrada registra exatamente
system/messages entregues ao SDK; o callback do SDK registra o corpo da requisição
efetiva de cada passo, o texto e chamadas/resultados de ferramentas. Headers,
credenciais e objetos de provedor não são coletados. Isso não cria outra chamada
ao modelo nem substitui o pacote encaminhado ao revisor.

No mesmo job, as etapas registram o retorno da ferramenta e recibo relido, a
classificação normalizada, a candidata e código/motivo do veto ou resultado do
canal. O texto bruto devolvido pelo classificador vem do passo real do modelo;
um rótulo de veto isolado não demonstra sua causa exclusiva. Resultado do canal
não equivale a leitura pelo cliente: a prova externa segue necessária.

Valem os controles existentes: default-off, contato de teste confirmado ou job,
opt-in administrativo, coleta por até 2h, acesso por até 72h, 100 registros/10MiB,
sanitização e exclusão de textos acima de 16000 caracteres/mídia com cobertura
explícita. Requisição ausente no SDK ou campo omitido impede alegar coleta completa.
Ativar imediatamente antes do teste próprio; conferir a cobertura e revogar ao
terminar, sem copiar conteúdo privado entre instalações ou a uma contribuição.
