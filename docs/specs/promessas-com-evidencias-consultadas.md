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

Limites do coletor: até 20 evidências, 4.000 caracteres JSON por evidência e 16.000
no conjunto serializado. Itens repetidos são substituídos; os mais antigos saem
quando falta espaço. Um item grande é descartado inteiro, nunca truncado no meio
de uma ressalva. Não há cache entre turnos/organizações nem nova busca/embedding.

As fontes são dados em JSON, separados da instrução de sistema. O classificador
deve conferir **todas** as promessas, a correspondência de produto/plano e seus
requisitos. Paráfrase fiel de condição explícita pode passar; mudar anual para
mensal, ampliar prazo, inventar vaga ou juntar oferta válida com desconto não
autorizado continua sujeito a veto. Contradição, dúvida e exemplo hipotético não
autorizam. Não existe bypass determinístico nem remoção de trechos da candidata.

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

1. Entrada: resultados reais das três ferramentas de consulta citadas.
2. Saída: `classifyPromise` → `semanticPromiseGate` → resposta ou veto instrutivo.
3. Registro: auditoria MCP existente, `llm_calls` e trace da cadeia; nenhum texto
   comercial ou pessoal acrescentado aos logs.
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
