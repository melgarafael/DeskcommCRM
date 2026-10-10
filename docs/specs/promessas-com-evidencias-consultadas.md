# Promessas e evidências comerciais consultadas

Destino: **núcleo**. A mudança integra consulta e proteção da resposta no turno
comum, sem extensão, schema, lista paralela ou configuração nova.

## Contrato

O classificador `promise_semantic` recebe a candidata inteira e, quando existem,
as evidências comerciais recolhidas pelo servidor **no mesmo turno**:

- Produtos disponíveis devolvidos por `crm_search_products`, cuja consulta filtra
  organização e produtos ativos. Preserva código, nome, preço e descrição completos.
- Trechos devolvidos por `search_knowledge` ou `crm_search_knowledge`, somente
  quando `knowledge_source_id` pertence aos materiais habilitados na versão do
  agente **e** o tipo da fonte, canonizado por `canonizarTipoDeFonte`, é `faq`,
  `documento` ou `catalogo`. "Conversas anteriores" (`conversas` e os legados
  `conversation`/`conversations`) nunca prova oferta: ali está o que o cliente
  escreveu. Tipo desconhecido também fica de fora (lista de permissão), e uma
  falha ao ler os tipos deixa o turno sem evidência de conhecimento. O índice
  legado sem fonte identificável não autoriza condição por este caminho.

A evidência nunca vem dos argumentos de `send_message`, do histórico, do prompt
do agente, de notas do cliente ou de `crm_get_org_memory`. Seleção da consulta
não concede ao modelo poder de fabricar seu resultado. Os retornos MCP continuam
atravessando a ponte de autorização e auditoria já existente.

O acervo temporário do turno conserva até 100 itens/100.000 caracteres por
origem (conhecimento e catálogo). Consultas de uma origem não expulsam a outra.
Para o revisor são selecionados até 20 itens/16.000 caracteres, com até 4.000 por
item. A candidata orienta a relevância lexical, ponderada pela frequência no
acervo, sem decidir autorização. Há espaço inicial para até três itens de cada
origem, seguido da relevância global. Itens repetidos são substituídos; no teto
do acervo sai o mais antigo da mesma origem. Um item grande é descartado inteiro,
nunca truncado no meio de uma ressalva. Não há cache entre turnos/organizações.

Antes da revisão semântica, o servidor complementa o contexto com até cinco
trechos pertinentes à candidata, por busca textual parametrizada sem embedding
ou nova chamada de LLM. A consulta filtra organização, fontes habilitadas que
podem provar oferta, fonte ativa/pronta e versão de índice ativa. O texto da
candidata apenas seleciona termos: não fornece evidência. Consultas iguais são
deduplicadas, inclusive em paralelo, e há até quatro consultas distintas por
turno. Erro preserva as evidências já consultadas e emite evento de falha sem
texto comercial/pessoal; não fabrica autorização nem interrompe o atendimento.
O enriquecimento precede a chave de memoização do classificador, que inclui o
acervo inteiro. Uma nova consulta pode mudar a classificação da mesma mensagem.

As fontes são dados em JSON, separados da instrução de sistema. O classificador
deve conferir **todas** as promessas, a correspondência de produto/plano e seus
requisitos. Paráfrase fiel de condição explícita pode passar; mudar anual para
mensal, ampliar prazo, inventar vaga ou juntar oferta válida com desconto não
autorizado continua sujeito a veto. Contradição, dúvida e exemplo hipotético não
autorizam. Não existe bypass determinístico nem remoção de trechos da candidata.
Convite curto à oferta aprovada não precisa repetir toda a política, desde que
não dispense requisitos, amplie limites ou confirme reserva. A instrução com
evidências distingue essa informação do compromisso sem respaldo, mantendo
independentes a detecção de retorno humano e suas regras de caso/follow-up.
O veto orienta recuperar a política e preservar gratuidade autorizada, sem
contorná-lo por sinônimos ou por remoção de informação comercial correta.

