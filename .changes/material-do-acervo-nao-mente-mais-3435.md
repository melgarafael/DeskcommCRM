---
impacto: nada_mudou
secao: corrigido
titulo: Editar o conteúdo de um material do acervo deixa de responder "salvo" sem salvar
---
No acervo de conhecimento, editar o conteúdo de um material que não é uma lista de perguntas e respostas — um documento, um catálogo — respondia que deu certo e não mudava nada: quem integra pela API achava que tinha trocado o texto do material e o assistente continuava respondendo o de antes. Agora esse pedido é recusado com uma mensagem que diz o que fazer (enviar o arquivo, ou esperar a rotina que alimenta aquele tipo), e nada é gravado — nem o nome novo que vinha junto no mesmo pedido, que antes ficava salvo mesmo com a recusa. Listas de perguntas e respostas continuam sendo editadas como sempre.

As quatro ações sobre material do acervo — criar, enviar arquivo, editar e arquivar — e o reindexar de um material passam a deixar registro na auditoria: quem fez, em que empresa, em qual material e quando. O registro guarda só identificadores e contagens, nunca o texto do material. É o que responde "quem arquivou o FAQ de trocas?". Nada a fazer na atualização. Contribuição de @webtecnica (#3435, #3437).