Sem evidências, a chamada conserva a instrução anterior. Envios fixos de
follow-up, que não consultam essas ferramentas, permanecem nesse caminho.
`semanticPromiseGate`, tabela de valores, demais gates e tratamento de parse
permanecem iguais. A distinção semântica depende do modelo escolhido: não é uma
garantia absoluta de ausência de falsos positivos/negativos.

## Operação e visibilidade

O material continua sendo editado em Conhecimento e associado ao agente; as
condições de produto continuam no Catálogo. As capacidades de consulta e o
modelo auxiliar são escolhidos nas telas existentes de agentes e provedores.
Não precisa copiar o catálogo para uma lista de exceções. A prévia reutiliza o
coletor e o classificador do turno, mostra a resposta aceita e os impedimentos
de tentativas recusadas. Custo continua registrado em `llm_calls`, propósito
`promise_semantic`; o contexto pode aumentar tokens, mas não cria outra chamada.

## Living System Checklist

1. Entrada: resultados reais das três ferramentas de consulta citadas e busca
   textual complementar sobre os índices ativos dos materiais habilitados.
2. Saída: `classifyPromise` → `semanticPromiseGate` → resposta ou veto instrutivo.
3. Registro: auditoria MCP existente, `llm_calls` e trace da cadeia; nenhum texto
   comercial ou pessoal acrescentado aos logs. Consulta complementar registra
   `promise_evidence_lookup` (contagem) ou `promise_evidence_lookup_failed`.
4. Tela: Teste do agente (`TurnPreview.result.impediments` e `candidates`) e
   observabilidade da cadeia existente.
5. Porta: Agentes → Teste; Catálogo/Conhecimento e Provedores de IA existentes.
6. Anti-morte: veto retorna como ensino para reformular pelo harness existente;
   não cria fila nem altera sua política de esgotamento.
7. Configuração: fontes/capacidades do agente e cadastro de produtos. Ausência de
   evidência preserva a classificação anterior, sem autorização implícita.
8. Continuidade: mecanismos de revisão/handoff existentes não mudam.
9. Retorno: impedimento visível permite corrigir a fonte comercial; a próxima
   consulta/turno usa o resultado novo, sem autorização persistida neste coletor.
10. Mapa: `docs/architecture/agent-turn.workflow.json`, aresta de evidências do
    turno à cadeia e cartão explicativo.

## Relação com a contribuição #1981

A lista manual versionada de condições proposta no #1981 (@webtecnica) abriu
este caminho. O mantenedor escolheu seguir com as evidências consultadas, sem
lista cadastrada, e o #1981 foi fechado com crédito. Esta contribuição resolve o
caminho de evidências que já estão no catálogo/acervo; ofertas que existem só
nas instruções do agente continuam fora dele.


## Contexto do pedido e consentimento

O turno entrega ao classificador também `contexto_conversa`: mensagens já
curadas pelo servidor, resumo anterior, momento e fuso da organização. Esse
campo informa perfil, requisito declarado e referência de pronomes; não é
fonte comercial. Falas do cliente, respostas anteriores do atendente e resumo
nunca autorizam oferta, mesmo quando contêm instruções para aprovar. Os dados
ficam separados de `evidencias`, em JSON, sem interpolação no sistema.

O transporte preserva a janela curada comum. Limites extraordinários: até cem
mensagens/48.000 caracteres e 4.000 de resumo, com `limitado=true` quando há
recorte. Não consulta outra conversa, identificador pessoal ou organização.
Chamadores sem contexto continuam compatíveis; modelo, orçamento e auditoria
continuam no seam `runModelCall`.

Condições comerciais aprovadas escritas no imperativo são limites da oferta,
não comandos para mudar o papel do classificador. A instrução distingue essas
ressalvas de instruções maliciosas e de garantias individuais inventadas.

No detector determinístico de humano, uma pergunta explícita de consentimento
para transferir/consultar, sem alegar operação ou compromisso, não é promessa
de caso. A isenção vale para a mensagem inteira, nunca frase a frase: basta uma
frase com operação alegada, prazo ou retorno anunciado para a análise voltar ao
texto todo. Pedir consentimento junto de “já encaminhei”, “a equipe vai
retornar” ou “retorna em 10 minutos” continua sujeito ao gate. Isso não
executa nem autoriza transferência; a operação permanece em seu caminho próprio.

Entrada: `effectiveContext.messages` e resumo do fechamento anterior em
`inbound-turn.ts` → `montarContextoDaRevisao`. Saída: `classifyPromise` → cadeia
before-send → candidato aceito ou impedimento instrutivo. A revisão permanece
registrada em `llm_calls` e no resultado da prévia; a pergunta não acrescenta
evento de operação. Porta e configuração: Agentes → Teste, fontes do agente e
Provedores de IA. Não há nova tela/configuração. O laço de retorno continua
reformulação instruída pelo veto e ajuste da fonte pela pessoa, sem aprender
autorizações a partir do diálogo. O mapa inclui duas arestas do contexto.

Precisão depende do modelo: transmitir o contexto não prova ausência de falsos
positivos/negativos. Não há bypass de ofertas, garantia de recuperação de um
contexto omitido pelo servidor nem prova de execução de casos pela prévia.


## Linguagem comercial e falhas do provedor

O revisor interpreta acolhimento, entusiasmo e benefícios aprovados no contexto
comercial. Não exige ressalvas jurídicas nem cópia literal da base. A revisão
procura compromisso concreto sem suporte, como gratuidade ampliada, vaga
confirmada inventada ou dispensa de condição essencial. O tratamento de diálogo
como dado e os limites das fontes continuam preservados. A intensidade da
persuasão, isoladamente, não caracteriza promessa não autorizada.

Uma falha estruturada do provedor com `promptFeedback.blockReason` conhecido
chega a `identificarConteudoBloqueado`, dentro do seam `runModelCall`. O seam
registra em `llm_calls` o código `conteudo_bloqueado` e mensagem sanitizada; a
rota de Teste do agente devolve a explicação no erro 422. Execuções e prévia
continuam acessíveis pelas portas existentes, sem tela/configuração novas.
Não transfere o corpo do fornecedor para a mensagem, não desliga sua proteção,
não transforma bloqueio em falta de saldo e não inventa a causa específica.

O operador pode revisar a execução e seu contexto antes de decidir outra
tentativa. Não há retentativa, modelo substituto ou autorização aprendida
introduzidos por esta classificação. As políticas existentes de orçamento e
fila permanecem. Destino: núcleo; diagnóstico e revisão já são capacidades
comuns, sem depender de extensão. Mapa: turno → diagnóstico → Execuções/prévia.
Sem nova tabela, consulta a outra organização ou credencial adicional.

## Busca textual e limite do recuperador

A consulta preserva letras Unicode e os acentos em NFC; tanto consulta quanto
conteúdo passam pelo stemmer português do Postgres. A normalização sem acento
serve apenas para descartar palavras vazias. A expressão
`to_tsvector('portuguese'::regconfig, content)` tem índice GIN idempotente no
baseline e na migration 0617. O índice não altera linhas ou políticas de acesso.

Cada turno continua limitado a quatro consultas distintas e cada consulta a
cinco trechos. Os filtros exigem organização, fonte aprovada/ativa/pronta e
versão ativa. A instrução com evidências mantém as categorias de compromisso
concreto e os exemplos de slogans da instrução sem evidências; a autorização
comercial sustenta apenas a oferta correspondente.

`tests/invariants/recuperacao-promessas-com-postgres.test.ts` mede acentos,
isolamento/versões, cinco resultados, uso do índice num acervo sintético e a
recuperação no turno antes do revisor, sem uma busca explícita pelo agente.
